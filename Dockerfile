# Pocket Option OTC Signal Bot — Render.com deployment image
# =========================================================
# Root-level Dockerfile so Render (which clones the repo root) finds it.
# The app source lives in price-bot/.
#
# Build / run locally:
#   docker build -t chamberfx-signal-bot .
#   docker run -p 10000:10000 -e TELEGRAM_BOT_TOKEN=... -e TELEGRAM_CHAT_ID=... chamberfx-signal-bot

# Playwright's official base image ships Node + the Chromium binary + OS deps
# needed for headless Pocket Option session discovery.
FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

# Copy the price-bot app (Dockerfile lives at repo root, app in price-bot/)
COPY price-bot/package.json price-bot/package-lock.json* ./
RUN npm ci --omit=dev=false || npm install

# Install the chromium browser binary for the pinned Playwright version.
RUN npx playwright install chromium

# Copy application source
COPY price-bot/ ./

# TypeScript is executed via tsx at runtime (no build step required).
# Compile-check is available via: docker run --rm <image> npx tsc --noEmit

# Non-root user for safety
RUN useradd -m botuser && chown -R botuser:botuser /app
USER botuser

ENV NODE_ENV=production \
    PORT=10000

EXPOSE 10000

# Render health check hits /health on the exposed port.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://localhost:'+ (process.env.PORT||10000) +'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default: 1-minute expiry, trade only >=72 confidence, trend-aligned signals (v3 quality engine: fewer, higher-conviction signals).
# Override via Render env vars EXPIRY / CONFIDENCE if desired.
CMD ["npx", "tsx", "signal-bot.ts", "--expiry", "1", "--confidence", "72"]
