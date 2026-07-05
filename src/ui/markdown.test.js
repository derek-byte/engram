// Markdown renderer tests. markdown.js touches document only at call time, so
// a ~40-line fake DOM (createElement/createTextNode + the handful of members
// the renderer uses) is enough — no happy-dom dependency.
import { beforeAll, describe, expect, test } from 'bun:test';
import { cleanSnippet, renderInline, renderMarkdown, SLUG_RE } from './markdown.js';

class FakeText {
  constructor(data) { this.data = data; }
  get textContent() { return this.data; }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.className = '';
    this.listeners = {};
  }
  appendChild(n) { this.childNodes.push(n); return n; }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i !== -1) this.childNodes.splice(i, 1);
    return n;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
  set textContent(v) { this.childNodes = [new FakeText(String(v))]; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
}

beforeAll(() => {
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (data) => new FakeText(String(data)),
  };
});

const el = (tag = 'div') => new FakeElement(tag);
// All FakeElement descendants of n (depth-first), optionally filtered by tag.
function descendants(n, tag) {
  const out = [];
  for (const c of n.childNodes) {
    if (c instanceof FakeElement) {
      if (!tag || c.tagName === tag.toUpperCase()) out.push(c);
      out.push(...descendants(c, tag));
    }
  }
  return out;
}

describe('cleanSnippet', () => {
  test('resolves wikilink labels and bare slugs', () => {
    expect(cleanSnippet('see [[docker-context|the Docker gotcha]] and [[pgvector]]')).toBe(
      'see the Docker gotcha and pgvector'
    );
  });
  test('drops heading markers and collapses whitespace', () => {
    expect(cleanSnippet('## Heading\n\nbody   text ')).toBe('Heading body text');
  });
});

describe('renderInline', () => {
  test('bold and inline code become elements, surrounding text stays text', () => {
    const c = el();
    renderInline(c, 'a **b** and `c()`');
    expect(c.textContent).toBe('a b and c()');
    expect(descendants(c, 'strong').map((n) => n.textContent)).toEqual(['b']);
    expect(descendants(c, 'code').map((n) => n.textContent)).toEqual(['c()']);
  });

  test('valid wikilinks render as .wikilink anchors; the label wins over the slug', () => {
    const c = el();
    const opened = [];
    renderInline(c, 'see [[docker-context|the gotcha]] now', (slug) => opened.push(slug));
    const [a] = descendants(c, 'a');
    expect(a.className).toBe('wikilink');
    expect(a.textContent).toBe('the gotcha');
    a.click();
    expect(opened).toEqual(['docker-context']);
  });

  test('[[slug]] with no label uses the slug as the label (case preserved, slug lowered)', () => {
    const c = el();
    const opened = [];
    renderInline(c, '[[Docker-Context]]', (slug) => opened.push(slug));
    const [a] = descendants(c, 'a');
    expect(a.textContent).toBe('Docker-Context');
    a.click();
    expect(opened).toEqual(['docker-context']);
  });

  test('an invalid slug falls back to plain text (no anchor)', () => {
    expect(SLUG_RE.test('not a slug!')).toBe(false);
    const c = el();
    renderInline(c, 'see [[Not A Slug!|label]] here');
    expect(descendants(c, 'a')).toEqual([]);
    expect(c.textContent).toBe('see label here');
  });

  test('only http/https hrefs become anchors; file:/javascript: fall to plain text', () => {
    const c = el();
    renderInline(c, '[ok](https://example.com/x) [f](file:///etc/passwd) [j](javascript:void0)');
    const anchors = descendants(c, 'a');
    expect(anchors.length).toBe(1);
    expect(anchors[0].href).toBe('https://example.com/x');
    expect(anchors[0].target).toBe('_blank');
    expect(anchors[0].rel).toBe('noopener');
    expect(c.textContent).toBe('ok f j');
  });
});

describe('renderMarkdown', () => {
  test('headings, paragraphs, lists, and fenced code land as the right blocks', () => {
    const c = el();
    renderMarkdown(c, '# Title\n\npara **bold**\n\n- one\n- two\n\n1. first\n\n```\nconst x = 1;\n```');
    expect(c.childNodes.map((n) => n.tagName)).toEqual(['H1', 'P', 'UL', 'OL', 'PRE']);
    expect(c.childNodes[0].textContent).toBe('Title');
    expect(descendants(c.childNodes[1], 'strong').map((n) => n.textContent)).toEqual(['bold']);
    expect(descendants(c.childNodes[2], 'li').map((n) => n.textContent)).toEqual(['one', 'two']);
    expect(descendants(c.childNodes[4], 'code').map((n) => n.textContent)).toEqual(['const x = 1;']);
  });

  test('clears the container before rendering (re-render is idempotent)', () => {
    const c = el();
    renderMarkdown(c, 'first');
    renderMarkdown(c, 'second');
    expect(c.childNodes.length).toBe(1);
    expect(c.textContent).toBe('second');
  });

  test('adjacent lines join into one paragraph; blank lines split', () => {
    const c = el();
    renderMarkdown(c, 'line one\nline two\n\nnext para');
    expect(c.childNodes.map((n) => n.tagName)).toEqual(['P', 'P']);
    expect(c.childNodes[0].textContent).toBe('line one line two');
  });

  test('threads onWikiLink through blocks', () => {
    const c = el();
    const opened = [];
    renderMarkdown(c, '## See [[docker-context]]\n\n- item [[pgvector|pg]]', (slug) => opened.push(slug));
    for (const a of descendants(c, 'a')) a.click();
    expect(opened).toEqual(['docker-context', 'pgvector']);
  });
});
