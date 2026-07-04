import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tempStore, type TempStore } from '../ingest/testkit.ts';
import { RECENTS_CAP } from './local.ts';

describe('LocalStore recents', () => {
  let t: TempStore;
  beforeEach(() => { t = tempStore(); });
  afterEach(() => t.cleanup());

  test('recency order: newest first', () => {
    const s = t.store;
    s.logRecent('search', 'alpha', 'alpha');
    s.logRecent('search', 'beta', 'beta');
    s.logRecent('search', 'gamma', 'gamma');
    expect(s.getRecents().map((r) => r.key)).toEqual(['gamma', 'beta', 'alpha']);
  });

  test('consecutive-identical searches dedupe to one row', () => {
    const s = t.store;
    s.logRecent('search', 'foo', 'foo');
    s.logRecent('search', 'foo', 'foo');
    s.logRecent('search', 'foo', 'foo');
    const rows = s.getRecents();
    expect(rows.length).toBe(1);
    expect(rows[0]!.key).toBe('foo');
  });

  test('search-as-you-type prefix refinement replaces in place', () => {
    const s = t.store;
    s.logRecent('search', 'pgvec', 'pgvec');
    s.logRecent('search', 'pgvect', 'pgvect');
    s.logRecent('search', 'pgvector', 'pgvector');
    const rows = s.getRecents();
    expect(rows.length).toBe(1);
    expect(rows[0]!.key).toBe('pgvector');
  });

  test('non-consecutive duplicate searches are both kept', () => {
    const s = t.store;
    s.logRecent('search', 'a', 'a');
    s.logRecent('search', 'b', 'b');
    s.logRecent('search', 'a', 'a');
    const rows = s.getRecents();
    expect(rows.length).toBe(3);
    expect(rows[0]!.key).toBe('a');
    expect(rows[1]!.key).toBe('b');
  });

  test('prefix rule is search-only; views never collapse by prefix', () => {
    const s = t.store;
    s.logRecent('view', 'wiki:a', 'A');
    s.logRecent('view', 'wiki:abc', 'ABC');
    const rows = s.getRecents();
    expect(rows.length).toBe(2);
  });

  test('view and search kinds do not dedupe across each other', () => {
    const s = t.store;
    s.logRecent('search', 'x', 'x');
    s.logRecent('view', 'x', 'x');
    expect(s.getRecents().length).toBe(2);
  });

  test('cap trims to the newest RECENTS_CAP rows, oldest dropped', () => {
    const s = t.store;
    for (let i = 0; i < RECENTS_CAP + 5; i++) s.logRecent('search', 'q-' + i, 'q-' + i);
    const rows = s.getRecents(1000);
    expect(rows.length).toBe(RECENTS_CAP);
    expect(rows[0]!.key).toBe('q-' + (RECENTS_CAP + 4)); // newest
    expect(rows.some((r) => r.key === 'q-0')).toBe(false); // oldest dropped
  });

  test('getRecents honors the limit', () => {
    const s = t.store;
    for (let i = 0; i < 10; i++) s.logRecent('search', 'k' + i, 'k' + i);
    expect(s.getRecents(3).length).toBe(3);
  });
});
