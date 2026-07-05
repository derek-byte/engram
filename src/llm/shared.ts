import OpenAI from 'openai';

// Per-request cap shared by every synthesis chat call. Without it the OpenAI SDK
// default is 10 minutes — one hung request stalls the whole batch. Pair it with
// SDK maxRetries: 0 so withRetry (below) owns the backoff, not the SDK.
export const REQUEST_TIMEOUT_MS = 120_000;

// Per-model completion params. A generous output cap either way: truncated JSON
// fails the unit identically on every retry. gpt-5+/o-series reasoning models
// reject the legacy `max_tokens` and any non-default `temperature`; older chat
// models accept `max_completion_tokens` but need `temperature: 0` for stable
// re-runs.
export function modelParams(model: string): { max_completion_tokens: number; temperature?: number } {
  const reasoning = /^(gpt-5|o\d)/.test(model);
  return reasoning
    ? { max_completion_tokens: 16384 }
    : { max_completion_tokens: 16384, temperature: 0 };
}

// Retry loop shared by embeddings + synthesis. `attempts` differs per caller
// (embeddings use 4, synthesis 6) but the backoff schedule is identical.
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 6 }: { attempts?: number } = {}
): Promise<T> {
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

// Auth/validation errors won't heal on retry; fail fast so callers (e.g. the
// embed fallback latch) react instead of spinning.
export function isRetryable(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    return status === undefined || status === 408 || status === 429 || status >= 500;
  }
  return true;
}
