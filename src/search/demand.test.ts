import { describe, expect, test } from 'bun:test';
import { demandRowForSearch, demandRowForSearchError } from './index.ts';
import type { SearchResult } from '../types/index.ts';
import type { Chunk } from '../types/index.ts';

function result(similarity: number, over: Partial<Chunk['metadata']> = {}): SearchResult {
  const chunk: Chunk = {
    id: 'c-' + similarity,
    embedding: [0, 0, 0, 0],
    content: 'content',
    metadata: {
      repo: 'engram',
      branch: 'main',
      timestamp: new Date('2026-07-01T00:00:00Z'),
      filePaths: [],
      exitCode: null,
      sessionId: 'sess-1',
      cwd: '/tmp',
      owner: 'test',
      tier: 'dream',
      ...over,
    },
  };
  return { chunk, similarity, keywordRank: 0, combined: similarity };
}

// The canonical search demand row, shared by CLI/MCP/UI — one builder so the
// three surfaces can never drift on shape again (they had already drifted:
// the UI row omitted repo, the UI error row omitted outcome).
describe('demandRowForSearch', () => {
  test('top_* come from the best hit', () => {
    const row = demandRowForSearch('mcp', 'how do we chunk', 'synth', 'engram', [
      result(0.91, { tier: 'wiki', sessionId: 'sess-top' }),
      result(0.5),
    ]);
    expect(row).toEqual({
      surface: 'mcp',
      kind: 'search',
      query: 'how do we chunk',
      tier: 'synth',
      repo: 'engram',
      resultCount: 2,
      topSimilarity: 0.91,
      topTier: 'wiki',
      topSessionId: 'sess-top',
    });
  });

  test('zero-hit row leaves top_* null and has no outcome (a genuine miss, not an error)', () => {
    const row = demandRowForSearch('cli', 'missing topic', 'all', null, []);
    expect(row.resultCount).toBe(0);
    expect(row.topSimilarity).toBeNull();
    expect(row.topTier).toBeNull();
    expect(row.topSessionId).toBeNull();
    expect(row.outcome).toBeUndefined();
  });

  test('error variant carries outcome error and zero stats', () => {
    const row = demandRowForSearchError('ui', 'broken query', 'raw', null);
    expect(row).toEqual({
      surface: 'ui',
      kind: 'search',
      query: 'broken query',
      tier: 'raw',
      repo: null,
      resultCount: 0,
      outcome: 'error',
    });
  });
});
