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
- `price-bot/predictor.ts` -- the prediction layer, ML-only. `Predictor`
  interface; `MlPredictor` wraps the inference client and tags every result
  `source: 'ml'`; `PredictionRouter` forwards to it and returns null when no
  model is served. There is **no baseline fallback**: a missing model (no
  `INFERENCE_URL`, service down, 503 untrained) means the window is not
  predicted. The engine then runs COLLECT-ONLY — it keeps building the dataset
  but emits no predictions, signals or deliveries. A placeholder's guesses are
  never shipped to a chat.
- `price-bot/deliverer.ts` -- `TelegramDeliverer`. Ships accepted signals to a
  Telegram chat when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set; inert
  otherwise. Signals are gathered over `SIGNAL_BATCH_WINDOW_MS` (default 2s) and
  sent as ONE message per bucket (`formatBatch`), because every asset is scored
  against the same wall-clock-aligned bucket and would otherwise burst into six
  separate messages for a single market moment. Per-asset cooldown
  (`SIGNAL_COOLDOWN_MS`, default 5 min) is applied at flush time. That default
  predates batching: it was sized for the ~360 msg/hour an unbatched 6-asset
  every-minute cadence would produce. With batching the ceiling is one message
  per bucket (<=60/hour), so a deployment that must deliver *every* window sets
  `SIGNAL_COOLDOWN_MS=0`; at the default most windows are throttled away.
  `telegram.sent` counts messages; `telegram.signals` counts signals inside them.
  Sends are serialised; failures are counted, never fatal. Shutdown drains the
  pending batch before exit.
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
  walk-forward (`--walk-forward --folds N`), fits a Platt (sigmoid) CALIBRATION map on
  a purged slice, and prints an ECONOMIC harness (post-filter win rate + Wilson
  95% CI vs the `--payout` break-even). Shuffled splits were removed because
  autocorrelated overlapping windows leak across the boundary.
- `inference/model_bundle.py` -- `CalibratedModel`, the artifact written to
  `model.pkl`: the forest plus its optional probability calibrator. Lives in its own
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

Inference env vars: `INFERENCE_URL` (unset = COLLECT-ONLY, no predictions),
`INFERENCE_TIMEOUT_MS` (5000), `MODEL_FILE` (./model.pkl),
`MODEL_AUTO_RELOAD` (1), `PREDICTION_THRESHOLD` (0.5).
Delivery env vars: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (both required to
enable delivery), `SIGNAL_COOLDOWN_MS` (300000), `SIGNAL_BATCH_WINDOW_MS`
(2000; 0 = one message per signal).

Local supervisor: `run.sh start|stop|status|logs|restart` runs the inference
service, the capture engine and the retrain loop together with a PID lock and
restart-on-crash. Logs/pids live in `run/` (gitignored). This is the local
counterpart to `deploy/supervisord.conf`.

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
    an embargo), supports expanding-window walk-forward, fits Platt (sigmoid)
    calibration on a purged slice, and prints an economic harness (post-filter
    win rate + Wilson CI vs payout break-even). On random data it now reports
    "inconclusive" instead of a spuriously confident number.
  * Added `price-bot/tests/run.ts` (`npm test`, now 81 checks) and
    `.github/workflows/ci.yml`.
  * Verified: `tsc` exit 0, 81/81 checks pass, chronological + walk-forward
    training runs end-to-end, calibrated `model.pkl` serves through `app.py`
    (`/health`, `/predict`, `/reload`).
- **Always-on prediction + delivery implemented 2026-10-16** (`predictor.ts`,
  `deliverer.ts`), **revised to ML-only (baseline removed)** — see the dated
  entry below. The engine predicts every closed window through the model; when
  no model is served it collects only.
  * Every prediction is logged (`[PREDICT] ... [ML]`) and surfaced on
    `/health` (`predictionStats`, `predictor`). Accepted signals are delivered
    to Telegram when credentials are present.
  * Per-asset delivery cooldown (default 5 min) because a 6-asset
    every-minute cadence would otherwise send ~360 messages/hour.
- **Inference wired into the deploy (one container) — 2026-10-16.** The Python
  model service is no longer a local-only extra. The root `Dockerfile` now
  installs Python + a venv with the inference deps, and `deploy/supervisord.conf`
  runs three programs in one Render service:
  * `capture`   — the TypeScript engine (`tsx capture.ts`)
  * `inference` — `uvicorn app:app` on `127.0.0.1:8000`
  * `retrain`   — `deploy/retrain-loop.sh`, re-running `train.py` on a schedule
  `INFERENCE_URL` is set to `http://127.0.0.1:8000` for the engine, so the
  deployed bot scores `[ML]` as soon as a model exists — no manual step. The
  retrain loop attempts a train immediately on start, and `deploy/entrypoint.sh`
  bootstrap-trains from an existing dataset before supervisord comes up.
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
  data growth. **The pipeline has one weak, unconfirmed hint of signal at a 180s
  horizon and nothing more — validation is only as good as the data.**
- **The deployed model used to be fit on a subset of the data.** The retrain
  loop called `train.py` without `--walk-forward`, which takes the holdout
  branch and saves the model fit on `fit_idx` — 80% of `train_idx`, i.e. ~67% of
  all rows. Nothing documented that. `--refit-full` (now passed by the retrain
  loop) refits the forest on all of `train_idx` after evaluation, so deployment
  uses ~80% of rows while the reported metrics stay exactly the same (they still
  come from the held-out fit). The calibrator is reused, not refit: refitting it
  on rows the forest had already seen would fit an in-sample calibration map, which
  is over-confident — the exact failure the calibrator exists to prevent. Test
  pins the artifact: the saved model's first tree sees more rows with the flag.
- **Isotonic calibration was replaced by Platt (sigmoid) — found by running the
  bot, not by reading it.** Live logs showed `[PREDICT] XAUUSD_otc P(UP)=1.0000`
  — exact certainty out of a weak model. Cause: isotonic regression is
  non-parametric, and on the ~30–35-row calibration slices this dataset
  produces it steps straight to exactly 0.0 or 1.0. On a 180s holdout it
  collapsed 48 distinct raw probabilities into 5 values, emitted exact 0/1 for
  18/48 windows, and inflated the share of windows clearing the 0.65 confidence
  gate from 9/48 to 30/48 — a 3.3× over-emission of "confident" signals, with
  Brier 0.3015 and log-loss 5.69 (vs 0.2413 / 0.6751 raw). Platt has two
  parameters, so the map is smooth, monotone, and strictly inside (0,1): Brier
  0.2485, AUC unchanged at 0.6017, and `P(UP)=1.0000` no longer appears. This is
  the concrete failure the "the gate reads probability magnitude, not just
  ranking" note was warning about — a miscalibrated map does not merely look
  bad, it mints full-confidence signals. `PlattCalibrator` lives in
  `model_bundle.py` (same unpickling reason as `CalibratedModel`);
  `TestCalibratorDoesNotSaturate` pins the open-unit-interval, monotonicity, and
  pickle round-trip properties.
- **Operating note:** a `model.pkl` written with a new class cannot be hot-loaded
  by a *running* uvicorn that predates that class — `MODEL_AUTO_RELOAD` fails
  with `Can't get attribute 'PlattCalibrator'`. Restart the inference service
  once after deploying a new calibrator class; auto-reload then works normally.
- **Operating note:** the collector's horizon must match the dataset. Running at
  `HORIZON=60` against a file of 180s labels appends mixed-horizon rows, and
  `train.py` refuses the file (by design). Keep `HORIZON` aligned with the
  existing `signals.json`.
- **Brier alone is not a sufficient guard — the gate can be silenced while
  Brier improves (2026-11-20).** `_calibrator_improves_brier` accepted a Platt
  map that compressed served probabilities to `[0.4178, 0.4711]`, so **0 of
  1578 rows** could clear the 0.65 gate. The engine ran, `/health` reported
  `connected: true`, and it was mathematically incapable of ever emitting a
  signal, while `train.py` printed the map as an improvement. Cause: Brier is
  minimised by predicting the base rate, so squashing every score toward ~0.5
  scores *better* than a model that actually discriminates — the guard was
  rewarding the exact failure it exists to prevent. `_preserves_signal_range`
  now requires the mapped scores to reach the gate. It deliberately does not
  compare raw-vs-mapped reachability: when the raw slice is itself too weak to
  reach the gate that comparison is vacuous and a collapsing map slips through
  (the first version of the fix had that hole, and the end-to-end test caught
  it). Verified: the guard rejects the exact calibrator that was live, the
  retrained model serves raw probabilities, and the live service now spans
  `0.34..0.63` with 3/120 rows clearing the gate.
- **Calibration is now gated on whether it actually helps — the Platt map alone
  reintroduced silence.** Switching isotonic → Platt removed the 0/1 saturation
  but not the underlying failure mode: Platt is a monotone *squashing* map, and
  on a weak model with ~64 calibration rows it compressed the entire raw range
  `[0,1]` into `[0.404, 0.538]` — fully inside the no-trade zone `[0.36, 0.64]`.
  The engine could then never emit a signal, no matter how strong the input,
  while every prediction still looked plausible (`P≈0.45`). The forest's raw
  scores spanned `[0.284, 0.790]` and *did* clear the gate, so the calibrator was
  strictly harmful. Measured out-of-fold, it also did not improve Brier
  (0.2598 vs 0.2411 raw). `_calibrator_improves_brier` now decides with an
  honest two-fold check inside the calibration slice and `_fit_calibrated`
  returns `(model, calibrator_or_None, note)`; a map that fails to beat raw
  Brier is dropped and the model serves raw probabilities. This is deliberately
  conservative: a map that does not help is worse than none, because the
  downstream filter reads magnitude. `TestCalibratorIsRejectedWhenItHurts` pins
  both directions, including a regression that the *served* probability range
  can reach the confidence gate at all — the silence bug is invisible to every
  metric that only measures ranking.
- **Lesson:** AUC is blind to this whole class of bug. Both the isotonic
  saturation and the Platt compression left AUC untouched while making the
  engine emit false certainty and then nothing. Any change to the probability
  scale must be checked against the gate that consumes it, not just against
  ranking metrics.
- **Signal delivery batches per bucket (2026-10-16).** The bucket boundary is
  `floor(serverTime / windowMs)` — wall-clock aligned — and every asset is
  evaluated in the same `collectAll()` tick against the same `serverTime`. So all
  six cross the boundary within ~1ms of each other and, when several cleared the
  filter, `capture.ts` called `deliverer.send()` once per asset. The chat
  received a burst of separate messages for a single market moment. Fixed by
  buffering accepted signals for `SIGNAL_BATCH_WINDOW_MS` (default 2s) and
  flushing them as one `formatBatch` message, strongest confidence first, with a
  per-signal line and a single shared `source:`. The per-asset cooldown is now
  applied at flush time so a batch reports only assets that were due; `sent`
  counts messages and the new `signals` counter counts what they carried.
  `SIGNAL_BATCH_WINDOW_MS=0` restores per-signal sends. Shutdown drains the
  buffer (time-bounded) so the final bucket is not dropped.
- **Local always-on supervisor (2026-10-16).** `run.sh` runs inference + capture
  + retrain with a PID lock (two engines sharing one `signals.json` would
  double-append every observation) and restart-on-crash with a capped backoff.
  It is the local counterpart to `deploy/supervisord.conf`. `retrain-loop.sh`
  now resolves its interpreter, `train.py`, dataset and model relative to its own
  location instead of hardcoding `/app/...`, so the same script works in the
  container and from a checkout. **The interpreter is the subtle one:** the image
  builds its venv at `/app/venv` (sibling of the source) while a checkout keeps it
  at `inference/.venv`, so the loop probes both and exits loudly if neither
  exists. Guessing wrong is silent — the loop logs "not trained yet" forever and
  the deployed model never updates.
- **A calibrator can invert the model (2026-10-16).** The Platt guard checked
  Brier improvement but not the *sign* of the slope. On a calibration slice whose
  raw scores were by chance anti-correlated with the labels, the out-of-fold
  check fitted a map with a negative slope and — correctly, in Brier terms —
  found it improved the score. Inverting a useless ranking does score better than
  the ranking itself. That map was persisted and served: correlation with the
  label went from **+0.34 to −0.34**, the whole probability range collapsed to
  `[0.3996, 0.4502]`, and **0 of 882 rows** could clear the 0.65 gate. Same
  silence bug as the isotonic/Platt compressions, through a third door, and
  invisible to Brier because Brier rewards the inversion. `_calibrator_improves_brier`
  now skips halves whose fitted slope is non-positive, and `_fit_calibrated`
  refuses a non-positive slope on the final map. **The tell is arithmetic:** a
  monotone *increasing* map leaves ranking (and AUC) unchanged, so
  `AUC_raw + AUC_calibrated ≈ 1.0` proves the map is decreasing. That is how this
  was caught — the eval printed raw `roc_auc 0.4830` beside calibrated `0.5170`.
- **`model.pkl` is written atomically (2026-10-16).** `train.py` wrote it with a
  plain `joblib.dump` while the inference service reloads it on mtime change, so
  a reload landing mid-write could raise on a torn pickle. Now a temp file plus
  `os.replace`, matching the engine's own atomic-write convention. The temp file
  is chmod'd to 0644 because `mkstemp` creates 0600.

## Deployment (Render) — verified 2026-10-18

Service `Chamberfx-pocket-option` (`srv-dbacaftg1s2s73bivrt0`), owner
`tea-db9333c9v7es73ecareg`. Deploys Docker from repo root, `main` branch.

- **`main` is the deploy branch and `autoDeploy` did not fire for a plain push.**
  The live deploys were both API-triggered (`POST /v1/services/<id>/deploys`).
  After pushing to `main`, check the deploy list rather than assuming; if no new
  deploy appears, trigger one explicitly.
- **`git push origin main` pushes the local `main` ref, not HEAD.** When the
  work is on a feature branch, use `git push origin HEAD:main` or the push is
  rejected as non-fast-forward.
- **The service runs on the `free` plan with no disk**, though `render.yaml`
  declares `standard` + a 1GB disk. Read the service back
  (`GET /v1/services/<id>`) rather than trusting the blueprint. Free plan means:
  spin-down when idle (capture stops, breaking "continuously"), no persistence
  (`signals.json` / `model.pkl` wiped per deploy), and 512MB (Chromium OOM risk).
  Moving to a paid plan is a billing decision and was deliberately left to the
  operator.
- **`healthCheckPath` was empty** and is now `/health`, so Render actually
  health-checks the service.
- **Env vars were entirely unset** on the service (the blueprint's values had
  never been applied). Set via `PUT /v1/services/<id>/env-vars`: `PORT`,
  `PERIOD`, `HORIZON`, `DATA_DIR`, `SIGNALS_FILE`, `FEATURES_FILE`, `MODEL_FILE`,
  `RETRAIN_INTERVAL_SEC`, `SIGNAL_COOLDOWN_MS`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`. Secrets are stored server-side and never echoed back.
- **Live verification (2026-10-18):** `connected: true`, 6 assets,
  `predictionStats.total` climbing, `telegram.sent` climbing at one message per
  minute with `failed: 0` and `throttled: 0`. A labeled test message reached the
  target chat. At that time no model had been trained on the deployed instance,
  so `/predict` answered 503 and the local baseline answered; that fallback has
  since been removed (see below).
- **`SIGNAL_COOLDOWN_MS=0` on the deployed service.** At the 300000 default the
  live run showed `sent 4 / throttled 43`; at `0` it is one message per 60s
  window with zero throttling. Batching already caps delivery at 60 msgs/hour, so
  the cooldown's original flood rationale no longer holds.

### The silent stall: connected but no ticks (fixed 2026-10-18)

Observed live: `[STATUS] ticks=1686` frozen for ~4.5 minutes across several
reconnects while `/health` reported `connected: true` and candles stayed at 3
per asset. The bot looked healthy and delivered nothing.

**Cause.** `connect()` re-ran `discoverSession()` on every reconnect and
overwrote the cached credentials unconditionally. Discovery waits a fixed 8s
for the page to emit its auth frame, and that frame does not always arrive in
time, so rediscovery often returns `authPacket: ""`. Adopting that cleared the
last known-good packet, and the reconnect logged the tell:

```
[WS] No auth packet, subscribing directly...
```

The socket then opens, joins the namespace, and subscribes — all of which
succeed and set `connected = true` — but an unauthenticated session receives no
ticks. No close event fires either, so nothing schedules a recovery.

**Fixes.**
1. `adoptDiscoveredSession()` merges instead of overwriting: a field is only
   taken from discovery when discovery actually found it, so a failed
   rediscovery can no longer downgrade a working session.
2. A liveness watchdog (`livenessTimeoutMs`, default 90s) terminates the socket
   when it is open but has produced no tick for the timeout, which forces
   `handleClose` → `scheduleReconnect`. This catches the half-open state from
   any cause, not just this one. `hasStalled()` is split out so the decision is
   testable without a live socket; `lastTickWallClock` uses the container clock
   because the tick timestamps carry the broker's server clock.

The tell to grep for in production logs is `No auth packet, subscribing
directly` followed by a `ticks=` that stops increasing while `connected=true`.
14 checks added to `price-bot/tests/run.ts` (109 → 123).

### ML-only prediction: the baseline predictor was removed (2026-11-18)

The engine now predicts **only** from the trained model. The deterministic
`LocalPredictor` baseline is gone, and with it the `'local-baseline'` source and
the `[BASE]` log tag.

**Why.** A baseline that always answers keeps the pipeline "always predicting",
but those predictions are a placeholder with no claimed edge. Every one of them
had to clear the same confidence gate and the same AI analyst as a real model
prediction, so a weak-but-confident baseline window could reach the chat looking
exactly like a model signal. The requirement is that delivery is gated on the
model, so the fallback is removed rather than merely down-weighted.

**Behaviour now.**
- `MlPredictor` is the only predictor; `PredictionRouter` forwards to it and
  returns null when it cannot answer. A null means "no prediction for this
  window" — never a fallback.
- No model served (no `INFERENCE_URL`, service down, 503 untrained) ⇒
  **COLLECT-ONLY**: the engine keeps building `signals.json` and `live-prices.json`
  but emits no predictions, signals, or deliveries. `/health` still reports
  `predictionStats` (which stay at zero) and `predictor: 'none'`.
- The startup log states the mode: `active predictor: <name>` when the model is
  reachable, or `COLLECT-ONLY mode` when it is not.

**Setup/automation now guarantees a model.**
- `run.sh` preflight trains one from an existing dataset if `model.pkl` is
  missing, then `wait_for_model` blocks (bounded, 30s) until `/health` reports
  `model_loaded: true` before capture starts. A timeout is not fatal — capture
  starts anyway and the retrain loop's model is hot-reloaded.
- `deploy/retrain-loop.sh` attempts a train immediately on start (previously it
  slept a full interval first), so a fresh setup with data reaches ML-only
  quickly instead of collecting blindly for up to 30 minutes.
- `deploy/entrypoint.sh` bootstrap-trains in-container from the mounted dataset
  before supervisord starts.
- The retrain loop still runs on its interval; a model that appears later is
  picked up by `MODEL_AUTO_RELOAD` and capture begins predicting without a
  restart.

**Trade-off.** This is deliberately fail-closed. If the model cannot be served,
the bot is silent by design: no signal is better than an unverified one. The
cost is that a broken inference path produces no Telegram traffic at all, which
is the intended signal that something needs attention (see `/health` `predictor`
and `inference` stats).

Verified: `tsc` exit 0, 187/187 checks pass (the removed baseline tests are gone;
new tests pin that a missing model yields null, never a fabricated prediction).


## Supervision hardening — the bot can now recover itself (2026-11-19)

Observed live: the bot ran fine, then the host suspended at 02:15 and the
process tree was killed. It stayed dead until 09:55 — ~7.5 hours of no capture,
no predictions, no signals. The supervisor restarted crashed *children*, but
nothing restarted the *supervisor*, and there is no cron or systemd in this
environment (`PID 1` is `openhands-agent`), so nothing else was going to.

Three real bugs surfaced while fixing this. All three produced the same
symptom — two capture engines appending to one `signals.json` — and the first
two were invisible to the existing checks.

1. **`kill -0` succeeds on a ZOMBIE.** A hard-killed supervisor whose parent
   does not reap it becomes `<defunct>`, and `kill -0 <pid>` still returns 0.
   The stale pidfile therefore looked like a live supervisor forever.
   `pid_running()` now checks `ps -o stat=` and rejects state `Z`.
2. **`supervise` subshells inherited the lock (fd 9).** `supervise` runs as a
   background subshell, so it held `supervisor.lock`. The child command closed
   fd 9, but the loop itself did not — so after a `kill -9` the loop kept the
   lock and every restart failed with "another instance is already running".
   The loop now drops fd 9 immediately.
3. **Orphaned `supervise` loops kept respawning engines.** Those loops are
   children of the supervisor, so `kill -9` orphans rather than kills them. Each
   one then restarted its child, defeating any reaping. The loop now exits when
   its supervisor is gone (again via `pid_running`, not `kill -0`), and
   `reap_orphans()` kills leftover loops while holding the lock — safe, because
   holding the lock proves no other supervisor is live.

Also added: `reap_orphans()` runs on every start (orphans from a hard kill are
killed by process group, plus strays matched on command line *and* scoped to
this checkout), and a watchdog daemon.

**Watchdog.** `run.sh daemon` is a self-healing outer loop: if the supervisor
pid is absent, or `/health` fails three consecutive probes (~90s), it restarts
the stack detached via `setsid`. `./run.sh start-daemon` launches it;
`./run.sh stop-all` stops it *before* the supervisor, otherwise it immediately
restarts what was just stopped. `status` now reports the watchdog too.

**`boot.sh`** is the one-command entry point: starts the supervisor detached
(it supervises in the foreground, so calling it directly would block), then the
watchdog, with the project's live settings (`HORIZON=60`, `SIGNAL_COOLDOWN_MS=0`,
`RETRAIN_INTERVAL_SEC=600`). Secrets come from the environment and are never
written to disk.

Verified by `kill -9` of the supervisor: recovered in ~25s with a new supervisor
pid and exactly one capture and one uvicorn process (previously 2 capture
processes). `tsc` exit 0, 187/187 checks pass.

## Live run findings (2026-11-20)

**The engine rediscovered its session on every reconnect (fixed).**
`connect()` called `discoverSession()` whenever `config.wsUrl` was empty, and
`discoveredWsUrl` was written but never used as a reuse guard. Every reconnect
launched a headless Chromium to intercept a fresh auth packet. Observed live:
198 launches in a few minutes, after which the broker closed every socket
(`1005`) immediately after auth and the bot never recovered — `ticks` frozen,
candles stuck at 1 per asset, while `connected` flickered true. Discovery is now
skipped when a session that already worked is cached, and a session is
invalidated for exactly one rediscovery after three sockets die within 15s, so a
genuinely stale token still recovers instead of looping. 7 checks pin both
directions. The broker's block was temporary: after a ~7 minute cooldown a fresh
probe received ticks again.

**The bot now reports its own skill (`/health.skill`).** `predictionStats`
counted volume (total/ml/accepted/rejected), which cannot tell a working model
from a busy one. Every scored window is held until its label resolves and
matched on `(asset, entryAt)`; `/health` reports accuracy with a Wilson 95%
interval, accuracy per confidence band, and the accuracy of filter-accepted
windows against the 0.5208 break-even of a 0.92 payout. A confidence band that
does not rise with confidence is the tell that the gate is selecting noise.

**The AI journal records the exact `features` window the analyst judged.**
Previously an audit had to re-derive features from `signals.json` by joining on
`(asset, entryAt)`, which silently drops windows that never resolved.

**The model has no measurable edge at a 60s horizon, and 0 accepted signals is
correct behaviour, not a fault.** Walk-forward over 2,250 labelled windows:
pooled AUC **0.5117**, inside the i.i.d. null spread `[0.4815, 0.5209]`, and the
block (circular-shift) null gives **p=0.404**. Per-fold AUC ranged 0.474–0.579.
The single chronological holdout reported 0.4370, which is *below* the null
spread — noise on 440 rows, not a signal, and a reminder that one holdout is not
a result. Mean predicted probability sits at **0.496**, so `max(P,1-P) ≈ 0.50`
essentially never reaches the 0.65 confidence gate; the engine emitted 1 accepted
signal in 90 windows. Filter-accepted windows resolved 0/1. Live resolved
accuracy across 84 windows: **45.2%**, Wilson `[35.0%, 55.9%]`.

This is the honest state of the pipeline: the plumbing (capture → ML scoring →
filter → Gemini gate → Telegram) is verified end-to-end live, and the predictor
it carries has no demonstrated skill. The gate and the filter are therefore
doing their job by staying closed. Do not loosen the confidence threshold or the
no-trade zone to manufacture signals — that converts a working safety system into
a loss generator at a 0.92 payout, where break-even is 52.08%.

## Unattended operation

Two deployment paths exist. They are not equivalent.

- **`run.sh start`** — local supervisor: inference + capture + retrain loop, a
  PID lock (two engines sharing one `signals.json` would double-append), and a
  watchdog. Data persists on local disk. This is the path that runs
  *continuously* and accumulates the dataset.
- **`automation/`** — an OpenHands Automation (cron `0 */4 * * *`, 21-minute
  runs) that rebuilds the whole stack in a throwaway sandbox. See
  `automation/README.md`.

Automation constraints, probed from inside a real run rather than assumed:

- `/workspace/project` **does not persist** between runs, the KV store caps at
  ~10 KB (413 above), and `git push` from a run is refused ("authentication is
  not supported for Git operations") while the stored `GITHUB_TOKEN` returns
  401. So there is no writable place to carry a 2 MB dataset between runs.
  The runner therefore ships `model.pkl` plus the most recent 1500 labels inside
  the tarball and restores them at startup.
- The tarball limit is 1 MB. `automation/build.sh` enforces it and trims the
  dataset; rebuild it after retraining or the deployed model keeps serving the
  old weights.
- **There is a `daily_sandbox_limit`.** Six probe runs plus real runs exhausted
  it in one day, after which dispatches return `SKIPPED` with
  `kind: daily_sandbox_limit`. The 4-hourly schedule exists to stay under it.
- A run's logs die with its sandbox. The runner posts a per-run summary to
  Telegram (predictions / AI verdicts / delivery counts) and sends a
  `⚠️ OTC bot run FAILED` message with the failing phase, so a broken run is
  visible instead of silent.

**Verified on the automation path:** two runs completed the full 21-minute
window (21:37→21:58 and 22:00→22:21), the second fired by cron with no manual
dispatch, and a later 8-minute run completed end to end. **Not verified:**
whether ticks actually streamed inside those cloud sandboxes. The evidence died
with the sandbox, and the diagnostic runs that would have reported it through
the callback were blocked by the daily sandbox quota. Treat cloud-side capture as
unproven until a run reports non-zero `predictions.total` in its Telegram
summary.

**Verified on the local path (the stronger evidence):** 114 minutes continuous,
`connected: true`, 6 assets, 615 predictions all `source=ml`, 4 accepted by the
filter, Gemini analyzed 4 → 1 approved / 3 rejected, 1 Telegram message, 0
failures. The AI journal (`price-bot/ai-journal.jsonl`) holds 105 entries:
68 REJECT / 33 APPROVE overall, and for the 60 ML-sourced ones 49 REJECT /
11 APPROVE, with concrete cited conflicts (e.g. "net change is positive but the
prediction is PUT", "net change is exactly zero"). The gate is demonstrably
filtering, not rubber-stamping.
