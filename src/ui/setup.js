// ── setup view ──
// GET /api/setup drift checklist. Each check is a row: a ✓/✗ dot, its label, a
// muted detail. `fix:'in-app'` rows get an action button (hook → /api/hook,
// service → /api/setup/service); `fix:'make-setup'` rows show a copy-to-
// clipboard `make setup` chip (reuses the artifact copy-chip mechanics).

import { setupBodyEl } from './dom.js';
import { clear } from './util.js';
import { copyArtifact } from './artifacts.js';
import { makeCard } from './settings.js';

document.getElementById('setup-refresh').addEventListener('click', () => loadSetup());

export async function loadSetup() {
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
