#!/usr/bin/env tsx
/**
 * Trade Bot CLI — Live Pocket Option OTC Trading (layered infrastructure)
 * ======================================================================
 *
 * The new infrastructure is a clean, three-layer pipeline:
 *
 *   1. STRATEGY  (strategy.ts)  — the ONLY place that decides direction.
 *      Pluggable; a reference (candle-direction) strategy is provided.
 *   2. RISK      (risk.ts)      — hard safety gates: stake cap, per-asset
 *      cooldown, rolling 24h loss-stop, concurrent-position cap, price sanity.
 *   3. EXECUTION (execution.ts) — raises the actual trade (openOrder protocol)
 *      over the authenticated Pocket Option session. Defaults to PAPER mode.
 *
 * SAFETY: by default this bot is in PAPER (simulated) trading mode — it never
 * sends a real order. To arm real-money execution you must BOTH:
 *   - set ALLOW_LIVE=1, AND
 *   - confirm the authenticated session is a non-demo (real) account.
 * The risk layer refuses live trades unless ALLOW_LIVE=1 is present.
 *
 * Usage:
 *   npx tsx trade-bot.ts                # default 1m candles, PAPER mode
 *   npx tsx trade-bot.ts --period 180   # 3-minute candles
 *   ALLOW_LIVE=1 npx tsx trade-bot.ts   # only if you truly mean real money
 */

import { PocketOptionPriceBot } from './server.js';
import * as http from 'http';
import { MultiAssetReversionStrategy, type Strategy, type StrategyContext } from './strategy.js';
import { RiskManager } from './risk.js';
import { ExecutionEngine } from './execution.js';

// ============================================
// CLI ARGS
// ============================================

/**
 * Parse command-line arguments and environment variables for bot configuration.
 * @returns Configuration object with candle period (60/180/300 seconds) and asset list
 */
function parseArgs(): { candlePeriod: number; assets: string[] } {
  const args = process.argv.slice(2);
  const assets = [
    'EURUSD_otc',
    'GBPUSD_otc',
    'USDJPY_otc',
    'XAUUSD_otc',
    'AUDUSD_otc',
    'USDCAD_otc',
  ];

  const fromEnv = Number(process.env.PERIOD); // e.g. PERIOD=180 on Render
  let candlePeriod = [60, 180, 300].includes(fromEnv) ? fromEnv : 60;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--period' || args[i] === '-p') {
      const v = Number(args[i + 1]);
      if ([60, 180, 300].includes(v)) candlePeriod = v;
      i++;
    }
  }
  return { candlePeriod, assets };
}

// ============================================
// STRATEGY / RISK / EXECUTION WIRING
// ============================================

/**
 * Run one decision cycle for an asset: ask the strategy for a proposal, gate
 * it through the risk layer, then (if allowed) submit it to the executor.
 * @param bot - Price bot instance providing market data
 * @param strategy - Strategy instance that proposes trades
 * @param risk - Risk manager that gates trades through safety checks
 * @param executor - Execution engine that submits approved trades
 * @param asset - Asset identifier to evaluate
 */
async function evaluateAsset(
  bot: PocketOptionPriceBot,
  strategy: Strategy,
  risk: RiskManager,
  executor: ExecutionEngine,
  asset: string
): Promise<void> {
  const price = bot.getPrice(asset);
  const candles = bot.getCandles(asset);
  if (!(price > 0) || candles.length === 0) return;

  const ctx: StrategyContext = {
    price,
    candles,
    serverTime: bot.getServerTime(),
  };

  const proposal = strategy.evaluate(ctx, asset);
  if (!proposal) return;

  const live = executor.isLive();
  const decision = risk.allow(asset, price, proposal.amount, ctx.serverTime, live);
  if (!decision.allowed) {
    console.log(`[RISK] BLOCKED ${proposal.direction.toUpperCase()} ${asset} — ${decision.reason}`);
    return;
  }

  const result = await executor.submit(
    {
      asset,
      amount: decision.maxAmount,
      direction: proposal.direction,
      duration: proposal.duration,
      source: strategy.name,
    },
    decision
  );
  if (result) {
    risk.registerOpen(result.requestId, result.asset, result.amount, result.placedAt);
    // Schedule settlement when the binary option expires
    setTimeout(() => {
      // Realized P&L: for PAPER mode we don't have the actual outcome, so we settle at 0
      // (a production implementation would track the actual strike vs settlement price)
      risk.settle(result.requestId, 0, bot.getServerTime());
    }, result.duration * 1000);
  }
}

// ============================================
// MAIN
// ============================================

/**
 * Main entry point for the trade bot.
 * Initializes the strategy/risk/execution pipeline and connects to Pocket Option.
 */
async function main() {
  const { candlePeriod, assets } = parseArgs();

  // SAFETY: live execution requires the explicit ALLOW_LIVE=1 env var. Without
  // it, the whole pipeline runs in PAPER mode and never sends a real order.
  const allowLive = process.env.ALLOW_LIVE === '1';
  // Multi-asset, small-stake range-reversion on all 6 OTC pairs.
  const strategy: Strategy = new MultiAssetReversionStrategy({
    amount: 1,          // small, equal stake per asset
    duration: candlePeriod, // match expiry to the candle period
    minCandles: 20,
    minRangeRatio: 0.0004,
    lookback: 8,
    maxTrendSlope: 0.0005,
  });
  const risk = new RiskManager({
    maxAmountPerTrade: 5,     // hard per-trade stake cap
    cooldownMs: 180_000,      // 3 min between trades on the same asset
    maxDailyLoss: 50,         // halt after -50 rolling 24h
    maxConcurrentTrades: 3,   // no more than 3 unresolved positions
    live: allowLive,
  });

  const bot = new PocketOptionPriceBot({
    verbose: false,
    saveToFile: true,
    outputFile: './live-prices.json',
    defaultAssets: assets,
    candlePeriod,
  });
  const executor = new ExecutionEngine(bot, { live: allowLive });

  const modeLabel = allowLive ? 'LIVE (real money)' : '🎯 PAPER (simulated — no real orders sent)';
  console.log('\n===========================================');
  console.log('  Pocket Option OTC — Trade Bot (layered)');
  console.log('===========================================');
  console.log(`  Candle period:   ${candlePeriod}s`);
  console.log(`  Assets:          ${assets.join(', ')}`);
  console.log(`  Strategy:        ${strategy.name}`);
  console.log(`  Mode:            ${modeLabel}`);
  console.log(`  Stake cap:       $5/trade (live only with ALLOW_LIVE=1)`);
  console.log('===========================================\n');

  bot.onConnect(() => console.log('✅ Connected to Pocket Option — live capture active\n'));
  bot.onDisconnect(() => console.log('⚠️ Disconnected — will attempt reconnect\n'));
  bot.onError((err) => console.error(`❌ Capture error: ${err.message}\n`));

  await bot.connect();

  // --- Health HTTP server (for Render.com / platform health checks) ---
  const PORT = Number(process.env.PORT) || 10000;
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const assetList = bot.getAssetList();
      const prices = new Map<string, number>();
      for (const a of assetList) {
        const p = bot.getPrice(a.id);
        if (p > 0) prices.set(a.id, p);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        connected: bot.isConnected(),
        mode: executor.isLive() ? 'LIVE' : 'PAPER',
        assets: prices.size,
        prices: Object.fromEntries(prices),
        candlePeriod: `${candlePeriod}s`,
        timestamp: Date.now(),
      }));
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  healthServer.listen(PORT, () => {
    console.log(`🩺 Health server listening on :${PORT} (/health)`);
  });

  // --- Evaluate each asset on candle close (entry point for the pipeline) ---
  bot.onCandle((candle) => {
    void evaluateAsset(bot, strategy, risk, executor, candle.assetId);
  });

  // --- Periodic evaluate inside the candle (catches setups between closes) ---
  const evalTimer = setInterval(() => {
    for (const asset of assets) {
      void evaluateAsset(bot, strategy, risk, executor, asset);
    }
  }, 15000);

  // --- Status printer: shows the engine is alive + mode ---
  let tickCount = 0;
  bot.onTick(() => { tickCount++; });
  const statusTimer = setInterval(() => {
    const list = bot.getAssetList();
    const candleTotals = list.map(a => `${a.id.split('_')[0]}:${a.candles.length}`).join(' ');
    console.log(`[STATUS] ticks=${tickCount} mode=${executor.isLive() ? 'LIVE' : 'PAPER'} connected=${bot.isConnected()} candles=[${candleTotals}]`);
  }, 15000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    clearInterval(evalTimer);
    clearInterval(statusTimer);
    healthServer.close();
    bot.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});