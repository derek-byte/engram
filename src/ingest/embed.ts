import OpenAI from 'openai';

const MAX_CHARS_PER_INPUT = 24000;

export class Embedder {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const inputs = texts.map((t) => (t.length > MAX_CHARS_PER_INPUT ? t.slice(0, MAX_CHARS_PER_INPUT) : t));

    const result = await this.withRetry(() =>
      this.client.embeddings.create({ model: this.model, input: inputs })
    );

    return result.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.embed([text]);
    if (!v) throw new Error('embedding returned no result');
    return v;
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
