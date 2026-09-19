# Inference — live ML training + prediction service

A small Python service that trains a direction classifier on the collector's
supervised-learning dataset and serves live probabilities over HTTP. The
TypeScript engine (`price-bot/capture.ts`) POSTs each 60-second feature window
to `/predict` at the bucket boundary.

```
price-bot/capture.ts                     inference/
   │  POST /predict {asset, features}        │
   └───────────────────────────────────────►├── app.py        FastAPI: /predict /health /reload
                                            ├── train.py      fits model.pkl from signals.json
                                            ├── features.py   feature contract (shared)
                                            └── model.pkl     trained weights (gitignored)
```

## Setup

```bash
cd inference
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Train

Reads `signals.json` (override with `--data`) and writes `model.pkl`:

```bash
python train.py
python train.py --data ../price-bot/signals.json --model model.pkl
```

Training refuses to emit a model below **200 rows**, and warns that metrics
below **1000 rows** are noisy. This is deliberate: an under-fit model that
returns confident-looking probabilities from a few dozen rows is worse than no
model, because nothing downstream can tell the difference.

## Serve

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

| Env var | Default | Purpose |
|---|---|---|
| `MODEL_FILE` | `./model.pkl` | model path |
| `MODEL_AUTO_RELOAD` | `1` | re-read the model when the file changes on disk |
| `PREDICTION_THRESHOLD` | `0.5` | probability cut for direction 1 vs 0 |

### Endpoints

`POST /predict`
```bash
curl -s localhost:8000/predict -H 'Content-Type: application/json' -d '{
  "asset": "EURUSD_otc",
  "features": {"tickCount": 87, "open": 1.15124, "close": 1.15122,
               "high": 1.15134, "low": 1.15116, "netChange": -2e-5,
               "netChangePct": -1.7e-5, "range": 1.8e-4,
               "avgAbsDelta": 1.47e-5, "stdDev": 4.18e-5,
               "upRatio": 0.414, "windowSpanSec": 39.06,
               "momentum60s": -1.7e-5}
}'
```
```json
{"asset":"EURUSD_otc","probability":0.5421,"direction":1,
 "threshold":0.5,"model_mtime":1789864000.12,"feature_count":14}
```

`GET /health` — service + model state.
`POST /reload` — force a model reload.

## Feature contract (`features.py`)

The model's input vector is 14 columns, built identically for training and
serving so the two can never drift:

| Column | Notes |
|---|---|
| `tickCount` | |
| `netChangePct` | |
| `rangePct` | `range / open` |
| `avgAbsDeltaPct` | `avgAbsDelta / open` |
| `stdDevPct` | `stdDev / open` |
| `upRatio` | |
| `windowSpanSec` | |
| `momentum60s` | |
| `asset_*` | one-hot across the 6 OTC pairs |

**Raw price levels are deliberately excluded.** The pairs trade at wildly
different scales (XAUUSD ≈ 4340, AUDUSD ≈ 0.76), so passing raw magnitudes
would let the model recover asset identity from price level alone and split on
"which pair is this" rather than on market structure. Every magnitude feature
is divided by the window's `open`, making it scale-free.

## Wiring the TypeScript side

Set `INFERENCE_URL` and the engine starts scoring automatically:

```bash
cd price-bot
INFERENCE_URL=http://localhost:8000 npx tsx capture.ts
```

With `INFERENCE_URL` unset the collector runs standalone — no Python service
required, no predictions attempted.

| Env var | Default | Purpose |
|---|---|---|
| `INFERENCE_URL` | *(unset)* | base URL; predictions disabled when unset |
| `INFERENCE_TIMEOUT_MS` | `5000` | per-request timeout |

## Honest limitations

- **No model exists in this repo.** `model.pkl` is a build artifact and is
  gitignored. `/predict` returns HTTP 503 until you run `train.py`.
- **Predictions are not persisted and do not drive trades.** They are logged
  and surfaced on `/health`. Nothing consumes them yet.
- **The dataset is small by nature.** ~6 observations/minute across 6 assets;
  a usable model needs thousands of rows, i.e. many hours of collection.