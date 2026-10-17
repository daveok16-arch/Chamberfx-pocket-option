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
- `price-bot/strategy.ts` -- PHASE 1 feature/label collector + inference client.
  Defines the `Strategy` contract (`evaluate(ctx, asset)`), the
  `FeatureLabelCollector` (emits the supervised-learning dataset; never proposes
  a trade), and `InferenceClient` (POSTs feature windows to the Python service).
- `price-bot/signalFilter.ts` -- PHASE 3 signal quality filters. Pure, no side
  effects. `MIN_CONFIDENCE_THRESHOLD = 0.65`,
  `MAX_SPREAD_VOLATILITY_PCT = 0.02`, no-trade zone `P in [0.36, 0.64]`.
  `evaluateSignal(prediction, features)` returns an accepted `ValidSignal`
  (`{timestamp, asset, direction:'CALL'|'PUT', confidence}`) or a discard reason.
  Confidence is `max(P, 1-P)`.
- `price-bot/capture.ts` -- entrypoint: capture + collector loop + inference at
  bucket boundaries + Phase 3 filtering + `/health`. Writes `live-prices.json`
  (features) and `signals.json` (labels) every 15s and flushes on SIGINT or
  SIGTERM. Writes are atomic (temp file + rename). Accepted signals are logged
  as `[VALID_SIGNAL]` JSON; rejected ones as
  `[SIGNAL_FILTER] Signal discarded: ...`.
- `inference/app.py` -- PHASE 2 FastAPI service. `POST /predict` returns
  `{probability (0-1), direction (1|0)}`; `GET /health`; `POST /reload`. Returns
  HTTP 503 (never a fabricated probability) when no model is loaded.
- `inference/train.py` -- fits a RandomForestClassifier on `signals.json` and
  writes `model.pkl`. Refuses to train below 200 rows (`--min-rows` to override
  for smoke tests) and warns that metrics below 1000 rows are noisy.
  Validation is TIME-SERIES aware: it sorts by `entryAt`, splits
  chronologically, PURGES training rows whose 60s label horizon overlaps the
  test period (plus an `--embargo-ms` gap), optionally runs expanding-window
  walk-forward (`--walk-forward --folds N`), fits an isotonic CALIBRATION map on
  a purged slice, and prints an ECONOMIC harness (post-filter win rate + Wilson
  95% CI vs the `--payout` break-even). Shuffled splits were removed because
  autocorrelated overlapping windows leak across the boundary.
- `inference/model_bundle.py` -- `CalibratedModel`, the artifact written to
  `model.pkl`: the forest plus its optional isotonic calibrator. Lives in its own
  module (not `train.py`) so `joblib` can unpickle it in the serving process;
  exposes `n_features_in_`/`predict_proba` so `app.py` needs no special-casing.
- `price-bot/tests/run.ts` -- `npm test`. Zero-dependency harness covering the
  filter boundaries, candle/normalize/dedup behavior, and collector invariants
  (one arm per bucket, 60s horizon, resume-from-disk, monotonic bucket guard,
  `maxLabels`, malformed-input tolerance).
- `inference/features.py` -- shared feature contract (14 columns). Magnitudes
  are normalised by the window's `open` price; raw price levels are excluded so
  the model cannot split on asset identity.
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
- **Labels persist across restarts.** `FeatureLabelCollector` reads `signals.json`
  on construction, merges by `(asset, entryAt)`, and seeds the bucket guard, so a
  redeploy no longer truncates the dataset. In-memory labels are capped by
  `maxLabels` (default 200k), oldest dropped first. Corrupt/non-array files are
  logged and ignored rather than crashing capture.
- **Bucket arming is monotonic.** `evaluate()` only advances to a bucket strictly
  newer than the last one, so a server-clock reset (or a restart replaying a
  covered range) cannot re-arm an already-labelled bucket.
- **Writes are atomic.** `capture.ts` writes to `<file>.tmp` then renames, so a
  crash mid-write can never leave a truncated `signals.json`.
- **SIGTERM is handled.** Render/Docker stop containers with SIGTERM; the handler
  flushes features + labels before exit (SIGINT alone would lose up to 15s).

## Build / Run
```
cd price-bot
npm install
npx playwright install chromium
npx tsc --noEmit                  # typecheck (must be exit 0)
npm test                          # 57-check harness (filters, candles, collector)
npx tsx capture.ts                # live capture, 1m candles + /health
npx tsx capture.ts --period 180   # (or PERIOD=180)
npx tsx server.ts                 # engine's own demo main

cd ../inference
pip install -r requirements.txt
uvicorn app:app --port 8000                      # serve /predict
python train.py --data ../price-bot/signals.json # fit model.pkl (chronological holdout)
python train.py --data ../price-bot/signals.json --walk-forward --folds 5
```

CI (`.github/workflows/ci.yml`) runs typecheck + `npm test` on Node, and a
Python compile + train smoke test on a synthetic dataset.

Inference env vars: `INFERENCE_URL` (unset = collection-only, no predictions),
`INFERENCE_TIMEOUT_MS` (5000), `MODEL_FILE` (./model.pkl),
`MODEL_AUTO_RELOAD` (1), `PREDICTION_THRESHOLD` (0.5).

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
  per window, balanced label split.
- **Phase 2 (training + inference) implemented 2026-09-19** under `inference/`.
  FastAPI `/predict` scores each closed bucket; the TS engine POSTs the feature
  window at bucket boundaries when `INFERENCE_URL` is set. Verified end-to-end
  live: TS -> /predict -> true probability + direction. NO model is committed;
  `model.pkl` is gitignored and must be trained locally.
- **Predictions do not drive trades.** Nothing consumes them yet; they are
  logged and surfaced on `/health`. No execution/risk layer exists.
- **Phase 3 (signal quality filters) implemented 2026-09-19** in
  `signalFilter.ts`, wired into the `capture.ts` consumer loop. Rejections are
  normal operation. Verified with a 22-check harness covering the no-trade zone
  boundaries (0.36/0.64 inclusive), the volatility boundary (0.02 inclusive),
  direction mapping and the confidence symmetry `max(P, 1-P)`.
- **Durability + honest validation implemented 2026-10-17.**
  * Dataset survives restarts: the collector resumes `signals.json`, merges by
    `(asset, entryAt)`, caps memory via `maxLabels`, and arms buckets
    monotonically; `capture.ts` writes atomically and handles SIGTERM. Before
    this, `autoDeploy: true` silently wiped all collected labels on every push.
  * `train.py` no longer shuffles. It sorts by `entryAt`, splits
    chronologically, purges rows whose 60s horizon overlaps the test set (plus
    an embargo), supports expanding-window walk-forward, fits isotonic
    calibration on a purged slice, and prints an economic harness (post-filter
    win rate + Wilson CI vs payout break-even). On random data it now reports
    "inconclusive" instead of a spuriously confident number.
  * Added `price-bot/tests/run.ts` (`npm test`, 57 checks) and
    `.github/workflows/ci.yml`.
  * Verified: `tsc` exit 0, 57/57 checks pass, chronological + walk-forward
    training runs end-to-end, calibrated `model.pkl` serves through `app.py`
    (`/health`, `/predict`, `/reload`).
- **Still missing (deliberately out of scope for this pass):** `INFERENCE_URL`
  is not wired into any deploy config, so the deployed collector runs
  collection-only; `inference/` has no Dockerfile/service; no LICENSE file; the
  `momentum60s` feature duplicates `netChangePct`; no retrain scheduling.
  Validation results are still only as good as the data — the pipeline has no
  evidence of a real edge yet.
