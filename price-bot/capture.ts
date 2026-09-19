#!/usr/bin/env tsx
/**
 * Live Price Capture + Feature/Label Collection — entrypoint
 * ==========================================================
 * Connects to Pocket Option over the authenticated Socket.IO WebSocket, streams
 * real-time OTC ticks, and builds candles. On top of that, the Phase 1
 * feature/label collector turns the feed into a supervised-learning dataset:
 *
 *   - 60s rolling feature windows per asset  -> `live-prices.json`
 *   - binary outcome labels resolved 60s later -> `signals.json`
 *
 * There is NO strategy decisioning, risk, execution, or ML code here.
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

async function main() {
  const candlePeriod = parsePeriod();

  const bot = new PocketOptionPriceBot({
    verbose: false,
    defaultAssets: DEFAULT_ASSETS,
    candlePeriod,
  });

  console.log('\n===========================================');
  console.log('  Pocket Option OTC — Live Price Capture');
  console.log('===========================================');
  console.log(`  Candle period:   ${candlePeriod}s`);
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
  const collector = new FeatureLabelCollector({
    featuresFile: './live-prices.json',
    signalsFile: './signals.json',
  });

  // --- Inference: score each window at the 60s bucket boundary ---------
  // Enabled only when INFERENCE_URL is set, so collection still runs
  // standalone with no Python service present.
  const inference = new InferenceClient();
  const predictions: Record<string, PredictionResult> = {};

  collector.onBucketBoundary((asset: string, features: FeatureWindow) => {
    // Fire-and-forget: the async request must not block the evaluate loop.
    void inference
      .predict(asset, features)
      .then((result) => {
        if (!result) return;
        predictions[asset] = result;
        console.log(
          `[INFER] ${asset} P(UP)=${result.probability.toFixed(4)} ` +
            `-> ${result.direction === 1 ? 'UP(1)' : 'DOWN(0)'}`
        );
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
  const writeOutputs = () => {
    const now = bot.getServerTime();
    try {
      fs.writeFileSync(
        './live-prices.json',
        JSON.stringify(collector.getFeatureSnapshot(now), null, 2)
      );
    } catch (e) {
      console.error(`[COLLECT] feature write failed: ${(e as Error).message}`);
    }
    try {
      fs.writeFileSync('./signals.json', JSON.stringify(collector.getLabels(), null, 2));
    } catch (e) {
      console.error(`[COLLECT] label write failed: ${(e as Error).message}`);
    }
  };

  const writeTimer = setInterval(() => {
    collectAll();     // ensure features are current before snapshotting
    writeOutputs();
    const s = collector.getStats();
    const inf = inference.getStats();
    console.log(
      `[COLLECT] labels=${s.labels} pending=${s.pending} assets=${s.assets} skipped=${s.skipped}` +
        (inf.enabled ? ` | predictions ok=${inf.successes} failed=${inf.failures}` : '')
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
        inference: inference.getStats(),
        predictions,
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

  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    collectAll();
    writeOutputs(); // flush current features + labels before exit
    const s = collector.getStats();
    console.log(`[COLLECT] final: labels=${s.labels} pending=${s.pending} assets=${s.assets}`);
    clearInterval(statusTimer);
    clearInterval(collectTimer);
    clearInterval(writeTimer);
    healthServer.close();
    bot.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});