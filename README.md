# engram

Global semantic memory for your coding sessions. Ingests Claude Code trajectories into pgvector and lets you search your coding history — from the CLI or from inside a Claude Code session over MCP.

## CLI

```bash
engram backfill          # scan ~/.claude/projects and index new sessions
engram watch-internal    # long-running file watcher (launchd / dev.sh)
engram search "<query>"  # semantic search (--repo --branch --since --limit --json)
engram status            # config, watcher state, chunk count
engram mcp               # run the MCP server (stdio)
```

Config lives in `~/.engram/config.json`; `OPENAI_API_KEY` and `ENGRAM_DATABASE_URL` env vars (including a `.env`) override it.

## MCP — use engram from Claude Code

`engram mcp` runs an [MCP](https://modelcontextprotocol.io) server over stdio exposing two tools: `engram_search` and `engram_status`. See [`src/mcp/README.md`](src/mcp/README.md).

Register it with the Claude Code CLI:

```bash
claude mcp add engram -- bun run /absolute/path/to/engram/src/index.ts mcp
```

Or commit it to a project by adding to `.mcp.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/engram/src/index.ts", "mcp"]
    }
  }
}
```

Requires a complete engram config (`OPENAI_API_KEY` + `ENGRAM_DATABASE_URL`); the server fails fast to stderr if either is missing.
