# Pocket Option OTC — deployment image (Render.com)
# =================================================
# Root-level Dockerfile so Render (which clones the repo root) finds it.
# The capture app source lives in price-bot/; the Python model service in
# inference/.
#
# This image runs BOTH halves of the pipeline in one container:
#   - the TypeScript capture/prediction engine  (Node + Chromium)
#   - the FastAPI inference service             (Python + scikit-learn)
# managed by supervisord, so INFERENCE_URL is a constant and there is a single
# Render service to deploy.
#
# Build / run locally:
#   docker build -t chamberfx-capture .
#   docker run -p 10000:10000 chamberfx-capture
#
# Playwright's official base image ships Node + the Chromium binary + OS deps
# needed for headless Pocket Option session discovery. It is Ubuntu-based, so
# apt is available for Python.
FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

# Python for the inference service. Ubuntu's system Python is PEP-668 managed,
# so the service gets its own venv rather than --break-system-packages.
# `supervisor` owns process lifecycle; `tini` reaps zombies and forwards
# signals so a container stop reaches supervisord cleanly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip supervisor tini \
    && rm -rf /var/lib/apt/lists/*

# --- Node app dependencies -------------------------------------------------
COPY price-bot/package.json price-bot/package-lock.json* ./
RUN npm ci --omit=dev=false || npm install

# Install the chromium browser binary for the pinned Playwright version.
RUN npx playwright install chromium

# --- Python inference service ---------------------------------------------
# Copied before the app source so dependency installs stay cached across
# source-only changes.
COPY inference/requirements.txt /app/inference/requirements.txt
RUN python3 -m venv /app/venv \
    && /app/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /app/venv/bin/pip install --no-cache-dir -r /app/inference/requirements.txt

# --- Application source ----------------------------------------------------
COPY price-bot/ ./
COPY inference/ /app/inference/
COPY deploy/ /app/deploy/

RUN chmod +x /app/deploy/entrypoint.sh /app/deploy/retrain-loop.sh

# Non-root user for the app processes (supervisord itself runs as root only to
# chown the mounted data disk — see deploy/entrypoint.sh).
RUN useradd -m botuser && chown -R botuser:botuser /app

# Defaults. Every %(ENV_...)s reference in deploy/supervisord.conf must resolve,
# so these are set here even when Render overrides them.
#   MODEL_FILE / SIGNALS_FILE / FEATURES_FILE live on the persistent disk so the
#   dataset and model survive redeploys (autoDeploy rebuilds otherwise wipe them).
# No secrets here: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are supplied at runtime
# and passed through by supervisord.
ENV NODE_ENV=production \
    PORT=10000 \
    PERIOD=60 \
    HORIZON=60 \
    DATA_DIR=/app/data \
    MODEL_FILE=/app/data/model.pkl \
    SIGNALS_FILE=/app/data/signals.json \
    FEATURES_FILE=/app/data/live-prices.json \
    RETRAIN_INTERVAL_SEC=1800

# Render health check hits /health on the exposed port (served by the engine).
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://localhost:'+ (process.env.PORT||10000) +'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 10000

# tini forwards signals to supervisord, which stops the capture engine with
# SIGTERM so it can flush labels before exit.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
