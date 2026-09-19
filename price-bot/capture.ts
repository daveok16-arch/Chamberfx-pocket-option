#!/usr/bin/env tsx
/**
 * Live Price Capture — entrypoint
 * ===============================
 * Connects to Pocket Option over the authenticated Socket.IO WebSocket, streams
 * real-time OTC ticks, and builds candles. This is pure market-data capture:
 * there is NO strategy, risk, execution, or paper-trading layer here.
 *
 * The `PocketOptionPriceBot` (server.ts) is the reusable capture engine. An ML
 * pipeline consumes it via `getCandles()` / `getPrice()` / `getTicks()` /
 * `onCandle` / `onTick`, or by tailing `live-prices.json`.
 *
 * Usage:
 *   npx tsx capture.ts                 # 1m candles
 *   npx tsx capture.ts --period 180    # 3m candles
 *   PERIOD=300 npx tsx capture.ts      # via env (used by Render)
 */

import { PocketOptionPriceBot } from './server.js';
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
    saveToFile: true,
    outputFile: './live-prices.json',
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

  // --- Periodic snapshot to live-prices.json (for offline / ML use) ---
  const saveTimer = setInterval(() => {
    if (bot.isConnected()) bot.savePricesToFile();
  }, 30000);

  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    clearInterval(statusTimer);
    clearInterval(saveTimer);
    healthServer.close();
    bot.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});