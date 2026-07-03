import { describe, expect, test } from 'bun:test';
import { slugify, isValidSlug, parseWikilinks, buildLinkGraph, normalizedEditDistance } from './links.ts';

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
