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
  strategy.ts          Feature/label collector + ML inference client
  predictor.ts         Prediction layer: baseline predictor + ML/fallback router
  signalFilter.ts      Signal quality filters + confidence guardrails
  deliverer.ts         Telegram signal delivery (batched per bucket, best-effort)
  capture.ts           Entrypoint: capture + collector + prediction + delivery
  tests/run.ts         Unit/integration test suite (npm test)
  tsconfig.json        TypeScript config
inference/
  app.py               FastAPI service: /predict /health /reload
  train.py             Trains model.pkl from signals.json (time-series validation)
  features.py          Shared feature contract (train + serve)
  model_bundle.py      Model artifact + optional Platt calibrator (kept only if it helps)
  requirements.txt     Python dependencies
  README.md            Inference service docs
Dockerfile             (repo root) Render.com deployment image (both services)
render.yaml            (repo root) Render blueprint (disk + env)
run.sh                 (repo root) local always-on supervisor (inference + capture + retrain)
deploy/
  supervisord.conf     Runs capture + inference + retrain in one container
  entrypoint.sh        Prepares the data dir, then execs supervisord
  retrain-loop.sh      Periodic train.py (no-op until the row floor is met)
.github/workflows/     CI: typecheck + tests + train smoke test
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

### Label horizon (`--horizon`)

`--period` sets the **candle** size. `--horizon` sets how far ahead the **label**
is measured — "will the price be higher in N seconds?" — and the two are
independent. The feature window stays 60s either way.

```bash
npx tsx capture.ts --horizon 180     # 3-minute label horizon
HORIZON=300 npx tsx capture.ts       # via env
```

A 60s horizon is dominated by microstructure noise: the price barely moves in a
minute, so the label is close to a coin flip no matter what the features say.
A 180s or 300s horizon gives a real move room to develop. This is the first
lever to pull when a model shows no edge — it changes the *problem*, not just
the model.

Training reads the horizon back out of the data (median of
`resolvedAt - entryAt`), so the purge always matches what the collector
actually produced. You do not need to tell `train.py` the horizon.

---

## Run it as a service (local)

Running the pipeline by hand means three processes that must all stay up: the
inference service, the capture engine, and the retrain loop. `run.sh` supervises
all three, restarts any that die, and holds a lock so a second invocation cannot
start a duplicate engine (two engines sharing one `signals.json` would
double-append every observation).

```bash
cd inference && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ../price-bot && npm install

cd ..
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... ./run.sh start
./run.sh status     # are inference and capture up?
./run.sh logs       # tail both logs
./run.sh stop       # graceful: the engine flushes labels on SIGTERM
./run.sh restart
```

Logs, pid files and the lock live under `run/` (gitignored). The supervisor
restarts a crashed child with a capped backoff (2s doubling to 30s), and the
engine reconnects to Pocket Option on its own. Set `RETRAIN_INTERVAL_SEC=0` to
disable the retrain loop.

This is the local counterpart to the container's `deploy/supervisord.conf`:
same three programs, same wiring, no Docker and no root.

---

## ML pipeline (Phases 1-3)

**Phase 1 — data collection** (`price-bot/strategy.ts`): turns the live feed into
a supervised-learning dataset. Proposes no trades.

**Phase 2 — training + inference** (`inference/`): a FastAPI service that fits a
RandomForestClassifier on the collected dataset and serves live probabilities.

**Phase 3 — signal quality filters** (`price-bot/signalFilter.ts`): gates each
raw prediction so only premium, high-confidence signals are surfaced.

**Prediction + delivery** (`price-bot/predictor.ts`, `price-bot/deliverer.ts`):
every closed window is scored, always. The ML service is preferred; a
deterministic local baseline answers when it is unavailable, so the bot predicts
continuously rather than only after a model exists. Signals that clear the
filters are delivered to Telegram (if configured). This is strictly a signal
generator — nothing executes trades.

```
price-bot/capture.ts                     inference/
   │  POST /predict {asset, features}        │
   └───────────────────────────────────────►├── app.py       FastAPI /predict
        │                                   ├── train.py     fits model.pkl
        ▼                                   ├── features.py  shared contract
   predictor.ts  (ML ──fallback──► baseline) └── model.pkl    weights (gitignored)
        │  [PREDICT] ... [ML]|[BASE]
        ▼
   signalFilter.ts  (confidence + volatility)
        │
        ├─ reject -> [SIGNAL_FILTER] Signal discarded: ...
        └─ accept -> [VALID_SIGNAL] {timestamp, asset, direction, confidence}
                        │
                        ▼
                 deliverer.ts -> Telegram (per-asset cooldown)
```

### Filter rules

| Rule | Threshold | Behaviour |
|---|---|---|
| `MIN_CONFIDENCE_THRESHOLD` | `0.65` | reject unless confidence ≥ 0.65 |
| `MAX_SPREAD_VOLATILITY_PCT` | `0.02` | reject when `(high-low)/open > 0.02` |
| No-Trade Zone | `P ∈ [0.36, 0.64]` | reject as ambiguous |

**Confidence means `max(P, 1-P)`**, not `P`. A model that is 90% sure of DOWN
reports `P(UP) = 0.10`; that is a *high*-confidence PUT, so its confidence is
0.90, not 0.10. Scoring it as 0.10 would discard the model's best calls and
keep its coin flips.

Both the confidence floor and the no-trade zone are applied, so the stricter
check always wins. The zone additionally rejects the thin slices `(0.35, 0.36)`
and `(0.64, 0.65)`.

A window rejected for volatility means its 60s range was abnormally wide —
usually news or illiquidity, where the feature distribution the model learned
no longer describes the current regime.

Accepted signals are printed as structured JSON and exposed on `/health` under
`validSignals`; a running `rejectedSignals` count is included alongside.

### Running it

```bash
# 1) inference service
cd inference && pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000

# 2) collector (with predictions + filtering enabled)
cd price-bot
INFERENCE_URL=http://localhost:8000 npx tsx capture.ts

# 3) train once enough rows exist
cd inference && python train.py --data ../price-bot/signals.json
```

`/predict` returns HTTP **503** until a model is trained — it never fabricates a
probability, and there is no 0.50 fallback. With `INFERENCE_URL` unset (or the
service down / model missing), the local baseline predictor answers instead, so
the bot keeps predicting — every prediction is tagged `[ML]` or `[BASE]` in the
log and on `/health`.

### Signal delivery (Telegram)

Delivery is off unless both credentials are set:

```bash
cd price-bot
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npx tsx capture.ts
```

- Only signals that pass the Phase 3 filters are delivered.
- **One message per 60s bucket, not one per asset.** Every asset is scored
  against the same wall-clock-aligned bucket, so all six cross the boundary in
  the same evaluate tick. Signals are held for `SIGNAL_BATCH_WINDOW_MS`
  (default 2000 = 2s) and flushed as a single message listing every asset that
  qualified, strongest first. Set it to `0` to send one message per signal.
  The cooldown is applied at flush time, so a batch contains only assets that
  were actually due. `/health` reports `telegram.sent` (messages) separately
  from `telegram.signals` (signals carried inside them).
- Per-asset cooldown (`SIGNAL_COOLDOWN_MS`, default 300000 = 5 min). The
  default is conservative: it assumes unbatched delivery, where a 6-asset
  every-minute cadence would be ~360 messages/hour. Batching already collapses
  each bucket to one message (<=60/hour), so a delivery-every-window deployment
  can set `SIGNAL_COOLDOWN_MS=0` and still send at most one message per minute.
  Left at the default, most qualifying windows are throttled rather than sent.
- Delivery is best-effort: failures are counted (`telegram.failed` on
  `/health`), never fatal to capture.
- Nothing here can place a trade — it is a notification path only.

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
`windowSpanSec`, `recentMomentumPct`.

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
One service runs the whole pipeline: the TypeScript capture/prediction engine, the
Python inference service, and a periodic retrain loop, all under supervisord.

### Option A — Blueprint (recommended)
1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → select the repo. Render reads `render.yaml` and creates the web service.
3. Deploy. Render builds the Docker image (root `./Dockerfile`), installs Playwright/chromium and the Python inference deps, and starts all processes. Health checks hit `/health` on port `10000`.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the dashboard to enable signal delivery (optional).

### Option B — Manual web service
1. **New → Web Service** → connect the repo.
2. **Runtime:** Docker. (Leave **Root Directory** empty — the Dockerfile is at the repo root.) **Dockerfile path:** `./Dockerfile`.
3. **Instance plan:** `standard` or higher (Playwright/chromium + scikit-learn need headroom; `starter` OOMs).
4. Add a **persistent disk** mounted at `/app/data` (1 GB is plenty). Without it, `autoDeploy` wipes the dataset on every push.
5. Deploy.

### What runs in the container

| Process | Purpose |
|---------|---------|
| `capture` | the TypeScript engine — ticks, features, labels, predictions, `/health` |
| `inference` | FastAPI model server (`/predict`, `/health`, `/reload`) on `127.0.0.1:8000` |
| `retrain` | re-runs `train.py` every `RETRAIN_INTERVAL_SEC`; a no-op until enough rows exist |

The engine talks to the model service over `INFERENCE_URL=http://127.0.0.1:8000`,
so predictions are `[ML]` once a model is trained and `[BASE]` (baseline) until then.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT`   | no (default 10000) | HTTP health server port (Render sets this) |
| `PERIOD` | no (default 60)   | Candle period in seconds: `60` \| `180` \| `300` |
| `HORIZON` | no (default 60)  | Label horizon in seconds: `60` \| `180` \| `300` |
| `SIGNALS_FILE` | no (default `/app/data/signals.json`) | labelled dataset — put it on the disk |
| `FEATURES_FILE` | no (default `/app/data/live-prices.json`) | live feature snapshot |
| `MODEL_FILE` | no (default `/app/data/model.pkl`) | trained model served by the inference service |
| `RETRAIN_INTERVAL_SEC` | no (default 1800) | retrain cadence |
| `TELEGRAM_BOT_TOKEN` | no | enables delivery when set with `TELEGRAM_CHAT_ID` |
| `TELEGRAM_CHAT_ID` | no | delivery target |
| `SIGNAL_COOLDOWN_MS` | no (default 300000) | per-asset delivery cooldown; `0` delivers every window |
| `SIGNAL_BATCH_WINDOW_MS` | no (default 2000) | gather a bucket's signals into one message; `0` sends one per signal |

---

## Tech stack

- **TypeScript** + **tsx** (runs `.ts` directly, no build step needed)
- **Playwright** (chromium) for Pocket Option session discovery
- **ws** for WebSocket

## License

MIT
