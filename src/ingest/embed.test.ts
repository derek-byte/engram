import { describe, expect, test } from 'bun:test';
import { Embedder, FallbackProvider, type EmbeddingProvider, type ProviderEmbedding } from './embed.ts';
import { contentSha256 } from './hash.ts';
import { FakeCache, FakeProvider } from './testkit.ts';

// A primary that always fails, to drive the FallbackProvider latch decision.
class ThrowingProvider implements EmbeddingProvider {
  readonly maxInputChars = undefined;
  callCount = 0;
  constructor(
    readonly model: string,
    readonly dim: number
  ) {}
  async embed(): Promise<ProviderEmbedding> {
    this.callCount++;
    throw new Error('primary down');
  }
}

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

describe('FallbackProvider latch rule (V5)', () => {
  test('equal-dim primary failure latches to the fallback for the rest of the process', async () => {
    const primary = new ThrowingProvider('openai-4', 4);
    const fallback = new FakeProvider({ model: 'local-4', dim: 4 });
    const provider = new FallbackProvider(primary, () => fallback);

    const res = await provider.embed(['hello']);
    expect(res.model).toBe('local-4');
    expect(res.vectors[0]).toEqual(fallback.vec('hello'));

    // Latched: subsequent calls skip the (broken) primary entirely.
    expect(provider.model).toBe('local-4');
    expect(provider.dim).toBe(4);
    await provider.embed(['again']);
    expect(primary.callCount).toBe(1); // primary hit once, never again after latch
  });

  test('dim-mismatch primary failure does NOT latch — it rethrows the original error', async () => {
    const primary = new ThrowingProvider('openai-1536', 1536);
    const fallback = new FakeProvider({ model: 'local-384', dim: 384 });
    const provider = new FallbackProvider(primary, () => fallback);

    // The original failure surfaces; a 384-dim fallback would corrupt a 1536-dim index.
    await expect(provider.embed(['hello'])).rejects.toThrow('primary down');

    // Not latched: active provider is still the primary (dims unchanged), and the
    // fallback's vectors were never returned.
    expect(provider.model).toBe('openai-1536');
    expect(provider.dim).toBe(1536);
    expect(fallback.callCount).toBe(0);
  });
});
