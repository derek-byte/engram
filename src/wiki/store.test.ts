import { describe, expect, test } from 'bun:test';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { Artifact } from '../types/index.ts';
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

  test('pagePath rejects traversal slugs at the single chokepoint (no fs escape)', () => {
    const dir = tempDir();
    const store = new WikiStore(dir);
    try {
      store.init();
      // readPage/writePage/pagePath all funnel through pagePath → isValidSlug.
      expect(() => store.readPage('../../../etc/passwd')).toThrow(/invalid wiki slug/);
      expect(() => store.readPage('..%2f..')).toThrow(/invalid wiki slug/);
      expect(() => store.pagePath('../secret')).toThrow(/invalid wiki slug/);
      expect(() => store.writePage(samplePage({ slug: '../../evil' }))).toThrow(/invalid wiki slug/);
      // Nothing was written or read outside pagesDir.
      expect(existsSync(join(dir, '..', 'evil.md'))).toBe(false);

      // A valid slug is unchanged — resolves under pages/ and round-trips.
      expect(store.pagePath('fingerprint-skip')).toBe(join(store.pagesDir, 'fingerprint-skip.md'));
      store.writePage(samplePage());
      expect(store.readPage('fingerprint-skip')?.slug).toBe('fingerprint-skip');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  test('artifacts round-trip as JSON objects, byte-identical across write→parse→write', () => {
    const artifacts: Artifact[] = [
      { kind: 'file', ref: 'src/desktop/hotkey.rs', tool: 'Write' },
      { kind: 'pr', ref: 'https://github.com/org/repo/pull/42', tool: 'gh' },
    ];
    const page = samplePage({ artifacts });
    const serialized = serializePage(page);
    expect(serialized).toContain('artifacts: [{"kind":"file","ref":"src/desktop/hotkey.rs","tool":"Write"}');

    const parsed = parsePage('fingerprint-skip', serialized);
    expect(parsed.artifacts).toEqual(artifacts);
    expect(serializePage(parsed)).toBe(serialized); // stable key order + escaping
  });

  test('parsePage on a pre-wave-10 page (no artifacts key) yields [] without throwing', () => {
    const legacy = [
      '---',
      'schema: 1',
      'title: Old Page',
      'kind: topic',
      'summary: from before artifacts existed',
      'aliases: []',
      'sources: ["c1"]',
      'trajectories: ["dream:x"]',
      `fingerprint: ${pageFingerprint(['c1'])}`,
      'created: 2026-01-01T00:00:00.000Z',
      'updated: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      'Body text.',
      '',
    ].join('\n');
    const parsed = parsePage('old-page', legacy);
    expect(parsed.artifacts).toEqual([]);
  });

  test('SACRED: pageFingerprint ignores artifacts (same sources ⇒ same fingerprint)', () => {
    const sources = ['src-b', 'src-a'];
    const withArt = samplePage({ sources, artifacts: [{ kind: 'file', ref: 'x.rs', tool: 'Write' }] });
    const without = samplePage({ sources, artifacts: [] });
    expect(withArt.fingerprint).toBe(without.fingerprint);
    expect(pageFingerprint(sources)).toBe(withArt.fingerprint);
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
