import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUiFetch } from './ui.ts';
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
  let fetch: (req: Request) => Promise<Response>;

  beforeEach(() => {
    t = tempStore();
    backend = new FakeBackend();
    wikiDir = join(tmpdir(), `engram-ui-test-${crypto.randomUUID()}`);
    wiki = new WikiStore(wikiDir);
    const embedder = new Embedder(new FakeProvider({ dim: 4 }), new FakeCache());
    fetch = buildUiFetch({ html: '<html>', backend, embedder, local: t.store, wiki, dim: 4, port: PORT });
  });
  afterEach(() => {
    t.cleanup();
    try { rmSync(wikiDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

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
});
