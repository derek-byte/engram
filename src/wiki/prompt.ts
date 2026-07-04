import type { SynthesisUnit } from '../storage/backend.ts';
import type { WikiPage, PageKind } from './store.ts';
import { PAGE_KINDS } from './store.ts';

// Stable instruction prefix → OpenAI automatic prompt caching (spec §6). Odysseus-
// conservative: compile durable knowledge from dream items, never invent, reuse
// existing slugs, and always link related entities (value is in the edges).
export const WIKI_SYSTEM_PROMPT = `You are the compiler for a personal engineering knowledge wiki. You are given durable memory items extracted from ONE coding session (decisions, fixes, gotchas, preferences), the full text of the wiki pages most related to them, and a compact inventory of every existing page. You return the pages to create or update so the wiki absorbs this session's knowledge.

A page is one entity or topic: a project, a decision, a gotcha, a tool, a person, or a topic. Write pages as digestible, self-contained knowledge — NOT a transcript. Synthesize claims; do not paste logs.

STYLE: write the most concise human-readable form of the knowledge — dense encyclopedic paragraphs, every sentence load-bearing, no filler or restated context. Structure a page into short "## " sections when the content genuinely divides (e.g. Technical Design, Engineering Notes, Decisions, Gotchas — use only the sections the content earns; a short page is one untitled paragraph). Prefer flowing prose inside sections; use a bullet list only for genuinely enumerable items, never as the default texture.

Rules:
- Do NOT invent. Every claim must be supported by the provided items or the existing page you are updating. If nothing durable applies, return {"pages":[]}.
- REUSE existing slugs from the inventory. Never mint a near-duplicate (e.g. "pgvector" when "pg-vector" exists). Prefer updating an existing page over creating a new one.
- Every page MUST link the other entities it mentions using [[slug]] or [[slug|label]], reusing inventory slugs. A page with no links is a failure.
- Every [[link]] target must be a page that exists in the inventory or one you create in this same response. Recurring entities (the project itself, key tools, people) deserve their own hub page — create it rather than leaving links dangling.
- For an "update", return the FULL new body (you own the page). Preserve prior knowledge — merge, don't drop — EXCEPT when a claim is superseded: then replace it and keep only the one-line evolution record (see RECENCY below).
- RECENCY / SUPERSESSION: the session date is in the user message. When this session's item supersedes or contradicts a claim already on the page, REPLACE the old claim with the new one and record the change in ONE line: \`Originally X (YYYY-MM); revised to Y (YYYY-MM)\`. NEVER present two mutually exclusive decisions as co-equal current facts. If the page's existing claim is dated LATER than this session, keep the page's claim as current and treat this session's version as the "Originally" arm — never regress a newer dated claim.
- CROSS-PROJECT ATTRIBUTION: items may mention files, code, or facts from OTHER repos or reference projects (examples the session merely read). Attribute every claim to the entity it is actually about — never place another project's facts in this page's body as if they were this subject's. If the other project is durable knowledge, give it its own page (kind: project or topic) and [[link]] it.
- kind ∈ {${PAGE_KINDS.join(', ')}} — these are PAGE kinds; item kinds like "fix" or "preference" are not valid page kinds. slug matches ^[a-z0-9-]{1,64}$. summary is one line.
- "sources" is the subset of the provided item ids that support the page. NEVER put item ids in the body — no inline citations, no [[<item id>]] links. Wikilinks are for entity pages only.

Respond with STRICT JSON only:
{"pages":[{"slug":"...","action":"create|update","kind":"decision","title":"...","summary":"...","aliases":["..."],"body":"markdown with [[links]]","sources":["<item id>"]}]}
Return {"pages":[]} when nothing durable qualifies.`;

// Own stable prefix for the split command (do NOT fold into WIKI_SYSTEM_PROMPT —
// keeping each system prompt byte-stable preserves OpenAI prompt caching).
export const WIKI_SPLIT_SYSTEM_PROMPT = `You are the compiler for a personal engineering knowledge wiki. You are given ONE oversized page and the inventory of every existing page. Split it into a short hub INDEX plus focused child pages, so the graph stays digestible.

Return the pages to write. Rules:
- Emit EXACTLY ONE op with action:"update" whose slug is the hub's slug (given below). Its body is a SHORT INDEX: for each child, a "## <section>" heading, a "[[child-slug]]" link, and a 2–3 sentence overview. No raw content dumps — the detail lives in the children.
- Every OTHER op is action:"create" with a NEW slug that does NOT appear in the inventory. Children carve the hub's content into coherent entity/topic pages, preserving ALL claims and their evolution lines ("Originally X …; revised to Y …") verbatim — never drop knowledge in a split.
- Reuse inventory slugs in [[links]]. Children should [[link]] each other and the hub where relevant. Value is in the edges.
- "sources" on each child = the subset of the hub's source ids that support that child, where determinable; omit "sources" if you cannot attribute them.
- kind ∈ {${PAGE_KINDS.join(', ')}}. slug matches ^[a-z0-9-]{1,64}$. summary is one line.
- NEVER put item/source ids in the body — no inline citations. Wikilinks are for entity pages only.

Respond with STRICT JSON only:
{"pages":[{"slug":"...","action":"create|update","kind":"topic","title":"...","summary":"...","aliases":["..."],"body":"markdown with [[links]]","sources":["<id>"]}]}`;

export function buildSplitUser(page: WikiPage, inventory: string): string {
  return [
    `HUB PAGE TO SPLIT — slug: ${page.slug} · kind: ${page.kind} · title: ${page.title}`,
    `summary: ${page.summary}`,
    `aliases: ${page.aliases.join(', ') || '(none)'}`,
    `available source ids (attribute children from this set): ${page.sources.join(', ') || '(none)'}`,
    '',
    'FULL CURRENT BODY:',
    page.body.trim(),
    '',
    'INVENTORY (all existing pages — reuse these slugs in links; child slugs must be NEW):',
    inventory,
  ].join('\n');
}

export function buildUnitHeader(unit: SynthesisUnit): string {
  const repo = unit.repo || '(no repo)';
  const date = isoDate(unit.lastTimestamp);
  return (
    `SESSION ${unit.sessionId} · repo ${repo} · ${unit.chunkIds.length} dream items · session date ${date}\n` +
    `This session is from ${date}. Existing pages may contain knowledge from other dates — reconcile by recency, never regress newer dated claims.`
  );
}

// YYYY-MM-DD from a (possibly invalid) Date, tolerant of bad timestamps.
function isoDate(d: Date): string {
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 10);
}

export interface DreamItemInput {
  id: string;
  kind: string; // dream_type
  text: string;
}

export function buildItemsText(items: DreamItemInput[]): string {
  return items.map((it) => `- [${it.id}] (${it.kind}) ${it.text}`).join('\n');
}

export function buildCandidatesText(pages: WikiPage[], maxChars: number): string {
  if (pages.length === 0) return '(no related pages yet)';
  const blocks: string[] = [];
  let used = 0;
  for (const p of pages) {
    const updated = p.updated ? p.updated.slice(0, 10) : '(unknown)';
    const block = `### [[${p.slug}]] (kind: ${p.kind})\ntitle: ${p.title}\naliases: ${p.aliases.join(', ') || '(none)'}\nupdated: ${updated}\n\n${p.body.trim()}`;
    if (used + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n\n---\n\n');
}

export function buildIngestUser(
  header: string,
  itemsText: string,
  candidatesText: string,
  inventory: string
): string {
  return [
    header,
    '',
    'DREAM ITEMS (id in brackets):',
    itemsText,
    '',
    'RELATED PAGES (full current text — update these in place where relevant):',
    candidatesText,
    '',
    'INVENTORY (all existing pages — reuse these slugs):',
    inventory,
  ].join('\n');
}

export type { PageKind };
