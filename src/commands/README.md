# commands/

CLI entrypoints, wired up by `src/index.ts` (commander). Each command constructs its own deps (config → backend → embedder → local store) and closes them on exit.

- **`search.ts`** — `engram search <query> [--repo --branch --since --limit --rerank --json]`. Formatted output by default; `--json` emits pure JSON on stdout (diagnostics go to stderr) so it's always `jq`-safe. `--rerank` (opt-in, needs `OPENAI_API_KEY`) runs the LLM reranker over the top-K hybrid pool and appends `rank=#N` to each reordered result; falls back to hybrid order without a key.
- **`status.ts`** — config completeness, key/db presence, watch path, last ingest time, total chunk count.
- **`backfill.ts`** — recursively finds `.jsonl` under the watch path and runs the ingest pipeline over each; reports chunks embedded per trajectory and embedding-cache hit/miss totals. Idempotent — cursors and seen-hashes make re-runs cheap.
- **`watch.ts`** — `watch-internal` (hidden): long-running `SessionWatcher` process, meant to be supervised by launchd / `dev.sh`. Fails fast (exits non-zero to the log) if config is incomplete, so a supervised run never blocks on a prompt.
- **`service.ts`** — `engram service install|uninstall|status` (macOS/launchd). `install` writes `~/Library/LaunchAgents/com.engram.watcher.plist` that runs the current bun binary against this repo's `src/index.ts watch-internal` with `RunAtLoad` + `KeepAlive`, `WorkingDirectory` = repo root (so `.env` loads), stdout/stderr → `~/.engram/watcher.log`, then bootstraps it (falls back to `launchctl load -w`). Idempotent: reinstalls bootout the old service first. `uninstall` unloads + removes the plist; `status` reports loaded/running state and the last log lines.
