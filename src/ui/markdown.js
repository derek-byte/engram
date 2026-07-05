// ── hand-rolled markdown renderer (DOM-only, never innerHTML) ──
// Scope: headings, paragraphs, unordered/ordered lists, fenced code, inline
// code, bold, [text](url) links (http/https only — file: falls to plain text), [[wikilinks]].
//
// DOM access happens only at call time (document.createElement inside the
// render functions), so markdown.test.js imports this module without a DOM.
// Wikilink clicks are delegated to the caller-supplied onWikiLink(slug) so the
// renderer never depends on the overlay.

import { clear } from './util.js';

export const SLUG_RE = /^[a-z0-9-]{1,64}$/; // mirrors isValidSlug (src/wiki/links.ts)

// Strip markdown artifacts for display: [[slug|label]] → label, [[slug]] →
// slug, drop heading markers. The source stays markdown; this is render-only.
export function cleanSnippet(s) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderInline(container, text, onWikiLink) {
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[\[([^\]|]+)(?:\|([^\]]*))?\]\])|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0, m;
  const pushText = (s) => { if (s) container.appendChild(document.createTextNode(s)); };
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== undefined) {
      const b = document.createElement('strong'); b.textContent = m[2]; container.appendChild(b);
    } else if (m[4] !== undefined) {
      const c = document.createElement('code'); c.textContent = m[4]; container.appendChild(c);
    } else if (m[6] !== undefined) {
      const rawSlug = m[6].trim();
      const slug = rawSlug.toLowerCase();
      const label = (m[7] !== undefined && m[7] !== '') ? m[7] : rawSlug;
      if (SLUG_RE.test(slug)) {
        const a = document.createElement('a');
        a.className = 'wikilink'; a.textContent = label;
        a.addEventListener('click', () => { if (onWikiLink) onWikiLink(slug); });
        container.appendChild(a);
      } else {
        pushText(label);
      }
    } else if (m[9] !== undefined) {
      const label = m[9], url = m[10];
      if (/^https?:/i.test(url)) {
        const a = document.createElement('a');
        a.textContent = label; a.href = url; a.target = '_blank'; a.rel = 'noopener';
        container.appendChild(a);
      } else {
        pushText(label);
      }
    }
  }
  pushText(text.slice(last));
}

export function renderMarkdown(container, md, onWikiLink) {
  clear(container);
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const flushPara = (buf) => {
    if (!buf.length) return;
    const p = document.createElement('p');
    renderInline(p, buf.join(' '), onWikiLink);
    container.appendChild(p);
  };
  let para = [];
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      flushPara(para); para = [];
      const marker = fence[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) code.push(lines[i++]);
      i++; // closing fence
      const pre = document.createElement('pre');
      const c = document.createElement('code');
      c.textContent = code.join('\n');
      pre.appendChild(c);
      container.appendChild(pre);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara(para); para = [];
      const h = document.createElement('h' + heading[1].length);
      renderInline(h, heading[2].trim(), onWikiLink);
      container.appendChild(h);
      i++;
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara(para); para = [];
      const listEl = document.createElement(ol ? 'ol' : 'ul');
      while (i < lines.length) {
        const um = lines[i].match(/^\s*[-*]\s+(.*)$/);
        const om = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        const item = ol ? om : um;
        if (!item) break;
        const li = document.createElement('li');
        renderInline(li, item[1], onWikiLink);
        listEl.appendChild(li);
        i++;
      }
      container.appendChild(listEl);
      continue;
    }
    if (line.trim() === '') { flushPara(para); para = []; i++; continue; }
    para.push(line.trim());
    i++;
  }
  flushPara(para);
}
