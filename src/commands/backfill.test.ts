import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Embedder } from '../ingest/embed.ts';
import { FakeBackend, FakeProvider, tempStore, testConfig, type TempStore } from '../ingest/testkit.ts';
import { chunkMessages, chunkTrajectory } from '../ingest/chunker.ts';
import { CHUNKER_VERSION } from '../types/index.ts';
import { chunkHash, trajectoryHash } from '../ingest/hash.ts';
import { parseJsonl } from '../ingest/parser.ts';
import type { Chunk, EmbeddedChunk } from '../types/index.ts';
import { runBackfillIngest, type BackfillDeps } from './backfill.ts';
import { DEFAULT_OWNER } from '../config/index.ts';

const SESSION = 'session-reindex';
const files: string[] = [];

function writeSession(turns: Array<{ user: string; assistant?: string }>, sessionId = SESSION): string {
  const lines: string[] = [];
  let t = 0;
  const stamp = () => new Date(1_700_000_000_000 + t++ * 1000).toISOString();
  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: '/tmp/engram',
        gitBranch: 'main',
        timestamp: stamp(),
        message: { role: 'user', content: [{ type: 'text', text: turn.user }] },
      })
    );
    if (turn.assistant) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          sessionId,
          cwd: '/tmp/engram',
          gitBranch: 'main',
          timestamp: stamp(),
          message: { role: 'assistant', content: [{ type: 'text', text: turn.assistant }] },
        })
      );
    }
  }
  const path = join(tmpdir(), `engram-backfill-${crypto.randomUUID()}.jsonl`);
  writeFileSync(path, lines.join('\n'));
  files.push(path);
  return path;
}

// The exact chunk ids the current chunker derives from a session file.
function expectedChunkIds(path: string): string[] {
  const trajectories = chunkMessages(parseJsonl(path));
  const ids: string[] = [];
  for (const t of trajectories) {
    const trajectoryId = trajectoryHash(t);
    chunkTrajectory(t).forEach((text, i) => ids.push(chunkHash(trajectoryId, i, text)));
  }
  return ids;
}

// Seed a fake "old-chunker" raw chunk directly into the backend (as if a prior
// chunker version produced it): different id/content than anything the current
// chunker derives.
function seedStaleChunk(backend: FakeBackend, id: string, owner = DEFAULT_OWNER): void {
  const chunk: EmbeddedChunk = {
    id,
    embedding: [1, 0, 0, 0],
    content: `stale v1 packing for ${id}`,
    metadata: {
      repo: 'engram',
      branch: 'main',
      timestamp: new Date(1_600_000_000_000),
      filePaths: [],
      artifacts: [],
      exitCode: null,
      sessionId: SESSION,
      cwd: '/tmp/engram',
      owner,
      tier: 'raw',
      trajectoryId: 'stale-traj',
      chunkIndex: 0,
      chunkCount: 1,
    },
  };
  backend.chunks.set(id, chunk);
  backend.chunkerVersions.set(id, 'v1');
}

describe('runBackfillIngest --reindex', () => {
  let ts: TempStore;
  let backend: FakeBackend;
  let deps: BackfillDeps;

  beforeEach(() => {
    ts = tempStore();
    backend = new FakeBackend();
    deps = {
      backend,
      embedder: new Embedder(new FakeProvider({ dim: 4 }), backend),
      local: ts.store,
      config: testConfig({ chunkBatchSize: 32 }),
    };
  });
  afterEach(() => {
    ts.cleanup();
    for (const f of files.splice(0)) {
      try {
        rmSync(f);
      } catch {
        // best effort
      }
    }
  });

  test('reindex replaces v1-stamped chunks with v2 exactly-once', async () => {
    const path = writeSession([{ user: 'question one' }, { user: 'question two', assistant: 'answer two' }]);

    // Simulate a prior v1 index: ingest under a backend stamping 'v1', with the
    // chunks pretending to be old-packing rows, plus real cursor/seen state.
    backend.chunkerVersion = 'v1';
    seedStaleChunk(backend, 'stale-v1-a');
    seedStaleChunk(backend, 'stale-v1-b');
    const plain = await runBackfillIngest([path], deps);
    expect(plain.embedded).toBeGreaterThan(0);
    expect(plain.swept).toBe(0); // not a reindex

    // Chunker "upgrades" to v2. A plain backfill would skip everything (cursor +
    // seen) and leave the v1 rows; reindex must converge on v2-only.
    backend.chunkerVersion = CHUNKER_VERSION;
    const r = await runBackfillIngest([path], deps, { reindex: true });

    expect(r.errors).toBe(0);
    expect(r.embedded).toBeGreaterThan(0); // everything re-embedded
    expect(r.swept).toBe(2); // both seeded stale rows gone
    expect(r.sessions).toBe(1);

    const ids = expectedChunkIds(path);
    expect(new Set(backend.chunks.keys())).toEqual(new Set(ids)); // exactly the v2 set, once each
    for (const id of ids) expect(backend.chunkerVersions.get(id)).toBe(CHUNKER_VERSION);
    expect(backend.chunks.has('stale-v1-a')).toBe(false);
    expect(backend.chunks.has('stale-v1-b')).toBe(false);
  });

  test('id shared across versions is restamped, not swept (upsert conflict restamps chunker_version)', async () => {
    const path = writeSession([{ user: 'tiny turn identical under both chunkers' }]);

    // v1 pass produced this exact chunk (same content-derived id).
    backend.chunkerVersion = 'v1';
    await runBackfillIngest([path], deps);
    const ids = expectedChunkIds(path);
    for (const id of ids) expect(backend.chunkerVersions.get(id)).toBe('v1');

    backend.chunkerVersion = CHUNKER_VERSION;
    const r = await runBackfillIngest([path], deps, { reindex: true });

    // The conflict path restamped the version, so the sweep spared the row.
    expect(r.swept).toBe(0);
    expect(new Set(backend.chunks.keys())).toEqual(new Set(ids));
    for (const id of ids) expect(backend.chunkerVersions.get(id)).toBe(CHUNKER_VERSION);
  });

  test('crash mid-reindex then re-run converges: no v1 leftovers, no duplicates', async () => {
    // Two files so the crash can land between them.
    const a = writeSession([{ user: 'file a question' }], 'session-a');
    const b = writeSession([{ user: 'file b question' }], 'session-b');
    backend.chunkerVersion = 'v1';
    seedStaleChunk(backend, 'stale-v1-x');
    await runBackfillIngest([a, b], deps);

    backend.chunkerVersion = CHUNKER_VERSION;
    // First reindex attempt: the second file's upsert dies mid-run.
    let calls = 0;
    backend.upsertHook = () => {
      calls++;
      if (calls >= 2) throw new Error('simulated crash mid-reindex');
    };
    const crashed = await runBackfillIngest([a, b], deps, { reindex: true });
    expect(crashed.errors).toBe(1);
    expect(crashed.swept).toBe(0); // sweep withheld on a partial pass
    expect(backend.chunks.has('stale-v1-x')).toBe(true); // nothing lost

    // Re-run heals: full pass, then sweep.
    backend.upsertHook = undefined;
    const r = await runBackfillIngest([a, b], deps, { reindex: true });
    expect(r.errors).toBe(0);
    expect(r.swept).toBe(1); // the seeded stale row (per-session v1 ids were restamped or replaced)

    const ids = [...expectedChunkIds(a), ...expectedChunkIds(b)];
    expect(new Set(backend.chunks.keys())).toEqual(new Set(ids)); // no dupes, no leftovers
    for (const id of ids) expect(backend.chunkerVersions.get(id)).toBe(CHUNKER_VERSION);
  });

  test('--reindex without prior state behaves like plain backfill', async () => {
    const path = writeSession([{ user: 'fresh question' }, { user: 'another fresh question' }]);
    const r = await runBackfillIngest([path], deps, { reindex: true });

    expect(r.errors).toBe(0);
    expect(r.swept).toBe(0);
    expect(new Set(backend.chunks.keys())).toEqual(new Set(expectedChunkIds(path)));

    // And it is a no-op when repeated without reindex (cursor/seen intact).
    const again = await runBackfillIngest([path], deps);
    expect(again.embedded).toBe(0);
  });

  test('owner threading: bench owner stamps chunks + raw events and scopes the sweep', async () => {
    const benchDeps: BackfillDeps = { ...deps, owner: 'bench:test' };
    const path = writeSession([{ user: 'bench-owned question' }]);

    // A live-owner stale row must survive a bench-owner reindex sweep.
    seedStaleChunk(backend, 'stale-derek', DEFAULT_OWNER);
    seedStaleChunk(backend, 'stale-bench', 'bench:test');

    const r = await runBackfillIngest([path], benchDeps, { reindex: true });
    expect(r.errors).toBe(0);
    expect(r.swept).toBe(1); // only the bench-owned stale row
    expect(backend.chunks.has('stale-derek')).toBe(true);
    expect(backend.chunks.has('stale-bench')).toBe(false);

    for (const id of expectedChunkIds(path)) {
      expect(backend.chunks.get(id)!.metadata.owner).toBe('bench:test');
    }
    for (const e of backend.rawEvents.values()) {
      expect(e.owner).toBe('bench:test');
    }
  });
});
