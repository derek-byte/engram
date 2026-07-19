import { describe, expect, test } from 'bun:test';
import type { Chunk } from '../types/index.ts';
import { buildTranscript } from './prompt.ts';

function chunk(content: string): Chunk {
  return {
    id: content.slice(0, 8),
    content,
    metadata: {
      repo: 'engram',
      branch: 'main',
      timestamp: new Date('2026-06-01T00:00:00Z'),
      filePaths: [],
      exitCode: null,
      sessionId: 's1',
      cwd: '',
      tier: 'raw',
    },
  };
}

describe('buildTranscript', () => {
  test('under cap → byte-identical to the joined chunk text', () => {
    const chunks = [chunk('alpha'), chunk('bravo'), chunk('charlie')];
    const joined = 'alpha\n---\nbravo\n---\ncharlie';
    expect(buildTranscript(chunks, 10_000)).toBe(joined);
    // Exactly at the cap is still byte-identical (no truncation branch).
    expect(buildTranscript(chunks, joined.length)).toBe(joined);
  });

  test('oversized → keeps BOTH ends: head + tail sentinels survive, marker between', () => {
    const START = 'START_SENTINEL_XYZ';
    const END = 'END_SENTINEL_XYZ';
    // START near the front, END near the back, bulk filler between so the middle
    // is what gets elided.
    const body = `${START} ${'filler '.repeat(5000)} ${END}`;
    const maxChars = 2000;
    const out = buildTranscript([chunk(body)], maxChars);

    expect(out.length).toBe(maxChars); // exact bound
    expect(out).toContain(START); // head preserved
    expect(out).toContain(END); // tail preserved (the old slice(0,n) dropped this)
    expect(out).toContain('[... transcript elided ...]');
    // The bulk middle is gone — output is far shorter than the source.
    expect(out.length).toBeLessThan(body.length);
  });

  test('length bound holds across odd/even budgets', () => {
    const body = 'x'.repeat(100_000);
    for (const maxChars of [1000, 1001, 4096, 60_001]) {
      expect(buildTranscript([chunk(body)], maxChars).length).toBe(maxChars);
    }
  });
});
