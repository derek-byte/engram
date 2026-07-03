import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chunk } from '../types/index.ts';
import { FakeBackend, FakeProvider, FakeWikiLLM, testConfig } from '../ingest/testkit.ts';
import { Embedder } from '../ingest/embed.ts';
import { WikiStore } from './store.ts';
import { ingestWiki, reindexWiki, pageToChunkTexts, type WikiIngestDeps } from './ingest.ts';
import type { WikiPageOp } from './llm.ts';

const SRC = 'test:wiki-dream';
const WIKI = 'test:wiki';

function dreamChunk(id: string, sessionId: string, repo: string, kind: string, content: string, ts = 1_700_000_000_000): Chunk {
  return {
    id,
    embedding: [],
    content,
    metadata: {
      repo,
      branch: '',
      timestamp: new Date(ts),
      filePaths: [],
      exitCode: null,
      sessionId,
      cwd: '',
      tier: 'dream',
      owner: SRC,
      dreamType: kind,
    },
  };
}

const LONG_BODY = 'pgvector backs the index. [[fingerprint-skip]] uses it. '.repeat(20); // >500 chars

// Script: unit s1 creates two interlinked pages; unit s2 tries to shrink pgvector.
function script(header: string): { pages: WikiPageOp[] } {
  if (header.includes('s2')) {
    return {
      pages: [{ slug: 'pgvector', action: 'update', kind: 'tool', title: 'pgvector', summary: 'x', aliases: [], body: 'tiny [[fingerprint-skip]]', sources: ['d3'] }],
    };
  }
  return {
    pages: [
      { slug: 'pgvector', action: 'create', kind: 'tool', title: 'pgvector', summary: 'the vector store', aliases: ['pg-vector'], body: LONG_BODY, sources: ['d1'] },
      { slug: 'fingerprint-skip', action: 'create', kind: 'decision', title: 'Fingerprint short-circuit', summary: 'skip unchanged units', aliases: [], body: 'The fingerprint skip relies on [[pgvector]].', sources: ['d2'] },
    ],
  };
}

function makeDeps(dir: string, llm: FakeWikiLLM): { backend: FakeBackend; deps: WikiIngestDeps } {
  const backend = new FakeBackend();
  const embedder = new Embedder(new FakeProvider({ dim: 4 }), backend);
  const store = new WikiStore(dir);
  return { backend, deps: { backend, store, embedder, llm, config: testConfig({ wikiDir: dir }) } };
}

describe('pageToChunkTexts', () => {
  test('single chunk under budget, splits on ## over budget', () => {
    expect(pageToChunkTexts('short body')).toHaveLength(1);
    const big = `intro\n${'## H\n'.padEnd(3000, 'x')}\n## Second\n${'y'.repeat(3000)}`;
    expect(pageToChunkTexts(big).length).toBeGreaterThan(1);
  });
});

describe('ingestWiki', () => {
  test('compiles pages with provenance + links, syncs pg, skips on re-run', async () => {
    const dir = join(tmpdir(), `engram-wiki-ingest-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(script);
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([
        dreamChunk('d1', 's1', 'engram', 'decision', 'we chose pgvector for the vector store'),
        dreamChunk('d2', 's1', 'engram', 'gotcha', 'fingerprint short-circuit skips unchanged units'),
      ]);

      const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(res.unitsCompiled).toBe(1);
      expect(res.pagesCreated).toBe(2);
      expect(llm.callCount).toBe(1);

      // Pages on disk carry provenance + fingerprint + merged trajectory.
      const pg = deps.store.readPage('pgvector')!;
      expect(pg.sources).toContain('d1');
      expect(pg.trajectories[0]).toStartWith('dream:');
      expect(pg.fingerprint).toBeTruthy();

      // Links form both directions; index has no orphans.
      const graph = deps.store.linkGraph();
      expect(graph.inbound.get('pgvector')).toContain('fingerprint-skip');
      expect(graph.inbound.get('fingerprint-skip')).toContain('pgvector');

      // Embedded into pg under tier='wiki', owner WIKI, trajectory 'wiki:<slug>'.
      const traj = await backend.getTrajectory('wiki:pgvector');
      expect(traj.length).toBeGreaterThan(0);
      expect(traj[0]!.metadata.tier).toBe('wiki');
      expect(traj[0]!.metadata.owner).toBe(WIKI);

      // Ledger recorded.
      expect((await backend.getWikiUnits(WIKI)).length).toBe(1);

      // Re-run: fingerprint unchanged → 100% skip, no LLM calls.
      const before = llm.callCount;
      const rerun = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(rerun.unitsSkipped).toBe(1);
      expect(rerun.pagesCreated).toBe(0);
      expect(llm.callCount).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shrink guard rejects a collapsing rewrite', async () => {
    const dir = join(tmpdir(), `engram-wiki-guard-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(script);
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector'), dreamChunk('d2', 's1', 'engram', 'gotcha', 'fp skip')]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      const bodyBefore = deps.store.readPage('pgvector')!.body;

      // New unit s2 tries to shrink pgvector below 40%.
      await backend.upsert([dreamChunk('d3', 's2', 'engram', 'decision', 'more pgvector notes')]);
      const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(res.pagesSkippedGuard).toBe(1);
      expect(deps.store.readPage('pgvector')!.body).toBe(bodyBefore); // old page kept
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  test('filters op sources to real item ids from the unit', async () => {
    const dir = join(tmpdir(), `engram-wiki-src-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(() => ({
      pages: [{ slug: 'pgvector', action: 'create' as const, kind: 'tool' as const, title: 'pgvector', summary: 'x', aliases: [], body: 'b [[fingerprint-skip]]', sources: ['d1', 'gotcha', 'made-up'] }],
    }));
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector')]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect(deps.store.readPage('pgvector')!.sources).toEqual(['d1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dry-run plans without writing or calling the LLM', async () => {
    const dir = join(tmpdir(), `engram-wiki-dry-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(script);
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector')]);
      const res = await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: true }, deps);
      expect(res.dryRun).toBe(true);
      expect(res.plan?.length).toBe(1);
      expect(llm.callCount).toBe(0);
      expect(deps.store.listSlugs()).toEqual([]);
      expect(existsSync(dir)).toBe(false); // dry-run must not bootstrap the wiki dir
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reindex drops pg chunks for deleted pages', async () => {
    const dir = join(tmpdir(), `engram-wiki-reindex-${crypto.randomUUID()}`);
    const llm = new FakeWikiLLM(script);
    const { backend, deps } = makeDeps(dir, llm);
    try {
      await backend.upsert([dreamChunk('d1', 's1', 'engram', 'decision', 'chose pgvector'), dreamChunk('d2', 's1', 'engram', 'gotcha', 'fp skip')]);
      await ingestWiki({ sourceOwner: SRC, wikiOwner: WIKI, limit: 20, dryRun: false }, deps);
      expect((await backend.listWikiChunkIds(WIKI)).length).toBeGreaterThan(0);

      // Delete a page file, then reconcile.
      rmSync(deps.store.pagePath('pgvector'));
      const res = await reindexWiki(WIKI, { backend, store: deps.store, embedder: deps.embedder });
      expect(res.pages).toBe(1);
      expect(res.dropped).toBeGreaterThan(0);
      expect(await backend.getTrajectory('wiki:pgvector')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
