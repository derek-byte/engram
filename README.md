# engram

Global semantic memory for your coding sessions. Ingests Claude Code trajectories into pgvector and makes them searchable.

## Quick start

```bash
bun install
docker compose up -d          # local pgvector on :5432
cp .env.example .env          # set OPENAI_API_KEY (+ optional ENGRAM_DATABASE_URL)

bun run src/index.ts backfill                 # index existing sessions
bun run src/index.ts search "how did I fix chunking"
bun run src/index.ts ui                        # local search UI at http://127.0.0.1:7777
bun run src/index.ts status
```

See `src/ui/README.md` for the local search UI, `src/search`, `src/storage`, and `src/config` for internals.
