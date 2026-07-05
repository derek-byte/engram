import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempStore, type TempStore } from '../ingest/testkit.ts';
import { LocalStore, RECENTS_CAP } from './local.ts';

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

// A demand store paired with a raw second connection to the same file, so tests
// can count rows regardless of retention window and backdate ts for prune.
interface DemandStore {
  store: LocalStore;
  raw: Database;
  cleanup: () => void;
}

function demandStore(): DemandStore {
  const path = join(tmpdir(), `engram-demand-${crypto.randomUUID()}.sqlite`);
  const store = new LocalStore(path);
  const raw = new Database(path);
  return {
    store,
    raw,
    cleanup: () => {
      store.close();
      raw.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(path + suffix);
        } catch {
          // best effort
        }
      }
    },
  };
}

function countDemand(raw: Database, where = '1=1'): number {
  return raw.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM demand_log WHERE ${where}`).get()!.c;
}

describe('LocalStore demand_log', () => {
  let d: DemandStore;
  beforeEach(() => { d = demandStore(); });
  afterEach(() => d.cleanup());

  test('insert: one row per logged event with fields round-tripping', () => {
    d.store.logDemand({
      surface: 'ui',
      kind: 'ask',
      query: 'how does pgvector hybrid search work',
      tier: 'synth',
      repo: 'engram',
      resultCount: 8,
      topSimilarity: 0.72,
      topTier: 'wiki',
      topSessionId: 'sess-1',
      outcome: 'answered',
      citedCount: 3,
    });
    expect(countDemand(d.raw)).toBe(1);
    const row = d.raw.query<Record<string, unknown>, []>('SELECT * FROM demand_log').get()!;
    expect(row.surface).toBe('ui');
    expect(row.kind).toBe('ask');
    expect(row.tier).toBe('synth');
    expect(row.result_count).toBe(8);
    expect(row.top_similarity).toBeCloseTo(0.72);
    expect(row.top_session_id).toBe('sess-1');
    expect(row.outcome).toBe('answered');
    expect(row.cited_count).toBe(3);
  });

  test('insert: optional fields default to NULL', () => {
    d.store.logDemand({ surface: 'cli', kind: 'search', query: 'q' });
    const row = d.raw.query<Record<string, unknown>, []>('SELECT * FROM demand_log').get()!;
    expect(row.tier).toBeNull();
    expect(row.repo).toBeNull();
    expect(row.result_count).toBeNull();
    expect(row.top_similarity).toBeNull();
    expect(row.top_session_id).toBeNull();
    expect(row.outcome).toBeNull();
    expect(row.cited_count).toBeNull();
  });

  test('search-as-you-type prefix refinement collapses to one row', () => {
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'pgvec', resultCount: 1 });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'pgvect', resultCount: 2 });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'pgvector', resultCount: 5, topSimilarity: 0.9 });
    expect(countDemand(d.raw)).toBe(1);
    const row = d.raw.query<Record<string, unknown>, []>('SELECT * FROM demand_log').get()!;
    expect(row.query).toBe('pgvector');
    expect(row.result_count).toBe(5); // latest fields win
    expect(row.top_similarity).toBeCloseTo(0.9);
  });

  test('consecutive-identical searches collapse to one row', () => {
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'foo' });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'foo' });
    expect(countDemand(d.raw)).toBe(1);
  });

  test('non-prefix searches each append', () => {
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'alpha' });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'beta' });
    expect(countDemand(d.raw)).toBe(2);
  });

  test('ask rows never collapse — one row per ask', () => {
    d.store.logDemand({ surface: 'cli', kind: 'ask', query: 'same', outcome: 'answered' });
    d.store.logDemand({ surface: 'cli', kind: 'ask', query: 'same', outcome: 'not_covered' });
    expect(countDemand(d.raw, "kind = 'ask'")).toBe(2);
  });

  test('an ask row between searches does not block prefix collapse', () => {
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'pg' });
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'unrelated', outcome: 'answered' });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'pgvector' });
    expect(countDemand(d.raw, "kind = 'search'")).toBe(1);
    expect(countDemand(d.raw)).toBe(2); // search collapsed to 1, plus the ask
  });

  test('90-day prune drops rows older than the window on write', () => {
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'old', outcome: 'answered' });
    // Backdate the row past the retention window via the raw connection.
    d.raw.query("UPDATE demand_log SET ts = datetime('now', '-100 days')").run();
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'new', outcome: 'answered' });
    expect(countDemand(d.raw)).toBe(1);
    expect(d.raw.query<{ query: string }, []>('SELECT query FROM demand_log').get()!.query).toBe('new');
  });

  test('unmetDemand groups by normalized query, counts, and picks best session', () => {
    // Three casings of one unmet ask; highest-similarity row supplies the session.
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'Deploy pipeline', outcome: 'no_candidates' });
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'deploy pipeline', outcome: 'not_covered', topSimilarity: 0.1, topSessionId: 'sess-A' });
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'deploy Pipeline', outcome: 'not_covered', topSimilarity: 0.3, topSessionId: 'sess-B' });
    // Answered ask is met → excluded.
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'other thing', outcome: 'answered', topSimilarity: 0.9 });
    // Unmet searches: zero-hit and weak-hit; good-hit is met.
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'search miss', resultCount: 0, topSessionId: 'sess-C' });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'weak hit', resultCount: 5, topSimilarity: 0.2, topSessionId: 'sess-D' });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'good hit', resultCount: 5, topSimilarity: 0.8, topSessionId: 'sess-E' });

    const unmet = d.store.unmetDemand(30);
    expect(unmet.length).toBe(3);
    // Most-demanded first.
    expect(unmet[0]!.query).toBe('deploy pipeline');
    expect(unmet[0]!.count).toBe(3);
    expect(unmet[0]!.topSessionId).toBe('sess-B'); // highest top_similarity in group
    const keys = unmet.map((u) => u.query).sort();
    expect(keys).toEqual(['deploy pipeline', 'search miss', 'weak hit']);
    expect(unmet.find((u) => u.query === 'good hit')).toBeUndefined();
    expect(unmet.find((u) => u.query === 'other thing')).toBeUndefined();
  });

  test('unmetDemand honors the days window', () => {
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'stale', outcome: 'no_candidates' });
    d.raw.query("UPDATE demand_log SET ts = datetime('now', '-40 days')").run();
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'fresh', outcome: 'no_candidates' });
    expect(d.store.unmetDemand(30).map((u) => u.query)).toEqual(['fresh']);
    expect(d.store.unmetDemand(60).map((u) => u.query).sort()).toEqual(['fresh', 'stale']);
  });

  test('demandSummary counts totals, kinds, and unmet volume', () => {
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'Deploy pipeline', outcome: 'no_candidates' });
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'deploy pipeline', outcome: 'not_covered', topSimilarity: 0.1, topSessionId: 'sess-A' });
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'deploy Pipeline', outcome: 'not_covered', topSimilarity: 0.3, topSessionId: 'sess-B' });
    d.store.logDemand({ surface: 'ui', kind: 'ask', query: 'other thing', outcome: 'answered', topSimilarity: 0.9 });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'search miss', resultCount: 0 });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'weak hit', resultCount: 5, topSimilarity: 0.2 });
    d.store.logDemand({ surface: 'ui', kind: 'search', query: 'good hit', resultCount: 5, topSimilarity: 0.8 });

    const s = d.store.demandSummary(30);
    expect(s.days).toBe(30);
    expect(s.total).toBe(7);
    expect(s.asks).toBe(4);
    expect(s.searches).toBe(3);
    expect(s.unmet).toBe(5); // 3 unmet asks + 2 unmet searches
    expect(s.unmetQueries).toBe(3);
  });
});
