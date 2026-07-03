import OpenAI from 'openai';
import type { EngramConfig, RerankConfig, SearchResult } from '../types/index.ts';

export const RERANK_DEFAULTS: RerankConfig = { enabled: false, model: 'gpt-4.1-mini', topK: 30 };

const SNIPPET_CHARS = 600; // ~topK × 600 chars bounds the prompt to a few k tokens
const RERANK_TIMEOUT_MS = 15_000;

// Just the slice of the OpenAI SDK the reranker touches — lets tests inject a fake.
export interface ChatClient {
  chat: {
    completions: {
      create(
        body: {
          model: string;
          messages: Array<{ role: 'system' | 'user'; content: string }>;
          response_format: { type: 'json_object' };
        },
        options?: { timeout?: number; maxRetries?: number }
      ): Promise<{
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      }>;
    };
  };
}

export interface RerankStats {
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
}

// Parse the model's JSON ranking into a clean index permutation. Exported for
// unit tests. Keeps integers in [0, n), dedupes preserving first occurrence.
// Returns null on any structural problem so the caller can fall back.
export function parseRanking(text: string, n: number): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const ranking = (parsed as { ranking?: unknown })?.ranking;
  if (!Array.isArray(ranking)) return null;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of ranking) {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) continue;
    if (raw < 0 || raw >= n) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out.length === 0 ? null : out;
}

function snippet(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
}

function buildPrompt(query: string, candidates: SearchResult[]): string {
  const lines = candidates.map((r, i) => {
    const m = r.chunk.metadata;
    const ts = m.timestamp instanceof Date ? m.timestamp.toISOString() : String(m.timestamp);
    return `[${i}] ${m.repo}@${m.branch || '(no-branch)'} · ${ts}\n${snippet(r.chunk.content)}`;
  });
  return (
    `Query: ${query}\n\n` +
    `Candidates:\n${lines.join('\n\n')}\n\n` +
    `Return JSON {"ranking": [<ALL candidate indices, most relevant to the query first>]}. ` +
    `Include every index exactly once.`
  );
}

const SYSTEM_PROMPT =
  'You are a search-result reranker. Order the candidates by relevance to the query, most relevant first.';

export class OpenAIReranker {
  readonly topK: number;
  readonly model: string;
  readonly stats: RerankStats = { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0 };
  private client: ChatClient;

  constructor(apiKey: string, cfg: { model: string; topK: number }, client?: ChatClient) {
    this.model = cfg.model;
    this.topK = cfg.topK;
    this.client = client ?? (new OpenAI({ apiKey }) as unknown as ChatClient);
  }

  // Reorder the candidate pool via one LLM call. Returns the full reordered
  // array (ranked chunks first with rerankRank set, then any omitted chunks in
  // original hybrid order), or null on any failure so the caller keeps hybrid
  // order. Never throws.
  async rerank(query: string, candidates: SearchResult[]): Promise<SearchResult[] | null> {
    if (candidates.length <= 1) return candidates;
    const pool = candidates.slice(0, this.topK);
    try {
      this.stats.calls++;
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildPrompt(query, pool) },
          ],
          response_format: { type: 'json_object' },
        },
        { timeout: RERANK_TIMEOUT_MS, maxRetries: 1 }
      );
      this.stats.promptTokens += response.usage?.prompt_tokens ?? 0;
      this.stats.completionTokens += response.usage?.completion_tokens ?? 0;

      const content = response.choices[0]?.message.content;
      const ranking = content ? parseRanking(content, pool.length) : null;
      if (!ranking) {
        this.stats.failures++;
        console.error('[rerank] malformed or empty LLM ranking; falling back to hybrid order');
        return null;
      }

      const ranked: SearchResult[] = ranking.map((idx, pos) => ({ ...pool[idx]!, rerankRank: pos + 1 }));
      const used = new Set(ranking);
      // LLM-omitted topK members, then the beyond-topK tail — all in hybrid order.
      const rest = candidates.filter((_, i) => i >= this.topK || !used.has(i));
      return [...ranked, ...rest];
    } catch (err) {
      this.stats.failures++;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[rerank] ${reason}; falling back to hybrid order`);
      return null;
    }
  }
}

// Construct a reranker from config, or undefined (with a warning) when no key
// is available — the search then proceeds in plain hybrid order.
export function buildReranker(config: EngramConfig): OpenAIReranker | undefined {
  if (!config.openaiApiKey) {
    console.error('[rerank] no OPENAI_API_KEY; falling back to hybrid order');
    return undefined;
  }
  return new OpenAIReranker(config.openaiApiKey, config.rerank);
}
