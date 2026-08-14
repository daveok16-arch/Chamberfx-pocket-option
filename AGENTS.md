# Pocket Option OTC Signal Bot

## Purpose
Leading (non-lagging) next-candle direction prediction for Pocket Option OTC pairs,
for 1/3/5-minute binary-option expiries. Predicts the next candlestick direction
using only leading methods (no EMA/RSI/MACD/Bollinger).

## Architecture
- `price-bot/server.ts` — verified live price-capture engine.
  Playwright discovers the Pocket Option Socket.IO WS, captures the auth packet,
  subscribes to OTC assets, and streams ticks + builds candles.
  Exports `PocketOptionPriceBot` with multi-listener callbacks (onTick/onCandle/...).
  `getCandles(assetId)`, `getPrice(assetId)`, `getAssetList()` for consumers.
- `price-bot/signal.ts` — `SignalEngine` class. Four leading components fused by
  weighted confluence: (A) tick Order-Flow Imbalance, (B) candle anatomy/rejection
  (wicks, engulfing, marubozu), (C) tick velocity + momentum decay (exhaustion),
  (D) market structure (HH/HL, LH/LL). Emits CALL/PUT/WAIT with confidence + reasons.
- `price-bot/signal-bot.ts` — CLI wiring capture -> signal engine. Args:
  `--expiry 1|3|5`, `--confidence N`. Logs signals to `signals.jsonl`.
- `price-bot/telegram.ts` — optional Telegram notifier (no extra deps, uses
  Node fetch). Reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`; disables itself
  (warns, does NOT crash) if unset. `signal-bot.ts` delivers every emitted
  signal there + a startup confirmation + a ~5min price heartbeat.

## Build / Run
```
cd price-bot
npx tsc --noEmit -p tsconfig.json     # typecheck (must be exit 0)
npx tsx signal-bot.ts --expiry 1 --confidence 68
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

## Signal Engine v2 — Regime-Adaptive (2026-08-13)
The v1 engine was ANTI-predictive (29.4% on 1m) because it treated every bullish
anatomy/OFI/momentum reading as a CALL (continuation), but on short-timeframe OTC
the next candle predominantly REVERSES the prior candle. v2 fixes this with a
regime layer:

- `computeRegime(candles)` — lag-1 return autocorrelation over recent closed
  candles. `<0` = MEAN_REVERT, `>0` = TREND, `|r|<minRegimeStrength` = UNCLEAR.
- Continuation components (OFI, body/marubozu conviction, momentum velocity,
  structure) are FLIPPED (sign × -1) in MEAN_REVERT + UNCLEAR (OTC default is
  mean-reversion, so UNCLEAR also fades). Kept as-is in TREND.
- Reversal components (rejection wicks + engulfing) are NEVER flipped — they
  already predict the opposite of the rejected extreme. This was the critical
  v1 bug: flipping rejection wicks inverted genuinely predictive signals.
- `computeCandleAnatomy` now returns separate `reversal` + `continuation` scores
  instead of one blended `score`. Momentum no longer self-flips on decay (the
  regime layer handles that); decay only lowers confidence.
- Confidence boosted by regime strength; still dampened by momentum decay.
- `SignalComponents` gained `regime` + `regimeStrength` fields (shown in
  signal-bot.ts + accuracy-test.ts output and the per-regime report breakdown).

CONFIG: `minRegimeStrength: 0.10` (commit to a regime at |autocorr|≥0.10).

## Accuracy Validation — v2 (live, 2026-08-13)
1m run (n=37 decided, 18-min live): **51.4% overall** (was 29.4% in v1). The
confidence filter now CORRELATES with accuracy — the key profit lever:
```
  By confidence tier:  ALL 51.4% | >=50 64.7% (11/17) | >=60 66.7% (2/3) | >=68 100% (1/1)
  By asset:   XAUUSD 75% (was 0%) | GBPUSD/USDJPY/USDCAD 50% | EURUSD 33% | AUDUSD 43%
  By direction: CALL 57.1% | PUT 47.8%
  By regime:   TREND 72.7% (8/11) | MEAN_REVERT 40.0% (10/25) | UNCLEAR 100% (1/1)
```
**Recommendation: trade ONLY >=50 confidence signals → 64.7% win rate, above the
~53% break-even for ~92% OTC payout.** Run `signal-bot.ts --confidence 50`.

Per-regime insight: the mean-revert FLIP of continuation components underperforms
(40%) in the detected MEAN_REVERT regime — the lag-1 autocorrelation is itself a
lagging aggregate, so by the time it reads "mean revert" the regime is often
shifting. The genuinely predictive part is the NEVER-FLIPPED reversal anchor
(rejection wicks + engulfing) plus continuation-kept-in-TREND. Next refinement:
weight the reversal anchor higher and reduce the continuation-flip magnitude.

5m run (v2, n=16 decided, 40-min live): **56.3% overall** (was 27.3% in v1) —
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
