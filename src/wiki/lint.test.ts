import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiStore, pageFingerprint, type WikiPage } from './store.ts';
import { lintWiki } from './lint.ts';

function page(over: Partial<WikiPage>): WikiPage {
  const sources = over.sources ?? ['s1'];
  return {
    slug: 'x',
    schema: 1,
    title: 'X',
    kind: 'topic',
    summary: 's',
    aliases: [],
    sources,
    trajectories: [],
    fingerprint: pageFingerprint(sources),
    created: '2026-07-02T00:00:00.000Z',
    updated: '2026-07-02T00:00:00.000Z',
    body: 'body',
    ...over,
  };
}

describe('lintWiki', () => {
  test('flags orphans, dangling links, link-less pages, drift, fingerprint mismatch', async () => {
    const dir = join(tmpdir(), `engram-wiki-lint-${crypto.randomUUID()}`);
    const store = new WikiStore(dir);
    try {
      store.init();
      // hub links to pgvector; pg-vector is a near-duplicate orphan; ghost link dangles.
      store.writePage(page({ slug: 'hub', title: 'Hub', body: 'links [[pgvector]] and [[ghost]] '.repeat(6) }));
      store.writePage(page({ slug: 'pgvector', title: 'pgvector', body: 'the store, big enough not to be a stub '.repeat(5) }));
      store.writePage(page({ slug: 'pg-vector', title: 'pg-vector', body: 'duplicate-ish page with no outbound links at all '.repeat(4) }));
      // corrupt fingerprint on a page
      store.writePage(page({ slug: 'bad-fp', body: 'links [[hub]] '.repeat(20), fingerprint: 'deadbeef' }));

      const findings = await lintWiki(store);
      const rules = new Set(findings.map((f) => f.rule));
      expect(rules.has('orphan')).toBe(true);
      expect(rules.has('dangling-link')).toBe(true);
      expect(rules.has('link-less')).toBe(true);
      expect(rules.has('spelling-drift')).toBe(true);
      expect(rules.has('fingerprint-mismatch')).toBe(true);
      // Provenance check skipped without a backend.
      expect(rules.has('provenance-skipped')).toBe(true);

      const dangling = findings.find((f) => f.rule === 'dangling-link' && f.page === 'hub');
      expect(dangling?.detail).toContain('ghost');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
