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
  dream/    group raw chunks → LLM synthesis (decisions/fixes/gotchas) → tier='dream' chunks
        │
        ▼
  commands/ search · status · backfill · dream · watch-internal
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
| [`src/dream/`](src/dream/README.md) | Dream layer: incremental LLM synthesis over raw chunks, fingerprint short-circuit |
| [`src/commands/`](src/commands/README.md) | CLI entrypoints (commander) |
| [`src/config/`](src/config/README.md) | `~/.engram` config loading, env overrides |
| [`src/types/`](src/types/README.md) | Shared domain types |
| [`src/ui/`](src/ui/README.md) | Local search UI (`engram ui`, search-as-you-type) |
| [`src/mcp/`](src/mcp/README.md) | MCP server (`engram mcp`) — search engram from Claude Code |

## Quick start

```bash
bun install
docker compose up -d        # local pgvector (Docker Desktop context)
cp .env.example .env        # set OPENAI_API_KEY (or use ENGRAM_EMBEDDING_PROVIDER=local)

bun run src/index.ts backfill
bun run src/index.ts search "what did we decide about chunking" --repo engram
bun run src/index.ts dream --repo engram --dry-run   # plan a dream-layer synthesis (no cost); drop --dry-run to run it
bun run src/index.ts ui     # local search UI at http://127.0.0.1:7777

bun run src/index.ts service install   # macOS: always-on launchd watcher (auto-ingests new sessions); `service status` / `service uninstall`
```

Config lives at `~/.engram/config.json`; `OPENAI_API_KEY` and `ENGRAM_DATABASE_URL` env vars override it.

## Benchmarks

`bun run benchmarks/longmemeval.ts --dataset <longmemeval_s_cleaned.json> [--limit N]` scores engram's retrieval substrate on LongMemEval under the same raw-mode conditions MemPalace publishes (one doc per session, user turns only, fresh index per question, recall_any). Embeddings go through the pg cache, so repeat runs are free. Current numbers: R@5 0.982, NDCG@10 0.945 (vs MemPalace raw 0.966 / 0.889).

Add `--path production` to score the **real** path instead of the in-memory substrate: each question's sessions are injected via `injectDocuments` → pgvector, queried through `runSearch` restricted to an owner (`bench:<question_id>`), and sessions ranked by their best-scoring chunk (max-sim). Bench rows are deleted after each question and swept on exit; `--cleanup` purges any leftovers (`owner LIKE 'bench:%'`).

## MCP — use engram from Claude Code

`engram mcp` runs an [MCP](https://modelcontextprotocol.io) server over stdio exposing `engram_search` and `engram_status` (see [`src/mcp/README.md`](src/mcp/README.md)). Register it:

```bash
claude mcp add engram -- bun run /absolute/path/to/engram/src/index.ts mcp
```

## MemPalace (benchmark reference)

[MemPalace](https://github.com/MemPalace/mempalace) is the published SOTA we measure against, kept as a side-by-side index over the same corpus — not an engram dependency. `scripts/setup-mempalace.sh` installs a pinned version, bootstraps the `mempalace` database on the compose Postgres (fresh volumes get it automatically via `docker/initdb/`), and mines `~/.claude/projects`. Search it with `mempalace search "..." --backend pgvector`.

## References

- [MemPalace](https://github.com/MemPalace/mempalace) — benchmark bar; verbatim thesis, retrieval ladder, eval conditions
- [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) — embedding fallback latch, local fastembed, 0.7/0.3 hybrid
- [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) — eval dataset
- LLM Wiki pattern — incremental synthesis artifacts (the [dream layer](src/dream/README.md))
- Type: [Departure Mono](https://departuremono.com) (OFL)
