# Local search UI

`engram ui [--port 7777]` starts a `Bun.serve` bound to **127.0.0.1 only** — a search-engine-style page over your memory index.

```
engram ui            # http://127.0.0.1:7777
engram ui --port 8080
```

The handler is `buildUiFetch(deps)` (exported for tests — call it with `Request` objects, no port bind, same seam as `service.ts`'s `buildPlist`); `uiCommand` is a thin wire-up (config → `PgVectorBackend` + `Embedder` + `LocalStore` + `WikiStore`). The DNS-rebinding Host/Origin allowlist is computed from `deps.port`.

## Routes

- `GET /` — single self-contained `index.html` (inline CSS + vanilla JS, zero external/CDN resources). Dark, minimal; results render as you type.
- `GET /api/search?q=…&k=3&tier=synth` — embeds `q` via the existing `Embedder` (query embeddings hit the pg `embedding_cache`, so repeat queries are free) and runs `runSearch`. `tier` ∈ `raw|dream|wiki|synth|all` (default `synth` = wiki+dream). Returns per-result `similarity`, `repo`, `branch`, `timestamp`, `sessionId`, `tier`, `kind`, `slug`, `trajectoryId`, `chunkIndex`, a ~300-char `snippet`, and chunk `id`. Logs a `search` recent when `q.length >= 3` and there were hits (try/catch-swallowed). Also logs a `demand_log` row for **every** settled query `>= 3` chars — including zero-hit and failed searches (the strongest unmet-demand signal) — carrying `result_count` and, from the best hit, `top_similarity`/`top_tier`/`top_session_id` (null on a miss). All demand writes are try/catch-swallowed (cosmetic).
- `POST /api/ask` — body `{ q, tier?: 'synth'|'raw'|'all', repo?, k? }` (`k` clamped 1–50, default 12; `tier` default `synth`). Same JSON gates as `PUT /api/config` (POST-only → 405; non-`application/json` or unparseable/empty-`q` body → 400). Builds an `OpenAIAskLLM` **per request** from `loadConfig()` so a key added in Settings works without a restart; **no key → `503 {error:'no_api_key'}`**. Runs `runAsk` over the shared backend/embedder → `200 {answer, sources, usage, model, tookMs}`. `AskError` (bad key, model refusal, timeout) → `502 {error}`; any other failure → `500` — never Bun's default error page. Ask never degrades to search. Logs an `ask` recent pre-call, and one `demand_log` row post-call whose `outcome` is `answered` / `not_covered` (answer cited nothing) / `no_candidates` (`answer === null`) / `error` (throw). `AskSource` carries no similarity/session id, so an ask row records `top_tier` + `cited_count` but leaves `top_similarity`/`top_session_id` null — the targeted-synthesis handle comes from `search` rows.
- `GET /api/demand?days=30` — the unmet-demand report for the search empty state: `{days, summary, unmet: [{query, count, latestTs, topSessionId}]}` via `LocalStore.demandSummary`/`unmetDemand`. `days` clamped 1–365 (default 30). "Unmet" = ask `not_covered`/`no_candidates` or search with `result_count = 0` OR `top_similarity < UNMET_THRESHOLD` (0.35).
- `GET /api/trajectory/:trajectoryId` — all chunks with that `trajectory_id` ordered by `chunk_index` (parameterized SQL via `PgVectorBackend.getTrajectory`), so a click stitches the full conversation turn together with the matched chunk highlighted. Logs a `view` recent (`traj:<id>`) for non-`wiki:` ids only (wiki drill-downs already logged by the page route).
- `GET /api/wiki/:slug` — page markdown + metadata from the wiki dir via `WikiStore.readPage` (read-only; never `init()`s). Slug validated with `isValidSlug` (400, doubling as the path-traversal guard); missing page → 404; malformed frontmatter → 500. Returns `slug`, `title`, `kind`, `summary`, `updated`, `created`, `sourceCount`, `trajectoryId` (`wiki:<slug>`), `body`. Logs a `view` recent (`wiki:<slug>`). The client falls back to the trajectory overlay on any non-200.
- `GET /api/wiki` — page index for the Wiki nav view: `slug`, `title`, `kind`, `updated` per page (no bodies), via `WikiStore.listPages`.
- `GET /api/recents` — the 50 newest `recents` rows (search + view), recency-desc.
- `GET /api/config` — the whitelisted, **secret-free** config view for the settings pane: `embeddingProvider`, `dreamModel`, `wikiModel`, `rerank` (only `{enabled}`), `synthesis`, `contextInjection`, plus derived booleans `hasOpenaiKey` / `hasDatabaseUrl`. Never `openaiApiKey` or `databaseUrl` — not even redacted. Reflects the effective config a **new** run would see (`loadConfig` folds env + defaults; edits apply to new processes).
- `PUT /api/config` — patch config.json in place. Requires `content-type: application/json`. Accepts only the editable keys above (`EDITABLE_CONFIG_KEYS`); any other key (secrets, `watchPath`, …) → 400, as does a bad provider value or non-object body. Routes through `patchConfigFile` (deep-merge over the raw file, clamp `contextInjection.budget` 100–20000 and `synthesis.hour` 0–23), **never** `saveConfig(loadConfig())` — so env secrets and provider-derived defaults never get baked into the file, and unknown keys already in the file survive verbatim. Response echoes the GET view plus `reembedRequired: true` when `embeddingProvider` actually changed, and `synthesisReconcile` (`{serviceInstalled, action}`) when the patch touched `synthesis` (see below).
- `GET /api/services` — both launchd agents' status: `{supported, serviceInstalled, agents: [{label, loaded, state, pid, plistPresent, schedule}]}`. `serviceInstalled` = watcher plist present (i.e. `engram service install` was run); non-darwin → `{supported:false, serviceInstalled:false, agents:[]}`.
- `POST /api/services/:label/restart` — `launchctl kickstart -k` the given agent. `:label` is validated against the two known constants (unknown → 404, never interpolated). Returns `{ok, label}`.

The launchd operations (`status`/`restart`/`reconcileSynthesis`) are injected via `deps.services` (`ServiceOps`, defaulting to `realServiceOps`) so route tests exercise config/services endpoints without shelling out to the real `launchctl`. A `PUT /api/config` that changes `synthesis.enabled`/`.hour` calls `reconcileSynthesis`: if the service was installed it (re)installs the synthesis agent with the new hour (or uninstalls it when disabled); if never installed it's a no-op returning `serviceInstalled:false`.

## Frontend

- Debounce ~200ms; `AbortController` cancels stale in-flight requests; `Enter` triggers an immediate search.
- `k` is `FETCH_K` in `index.html` — change it there.
- **Scope toggle** (search card): `knowledge|history|all` → tier `synth|raw|all` (default `knowledge`). `Tab`/`Shift+Tab` cycle scope when the overlay is closed (`[`/`]` stay usable as query characters; the future desktop webview must not rely on Tab for focus traversal). Selection persists in `localStorage['engram.scope']`, validated on read.
- **Wiki page view**: clicking a wiki card opens the rendered page (hand-rolled DOM-only markdown — headings/paragraphs/lists/fenced+inline code/bold/`[text](url)` http|https|file/`[[wikilinks]]`; **never** `innerHTML`). `[[wikilinks]]` navigate in-page; a provenance line ("compiled from N dream chunks → view sources") drills into the trajectory overlay. `Esc`/back always returns to results (no view stack).
- **Empty-state recents**: an empty query box shows recency-ranked recent searches and recently viewed pages/trajectories (via `/api/recents`); a recent search re-runs, a recent view reopens.
- Click a result → full-document overlay with a back affordance (also `Esc`); the matched chunk is highlighted and scrolled into view.
- All dynamic content is rendered via `textContent` / DOM APIs — **never** `innerHTML` with data (chunk/page content is untrusted).

## Reuse

No duplicate search logic: reuses `loadConfig`, `PgVectorBackend`, `Embedder` (with the backend passed as its embedding cache), `runSearch`, `runAsk` (`POST /api/ask`), `LocalStore` (recents + `demand_log`), and `WikiStore` (page reads). Requires a complete config (`engram backfill` sets it up). Logs the bound URL once; per-request failures go to `console.error`. The `OpenAIAskLLM` factory is injected via `deps.buildAskLLM` (default builds from `loadConfig()`, null when no key) so route tests supply a fake `AskChatClient` with no network.

`Bun.serve` sets `idleTimeout: 240` — verified on Bun 1.3.14, the default 10s timeout severs the socket mid-answer for a 5–60s `POST /api/ask` LLM call, and the client sees a dropped connection instead of the response.
