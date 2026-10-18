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

# Resolve the interpreter and training script relative to this script so the
# loop works both in the container (/app) and from a local checkout.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${APP_ROOT:-$(dirname "$SELF_DIR")}"
PYTHON="${PYTHON:-$APP_ROOT/inference/.venv/bin/python}"
TRAIN="${TRAIN:-$APP_ROOT/inference/train.py}"

SIGNALS="${SIGNALS_FILE:-$APP_ROOT/price-bot/signals.json}"
MODEL="${MODEL_FILE:-$APP_ROOT/inference/model.pkl}"
INTERVAL="${RETRAIN_INTERVAL_SEC:-1800}"

log() { echo "[retrain] $*"; }

log "loop started (interval ${INTERVAL}s, data ${SIGNALS}, model ${MODEL})"

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
