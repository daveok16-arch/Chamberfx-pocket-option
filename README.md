# CHAMBERFX — Pocket Option OTC Live Price Capture

A TypeScript **market-data capture foundation** for Pocket Option OTC pairs. It
connects to the broker's live Socket.IO WebSocket, streams real-time ticks, and
builds candles — nothing more.

There is deliberately **no strategy, risk, execution, signal, or paper-trading
layer**. Those were removed on 2026-09-19 so the AI/ML prediction pipeline can
be built on a clean slate. What remains is a verified live feed plus a small
`/health` endpoint.

> ⚠️ This project streams live market data only. It places no orders and holds
> no trading logic. Any future execution path must be added deliberately.

---

## What it does

1. **Session discovery** — Uses Playwright (headless Chromium) to load Pocket Option and intercept the authenticated Socket.IO WebSocket URL, session cookies, and auth packet.
2. **Live capture** — Connects to that WebSocket, subscribes to 6 OTC pairs (EURUSD, GBPUSD, USDJPY, XAUUSD, AUDUSD, USDCAD), and streams real-time ticks.
3. **Candle building** — Aggregates ticks into OHLC candles on a configurable period (60/180/300s).
4. **Health endpoint** — A tiny HTTP server (`/health`) exposes connection state, live prices, and per-asset candle counts for Render.

---

## Repository layout

```
price-bot/
  server.ts            Live price-capture engine (Playwright + WebSocket)
  capture.ts           Entrypoint: starts capture + /health (no trading logic)
  tsconfig.json        TypeScript config
Dockerfile             (repo root) Render.com deployment image
render.yaml            (repo root) Render blueprint
```

---

## Quick start (local)

```bash
cd price-bot
npm install
npx playwright install chromium

# Start live capture (1-minute candles) + health server
npx tsx capture.ts

# 3-minute / 5-minute candles
npx tsx capture.ts --period 180
npx tsx capture.ts --period 300
```

CLI flags: `--period 60|180|300` (default 60). Also accepts the `PERIOD`
environment variable (used by Render):
```bash
PERIOD=180 npx tsx capture.ts
```

---

## Building the ML pipeline

The capture engine is the data source. Wrap it (or import `PocketOptionPriceBot`
from `server.ts`) and read the feed:

```ts
import { PocketOptionPriceBot } from './server.js';

const bot = new PocketOptionPriceBot({ candlePeriod: 60, /* ... */ });

bot.onCandle((candle) => {
  // closed candle: { assetId, open, high, low, close, volume, openTime, closeTime }
});

bot.onTick((tick) => {
  // { assetId, price, timestamp, direction }
});

await bot.connect();

// Pull-based access at any time:
const candles = bot.getCandles('EURUSD_otc'); // oldest first
const price = bot.getPrice('EURUSD_otc');
```

The rule-based strategy/risk/execution layers were removed on 2026-09-19. There
is no decision code in this repo anymore — add the predictor deliberately.

The engine also exposes `getTicks(assetId)`, `getAssetList()`, and
`getServerTime()` (Pocket Option's clock — ~2h ahead of `Date.now()` on this
host, so use it for any timing/window math). `live-prices.json` is written for
offline use.

---

## Deploy on Render.com

This repo is configured for Render via the `render.yaml` blueprint and a Dockerfile.

### Option A — Blueprint (recommended)
1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → select the repo. Render reads `render.yaml` and creates the web service.
3. Deploy. Render builds the Docker image (root `./Dockerfile`, app in `price-bot/`), installs Playwright/chromium, and starts the capture engine. Health checks hit `/health` on port `10000`.

### Option B — Manual web service
1. **New → Web Service** → connect the repo.
2. **Runtime:** Docker. (Leave **Root Directory** empty — the Dockerfile is at the repo root.) **Dockerfile path:** `./Dockerfile`.
3. **Instance plan:** `starter` or higher (Playwright/chromium needs ~1GB RAM — bump to `standard` if you see OOM).
4. Deploy.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT`   | no (default 10000) | HTTP health server port (Render sets this) |
| `PERIOD` | no (default 60)   | Candle period in seconds: `60` \| `180` \| `300` |

---

## Tech stack

- **TypeScript** + **tsx** (runs `.ts` directly, no build step needed)
- **Playwright** (chromium) for Pocket Option session discovery
- **ws** for WebSocket

## License

MIT
