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
# Label horizon. Kept at 60 to match the Dockerfile and render.yaml defaults, so
# the local and deployed stacks train on the same prediction problem. A horizon
# change invalidates the existing signals.json (train.py refuses a mixed-horizon
# file), so it must be a deliberate, dataset-wide decision.
HORIZON="${HORIZON:-60}"
RETRAIN_INTERVAL_SEC="${RETRAIN_INTERVAL_SEC:-1800}"

VENV_PY="$ROOT/inference/.venv/bin/python"
UVICORN="$ROOT/inference/.venv/bin/uvicorn"

MODEL_PATH="${MODEL_FILE:-$ROOT/inference/model.pkl}"
SIGNALS_PATH="${SIGNALS_FILE:-$ROOT/price-bot/signals.json}"

mkdir -p "$RUN_DIR"

log() { echo "[supervisor] $*"; }

# True liveness check. `kill -0` succeeds for a ZOMBIE (a reaped-but-not-yet-
# collected child), so a supervisor killed while its parent still lives looks
# alive forever — which is exactly how a stale pidfile defeated the watchdog.
# A process is only "running" if it exists AND is not in state Z.
pid_running() {
  local pid="$1" state
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')"
  [ -n "$state" ] || return 1
  case "$state" in
    Z*|*Z*) return 1 ;;
  esac
  return 0
}

# The supervisor pid, but only if that pid is genuinely alive and is one of our
# run.sh processes (a recycled pid must not be mistaken for the supervisor).
live_supervisor_pid() {
  local pid
  pid="$(cat "$RUN_DIR/supervisor.pid" 2>/dev/null || true)"
  pid_running "$pid" || return 1
  ps -o cmd= -p "$pid" 2>/dev/null | grep -q "run.sh" || return 1
  echo "$pid"
}

# Block until the inference service reports a loaded model, or the deadline
# passes. The engine has no baseline fallback, so starting capture before the
# model is served would collect the first buckets without predicting them.
# A timeout is not fatal: the retrain loop will produce a model and the service
# auto-reloads it, at which point capture starts predicting.
wait_for_model() {
  local port="$1" tries="${2:-30}" i
  for i in $(seq 1 "$tries"); do
    if curl -sf "http://127.0.0.1:$port/health" 2>/dev/null | grep -q '"model_loaded":true'; then
      log "inference serving a model on :$port"
      return 0
    fi
    sleep 1
  done
  log "warn: no model served after ${tries}s — starting capture anyway (COLLECT-ONLY until a model appears)"
  return 1
}

# Kill any engine/inference/retrain process left over from a previous
# supervisor. Called only while holding the lock, so nothing here is "current".
reap_orphans() {
  local name pid found=0

  # 1. Anything recorded in our own pidfiles.
  for name in capture inference retrain; do
    pid="$(cat "$RUN_DIR/$name.pid" 2>/dev/null || true)"
    if pid_running "$pid"; then
      log "reaping orphan $name (pid $pid)"
      kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      found=1
    fi
  done

  # 2. Strays the pidfiles missed (a crash between spawn and write, or a
  #    manually launched engine). Matched by full command line, scoped to this
  #    checkout so an unrelated process on the host is never touched.
  local pat
  for pat in "tsx capture.ts" "uvicorn app:app" "retrain-loop.sh"; do
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      pid_running "$pid" || continue
      grep -qa "$ROOT" "/proc/$pid/cmdline" 2>/dev/null || continue
      log "reaping stray ${pat} (pid $pid)"
      kill -TERM "$pid" 2>/dev/null
      found=1
    done < <(pgrep -f "$pat" 2>/dev/null || true)
  done

  # 3. Orphaned `supervise` loops from a dead supervisor. These are the loops
  #    that RESPAWN children, so leaving one alive undoes everything above: it
  #    starts a fresh engine the moment we kill the old one, which is how two
  #    capture processes appeared. Safe to kill because we hold the lock, so any
  #    other `run.sh start` process is by definition not a live supervisor.
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$$" ] && continue
    pid_running "$pid" || continue
    grep -qa "$ROOT" "/proc/$pid/cmdline" 2>/dev/null || continue
    log "reaping orphan supervise loop (pid $pid)"
    kill -KILL "$pid" 2>/dev/null
    found=1
  done < <(pgrep -f "run.sh start" 2>/dev/null || true)

  if [ "$found" -eq 1 ]; then
    # Give them a moment to flush, then force anything still standing.
    local i
    for i in $(seq 1 10); do
      local alive=0
      for name in capture inference retrain; do
        pid="$(cat "$RUN_DIR/$name.pid" 2>/dev/null || true)"
        pid_running "$pid" && alive=1
      done
      [ "$alive" -eq 0 ] && break
      sleep 1
    done
    for name in capture inference retrain; do
      pid="$(cat "$RUN_DIR/$name.pid" 2>/dev/null || true)"
      if pid_running "$pid"; then
        log "orphan $name did not exit; forcing"
        kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
      fi
    done
    sleep 1
  fi

  rm -f "$RUN_DIR/capture.pid" "$RUN_DIR/inference.pid" "$RUN_DIR/retrain.pid"
}

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
  if [ ! -f "$MODEL_PATH" ]; then
    # The engine runs on the model or not at all. Try to produce one now so a
    # fresh setup starts on the model instead of collecting blindly; the retrain
    # loop retries until the dataset is large enough, but a bootstrap attempt
    # here means an existing dataset yields a serving model before first start.
    log "no model at $MODEL_PATH — attempting to train one now"
    if [ -s "$SIGNALS_PATH" ] && "$VENV_PY" "$ROOT/inference/train.py" \
        --data "$SIGNALS_PATH" --model "$MODEL_PATH" --refit-full >/dev/null 2>&1; then
      log "trained model -> $MODEL_PATH"
    else
      log "warn: could not train yet (dataset below the row floor or no data)."
      log "      The engine will COLLECT-ONLY until the retrain loop produces a model."
    fi
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

  # This function runs as a background subshell (`supervise ... &`), so it
  # inherits the supervisor's lock descriptor (fd 9) and, because it is a child
  # of the supervisor, it also survives when the supervisor is killed with -9.
  # It would then hold the lock forever and every restart would fail with
  # "another instance is already running". Drop the descriptor here; only the
  # supervisor process itself may hold it.
  exec 9>&-

  # Remember the supervisor pid. If it dies without running its trap (kill -9,
  # host suspend), this loop would otherwise keep restarting children forever
  # as an orphan, repopulating engines no supervisor is tracking.
  local parent=$$

  while [ ! -f "$RUN_DIR/stopping" ]; do
    # pid_running, not `kill -0`: a hard-killed supervisor whose parent does
    # not reap it becomes a ZOMBIE, and `kill -0` still succeeds on a zombie.
    # That made orphaned loops believe their supervisor was alive and keep
    # respawning engines nobody tracked.
    if ! pid_running "$parent"; then
      log "$name: supervisor gone; stopping child"
      echo "===== $name orphaned (supervisor gone) =====" >>"$logfile"
      return 0
    fi
    log "$name starting"
    echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) $name start =====" >>"$logfile"
    # Close the supervisor's lock descriptor (fd 9) in the child. Without this
    # the child inherits it, and a long-lived grandchild (e.g. the retrain
    # loop's `sleep 600`) keeps the flock held after the supervisor itself is
    # gone — observed as "another instance is already running" with no
    # supervisor running at all. The lock must die with the supervisor.
    setsid bash -c 'exec 9>&-; exec "$@"' bash "$@" >>"$logfile" 2>&1 &
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
# Stop every supervised program, then the supervisor itself.
#
# Each child is started with `setsid`, so it leads its OWN process group and is
# not reachable through the supervisor's group. Killing only the supervisor's
# group therefore left capture, uvicorn and the retrain loop running — observed
# as "stopped" followed by a live capture engine and a held lock. Each child's
# pid is the group leader id, so `kill -TERM -<pid>` reaches the whole tree
# (tsx -> node, retrain -> sleep) and lets the capture engine flush on SIGTERM.
stop_bot() {
  # Re-entrancy guard: this runs from the CLI *and* from the INT/TERM trap, and
  # the trap's own kill would otherwise re-enter it.
  if [ -n "${STOPPING:-}" ]; then return 0; fi
  STOPPING=1

  touch "$RUN_DIR/stopping" 2>/dev/null || true

  local name pid
  for name in capture inference retrain; do
    pid="$(cat "$RUN_DIR/$name.pid" 2>/dev/null || true)"
    if pid_running "$pid"; then
      log "stopping $name (pid $pid)"
      kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    fi
  done

  local sup
  sup="$(cat "$RUN_DIR/supervisor.pid" 2>/dev/null || true)"
  if pid_running "$sup"; then
    log "stopping supervisor $sup"
    kill -TERM "$sup" 2>/dev/null
  fi

  # Give the children time to flush (the capture engine writes its final labels
  # on SIGTERM), then force-kill anything still standing.
  local i
  for i in $(seq 1 30); do
    local alive=0
    for name in capture inference retrain; do
      pid="$(cat "$RUN_DIR/$name.pid" 2>/dev/null || true)"
      if pid_running "$pid"; then alive=1; fi
    done
    if pid_running "$sup"; then alive=1; fi
    [ "$alive" -eq 0 ] && break
    sleep 1
  done

  for name in capture inference retrain; do
    pid="$(cat "$RUN_DIR/$name.pid" 2>/dev/null || true)"
    if pid_running "$pid"; then
      log "$name did not exit; forcing"
      kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
    fi
  done
  if pid_running "$sup"; then
    kill -KILL "$sup" 2>/dev/null
  fi

  rm -f "$RUN_DIR/supervisor.pid" "$RUN_DIR/inference.pid" "$RUN_DIR/capture.pid" "$RUN_DIR/retrain.pid"
  rm -f "$RUN_DIR/stopping"
  log "stopped"
}

status_bot() {
  local pid
  pid="$(live_supervisor_pid 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    log "supervisor running (pid $pid)"
    curl -sf "http://127.0.0.1:$INFERENCE_PORT/health" >/dev/null 2>&1 \
      && log "inference: up on :$INFERENCE_PORT" \
      || log "inference: DOWN"
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 \
      && log "capture:   up on :$PORT" \
      || log "capture:   DOWN"
    local wd
    wd="$(pgrep -f "run.sh daemon" 2>/dev/null | head -1)"
    [ -n "$wd" ] && log "watchdog:  running (pid $wd)" || log "watchdog:  NOT running (./run.sh start-daemon)"
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

  # Holding the lock proves no other supervisor is running. So any child still
  # alive from a previous incarnation is an ORPHAN: a hard-killed supervisor
  # (kill -9, host suspend) cannot run its trap, and its `setsid` children
  # outlive it. Restarting without reaping them yields two capture engines
  # appending to one signals.json — observed as 2 capture.ts processes. Reap
  # before starting anything.
  reap_orphans

  echo "$$" >"$RUN_DIR/supervisor.pid"
  rm -f "$RUN_DIR/stopping"
  trap stop_bot INT TERM

  log "starting (inference :$INFERENCE_PORT, engine :$PORT, period ${PERIOD}s, horizon ${HORIZON}s)"

  # Inference first: the engine scores every window through it and has no
  # baseline fallback, so it must be serving the model before capture starts —
  # otherwise the first buckets are collected but not predicted. Wait for
  # /health to report a loaded model (bounded) before starting capture.
  supervise inference "$INFERENCE_LOG" \
    env MODEL_FILE="$MODEL_PATH" \
        MODEL_AUTO_RELOAD=1 PYTHONUNBUFFERED=1 \
    bash -c "cd '$ROOT/inference' && exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port $INFERENCE_PORT" &

  wait_for_model "$INFERENCE_PORT"

  supervise capture "$CAPTURE_LOG" \
    env NODE_ENV=production PORT="$PORT" PERIOD="$PERIOD" HORIZON="$HORIZON" \
        INFERENCE_URL="http://127.0.0.1:$INFERENCE_PORT" \
        SIGNALS_FILE="$SIGNALS_PATH" \
        FEATURES_FILE="${FEATURES_FILE:-$ROOT/price-bot/live-prices.json}" \
        TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
        TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" \
        GEMINI_API_KEY="${GEMINI_API_KEY:-${Gemini_API_Token:-}}" \
        GEMINI_MODEL="${GEMINI_MODEL:-}" \
        AI_MIN_CONFIDENCE="${AI_MIN_CONFIDENCE:-}" \
    bash -c "cd '$ROOT/price-bot' && exec node_modules/.bin/tsx capture.ts" &

  if [ "$RETRAIN_INTERVAL_SEC" -gt 0 ]; then
    supervise retrain "$RETRAIN_LOG" \
      env SIGNALS_FILE="$SIGNALS_PATH" \
          MODEL_FILE="$MODEL_PATH" \
          RETRAIN_INTERVAL_SEC="$RETRAIN_INTERVAL_SEC" \
      "$ROOT/deploy/retrain-loop.sh" &
  fi

  wait
}

# ------------------------------------------------------------------- daemon --
# Self-healing outer loop.
#
# `start_bot` already restarts crashed CHILDREN, but nothing restarts the
# supervisor itself. When the host is suspended or the supervisor is killed
# outright, the bot stays dead until a human notices — observed as a 7.5h outage
# after the sandbox suspended at 02:15. This loop is the missing layer: it
# re-invokes `start` whenever the supervisor is gone or the health endpoint
# stops answering, and it is safe to run because `start` is idempotent (flock).
daemon_loop() {
  local interval="${WATCHDOG_INTERVAL_SEC:-30}"
  local log="$RUN_DIR/watchdog.log"
  local unhealthy=0

  log "watchdog running (interval ${interval}s, log ${log})"
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) watchdog start =====" >>"$log"

  while true; do
    if [ -f "$RUN_DIR/daemon.stop" ]; then
      log "watchdog stopping (daemon.stop present)"
      echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) watchdog stop =====" >>"$log"
      return 0
    fi

    local sup
    sup="$(live_supervisor_pid 2>/dev/null || true)"

    if [ -z "$sup" ]; then
      log "watchdog: supervisor not running — starting"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) supervisor absent; starting" >>"$log"
      unhealthy=0
      # setsid so the restarted supervisor does not die with this watchdog.
      setsid nohup "$0" start >>"$log" 2>&1 < /dev/null &
      # Give start_bot time to take the lock and bring children up before the
      # next probe, so one restart is not mistaken for a crash loop.
      sleep "$interval"
      continue
    fi

    # Supervisor alive: also require the engine's health endpoint. A capture
    # process that hangs without exiting would otherwise look healthy forever.
    if curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      unhealthy=0
    else
      unhealthy=$(( unhealthy + 1 ))
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) health probe failed (${unhealthy}/3)" >>"$log"
      # Three consecutive failures (>=90s at the default) before acting, so a
      # slow tick or a brief reconnect does not trigger a restart.
      if [ "$unhealthy" -ge 3 ]; then
        log "watchdog: /health unresponsive ${unhealthy}x — restarting"
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) unhealthy x${unhealthy}; restarting" >>"$log"
        # setsid + detached, so the recovery does not depend on this watchdog
        # staying alive through the restart.
        setsid nohup bash -c "'$0' stop; sleep 3; exec '$0' start" >>"$log" 2>&1 < /dev/null &
        unhealthy=0
        sleep "$interval"
        continue
      fi
    fi

    sleep "$interval"
  done
}

case "${1:-start}" in
  start)   start_bot ;;
  stop)    stop_bot ;;
  status)  status_bot ;;
  logs)    tail -n 40 -f "$CAPTURE_LOG" "$INFERENCE_LOG" ;;
  restart) stop_bot; sleep 2; start_bot ;;
  daemon)  daemon_loop ;;
  # Stop the watchdog first, otherwise it immediately restarts what `stop` just
  # killed.
  stop-all) touch "$RUN_DIR/daemon.stop"; sleep 1; stop_bot ;;
  start-daemon)
    rm -f "$RUN_DIR/daemon.stop"
    # Without this guard every `boot.sh start` (and every watchdog-driven
    # recovery, which calls `start` again) adds another watchdog. Two watchdogs
    # both restart the stack, which is how a duplicate engine appears even
    # though the supervisor itself is locked.
    if pgrep -f "run.sh daemon" >/dev/null 2>&1; then
      echo "[supervisor] watchdog already running (pid $(pgrep -f "run.sh daemon" | head -1))"
    else
      setsid nohup "$0" daemon >>"$RUN_DIR/watchdog.log" 2>&1 < /dev/null &
      echo "[supervisor] watchdog started (pid $!)"
    fi
    ;;
  *) echo "usage: $0 {start|stop|restart|status|logs|daemon|start-daemon|stop-all}"; exit 2 ;;
esac
