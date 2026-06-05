#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${PATCHRELAY_WATCHDOG_HEALTH_URL:-http://127.0.0.1:8787/health}"
TIMEOUT_SECONDS="${PATCHRELAY_WATCHDOG_TIMEOUT_SECONDS:-12}"
LOG_FILE="${PATCHRELAY_WATCHDOG_LOG_FILE:-$HOME/.local/state/patchrelay/watchdog.log}"
LOCK_FILE="${PATCHRELAY_WATCHDOG_LOCK_FILE:-$HOME/.local/state/patchrelay/watchdog.lock}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

if curl --silent --show-error --fail --max-time "$TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null 2>&1; then
  exit 0
fi

pid="$(systemctl show patchrelay.service --property=ExecMainPID --value 2>/dev/null || true)"
if [[ -z "$pid" || "$pid" == "0" ]]; then
  log "health failed but patchrelay.service has no ExecMainPID"
  exit 0
fi

state="$(ps -o stat= -p "$pid" 2>/dev/null | awk '{print $1}' || true)"
wchan="$(cat "/proc/$pid/wchan" 2>/dev/null || true)"
log "health failed; killing patchrelay pid=$pid state=${state:-unknown} wchan=${wchan:-unknown}"
kill -9 "$pid" 2>/dev/null || true
