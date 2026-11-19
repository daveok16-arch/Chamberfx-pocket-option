#!/usr/bin/env bash
# Container entrypoint
# ====================
# Prepares the data directory, then hands off to supervisord, which owns the
# capture engine, the inference service, and the retrain loop.
#
# The mounted persistent disk (see render.yaml) arrives owned by root, but the
# programs run as `botuser`. Rather than force the whole app to run as root,
# only the data directory is chowned here.
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

# Best-effort: a disk mounted read-only, or an image built without the user,
# must not stop the container from starting.
chown -R botuser:botuser "$DATA_DIR" 2>/dev/null || \
  echo "[entrypoint] warning: could not chown ${DATA_DIR}; continuing"

# Seed an empty dataset so the collector's first read is well-formed rather
# than relying on its missing-file path.
if [ ! -f "${SIGNALS_FILE:-$DATA_DIR/signals.json}" ]; then
  echo '[]' > "${SIGNALS_FILE:-$DATA_DIR/signals.json}"
fi

# Bootstrap a model before anything starts. The engine has no baseline
# fallback, so a container that begins with no model would collect the first
# buckets without predicting. If a dataset already exists on the disk this
# trains one now; otherwise it is a harmless no-op and the retrain loop produces
# the model once enough data has accumulated (the service auto-reloads it).
MODEL="${MODEL_FILE:-$DATA_DIR/model.pkl}"
SIGNALS="${SIGNALS_FILE:-$DATA_DIR/signals.json}"
if [ ! -f "$MODEL" ] && [ -s "$SIGNALS" ]; then
  echo "[entrypoint] no model at ${MODEL} — attempting to train one now"
  if /app/venv/bin/python /app/inference/train.py \
      --data "$SIGNALS" --model "$MODEL" --refit-full; then
    chown botuser:botuser "$MODEL" 2>/dev/null || true
    echo "[entrypoint] trained model -> ${MODEL}"
  else
    echo "[entrypoint] not enough data to train yet; retrain loop will produce a model"
  fi
fi

exec /usr/bin/supervisord -c /app/deploy/supervisord.conf
