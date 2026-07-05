import { existsSync } from 'node:fs';
import type { WikiStore, WikiPage } from './store.ts';
import { pageFingerprint } from './store.ts';
import { parseWikilinks, normalizedEditDistance } from './links.ts';
import type { PendingUnit } from '../storage/backend.ts';

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
  // Provided by the command (backend-backed): (session, repo) units whose dream
  // knowledge no wiki compile has absorbed and the nightly loop hasn't healed.
  // Omitted ⇒ the rule is skipped silently (CLI offline mode still lints files).
  pendingUnits?: () => Promise<PendingUnit[]>;
  llm?: WikiLintLLM;
}

// The (session, repo) join row the pending-unit rule reasons over. The
// "dream fingerprint" wiki ingest short-circuits on is sha256(sorted dream chunk
// ids), so `dreamChunkIds` are compared against `wikiFingerprint` verbatim.
export interface PendingLedgerRow {
  sessionId: string;
  repo: string;
  dreamChunkIds: string[]; // dream_units.dream_chunk_ids (current dream knowledge)
  wikiFingerprint: string | null; // wiki_units.fingerprint, null if never compiled
  synthesizedAt: Date; // dream_units.synthesized_at
}

const PENDING_STALE_HOURS = 48;

// Pure decision for the pending-unit rule (unit-testable without pg). A unit is
// pending iff it holds dream knowledge (non-empty dream chunk set), that
// knowledge's fingerprint differs from what the wiki ledger recorded (or no wiki
// row exists), AND the dream stamp is older than staleHours — long enough that
// the nightly wiki compile should have absorbed it and hasn't.
//   fingerprint = sha256(sorted ids) — identical formula to pageFingerprint /
//   dream.fingerprintOf, which is exactly what ingestWiki compares to skip a unit.
export function pendingUnitsFrom(
  rows: PendingLedgerRow[],
  now: Date = new Date(),
  staleHours: number = PENDING_STALE_HOURS
): PendingUnit[] {
  const out: PendingUnit[] = [];
  for (const r of rows) {
    if (r.dreamChunkIds.length === 0) continue; // no knowledge to absorb
    const ageHours = (now.getTime() - r.synthesizedAt.getTime()) / 3_600_000;
    if (ageHours <= staleHours) continue; // fresh — the nightly loop still has time
    if (pageFingerprint(r.dreamChunkIds) === r.wikiFingerprint) continue; // wiki absorbed it
    out.push({ sessionId: r.sessionId, repo: r.repo, ageHours });
  }
  return out;
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
    // Dead artifact: a derived file reference whose path is gone on disk. A dead
    // path is actionable (the chip renders struck-through in the UI), so warn.
    for (const a of p.artifacts ?? []) {
      if (a.kind === 'file' && !existsSync(a.ref)) {
        findings.push({ severity: 'warn', rule: 'dead-artifact', page: p.slug, detail: `artifact path no longer exists: ${a.ref}` });
      }
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

  // Pending units: new dream knowledge no wiki compile has absorbed, un-healed
  // past the staleness window. System-level (page:''). Skipped silently offline.
  if (opts.pendingUnits) {
    try {
      for (const u of await opts.pendingUnits()) {
        const days = Math.floor(u.ageHours / 24);
        findings.push({
          severity: 'warn',
          rule: 'pending-unit',
          page: '',
          detail: `dream unit ${u.sessionId}${u.repo ? ` @ ${u.repo}` : ''} holds knowledge no wiki compile absorbed (dream ${days}d old)`,
        });
      }
    } catch (err) {
      findings.push({ severity: 'info', rule: 'pending-unit-skipped', page: '', detail: `db unreachable: ${err instanceof Error ? err.message : err}` });
    }
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
