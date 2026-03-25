#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <log-file>" >&2
  exit 1
fi

LOG_FILE="$1"

case "$(uname -s)" in
  Linux)
    systemd-run --user \
      --unit="macroclaw-restart-$(date -u +%Y%m%dT%H%M%SZ)" \
      --collect \
      --no-block \
      --setenv="PATH=$PATH" \
      /bin/bash -lc "exec macroclaw service restart > \"$LOG_FILE\" 2>&1"
    ;;
  Darwin)
    nohup setsid /bin/bash -lc "exec macroclaw service restart > \"$LOG_FILE\" 2>&1" >/dev/null 2>&1 &
    ;;
  *)
    echo "Unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac