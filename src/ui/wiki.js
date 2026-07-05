// ── wiki nav view (page index) ──
// Feature-detected: GET /api/wiki may not exist yet in every build; a 404 or
// network error renders an empty message rather than crashing.

import { wikiListEl } from './dom.js';
import { relAge, normTs, clear } from './util.js';
import { openWikiPage } from './overlay.js';

export async function loadWiki() {
  clear(wikiListEl);
  loadLint(); // lazy, fire-and-forget: the list renders regardless of lint
  let pages = null;
  try {
    const res = await fetch('/api/wiki');
    if (!res.ok) { showWikiMessage('Wiki index unavailable.'); return; }
    pages = await res.json();
  } catch {
    showWikiMessage('Wiki index unavailable.');
    return;
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    showWikiMessage('No wiki pages yet — run `engram dream` to compile knowledge.');
    return;
  }
  for (const p of pages) {
    const slug = p.slug;
    if (!slug) continue;
    const row = document.createElement('div');
    row.className = 'result';
    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    gutter.textContent = relAge(normTs(p.updated));
    row.appendChild(gutter);
    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('div');
    title.className = 'wiki-title';
    title.textContent = (p.title || slug).replace(/-/g, ' ');
    const kind = document.createElement('span');
    kind.className = 'card-kind';
    kind.textContent = p.kind || 'page';
    title.appendChild(kind);
    body.appendChild(title);
    row.appendChild(body);
    row.addEventListener('click', () => openWikiPage({ slug, trajectoryId: 'wiki:' + slug, tier: 'wiki' }));
    wikiListEl.appendChild(row);
  }
}
function showWikiMessage(msg) {
  clear(wikiListEl);
  const p = document.createElement('div');
  p.className = 'empty-msg';
  p.textContent = msg;
  wikiListEl.appendChild(p);
}

// Wiki health: fetch lint on demand and surface a warnings chip that toggles
// a findings list. Feature-detected — a 404/error (older build, no backend)
// leaves the chip hidden, never crashing the wiki view.
async function loadLint() {
  const chip = document.getElementById('wiki-lint-chip');
  const listEl = document.getElementById('wiki-lint-list');
  chip.classList.add('lint-hidden');
  listEl.classList.add('lint-hidden');
  clear(listEl);
  let data = null;
  try {
    const res = await fetch('/api/lint');
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }
  const warns = data && data.counts ? (data.counts.warns || 0) : 0;
  if (!warns) return;
  chip.textContent = warns + ' warning' + (warns === 1 ? '' : 's');
  chip.classList.remove('lint-hidden');
  const findings = (data && Array.isArray(data.findings) ? data.findings : []).filter((f) => f.level === 'warn');
  for (const f of findings) {
    const row = document.createElement('div');
    row.className = 'lint-row';
    const rule = document.createElement('span');
    rule.className = 'lint-rule';
    rule.textContent = f.rule || '';
    row.appendChild(rule);
    const meta = document.createElement('span');
    meta.textContent = (f.page ? f.page + ' · ' : '') + (f.detail || '');
    row.appendChild(meta);
    if (f.page) {
      const slug = f.page;
      row.classList.add('lint-clickable');
      row.addEventListener('click', () => openWikiPage({ slug, trajectoryId: 'wiki:' + slug, tier: 'wiki' }));
    }
    listEl.appendChild(row);
  }
  chip.onclick = () => listEl.classList.toggle('lint-hidden');
}
