// Pure-router tests: router.js has no top-level DOM/window access, so these
// run in bun test with no DOM at all.
import { describe, expect, test } from 'bun:test';
import { safeDecode, parseHash, hashFor } from './router.js';

describe('safeDecode', () => {
  test('decodes well-formed %-escapes', () => {
    expect(safeDecode('a%20b')).toBe('a b');
    expect(safeDecode('docker-context')).toBe('docker-context');
  });

  test('returns the raw segment on a malformed escape instead of throwing', () => {
    expect(() => decodeURIComponent('%ZZ')).toThrow(); // the bug safeDecode exists for
    expect(safeDecode('%ZZ')).toBe('%ZZ');
    expect(safeDecode('%')).toBe('%');
    expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('parseHash', () => {
  test('empty / bare hashes default to search', () => {
    expect(parseHash('')).toEqual({ view: 'search', q: '' });
    expect(parseHash('#/')).toEqual({ view: 'search', q: '' });
    expect(parseHash('#/search')).toEqual({ view: 'search', q: '' });
  });

  test('search query round-trips through encodeURIComponent', () => {
    expect(parseHash('#/search?q=foo%20bar')).toEqual({ view: 'search', q: 'foo bar' });
  });

  test('wiki slugs parse with and without a slug', () => {
    expect(parseHash('#/wiki')).toEqual({ view: 'wiki', slug: null });
    expect(parseHash('#/wiki/docker-context')).toEqual({ view: 'wiki', slug: 'docker-context' });
  });

  test('a malformed wiki slug (%ZZ) falls back to the raw segment, never throws', () => {
    expect(parseHash('#/wiki/%ZZ')).toEqual({ view: 'wiki', slug: '%ZZ' });
  });

  test('plain views parse', () => {
    expect(parseHash('#/analytics')).toEqual({ view: 'analytics' });
    expect(parseHash('#/setup')).toEqual({ view: 'setup' });
    expect(parseHash('#/settings')).toEqual({ view: 'settings' });
  });

  test('unknown heads return null (router defaults to search)', () => {
    expect(parseHash('#/nonsense')).toBeNull();
    expect(parseHash('#/nonsense/deeper')).toBeNull();
  });
});

describe('hashFor ↔ parseHash round-trips', () => {
  const states = [
    { view: 'search', q: '' },
    { view: 'search', q: 'foo bar' },
    { view: 'search', q: 'what is a=b&c?' },
    { view: 'wiki', slug: null },
    { view: 'wiki', slug: 'docker-context' },
    { view: 'analytics' },
    { view: 'setup' },
    { view: 'settings' },
  ];
  for (const s of states) {
    test(JSON.stringify(s), () => {
      const h = hashFor(s);
      const back = parseHash(h);
      expect(back.view).toBe(s.view);
      if (s.view === 'search') expect(back.q).toBe(s.q);
      if (s.view === 'wiki') expect(back.slug).toBe(s.slug);
      // …and the hash itself is stable under a second round-trip.
      expect(hashFor(back)).toBe(h);
    });
  }
});
