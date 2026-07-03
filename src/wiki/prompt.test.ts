import { describe, expect, test } from 'bun:test';
import { WIKI_SYSTEM_PROMPT, WIKI_SPLIT_SYSTEM_PROMPT, buildUnitHeader, buildCandidatesText } from './prompt.ts';
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
