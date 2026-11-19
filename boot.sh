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

# Delivery and analysis both depend on these. A missing token does not crash the
# engine — it just silently never delivers — so refuse to *start* instead of
# running a bot that looks healthy and can never reach the user. `stop` and
# `status` must keep working regardless, or a bad config could not be undone.
require_secrets() {
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "[boot] ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set." >&2
    echo "[boot] Without them the engine runs but delivers nothing." >&2
    return 1
  fi
  if [ -z "${GEMINI_API_KEY:-}" ]; then
    echo "[boot] ERROR: GEMINI_API_KEY (or Gemini_API_Token) is not set." >&2
    echo "[boot] Without it the AI analysis gate cannot run and every signal is dropped." >&2
    return 1
  fi
  return 0
}

case "${1:-start}" in
  start)
    require_secrets || exit 1
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
