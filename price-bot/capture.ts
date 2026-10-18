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
import { LocalPredictor, PredictionRouter } from './predictor.js';
import { TelegramDeliverer } from './deliverer.js';
import * as fs from 'fs';
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

  // --- Prediction: score EVERY window at the 60s bucket boundary -------
  // A prediction bot must always predict. The ML service is preferred when
  // INFERENCE_URL is set and a model is trained; otherwise the local baseline
  // answers, so the bot never goes silent. Every prediction is emitted (logged
  // and delivered); the Phase 3 filters additionally mark which ones cleared
  // the confidence/volatility bar.
  const inference = new InferenceClient();
  const predictor = new PredictionRouter(
    inference.isEnabled() ? inference : null,
    new LocalPredictor()
  );
  console.log(`[PREDICT] active predictor: ${predictor.name}`);

  const predictions: Record<string, PredictionResult> = {};
  /** Most recent signal that cleared every filter, per asset. */
  const validSignals: Record<string, ValidSignal> = {};
  /** Rolling counts for observability. */
  const predictionStats = { total: 0, ml: 0, local: 0, accepted: 0, rejected: 0 };

  const deliverer = new TelegramDeliverer();

  collector.onBucketBoundary((asset: string, features: FeatureWindow) => {
    // Fire-and-forget: scoring must not block the evaluate loop.
    void predictor
      .predict(asset, features)
      .then((result) => {
        if (!result) return;
        predictions[asset] = result;
        predictionStats.total++;
        if (result.source === 'ml') predictionStats.ml++;
        else predictionStats.local++;

        const tag = result.source === 'ml' ? 'ML' : 'BASE';
        console.log(
          `[PREDICT] ${asset} P(UP)=${result.probability.toFixed(4)} ` +
            `-> ${result.direction === 1 ? 'UP(1)' : 'DOWN(0)'} [${tag}]`
        );

        // Phase 3: gate the raw prediction. A rejection is normal operation,
        // not an error — it only means the window was not tradeable.
        const outcome = evaluateSignal(result, features);
        if (!outcome.accepted) {
          predictionStats.rejected++;
          console.log(`[SIGNAL_FILTER] Signal discarded: ${outcome.detail}`);
          return;
        }

        predictionStats.accepted++;
        validSignals[asset] = outcome.signal;
        console.log(`[VALID_SIGNAL] ${JSON.stringify(outcome.signal)}`);
        void deliverer.send(outcome.signal, features, result.source ?? 'unknown');
      });
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
    const s = collector.getStats();
    const d = deliverer.getStats();
    console.log(
      `[COLLECT] labels=${s.labels} pending=${s.pending} assets=${s.assets} skipped=${s.skipped}` +
        ` | predictions total=${predictionStats.total}` +
        ` ml=${predictionStats.ml} base=${predictionStats.local}` +
        ` | signals accepted=${predictionStats.accepted} rejected=${predictionStats.rejected}` +
        (d.enabled ? ` | telegram sent=${d.sent} failed=${d.failed} throttled=${d.throttled}` : '')
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
          `base=${predictionStats.local} accepted=${predictionStats.accepted} ` +
          `rejected=${predictionStats.rejected}`
      );
    } catch (e) {
      console.error(`[COLLECT] shutdown flush failed: ${(e as Error).message}`);
    }
    clearInterval(statusTimer);
    clearInterval(collectTimer);
    clearInterval(writeTimer);
    healthServer.close();
    bot.disconnect();
    process.exit(0);
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