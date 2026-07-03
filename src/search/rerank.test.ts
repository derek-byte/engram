import { describe, expect, test } from 'bun:test';
import { OpenAIReranker, parseRanking, type ChatClient } from './rerank.ts';
import { runSearch } from './index.ts';
import type { Chunk, SearchFilters, SearchResult } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';

function makeResult(id: string, content: string, similarity: number): SearchResult {
  const chunk: Chunk = {
    id,
    embedding: [],
    content,
    metadata: {
      repo: 'engram',
      branch: 'main',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      filePaths: [],
      exitCode: null,
      sessionId: id,
      cwd: '',
      tier: 'raw',
    },
  };
  return { chunk, similarity, keywordRank: 0, combined: similarity };
}

// Fake chat client that returns a fixed ranking JSON (or throws).
function fakeClient(reply: string | (() => never), usage = { prompt_tokens: 100, completion_tokens: 10 }): ChatClient {
  return {
    chat: {
      completions: {
        async create() {
          if (typeof reply === 'function') return reply();
          return { choices: [{ message: { content: reply } }], usage };
        },
      },
    },
  };
}

describe('parseRanking', () => {
  test('valid permutation', () => {
    expect(parseRanking('{"ranking":[2,0,1]}', 3)).toEqual([2, 0, 1]);
  });

  test('drops out-of-range and duplicate indices', () => {
    expect(parseRanking('{"ranking":[2,5,-1,0,2,1]}', 3)).toEqual([2, 0, 1]);
  });

  test('non-JSON returns null', () => {
    expect(parseRanking('I cannot help with that.', 3)).toBeNull();
  });

  test('missing key returns null', () => {
    expect(parseRanking('{"foo":[0,1]}', 3)).toBeNull();
  });

  test('empty/all-invalid returns null', () => {
    expect(parseRanking('{"ranking":[]}', 3)).toBeNull();
    expect(parseRanking('{"ranking":[9,9,9]}', 3)).toBeNull();
  });
});

describe('OpenAIReranker.rerank', () => {
  const candidates = [
    makeResult('a', 'alpha', 0.9),
    makeResult('b', 'bravo', 0.8),
    makeResult('c', 'charlie', 0.7),
  ];

  test('reorders and assigns rerankRank', async () => {
    const r = new OpenAIReranker('k', { model: 'm', topK: 30 }, fakeClient('{"ranking":[2,0,1]}'));
    const out = await r.rerank('q', candidates);
    expect(out!.map((x) => x.chunk.id)).toEqual(['c', 'a', 'b']);
    expect(out!.map((x) => x.rerankRank)).toEqual([1, 2, 3]);
    expect(r.stats.calls).toBe(1);
    expect(r.stats.promptTokens).toBe(100);
    expect(r.stats.completionTokens).toBe(10);
  });

  test('appends LLM-omitted candidates in hybrid order without a rank', async () => {
    const r = new OpenAIReranker('k', { model: 'm', topK: 30 }, fakeClient('{"ranking":[2]}'));
    const out = await r.rerank('q', candidates);
    expect(out!.map((x) => x.chunk.id)).toEqual(['c', 'a', 'b']);
    expect(out!.map((x) => x.rerankRank)).toEqual([1, undefined, undefined]);
  });

  test('respects topK slice — beyond-topK tail follows in hybrid order', async () => {
    const many = [candidates[0]!, candidates[1]!, candidates[2]!];
    const r = new OpenAIReranker('k', { model: 'm', topK: 2 }, fakeClient('{"ranking":[1,0]}'));
    const out = await r.rerank('q', many);
    // Only first 2 went to the LLM; 'c' (index 2) is the untouched tail.
    expect(out!.map((x) => x.chunk.id)).toEqual(['b', 'a', 'c']);
    expect(out!.map((x) => x.rerankRank)).toEqual([1, 2, undefined]);
  });

  test('<=1 candidate short-circuits with zero calls', async () => {
    const r = new OpenAIReranker('k', { model: 'm', topK: 30 }, fakeClient('{"ranking":[0]}'));
    const out = await r.rerank('q', [candidates[0]!]);
    expect(out).toEqual([candidates[0]!]);
    expect(r.stats.calls).toBe(0);
  });

  test('malformed JSON → null, failure counted', async () => {
    const r = new OpenAIReranker('k', { model: 'm', topK: 30 }, fakeClient('refused'));
    expect(await r.rerank('q', candidates)).toBeNull();
    expect(r.stats.failures).toBe(1);
  });

  test('client that throws → null, failure counted, no exception', async () => {
    const r = new OpenAIReranker('k', { model: 'm', topK: 30 }, fakeClient(() => {
      throw new Error('timeout');
    }));
    expect(await r.rerank('q', candidates)).toBeNull();
    expect(r.stats.failures).toBe(1);
  });
});

// Minimal stub backend for runSearch integration.
function stubBackend(results: SearchResult[]): VectorBackend & { lastFilters?: SearchFilters } {
  const b: any = {
    lastFilters: undefined,
    async search(_vec: number[], _q: string, filters: SearchFilters) {
      b.lastFilters = filters;
      return results.slice(0, filters.limit ?? 5);
    },
    async initialize() {},
    async insertRawEvents() {
      return 0;
    },
    async upsert() {},
    async getTrajectory() {
      return [];
    },
    async count() {
      return results.length;
    },
    async getCachedEmbeddings() {
      return new Map();
    },
    async putCachedEmbeddings() {},
    async close() {},
  };
  return b;
}

const stubEmbedder = { async embedOne() { return [0]; } } as unknown as Embedder;

describe('runSearch with reranker', () => {
  const pool = [
    makeResult('a', 'alpha', 0.9),
    makeResult('b', 'bravo', 0.8),
    makeResult('c', 'charlie', 0.7),
  ];

  test('failing reranker → hybrid order, sliced to limit', async () => {
    const backend = stubBackend(pool);
    const reranker = new OpenAIReranker('k', { model: 'm', topK: 30 }, fakeClient('nope'));
    const out = await runSearch('q', { limit: 2 }, { backend, embedder: stubEmbedder, reranker });
    expect(out.map((x) => x.chunk.id)).toEqual(['a', 'b']);
    expect(out.every((x) => x.rerankRank === undefined)).toBe(true);
    // Pool widened to max(topK, limit).
    expect(backend.lastFilters?.limit).toBe(30);
  });

  test('no reranker → backend called with original filters', async () => {
    const backend = stubBackend(pool);
    const out = await runSearch('q', { limit: 2 }, { backend, embedder: stubEmbedder });
    expect(out.map((x) => x.chunk.id)).toEqual(['a', 'b']);
    expect(backend.lastFilters?.limit).toBe(2);
  });

  test('successful reranker reorders then slices', async () => {
    const backend = stubBackend(pool);
    const reranker = new OpenAIReranker('k', { model: 'm', topK: 30 }, fakeClient('{"ranking":[2,1,0]}'));
    const out = await runSearch('q', { limit: 2 }, { backend, embedder: stubEmbedder, reranker });
    expect(out.map((x) => x.chunk.id)).toEqual(['c', 'b']);
    expect(out.map((x) => x.rerankRank)).toEqual([1, 2]);
  });
});
