// ── hash routing (impure half) ──
// The hashchange listener (browser back/forward) re-applies location.hash to
// the UI: routeFromHash drives showView/search/openWikiPage/closeOverlay with
// updateHash suppressed (setApplyingRoute) so re-applying a route never pushes
// a dup history entry. The pure parsing/formatting half lives in router.js.

import { parseHash, setApplyingRoute } from './router.js';
import { getCurrentView, getOverlayWikiSlug } from './state.js';
import { qEl, overlayEl } from './dom.js';
import { showView } from './views.js';
import { search } from './search.js';
import { openWikiPage, closeOverlay } from './overlay.js';

export function routeFromHash() {
  let st = parseHash(location.hash);
  if (!st || !location.hash) {                // unknown / empty hash → #/search (silent)
    st = { view: 'search', q: '' };
    history.replaceState(null, '', location.pathname + location.search + '#/search');
  }
  setApplyingRoute(true);
  try {
    if (getCurrentView() !== st.view) showView(st.view);
    if (st.view === 'search') {
      const q = st.q || '';
      if (qEl.value !== q) qEl.value = q;
      if (overlayEl.classList.contains('open')) closeOverlay();
      search(q);
    } else if (st.view === 'settings' || st.view === 'analytics' || st.view === 'setup') {
      if (overlayEl.classList.contains('open')) closeOverlay();
    } else if (st.view === 'wiki') {
      if (st.slug) {
        if (getOverlayWikiSlug() !== st.slug) openWikiPage({ slug: st.slug, trajectoryId: 'wiki:' + st.slug, tier: 'wiki' });
      } else if (overlayEl.classList.contains('open')) {
        closeOverlay();
      }
    }
  } finally {
    setApplyingRoute(false);
  }
}
window.addEventListener('hashchange', routeFromHash);
