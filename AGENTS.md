# Pocket Option OTC — Live Price Capture

## Purpose
Foundational live-price capture engine for Pocket Option OTC pairs. Streams
real-time ticks and builds candles from the broker's Socket.IO WebSocket. This
repo is intentionally market-data ONLY: the strategy, risk, execution, signal,
and paper-trading layers were all removed (2026-09-19) so an AI/ML prediction
pipeline can be built on a clean slate.

## No trading logic (critical)
There is NO decision or order code in this repo:
- no strategy / direction selection
- no risk gates
- no execution / order sending (the `openOrder` path was removed)
- no paper-trading mode, no `signals.jsonl`, no webhook/Telegram delivery

`server.ts` no longer exposes `send()`, `isDemoMode()`, or
`setAuthPacketForTest()` — those existed only for the execution layer. Any
future execution path must be added deliberately, with its own safety design.

## Architecture
- `price-bot/server.ts` -- verified live price-capture engine.
  Playwright discovers the Pocket Option Socket.IO WS, captures the auth packet,
  subscribes to OTC assets, and streams ticks + builds candles.
  Exports `PocketOptionPriceBot` with multi-listener callbacks
  (onTick/onCandle/onConnect/onDisconnect/onError/...).
  `getCandles(assetId)`, `getPrice(assetId)`, `getTicks(assetId)`,
  `getPrices()`, `getAssetList()`, `getTickHistory(assetId)` (Tick[] with
  timestamp+direction), `getServerTime()`, `isConnected()`,
  `savePricesToFile()`. Self-contained `main()` (capture-only) runs when
  executed directly.
- `price-bot/strategy.ts` -- PHASE 1 feature/label collector. Defines the
  `Strategy` contract (`evaluate(ctx, asset)`) plus `FeatureLabelCollector`,
  which consumes the feed and emits a supervised-learning dataset. It NEVER
  proposes a trade (always returns null). No ML/model code exists yet.
- `price-bot/capture.ts` -- entrypoint: capture + collector loop + `/health`
  HTTP server for Render. Writes `live-prices.json` (features) and
  `signals.json` (labels) every 15s and flushes on SIGINT.
- `Dockerfile` (repo ROOT) -- Render deploys Docker from the root. Base
  `mcr.microsoft.com/playwright` (Node + chromium). Runs
  `tsx capture.ts`. Exposes port 10000, HEALTHCHECK on `/health`.
- `render.yaml` (root) -- Render blueprint: `web` service, `env: docker`,
  `healthCheckPath: /health`, `PERIOD` env var (60|180|300).
- `price-bot/package.json` -- scripts: `start`/`render:start`/`capture` →
  capture.ts, `typecheck`/`build` (tsc), `postinstall` → playwright install.

## Phase 1: feature/label collector (implemented)
No ML code exists yet. `strategy.ts` collects the supervised-learning dataset:

- **Feature window:** trailing 60s per asset. Fields: `tickCount, open, close,
  high, low, netChange, netChangePct, range, avgAbsDelta, stdDev, upRatio,
  windowSpanSec, momentum60s`. Written live to `live-prices.json`.
- **Label:** the price 60s later vs the entry price. `label` is binary
  (1 = UP, 0 = DOWN); ties (delta === 0) resolve to 0. Appended to
  `signals.json` as `{type:'OBSERVATION', asset, entryAt, entryPrice,
  resolvedAt, expirationPrice, delta, label, outcome, features, source}`.
- **One observation per asset per aligned 60s bucket** (`entryAt = now` when
  armed). The bucket boundary is a dedup key only — without it the 1s evaluate
  loop would arm ~60 observations/min/asset and oversample one window.
- **Windows with <50% tick coverage are skipped** (`minCoverage`), so
  post-reconnect partial windows never produce junk labels. Surfaced as
  `skipped=` in the `[COLLECT]` log.
- Features slide continuously within the bucket; arming happens once per
  bucket, so `windowSpanSec` is typically ~59s rather than exactly 60s.
- Dedup of the overlapping `ctx.ticks` snapshots is by `(timestamp, price)`.

## Build / Run
```
cd price-bot
npm install
npx playwright install chromium
npx tsc --noEmit                  # typecheck (must be exit 0)
npx tsx capture.ts                # live capture, 1m candles + /health
npx tsx capture.ts --period 180   # (or PERIOD=180)
npx tsx server.ts                 # engine's own demo main
```

## Data interfaces (from server.ts)
- `Tick {assetId,price,timestamp,direction}`
- `Candle {assetId,open,high,low,close,volume,openTime,closeTime}`
- `AssetInfo {id,name,payout,active,lastPrice,lastTickTime,ticks,candles}`

## Capture-engine notes
- **Clock skew:** candle `openTime`/`closeTime` come from Pocket Option's server
  clock (embedded in tick timestamps), ~2h ahead of container `Date.now()`.
  Any timing math (feature windows, label horizons) must use the candle array's
  openTime or `bot.getServerTime()`, NOT `Date.now()`.
- Reconnect re-seeds are deduped by `openTime` (Set) and sorted before
  trimming, so a reconnect can't corrupt the candle stream.
- `candlePeriod` config controls tick->candle aggregation and the same period
  is used for the `changeSymbol` subscription.
- `/health` exposes `status`, `uptime`, `connected`, `assets`, live `prices`,
  and `candlePeriod`.



## Status
- Live capture verified: 6 OTC pairs, real auth, ticks streaming, candles
  building; `/health` reporting live prices.
- Signal engine (signal.ts / signal-bot.ts / telegram.ts / accuracy-test.ts /
  engine-smoke-test.ts) deleted 2026-08-27.
- Strategy/risk/execution/paper layers (strategy.ts, risk.ts, execution.ts,
  trade-bot.ts, risk-smoke-test.ts) and the signal-output path (SIGNALS_FILE,
  webhook/Telegram, signals.jsonl) deleted 2026-09-19. Capture is now the whole
  repo; an AI/ML predictor will be added on top of it deliberately.
- `server.ts` shed the execution-only `send()`, `isDemoMode()`, and
  `setAuthPacketForTest()` helpers.
- **Phase 1 (feature/label collector) implemented 2026-09-19** in
  `strategy.ts`, wired through `capture.ts`. Emits `live-prices.json`
  (real-time 60s features) and `signals.json` (binary labels resolved 60s
  later). Verified live: 1 observation per asset per 60s bucket, ~120 ticks
  per window, balanced label split. No ML/model code yet — that is Phase 2.
