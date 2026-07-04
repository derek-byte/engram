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
