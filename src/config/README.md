# config/

Config + paths. Everything lives under `~/.engram/`: `config.json`, `engram.sqlite` (local state), `engram.log`, `models/` (local embedding models).

`loadConfig()` merges three layers, later wins:
1. Defaults (watch `~/.claude/projects`, 8s session-idle delay, batch size 32)
2. `~/.engram/config.json`
3. Env vars: `OPENAI_API_KEY`, `ENGRAM_DATABASE_URL`, `ENGRAM_EMBEDDING_PROVIDER` (Bun auto-loads `.env`)

`promptForMissing()` interactively collects required fields on first run and persists them. `configIsComplete()` gates commands.

## Embedding provider

- `embeddingProvider`: `'openai'` (default, pending benchmark-backed flip to local) | `'local'`.
- `embeddingModel`/`embeddingDim` follow the provider: `openai` → `text-embedding-3-small`/1536, `local` → `all-MiniLM-L6-v2`/384 (forced coherent when provider is local — see `PROVIDER_DEFAULTS` in `ingest/embed.ts`).
- `local` needs no API key; `configIsComplete`/`promptForMissing` only require the OpenAI key when the provider is `openai`.
- Switching providers changes the vector dimension, so a switch requires a re-embedded index (see `src/ingest/README.md`).

## Rerank

`rerank`: `{ enabled: false, model: 'gpt-4.1-mini', topK: 30 }` — the LLM reranker (see `src/search/README.md`). **Default off** on purpose: it costs money and adds latency, against the local-first ethos. Nested-merged in `loadConfig` (older config files without the block get defaults); `topK` clamped to [1,100]. No env var — enable via config file, `--rerank` flag, or the MCP `rerank` param. Needs `OPENAI_API_KEY`; degrades to hybrid order without one.

## Wiki + synthesis

- `wikiDir` (default `~/.engram/wiki`), `wikiModel` (`gpt-4o-mini`), `wikiMaxInputChars` (60k). Env overrides: `ENGRAM_WIKI_DIR` (mandatory for dev/test — never write the real wiki dir) and `ENGRAM_WIKI_MODEL`.
- `synthesis`: `{ enabled: false, hour: 3 }` — nested-merged like `rerank` (older config files get defaults), `hour` clamped to int 0–23. Off by default. When on, `engram service install` also installs the nightly `com.engram.synthesis` launchd agent (StartCalendarInterval at `hour`) and the watcher runs dream → wiki after each ingest.

## Context injection

`contextInjection`: `{ enabled: true, budget: 1500 }` — governs `engram context` (see `src/context/README.md`). Nested-merged like the blocks above; `budget` clamped to [100, 20000]. `enabled: false` is the kill switch: the SessionStart hook stays installed and prints nothing (silent-empty, exit 0) until flipped back — no settings.json surgery. This is the pattern the desktop app's settings pane builds on: every toggle is a config.json key.
