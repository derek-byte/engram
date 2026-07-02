# types/

Shared domain types. The vocabulary, in pipeline order:

- **`Trajectory`** — one user turn plus everything it caused: user message, assistant blocks, `ToolCall[]` (with truncated outputs), touched file paths, repo/branch/cwd/session metadata. Produced by the chunker from parsed messages.
- **`RawEvent`** — the append-only store-of-record row: owner, source, session, content sha, timestamp, full jsonb payload.
- **`Chunk` / `ChunkMetadata`** — an embedded text chunk. Metadata carries search filters (repo, branch, timestamp, tier raw/dream) and provenance (`trajectoryId`, `chunkIndex`, `chunkCount` — optional because legacy rows predate sub-chunking).
- **`SearchFilters` / `SearchResult`** — query surface: repo/branch/since/tier/exitCode/limit in, chunk + similarity out.
- **`EngramConfig`** — see `src/config/README.md`.
