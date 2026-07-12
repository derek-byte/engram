import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonl, sanitizeUnicode } from './parser.ts';

const NUL = String.fromCharCode(0);
const LONE_HIGH = String.fromCharCode(0xd83d); // unpaired high surrogate
const LONE_LOW = String.fromCharCode(0xde00); // unpaired low surrogate
const FFFD = '�';

describe('sanitizeUnicode', () => {
  test('replaces NUL with U+FFFD', () => {
    expect(sanitizeUnicode(`a${NUL}b`)).toBe(`a${FFFD}b`);
  });
  test('replaces a lone high surrogate with U+FFFD', () => {
    expect(sanitizeUnicode(`x${LONE_HIGH}y`)).toBe(`x${FFFD}y`);
  });
  test('replaces a lone low surrogate with U+FFFD', () => {
    expect(sanitizeUnicode(`x${LONE_LOW}y`)).toBe(`x${FFFD}y`);
  });
  test('passes an already-well-formed string through byte-identically', () => {
    const s = 'clean 😀 text with émojis';
    expect(sanitizeUnicode(s)).toBe(s);
  });
});

describe('parseJsonl Unicode sanitization', () => {
  test('degrades   / lone surrogates across text, tool_result, tool_use — never drops the line', () => {
    const dir = join(tmpdir(), `engram-parser-${crypto.randomUUID()}`);
    const path = join(dir, 'session.jsonl');
    // JSON.stringify emits real NUL / lone-surrogate chars as \u0000 / \udXXX
    // escapes — exactly the byte pattern the real cs-240 file carries.
    const bad = {
      type: 'assistant',
      uuid: 'u1',
      sessionId: 's-bad',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `note${NUL} with a null and ${LONE_HIGH} lone surrogate` },
          { type: 'tool_use', name: 'Read', id: 't1', input: { path: `file${NUL}.pdf`, note: LONE_LOW } },
          { type: 'tool_result', tool_use_id: 't1', content: `extracted${NUL}text${LONE_HIGH}` },
        ],
      },
    };
    const clean = {
      type: 'user',
      uuid: 'u2',
      sessionId: 's-bad',
      timestamp: '2026-01-01T00:01:00.000Z',
      message: { role: 'user', content: 'a perfectly clean line' },
    };
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(bad) + '\n' + JSON.stringify(clean) + '\n', 'utf-8');
      // Sanity: the file really carries the escape bytes.
      const rawFile = readFileSync(path, 'utf-8');
      expect(rawFile).toContain('\\u0000');
      expect(rawFile.toLowerCase()).toContain('\\ud83d');

      const msgs = parseJsonl(path);
      expect(msgs.length).toBe(2);

      const dump = JSON.stringify(msgs);
      // No NUL / lone surrogate survives to the payload (jsonb + TEXT safe).
      expect(dump.includes(NUL)).toBe(false);
      expect(dump.isWellFormed()).toBe(true);
      expect(dump).not.toContain('\\u0000');

      // The bad line's strings degraded to U+FFFD, content preserved around it.
      const asst = msgs[0]!;
      const textBlock = asst.content.find((b) => b.type === 'text') as { text: string };
      expect(textBlock.text).toContain(FFFD);
      expect(textBlock.text).toContain('note');
      expect(textBlock.text).toContain('lone surrogate');
      const tr = asst.content.find((b) => b.type === 'tool_result') as { content: string };
      expect(tr.content).toContain(FFFD);
      expect(tr.content).toContain('extracted');

      // The clean line is untouched.
      const user = msgs[1]!;
      expect((user.content[0] as { text: string }).text).toBe('a perfectly clean line');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Write one JSONL line and parse it back through parseJsonl.
function parseLine(obj: unknown): ReturnType<typeof parseJsonl>[number] | undefined {
  const dir = join(tmpdir(), `engram-parser-${crypto.randomUUID()}`);
  const path = join(dir, 'session.jsonl');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(obj) + '\n', 'utf-8');
    return parseJsonl(path)[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const B64 = Buffer.from('some-image-bytes').toString('base64');

describe('parseJsonl thinking + image blocks', () => {
  test('a thinking block is captured with its text', () => {
    const m = parseLine({
      type: 'assistant',
      uuid: 'u1',
      sessionId: 's',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'let me reason about this' }] },
    });
    expect(m!.content).toEqual([{ type: 'thinking', text: 'let me reason about this' }]);
  });

  test('redacted_thinking is dropped (no readable text)', () => {
    const m = parseLine({
      type: 'assistant',
      uuid: 'u1',
      sessionId: 's',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'visible' },
        ],
      },
    });
    expect(m!.content).toEqual([{ type: 'text', text: 'visible' }]);
  });

  test('a user image block becomes {type:image, mediaType, data}', () => {
    const m = parseLine({
      type: 'user',
      uuid: 'u1',
      sessionId: 's',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
        ],
      },
    });
    expect(m!.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', mediaType: 'image/png', data: B64 },
    ]);
  });

  test('a URL (non-base64) image source is dropped', () => {
    const m = parseLine({
      type: 'user',
      uuid: 'u1',
      sessionId: 's',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
        ],
      },
    });
    expect(m!.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  test('tool_result with nested text+image → text-only content + sibling image, no base64 in the string', () => {
    const m = parseLine({
      type: 'user',
      uuid: 'u1',
      sessionId: 's',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'screenshot captured' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
            ],
          },
        ],
      },
    });
    expect(m!.content).toEqual([
      { type: 'tool_result', toolUseId: 't1', content: 'screenshot captured', isError: undefined },
      { type: 'image', mediaType: 'image/png', data: B64 },
    ]);
    // The base64 never leaked into the tool_result content string.
    const tr = m!.content.find((b) => b.type === 'tool_result') as { content: string };
    expect(tr.content).not.toContain(B64);
  });
});
