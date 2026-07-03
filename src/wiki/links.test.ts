import { describe, expect, test } from 'bun:test';
import { slugify, isValidSlug, parseWikilinks, buildLinkGraph, normalizedEditDistance, stripIdCitations, autolinkBody, type LinkTarget } from './links.ts';

describe('slugify', () => {
  test('kebab-cases and trims', () => {
    expect(slugify('Fingerprint Short-Circuit')).toBe('fingerprint-short-circuit');
    expect(slugify('  pgvector!! ')).toBe('pgvector');
    expect(slugify('C++ & Rust')).toBe('c-rust');
  });
  test('validates slug shape', () => {
    expect(isValidSlug('pg-vector')).toBe(true);
    expect(isValidSlug('Bad Slug')).toBe(false);
    expect(isValidSlug('')).toBe(false);
  });
});

describe('parseWikilinks', () => {
  test('extracts [[slug]] and [[slug|label]]', () => {
    const links = parseWikilinks('See [[pgvector]] and [[dream-layer|the dream tier]].');
    expect(links.sort()).toEqual(['dream-layer', 'pgvector']);
  });
  test('normalizes non-slug targets', () => {
    expect(parseWikilinks('[[Fingerprint Skip]]')).toEqual(['fingerprint-skip']);
  });
  test('ignores links inside fenced code blocks', () => {
    const body = 'real [[a]]\n```\ncode [[b]]\n```\n';
    expect(parseWikilinks(body)).toEqual(['a']);
  });
});

describe('buildLinkGraph', () => {
  test('resolves inbound/outbound and aliases, flags dangling', () => {
    const g = buildLinkGraph([
      { slug: 'a', aliases: ['alpha'], outbound: ['b', 'ghost'] },
      { slug: 'b', aliases: [], outbound: ['alpha'] },
    ]);
    expect(g.outbound.get('a')).toEqual(['b']);
    expect(g.outbound.get('b')).toEqual(['a']); // via alias 'alpha'
    expect(g.inbound.get('a')).toEqual(['b']);
    expect(g.inbound.get('b')).toEqual(['a']);
    expect(g.dangling.get('a')).toEqual(['ghost']);
  });
});

describe('normalizedEditDistance', () => {
  test('near-duplicate slugs score low', () => {
    expect(normalizedEditDistance('pgvector', 'pg-vector')).toBeLessThan(0.25);
    expect(normalizedEditDistance('alpha', 'omega')).toBeGreaterThan(0.5);
  });
});

describe('stripIdCitations', () => {
  const id = 'a'.repeat(64);
  test('removes [[<hex id>]] citations, keeps real wikilinks', () => {
    expect(stripIdCitations(`Chose pgvector. [[${id}]]`)).toBe('Chose pgvector.');
    expect(stripIdCitations(`See [[pgvector]] and [[${id}]].`)).toBe('See [[pgvector]] and.');
    expect(stripIdCitations('no ids here [[dream-layer]]')).toBe('no ids here [[dream-layer]]');
  });
  test('keeps the label of [[<hex id>|label]]', () => {
    expect(stripIdCitations(`per [[${id}|the decision]]`)).toBe('per the decision');
  });
});

describe('autolinkBody', () => {
  const pg: LinkTarget = { slug: 'pgvector', title: 'pgvector', aliases: ['pg-vector'] };
  const fp: LinkTarget = { slug: 'fingerprint-skip', title: 'fingerprint short-circuit', aliases: [] };
  const fingerprint: LinkTarget = { slug: 'fingerprint', title: 'fingerprint', aliases: [] };

  test('wraps only the first mention per page', () => {
    const r = autolinkBody('pgvector is great. pgvector again.', [pg]);
    expect(r.body).toBe('[[pgvector]] is great. pgvector again.');
    expect(r.added).toEqual(['pgvector']);
  });

  test('case-insensitive match preserves original casing via label', () => {
    expect(autolinkBody('We use Pgvector here.', [pg]).body).toBe('We use [[pgvector|Pgvector]] here.');
  });

  test('skips a mention inside a fenced code block, links the next one outside', () => {
    const r = autolinkBody('```\npgvector\n```\nThen pgvector rocks.', [pg]);
    expect(r.body).toBe('```\npgvector\n```\nThen [[pgvector]] rocks.');
  });

  test('skips a mention inside an inline code span', () => {
    expect(autolinkBody('Use `pgvector` now, pgvector rules.', [pg]).body).toBe('Use `pgvector` now, [[pgvector]] rules.');
  });

  test('a page already linked (by slug or alias) gets no extra link', () => {
    expect(autolinkBody('See [[pgvector]]. Also pgvector text.', [pg]).body).toBe('See [[pgvector]]. Also pgvector text.');
    expect(autolinkBody('See [[pg-vector]]. Also pgvector text.', [pg]).body).toBe('See [[pg-vector]]. Also pgvector text.');
  });

  test('text inside an existing [[slug|label]] and inside [text](url) is untouched', () => {
    const body = '[[fingerprint-skip|the pgvector thing]] and [pgvector docs](http://x).';
    expect(autolinkBody(body, [pg, fp]).body).toBe(body);
  });

  test('overlapping titles: longest wins at a shared offset, shorter links a later standalone', () => {
    const r = autolinkBody('The fingerprint short-circuit is fast. Also fingerprint alone.', [fp, fingerprint]);
    expect(r.body).toBe('The [[fingerprint-skip|fingerprint short-circuit]] is fast. Also [[fingerprint]] alone.');
    expect(r.added.sort()).toEqual(['fingerprint', 'fingerprint-skip']);
  });

  test('word boundary: a needle does not match inside a larger word', () => {
    const log: LinkTarget = { slug: 'log', title: 'log', aliases: [] };
    expect(autolinkBody('the logger and the log file', [log]).body).toBe('the logger and the [[log]] file');
  });

  test('self-title is not linked', () => {
    expect(autolinkBody('pgvector notes here', [pg], 'pgvector').body).toBe('pgvector notes here');
  });

  test('ambiguous shared alias links nothing', () => {
    const a: LinkTarget = { slug: 'alpha', title: 'Alpha', aliases: ['shared-thing'] };
    const b: LinkTarget = { slug: 'beta', title: 'Beta', aliases: ['shared-thing'] };
    expect(autolinkBody('the shared-thing here', [a, b]).body).toBe('the shared-thing here');
  });

  test('regex-metacharacter title is safe', () => {
    const cpp: LinkTarget = { slug: 'cpp', title: 'C++', aliases: [] };
    expect(autolinkBody('we use C++ daily', [cpp]).body).toBe('we use [[cpp|C++]] daily');
  });

  test('deterministic: same input → same output', () => {
    const body = 'pgvector and the fingerprint short-circuit and fingerprint';
    const targets = [pg, fp, fingerprint];
    expect(autolinkBody(body, targets).body).toBe(autolinkBody(body, targets).body);
  });
});
