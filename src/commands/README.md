# commands/

CLI entrypoints, wired up by `src/index.ts` (commander). Each command constructs its own deps (config → backend → embedder → local store) and closes them on exit.

- **`search.ts`** — `engram search <query> [--repo --branch --since --limit --json]`. Formatted output by default; `--json` emits pure JSON on stdout (diagnostics go to stderr) so it's always `jq`-safe.
- **`status.ts`** — config completeness, key/db presence, watch path, last ingest time, total chunk count.
- **`backfill.ts`** — recursively finds `.jsonl` under the watch path and runs the ingest pipeline over each; reports chunks embedded per trajectory and embedding-cache hit/miss totals. Idempotent — cursors and seen-hashes make re-runs cheap.
- **`watch.ts`** — `watch-internal` (hidden): long-running `SessionWatcher` process, meant to be supervised by launchd / `dev.sh`.
