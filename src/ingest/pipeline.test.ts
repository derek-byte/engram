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

    // Recovery: all chunks present exactly once, no duplicates. The cursor is the
    // last trajectory's index (V2): a single-trajectory session pins it at 0.
    expect(ts.store.getCursor(SESSION)).toBe(0);
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

describe('ingestFile V2 supersession (appended-content data loss)', () => {
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

  test('THE REPRO: content appended to the last turn is embedded, not dropped', async () => {
    // One-turn session ingests fine.
    const first = writeSession([{ user: 'explain the auth flow' }]);
    const r1 = await ingestFile(first, deps);
    expect(r1.embedded).toBeGreaterThan(0);
    const idsAfter1 = new Set(backend.chunks.keys());
    expect(idsAfter1.size).toBeGreaterThan(0);

    // The assistant reply lands on the SAME turn: content grows, trajectory COUNT
    // stays 1. The old count-based cursor sliced this away → embedded 0 → lost.
    const grown = writeSession([
      { user: 'explain the auth flow', assistant: 'the auth flow uses JWT tokens validated at the gateway' },
    ]);
    const r2 = await ingestFile(grown, deps);

    expect(r2.embedded).toBeGreaterThan(0); // was 0 under the bug
    // The appended text is actually in the backend now.
    const contents = [...backend.chunks.values()].map((c) => c.content.toLowerCase()).join('\n');
    expect(contents).toContain('jwt tokens');
    // The pre-append turn's chunk ids were superseded (deleted), so no duplicate
    // content lingers under the old ids.
    for (const id of idsAfter1) expect(backend.chunks.has(id)).toBe(false);
    assertDenseProvenance([...backend.chunks.values()]);
    // Single-trajectory session pins the cursor at 0.
    expect(ts.store.getCursor(SESSION)).toBe(0);
  });

  test('new-turn append: cursor advances to N-1, prior turn skipped, new turn embedded', async () => {
    const one = writeSession([{ user: 'turn one' }]);
    await ingestFile(one, deps);
    expect(ts.store.getCursor(SESSION)).toBe(0);
    const idsAfter1 = new Set(backend.chunks.keys());

    const two = writeSession([{ user: 'turn one' }, { user: 'turn two brand new' }]);
    const r = await ingestFile(two, deps);

    expect(r.embedded).toBeGreaterThan(0);
    expect(r.skipped).toBeGreaterThan(0); // turn one skipped via hasSeen
    expect(ts.store.getCursor(SESSION)).toBe(1); // advanced to last index

    // Turn one was NOT superseded — its chunks survive; only turn two is new.
    for (const id of idsAfter1) expect(backend.chunks.has(id)).toBe(true);
    const newIds = [...backend.chunks.keys()].filter((id) => !idsAfter1.has(id));
    expect(newIds.length).toBeGreaterThan(0);
    for (const id of newIds) expect(backend.chunks.get(id)!.content.toLowerCase()).toContain('turn two');
  });

  test('no-change re-ingest embeds nothing and leaves the cursor put', async () => {
    const path = writeSession([{ user: 'stable question', assistant: 'stable answer' }]);
    await ingestFile(path, deps);
    const cursorAfter1 = ts.store.getCursor(SESSION);
    const rows = backend.chunks.size;
    const upserts = backend.upsertCalls;

    const r2 = await ingestFile(path, deps);
    expect(r2.embedded).toBe(0);
    expect(backend.chunks.size).toBe(rows); // no new chunks
    expect(backend.upsertCalls).toBe(upserts); // upsert not called again
    expect(ts.store.getCursor(SESSION)).toBe(cursorAfter1); // unchanged
  });

  // Review-flagged gap #2: grow-in-place AND a new turn in the SAME ingest — the
  // delete must hit only the stale last-turn ids, and BOTH new turns must embed.
  test('mixed growth: in-place last-turn edit + a new turn together', async () => {
    await ingestFile(writeSession([{ user: 'turn one' }]), deps);
    const idsAfter1 = new Set(backend.chunks.keys());
    backend.deletedIds = [];

    // Turn one grows an assistant reply (in place) AND turn two is appended.
    const grown = writeSession([
      { user: 'turn one', assistant: 'answer one references pgvector hnsw' },
      { user: 'turn two brand new' },
    ]);
    const r = await ingestFile(grown, deps);

    expect(r.embedded).toBeGreaterThan(0);
    // Supersession deleted exactly the stale turn-one chunk ids, nothing else.
    expect(new Set(backend.deletedIds)).toEqual(idsAfter1);
    const contents = [...backend.chunks.values()].map((c) => c.content.toLowerCase());
    expect(contents.join('\n')).toContain('pgvector hnsw'); // grown turn one embedded
    expect(contents.join('\n')).toContain('turn two'); // new turn embedded
    expect(ts.store.getCursor(SESSION)).toBe(1);
    assertDenseProvenance([...backend.chunks.values()]);
  });

  // Review-flagged gap #1: a legacy count-based cursor (pre-wave-12 rows have
  // chunkOffset = trajectory COUNT and no recorded ids) must not lose data or
  // fire a spurious supersession delete on the first post-upgrade ingest.
  test('legacy count cursor migrates without loss or spurious delete', async () => {
    const path = writeSession([{ user: 'q one', assistant: 'a one' }, { user: 'q two', assistant: 'a two' }]);
    await ingestFile(path, deps); // establishes real chunks
    // Simulate a legacy row: cursor = COUNT (2), no last-trajectory identity.
    ts.store.setCursor(SESSION, 2);
    backend.deletedIds = [];
    const rowsBefore = backend.chunks.size;

    // Unchanged file re-ingested under the legacy cursor.
    const r = await ingestFile(path, deps);
    expect(r.embedded).toBe(0); // nothing lost, nothing re-embedded
    expect(backend.deletedIds).toEqual([]); // no recorded ids ⇒ no supersession delete
    expect(backend.chunks.size).toBe(rowsBefore);
    expect(ts.store.getCursor(SESSION)).toBe(1); // count 2 → index 1
  });

  // Review-confirmed residual: legacy cursor + in-place growth + a NEW appended
  // turn in the same first post-upgrade ingest. Math.min alone leaves the cursor
  // at the appended turn, slicing away the grown old turn — permanently lost.
  // The explicit count→index mapping must re-examine it.
  test('legacy cursor + grown last turn + appended turn: nothing is lost', async () => {
    const path = writeSession([{ user: 'legacy turn one' }]);
    await ingestFile(path, deps);
    // Simulate the pre-wave-12 row: cursor = COUNT (1), no last-turn identity.
    ts.store.setCursor(SESSION, 1);

    // Turn one grows in place AND turn two is appended before the next ingest.
    const grown = writeSession([
      { user: 'legacy turn one', assistant: 'grown legacy reply about vector indexes' },
      { user: 'brand new turn two' },
    ]);
    const r = await ingestFile(grown, deps);
    expect(r.embedded).toBeGreaterThan(0);
    const contents = [...backend.chunks.values()].map((c) => c.content.toLowerCase()).join('\n');
    expect(contents).toContain('vector indexes'); // grown turn re-examined, not sliced away
    expect(contents).toContain('turn two'); // appended turn embedded
    expect(ts.store.getCursor(SESSION)).toBe(1); // index semantics from here on
    assertDenseProvenance([...backend.chunks.values()]);
  });

  // Review-confirmed (seen⇒present): after a supersession delete, the retracted
  // ids' seen-markers must be forgotten too. Otherwise content that reverts to a
  // previously-seen state (external file restore, sync-conflict overwrite) is
  // hasSeen-skipped while its replacement was just deleted — the backend ends
  // up holding NEITHER version of the turn.
  test('A→B→A revert of the last turn re-embeds A instead of losing both', async () => {
    const a = writeSession([{ user: 'revert turn' }]);
    await ingestFile(a, deps);
    const aIds = new Set(backend.chunks.keys());
    expect(aIds.size).toBeGreaterThan(0);

    const b = writeSession([{ user: 'revert turn', assistant: 'transient reply later reverted' }]);
    await ingestFile(b, deps);
    for (const id of aIds) expect(backend.chunks.has(id)).toBe(false); // A superseded by B

    // The file reverts to A. B is superseded in turn; A's chunks must be
    // re-embedded, not skipped as already-seen.
    const a2 = writeSession([{ user: 'revert turn' }]);
    const r = await ingestFile(a2, deps);
    expect(r.embedded).toBeGreaterThan(0); // was 0 under the bug — neither version survived
    for (const id of aIds) expect(backend.chunks.has(id)).toBe(true);
    const contents = [...backend.chunks.values()].map((c) => c.content.toLowerCase()).join('\n');
    expect(contents).not.toContain('transient reply');
  });

  // Review-flagged gap #3: a crash between the supersession delete and the upsert
  // is recoverable — the next ingest re-derives and re-embeds, no permanent loss.
  test('crash after supersession delete, before upsert, recovers next run', async () => {
    await ingestFile(writeSession([{ user: 'crash turn' }]), deps);

    const grown = writeSession([{ user: 'crash turn', assistant: 'grown reply about connection pooling' }]);
    backend.upsertHook = () => {
      throw new Error('simulated crash mid-upsert');
    };
    await expect(ingestFile(grown, deps)).rejects.toThrow('simulated crash');

    // Cursor untouched by the throw (crash-safety invariant); recover cleanly.
    backend.upsertHook = undefined;
    const r = await ingestFile(grown, deps);
    expect(r.embedded).toBeGreaterThan(0);
    const contents = [...backend.chunks.values()].map((c) => c.content.toLowerCase()).join('\n');
    expect(contents).toContain('connection pooling');
    assertDenseProvenance([...backend.chunks.values()]);
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
