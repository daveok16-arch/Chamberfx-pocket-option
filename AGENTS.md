# Pocket Option OTC Trade Bot — Layered Capture + Execution

## Purpose
Foundational live-price capture engine for Pocket Option OTC pairs, overlaid
with a clean strategy → risk → execution pipeline. Streams real-time ticks and
builds candles from the broker's Socket.IO WebSocket, then lets a pluggable
strategy propose trades that are hard-gated by a risk layer and (in paper mode
by default) recorded locally by an execution layer. The previous signal engine
was deliberately removed (2026-08-27) to make room for this architecture.

## Layered trading pipeline
Decisions and safety are separated into three layers, wired in `trade-bot.ts`:

- `price-bot/strategy.ts` -- STRATEGY layer. The ONLY place that decides
  direction (`'call' | 'put'`). `Strategy.evaluate(ctx, asset)` proposes a
  trade from ticks + candles. Pluggable. Active: `MultiAssetReversionStrategy`
  (multi-asset, small-stake range-reversion — volatility filter + rejection-wick
  anatomy, skips hard trends). Reference `CandleDirectionStrategy` retained as a
  template. Swap by editing `trade-bot.ts`.
- `price-bot/risk.ts` -- RISK layer. `RiskManager` hard-gates every proposal:
  per-trade stake cap, per-asset cooldown, rolling-24h loss stop, max
  concurrent positions, price sanity. Never decides direction.
- `price-bot/execution.ts` -- EXECUTION layer. `ExecutionEngine` raises the
  broker `42["openOrder",{...}]` message over the bot's authenticated WS.
  Defaults to PAPER mode (records locally, nothing over the wire).

## SAFETY MODEL (critical)
- The bot runs in PAPER mode by default and never sends a real order.
- To arm real-money execution, BOTH must hold:
  1. `ALLOW_LIVE=1` env var is set, AND
  2. the authenticated session is a non-demo account (the executor checks
     `bot.isDemoMode()`, so a demo session always falls back to paper even if
     `ALLOW_LIVE=1`).
- Hard defaults in `trade-bot.ts`: stake cap $5/trade, 3-min cooldown per
  asset, $50 rolling-24h loss stop, max 3 concurrent positions.
- `risk-smoke-test.ts` validates these gates (`npm run test:risk`).

## Architecture
- `price-bot/server.ts` -- verified live price-capture engine.
  Playwright discovers the Pocket Option Socket.IO WS, captures the auth packet,
  subscribes to OTC assets, and streams ticks + builds candles.
  Exports `PocketOptionPriceBot` with multi-listener callbacks
  (onTick/onCandle/onConnect/onDisconnect/onError/...).
  `getCandles(assetId)`, `getPrice(assetId)`, `getTicks(assetId)`,
  `getAssetList()`, `getServerTime()`, `send(message)` (raw Socket.IO send),
  `isDemoMode()` for consumers. Self-contained `main()` (capture-only) runs
  when executed directly.
- `price-bot/trade-bot.ts` -- entrypoint wiring strategy → risk → execution
  into the live feed + a `/health` HTTP server for Render.
- `Dockerfile` (repo ROOT) -- Render deploys Docker from the root. Base
  `mcr.microsoft.com/playwright` (Node + chromium). Runs
  `tsx trade-bot.ts`. Exposes port 10000, HEALTHCHECK on `/health`.
- `render.yaml` (root) -- Render blueprint: `web` service, `env: docker`,
  `healthCheckPath: /health`, `PERIOD` env var (60|180|300).
- `price-bot/package.json` -- scripts: `start`/`render:start` → trade-bot.ts,
  `capture` → server.ts capture main, `test:risk` → risk-smoke-test.ts,
  `typecheck`/`build` (tsc), `postinstall` → playwright install chromium.

## Build / Run
```
cd price-bot
npm install
npx playwright install chromium
npx tsc --noEmit                  # typecheck (must be exit 0)
npx tsx risk-smoke-test.ts        # safety-gate self-check (npm run test:risk)
npx tsx trade-bot.ts              # PAPER mode, 1m candles
npx tsx trade-bot.ts --period 180 # (or PERIOD=180)
ALLOW_LIVE=1 npx tsx trade-bot.ts # real money — ONLY if intended
npx tsx server.ts                 # capture-only demo main
```

## Data interfaces (consumed from server.ts)
- `Tick {assetId,price,timestamp,direction}`
- `Candle {assetId,open,high,low,close,volume,openTime,closeTime}`
- `AssetInfo {id,name,payout,active,lastPrice,ticks,candles}`

## Capture-engine notes (still valid)
- **Clock skew:** candle `openTime`/`closeTime` come from Pocket Option's server
  clock (embedded in tick timestamps), ~2h ahead of container `Date.now()`.
  Any timing math (e.g. expiry resolution) must use the candle array's openTime,
  NOT `Date.now()`.
- Reconnect re-seeds are deduped by `openTime` (Set) and sorted before
  trimming, so a reconnect can't corrupt the candle stream.
- `candlePeriod` config controls tick->candle aggregation and the same period
  is used for the `changeSymbol` subscription.

## Signals (output)
- Every executed trade is appended to `signals.jsonl` (gitignored: one JSON
  object per line: `{type, asset, direction, price, amount, duration, mode, source, timestamp, serverTime}`)
- Optional delivery when env vars set: `SIGNAL_WEBHOOK_URL` (POST JSON), or
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (Telegram markdown message.

- `/health` endpoint exposes `signals` count (when the log exists.



## Status
- Live capture verified: 6 OTC pairs, real auth, ticks streaming, candles
  building.
- Signal engine (signal.ts / signal-bot.ts / telegram.ts / accuracy-test.ts /
  engine-smoke-test.ts) deleted 2026-08-27. Replaced by the layered
  strategy/risk/execution pipeline above (PAPER-mode by default).
- `server.ts` gained `send()` and `isDemoMode()` for the execution layer.
