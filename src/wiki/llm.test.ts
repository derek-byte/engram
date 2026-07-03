import { describe, expect, test } from 'bun:test';
import { parsePageOps } from './llm.ts';

const base = { slug: 'pgvector', action: 'create', title: 'pgvector', summary: 's', aliases: [], sources: ['d1'] };

describe('parsePageOps', () => {
  test('throws on malformed JSON or missing pages array', () => {
    expect(() => parsePageOps('nope')).toThrow('malformed JSON');
    expect(() => parsePageOps('{"ops":[]}')).toThrow('missing "pages"');
  });

  test('drops ops with invalid slug, action, kind, or empty body', () => {
    const ops = parsePageOps(
      JSON.stringify({
        pages: [
          { ...base, slug: 'Bad Slug', kind: 'tool', body: 'x' },
          { ...base, action: 'delete', kind: 'tool', body: 'x' },
          { ...base, kind: 'saga', body: 'x' },
          { ...base, kind: 'tool', body: '   ' },
          { ...base, kind: 'tool', body: 'keep me' },
        ],
      })
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.body).toBe('keep me');
  });

  test('coerces dream item kinds to wiki kinds instead of dropping', () => {
    const ops = parsePageOps(
      JSON.stringify({
        pages: [
          { ...base, slug: 'a-fix', kind: 'fix', body: 'x' },
          { ...base, slug: 'a-pref', kind: 'preference', body: 'x' },
        ],
      })
    );
    expect(ops.map((o) => o.kind)).toEqual(['gotcha', 'topic']);
  });

  test('strips inline [[<chunk id>]] citations from bodies', () => {
    const id = 'f'.repeat(64);
    const ops = parsePageOps(
      JSON.stringify({ pages: [{ ...base, kind: 'tool', body: `Chose [[pgvector]]. [[${id}]]` }] })
    );
    expect(ops[0]!.body).toBe('Chose [[pgvector]].');
  });
});
