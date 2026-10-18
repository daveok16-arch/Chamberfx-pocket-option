#!/usr/bin/env bash
# Periodic retraining loop
# ========================
# train.py is the source of truth for "do we have enough data yet" — it refuses
# below its row floor and exits non-zero. Duplicating that threshold here would
# create a second place to keep in sync, so this loop just re-runs it on a
# schedule and treats a refusal as normal.
#
# A successful train writes MODEL_FILE; the inference service picks it up on its
# next request via MODEL_AUTO_RELOAD, so no restart is needed.
set -u

log() { echo "[retrain] $*"; }

# Resolve everything relative to this script so the loop works both in the
# container and from a local checkout.
#
# The interpreter is the subtle one: the image builds its venv at /app/venv
# (a sibling of the source), while a local checkout keeps it under
# inference/.venv. Guessing wrong is silent — the loop just logs "not trained
# yet" forever and the deployed model never updates — so probe both and fail
# loudly if neither exists. PYTHON overrides the probe.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${APP_ROOT:-$(dirname "$SELF_DIR")}"
TRAIN="${TRAIN:-$APP_ROOT/inference/train.py}"

if [ -z "${PYTHON:-}" ]; then
  for cand in \
    "$APP_ROOT/venv/bin/python" \
    "$APP_ROOT/inference/.venv/bin/python" \
    "$APP_ROOT/.venv/bin/python"
  do
    if [ -x "$cand" ]; then PYTHON="$cand"; break; fi
  done
fi

if [ -z "${PYTHON:-}" ] || [ ! -x "$PYTHON" ]; then
  log "error: no python interpreter found under ${APP_ROOT}"
  log "       set PYTHON=/path/to/venv/bin/python, or create one:"
  log "       python3 -m venv inference/.venv && inference/.venv/bin/pip install -r inference/requirements.txt"
  exit 1
fi

if [ ! -f "$TRAIN" ]; then
  log "error: train.py not found at ${TRAIN}"
  exit 1
fi

SIGNALS="${SIGNALS_FILE:-$APP_ROOT/price-bot/signals.json}"
MODEL="${MODEL_FILE:-$APP_ROOT/inference/model.pkl}"
INTERVAL="${RETRAIN_INTERVAL_SEC:-1800}"

log "loop started (interval ${INTERVAL}s, data ${SIGNALS}, model ${MODEL}, python ${PYTHON})"

while true; do
  sleep "$INTERVAL"

  if [ ! -s "$SIGNALS" ]; then
    log "no dataset at ${SIGNALS} yet — skipping"
    continue
  fi

  # Capture output so a refusal is summarised rather than spamming every cycle.
  # --refit-full: evaluate on the held-out split as usual, then refit the saved
  # model on every non-test row so the deployed model uses the whole dataset.
  if out=$("$PYTHON" "$TRAIN" --data "$SIGNALS" --model "$MODEL" --refit-full 2>&1); then
    log "trained OK -> ${MODEL}"
    echo "$out" | grep -E '^\[(save|eval|walk|split|calib)' || true
  else
    reason=$(echo "$out" | grep -E '^\[error\]' | head -1)
    log "not trained yet: ${reason:-train.py exited non-zero}"
  fi
done
