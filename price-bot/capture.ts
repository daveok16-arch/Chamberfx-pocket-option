#!/usr/bin/env tsx
/**
 * Live Price Capture + Feature/Label Collection + Signal Filtering — entrypoint
 * ============================================================================
 * Connects to Pocket Option over the authenticated Socket.IO WebSocket, streams
 * real-time OTC ticks, and builds candles. On top of that:
 *
 *   1. the feature/label collector turns the feed into a supervised-learning
 *      dataset; and
 *   2. each closed 60s window is scored by the ML service, then gated by the
 *      Phase 3 quality filters before any signal is surfaced.
 *
 * Outputs:
 *   - 60s rolling feature windows per asset  -> `live-prices.json`
 *   - binary outcome labels resolved 60s later -> `signals.json`
 *   - premium signals only (post-filter)      -> `[VALID_SIGNAL]` log
 *
 * There is NO execution, risk, or order-placement logic here — this is
 * strictly a signal generator.
 *
 * Usage:
 *   npx tsx capture.ts                 # 1m windows
 *   npx tsx capture.ts --period 180    # 3m candles
 *   PERIOD=300 npx tsx capture.ts      # via env (used by Render)
 */

import { PocketOptionPriceBot } from './server.js';
import {
  FeatureLabelCollector,
  InferenceClient,
  type FeatureWindow,
  type PredictionResult,
  type StrategyContext,
} from './strategy.js';
import { evaluateSignal, type ValidSignal } from './signalFilter.js';
import { MlPredictor, PredictionRouter } from './predictor.js';
import { TelegramDeliverer } from './deliverer.js';
import { GeminiAnalyst, type AiAnalysis, type SignalAnalyst } from './aiAnalyst.js';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

const DEFAULT_ASSETS = [
  'EURUSD_otc',
  'GBPUSD_otc',
  'USDJPY_otc',
  'XAUUSD_otc',
  'AUDUSD_otc',
  'USDCAD_otc',
];

/**
 * Parse CLI args and env for the candle period.
 * @returns Candle period in seconds (60 | 180 | 300)
 */
function parsePeriod(): number {
  const args = process.argv.slice(2);
  const fromEnv = Number(process.env.PERIOD);
  let period = [60, 180, 300].includes(fromEnv) ? fromEnv : 60;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--period' || args[i] === '-p') {
      const v = Number(args[i + 1]);
      if ([60, 180, 300].includes(v)) period = v;
      i++;
    }
  }
  return period;
}

/**
 * Parse CLI args and env for the label horizon.
 *
 * The horizon is how far ahead the label is measured ("will price be higher in
 * N seconds?"). It is separate from the candle period: the feature window stays
 * 60s, but a longer horizon is a different prediction problem — a 60s horizon
 * is dominated by microstructure noise, a 180s/300s horizon gives a real move
 * room to develop. Kept to the same set the broker offers expirations for.
 *
 * @returns Horizon in seconds (60 | 180 | 300)
 */
function parseHorizon(): number {
  const args = process.argv.slice(2);
  const fromEnv = Number(process.env.HORIZON);
  let horizon = [60, 180, 300].includes(fromEnv) ? fromEnv : 60;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--horizon' || args[i] === '-H') {
      const v = Number(args[i + 1]);
      if ([60, 180, 300].includes(v)) horizon = v;
      i++;
    }
  }
  return horizon;
}

async function main() {
  const candlePeriod = parsePeriod();
  const horizonSec = parseHorizon();

  const bot = new PocketOptionPriceBot({
    verbose: false,
    defaultAssets: DEFAULT_ASSETS,
    candlePeriod,
  });

  console.log('\n===========================================');
  console.log('  Pocket Option OTC — Live Price Capture');
  console.log('===========================================');
  console.log(`  Candle period:   ${candlePeriod}s`);
  console.log(`  Label horizon:   ${horizonSec}s`);
  console.log(`  Assets:          ${DEFAULT_ASSETS.join(', ')}`);
  console.log('===========================================\n');

  bot.onConnect(() => console.log('✅ Connected to Pocket Option — live capture active\n'));
  bot.onDisconnect(() => console.log('⚠️ Disconnected — will attempt reconnect\n'));
  bot.onError((err) => console.error(`❌ Capture error: ${err.message}\n`));
  bot.onCandle((c) =>
    console.log(
      `🕯️  CANDLE CLOSED: ${c.assetId} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
    )
  );

  await bot.connect();

  // --- Phase 1: feature/label collector -------------------------------
  // Paths are env-overridable so the deployed container can point them at a
  // mounted persistent disk (see render.yaml). Without that, `autoDeploy`
  // rebuilds wipe the dataset on every push.
  const featuresFile = process.env.FEATURES_FILE ?? './live-prices.json';
  const signalsFile = process.env.SIGNALS_FILE ?? './signals.json';
  // The horizon must reach the collector, not just the candle engine. Before
  // this it was silently fixed at 60s, so `--period 180` changed the candles
  // but every label was still resolved 60s later.
  const collector = new FeatureLabelCollector({
    featuresFile,
    signalsFile,
    horizonMs: horizonSec * 1000,
  });

  // --- Prediction: score EVERY closed window via the trained model ------
  // The ONLY prediction source is the model served by the inference service.
  // There is no baseline fallback: if INFERENCE_URL is unset, the service is
  // down, or no model has been trained (503), the engine collects data and
  // makes no predictions. Shipping a placeholder's guesses to a chat is worse
  // than staying quiet, so this path is deliberately fail-closed.
  const inference = new InferenceClient();
  const predictor = new PredictionRouter(inference.isEnabled() ? new MlPredictor(inference) : null);
  if (!inference.isEnabled()) {
    console.error(
      '[PREDICT] no inference service configured — COLLECT-ONLY mode. ' +
        'No predictions, signals or deliveries until a model is served.'
    );
  }
  console.log(`[PREDICT] active predictor: ${predictor.name}`);

  const predictions: Record<string, PredictionResult> = {};
  /** Most recent signal that cleared every filter, per asset. */
  const validSignals: Record<string, ValidSignal> = {};
  /** Most recent AI verdict, per asset (approved signals only). */
  const aiApprovals: Record<string, AiAnalysis> = {};
  /** Rolling counts for observability. `ml` counts model-sourced predictions. */
  const predictionStats = { total: 0, ml: 0, accepted: 0, rejected: 0 };
  /** AI-gate counts: what the analyst did with the filter-accepted signals. */
  const aiStats = { analyzed: 0, approved: 0, rejected: 0, failed: 0 };
  /**
   * Every scored window, held only until its label resolves. Volume counters
   * (`predictionStats`) cannot distinguish a working model from a busy one, so
   * the bot also has to report whether its calls were RIGHT.
   */
  const pendingScored: Array<{
    asset: string;
    entryAt: number;
    direction: 'CALL' | 'PUT';
    probability: number;
    source: string;
    accepted: boolean;
  }> = [];
  /** Resolved outcomes, newest last, capped so memory stays flat. */
  const resolvedScored: Array<{ confidence: number; correct: boolean; accepted: boolean; source: string }> = [];
  const MAX_RESOLVED = 20000;

  /**
   * Match scored windows to their resolved labels and record whether each call
   * was right. Volume counters cannot tell a working model from a busy one, so
   * this is the number that decides whether the predictor has any skill.
   *
   * A prediction is "correct" when its direction matched the realised label
   * (CALL needs label 1, PUT needs label 0). Unresolved windows stay pending
   * until their 60s horizon closes.
   */
  const resolveScored = () => {
    if (pendingScored.length === 0) return;
    const byKey = new Map<string, { label: number }>();
    for (const rec of collector.getLabels()) {
      byKey.set(`${rec.asset}|${rec.entryAt}`, { label: rec.label });
    }
    for (let i = pendingScored.length - 1; i >= 0; i--) {
      const p = pendingScored[i];
      const hit = byKey.get(`${p.asset}|${p.entryAt}`);
      if (!hit) continue;
      pendingScored.splice(i, 1);
      const correct = p.direction === 'CALL' ? hit.label === 1 : hit.label === 0;
      resolvedScored.push({
        confidence: Math.max(p.probability, 1 - p.probability),
        correct,
        accepted: p.accepted,
        source: p.source,
      });
    }
    if (resolvedScored.length > MAX_RESOLVED) {
      resolvedScored.splice(0, resolvedScored.length - MAX_RESOLVED);
    }
  };

  /** Aggregate resolved outcomes into the skill report served on /health. */
  const skillReport = ():
    | { resolved: 0; note: string }
    | {
        resolved: number;
        accuracy: number;
        wilson95: [number, number];
        breakEvenAt92Payout: number;
        byConfidence: Record<string, { n: number; accuracy?: number }>;
        filterAccepted: { n: number; accuracy?: number };
        pending: number;
      } => {
    const n = resolvedScored.length;
    if (n === 0) return { resolved: 0, note: 'no resolved predictions yet' };
    const wins = resolvedScored.filter((r) => r.correct).length;
    const acc = wins / n;
    // Wilson interval: the honest way to report a proportion this close to 0.5
    // on a small sample, and what makes a fluke look like a fluke.
    const z = 1.96;
    const denom = 1 + (z * z) / n;
    const centre = (acc + (z * z) / (2 * n)) / denom;
    const half = (z * Math.sqrt((acc * (1 - acc)) / n + (z * z) / (4 * n * n))) / denom;
    const bucket = (lo: number, hi: number) => {
      const g = resolvedScored.filter((r) => r.confidence >= lo && r.confidence < hi);
      if (g.length === 0) return { n: 0 };
      return { n: g.length, accuracy: +(g.filter((r) => r.correct).length / g.length).toFixed(4) };
    };
    const acc_g = resolvedScored.filter((r) => r.accepted);
    return {
      resolved: n,
      accuracy: +acc.toFixed(4),
      wilson95: [+(centre - half).toFixed(4), +(centre + half).toFixed(4)],
      breakEvenAt92Payout: 0.5208,
      // A confidence band that does not rise with confidence means the model's
      // probability is decorative — the gate is then selecting noise.
      byConfidence: {
        '0.50-0.60': bucket(0.5, 0.6),
        '0.60-0.70': bucket(0.6, 0.7),
        '0.70-0.80': bucket(0.7, 0.8),
        '0.80-1.00': bucket(0.8, 1.01),
      },
      filterAccepted: acc_g.length
        ? {
            n: acc_g.length,
            accuracy: +(acc_g.filter((r) => r.correct).length / acc_g.length).toFixed(4),
          }
        : { n: 0 },
      pending: pendingScored.length,
    };
  };

  const deliverer = new TelegramDeliverer({
    auditFile: process.env.TELEGRAM_AUDIT_FILE ?? path.join(path.dirname(signalsFile), 'telegram-audit.jsonl'),
  });
  const analyst: SignalAnalyst = new GeminiAnalyst();

  // --- AI decision journal --------------------------------------------
  // Append-only JSONL record of every AI verdict, so the gate can be audited
  // independently of the rotating console log: what the prediction was, what
  // the analyst decided, and whether the signal was delivered. Kept in the
  // data directory next to signals.json so it survives a restart alongside the
  // dataset. It records decisions; it is not a second source of predictions.
  const journalFile =
    process.env.AI_JOURNAL_FILE ?? path.join(path.dirname(signalsFile), 'ai-journal.jsonl');
  const journal = (entry: Record<string, unknown>) => {
    try {
      fs.appendFileSync(journalFile, JSON.stringify(entry) + '\n');
    } catch (e) {
      console.error(`[AI] journal write failed: ${(e as Error).message}`);
    }
  };

  /**
   * Route a filter-accepted signal through the AI analyst, then deliver it.
   *
   * This is the ONLY path to Telegram. Ordering is deliberate:
   *   1. the prediction engine's signal is captured intact,
   *   2. the analyst independently judges it,
   *   3. only an APPROVE is delivered — with the analysis attached.
   *
   * A failed analysis is fail-closed: the signal is dropped, never delivered
   * unverified. The original prediction object is passed by value and never
   * mutated, so the source data is preserved exactly.
   */
  const analyzeAndDeliver = async (
    signal: ValidSignal,
    features: FeatureWindow,
    prediction: PredictionResult,
    context: string
  ) => {
    aiStats.analyzed++;
    const analysis = await analyst.analyze({ signal, prediction, features, marketContext: context });

    // The prediction object is journaled as received, never rewritten, so the
    // original source prediction can always be compared against the verdict.
    // `features` is the exact window the analyst judged: without it, any
    // post-hoc audit has to re-derive features from signals.json by joining on
    // (asset, entryAt), which silently drops rows that never resolved.
    const base = {
      at: new Date().toISOString(),
      signal,
      prediction,
      features,
    };

    if (!analysis) {
      aiStats.failed++;
      console.error(`[AI] ${signal.asset} — analysis unavailable; signal withheld`);
      journal({ ...base, delivered: false, reason: 'analysis-unavailable' });
      return;
    }

    if (analysis.verdict !== 'APPROVE') {
      aiStats.rejected++;
      console.log(
        `[AI_REJECT] ${signal.asset} ${signal.direction} ` +
          `(AI ${(analysis.confidence * 100).toFixed(0)}%): ${analysis.summary}`
      );
      journal({ ...base, analysis, delivered: false, reason: 'ai-rejected' });
      return;
    }

    aiStats.approved++;
    aiApprovals[signal.asset] = analysis;
    console.log(
      `[AI_APPROVE] ${signal.asset} ${signal.direction} ` +
        `(AI ${(analysis.confidence * 100).toFixed(0)}%): ${analysis.summary}`
    );
    void deliverer.send(signal, features, prediction.source ?? 'unknown', analysis);
    // Delivery is queued and batched; the journal records the approval decision,
    // and `[DELIVER] sent ... message #N` is the delivery confirmation.
    journal({ ...base, analysis, delivered: true, reason: 'ai-approved' });
  };

  collector.onBucketBoundary((asset: string, features: FeatureWindow, _price: number, entryAt: number) => {
    // Fire-and-forget: scoring must not block the evaluate loop.
    void predictor
      .predict(asset, features)
      .then((result) => {
        if (!result) return;
        predictions[asset] = result;
        predictionStats.total++;
        predictionStats.ml++;

        console.log(
          `[PREDICT] ${asset} P(UP)=${result.probability.toFixed(4)} ` +
            `-> ${result.direction === 1 ? 'UP(1)' : 'DOWN(0)'} [ML]`
        );

        // Phase 3: gate the raw prediction. A rejection is normal operation,
        // not an error — it only means the window was not tradeable.
        const outcome = evaluateSignal(result, features, entryAt);

        // Record the scored window before any gating, so the skill tracker
        // measures the raw model, not just the survivors of the filter.
        pendingScored.push({
          asset,
          entryAt,
          direction: result.direction === 1 ? 'CALL' : 'PUT',
          probability: result.probability,
          source: result.source ?? 'unknown',
          accepted: outcome.accepted,
        });
        resolveScored();

        if (!outcome.accepted) {
          predictionStats.rejected++;
          console.log(`[SIGNAL_FILTER] Signal discarded: ${outcome.detail}`);
          return;
        }

        predictionStats.accepted++;
        validSignals[asset] = outcome.signal;
        console.log(`[VALID_SIGNAL] ${JSON.stringify(outcome.signal)}`);

        // AI analysis gate: nothing reaches Telegram without an APPROVE.
        const context = `${asset} recent closes: ${bot
          .getCandles(asset)
          .slice(-5)
          .map((c) => c.close)
          .join(', ')}`;
        return analyzeAndDeliver(outcome.signal, features, result, context);
      })
      .catch((e) => console.error(`[PREDICT] ${asset} pipeline error: ${(e as Error).message}`));
  });

  /**
   * Drive one collector cycle per asset: stream the engine's tick history and
   * current candles into the collector via the Strategy context.
   */
  const collectAll = () => {
    for (const a of bot.getAssetList()) {
      const price = bot.getPrice(a.id);
      if (!(price > 0)) continue;
      const ctx: StrategyContext = {
        price,
        candles: bot.getCandles(a.id),
        ticks: bot.getTickHistory(a.id),
        serverTime: bot.getServerTime(),
      };
      collector.evaluate(ctx, a.id);
    }
  };

  const collectTimer = setInterval(collectAll, 1000);

  // --- Periodic output: real-time features + append-only labels --------
  // Writes are atomic (temp file + rename) so a crash mid-write can never
  // truncate the dataset: readers either see the old file or the new one.
  const writeAtomic = (file: string, contents: string) => {
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, contents);
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`[COLLECT] write failed for ${file}: ${(e as Error).message}`);
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  };

  const writeOutputs = () => {
    const now = bot.getServerTime();
    writeAtomic(featuresFile, JSON.stringify(collector.getFeatureSnapshot(now), null, 2));
    writeAtomic(signalsFile, JSON.stringify(collector.getLabels(), null, 2));
  };

  const writeTimer = setInterval(() => {
    collectAll();     // ensure features are current before snapshotting
    writeOutputs();
    resolveScored();  // resolve outcomes even when no new window is scored
    const s = collector.getStats();
    const d = deliverer.getStats();
    const sk = skillReport();
    console.log(
      `[COLLECT] labels=${s.labels} pending=${s.pending} assets=${s.assets} skipped=${s.skipped}` +
        ` | predictions total=${predictionStats.total} ml=${predictionStats.ml}` +
        ` | signals accepted=${predictionStats.accepted} rejected=${predictionStats.rejected}` +
        ` | skill resolved=${sk.resolved}` +
        ('accuracy' in sk
          ? ` acc=${(sk.accuracy * 100).toFixed(1)}% ci=[${sk.wilson95.map((x) => (x * 100).toFixed(1)).join(',')}]`
          : '') +
        ` | ai analyzed=${aiStats.analyzed} approved=${aiStats.approved}` +
        ` rejected=${aiStats.rejected} failed=${aiStats.failed}` +
        (d.enabled
          ? ` | telegram msgs=${d.sent} signals=${d.signals} failed=${d.failed}` +
            ` throttled=${d.throttled} dup=${d.duplicates} retries=${d.retries}`
          : '')
    );
  }, 15000);

  // --- Health endpoint (Render platform health checks) ---
  const PORT = Number(process.env.PORT) || 10000;
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const prices = new Map<string, number>();
      for (const a of bot.getAssetList()) {
        const p = bot.getPrice(a.id);
        if (p > 0) prices.set(a.id, p);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        connected: bot.isConnected(),
        assets: prices.size,
        prices: Object.fromEntries(prices),
        candlePeriod: `${candlePeriod}s`,
        labelHorizon: `${horizonSec}s`,
        predictor: predictor.name,
        inference: inference.getStats(),
        predictionStats,
        skill: skillReport(),
        ai: { ...analyst.getStats(), gate: aiStats },
        aiApprovals,
        predictions,
        validSignals,
        telegram: deliverer.getStats(),
        timestamp: Date.now(),
      }));
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  healthServer.listen(PORT, () => {
    console.log(`🩺 Health server listening on :${PORT} (/health)`);
  });
  // A busy port must not take the capture engine down with it: capture is the
  // job, /health is auxiliary. Without this handler Node's default 'error'
  // behaviour is to throw, which crashed the whole process (observed as a
  // restart loop when a previous instance still held :10000). Log, retry a few
  // times, and keep capturing either way.
  let healthRetries = 0;
  healthServer.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && healthRetries < 5) {
      healthRetries++;
      console.error(
        `[HEALTH] port ${PORT} in use; retrying in ${healthRetries * 5}s ` +
          `(capture continues)`
      );
      setTimeout(() => healthServer.listen(PORT), healthRetries * 5000).unref?.();
    } else {
      console.error(`[HEALTH] server error: ${e.message} — capture continues`);
    }
  });

  // --- Status printer ---
  let tickCount = 0;
  bot.onTick(() => { tickCount++; });
  const statusTimer = setInterval(() => {
    const candleTotals = bot
      .getAssetList()
      .map((a) => `${a.id.split('_')[0]}:${a.candles.length}`)
      .join(' ');
    console.log(`[STATUS] ticks=${tickCount} connected=${bot.isConnected()} candles=[${candleTotals}]`);
  }, 15000);

  /**
   * Flush state and exit cleanly. Idempotent: a second signal (or a SIGINT
   * racing a SIGTERM) returns immediately instead of re-running the flush.
   */
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\n\nShutting down...');
    try {
      collectAll();
      writeOutputs(); // flush current features + labels before exit
      const s = collector.getStats();
      console.log(`[COLLECT] final: labels=${s.labels} pending=${s.pending} assets=${s.assets}`);
      console.log(
        `[PREDICT] final: total=${predictionStats.total} ml=${predictionStats.ml} ` +
          `accepted=${predictionStats.accepted} rejected=${predictionStats.rejected}`
      );
      console.log(
        `[AI] final: analyzed=${aiStats.analyzed} approved=${aiStats.approved} ` +
          `rejected=${aiStats.rejected} failed=${aiStats.failed}`
      );
      // Drain any batched signals still inside the delivery window, so the
      // final bucket of a run is delivered rather than silently dropped.
      const d = deliverer.getStats();
      if (d.enabled) {
        console.log(
          `[DELIVER] final: msgs=${d.sent} signals=${d.signals} ` +
            `failed=${d.failed} throttled=${d.throttled} dup=${d.duplicates} ` +
            `retries=${d.retries}`
        );
      }
    } catch (e) {
      console.error(`[COLLECT] shutdown flush failed: ${(e as Error).message}`);
    }
    clearInterval(statusTimer);
    clearInterval(collectTimer);
    clearInterval(writeTimer);
    healthServer.close();
    bot.disconnect();
    // The batch timer is unref'd, so give the pending flush a moment to reach
    // Telegram before the process exits. Best-effort and time-bounded.
    void Promise.race([
      deliverer.flush(),
      new Promise((r) => setTimeout(r, 3000)),
    ]).finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  // Render/Docker stop containers with SIGTERM, not SIGINT. Without this the
  // process dies without flushing and the last write interval (up to 15s) of
  // observations is lost on every redeploy.
  process.on('SIGTERM', shutdown);
}

let shuttingDown = false;

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});