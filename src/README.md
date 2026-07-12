# src

The engram engine + CLI (Bun/TypeScript). Entry point: `index.ts` — commander CLI wiring every command in `commands/`. Data flows ingest → storage → synthesis (dream → wiki) → surfaces (search / ask / context / MCP / UI).

| Dir | What it is |
|---|---|
| `commands/` | One file per CLI command (`search`, `ask`, `backfill`, `watch`, `ui`, `mcp`, `service`, `dream`, `wiki`, `synthesis-run`, `context`, `hooks`, `demand`, `jobs`, `status`…). Thin: parse flags, build deps, call the core module, print. |
| `config/` | `~/.engram/config.json` loading, defaults, completeness checks. Everything downstream takes an `EngramConfig`. |
| `types/` | Shared type definitions (`Trajectory`, `Chunk`, tiers, `EngramConfig`). |
| `ingest/` | Session capture: jsonl parser → trajectory chunker → embeddings (local MiniLM or OpenAI, pg-cached) → pipeline upsert. Plus the fs watcher, bulk `injectDocuments`, artifact extraction, synthesis queue. |
| `storage/` | The two stores: `pgvector.ts` (Postgres — chunks, raw events, embedding cache, hybrid search SQL) behind the `backend.ts` interface, and `local.ts` (SQLite — recents, demand log, job telemetry). |
| `llm/` | Shared OpenAI plumbing: per-model completion params, request timeout, retry/backoff. |
| `dream/` | Tier-1 synthesis: conservative per-trajectory extraction (decision / fix / gotcha / preference chunks) via LLM. |
| `wiki/` | Tier-2 synthesis: compiles dream chunks into markdown knowledge pages at `~/.engram/wiki/` (git-versioned, wikilinked), plus lint, link graph, page store, pg indexing. |
| `search/` | Query surface: hybrid vector+keyword `runSearch` across tiers, optional LLM rerank, demand logging. |
| `ask/` | Answer surface: retrieve → grounded LLM answer with `[n]` citations resolving to raw provenance. |
| `context/` | SessionStart injection: resolve repo/branch → compose a token-budgeted "what you decided last time" block for new Claude Code sessions. |
| `eval/` | Ask answer-quality eval core (citation-faithfulness judge) — driven by `engram askeval-run` and `benchmarks/askeval.ts`. |
| `mcp/` | MCP server exposing search/ask as tools for Claude Code/Desktop/Cursor. |
| `ui/` | Local web UI (vanilla JS, served by `engram ui`, rendered by the browser or the `app/` webview): search, ask, wiki pages, trajectory overlay, analytics, settings, setup. |
