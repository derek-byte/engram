// ── search view ──
// Debounced query → /api/search, results rendering (wiki cards over collapsed
// episodic rows), the empty-state recents, the scope tabs, and the search-box
// keyboard model (Enter/arrows/Cmd+Enter).

import { qEl, statusEl, resultsEl, statsEl, latencyEl, moreEl, scopeEl, attachSlidingHighlight } from './dom.js';
import { SCOPE_TIER, SCOPES, getScope, setScopeValue } from './state.js';
import { relAge, normTs, clear } from './util.js';
import { cleanSnippet } from './markdown.js';
import { updateHash } from './router.js';
import { clearAnswer, getAskCardQuery, runAskUI } from './ask.js';
import { openWikiPage, openTrajectory } from './overlay.js';

const FETCH_K = 25;       // fetched per query (server clamps at 50)
const INITIAL_VISIBLE = 3; // compact default; ↓ past the last row reveals more
const DEBOUNCE_MS = 200;

moreEl.addEventListener('click', () => reveal(visible + 5));

const scopeHL = attachSlidingHighlight(scopeEl, { radius: 5 });

export function renderScope() {
  for (const s of scopeEl.querySelectorAll('span')) {
    s.classList.toggle('on', s.dataset.scope === getScope());
  }
  scopeHL.moveTo(scopeEl.querySelector('span.on')); // slide the pill to the selected tab
}
function setScope(next) {
  if (!SCOPE_TIER[next] || next === getScope()) return;
  setScopeValue(next);
  renderScope();
  // Re-run the current query immediately (skip the debounce); empty box just
  // moves the highlight.
  clearTimeout(debounceTimer);
  if (qEl.value.trim()) search(qEl.value);
}
export function cycleScope(dir) {
  const i = SCOPES.indexOf(getScope());
  setScope(SCOPES[(i + dir + SCOPES.length) % SCOPES.length]);
}
scopeEl.addEventListener('click', (e) => {
  const s = e.target.closest('span[data-scope]');
  if (s) setScope(s.dataset.scope);
});

let debounceTimer = null;
let inflight = null;
let rows = [];       // current result <div> elements
let items = [];      // current result data
let activeIndex = -1;
let visible = INITIAL_VISIBLE;

// Human label for a result's memory tier. Dream/raw are dated episodic
// snapshots; wiki is current compiled knowledge.
function tierLabel(r) {
  if (r.tier === 'wiki') return 'wiki' + (r.kind ? ':' + r.kind : '');
  if (r.tier === 'dream') return 'dream' + (r.kind ? ':' + r.kind : '');
  return 'raw';
}

export async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const s = await res.json();
    if (!s || typeof s.chunks !== 'number') return;
    clear(statsEl);
    const model = document.createElement('span');
    model.className = 'accent';
    model.textContent = s.model + (s.dim ? ' · ' + s.dim + 'd' : '');
    const count = document.createElement('span');
    count.textContent = ' · ' + s.chunks.toLocaleString() + ' chunks';
    statsEl.appendChild(model);
    statsEl.appendChild(count);
  } catch { /* stats are cosmetic; ignore */ }
}

function setActive(i) {
  if (rows[activeIndex]) rows[activeIndex].classList.remove('active');
  activeIndex = i;
  const row = rows[activeIndex];
  if (row) {
    row.classList.add('active');
    row.scrollIntoView({ block: 'nearest' });
  }
}

let wikiN = 0; // leading wiki cards, always visible; `visible` counts history rows

function updateStatus() {
  if (!items.length) {
    statusEl.textContent = qEl.value.trim() ? 'no results' : '';
    moreEl.style.display = 'none';
    return;
  }
  statusEl.textContent = items.length + ' result' + (items.length === 1 ? '' : 's');
  const remaining = items.length - wikiN - visible;
  if (remaining > 0) {
    moreEl.textContent = 'show ' + remaining + ' more from history ↓';
    moreEl.style.display = 'block';
  } else {
    moreEl.style.display = 'none';
  }
}

function reveal(n) {
  visible = Math.min(n, items.length - wikiN);
  rows.forEach((row, i) => row.classList.toggle('hidden', i >= wikiN + visible));
  updateStatus();
}

// Near-duplicate collapse for episodic rows: dream units restate the same
// fact across sessions; one row per fact, "+N similar" on the survivor.
function wordSet(s) {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}
function similar(a, b) {
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  const denom = Math.min(a.size, b.size) || 1;
  return hit / denom > 0.6;
}

function buildRow(r, i, isCard) {
  const row = document.createElement('div');
  row.className = isCard ? 'result wiki-card' : 'result';

  // Episodic rows get a timestamp gutter; wiki cards keep age in the header.
  if (!isCard) {
    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    gutter.textContent = relAge(r.timestamp);
    row.appendChild(gutter);
  }

  const body = document.createElement('div');
  body.className = 'body';
  if (isCard) {
    const title = document.createElement('div');
    title.className = 'card-title';
    const titleText = document.createElement('span');
    titleText.textContent = (r.slug || 'page').replace(/-/g, ' ');
    title.appendChild(titleText);
    const kind = document.createElement('span');
    kind.className = 'card-kind';
    kind.textContent = r.kind || 'page';
    title.appendChild(kind);
    const age = document.createElement('span');
    age.className = 'card-age';
    age.textContent = relAge(r.timestamp);
    title.appendChild(age);
    body.appendChild(title);
  }
  const snip = document.createElement('div');
  snip.className = isCard ? 'snippet card-snippet' : 'snippet';
  snip.textContent = isCard ? cleanSnippet(r.snippet) : r.snippet;
  body.appendChild(snip);
  if (!isCard) {
    const sub = document.createElement('div');
    sub.className = 'sub';
    const badge = document.createElement('span');
    badge.className = 'tier tier-' + (r.tier || 'raw');
    badge.textContent = tierLabel(r);
    sub.appendChild(badge);
    const where = document.createElement('span');
    where.textContent = ' · ' + (r.repo || '(no-repo)') + '@' + (r.branch || 'no-branch');
    sub.appendChild(where);
    if (r._dupes) {
      const dupes = document.createElement('span');
      dupes.className = 'dupes';
      dupes.textContent = ' · +' + r._dupes + ' similar';
      sub.appendChild(dupes);
    }
    body.appendChild(sub);
  }
  row.appendChild(body);

  if (!isCard) {
    const aside = document.createElement('div');
    aside.className = 'aside';
    const sim = document.createElement('span');
    sim.className = 'sim';
    sim.textContent = (r.similarity * 100).toFixed(0) + '%';
    aside.appendChild(sim);
    row.appendChild(aside);
  }
  row.addEventListener('click', () => (isCard ? openWikiPage(r) : openTrajectory(r)));
  row.addEventListener('mouseenter', () => setActive(i));
  return row;
}

function renderResults(list) {
  clear(resultsEl);
  rows = [];
  activeIndex = -1;
  visible = INITIAL_VISIBLE;

  // Knowledge first: wiki pages are answer cards; dream/raw are the dated
  // episodic record behind them — deduped, collapsed by default.
  const wiki = list.filter((r) => r.tier === 'wiki');
  const episodic = [];
  for (const r of list.filter((r) => r.tier !== 'wiki')) {
    const ws = wordSet(r.snippet);
    const dupe = episodic.find((k) => similar(ws, k._ws));
    if (dupe) { dupe._dupes = (dupe._dupes || 0) + 1; continue; }
    r._ws = ws;
    episodic.push(r);
  }
  items = wiki.concat(episodic);
  wikiN = wiki.length;

  items.forEach((r, i) => {
    if (i === wikiN && wikiN > 0 && episodic.length > 0) {
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = 'episodic memory';
      resultsEl.appendChild(label);
    }
    const row = buildRow(r, i, i < wikiN);
    if (i >= wikiN + visible) row.classList.add('hidden');
    resultsEl.appendChild(row);
    rows.push(row);
  });
}

function buildRecentRow(item, i) {
  const row = document.createElement('div');
  row.className = 'result';
  const gutter = document.createElement('div');
  gutter.className = 'gutter';
  gutter.textContent = relAge(item.timestamp);
  row.appendChild(gutter);
  const body = document.createElement('div');
  body.className = 'body';
  const snip = document.createElement('div');
  snip.className = 'snippet';
  snip.textContent = item.label || item.key;
  body.appendChild(snip);
  row.appendChild(body);
  if (item._aside) {
    const aside = document.createElement('div');
    aside.className = 'aside';
    const sim = document.createElement('span');
    sim.className = 'sim';
    sim.textContent = item._aside;
    aside.appendChild(sim);
    row.appendChild(aside);
  }
  row.addEventListener('click', () => openItem(item));
  row.addEventListener('mouseenter', () => setActive(i));
  return row;
}

function appendRecentGroup(heading, group) {
  if (!group.length) return;
  const lab = document.createElement('div');
  lab.className = 'section-label';
  lab.textContent = heading;
  resultsEl.appendChild(lab);
  for (const item of group) {
    const i = items.length;
    const row = buildRecentRow(item, i);
    resultsEl.appendChild(row);
    rows.push(row); items.push(item);
  }
}

// Empty-state: recent searches / asks / recently viewed, then "unanswered
// lately" (unmet-demand queries) below. Recents come from /api/recents; the
// demand group from GET /api/demand — both are cosmetic, so a missing endpoint
// (404 / network / T2 not yet landed) just drops its group, never throws.
async function showRecents() {
  if (inflight) { inflight.abort(); inflight = null; }
  clear(resultsEl);
  rows = []; items = []; activeIndex = -1; wikiN = 0;
  moreEl.style.display = 'none';
  statusEl.textContent = '';
  const [list, demand] = await Promise.all([
    fetch('/api/recents').then((r) => r.json()).catch(() => null),
    fetch('/api/demand?days=30').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  // The log keeps non-consecutive repeats (it doubles as the demand signal);
  // the display is LRU-style — one row per kind+key, newest wins.
  if (Array.isArray(list)) {
    const seen = new Set();
    const uniq = list.filter((r) => {
      const k = r.kind + '\n' + r.key;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const toItems = (kind) => uniq.filter((r) => r.kind === kind).slice(0, 8)
      .map((rec) => ({ _recent: rec.kind, key: rec.key, label: rec.label, timestamp: normTs(rec.timestamp) }));
    appendRecentGroup('recent searches', toItems('search'));
    appendRecentGroup('recent asks', toItems('ask'));
    appendRecentGroup('recently viewed', toItems('view'));
  }
  // Unmet demand: queries that returned nothing / weak / uncovered. Clicking a
  // row restores the query so it can be re-run (or asked).
  if (demand && Array.isArray(demand.unmet) && demand.unmet.length) {
    const unmet = demand.unmet.slice(0, 8).map((u) => ({
      _recent: 'demand',
      key: u.query,
      label: u.query,
      timestamp: normTs(u.latestTs),
      _aside: u.count ? u.count + '×' : '',
    }));
    appendRecentGroup('unanswered lately', unmet);
  }
  // All recents are visible; keep the reveal machinery inert (no hiding, no
  // "show more from history" in the empty state).
  visible = items.length;
}

export async function search(q) {
  // Keep the answer card only while it still matches the query. Typing already
  // clears it on `input`; this covers programmatic query changes (back/forward,
  // clicking a recent row). A scope change re-runs search with the SAME query,
  // so the card survives — the tier-keyed cache guards against a mismatch.
  const askCardQuery = getAskCardQuery();
  if (askCardQuery !== null && askCardQuery !== q.trim()) clearAnswer();
  if (inflight) inflight.abort();
  if (!q.trim()) {
    latencyEl.textContent = '';
    showRecents();
    return;
  }
  const ctrl = new AbortController();
  inflight = ctrl;
  statusEl.textContent = 'searching…';
  const t0 = performance.now();
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&k=' + FETCH_K + '&tier=' + SCOPE_TIER[getScope()], { signal: ctrl.signal });
    const list = await res.json();
    if (ctrl.signal.aborted) return;
    inflight = null;
    const ms = Math.round(performance.now() - t0);
    if (!Array.isArray(list)) { statusEl.textContent = 'error'; return; }
    latencyEl.textContent = ms + 'ms';
    renderResults(list);
    updateStatus();
  } catch (err) {
    if (err.name === 'AbortError') return;
    statusEl.textContent = 'error';
  }
}

// Open dispatch shared by clicks, Enter, and recents rows.
function openItem(r) {
  if (r._recent === 'search' || r._recent === 'demand') { qEl.value = r.key; search(r.key); updateHash({ view: 'search', q: r.key.trim() }, {}); return; }
  // A recent ask row is a deliberate re-ask: restore the query and fire it
  // (search runs too, to populate the results beneath the card).
  if (r._recent === 'ask') { qEl.value = r.key; search(r.key); updateHash({ view: 'search', q: r.key.trim() }, {}); runAskUI(); return; }
  if (r._recent === 'view') { openRecentView(r.key); return; }
  if (r.tier === 'wiki') { openWikiPage(r); return; }
  openTrajectory(r);
}

function openRecentView(key) {
  if (key.startsWith('wiki:')) openWikiPage({ slug: key.slice(5), trajectoryId: key, tier: 'wiki' });
  else if (key.startsWith('traj:')) openTrajectory({ trajectoryId: key.slice(5) });
}

qEl.addEventListener('input', () => {
  clearAnswer(); // editing the query invalidates the echoed answer
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    search(qEl.value);
    updateHash({ view: 'search', q: qEl.value.trim() }, { replace: true }); // debounced: replace while typing
  }, DEBOUNCE_MS);
});
qEl.addEventListener('keydown', (e) => {
  // Cmd/Ctrl+Enter = ask (a paid, grounded call); plain Enter keeps its
  // open-row / re-run-search semantics below.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    runAskUI();
    return;
  }
  if (e.key === 'Enter') {
    if (activeIndex >= 0 && items[activeIndex]) { openItem(items[activeIndex]); return; }
    clearTimeout(debounceTimer);
    search(qEl.value);
    updateHash({ view: 'search', q: qEl.value.trim() }, {}); // explicit: push a history entry
  } else if (e.key === 'ArrowDown') {
    if (rows.length) {
      e.preventDefault();
      // Stepping past the last visible row reveals the next hidden one.
      const limit = wikiN + visible;
      if (activeIndex >= limit - 1 && limit < items.length) reveal(visible + 1);
      setActive(Math.min(activeIndex + 1, wikiN + visible - 1));
    }
  } else if (e.key === 'ArrowUp') {
    if (rows.length) { e.preventDefault(); setActive(Math.max(activeIndex - 1, 0)); }
  }
});
