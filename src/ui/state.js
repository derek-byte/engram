// Shared mutable UI state, centralized behind narrow accessors so modules
// never reach into each other's `let`s. No DOM access (localStorage only, for
// scope persistence); the pure, unit-tested modules (router.js, markdown.js)
// still deliberately don't import it.

// ── sidebar nav / views ──
let currentView = 'search';
export function getCurrentView() { return currentView; }
export function setCurrentView(name) { currentView = name; }

// slug of the wiki page in the overlay, else null
let overlayWikiSlug = null;
export function getOverlayWikiSlug() { return overlayWikiSlug; }
export function setOverlayWikiSlug(slug) { overlayWikiSlug = slug; }

// ── tier scope ──
// knowledge = synth (wiki+dream, the API default), history = raw, all = every tier.
export const SCOPE_TIER = { knowledge: 'synth', history: 'raw', all: 'all' };
export const SCOPES = ['knowledge', 'history', 'all'];
let scope = localStorage.getItem('engram.scope');
if (!SCOPE_TIER[scope]) scope = 'knowledge';
export function getScope() { return scope; }
export function setScopeValue(next) {
  scope = next;
  localStorage.setItem('engram.scope', scope);
}

// Last known /api/config view. Shared between the ask affordance (ask.js's
// ensureConfig) and the settings pane — whichever loads first populates it.
let settingsCfg = null;
export function getSettingsCfg() { return settingsCfg; }
export function setSettingsCfg(cfg) { settingsCfg = cfg; }
