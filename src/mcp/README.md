# MCP server

Exposes engram to Claude Code (and any MCP client) over **stdio**.

## Tools

| Tool | Params | Returns |
| --- | --- | --- |
| `engram_search` | `query` (required), `repo`, `branch`, `since` (ISO), `limit` (default 5), `rerank` (default from config) | Compact text blocks: `timestamp · repo@branch · sim [· rank=#N]`, content (trimmed to ~700 chars), session id. |
| `engram_status` | — | Total indexed chunk count + last ingest time. |

## Layout

- `server.ts` — `startMcpServer(deps)`: registers the two tools, wires `runSearch`, connects a `StdioServerTransport`. Deliberately thin — no search logic lives here. `rerank` falls back to `rerankDefault` (config) when omitted; requesting it without a key logs to stderr and proceeds in hybrid order (never throws).
- Wiring lives in `../commands/mcp.ts` (`engram mcp`): `loadConfig → PgVectorBackend + Embedder + LocalStore → startMcpServer`.

## stdio discipline

stdout is the JSON-RPC protocol channel. **Every diagnostic must go to stderr.** The command fails fast to stderr (never prompts) if config is incomplete — `promptForMissing` is not reachable in this path. Postgres notices are suppressed at the backend.

## Run / debug

```bash
bun run src/index.ts mcp
```

Then speak JSON-RPC on stdin (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`). Requires a complete config (`OPENAI_API_KEY` + `ENGRAM_DATABASE_URL`, via `.env` or `~/.engram/config.json`).
