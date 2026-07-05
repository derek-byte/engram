// Every element the app holds a long-lived reference to, resolved once at
// module load. Browser-only by design — this file touches document at top
// level, so the pure, unit-tested modules (router.js, markdown.js) must never
// import it (directly or transitively).

export const qEl = document.getElementById('q');
export const statusEl = document.getElementById('status');
export const resultsEl = document.getElementById('results');
export const statsEl = document.getElementById('stats');
export const latencyEl = document.getElementById('latency');
export const moreEl = document.getElementById('more');
export const askBtnEl = document.getElementById('ask-btn');
export const answerEl = document.getElementById('answer');
export const resultsPaneEl = document.getElementById('results-pane');
export const overlayEl = document.getElementById('overlay');
export const overlayBodyEl = document.getElementById('overlay-body'); // the overlay's scroll container
export const overlayMetaEl = document.getElementById('overlay-meta');
export const turnsEl = document.getElementById('turns');
export const pageEl = document.getElementById('page');
export const scopeEl = document.getElementById('scope');
export const sidebarEl = document.getElementById('sidebar');
export const wikiListEl = document.getElementById('wiki-list');
export const settingsBodyEl = document.getElementById('settings-body');
export const analyticsBodyEl = document.getElementById('analytics-body');
export const setupBodyEl = document.getElementById('setup-body');

// ── sliding selection pill ──
// Shared by the discrete selection controls (sidebar nav, scope tabs): one
// .slide-hl node per container, translated/resized to the selected item so
// the pill glides from the old selection to the new one on click / keyboard.
// Hover stays each item's own static CSS tint — nothing here tracks the mouse.
// API: { moveTo(el), hide() }
//   moveTo(el) — slide the pill to el; on first placement it appears in
//                place (no fly-in from 0,0). moveTo(null) hides it.
//   hide()     — fade out (no current selection)
export function attachSlidingHighlight(container, opts) {
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
