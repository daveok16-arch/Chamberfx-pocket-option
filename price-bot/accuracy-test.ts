#!/usr/bin/env tsx
/**
 * Accuracy Validation Harness — Live Next-Candle Prediction
 * ==========================================================
 *
 * Measures how accurately the SignalEngine (signal.ts) predicts the NEXT
 * candlestick direction on every live Pocket Option OTC asset.
 *
 * Method (statistically clean, no look-ahead):
 *   1. Capture engine streams live ticks + builds candles (server.ts).
 *   2. Every 2s we ask the engine to evaluate each asset's next-candle
 *      direction (CALL / PUT / WAIT) + confidence. We record a prediction
 *      ONCE per asset per candle, in the LAST ~12s of the current candle —
 *      at that point the current candle's anatomy is nearly complete, so
 *      the prediction reflects a fully-formed candle (correct timing for a
 *      "predict the next candle" engine).
 *   3. Each prediction targets candle N+1 (openTime = currentOpen + PERIOD).
 *      When wall-clock passes targetClose = (N+1 openTime + PERIOD), we find
 *      the candle with that openTime and compare open vs close:
 *        WIN  = (CALL && close>open) || (PUT && close<open)
 *        TIE  = close == open
 *        LOSS = otherwise
 *   4. We aggregate overall + per-asset + per-confidence-tier + CALL/PUT.
 *
 * Usage:
 *   npx tsx accuracy-test.ts                 # ~20 minute live run
 *   npx tsx accuracy-test.ts --minutes 10
 *   npx tsx accuracy-test.ts --expiry 3 --minutes 30
 */

import { PocketOptionPriceBot } from './server.js';
import { SignalEngine, type ExpiryMinutes, type Signal } from './signal.js';

// ============================================
// TYPES
// ============================================

interface Prediction {
  assetId: string;
  direction: 'CALL' | 'PUT';
  confidence: number;
  components: Signal['components'];
  reasons: string[];
  entryPrice: number;          // price at prediction time
  targetOpenTime: number;      // ms openTime of the candle being predicted
  predictedAt: number;          // ms wall-clock when prediction made
  // resolved later:
  outcome?: 'WIN' | 'LOSS' | 'TIE';
  resolvedCandle?: { open: number; high: number; low: number; close: number };
  resolvedAt?: number;
}

// ============================================
// CLI ARGS
// ============================================

function parseArgs(): { expiry: ExpiryMinutes; minutes: number } {
  const args = process.argv.slice(2);
  let expiry: ExpiryMinutes = 1;
  let minutes = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--expiry' || args[i] === '-e') {
      const v = Number(args[i + 1]);
      if (v === 1 || v === 3 || v === 5) expiry = v as ExpiryMinutes;
      i++;
    } else if (args[i] === '--minutes' || args[i] === '-m') {
      minutes = Number(args[i + 1]) || minutes;
      i++;
    }
  }
  return { expiry, minutes };
}

const ASSETS = [
  'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc',
  'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc',
];

// Confidence tier used for slicing accuracy
const CONF_TIERS = [
  { label: 'ALL',  min: 0 },
  { label: '>=50', min: 50 },
  { label: '>=60', min: 60 },
  { label: '>=68', min: 68 },
  { label: '>=75', min: 75 },
];

// ============================================
// MAIN
// ============================================

async function main() {
  const { expiry, minutes } = parseArgs();
  const periodSec = expiry * 60;
  const periodMs = periodSec * 1000;

  console.log('\n===========================================');
  console.log('  Accuracy Validation — Live Next-Candle');
  console.log('===========================================');
  console.log(`  Expiry/candle:  ${expiry} minute(s)`);
  console.log(`  Duration:       ~${minutes} minutes`);
  console.log(`  Assets:         ${ASSETS.length}`);
  console.log(`  Expected preds:  ~${ASSETS.length * minutes} (one per asset per candle)`);
  console.log('===========================================\n');

  const engine = new SignalEngine({
    expiryMinutes: expiry,
    minConfidence: 0, // we want to see ALL directional predictions for analysis
    cooldownMs: 0,    // we control prediction cadence ourselves
  });

  const bot = new PocketOptionPriceBot({
    verbose: false,
    saveToFile: false,
    defaultAssets: ASSETS,
  });

  // --- State ---
  const predictions: Prediction[] = [];
  // Track which candle-openTime we already predicted for each asset (1 prediction/candle/asset)
  const predictedOpenTimes = new Map<string, Set<number>>();

  // --- Ingest ticks ---
  bot.onTick((tick) => engine.ingestTick(tick.assetId, tick));

  // --- Prediction + resolution loop (every 2s) ---
  let statusTick = 0;
  const loop = setInterval(() => {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const curCandleStartSec = Math.floor(nowSec / periodSec) * periodSec;
    const curCandleEndSec = curCandleStartSec + periodSec;
    const timeLeftSec = curCandleEndSec - nowSec;

    // Predict only in the last 12s of the current candle
    const IN_WINDOW = timeLeftSec <= 12 && timeLeftSec > 0;

    // Diagnostic status every ~10s (5 loops)
    if (++statusTick % 5 === 0) {
      const counts = ASSETS.map(a => `${a.split('_')[0]}:${bot.getCandles(a).length}`).join(' ');
      console.log(`[STAT] ${fmtTime(now)} candles=[${counts}] timeLeft=${timeLeftSec}s inWindow=${IN_WINDOW}`);
    }

    for (const assetId of ASSETS) {
      const candles = bot.getCandles(assetId);
      const price = bot.getPrice(assetId);
      if (price <= 0 || candles.length < 3) continue;

      if (IN_WINDOW) {
        // Use the ACTUAL current candle openTime from the candle array
        // (server clock from Pocket Option tick timestamps), NOT Date.now(),
        // because the server clock may differ from the container clock.
        const curCandle = candles[candles.length - 1];
        const curOpenMs = curCandle.openTime;
        // Next candle (the one we're predicting) opens at curOpenMs + periodMs
        const targetOpenMs = curOpenMs + periodMs;

        let seen = predictedOpenTimes.get(assetId);
        if (!seen) { seen = new Set(); predictedOpenTimes.set(assetId, seen); }
        if (seen.has(targetOpenMs)) continue; // already predicted this candle

        const sig = engine.evaluate(assetId, candles, price, now);
        if (sig.direction === 'CALL' || sig.direction === 'PUT') {
          seen.add(targetOpenMs);
          const pred: Prediction = {
            assetId,
            direction: sig.direction,
            confidence: sig.confidence,
            components: sig.components,
            reasons: sig.reasons,
            entryPrice: price,
            targetOpenTime: targetOpenMs,
            predictedAt: now,
          };
          predictions.push(pred);
          const c = sig.components;
          console.log(
            `[PRED] ${fmtTime(now)} ${assetId.padEnd(12)} ${sig.direction.padEnd(4)} conf=${String(sig.confidence).padStart(3)}% -> next candle @ ${fmtTime(targetOpenMs)} | ofi=${pct(c.ofi)} can=${pct(c.candleSignal)} mom=${pct(c.momentum)} str=${pct(c.structure)} [${c.candlePattern}] ${c.regime}/${c.regimeStrength.toFixed(2)}`
          );
        }
      }

      // --- Resolve pending predictions whose target candle has closed ---
      for (const pred of predictions) {
        if (pred.outcome) continue;
        if (pred.assetId !== assetId) continue; // only resolve this asset's preds here
        const targetCloseMs = pred.targetOpenTime + periodMs;
        // Resolve once wall-clock is past the target close + buffer. Use the
        // server clock (last candle closeTime) to be safe against clock skew.
        const lastCandle = candles[candles.length - 1];
        const serverNowMs = lastCandle ? lastCandle.closeTime : now;
        if (serverNowMs < targetCloseMs + 2000 && now < targetCloseMs + 30000) continue;
        const candle = bot.getCandles(assetId).find(c => c.openTime === pred.targetOpenTime);
        if (!candle) {
          if (now > pred.targetOpenTime + periodMs + 60000) {
            pred.outcome = 'LOSS'; // no candle to verify → conservative loss
            pred.resolvedAt = now;
          }
          continue;
        }
        pred.resolvedCandle = { open: candle.open, high: candle.high, low: candle.low, close: candle.close };
        pred.resolvedAt = now;
        if (candle.close > candle.open) {
          pred.outcome = pred.direction === 'CALL' ? 'WIN' : 'LOSS';
        } else if (candle.close < candle.open) {
          pred.outcome = pred.direction === 'PUT' ? 'WIN' : 'LOSS';
        } else {
          pred.outcome = 'TIE';
        }
        const mark = pred.outcome === 'WIN' ? '✅ WIN ' : pred.outcome === 'TIE' ? '🟰 TIE ' : '❌ LOSS';
        console.log(
          `[RESV] ${fmtTime(now)} ${pred.assetId.padEnd(12)} ${mark} ${pred.direction} conf=${pred.confidence}% | target O:${candle.open} C:${candle.close} (${candle.close > candle.open ? 'UP' : candle.close < candle.open ? 'DOWN' : 'FLAT'})`
        );
      }
    }

    // Periodic summary
    const resolved = predictions.filter(p => p.outcome);
    if (resolved.length > 0 && resolved.length % 5 === 0) {
      printSummary(resolved, predictions.length, false);
    }
  }, 2000);

  // --- Stop after the configured duration ---
  setTimeout(async () => {
    clearInterval(loop);
    console.log('\n\n===========================================');
    console.log('  FINAL ACCURACY REPORT');
    console.log('===========================================\n');
    // Give a last grace window for pending predictions to resolve
    await sleep(15000);
    printSummary(predictions, predictions.length, true);
    bot.disconnect();
    process.exit(0);
  }, minutes * 60 * 1000);

  await bot.connect();
  console.log('✅ Connected — accuracy test running. Press Ctrl+C for early report.\n');

  // Early Ctrl+C → print current report
  process.on('SIGINT', () => {
    clearInterval(loop);
    console.log('\n\n===========================================');
    console.log('  ACCURACY REPORT (early stop)');
    console.log('===========================================\n');
    printSummary(predictions, predictions.length, true);
    bot.disconnect();
    process.exit(0);
  });
}

// ============================================
// REPORTING
// ============================================

function printSummary(preds: Prediction[], total: number, final: boolean): void {
  const resolved = preds.filter(p => p.outcome === 'WIN' || p.outcome === 'LOSS' || p.outcome === 'TIE');
  const decided = resolved.filter(p => p.outcome !== 'TIE');
  const wins = resolved.filter(p => p.outcome === 'WIN').length;
  const losses = resolved.filter(p => p.outcome === 'LOSS').length;
  const ties = resolved.filter(p => p.outcome === 'TIE').length;
  const winRate = decided.length > 0 ? (wins / decided.length) * 100 : 0;

  console.log('-------------------------------------------');
  console.log(`Predictions: ${resolved.length} resolved / ${total} total | Pending: ${total - resolved.length}`);
  console.log(`Wins: ${wins} | Losses: ${losses} | Ties: ${ties}`);
  console.log(`★ Win rate (excl. ties): ${winRate.toFixed(1)}%   (binary-options effective: ${resolved.length > 0 ? ((wins / resolved.length) * 100).toFixed(1) : '0'}% — ties count as loss)`);
  console.log('-------------------------------------------');

  // Per confidence tier
  console.log('  By confidence tier (excl. ties):');
  for (const t of CONF_TIERS) {
    const tier = decided.filter(p => p.confidence >= t.min);
    if (tier.length === 0) {
      console.log(`    ${t.label.padEnd(6)}: n/a`);
      continue;
    }
    const tw = tier.filter(p => p.outcome === 'WIN').length;
    console.log(`    ${t.label.padEnd(6)}: ${(tw / tier.length * 100).toFixed(1)}%  (${tw}/${tier.length})`);
  }

  // Per asset
  console.log('  By asset (excl. ties):');
  for (const asset of ASSETS) {
    const ap = decided.filter(p => p.assetId === asset);
    if (ap.length === 0) { console.log(`    ${asset.padEnd(12)}: n/a`); continue; }
    const aw = ap.filter(p => p.outcome === 'WIN').length;
    console.log(`    ${asset.padEnd(12)}: ${(aw / ap.length * 100).toFixed(1)}%  (${aw}/${ap.length})`);
  }

  // CALL vs PUT
  const calls = decided.filter(p => p.direction === 'CALL');
  const puts = decided.filter(p => p.direction === 'PUT');
  const cw = calls.filter(p => p.outcome === 'WIN').length;
  const pw = puts.filter(p => p.outcome === 'WIN').length;
  console.log('  By direction (excl. ties):');
  console.log(`    CALL: ${calls.length ? (cw / calls.length * 100).toFixed(1) : 'n/a'}%  (${cw}/${calls.length})`);
  console.log(`    PUT : ${puts.length ? (pw / puts.length * 100).toFixed(1) : 'n/a'}%  (${pw}/${puts.length})`);

  // Per regime (key metric for the regime-adaptive engine)
  console.log('  By regime (excl. ties):');
  for (const reg of ['MEAN_REVERT', 'TREND', 'UNCLEAR']) {
    const rp = decided.filter(p => p.components.regime === reg);
    if (rp.length === 0) { console.log(`    ${reg.padEnd(12)}: n/a`); continue; }
    const rw = rp.filter(p => p.outcome === 'WIN').length;
    console.log(`    ${reg.padEnd(12)}: ${(rw / rp.length * 100).toFixed(1)}%  (${rw}/${rp.length})`);
  }
  console.log('-------------------------------------------\n');

  if (final && resolved.length > 0) {
    console.log('Verdict: ' + verdict(winRate, decided.length));
  }
}

function verdict(winRate: number, n: number): string {
  // Binary options need >55% to be profitable after payouts; PO OTC pays ~80-92%.
  // Break-even ~52-55% at 92% payout. Strong if >=60%.
  if (n < 15) return `Sample size ${n} is small — treat results as indicative only.`;
  if (winRate >= 65) return `STRONG — ${winRate.toFixed(1)}% on n=${n}. Edge is real if reproducible.`;
  if (winRate >= 55) return `PROFITABLE — ${winRate.toFixed(1)}% on n=${n}. Above break-even for ~90% payouts.`;
  if (winRate >= 50) return `MARGINAL — ${winRate.toFixed(1)}% on n=${n}. Near break-even; needs refinement.`;
  return `BELOW BREAK-EVEN — ${winRate.toFixed(1)}% on n=${n}. Tune thresholds/components.`;
}

// ============================================
// HELPERS
// ============================================

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().split('T')[1].slice(0, 8);
}
function pct(n: number): string {
  return (n > 0 ? '+' : '') + String(n).padStart(3);
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
