// ── analytics view ──
// Lazy on first open, refreshed on re-open (showView calls loadAnalytics). One
// read-only /api/analytics payload plus the live /api/demand and /api/lint
// reads back four cards: demand, context injection, answer-eval, wiki lint.
// The only stateful piece is the askeval poll (startAskevalPoll) — it MUST
// stop when the view is left (showView clears it) and never tick off-view.

import { qEl, analyticsBodyEl } from './dom.js';
import { getCurrentView } from './state.js';
import { relAge, normTs, clear } from './util.js';
import { makeCard } from './settings.js';
import { showView } from './views.js';
import { search } from './search.js';

document.getElementById('analytics-refresh').addEventListener('click', () => loadAnalytics());

let askevalPoll = null; // 2s interval id while an askeval run is in flight, else null

export function stopAskevalPoll() {
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

export async function loadAnalytics() {
  clear(analyticsBodyEl);
  const [analytics, demand, lint] = await Promise.all([
    fetch('/api/analytics').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/api/demand?days=30').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/api/lint').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (!analytics) { analyticsMsg('Analytics unavailable — is the engram server running?'); return; }
  renderHeatmapCard(analytics.heatmap || []);
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

// ── memory-formation heatmap (GitHub-contribution style) ──
// rows = /api/analytics heatmap: [{ day: 'YYYY-MM-DD', tier, chunks, chars }].
// 53 week columns ending on the current week, Sun→Sat rows, quartile levels.

const HM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HM_TIERS = ['raw', 'dream', 'wiki'];
const HM_PITCH = 12; // 10px cell + 2px gap — keep in sync with .hm-grid CSS

function fmtTokens(chars) {
  const t = Math.round(chars / 4); // CHARS_PER_TOKEN estimate, same as the chunker
  if (t >= 1e6) return '~' + (t / 1e6).toFixed(1) + 'M tokens';
  if (t >= 1e3) return '~' + Math.round(t / 1e3) + 'k tokens';
  return '~' + t + ' tokens';
}

// Local-date key matching the server's date bucketing.
function hmDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function renderHeatmapCard(rows) {
  const card = makeCard('Memory Formation', 'Chunks synthesized into the index, per day.');
  card.classList.add('hm-card');
  const byDay = new Map();
  let totalChunks = 0;
  let totalChars = 0;
  for (const r of rows) {
    let d = byDay.get(r.day);
    if (!d) byDay.set(r.day, (d = { chunks: 0, chars: 0, tiers: {} }));
    d.chunks += r.chunks;
    d.chars += r.chars;
    d.tiers[r.tier] = (d.tiers[r.tier] || 0) + r.chunks;
    totalChunks += r.chunks;
    totalChars += r.chars;
  }

  const head = document.createElement('div');
  head.className = 'an-note';
  head.textContent = totalChunks
    ? totalChunks.toLocaleString('en-US') + ' chunks · ' + fmtTokens(totalChars) + ' in the last year'
    : 'no chunks formed in the last year';
  card.appendChild(head);
  if (totalChunks) card.appendChild(buildHeatmap(byDay));
  analyticsBodyEl.appendChild(card);
}

function hmTipText(date, info) {
  const label = HM_MONTHS[date.getMonth()] + ' ' + date.getDate();
  if (!info) return 'no chunks on ' + label;
  let t = info.chunks.toLocaleString('en-US') + ' chunk' + (info.chunks === 1 ? '' : 's') +
    ' · ' + fmtTokens(info.chars) + ' on ' + label;
  const split = HM_TIERS.filter((k) => info.tiers[k]).map((k) => info.tiers[k] + ' ' + k);
  // A pure-raw day's split ("218 chunks — 218 raw") adds nothing; skip it.
  if (split.length > 1 || !info.tiers.raw) t += ' — ' + split.join(' · ');
  return t;
}

function buildHeatmap(byDay) {
  // GitHub-style quartile thresholds over the non-zero day totals.
  const nz = [...byDay.values()].map((d) => d.chunks).sort((a, b) => a - b);
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] || 1;
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  const level = (n) => (n === 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4);

  // Window: 53 Sun→Sat columns ending on the current week (371 days, matching
  // the /api/analytics window). Future cells render invisible to keep the grid.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));
  const start = new Date(end);
  start.setDate(start.getDate() - 53 * 7 + 1);

  const wrap = document.createElement('div');
  wrap.className = 'hm-wrap';
  const tip = document.createElement('div');
  tip.className = 'hm-tip';

  const scroll = document.createElement('div');
  scroll.className = 'hm-scroll';
  const flex = document.createElement('div');
  flex.className = 'hm-flex';

  // Mon/Wed/Fri row labels (rows 2/4/6 of the Sun-first grid), below a spacer
  // that mirrors the month row's height so the labels align with the cells.
  const days = document.createElement('div');
  days.className = 'hm-days';
  for (const [row, name] of [[2, 'Mon'], [4, 'Wed'], [6, 'Fri']]) {
    const s = document.createElement('span');
    s.textContent = name;
    s.style.gridRow = String(row);
    days.appendChild(s);
  }

  const months = document.createElement('div');
  months.className = 'hm-months';
  const grid = document.createElement('div');
  grid.className = 'hm-grid';

  const showTip = (cell) => {
    tip.textContent = cell.dataset.tip;
    const c = cell.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    tip.style.left = (c.left - w.left + c.width / 2) + 'px';
    tip.style.top = (c.top - w.top) + 'px';
    tip.style.opacity = '1';
  };

  let col = 0;
  let prevMonth = -1;
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0) {
      col++;
      // Month label on the first column whose Sunday enters a new month; the
      // first column is skipped when its label would collide with the second's.
      const m = d.getMonth();
      if (m !== prevMonth) {
        if (prevMonth !== -1 || new Date(d.getFullYear(), m + 1, 1) - d > 7 * 86_400_000) {
          const lab = document.createElement('span');
          lab.textContent = HM_MONTHS[m];
          lab.style.left = (col - 1) * HM_PITCH + 'px';
          months.appendChild(lab);
        }
        prevMonth = m;
      }
    }
    const cell = document.createElement('div');
    if (d > today) {
      cell.className = 'hm-cell hm-future';
    } else {
      const info = byDay.get(hmDayKey(d));
      cell.className = 'hm-cell l' + level(info ? info.chunks : 0);
      cell.dataset.tip = hmTipText(d, info);
      cell.addEventListener('mouseenter', () => showTip(cell));
      cell.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    }
    grid.appendChild(cell);
  }

  const right = document.createElement('div');
  right.appendChild(months);
  right.appendChild(grid);
  flex.appendChild(days);
  flex.appendChild(right);
  scroll.appendChild(flex);
  wrap.appendChild(scroll);
  wrap.appendChild(tip);
  // When the window is too narrow for all 53 columns, show the NEWEST weeks:
  // a left-anchored scroll hides the current month, which reads as missing data.
  requestAnimationFrame(() => { scroll.scrollLeft = scroll.scrollWidth; });

  const legend = document.createElement('div');
  legend.className = 'hm-legend';
  const less = document.createElement('span');
  less.textContent = 'Less';
  legend.appendChild(less);
  for (let l = 0; l <= 4; l++) {
    const c = document.createElement('div');
    c.className = 'hm-cell l' + l;
    legend.appendChild(c);
  }
  const more = document.createElement('span');
  more.textContent = 'More';
  legend.appendChild(more);
  wrap.appendChild(legend);
  return wrap;
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
  else if (hook.stalePath || hook.staleInterpreter) { hookText = 'hook stale'; hookOk = false; hookAction = 'install'; }
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
    if (getCurrentView() !== 'analytics') { stopAskevalPoll(); return; } // never tick off-view
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
  if (data.running && getCurrentView() === 'analytics') startAskevalPoll();
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
