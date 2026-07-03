// Slug + wikilink utilities. Links live only in page bodies as [[slug]] or
// [[slug|label]]; the link graph is derived on demand by scanning the wiki dir —
// there is no persisted edge table.

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

// Normalize an arbitrary title/phrase into a kebab-case slug (a–z, 0–9, dashes),
// collapsing runs of separators and trimming to 64 chars.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

// Strip fenced code blocks (``` ... ```) so a [[...]] inside a code sample is not
// parsed as a real wikilink.
function stripFences(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

// Parse the distinct link targets (slugs) referenced by a page body. Accepts
// [[slug]] and [[slug|label]]; the target is normalized through slugify so
// [[Fingerprint Skip]] resolves to `fingerprint-skip`.
export function parseWikilinks(body: string): string[] {
  const out = new Set<string>();
  const text = stripFences(body);
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1]!.trim();
    const slug = isValidSlug(raw) ? raw : slugify(raw);
    if (slug) out.add(slug);
  }
  return [...out];
}

// Chunk ids are sha256 hex — a [[<hex id>]] in a body is an inline provenance
// citation the LLM sometimes emits despite instructions, not a real wikilink.
const HEX_ID_RE = /^[0-9a-f]{40,64}$/;

// Strip inline id citations from a page body: [[<hex id>]] is removed (with any
// immediately preceding space), [[<hex id>|label]] keeps just the label.
// Provenance belongs in frontmatter `sources`, not in the link graph.
export function stripIdCitations(body: string): string {
  return body
    .replace(/\[\[([0-9a-f]{40,64})\|([^\]]*)\]\]/g, '$2')
    .replace(/ ?\[\[[0-9a-f]{40,64}\]\]/g, '');
}

export function isHexId(s: string): boolean {
  return HEX_ID_RE.test(s);
}

export interface LinkNode {
  slug: string;
  aliases: string[];
  outbound: string[];
}

export interface LinkGraph {
  // slug → resolved outbound target slugs (alias targets resolved to canonical slug)
  outbound: Map<string, string[]>;
  // slug → inbound source slugs
  inbound: Map<string, string[]>;
  // link target (slug or alias) → canonical slug
  resolve: Map<string, string>;
  // outbound targets that resolve to no known page
  dangling: Map<string, string[]>;
}

// Build the link graph from a set of pages, resolving aliases to canonical slugs.
export function buildLinkGraph(nodes: LinkNode[]): LinkGraph {
  const resolve = new Map<string, string>();
  for (const n of nodes) {
    resolve.set(n.slug, n.slug);
    for (const a of n.aliases) {
      const s = isValidSlug(a) ? a : slugify(a);
      if (s && !resolve.has(s)) resolve.set(s, n.slug);
    }
  }

  const outbound = new Map<string, string[]>();
  const inbound = new Map<string, string[]>();
  const dangling = new Map<string, string[]>();
  for (const n of nodes) {
    inbound.set(n.slug, inbound.get(n.slug) ?? []);
  }

  for (const n of nodes) {
    const resolved: string[] = [];
    const bad: string[] = [];
    for (const target of n.outbound) {
      const canon = resolve.get(target);
      if (canon && canon !== n.slug) {
        resolved.push(canon);
        inbound.get(canon)!.push(n.slug);
      } else if (!canon) {
        bad.push(target);
      }
    }
    outbound.set(n.slug, [...new Set(resolved)]);
    if (bad.length) dangling.set(n.slug, [...new Set(bad)]);
  }

  return { outbound, inbound, resolve, dangling };
}

// Normalized Levenshtein distance in [0,1]; used by lint's spelling-drift check.
export function normalizedEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  const dist = levenshtein(a, b);
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : dist / max;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

// ---------------------------------------------------------------------------
// Deterministic auto-linking
// ---------------------------------------------------------------------------

export interface LinkTarget {
  slug: string;
  title: string;
  aliases: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Byte ranges [start,end) whose text must NOT be auto-linked: fenced code blocks,
// inline code spans, existing wikilinks, and markdown links (label + URL). Unlike
// stripFences we mask (not delete) so offsets survive for splicing. Ranges may
// overlap harmlessly — a candidate is disqualified if it touches ANY of them.
function protectedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const patterns = [
    /```[\s\S]*?```/g, // fenced ```
    /~~~[\s\S]*?~~~/g, // fenced ~~~
    /`[^`]*`/g, // inline code span
    /\[\[[^\]]*\]\]/g, // existing wikilink
    /\[[^\]]*\]\([^)]*\)/g, // markdown link
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return ranges;
}

// Auto-wrap the FIRST unlinked, word-bounded, code-free mention of each target
// page's title/alias in [[slug|matched]] (or bare [[slug]] when the matched text
// equals the slug exactly). Guarantees edges regardless of LLM compliance.
// Pure + deterministic: longest needle wins at a shared offset, claimed ranges
// accumulate, ambiguous aliases (mapping to >1 slug) link nothing, a page already
// linked anywhere in the body is left alone ("first mention" = first UNLINKED page).
export function autolinkBody(
  body: string,
  targets: LinkTarget[],
  selfSlug?: string
): { body: string; added: string[] } {
  if (!body || targets.length === 0) return { body, added: [] };

  // Alias → canonical slug resolution (mirrors buildLinkGraph).
  const resolve = new Map<string, string>();
  for (const t of targets) {
    resolve.set(t.slug, t.slug);
    for (const a of t.aliases) {
      const s = isValidSlug(a) ? a : slugify(a);
      if (s && !resolve.has(s)) resolve.set(s, t.slug);
    }
  }

  // Pages already linked anywhere in the body get no auto-link.
  const alreadyLinked = new Set<string>();
  for (const raw of parseWikilinks(body)) alreadyLinked.add(resolve.get(raw) ?? raw);

  // Needle (lowercased phrase) → slug; a needle resolving to two slugs is dropped.
  const needleToSlug = new Map<string, string | null>();
  for (const t of targets) {
    if (t.slug === selfSlug) continue;
    if (alreadyLinked.has(t.slug)) continue;
    for (const phrase of [t.title, ...t.aliases]) {
      const n = phrase.trim().toLowerCase();
      if (n.length < 3) continue;
      if (needleToSlug.has(n)) {
        if (needleToSlug.get(n) !== t.slug) needleToSlug.set(n, null); // ambiguous
      } else {
        needleToSlug.set(n, t.slug);
      }
    }
  }

  const needles = [...needleToSlug.entries()]
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([needle, slug]) => ({ needle, slug }))
    // Longest first (ties alphabetical) so "fingerprint short-circuit" beats
    // "fingerprint" at a shared offset; deterministic across runs.
    .sort((a, b) => b.needle.length - a.needle.length || a.needle.localeCompare(b.needle));

  const protectedR = protectedRanges(body);
  const claimed: Array<[number, number]> = [];
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
  const overlaps = (s: number, e: number, ranges: Array<[number, number]>): boolean =>
    ranges.some(([rs, re]) => s < re && rs < e);

  interface Repl {
    start: number;
    end: number;
    text: string;
    slug: string;
  }
  const repls: Repl[] = [];
  const done = new Set<string>();

  for (const { needle, slug } of needles) {
    if (done.has(slug)) continue;
    const re = new RegExp(escapeRegex(needle), 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      // Explicit [A-Za-z0-9_] boundary (not \b, so "pg" never matches inside
      // "pgvector" and "_" is treated as a word char / non-boundary).
      if (isWordChar(body[s - 1]) || isWordChar(body[e])) continue;
      if (overlaps(s, e, protectedR)) continue;
      if (overlaps(s, e, claimed)) continue;
      const matched = m[0];
      const text = matched === slug ? `[[${slug}]]` : `[[${slug}|${matched}]]`;
      repls.push({ start: s, end: e, text, slug });
      claimed.push([s, e]);
      done.add(slug);
      break;
    }
  }

  if (repls.length === 0) return { body, added: [] };
  // Apply back-to-front so earlier offsets stay valid.
  repls.sort((a, b) => b.start - a.start);
  let out = body;
  for (const r of repls) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  // Report in document order for stable logging.
  const added = [...repls].sort((a, b) => a.start - b.start).map((r) => r.slug);
  return { body: out, added };
}
