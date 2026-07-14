# scripts

- **`setup.sh`** — one-command setup, invoked by `make setup`. Idempotent; safe to re-run anytime. Fresh clone → working engram: deps → compose Postgres → config bootstrap → first backfill → SessionStart hook → MCP registration → launchd watcher. Each step prints ✓ / ↷ (already done) / ✗.

- **`setup-mempalace.sh`** — installs [MemPalace](https://github.com/MemPalace/mempalace) (pinned version) as the side-by-side benchmark reference: creates the `mempalace` database on the compose Postgres and mines `~/.claude/projects`. Not an engram dependency. Run directly: `scripts/setup-mempalace.sh` (needs `uv` + the compose Postgres up).

- **`verify-local-embed.ts`** — smoke test for the local embedding path: `bun scripts/verify-local-embed.ts`. Checks MiniLM loads (384-dim), related text scores above unrelated, and a keyless `openai` config latches to the local fallback with one warning. Run after touching `src/ingest/embed.ts` or bumping fastembed.

- **`gen-arch-diagram.py`** — regenerates the README's excalidraw-style pipeline diagram: `python3 scripts/gen-arch-diagram.py docs/architecture.png`. Hand-wobble SVG rasterized via qlmanage; edit the box/container layout in the script when the pipeline changes.

App icon generation lives in `app/scripts/` (see `app/README.md`).
