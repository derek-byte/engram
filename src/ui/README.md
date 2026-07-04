# Local search UI

`engram ui [--port 7777]` starts a `Bun.serve` bound to **127.0.0.1 only** — a search-engine-style page over your memory index.

```
engram ui            # http://127.0.0.1:7777
engram ui --port 8080
```

The handler is `buildUiFetch(deps)` (exported for tests — call it with `Request` objects, no port bind, same seam as `service.ts`'s `buildPlist`); `uiCommand` is a thin wire-up (config → `PgVectorBackend` + `Embedder` + `LocalStore` + `WikiStore`). The DNS-rebinding Host/Origin allowlist is computed from `deps.port`.

## Routes

- `GET /` — single self-contained `index.html` (inline CSS + vanilla JS, zero external/CDN resources). Dark, minimal; results render as you type.
- `GET /api/search?q=…&k=3&tier=synth` — embeds `q` via the existing `Embedder` (query embeddings hit the pg `embedding_cache`, so repeat queries are free) and runs `runSearch`. `tier` ∈ `raw|dream|wiki|synth|all` (default `synth` = wiki+dream). Returns per-result `similarity`, `repo`, `branch`, `timestamp`, `sessionId`, `tier`, `kind`, `slug`, `trajectoryId`, `chunkIndex`, a ~300-char `snippet`, and chunk `id`. Logs a `search` recent when `q.length >= 3` and there were hits (try/catch-swallowed).
- `GET /api/trajectory/:trajectoryId` — all chunks with that `trajectory_id` ordered by `chunk_index` (parameterized SQL via `PgVectorBackend.getTrajectory`), so a click stitches the full conversation turn together with the matched chunk highlighted. Logs a `view` recent (`traj:<id>`) for non-`wiki:` ids only (wiki drill-downs already logged by the page route).
- `GET /api/wiki/:slug` — page markdown + metadata from the wiki dir via `WikiStore.readPage` (read-only; never `init()`s). Slug validated with `isValidSlug` (400, doubling as the path-traversal guard); missing page → 404; malformed frontmatter → 500. Returns `slug`, `title`, `kind`, `summary`, `updated`, `created`, `sourceCount`, `trajectoryId` (`wiki:<slug>`), `body`. Logs a `view` recent (`wiki:<slug>`). The client falls back to the trajectory overlay on any non-200.
- `GET /api/recents` — the 50 newest `recents` rows (search + view), recency-desc.

## Frontend

- Debounce ~200ms; `AbortController` cancels stale in-flight requests; `Enter` triggers an immediate search.
- `k` is `FETCH_K` in `index.html` — change it there.
- **Scope toggle** (search card): `knowledge|history|all` → tier `synth|raw|all` (default `knowledge`). `Tab`/`Shift+Tab` cycle scope when the overlay is closed (`[`/`]` stay usable as query characters; the future desktop webview must not rely on Tab for focus traversal). Selection persists in `localStorage['engram.scope']`, validated on read.
- **Wiki page view**: clicking a wiki card opens the rendered page (hand-rolled DOM-only markdown — headings/paragraphs/lists/fenced+inline code/bold/`[text](url)` http|https|file/`[[wikilinks]]`; **never** `innerHTML`). `[[wikilinks]]` navigate in-page; a provenance line ("compiled from N dream chunks → view sources") drills into the trajectory overlay. `Esc`/back always returns to results (no view stack).
- **Empty-state recents**: an empty query box shows recency-ranked recent searches and recently viewed pages/trajectories (via `/api/recents`); a recent search re-runs, a recent view reopens.
- Click a result → full-document overlay with a back affordance (also `Esc`); the matched chunk is highlighted and scrolled into view.
- All dynamic content is rendered via `textContent` / DOM APIs — **never** `innerHTML` with data (chunk/page content is untrusted).

## Reuse

No duplicate search logic: reuses `loadConfig`, `PgVectorBackend`, `Embedder` (with the backend passed as its embedding cache), `runSearch`, `LocalStore` (recents), and `WikiStore` (page reads). Requires a complete config (`engram backfill` sets it up). Logs the bound URL once; per-request failures go to `console.error`.
