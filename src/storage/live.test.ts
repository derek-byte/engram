import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import type { Chunk, EngramConfig, RawEvent, ScoringConfig } from '../types/index.ts';
import { PgVectorBackend } from './pgvector.ts';
import { CHUNKER_VERSION } from '../ingest/chunker.ts';
import { LOCAL_DIM } from '../ingest/embed.ts';

const LIVE = process.env.ENGRAM_TEST_LIVE === '1';
const DB_URL = process.env.ENGRAM_DATABASE_URL ?? 'postgresql://engram:engram@localhost:5432/engram';
const FAKE_MODEL = 'test-fake-384';
const OWNER = 'test:storage';
const REPO = 'storage-repo';

// A valid, deterministic embedding of the configured dimension.
function vec(seed: number, dim = LOCAL_DIM): number[] {
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = ((seed * 31 + i) % 97) / 97;
  return out;
}

function rawChunk(id: string, seed: number, extra?: Partial<Chunk['metadata']>): Chunk {
  return {
    id,
    embedding: vec(seed),
    content: `chunk ${id} content body number ${seed}`,
    metadata: {
      repo: REPO,
      branch: 'main',
      timestamp: new Date('2026-06-01T00:00:00Z'),
      filePaths: [`src/f${seed}.ts`],
      exitCode: null,
      sessionId: 's-batch',
      cwd: '/tmp/work',
      tier: 'raw',
      owner: OWNER,
      chunkIndex: seed,
      chunkCount: 1,
      ...extra,
    },
  };
}

describe('live storage hardening (Wave 12 Lane A)', () => {
  test.skipIf(!LIVE)('fresh initialize records schema_meta version; matched version skips DDL (index canary)', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    const admin = postgres(DB_URL, { prepare: false, onnotice: () => {} });
    try {
      await backend.initialize();

      // schema_meta exists and records our version.
      const [ver] = await admin<Array<{ value: string }>>`
        SELECT value FROM schema_meta WHERE key = 'schema_version'
      `;
      expect(ver?.value).toBe('2');

      const indexPresent = async (): Promise<boolean> => {
        const [r] = await admin<Array<{ n: string }>>`
          SELECT count(*)::text AS n FROM pg_class WHERE relname = 'chunks_repo_idx'
        `;
        return Number(r?.n ?? 0) > 0;
      };

      // Drop an index by hand, then re-initialize on a MATCHED version → fast
      // path skips all DDL, so the index is NOT restored.
      await admin`DROP INDEX IF EXISTS chunks_repo_idx`;
      expect(await indexPresent()).toBe(false);
      await backend.initialize();
      expect(await indexPresent()).toBe(false);

      // Clear the version row → next initialize sees a mismatch → full DDL runs
      // → index restored and version re-stamped.
      await admin`UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'`;
      await backend.initialize();
      expect(await indexPresent()).toBe(true);
      const [ver2] = await admin<Array<{ value: string }>>`
        SELECT value FROM schema_meta WHERE key = 'schema_version'
      `;
      expect(ver2?.value).toBe('1');
    } finally {
      // Guarantee a clean end state even if an assertion above threw: reset the
      // version so the next full DDL restores every index, then run it.
      await admin`UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'`.catch(() => {});
      await backend.initialize().catch(() => {});
      await admin.end();
      await backend.close();
    }
  });

  test.skipIf(!LIVE)('dimension mismatch → initialize throws', async () => {
    // Real chunks.embedding is vector(LOCAL_DIM); construct at a different dim.
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM + 1, FAKE_MODEL, CHUNKER_VERSION);
    try {
      await expect(backend.initialize()).rejects.toThrow(/dimension mismatch/i);
    } finally {
      await backend.close();
    }
  });

  test.skipIf(!LIVE)('duplicate ids in one upsert batch land once; id conflict restamps chunker_version only', async () => {
    // Identical repeated user turns hash to the same trajectoryId + chunk ids,
    // so one pipeline batch can carry the same id twice. DO NOTHING tolerated
    // that; the reindex restamp (DO UPDATE) must not die on "cannot affect row
    // a second time" — upsert dedupes first-wins.
    const v1Backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, 'v1-test');
    const v2Backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, 'v2-test');
    const admin = postgres(DB_URL, { prepare: false, onnotice: () => {} });
    try {
      await v1Backend.initialize();
      await v1Backend.deleteByOwnerPrefix('test:');

      const dup = rawChunk('dup-id-a', 1);
      await v1Backend.upsert([dup, { ...dup }, rawChunk('dup-id-b', 2)]);
      const versionOf = async (id: string): Promise<string | null> => {
        const [r] = await admin<Array<{ v: string | null }>>`
          SELECT chunker_version AS v FROM chunks WHERE id = ${id}
        `;
        return r?.v ?? null;
      };
      expect(await versionOf('dup-id-a')).toBe('v1-test');

      // Same id upserted under a newer chunker version: row survives (owner and
      // content untouched) but the version stamp moves — the reindex sweep must
      // spare content the current chunker still produces.
      await v2Backend.upsert([rawChunk('dup-id-a', 1)]);
      expect(await versionOf('dup-id-a')).toBe('v2-test');
      const swept = await v2Backend.deleteChunksByStaleVersion(OWNER, 'raw', 'v2-test');
      expect(swept).toBe(1); // only dup-id-b (still v1-test) goes
      expect(await versionOf('dup-id-a')).toBe('v2-test');
      expect(await versionOf('dup-id-b')).toBeNull();
    } finally {
      await v1Backend.deleteByOwnerPrefix('test:').catch(() => {});
      await admin.end();
      await v1Backend.close();
      await v2Backend.close();
    }
  });

  test.skipIf(!LIVE)('wrong-length embedding → upsert throws before any insert', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');

      const good = rawChunk('wrong-len-a', 1);
      const bad = rawChunk('wrong-len-b', 2);
      bad.embedding = vec(2, LOCAL_DIM - 1); // one short

      await expect(backend.upsert([good, bad])).rejects.toThrow(/expected/i);
      // Whole batch rejected: the good chunk must NOT have been written.
      expect(await backend.getTrajectory('nope')).toEqual([]);
      const round = await backend.getUnitChunks(OWNER, 's-batch', REPO, 'raw');
      expect(round.length).toBe(0);
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await backend.close();
    }
  });

  test.skipIf(!LIVE)('300-chunk batched upsert round-trips, re-upsert no-ops', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');

      const chunks: Chunk[] = [];
      for (let i = 0; i < 300; i++) chunks.push(rawChunk(`test:batch-${i}`, i));
      // Give one chunk artifacts + source ids to exercise jsonb/text[] fidelity.
      chunks[0]!.metadata.artifacts = [{ kind: 'file', ref: 'a.ts', tool: 'Edit' }];
      chunks[0]!.metadata.sourceChunkIds = ['x1', 'x2'];

      await backend.upsert(chunks);
      const got = await backend.getUnitChunks(OWNER, 's-batch', REPO, 'raw');
      expect(got.length).toBe(300);

      // Per-column fidelity on a sampled chunk (ordered by chunkIndex).
      const byId = new Map(got.map((c) => [c.id, c]));
      const c0 = byId.get('test:batch-0')!;
      expect(c0.content).toBe('chunk test:batch-0 content body number 0');
      expect(c0.metadata.repo).toBe(REPO);
      expect(c0.metadata.branch).toBe('main');
      expect(c0.metadata.filePaths).toEqual(['src/f0.ts']);
      expect(c0.metadata.sourceChunkIds).toEqual(['x1', 'x2']);
      expect(c0.metadata.artifacts?.length).toBe(1);
      const c299 = byId.get('test:batch-299')!;
      expect(c299.content).toContain('299');

      // Re-upsert the same set → ON CONFLICT DO NOTHING, count unchanged.
      await backend.upsert(chunks);
      const again = await backend.getUnitChunks(OWNER, 's-batch', REPO, 'raw');
      expect(again.length).toBe(300);
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await backend.close();
    }
  });

  test.skipIf(!LIVE)('insertRawEvents batched: exact count with mixed conflicts', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');

      const mk = (sha: string): RawEvent => ({
        owner: OWNER,
        source: 'test',
        sessionId: 's-raw',
        contentSha256: sha,
        occurredAt: new Date('2026-06-01T00:00:00Z'),
        payload: { sha },
      });

      // 250 events crossing the 100-row batch boundary, all distinct.
      const first: RawEvent[] = [];
      for (let i = 0; i < 250; i++) first.push(mk(`test:raw-${i}`));
      expect(await backend.insertRawEvents(first)).toBe(250);

      // Mixed batch: 50 pre-existing (conflict) + 50 new → only 50 inserted.
      const mixed: RawEvent[] = [];
      for (let i = 0; i < 50; i++) mixed.push(mk(`test:raw-${i}`)); // conflicts
      for (let i = 250; i < 300; i++) mixed.push(mk(`test:raw-${i}`)); // new
      expect(await backend.insertRawEvents(mixed)).toBe(50);

      // Full replay → all conflict → 0 inserted.
      expect(await backend.insertRawEvents(first)).toBe(0);
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await backend.close();
    }
  });
});

// --- Non-live: no DB connection required (postgres.js connects lazily) --------

describe('storage unit (no pg)', () => {
  test('fromConfig threads scoring weights + CHUNKER_VERSION', () => {
    const config = {
      databaseUrl: DB_URL,
      embeddingModel: 'm-test',
      embeddingDim: LOCAL_DIM,
      vectorWeight: 0.42,
      keywordWeight: 0.58,
      timeDecayHalfLifeDays: 14,
    } as unknown as EngramConfig;

    const backend = PgVectorBackend.fromConfig(config);
    // Test seam: assert the private scoring/chunkerVersion fields fromConfig set.
    const seam = backend as unknown as { scoring: ScoringConfig; chunkerVersion: string; embeddingModel: string };
    expect(seam.scoring).toEqual({ vectorWeight: 0.42, keywordWeight: 0.58, timeDecayHalfLifeDays: 14 });
    expect(seam.chunkerVersion).toBe(CHUNKER_VERSION);
    expect(seam.embeddingModel).toBe('m-test');
  });

  test('rowToChunk maps snake_case row → Chunk, coalescing nulls', () => {
    const backend = PgVectorBackend.fromConfig({
      databaseUrl: DB_URL,
      embeddingModel: 'm',
      embeddingDim: LOCAL_DIM,
      vectorWeight: 0.7,
      keywordWeight: 0.3,
      timeDecayHalfLifeDays: 0,
    } as unknown as EngramConfig);
    const rowToChunk = (backend as unknown as { rowToChunk: (r: unknown) => Chunk }).rowToChunk.bind(backend);

    const ts = new Date('2026-06-01T00:00:00Z');
    // Full row.
    const full = rowToChunk({
      id: 'r1',
      content: 'body',
      repo: 'repoA',
      branch: 'br',
      timestamp: ts,
      file_paths: ['a.ts'],
      exit_code: 0,
      session_id: 'sess',
      cwd: '/w',
      tier: 'raw',
      owner: 'o',
      dream_type: 'decision',
      source_chunk_ids: ['s1'],
      trajectory_id: 't1',
      chunk_index: 3,
      chunk_count: 9,
      artifacts: [{ kind: 'file', ref: 'a.ts', tool: 'Edit' }],
    });
    expect(full).toEqual({
      id: 'r1',
      embedding: [],
      content: 'body',
      metadata: {
        repo: 'repoA',
        branch: 'br',
        timestamp: ts,
        filePaths: ['a.ts'],
        exitCode: 0,
        sessionId: 'sess',
        cwd: '/w',
        tier: 'raw',
        owner: 'o',
        dreamType: 'decision',
        sourceChunkIds: ['s1'],
        trajectoryId: 't1',
        chunkIndex: 3,
        chunkCount: 9,
        artifacts: [{ kind: 'file', ref: 'a.ts', tool: 'Edit' }],
      },
    });

    // Sparse row: nullable text columns coalesce to '', missing optionals → undefined.
    const sparse = rowToChunk({ id: 'r2', content: 'c', tier: 'dream', timestamp: ts, exit_code: null });
    expect(sparse.metadata.repo).toBe('');
    expect(sparse.metadata.branch).toBe('');
    expect(sparse.metadata.cwd).toBe('');
    expect(sparse.metadata.sessionId).toBe('');
    expect(sparse.metadata.filePaths).toEqual([]);
    expect(sparse.metadata.exitCode).toBeNull();
    expect(sparse.metadata.owner).toBeUndefined();
    expect(sparse.metadata.chunkIndex).toBeUndefined();
    expect(sparse.metadata.artifacts).toBeUndefined();
    expect(sparse.embedding).toEqual([]);
  });
});
