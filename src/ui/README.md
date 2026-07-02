# Local search UI

`engram ui [--port 7777]` starts a `Bun.serve` bound to **127.0.0.1 only** — a search-engine-style page over your memory index.

```
engram ui            # http://127.0.0.1:7777
engram ui --port 8080
```

## Routes

- `GET /` — single self-contained `index.html` (inline CSS + vanilla JS, zero external/CDN resources). Dark, minimal; results render as you type.
- `GET /api/search?q=…&k=3` — embeds `q` via the existing `Embedder` (query embeddings hit the pg `embedding_cache`, so repeat queries are free) and runs `runSearch`. Returns per-result `similarity`, `repo`, `branch`, `timestamp`, `sessionId`, `trajectoryId`, `chunkIndex`, a ~300-char `snippet`, and chunk `id`.
- `GET /api/trajectory/:trajectoryId` — all chunks with that `trajectory_id` ordered by `chunk_index` (parameterized SQL via `PgVectorBackend.getTrajectory`), so a click stitches the full conversation turn together with the matched chunk highlighted.

## Frontend

- Debounce ~200ms; `AbortController` cancels stale in-flight requests; `Enter` triggers an immediate search.
- `k` is a constant (`K = 3`) in `index.html` — change it there.
- Click a result → full-document overlay with a back affordance (also `Esc`); the matched chunk is highlighted and scrolled into view.
- All dynamic content is rendered via `textContent` / DOM APIs — **never** `innerHTML` with data (chunk content is untrusted).

## Reuse

No duplicate search logic: reuses `loadConfig`, `PgVectorBackend`, `Embedder` (with the backend passed as its embedding cache), and `runSearch`. Requires a complete config (`engram backfill` sets it up). Logs the bound URL once; per-request failures go to `console.error`.
