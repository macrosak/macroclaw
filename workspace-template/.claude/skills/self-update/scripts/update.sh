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
      --unit="macroclaw-update-$(date -u +%Y%m%dT%H%M%SZ)" \
      --collect \
      --no-block \
      --setenv="PATH=$PATH" \
      /bin/bash -lc "exec macroclaw service update > \"$LOG_FILE\" 2>&1"

    # --user: run in user service manager (not system), so the transient unit
    #   has access to the user D-Bus session bus and can restart user services.
    # --collect: automatically remove the transient unit after it finishes.
    # --no-block: return immediately instead of waiting for the started job.
    ;;
  Darwin)
    nohup setsid /bin/bash -lc "exec macroclaw service update > \"$LOG_FILE\" 2>&1" >/dev/null 2>&1 &

    # Best-effort only:
    # macOS launchd has no simple systemd-run equivalent for transient jobs.
    # nohup + setsid detaches the updater from the current process/session so it
    # has a better chance of surviving when the main launchd service stops.
    # A separate launchd job would still be the more robust long-term solution.
    ;;
  *)
    echo "Unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac
