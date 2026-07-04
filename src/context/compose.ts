import { CHARS_PER_TOKEN } from '../ingest/chunker.ts';
import type { ContextStore } from '../storage/backend.ts';
import type { WikiStore } from '../wiki/store.ts';

// Dream types that count as durable memory for the context block. Named so the
// list is trivially widenable (spec: 'fix' and 'preference' are excluded).
export const MEMORY_TYPES = ['decision', 'gotcha'] as const;
const MEMORY_WINDOW_DAYS = 30;
const MAX_PAGES = 6;
const MAX_MEMORIES = 10;
// Arm 1/2 pull more candidates than the hard cap so budget trimming has room.
const CANDIDATE_PAGES = 8;
const CANDIDATE_MEMORIES = 12;
const PAGES_BUDGET_FRACTION = 0.4;
const EXCERPT_CAP = 200;

export interface PageItem {
  slug: string;
  title: string;
  summary: string;
  updated?: string;
  source: 'provenance' | 'mention';
}

export interface MemoryItem {
  type: string;
  timestamp: Date;
  text: string;
}

export interface ContextResult {
  repo: string;
  branch?: string;
  pages: PageItem[];
  memories: MemoryItem[];
  markdown: string;
  estTokens: number;
}

export interface BuildContextParams {
  repo: string;
  branch?: string;
  owner: string;
  budgetTokens: number;
  now?: Date;
}

export interface BuildContextDeps {
  backend: ContextStore;
  store: WikiStore | null;
}

export function estTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export async function buildContext(params: BuildContextParams, deps: BuildContextDeps): Promise<ContextResult> {
  const { repo, branch, owner, budgetTokens } = params;
  const now = params.now ?? new Date();
  const { backend, store } = deps;

  // --- Retrieval (three arms, owner-scoped, no LLM / no embeddings) ---------
  // Arm 1 (provenance) + arm 3 (recent memories) establish whether engram knows
  // this repo at all. Arm 2 (keyword mentions) only *supplements* a known repo:
  // tokenizing a repo name yields generic words ("repo", "app") that would match
  // unrelated pages, so we suppress it for an unknown repo to keep silent-empty
  // structural — an unknown repo produces zero candidates and prints nothing.
  const provenance = await backend.wikiPagesForRepo(owner, repo, CANDIDATE_PAGES);
  const dreams = await backend.recentDreamChunks(
    owner,
    repo,
    new Date(now.getTime() - MEMORY_WINDOW_DAYS * 86_400_000),
    [...MEMORY_TYPES],
    CANDIDATE_MEMORIES
  );

  const known = provenance.length > 0 || dreams.length > 0;
  const seen = new Set(provenance.map((p) => p.slug));
  const query = buildKeywordQuery(repo, branch);
  const mentions =
    known && query
      ? (await backend.keywordSearchChunks(owner, 'wiki', query, CANDIDATE_PAGES)).filter((m) => {
          const slug = slugOf(m.trajectoryId);
          if (!slug || seen.has(slug)) return false;
          seen.add(slug);
          return true;
        })
      : [];

  // --- Hydration ------------------------------------------------------------
  const pageCandidates: PageItem[] = [];
  for (const p of provenance) pageCandidates.push(hydratePage(p.slug, p.excerpt, 'provenance', store));
  for (const m of mentions) pageCandidates.push(hydratePage(slugOf(m.trajectoryId)!, m.content, 'mention', store));

  const memoryCandidates: MemoryItem[] = dreams.map((c) => ({
    type: c.metadata.dreamType ?? 'note',
    timestamp: c.metadata.timestamp,
    text: collapse(c.content),
  }));

  // --- Budget fill (whole items only) ---------------------------------------
  const { pages, memories } = fillBudget(pageCandidates, memoryCandidates, budgetTokens, repo, branch, now, query || repo);

  if (pages.length === 0 && memories.length === 0) {
    return { repo, branch, pages, memories, markdown: '', estTokens: 0 };
  }

  const markdown = render(repo, branch, pages, memories, now, query || repo);
  return { repo, branch, pages, memories, markdown, estTokens: estTokens(markdown) };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

function fillBudget(
  pageCandidates: PageItem[],
  memoryCandidates: MemoryItem[],
  budget: number,
  repo: string,
  branch: string | undefined,
  now: Date,
  query: string
): { pages: PageItem[]; memories: MemoryItem[] } {
  const caps = { pages: pageCandidates.slice(0, MAX_PAGES), memories: memoryCandidates.slice(0, MAX_MEMORIES) };

  // Reserve the deterministic scaffold: header + footer, plus each section
  // header when that arm has any candidate. Footer sized with candidate counts
  // (an upper bound) so the rendered footer, with actual counts, always fits.
  const header = renderHeader(repo, branch);
  const footer = renderFooter(caps.pages.length, caps.memories.length, query, repo);
  let reserve = estTokens(header) + estTokens(footer);
  if (caps.pages.length > 0) reserve += estTokens(WIKI_HEADER);
  if (caps.memories.length > 0) reserve += estTokens(MEMORY_HEADER);

  const remaining = Math.max(0, budget - reserve);
  const pageBudget = Math.floor(remaining * PAGES_BUDGET_FRACTION);

  const pages: PageItem[] = [];
  const memories: MemoryItem[] = [];
  let used = 0;

  // Pass 1: pages up to the page fraction (at least the top page if any exists).
  for (const p of caps.pages) {
    const cost = estTokens(renderPageLine(p));
    const first = pages.length === 0;
    const cap = first ? remaining : pageBudget;
    if (used + cost <= cap) {
      pages.push(p);
      used += cost;
    } else if (!first) {
      break;
    }
  }

  // Pass 2: memories into whatever remains.
  for (const m of caps.memories) {
    const cost = estTokens(renderMemoryLine(m, now));
    if (used + cost <= remaining) {
      memories.push(m);
      used += cost;
    } else {
      break;
    }
  }

  // Pass 3: leftover budget resumes pages.
  for (const p of caps.pages) {
    if (pages.includes(p)) continue;
    const cost = estTokens(renderPageLine(p));
    if (used + cost <= remaining) {
      pages.push(p);
      used += cost;
    } else {
      break;
    }
  }

  // Never emit a bare header+footer: if nothing fit but candidates exist, force
  // the single best item (budget floor of 100 easily covers one line).
  if (pages.length === 0 && memories.length === 0) {
    if (caps.pages.length > 0) pages.push(caps.pages[0]!);
    else if (caps.memories.length > 0) memories.push(caps.memories[0]!);
  }

  return { pages, memories };
}

// ---------------------------------------------------------------------------
// Rendering (deterministic)
// ---------------------------------------------------------------------------

const WIKI_HEADER = '**Wiki**';
const MEMORY_HEADER = `**Recent decisions & gotchas (${MEMORY_WINDOW_DAYS}d)**`;

function render(
  repo: string,
  branch: string | undefined,
  pages: PageItem[],
  memories: MemoryItem[],
  now: Date,
  query: string
): string {
  const blocks: string[] = [renderHeader(repo, branch)];
  if (pages.length > 0) {
    blocks.push([WIKI_HEADER, ...pages.map(renderPageLine)].join('\n'));
  }
  if (memories.length > 0) {
    blocks.push([MEMORY_HEADER, ...memories.map((m) => renderMemoryLine(m, now))].join('\n'));
  }
  blocks.push(renderFooter(pages.length, memories.length, query, repo));
  return blocks.join('\n\n') + '\n';
}

function renderHeader(repo: string, branch: string | undefined): string {
  return `## Prior context from engram — ${repo}${branch ? `@${branch}` : ''}`;
}

function renderPageLine(p: PageItem): string {
  const summary = p.summary || p.title;
  const updated = p.updated ? ` (updated ${p.updated.slice(0, 10)})` : '';
  return `- ${p.slug} — ${summary}${updated}`;
}

function renderMemoryLine(m: MemoryItem, now: Date): string {
  return `- ${m.type} (${ageLabel(now, m.timestamp)}): ${m.text}`;
}

function renderFooter(pages: number, memories: number, query: string, repo: string): string {
  const pLabel = `${pages} page${pages === 1 ? '' : 's'}`;
  const mLabel = `${memories} memor${memories === 1 ? 'y' : 'ies'}`;
  return `_from engram · ${pLabel}, ${mLabel} · \`engram search "${query}" --repo ${repo}\` to dig deeper_`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hydratePage(slug: string, excerpt: string, source: PageItem['source'], store: WikiStore | null): PageItem {
  if (store) {
    try {
      const page = store.readPage(slug);
      if (page) {
        // collapse(): frontmatter allows block scalars, and a multi-line summary
        // would break the one-line-per-item block (and could inject structure).
        return {
          slug,
          title: collapse(page.title) || slug,
          summary: collapse(page.summary),
          updated: page.updated || undefined,
          source,
        };
      }
    } catch {
      // malformed frontmatter → fall through to excerpt
    }
  }
  return { slug, title: slug, summary: firstSentence(excerpt, EXCERPT_CAP), source };
}

function slugOf(trajectoryId: string | null): string | null {
  if (!trajectoryId) return null;
  return trajectoryId.replace(/^wiki:/, '');
}

// Build a websearch_to_tsquery OR of sanitized repo + branch tokens. Tokens are
// lowercased and stripped to [a-z0-9]; branch paths split on separators so
// `feature/context-injection` contributes context, injection. A token-less
// input yields '' (caller skips the arm — an empty tsquery matches nothing).
function buildKeywordQuery(repo: string, branch?: string): string {
  const tokens = new Set<string>();
  for (const t of tokenize(repo)) tokens.add(t);
  if (branch) for (const t of tokenize(branch)) tokens.add(t);
  return [...tokens].join(' OR ');
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function firstSentence(s: string, cap: number): string {
  const clean = collapse(s);
  const dot = clean.search(/[.!?](\s|$)/);
  const sentence = dot >= 0 ? clean.slice(0, dot + 1) : clean;
  return sentence.length > cap ? sentence.slice(0, cap).trimEnd() + '…' : sentence;
}

function ageLabel(now: Date, ts: Date): string {
  const days = Math.floor((now.getTime() - ts.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  return `${days}d ago`;
}
