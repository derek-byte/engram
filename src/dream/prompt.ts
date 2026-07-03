import type { Chunk } from '../types/index.ts';
import type { SynthesisUnit } from '../storage/backend.ts';

// Odysseus-conservative extraction: pull ONLY what is actually stated in the
// transcript. Empty output is a valid, expected result — it must never invent.
export const SYSTEM_PROMPT = `You extract durable memory from a Claude Code coding session transcript.

Extract ONLY items that are ACTUALLY PRESENT in the transcript, of these kinds:
- decision: a choice that was made and why (architecture, approach, tradeoff).
- fix: a concrete bug/problem and how it was resolved.
- gotcha: a non-obvious constraint, footgun, or surprising behavior discovered.
- preference: a stated preference about how work should be done.

Rules:
- Do NOT invent, infer, or generalize. If it is not stated, do not extract it.
- Each item is 1-3 self-contained sentences. Name the repo, files, tools, or symbols involved so the item stands alone out of context.
- Prefer specific, load-bearing facts over vague summaries. Skip small talk, restated questions, and incomplete/abandoned threads.
- If nothing durable qualifies, return an empty list. An empty result is correct and expected.

Respond with STRICT JSON only, matching:
{"items":[{"type":"decision|fix|gotcha|preference","text":"..."}]}
"type" MUST be exactly one of decision, fix, gotcha, preference — never any other value.
Return {"items":[]} when nothing qualifies.`;

export function buildUnitHeader(unit: SynthesisUnit): string {
  const repo = unit.repo || '(no repo)';
  return `Session ${unit.sessionId} · repo ${repo} · ${unit.chunkIds.length} chunks`;
}

// Join chunk contents into one transcript, head-truncating (keeping the start)
// at maxChars so the LLM sees the opening context; a marker flags truncation.
export function buildTranscript(chunks: Chunk[], maxChars: number): string {
  const joined = chunks.map((c) => c.content).join('\n---\n');
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars) + '\n[transcript truncated]';
}
