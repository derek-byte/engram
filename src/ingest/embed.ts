import OpenAI from 'openai';
import type { EmbeddingCache } from '../storage/backend.ts';
import { contentSha256 } from './hash.ts';

const MAX_CHARS_PER_INPUT = 24000;

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

  async embed(texts: string[]): Promise<number[][]> {
    return (await this.embedWithStats(texts)).embeddings;
  }

  async embedWithStats(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { embeddings: [], cacheHits: 0, cacheMisses: 0 };
    const inputs = texts.map((t) => (t.length > MAX_CHARS_PER_INPUT ? t.slice(0, MAX_CHARS_PER_INPUT) : t));
    if (!this.cache) return { embeddings: await this.embedRaw(inputs), cacheHits: 0, cacheMisses: 0 };

    const shas = inputs.map(contentSha256);
    const cached = await this.cache.getCachedEmbeddings(shas, this.model);

    const out: number[][] = new Array(inputs.length);
    const misses: Array<{ index: number; text: string; sha: string }> = [];
    inputs.forEach((text, i) => {
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

    return { embeddings: out, cacheHits: inputs.length - misses.length, cacheMisses: misses.length };
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
