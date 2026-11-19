#!/usr/bin/env bash
# One-command live boot
# ====================
# Starts the supervisor (inference + capture + retrain) AND the self-healing
# watchdog, using the settings this project runs live with. Idempotent: running
# it again brings a dead stack back without creating duplicates.
#
#   ./boot.sh            start (or recover) the whole stack
#   ./boot.sh status     show supervisor, services and watchdog
#   ./boot.sh stop       stop the watchdog and everything it manages
#
# Secrets are read from the environment (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID /
# Gemini_API_Token) and passed through to the children. They are never written
# to disk by this script.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Live settings. HORIZON must match the dataset already on disk; 60 matches
# signals.json, so this stays at 60.
export HORIZON="${HORIZON:-60}"
export PORT="${PORT:-10000}"
export INFERENCE_PORT="${INFERENCE_PORT:-8000}"
export RETRAIN_INTERVAL_SEC="${RETRAIN_INTERVAL_SEC:-600}"
export SIGNAL_COOLDOWN_MS="${SIGNAL_COOLDOWN_MS:-0}"
export WATCHDOG_INTERVAL_SEC="${WATCHDOG_INTERVAL_SEC:-30}"

# Gemini: accept either name the environment may use.
export GEMINI_API_KEY="${GEMINI_API_KEY:-${Gemini_API_Token:-}}"

case "${1:-start}" in
  start)
    # `run.sh start` supervises in the FOREGROUND, so it must be detached —
    # calling it directly would block this script forever.
    if ! "$ROOT/run.sh" status >/dev/null 2>&1; then
      setsid nohup "$ROOT/run.sh" start >>"$ROOT/run/supervisor.out" 2>&1 < /dev/null &
      # Give the supervisor time to take the lock and bring the model up.
      sleep 12
    fi
    "$ROOT/run.sh" start-daemon
    sleep 3
    "$ROOT/run.sh" status
    ;;
  status) "$ROOT/run.sh" status ;;
  stop)   "$ROOT/run.sh" stop-all ;;
  *) echo "usage: $0 {start|status|stop}"; exit 2 ;;
esac
