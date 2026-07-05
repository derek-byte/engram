#!/usr/bin/env bash
# engram one-command setup. Idempotent — safe to re-run anytime.
# Invoked by `make setup`. Takes a fresh clone to a working, indexed, wired-up
# engram: deps → local pgvector → config → first index → SessionStart hook →
# MCP registration → always-on service. Every step prints ✓ (done), ↷ (skipped,
# already satisfied), or ✗ (failed) and is a no-op when its work is already done.
set -euo pipefail

# ── Resolve repo root (this script lives in scripts/) ────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

INDEX="$REPO_ROOT/src/index.ts"
COMPOSE_DB_URL="postgresql://engram:engram@localhost:5432/engram"

# ── Logging helpers ──────────────────────────────────────────────────────────
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '  \033[2m↷ %s\033[0m\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { fail "$*"; exit 1; }

HAS_CLAUDE=0   # set in preflight; gates the MCP step

# ── 1. Preflight ─────────────────────────────────────────────────────────────
step "1/8  Preflight"

if command -v bun >/dev/null 2>&1; then
  ok "bun $(bun --version)"
else
  fail "bun is not installed."
  echo "      Install it:  curl -fsSL https://bun.sh/install | bash"
  echo "      Then re-run:  make setup"
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "docker daemon reachable"
  else
    fail "docker CLI found but the daemon is not reachable."
    echo "      Start Docker Desktop, then re-run: make setup"
    echo "      If the daemon is up under a non-default context, check:  docker context ls"
    echo "      (engram's Postgres runs on whichever context 'docker compose' resolves to.)"
    exit 1
  fi
else
  fail "docker is not installed."
  echo "      Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
  echo "      Then re-run: make setup"
  exit 1
fi

if command -v claude >/dev/null 2>&1; then
  HAS_CLAUDE=1
  ok "claude CLI found (MCP step will run)"
else
  warn "claude CLI not found — the MCP registration step (7) will be skipped."
fi

# ── 2. Dependencies ──────────────────────────────────────────────────────────
step "2/8  Install dependencies"
bun install
ok "bun install complete"

# ── 3. Local pgvector (docker compose) ───────────────────────────────────────
step "3/8  Start local Postgres (pgvector)"
docker compose up -d
ok "docker compose up -d"

printf '  waiting for Postgres to accept connections'
PG_READY=0
for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U engram >/dev/null 2>&1; then
    PG_READY=1
    break
  fi
  printf '.'
  sleep 1
done
printf '\n'
if [ "$PG_READY" -eq 1 ]; then
  ok "Postgres is ready"
else
  die "Postgres did not become ready within 30s. Check: docker compose logs postgres"
fi

# ── 4. Config bootstrap ──────────────────────────────────────────────────────
# Write the compose default databaseUrl into ~/.engram/config.json (raw-file
# patch that preserves every other key) unless a databaseUrl is already set in
# config.json or the ENGRAM_DATABASE_URL env var (incl. anything Bun loads from
# .env). Optionally capture an OpenAI key when running interactively.
step "4/8  Bootstrap config (~/.engram/config.json)"

DB_STATE="$(
  DEFAULT_DB_URL="$COMPOSE_DB_URL" bun -e '
    import { readConfigFile, CONFIG_PATH } from "./src/config/index.ts";
    import { writeFileSync } from "node:fs";
    const path = process.env.ENGRAM_CONFIG_PATH ?? CONFIG_PATH;
    const raw = readConfigFile();
    const haveFileUrl = typeof raw.databaseUrl === "string" && raw.databaseUrl.length > 0;
    const haveEnvUrl = Boolean(process.env.ENGRAM_DATABASE_URL);
    if (haveFileUrl) { console.log("skip-file"); }
    else if (haveEnvUrl) { console.log("skip-env"); }
    else {
      raw.databaseUrl = process.env.DEFAULT_DB_URL;
      writeFileSync(path, JSON.stringify(raw, null, 2));
      console.log("wrote");
    }
  '
)"
case "$DB_STATE" in
  wrote)     ok "databaseUrl → $COMPOSE_DB_URL (config.json)" ;;
  skip-file) skip "databaseUrl already set in config.json" ;;
  skip-env)  skip "databaseUrl provided via ENGRAM_DATABASE_URL / .env" ;;
  *)         die "config bootstrap failed" ;;
esac

# Optional OpenAI key — only prompt on an interactive TTY; skip silently otherwise.
KEY_STATE="$(
  bun -e '
    import { readConfigFile } from "./src/config/index.ts";
    const raw = readConfigFile();
    const haveFileKey = typeof raw.openaiApiKey === "string" && raw.openaiApiKey.length > 0;
    console.log(haveFileKey || process.env.OPENAI_API_KEY ? "have" : "missing");
  '
)"
if [ "$KEY_STATE" = "have" ]; then
  skip "OpenAI key already configured (synthesis/ask enabled)"
elif [ -t 0 ]; then
  printf '  OpenAI API key for synthesis/ask (Enter to skip — local embeddings work without it): '
  read -r OPENAI_KEY_INPUT || OPENAI_KEY_INPUT=""
  if [ -n "$OPENAI_KEY_INPUT" ]; then
    OPENAI_KEY_INPUT="$OPENAI_KEY_INPUT" bun -e '
      import { readConfigFile, CONFIG_PATH } from "./src/config/index.ts";
      import { writeFileSync } from "node:fs";
      const path = process.env.ENGRAM_CONFIG_PATH ?? CONFIG_PATH;
      const raw = readConfigFile();
      raw.openaiApiKey = process.env.OPENAI_KEY_INPUT;
      writeFileSync(path, JSON.stringify(raw, null, 2));
    '
    ok "OpenAI key saved to config.json"
  else
    skip "no OpenAI key — running with local embeddings only"
  fi
else
  skip "no OpenAI key (non-interactive) — local embeddings only"
fi

# ── 5. First index ───────────────────────────────────────────────────────────
# Count existing chunks straight from the backend so a DB that is unreachable
# fails fast here (rather than silently skipping the backfill). Empty → backfill.
step "5/8  First index"
set +e
CHUNK_COUNT="$(
  bun -e '
    import { loadConfig, configIsComplete } from "./src/config/index.ts";
    import { PgVectorBackend } from "./src/storage/pgvector.ts";
    const c = loadConfig();
    if (!configIsComplete(c)) { console.error("config incomplete"); process.exit(2); }
    const b = PgVectorBackend.fromConfig(c);
    try { await b.initialize(); process.stdout.write(String(await b.count())); }
    finally { await b.close(); }
  ' 2>/tmp/engram-count-err
)"
COUNT_RC=$?
set -e
if [ "$COUNT_RC" -ne 0 ]; then
  fail "could not query the index (database unreachable?):"
  sed 's/^/      /' /tmp/engram-count-err 2>/dev/null || true
  die "fix the database connection above, then re-run: make setup"
fi
if [ "$CHUNK_COUNT" -gt 0 ] 2>/dev/null; then
  skip "index already has $CHUNK_COUNT chunks"
else
  echo "  index is empty — running first backfill over ~/.claude/projects (this can take a bit)…"
  bun run "$INDEX" backfill
  ok "backfill complete"
fi

# ── 6. SessionStart hook ─────────────────────────────────────────────────────
step "6/8  SessionStart hook (context injection)"
if bun run "$INDEX" hooks status --json 2>/dev/null | grep -q '"installed": true'; then
  skip "SessionStart hook already installed"
else
  bun run "$INDEX" hooks install
  ok "SessionStart hook installed"
fi

# ── 7. MCP registration ──────────────────────────────────────────────────────
step "7/8  MCP registration (Claude Code)"
if [ "$HAS_CLAUDE" -eq 1 ]; then
  if claude mcp list 2>/dev/null | grep -q engram; then
    skip "engram already registered as an MCP server"
  else
    claude mcp add engram -s user -- bun run "$INDEX" mcp
    ok "registered engram MCP server (user scope)"
  fi
else
  skip "claude CLI absent — skipping MCP registration"
fi

# ── 8. Always-on service (macOS / launchd) ───────────────────────────────────
step "8/8  Always-on service"
if [ "$(uname)" = "Darwin" ]; then
  if [ -f "$HOME/Library/LaunchAgents/com.engram.watcher.plist" ]; then
    skip "engram watcher service already installed"
  else
    bun run "$INDEX" service install
    ok "service installed"
  fi
else
  skip "not macOS — the launchd service is macOS-only (use dev.sh / your own supervisor)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
step "engram is ready."
cat <<EOF
  Config:   ~/.engram/config.json
  Database: local pgvector via docker compose ($COMPOSE_DB_URL)

  Open the app:
    cd app && bun run tauri dev            # menu-bar app (Tauri)
    bun run src/index.ts ui                # or the local web UI → http://127.0.0.1:7777

  Try it:
    bun run src/index.ts search "what did we decide about X"
    bun run src/index.ts ask "what did we decide about X and why"   # needs OpenAI key
EOF
