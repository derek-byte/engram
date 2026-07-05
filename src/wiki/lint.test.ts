import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiStore, pageFingerprint, type WikiPage } from './store.ts';
import { lintWiki, pendingUnitsFrom, type PendingLedgerRow } from './lint.ts';

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

  test('dead-artifact fires for a missing file path, silent for an existing one', async () => {
    const dir = join(tmpdir(), `engram-wiki-lint-dead-${crypto.randomUUID()}`);
    const store = new WikiStore(dir);
    const alive = join(tmpdir(), `engram-lint-alive-${crypto.randomUUID()}.txt`);
    const gone = join(tmpdir(), `engram-lint-gone-${crypto.randomUUID()}.txt`); // never created
    writeFileSync(alive, 'x');
    try {
      store.init();
      store.writePage(
        page({
          slug: 'has-dead',
          body: 'links [[has-alive]] '.repeat(20),
          artifacts: [
            { kind: 'file', ref: gone, tool: 'Write' },
            { kind: 'url', ref: 'https://example.com/x', tool: 'Bash' }, // url is never dead-artifact
          ],
        })
      );
      store.writePage(
        page({ slug: 'has-alive', body: 'links [[has-dead]] '.repeat(20), artifacts: [{ kind: 'file', ref: alive, tool: 'Write' }] })
      );
      const findings = await lintWiki(store);
      const dead = findings.filter((f) => f.rule === 'dead-artifact');
      expect(dead.length).toBe(1);
      expect(dead[0]!.page).toBe('has-dead');
      expect(dead[0]!.severity).toBe('warn');
      expect(dead[0]!.detail).toContain(gone);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(alive, { force: true });
    }
  });

  test('pending-unit surfaces injected units as system-level warns; skipped without a backend', async () => {
    const dir = join(tmpdir(), `engram-wiki-lint-pending-${crypto.randomUUID()}`);
    const store = new WikiStore(dir);
    try {
      store.init();
      store.writePage(page({ slug: 'a', body: 'links [[b]] '.repeat(20) }));
      const findings = await lintWiki(store, {
        pendingUnits: async () => [{ sessionId: 'sess-x', repo: 'engram', ageHours: 72 }],
      });
      const pu = findings.find((f) => f.rule === 'pending-unit');
      expect(pu).toBeDefined();
      expect(pu!.severity).toBe('warn');
      expect(pu!.page).toBe(''); // system-level, no page
      expect(pu!.detail).toContain('sess-x');

      // No closure ⇒ the rule is skipped silently (offline CLI still lints files).
      const offline = await lintWiki(store);
      expect(offline.some((f) => f.rule === 'pending-unit')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags an oversized page and names the split command', async () => {
    const dir = join(tmpdir(), `engram-wiki-lint-oversized-${crypto.randomUUID()}`);
    const store = new WikiStore(dir);
    try {
      store.init();
      store.writePage(page({ slug: 'fat-hub', title: 'Fat Hub', body: 'x'.repeat(8100) }));
      const findings = await lintWiki(store);
      const oversized = findings.find((f) => f.rule === 'oversized' && f.page === 'fat-hub');
      expect(oversized?.severity).toBe('warn');
      expect(oversized?.detail).toContain('engram wiki split fat-hub');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pendingUnitsFrom', () => {
  const now = new Date('2026-07-04T00:00:00.000Z');
  const stale = new Date(now.getTime() - 72 * 3_600_000); // 72h old (> 48h window)
  const fresh = new Date(now.getTime() - 12 * 3_600_000); // 12h old (< 48h window)
  const ids = ['d1', 'd2'];
  const inSync = pageFingerprint(ids); // what a caught-up wiki_units row records

  const row = (over: Partial<PendingLedgerRow>): PendingLedgerRow => ({
    sessionId: 's',
    repo: 'engram',
    dreamChunkIds: ids,
    wikiFingerprint: 'stale-fp',
    synthesizedAt: stale,
    ...over,
  });

  test('fires on a stale mismatch (>48h old, fingerprints differ)', () => {
    expect(pendingUnitsFrom([row({})], now).map((u) => u.sessionId)).toEqual(['s']);
  });

  test('fires when the unit was never compiled (wikiFingerprint null) and stale', () => {
    expect(pendingUnitsFrom([row({ wikiFingerprint: null })], now).length).toBe(1);
  });

  test('silent when the wiki fingerprint matches the current dream knowledge', () => {
    expect(pendingUnitsFrom([row({ wikiFingerprint: inSync })], now)).toEqual([]);
  });

  test('silent when the dream stamp is fresh (<48h), even on a mismatch', () => {
    expect(pendingUnitsFrom([row({ synthesizedAt: fresh })], now)).toEqual([]);
  });

  test('silent for an empty dream unit — no knowledge to absorb', () => {
    expect(pendingUnitsFrom([row({ dreamChunkIds: [], wikiFingerprint: null })], now)).toEqual([]);
  });

  test('fingerprint is order-invariant (sorted before hashing)', () => {
    expect(pendingUnitsFrom([row({ dreamChunkIds: ['d2', 'd1'], wikiFingerprint: inSync })], now)).toEqual([]);
  });
});
