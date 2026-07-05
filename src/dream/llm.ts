import OpenAI from 'openai';
import { SYSTEM_PROMPT } from './prompt.ts';
import { modelParams, withRetry, REQUEST_TIMEOUT_MS } from '../llm/shared.ts';

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

// Structural view of the OpenAI chat client this seam uses — narrowed so tests can
// inject a fake and assert the request options (timeout/maxRetries) without pulling
// the full SDK type.
export interface DreamChatClient {
  chat: {
    completions: {
      create(
        body: {
          model: string;
          messages: Array<{ role: 'system' | 'user'; content: string }>;
          response_format: { type: 'json_object' };
          max_completion_tokens: number;
          temperature?: number;
        },
        options?: { timeout?: number; maxRetries?: number }
      ): Promise<{
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens: number; completion_tokens: number } | null;
      }>;
    };
  };
}

export class OpenAIDreamLLM implements DreamLLM {
  private client: DreamChatClient;
  private model: string;

  constructor(apiKey: string, model: string, client?: DreamChatClient) {
    this.client = client ?? (new OpenAI({ apiKey }) as unknown as DreamChatClient);
    this.model = model;
  }

  async extract(header: string, transcript: string): Promise<DreamExtraction> {
    const res = await withRetry(() =>
      this.client.chat.completions.create(
        {
          model: this.model,
          ...modelParams(this.model),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `${header}\n\nTRANSCRIPT:\n${transcript}` },
          ],
        },
        // Without a timeout the SDK default is 10 minutes; withRetry owns the
        // retries. Was previously omitted → SDK default timeout × SDK retries ×
        // withRetry stacked into a pathological worst case.
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }
      )
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
