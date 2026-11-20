#!/usr/bin/env bash
# Build the automation tarball.
#
# The tarball must stay under the 1 MB upload limit, and it carries the trained
# model and the labelled dataset because the automation sandbox offers no
# writable persistence between runs (see README.md).
#
#   ./build.sh          # build automation.tar.gz
#   ./build.sh upload   # build, upload, and repoint the automation
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd .. && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/state"
cp runner/run_bot.py "$STAGE/"

if [ ! -f "$REPO_ROOT/inference/model.pkl" ]; then
  echo "error: missing inference/model.pkl — train a model first" >&2
  exit 1
fi
cp "$REPO_ROOT/inference/model.pkl" "$STAGE/state/"

# The dataset only feeds an optional in-run retrain (the shipped model is what
# serves predictions), so keep the most recent rows rather than the whole file.
# It grows every minute, and the upload limit is 1 MB.
if [ -f "$REPO_ROOT/price-bot/signals.json" ]; then
  python3 - "$REPO_ROOT/price-bot/signals.json" "$STAGE/state/signals.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
rows = json.load(open(src))
rows.sort(key=lambda r: r.get("entryAt", 0))
kept = rows[-1500:]
json.dump(kept, open(dst, "w"))
print(f"dataset: {len(rows)} rows -> shipped most recent {len(kept)}")
PY
fi

tar -czf automation.tar.gz -C "$STAGE" .

size=$(stat -c%s automation.tar.gz)
printf 'built automation.tar.gz: %.2f MB (limit 1.00 MB)\n' "$(echo "$size" | awk '{print $1/1048576}')"
if [ "$size" -gt 1048576 ]; then
  echo "error: tarball exceeds the 1 MB upload limit; trim signals.json" >&2
  exit 1
fi

if [ "${1:-}" = "upload" ]; then
  : "${OPENHANDS_API_KEY:?OPENHANDS_API_KEY must be set}"
  : "${AUTOMATION_ID:?AUTOMATION_ID must be set}"
  host="${OPENHANDS_HOST:-https://app.all-hands.dev}"
  tp=$(curl -sS -X POST "$host/api/automation/v1/uploads?name=otc-bot-runner" \
        -H "Authorization: Bearer $OPENHANDS_API_KEY" \
        -H "Content-Type: application/gzip" \
        --data-binary @automation.tar.gz \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["tarball_path"])')
  curl -sS -X PATCH "$host/api/automation/v1/$AUTOMATION_ID" \
    -H "Authorization: Bearer $OPENHANDS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"tarball_path\": \"$tp\"}" > /dev/null
  echo "repointed automation $AUTOMATION_ID at $tp"
fi
