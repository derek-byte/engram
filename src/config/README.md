# config/

Config + paths. Everything lives under `~/.engram/`: `config.json`, `engram.sqlite` (local state), `engram.log`.

`loadConfig()` merges three layers, later wins:
1. Defaults (`text-embedding-3-small`, 1536 dims, watch `~/.claude/projects`, 8s session-idle delay, batch size 32)
2. `~/.engram/config.json`
3. Env vars: `OPENAI_API_KEY`, `ENGRAM_DATABASE_URL` (Bun auto-loads `.env`, so those work too)

`promptForMissing()` interactively collects the OpenAI key and database URL on first run and persists them. `configIsComplete()` gates commands that need both.
