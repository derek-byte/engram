// Pure display/format helpers shared across views. No top-level DOM access —
// clear() touches an element only when called — so any module (or a DOM-less
// bun test) can import this safely.

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toLocaleString();
}

// Date-only (no clock) for evidence spans like "Jan 3 → Feb 1".
export function fmtDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toLocaleDateString();
}

// Compact relative age like "9d", "3h", "5m".
export function relAge(ts) {
  if (!ts) return '';
  const then = new Date(ts).getTime();
  if (isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return Math.floor(s) + 's';
  const m = s / 60;
  if (m < 60) return Math.floor(m) + 'm';
  const h = m / 60;
  if (h < 24) return Math.floor(h) + 'h';
  const d = h / 24;
  if (d < 7) return Math.floor(d) + 'd';
  const w = d / 7;
  if (w < 5) return Math.floor(w) + 'w';
  const mo = d / 30;
  if (mo < 12) return Math.floor(mo) + 'mo';
  return Math.floor(d / 365) + 'y';
}

// Normalize SQLite-style "YYYY-MM-DD HH:MM:SS" (UTC) timestamps to ISO.
export function normTs(ts) {
  return (typeof ts === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ts)) ? ts.replace(' ', 'T') + 'Z' : ts;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
