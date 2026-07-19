import { describe, expect, test } from 'bun:test';
import type { Chunk } from '../types/index.ts';
import type { ContextStore } from '../storage/backend.ts';
import { buildContext } from './compose.ts';

const NOW = new Date('2026-07-04T00:00:00Z');

interface FakeData {
  provenance?: Array<{ slug: string; matchCount: number; lastChunkAt: Date | null; excerpt: string }>;
  mentions?: Array<{ trajectoryId: string | null; rank: number; content: string }>;
  dreams?: Chunk[];
}

class FakeContextStore implements ContextStore {
  constructor(private data: FakeData) {}
  async wikiPagesForRepo(_o: string, _r: string, limit: number) {
    return (this.data.provenance ?? []).slice(0, limit);
  }
  async recentDreamChunks(_o: string, _r: string, _s: Date, _t: string[], limit: number) {
    return (this.data.dreams ?? []).slice(0, limit);
  }
  async keywordSearchChunks(_o: string, _t: string, _q: string, limit: number) {
    return (this.data.mentions ?? []).slice(0, limit);
  }
}

function dream(id: string, type: string, text: string, ageDays: number): Chunk {
  return {
    id,
    content: text,
    metadata: {
      repo: 'r',
      branch: '',
      timestamp: new Date(NOW.getTime() - ageDays * 86_400_000),
      filePaths: [],
      exitCode: null,
      sessionId: 's',
      cwd: '',
      tier: 'dream',
      dreamType: type,
    },
  };
}

function prov(slug: string, matchCount: number) {
  return { slug, matchCount, lastChunkAt: NOW, excerpt: `Excerpt for ${slug}. More text.` };
}

const base = { owner: 'derek', budgetTokens: 1500, now: NOW };

describe('buildContext', () => {
  test('determinism: two identical calls yield byte-identical markdown', async () => {
    const store = new FakeContextStore({
      provenance: [prov('alpha', 5), prov('beta', 3)],
      dreams: [dream('d1', 'decision', 'We chose X.', 2)],
    });
    const a = await buildContext({ repo: 'r', ...base }, { backend: store, store: null });
    const b = await buildContext({ repo: 'r', ...base }, { backend: store, store: null });
    expect(a.markdown).toBe(b.markdown);
    expect(a.markdown.length).toBeGreaterThan(0);
  });

  test('silent-empty: no candidates → empty markdown', async () => {
    const store = new FakeContextStore({});
    const r = await buildContext({ repo: 'r', ...base }, { backend: store, store: null });
    expect(r.markdown).toBe('');
    expect(r.pages).toEqual([]);
    expect(r.memories).toEqual([]);
    expect(r.estTokens).toBe(0);
  });

  test('provenance renders before mentions, deduped', async () => {
    const store = new FakeContextStore({
      provenance: [prov('alpha', 5)],
      mentions: [
        { trajectoryId: 'wiki:alpha', rank: 9, content: 'dup' }, // deduped
        { trajectoryId: 'wiki:zeta', rank: 8, content: 'A mention page. Body.' },
      ],
      dreams: [dream('d1', 'decision', 'Known repo.', 1)],
    });
    const r = await buildContext({ repo: 'myrepo', ...base }, { backend: store, store: null });
    expect(r.pages.map((p) => p.slug)).toEqual(['alpha', 'zeta']);
    expect(r.pages[0]!.source).toBe('provenance');
    expect(r.pages[1]!.source).toBe('mention');
  });

  test('mentions suppressed for an unknown repo (no provenance, no memories)', async () => {
    const store = new FakeContextStore({
      mentions: [{ trajectoryId: 'wiki:generic', rank: 1, content: 'mentions the word repo' }],
    });
    const r = await buildContext({ repo: 'myrepo', ...base }, { backend: store, store: null });
    expect(r.markdown).toBe('');
    expect(r.pages).toEqual([]);
  });

  test('hard caps: at most 6 pages / 10 memories', async () => {
    const store = new FakeContextStore({
      provenance: Array.from({ length: 8 }, (_, i) => prov(`p${i}`, 8 - i)),
      dreams: Array.from({ length: 12 }, (_, i) => dream(`d${i}`, 'decision', `Decision ${i}.`, i)),
    });
    const r = await buildContext({ repo: 'r', ...base, budgetTokens: 20000 }, { backend: store, store: null });
    expect(r.pages.length).toBe(6);
    expect(r.memories.length).toBe(10);
  });

  test('budget drops whole items from the bottom; footer survives; within budget', async () => {
    const store = new FakeContextStore({
      provenance: Array.from({ length: 6 }, (_, i) => prov(`page-${i}`, 6 - i)),
      dreams: Array.from({ length: 10 }, (_, i) => dream(`d${i}`, 'gotcha', `Gotcha number ${i} with a fairly long sentence to consume budget.`, i)),
    });
    const full = await buildContext({ repo: 'r', ...base, budgetTokens: 20000 }, { backend: store, store: null });
    const tight = await buildContext({ repo: 'r', ...base, budgetTokens: 250 }, { backend: store, store: null });
    expect(tight.estTokens).toBeLessThanOrEqual(250);
    expect(tight.pages.length + tight.memories.length).toBeLessThan(full.pages.length + full.memories.length);
    // Footer always present.
    expect(tight.markdown).toContain('_from engram ·');
    // No mid-sentence truncation: every rendered line ends cleanly.
    for (const line of tight.markdown.split('\n')) {
      if (line.startsWith('- ')) expect(line.endsWith('…')).toBe(false);
    }
  });

  test('footer counts reflect rendered items', async () => {
    const store = new FakeContextStore({
      provenance: [prov('alpha', 5), prov('beta', 3)],
      dreams: [dream('d1', 'decision', 'A.', 1), dream('d2', 'gotcha', 'B.', 2)],
    });
    const r = await buildContext({ repo: 'r', ...base }, { backend: store, store: null });
    expect(r.markdown).toContain(`_from engram · ${r.pages.length} pages, ${r.memories.length} memories`);
  });

  test('multi-line frontmatter summary is collapsed to one line', async () => {
    const store = new FakeContextStore({
      provenance: [prov('alpha', 5)],
      dreams: [dream('d1', 'decision', 'X.', 1)],
    });
    const wikiStore = {
      readPage: () => ({ title: 'Alpha\nPage', summary: 'Line one.\n## Injected header\nLine two.', updated: '2026-07-01' }),
    } as unknown as import('../wiki/store.ts').WikiStore;
    const r = await buildContext({ repo: 'r', ...base }, { backend: store, store: wikiStore });
    const line = r.markdown.split('\n').find((l) => l.startsWith('- alpha'))!;
    expect(line).toBe('- alpha — Line one. ## Injected header Line two. (updated 2026-07-01)');
    expect(r.pages[0]!.summary).not.toContain('\n');
  });

  test('header carries branch when present', async () => {
    const store = new FakeContextStore({ dreams: [dream('d1', 'decision', 'X.', 1)] });
    const r = await buildContext({ repo: 'r', branch: 'feature/foo', ...base }, { backend: store, store: null });
    expect(r.markdown).toContain('## Prior context from engram — r@feature/foo');
  });
});
