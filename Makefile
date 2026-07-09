.PHONY: setup up test typecheck dev app

# One command: fresh clone → working, indexed, wired-up engram. Then open the app.
setup:
	@bash scripts/setup.sh

# Just start the local pgvector Postgres.
up:
	docker compose up -d

# Run the test suite.
test:
	bun test

# Type-check without emitting.
typecheck:
	tsc --noEmit

# Run the local web UI (http://127.0.0.1:7777).
dev:
	bun run src/index.ts ui

# Rebuild the desktop shell and swap it into /Applications. Only needed when
# app/src-tauri (Rust: window chrome, tray, hotkey) changes — the web UI and
# server are served per-request from this repo, so a plain app relaunch picks
# those up. Skips the DMG (fails headless; the .app is all we install).
app:
	cd app && bun run tauri build --bundles app
	@osascript -e 'quit app "Engram"' 2>/dev/null || true
	rm -rf /Applications/Engram.app
	cp -R app/src-tauri/target/release/bundle/macos/Engram.app /Applications/Engram.app
	open /Applications/Engram.app
