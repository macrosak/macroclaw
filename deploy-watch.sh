#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

INTERVAL=${1:-10}
PID=""

start() {
  echo "[$(date '+%H:%M:%S')] Starting macroclaw..."
  bun run dev &
  PID=$!
}

stop() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] Stopping macroclaw (pid $PID)..."
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null || true
  fi
}

cleanup() {
  echo ""
  echo "[$(date '+%H:%M:%S')] Shutting down..."
  stop
  exit 0
}

trap cleanup SIGINT SIGTERM

# Initial start
bun install --frozen-lockfile
bun test || { echo "Tests failed, not starting."; exit 1; }
start

while true; do
  sleep "$INTERVAL"

  git fetch origin main --quiet

  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/main)

  if [[ "$LOCAL" != "$REMOTE" ]]; then
    echo "[$(date '+%H:%M:%S')] Changes detected ($LOCAL -> $REMOTE)"
    git pull --ff-only origin main

    bun install --frozen-lockfile

    if bun test; then
      echo "[$(date '+%H:%M:%S')] Tests passed, restarting..."
      stop
      start
    else
      echo "[$(date '+%H:%M:%S')] Tests FAILED, keeping current version running."
    fi
  fi
done
