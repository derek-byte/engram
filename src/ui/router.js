// ── hash routing (pure half) ──
// location.hash is the single source of truth. Nav actions call updateHash()
// to record history (push) or rewrite the current entry (replace); the
// hashchange listener in nav.js (browser back/forward) calls routeFromHash()
// to re-apply state. We mutate history via push/replaceState — which do NOT
// fire hashchange — so our own updates never re-enter the router.
//   #/search            search view (empty query → recents)
//   #/search?q=<query>  search view, query restored + run
//   #/wiki              wiki index
//   #/wiki/<slug>       wiki page overlay over the wiki view
//   #/settings          settings view
// Push on explicit navigation (nav click, open page, open settings,
// Enter/open a result); replace while typing and on close / Esc-reset — so
// window hides don't grow history and a Tauri summon lands cleanly on search.
//
// No top-level DOM/window access: parseHash/hashFor/safeDecode are pure, and
// updateHash touches location/history only when called — so router.test.js
// imports this module without a DOM.

// decodeURIComponent throws URIError on a malformed %-escape (e.g. '#/wiki/%ZZ');
// a bare call would kill the router with an uncaught throw. Fall back to the
// raw segment — a bogus slug just renders as a missing wiki page.
export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// `applyingRoute` suppresses updateHash while routeFromHash (nav.js) drives
// showView/openWikiPage/closeOverlay, so re-applying a route never pushes a
// dup entry. nav.js flips it around each drive.
let applyingRoute = false;
export function setApplyingRoute(v) { applyingRoute = v; }

export function hashFor(s) {
  if (s.view === 'wiki') return s.slug ? '#/wiki/' + encodeURIComponent(s.slug) : '#/wiki';
  if (s.view === 'analytics') return '#/analytics';
  if (s.view === 'setup') return '#/setup';
  if (s.view === 'settings') return '#/settings';
  return s.q ? '#/search?q=' + encodeURIComponent(s.q) : '#/search';
}

export function updateHash(state, opts) {
  if (applyingRoute) return;                 // the router is driving; don't fight it
  const h = hashFor(state);
  if (h === location.hash) return;           // compare-before-apply: nothing changed
  const url = location.pathname + location.search + h;
  if (opts && opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

export function parseHash(hash) {
  const raw = hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const path = qi === -1 ? raw : raw.slice(0, qi);
  const query = qi === -1 ? '' : raw.slice(qi + 1);
  const segs = path.split('/').filter(Boolean);
  const head = segs[0] || 'search';
  if (head === 'wiki') return { view: 'wiki', slug: segs[1] ? safeDecode(segs[1]) : null };
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
