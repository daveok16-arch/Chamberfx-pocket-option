# CHAMBERFX — Pocket Option OTC Trade Bot

A TypeScript trading bot for Pocket Option OTC binary options. It captures **live market prices** directly from Pocket Option via the Socket.IO WebSocket and pipelines them through a clean, layered **strategy → risk → execution** architecture. The previous signal engine was deliberately removed to make room for this new infrastructure.

> ⚠️ Trading disclaimer: This project is for educational/research purposes. Binary options trading carries significant risk. **The bot defaults to PAPER trading and never sends a real order** unless explicitly armed. Always validate strategies on a demo account before risking real money.

---

## What it does

1. **Live price capture** — Uses Playwright (headless Chromium) to discover and authenticate to Pocket Option's live Socket.IO WebSocket, then streams real-time OTC ticks for 6 pairs (EURUSD, GBPUSD, USDJPY, XAUUSD, AUDUSD, USDCAD) and builds candles.
2. **Strategy layer** (`strategy.ts`) — The *only* place that decides direction. A pluggable interface with a simple reference strategy; drop in your own.
3. **Risk layer** (`risk.ts`) — Hard safety gates: per-trade stake cap, cooldown, rolling 24h loss stop, max concurrent positions, price sanity.
4. **Execution layer** (`execution.ts`) — Raises the trade (`openOrder` protocol) over the authenticated WebSocket. **Defaults to PAPER mode.**
5. **Health endpoint** — A tiny HTTP server (`/health`) lets Render monitor the bot.

---

## Repository layout

```
price-bot/
  server.ts            Live price-capture engine (Playwright + WebSocket)
  strategy.ts          Strategy layer (pluggable decision engine)
  risk.ts              Risk layer (hard safety gates)
  execution.ts         Execution layer (paper/live openOrder)
  trade-bot.ts         Entrypoint: wires strategy → risk → execution + health
  risk-smoke-test.ts   Safety-gate self-check (npm run test:risk)
Dockerfile             (repo root) Render.com deployment image
render.yaml            (repo root) Render blueprint
```

---

## Quick start (local)

```bash
cd price-bot
npm install
npx playwright install chromium

# Run: 1-minute candles on the 6 default OTC assets
npx tsx trade-bot.ts

# 3-minute / 5-minute candles
npx tsx trade-bot.ts --period 180
npx tsx trade-bot.ts --period 300
```

CLI flags: `--period 60|180|300` (default 60). Also accepts the `PERIOD`
environment variable (used by Render):
```bash
PERIOD=180 npx tsx trade-bot.ts
```

---

## Building a strategy

Implement the `Strategy` interface in `price-bot/strategy.ts`:

```ts
import type { Strategy, StrategyContext, StrategySignal } from './strategy.js';

export class MyStrategy implements Strategy {
  readonly name = 'my-strategy';
  evaluate(ctx: StrategyContext, asset: string): StrategySignal | null {
    // ctx.candles  — closed candles, oldest first
    // ctx.price    — last known price
    // ctx.serverTime — Pocket Option's clock (not Date.now())
    // return { direction: 'call'|'put', amount, duration } or null to wait
  }
}
```

The active strategy is **`MultiAssetReversionStrategy`** — a multi-asset,
small-stake range-reversion approach across all 6 OTC pairs. It only acts on
the just-closed candle when it has real range (volatility filter) and carries a
rejection wick (leading candle-anatomy signal), and it skips assets in a hard
trend. Stake is small (`$1`/trade) and spread equally across assets. The
reference `CandleDirectionStrategy` is retained in `strategy.ts` as a template.
Swap strategies by editing `trade-bot.ts`.

### Safety / arming live

- By default the bot runs **PAPER** — every "trade" is recorded locally, and
  **no real order is sent**.
- To arm **real money**, set `ALLOW_LIVE=1`, and the executor additionally
  refuses to arm unless the authenticated session is a **non-demo** account.
- Risk defaults in `trade-bot.ts`: stake cap `$5`/trade, `3-min` cooldown per
  asset, `$50` rolling-24h loss stop, max `3` concurrent positions. Tune these
  in the `RiskManager` config.

The capture engine (`server.ts`) also exposes, per asset:
`getCandles(assetId)`, `getPrice(assetId)`, `getTicks(assetId)`,
`getAssetList()`, `getServerTime()`.

---

## Deploy on Render.com

This repo is configured for Render via the `render.yaml` blueprint and a Dockerfile.

### Option A — Blueprint (recommended)
1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → select the repo. Render reads `render.yaml` and creates the web service.
3. Deploy. Render builds the Docker image (root `./Dockerfile`, app in `price-bot/`), installs Playwright/chromium, and starts the bot. Health checks hit `/health` on port `10000`.

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
