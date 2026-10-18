# Pocket Option OTC — Live Price Capture & Direction Prediction

## Purpose
Live-price capture engine and direction predictor for Pocket Option OTC pairs.
Streams real-time ticks from the broker's Socket.IO WebSocket, builds candles,
collects a supervised-learning dataset, predicts a direction for every closed
60s window, and delivers the signals that clear the quality filters.

## No execution (critical)
This repo predicts and delivers; it does NOT trade:
- no risk gates, no staking, no position sizing
- no execution / order sending (the `openOrder` path was removed)
- no paper-trading mode

Delivery is a notification path only (Telegram, see `deliverer.ts`). Nothing
here can place an order. Any future execution path must be added deliberately,
with its own safety design.

`server.ts` no longer exposes `send()`, `isDemoMode()`, or
`setAuthPacketForTest()` — those existed only for the execution layer.

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
- `price-bot/predictor.ts` -- the prediction layer. `Predictor` interface with
  two implementations: `LocalPredictor` (deterministic baseline — trend +
  momentum + tick-imbalance, scaled by the window's own volatility; always
  answers, output clamped to [0.02, 0.98]) and `PredictionRouter` (prefers the
  ML service, falls back to the baseline when `INFERENCE_URL` is unset, the
  service is down, or no model is trained). Every prediction carries
  `source: 'ml' | 'local-baseline'`, so an ML answer is never confused with a
  baseline one. The baseline is a placeholder, NOT a claimed edge.
- `price-bot/deliverer.ts` -- `TelegramDeliverer`. Ships accepted signals to a
  Telegram chat when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set; inert
  otherwise. Per-asset cooldown (`SIGNAL_COOLDOWN_MS`, default 5 min) prevents
  the ~360 msg/hour a 6-asset every-minute cadence would otherwise produce.
  Sends are serialised; failures are counted, never fatal.
- `price-bot/capture.ts` -- entrypoint: capture + collector loop + prediction at
  bucket boundaries + Phase 3 filtering + delivery + `/health`. Writes
  `live-prices.json` (features) and `signals.json` (labels) every 15s and
  flushes on SIGINT or SIGTERM. Writes are atomic (temp file + rename).
  Every prediction is logged as `[PREDICT]`; accepted signals as
  `[VALID_SIGNAL]`; rejected ones as `[SIGNAL_FILTER] Signal discarded: ...`.
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
  Also carries `feature_names` (the training schema) so serving can refuse a
  renamed-feature model, not just a wrong-width one.
- `inference/test_app.py` -- `python -m unittest test_app`. The `/predict`
  contract: matching schema scores, a renamed feature 409s, a wrong width 409s,
  no model 503s. No HTTP client (the endpoint function is called directly with a
  stub model), so it adds no dependency.
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
  windowSpanSec, recentMomentumPct`. Written live to `live-prices.json`.
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

CI (`.github/workflows/ci.yml`) runs typecheck + `npm test` on Node, and on
Python: compile, the unit tests (`test_train.py` + `test_app.py`), then a train
smoke test on a synthetic dataset.

Inference env vars: `INFERENCE_URL` (unset = baseline predictor only),
`INFERENCE_TIMEOUT_MS` (5000), `MODEL_FILE` (./model.pkl),
`MODEL_AUTO_RELOAD` (1), `PREDICTION_THRESHOLD` (0.5).
Delivery env vars: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (both required to
enable delivery), `SIGNAL_COOLDOWN_MS` (300000).

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
  * Added `price-bot/tests/run.ts` (`npm test`, now 81 checks) and
    `.github/workflows/ci.yml`.
  * Verified: `tsc` exit 0, 81/81 checks pass, chronological + walk-forward
    training runs end-to-end, calibrated `model.pkl` serves through `app.py`
    (`/health`, `/predict`, `/reload`).
- **Always-on prediction + delivery implemented 2026-10-16** (`predictor.ts`,
  `deliverer.ts`). This is the change that makes it a *prediction* bot rather
  than a data collector:
  * Every closed 60s window is now scored, even with no trained model and no
    inference service. `LocalPredictor` (deterministic baseline) answers when
    the ML path is unavailable; `PredictionRouter` prefers the ML service and
    falls back automatically. Every prediction carries its `source`.
  * Every prediction is logged (`[PREDICT] ... [ML]|[BASE]`) and surfaced on
    `/health` (`predictionStats`, `predictor`). Accepted signals are delivered
    to Telegram when credentials are present.
  * Per-asset delivery cooldown (default 5 min) because a 6-asset
    every-minute cadence would otherwise send ~360 messages/hour.
  * Verified live: 18 windows scored, ML and fallback both exercised (6 `[ML]`
    then 12 `[BASE]` after the service was killed), Telegram 12 sent / 0 failed
    / 4 throttled. The bot never stopped predicting through an ML outage.
- **Inference wired into the deploy (one container) — 2026-10-16.** The Python
  model service is no longer a local-only extra. The root `Dockerfile` now
  installs Python + a venv with the inference deps, and `deploy/supervisord.conf`
  runs three programs in one Render service:
  * `capture`   — the TypeScript engine (`tsx capture.ts`)
  * `inference` — `uvicorn app:app` on `127.0.0.1:8000`
  * `retrain`   — `deploy/retrain-loop.sh`, re-running `train.py` on a schedule
  `INFERENCE_URL` is set to `http://127.0.0.1:8000` for the engine, so the
  deployed bot scores `[ML]` as soon as a model exists — no manual step.
  Verified by building the image and running it: supervisord brought all three
  programs up, the engine connected live, `/health` reported
  `ml+local-baseline-fallback`, the retrain loop trained a model from a seeded
  dataset, the service auto-reloaded it, and predictions flipped from `[BASE]`
  to `[ML]` with no restart.
- **Dataset + model now persist across deploys.** `render.yaml` attaches a 1 GB
  disk at `/app/data`, and `SIGNALS_FILE` / `FEATURES_FILE` / `MODEL_FILE` point
  there. Without this, `autoDeploy: true` wiped every collected label on each
  push. Verified: `docker stop` flushed 18 labels (exit 0), the files survived on
  the volume, and a restart resumed them ("resumed 18 label(s)").
- **Feature bugs fixed 2026-10-17 (both were real, both verified).**
  * `upRatio` divided UP ticks by the *total* tick count, but ~30% of ticks
    repeat the previous price (FLAT). The feature therefore sat near 0.365
    instead of ~0.5, reading as a permanent DOWN bias. It now divides by
    directional ticks only (`up / (up + down)`), and an all-FLAT window is the
    neutral 0.5 rather than 0. Live check after the fix: mean 0.509.
  * `momentum60s` was computed with the *identical* formula to `netChangePct`
    (`(close - open) / open`) — equal in 252/252 rows, so it was a duplicate
    column that only split feature importance. Worse, `predictor.ts` used it as
    `momentum60s / open / volScale`, which re-injected the raw price level that
    `features.py` exists to remove. It is now `recentMomentumPct` — the return
    over the recent half of the window — a genuinely different quantity.
  * The 252-row dataset collected before this fix carries the old schema and is
    archived at `price-bot/archive/signals-pre-featurefix.json`. It is not
    comparable to new data and must not be mixed with it.
- **`train.py` now prints a shuffled-label null control.** It refits the same
  feature set on permuted labels and reports the null AUC spread plus an
  empirical p-value, which is what makes a held-out AUC interpretable. Validated
  in both directions: on the real (pre-fix) data it reports INSIDE the null
  spread (real 0.5508 vs null [0.373, 0.613], p=0.40 → no signal), and on
  synthetic data with a planted relationship it reports ABOVE the spread
  (real 1.0000, p=0.000). It is a working test, not a rubber stamp.
- **Label horizon is now configurable (`--horizon` / `HORIZON`, 60|180|300).**
  Before this, `--period` changed only the candle engine and the collector was
  built without a `horizonMs`, so every label resolved at 60s regardless.
  `capture.ts` now passes it through and `/health` reports `labelHorizon`.
  `train.py` derives the purge horizon from the data (median of
  `resolvedAt - entryAt`), so a 180s dataset is purged over 180s. Without that,
  training rows in the 60-180s band before the test seam keep labels built from
  test-period prices — silent leakage that inflates the score. `test_train.py`
  (stdlib unittest, no new deps) pins it: a row one step before the seam is
  purged at 180s and kept at 60s; the test fails on the old constant purge.
  Rationale: a 60s horizon is dominated by microstructure noise, so the label
  is near a coin flip no matter what the features say. A longer horizon changes
  the problem, not just the model — it is the first lever to pull when there is
  no edge.
- **Horizon experiment (240 rows @ 180s, one 104-minute session):** the pooled
  walk-forward AUC rose to **0.612 vs a 60s 0.55**, and the pooled
  shuffled-label control put that **above** the null spread, p=0.015 (n_perm=200).
  The 60s horizon on the pre-change data showed no signal. Read: a longer horizon
  is the first place signal appears, which is consistent with 60s being mostly
  microstructure noise. **Do not treat this as an edge yet.** It is 240 rows from
  a single session on 6 correlated pairs, the AUC is weak, and the economic
  harness still reports the accepted-signal win-rate CI straddling break-even.
  Confirm on fresh out-of-sample data before any conclusion.
- **Why pool the walk-forward for the control:** the single-holdout control on
  the same data says p=0.367 (48 test rows — no power) while the pooled control
  says p=0.015. Same data, same model; only the number of test rows differs.
  When they disagree, the pooled number is the better read. `--permutations N`
  tunes the null resolution; each permutation is a full refit.
- **The pooled control is i.i.d., and that is a known weakness.** A label
  shuffle assumes observations are exchangeable, but consecutive overlapping
  windows are autocorrelated, so the shuffle destroys a structure the data
  actually has and can make the null too tight. So the walk-forward path prints
  a **second control**: a circular-shift (block) null that rotates the label
  series against the fixed predictions, preserving the autocorrelation. It
  reuses the predictions and needs no refits, so it is free. On the 180s data:
  real pooled AUC 0.618, i.i.d. p=0.001, block p=0.040 — the signal survives
  both, so it is not a shuffle artifact. Read them together: clearing the i.i.d.
  null alone is not enough; the block null is the stricter one. (Circular shift
  is the cheap block null; a full block-bootstrap would be stricter still.)
- **Overlapping labels at long horizons:** window=60s with horizon=180s means
  consecutive observations share 2/3 of their outcome window, so 240 rows are
  not 240 independent samples. The permutation null is built with the *same*
  overlap and folds, so the comparison stays like-for-like, but the effective
  sample size is well below 240.
- **Still missing:** no LICENSE file; retraining is time-based, not triggered by
  data growth. **The baseline remains a placeholder with no claimed edge. The
  pipeline has one weak, unconfirmed hint of signal at a 180s horizon and
  nothing more — validation is only as good as the data.**
- **The deployed model used to be fit on a subset of the data.** The retrain
  loop called `train.py` without `--walk-forward`, which takes the holdout
  branch and saves the model fit on `fit_idx` — 80% of `train_idx`, i.e. ~67% of
  all rows. Nothing documented that. `--refit-full` (now passed by the retrain
  loop) refits the forest on all of `train_idx` after evaluation, so deployment
  uses ~80% of rows while the reported metrics stay exactly the same (they still
  come from the held-out fit). The calibrator is reused, not refit: refitting it
  on rows the forest had already seen would fit an in-sample isotonic map, which
  is over-confident — the exact failure the calibrator exists to prevent. Test
  pins the artifact: the saved model's first tree sees more rows with the flag.
