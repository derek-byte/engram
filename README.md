# engram

Global semantic memory for your coding sessions. Watches `~/.claude/projects`, chunks every Claude Code trajectory, embeds it, and makes your entire coding history searchable — filtered by repo, branch, and time.

## Architecture

```
~/.claude/projects/**/*.jsonl
        │
        ▼
  ingest/   parse → trajectories → token-aware chunks → embed (cached)
        │
        ▼
  storage/  raw_events (append-only store of record) + chunks (pgvector, versioned)
        │
        ▼
  search/   query embedding → cosine similarity + metadata filters
        │
        ▼
  commands/ search · status · backfill · watch-internal
```

Two design invariants:

1. **The raw log is the store of record, indexes are disposable.** Every trajectory lands in an append-only `raw_events` table before any chunking/embedding. Chunks are stamped with `chunker_version` + `embedding_model`, so re-indexing under a new model or chunker is a batch job, never a migration crisis.
2. **Never embed the same content twice.** An embedding cache keyed `(content_sha256, model)` sits in front of the OpenAI API.

## Directories

| Dir | Role |
|---|---|
| [`src/ingest/`](src/ingest/README.md) | Parse session JSONL → trajectories → chunks → embeddings; file watcher |
| [`src/storage/`](src/storage/README.md) | pgvector backend (raw events, chunks, embedding cache) + local sqlite state |
| [`src/search/`](src/search/README.md) | Query orchestration: embed query, delegate to backend |
| [`src/commands/`](src/commands/README.md) | CLI entrypoints (commander) |
| [`src/config/`](src/config/README.md) | `~/.engram` config loading, env overrides |
| [`src/types/`](src/types/README.md) | Shared domain types |

## Quick start

```bash
docker compose up -d        # local pgvector (Docker Desktop context)
bun run src/index.ts backfill
bun run src/index.ts search "what did we decide about chunking" --repo engram
```

Config lives at `~/.engram/config.json`; `OPENAI_API_KEY` and `ENGRAM_DATABASE_URL` env vars override it.
