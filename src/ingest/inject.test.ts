import { describe, expect, test } from 'bun:test';
import { Embedder } from './embed.ts';
import { injectDocuments, type InjectDeps, type InjectDoc } from './inject.ts';
import { FakeBackend, FakeProvider, testConfig } from './testkit.ts';

function makeDeps(): { deps: InjectDeps; backend: FakeBackend; provider: FakeProvider } {
  const backend = new FakeBackend();
  const provider = new FakeProvider({ dim: 4 });
  const deps: InjectDeps = { backend, embedder: new Embedder(provider, backend), config: testConfig() };
  return { deps, backend, provider };
}

describe('injectDocuments', () => {
  test('re-injecting the same document is idempotent (no new rows, no re-embeds)', async () => {
    const { deps, backend, provider } = makeDeps();
    const doc: InjectDoc = { id: 'doc-1', content: 'the quick brown fox', owner: 'test:a', source: 'unit' };

    const r1 = await injectDocuments([doc], deps);
    expect(r1.embedded).toBeGreaterThan(0);
    expect(r1.cacheMisses).toBe(r1.embedded);
    const chunksAfter1 = backend.chunks.size;
    const rawAfter1 = backend.rawEvents.size;
    const providerCallsAfter1 = provider.callCount;

    const r2 = await injectDocuments([doc], deps);
    expect(backend.chunks.size).toBe(chunksAfter1); // ON CONFLICT DO NOTHING
    expect(backend.rawEvents.size).toBe(rawAfter1);
    expect(r2.cacheMisses).toBe(0); // every chunk served from the embedding cache
    expect(provider.callCount).toBe(providerCallsAfter1); // provider not re-hit
  });

  test('cross-owner isolation: same content, two owners → independent rows; retracting one leaves the other', async () => {
    const { deps, backend } = makeDeps();
    const content = 'shared knowledge across tenants';
    const a: InjectDoc = { id: 'same-id', content, owner: 'test:owner-a', source: 'unit' };
    const b: InjectDoc = { id: 'same-id', content, owner: 'test:owner-b', source: 'unit' };

    await injectDocuments([a, b], deps);

    const ownersOf = (pred: (o?: string) => boolean) =>
      [...backend.chunks.values()].filter((c) => pred(c.metadata.owner));
    const aChunks = ownersOf((o) => o === 'test:owner-a');
    const bChunks = ownersOf((o) => o === 'test:owner-b');
    expect(aChunks.length).toBeGreaterThan(0);
    expect(bChunks.length).toBe(aChunks.length);

    // Identical content + id but different owner must not collide on chunk id or raw-event sha.
    const aIds = new Set(aChunks.map((c) => c.id));
    for (const c of bChunks) expect(aIds.has(c.id)).toBe(false);
    expect(backend.rawEvents.size).toBe(2);

    // Retract owner A; owner B's rows survive intact.
    const del = backend.deleteByOwner('test:owner-a');
    expect(del.chunks).toBe(aChunks.length);
    expect(del.rawEvents).toBe(1);
    expect(ownersOf((o) => o === 'test:owner-a')).toHaveLength(0);
    expect(ownersOf((o) => o === 'test:owner-b')).toHaveLength(bChunks.length);
    expect(backend.rawEvents.size).toBe(1);
  });
});
