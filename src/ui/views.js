// ── sidebar nav / views ──
// showView is the single view-switcher: it flips the .active classes, slides
// the nav pill, kicks the entered view's loader, and records the route.

import { qEl, sidebarEl, overlayEl, attachSlidingHighlight } from './dom.js';
import { getCurrentView, setCurrentView } from './state.js';
import { updateHash } from './router.js';
import { loadWiki } from './wiki.js';
import { loadAnalytics, stopAskevalPoll } from './analytics.js';
import { loadSetup } from './setup.js';
import { loadSettings } from './settings.js';

export const navHL = attachSlidingHighlight(sidebarEl, { radius: 8 });

export function stateForView(name) {
  return name === 'search' ? { view: 'search', q: qEl.value.trim() } : { view: name };
}

export function showView(name, opts) {
  if (!['search', 'wiki', 'analytics', 'setup', 'settings'].includes(name)) return;
  // Leaving Analytics tears down any askeval poll — it must never tick while
  // the tab is on another view.
  if (name !== 'analytics') stopAskevalPoll();
  setCurrentView(name);
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
export function openSettings() { showView('settings'); }
export function closeSettings() { showView('search'); } // showView('search') returns focus to #q
window.openSettings = openSettings;
window.closeSettings = closeSettings;
// True when a modal-like surface is up: the settings pane OR the overlay
// (wiki page / trajectory). The Tauri ESC script uses this to decide whether
// Esc closes a surface or hides the window.
window.__engramModalOpen = () => getCurrentView() === 'settings' || overlayEl.classList.contains('open');
