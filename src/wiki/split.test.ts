import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBackend, FakeProvider, FakeWikiLLM, testConfig } from '../ingest/testkit.ts';
import { Embedder } from '../ingest/embed.ts';
import { WikiStore, pageFingerprint, type WikiPage } from './store.ts';
import { syncPageToIndex, violatesShrinkGuard } from './ingest.ts';
import { splitPage, type WikiSplitDeps } from './split.ts';
import type { WikiPageOp } from './llm.ts';

const WIKI = 'test:wiki';
const HUB_SOURCES = ['s1', 's2', 's3'];

function fatHub(): WikiPage {
  return {
    slug: 'fat-hub',
    schema: 1,
    title: 'Fat Hub',
    kind: 'project',
    summary: 'the everything page',
    aliases: ['the-hub'],
    sources: [...HUB_SOURCES],
    trajectories: ['dream:abc'],
    fingerprint: pageFingerprint(HUB_SOURCES),
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-06-01T00:00:00.000Z',
    body: 'Everything about the project lives here. '.repeat(60), // >500 chars → guard would trigger
  };
}

function makeDeps(dir: string, splitScript?: (page: WikiPage, inventory: string) => { pages: WikiPageOp[] }) {
  const backend = new FakeBackend();
  const embedder = new Embedder(new FakeProvider({ dim: 4 }), backend);
  const store = new WikiStore(dir);
  const llm = new FakeWikiLLM(() => ({ pages: [] }), splitScript);
  const deps: WikiSplitDeps = { backend, store, embedder, llm, config: testConfig({ wikiDir: dir }) };
  return { backend, store, embedder, llm, deps };
}

// A well-formed split: hub → tiny index, plus two children (one valid-subset
// source, one invalid → full inherit).
const goodSplit = (): { pages: WikiPageOp[] } => ({
  pages: [
    { slug: 'fat-hub', action: 'update', kind: 'project', title: 'Fat Hub', summary: 'index', aliases: [], body: '## Child A\n[[child-a]] covers storage.\n\n## Child B\n[[child-b]] covers skipping.', sources: [] },
    { slug: 'child-a', action: 'create', kind: 'tool', title: 'Child A', summary: 'a', aliases: [], body: 'Storage details here.', sources: ['s1'] },
    { slug: 'child-b', action: 'create', kind: 'decision', title: 'Child B', summary: 'b', aliases: [], body: 'Skip details here.', sources: ['made-up'] },
  ],
});

describe('violatesShrinkGuard', () => {
  test('true only when old > 500 chars and new < 40% of old', () => {
    expect(violatesShrinkGuard('x'.repeat(1000), 'y'.repeat(100))).toBe(true);
    expect(violatesShrinkGuard('x'.repeat(1000), 'y'.repeat(500))).toBe(false); // exactly 50%
    expect(violatesShrinkGuard('x'.repeat(100), '')).toBe(false); // old too small
    expect(violatesShrinkGuard('x'.repeat(1000), 'x'.repeat(1000))).toBe(false);
  });
});

describe('splitPage', () => {
  test('rewrites the hub to a link index + children, bypassing the shrink guard', async () => {
    const dir = join(tmpdir(), `engram-wiki-split-${crypto.randomUUID()}`);
    const { backend, store, embedder, deps } = makeDeps(dir, goodSplit);
    try {
      store.init();
      const hub = fatHub();
      store.writePage(hub);
      await syncPageToIndex(hub, WIKI, { backend, embedder });
      const oldHubChunkIds = (await backend.getTrajectory('wiki:fat-hub')).map((c) => c.id);
      expect(oldHubChunkIds.length).toBeGreaterThan(0);

      const res = await splitPage({ wikiOwner: WIKI, slug: 'fat-hub', dryRun: false }, deps);

      // Hub shrank far below 40% yet was written (guard bypassed).
      expect(res.shrinkGuardBypassed).toBe(true);
      expect(res.hubChars.after).toBeLessThan(res.hubChars.before * 0.4);
      const newHub = store.readPage('fat-hub')!;
      expect(newHub.body).toContain('[[child-a]]');
      expect(newHub.body).toContain('[[child-b]]');
      expect(newHub.sources.sort()).toEqual([...HUB_SOURCES].sort()); // hub keeps full set
      expect(newHub.created).toBe(hub.created); // created preserved

      // Children written with the right provenance.
      expect(res.children.sort()).toEqual(['child-a', 'child-b']);
      expect(store.readPage('child-a')!.sources).toEqual(['s1']); // valid subset
      expect(store.readPage('child-b')!.sources.sort()).toEqual([...HUB_SOURCES].sort()); // invalid → full inherit
      expect(res.sourcesInherited).toEqual({ subset: 1, full: 1 });

      // pg reconciled: old hub chunks gone, new hub + child chunks present.
      const newHubChunks = await backend.getTrajectory('wiki:fat-hub');
      expect(newHubChunks.length).toBeGreaterThan(0);
      for (const oldId of oldHubChunkIds) {
        if (!newHubChunks.some((c) => c.id === oldId)) {
          expect(backend.chunks.has(oldId)).toBe(false);
        }
      }
      expect((await backend.getTrajectory('wiki:child-a')).length).toBeGreaterThan(0);

      // Index regenerated + committed.
      expect(existsSync(store.indexPath)).toBe(true);
      expect(store.head()).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails (nothing written) when the response has no hub update op', async () => {
    const dir = join(tmpdir(), `engram-wiki-split-nohub-${crypto.randomUUID()}`);
    const { store, deps } = makeDeps(dir, () => ({
      pages: [{ slug: 'child-a', action: 'create', kind: 'tool', title: 'A', summary: 'a', aliases: [], body: 'only a child', sources: [] }],
    }));
    try {
      store.init();
      const hub = fatHub();
      store.writePage(hub);
      await expect(splitPage({ wikiOwner: WIKI, slug: 'fat-hub', dryRun: false }, deps)).rejects.toThrow();
      expect(store.readPage('fat-hub')!.body).toBe(hub.body.trim()); // untouched
      expect(store.listSlugs()).toEqual(['fat-hub']); // no child written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('drops a child op that collides with an existing unrelated page', async () => {
    const dir = join(tmpdir(), `engram-wiki-split-collide-${crypto.randomUUID()}`);
    const { store, deps } = makeDeps(dir, () => ({
      pages: [
        { slug: 'fat-hub', action: 'update', kind: 'project', title: 'Fat Hub', summary: 'i', aliases: [], body: 'index [[child-a]] [[existing-other]]', sources: [] },
        { slug: 'child-a', action: 'create', kind: 'tool', title: 'A', summary: 'a', aliases: [], body: 'new child', sources: ['s1'] },
        { slug: 'existing-other', action: 'create', kind: 'tool', title: 'X', summary: 'x', aliases: [], body: 'SHOULD NOT OVERWRITE', sources: ['s2'] },
      ],
    }));
    try {
      store.init();
      store.writePage(fatHub());
      const other: WikiPage = { ...fatHub(), slug: 'existing-other', title: 'Existing Other', aliases: [], body: 'original untouched body here, big enough' };
      store.writePage(other);

      const res = await splitPage({ wikiOwner: WIKI, slug: 'fat-hub', dryRun: false }, deps);
      expect(res.children).toEqual(['child-a']); // collider dropped
      expect(store.readPage('existing-other')!.body).toBe(other.body); // NOT overwritten
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dry-run writes nothing and makes no LLM call', async () => {
    const dir = join(tmpdir(), `engram-wiki-split-dry-${crypto.randomUUID()}`);
    const { store, llm, deps } = makeDeps(dir, goodSplit);
    try {
      store.init();
      const hub = fatHub();
      store.writePage(hub);
      const res = await splitPage({ wikiOwner: WIKI, slug: 'fat-hub', dryRun: true }, deps);
      expect(res.dryRun).toBe(true);
      expect(res.estTokens).toBeGreaterThan(0);
      expect(llm.splitCallCount).toBe(0);
      expect(store.readPage('fat-hub')!.body).toBe(hub.body.trim());
      expect(store.listSlugs()).toEqual(['fat-hub']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
