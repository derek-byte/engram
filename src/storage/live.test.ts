import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import type { Chunk, EngramConfig, RawEvent, ScoringConfig } from '../types/index.ts';
import { PgVectorBackend } from './pgvector.ts';
import { FakeBackend } from '../ingest/testkit.ts';
import { CHUNKER_VERSION } from '../types/index.ts';
import { LOCAL_DIM } from '../config/defaults.ts';

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
      expect(ver2?.value).toBe('2');
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
      recencyWeight: 0.1,
      recencyHalfLifeDays: 30,
      importanceWeight: 0.1,
    } as unknown as EngramConfig;

    const backend = PgVectorBackend.fromConfig(config);
    // Test seam: assert the private scoring/chunkerVersion fields fromConfig set.
    const seam = backend as unknown as { scoring: ScoringConfig; chunkerVersion: string; embeddingModel: string };
    expect(seam.scoring).toEqual({
      vectorWeight: 0.42,
      keywordWeight: 0.58,
      timeDecayHalfLifeDays: 14,
      recencyWeight: 0.1,
      recencyHalfLifeDays: 30,
      importanceWeight: 0.1,
    });
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
    expect(sparse.metadata.invalidAt).toBeUndefined();
    expect(sparse.metadata.supersededBy).toBeUndefined();
    expect(sparse.embedding).toEqual([]);
  });
});

// --- FakeBackend tombstone semantics (no pg): mirrors PgVectorBackend ---------

describe('FakeBackend supersession tombstones (no pg)', () => {
  const OWNER2 = 'test:fake-tomb';

  function fakeChunk(id: string, tier: 'raw' | 'dream' | 'wiki' = 'raw'): Chunk {
    return {
      id,
      embedding: [1, 0, 0, 0],
      content: `content of ${id}`,
      metadata: {
        repo: 'r',
        branch: 'main',
        timestamp: new Date('2026-06-01T00:00:00Z'),
        filePaths: [],
        exitCode: null,
        sessionId: 's1',
        cwd: '/w',
        tier,
        owner: OWNER2,
        trajectoryId: `traj:${id}`,
      },
    };
  }

  test('invalidate excludes from search/aggregateUnits/getUnitChunks/count; includeSuperseded opts back in', async () => {
    const backend = new FakeBackend();
    await backend.upsert([fakeChunk('a'), fakeChunk('b')]);

    expect(await backend.invalidateChunks(['a'], OWNER2, 'raw', 'x')).toBe(1);
    expect(backend.invalidatedIds).toEqual(['a']);
    expect(backend.deletedIds).toEqual([]); // soft only

    // search: default live-only, includeSuperseded returns the tombstone too.
    const live = await backend.search([1, 0, 0, 0], 'content', { owner: OWNER2, limit: 10 });
    expect(live.map((r) => r.chunk.id)).toEqual(['b']);
    const all = await backend.search([1, 0, 0, 0], 'content', { owner: OWNER2, limit: 10, includeSuperseded: true });
    expect(all.map((r) => r.chunk.id).sort()).toEqual(['a', 'b']);
    const tomb = all.find((r) => r.chunk.id === 'a')!.chunk;
    expect(tomb.metadata.invalidAt).toBeInstanceOf(Date);
    expect(tomb.metadata.supersededBy).toBe('x');

    // aggregateUnits / getUnitChunks / count all serve the live view.
    const units = await backend.listSynthesisUnits({ owner: OWNER2 });
    expect(units).toHaveLength(1);
    expect(units[0]!.chunkIds).toEqual(['b']);
    expect((await backend.getUnitChunks(OWNER2, 's1', 'r')).map((c) => c.id)).toEqual(['b']);
    expect(await backend.count()).toBe(1);

    // Idempotent: re-invalidating preserves the first tombstone.
    const firstStamp = backend.chunks.get('a')!.metadata.invalidAt;
    expect(await backend.invalidateChunks(['a'], OWNER2, 'raw', 'y')).toBe(0);
    expect(backend.chunks.get('a')!.metadata.invalidAt).toBe(firstStamp);
    expect(backend.chunks.get('a')!.metadata.supersededBy).toBe('x');
  });

  test('re-upsert of an invalidated id clears the tombstone (resurrection)', async () => {
    const backend = new FakeBackend();
    await backend.upsert([fakeChunk('a')]);
    await backend.invalidateChunks(['a'], OWNER2, 'raw', 'x');
    expect(backend.liveChunks()).toHaveLength(0);

    await backend.upsert([fakeChunk('a')]);
    const c = backend.chunks.get('a')!;
    expect(c.metadata.invalidAt).toBeUndefined();
    expect(c.metadata.supersededBy).toBeUndefined();
    expect(backend.liveChunks().map((x) => x.id)).toEqual(['a']);
    expect(await backend.count()).toBe(1);
  });
});

// --- Live supersession + scoring (memory quality Lane 2) ----------------------

describe('live supersession tombstones + scoring', () => {
  const TOMB_OWNER = 'test:tombstone';

  test.skipIf(!LIVE)('invalidateChunks: default search excludes, includeSuperseded surfaces tombstone metadata', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');

      const a = rawChunk('test:tomb-a', 1, { owner: TOMB_OWNER });
      const b = rawChunk('test:tomb-b', 2, { owner: TOMB_OWNER });
      await backend.upsert([a, b]);
      expect(await backend.invalidateChunks(['test:tomb-a'], TOMB_OWNER, 'raw', 'x')).toBe(1);
      // Idempotent second call flips nothing.
      expect(await backend.invalidateChunks(['test:tomb-a'], TOMB_OWNER, 'raw', 'y')).toBe(0);

      const filters = { owner: TOMB_OWNER, exhaustive: true, limit: 10 };
      const live = await backend.search(vec(1), 'chunk content body', filters);
      expect(live.map((r) => r.chunk.id)).toEqual(['test:tomb-b']);

      const all = await backend.search(vec(1), 'chunk content body', { ...filters, includeSuperseded: true });
      expect(all.map((r) => r.chunk.id).sort()).toEqual(['test:tomb-a', 'test:tomb-b']);
      const tomb = all.find((r) => r.chunk.id === 'test:tomb-a')!.chunk;
      expect(tomb.metadata.invalidAt).toBeInstanceOf(Date);
      expect(tomb.metadata.supersededBy).toBe('x'); // first tombstone preserved
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await backend.close();
    }
  });

  test.skipIf(!LIVE)('resurrection: re-upsert of an invalidated id clears invalid_at', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    const admin = postgres(DB_URL, { prepare: false, onnotice: () => {} });
    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');

      const c = rawChunk('test:tomb-res', 1, { owner: TOMB_OWNER });
      await backend.upsert([c]);
      await backend.invalidateChunks(['test:tomb-res'], TOMB_OWNER, 'raw', 'gone');

      const probe = async () => {
        const [r] = await admin<Array<{ invalid_at: Date | null; superseded_by: string | null }>>`
          SELECT invalid_at, superseded_by FROM chunks WHERE id = 'test:tomb-res'
        `;
        return r!;
      };
      const dead = await probe();
      expect(dead.invalid_at).toBeInstanceOf(Date);
      expect(dead.superseded_by).toBe('gone');

      // Content reverts → same content-addressed id re-upserts → tombstone cleared.
      await backend.upsert([c]);
      const alive = await probe();
      expect(alive.invalid_at).toBeNull();
      expect(alive.superseded_by).toBeNull();
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await admin.end();
      await backend.close();
    }
  });

  test.skipIf(!LIVE)('scoring: importance prior ranks wiki over raw, recency ranks new over old, zero weights = old formula', async () => {
    const scoringOf = (over: Partial<ScoringConfig>): ScoringConfig => ({
      vectorWeight: 0.7,
      keywordWeight: 0.3,
      timeDecayHalfLifeDays: 0,
      recencyWeight: 0,
      recencyHalfLifeDays: 30,
      importanceWeight: 0,
      ...over,
    });
    const mkBackend = (over: Partial<ScoringConfig>) =>
      new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION, scoringOf(over));

    const setup = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    try {
      await setup.initialize();
      await setup.deleteByOwnerPrefix('test:');

      // Identical embeddings; only tier and timestamp differ.
      const now = new Date();
      const old = new Date('2020-01-01T00:00:00Z');
      const mk = (id: string, tier: 'raw' | 'wiki', ts: Date): Chunk =>
        rawChunk(id, 7, { owner: TOMB_OWNER, timestamp: ts, tier });
      await setup.upsert([
        mk('test:score-wiki', 'wiki', now),
        mk('test:score-raw', 'raw', now),
        mk('test:score-old', 'raw', old),
      ]);

      const filters = { owner: TOMB_OWNER, exhaustive: true, limit: 10 };

      // Importance: wiki outranks raw at equal similarity/recency.
      const imp = mkBackend({ importanceWeight: 0.5 });
      const impRes = await imp.search(vec(7), 'zzz-no-keyword-match', filters);
      expect(impRes.map((r) => r.chunk.id).slice(0, 2)).toEqual(['test:score-wiki', 'test:score-raw']);
      await imp.close();

      // Recency: with a high recencyWeight the recent raw chunk beats the old one.
      const rec = mkBackend({ recencyWeight: 5, importanceWeight: 0 });
      const recRes = await rec.search(vec(7), 'zzz-no-keyword-match', { ...filters, tier: 'raw' as const });
      expect(recRes.map((r) => r.chunk.id)).toEqual(['test:score-raw', 'test:score-old']);
      await rec.close();

      // Regression guard: all three new weights 0 → combined equals the old
      // vectorWeight*sim + keywordWeight*kw formula exactly.
      const zero = mkBackend({});
      const zeroRes = await zero.search(vec(7), 'zzz-no-keyword-match', filters);
      expect(zeroRes.length).toBeGreaterThan(0);
      for (const r of zeroRes) {
        expect(r.combined).toBeCloseTo(0.7 * r.similarity + 0.3 * r.keywordRank, 6);
      }
      await zero.close();
    } finally {
      await setup.deleteByOwnerPrefix('test:').catch(() => {});
      await setup.close();
    }
  });
});
