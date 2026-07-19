import { describe, expect, test } from 'bun:test';
import { OpenAIAskLLM, AskError, runAsk, askOutcome, formatSourceLine, type AskChatClient, type AskResult } from './index.ts';
import { buildAskUser, candidateHeader, extractCitedIndices, CANDIDATE_CHARS } from './prompt.ts';
import type { Chunk, ChunkMetadata, SearchFilters, SearchResult } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';

function makeResult(id: string, content: string, meta: Partial<ChunkMetadata> = {}): SearchResult {
  const chunk: Chunk = {
    id,
    content,
    metadata: {
      repo: 'engram',
      branch: 'main',
      timestamp: new Date('2026-06-12T00:00:00Z'),
      filePaths: [],
      exitCode: null,
      sessionId: id,
      cwd: '',
      tier: 'raw',
      ...meta,
    },
  };
  return { chunk, similarity: 0.9, keywordScore: 0, combined: 0.9 };
}

// Fake chat client returning canned text (or throwing), with a call counter.
function fakeClient(
  reply: string | null | (() => never),
  usage: { prompt_tokens?: number; completion_tokens?: number } | null = { prompt_tokens: 100, completion_tokens: 10 }
): AskChatClient & { calls: number } {
  const c: any = {
    calls: 0,
    chat: {
      completions: {
        async create() {
          c.calls++;
          if (typeof reply === 'function') return reply();
          return { choices: [{ message: { content: reply } }], usage };
        },
      },
    },
  };
  return c;
}

describe('candidateHeader', () => {
  test('wiki header uses slug and 1-based number', () => {
    const r = makeResult('c1', 'x', { tier: 'wiki', dreamType: 'concept', trajectoryId: 'wiki:pgvector-hnsw' });
    expect(candidateHeader(1, r)).toBe('[1] wiki/concept · pgvector-hnsw · 2026-06-12');
  });

  test('dream header uses dream/<type> + repo@branch', () => {
    const r = makeResult('c2', 'x', { tier: 'dream', dreamType: 'decision' });
    expect(candidateHeader(3, r)).toBe('[3] dream/decision · engram@main · 2026-06-12');
  });

  test('raw header', () => {
    const r = makeResult('c3', 'x', { tier: 'raw' });
    expect(candidateHeader(2, r)).toBe('[2] raw · engram@main · 2026-06-12');
  });
});

describe('buildAskUser', () => {
  test('numbers candidates 1-based', () => {
    const out = buildAskUser('q?', [makeResult('a', 'alpha'), makeResult('b', 'bravo')]);
    expect(out).toContain('Question: q?');
    expect(out).toContain('[1] raw');
    expect(out).toContain('[2] raw');
    expect(out.indexOf('[1]')).toBeLessThan(out.indexOf('[2]'));
  });

  test('truncation marker at CANDIDATE_CHARS', () => {
    const long = 'z'.repeat(CANDIDATE_CHARS + 500);
    const out = buildAskUser('q', [makeResult('a', long)]);
    expect(out).toContain('[truncated]');
    expect(out).not.toContain('z'.repeat(CANDIDATE_CHARS + 1));
  });
});

describe('extractCitedIndices', () => {
  test('dedupes and parses adjacent markers', () => {
    expect([...extractCitedIndices('a [1] b [4] c [1][4]', 5)].sort()).toEqual([1, 4]);
  });

  test('drops out-of-range', () => {
    expect([...extractCitedIndices('[0] [3] [99]', 5)].sort()).toEqual([3]);
  });
});

describe('formatSourceLine', () => {
  test('dream uses trajectory id as tail', () => {
    const line = formatSourceLine({ n: 2, tier: 'dream', dreamType: 'decision', ref: 'engram@main', date: '2026-05-30T00:00:00Z', chunkId: 'abc', trajectoryId: 'dream:fp#2', cited: true });
    expect(line).toBe('[2] [dream:decision] engram@main · 2026-05-30 · dream:fp#2');
  });

  test('wiki uses chunk id tail', () => {
    const line = formatSourceLine({ n: 1, tier: 'wiki', dreamType: 'concept', ref: 'pgvector-hnsw', date: '2026-06-12T00:00:00Z', chunkId: '3f2a1b9c8d', trajectoryId: 'wiki:pgvector-hnsw', cited: true });
    expect(line).toBe('[1] [wiki:concept] pgvector-hnsw · 2026-06-12 · chunk 3f2a1b9c…');
  });

  test('appends artifact count only when >0 (singular/plural)', () => {
    const base = { n: 1, tier: 'raw' as const, ref: 'engram@main', date: '2026-06-12T00:00:00Z', chunkId: 'abc12345', cited: true };
    // none → no suffix (empty array and undefined both)
    expect(formatSourceLine(base)).toBe('[1] [raw] engram@main · 2026-06-12 · chunk abc12345');
    expect(formatSourceLine({ ...base, artifacts: [] })).toBe('[1] [raw] engram@main · 2026-06-12 · chunk abc12345');
    // one → singular
    expect(formatSourceLine({ ...base, artifacts: [{ kind: 'file', ref: 'src/x.ts', tool: 'Write' }] })).toBe(
      '[1] [raw] engram@main · 2026-06-12 · chunk abc12345 · 1 artifact'
    );
    // many → plural
    expect(
      formatSourceLine({
        ...base,
        artifacts: [
          { kind: 'file', ref: 'src/x.ts', tool: 'Write' },
          { kind: 'pr', ref: 'https://github.com/a/b/pull/7', tool: 'Bash' },
        ],
      })
    ).toBe('[1] [raw] engram@main · 2026-06-12 · chunk abc12345 · 2 artifacts');
  });
});

describe('askOutcome', () => {
  const src = (n: number, cited: boolean) => ({
    n,
    tier: 'wiki' as const,
    ref: 'r',
    date: '2026-06-12T00:00:00Z',
    chunkId: `c${n}`,
    cited,
  });
  const result = (answer: string | null, cited: boolean[]): AskResult => ({
    answer,
    sources: cited.map((c, i) => src(i + 1, c)),
    usage: null,
    model: 'm',
  });

  test('answer null → no_candidates', () => {
    expect(askOutcome(result(null, []))).toBe('no_candidates');
  });

  test('answer with no cited sources → not_covered', () => {
    expect(askOutcome(result('the memory does not cover this', [false, false]))).toBe('not_covered');
  });

  test('answer with at least one cited source → answered', () => {
    expect(askOutcome(result('we chose X [1]', [true, false]))).toBe('answered');
  });
});

// Minimal stub backend / embedder, cloned from rerank.test.ts.
function stubBackend(results: SearchResult[]): VectorBackend & { lastFilters?: SearchFilters } {
  const b: any = {
    lastFilters: undefined,
    async search(_vec: number[], _q: string, filters: SearchFilters) {
      b.lastFilters = filters;
      return results.slice(0, filters.limit ?? 5);
    },
    async initialize() {},
    async insertRawEvents() { return 0; },
    async upsert() {},
    async getTrajectory() { return []; },
    async count() { return results.length; },
    async getCachedEmbeddings() { return new Map(); },
    async putCachedEmbeddings() {},
    async close() {},
  };
  return b;
}

const stubEmbedder = { async embedOne() { return [0]; } } as unknown as Embedder;

describe('runAsk', () => {
  const pool = [
    makeResult('a', 'alpha', { tier: 'wiki', dreamType: 'concept', trajectoryId: 'wiki:chunking' }),
    makeResult('b', 'bravo', { tier: 'dream', dreamType: 'decision', trajectoryId: 'dream:fp#1' }),
    makeResult('c', 'charlie'),
  ];

  test('happy path: answer passthrough, sources cover k, cited flags, usage, limit reaches backend', async () => {
    const backend = stubBackend(pool);
    const llm = new OpenAIAskLLM('k', 'gpt-5.4-mini', fakeClient('We chose X [1] because of Y [2].'));
    const out = await runAsk('why?', { limit: 3 }, { backend, embedder: stubEmbedder, llm });
    expect(out.answer).toBe('We chose X [1] because of Y [2].');
    expect(out.sources).toHaveLength(3);
    expect(out.sources.map((s) => s.cited)).toEqual([true, true, false]);
    expect(out.usage).toEqual({ promptTokens: 100, completionTokens: 10 });
    expect(out.model).toBe('gpt-5.4-mini');
    expect(backend.lastFilters?.limit).toBe(3);
  });

  test('zero candidates → answer null, no LLM call', async () => {
    const backend = stubBackend([]);
    const client = fakeClient('should not be called');
    const llm = new OpenAIAskLLM('k', 'm', client);
    const out = await runAsk('q', { limit: 3 }, { backend, embedder: stubEmbedder, llm });
    expect(out.answer).toBeNull();
    expect(out.sources).toEqual([]);
    expect(out.usage).toBeNull();
    expect(client.calls).toBe(0);
  });

  test('LLM throws → AskError propagates (NO fallback)', async () => {
    const backend = stubBackend(pool);
    const llm = new OpenAIAskLLM('k', 'm', fakeClient(() => { throw new Error('timeout'); }));
    await expect(runAsk('q', { limit: 3 }, { backend, embedder: stubEmbedder, llm })).rejects.toBeInstanceOf(AskError);
  });

  test('empty content → AskError', async () => {
    const backend = stubBackend(pool);
    const llm = new OpenAIAskLLM('k', 'm', fakeClient('   '));
    await expect(runAsk('q', { limit: 3 }, { backend, embedder: stubEmbedder, llm })).rejects.toBeInstanceOf(AskError);
  });
});
