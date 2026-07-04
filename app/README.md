# engram app

macOS menu-bar app (Tauri 2) that supervises the existing engram CLI. No new backend — it spawns `bun run src/index.ts …` as children and drives them from a tray.

## What it does

- **Tray menu** (no Dock icon): `Open Search` · `Run Synthesis Now` · UI status line · Synthesis status line · `Quit`. The two disabled lines are the spec's "Status" entry + nightly-run indicator.
- **UI supervision**: on launch, picks a free loopback port, spawns `engram ui --port <N>` with cwd = repo root (so Bun auto-loads the repo `.env`), polls `GET /api/stats` to readiness (20s), and loads it in the search window. Killed + reaped on Quit — no orphan on the port. Crash-restart with backoff (max 3), then an error dialog.
- **Global hotkey** (`Cmd+Shift+E`): Spotlight-style summon/focus of the search window from anywhere; `Esc` hides it (unless the trajectory overlay is open — then the UI's own Esc closes the overlay). Registration failure is non-fatal; the tray path still works.
- **Nightly-run indicator**: polls `~/.engram/synthesis.lock` freshness every 5s (exists AND mtime younger than 30 min — mirrors the CLI's `STALE_MS`). Fresh → active tray icon + `Synthesis: running…` + `Run Synthesis Now` disabled. READ-ONLY: the app never creates or deletes the lock.
- **Run Synthesis Now**: spawns `engram synthesis-run` (cwd = repo root). UX-guarded (single-flight + lock-fresh check); correctness stays in the CLI's advisory lock. This child is deliberately **not** killed on Quit — it self-releases the lock; SIGKILL would strand a stale lock and block the 03:00 launchd run for up to 30 min.

## Run / build

```bash
cd app
bun install          # @tauri-apps/cli (once)
bun run dev          # debug build + launch (first Rust build is slow: hundreds of crates)
bun run build        # → src-tauri/target/release/bundle/macos/Engram.app  (unsigned)
```

Or from the repo root: `bun run app:dev` / `bun run app:build`.

Unsigned build hits Gatekeeper — right-click → Open the first time (code signing/notarization deferred).

Requires Rust (`rustup`, user-space) + Xcode CLT. Docker Postgres must be up for the UI to return results.

## Env knobs (Rust side only — the bun CLI does NOT honor these)

| Var | Default | Purpose |
|---|---|---|
| `ENGRAM_APP_BUN` | `which bun` → `/opt/homebrew/bin/bun` → `~/.bun/bin/bun` | bun executable |
| `ENGRAM_APP_REPO` | `<this repo>` (from `CARGO_MANIFEST_DIR/../..`) | repo root = cwd for spawned children |
| `ENGRAM_DIR` | `~/.engram` | where logs + `synthesis.lock` live |

Child logs (append): `$ENGRAM_DIR/app-ui.log`, `$ENGRAM_DIR/app-synthesis.log`.

The env seams let a tester point the app at a stub repo + temp engram dir for zero-risk spawn/indicator testing.

## Deferred from v1

- **Absorbing the launchd agents** (in-app watcher + nightly scheduler). v1 deliberately **coexists** with the live `com.engram.watcher` / `com.engram.synthesis` LaunchAgents and never touches them, `launchctl`, plists, or `~/.engram/config.json`.
- Code signing / notarization; login item (launch at boot); bundling `bun` as a Tauri sidecar (v1 shells out to the installed `bun`).
- Empty-state recents / tier-toggle UI widgets (a separate UI wave).
- If the app crashes hard (vs. clean Quit), the ui child can be orphaned on its loopback port until manually killed — acceptable for a v1 dev-machine supervisor.
