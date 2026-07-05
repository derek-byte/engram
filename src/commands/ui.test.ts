import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUiFetch, type ServiceOps, type UiDeps } from './ui.ts';
import { OpenAIAskLLM, type AskChatClient } from '../ask/index.ts';
import { Embedder } from '../ingest/embed.ts';
import { FakeBackend, FakeCache, FakeProvider, tempStore, type TempStore } from '../ingest/testkit.ts';
import { WikiStore, pageFingerprint, type WikiPage } from '../wiki/store.ts';
import type { Chunk } from '../types/index.ts';

const PORT = 7777;
const HOST = '127.0.0.1:' + PORT;

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
      sessionId: 'sess-1',
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
  const sources = over.sources ?? ['c1', 'c2', 'c3'];
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
    body: '# Heading\n\nSee [[other-page]] for more.',
    ...over,
  };
}

describe('buildUiFetch', () => {
  let t: TempStore;
  let backend: FakeBackend;
  let wiki: WikiStore;
  let wikiDir: string;
  let configPath: string;
  let serviceCalls: { restart: string[]; reconcile: number };
  let embedder: Embedder;
  let services: ServiceOps;
  let fetch: (req: Request) => Promise<Response>;

  beforeEach(() => {
    t = tempStore();
    backend = new FakeBackend();
    wikiDir = join(tmpdir(), `engram-ui-test-${crypto.randomUUID()}`);
    wiki = new WikiStore(wikiDir);
    // Redirect config reads/writes at a scratch file so the config route never
    // touches the real ~/.engram/config.json. Seed it with secrets + a custom
    // key to prove they never leak (GET) and survive a patch (PUT).
    configPath = join(tmpdir(), `engram-cfg-test-${crypto.randomUUID()}.json`);
    process.env.ENGRAM_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          openaiApiKey: 'sk-TESTONLY',
          databaseUrl: 'postgres://user:pw@host/db',
          embeddingProvider: 'local',
          synthesis: { enabled: false, hour: 3 },
          contextInjection: { enabled: true, budget: 1500 },
          customExperimental: 42,
        },
        null,
        2
      )
    );
    // Fake launchd seam — route tests never shell out to the real launchctl.
    serviceCalls = { restart: [], reconcile: 0 };
    services = {
      status: () => ({
        supported: true,
        serviceInstalled: true,
        agents: [
          { label: 'com.engram.watcher', loaded: true, state: 'running', pid: 123, plistPresent: true, schedule: null },
          { label: 'com.engram.synthesis', loaded: false, state: null, pid: null, plistPresent: false, schedule: { hour: 3 } },
        ],
      }),
      restart: (label) => {
        serviceCalls.restart.push(label);
        return { ok: true, out: '' };
      },
      reconcileSynthesis: () => {
        serviceCalls.reconcile++;
        return { serviceInstalled: true, action: 'installed' };
      },
    };
    embedder = new Embedder(new FakeProvider({ dim: 4 }), new FakeCache());
    fetch = buildUiFetch({ html: () => '<html>', backend, embedder, local: t.store, wiki, dim: 4, port: PORT, services });
  });
  afterEach(() => {
    t.cleanup();
    delete process.env.ENGRAM_CONFIG_PATH;
    try { rmSync(configPath, { force: true }); } catch { /* best effort */ }
    try { rmSync(wikiDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const putConfig = (bodyObj: unknown, headers: Record<string, string> = {}) =>
    fetch(
      new Request('http://' + HOST + '/api/config', {
        method: 'PUT',
        headers: { host: HOST, 'content-type': 'application/json', ...headers },
        body: typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj),
      })
    );

  const req = (path: string, headers: Record<string, string> = {}) =>
    new Request('http://' + HOST + path, { headers: { host: HOST, ...headers } });

  test('rejects foreign Host (403)', async () => {
    const res = await fetch(new Request('http://evil.example/api/recents', { headers: { host: 'evil.example' } }));
    expect(res.status).toBe(403);
  });

  test('rejects foreign Origin (403)', async () => {
    const res = await fetch(req('/api/recents', { origin: 'http://evil.example' }));
    expect(res.status).toBe(403);
  });

  test('GET /api/wiki/:slug returns page + logs a view', async () => {
    wiki.writePage(page());
    const res = await fetch(req('/api/wiki/engram'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.slug).toBe('engram');
    expect(body.kind).toBe('project');
    expect(body.sourceCount).toBe(3);
    expect(body.trajectoryId).toBe('wiki:engram');
    expect(body.body).toContain('[[other-page]]');
    const recents = t.store.getRecents();
    expect(recents.some((r) => r.kind === 'view' && r.key === 'wiki:engram')).toBe(true);
  });

  test('GET /api/wiki/:slug returns artifacts with exists (file existence checked; url/pr always true)', async () => {
    const existing = join(tmpdir(), `engram-artifact-${crypto.randomUUID()}.txt`);
    writeFileSync(existing, 'x');
    const missing = join(tmpdir(), `engram-artifact-missing-${crypto.randomUUID()}.txt`);
    wiki.writePage(
      page({
        artifacts: [
          { kind: 'file', ref: existing, tool: 'Write' },
          { kind: 'file', ref: missing, tool: 'Write' },
          { kind: 'url', ref: 'https://example.com/x', tool: 'Bash' },
          { kind: 'pr', ref: 'https://github.com/a/b/pull/9', tool: 'Bash' },
        ],
      })
    );
    const body: any = await (await fetch(req('/api/wiki/engram'))).json();
    const byRef: Record<string, any> = Object.fromEntries(body.artifacts.map((a: any) => [a.ref, a]));
    expect(byRef[existing].kind).toBe('file');
    expect(byRef[existing].exists).toBe(true);
    expect(byRef[missing].exists).toBe(false); // moved/deleted → struck-through in the UI
    expect(byRef['https://example.com/x'].exists).toBe(true); // url is remote → always true
    expect(byRef['https://github.com/a/b/pull/9'].exists).toBe(true);
    try { rmSync(existing, { force: true }); } catch { /* best effort */ }
  });

  test('GET /api/wiki/:slug 404 for unknown slug (no view logged)', async () => {
    const res = await fetch(req('/api/wiki/nope'));
    expect(res.status).toBe(404);
    expect(t.store.getRecents().length).toBe(0);
  });

  test('GET /api/wiki/:slug 400 for traversal / invalid slug', async () => {
    expect((await fetch(req('/api/wiki/..%2Fetc'))).status).toBe(400);
    expect((await fetch(req('/api/wiki/Bad_Slug'))).status).toBe(400);
  });

  test('/api/search logs once, dedupes repeats, respects 3-char + hits gate', async () => {
    await backend.upsert([chunk('c1', 'raw'), chunk('w1', 'wiki', { trajectoryId: 'wiki:engram' })]);
    await fetch(req('/api/search?q=hello&tier=all'));
    await fetch(req('/api/search?q=hello&tier=all')); // consecutive identical → still one
    let searches = t.store.getRecents().filter((r) => r.kind === 'search');
    expect(searches.length).toBe(1);
    expect(searches[0]!.key).toBe('hello');

    await fetch(req('/api/search?q=hi&tier=all')); // < 3 chars → not logged
    searches = t.store.getRecents().filter((r) => r.kind === 'search');
    expect(searches.some((r) => r.key === 'hi')).toBe(false);
    expect(searches.length).toBe(1);
  });

  test('/api/search does not log a zero-hit query', async () => {
    await backend.upsert([chunk('w1', 'wiki', { trajectoryId: 'wiki:engram' })]);
    // tier=raw with only a wiki chunk seeded → zero results → nothing logged.
    const res = await fetch(req('/api/search?q=anything&tier=raw'));
    const list: any = await res.json();
    expect(list.length).toBe(0);
    expect(t.store.getRecents().length).toBe(0);
  });

  test('/api/search tier=raw returns only raw; default is synth (wiki+dream)', async () => {
    await backend.upsert([
      chunk('c1', 'raw'),
      chunk('d1', 'dream'),
      chunk('w1', 'wiki', { trajectoryId: 'wiki:engram' }),
    ]);
    const raw: any = await (await fetch(req("/api/search?q=hello&tier=raw"))).json();
    expect(raw.map((r: any) => r.tier).sort()).toEqual(['raw']);

    const synth: any = await (await fetch(req('/api/search?q=hello'))).json(); // tier omitted → synth
    expect(synth.map((r: any) => r.tier).sort()).toEqual(['dream', 'wiki']);
  });

  test('/api/trajectory logs view for raw id, not for wiki id', async () => {
    await backend.upsert([
      chunk('c1', 'raw', { trajectoryId: 'traj-abc' }),
      chunk('w1', 'wiki', { trajectoryId: 'wiki:engram' }),
    ]);
    const raw: any = await (await fetch(req('/api/trajectory/traj-abc'))).json();
    expect(raw.length).toBe(1);
    expect(t.store.getRecents().some((r) => r.kind === 'view' && r.key === 'traj:traj-abc')).toBe(true);

    const w: any = await (await fetch(req('/api/trajectory/' + encodeURIComponent('wiki:engram')))).json();
    expect(w.length).toBe(1);
    expect(t.store.getRecents().some((r) => r.key === 'traj:wiki:engram')).toBe(false);
  });

  test('GET /api/recents returns recency-desc rows', async () => {
    t.store.logRecent('search', 'first', 'first');
    t.store.logRecent('view', 'wiki:engram', 'Engram');
    const rows: any = await (await fetch(req("/api/recents"))).json();
    expect(rows[0].key).toBe('wiki:engram');
    expect(rows[1].key).toBe('first');
  });

  test('GET /api/config returns editable keys and never leaks secrets', async () => {
    const res = await fetch(req('/api/config'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.embeddingProvider).toBe('local');
    expect(body.hasOpenaiKey).toBe(true);
    expect(body.hasDatabaseUrl).toBe(true);
    expect('openaiApiKey' in body).toBe(false);
    expect('databaseUrl' in body).toBe(false);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('sk-');
    expect(raw).not.toContain('postgres://');
    expect(raw).not.toContain('databaseUrl');
  });

  test('PUT /api/config rejects secrets and read-only keys (400)', async () => {
    expect((await putConfig({ openaiApiKey: 'x' })).status).toBe(400);
    expect((await putConfig({ databaseUrl: 'postgres://y' })).status).toBe(400);
    expect((await putConfig({ watchPath: '/tmp' })).status).toBe(400);
  });

  test('PUT /api/config rejects type-confused values (400) and leaves the file untouched', async () => {
    const before = readFileSync(configPath, 'utf-8');
    expect((await putConfig({ synthesis: 'on' })).status).toBe(400);
    expect((await putConfig({ contextInjection: 42 })).status).toBe(400);
    expect((await putConfig({ rerank: 'on' })).status).toBe(400);
    expect((await putConfig({ rerank: [] })).status).toBe(400);
    expect((await putConfig({ dreamModel: { a: 1 } })).status).toBe(400);
    expect((await putConfig({ wikiModel: '  ' })).status).toBe(400);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  test('PUT /api/config with a foreign Origin is rejected (403) and the file is untouched', async () => {
    const before = readFileSync(configPath, 'utf-8');
    const res = await putConfig({ dreamModel: 'evil-model' }, { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  test('PUT /api/config requires application/json', async () => {
    const res = await putConfig({}, { 'content-type': 'text/plain' });
    expect(res.status).toBe(400);
  });

  test('PUT /api/config clamps context budget to the max and persists it', async () => {
    const body: any = await (await putConfig({ contextInjection: { budget: 999999 } })).json();
    expect(body.contextInjection.budget).toBe(20000);
    const after: any = await (await fetch(req('/api/config'))).json();
    expect(after.contextInjection.budget).toBe(20000);
    expect(after.contextInjection.enabled).toBe(true); // merged, not overwritten
  });

  test('PUT /api/config preserves unknown keys and secrets already in the file', async () => {
    await putConfig({ dreamModel: 'gpt-4o' });
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(raw.customExperimental).toBe(42);
    expect(raw.dreamModel).toBe('gpt-4o');
    expect(raw.openaiApiKey).toBe('sk-TESTONLY'); // patch never rewrites secrets
    expect(raw.databaseUrl).toBe('postgres://user:pw@host/db');
  });

  test('PUT embeddingProvider change flags reembedRequired (once)', async () => {
    const first: any = await (await putConfig({ embeddingProvider: 'openai' })).json();
    expect(first.reembedRequired).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).embeddingProvider).toBe('openai');
    const again: any = await (await putConfig({ embeddingProvider: 'openai' })).json();
    expect(again.reembedRequired).toBe(false);
  });

  test('PUT synthesis change reconciles the launchd agent', async () => {
    const body: any = await (await putConfig({ synthesis: { enabled: true, hour: 5 } })).json();
    expect(serviceCalls.reconcile).toBe(1);
    expect(body.synthesisReconcile).toEqual({ serviceInstalled: true, action: 'installed' });
    // publicConfig returns the merged config, so the default cap surfaces alongside the patched fields.
    expect(body.synthesis).toEqual({ enabled: true, hour: 5, targetedSessionsPerNight: 5 });
    // The file itself only gains the keys that were patched — the cap was not in this body.
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).synthesis).toEqual({ enabled: true, hour: 5 });
  });

  test('PUT /api/config clamps the targeted-sessions cap to the max and persists it', async () => {
    const body: any = await (await putConfig({ synthesis: { targetedSessionsPerNight: 99 } })).json();
    expect(body.synthesis.targetedSessionsPerNight).toBe(20);
    // Siblings from the on-disk block are preserved, not overwritten.
    expect(body.synthesis.enabled).toBe(false);
    expect(body.synthesis.hour).toBe(3);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8')).synthesis;
    expect(persisted).toEqual({ enabled: false, hour: 3, targetedSessionsPerNight: 20 });
  });

  test('PUT without a synthesis key does not reconcile', async () => {
    await putConfig({ dreamModel: 'gpt-4o' });
    expect(serviceCalls.reconcile).toBe(0);
  });

  test('GET /api/services returns both agents', async () => {
    const body: any = await (await fetch(req('/api/services'))).json();
    expect(body.supported).toBe(true);
    expect(body.serviceInstalled).toBe(true);
    expect(body.agents.map((a: any) => a.label)).toEqual(['com.engram.watcher', 'com.engram.synthesis']);
  });

  test('POST /api/services/:label/restart — 404 unknown label, ok for a known one', async () => {
    const post = (label: string) =>
      fetch(new Request('http://' + HOST + '/api/services/' + label + '/restart', { method: 'POST', headers: { host: HOST } }));
    const bad = await post('bogus');
    expect(bad.status).toBe(404);
    expect(serviceCalls.restart.length).toBe(0);
    const ok = await post('com.engram.watcher');
    expect(ok.status).toBe(200);
    expect(serviceCalls.restart).toEqual(['com.engram.watcher']);
  });

  test('GET /api/wiki/:slug carries evidence fields from the source chunks', async () => {
    await backend.upsert([
      chunk('c1', 'dream', { sessionId: 's1', timestamp: new Date('2026-01-01T00:00:00Z') }),
      chunk('c2', 'dream', { sessionId: 's1', timestamp: new Date('2026-02-01T00:00:00Z') }),
      chunk('c3', 'dream', { sessionId: 's2', timestamp: new Date('2026-03-01T00:00:00Z') }),
    ]);
    wiki.writePage(page({ sources: ['c1', 'c2', 'c3'] }));
    const body: any = await (await fetch(req('/api/wiki/engram'))).json();
    expect(body.sourceCount).toBe(3);
    expect(body.sessionCount).toBe(2); // s1, s2
    expect(new Date(body.firstSeen).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(new Date(body.lastSeen).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  test('GET /api/lint returns {findings:[{rule,level,page,detail}], counts} — dead-artifact from a missing file', async () => {
    const missing = join(tmpdir(), `engram-ui-lint-missing-${crypto.randomUUID()}.txt`);
    wiki.writePage(page({ artifacts: [{ kind: 'file', ref: missing, tool: 'Write' }] }));
    const body: any = await (await fetch(req('/api/lint'))).json();
    expect(Array.isArray(body.findings)).toBe(true);
    expect(typeof body.counts.warns).toBe('number');
    expect(typeof body.counts.infos).toBe('number');
    const dead = body.findings.find((f: any) => f.rule === 'dead-artifact');
    expect(dead).toBeDefined();
    expect(dead.level).toBe('warn'); // severity is surfaced as `level`
    expect(dead.page).toBe('engram');
    expect(dead.detail).toContain(missing);
    try { rmSync(missing, { force: true }); } catch { /* never created */ }
  });

  test('GET /api/wiki lists pages without bodies', async () => {
    wiki.writePage(page());
    const body: any = await (await fetch(req('/api/wiki'))).json();
    expect(body.length).toBe(1);
    expect(body[0]).toEqual({ slug: 'engram', title: 'Engram', kind: 'project', updated: '2026-02-01T00:00:00Z' });
    expect('body' in body[0]).toBe(false);
  });

  // --- POST /api/ask + demand log -------------------------------------------

  // A real OpenAIAskLLM wrapping a fake AskChatClient (no network): returns the
  // given content, or throws to exercise the AskError → 502 path.
  const fakeLLM = (content: string | null, opts: { throws?: boolean } = {}): UiDeps['buildAskLLM'] => {
    const client: AskChatClient = {
      chat: {
        completions: {
          create: async () => {
            if (opts.throws) throw new Error('boom from model');
            return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
          },
        },
      },
    };
    return () => new OpenAIAskLLM('sk-test', 'fake-ask-model', client);
  };

  // Build a fetch with a specific ask-LLM factory, reusing the beforeEach deps.
  const askFetch = (buildAskLLM: UiDeps['buildAskLLM']) =>
    buildUiFetch({ html: () => '<html>', backend, embedder, local: t.store, wiki, dim: 4, port: PORT, services, buildAskLLM });

  const postAsk = (bodyObj: unknown, f = fetch, headers: Record<string, string> = {}) =>
    f(
      new Request('http://' + HOST + '/api/ask', {
        method: 'POST',
        headers: { host: HOST, 'content-type': 'application/json', ...headers },
        body: typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj),
      })
    );

  const demandRows = () => (t.store as any).db.query('SELECT * FROM demand_log ORDER BY id').all() as any[];

  test('POST /api/ask returns 200 with answer + sources and logs an answered demand row', async () => {
    await backend.upsert([chunk('d1', 'dream', { dreamType: 'gotcha' })]);
    const f = askFetch(fakeLLM('The fix is grounded in the notes [1].'));
    const res = await postAsk({ q: 'how do we handle X' }, f);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.answer).toBe('The fix is grounded in the notes [1].');
    expect(body.sources.length).toBe(1);
    expect(body.sources[0].cited).toBe(true);
    expect(body.model).toBe('fake-ask-model');
    expect(typeof body.tookMs).toBe('number');
    expect(body.usage).toEqual({ promptTokens: 10, completionTokens: 5 });

    const rows = demandRows();
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('ask');
    expect(rows[0].surface).toBe('ui');
    expect(rows[0].outcome).toBe('answered');
    expect(rows[0].cited_count).toBe(1);
    expect(rows[0].top_tier).toBe('dream');
    // Ask rows leave the targeted-synthesis handle null (AskSource carries no id).
    expect(rows[0].top_session_id).toBeNull();
    expect(rows[0].top_similarity).toBeNull();
    // A recent 'ask' row is logged pre-call.
    expect(t.store.getRecents().some((r) => r.kind === 'ask' && r.key === 'how do we handle X')).toBe(true);
  });

  test('POST /api/ask sources carry their chunk artifacts (serialized wholesale)', async () => {
    await backend.upsert([
      chunk('d1', 'dream', {
        dreamType: 'gotcha',
        artifacts: [
          { kind: 'file', ref: 'src/a.ts', tool: 'Write' },
          { kind: 'url', ref: 'https://x.dev/p', tool: 'Bash' },
        ],
      }),
    ]);
    const f = askFetch(fakeLLM('grounded [1].'));
    const body: any = await (await postAsk({ q: 'artifacts?' }, f)).json();
    expect(body.sources[0].artifacts).toEqual([
      { kind: 'file', ref: 'src/a.ts', tool: 'Write' },
      { kind: 'url', ref: 'https://x.dev/p', tool: 'Bash' },
    ]);
  });

  test('POST /api/ask with no OpenAI key → 503 no_api_key', async () => {
    const f = askFetch(() => null);
    const res = await postAsk({ q: 'anything' }, f);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe('no_api_key');
    // No key ⇒ no runAsk ⇒ no demand row (recents still logs nothing either).
    expect(demandRows().length).toBe(0);
  });

  test('POST /api/ask zero candidates → answer:null + no_candidates demand row (LLM untouched)', async () => {
    // No chunks seeded → runSearch returns [] → runAsk short-circuits, never
    // calling the LLM (a throwing fake proves it).
    const f = askFetch(fakeLLM(null, { throws: true }));
    const res = await postAsk({ q: 'nothing indexed yet' }, f);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.answer).toBeNull();
    expect(body.sources.length).toBe(0);
    const rows = demandRows();
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('no_candidates');
    expect(rows[0].result_count).toBe(0);
  });

  test('POST /api/ask answer citing nothing → not_covered demand row', async () => {
    await backend.upsert([chunk('d1', 'dream')]);
    const f = askFetch(fakeLLM('The material does not cover this question.'));
    const res = await postAsk({ q: 'unrelated question' }, f);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.answer).toContain('does not cover');
    const rows = demandRows();
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('not_covered');
    expect(rows[0].cited_count).toBe(0);
  });

  test('POST /api/ask AskError from the model → 502 JSON + error demand row', async () => {
    await backend.upsert([chunk('d1', 'dream')]);
    const f = askFetch(fakeLLM(null, { throws: true }));
    const res = await postAsk({ q: 'triggers a model error' }, f);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toContain('boom from model');
    const rows = demandRows();
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('error');
  });

  test('POST /api/ask rejects non-JSON body (400) and non-JSON content-type (400)', async () => {
    const f = askFetch(fakeLLM('unused'));
    expect((await postAsk('not json at all', f)).status).toBe(400);
    expect((await postAsk({ q: 'x' }, f, { 'content-type': 'text/plain' })).status).toBe(400);
    // Missing/empty q → 400 before any LLM build.
    expect((await postAsk({ q: '  ' }, f)).status).toBe(400);
    expect((await postAsk({}, f)).status).toBe(400);
    // GET is not allowed.
    expect((await f(req('/api/ask'))).status).toBe(405);
  });

  test('POST /api/ask with a foreign Origin is rejected (403), no demand row', async () => {
    const f = askFetch(fakeLLM('grounded [1]'));
    const res = await postAsk({ q: 'x' }, f, { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(demandRows().length).toBe(0);
  });

  test('/api/search logs a demand row for a zero-hit query (strongest unmet signal)', async () => {
    await backend.upsert([chunk('w1', 'wiki', { trajectoryId: 'wiki:engram' })]);
    // tier=raw with only a wiki chunk seeded → zero hits.
    const res = await fetch(req('/api/search?q=missing-topic&tier=raw'));
    expect(((await res.json()) as any).length).toBe(0);
    const rows = demandRows();
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('search');
    expect(rows[0].query).toBe('missing-topic');
    expect(rows[0].result_count).toBe(0);
    expect(rows[0].outcome).toBeNull();
    // Zero-hit ⇒ not a recent (recents gate requires hits), but IS demand.
    expect(t.store.getRecents().length).toBe(0);
  });

  test('/api/search logs a demand row with top_* for a hit', async () => {
    await backend.upsert([chunk('d1', 'dream', { sessionId: 'sess-xyz' })]);
    await fetch(req('/api/search?q=find-something&tier=synth'));
    const rows = demandRows();
    expect(rows.length).toBe(1);
    expect(rows[0].result_count).toBe(1);
    expect(rows[0].top_tier).toBe('dream');
    expect(rows[0].top_session_id).toBe('sess-xyz');
    expect(typeof rows[0].top_similarity).toBe('number');
  });

  test('GET /api/demand returns {days, summary, unmet[]} and clamps days', async () => {
    await backend.upsert([chunk('w1', 'wiki', { trajectoryId: 'wiki:engram' })]);
    await fetch(req('/api/search?q=unmet-thing&tier=raw')); // zero hit → unmet
    const body: any = await (await fetch(req('/api/demand?days=7'))).json();
    expect(body.days).toBe(7);
    expect(body.summary.days).toBe(7);
    expect(body.summary.searches).toBe(1);
    expect(body.summary.unmet).toBe(1);
    expect(Array.isArray(body.unmet)).toBe(true);
    expect(body.unmet[0].query).toBe('unmet-thing');
    expect(body.unmet[0].count).toBe(1);

    // days clamps to 1..365.
    expect(((await (await fetch(req('/api/demand?days=99999'))).json()) as any).days).toBe(365);
    expect(((await (await fetch(req('/api/demand?days=0'))).json()) as any).days).toBe(1);
    expect(((await (await fetch(req('/api/demand'))).json()) as any).days).toBe(30);
  });
});
