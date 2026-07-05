// ── artifact chips (DOM-only, never innerHTML, never a file:// href) ──
// A durable output a trajectory produced. url/pr with an http(s) ref render as
// a real external anchor; file (and any non-http ref) renders as a chip that
// copies the path to the clipboard.

export function artifactChipLabel(a) {
  if (a.kind === 'pr') {
    const m = /\/pull\/(\d+)/.exec(a.ref || '');
    return m ? 'PR #' + m[1] : 'PR';
  }
  if (a.kind === 'url') {
    try {
      const u = new URL(a.ref);
      let p = u.pathname || '';
      if (p.length > 24) p = p.slice(0, 23) + '…';
      return u.hostname + (p === '/' ? '' : p);
    } catch { return a.ref; }
  }
  const parts = String(a.ref || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(a.ref || '?');
}

export function copyArtifact(chip, text, label) {
  const restore = () => { chip.textContent = label; chip.classList.remove('artifact-copied'); };
  const ok = () => { chip.textContent = 'copied'; chip.classList.add('artifact-copied'); setTimeout(restore, 1100); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, restore);
  } catch { /* clipboard unavailable — chip stays inert */ }
}

export function makeArtifactChip(a) {
  const label = artifactChipLabel(a);
  const isHttp = /^https?:/i.test(a.ref || '');
  if ((a.kind === 'url' || a.kind === 'pr') && isHttp) {
    const link = document.createElement('a');
    link.className = 'artifact-chip artifact-link';
    link.textContent = label;
    link.href = a.ref;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = a.ref;
    // A chip inside a clickable source/turn row must not trigger that row.
    link.addEventListener('click', (e) => e.stopPropagation());
    return link;
  }
  // file (or a non-http url/pr) → copy-to-clipboard, NEVER href="file://…".
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'artifact-chip artifact-copy';
  chip.textContent = label;
  chip.title = a.ref;
  // exists is only sent by /api/wiki; search/ask/trajectory omit it → unknown,
  // which is NOT rendered as missing (unknown ≠ deleted).
  if (a.kind === 'file' && a.exists === false) {
    chip.classList.add('artifact-missing');
    chip.title = a.ref + ' · moved or deleted';
  }
  chip.addEventListener('click', (e) => { e.stopPropagation(); copyArtifact(chip, a.ref, label); });
  return chip;
}

export function dedupeArtifacts(artifacts) {
  const seen = new Set();
  const out = [];
  for (const a of (artifacts || [])) {
    if (!a || typeof a.ref !== 'string' || seen.has(a.ref)) continue;
    seen.add(a.ref);
    out.push(a);
  }
  return out;
}

// Build an artifact strip (dedup by ref, cap the rendered count, append a muted
// "+N more" when capped). Returns the strip element, or null when there's none.
export function buildArtifactStrip(artifacts, cap, mini) {
  const list = dedupeArtifacts(artifacts);
  if (!list.length) return null;
  const strip = document.createElement('div');
  strip.className = mini ? 'artifact-strip mini' : 'artifact-strip';
  const shown = cap && list.length > cap ? list.slice(0, cap) : list;
  for (const a of shown) strip.appendChild(makeArtifactChip(a));
  if (cap && list.length > cap) {
    const more = document.createElement('span');
    more.className = 'artifact-more';
    more.textContent = '+' + (list.length - cap) + ' more';
    strip.appendChild(more);
  }
  return strip;
}
