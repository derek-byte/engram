import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolHandlers, type McpDeps } from './server.ts';
import { OpenAIAskLLM, type AskChatClient } from '../ask/index.ts';
import { Embedder } from '../ingest/embed.ts';
import { FakeBackend, FakeCache, FakeProvider } from '../ingest/testkit.ts';
import { WikiStore, pageFingerprint, type WikiPage } from '../wiki/store.ts';
import type { Chunk } from '../types/index.ts';
import type { DemandRow } from '../storage/local.ts';

function chunk(id: string, tier: Chunk['metadata']['tier'], over: Partial<Chunk['metadata']> = {}): Chunk {
  return {
    id,
    embedding: [1, 1, 1, 1],
    content: 'content of ' + id,
    metadata: {
      repo: 'engram',
      branch: 'main',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      filePaths: [],
      exitCode: null,
      sessionId: 'sess-mcp',
      cwd: '/tmp',
      tier,
      trajectoryId: 'traj-' + id,
      chunkIndex: 0,
      chunkCount: 1,
      ...over,
    },
  };
}

function page(over: Partial<WikiPage> = {}): WikiPage {
  const sources = over.sources ?? ['c1', 'c2'];
  return {
    slug: 'engram',
    schema: 1,
    title: 'Engram',
    kind: 'project',
    summary: 'the memory engine',
    aliases: [],
    sources,
    trajectories: ['dream:x'],
    fingerprint: pageFingerprint(sources),
    created: '2026-01-01T00:00:00Z',
    updated: '2026-02-01T00:00:00Z',
    body: '# Heading\n\nBody text.',
    ...over,
  };
}

// Fake chat client returning canned text (or throwing), mirroring ask.test.ts.
function fakeClient(reply: string | (() => never)): AskChatClient {
  return {
    chat: {
      completions: {
        async create() {
          if (typeof reply === 'function') return reply();
          return { choices: [{ message: { content: reply } }], usage: { prompt_tokens: 100, completion_tokens: 10 } };
        },
      },
    },
  } as unknown as AskChatClient;
}

describe('buildToolHandlers', () => {
  let backend: FakeBackend;
  let embedder: Embedder;
  let wiki: WikiStore;
  let wikiDir: string;
  let demand: DemandRow[];
  let recents: Array<{ kind: string; key: string; label: string }>;

  function makeDeps(over: Partial<McpDeps> = {}): McpDeps {
    return {
      backend,
      embedder,
      lastIngestAt: () => '2026-07-01T00:00:00Z',
      store: wiki,
      logDemand: (r) => demand.push(r),
      logRecent: (kind, key, label) => recents.push({ kind, key, label }),
      askLLM: new OpenAIAskLLM('sk-test', 'gpt-test', fakeClient('The answer is grounded [1].')),
      ...over,
    };
  }

  beforeEach(() => {
    backend = new FakeBackend();
    embedder = new Embedder(new FakeProvider({ dim: 4 }), new FakeCache());
    wikiDir = join(tmpdir(), `engram-mcp-test-${crypto.randomUUID()}`);
    wiki = new WikiStore(wikiDir);
    demand = [];
    recents = [];
  });
  afterEach(() => {
    try { rmSync(wikiDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // --- engram_search ---------------------------------------------------------

  test('search formats results and logs a demand row (surface mcp, top_* from best hit)', async () => {
    await backend.upsert([chunk('c1', 'dream', { sessionId: 'sess-mcp', dreamType: 'decision' })]);
    const handlers = buildToolHandlers(makeDeps());
    const res = await handlers.search({ query: 'how did we decide' });
    expect(res.isError).toBeUndefined();
    const text = res.content[0]!.text;
    expect(text).toContain('content of c1');
    expect(text).toContain('session: sess-mcp');

    // One demand row mirroring the UI search row.
    expect(demand.length).toBe(1);
    const row = demand[0]!;
    expect(row.surface).toBe('mcp');
    expect(row.kind).toBe('search');
    expect(row.query).toBe('how did we decide');
    expect(row.resultCount).toBe(1);
    expect(typeof row.topSimilarity).toBe('number');
    expect(row.topTier).toBe('dream');
    expect(row.topSessionId).toBe('sess-mcp');
  });

  test('search on an empty index → "No results." and a zero-hit demand row', async () => {
    const handlers = buildToolHandlers(makeDeps());
    const res = await handlers.search({ query: 'nothing indexed' });
    expect(res.content[0]!.text).toBe('No results.');
    expect(demand.length).toBe(1);
    expect(demand[0]!.resultCount).toBe(0);
    expect(demand[0]!.topSimilarity).toBeNull();
    expect(demand[0]!.topSessionId).toBeNull();
  });

  test('search demand logging never breaks the search (throwing logDemand is swallowed)', async () => {
    await backend.upsert([chunk('c1', 'dream')]);
    const handlers = buildToolHandlers(makeDeps({ logDemand: () => { throw new Error('sqlite down'); } }));
    const res = await handlers.search({ query: 'still works' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain('content of c1');
  });

  // --- engram_ask ------------------------------------------------------------

  test('ask success → answer + cited source, demand row outcome answered', async () => {
    await backend.upsert([chunk('c1', 'dream', { sessionId: 'sess-mcp', dreamType: 'decision' })]);
    const handlers = buildToolHandlers(makeDeps());
    const res = await handlers.ask({ question: 'what did we decide' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain('The answer is grounded');
    expect(recents.some((r) => r.kind === 'ask')).toBe(true);

    expect(demand.length).toBe(1);
    const row = demand[0]!;
    expect(row.surface).toBe('mcp');
    expect(row.kind).toBe('ask');
    expect(row.tier).toBe('synth');
    expect(row.outcome).toBe('answered');
    expect(row.citedCount).toBe(1);
    expect(row.topSimilarity).toBeNull();
    expect(row.topSessionId).toBeNull();
  });

  test('ask with no candidates → no-material message, outcome no_candidates', async () => {
    const handlers = buildToolHandlers(makeDeps());
    const res = await handlers.ask({ question: 'nothing indexed' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain('No indexed material matched');
    expect(demand.length).toBe(1);
    expect(demand[0]!.outcome).toBe('no_candidates');
    expect(demand[0]!.resultCount).toBe(0);
  });

  test('ask answer with no citations → outcome not_covered', async () => {
    await backend.upsert([chunk('c1', 'dream')]);
    const handlers = buildToolHandlers(makeDeps({
      askLLM: new OpenAIAskLLM('sk-test', 'gpt-test', fakeClient('I cannot find that in the material.')),
    }));
    const res = await handlers.ask({ question: 'q' });
    expect(res.content[0]!.text).toContain('(no sources cited)');
    expect(demand[0]!.outcome).toBe('not_covered');
    expect(demand[0]!.citedCount).toBe(0);
  });

  test('ask LLM failure → isError + error demand row (never a silent search fallback)', async () => {
    await backend.upsert([chunk('c1', 'dream')]);
    const handlers = buildToolHandlers(makeDeps({
      askLLM: new OpenAIAskLLM('sk-test', 'gpt-test', fakeClient(() => { throw new Error('model exploded'); })),
    }));
    const res = await handlers.ask({ question: 'q' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('engram_ask failed');
    expect(demand.length).toBe(1);
    expect(demand[0]!.outcome).toBe('error');
  });

  test('ask with no askLLM configured → isError, no key hint, no demand row', async () => {
    const handlers = buildToolHandlers(makeDeps({ askLLM: undefined }));
    const res = await handlers.ask({ question: 'q' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('no OPENAI_API_KEY');
    expect(demand.length).toBe(0);
  });

  // --- engram_wiki_page ------------------------------------------------------

  test('wiki_page returns the serialized page for a valid slug', async () => {
    wiki.writePage(page());
    const handlers = buildToolHandlers(makeDeps());
    const res = await handlers.wikiPage({ slug: 'engram' });
    expect(res.content[0]!.text).toContain('title: "Engram"');
    expect(res.content[0]!.text).toContain('Body text.');
  });

  test('wiki_page with a traversal slug → clean error, no fs escape', async () => {
    const handlers = buildToolHandlers(makeDeps());
    const res = await handlers.wikiPage({ slug: '../../etc/passwd' });
    // The slug guard rejects it before any fs read; the handler surfaces the
    // guard message as plain text rather than throwing or reading outside pages/.
    expect(res.content[0]!.text).toContain('invalid wiki slug');
    expect(res.content[0]!.text).not.toContain('root:');
  });

  test('wiki_page for an unknown-but-valid slug → no-page message', async () => {
    const handlers = buildToolHandlers(makeDeps());
    const res = await handlers.wikiPage({ slug: 'does-not-exist' });
    expect(res.content[0]!.text).toBe('no wiki page: does-not-exist');
  });

  // --- engram_status ---------------------------------------------------------

  test('status reports chunk count, wiki page count, and last ingest', async () => {
    await backend.upsert([chunk('c1', 'dream'), chunk('c2', 'raw')]);
    wiki.writePage(page());
    const handlers = buildToolHandlers(makeDeps());
    const res = await handlers.status();
    const text = res.content[0]!.text;
    expect(text).toContain('chunks: 2');
    expect(text).toContain('wiki pages: 1');
    expect(text).toContain('last ingest: 2026-07-01T00:00:00Z');
  });

  test('status shows "never" when last ingest is null', async () => {
    const handlers = buildToolHandlers(makeDeps({ lastIngestAt: () => null }));
    const res = await handlers.status();
    expect(res.content[0]!.text).toContain('last ingest: never');
  });
});
