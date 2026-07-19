import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askCommand, type AskCommandDeps } from './ask.ts';
import { OpenAIAskLLM, type AskChatClient } from '../ask/index.ts';
import { LocalStore } from '../storage/local.ts';
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
      tier: 'wiki',
      ...meta,
    },
  };
  return { chunk, similarity: 0.9, keywordScore: 0, combined: 0.9 };
}

function fakeClient(reply: string | null | (() => never)): AskChatClient {
  return {
    chat: {
      completions: {
        async create() {
          if (typeof reply === 'function') return reply();
          return { choices: [{ message: { content: reply } }], usage: { prompt_tokens: 100, completion_tokens: 10 } };
        },
      },
    },
  };
}

function stubBackend(results: SearchResult[]): VectorBackend {
  const b: any = {
    async search(_vec: number[], _q: string, filters: SearchFilters) {
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

describe('askCommand demand logging', () => {
  let path: string;
  let store: LocalStore;
  let raw: Database;
  let logSpy: typeof console.log;
  let errSpy: typeof console.error;

  beforeEach(() => {
    path = join(tmpdir(), `engram-ask-cmd-${crypto.randomUUID()}.sqlite`);
    store = new LocalStore(path);
    raw = new Database(path);
    // Silence the command's stdout/stderr chatter during the test.
    logSpy = console.log;
    errSpy = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    console.log = logSpy;
    console.error = errSpy;
    process.exitCode = 0;
    store.close();
    raw.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(path + suffix);
      } catch {
        // best effort
      }
    }
  });

  function deps(results: SearchResult[], reply: string | null | (() => never)): AskCommandDeps {
    return {
      backend: stubBackend(results),
      embedder: stubEmbedder,
      llm: new OpenAIAskLLM('k', 'gpt-5.4-mini', fakeClient(reply)),
      local: store,
    };
  }

  function rows() {
    return raw.query('SELECT * FROM demand_log ORDER BY id').all() as any[];
  }

  test('answered ask writes one demand row with cited count + top_tier', async () => {
    await askCommand('why did we pick pgvector?', { tier: 'synth' }, deps(
      [makeResult('a', 'alpha', { tier: 'wiki' }), makeResult('b', 'bravo', { tier: 'dream' })],
      'We chose pgvector [1].'
    ));
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].surface).toBe('cli');
    expect(r[0].kind).toBe('ask');
    expect(r[0].query).toBe('why did we pick pgvector?');
    expect(r[0].tier).toBe('synth');
    expect(r[0].outcome).toBe('answered');
    expect(r[0].result_count).toBe(2);
    expect(r[0].cited_count).toBe(1);
    expect(r[0].top_tier).toBe('wiki');
    expect(r[0].top_similarity).toBeNull();
    expect(r[0].top_session_id).toBeNull();
  });

  test('answer with no citations → not_covered', async () => {
    await askCommand('q', { tier: 'synth' }, deps([makeResult('a', 'alpha')], 'the memory does not cover this'));
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].outcome).toBe('not_covered');
    expect(r[0].cited_count).toBe(0);
  });

  test('zero candidates → no_candidates row, no LLM call', async () => {
    await askCommand('q', { tier: 'synth' }, deps([], () => { throw new Error('should not call LLM'); }));
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].outcome).toBe('no_candidates');
    expect(r[0].result_count).toBe(0);
  });

  test('LLM failure → error row + exit code 1', async () => {
    await askCommand('q', { tier: 'synth' }, deps([makeResult('a', 'alpha')], () => { throw new Error('timeout'); }));
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].outcome).toBe('error');
    expect(process.exitCode).toBe(1);
  });
});
