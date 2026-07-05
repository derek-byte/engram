import { describe, expect, test } from 'bun:test';
import type { Trajectory } from '../types/index.ts';
import {
  CHARS_PER_TOKEN,
  CHUNKER_VERSION,
  HARD_CAP_TOKENS,
  TARGET_TOKENS,
  TOOL_CHARS_PER_TOKEN,
  TOOL_PREFIX_MAX_CHARS,
  chunkMessages,
  chunkText,
  chunkTrajectory,
  overlapTail,
  packSegments,
  toolContextPrefix,
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

function traj(partial: Partial<Trajectory>): Trajectory {
  return {
    sessionId: 's',
    repo: 'r',
    branch: 'b',
    cwd: '/c',
    timestamp: new Date(1_700_000_000_000),
    userMessage: 'hello world',
    assistantBlocks: [],
    toolCalls: [],
    filePaths: [],
    artifacts: [],
    exitCode: null,
    ...partial,
  };
}

describe('chunkTrajectory invariants (property-style)', () => {
  test('chunker is stamped v2', () => {
    expect(CHUNKER_VERSION).toBe('v2');
  });

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

  test('adjacent prose chunks overlap: chunk[i+1] carries the tail of chunk[i]', () => {
    const next = rng(3);
    let sawMulti = false;
    for (let i = 0; i < 400; i++) {
      // Prose-only trajectories: in v2 the overlap seam exists WITHIN a role
      // class, never across the prose→tool boundary.
      const t = genTrajectory(next, 1 + next() * 3);
      const chunks = chunkTrajectory({ ...t, toolCalls: [] });
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
    const chunks = chunkTrajectory(traj({ userMessage: 'hello world' }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('USER: hello world');
  });
});

describe('chunkTrajectory v2: role-homogeneous packing', () => {
  // Word alphabets are disjoint per role class, so any cross-contamination in
  // a chunk is detectable by substring.
  function mixed(next: () => number, scale = 1): Trajectory {
    const blocks: string[] = [];
    for (let i = 0, n = 2 + next() * 5 * scale; i < n; i++) {
      blocks.push(
        Array.from({ length: 20 + Math.floor(next() * 60 * scale) }, () => 'prose' + Math.floor(next() * 1e4)).join(' ')
      );
    }
    const toolCalls = [];
    for (let i = 0, n = 2 + next() * 5 * scale; i < n; i++) {
      toolCalls.push({
        name: 'Bash',
        input: { command: Array.from({ length: 30 + Math.floor(next() * 80 * scale) }, () => 'jsonword' + Math.floor(next() * 1e4)).join(' ') },
        output: Array.from({ length: 20 + Math.floor(next() * 60 * scale) }, () => 'jsonword' + Math.floor(next() * 1e4)).join(' '),
      });
    }
    return traj({ userMessage: 'ask about the auth flow', assistantBlocks: blocks, toolCalls });
  }

  test('no chunk mixes tool payloads with prose, over varied trajectories', () => {
    const next = rng(11);
    let sawBoth = false;
    for (let i = 0; i < 200; i++) {
      const t = mixed(next, 1 + next() * 3);
      const chunks = chunkTrajectory(t);
      const prefix = toolContextPrefix(t.userMessage);
      const proseChunks = chunks.filter((c) => c.includes('prose'));
      const toolChunks = chunks.filter((c) => c.includes('jsonword'));
      if (proseChunks.length > 0 && toolChunks.length > 0) sawBoth = true;
      // Partition is exact: every chunk is one or the other, never both.
      expect(proseChunks.length + toolChunks.length).toBe(chunks.length);
      for (const c of chunks) expect(c.includes('prose') && c.includes('jsonword')).toBe(false);
      // Every tool chunk leads with the one-line USER intent prefix.
      for (const c of toolChunks) expect(c.split('\n')[0]).toBe(prefix);
    }
    expect(sawBoth).toBe(true);
  });

  test('order is preserved within each role class', () => {
    const t = traj({
      userMessage: 'q',
      assistantBlocks: ['alpha first', 'bravo second'],
      toolCalls: [
        { name: 'Read', input: { file_path: '/a' } },
        { name: 'Write', input: { file_path: '/b' } },
      ],
    });
    const chunks = chunkTrajectory(t);
    const all = chunks.join('\n');
    expect(all.indexOf('alpha first')).toBeLessThan(all.indexOf('bravo second'));
    expect(all.indexOf('TOOL Read')).toBeLessThan(all.indexOf('TOOL Write'));
  });

  test('tool chunks carry the user question truncated to ~100 chars, one line', () => {
    const longQuestion = ('explain the auth flow in detail\nand also ' + 'x'.repeat(200)).trim();
    const t = traj({
      userMessage: longQuestion,
      toolCalls: [{ name: 'Bash', input: { command: 'grep -r auth src' }, output: 'src/auth.ts' }],
    });
    const chunks = chunkTrajectory(t);
    const toolChunk = chunks.find((c) => c.includes('TOOL Bash'))!;
    const firstLine = toolChunk.split('\n')[0]!;
    expect(firstLine.startsWith('USER: explain the auth flow in detail and also ')).toBe(true); // newline collapsed
    expect(firstLine.endsWith('…')).toBe(true);
    expect(firstLine.length).toBeLessThanOrEqual('USER: '.length + TOOL_PREFIX_MAX_CHARS + 1);
  });

  test('trajectory without tool calls emits no prefix line', () => {
    const chunks = chunkTrajectory(traj({ userMessage: 'just chatting', assistantBlocks: ['sure'] }));
    expect(chunks).toEqual(['USER: just chatting\nASSISTANT: sure']);
  });
});

describe('v2 token targets', () => {
  test('JSON-dense tool chunks respect the 3-chars/token budget', () => {
    const next = rng(12);
    // 40 fat JSON tool calls (~1200 chars each) force many tool chunks.
    const toolCalls = Array.from({ length: 40 }, (_, i) => ({
      name: 'Bash',
      input: { command: `cmd-${i} ` + Array.from({ length: 150 }, () => '"k":' + Math.floor(next() * 1e6)).join(',') },
      output: Array.from({ length: 40 }, () => 'out' + Math.floor(next() * 1e6)).join(' '),
    }));
    const t = traj({ userMessage: 'run the sweep', toolCalls });
    const chunks = chunkTrajectory(t);
    const toolChunks = chunks.filter((c) => c.includes('TOOL Bash'));
    expect(toolChunks.length).toBeGreaterThan(5);
    // Packing closes a chunk once it would pass TARGET_TOKENS; segments are
    // pre-split to <= 1.2x target, so a chunk never exceeds 2.2x target — at
    // the TOOL rate of 3 chars/token, plus the one-line USER prefix.
    // + prefix line + a few join newlines the per-segment estimate doesn't count.
    const maxChars = Math.ceil(TARGET_TOKENS * 2.2) * TOOL_CHARS_PER_TOKEN + 'USER: run the sweep\n'.length + 16;
    for (const c of toolChunks) expect(c.length).toBeLessThanOrEqual(maxChars);
  });

  test('prose chunks land near TARGET_TOKENS at the 4-chars/token rate', () => {
    const next = rng(13);
    const blocks = Array.from({ length: 30 }, () =>
      Array.from({ length: 120 }, () => 'word' + Math.floor(next() * 1e5)).join(' ')
    );
    const chunks = chunkTrajectory(traj({ userMessage: 'q', assistantBlocks: blocks }));
    expect(chunks.length).toBeGreaterThan(5);
    const maxChars = Math.ceil(TARGET_TOKENS * 2.2) * CHARS_PER_TOKEN;
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(maxChars);
  });
});

describe('hardSplit safety (via packSegments)', () => {
  test('surrogate pairs are never split: emoji-only oversized segment', () => {
    // ~4000 chars of emoji with no space/newline anywhere: the backoff window
    // finds nothing, forcing the raw cut path where the surrogate guard lives.
    // The leading 'a' offsets the pairs so the raw cut lands MID-pair.
    const emoji = 'a' + '\u{1F600}'.repeat(2000);
    const pieces = packSegments([emoji]);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.isWellFormed()).toBe(true);
      // Well-formed via boundary adjustment, not via U+FFFD replacement.
      expect(p.includes('�')).toBe(false);
    }
  });

  test('cuts back off to a word boundary instead of slicing mid-word', () => {
    const next = rng(14);
    const vocab = Array.from({ length: 400 }, (_, i) => `word${i}x${Math.floor(next() * 1e6)}`);
    const text = vocab.join(' '); // one huge segment, far beyond MAX_SEGMENT_TOKENS
    const chunks = packSegments([text]);
    expect(chunks.length).toBeGreaterThan(1);
    const allowed = new Set(vocab);
    for (const c of chunks) {
      for (const w of c.split(/\s+/).filter((w) => w.length > 0)) {
        expect(allowed.has(w)).toBe(true); // every token is an intact word
      }
    }
  });

  test('overlapTail never starts inside a surrogate pair', () => {
    const text = 'a'.repeat(10) + '\u{1F600}'.repeat(500);
    const tail = overlapTail(text);
    expect(tail.isWellFormed()).toBe(true);
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
