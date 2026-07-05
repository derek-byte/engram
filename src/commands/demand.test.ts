import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demandCommand } from './demand.ts';
import { LocalStore } from '../storage/local.ts';

describe('demandCommand --json', () => {
  let path: string;
  let store: LocalStore;
  let logSpy: typeof console.log;
  let captured: string[];

  beforeEach(() => {
    path = join(tmpdir(), `engram-demand-cmd-${crypto.randomUUID()}.sqlite`);
    store = new LocalStore(path);
    captured = [];
    logSpy = console.log;
    console.log = (...a: unknown[]) => {
      captured.push(a.join(' '));
    };
  });

  afterEach(() => {
    console.log = logSpy;
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(path + suffix);
      } catch {
        // best effort
      }
    }
  });

  function parseJson() {
    return JSON.parse(captured.join('\n'));
  }

  test('emits {summary, unmet} with grouped unmet demand', async () => {
    // Two unmet asks for the same normalized query + one met ask + one unmet search.
    store.logDemand({ surface: 'cli', kind: 'ask', query: 'How does HNSW work', outcome: 'not_covered', resultCount: 3, citedCount: 0 });
    store.logDemand({ surface: 'mcp', kind: 'ask', query: 'how does hnsw work', outcome: 'no_candidates', topSessionId: 'sess-1', topSimilarity: 0.2 });
    store.logDemand({ surface: 'cli', kind: 'ask', query: 'why pgvector', outcome: 'answered', citedCount: 2 });
    store.logDemand({ surface: 'ui', kind: 'search', query: 'obscure thing', resultCount: 0 });

    await demandCommand({ days: '30', json: true }, store);

    const out = parseJson();
    expect(out.summary.days).toBe(30);
    expect(out.summary.total).toBe(4);
    expect(out.summary.asks).toBe(3);
    expect(out.summary.searches).toBe(1);
    // unmet raw rows: 2 asks (not_covered + no_candidates) + 1 zero-hit search = 3
    expect(out.summary.unmet).toBe(3);
    // distinct normalized queries: "how does hnsw work" + "obscure thing" = 2
    expect(out.summary.unmetQueries).toBe(2);

    expect(Array.isArray(out.unmet)).toBe(true);
    const hnsw = out.unmet.find((u: { query: string }) => u.query === 'how does hnsw work');
    expect(hnsw.count).toBe(2);
    expect(hnsw.topSessionId).toBe('sess-1');
  });

  test('empty demand log → summary with zero unmet', async () => {
    await demandCommand({ days: '7', json: true }, store);
    const out = parseJson();
    expect(out.summary.days).toBe(7);
    expect(out.summary.total).toBe(0);
    expect(out.unmet).toEqual([]);
  });
});
