import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Trajectory } from '../types/index.ts';
import { trajectoryHash } from './hash.ts';
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
    thinkingBlocks: [],
    images: [],
    toolCalls: [],
    filePaths: [],
    artifacts: [],
    exitCode: null,
    ...partial,
  };
}

describe('chunkTrajectory invariants (property-style)', () => {
  test('chunker is stamped v3', () => {
    expect(CHUNKER_VERSION).toBe('v3');
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
      // Prose-only: strip thinking + tool so the only seam is the within-prose overlap.
      const chunks = chunkTrajectory({ ...t, thinkingBlocks: [], toolCalls: [] });
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
    const thinkingBlocks: string[] = [];
    for (let i = 0, n = 2 + next() * 5 * scale; i < n; i++) {
      thinkingBlocks.push(
        Array.from({ length: 20 + Math.floor(next() * 60 * scale) }, () => 'thinkword' + Math.floor(next() * 1e4)).join(' ')
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
    return traj({ userMessage: 'ask about the auth flow', assistantBlocks: blocks, thinkingBlocks, toolCalls });
  }

  test('no chunk mixes prose, thinking, and tool payloads, over varied trajectories', () => {
    const next = rng(11);
    let sawAll = false;
    for (let i = 0; i < 200; i++) {
      const t = mixed(next, 1 + next() * 3);
      const chunks = chunkTrajectory(t);
      const prefix = toolContextPrefix(t.userMessage);
      const proseChunks = chunks.filter((c) => c.includes('prose'));
      const thinkChunks = chunks.filter((c) => c.includes('thinkword'));
      const toolChunks = chunks.filter((c) => c.includes('jsonword'));
      if (proseChunks.length > 0 && thinkChunks.length > 0 && toolChunks.length > 0) sawAll = true;
      // Partition is exact: every chunk belongs to exactly one role class.
      expect(proseChunks.length + thinkChunks.length + toolChunks.length).toBe(chunks.length);
      for (const c of chunks) {
        const kinds = [c.includes('prose'), c.includes('thinkword'), c.includes('jsonword')].filter(Boolean);
        expect(kinds.length).toBeLessThanOrEqual(1);
      }
      // Every thinking + tool chunk leads with the one-line USER intent prefix.
      for (const c of thinkChunks) expect(c.split('\n')[0]).toBe(prefix);
      for (const c of toolChunks) expect(c.split('\n')[0]).toBe(prefix);
    }
    expect(sawAll).toBe(true);
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

describe('chunkTrajectory v3: thinking + images', () => {
  test('thinking renders as USER: …\\nTHINKING: … with the one-line intent prefix', () => {
    const t = traj({ userMessage: 'why is auth failing', thinkingBlocks: ['the token is expired'] });
    const chunks = chunkTrajectory(t);
    const thinkChunk = chunks.find((c) => c.includes('THINKING:'))!;
    expect(thinkChunk).toBeDefined();
    const lines = thinkChunk.split('\n');
    expect(lines[0]).toBe('USER: why is auth failing'); // the intent prefix
    expect(lines[1]).toBe('THINKING: the token is expired');
    // Thinking is its own class — the prose chunk holds no THINKING material.
    const proseChunk = chunks.find((c) => c.startsWith('USER: why is auth failing') && !c.includes('THINKING:'));
    expect(proseChunk).toBeDefined();
  });

  test('an image renders as IMAGE: <caption> inside a prose chunk', () => {
    const t = traj({
      userMessage: 'look at this',
      images: [{ sha256: 'abc', mediaType: 'image/png', bytes: 214 * 1024, caption: 'a login error dialog' }],
    });
    const chunks = chunkTrajectory(t);
    const proseChunk = chunks.find((c) => c.startsWith('USER: look at this'))!;
    expect(proseChunk).toContain('IMAGE: a login error dialog');
  });

  test('an uncaptioned image falls back to the placeholder text', () => {
    const t = traj({
      userMessage: 'look',
      images: [{ sha256: 'abc', mediaType: 'image/png', bytes: 214 * 1024, caption: '' }],
    });
    const chunks = chunkTrajectory(t);
    expect(chunks.join('\n')).toContain('IMAGE: [uncaptioned image/png, 214 KB]');
  });

  test('a repeated image within a trajectory is deduped by sha256', () => {
    const b64 = Buffer.from('the-same-image-bytes').toString('base64');
    const imageBlock = { type: 'image' as const, mediaType: 'image/png', data: b64 };
    const messages: RawMessage[] = [
      msg({ type: 'user', content: [{ type: 'text', text: 'here' }, imageBlock] }),
      msg({ type: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'ok' }, imageBlock] }),
    ];
    const sink = new Map<string, { mediaType: string; data: string }>();
    const [t] = chunkMessages(messages, sink);
    expect(t!.images).toHaveLength(1);
    expect(sink.size).toBe(1);
  });

  test('emit order is stable: prose chunks, then thinking, then tool', () => {
    const t = traj({
      userMessage: 'q',
      assistantBlocks: ['proseword'],
      thinkingBlocks: ['thinkword'],
      toolCalls: [{ name: 'Bash', input: { command: 'jsonword' } }],
    });
    const chunks = chunkTrajectory(t);
    const proseIdx = chunks.findIndex((c) => c.includes('proseword'));
    const thinkIdx = chunks.findIndex((c) => c.includes('thinkword'));
    const toolIdx = chunks.findIndex((c) => c.includes('jsonword'));
    expect(proseIdx).toBeGreaterThanOrEqual(0);
    expect(proseIdx).toBeLessThan(thinkIdx);
    expect(thinkIdx).toBeLessThan(toolIdx);
  });
});

describe('trajectoryHash v3 composition', () => {
  // Inline reimplementation of the PRE-wave hash composition (no thinking/images).
  function oldTrajectoryHash(t: Trajectory): string {
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const stableJson = (v: unknown): string => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
      const keys = Object.keys(v as object).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson((v as Record<string, unknown>)[k])).join(',') + '}';
    };
    const normalized = normalize(
      [t.sessionId, t.userMessage, ...t.toolCalls.map((tc) => `${tc.name}:${stableJson(tc.input)}`), ...t.assistantBlocks].join('\n')
    );
    return createHash('sha256').update(normalized).digest('hex');
  }

  test('empty thinkingBlocks + images hashes byte-identically to the pre-wave composition', () => {
    const t = traj({
      userMessage: 'ship it',
      assistantBlocks: ['done'],
      toolCalls: [{ name: 'Write', input: { file_path: '/a' } }],
    });
    expect(trajectoryHash(t)).toBe(oldTrajectoryHash(t));
  });

  test('captions never enter the hash: two trajectories differing only in caption hash equal', () => {
    const base = traj({ userMessage: 'look', images: [{ sha256: 'sha-1', mediaType: 'image/png', bytes: 100, caption: '' }] });
    const captioned = traj({ userMessage: 'look', images: [{ sha256: 'sha-1', mediaType: 'image/png', bytes: 100, caption: 'a diagram' }] });
    expect(trajectoryHash(captioned)).toBe(trajectoryHash(base));
  });

  test('a differing image sha256 changes the hash', () => {
    const a = traj({ userMessage: 'look', images: [{ sha256: 'sha-1', mediaType: 'image/png', bytes: 100, caption: '' }] });
    const b = traj({ userMessage: 'look', images: [{ sha256: 'sha-2', mediaType: 'image/png', bytes: 100, caption: '' }] });
    expect(trajectoryHash(b)).not.toBe(trajectoryHash(a));
  });

  test('a differing thinking block changes the hash', () => {
    const a = traj({ userMessage: 'q', thinkingBlocks: ['plan A'] });
    const b = traj({ userMessage: 'q', thinkingBlocks: ['plan B'] });
    expect(trajectoryHash(b)).not.toBe(trajectoryHash(a));
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
