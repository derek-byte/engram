import OpenAI from 'openai';
import { SYSTEM_PROMPT } from './prompt.ts';

// 'note' is never requested from the model — it's the coercion bucket for
// off-enum types the model invents, so the item's text survives with an
// honest label instead of being dropped (a dropped item is unrecoverable
// once the unit's fingerprint lands).
export type DreamItemType = 'decision' | 'fix' | 'gotcha' | 'preference' | 'note';
const ITEM_TYPES: readonly DreamItemType[] = ['decision', 'fix', 'gotcha', 'preference'];

export interface DreamItem {
  type: DreamItemType;
  text: string;
}

export interface DreamUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface DreamExtraction {
  items: DreamItem[];
  usage?: DreamUsage;
}

export interface DreamLLM {
  extract(header: string, transcript: string): Promise<DreamExtraction>;
}

export class OpenAIDreamLLM implements DreamLLM {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async extract(header: string, transcript: string): Promise<DreamExtraction> {
    const res = await withRetry(() =>
      this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        // Big units yield many items; a low cap truncates the JSON mid-string
        // and, at temperature 0, the same unit then fails identically forever.
        max_tokens: 16384,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${header}\n\nTRANSCRIPT:\n${transcript}` },
        ],
      })
    );

    const content = res.choices[0]?.message?.content ?? '';
    const items = parseItems(content);
    return {
      items,
      usage: res.usage
        ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens }
        : undefined,
    };
  }
}

// Strict parse: throw on malformed JSON (unit fails → retried next run). Items
// with an unknown type are coerced to 'note' rather than dropped.
export function parseItems(raw: string): DreamItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`dream LLM returned malformed JSON: ${raw.slice(0, 200)}`);
  }
  const list = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(list)) {
    throw new Error(`dream LLM JSON missing "items" array: ${raw.slice(0, 200)}`);
  }
  const out: DreamItem[] = [];
  for (const raw of list) {
    const type = (raw as { type?: unknown })?.type;
    const text = (raw as { text?: unknown })?.text;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    if (!ITEM_TYPES.includes(type as DreamItemType)) {
      console.warn(`[dream] coercing unknown item type '${String(type)}' to note: ${text.trim().slice(0, 80)}`);
      out.push({ type: 'note', text: text.trim() });
      continue;
    }
    out.push({ type: type as DreamItemType, text: text.trim() });
  }
  return out;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, retryDelayMs(err, i)));
    }
  }
  throw lastErr;
}

// TPM 429s need seconds-scale waits (the budget refills per minute); with
// concurrent workers a sub-second backoff just re-collides.
function retryDelayMs(err: unknown, attempt: number): number {
  const base = Math.min(2 ** attempt * 500, 8000);
  if (err instanceof OpenAI.APIError && err.status === 429) {
    return Math.max(base, (attempt + 1) * 5000);
  }
  return base;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    return status === undefined || status === 408 || status === 429 || status >= 500;
  }
  return true;
}
