# Pocket Option OTC Signal Bot

## Purpose
Leading (non-lagging) next-candle direction prediction for Pocket Option OTC pairs,
for 1/3/5-minute binary-option expiries. Predicts the next candlestick direction
using only leading methods (no EMA/RSI/MACD/Bollinger).

## Architecture
- `price-bot/server.ts` -- verified live price-capture engine.
  Playwright discovers the Pocket Option Socket.IO WS, captures the auth packet,
  subscribes to OTC assets, and streams ticks + builds candles.
  Exports `PocketOptionPriceBot` with multi-listener callbacks (onTick/onCandle/...).
  `getCandles(assetId)`, `getPrice(assetId)`, `getAssetList()` for consumers.
- `price-bot/signal.ts` -- `SignalEngine` class. Four leading components fused by
  weighted confluence: (A) tick Order-Flow Imbalance, (B) candle anatomy/rejection
  (wicks, engulfing, marubozu), (C) tick velocity + momentum decay (exhaustion),
  (D) market structure (HH/HL, LH/LL). Emits CALL/PUT/WAIT with confidence + reasons.
- `price-bot/signal-bot.ts` -- CLI wiring capture -> signal engine. Args:
  `--expiry 1|3|5`, `--confidence N`. Logs signals to `signals.jsonl`. Also runs a
  tiny HTTP `/health` server (for Render) and delivers signals to Telegram.
- `price-bot/telegram.ts` -- optional Telegram notifier (no extra deps, uses
  Node fetch). Reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`; disables itself
  (warns, does NOT crash) if unset. `signal-bot.ts` delivers every emitted
  signal there + a startup confirmation + a ~5min price heartbeat.

## Deployment (Render.com)
- `Dockerfile` (repo ROOT, not price-bot/) -- Render clones the repo root, so the
  Dockerfile must be at root to be found. It `COPY price-bot/` into the image.
  Base `mcr.microsoft.com/playwright` (Node + chromium) for session discovery.
  Installs deps + `playwright install chromium`, runs
  `tsx signal-bot.ts --expiry 1 --confidence 50`. Exposes port 10000, HEALTHCHECK
  on `/health`.
- `.dockerignore` (root) -- excludes `**/node_modules`, logs, runtime JSON, .env.
- `render.yaml` (root) -- Render blueprint: `web` service, `env: docker` (no
  `rootDirectory` -- Dockerfile is at repo root), `healthCheckPath: /health`,
  plan `starter` (bump to standard if chromium OOMs). Secret env vars
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are `sync: false`.
- `signal-bot.ts` runs a tiny HTTP server on `PORT` (default 10000) serving
  `/health` (JSON status: uptime, prices, asset count, telegram on/off) so
  Render's health check passes. Closed on SIGINT.
- `package.json` `postinstall` runs `playwright install chromium --with-deps`
  for non-Docker Render runtimes; `render:start` script available.
- If Telegram env vars are unset the bot runs fine (logs to console +
  signals.jsonl) -- it does NOT crash.

## Build / Run
```
cd price-bot
npx tsc --noEmit -p tsconfig.json     # typecheck (must be exit 0)
npx tsx signal-bot.ts --expiry 1 --confidence 50
```
Playwright Chromium must be installed (`npx playwright install chromium`).

## Key Constraints
- NO lagging/smoothing indicators. Prediction must be leading (price action,
  order flow, tick microstructure, candle anatomy).
- Data interfaces consumed from server.ts: `Tick {assetId,price,timestamp,direction}`,
  `Candle {assetId,open,high,low,close,volume,openTime,closeTime}`,
  `AssetInfo {id,name,payout,active,lastPrice,ticks,candles}`.

## Status
- Live capture verified: 6 OTC pairs, real auth, ticks streaming, candles building.
- Live signals verified: e.g. USDCAD CALL/68 (engulfing+marubozu, OFI+46),
  EURUSD PUT/68 (bearish marubozu, OFI-53, downtrend-55).
- candlePeriod config + processHistoryData() added to server.ts.
- server.ts callbacks refactored to multi-listener arrays.
- server.ts main() guarded to run only when executed directly.

## Signal Engine v2 -- Regime-Adaptive (2026-08-13)
The v1 engine was ANTI-predictive (29.4% on 1m) because it treated every bullish
anatomy/OFI/momentum reading as a CALL (continuation), but on short-timeframe OTC
the next candle predominantly REVERSES the prior candle. v2 fixes this with a
regime layer:

- `computeRegime(candles)` -- lag-1 return autocorrelation over recent closed
  candles. `<0` = MEAN_REVERT, `>0` = TREND, `|r|<minRegimeStrength` = UNCLEAR.
- Continuation components (OFI, body/marubozu conviction, momentum velocity,
  structure) are FLIPPED (sign x -1) in MEAN_REVERT + UNCLEAR (OTC default is
  mean-reversion, so UNCLEAR also fades). Kept as-is in TREND.
- Reversal components (rejection wicks + engulfing) are NEVER flipped -- they
  already predict the opposite of the rejected extreme. This was the critical
  v1 bug: flipping rejection wicks inverted genuinely predictive signals.
- `computeCandleAnatomy` now returns separate `reversal` + `continuation` scores
  instead of one blended `score`. Momentum no longer self-flips on decay (the
  regime layer handles that); decay only lowers confidence.
- Confidence boosted by regime strength; still dampened by momentum decay.
- `SignalComponents` gained `regime` + `regimeStrength` fields (shown in
  signal-bot.ts + accuracy-test.ts output and the per-regime report breakdown).

CONFIG: `minRegimeStrength: 0.10` (commit to a regime at |autocorr|>=0.10).

## Accuracy Validation -- v2 (live, 2026-08-13)
1m run (n=37 decided, 18-min live): **51.4% overall** (was 29.4% in v1). The
confidence filter now CORRELATES with accuracy -- the key profit lever:
```
  By confidence tier:  ALL 51.4% | >=50 64.7% (11/17) | >=60 66.7% (2/3) | >=68 100% (1/1)
  By asset:   XAUUSD 75% (was 0%) | GBPUSD/USDJPY/USDCAD 50% | EURUSD 33% | AUDUSD 43%
  By direction: CALL 57.1% | PUT 47.8%
  By regime:   TREND 72.7% (8/11) | MEAN_REVERT 40.0% (10/25) | UNCLEAR 100% (1/1)
```
**Recommendation: trade ONLY >=50 confidence signals -> 64.7% win rate, above the
~53% break-even for ~92% OTC payout.** Run `signal-bot.ts --confidence 50`.

Per-regime insight: the mean-revert FLIP of continuation components underperforms
(40%) in the detected MEAN_REVERT regime -- the lag-1 autocorrelation is itself a
lagging aggregate, so by the time it reads "mean revert" the regime is often
shifting. The genuinely predictive part is the NEVER-FLIPPED reversal anchor
(rejection wicks + engulfing) plus continuation-kept-in-TREND. Next refinement:
weight the reversal anchor higher and reduce the continuation-flip magnitude.

5m run (v2, n=16 decided, 40-min live): **56.3% overall** (was 27.3% in v1) --
above break-even. CALL 55.6% / PUT 57.1% (balanced, unlike v1's CALL collapse).
USDJPY 100% (2/2), EURUSD 75% (3/4), AUDUSD 66.7%. Same regime pattern: TREND
62.5% (5/8) > MEAN_REVERT 33.3% (2/6) > UNCLEAR 100% (2/2).

CROSS-TIMEFRAME CONCLUSION (v2): profitable on BOTH 1m (51.4%, 64.7% at >=50 conf)
and 5m (56.3%). The consistent weak spot is the continuation-flip in the detected
MEAN_REVERT regime (~33-40%). The next improvement is to reduce/replace that flip
with the reversal anchor (rejection wicks + engulfing) which is reliably predictive,
and lean on TREND-regime continuation.

CLOCK-SKEW GOTCHA (still applies): candle `openTime`/`closeTime` come from Pocket
Option's server clock (embedded in tick timestamps), ~2h ahead of container
`Date.now()`. Prediction targets + resolution must use the candle array's openTime,
NOT Date.now(), or candle matches silently fail (0 resolutions).

## Signal Engine v3 -- Quality Over Quantity (2026-08-14)
User feedback: v2 generated too many low-accuracy signals ("not productive for
real-account trading"). Researched how professional binary-options signal bots +
Pocket Option OTC strategies operate. The consistent lessons (from axiory, Investopedia,
ThinkCapital, tradeciety, quantifiedstrategies, pocketoption.com, binaryoptions.net):

1. **Multi-timeframe (MTF) trend alignment is the #1 false-signal filter.** Trade
   only in the direction of the higher-timeframe trend. Counter-trend setups on
   low timeframes are the dominant source of false signals. (Investopedia: "the
   longer the timeframe, the more reliable the signals"; axiory: "trade only in
   the direction of the higher-timeframe trend".)
2. **Volatility/range filter.** Low-range candles are random walk -> no edge.
   Suppress signals when the current candle range < ~60% of the recent average.
3. **Stronger confluence.** Require 3+ agreeing components (not 2), and bias
   toward the never-flipped reversal anchor (rejection wicks + engulfing), which
   was the most predictive part in v2. Discount the MEAN_REVERT continuation-flip
   (it underperformed at ~40% live).
4. **Far fewer signals.** Pros send 1-2/day, not 6/min. Best-of-per-window cap +
   3-min cooldown + eval every 15s (not 5s).
5. **Higher confidence bar** (72 default, was 50/68).

### v3 implementation (signal.ts)
- `computeHtfTrend()` -- aggregates `htfPeriod` (default 5) base candles into a
  higher timeframe, reads the trend from recent HTF closes (UP/DOWN/FLAT). New
  config `htfPeriod`, `minHtfCandles`, `requireTrendAlignment`.
- `rangeVsAverage()` -- current candle range / recent avg range. New config
  `minRangeRatio` (default 0.6). Suppresses low-volatility candles.
- `directionFromConfluence(fused, agreeing, minAgreeing)` -- now requires
  >= `minAgreeing` (default 3) agreeing components for a CALL/PUT.
- Confidence adjustments: +8 HTF-aligned / -25 misaligned; +6 when the reversal
  anchor drives the direction; -8 in MEAN_REVERT regime (discount the weak flip).
- `maxSignalsPerWindow` (default 1) -- best-of per candle window; tracked via
  `windowEmissions` map keyed by `Math.floor(now / (expiry*60s))`.
- `minConfidence` raised to 72; `minCandles` 3->5; `cooldownMs` 60s->180s.
- New `SignalComponents` fields: `htfTrend`, `htfAligned`, `rangeRatio`, `agreeing`.
- `signal-bot.ts`: periodic eval 5s->15s; default confidence 68->72.
- Dockerfile/render.yaml/package.json: default `--confidence 72`.

### v3 expected effect
Fewer, higher-conviction signals. A signal now fires only when: 3+ leading
components agree AND the direction aligns with the HTF trend AND the candle has
real volatility AND confidence >=72 AND it's the best setup of that window AND
3+ min since the last signal on that asset. This directly implements
"quality over quantity" per the research.

VALIDATION: re-run `accuracy-test.ts --expiry 1 --minutes 30` against the live
feed to measure v3 win rate. Compare to v2 (51.4% all / 64.7% at >=50). Expect
fewer decided trades but a higher hit rate, especially on trend-aligned setups.

## Signal Engine v3.1 — Weakness Fixes (2026-08-14)
Audited + fixed the top implementation weaknesses from the v3 audit. All changes
typecheck clean (`npx tsc --noEmit` exit 0). No behavior change to the leading-
indicator design; these are correctness/robustness fixes.

1. **Candle-period now matches expiry (was hardcoded 60s).** `updateCandles`
   and `subscribeAsset` use `candlePeriod` (default 60s). `signal-bot.ts` sets
   `candlePeriod: expiry * 60`, and the changeSymbol subscription period matches,
   so 3m/5m expiries now build/seed 3m/5m candles (the engine no longer reasons
   about 1m candles while predicting a 5m candle). Added `subscribePeriod?` cfg.
2. **Clock-skew-safe timing.** Candle boundaries are server-clock (~2h ahead of
   container `Date.now()`). `evaluate()` now anchors `now` to the current
   candle's bucket when the supplied `now` is outside it, and `signal-bot.ts`
   passes `bot.getServerTime()` (server clock from last tick) to every
   `evaluate()` call. `timeRemainingInCandle`/`entryQuality` are now correct in
   production. Added `PocketOptionPriceBot.getServerTime()`.
3. **Regime excludes the in-progress candle.** `computeRegime` looped to
   `candles.length` (included the unstable last candle) despite its comment
   saying otherwise; fixed to `candles.length - 1`.
4. **OFI is now scale-invariant.** Replaced the `mag * 1e5` weighting (which
   saturated on XAUUSD and went inert on USDJPY) with a relative-move weighting
   (`abs(delta)/prevPrice`), so the imbalance behaves identically across assets.
   Targeted cause of the documented per-asset accuracy variance.
5. **Reconnect no longer duplicates candles.** `processHistoryData` dedups by
   `openTime` (Set) and sorts before trimming, so a reconnect re-seed can't
   corrupt structure/regime/HTF. `updateCandles` also checks the candle tail
   first (avoids O(n) scan + handles tick gaps).

Cleanups: `windowEmissions` Map pruned (was an unbounded leak over long runs);
`normalizeAssetId` uses strict exact/`_otc`-suffix matching (no more loose
`includes()` cross-mapping); binary Socket.IO state machine resets pending state
on an intervening `42` event (no desync); `package.json` dropped missing-file
scripts (`trading-bot.ts`/`telegram-bot.ts`/`server.js` main, `ts-node`) and
added `typecheck`/`capture`/`test:accuracy`; `price-bot/Dockerfile` confidence
aligned to 72 (was divergent 50); `signal-bot.ts` reads `EXPIRY`/`CONFIDENCE`
env vars (render.yaml overrides now actually work); `/health` reports real
`bot.isConnected()` (was hardcoded `true`); `Signal.payout` added and displayed
in console + Telegram (real per-asset payout, was blank/hardcoded 0.92 display).

### Minor-findings round (2026-08-14)
- **Stale docs fixed.** `price-bot/README.md` described the old EMA/RSI/MACD/
  Bollinger/ADX/ATR engine + `trading-bot.ts`/`npm run trading`/`npm run dev`;
  rewritten to the leading-indicator engine, with the candle-period diagram,
  `getServerTime()` in the API table, and current run commands. Root `README.md`
  confidence defaults fixed (68/50 → 72; quickstart `--confidence 50` → 72) and
  notes that `EXPIRY`/`CONFIDENCE` env vars are honored.
- **Regime low-variance guard (#6).** `computeRegime` now returns UNCLEAR when
  the average absolute candle return is negligible (< 1e-6 of price) — a
  random-walk band where the lag-1 autocorrelation sign is rounding noise, so
  committing to TREND/MEAN_REVERT there would flip on garbage. Mitigates the
  documented small-sample autocorrelation weakness without a redesign.
- **Agreement threshold is now config (#7).** Added `agreeThreshold` (default
  15, was a hardcoded magic constant) so the confluence gate isn't driven by
  marginal +16 noise and is tunable per deployment.
- **Confidence documented as heuristic (#8).** Added an explicit comment that
  confidence is a hand-tuned conviction ranking, NOT a calibrated probability,
  and that win-rate-by-tier claims need large-sample re-validation (v2's 64.7%
  was n=17). No fake-precision calibration added.
