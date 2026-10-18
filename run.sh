#!/usr/bin/env bash
# Local always-on supervisor
# ==========================
# Runs the whole bot — inference service plus capture engine — and keeps it
# running. This is the local-development counterpart to the container's
# `deploy/supervisord.conf`: same two programs, same wiring, but no Docker and
# no root.
#
# Why a supervisor rather than two `nohup` commands: the capture engine exits
# when its WebSocket session ends badly or the host reboots, and the inference
# service is a separate process that must be up before the engine sends its
# first prediction. A bare background process is not restarted and is not
# reachable after the terminal that started it goes away.
#
#   ./run.sh              start (or report the running instance)
#   ./run.sh stop         stop everything
#   ./run.sh status       show what is running
#   ./run.sh logs         tail both logs
#
# The lock file makes the script idempotent: a second `./run.sh` will not start
# a duplicate bot, because two capture engines sharing one signals.json would
# double-append every observation.
#
# Environment (all optional; sensible local defaults):
#   PERIOD, HORIZON            candle period / label horizon in seconds
#   INFERENCE_PORT             inference port (default 8000)
#   PORT                       health-server port for the engine (default 10000)
#   TELEGRAM_BOT_TOKEN/CHAT_ID enable Telegram delivery
#   RETRAIN_INTERVAL_SEC       retrain cadence (default 1800); 0 disables
#   RUN_DIR                    where logs and the lock live (default ./run)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT/run}"
LOCK_FILE="$RUN_DIR/supervisor.lock"
INFERENCE_LOG="$RUN_DIR/inference.log"
CAPTURE_LOG="$RUN_DIR/capture.log"
RETRAIN_LOG="$RUN_DIR/retrain.log"

INFERENCE_PORT="${INFERENCE_PORT:-8000}"
PORT="${PORT:-10000}"
PERIOD="${PERIOD:-60}"
HORIZON="${HORIZON:-180}"
RETRAIN_INTERVAL_SEC="${RETRAIN_INTERVAL_SEC:-1800}"

VENV_PY="$ROOT/inference/.venv/bin/python"
UVICORN="$ROOT/inference/.venv/bin/uvicorn"

mkdir -p "$RUN_DIR"

log() { echo "[supervisor] $*"; }

# ---------------------------------------------------------------- preflight --
preflight() {
  local missing=0
  if [ ! -x "$UVICORN" ]; then
    log "error: inference venv missing at $ROOT/inference/.venv"
    log "       fix: cd inference && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
    missing=1
  fi
  if [ ! -d "$ROOT/price-bot/node_modules" ]; then
    log "error: node_modules missing at $ROOT/price-bot"
    log "       fix: cd price-bot && npm install"
    missing=1
  fi
  if [ ! -f "$ROOT/inference/model.pkl" ]; then
    log "warn: no model.pkl — the bot will run on the local baseline until one is trained"
    log "      train: cd inference && .venv/bin/python train.py --data ../price-bot/signals.json --model model.pkl"
  fi
  return $missing
}

# ------------------------------------------------------------- child runner --
# Run one program forever, restarting it if it exits. Each child gets its own
# process group via setsid so a stop can take down the whole tree (tsx spawns
# node, which would otherwise survive its parent).
supervise() {
  local name="$1" logfile="$2"
  shift 2
  local backoff=2

  while [ ! -f "$RUN_DIR/stopping" ]; do
    log "$name starting"
    echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) $name start =====" >>"$logfile"
    setsid "$@" >>"$logfile" 2>&1 &
    local pid=$!
    echo "$pid" >"$RUN_DIR/$name.pid"

    wait "$pid"
    local rc=$?

    if [ -f "$RUN_DIR/stopping" ]; then
      log "$name stopped"
      return 0
    fi

    log "$name exited (rc=$rc); restarting in ${backoff}s"
    echo "===== $name exited rc=$rc =====" >>"$logfile"
    sleep "$backoff"
    # Cap the backoff so a persistent failure does not stall restarts forever.
    backoff=$(( backoff < 30 ? backoff * 2 : 30 ))
  done
}

# ------------------------------------------------------------------ actions --
stop_bot() {
  if [ ! -f "$RUN_DIR/supervisor.pid" ]; then
    log "not running"
    return 0
  fi
  local pid
  pid="$(cat "$RUN_DIR/supervisor.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "stopping supervisor $pid"
    touch "$RUN_DIR/stopping"
    # SIGTERM the whole group so children get a chance to flush (the capture
    # engine writes its last labels on SIGTERM).
    kill -TERM -"$(ps -o pgid= -p "$pid" | tr -d ' ')" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
  else
    log "stale pid file; cleaning up"
  fi
  rm -f "$RUN_DIR/supervisor.pid" "$RUN_DIR/inference.pid" "$RUN_DIR/capture.pid"
  rm -f "$RUN_DIR/stopping"
  log "stopped"
}

status_bot() {
  local pid
  pid="$(cat "$RUN_DIR/supervisor.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "supervisor running (pid $pid)"
    curl -sf "http://127.0.0.1:$INFERENCE_PORT/health" >/dev/null 2>&1 \
      && log "inference: up on :$INFERENCE_PORT" \
      || log "inference: DOWN"
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 \
      && log "capture:   up on :$PORT" \
      || log "capture:   DOWN"
  else
    log "not running"
    return 1
  fi
}

start_bot() {
  preflight || return 1

  # Take the lock for the life of the run. If another instance holds it, exit
  # rather than starting a second engine.
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another instance is already running (see: ./run.sh status)"
    return 1
  fi

  echo "$$" >"$RUN_DIR/supervisor.pid"
  rm -f "$RUN_DIR/stopping"
  trap stop_bot INT TERM

  log "starting (inference :$INFERENCE_PORT, engine :$PORT, period ${PERIOD}s, horizon ${HORIZON}s)"

  # Inference first: the engine probes it at startup and falls back to the local
  # baseline if it is unreachable, so ordering only affects the first bucket.
  # uvicorn resolves `app:app` relative to its working directory, so it must run
  # from inference/.
  supervise inference "$INFERENCE_LOG" \
    env MODEL_FILE="${MODEL_FILE:-$ROOT/inference/model.pkl}" \
        MODEL_AUTO_RELOAD=1 PYTHONUNBUFFERED=1 \
    bash -c "cd '$ROOT/inference' && exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port $INFERENCE_PORT" &

  supervise capture "$CAPTURE_LOG" \
    env NODE_ENV=production PORT="$PORT" PERIOD="$PERIOD" HORIZON="$HORIZON" \
        INFERENCE_URL="http://127.0.0.1:$INFERENCE_PORT" \
        SIGNALS_FILE="${SIGNALS_FILE:-$ROOT/price-bot/signals.json}" \
        FEATURES_FILE="${FEATURES_FILE:-$ROOT/price-bot/live-prices.json}" \
        TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
        TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" \
    bash -c "cd '$ROOT/price-bot' && exec node_modules/.bin/tsx capture.ts" &

  if [ "$RETRAIN_INTERVAL_SEC" -gt 0 ]; then
    supervise retrain "$RETRAIN_LOG" \
      env SIGNALS_FILE="${SIGNALS_FILE:-$ROOT/price-bot/signals.json}" \
          MODEL_FILE="${MODEL_FILE:-$ROOT/inference/model.pkl}" \
          RETRAIN_INTERVAL_SEC="$RETRAIN_INTERVAL_SEC" \
      "$ROOT/deploy/retrain-loop.sh" &
  fi

  wait
}

case "${1:-start}" in
  start)  start_bot ;;
  stop)   stop_bot ;;
  status) status_bot ;;
  logs)   tail -n 40 -f "$CAPTURE_LOG" "$INFERENCE_LOG" ;;
  restart) stop_bot; sleep 2; start_bot ;;
  *) echo "usage: $0 {start|stop|status|logs|restart}"; exit 2 ;;
esac
