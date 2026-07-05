import { describe, expect, test } from 'bun:test';
import {
  CHARS_PER_TOKEN,
  HARD_CAP_TOKENS,
  chunkMessages,
  chunkText,
  chunkTrajectory,
  overlapTail,
} from './chunker.ts';
import type { RawMessage } from './parser.ts';
import { genTrajectory, rng } from './testkit.ts';

function msg(partial: Partial<RawMessage> & Pick<RawMessage, 'type' | 'content'>): RawMessage {
  return {
    uuid: crypto.randomUUID(),
    parentUuid: null,
    timestamp: new Date(1_700_000_000_000),
    sessionId: 's',
    cwd: '/tmp/engram',
    branch: 'main',
    ...partial,
  };
}

const MAX_CHUNK_CHARS = HARD_CAP_TOKENS * CHARS_PER_TOKEN;

describe('chunkTrajectory invariants (property-style)', () => {
  test('no chunk exceeds the hard cap, over varied + oversized trajectories', () => {
    const next = rng(1);
    for (let i = 0; i < 400; i++) {
      // Mostly normal, occasionally huge to exercise the hard-split pass.
      const scale = i % 20 === 0 ? 60 : 1 + next() * 4;
      const chunks = chunkTrajectory(genTrajectory(next, scale));
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  test('no empty or whitespace-only chunks', () => {
    const next = rng(2);
    for (let i = 0; i < 400; i++) {
      const chunks = chunkTrajectory(genTrajectory(next, 1 + next() * 5));
      for (const c of chunks) expect(c.trim().length).toBeGreaterThan(0);
    }
  });

  test('adjacent chunks overlap: chunk[i+1] carries the tail of chunk[i]', () => {
    const next = rng(3);
    let sawMulti = false;
    for (let i = 0; i < 400; i++) {
      // scale <= a few keeps every chunk under the hard cap, so the final
      // hard-split pass is a no-op and the overlap seam is preserved verbatim.
      const chunks = chunkTrajectory(genTrajectory(next, 1 + next() * 3));
      for (const c of chunks) {
        if (c.length > MAX_CHUNK_CHARS) throw new Error('unexpected hard-split in overlap regime');
      }
      if (chunks.length >= 2) {
        sawMulti = true;
        for (let j = 0; j + 1 < chunks.length; j++) {
          const overlap = overlapTail(chunks[j]!);
          expect(overlap.length).toBeGreaterThan(0);
          expect(chunks[j + 1]!.startsWith(overlap)).toBe(true);
        }
      }
    }
    expect(sawMulti).toBe(true);
  });

  test('tiny trajectory yields exactly one chunk', () => {
    const chunks = chunkTrajectory({
      sessionId: 's',
      repo: 'r',
      branch: 'b',
      cwd: '/c',
      timestamp: new Date(),
      userMessage: 'hello world',
      assistantBlocks: [],
      toolCalls: [],
      filePaths: [],
      artifacts: [],
      exitCode: null,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('USER: hello world');
  });
});

describe('chunkMessages artifact extraction', () => {
  test('acceptance: Write + Read + Bash(pr URL + localhost) → [file, pr] on the trajectory', () => {
    const messages: RawMessage[] = [
      msg({ type: 'user', content: [{ type: 'text', text: 'ship the change' }] }),
      msg({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/src/x.ts' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/src/y.ts' } },
          { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'gh pr create' } },
        ],
      }),
      msg({
        type: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 't3',
            content: 'https://github.com/acme/engram/pull/12\npreview http://localhost:3000/x',
          },
        ],
      }),
    ];

    const [traj] = chunkMessages(messages);
    expect(traj!.artifacts).toEqual([
      { kind: 'file', ref: '/src/x.ts', tool: 'Write' },
      { kind: 'pr', ref: 'https://github.com/acme/engram/pull/12', tool: 'Bash' },
    ]);
    // The parallel filePaths field stays tool-name-blind (untouched behaviour).
    expect(new Set(traj!.filePaths)).toEqual(new Set(['/src/x.ts', '/src/y.ts']));
  });

  test('URLs are extracted from the FULL output, before the 2000-char truncation', () => {
    const url = 'https://github.com/acme/engram/pull/777';
    // Push the URL past the 2000-char truncation boundary in the output.
    const output = 'x'.repeat(2100) + ' ' + url;
    const messages: RawMessage[] = [
      msg({ type: 'user', content: [{ type: 'text', text: 'run it' }] }),
      msg({
        type: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh pr view' } }],
      }),
      msg({ type: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: output }] }),
    ];

    const [traj] = chunkMessages(messages);
    expect(traj!.artifacts).toEqual([{ kind: 'pr', ref: url, tool: 'Bash' }]);
    // The stored tool output is truncated, proving extraction ran on the full content.
    expect(traj!.toolCalls[0]!.output).toContain('[truncated');
  });
});

describe('chunkText', () => {
  test('whitespace-only content yields zero chunks', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n \t  \n')).toEqual([]);
  });

  test('tiny text yields exactly one chunk', () => {
    expect(chunkText('a short note')).toEqual(['a short note']);
  });

  test('no chunk exceeds the hard cap over varied generated text', () => {
    const next = rng(4);
    for (let i = 0; i < 200; i++) {
      const paras: string[] = [];
      const n = 1 + Math.floor(next() * 30);
      for (let p = 0; p < n; p++) {
        const len = i % 15 === 0 ? 30000 : Math.floor(next() * 4000);
        paras.push('x'.repeat(len));
      }
      const chunks = chunkText(paras.join('\n\n'));
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
        expect(c.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
