// Overlay hosts either the trajectory turns or the wiki page; exactly one is
// shown. back/Escape always returns to results (no view stack).

import { qEl, overlayEl, overlayBodyEl, overlayMetaEl, turnsEl, pageEl } from './dom.js';
import { getCurrentView, getOverlayWikiSlug, setOverlayWikiSlug } from './state.js';
import { fmtTime, fmtDay, clear } from './util.js';
import { renderMarkdown } from './markdown.js';
import { buildArtifactStrip } from './artifacts.js';
import { updateHash } from './router.js';
import { stateForView } from './views.js';

document.getElementById('back').addEventListener('click', closeOverlay);

function showTurnsView() { pageEl.classList.remove('open'); turnsEl.style.display = ''; }
function showPageView() { turnsEl.style.display = 'none'; pageEl.classList.add('open'); }

// Wikilink click-through for rendered markdown: open the linked page.
function openWikiLink(slug) { openWikiPage({ slug, trajectoryId: 'wiki:' + slug, tier: 'wiki' }); }

let wikiPageReq = 0; // guards rapid opens: only the latest fetch may render
export async function openWikiPage(r) {
  const slug = r.slug;
  const reqId = ++wikiPageReq;
  setOverlayWikiSlug(slug);
  updateHash({ view: 'wiki', slug }, {}); // push (suppressed while the router drives)
  overlayMetaEl.textContent = '';
  clear(pageEl);
  showPageView();
  overlayEl.classList.add('open');
  overlayBodyEl.scrollTop = 0;
  let page = null;
  try {
    const res = await fetch('/api/wiki/' + encodeURIComponent(slug));
    if (reqId !== wikiPageReq) return; // a newer open superseded this one
    if (!res.ok) { openTrajectory({ trajectoryId: r.trajectoryId || 'wiki:' + slug, tier: 'wiki', slug }); return; }
    page = await res.json();
  } catch {
    if (reqId !== wikiPageReq) return;
    openTrajectory({ trajectoryId: r.trajectoryId || 'wiki:' + slug, tier: 'wiki', slug });
    return;
  }
  if (reqId !== wikiPageReq) return;
  const head = document.createElement('div');
  head.className = 'page-head';
  const title = document.createElement('h2');
  title.className = 'page-title';
  title.textContent = (page.title || slug).replace(/-/g, ' ');
  const kind = document.createElement('span');
  kind.className = 'page-kind';
  kind.textContent = page.kind || 'page';
  title.appendChild(kind);
  head.appendChild(title);
  pageEl.appendChild(head);

  const prov = document.createElement('div');
  prov.className = 'page-prov';
  const n = page.sourceCount || 0;
  prov.appendChild(document.createTextNode('updated ' + fmtTime(page.updated) + ' · '));
  const link = document.createElement('span');
  link.className = 'prov-link';
  link.textContent = 'compiled from ' + n + ' dream chunk' + (n === 1 ? '' : 's') + ' → view sources';
  link.addEventListener('click', () =>
    openTrajectory({ trajectoryId: page.trajectoryId, tier: 'wiki', slug: page.slug, timestamp: page.updated })
  );
  prov.appendChild(link);
  // Evidence header: distinct sessions + source count + first→last span, so the
  // page's grounding is legible at a glance. A muted second line under the prov.
  const ev = document.createElement('div');
  ev.className = 'page-evidence';
  const sc = page.sessionCount || 0;
  let evText = sc + ' session' + (sc === 1 ? '' : 's') + ' · ' + n + ' source item' + (n === 1 ? '' : 's');
  const fd = fmtDay(page.firstSeen);
  const ld = fmtDay(page.lastSeen);
  if (fd && ld) evText += ' · ' + fd + ' → ' + ld;
  ev.textContent = evText;
  prov.appendChild(ev);
  pageEl.appendChild(prov);

  // Artifact strip: this page's durable outputs, under the meta region and at
  // the top of the scrolling body (not the fixed header, so many chips don't
  // eat the viewport). /api/wiki carries `exists`, so missing files strike out.
  const strip = buildArtifactStrip(page.artifacts, 12, false);
  if (strip) pageEl.appendChild(strip);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'page-body';
  renderMarkdown(bodyEl, page.body || '', openWikiLink);
  pageEl.appendChild(bodyEl);
}

export async function openTrajectory(r) {
  showTurnsView();
  if (!r.trajectoryId) {
    overlayMetaEl.textContent = 'This chunk has no trajectory id.';
    clear(turnsEl);
    overlayEl.classList.add('open');
    return;
  }
  overlayMetaEl.textContent = 'loading…';
  clear(turnsEl);
  overlayEl.classList.add('open');
  overlayBodyEl.scrollTop = 0;
  try {
    const res = await fetch('/api/trajectory/' + encodeURIComponent(r.trajectoryId));
    const chunks = await res.json();
    if (!Array.isArray(chunks)) { overlayMetaEl.textContent = 'error loading trajectory'; return; }
    // Reopened recents carry only the trajectory id; fall back to the fetched
    // chunks' metadata for repo/branch/timestamp.
    const c0 = chunks[0] || {};
    const repo = r.repo ?? c0.repo;
    const branch = r.branch ?? c0.branch;
    const ts = r.timestamp ?? c0.timestamp;
    overlayMetaEl.textContent =
      (r.tier === 'wiki'
        ? 'wiki page · ' + (r.slug || '?') + ' · current compiled knowledge · updated ' + fmtTime(r.timestamp)
        : r.tier === 'dream'
          ? 'dream unit · dated snapshot of ' + fmtTime(ts) + ' · ' + (repo || '(no-repo)')
          : (repo || '(no-repo)') + '@' + (branch || 'no-branch') + ' · ' + fmtTime(ts)) +
      ' · ' + chunks.length + ' chunk' + (chunks.length === 1 ? '' : 's');
    renderTurns(chunks, r.id);
    // Union of the trajectory's chunks' artifacts (dedup by ref, cap 12) at the
    // top of the scrolling body, near the meta. No exists flag from this route,
    // so file chips render plainly (unknown ≠ missing).
    const union = [];
    for (const c of chunks) if (Array.isArray(c.artifacts)) union.push(...c.artifacts);
    const strip = buildArtifactStrip(union, 12, false);
    if (strip) turnsEl.insertBefore(strip, turnsEl.firstChild);
  } catch {
    overlayMetaEl.textContent = 'error loading trajectory';
  }
}

function renderTurns(chunks, matchId) {
  clear(turnsEl);
  let matched = null;
  for (const c of chunks) {
    const div = document.createElement('div');
    div.className = 'turn';
    const label = document.createElement('span');
    label.className = 'idx';
    label.textContent = 'chunk ' + (c.chunkIndex ?? '?') +
      (c.chunkCount ? ' / ' + c.chunkCount : '');
    div.appendChild(label);
    const body = document.createElement('div');
    body.textContent = c.content;
    div.appendChild(body);
    if (c.id === matchId) { div.classList.add('match'); matched = div; }
    turnsEl.appendChild(div);
  }
  if (matched) matched.scrollIntoView({ block: 'center' });
}

export function closeOverlay() {
  overlayEl.classList.remove('open');
  const wasWiki = getOverlayWikiSlug();
  setOverlayWikiSlug(null);
  qEl.focus();
  // Closing a routed wiki page returns to the underlying view (replace, so the
  // close — and a Tauri Esc-hide — never grows history). Trajectory overlays
  // aren't routed (wasWiki null), so their close leaves the hash untouched.
  if (wasWiki) updateHash(stateForView(getCurrentView()), { replace: true });
}
