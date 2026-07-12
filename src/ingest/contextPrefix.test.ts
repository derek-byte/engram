import { describe, expect, test } from 'bun:test';
import type { Trajectory } from '../types/index.ts';
import {
  buildTrajectoryContext,
  CONTEXT_HEAD_CHARS,
  CONTEXT_TAIL_CHARS,
  generatePrefix,
  MAX_PREFIX_CHARS,
  resolvePrefixes,
  type PrefixCache,
  type PrefixClient,
} from './contextPrefix.ts';

const MODEL = 'fake-prefix-model';

// Inline Map-backed fake cache, keyed `${model}\n${sha}`. Counters prove the
// pipeline hits the cache and persists only successful prefixes.
class FakePrefixCache implements PrefixCache {
  private store = new Map<string, string>();
  putCalls = 0;
  private key(sha: string, model: string): string {
    return `${model}\n${sha}`;
  }
  seed(sha: string, model: string, prefix: string): void {
    this.store.set(this.key(sha, model), prefix);
  }
  async getCachedPrefixes(shas: string[], model: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const sha of shas) {
      const hit = this.store.get(this.key(sha, model));
      if (hit !== undefined) out.set(sha, hit);
    }
    return out;
  }
  async putCachedPrefixes(entries: Array<{ sha: string; prefix: string }>, model: string): Promise<void> {
    this.putCalls++;
    for (const e of entries) {
      const k = this.key(e.sha, model);
      if (!this.store.has(k)) this.store.set(k, e.prefix);
    }
  }
}

// Counting fake completion client. Returns a fixed prefix (with usage) or throws.
class FakePrefixClient implements PrefixClient {
  calls = 0;
  constructor(private behavior: 'ok' | 'throw' | 'empty', private text = 'a situating prefix') {}
  chat = {
    completions: {
      create: async () => {
        this.calls++;
        if (this.behavior === 'throw') throw new Error('prefix boom');
        const content = this.behavior === 'empty' ? '' : this.text;
        return {
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        };
      },
    },
  };
}

function traj(over: Partial<Trajectory> = {}): Trajectory {
  return {
    sessionId: 's',
    repo: 'r',
    branch: 'b',
    cwd: '/c',
    timestamp: new Date(0),
    userMessage: 'do the thing',
    assistantBlocks: [],
    thinkingBlocks: [],
    images: [],
    toolCalls: [],
    filePaths: [],
    artifacts: [],
    exitCode: null,
    ...over,
  };
}

describe('resolvePrefixes', () => {
  test('cache hit → client never called', async () => {
    const cache = new FakePrefixCache();
    cache.seed('sha1', MODEL, 'cached prefix');
    const client = new FakePrefixClient('ok');
    const { prefixes, stats } = await resolvePrefixes(
      [{ sha: 'sha1', chunkText: 'chunk', context: 'ctx' }],
      { cache, model: MODEL, client }
    );
    expect(prefixes.get('sha1')).toBe('cached prefix');
    expect(client.calls).toBe(0);
    expect(stats.cacheHits).toBe(1);
    expect(stats.generated).toBe(0);
    expect(cache.putCalls).toBe(0);
  });

  test('cache miss → one call, result cached', async () => {
    const cache = new FakePrefixCache();
    const client = new FakePrefixClient('ok');
    const { prefixes, stats } = await resolvePrefixes(
      [{ sha: 'sha1', chunkText: 'chunk', context: 'ctx' }],
      { cache, model: MODEL, client }
    );
    expect(prefixes.get('sha1')).toBe('a situating prefix');
    expect(client.calls).toBe(1);
    expect(stats.generated).toBe(1);
    expect(stats.promptTokens).toBe(100);
    expect(stats.completionTokens).toBe(20);
    // Second run is a pure cache hit — proves the prefix was persisted.
    const client2 = new FakePrefixClient('ok');
    const again = await resolvePrefixes([{ sha: 'sha1', chunkText: 'chunk', context: 'ctx' }], {
      cache,
      model: MODEL,
      client: client2,
    });
    expect(client2.calls).toBe(0);
    expect(again.stats.cacheHits).toBe(1);
  });

  test('client always throws → sha absent from map, fallback counted, nothing cached', async () => {
    const cache = new FakePrefixCache();
    const client = new FakePrefixClient('throw');
    const { prefixes, stats } = await resolvePrefixes(
      [{ sha: 'sha1', chunkText: 'chunk', context: 'ctx' }],
      { cache, model: MODEL, client }
    );
    expect(prefixes.has('sha1')).toBe(false);
    expect(stats.fallbacks).toBe(1);
    expect(stats.generated).toBe(0);
    expect(cache.putCalls).toBe(0);
  });

  test('empty response → fallback, nothing cached', async () => {
    const cache = new FakePrefixCache();
    const client = new FakePrefixClient('empty');
    const { prefixes, stats } = await resolvePrefixes(
      [{ sha: 'sha1', chunkText: 'chunk', context: 'ctx' }],
      { cache, model: MODEL, client }
    );
    expect(prefixes.has('sha1')).toBe(false);
    expect(stats.fallbacks).toBe(1);
    expect(cache.putCalls).toBe(0);
  });

  test('deduped by sha: one call for a repeated sha', async () => {
    const cache = new FakePrefixCache();
    const client = new FakePrefixClient('ok');
    const { prefixes, stats } = await resolvePrefixes(
      [
        { sha: 'sha1', chunkText: 'chunk', context: 'ctx-a' },
        { sha: 'sha1', chunkText: 'chunk', context: 'ctx-b' },
      ],
      { cache, model: MODEL, client }
    );
    expect(client.calls).toBe(1);
    expect(stats.generated).toBe(1);
    expect(prefixes.size).toBe(1);
  });
});

describe('buildTrajectoryContext', () => {
  test('renders user, assistant, and tool lines', async () => {
    const ctx = buildTrajectoryContext(
      traj({
        userMessage: 'fix the bug',
        assistantBlocks: ['looking now'],
        toolCalls: [{ name: 'Bash', input: {}, output: 'ok' }],
      })
    );
    expect(ctx).toBe('USER: fix the bug\nASSISTANT: looking now\nTOOL Bash: ok');
  });

  test('head+tail truncation: input > 8k chars keeps first 6k and last 2k', async () => {
    const big = 'x'.repeat(20_000);
    const rendered = `USER: ${big}`;
    const ctx = buildTrajectoryContext(traj({ userMessage: big }));
    expect(ctx.length).toBeLessThan(rendered.length);
    expect(ctx.slice(0, CONTEXT_HEAD_CHARS)).toBe(rendered.slice(0, CONTEXT_HEAD_CHARS));
    expect(ctx.slice(-CONTEXT_TAIL_CHARS)).toBe(rendered.slice(-CONTEXT_TAIL_CHARS));
    expect(ctx).toContain('[truncated]');
  });

  test('short input passes through untouched', async () => {
    const ctx = buildTrajectoryContext(traj({ userMessage: 'hi' }));
    expect(ctx).toBe('USER: hi');
  });
});

describe('generatePrefix', () => {
  test('trims and returns usage', async () => {
    const client = new FakePrefixClient('ok', '  spaced prefix  ');
    const r = await generatePrefix(client, MODEL, 'ctx', 'chunk');
    expect(r.prefix).toBe('spaced prefix');
    expect(r.promptTokens).toBe(100);
    expect(r.completionTokens).toBe(20);
  });

  test('prefix longer than MAX_PREFIX_CHARS is truncated', async () => {
    const long = 'p'.repeat(MAX_PREFIX_CHARS + 200);
    const client = new FakePrefixClient('ok', long);
    const r = await generatePrefix(client, MODEL, 'ctx', 'chunk');
    expect(r.prefix.length).toBe(MAX_PREFIX_CHARS);
  });

  test('empty response throws', async () => {
    const client = new FakePrefixClient('empty');
    await expect(generatePrefix(client, MODEL, 'ctx', 'chunk')).rejects.toThrow('empty prefix response');
  });
});
