import type { Trajectory } from '../types/index.ts';
import { REQUEST_TIMEOUT_MS, withRetry } from '../llm/shared.ts';

// Anthropic "Contextual Retrieval" cookbook, ported to the engram corpus: an LLM
// writes a one-sentence situating prefix for each chunk, prepended before it is
// embedded. Product-shaped and promotable — mirrors caption.ts exactly: a narrow
// injectable client (so tests inject a fake), a sha-keyed cache keyed by the
// generator model, fail-safe fallback (any failure → the caller embeds raw text),
// and withRetry-owned backoff. See:
// https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide

// Head/tail caps for the rendered trajectory document handed to the LLM. Long
// sessions are truncated to a 6k-char head + 2k-char tail with a seam, so the
// prompt stays bounded while keeping both the opening intent and the outcome.
export const CONTEXT_HEAD_CHARS = 6000;
export const CONTEXT_TAIL_CHARS = 2000;
const CONTEXT_SEAM = '\n…[truncated]…\n';

// Per-tool-output cap inside the rendered document — tool results are the bulk of
// a coding trajectory; a tight cap keeps the context readable and the prompt small.
const TOOL_OUTPUT_CHARS = 500;

// Defensive cap on the returned prefix. A well-behaved model returns one sentence;
// this bounds a runaway response before it ever reaches the embedder.
export const MAX_PREFIX_CHARS = 300;

// Small completion cap: the prefix is one sentence. Deliberately NOT modelParams()
// (whose 16384 cap is sized for JSON synthesis) — a runaway generation here is pure
// waste. temperature 0 for stable re-runs (gpt-4o-mini is not a reasoning model).
const PREFIX_MAX_COMPLETION_TOKENS = 150;

// The minimal chat-completion slice the prefix generator touches — text-only
// messages (caption.ts's pattern minus the image parts) so tests inject a fake.
export interface PrefixClient {
  chat: {
    completions: {
      create(
        body: {
          model: string;
          messages: Array<{ role: 'user'; content: string }>;
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

// Persisted prefixes, keyed (chunk_content_sha256, generator_model). Mirror of
// EmbeddingCache/CaptionCache: a hit skips the (paid, slow) LLM call, and the key
// is the generator model so arms B and D (same prefix text, different embedder)
// share one cache.
export interface PrefixCache {
  getCachedPrefixes(shas: string[], model: string): Promise<Map<string, string>>;
  putCachedPrefixes(entries: Array<{ sha: string; prefix: string }>, model: string): Promise<void>;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `… [truncated ${s.length - max} chars]`;
}

// Head+tail cap with a seam. Inputs at or under HEAD+TAIL pass through untouched;
// longer inputs keep the first HEAD chars and the last TAIL chars.
export function capContext(s: string): string {
  if (s.length <= CONTEXT_HEAD_CHARS + CONTEXT_TAIL_CHARS) return s;
  return s.slice(0, CONTEXT_HEAD_CHARS) + CONTEXT_SEAM + s.slice(s.length - CONTEXT_TAIL_CHARS);
}

// Render the trajectory as a plain-text document for the situating prompt:
// the user turn, each assistant block, then one line per tool call with its
// (truncated) output. Capped head+tail so the prompt stays bounded.
export function buildTrajectoryContext(t: Trajectory): string {
  const lines: string[] = [`USER: ${t.userMessage}`];
  for (const block of t.assistantBlocks) lines.push(`ASSISTANT: ${block}`);
  for (const tc of t.toolCalls) {
    const out = tc.output ? truncate(tc.output, TOOL_OUTPUT_CHARS) : '';
    lines.push(`TOOL ${tc.name}: ${out}`);
  }
  return capContext(lines.join('\n'));
}

// The cookbook situating prompt, verbatim.
export function buildPrefixPrompt(context: string, chunkText: string): string {
  return `<document>
${context}
</document>

<chunk>
${chunkText}
</chunk>

Give a short succinct context (one sentence) situating this chunk within the
overall document for the purposes of improving search retrieval of the chunk.
Answer only with the succinct context and nothing else.`;
}

// One chat completion → a situating prefix + token usage. withRetry (4 attempts)
// owns the backoff; the SDK maxRetries is 0 so it doesn't double-retry. Throws on
// exhausted retries or an empty response — resolvePrefixes catches and falls back
// to the raw chunk. The returned prefix is defensively truncated to MAX_PREFIX_CHARS.
export async function generatePrefix(
  client: PrefixClient,
  model: string,
  context: string,
  chunkText: string
): Promise<{ prefix: string; promptTokens: number; completionTokens: number }> {
  return withRetry(
    async () => {
      const res = await client.chat.completions.create(
        {
          model,
          messages: [{ role: 'user', content: buildPrefixPrompt(context, chunkText) }],
          max_completion_tokens: PREFIX_MAX_COMPLETION_TOKENS,
          temperature: 0,
        },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }
      );
      const raw = res.choices[0]?.message.content?.trim();
      if (!raw) throw new Error('empty prefix response');
      return {
        prefix: raw.length > MAX_PREFIX_CHARS ? raw.slice(0, MAX_PREFIX_CHARS) : raw,
        promptTokens: res.usage?.prompt_tokens ?? 0,
        completionTokens: res.usage?.completion_tokens ?? 0,
      };
    },
    { attempts: 4 }
  );
}

export interface PrefixStats {
  cacheHits: number;
  generated: number;
  fallbacks: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ResolvePrefixDeps {
  cache: PrefixCache;
  model: string;
  client: PrefixClient;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

// Resolve a situating prefix for every unique chunk (deduped by sha, resolved
// once and reused). Cache hits win; misses are generated by a bounded worker pool.
// Any generation failure is logged once and skipped — an absent sha in the
// returned map is the caller's signal to fall back to the raw chunk text. Only
// successful prefixes are cached (mirror of resolveCaptions).
export async function resolvePrefixes(
  items: Array<{ sha: string; chunkText: string; context: string }>,
  deps: ResolvePrefixDeps
): Promise<{ prefixes: Map<string, string>; stats: PrefixStats }> {
  const { cache, model, client, concurrency = 8, onProgress } = deps;

  // Dedupe by sha: identical chunk text hashes identically and needs one prefix.
  const bySha = new Map<string, { sha: string; chunkText: string; context: string }>();
  for (const it of items) if (!bySha.has(it.sha)) bySha.set(it.sha, it);
  const unique = [...bySha.values()];

  const prefixes = new Map<string, string>();
  const stats: PrefixStats = { cacheHits: 0, generated: 0, fallbacks: 0, promptTokens: 0, completionTokens: 0 };
  if (unique.length === 0) return { prefixes, stats };

  const cached = await cache.getCachedPrefixes(
    unique.map((u) => u.sha),
    model
  );
  const misses: typeof unique = [];
  for (const u of unique) {
    const hit = cached.get(u.sha);
    if (hit !== undefined) {
      prefixes.set(u.sha, hit);
      stats.cacheHits++;
    } else {
      misses.push(u);
    }
  }

  const fresh: Array<{ sha: string; prefix: string }> = [];
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= misses.length) return;
      const m = misses[i]!;
      try {
        const r = await generatePrefix(client, model, m.context, m.chunkText);
        prefixes.set(m.sha, r.prefix);
        fresh.push({ sha: m.sha, prefix: r.prefix });
        stats.generated++;
        stats.promptTokens += r.promptTokens;
        stats.completionTokens += r.completionTokens;
      } catch (err) {
        // Logged once per chunk; absent from the map = the caller embeds raw text.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[prefix] ${reason}; falling back to raw chunk`);
        stats.fallbacks++;
      }
      done++;
      onProgress?.(done, misses.length);
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, misses.length || 1));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  if (fresh.length > 0) await cache.putCachedPrefixes(fresh, model);
  return { prefixes, stats };
}
