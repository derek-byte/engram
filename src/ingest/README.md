# ingest/

Turns Claude Code session files into embedded, deduplicated chunks. Flow: `parser → chunker → pipeline → embed`, driven by `watcher` (live) or the backfill command (batch).

## Files

**`parser.ts`** — Reads a session `.jsonl` file into `RawMessage[]`. Normalizes the three content block shapes (text, tool_use, tool_result), keeps `cwd`/`gitBranch`/`sessionId` metadata, skips meta and sidechain messages. Malformed lines are ignored, not fatal.

**`chunker.ts`** — Two stages, two exports:
- `chunkMessages(messages)` groups raw messages into `Trajectory[]` — one per user turn, carrying the user message, assistant blocks, tool calls (outputs truncated to 2k chars), touched file paths, repo/branch.
- `chunkTrajectory(t)` splits one trajectory into embedding-sized text chunks: semantic segments (USER / ASSISTANT / TOOL+RESULT) greedily packed to ~1000 est. tokens with ~120-token overlap, then a hard-split pass at 5000 est. tokens (chars/4 estimate — generous margin under the 8192-token embed limit, so nothing is ever dropped).
- `CHUNKER_VERSION` stamps every stored chunk; bump it when chunking semantics change to trigger re-indexing.

**`hash.ts`** — Identity: `trajectoryHash` (whitespace/case-normalized content hash, doubles as `trajectoryId` and raw-event `content_sha256`), `chunkHash(trajectoryId, index, content)` (per-chunk dedup key), `contentSha256` (embedding-cache key).

**`embed.ts`** — `Embedder` is provider-agnostic: it owns the read-through cache (keyed `content_sha256` + model), the oversized-input guard (loud throw naming the offender, never silent truncation), retry with backoff (fast-fail on non-retryable 4xx), and per-call hit/miss stats. Vector math is delegated to an `EmbeddingProvider`:
- `OpenAIProvider` — `text-embedding-3-small`, 1536-dim, `MAX_CHARS_PER_INPUT` (24k) guard.
- `FastembedProvider` — local ONNX `all-MiniLM-L6-v2`, 384-dim, via `fastembed`. Model downloads on first use to `~/.engram/models`; no char cap (MiniLM's 512-token window truncates internally).
- `FallbackProvider` — the Odysseus "HTTP-down latch": when openai fails after retries (or no key is configured), latch to local for the rest of the process, one warning, no per-batch re-probing.

Providers return `{ vectors, model }` atomically, and everything downstream stamps the model that **actually** embedded (`chunks.embedding_model`, cache keys) — never the configured one. A mid-batch latch re-embeds the whole batch under the new model so no batch mixes dimensions.

**Mixed-index caveat:** vectors from different models must never be compared, and `vector(N)` is a fixed-dim column. A mid-ingest latch (1536 → 384) fails loudly on insert rather than corrupting; run single-model, or reconcile with a re-embed batch job. Search embeds the query with the configured provider and falls back the same way.

**`pipeline.ts`** — `ingestFile(path, deps)`: parse → trajectories → slice from the per-session cursor → insert raw events (idempotent) → chunk → dedup via local `seen_hashes` → batch embed → upsert to pgvector → advance cursor. One trajectory fans out to N chunks with `trajectoryId`/`chunkIndex`/`chunkCount` provenance.

**`watcher.ts`** — `SessionWatcher` (chokidar) debounces `.jsonl` writes by `sessionCompleteDelaySec`, checks the file is idle (`fileIsStable`), then runs `ingestFile`. Per-path in-flight guard prevents concurrent ingestion of the same file.
