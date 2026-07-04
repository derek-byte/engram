# Wave 5: the engram wiki — compile, don't retrieve

Status: **scoped, not started** (blocked on wave 4 merge: rerank + dream v1).
Owner of judgment: Derek. Owner of bookkeeping: the model. (Karpathy, LLM-WIKI.md.)

## Why

Raw-tier search has solved recall (R@5 0.95+) but not digestibility: results are
verbatim transcript chunks — tool logs, grep dumps. The product is digestible
knowledge. RAG re-derives an answer on every query and accumulates nothing;
a compiled wiki compounds.

## Shape: knowledge pyramid

```
L3  index.md            — one honest map of everything (navigate by index)
L2  wiki pages          — entity/topic pages: projects, decisions, gotchas, tools, people
L1  dream chunks        — per-trajectory conservative extraction (wave 4, shipping)
L0  raw chunks + raw_events — immutable verbatim store of record (never edited)
```

Each layer is synthesized only from the layer below. Fingerprint short-circuit
(sha256 of sorted source ids, shipping in wave 4) makes every layer an
incremental build: a new session recompiles only the pages it touches.
It is a build system for knowledge.

## Decisions (made)

1. **Materialization: real markdown files** at `~/.engram/wiki/`, git-versioned,
   wikilinks (`[[page-name]]`), YAML frontmatter carrying provenance
   (source dream-chunk ids / trajectory ids) and the fingerprint. Obsidian-openable
   for free. The pg index over wiki pages (tier='wiki') is derived, rebuildable.
2. **Ownership boundary:** `raw/` layers are Derek's and immutable; `wiki/` is
   model-owned — humans rarely edit it (rule II/III). A schema file
   (`~/.engram/wiki/SCHEMA.md`) holds the rules and belongs to both.
3. **Ingest is incremental, one source at a time** (rule V/IX): the watcher (or
   `engram wiki ingest`) compiles each NEW trajectory's dream chunks into the
   graph — tracing implications across existing pages, updating neighbors — not
   batch-importing 3.3k chunks ("a dump, not a wiki"). Backfill happens as
   curated slices on demand (`--repo X --since Y`), supervised at first.
4. **Links are first-class:** every page links entities it mentions; orphan pages
   and link-less entities are lint findings. Value is in the edges.
5. **Search surface flips:** UI + MCP search wiki tier by default, raw as
   drill-down provenance (trajectory overlay already exists). Exact-identifier
   queries still hit raw (two-arm keyword search keeps working there).
6. **LLM:** existing OPENAI_API_KEY, cheap tier, config-overridable. Synthesis
   prompts use a stable instruction prefix (automatic prompt caching). A
   later optimization: hot pages (index + top-N) in a cached system prompt for
   query-time use — cache-augmented generation. Not in wave 5 scope.

## Deliverables

- `engram wiki ingest [--repo --since --limit --dry-run]` — incremental compile
  of un-ingested dream chunks into pages; reports pages created/updated/skipped
  (fingerprint) and token cost. Idempotent.
- `engram wiki lint` — contradictions between pages, low-confidence claims,
  orphan pages, entity spelling drift. Findings are information, not auto-fixes.
- `engram wiki status` — page count, orphans, last compile, index freshness.
- Index maintenance: `index.md` regenerated when pages change (part of ingest).
- Search integration: wiki pages embedded into pg (tier='wiki'), UI/MCP default
  to wiki+dream tiers, `--tier raw` for verbatim.
- Watcher hook: new session → dream synthesis (wave 4) → wiki ingest, end to end.
- **Synthesis toggle + nightly schedule:** `synthesis: { enabled: false, hour: 3 }`
  in EngramConfig — OFF by default. When enabled, `engram service install` also
  installs a `com.engram.synthesis` launchd agent (StartCalendarInterval, default
  03:00) running dream synthesis → wiki ingest over anything new since the last
  run. `engram service status` reports both agents. Toggling off removes the
  agent. Manual `engram wiki ingest` / `engram dream` always work regardless of
  the toggle. (The wave-6 desktop app later absorbs this scheduler — see below.)

## Non-goals (wave 5)

- No bulk one-shot compile of the historical corpus.
- No query-time KV-cache/CAG layer (sequenced after the wiki exists).
- No multi-owner/org federation changes.
- No hand-editing workflow for wiki pages.
- No desktop app (wave 6, below) — but nothing in wave 5 may assume a terminal:
  every command the app will trigger must run headless with JSON-able output.

## Wave 6 preview: desktop app (scoped separately, not started)

Menu-bar macOS app (Tauri 2 recommended: ~10MB, native tray, existing web UI
drops in; engram CLI runs as a sidecar) that becomes the single permission
grant: one signed .app bundle holding the watcher, the search UI window, and
the nightly synthesis scheduler — so Full Disk Access / folder access is
granted once to the app instead of to bun-under-launchd. Login item = always
resident; it absorbs both launchd agents (`com.engram.watcher`,
`com.engram.synthesis`) and runs nightly sync in-process. The web UI stays the
single frontend (served locally, rendered in the app webview) so browser and
app share one codebase.

**v1 scope (Derek, 2026-07-03):** core = tray icon + nightly-run indicator +
embedded search UI, PLUS all three extras: (1) global-hotkey spotlight-style
search (summon anywhere, Esc dismisses), (2) the deferred UI widgets —
raw/synth tier toggle, wiki pages rendered as pages with tier badges in the
trajectory overlay, (3) in-app watcher + scheduler from day one (no launchd
once the app runs; the launchd agents are the bridge until then).

**Artifact hyperlinks (Derek, 2026-07-03):** wiki pages should link to the
real things they discuss, not just other pages — generated artifacts
(benchmark results, specs/docs by path), diagrams, dashboards, external URLs,
and key file paths mentioned in the source sessions. Dream extraction already
names files/tools; the wiki compile should render them as markdown links
(file paths as `[path](file://...)` or repo-relative links, URLs verbatim).
Deterministic where possible (URL/path detection is regexable — same
philosophy as auto-linking); frontmatter could carry an `artifacts:` list for
the UI to render as a resources row.

**Empty-state recents (Derek, 2026-07-03):** when the app opens with nothing
typed, show recency-ranked history — recent searches and recently viewed
pages/trajectories — instead of a blank screen. Store both in LocalStore
(sqlite): a `recents` log of (kind: search|view, key, timestamp), LRU-style,
local-only, capped. Dual-purpose by design: the same query log feeds
roadmap #6 (demand-driven synthesis — poorly-answered searches become the
synthesis priority queue), so this UI feature and the self-managing loop
share one table.

## Verification

- Ingest 5–10 real trajectories' dream chunks; show pages + links form.
- Re-run ingest: 100% fingerprint skip.
- A "what did we decide about X" query answered from a wiki page, readable,
  with provenance links back to raw.
- Lint run over the small wiki produces sane findings.
