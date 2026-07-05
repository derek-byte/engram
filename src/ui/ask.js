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

import { qEl, askBtnEl, answerEl, resultsPaneEl } from './dom.js';
import { SCOPE_TIER, getScope, getSettingsCfg, setSettingsCfg } from './state.js';
import { clear } from './util.js';
import { buildArtifactStrip } from './artifacts.js';
import { openWikiPage, openTrajectory } from './overlay.js';

const askCache = new Map(); // key `q\ntier\nrepo` → terminal result (never errors)
let askCtrl = null;         // in-flight AbortController, or null
let askTick = null;         // elapsed-ticker interval id, or null
let askCardQuery = null;    // query echoed in the current card (null ⇒ no card)
export function getAskCardQuery() { return askCardQuery; }

function askKey(q) { return q + '\n' + SCOPE_TIER[getScope()] + '\n' + ''; } // repo unused in the UI
function askModelLabel() {
  const settingsCfg = getSettingsCfg();
  return (settingsCfg && settingsCfg.wikiModel) || 'the wiki model';
}

// Empty #answer, stop the ticker, abort any in-flight fetch. Called on query
// edit and before rebuilding the card for a new state.
export function clearAnswer() {
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

export async function runAskUI() {
  const q = qEl.value.trim();
  if (!q) return;                 // empty query → no-op
  if (askCtrl) return;            // in flight → no-op (cancel via the card chip)
  if (askBtnEl.classList.contains('disabled')) { renderAskNoKey(q); return; }
  const tier = SCOPE_TIER[getScope()];
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
// the settings pane (settings.js) fetches the full view into the shared
// settingsCfg. Whichever loads first populates it — this probe fetches once on
// demand and dedupes.
let cfgProbe = null;
export function ensureConfig() {
  const settingsCfg = getSettingsCfg();
  if (settingsCfg) return Promise.resolve(settingsCfg);
  if (!cfgProbe) {
    cfgProbe = fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (c) setSettingsCfg(c); cfgProbe = null; updateAskAffordance(); return c; })
      .catch(() => { cfgProbe = null; return null; });
  }
  return cfgProbe;
}
// Disable the affordance only when we KNOW there's no key; unknown stays
// enabled (optimistic) and a POST 503 surfaces the message in-card.
export function updateAskAffordance() {
  const settingsCfg = getSettingsCfg();
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
