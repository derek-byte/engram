import OpenAI from 'openai';
import type { EmbeddingCache } from '../storage/backend.ts';
import { contentSha256 } from './hash.ts';

export const MAX_CHARS_PER_INPUT = 24000;

export interface EmbedResult {
  embeddings: number[][];
  cacheHits: number;
  cacheMisses: number;
}

export class Embedder {
  private client: OpenAI;
  private model: string;
  private cache?: EmbeddingCache;

  constructor(apiKey: string, model: string, cache?: EmbeddingCache) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.cache = cache;
  }

  async embed(texts: string[], labels?: string[]): Promise<number[][]> {
    return (await this.embedWithStats(texts, labels)).embeddings;
  }

  async embedWithStats(texts: string[], labels?: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { embeddings: [], cacheHits: 0, cacheMisses: 0 };
    texts.forEach((t, i) => {
      if (t.length > MAX_CHARS_PER_INPUT) {
        const label = labels?.[i] ?? `input[${i}]`;
        throw new Error(
          `embedding input too large: ${label} is ${t.length} chars (limit ${MAX_CHARS_PER_INPUT}); split it into smaller chunks before embedding`
        );
      }
    });
    if (!this.cache) return { embeddings: await this.embedRaw(texts), cacheHits: 0, cacheMisses: 0 };

    const shas = texts.map(contentSha256);
    const cached = await this.cache.getCachedEmbeddings(shas, this.model);

    const out: number[][] = new Array(texts.length);
    const misses: Array<{ index: number; text: string; sha: string }> = [];
    texts.forEach((text, i) => {
      const hit = cached.get(shas[i]!);
      if (hit) {
        out[i] = hit;
      } else {
        misses.push({ index: i, text, sha: shas[i]! });
      }
    });

    if (misses.length > 0) {
      const fresh = await this.embedRaw(misses.map((m) => m.text));
      const toCache = misses.map((m, j) => {
        out[m.index] = fresh[j]!;
        return { sha: m.sha, embedding: fresh[j]! };
      });
      await this.cache.putCachedEmbeddings(toCache, this.model);
    }

    return { embeddings: out, cacheHits: texts.length - misses.length, cacheMisses: misses.length };
  }

  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.embed([text]);
    if (!v) throw new Error('embedding returned no result');
    return v;
  }

  private async embedRaw(inputs: string[]): Promise<number[][]> {
    const result = await this.withRetry(() =>
      this.client.embeddings.create({ model: this.model, input: inputs })
    );

    return result.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
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
}
