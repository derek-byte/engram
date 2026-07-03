import { describe, expect, test } from 'bun:test';
import { Embedder } from './embed.ts';
import { contentSha256 } from './hash.ts';
import { FakeCache, FakeProvider } from './testkit.ts';

describe('Embedder cache', () => {
  test('places hits and misses at their original indices', async () => {
    const provider = new FakeProvider({ dim: 4 });
    const cache = new FakeCache();
    const texts = ['alpha', 'bravo', 'charlie', 'delta'];

    // Pre-seed indices 0 and 2 with sentinel vectors distinct from the provider's.
    const seeded0 = [9, 9, 9, 9];
    const seeded2 = [8, 8, 8, 8];
    cache.seed(contentSha256(texts[0]!), provider.model, seeded0);
    cache.seed(contentSha256(texts[2]!), provider.model, seeded2);

    const res = await new Embedder(provider, cache).embedWithStats(texts);

    expect(res.embeddings[0]).toEqual(seeded0);
    expect(res.embeddings[2]).toEqual(seeded2);
    expect(res.embeddings[1]).toEqual(provider.vec('bravo'));
    expect(res.embeddings[3]).toEqual(provider.vec('delta'));
    expect(res.cacheHits).toBe(2);
    expect(res.cacheMisses).toBe(2);

    // Provider was called once, with only the misses, in order.
    expect(provider.callCount).toBe(1);
    expect(provider.calls[0]).toEqual(['bravo', 'delta']);
  });

  test('all-hit path never calls the provider', async () => {
    const provider = new FakeProvider({ dim: 4 });
    const cache = new FakeCache();
    const texts = ['one', 'two', 'three'];
    for (const t of texts) cache.seed(contentSha256(t), provider.model, [1, 2, 3, 4]);

    const res = await new Embedder(provider, cache).embedWithStats(texts);

    expect(provider.callCount).toBe(0);
    expect(res.cacheHits).toBe(3);
    expect(res.cacheMisses).toBe(0);
  });

  test('per-call stats stay isolated under concurrency', async () => {
    const provider = new FakeProvider({ dim: 4 });
    const cache = new FakeCache();
    const embedder = new Embedder(provider, cache);

    // Call A: all hits. Call B: all misses. Disjoint inputs.
    const aTexts = ['ha', 'hb'];
    for (const t of aTexts) cache.seed(contentSha256(t), provider.model, [1, 1, 1, 1]);
    const bTexts = ['mx', 'my', 'mz'];

    const [a, b] = await Promise.all([
      embedder.embedWithStats(aTexts),
      embedder.embedWithStats(bTexts),
    ]);

    expect(a.cacheHits).toBe(2);
    expect(a.cacheMisses).toBe(0);
    expect(b.cacheHits).toBe(0);
    expect(b.cacheMisses).toBe(3);
  });

  test('oversized input throws naming the offending label', async () => {
    const provider = new FakeProvider({ dim: 4, maxInputChars: 10 });
    const embedder = new Embedder(provider, new FakeCache());
    const big = 'x'.repeat(50);

    await expect(
      embedder.embedWithStats(['short', big], ['label-A', 'label-OFFENDER'])
    ).rejects.toThrow(/label-OFFENDER/);
    await expect(
      embedder.embedWithStats(['short', big], ['label-A', 'label-OFFENDER'])
    ).rejects.toThrow(/50 chars/);
  });
});
