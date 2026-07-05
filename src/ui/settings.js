// ── settings pane ──
// Lazy: nothing here fetches until the Settings view is first opened. Every
// control saves-on-change (Wispr style) and re-renders from the PUT response —
// the server is the source of truth; a failed save reverts the optimistic UI.

import { settingsBodyEl } from './dom.js';
import { getSettingsCfg, setSettingsCfg } from './state.js';
import { clear } from './util.js';
import { updateAskAffordance } from './ask.js';

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

export async function loadSettings() {
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
  setSettingsCfg(cfg);
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
    setSettingsCfg(cfg);
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

export function makeCard(title, desc) {
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
  const cfg = getSettingsCfg();
  if (!cfg) return;
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
    const cfg = getSettingsCfg();
    sel.value = cfg ? cfg.embeddingProvider : sel.value; // revert
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
