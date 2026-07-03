import type { SynthesisUnit } from '../storage/backend.ts';
import type { WikiPage, PageKind } from './store.ts';
import { PAGE_KINDS } from './store.ts';

// Stable instruction prefix → OpenAI automatic prompt caching (spec §6). Odysseus-
// conservative: compile durable knowledge from dream items, never invent, reuse
// existing slugs, and always link related entities (value is in the edges).
export const WIKI_SYSTEM_PROMPT = `You are the compiler for a personal engineering knowledge wiki. You are given durable memory items extracted from ONE coding session (decisions, fixes, gotchas, preferences), the full text of the wiki pages most related to them, and a compact inventory of every existing page. You return the pages to create or update so the wiki absorbs this session's knowledge.

A page is one entity or topic: a project, a decision, a gotcha, a tool, a person, or a topic. Write pages as digestible, self-contained knowledge — NOT a transcript. Synthesize claims; do not paste logs.

Rules:
- Do NOT invent. Every claim must be supported by the provided items or the existing page you are updating. If nothing durable applies, return {"pages":[]}.
- REUSE existing slugs from the inventory. Never mint a near-duplicate (e.g. "pgvector" when "pg-vector" exists). Prefer updating an existing page over creating a new one.
- Every page MUST link the other entities it mentions using [[slug]] or [[slug|label]], reusing inventory slugs. A page with no links is a failure.
- Every [[link]] target must be a page that exists in the inventory or one you create in this same response. Recurring entities (the project itself, key tools, people) deserve their own hub page — create it rather than leaving links dangling.
- For an "update", return the FULL new body (you own the page). Preserve prior knowledge — merge, don't drop. Do not delete pages.
- kind ∈ {${PAGE_KINDS.join(', ')}} — these are PAGE kinds; item kinds like "fix" or "preference" are not valid page kinds. slug matches ^[a-z0-9-]{1,64}$. summary is one line.
- "sources" is the subset of the provided item ids that support the page. NEVER put item ids in the body — no inline citations, no [[<item id>]] links. Wikilinks are for entity pages only.

Respond with STRICT JSON only:
{"pages":[{"slug":"...","action":"create|update","kind":"decision","title":"...","summary":"...","aliases":["..."],"body":"markdown with [[links]]","sources":["<item id>"]}]}
Return {"pages":[]} when nothing durable qualifies.`;

export function buildUnitHeader(unit: SynthesisUnit): string {
  const repo = unit.repo || '(no repo)';
  return `SESSION ${unit.sessionId} · repo ${repo} · ${unit.chunkIds.length} dream items`;
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
    const block = `### [[${p.slug}]] (kind: ${p.kind})\ntitle: ${p.title}\naliases: ${p.aliases.join(', ') || '(none)'}\n\n${p.body.trim()}`;
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
