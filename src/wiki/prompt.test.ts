import { describe, expect, test } from 'bun:test';
import { WIKI_SYSTEM_PROMPT, WIKI_SPLIT_SYSTEM_PROMPT, buildUnitHeader, buildCandidatesText, buildCorrectionText, buildIngestUser } from './prompt.ts';
import type { SynthesisUnit } from '../storage/backend.ts';
import type { WikiPage } from './store.ts';

// Guards against accidental deletion of the reconciliation / anti-contamination
// rules (their real behavior is verified by the live test).
describe('WIKI_SYSTEM_PROMPT', () => {
  test('carries the recency/supersession and cross-project rules', () => {
    expect(WIKI_SYSTEM_PROMPT).toContain('RECENCY');
    expect(WIKI_SYSTEM_PROMPT).toContain('Originally X');
    expect(WIKI_SYSTEM_PROMPT).toContain('never regress');
    expect(WIKI_SYSTEM_PROMPT).toContain('CROSS-PROJECT ATTRIBUTION');
  });
});

describe('WIKI_SPLIT_SYSTEM_PROMPT', () => {
  test('requires exactly one hub update + new child slugs', () => {
    expect(WIKI_SPLIT_SYSTEM_PROMPT).toContain('EXACTLY ONE op with action:"update"');
    expect(WIKI_SPLIT_SYSTEM_PROMPT).toContain('NEW slug');
  });
});

describe('buildUnitHeader', () => {
  test('includes the session date and a recency instruction', () => {
    const unit: SynthesisUnit = {
      sessionId: 'sess-x',
      repo: 'engram',
      chunkIds: ['a', 'b'],
      totalChars: 100,
      lastTimestamp: new Date('2026-05-01T12:00:00.000Z'),
    };
    const header = buildUnitHeader(unit);
    expect(header).toContain('session date 2026-05-01');
    expect(header).toContain('This session is from 2026-05-01');
  });
});

describe('buildCandidatesText', () => {
  test('exposes each candidate page freshness via an updated line', () => {
    const page: WikiPage = {
      slug: 'p', schema: 1, title: 'P', kind: 'topic', summary: 's', aliases: [],
      sources: [], trajectories: [], fingerprint: '', created: '', updated: '2026-06-15T00:00:00.000Z', body: 'x',
    };
    expect(buildCandidatesText([page], 10_000)).toContain('updated: 2026-06-15');
  });
});

describe('buildCorrectionText', () => {
  test('restates each slug with both char counts, the floor, and the full old body', () => {
    const text = buildCorrectionText([
      { slug: 'pgvector', oldLen: 1200, newLen: 40, oldBody: 'FULL OLD BODY HERE' },
      { slug: 'embedder', oldLen: 800, newLen: 30, oldBody: 'EMBEDDER BODY' },
    ]);
    expect(text).toContain('shrank pgvector from 1200 to 40 chars');
    expect(text).toContain('shrank embedder from 800 to 30 chars');
    expect(text).toContain('below the 40% floor');
    expect(text).toContain('MERGE the new knowledge');
    expect(text).toContain('FULL OLD BODY HERE');
    expect(text).toContain('Return ops ONLY for these slugs: pgvector, embedder.');
  });
});

describe('buildIngestUser', () => {
  const args = ['HDR', 'ITEMS', 'CANDS', 'INV'] as const;

  test('is byte-identical without a correction (protects prompt caching)', () => {
    expect(buildIngestUser(...args)).toBe(buildIngestUser(...args, undefined));
  });

  test('appends the correction block only when provided, as a strict suffix', () => {
    const base = buildIngestUser(...args);
    const withCorrection = buildIngestUser(...args, 'CORRECTION BLOCK');
    expect(withCorrection).toStartWith(base);
    expect(withCorrection).toContain('CORRECTION BLOCK');
    expect(withCorrection.length).toBeGreaterThan(base.length);
  });
});
