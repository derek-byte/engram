import type { WikiStore, WikiPage } from './store.ts';
import { pageFingerprint } from './store.ts';
import { parseWikilinks, normalizedEditDistance } from './links.ts';

export interface Finding {
  severity: 'warn' | 'info';
  rule: string;
  page: string;
  detail: string;
}

const STUB_CHARS = 120;
const OVERSIZED_CHARS = 8000; // a hub this large demonstrably degraded compile quality → warn
const DRIFT_THRESHOLD = 0.25; // normalized edit distance ≤ this ⇒ possible duplicate
const DRIFT_MIN_LEN = 4;

// Optional contradiction/low-confidence pass over page texts.
export interface WikiLintLLM {
  review(pagesText: string): Promise<Finding[]>;
}

export interface LintOptions {
  // Provided by the command: returns the subset of the given ids that exist as
  // tier='dream' chunks in pg. Omitted ⇒ provenance check is skipped with a note.
  checkProvenance?: (ids: string[]) => Promise<Set<string>>;
  llm?: WikiLintLLM;
}

// Deterministic wiki lint: findings are information, never auto-fixed (exit 0).
export async function lintWiki(store: WikiStore, opts: LintOptions = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const pages: WikiPage[] = [];

  for (const slug of store.listSlugs()) {
    try {
      const p = store.readPage(slug);
      if (p) pages.push(p);
    } catch (err) {
      findings.push({
        severity: 'warn',
        rule: 'malformed-frontmatter',
        page: slug,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const graph = store.linkGraph(pages);

  for (const p of pages) {
    const outbound = parseWikilinks(p.body);
    if ((graph.inbound.get(p.slug)?.length ?? 0) === 0) {
      findings.push({ severity: 'warn', rule: 'orphan', page: p.slug, detail: 'no other page links to this page' });
    }
    if (outbound.length === 0) {
      findings.push({ severity: 'warn', rule: 'link-less', page: p.slug, detail: 'page has no outbound [[links]] — value is in the edges' });
    }
    const dangling = graph.dangling.get(p.slug);
    if (dangling && dangling.length) {
      findings.push({ severity: 'warn', rule: 'dangling-link', page: p.slug, detail: `links to unknown page(s): ${dangling.join(', ')}` });
    }
    if (p.body.trim().length < STUB_CHARS) {
      findings.push({ severity: 'info', rule: 'stub', page: p.slug, detail: `body is only ${p.body.trim().length} chars` });
    }
    if (p.body.length > OVERSIZED_CHARS) {
      findings.push({
        severity: 'warn',
        rule: 'oversized',
        page: p.slug,
        detail: `body is ${p.body.length} chars (> ${OVERSIZED_CHARS}) — consider engram wiki split ${p.slug}`,
      });
    }
    if (p.fingerprint && p.fingerprint !== pageFingerprint(p.sources)) {
      findings.push({ severity: 'warn', rule: 'fingerprint-mismatch', page: p.slug, detail: 'frontmatter fingerprint ≠ sha256(sorted sources)' });
    }
  }

  // Spelling drift: near-duplicate slugs or overlapping aliases.
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i]!;
      const b = pages[j]!;
      const closeSlug =
        a.slug.length >= DRIFT_MIN_LEN &&
        b.slug.length >= DRIFT_MIN_LEN &&
        normalizedEditDistance(a.slug, b.slug) <= DRIFT_THRESHOLD;
      const sharedAlias = a.aliases.some((x) => b.aliases.includes(x) || b.slug === x) || b.aliases.some((x) => a.slug === x);
      if (closeSlug || sharedAlias) {
        findings.push({
          severity: 'info',
          rule: 'spelling-drift',
          page: a.slug,
          detail: `looks like a near-duplicate of ${b.slug}${sharedAlias ? ' (overlapping aliases)' : ''}`,
        });
      }
    }
  }

  // Provenance: frontmatter sources must exist as tier='dream' chunks.
  if (opts.checkProvenance) {
    const allSources = [...new Set(pages.flatMap((p) => p.sources))];
    if (allSources.length > 0) {
      try {
        const present = await opts.checkProvenance(allSources);
        for (const p of pages) {
          const missing = p.sources.filter((s) => !present.has(s));
          if (missing.length) {
            findings.push({
              severity: 'warn',
              rule: 'broken-provenance',
              page: p.slug,
              detail: `${missing.length} source id(s) absent from dream chunks`,
            });
          }
        }
      } catch (err) {
        findings.push({ severity: 'info', rule: 'provenance-skipped', page: '', detail: `db unreachable: ${err instanceof Error ? err.message : err}` });
      }
    }
  } else {
    findings.push({ severity: 'info', rule: 'provenance-skipped', page: '', detail: 'no backend provided; provenance check skipped' });
  }

  if (opts.llm && pages.length > 0) {
    try {
      const text = pages.map((p) => `### [[${p.slug}]]\n${p.body.trim()}`).join('\n\n---\n\n');
      findings.push(...(await opts.llm.review(text)));
    } catch (err) {
      findings.push({ severity: 'info', rule: 'llm-pass-failed', page: '', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  const order = { warn: 0, info: 1 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule) || a.page.localeCompare(b.page));
  return findings;
}
