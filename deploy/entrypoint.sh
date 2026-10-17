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

exec /usr/bin/supervisord -c /app/deploy/supervisord.conf
