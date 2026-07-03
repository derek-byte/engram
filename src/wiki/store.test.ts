import { describe, expect, test } from 'bun:test';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { WikiStore, parsePage, serializePage, pageFingerprint, type WikiPage } from './store.ts';

function tempDir(): string {
  return join(tmpdir(), `engram-wiki-test-${crypto.randomUUID()}`);
}

function samplePage(over: Partial<WikiPage> = {}): WikiPage {
  const sources = ['src-b', 'src-a'];
  return {
    slug: 'fingerprint-skip',
    schema: 1,
    title: 'Fingerprint short-circuit',
    kind: 'decision',
    summary: 'sha256 of sorted sources short-circuits re-ingest',
    aliases: ['fp-skip'],
    sources,
    trajectories: ['dream:abc'],
    fingerprint: pageFingerprint(sources),
    created: '2026-07-02T03:00:00.000Z',
    updated: '2026-07-02T03:00:00.000Z',
    body: 'The fingerprint links to [[pgvector]] and skips unchanged units.',
    ...over,
  };
}

describe('WikiStore safety', () => {
  test('rejects unsafe wikiDir', () => {
    expect(() => new WikiStore('/')).toThrow();
    expect(() => new WikiStore(homedir())).toThrow();
    expect(() => new WikiStore('relative/path')).toThrow();
  });
});

describe('frontmatter codec', () => {
  test('round-trips deterministically', () => {
    const page = samplePage();
    const serialized = serializePage(page);
    const parsed = parsePage('fingerprint-skip', serialized);
    expect(parsed.title).toBe(page.title);
    expect(parsed.kind).toBe('decision');
    expect(parsed.aliases).toEqual(['fp-skip']);
    expect(parsed.sources.sort()).toEqual(['src-a', 'src-b']);
    expect(parsed.body).toBe(page.body);
    // Re-serializing yields byte-identical output (stable git diffs).
    expect(serializePage(parsed)).toBe(serialized);
  });
  test('throws on missing frontmatter', () => {
    expect(() => parsePage('x', 'no frontmatter here')).toThrow();
  });
});

describe('WikiStore filesystem', () => {
  test('init writes SCHEMA.md + git, writePage/readPage round-trip, renderIndex groups + orphans', () => {
    const dir = tempDir();
    const store = new WikiStore(dir);
    try {
      store.init();
      expect(existsSync(store.schemaPath)).toBe(true);
      expect(existsSync(join(dir, '.git'))).toBe(true);

      const a = samplePage();
      const b = samplePage({
        slug: 'pgvector',
        title: 'pgvector',
        kind: 'tool',
        summary: 'the vector store',
        aliases: [],
        body: 'pgvector backs the [[fingerprint-skip]] index.',
      });
      store.writePage(a);
      store.writePage(b);

      expect(store.listSlugs()).toEqual(['fingerprint-skip', 'pgvector']);
      expect(store.readPage('pgvector')?.title).toBe('pgvector');

      store.renderIndex();
      const index = readFileSync(store.indexPath, 'utf-8');
      expect(index).toContain('## decision');
      expect(index).toContain('## tool');
      expect(index).toContain('[[fingerprint-skip]]');
      // Both pages link each other → neither is an orphan.
      expect(index).not.toContain('## orphans');

      store.commit('test');
      expect(store.head()).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
