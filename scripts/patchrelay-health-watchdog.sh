#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${PATCHRELAY_WATCHDOG_HEALTH_URL:-http://127.0.0.1:8787/health}"
TIMEOUT_SECONDS="${PATCHRELAY_WATCHDOG_TIMEOUT_SECONDS:-45}"
FAILURES_BEFORE_KILL="${PATCHRELAY_WATCHDOG_FAILURES_BEFORE_KILL:-3}"
LOG_FILE="${PATCHRELAY_WATCHDOG_LOG_FILE:-$HOME/.local/state/patchrelay/watchdog.log}"
LOCK_FILE="${PATCHRELAY_WATCHDOG_LOCK_FILE:-$HOME/.local/state/patchrelay/watchdog.lock}"
STATE_FILE="${PATCHRELAY_WATCHDOG_STATE_FILE:-$HOME/.local/state/patchrelay/watchdog.failures}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

if curl --silent --show-error --fail --max-time "$TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null 2>&1; then
  rm -f "$STATE_FILE"
  exit 0
fi

failures=0
if [[ -f "$STATE_FILE" ]]; then
  failures="$(cat "$STATE_FILE" 2>/dev/null || printf '0')"
fi
if ! [[ "$failures" =~ ^[0-9]+$ ]]; then
  failures=0
fi
failures=$((failures + 1))
printf '%s\n' "$failures" > "$STATE_FILE"

pid="$(systemctl show patchrelay.service --property=ExecMainPID --value 2>/dev/null || true)"
if [[ -z "$pid" || "$pid" == "0" ]]; then
  log "health failed but patchrelay.service has no ExecMainPID"
  exit 0
fi

state="$(ps -o stat= -p "$pid" 2>/dev/null | awk '{print $1}' || true)"
wchan="$(cat "/proc/$pid/wchan" 2>/dev/null || true)"
rss_kb="$(ps -o rss= -p "$pid" 2>/dev/null | awk '{print $1}' || true)"
pressure="$(tr '\n' ';' < /proc/pressure/memory 2>/dev/null || true)"

if (( failures < FAILURES_BEFORE_KILL )); then
  log "health failed (${failures}/${FAILURES_BEFORE_KILL}); leaving patchrelay alive pid=$pid state=${state:-unknown} wchan=${wchan:-unknown} rss_kb=${rss_kb:-unknown} memory_pressure=${pressure:-unknown}"
  exit 0
fi

log "health failed (${failures}/${FAILURES_BEFORE_KILL}); terminating patchrelay pid=$pid state=${state:-unknown} wchan=${wchan:-unknown} rss_kb=${rss_kb:-unknown} memory_pressure=${pressure:-unknown}"
rm -f "$STATE_FILE"
kill -TERM "$pid" 2>/dev/null || true
sleep 10
if kill -0 "$pid" 2>/dev/null; then
  log "patchrelay pid=$pid ignored TERM; killing"
  kill -9 "$pid" 2>/dev/null || true
fi
