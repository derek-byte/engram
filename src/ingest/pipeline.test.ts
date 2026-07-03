import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Embedder } from './embed.ts';
import { ingestFile, type PipelineDeps } from './pipeline.ts';
import { FakeBackend, FakeProvider, tempStore, testConfig, type TempStore } from './testkit.ts';
import { chunkMessages, chunkTrajectory } from './chunker.ts';
import { chunkHash, trajectoryHash } from './hash.ts';
import { parseJsonl } from './parser.ts';
import type { Chunk } from '../types/index.ts';

// Recompute the exact chunk ids the pipeline will derive from a session file,
// so tests can assert on specific seen/unseen hashes.
function expectedChunkIds(path: string): string[] {
  const trajectories = chunkMessages(parseJsonl(path));
  const ids: string[] = [];
  for (const t of trajectories) {
    const trajectoryId = trajectoryHash(t);
    chunkTrajectory(t).forEach((text, i) => ids.push(chunkHash(trajectoryId, i, text)));
  }
  return ids;
}

const SESSION = 'session-fixed';

interface Turn {
  user: string;
  assistant?: string;
}

const files: string[] = [];

function writeSession(turns: Turn[]): string {
  const lines: string[] = [];
  let t = 0;
  const stamp = () => new Date(1_700_000_000_000 + t++ * 1000).toISOString();
  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        type: 'user',
        sessionId: SESSION,
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
          sessionId: SESSION,
          cwd: '/tmp/engram',
          gitBranch: 'main',
          timestamp: stamp(),
          message: { role: 'assistant', content: [{ type: 'text', text: turn.assistant }] },
        })
      );
    }
  }
  const path = join(tmpdir(), `engram-session-${crypto.randomUUID()}.jsonl`);
  writeFileSync(path, lines.join('\n'));
  files.push(path);
  return path;
}

function groupByTrajectory(chunks: Chunk[]): Map<string, Chunk[]> {
  const m = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const key = c.metadata.trajectoryId!;
    (m.get(key) ?? m.set(key, []).get(key)!).push(c);
  }
  return m;
}

// Every trajectory's chunks must be dense 0..count-1, ordered, with a matching chunkCount.
function assertDenseProvenance(chunks: Chunk[]): void {
  for (const [, group] of groupByTrajectory(chunks)) {
    const indices = group.map((c) => c.metadata.chunkIndex!).sort((a, b) => a - b);
    expect(indices).toEqual([...group.keys()]);
    for (const c of group) expect(c.metadata.chunkCount).toBe(group.length);
  }
}

describe('ingestFile exactly-once', () => {
  let ts: TempStore;
  let backend: FakeBackend;
  let deps: PipelineDeps;

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

  afterEach(() => ts.cleanup());

  test('re-ingesting an unchanged file embeds and upserts nothing new', async () => {
    const path = writeSession([{ user: 'first question' }, { user: 'second question' }]);

    const r1 = await ingestFile(path, deps);
    expect(r1.embedded).toBeGreaterThan(0);
    const chunksAfter1 = backend.chunks.size;
    const upsertsAfter1 = backend.upsertCalls;
    const rawAfter1 = backend.rawEvents.size;
    assertDenseProvenance([...backend.chunks.values()]);

    const r2 = await ingestFile(path, deps);
    expect(r2.embedded).toBe(0);
    expect(backend.chunks.size).toBe(chunksAfter1); // no new chunks
    expect(backend.upsertCalls).toBe(upsertsAfter1); // upsert not called again
    expect(backend.rawEvents.size).toBe(rawAfter1); // no new raw events
  });

  test('partial-file growth: only appended trajectories are processed', async () => {
    const path = writeSession([{ user: 'alpha' }, { user: 'bravo' }]);
    await ingestFile(path, deps);
    const idsAfterFirst = new Set(backend.chunks.keys());
    const trajsAfterFirst = groupByTrajectory([...backend.chunks.values()]).size;
    expect(trajsAfterFirst).toBe(2);

    // Append a third trajectory (same session), keeping the first two verbatim.
    const grown = writeSession([{ user: 'alpha' }, { user: 'bravo' }, { user: 'charlie appended' }]);
    // writeSession made a new path; ingestFile keys the cursor by sessionId, which is shared.
    const r = await ingestFile(grown, deps);

    expect(r.embedded).toBeGreaterThan(0);
    const groups = groupByTrajectory([...backend.chunks.values()]);
    expect(groups.size).toBe(3); // exactly one new trajectory
    // The only new chunk ids belong to the appended trajectory.
    const newIds = [...backend.chunks.keys()].filter((id) => !idsAfterFirst.has(id));
    for (const id of newIds) {
      expect(backend.chunks.get(id)!.content.toLowerCase()).toContain('charlie');
    }
    assertDenseProvenance([...backend.chunks.values()]);
  });
});

describe('ingestFile crash safety (THE invariant)', () => {
  let ts: TempStore;
  let backend: FakeBackend;

  beforeEach(() => {
    ts = tempStore();
    backend = new FakeBackend();
  });
  afterEach(() => ts.cleanup());

  test('a mid-file upsert throw leaves cursor + failed-batch seen-hashes untouched, and re-run recovers with no gaps or dupes', async () => {
    // One big trajectory → many chunks; batchSize 1 makes each chunk its own upsert.
    const big = ('token '.repeat(3000)).trim();
    const path = writeSession([{ user: big }]);

    const config = testConfig({ chunkBatchSize: 1 });
    const embedder = new Embedder(new FakeProvider({ dim: 4 }), backend);
    const deps: PipelineDeps = { backend, embedder, local: ts.store, config };

    // Fail the SECOND upsert (call index 1); the first has already committed.
    backend.upsertHook = (_chunks, callIndex) => {
      if (callIndex === 1) throw new Error('simulated backend failure');
    };

    const ids = expectedChunkIds(path);
    expect(ids.length).toBeGreaterThan(1);

    await expect(ingestFile(path, deps)).rejects.toThrow('simulated backend failure');

    // Crash-safety invariants:
    expect(ts.store.getCursor(SESSION)).toBe(0); // cursor did NOT advance
    expect(backend.chunks.size).toBe(1); // only the first batch committed
    expect(ts.store.hasSeen(ids[0]!)).toBe(true); // committed batch marked seen
    expect(ts.store.hasSeen(ids[1]!)).toBe(false); // failed batch's hash untouched

    // Re-run with the backend healthy.
    backend.upsertHook = undefined;
    const r2 = await ingestFile(path, deps);

    // Recovery: cursor advances, all chunks present exactly once, no duplicates.
    expect(ts.store.getCursor(SESSION)).toBe(1);
    const all = [...backend.chunks.values()];
    expect(all.length).toBeGreaterThan(1);
    // The first chunk was skipped as already-seen on re-run; the rest were embedded.
    expect(r2.skipped).toBe(1);
    expect(r2.embedded).toBe(all.length - 1);

    // Dense provenance, unique ids, single trajectory.
    const groups = groupByTrajectory(all);
    expect(groups.size).toBe(1);
    assertDenseProvenance(all);
    expect(new Set(backend.chunks.keys()).size).toBe(all.length);
  });
});

afterEach(() => {
  for (const f of files.splice(0)) {
    try {
      rmSync(f);
    } catch {
      // best effort
    }
  }
});
