.PHONY: setup up test typecheck dev

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
