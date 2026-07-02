import OpenAI from 'openai';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingCache } from '../storage/backend.ts';
import { contentSha256 } from './hash.ts';

export const MAX_CHARS_PER_INPUT = 24000;

export const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
export const OPENAI_DEFAULT_DIM = 1536;
export const LOCAL_MODEL = 'all-MiniLM-L6-v2';
export const LOCAL_DIM = 384;

export type EmbeddingProviderKind = 'openai' | 'local';

export const PROVIDER_DEFAULTS: Record<EmbeddingProviderKind, { model: string; dim: number }> = {
  openai: { model: OPENAI_DEFAULT_MODEL, dim: OPENAI_DEFAULT_DIM },
  local: { model: LOCAL_MODEL, dim: LOCAL_DIM },
};

const MODEL_CACHE_DIR = join(homedir(), '.engram', 'models');

export interface EmbeddingProvider {
  /** Model id that owns the vectors this provider currently produces. */
  readonly model: string;
  readonly dim: number;
  /** Per-input char cap enforced upstream; undefined = provider truncates internally. */
  readonly maxInputChars?: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class OpenAIProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  readonly maxInputChars = MAX_CHARS_PER_INPUT;
  private client: OpenAI;

  constructor(apiKey: string, model = OPENAI_DEFAULT_MODEL, dim = OPENAI_DEFAULT_DIM) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await withRetry(() =>
      this.client.embeddings.create({ model: this.model, input: texts })
    );
    return result.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export class FastembedProvider implements EmbeddingProvider {
  readonly model = LOCAL_MODEL;
  readonly dim = LOCAL_DIM;
  private engine?: Promise<{ embed(texts: string[], batchSize?: number): AsyncGenerator<number[][]> }>;

  private async load() {
    if (!this.engine) {
      this.engine = (async () => {
        const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
        return FlagEmbedding.init({
          model: EmbeddingModel.AllMiniLML6V2,
          cacheDir: MODEL_CACHE_DIR,
        });
      })();
    }
    return this.engine;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const engine = await this.load();
    const out: number[][] = [];
    for await (const batch of engine.embed(texts, texts.length)) out.push(...batch);
    return out;
  }
}

/**
 * Odysseus-style HTTP-down latch: on the first primary failure (or when
 * pre-latched for a missing key) switch to the fallback provider for the rest
 * of the process. No re-probing per batch, exactly one warning.
 */
export class FallbackProvider implements EmbeddingProvider {
  private active: EmbeddingProvider;
  private latched = false;

  constructor(
    private primary: EmbeddingProvider,
    private makeFallback: () => EmbeddingProvider
  ) {
    this.active = primary;
  }

  get model(): string {
    return this.active.model;
  }
  get dim(): number {
    return this.active.dim;
  }
  get maxInputChars(): number | undefined {
    return this.active.maxInputChars;
  }

  forceLatch(reason: string): void {
    if (this.latched) return;
    this.active = this.makeFallback();
    this.latched = true;
    console.warn(
      `[embed] ${reason}; using local provider ${this.active.model} for the rest of this process`
    );
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.latched) return this.active.embed(texts);
    try {
      return await this.primary.embed(texts);
    } catch (err) {
      this.forceLatch(
        `primary provider ${this.primary.model} failed (${err instanceof Error ? err.message : err})`
      );
      return this.active.embed(texts);
    }
  }
}

export function buildProvider(config: {
  embeddingProvider: EmbeddingProviderKind;
  openaiApiKey: string;
  embeddingModel: string;
  embeddingDim: number;
}): EmbeddingProvider {
  if (config.embeddingProvider === 'local') return new FastembedProvider();

  const primary = new OpenAIProvider(config.openaiApiKey, config.embeddingModel, config.embeddingDim);
  const provider = new FallbackProvider(primary, () => new FastembedProvider());
  if (!config.openaiApiKey) provider.forceLatch('no OpenAI API key configured');
  return provider;
}

export interface EmbedResult {
  embeddings: number[][];
  /** Model that actually produced these vectors (may differ from the configured one after a fallback latch). */
  model: string;
  cacheHits: number;
  cacheMisses: number;
}

export class Embedder {
  private cache?: EmbeddingCache;

  constructor(
    private provider: EmbeddingProvider,
    cache?: EmbeddingCache
  ) {
    this.cache = cache;
  }

  get model(): string {
    return this.provider.model;
  }
  get dim(): number {
    return this.provider.dim;
  }

  async embed(texts: string[], labels?: string[]): Promise<number[][]> {
    return (await this.embedWithStats(texts, labels)).embeddings;
  }

  async embedWithStats(texts: string[], labels?: string[]): Promise<EmbedResult> {
    if (texts.length === 0)
      return { embeddings: [], model: this.provider.model, cacheHits: 0, cacheMisses: 0 };

    const cap = this.provider.maxInputChars;
    if (cap !== undefined) {
      texts.forEach((t, i) => {
        if (t.length > cap) {
          const label = labels?.[i] ?? `input[${i}]`;
          throw new Error(
            `embedding input too large: ${label} is ${t.length} chars (limit ${cap}); split it into smaller chunks before embedding`
          );
        }
      });
    }

    if (!this.cache) {
      const embeddings = await this.provider.embed(texts);
      return { embeddings, model: this.provider.model, cacheHits: 0, cacheMisses: 0 };
    }

    const lookupModel = this.provider.model;
    const shas = texts.map(contentSha256);
    const cached = await this.cache.getCachedEmbeddings(shas, lookupModel);

    const out: number[][] = new Array(texts.length);
    const misses: Array<{ index: number; text: string; sha: string }> = [];
    texts.forEach((text, i) => {
      const hit = cached.get(shas[i]!);
      if (hit) out[i] = hit;
      else misses.push({ index: i, text, sha: shas[i]! });
    });

    if (misses.length === 0)
      return { embeddings: out, model: lookupModel, cacheHits: texts.length, cacheMisses: 0 };

    const fresh = await this.provider.embed(misses.map((m) => m.text));
    const usedModel = this.provider.model;

    // A mid-batch latch means cache hits were produced by the old model and
    // must not be mixed with the fallback's vectors — re-embed the whole batch
    // under the new model so every vector in it shares one model + dimension.
    if (usedModel !== lookupModel && cached.size > 0) {
      const all = await this.provider.embed(texts);
      await this.cache.putCachedEmbeddings(
        texts.map((_, i) => ({ sha: shas[i]!, embedding: all[i]! })),
        usedModel
      );
      return { embeddings: all, model: usedModel, cacheHits: 0, cacheMisses: texts.length };
    }

    const toCache = misses.map((m, j) => {
      out[m.index] = fresh[j]!;
      return { sha: m.sha, embedding: fresh[j]! };
    });
    await this.cache.putCachedEmbeddings(toCache, usedModel);

    return { embeddings: out, model: usedModel, cacheHits: texts.length - misses.length, cacheMisses: misses.length };
  }

  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.embed([text]);
    if (!v) throw new Error('embedding returned no result');
    return v;
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = Math.min(2 ** i * 500, 8000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
