import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlPrefixCache } from './prefixcache.ts';

const MODEL = 'gpt-4o-mini';

// Tests write under a tmpdir, never benchmarks/.cache/.
let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prefixcache-'));
  path = join(dir, 'nested', 'prefix-cache.jsonl'); // nested → exercises mkdir
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('JsonlPrefixCache', () => {
  test('roundtrip: put then get on a fresh reopen', async () => {
    const c1 = new JsonlPrefixCache(path);
    await c1.putCachedPrefixes([{ sha: 'a', prefix: 'prefix a' }], MODEL);

    const c2 = new JsonlPrefixCache(path);
    const got = await c2.getCachedPrefixes(['a', 'b'], MODEL);
    expect(got.get('a')).toBe('prefix a');
    expect(got.has('b')).toBe(false);
  });

  test('missing file → empty map', async () => {
    const c = new JsonlPrefixCache(path);
    const got = await c.getCachedPrefixes(['a'], MODEL);
    expect(got.size).toBe(0);
  });

  test('corrupt line tolerated; valid lines still load', async () => {
    const c1 = new JsonlPrefixCache(path);
    await c1.putCachedPrefixes([{ sha: 'a', prefix: 'prefix a' }], MODEL);
    appendFileSync(path, '{ this is not json\n');
    await c1.putCachedPrefixes([{ sha: 'b', prefix: 'prefix b' }], MODEL);

    const c2 = new JsonlPrefixCache(path);
    const got = await c2.getCachedPrefixes(['a', 'b'], MODEL);
    expect(got.get('a')).toBe('prefix a');
    expect(got.get('b')).toBe('prefix b');
  });

  test('model-key isolation: same sha under a different model does not collide', async () => {
    const c = new JsonlPrefixCache(path);
    await c.putCachedPrefixes([{ sha: 'a', prefix: 'from mini' }], MODEL);
    await c.putCachedPrefixes([{ sha: 'a', prefix: 'from other' }], 'other-model');

    expect((await c.getCachedPrefixes(['a'], MODEL)).get('a')).toBe('from mini');
    expect((await c.getCachedPrefixes(['a'], 'other-model')).get('a')).toBe('from other');
  });

  test('append-once: re-putting a key does not duplicate or overwrite', async () => {
    const c1 = new JsonlPrefixCache(path);
    await c1.putCachedPrefixes([{ sha: 'a', prefix: 'first' }], MODEL);
    await c1.putCachedPrefixes([{ sha: 'a', prefix: 'second' }], MODEL);

    const c2 = new JsonlPrefixCache(path);
    expect((await c2.getCachedPrefixes(['a'], MODEL)).get('a')).toBe('first');
  });
});
