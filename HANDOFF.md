# Session Handoff — Pocket Option OTC Layered Trade Bot

> Written 2026-08-27 by the previous session (OpenHands acting as project manager).
> The new session should READ THIS FILE FIRST, verify the state per "Verification", then continue.
> If you are the new session and this file is present, treat everything below as authoritative context
> and DO NOT re-explore from scratch before checking the current git state.

---

## TL;DR — where things stand right now

- Repo: `daveok16-arch/Chamberfx-pocket-option` (TS, `price-bot/`).
- The old **signal engine was deleted** (boss's command — "it was a loser signal giver").
- Replaced with a **safe, PAPER-by-default layered pipeline**: `strategy.ts` -> `risk.ts` -> `execution.ts` -> `trade-bot.ts`, built on the **verified TS capture layer** (`server.ts`). NOT a Python rewrite.
- **PR #4** ("Replace signal engine with layered strategy/risk/execution foundation") was **MERGED to `main`** at `2045abc`, but it was merged WITHOUT the two critical code-review fixes.
- The two critical fixes now live in **PR #5** (open, `fix/review-critical` -> `main`, label `bug`):
  https://github.com/daveok16-arch/Chamberfx-pocket-option/pull/5
- **Next action for the user: review + merge PR #5.**
- After #5 merges, remaining proposed work (not yet started): end-to-end validation that paper settlement resolves against the real live WS feed, optional CI, optional main-based rebase test.

---

## How we got here (recent history)

1. Boss overruled the PM: DELETE all signal-engine files (`signal.ts`, `signal-bot.ts`, `telegram.ts`, `accuracy-test.ts`, `engine-smoke-test.ts`) and the deploy wiring (`price-bot/Dockerfile`, render.yaml refs). Chose **Plan B** (strip signal engine). Do NOT rewrite in Python.
2. Built the layered pipeline + updated docs (READMEs, AGENTS.md, `.env.example`, render.yaml).
3. Committed on `feat/layered-trade-bot` (714dbc8), pushed, opened **PR #4**.
4. Rigorous self-review found two critical bugs:
   - **CRITICAL #1 — isDemo regex:** `isDemoMode()` used `/\b"isDemo"\s*:\s*(\d)/`. The `\b` never matches in front of a bare JSON key (`{`/`,` are non-word chars), so it ALWAYS returned `true` (demo). The **LIVE path was unreachable** regardless of `ALLOW_LIVE=1` or a real (non-demo) session.
   - **CRITICAL #2 — settlement leak:** `settle()` was never wired into the runtime. `positions` grew unbounded; concurrency slots + 24h loss-stop gates self-deadlocked.
5. Fixed both locally, wrote regression tests, verified (30/30 checks, typecheck 0).
6. **Wrinkle encountered when pushing:** CodeRabbit (automated bot) had pushed auto-fixes onto `feat/layered-trade-bot` AND **PR #4 had already been merged to main** (2045abc) WITHOUT the two critical fixes. Verified `main` still had both original bugs.
7. Created `fix/review-critical` from `origin/main`, applied the two critical fixes (+ retained CodeRabbit's in-merge additions), pushed, and opened **PR #5**.

---

## Git state (authoritative, verified at handoff)

```
main                   2045abc  (origin/main)  Merge PR #4  [contains base pipeline + CodeRabbit auto-fixes, NOT the two critical fixes]
fix/review-critical    b9cb192  (origin/fix/review-critical) -> PR #5  [HEAD = the two critical fixes]
feat/layered-trade-bot 93350c3  (origin)  stale/abandoned (was PR #4's branch, now merged; do not push to it)
```

- Current local branch: `fix/review-critical` (tracking `origin/fix/review-critical`), working tree clean.
- PR #5: `fix: live-execution gating + auto-settle paper positions against live prices` — https://github.com/daveok16-arch/Chamberfx-pocket-option/pull/5

---

## What the two critical fixes in PR #5 do

### server.ts
- `isDemoMode()`: removed the `\b`, kept both quoted and unquoted key variants, still defaults to safe demo if the flag is absent.
  ```ts
  const m = /"isDemo"\s*:\s*(\d)/.exec(this.cachedAuthPacket) ?? /isDemo\s*:\s*(\d)/.exec(this.cachedAuthPacket);
  if (m) return m[1] === "1";
  return true; // safe default
  ```
- Added `setAuthPacketForTest(packet)` test seam so the real method is unit-testable without a live WS.

### risk.ts
- `registerOpen(requestId, asset, amount, strike, direction, durationMs, nowMs)` — records the LIVE entry price as `strike`.
- New `settleExpired(nowMs, priceOf, payoutRatio=0.92)` — for each expired open position, resolves paper PnL against the CURRENT live WS price:
  - CALL won if `livePrice > strike` -> `+stake*payout`
  - PUT won if `livePrice < strike` -> `+stake*payout`
  - lost -> `-stake`
  - no feed price (handle) -> refund `0` (conservative)
  - Releases the concurrency slot; PnL feeds the rolling 24h loss-stop.
- Retains CodeRabbit's 300s `maxOptionDurationMs` backstop prune in `allow()`.

### trade-bot.ts
- Passes the live entry `price` as `strike` to `registerOpen`.
- `startSettlementLoop()` runs every 1s feeding `priceOf = (a) => bot.getPrice(a)`; cleared on SIGINT.

### risk-smoke-test.ts
- **30 checks**, all passing, including new regressions:
  - real-bot isDemo paths (demo / non-demo / flag-absent) via `setAuthPacketForTest`
  - non-demo bot + `config.live` arms the live executor
  - `settleExpired` win/loss/refund vs live price + slot release + loss-stop feed

---

## Verification commands (run these BEFORE any further work)

```bash
cd /workspace/project/Chamberfx-pocket-option/price-bot
./node_modules/.bin/tsc --noEmit            # must exit 0
timeout 90 npx tsx risk-smoke-test.ts        # expect "ALL CHECKS PASSED", 30 PASS, exit 0
```

If you are on a fresh sandbox (no node_modules): `cd price-bot && npm install` first (postinstall runs `playwright install chromium`).

---

## User's proposed next steps (in order, from the user)

1. Review + merge **PR #5** (the critical fixes). Wait for the user's go-ahead to merge or monitor the PR.
2. After #5 merges:
   - **End-to-end validation** that paper settlement resolves against real live prices from the WS feed:
     `npx tsx trade-bot.ts --expiry 1 --confidence 72` (or via `npm run start`) in PAPER mode (do NOT set `ALLOW_LIVE`), let it run, verify logged/settled PnL tracks live prices.
   - Optional: CI wiring (typecheck + smoke on PRs), main-based rebase test.

---

## Hard constraints / ground rules (carried from this session)

- **PAPER mode by default.** Live execution requires `ALLOW_LIVE=1` env var AND a real (non-demo) authenticated session. Never arm live without explicit user consent.
- **Do NOT rewrite in Python.** Keep + validate the working TypeScript capture layer.
- **Do NOT push to `main` directly.** Always work on a feature branch; commit is fine on `fix/review-critical` to update PR #5; if PR #5 gets merged, create a NEW branch from updated `main` for further work (per version-control policy: never push to a closed/merged PR's branch).
- Use `Co-authored-by: openhands <openhands@all-hands.dev>` on commits.
- No new external deps unless required; existing deps suffice (Socket.IO client, Playwright, tsx).
- Align candle period with expiry (`candlePeriod = expiry * 60`); clock-skew: candle openTime comes from Pocket Option server clock (~2h ahead of container `Date.now()`), always use `bot.getServerTime()` for settlement/timing.
- Trade ALL 6 OTC pairs at ~$1 stake (multi-asset reversion strategy in `strategy.ts`).

---

## Architecture map (price-bot/)

- `server.ts` — verified live price-capture engine (Playwright discovers PO Socket.IO WS, auth packet, subscribes to OTC assets, ticks + candles). Exposes `getCandles(assetId)`, `getPrice(assetId)`, `getAssetList()`, `getServerTime()`, `isDemoMode()`, multi-listener callbacks. THIS is the "actual capture" source of live prices.
- `strategy.ts` — `Strategy` interface + `MultiAssetReversionStrategy` (all 6 OTC pairs, range-reversion, volatility/range filter, rejection-wick leading edge, hard-trend suppression). Pure/leading; NO lagging indicators (no EMA/RSI/MACD/Bollinger).
- `risk.ts` — `RiskManager` safety gates (stake cap, cooldown, max concurrent, daily loss stop) + position model + `settleExpired` live-price settlement.
- `execution.ts` — `ExecutionEngine` speaking Pocket Option `openOrder` WS protocol; refuses LIVE unless session is non-demo AND config.live.
- `trade-bot.ts` — entrypoint wiring strategy -> risk -> execution + settlement loop + `/health` HTTP endpoint (for Render).
- `risk-smoke-test.ts` — smoke test (30 checks).
- `package.json` — scripts: `start`/`render:start` = `tsx trade-bot.ts`, `capture` = `tsx server.ts`, `test:risk` = `tsx risk-smoke-test.ts`, `typecheck` = `tsc --noEmit`.

Data interfaces: `Tick {assetId,price,timestamp,direction}`, `Candle {assetId,open,high,low,close,volume,openTime,closeTime}`, `AssetInfo {id,name,payout,active,lastPrice,ticks,candles}`.

OpenOrder payload: `42["openOrder",{asset,amount,action,isDemo,requestId,optionType,time}]`.

Env vars: `ALLOW_LIVE` (paper/live switch), `EXPIRY`, `CONFIDENCE`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (optional Telegram delivery, disables itself if unset), `PORT`.