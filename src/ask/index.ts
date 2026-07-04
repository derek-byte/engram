import OpenAI from 'openai';
import { runSearch } from '../search/index.ts';
import { modelParams } from '../wiki/llm.ts';
import { ASK_SYSTEM_PROMPT, buildAskUser, extractCitedIndices } from './prompt.ts';
import type { SearchFilters, SearchResult } from '../types/index.ts';
import type { VectorBackend } from '../storage/backend.ts';
import type { Embedder } from '../ingest/embed.ts';

// Interactive: a user is waiting, so one SDK retry is enough — this is NOT the
// batch-grade 120s/6-attempt loop synthesis uses.
const ASK_TIMEOUT_MS = 60_000;

// Typed failure so callers distinguish "ask failed" (CLI exit 1 / MCP isError)
// from a bug. Ask NEVER silently degrades to search — the opposite of rerank's
// null-fallback — because the spec forbids answering-without-an-answer.
export class AskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskError';
  }
}

// Just the slice of the OpenAI SDK the answerer touches. Distinct from rerank's
// ChatClient: no `response_format` (plain-text output) and it carries the
// modelParams fields, so tests inject a fake without lying about the shape.
export interface AskChatClient {
  chat: {
    completions: {
      create(
        body: {
          model: string;
          messages: Array<{ role: 'system' | 'user'; content: string }>;
          max_completion_tokens: number;
          temperature?: number;
        },
        options?: { timeout?: number; maxRetries?: number }
      ): Promise<{
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      }>;
    };
  };
}

export interface AskSource {
  n: number;
  tier: 'raw' | 'dream' | 'wiki';
  dreamType?: string;
  ref: string; // wiki slug, or repo@branch for dream/raw
  date: string; // ISO
  chunkId: string;
  trajectoryId?: string;
  cited: boolean;
}

export interface AskUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AskResult {
  answer: string | null; // null ONLY for the zero-candidates case
  sources: AskSource[];
  usage: AskUsage | null;
  model: string;
}

export class OpenAIAskLLM {
  readonly model: string;
  private client: AskChatClient;

  constructor(apiKey: string, model: string, client?: AskChatClient) {
    this.model = model;
    this.client = client ?? (new OpenAI({ apiKey }) as unknown as AskChatClient);
  }

  // One grounded chat call. Empty/refused content or any API error throws
  // AskError — never a silent fallback.
  async answer(question: string, candidates: SearchResult[]): Promise<{ text: string; usage: AskUsage | null }> {
    let res;
    try {
      res = await this.client.chat.completions.create(
        {
          model: this.model,
          ...modelParams(this.model),
          messages: [
            { role: 'system', content: ASK_SYSTEM_PROMPT },
            { role: 'user', content: buildAskUser(question, candidates) },
          ],
        },
        { timeout: ASK_TIMEOUT_MS, maxRetries: 1 }
      );
    } catch (err) {
      throw new AskError(err instanceof Error ? err.message : String(err));
    }
    const text = res.choices[0]?.message.content?.trim();
    if (!text) throw new AskError('the model returned no answer');
    const usage = res.usage
      ? { promptTokens: res.usage.prompt_tokens ?? 0, completionTokens: res.usage.completion_tokens ?? 0 }
      : null;
    return { text, usage };
  }
}

function toSource(n: number, r: SearchResult, cited: boolean): AskSource {
  const m = r.chunk.metadata;
  const date = m.timestamp instanceof Date ? m.timestamp.toISOString() : String(m.timestamp);
  const ref = m.tier === 'wiki' ? (m.trajectoryId?.replace(/^wiki:/, '') ?? '?') : `${m.repo}@${m.branch || '(no-branch)'}`;
  return { n, tier: m.tier, dreamType: m.dreamType, ref, date, chunkId: r.chunk.id, trajectoryId: m.trajectoryId, cited };
}

// One human-readable source line, shared by the CLI and MCP so both stay in
// lockstep: `[n] [wiki:concept] pgvector-hnsw · 2026-06-12 · chunk 3f2a1b…`
export function formatSourceLine(s: AskSource): string {
  const badge = s.tier === 'wiki' ? `wiki:${s.dreamType ?? '?'}` : s.tier === 'dream' ? `dream:${s.dreamType ?? '?'}` : 'raw';
  const day = s.date.slice(0, 10);
  // Dream chunks carry a stable trajectory id (dream:<fp>#i); for wiki/raw the
  // chunk id is the reopenable handle.
  const tail = s.tier === 'dream' && s.trajectoryId ? s.trajectoryId : `chunk ${shortId(s.chunkId)}`;
  return `[${s.n}] [${badge}] ${s.ref} · ${day} · ${tail}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + '…' : id;
}

// Retrieve (reused wholesale, NO reranker — v0 is strictly one LLM call and the
// answerer reads all k anyway) → one grounded call → resolve [n] citations.
export async function runAsk(
  question: string,
  filters: SearchFilters,
  deps: { backend: VectorBackend; embedder: Embedder; llm: OpenAIAskLLM }
): Promise<AskResult> {
  const candidates = await runSearch(question, filters, { backend: deps.backend, embedder: deps.embedder });
  if (candidates.length === 0) {
    return { answer: null, sources: [], usage: null, model: deps.llm.model };
  }
  const { text, usage } = await deps.llm.answer(question, candidates);
  const cited = extractCitedIndices(text, candidates.length);
  // Sources cover ALL k in prompt order so every [n] marker resolves; the CLI
  // prints only the cited ones, the JSON carries all with the `cited` flag.
  const sources = candidates.map((r, i) => toSource(i + 1, r, cited.has(i + 1)));
  return { answer: text, sources, usage, model: deps.llm.model };
}
