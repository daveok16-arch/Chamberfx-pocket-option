# CHAMBERFX — Pocket Option OTC Signal Bot

A production signal bot for Pocket Option OTC binary options, built in TypeScript. It captures **live market prices** directly from Pocket Option, runs a **regime-adaptive leading-indicator engine**, and delivers CALL/PUT signals to **Telegram** — deployable on **Render.com**.

> ⚠️ Trading disclaimer: This bot is for educational/research purposes. Binary options trading carries significant risk. The accuracy figures below are from limited live samples (n=37 / n=16). Always validate on a demo account before risking real money.

---

## What it does

1. **Live price capture** — Uses Playwright (headless Chromium) to discover and authenticate to Pocket Option's live Socket.IO WebSocket, then streams real-time OTC ticks for 6 pairs (EURUSD, GBPUSD, USDJPY, XAUUSD, AUDUSD, USDCAD) and builds candles.
2. **Regime-adaptive signal engine** — Detects market regime (trend vs mean-revert) via lag-1 return autocorrelation and fuses four **leading, non-lagging** components: Order-Flow Imbalance, candle anatomy (rejection wicks + engulfing, never flipped), tick momentum/decay, and market structure. Emits CALL/PUT/WAIT with a confidence score.
3. **Telegram delivery** — Every emitted signal is sent to your Telegram chat (formatted with components, regime, confidence, reasons), plus a startup confirmation and a periodic price heartbeat.
4. **Health endpoint** — A tiny HTTP server (`/health`) lets Render monitor the bot.

---

## Live accuracy (validated against real Pocket Option feed)

The engine was iterated against a no-look-ahead live accuracy harness (`accuracy-test.ts`) that predicts each asset's next-candle direction and resolves against the actual next candle.

| Timeframe | v1 (before) | v2 (after) | ≥50 confidence tier |
|-----------|-------------|------------|---------------------|
| 1-minute  | 29.4%       | **51.4%**  | **64.7%**           |
| 5-minute  | 27.3%       | **56.3%**  | above break-even    |

Break-even at ~92% OTC payout is ~53% win rate, so **trading only ≥50-confidence signals is profitable** in these samples. Full methodology and per-asset/regime breakdowns are in `AGENTS.md`.

---

## Repository layout

```
price-bot/
  server.ts         Live price-capture engine (Playwright + WebSocket)
  signal.ts         Regime-adaptive SignalEngine (leading indicators)
  signal-bot.ts     CLI: wires capture → engine → Telegram + health server
  telegram.ts       Optional Telegram notifier (Node fetch, no extra deps)
  accuracy-test.ts  Live next-candle accuracy harness
  Dockerfile        Render.com deployment image (Node + Playwright)
  render.yaml       (repo root) Render blueprint
```

---

## Quick start (local)

```bash
cd price-bot
npm install
npx playwright install chromium

# Optional: enable Telegram delivery
export TELEGRAM_BOT_TOKEN="<from @BotFather>"
export TELEGRAM_CHAT_ID="<your chat id>"

# Run: 1-minute expiry, only emit ≥50-confidence signals
npx tsx signal-bot.ts --expiry 1 --confidence 50
```

CLI flags: `--expiry 1|3|5` (default 1), `--confidence N` (default 68).

Validate accuracy yourself:
```bash
npx tsx accuracy-test.ts --expiry 1 --minutes 18
npx tsx accuracy-test.ts --expiry 5 --minutes 40
```

---

## Deploy on Render.com

This repo is configured for Render via the `render.yaml` blueprint and a Dockerfile.

### Option A — Blueprint (recommended)
1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → select the repo. Render reads `render.yaml` and creates the web service.
3. Set the two **secret** env vars in the Render dashboard (they are marked `sync: false` so they are never read from the repo):
   - `TELEGRAM_BOT_TOKEN` — from `@BotFather`
   - `TELEGRAM_CHAT_ID` — your chat/channel id (get it from `@userinfobot`)
4. Deploy. Render builds the Docker image (root `./Dockerfile`, app in `price-bot/`), installs Playwright/chromium, and starts the bot. Health checks hit `/health` on port `10000`.

### Option B — Manual web service
1. **New → Web Service** → connect the repo.
2. **Runtime:** Docker. (Leave **Root Directory** empty — the Dockerfile is at the repo root.) **Dockerfile path:** `./Dockerfile`.
3. **Instance plan:** `starter` or higher (Playwright/chromium needs ~1GB RAM — bump to `standard` if you see OOM).
4. Add the env vars above. Deploy.

### Required environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes (for signals) | Bot token from `@BotFather` |
| `TELEGRAM_CHAT_ID` | yes (for signals) | Target chat/channel id |
| `PORT` | no (default 10000) | HTTP health server port (Render sets this) |
| `EXPIRY` | no (default 1) | Trade expiry in minutes |
| `CONFIDENCE` | no (default 50) | Minimum signal confidence to emit |

> If the Telegram env vars are absent, the bot still runs — it logs signals to the console and `signals.jsonl`, and prints a warning. It does **not** crash.

---

## How the engine works (summary)

- **Regime detection**: lag-1 return autocorrelation over recent closed candles → `TREND` / `MEAN_REVERT` / `UNCLEAR`. OTC short-timeframe data predominantly mean-reverts, so `UNCLEAR` defaults to mean-revert behavior.
- **Continuation components** (OFI, body/marubozu conviction, momentum, structure) are **sign-flipped** in a mean-reverting regime (a bullish candle predicts a DOWN next candle) and kept as-is in a trend.
- **Reversal components** (rejection wicks + engulfing) are **never flipped** — they already predict the opposite of the rejected extreme.
- Confidence is boosted by regime strength and dampened by momentum decay.

Full design notes, the fix history, and per-regime accuracy analysis live in `AGENTS.md`.

---

## Tech stack

- **TypeScript** + **tsx** (runs `.ts` directly, no build step needed)
- **Playwright** (chromium) for Pocket Option session discovery
- **ws** for WebSocket
- **Node fetch** for the Telegram Bot API (no extra dependency)

## License

MIT
