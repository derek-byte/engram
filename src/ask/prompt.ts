import type { SearchResult } from '../types/index.ts';

// Dream-prompt lineage: answer ONLY from the numbered material, cite every
// claim, and say plainly when the material doesn't cover the question. Unlike
// rerank/dream this is PLAIN TEXT — the answer IS the prose, no JSON envelope,
// which removes the malformed-parse failure mode entirely.
export const ASK_SYSTEM_PROMPT = `You answer questions using ONLY the provided numbered material from the user's coding-session memory (wiki pages, synthesized dream notes, raw session excerpts).

Rules:
- Use ONLY the material below. No outside knowledge, no inference beyond what is stated.
- Cite EVERY claim with [n] markers referencing the numbered material (multiple markers like [1][4] are fine when a claim draws on several).
- If the material does not answer the question, say so plainly in one or two sentences and cite nothing. Do NOT guess or fill gaps.
- If it answers only partially, give the partial answer and state what is missing.
- Be concise: lead with the direct answer, then only the supporting detail that is actually in the material.
- Never invent files, decisions, dates, reasons, or citations. Never cite a number that is not in the material.`;

// Per-candidate content cap. Larger than rerank's 600: the answerer needs
// substance, and wiki bodies (markdown) are the payload. 12 × 2000 ≈ 6–8k
// prompt tokens, well inside the wikiModel budget.
export const CANDIDATE_CHARS = 2000;

function toIso(ts: unknown): string {
  return ts instanceof Date ? ts.toISOString() : String(ts);
}

// Head-truncate (keep the opening) at CANDIDATE_CHARS, preserving newlines
// (markdown), flagged with a marker — same idea as dream's buildTranscript.
function candidateBody(content: string): string {
  if (content.length <= CANDIDATE_CHARS) return content;
  return content.slice(0, CANDIDATE_CHARS) + '\n[truncated]';
}

// One-line header per candidate, derived from ChunkMetadata. The [n] is 1-based
// because the same numbers render in the user-facing sources list.
export function candidateHeader(n: number, r: SearchResult): string {
  const m = r.chunk.metadata;
  const date = toIso(m.timestamp).slice(0, 10);
  if (m.tier === 'wiki') {
    const slug = m.trajectoryId?.replace(/^wiki:/, '') ?? '?';
    return `[${n}] wiki/${m.dreamType ?? '?'} · ${slug} · ${date}`;
  }
  const ref = `${m.repo}@${m.branch || '(no-branch)'}`;
  if (m.tier === 'dream') return `[${n}] dream/${m.dreamType ?? '?'} · ${ref} · ${date}`;
  return `[${n}] raw · ${ref} · ${date}`;
}

// Build the user message: the question, then the numbered material [1]..[k].
export function buildAskUser(question: string, candidates: SearchResult[]): string {
  const blocks = candidates.map((r, i) => `${candidateHeader(i + 1, r)}\n${candidateBody(r.chunk.content)}`);
  return `Question: ${question}\n\nMaterial:\n\n${blocks.join('\n\n')}`;
}

// Collect the citation numbers the model actually used, keeping only integers
// in [1, n]. Drives the `cited` flag on sources; dedupes.
export function extractCitedIndices(answer: string, n: number): Set<number> {
  const cited = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const idx = Number(match[1]);
    if (Number.isInteger(idx) && idx >= 1 && idx <= n) cited.add(idx);
  }
  return cited;
}
