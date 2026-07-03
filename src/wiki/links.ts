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
