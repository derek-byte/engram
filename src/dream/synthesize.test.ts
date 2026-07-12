import { describe, expect, test } from 'bun:test';
import type { Artifact, Chunk } from '../types/index.ts';
import { FakeBackend, FakeDreamLLM, FakeProvider, testConfig } from '../ingest/testkit.ts';
import { Embedder } from '../ingest/embed.ts';
import { fingerprintOf, synthesizeDreams, type SynthesizeDeps } from './synthesize.ts';
import { parseItems } from './llm.ts';

const SRC = 'test:src';
const DREAM = 'test:dream';

function rawChunk(
  id: string,
  sessionId: string,
  repo: string,
  content: string,
  ts = 1_700_000_000_000,
  artifacts?: Artifact[]
): Chunk {
  return {
    id,
    embedding: [],
    content,
    metadata: {
      repo,
      branch: '',
      timestamp: new Date(ts),
      filePaths: [],
      exitCode: null,
      sessionId,
      cwd: '',
      tier: 'raw',
      owner: SRC,
      ...(artifacts ? { artifacts } : {}),
    },
  };
}

function makeDeps(llm: FakeDreamLLM): { backend: FakeBackend; deps: SynthesizeDeps } {
  const backend = new FakeBackend();
  const embedder = new Embedder(new FakeProvider({ dim: 4 }), backend);
  return { backend, deps: { backend, embedder, llm, config: testConfig() } };
}

async function seed(backend: FakeBackend, chunks: Chunk[]): Promise<void> {
  await backend.upsert(chunks);
}

const run = (backend: FakeBackend, deps: SynthesizeDeps, over: Partial<Parameters<typeof synthesizeDreams>[0]> = {}) =>
  synthesizeDreams(
    { sourceOwner: SRC, dreamOwner: DREAM, limit: 20, dryRun: false, ...over },
    deps
  );

describe('fingerprint', () => {
  test('is order-invariant over chunk ids', () => {
    const base = { sessionId: 's', repo: 'r', totalChars: 10, lastTimestamp: new Date(0) };
    const a = fingerprintOf({ ...base, chunkIds: ['a', 'b', 'c'] });
    const b = fingerprintOf({ ...base, chunkIds: ['c', 'b', 'a'] });
    expect(a).toBe(b);
  });

  test('changes when a chunk id is added', () => {
    const base = { sessionId: 's', repo: 'r', totalChars: 10, lastTimestamp: new Date(0) };
    const a = fingerprintOf({ ...base, chunkIds: ['a', 'b'] });
    const b = fingerprintOf({ ...base, chunkIds: ['a', 'b', 'c'] });
    expect(a).not.toBe(b);
  });
});

describe('synthesizeDreams', () => {
  test('writes a dream chunk per extracted item with provenance', async () => {
    const llm = new FakeDreamLLM(() => [{ type: 'decision', text: 'chose pgvector over pinecone' }]);
    const { backend, deps } = makeDeps(llm);
    await seed(backend, [rawChunk('c1', 's1', 'engram', 'we chose pgvector')]);

    const res = await run(backend, deps);
    expect(res.synthesized).toBe(1);
    expect(res.dreamChunks).toBe(1);

    const dreams = [...backend.chunks.values()].filter((c) => c.metadata.tier === 'dream');
    expect(dreams).toHaveLength(1);
    expect(dreams[0]!.metadata.owner).toBe(DREAM);
    expect(dreams[0]!.metadata.dreamType).toBe('decision');
    expect(dreams[0]!.metadata.sourceChunkIds).toEqual(['c1']);
    expect(dreams[0]!.metadata.trajectoryId).toMatch(/^dream:/);
    // Provenance also lands in raw_events (store of record).
    expect([...backend.rawEvents.values()].some((e) => e.source === 'dream')).toBe(true);
  });

  test('re-run skips all unchanged units (no new LLM calls)', async () => {
    const llm = new FakeDreamLLM(() => [{ type: 'fix', text: 'fixed the off-by-one' }]);
    const { backend, deps } = makeDeps(llm);
    await seed(backend, [rawChunk('c1', 's1', 'engram', 'a bug')]);

    await run(backend, deps);
    const callsAfterFirst = llm.callCount;
    const res = await run(backend, deps);

    expect(llm.callCount).toBe(callsAfterFirst);
    expect(res.synthesized).toBe(0);
    expect(res.skipped).toBe(1);
  });

  test('empty extraction records fingerprint but writes no chunk', async () => {
    const llm = new FakeDreamLLM(() => []);
    const { backend, deps } = makeDeps(llm);
    await seed(backend, [rawChunk('c1', 's1', 'engram', 'small talk')]);

    const res = await run(backend, deps);
    expect(res.emptyUnits).toBe(1);
    expect(res.dreamChunks).toBe(0);
    expect([...backend.chunks.values()].filter((c) => c.metadata.tier === 'dream')).toHaveLength(0);
    expect(await backend.getDreamUnits(DREAM)).toHaveLength(1);

    // Re-run is a free skip.
    const before = llm.callCount;
    const res2 = await run(backend, deps);
    expect(llm.callCount).toBe(before);
    expect(res2.skipped).toBe(1);
  });

  test('changed unit supersedes stale dream chunks (soft invalidation, not deletion)', async () => {
    let text = 'first decision';
    const llm = new FakeDreamLLM(() => [{ type: 'decision', text }]);
    const { backend, deps } = makeDeps(llm);
    await seed(backend, [rawChunk('c1', 's1', 'engram', 'v1')]);
    await run(backend, deps);
    const firstId = backend.liveChunks().find((c) => c.metadata.tier === 'dream')!.id;

    // Add a chunk (fingerprint changes) and change the extracted text.
    text = 'revised decision';
    await seed(backend, [rawChunk('c2', 's1', 'engram', 'v2')]);
    const res = await run(backend, deps);

    expect(res.synthesized).toBe(1);
    const liveDreams = backend.liveChunks().filter((c) => c.metadata.tier === 'dream');
    expect(liveDreams).toHaveLength(1);
    expect(liveDreams[0]!.id).not.toBe(firstId);
    expect(liveDreams[0]!.content).toBe('revised decision');

    // The stale dream row REMAINS as a tombstone pointing at its replacement.
    const stale = backend.chunks.get(firstId)!;
    expect(stale.metadata.invalidAt).toBeInstanceOf(Date);
    expect(stale.metadata.supersededBy).toStartWith('dream:');
    expect(backend.invalidatedIds).toContain(firstId);
    expect(backend.deletedIds).not.toContain(firstId); // soft, never hard
  });

  test('--limit defers the rest', async () => {
    const llm = new FakeDreamLLM(() => [{ type: 'gotcha', text: 'watch out' }]);
    const { backend, deps } = makeDeps(llm);
    await seed(backend, [
      rawChunk('a', 's1', 'engram', 'x', 1),
      rawChunk('b', 's2', 'engram', 'y', 2),
      rawChunk('c', 's3', 'engram', 'z', 3),
    ]);

    const res = await run(backend, deps, { limit: 2 });
    expect(res.synthesized).toBe(2);
    expect(res.deferred).toBe(1);
  });

  test('dry-run makes no LLM calls and no writes', async () => {
    const llm = new FakeDreamLLM(() => [{ type: 'decision', text: 'should not run' }]);
    const { backend, deps } = makeDeps(llm);
    await seed(backend, [rawChunk('c1', 's1', 'engram', 'hello')]);

    const res = await run(backend, deps, { dryRun: true });
    expect(llm.callCount).toBe(0);
    expect(res.plan).toHaveLength(1);
    expect(res.plan![0]!.status).toBe('new');
    expect(res.estTotalTokens).toBeGreaterThan(0);
    expect([...backend.chunks.values()].filter((c) => c.metadata.tier === 'dream')).toHaveLength(0);
    expect(await backend.getDreamUnits(DREAM)).toHaveLength(0);
  });

  test('malformed LLM output fails the unit without recording the fingerprint', async () => {
    const llm = new FakeDreamLLM(() => {
      throw new Error('malformed JSON');
    });
    const { backend, deps } = makeDeps(llm);
    await seed(backend, [rawChunk('c1', 's1', 'engram', 'oops')]);

    const res = await run(backend, deps);
    expect(res.failed).toBe(1);
    expect(res.synthesized).toBe(0);
    // Fingerprint not recorded → retried next run.
    expect(await backend.getDreamUnits(DREAM)).toHaveLength(0);
  });
});

describe('artifact propagation', () => {
  const HOTKEY: Artifact = { kind: 'file', ref: 'src/desktop/hotkey.rs', tool: 'Write' };
  const PR: Artifact = { kind: 'pr', ref: 'https://github.com/org/repo/pull/42', tool: 'gh' };

  function dreamsByContent(backend: FakeBackend): Map<string, Chunk> {
    const m = new Map<string, Chunk>();
    for (const c of backend.chunks.values()) if (c.metadata.tier === 'dream') m.set(c.content, c);
    return m;
  }

  test('attaches a file artifact only to the dream item naming its basename', async () => {
    const llm = new FakeDreamLLM(() => [
      { type: 'decision', text: 'Refactored the hotkey.rs handler for global shortcuts' },
      { type: 'note', text: 'General cleanup, nothing file-specific here' },
    ]);
    const { backend, deps } = makeDeps(llm);
    await seed(backend, [rawChunk('c1', 's1', 'engram', 'work on shortcuts', 1_700_000_000_000, [HOTKEY])]);

    await run(backend, deps);
    const dreams = dreamsByContent(backend);

    const hit = dreams.get('Refactored the hotkey.rs handler for global shortcuts')!;
    expect(hit.metadata.artifacts).toEqual([HOTKEY]);

    const miss = dreams.get('General cleanup, nothing file-specific here')!;
    expect(miss.metadata.artifacts ?? []).toEqual([]);
  });

  test('attaches a PR artifact by verbatim URL match', async () => {
    const llm = new FakeDreamLLM(() => [
      { type: 'decision', text: `Shipped it in https://github.com/org/repo/pull/42 after review` },
      { type: 'note', text: 'Unrelated aside about pull requests in general' },
    ]);
    const { backend, deps } = makeDeps(llm);
    await seed(backend, [rawChunk('c1', 's1', 'engram', 'merged the pr', 1_700_000_000_000, [PR])]);

    await run(backend, deps);
    const dreams = dreamsByContent(backend);

    expect(dreams.get('Shipped it in https://github.com/org/repo/pull/42 after review')!.metadata.artifacts).toEqual([PR]);
    expect(dreams.get('Unrelated aside about pull requests in general')!.metadata.artifacts ?? []).toEqual([]);
  });

  test('SACRED: the unit fingerprint is identical with and without artifacts present', async () => {
    const items = () => [{ type: 'decision' as const, text: 'chose pgvector for hotkey.rs' }];

    const withArt = makeDeps(new FakeDreamLLM(items));
    await seed(withArt.backend, [rawChunk('c1', 's1', 'engram', 'body', 1_700_000_000_000, [HOTKEY])]);
    await run(withArt.backend, withArt.deps);

    const without = makeDeps(new FakeDreamLLM(items));
    await seed(without.backend, [rawChunk('c1', 's1', 'engram', 'body', 1_700_000_000_000)]);
    await run(without.backend, without.deps);

    const fpWith = (await withArt.backend.getDreamUnits(DREAM))[0]!.fingerprint;
    const fpWithout = (await without.backend.getDreamUnits(DREAM))[0]!.fingerprint;
    expect(fpWith).toBe(fpWithout);
  });
});

describe('parseItems', () => {
  test('throws on malformed JSON', () => {
    expect(() => parseItems('not json')).toThrow();
  });

  test('throws when items array is missing', () => {
    expect(() => parseItems('{"foo":1}')).toThrow();
  });

  test('coerces items with an unknown type to note', () => {
    const items = parseItems('{"items":[{"type":"decision","text":"keep"},{"type":"bogus","text":"salvaged"}]}');
    expect(items).toEqual([
      { type: 'decision', text: 'keep' },
      { type: 'note', text: 'salvaged' },
    ]);
  });

  test('drops empty-text items and returns [] for empty list', () => {
    expect(parseItems('{"items":[]}')).toEqual([]);
    expect(parseItems('{"items":[{"type":"fix","text":"  "}]}')).toEqual([]);
  });
});
