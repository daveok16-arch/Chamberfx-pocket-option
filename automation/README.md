# Continuous automation (OpenHands Automations)

Runs the capture engine + inference service + AI gate + Telegram delivery on a
cron schedule, with no machine of our own.

## Why it is built this way

Each automation run gets a **fresh sandbox** with a 30-minute hard cap. Probed
directly from inside a run:

| Capability | Result |
|---|---|
| `git clone` (public repo) | works |
| `npm install`, `npx tsx` | works |
| `playwright install chromium` + launch | works |
| Network to broker / Telegram / Gemini | works |
| pip install of `inference/requirements.txt` | works (~13s) |
| KV store (state between runs) | works, but **413 above ~10 KB** |
| `git push` from a run | **refused**: "authentication is not supported for Git operations" |
| `GITHUB_TOKEN` in the run | **401 Bad credentials** (the stored token is stale) |
| `/workspace/project` persistence | **does not persist** between runs |

So there is nowhere writable to keep a 2 MB dataset or a 2 MB model between
runs. The runner therefore **rebuilds the whole stack every run** and carries
the trained model and a trimmed dataset inside the tarball.

## What a run does

`runner/run_bot.py`:

1. fetch `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `Gemini_API_Token` (retried;
   aborts before doing any work if they are unreachable)
2. clone the repo
3. restore `signals.json` and `model.pkl` from the bundled `state/`
4. `npm install` + `playwright install chromium` + `pip install -r requirements.txt`
5. start `uvicorn app:app` on 127.0.0.1:8000, wait for `/health`
6. start `npx tsx capture.ts` with `INFERENCE_URL` pointed at the service
7. supervise for `RUN_SECONDS`, restarting nothing but failing loudly if either
   process dies
8. post a run summary to Telegram, shut both processes down cleanly, and report
   through the automation callback

The prediction path is the project's own: `capture.ts` → `InferenceClient` →
FastAPI `/predict` → `signalFilter` → Gemini gate → Telegram. Nothing here
fabricates a prediction, and the runner never bypasses the AI gate.

## Layout

```
automation/
  runner/run_bot.py   the script an automation run executes
  build.sh            builds automation.tar.gz (and can upload + repoint)
  README.md
```

## Build and deploy

```bash
cd automation
./build.sh                       # writes automation.tar.gz, enforces the 1 MB cap
OPENHANDS_API_KEY=... AUTOMATION_ID=... ./build.sh upload
```

The build trims the shipped dataset to the most recent 1500 rows because the
upload limit is 1 MB and `signals.json` grows every minute. The shipped model is
what serves predictions; the dataset is only there so a run *could* retrain.

## Current schedule

Automation `9d76a957-436f-446b-8d3f-dfb24a6ce077`, cron `*/30 * * * *` (UTC),
timeout 1740s, entrypoint `python3 run_bot.py`.

Each run therefore covers roughly 21 of every 30 minutes of wall clock. The
~9-minute gap is the platform's per-run cap, not a configuration choice.

## Known limitations

- **The dataset does not accumulate across runs.** New observations die with
  the sandbox. The shipped model is therefore static until someone retrains
  locally and rebuilds the tarball. Fixing this needs a writable store the run
  can reach — a working GitHub token, an object-storage bucket, or a paid Render
  disk. None is available to a run today.
- **Two of every three minutes are uncovered**, because a run cannot exceed
  30 minutes and cannot hand off to the next one.
- **A stale `GITHUB_TOKEN`** is stored in the account; it 401s from a run and
  blocks the obvious "commit the dataset to a branch" design.
- **`model.pkl` and `signals.json` are gitignored**, so the tarball is the only
  channel that carries them. Rebuild the tarball after retraining or the
  deployed model keeps serving the old weights.

## Monitoring

- Automation runs: `GET /api/automation/v1/<id>/runs` — status, start/end,
  `error_detail` (the runner puts the failing phase there).
- Telegram receives one summary message per run:
  `predictions total/ml/accepted/rejected`, `AI analyzed/approved/rejected`,
  `telegram sent/signals/failed/dupes`, and the model's measured skill.
- A run that fails sends a `⚠️ OTC bot run FAILED` message with the phase.

The local supervisor (`run.sh`) is the other deployment path and does persist
data; see the repo `AGENTS.md`.
