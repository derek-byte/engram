# engram app

macOS menu-bar app (Tauri 2). No backend of its own — it spawns the engram CLI (`bun run src/index.ts ui` / `synthesis-run`) and renders the UI server in a webview.

## Features

- **Tray menu**: Open Search · Settings… · Run Synthesis Now · UI/synthesis status lines · Quit. No Dock icon.
- **UI supervision**: spawns `engram ui` on a free loopback port, polls to readiness, crash-restarts (max 3), kills + reaps on quit.
- **Global hotkey** ⌘⇧E: Spotlight-style summon/hide of the search window; Esc hides it.
- **Synthesis indicator**: watches `~/.engram/synthesis.lock` freshness (read-only) and swaps the tray icon while a run is active.
- **Run Synthesis Now**: spawns `engram synthesis-run`; deliberately not killed on quit (it self-releases the lock).
- **Auto-update**: on launch, `git pull --ff-only` — only on `main` with a clean tree; shows a rebuild banner when the Rust shell changed.
- **Single-instance**: a second launch just focuses the running app.

## Run / build

```bash
cd app
bun install      # once
bun run dev      # debug build + launch (first Rust build is slow)
bun run build    # → src-tauri/target/release/bundle/macos/Engram.app (unsigned: right-click → Open)
```

Needs Rust, Xcode CLT, bun. Postgres must be up for search results.

## Test

- **Web UI (`src/ui/*`)**: no rebuild — served per-request; Cmd+R in the app window.
- **Rust**: `cd src-tauri && cargo test` (stub CLI + temp dirs; never touches real data).
- **Tray/hotkey/window behavior**: `bun run dev` — quit the installed Engram.app first (single-instance blocks a second launch).
- **Packaged .app (icons, Gatekeeper)**: `bun run build` or `make app` from repo root.

## Icons

Edit `src-tauri/icons/icon-art.png` (or `scripts/gen-icons.py`), then:

```bash
python3 scripts/gen-icons.py && bunx tauri icon src-tauri/icons/icon-source.png
```

Delete the generated `android/`, `ios/`, `Square*`, `StoreLogo*` extras (macOS-only). Stale icon in Finder/Dock: `killall Finder Dock`.

## Env / logs

| Var | Default |
|---|---|
| `ENGRAM_APP_BUN` | `which bun` → `/opt/homebrew/bin/bun` → `~/.bun/bin/bun` |
| `ENGRAM_APP_REPO` | this repo (cwd for spawned children) |
| `ENGRAM_DIR` | `~/.engram` |

Rust-side only (the CLI doesn't honor them) — point the app at a stub repo + temp dir for zero-risk testing. Child logs: `~/.engram/app-ui.log`, `app-synthesis.log`, `app-update.log`.
