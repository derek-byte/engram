import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import type { Artifact, Chunk, RawEvent } from '../types/index.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { CHUNKER_VERSION } from './chunker.ts';
import { LOCAL_DIM } from '../config/defaults.ts';
import { Embedder } from './embed.ts';
import { injectDocuments, type InjectDoc } from './inject.ts';
import { parseJsonl } from './parser.ts';
import { FakeProvider, testConfig } from './testkit.ts';

const LIVE = process.env.ENGRAM_TEST_LIVE === '1';
const DB_URL =
  process.env.ENGRAM_DATABASE_URL ?? 'postgresql://engram:engram@localhost:5432/engram';
const OWNER = 'test:invariants';

// Match the live 384-dim column; a deterministic fake avoids a fastembed download
// while still exercising the real inject → search → retract path against Postgres.
const FAKE_MODEL = 'test-fake-384';

describe('live pgvector inject → search → retract', () => {
  test.skipIf(!LIVE)('injects under a test owner, finds it, retracts cleanly', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    const raw = postgres(DB_URL, { prepare: false, onnotice: () => {} });
    const provider = new FakeProvider({ dim: LOCAL_DIM, model: FAKE_MODEL });
    // No embedding cache: keep the shared embedding_cache table free of test rows.
    const embedder = new Embedder(provider);

    try {
      await backend.initialize();
      // Pre-clean in case a prior aborted run left rows.
      await backend.deleteByOwnerPrefix('test:');

      const doc: InjectDoc = {
        id: 'live-doc-1',
        content: 'engram exactly-once invariant live integration probe',
        owner: OWNER,
        source: 'live-test',
      };
      const res = await injectDocuments([doc], { backend, embedder, config: testConfig() });
      expect(res.embedded).toBeGreaterThan(0);

      const queryVec = await embedder.embedOne(doc.content);
      const hits = await backend.search(queryVec, doc.content, {
        owner: OWNER,
        exhaustive: true,
        limit: 5,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.chunk.content).toContain('exactly-once invariant');

      const del = await backend.deleteByOwner(OWNER);
      expect(del.chunks).toBeGreaterThan(0);

      // Cleanup leaves zero test:-owned rows in either table.
      const [{ chunks }] = await raw<Array<{ chunks: string }>>`
        SELECT COUNT(*)::text AS chunks FROM chunks WHERE owner LIKE 'test:%'`;
      const [{ events }] = await raw<Array<{ events: string }>>`
        SELECT COUNT(*)::text AS events FROM raw_events WHERE owner LIKE 'test:%'`;
      expect(Number(chunks)).toBe(0);
      expect(Number(events)).toBe(0);
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await raw.end();
      await backend.close();
    }
  });
});

describe('live pgvector artifacts column round-trips through row mappings', () => {
  test.skipIf(!LIVE)('upsert → getTrajectory / getUnitChunks return the artifacts', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    const OWNER_A = 'test:artifacts';
    const artifacts: Artifact[] = [
      { kind: 'file', ref: '/src/x.ts', tool: 'Write' },
      { kind: 'pr', ref: 'https://github.com/acme/engram/pull/1', tool: 'Bash' },
    ];
    const chunk: Chunk = {
      id: `test-artifact-${crypto.randomUUID()}`,
      embedding: new Array(LOCAL_DIM).fill(0.01),
      content: 'artifact round-trip probe',
      metadata: {
        repo: 'engram',
        branch: 'main',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        filePaths: ['/src/x.ts'],
        exitCode: null,
        sessionId: 's-artifacts',
        cwd: '/tmp/engram',
        tier: 'raw',
        owner: OWNER_A,
        trajectoryId: 'traj-artifacts',
        chunkIndex: 0,
        chunkCount: 1,
        artifacts,
      },
    };
    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');
      await backend.upsert([chunk]);

      const byTraj = await backend.getTrajectory('traj-artifacts');
      expect(byTraj[0]!.metadata.artifacts).toEqual(artifacts);

      const byUnit = await backend.getUnitChunks(OWNER_A, 's-artifacts', 'engram', 'raw');
      expect(byUnit[0]!.metadata.artifacts).toEqual(artifacts);

      // setChunkArtifacts (the backfill sweep primitive) overwrites in place.
      const replacement: Artifact[] = [{ kind: 'url', ref: 'https://example.com', tool: 'Bash' }];
      const updated = await backend.setChunkArtifacts('traj-artifacts', replacement);
      expect(updated).toBe(1);
      const after = await backend.getTrajectory('traj-artifacts');
      expect(after[0]!.metadata.artifacts).toEqual(replacement);
    } finally {
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await backend.close();
    }
  });
});

describe('live pgvector jsonb accepts sanitized payloads', () => {
  test.skipIf(!LIVE)('a payload with   / lone surrogates inserts (post-parse sanitized)', async () => {
    const backend = new PgVectorBackend(DB_URL, LOCAL_DIM, FAKE_MODEL, CHUNKER_VERSION);
    const dir = join(tmpdir(), `engram-live-unicode-${crypto.randomUUID()}`);
    const path = join(dir, 'session.jsonl');
    const OWNER_U = 'test:unicode';
    // Real NUL / lone-surrogate chars → JSON.stringify emits them as   / \udXXX
    // escapes in the file — the exact byte pattern that killed the cs-240 ingest.
    const NUL = String.fromCharCode(0);
    const LONE = String.fromCharCode(0xd83d);
    const bad = {
      type: 'assistant',
      uuid: 'u1',
      sessionId: 's-unicode',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `pdf${NUL}extract${LONE} of notes` }],
      },
    };
    try {
      await backend.initialize();
      await backend.deleteByOwnerPrefix('test:');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(bad) + '\n', 'utf-8');

      // Exercise the real seam: parseJsonl sanitizes, then the parsed payload
      // (which pre-fix carried the fatal escapes) goes into jsonb.
      const msgs = parseJsonl(path);
      expect(msgs.length).toBe(1);
      const event: RawEvent = {
        owner: OWNER_U,
        source: 'claude-code',
        sessionId: 's-unicode',
        contentSha256: `test-unicode-${crypto.randomUUID()}`,
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        payload: msgs,
      };
      const inserted = await backend.insertRawEvents([event]);
      expect(inserted).toBe(1);

      const del = await backend.deleteByOwner(OWNER_U);
      expect(del.rawEvents).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await backend.deleteByOwnerPrefix('test:').catch(() => {});
      await backend.close();
    }
  });
});
