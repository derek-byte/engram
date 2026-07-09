// Thin ES-module entry. Each module wires its own listeners at load; this file
// holds only the cross-view keyboard shortcuts and the boot sequence. Module
// map: state (shared mutable state), dom (element refs), util (formatters),
// router (pure hash parsing) / nav (hashchange glue), markdown + artifacts
// (pure-ish renderers), views (sidebar/showView), search, ask, overlay, wiki,
// settings, analytics, setup.

import { sidebarEl, overlayEl } from './dom.js';
import { getCurrentView } from './state.js';
import { navHL, showView, openSettings } from './views.js';
import { renderScope, cycleScope, loadStats } from './search.js';
import { ensureConfig } from './ask.js';
import { closeOverlay } from './overlay.js';
import { routeFromHash } from './nav.js';

// One design everywhere; the Tauri webview scopes traffic-light padding + drag
// region under this class so the browser never reserves that space.
if (window.__TAURI__) document.documentElement.classList.add('tauri');

// Sidebar collapse (titlebar button, app only). localStorage is best-effort:
// the app's origin changes per launch (random ui-server port), so the state
// effectively resets each launch — acceptable, default is expanded.
const sideToggle = document.getElementById('side-toggle');
if (sideToggle) {
  try {
    if (localStorage.getItem('side-collapsed') === '1') document.documentElement.classList.add('side-collapsed');
  } catch { /* storage unavailable */ }
  sideToggle.addEventListener('click', () => {
    const collapsed = document.documentElement.classList.toggle('side-collapsed');
    try { localStorage.setItem('side-collapsed', collapsed ? '1' : '0'); } catch { /* best effort */ }
  });
}

document.addEventListener('keydown', (e) => {
  // Cmd+, opens settings from anywhere (mirrors the macOS Preferences shortcut).
  if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (e.key === 'Escape') {
    // Compose: overlay first, then any non-search view, else nothing.
    if (overlayEl.classList.contains('open')) { closeOverlay(); return; }
    if (getCurrentView() !== 'search') { showView('search', { replace: true }); return; }
    return;
  }
  // Tab cycles scope only in the search view with the overlay closed. On this
  // page Tab has no competing focus role; [ and ] stay usable as query chars.
  if (e.key === 'Tab' && getCurrentView() === 'search' && !overlayEl.classList.contains('open')) {
    e.preventDefault();
    cycleScope(e.shiftKey ? -1 : 1);
  }
});

navHL.moveTo(sidebarEl.querySelector('.nav-item.active')); // seat the pill in place on load
renderScope();                                             // …renderScope seats the scope pill
loadStats();
ensureConfig();                                            // seat the ask affordance (disabled if no OpenAI key)
routeFromHash();                                           // apply the initial hash (deep links, else #/search → recents)
