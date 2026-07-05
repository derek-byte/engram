  // One design everywhere; the Tauri webview scopes traffic-light padding + drag
  // region under this class so the browser never reserves that space.
  if (window.__TAURI__) document.documentElement.classList.add('tauri');

  const FETCH_K = 25;       // fetched per query (server clamps at 50)
  const INITIAL_VISIBLE = 3; // compact default; ↓ past the last row reveals more
  const DEBOUNCE_MS = 200;

  const qEl = document.getElementById('q');
  const statusEl = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  const statsEl = document.getElementById('stats');
  const latencyEl = document.getElementById('latency');
  const moreEl = document.getElementById('more');
  const askBtnEl = document.getElementById('ask-btn');
  const answerEl = document.getElementById('answer');
  const resultsPaneEl = document.getElementById('results-pane');
  const overlayEl = document.getElementById('overlay');
  const overlayBodyEl = document.getElementById('overlay-body'); // the overlay's scroll container
  const overlayMetaEl = document.getElementById('overlay-meta');
  const turnsEl = document.getElementById('turns');
  const pageEl = document.getElementById('page');
  const scopeEl = document.getElementById('scope');
  const sidebarEl = document.getElementById('sidebar');
  const wikiListEl = document.getElementById('wiki-list');
  document.getElementById('back').addEventListener('click', closeOverlay);
  moreEl.addEventListener('click', () => reveal(visible + 5));

  // ── sliding selection pill ──
  // Shared by the discrete selection controls (sidebar nav, scope tabs): one
  // .slide-hl node per container, translated/resized to the selected item so
  // the pill glides from the old selection to the new one on click / keyboard.
  // Hover stays each item's own static CSS tint — nothing here tracks the mouse.
  // API: { moveTo(el), hide() }
  //   moveTo(el) — slide the pill to el; on first placement it appears in
  //                place (no fly-in from 0,0). moveTo(null) hides it.
  //   hide()     — fade out (no current selection)
  function attachSlidingHighlight(container, opts) {
    opts = opts || {};
    const hl = document.createElement('div');
    hl.className = 'slide-hl';
    if (opts.radius != null) hl.style.borderRadius = opts.radius + 'px';
    container.appendChild(hl);
    let shown = false;

    // offsetLeft/Top are relative to the container (the pill's offsetParent),
    // the same coordinate frame the items live in.
    function place(el) {
      hl.style.transform = 'translate(' + el.offsetLeft + 'px,' + el.offsetTop + 'px)';
      hl.style.width = el.offsetWidth + 'px';
      hl.style.height = el.offsetHeight + 'px';
    }
    function moveTo(el) {
      if (!el) { hide(); return; }
      if (!shown) {
        // First placement (view load): appear at the target rather than flying
        // in — place with transitions off, force a reflow, then restore.
        const prev = hl.style.transition;
        hl.style.transition = 'none';
        place(el);
        void hl.offsetWidth;
        hl.style.transition = prev;
        shown = true;
      } else {
        place(el);
      }
      hl.style.opacity = '1';
    }
    function hide() {
      hl.style.opacity = '0';
      shown = false;
    }
    return { moveTo, hide };
  }

  const navHL = attachSlidingHighlight(sidebarEl, { radius: 8 });
  const scopeHL = attachSlidingHighlight(scopeEl, { radius: 5 });

  // ── sidebar nav / views ──
  let currentView = 'search';

  // ── hash routing ──
  // location.hash is the single source of truth. Nav actions call updateHash()
  // to record history (push) or rewrite the current entry (replace); the
  // hashchange listener (browser back/forward) calls routeFromHash() to re-apply
  // state. We mutate history via push/replaceState — which do NOT fire
  // hashchange — so our own updates never re-enter the router; `applyingRoute`
  // additionally suppresses updateHash while routeFromHash drives showView/
  // openWikiPage/closeOverlay, so re-applying a route never pushes a dup entry.
  //   #/search            search view (empty query → recents)
  //   #/search?q=<query>  search view, query restored + run
  //   #/wiki              wiki index
  //   #/wiki/<slug>       wiki page overlay over the wiki view
  //   #/settings          settings view
  // Push on explicit navigation (nav click, open page, open settings,
  // Enter/open a result); replace while typing and on close / Esc-reset — so
  // window hides don't grow history and a Tauri summon lands cleanly on search.
  let applyingRoute = false;
  let overlayWikiSlug = null; // slug of the wiki page in the overlay, else null

  function stateForView(name) {
    return name === 'search' ? { view: 'search', q: qEl.value.trim() } : { view: name };
  }
  function hashFor(s) {
    if (s.view === 'wiki') return s.slug ? '#/wiki/' + encodeURIComponent(s.slug) : '#/wiki';
    if (s.view === 'analytics') return '#/analytics';
    if (s.view === 'setup') return '#/setup';
    if (s.view === 'settings') return '#/settings';
    return s.q ? '#/search?q=' + encodeURIComponent(s.q) : '#/search';
  }
  function updateHash(state, opts) {
    if (applyingRoute) return;                 // the router is driving; don't fight it
    const h = hashFor(state);
    if (h === location.hash) return;           // compare-before-apply: nothing changed
    const url = location.pathname + location.search + h;
    if (opts && opts.replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const qi = raw.indexOf('?');
    const path = qi === -1 ? raw : raw.slice(0, qi);
    const query = qi === -1 ? '' : raw.slice(qi + 1);
    const segs = path.split('/').filter(Boolean);
    const head = segs[0] || 'search';
    if (head === 'wiki') return { view: 'wiki', slug: segs[1] ? decodeURIComponent(segs[1]) : null };
    if (head === 'analytics') return { view: 'analytics' };
    if (head === 'setup') return { view: 'setup' };
    if (head === 'settings') return { view: 'settings' };
    if (head === 'search') {
      let q = '';
      if (query) { try { q = new URLSearchParams(query).get('q') || ''; } catch { q = ''; } }
      return { view: 'search', q };
    }
    return null; // unknown → default to search
  }
  function routeFromHash() {
    let st = parseHash();
    if (!st || !location.hash) {                // unknown / empty hash → #/search (silent)
      st = { view: 'search', q: '' };
      history.replaceState(null, '', location.pathname + location.search + '#/search');
    }
    applyingRoute = true;
    try {
      if (currentView !== st.view) showView(st.view);
      if (st.view === 'search') {
        const q = st.q || '';
        if (qEl.value !== q) qEl.value = q;
        if (overlayEl.classList.contains('open')) closeOverlay();
        search(q);
      } else if (st.view === 'settings' || st.view === 'analytics' || st.view === 'setup') {
        if (overlayEl.classList.contains('open')) closeOverlay();
      } else if (st.view === 'wiki') {
        if (st.slug) {
          if (overlayWikiSlug !== st.slug) openWikiPage({ slug: st.slug, trajectoryId: 'wiki:' + st.slug, tier: 'wiki' });
        } else if (overlayEl.classList.contains('open')) {
          closeOverlay();
        }
      }
    } finally {
      applyingRoute = false;
    }
  }
  window.addEventListener('hashchange', routeFromHash);

  function showView(name, opts) {
    if (!['search', 'wiki', 'analytics', 'setup', 'settings'].includes(name)) return;
    // Leaving Analytics tears down any askeval poll — it must never tick while
    // the tab is on another view.
    if (name !== 'analytics') stopAskevalPoll();
    currentView = name;
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === name + '-view');
    for (const b of sidebarEl.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === name);
    navHL.moveTo(sidebarEl.querySelector('.nav-item.active')); // slide the green pill to the new selection
    if (name === 'search') qEl.focus();
    else if (name === 'wiki') loadWiki();
    else if (name === 'analytics') loadAnalytics();
    else if (name === 'setup') loadSetup();
    else if (name === 'settings') loadSettings();
    updateHash(stateForView(name), opts); // push by default; opts.replace for resets
  }
  sidebarEl.addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) showView(b.dataset.view);
  });

  // Exposed for the Tauri shell (tray "Settings…", ESC composition) and the
  // settings-pane agent. openSettings/closeSettings switch the main-region view.
  function openSettings() { showView('settings'); }
  function closeSettings() { showView('search'); } // showView('search') returns focus to #q
  window.openSettings = openSettings;
  window.closeSettings = closeSettings;
  // True when a modal-like surface is up: the settings pane OR the overlay
  // (wiki page / trajectory). The Tauri ESC script uses this to decide whether
  // Esc closes a surface or hides the window.
  window.__engramModalOpen = () => currentView === 'settings' || overlayEl.classList.contains('open');

  // ── tier scope ──
  // knowledge = synth (wiki+dream, the API default), history = raw, all = every tier.
  const SCOPE_TIER = { knowledge: 'synth', history: 'raw', all: 'all' };
  const SCOPES = ['knowledge', 'history', 'all'];
  const SLUG_RE = /^[a-z0-9-]{1,64}$/; // mirrors isValidSlug (src/wiki/links.ts)
  let scope = localStorage.getItem('engram.scope');
  if (!SCOPE_TIER[scope]) scope = 'knowledge';

  function renderScope() {
    for (const s of scopeEl.querySelectorAll('span')) {
      s.classList.toggle('on', s.dataset.scope === scope);
    }
    scopeHL.moveTo(scopeEl.querySelector('span.on')); // slide the pill to the selected tab
  }
  function setScope(next) {
    if (!SCOPE_TIER[next] || next === scope) return;
    scope = next;
    localStorage.setItem('engram.scope', scope);
    renderScope();
    // Re-run the current query immediately (skip the debounce); empty box just
    // moves the highlight.
    clearTimeout(debounceTimer);
    if (qEl.value.trim()) search(qEl.value);
  }
  function cycleScope(dir) {
    const i = SCOPES.indexOf(scope);
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

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return isNaN(d) ? '' : d.toLocaleString();
  }

  // Date-only (no clock) for evidence spans like "Jan 3 → Feb 1".
  function fmtDay(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return isNaN(d) ? '' : d.toLocaleDateString();
  }

  // Compact relative age like "9d", "3h", "5m".
  function relAge(ts) {
    if (!ts) return '';
    const then = new Date(ts).getTime();
    if (isNaN(then)) return '';
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return Math.floor(s) + 's';
    const m = s / 60;
    if (m < 60) return Math.floor(m) + 'm';
    const h = m / 60;
    if (h < 24) return Math.floor(h) + 'h';
    const d = h / 24;
    if (d < 7) return Math.floor(d) + 'd';
    const w = d / 7;
    if (w < 5) return Math.floor(w) + 'w';
    const mo = d / 30;
    if (mo < 12) return Math.floor(mo) + 'mo';
    return Math.floor(d / 365) + 'y';
  }

  // Normalize SQLite-style "YYYY-MM-DD HH:MM:SS" (UTC) timestamps to ISO.
  function normTs(ts) {
    return (typeof ts === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ts)) ? ts.replace(' ', 'T') + 'Z' : ts;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // Strip markdown artifacts for display: [[slug|label]] → label, [[slug]] →
  // slug, drop heading markers. The source stays markdown; this is render-only.
  function cleanSnippet(s) {
    return s
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/#{1,6}\s+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Human label for a result's memory tier. Dream/raw are dated episodic
  // snapshots; wiki is current compiled knowledge.
  function tierLabel(r) {
    if (r.tier === 'wiki') return 'wiki' + (r.kind ? ':' + r.kind : '');
    if (r.tier === 'dream') return 'dream' + (r.kind ? ':' + r.kind : '');
    return 'raw';
  }

  async function loadStats() {
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

  // ── wiki nav view (page index) ──
  // Feature-detected: GET /api/wiki may not exist yet in every build; a 404 or
  // network error renders an empty message rather than crashing.
  async function loadWiki() {
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

  async function search(q) {
    // Keep the answer card only while it still matches the query. Typing already
    // clears it on `input`; this covers programmatic query changes (back/forward,
    // clicking a recent row). A scope change re-runs search with the SAME query,
    // so the card survives — the tier-keyed cache guards against a mismatch.
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
      const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&k=' + FETCH_K + '&tier=' + SCOPE_TIER[scope], { signal: ctrl.signal });
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

  // ── ask (grounded answer) ──
  // A verb, never a scope: fires ONLY on Cmd+Enter or the #ask-btn click, never
  // per keystroke / debounce / scope change / plain Enter / zero results. The
  // answer is state within #/search and is NOT routed — back/forward must never
  // re-fire a paid call, and returning from a citation overlay must not lose the
  // card. An in-memory session cache keyed q+tier+repo makes re-asking free and
  // preserves the card across navigation.
  //
  // Interaction decisions:
  //  · Cmd+Enter while an ask is in flight → no-op (stop it via the cancel chip).
  //  · Empty query → no-op.
  //  · Scope change mid-answer → the card STAYS (it's the answer to the question
  //    as asked); the tier-keyed cache means re-asking under the new scope can't
  //    serve the wrong answer. Editing the query text clears the card + aborts.
  //  · Cancel aborts the client fetch only; the server call still completes (and
  //    may cost) — the card says so.
  const askCache = new Map(); // key `q\ntier\nrepo` → terminal result (never errors)
  let askCtrl = null;         // in-flight AbortController, or null
  let askTick = null;         // elapsed-ticker interval id, or null
  let askCardQuery = null;    // query echoed in the current card (null ⇒ no card)

  function askKey(q) { return q + '\n' + SCOPE_TIER[scope] + '\n' + ''; } // repo unused in the UI
  function askModelLabel() { return (settingsCfg && settingsCfg.wikiModel) || 'the wiki model'; }

  // Empty #answer, stop the ticker, abort any in-flight fetch. Called on query
  // edit and before rebuilding the card for a new state.
  function clearAnswer() {
    if (askTick) { clearInterval(askTick); askTick = null; }
    if (askCtrl) { askCtrl.abort(); askCtrl = null; }
    askCardQuery = null;
    clear(answerEl);
  }

  // Fresh .ask-card in a cleared #answer; scrolls the pane to the top so the
  // card is visible even if the user had scrolled into the results.
  function startCard(q) {
    if (askTick) { clearInterval(askTick); askTick = null; }
    clear(answerEl);
    askCardQuery = q;
    const card = document.createElement('div');
    card.className = 'ask-card';
    answerEl.appendChild(card);
    resultsPaneEl.scrollTop = 0;
    return card;
  }
  function askHead(card, metaText, withCancel) {
    const head = document.createElement('div');
    head.className = 'ask-head';
    const kind = document.createElement('span');
    kind.className = 'ask-kind';
    kind.textContent = 'ask';
    head.appendChild(kind);
    const meta = document.createElement('span');
    meta.className = 'ask-meta';
    meta.textContent = metaText;
    head.appendChild(meta);
    if (withCancel) {
      const cancel = document.createElement('span');
      cancel.className = 'ask-cancel';
      cancel.textContent = 'cancel';
      cancel.addEventListener('click', cancelAsk);
      head.appendChild(cancel);
    }
    card.appendChild(head);
    return meta;
  }
  function askQLine(card, q) {
    const el = document.createElement('div');
    el.className = 'ask-q';
    el.textContent = q;
    card.appendChild(el);
  }
  function askNote(card, text) {
    const el = document.createElement('div');
    el.className = 'ask-note';
    el.textContent = text;
    card.appendChild(el);
  }

  // ── artifact chips (DOM-only, never innerHTML, never a file:// href) ──
  // A durable output a trajectory produced. url/pr with an http(s) ref render as
  // a real external anchor; file (and any non-http ref) renders as a chip that
  // copies the path to the clipboard.
  function artifactChipLabel(a) {
    if (a.kind === 'pr') {
      const m = /\/pull\/(\d+)/.exec(a.ref || '');
      return m ? 'PR #' + m[1] : 'PR';
    }
    if (a.kind === 'url') {
      try {
        const u = new URL(a.ref);
        let p = u.pathname || '';
        if (p.length > 24) p = p.slice(0, 23) + '…';
        return u.hostname + (p === '/' ? '' : p);
      } catch { return a.ref; }
    }
    const parts = String(a.ref || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(a.ref || '?');
  }

  function copyArtifact(chip, text, label) {
    const restore = () => { chip.textContent = label; chip.classList.remove('artifact-copied'); };
    const ok = () => { chip.textContent = 'copied'; chip.classList.add('artifact-copied'); setTimeout(restore, 1100); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, restore);
    } catch { /* clipboard unavailable — chip stays inert */ }
  }

  function makeArtifactChip(a) {
    const label = artifactChipLabel(a);
    const isHttp = /^https?:/i.test(a.ref || '');
    if ((a.kind === 'url' || a.kind === 'pr') && isHttp) {
      const link = document.createElement('a');
      link.className = 'artifact-chip artifact-link';
      link.textContent = label;
      link.href = a.ref;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = a.ref;
      // A chip inside a clickable source/turn row must not trigger that row.
      link.addEventListener('click', (e) => e.stopPropagation());
      return link;
    }
    // file (or a non-http url/pr) → copy-to-clipboard, NEVER href="file://…".
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'artifact-chip artifact-copy';
    chip.textContent = label;
    chip.title = a.ref;
    // exists is only sent by /api/wiki; search/ask/trajectory omit it → unknown,
    // which is NOT rendered as missing (unknown ≠ deleted).
    if (a.kind === 'file' && a.exists === false) {
      chip.classList.add('artifact-missing');
      chip.title = a.ref + ' · moved or deleted';
    }
    chip.addEventListener('click', (e) => { e.stopPropagation(); copyArtifact(chip, a.ref, label); });
    return chip;
  }

  function dedupeArtifacts(artifacts) {
    const seen = new Set();
    const out = [];
    for (const a of (artifacts || [])) {
      if (!a || typeof a.ref !== 'string' || seen.has(a.ref)) continue;
      seen.add(a.ref);
      out.push(a);
    }
    return out;
  }

  // Build an artifact strip (dedup by ref, cap the rendered count, append a muted
  // "+N more" when capped). Returns the strip element, or null when there's none.
  function buildArtifactStrip(artifacts, cap, mini) {
    const list = dedupeArtifacts(artifacts);
    if (!list.length) return null;
    const strip = document.createElement('div');
    strip.className = mini ? 'artifact-strip mini' : 'artifact-strip';
    const shown = cap && list.length > cap ? list.slice(0, cap) : list;
    for (const a of shown) strip.appendChild(makeArtifactChip(a));
    if (cap && list.length > cap) {
      const more = document.createElement('span');
      more.className = 'artifact-more';
      more.textContent = '+' + (list.length - cap) + ' more';
      strip.appendChild(more);
    }
    return strip;
  }

  // Citation click-through: wiki → the compiled page; dream/raw → the trajectory
  // overlay with the source chunk highlighted (matchId = chunkId).
  function openAskSource(s) {
    if (s.tier === 'wiki') openWikiPage({ slug: s.ref, trajectoryId: 'wiki:' + s.ref, tier: 'wiki' });
    else openTrajectory({ trajectoryId: s.trajectoryId, id: s.chunkId, tier: s.tier });
  }

  // Prose → text nodes + clickable [n] chips. Split on [n] markers by text (no
  // innerHTML); a marker with no matching source stays literal text.
  function renderProse(container, text, sources) {
    const byN = new Map();
    for (const s of sources) byN.set(s.n, s);
    const re = /\[(\d+)\]/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      const n = parseInt(m[1], 10);
      const src = byN.get(n);
      if (src) {
        const chip = document.createElement('span');
        chip.className = 'cite-chip';
        chip.textContent = '[' + n + ']';
        chip.addEventListener('click', () => openAskSource(src));
        container.appendChild(chip);
      } else {
        container.appendChild(document.createTextNode(m[0]));
      }
      last = re.lastIndex;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  // Compact source line, mirroring formatSourceLine (src/ask/index.ts): a green
  // [n] then `badge · ref · YYYY-MM-DD`. Clickable through to the source.
  function askSrcBadge(s) {
    if (s.tier === 'wiki') return 'wiki:' + (s.dreamType || '?');
    if (s.tier === 'dream') return 'dream:' + (s.dreamType || '?');
    return 'raw';
  }
  function renderCitedFooter(card, cited) {
    const foot = document.createElement('div');
    foot.className = 'ask-foot';
    const label = document.createElement('div');
    label.className = 'ask-foot-label';
    label.textContent = cited.length + ' cited source' + (cited.length === 1 ? '' : 's');
    foot.appendChild(label);
    for (const s of cited) {
      const row = document.createElement('div');
      row.className = 'ask-src';
      const num = document.createElement('span');
      num.className = 'ask-src-n';
      num.textContent = '[' + s.n + ']';
      row.appendChild(num);
      const rest = document.createElement('span');
      rest.textContent = askSrcBadge(s) + ' · ' + (s.ref || '?') + ' · ' + String(s.date || '').slice(0, 10);
      row.appendChild(rest);
      row.addEventListener('click', () => openAskSource(s));
      // Source-level artifacts (no exists flag → never struck-through) as a small
      // strip that wraps under the line; chip clicks don't trigger the row.
      const strip = buildArtifactStrip(s.artifacts, 8, true);
      if (strip) row.classList.add('has-arts');
      if (strip) row.appendChild(strip);
      foot.appendChild(row);
    }
    card.appendChild(foot);
  }

  // Terminal render from a cached-or-fresh result. Three success shapes:
  // answer===null (no candidates), answer with no cited sources (not covered),
  // and a normal cited answer.
  function renderAnswerResult(q, r) {
    const card = startCard(q);
    if (r.answer === null || r.answer === undefined) {
      askHead(card, 'no match', false);
      askQLine(card, q);
      askNote(card, 'No indexed material matched this question — logged as unmet demand. Try the "all" scope, or search below.');
      return;
    }
    const cited = (r.sources || []).filter((s) => s.cited);
    const meta = [r.model, (r.tookMs != null ? (r.tookMs / 1000).toFixed(1) + 's' : null)].filter(Boolean).join(' · ');
    askHead(card, meta, false);
    askQLine(card, q);
    const body = document.createElement('div');
    body.className = 'ask-body';
    renderProse(body, r.answer, r.sources || []);
    card.appendChild(body);
    if (cited.length) {
      renderCitedFooter(card, cited);
    } else {
      askNote(card, 'Not covered by memory — logged as unmet demand.');
    }
  }

  function renderAskError(q, msg) {
    const card = startCard(q);
    askHead(card, 'failed', false);
    askQLine(card, q);
    askNote(card, 'ask failed: ' + msg + ' — results below are plain search.');
  }
  function renderAskNoKey(q) {
    const card = startCard(q);
    askHead(card, 'no api key', false);
    askQLine(card, q);
    askNote(card, 'ask needs an OpenAI API key (Settings) — search below still works.');
  }
  function cancelAsk() {
    if (askTick) { clearInterval(askTick); askTick = null; }
    if (askCtrl) { askCtrl.abort(); askCtrl = null; }
    const q = askCardQuery;
    const card = startCard(q);
    askHead(card, 'cancelled', false);
    askQLine(card, q);
    askNote(card, 'ask cancelled — the server request still completes (and may cost).');
  }

  async function runAskUI() {
    const q = qEl.value.trim();
    if (!q) return;                 // empty query → no-op
    if (askCtrl) return;            // in flight → no-op (cancel via the card chip)
    if (askBtnEl.classList.contains('disabled')) { renderAskNoKey(q); return; }
    const tier = SCOPE_TIER[scope];
    const key = askKey(q);
    if (askCache.has(key)) { renderAnswerResult(q, askCache.get(key)); return; }

    // Known-no-key shortcut; otherwise POST and let a 503 surface the message.
    const cfg = await ensureConfig();
    if (qEl.value.trim() !== q) return; // query changed while probing config
    if (cfg && cfg.hasOpenaiKey === false) { renderAskNoKey(q); return; }

    const card = startCard(q);
    const meta = askHead(card, 'asking ' + askModelLabel() + '… 0s', true);
    askQLine(card, q);
    const t0 = Date.now();
    askTick = setInterval(() => {
      meta.textContent = 'asking ' + askModelLabel() + '… ' + Math.round((Date.now() - t0) / 1000) + 's';
    }, 1000);

    const ctrl = new AbortController();
    askCtrl = ctrl;
    let res;
    try {
      res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, tier }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') return; // cancelled / query edited — handled elsewhere
      if (askTick) { clearInterval(askTick); askTick = null; }
      askCtrl = null;
      renderAskError(q, 'network error');
      return;
    }
    if (ctrl.signal.aborted) return;
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (ctrl.signal.aborted) return;
    if (askTick) { clearInterval(askTick); askTick = null; }
    askCtrl = null;

    if (res.status === 503 || (data && data.error === 'no_api_key')) { renderAskNoKey(q); return; }
    if (!res.ok || !data || typeof data !== 'object' || typeof data.answer === 'undefined') {
      renderAskError(q, (data && data.error) ? String(data.error) : ('http ' + res.status));
      return; // errors are transient — never cached
    }
    const result = {
      answer: data.answer === null ? null : String(data.answer),
      sources: Array.isArray(data.sources) ? data.sources : [],
      model: data.model,
      tookMs: data.tookMs,
    };
    askCache.set(key, result);
    renderAnswerResult(q, result);
  }

  // Shared, lazily-fetched /api/config. The ask affordance needs hasOpenaiKey;
  // the settings pane (below) fetches the full view into settingsCfg. Whichever
  // loads first populates it — this probe fetches once on demand and dedupes.
  let cfgProbe = null;
  function ensureConfig() {
    if (settingsCfg) return Promise.resolve(settingsCfg);
    if (!cfgProbe) {
      cfgProbe = fetch('/api/config')
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => { if (c) settingsCfg = c; cfgProbe = null; updateAskAffordance(); return c; })
        .catch(() => { cfgProbe = null; return null; });
    }
    return cfgProbe;
  }
  // Disable the affordance only when we KNOW there's no key; unknown stays
  // enabled (optimistic) and a POST 503 surfaces the message in-card.
  function updateAskAffordance() {
    const off = !!(settingsCfg && settingsCfg.hasOpenaiKey === false);
    askBtnEl.classList.toggle('disabled', off);
    askBtnEl.title = off
      ? 'Ask needs an OpenAI API key — add one in Settings'
      : 'Ask a grounded question (⌘↵)';
  }

  askBtnEl.addEventListener('click', () => { if (!askBtnEl.classList.contains('disabled')) runAskUI(); });
  askBtnEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!askBtnEl.classList.contains('disabled')) runAskUI(); }
  });

  // Overlay hosts either the trajectory turns or the wiki page; exactly one is
  // shown. back/Escape always returns to results (no view stack).
  function showTurnsView() { pageEl.classList.remove('open'); turnsEl.style.display = ''; }
  function showPageView() { turnsEl.style.display = 'none'; pageEl.classList.add('open'); }

  // ── hand-rolled markdown renderer (DOM-only, never innerHTML) ──
  // Scope: headings, paragraphs, unordered/ordered lists, fenced code, inline
  // code, bold, [text](url) links (http/https only — file: falls to plain text), [[wikilinks]].
  function renderInline(container, text) {
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
          a.addEventListener('click', () => openWikiPage({ slug, trajectoryId: 'wiki:' + slug, tier: 'wiki' }));
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

  function renderMarkdown(container, md) {
    clear(container);
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    const flushPara = (buf) => {
      if (!buf.length) return;
      const p = document.createElement('p');
      renderInline(p, buf.join(' '));
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
        renderInline(h, heading[2].trim());
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
          renderInline(li, item[1]);
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

  let wikiPageReq = 0; // guards rapid opens: only the latest fetch may render
  async function openWikiPage(r) {
    const slug = r.slug;
    const reqId = ++wikiPageReq;
    overlayWikiSlug = slug;
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
    renderMarkdown(bodyEl, page.body || '');
    pageEl.appendChild(bodyEl);
  }

  async function openTrajectory(r) {
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

  function closeOverlay() {
    overlayEl.classList.remove('open');
    const wasWiki = overlayWikiSlug;
    overlayWikiSlug = null;
    qEl.focus();
    // Closing a routed wiki page returns to the underlying view (replace, so the
    // close — and a Tauri Esc-hide — never grows history). Trajectory overlays
    // aren't routed (wasWiki null), so their close leaves the hash untouched.
    if (wasWiki) updateHash(stateForView(currentView), { replace: true });
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
  document.addEventListener('keydown', (e) => {
    // Cmd+, opens settings from anywhere (mirrors the macOS Preferences shortcut).
    if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
    if (e.key === 'Escape') {
      // Compose: overlay first, then any non-search view, else nothing.
      if (overlayEl.classList.contains('open')) { closeOverlay(); return; }
      if (currentView !== 'search') { showView('search', { replace: true }); return; }
      return;
    }
    // Tab cycles scope only in the search view with the overlay closed. On this
    // page Tab has no competing focus role; [ and ] stay usable as query chars.
    if (e.key === 'Tab' && currentView === 'search' && !overlayEl.classList.contains('open')) {
      e.preventDefault();
      cycleScope(e.shiftKey ? -1 : 1);
    }
  });

  // ── settings pane ──
  // Lazy: nothing here fetches until the Settings view is first opened. Every
  // control saves-on-change (Wispr style) and re-renders from the PUT response —
  // the server is the source of truth; a failed save reverts the optimistic UI.
  const settingsBodyEl = document.getElementById('settings-body');
  let settingsCfg = null;         // last known /api/config view
  let settingsScaffolded = false; // one-time DOM scaffold
  let reembedPending = false;     // sticky notice after a provider switch this session
  let settingsErrEl, settingsCfgEl, settingsSvcEl;
  const SVC_NAMES = { 'com.engram.watcher': 'Watcher', 'com.engram.synthesis': 'Synthesis' };

  function buildSettingsScaffold() {
    if (settingsScaffolded) return;
    clear(settingsBodyEl);
    const hint = document.createElement('div');
    hint.className = 'set-hint';
    hint.textContent = 'Changes apply to new runs (next watcher restart / synthesis run / session).';
    settingsBodyEl.appendChild(hint);
    settingsErrEl = document.createElement('div');
    settingsErrEl.className = 'set-error';
    settingsErrEl.style.display = 'none';
    settingsErrEl.setAttribute('role', 'alert');
    settingsBodyEl.appendChild(settingsErrEl);
    settingsCfgEl = document.createElement('div');
    settingsBodyEl.appendChild(settingsCfgEl);
    settingsSvcEl = document.createElement('div');
    settingsBodyEl.appendChild(settingsSvcEl);
    settingsScaffolded = true;
  }

  function settingsError(msg) {
    if (!settingsErrEl) return;
    settingsErrEl.textContent = msg || '';
    settingsErrEl.style.display = msg ? 'block' : 'none';
  }

  async function loadSettings() {
    buildSettingsScaffold();
    await Promise.all([refreshConfig(), refreshServices()]);
  }

  async function refreshConfig() {
    let cfg = null;
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error('http ' + res.status);
      cfg = await res.json();
    } catch {
      settingsError('Could not load settings — is the engram server running?');
      return;
    }
    settingsCfg = cfg;
    settingsError('');
    renderConfigCards();
    updateAskAffordance(); // a key added/removed in Settings flips the ask affordance
  }

  // Save-on-change: PUT the patch, then re-render from the response. On failure,
  // re-render from the unchanged settingsCfg — which reverts the control.
  async function putConfig(patch) {
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error('http ' + res.status);
      const cfg = await res.json();
      settingsCfg = cfg;
      if (cfg.reembedRequired) reembedPending = true;
      settingsError('');
      renderConfigCards();
      updateAskAffordance();
      // A synthesis toggle/hour change may have reconciled the launchd agent.
      if (cfg.synthesisReconcile) refreshServices();
      return cfg;
    } catch {
      settingsError('Save failed — is the engram server running?');
      renderConfigCards();
      return null;
    }
  }

  function makeCard(title, desc) {
    const card = document.createElement('div');
    card.className = 'set-card';
    const h = document.createElement('h2');
    h.textContent = title;
    card.appendChild(h);
    if (desc) {
      const d = document.createElement('div');
      d.className = 'card-desc';
      d.textContent = desc;
      card.appendChild(d);
    }
    return card;
  }

  function makeRow(labelText, subText) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const left = document.createElement('div');
    const lab = document.createElement('div');
    lab.className = 'set-label';
    lab.textContent = labelText;
    left.appendChild(lab);
    if (subText) {
      const s = document.createElement('div');
      s.className = 'set-sub';
      s.textContent = subText;
      left.appendChild(s);
    }
    const control = document.createElement('div');
    control.className = 'set-control';
    row.appendChild(left);
    row.appendChild(control);
    return { row, control };
  }

  function makeToggle(on, onChange) {
    const b = document.createElement('button');
    b.className = 'toggle';
    b.type = 'button';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.addEventListener('click', () => onChange(b.getAttribute('aria-pressed') !== 'true'));
    return b;
  }

  function renderConfigCards() {
    if (!settingsCfgEl) return;
    clear(settingsCfgEl);
    if (!settingsCfg) return;
    const cfg = settingsCfg;
    const ci = cfg.contextInjection || {};
    const syn = cfg.synthesis || {};
    const rr = cfg.rerank || {};

    // Context Injection
    const ciCard = makeCard('Context Injection', 'Surface relevant memory into new agent sessions.');
    const ciEnabled = makeRow('Enabled', 'Inject memory at session start.');
    ciEnabled.control.appendChild(makeToggle(!!ci.enabled, (on) => putConfig({ contextInjection: { enabled: on } })));
    ciCard.appendChild(ciEnabled.row);
    const ciBudget = makeRow('Budget', 'Max characters injected (100–20000).');
    const budgetInput = document.createElement('input');
    budgetInput.type = 'number';
    budgetInput.className = 'set-input num';
    budgetInput.min = '100'; budgetInput.max = '20000'; budgetInput.step = '100';
    budgetInput.value = ci.budget != null ? String(ci.budget) : '';
    budgetInput.addEventListener('change', () => {
      let v = parseInt(budgetInput.value, 10);
      if (isNaN(v)) { renderConfigCards(); return; }
      v = Math.max(100, Math.min(20000, v));
      if (v === ci.budget) { renderConfigCards(); return; }
      putConfig({ contextInjection: { budget: v } });
    });
    ciBudget.control.appendChild(budgetInput);
    ciCard.appendChild(ciBudget.row);
    settingsCfgEl.appendChild(ciCard);

    // Synthesis
    const synCard = makeCard('Synthesis', 'Nightly compilation of raw memory into dreams and wiki pages.');
    const synEnabled = makeRow('Enabled', 'Run synthesis on a schedule.');
    synEnabled.control.appendChild(makeToggle(!!syn.enabled, (on) => putConfig({ synthesis: { enabled: on } })));
    synCard.appendChild(synEnabled.row);
    const synHour = makeRow('Hour', 'Local hour of day to run (0–23).');
    const hourSel = document.createElement('select');
    hourSel.className = 'set-select';
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = String(h).padStart(2, '0') + ':00';
      if (h === syn.hour) opt.selected = true;
      hourSel.appendChild(opt);
    }
    hourSel.addEventListener('change', () => {
      const v = parseInt(hourSel.value, 10);
      if (isNaN(v) || v === syn.hour) return;
      putConfig({ synthesis: { hour: v } });
    });
    synHour.control.appendChild(hourSel);
    synCard.appendChild(synHour.row);
    const synTargeted = makeRow('Targeted sessions / night', 'Max demand-targeted re-dreams per run (0–20, 0 disables).');
    const targetedInput = document.createElement('input');
    targetedInput.type = 'number';
    targetedInput.className = 'set-input num';
    targetedInput.min = '0'; targetedInput.max = '20'; targetedInput.step = '1';
    targetedInput.value = syn.targetedSessionsPerNight != null ? String(syn.targetedSessionsPerNight) : '';
    targetedInput.addEventListener('change', () => {
      let v = parseInt(targetedInput.value, 10);
      if (isNaN(v)) { renderConfigCards(); return; }
      v = Math.max(0, Math.min(20, v));
      if (v === syn.targetedSessionsPerNight) { renderConfigCards(); return; }
      putConfig({ synthesis: { targetedSessionsPerNight: v } });
    });
    synTargeted.control.appendChild(targetedInput);
    synCard.appendChild(synTargeted.row);
    settingsCfgEl.appendChild(synCard);

    // Embedding
    const embCard = makeCard('Embedding', 'Which model produces vector embeddings.');
    const provRow = makeRow('Provider', 'local (on-device) or openai (API).');
    const provSel = document.createElement('select');
    provSel.className = 'set-select';
    for (const p of ['local', 'openai']) {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      if (p === cfg.embeddingProvider) opt.selected = true;
      provSel.appendChild(opt);
    }
    provSel.addEventListener('change', () => {
      const next = provSel.value;
      if (next === cfg.embeddingProvider) return;
      showProviderConfirm(embCard, next, provSel);
    });
    provRow.control.appendChild(provSel);
    embCard.appendChild(provRow.row);
    // Read-only "configured" badges — never the secret itself.
    const keyRow = makeRow('OpenAI API key', 'Read from environment / config.');
    keyRow.control.appendChild(makeBadge(cfg.hasOpenaiKey));
    embCard.appendChild(keyRow.row);
    const dbRow = makeRow('Database URL', 'Read from environment / config.');
    dbRow.control.appendChild(makeBadge(cfg.hasDatabaseUrl));
    embCard.appendChild(dbRow.row);
    if (reembedPending) {
      const notice = document.createElement('div');
      notice.className = 'set-notice';
      notice.appendChild(document.createTextNode('Provider changed — re-embed the index with '));
      const code = document.createElement('code');
      code.textContent = 'engram backfill';
      notice.appendChild(code);
      notice.appendChild(document.createTextNode('.'));
      embCard.appendChild(notice);
    }
    settingsCfgEl.appendChild(embCard);

    // Models
    const modCard = makeCard('Models', 'LLMs used to compile knowledge.');
    modCard.appendChild(makeTextRow('Dream model', 'Summarizes sessions into dream units.', cfg.dreamModel, (v) => {
      if (v === cfg.dreamModel) return;
      putConfig({ dreamModel: v });
    }));
    modCard.appendChild(makeTextRow('Wiki model', 'Compiles dreams into wiki pages.', cfg.wikiModel, (v) => {
      if (v === cfg.wikiModel) return;
      putConfig({ wikiModel: v });
    }));
    settingsCfgEl.appendChild(modCard);

    // Search
    const searchCard = makeCard('Search', 'Retrieval behavior.');
    const rerankRow = makeRow('Rerank', 'Re-score candidates for relevance.');
    rerankRow.control.appendChild(makeToggle(!!rr.enabled, (on) => putConfig({ rerank: { enabled: on } })));
    searchCard.appendChild(rerankRow.row);
    settingsCfgEl.appendChild(searchCard);
  }

  function makeBadge(on) {
    const b = document.createElement('span');
    b.className = 'set-badge' + (on ? ' ok' : '');
    b.textContent = on ? 'configured' : 'not configured';
    return b;
  }

  // Text input row that commits on change/blur; reverts to the current value if
  // the field is blanked (a model name is never empty).
  function makeTextRow(labelText, subText, value, commit) {
    const { row, control } = makeRow(labelText, subText);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'set-input model';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = value || '';
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!v) { renderConfigCards(); return; }
      commit(v);
    });
    control.appendChild(input);
    return row;
  }

  // In-page confirm before an embedding-provider switch (no window.confirm).
  // The PUT is withheld until the user commits; Cancel reverts the select.
  function showProviderConfirm(card, next, sel) {
    const prior = card.querySelector('.set-confirm');
    if (prior) prior.remove();
    const box = document.createElement('div');
    box.className = 'set-confirm';
    const p = document.createElement('p');
    p.textContent = 'Switching providers requires re-embedding your entire index (engram backfill). Continue?';
    box.appendChild(p);
    const row = document.createElement('div');
    row.className = 'row';
    const yes = document.createElement('button');
    yes.className = 'set-btn primary'; yes.type = 'button'; yes.textContent = 'Continue';
    const no = document.createElement('button');
    no.className = 'set-btn'; no.type = 'button'; no.textContent = 'Cancel';
    yes.addEventListener('click', async () => {
      yes.disabled = true; no.disabled = true;
      await putConfig({ embeddingProvider: next }); // success re-renders the card (confirm gone)
    });
    no.addEventListener('click', () => {
      sel.value = settingsCfg ? settingsCfg.embeddingProvider : sel.value; // revert
      box.remove();
    });
    row.appendChild(yes);
    row.appendChild(no);
    box.appendChild(row);
    card.appendChild(box);
  }

  // ── services ──
  async function refreshServices() {
    if (!settingsSvcEl) return;
    let data = null;
    try {
      const res = await fetch('/api/services');
      if (!res.ok) throw new Error('http ' + res.status);
      data = await res.json();
    } catch {
      settingsError('Could not load service status — is the engram server running?');
      return;
    }
    renderServices(data);
  }

  function fmtSchedule(s) {
    if (!s || s.hour == null) return '';
    return 'daily at ' + String(s.hour).padStart(2, '0') + ':00';
  }

  function svcStateText(a) {
    const parts = [];
    parts.push(a.loaded ? (a.state || 'loaded') : 'not loaded');
    if (a.pid) parts.push('pid ' + a.pid);
    const sched = fmtSchedule(a.schedule);
    if (sched) parts.push(sched);
    return parts.join(' · ');
  }

  function renderServices(data) {
    if (!settingsSvcEl) return;
    clear(settingsSvcEl);
    const card = makeCard('Services', 'Background launchd agents.');
    if (!data || !data.supported) {
      const msg = document.createElement('div');
      msg.className = 'empty-msg';
      msg.textContent = 'Background services are only available on macOS.';
      card.appendChild(msg);
      settingsSvcEl.appendChild(card);
      return;
    }
    if (!data.serviceInstalled) {
      const msg = document.createElement('div');
      msg.className = 'empty-msg';
      msg.appendChild(document.createTextNode('Not installed — run '));
      const code = document.createElement('code');
      code.textContent = 'engram service install';
      msg.appendChild(code);
      msg.appendChild(document.createTextNode(' to enable background watching and synthesis.'));
      card.appendChild(msg);
      settingsSvcEl.appendChild(card);
      return;
    }
    for (const agent of (data.agents || [])) {
      const row = document.createElement('div');
      row.className = 'svc-row';
      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'svc-name';
      const dot = document.createElement('span');
      dot.className = 'svc-dot' + (agent.loaded ? ' on' : '');
      name.appendChild(dot);
      name.appendChild(document.createTextNode(SVC_NAMES[agent.label] || agent.label));
      left.appendChild(name);
      const state = document.createElement('div');
      state.className = 'svc-state';
      state.textContent = svcStateText(agent);
      left.appendChild(state);
      row.appendChild(left);
      const btn = document.createElement('button');
      btn.className = 'set-btn';
      btn.type = 'button';
      btn.textContent = 'Restart';
      btn.addEventListener('click', () => restartService(agent.label, btn));
      row.appendChild(btn);
      card.appendChild(row);
    }
    settingsSvcEl.appendChild(card);
  }

  async function restartService(label, btn) {
    btn.disabled = true;
    btn.textContent = 'Restarting…';
    try {
      const res = await fetch('/api/services/' + encodeURIComponent(label) + '/restart', { method: 'POST' });
      if (!res.ok) throw new Error('http ' + res.status);
      settingsError('');
    } catch {
      settingsError('Restart failed for ' + (SVC_NAMES[label] || label) + '.');
    }
    await refreshServices(); // rebuilds the rows (fresh state, re-enabled button)
  }

  // ── analytics view ──
  // Lazy on first open, refreshed on re-open (showView calls loadAnalytics). One
  // read-only /api/analytics payload plus the live /api/demand and /api/lint
  // reads back four cards: demand, context injection, answer-eval, wiki lint.
  // The only stateful piece is the askeval poll (startAskevalPoll) — it MUST
  // stop when the view is left (showView clears it) and never tick off-view.
  const analyticsBodyEl = document.getElementById('analytics-body');
  document.getElementById('analytics-refresh').addEventListener('click', () => loadAnalytics());

  let askevalPoll = null; // 2s interval id while an askeval run is in flight, else null

  function stopAskevalPoll() {
    if (askevalPoll) { clearInterval(askevalPoll); askevalPoll = null; }
  }

  function analyticsMsg(text) {
    clear(analyticsBodyEl);
    const p = document.createElement('div');
    p.className = 'empty-msg';
    p.textContent = text;
    analyticsBodyEl.appendChild(p);
  }

  // Pill badge with arbitrary text; `.ok` tints it accent (matches .set-badge).
  function stateBadge(on, text) {
    const b = document.createElement('span');
    b.className = 'set-badge' + (on ? ' ok' : '');
    b.textContent = text;
    return b;
  }

  // Inline SVG sparkline (pure createElementNS, never innerHTML): a polyline of
  // the given values scaled into a w×h box. Returns the <svg>, null with <2 pts.
  function sparkline(values, w, h) {
    if (!Array.isArray(values) || values.length < 2) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'an-spark');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const pad = 2;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const stepX = (w - pad * 2) / (values.length - 1);
    const pts = values.map((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    const poly = document.createElementNS(NS, 'polyline');
    poly.setAttribute('points', pts.join(' '));
    svg.appendChild(poly);
    return svg;
  }

  // Delta glyph + count between the two latest snapshot values (newest first);
  // for these fewer-is-better metrics ↓ reads as an improvement.
  function deltaText(newest, prev, unit) {
    if (prev == null) return '';
    const d = newest - prev;
    if (d === 0) return ' · no change since last synthesis';
    return ' · ' + (d < 0 ? '↓' : '↑') + Math.abs(d) + ' ' + unit + ' since last synthesis';
  }

  async function loadAnalytics() {
    clear(analyticsBodyEl);
    const [analytics, demand, lint] = await Promise.all([
      fetch('/api/analytics').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/demand?days=30').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/lint').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!analytics) { analyticsMsg('Analytics unavailable — is the engram server running?'); return; }
    renderDemandCard(analytics.demandTrend || [], demand);
    renderContextCard(analytics.context || {});
    renderAskevalCard(analytics.askevalRuns || []);
    renderLintCard(analytics.lintTrend || [], lint);
    // Resume the live readout if a run is already in flight (started in a prior
    // session / via the CLI). Guarded by a job-status probe so a stale 'running'
    // row can't spin up an endless poll↔reload loop.
    const runs = analytics.askevalRuns || [];
    if (runs[0] && runs[0].status === 'running') resumeAskevalIfRunning();
  }

  function renderDemandCard(trend, demand) {
    const card = makeCard('Demand', 'Queries your memory could not answer.');
    if (!trend.length) {
      const note = document.createElement('div');
      note.className = 'an-note';
      note.textContent = 'no synthesis runs recorded yet';
      card.appendChild(note);
    } else {
      // trend is newest-first; the sparkline wants oldest→newest.
      const series = trend.slice().reverse().map((s) => Number((s.payload || {}).unmetQueries) || 0);
      const trendRow = document.createElement('div');
      trendRow.className = 'an-trend';
      const spark = sparkline(series, 120, 28);
      if (spark) trendRow.appendChild(spark);
      const newest = Number((trend[0].payload || {}).unmetQueries) || 0;
      const prev = trend[1] ? (Number((trend[1].payload || {}).unmetQueries) || 0) : null;
      const label = document.createElement('span');
      label.className = 'an-delta';
      label.textContent = newest + ' unmet ' + (newest === 1 ? 'query' : 'queries') + deltaText(newest, prev, 'unmet');
      trendRow.appendChild(label);
      card.appendChild(trendRow);
    }
    // Current unmet table (mirrors `engram demand`: count / last / coverage / query).
    const unmet = demand && Array.isArray(demand.unmet) ? demand.unmet : [];
    if (unmet.length) {
      const table = document.createElement('div');
      table.className = 'an-table';
      for (const u of unmet.slice(0, 12)) {
        const row = document.createElement('div');
        row.className = 'an-row an-row-click';
        const count = document.createElement('span');
        count.className = 'an-c-count';
        count.textContent = (u.count || 0) + '×';
        const age = document.createElement('span');
        age.className = 'an-c-age';
        age.textContent = relAge(normTs(u.latestTs));
        const cov = document.createElement('span');
        cov.className = 'an-c-cov';
        cov.textContent = u.topTier === 'raw' && u.topSessionId ? 'raw' : (u.topTier || '—');
        const query = document.createElement('span');
        query.className = 'an-c-query';
        query.textContent = u.query;
        row.appendChild(count); row.appendChild(age); row.appendChild(cov); row.appendChild(query);
        row.addEventListener('click', () => openDemandQuery(u.query));
        table.appendChild(row);
      }
      card.appendChild(table);
    } else if (trend.length) {
      const note = document.createElement('div');
      note.className = 'an-note';
      note.textContent = 'no unmet demand in the last 30 days';
      card.appendChild(note);
    }
    analyticsBodyEl.appendChild(card);
  }

  // Clicking an unmet row jumps to Search with the query restored + run.
  function openDemandQuery(q) {
    qEl.value = q;
    showView('search');   // pushes #/search?q=… (stateForView reads qEl.value)
    search(q);
  }

  function renderContextCard(ctx) {
    const card = makeCard('Context Injection', 'Memory injected into new agent sessions.');
    const badges = document.createElement('div');
    badges.className = 'an-badges';
    badges.appendChild(stateBadge(!!ctx.configEnabled, ctx.configEnabled ? 'enabled' : 'disabled'));
    const hook = ctx.hook || {};
    let hookText, hookOk, hookAction;
    if (!hook.installed) { hookText = 'hook missing'; hookOk = false; hookAction = 'install'; }
    else if (hook.stalePath) { hookText = 'hook stale'; hookOk = false; hookAction = 'install'; }
    else { hookText = 'hook installed'; hookOk = true; hookAction = 'uninstall'; }
    badges.appendChild(stateBadge(hookOk, hookText));
    card.appendChild(badges);

    const fires = document.createElement('div');
    fires.className = 'an-note';
    if (ctx.count) {
      let t = ctx.count + ' injection' + (ctx.count === 1 ? '' : 's') + ' · 30d (' + (ctx.last7d || 0) + ' · 7d)';
      if (ctx.lastTs) t += ' · last ' + relAge(normTs(ctx.lastTs));
      fires.textContent = t;
    } else {
      fires.textContent = 'no injections recorded in the last 30 days';
    }
    card.appendChild(fires);

    const actions = document.createElement('div');
    actions.className = 'an-actions';
    const btn = document.createElement('button');
    btn.className = 'set-btn';
    btn.type = 'button';
    btn.textContent = hookAction === 'install' ? 'install hook' : 'uninstall hook';
    btn.addEventListener('click', () => mutateHook(hookAction, btn));
    actions.appendChild(btn);
    card.appendChild(actions);
    analyticsBodyEl.appendChild(card);
  }

  async function mutateHook(action, btn) {
    btn.disabled = true;
    btn.textContent = action === 'install' ? 'installing…' : 'uninstalling…';
    try {
      const res = await fetch('/api/hook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error('http ' + res.status);
    } catch { /* a failed toggle just re-renders unchanged */ }
    loadAnalytics(); // refresh from fresh hook status
  }

  function renderAskevalCard(runs) {
    const card = makeCard('Answer Eval', 'Citation-faithfulness of engram ask (paid, minutes to run).');
    const last = runs[0];
    if (last && last.summary && typeof last.summary === 'object') {
      const s = last.summary;
      const sum = document.createElement('div');
      sum.className = 'an-note';
      const parts = [];
      if (typeof s.faithfulnessPct === 'number') parts.push(s.faithfulnessPct + '% faithful');
      parts.push((s.supported ?? 0) + ' supported · ' + (s.partial ?? 0) + ' partial · ' + (s.unsupported ?? 0) + ' unsupported');
      if (typeof s.costUsd === 'number') parts.push('$' + s.costUsd.toFixed(2));
      sum.textContent = parts.join(' · ');
      card.appendChild(sum);
    }
    // Live progress readout, filled by the poll while a run is in flight.
    const status = document.createElement('div');
    status.className = 'an-note an-eval-status';
    status.id = 'an-eval-status';
    card.appendChild(status);
    if (runs.length) {
      const table = document.createElement('div');
      table.className = 'an-table';
      for (const r of runs) {
        const row = document.createElement('div');
        row.className = 'an-row';
        const date = document.createElement('span');
        date.className = 'an-c-age';
        date.textContent = relAge(normTs(r.startedAt));
        const st = document.createElement('span');
        st.className = 'an-c-cov';
        st.textContent = r.status;
        const f = document.createElement('span');
        f.className = 'an-c-query';
        f.textContent = (r.summary && typeof r.summary.faithfulnessPct === 'number') ? r.summary.faithfulnessPct + '% faithful' : '—';
        row.appendChild(date); row.appendChild(st); row.appendChild(f);
        table.appendChild(row);
      }
      card.appendChild(table);
    }
    const actions = document.createElement('div');
    actions.className = 'an-actions';
    const btn = document.createElement('button');
    btn.className = 'set-btn';
    btn.type = 'button';
    btn.textContent = 'Run eval';
    btn.addEventListener('click', () => showAskevalConfirm(card, btn));
    actions.appendChild(btn);
    card.appendChild(actions);
    analyticsBodyEl.appendChild(card);
  }

  // In-page confirm (reuses the provider-switch .set-confirm pattern): a paid,
  // minutes-long run gets an explicit money/time warning + a limit input.
  function showAskevalConfirm(card, btn) {
    const prior = card.querySelector('.set-confirm');
    if (prior) { prior.remove(); return; }
    const box = document.createElement('div');
    box.className = 'set-confirm';
    const p = document.createElement('p');
    p.textContent = 'Running the eval calls the ask + judge models for real — it costs money and takes minutes. Continue?';
    box.appendChild(p);
    const limitRow = document.createElement('div');
    limitRow.className = 'an-confirm-row';
    const lab = document.createElement('span');
    lab.className = 'an-confirm-label';
    lab.textContent = 'questions';
    const limit = document.createElement('input');
    limit.type = 'number';
    limit.className = 'set-input num';
    limit.min = '1'; limit.max = '50'; limit.step = '1'; limit.value = '20';
    limitRow.appendChild(lab);
    limitRow.appendChild(limit);
    box.appendChild(limitRow);
    const row = document.createElement('div');
    row.className = 'row';
    const yes = document.createElement('button');
    yes.className = 'set-btn primary'; yes.type = 'button'; yes.textContent = 'Run';
    const no = document.createElement('button');
    no.className = 'set-btn'; no.type = 'button'; no.textContent = 'Cancel';
    yes.addEventListener('click', () => {
      let n = parseInt(limit.value, 10);
      if (isNaN(n)) n = 20;
      n = Math.max(1, Math.min(50, n));
      yes.disabled = true; no.disabled = true;
      box.remove();
      startAskevalRun(n);
    });
    no.addEventListener('click', () => box.remove());
    row.appendChild(yes);
    row.appendChild(no);
    box.appendChild(row);
    card.appendChild(box);
  }

  async function startAskevalRun(limit) {
    setAskevalStatus('starting…');
    let res;
    try {
      res = await fetch('/api/jobs/askeval/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit }),
      });
    } catch {
      setAskevalStatus('could not start the run — is the engram server running?');
      return;
    }
    if (res.status === 202) { startAskevalPoll(); return; }
    if (res.status === 409) { setAskevalStatus('already running'); startAskevalPoll(); return; }
    setAskevalStatus('run failed to start (http ' + res.status + ')');
  }

  function setAskevalStatus(text) {
    const el = document.getElementById('an-eval-status');
    if (el) el.textContent = text;
  }

  // Latest {phase:'question'} line in the runner's lastLines tail (JSON/line).
  function latestQuestionLine(lastLines) {
    if (!Array.isArray(lastLines)) return null;
    for (let i = lastLines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lastLines[i]);
        if (o && o.phase === 'question') return o;
      } catch { /* non-JSON tail line */ }
    }
    return null;
  }

  function startAskevalPoll() {
    stopAskevalPoll();
    const tick = async () => {
      if (currentView !== 'analytics') { stopAskevalPoll(); return; } // never tick off-view
      let data;
      try {
        const res = await fetch('/api/jobs/askeval');
        if (!res.ok) return;
        data = await res.json();
      } catch { return; }
      if (data.running) {
        const q = latestQuestionLine(data.lastLines);
        setAskevalStatus(q ? ('question ' + q.i + '/' + q.of + ' · ' + (q.label || '')) : 'running…');
      } else {
        stopAskevalPoll();
        loadAnalytics(); // run finished — refresh summary + history
      }
    };
    askevalPoll = setInterval(tick, 2000);
    tick(); // don't wait 2s for the first readout
  }

  // On view open with a 'running' run row: probe the runner ONCE. Only spin up
  // the poll if the job is genuinely running — a crashed run leaves a stale
  // 'running' row, and reload-on-stop would otherwise loop forever.
  async function resumeAskevalIfRunning() {
    let data;
    try {
      const res = await fetch('/api/jobs/askeval');
      if (!res.ok) return;
      data = await res.json();
    } catch { return; }
    if (data.running && currentView === 'analytics') startAskevalPoll();
  }

  function renderLintCard(trend, lint) {
    const card = makeCard('Wiki Lint', 'Health of the compiled wiki.');
    if (trend.length) {
      const newest = Number((trend[0].payload || {}).warns) || 0;
      const prev = trend[1] ? (Number((trend[1].payload || {}).warns) || 0) : null;
      const delta = document.createElement('div');
      delta.className = 'an-note';
      delta.textContent = newest + ' warning' + (newest === 1 ? '' : 's') + deltaText(newest, prev, 'warns');
      card.appendChild(delta);
    }
    const findings = lint && Array.isArray(lint.findings) ? lint.findings : null;
    if (findings === null) {
      const note = document.createElement('div');
      note.className = 'an-note';
      note.textContent = 'lint unavailable';
      card.appendChild(note);
    } else if (!findings.length) {
      const note = document.createElement('div');
      note.className = 'an-note';
      note.textContent = 'no lint findings — the wiki is clean';
      card.appendChild(note);
    } else {
      const byRule = new Map();
      for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) || 0) + 1);
      const table = document.createElement('div');
      table.className = 'an-table';
      for (const [rule, count] of byRule) {
        const row = document.createElement('div');
        row.className = 'an-row';
        const r = document.createElement('span');
        r.className = 'an-c-rule';
        r.textContent = rule;
        const c = document.createElement('span');
        c.className = 'an-c-count-r';
        c.textContent = String(count);
        row.appendChild(r); row.appendChild(c);
        table.appendChild(row);
      }
      card.appendChild(table);
    }
    analyticsBodyEl.appendChild(card);
  }

  // ── setup view ──
  // GET /api/setup drift checklist. Each check is a row: a ✓/✗ dot, its label, a
  // muted detail. `fix:'in-app'` rows get an action button (hook → /api/hook,
  // service → /api/setup/service); `fix:'make-setup'` rows show a copy-to-
  // clipboard `make setup` chip (reuses the artifact copy-chip mechanics).
  const setupBodyEl = document.getElementById('setup-body');
  document.getElementById('setup-refresh').addEventListener('click', () => loadSetup());

  async function loadSetup() {
    clear(setupBodyEl);
    const note = document.createElement('div');
    note.className = 'set-hint';
    note.appendChild(document.createTextNode('One-command bootstrap: '));
    const code = document.createElement('code');
    code.textContent = 'make setup';
    note.appendChild(code);
    note.appendChild(document.createTextNode(' (from the repo root).'));
    setupBodyEl.appendChild(note);

    let data;
    try {
      const res = await fetch('/api/setup');
      if (!res.ok) throw new Error('http ' + res.status);
      data = await res.json();
    } catch {
      const msg = document.createElement('div');
      msg.className = 'empty-msg';
      msg.textContent = 'setup status unavailable';
      setupBodyEl.appendChild(msg);
      return;
    }
    const checks = data && Array.isArray(data.checks) ? data.checks : [];
    const card = makeCard('Setup checks', 'What engram needs to run end-to-end.');
    for (const c of checks) card.appendChild(buildSetupRow(c));
    setupBodyEl.appendChild(card);
  }

  function buildSetupRow(c) {
    const row = document.createElement('div');
    row.className = 'svc-row';
    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'svc-name';
    const dot = document.createElement('span');
    dot.className = 'svc-dot' + (c.ok ? ' on' : '');
    name.appendChild(dot);
    name.appendChild(document.createTextNode(c.label || c.id));
    left.appendChild(name);
    if (c.detail) {
      const det = document.createElement('div');
      det.className = 'svc-state';
      det.textContent = c.detail;
      left.appendChild(det);
    }
    row.appendChild(left);
    if (!c.ok && c.fix === 'in-app') {
      const btn = document.createElement('button');
      btn.className = 'set-btn';
      btn.type = 'button';
      btn.textContent = 'install';
      btn.addEventListener('click', () => fixSetupInApp(c.id, btn));
      row.appendChild(btn);
    } else if (!c.ok && c.fix === 'make-setup') {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'artifact-chip artifact-copy';
      chip.textContent = 'make setup';
      chip.title = 'copy `make setup` to the clipboard';
      chip.addEventListener('click', () => copyArtifact(chip, 'make setup', 'make setup'));
      row.appendChild(chip);
    }
    return row;
  }

  // The two in-app fixers: the hook installer and the background-service
  // installer. Both POST {action:'install'} then re-fetch to reflect real state.
  async function fixSetupInApp(id, btn) {
    btn.disabled = true;
    btn.textContent = 'installing…';
    const url = id === 'hook' ? '/api/hook' : '/api/setup/service';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'install' }),
      });
      if (!res.ok) throw new Error('http ' + res.status);
    } catch { /* refresh below reflects the real state either way */ }
    loadSetup();
  }

  navHL.moveTo(sidebarEl.querySelector('.nav-item.active')); // seat the pill in place on load
  renderScope();                                             // …renderScope seats the scope pill
  loadStats();
  ensureConfig();                                            // seat the ask affordance (disabled if no OpenAI key)
  routeFromHash();                                           // apply the initial hash (deep links, else #/search → recents)
