# ingest/

Turns Claude Code session files into embedded, deduplicated chunks. Flow: `parser → chunker → pipeline → embed`, driven by `watcher` (live) or the backfill command (batch).

## Files

**`parser.ts`** — Reads a session `.jsonl` file into `RawMessage[]`. Normalizes the three content block shapes (text, tool_use, tool_result), keeps `cwd`/`gitBranch`/`sessionId` metadata, skips meta and sidechain messages. Malformed lines are ignored, not fatal.

**`chunker.ts`** — Two stages, two exports:
- `chunkMessages(messages)` groups raw messages into `Trajectory[]` — one per user turn, carrying the user message, assistant blocks, tool calls (outputs truncated to 2k chars), touched file paths, repo/branch.
- `chunkTrajectory(t)` splits one trajectory into embedding-sized text chunks: semantic segments (USER / ASSISTANT / TOOL+RESULT) greedily packed to ~1000 est. tokens with ~120-token overlap, then a hard-split pass at 5000 est. tokens (chars/4 estimate — generous margin under the 8192-token embed limit, so nothing is ever dropped).
- `CHUNKER_VERSION` stamps every stored chunk; bump it when chunking semantics change to trigger re-indexing.

**`hash.ts`** — Identity: `trajectoryHash` (whitespace/case-normalized content hash, doubles as `trajectoryId` and raw-event `content_sha256`), `chunkHash(trajectoryId, index, content)` (per-chunk dedup key), `contentSha256` (embedding-cache key).

**`embed.ts`** — `Embedder` wraps OpenAI embeddings with a read-through cache (`EmbeddingCache` from storage): sha-lookup first, batch-embed only misses, write back. Throws loudly (naming the offending chunk) on input over `MAX_CHARS_PER_INPUT` — never truncates silently. Retries with exponential backoff. `embedWithStats` returns per-call hit/miss counts.

**`pipeline.ts`** — `ingestFile(path, deps)`: parse → trajectories → slice from the per-session cursor → insert raw events (idempotent) → chunk → dedup via local `seen_hashes` → batch embed → upsert to pgvector → advance cursor. One trajectory fans out to N chunks with `trajectoryId`/`chunkIndex`/`chunkCount` provenance.

**`watcher.ts`** — `SessionWatcher` (chokidar) debounces `.jsonl` writes by `sessionCompleteDelaySec`, checks the file is idle (`fileIsStable`), then runs `ingestFile`. Per-path in-flight guard prevents concurrent ingestion of the same file.
