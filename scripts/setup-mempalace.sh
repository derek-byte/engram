#!/usr/bin/env bash
# MemPalace: benchmark reference + secondary search index over ~/.claude/projects.
# Not an engram dependency — engram runs fine without it.
set -euo pipefail

MEMPALACE_VERSION="3.5.0"
DSN="${MEMPALACE_PGVECTOR_DSN:-postgresql://engram:engram@localhost:5432/mempalace}"

uv tool install "mempalace[pgvector]==${MEMPALACE_VERSION}"

# Idempotent db bootstrap on the compose Postgres.
psql_container() {
  docker exec engram-postgres psql -U engram -d "$1" -c "$2"
}
psql_container engram "SELECT 1 FROM pg_database WHERE datname = 'mempalace'" | grep -q 1 \
  || psql_container engram "CREATE DATABASE mempalace;"
psql_container mempalace "CREATE EXTENSION IF NOT EXISTS vector;"

export MEMPALACE_PGVECTOR_DSN="$DSN"
mempalace init ~/.claude/projects --yes --backend pgvector
mempalace mine ~/.claude/projects --mode convos --backend pgvector --agent "$(whoami)"

echo
echo "Done. Try: MEMPALACE_PGVECTOR_DSN='$DSN' mempalace search \"your query\" --backend pgvector"
