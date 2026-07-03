import OpenAI from 'openai';
import { WIKI_SYSTEM_PROMPT, WIKI_SPLIT_SYSTEM_PROMPT, buildIngestUser, buildSplitUser } from './prompt.ts';
import { PAGE_KINDS, type PageKind, type WikiPage } from './store.ts';
import { isValidSlug, slugify, stripIdCitations } from './links.ts';

export interface WikiPageOp {
  slug: string;
  action: 'create' | 'update';
  kind: PageKind;
  title: string;
  summary: string;
  aliases: string[];
  body: string;
  sources: string[];
}

export interface WikiUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface WikiIngestResponse {
  pages: WikiPageOp[];
  usage?: WikiUsage;
}

const REQUEST_TIMEOUT_MS = 120_000;

// Dream item types the model sometimes leaks into page ops despite the prompt;
// coerce to the closest wiki kind instead of dropping the whole page.
const KIND_ALIASES: Record<string, PageKind> = { fix: 'gotcha', preference: 'topic' };

// The wiki-ingest LLM seam: one call per synthesis unit returns full page ops.
export interface WikiIngestLLM {
  ingest(header: string, itemsText: string, candidatesText: string, inventory: string): Promise<WikiIngestResponse>;
}

// The hub-split seam: one call takes an oversized page + inventory, returns a
// rewritten hub op plus child page ops (same STRICT JSON shape as ingest).
export interface WikiSplitLLM {
  split(page: WikiPage, inventory: string): Promise<WikiIngestResponse>;
}

export class OpenAIWikiLLM implements WikiIngestLLM, WikiSplitLLM {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async ingest(header: string, itemsText: string, candidatesText: string, inventory: string): Promise<WikiIngestResponse> {
    const res = await withRetry(() =>
      this.client.chat.completions.create(
        {
          model: this.model,
          temperature: 0,
          // Units that update many pages return full bodies; a low cap
          // truncates the JSON mid-string and, at temperature 0, the same
          // unit then fails identically on every retry.
          max_tokens: 16384,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: WIKI_SYSTEM_PROMPT },
            { role: 'user', content: buildIngestUser(header, itemsText, candidatesText, inventory) },
          ],
        },
        // Without a timeout the SDK default is 10 minutes — one hung request
        // stalls the whole ingest. withRetry owns the retries.
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }
      )
    );
    const content = res.choices[0]?.message?.content ?? '';
    return {
      pages: parsePageOps(content),
      usage: res.usage
        ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens }
        : undefined,
    };
  }

  async split(page: WikiPage, inventory: string): Promise<WikiIngestResponse> {
    const res = await withRetry(() =>
      this.client.chat.completions.create(
        {
          model: this.model,
          temperature: 0,
          max_tokens: 16384,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: WIKI_SPLIT_SYSTEM_PROMPT },
            { role: 'user', content: buildSplitUser(page, inventory) },
          ],
        },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }
      )
    );
    const content = res.choices[0]?.message?.content ?? '';
    return {
      pages: parsePageOps(content),
      usage: res.usage
        ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens }
        : undefined,
    };
  }
}

// Strict parse: throw on malformed JSON (unit fails → retried next run). Ops with
// an unknown kind/action or an invalid slug are dropped with a warning.
export function parsePageOps(raw: string): WikiPageOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`wiki LLM returned malformed JSON: ${raw.slice(0, 200)}`);
  }
  const list = (parsed as { pages?: unknown })?.pages;
  if (!Array.isArray(list)) {
    throw new Error(`wiki LLM JSON missing "pages" array: ${raw.slice(0, 200)}`);
  }
  const out: WikiPageOp[] = [];
  for (const raw of list) {
    const o = raw as Record<string, unknown>;
    let slug = typeof o.slug === 'string' ? o.slug.trim() : '';
    const action = o.action;
    let kind = o.kind;
    if (typeof kind === 'string' && KIND_ALIASES[kind]) {
      console.warn(`[wiki] coercing page op ${slug} kind '${kind}' → '${KIND_ALIASES[kind]}'`);
      kind = KIND_ALIASES[kind];
    }
    // Strip inline [[<chunk id>]] citations: hex ids are valid slugs, so left in
    // place they'd pollute the link graph as dangling links.
    const body = typeof o.body === 'string' ? stripIdCitations(o.body) : '';
    if (!isValidSlug(slug)) {
      // Salvage: the model sometimes omits slug but supplies a title.
      const derived = typeof o.title === 'string' ? slugify(o.title) : '';
      if (!isValidSlug(derived)) {
        console.warn(`[wiki] dropping page op with invalid slug: ${String(o.slug)}`);
        continue;
      }
      console.warn(`[wiki] deriving slug '${derived}' from title for page op with invalid slug: ${String(o.slug)}`);
      slug = derived;
    }
    if (action !== 'create' && action !== 'update') {
      console.warn(`[wiki] dropping page op ${slug} with unknown action: ${String(action)}`);
      continue;
    }
    if (!(PAGE_KINDS as readonly string[]).includes(String(kind))) {
      console.warn(`[wiki] dropping page op ${slug} with unknown kind: ${String(kind)}`);
      continue;
    }
    if (body.trim().length === 0) {
      console.warn(`[wiki] dropping page op ${slug} with empty body`);
      continue;
    }
    out.push({
      slug,
      action,
      kind: kind as PageKind,
      title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : slug,
      summary: typeof o.summary === 'string' ? o.summary.trim() : '',
      aliases: Array.isArray(o.aliases) ? o.aliases.filter((a): a is string => typeof a === 'string') : [],
      body: body.trim(),
      sources: Array.isArray(o.sources) ? o.sources.filter((s): s is string => typeof s === 'string') : [],
    });
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
