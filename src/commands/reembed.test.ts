import { describe, expect, test } from 'bun:test';
import { runReembedSweep, type ReembedSweepDeps } from './backfill.ts';

// In-memory stand-in for chunks.embedding under a re-embed sweep. Mirrors the
// self-advancing predicate of PgVectorBackend.reembedFetchBatch: a row needs
// (re-)embedding when its embedding is null OR its model differs from the target,
// and it drops out of the set once written under the target model.
class FakeReembedStore {
  rows: Map<string, { content: string; embedding: number[] | null; model: string | null }>;

  constructor(seed: Array<{ id: string; content: string; embedding?: number[] | null; model?: string | null }>) {
    this.rows = new Map(
      seed.map((r) => [r.id, { content: r.content, embedding: r.embedding ?? null, model: r.model ?? null }])
    );
  }

  fetchBatch(targetModel: string, limit: number): Array<{ id: string; content: string }> {
    return [...this.rows.entries()]
      .filter(([, r]) => r.embedding === null || r.model !== targetModel)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, limit)
      .map(([id, r]) => ({ id, content: r.content }));
  }

  writeBatch(writes: Array<{ id: string; embedding: number[]; model: string }>): void {
    for (const w of writes) {
      const row = this.rows.get(w.id)!;
      row.embedding = w.embedding;
      row.model = w.model;
    }
  }
}

const TARGET_MODEL = 'target-8';
const TARGET_DIM = 8;

// Deterministic 8-dim embed fake that records how many rows it was asked to embed.
function makeEmbed(opts: { failOnCall?: number } = {}) {
  const state = { calls: 0, embeddedContents: [] as string[] };
  const embed: ReembedSweepDeps['embed'] = async (contents) => {
    state.calls++;
    if (opts.failOnCall !== undefined && state.calls === opts.failOnCall) {
      throw new Error('simulated embedder failure');
    }
    state.embeddedContents.push(...contents);
    return {
      embeddings: contents.map((c) => new Array<number>(TARGET_DIM).fill(c.length)),
      model: TARGET_MODEL,
      cacheHits: 0,
      cacheMisses: contents.length,
    };
  };
  return { embed, state };
}

function depsFor(store: FakeReembedStore, embed: ReembedSweepDeps['embed']): ReembedSweepDeps {
  return {
    fetchBatch: async (limit) => store.fetchBatch(TARGET_MODEL, limit),
    embed,
    writeBatch: async (writes) => store.writeBatch(writes),
  };
}

describe('runReembedSweep', () => {
  test('processes every row until the fetch is empty', async () => {
    const store = new FakeReembedStore(
      Array.from({ length: 10 }, (_, i) => ({ id: `id-${i.toString().padStart(2, '0')}`, content: `c${i}` }))
    );
    const { embed, state } = makeEmbed();

    const res = await runReembedSweep(depsFor(store, embed), { batchSize: 3 });

    expect(res.reembedded).toBe(10);
    expect(res.batches).toBe(4); // ceil(10 / 3)
    expect(res.cacheMisses).toBe(10);
    expect(state.embeddedContents.length).toBe(10);
    // Every row now carries an 8-dim vector under the target model.
    for (const r of store.rows.values()) {
      expect(r.embedding).toHaveLength(TARGET_DIM);
      expect(r.model).toBe(TARGET_MODEL);
    }
  });

  test('resumes when the first rows were already embedded (no rework)', async () => {
    const store = new FakeReembedStore([
      { id: 'id-0', content: 'done-0', embedding: new Array(TARGET_DIM).fill(1), model: TARGET_MODEL },
      { id: 'id-1', content: 'done-1', embedding: new Array(TARGET_DIM).fill(1), model: TARGET_MODEL },
      { id: 'id-2', content: 'todo-2' },
      { id: 'id-3', content: 'todo-3' },
    ]);
    const { embed, state } = makeEmbed();

    const res = await runReembedSweep(depsFor(store, embed), { batchSize: 2 });

    // Only the two unfinished rows are embedded; the finished pair is untouched.
    expect(res.reembedded).toBe(2);
    expect(state.embeddedContents.sort()).toEqual(['todo-2', 'todo-3']);
    expect(store.rows.get('id-0')!.embedding).toEqual(new Array(TARGET_DIM).fill(1));
  });

  test('propagates an embedder failure without losing data', async () => {
    const store = new FakeReembedStore(
      Array.from({ length: 6 }, (_, i) => ({ id: `id-${i}`, content: `c${i}` }))
    );
    const { embed } = makeEmbed({ failOnCall: 2 }); // first batch writes, second throws

    await expect(runReembedSweep(depsFor(store, embed), { batchSize: 2 })).rejects.toThrow(/embedder failure/);

    // Batch 1 (id-0, id-1) persisted; the rest stayed NULL. No content was ever
    // mutated, so a re-run resumes exactly where it stopped.
    expect(store.rows.get('id-0')!.embedding).toHaveLength(TARGET_DIM);
    expect(store.rows.get('id-1')!.embedding).toHaveLength(TARGET_DIM);
    for (const id of ['id-2', 'id-3', 'id-4', 'id-5']) {
      expect(store.rows.get(id)!.embedding).toBeNull();
    }
    // Content is never touched by the sweep, so nothing is lost on failure.
    for (let i = 0; i < 6; i++) expect(store.rows.get(`id-${i}`)!.content).toBe(`c${i}`);
  });

  test('selects model-mismatch rows even when the dimension is unchanged', async () => {
    // Same-dim model swap: every row already has an 8-dim vector, but from the
    // old model — all must be re-embedded, none skipped.
    const store = new FakeReembedStore(
      Array.from({ length: 5 }, (_, i) => ({
        id: `id-${i}`,
        content: `c${i}`,
        embedding: new Array(TARGET_DIM).fill(0),
        model: 'old-model',
      }))
    );
    const { embed, state } = makeEmbed();

    const res = await runReembedSweep(depsFor(store, embed), { batchSize: 10 });

    expect(res.reembedded).toBe(5);
    expect(state.embeddedContents.sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    for (const r of store.rows.values()) expect(r.model).toBe(TARGET_MODEL);

    // A second pass is a clean no-op — everything is now on the target model.
    const again = await runReembedSweep(depsFor(store, embed), { batchSize: 10 });
    expect(again.reembedded).toBe(0);
    expect(again.batches).toBe(0);
  });
});
