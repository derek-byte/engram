import { describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { modelParams, withRetry, isRetryable, REQUEST_TIMEOUT_MS } from './shared.ts';
import { OpenAIDreamLLM, type DreamChatClient } from '../dream/llm.ts';

describe('modelParams', () => {
  test('reasoning models (gpt-5+, o-series) omit temperature', () => {
    for (const m of ['gpt-5', 'gpt-5.4-mini', 'o1', 'o3-mini']) {
      const p = modelParams(m);
      expect(p.max_completion_tokens).toBe(16384);
      expect(p.temperature).toBeUndefined();
    }
  });

  test('legacy chat models pin temperature 0 for stable re-runs', () => {
    for (const m of ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o']) {
      const p = modelParams(m);
      expect(p.max_completion_tokens).toBe(16384);
      expect(p.temperature).toBe(0);
    }
  });
});

describe('isRetryable', () => {
  test('non-API errors are retryable (transient network faults)', () => {
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
  });

  test('5xx / 408 / 429 / unknown-status API errors retry; 4xx auth does not', () => {
    const apiErr = (status: number | undefined) =>
      new OpenAI.APIError(status, undefined, 'x', undefined);
    expect(isRetryable(apiErr(500))).toBe(true);
    expect(isRetryable(apiErr(503))).toBe(true);
    expect(isRetryable(apiErr(408))).toBe(true);
    expect(isRetryable(apiErr(429))).toBe(true);
    expect(isRetryable(apiErr(undefined))).toBe(true);
    expect(isRetryable(apiErr(401))).toBe(false);
    expect(isRetryable(apiErr(400))).toBe(false);
  });
});

describe('withRetry', () => {
  test('returns on first success without retrying', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(1);
  });

  test('stops immediately on a non-retryable error (no wasted attempts)', async () => {
    let calls = 0;
    const authErr = new OpenAI.APIError(401, undefined, 'unauthorized', undefined);
    await expect(
      withRetry(async () => {
        calls++;
        throw authErr;
      })
    ).rejects.toBe(authErr);
    expect(calls).toBe(1);
  });

  test('retries a retryable error up to `attempts`, then throws the last one', async () => {
    let calls = 0;
    const err = new Error('flaky');
    await expect(
      withRetry(
        async () => {
          calls++;
          throw err;
        },
        { attempts: 2 } // one 500ms backoff, keeps the test fast
      )
    ).rejects.toBe(err);
    expect(calls).toBe(2);
  });

  test('recovers when a retryable failure is followed by success', async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('transient');
        return calls;
      },
      { attempts: 3 }
    );
    expect(out).toBe(2);
    expect(calls).toBe(2);
  });
});

// A fake chat client recording the exact body + request options each call gets.
function recordingClient(): DreamChatClient & { bodies: unknown[]; options: unknown[] } {
  const rec = { bodies: [] as unknown[], options: [] as unknown[] };
  const client: DreamChatClient = {
    chat: {
      completions: {
        async create(body, options) {
          rec.bodies.push(body);
          rec.options.push(options);
          return { choices: [{ message: { content: '{"items":[]}' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } };
        },
      },
    },
  };
  return Object.assign(client, rec);
}

describe('OpenAIDreamLLM request options', () => {
  test('passes an explicit timeout + maxRetries: 0 (no pathological SDK stacking)', async () => {
    const client = recordingClient();
    const llm = new OpenAIDreamLLM('k', 'gpt-4o-mini', client);
    await llm.extract('HDR', 'transcript body');

    expect(client.options).toHaveLength(1);
    expect(client.options[0]).toEqual({ timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });

    // Body still carries modelParams + json_object + the composed messages.
    const body = client.bodies[0] as { max_completion_tokens: number; response_format: unknown; messages: Array<{ content: string }> };
    expect(body.max_completion_tokens).toBe(16384);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1]!.content).toContain('transcript body');
  });
});
