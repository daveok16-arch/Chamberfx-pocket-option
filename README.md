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
  strategy.ts          Feature/label collector (Phase 1 data engine)
  capture.ts           Entrypoint: capture + collector + /health
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

Phase 1 (a feature/label collector) is implemented in `price-bot/strategy.ts`.
It turns the live feed into a supervised-learning dataset and proposes no
trades. Phase 2 (the model) has not been written yet.

### What the collector emits

| File | Contents |
|------|----------|
| `live-prices.json` | Real-time feature snapshot — the latest trailing 60s window per asset |
| `signals.json` | Completed, labelled observations — append-only array |

Each **observation** pairs a trailing 60-second feature window with the
outcome over the next 60 seconds:

```jsonc
{
  "type": "OBSERVATION",
  "asset": "EURUSD_otc",
  "entryAt": 1789863660010,        // server-clock ms; window/outcome boundary
  "entryPrice": 1.15122,
  "resolvedAt": 1789863720099,     // entryAt + 60s
  "expirationPrice": 1.15126,      // market price at expiration
  "delta": 0.00004,
  "label": 1,                      // 1 = UP, 0 = DOWN (ties -> 0)
  "outcome": "UP",
  "features": { /* trailing 60s state at entry */ },
  "source": "feature-label-collector"
}
```

Feature window fields: `tickCount`, `open`, `close`, `high`, `low`,
`netChange`, `netChangePct`, `range`, `avgAbsDelta`, `stdDev`, `upRatio`,
`windowSpanSec`, `momentum60s`.

### How it is wired

`capture.ts` drives the collector once per second per asset, passing the
engine's tick history and current price through the `Strategy` context:

```ts
const ctx: StrategyContext = {
  price: bot.getPrice(assetId),
  candles: bot.getCandles(assetId),
  ticks: bot.getTickHistory(assetId),
  serverTime: bot.getServerTime(),   // Pocket Option clock, never Date.now()
};
collector.evaluate(ctx, assetId);
```

### Behaviour worth knowing

- **One observation per asset per 60s bucket.** The bucket boundary is only a
  dedup key; without it the 1s evaluate loop would arm ~60 observations per
  minute per asset and oversample the same window.
- **Windows are skipped until ≥50% covered.** Right after (re)connect a window
  may hold only a tick or two; those are dropped rather than emitting a label
  built on a near-empty window (visible as `skipped=` in the logs).
- **Windows slide within the bucket.** Features are collected continuously, but
  arming happens once per bucket, so `windowSpanSec` is typically slightly
  under 60s.
- **Timing uses the server clock.** `entryAt`/`resolvedAt` come from
  `bot.getServerTime()` (Pocket Option's clock, ~2h ahead of `Date.now()`), so
  `resolvedAt - entryAt` is a true 60s.
- **Ties resolve to `0` (DOWN).** At-the-strike is not a win for a binary option.

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
