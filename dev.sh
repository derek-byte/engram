#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  bun install
fi

echo "Starting engram watcher (foreground)"
echo "Press Ctrl+C to stop"
echo ""

exec bun run src/index.ts watch-internal
