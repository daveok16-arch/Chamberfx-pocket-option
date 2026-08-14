#!/usr/bin/env tsx
/**
 * Signal Bot CLI — Live Pocket Option OTC Signal Generation
 * =========================================================
 *
 * Wires the verified price-capture engine (PocketOptionPriceBot from
 * server.ts) together with the leading SignalEngine (signal.ts) to
 * produce real-time CALL/PUT/WAIT signals for 1/3/5-minute expirations.
 *
 * Pipeline:
 *   1. Capture engine discovers the Pocket Option session (Playwright),
 *      authenticates, and streams live OTC ticks.
 *   2. Every tick is ingested into the SignalEngine.
 *   3. On each candle close (and on a periodic timer inside the candle),
 *      the SignalEngine evaluates confluence and emits a signal when
 *      confidence + cooldown + timing filters pass.
 *   4. Signals are printed and logged to signals.jsonl for review.
 *
 * Usage:
 *   npx tsx signal-bot.ts                  # default 1m expiry
 *   npx tsx signal-bot.ts --expiry 3        # 3-minute expiry
 *   npx tsx signal-bot.ts --expiry 5 --confidence 72
 */

import { PocketOptionPriceBot } from './server.js';
import { SignalEngine, type ExpiryMinutes, type Signal } from './signal.js';
import { telegram } from './telegram.js';
import * as fs from 'fs';
import * as http from 'http';

// ============================================
// CLI ARGS
// ============================================

function parseArgs(): { expiry: ExpiryMinutes; confidence: number; assets: string[] } {
  const args = process.argv.slice(2);
  // Defaults may be overridden by Render env vars (render.yaml sets EXPIRY/CONFIDENCE).
  let expiry: ExpiryMinutes = envExpiry();
  let confidence = envConfidence(72);
  const assets = [
    'EURUSD_otc',
    'GBPUSD_otc',
    'USDJPY_otc',
    'XAUUSD_otc',
    'AUDUSD_otc',
    'USDCAD_otc',
  ];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--expiry' || args[i] === '-e') {
      const v = Number(args[i + 1]);
      if (v === 1 || v === 3 || v === 5) expiry = v as ExpiryMinutes;
      i++;
    } else if (args[i] === '--confidence' || args[i] === '-c') {
      confidence = Number(args[i + 1]) || confidence;
      i++;
    }
  }
  return { expiry, confidence, assets };
}

/** EXPIRY env var → minutes (1|3|5). Falls back to 1. */
function envExpiry(): ExpiryMinutes {
  const v = Number(process.env.EXPIRY);
  return v === 3 || v === 5 ? v : 1;
}

/** CONFIDENCE env var → 0-100. Falls back to the provided default. */
function envConfidence(def: number): number {
  const v = Number(process.env.CONFIDENCE);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// ============================================
// MAIN
// ============================================

async function main() {
  const { expiry, confidence, assets } = parseArgs();

  console.log('\n===========================================');
  console.log('  Pocket Option OTC Signal Bot');
  console.log('  Leading next-candle direction prediction');
  console.log('===========================================');
  console.log(`  Expiry:     ${expiry} minute(s)`);
  console.log(`  Confidence: ${confidence}%`);
  console.log(`  Assets:     ${assets.join(', ')}`);
  console.log(`  Telegram:   ${telegram.isEnabled() ? 'ENABLED — signals will be delivered' : 'disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'}`);
  console.log('===========================================\n');

  const engine = new SignalEngine({
    expiryMinutes: expiry,
    minConfidence: confidence,
  });

  // Signal output sink — append every emitted signal to a JSONL log
  const logPath = './signals.jsonl';
  fs.writeFileSync(logPath, ''); // start fresh each run

  engine.onSignal((signal: Signal) => {
    printSignal(signal);
    fs.appendFileSync(logPath, JSON.stringify(signal) + '\n');
    // Deliver to Telegram (fire-and-forget; errors logged inside)
    void telegram.sendSignal(signal);
  });

  // Capture engine
  // candlePeriod MUST match the signal expiry (fix #1): the engine predicts
  // the next candle of `expiry` minutes, so the live candles built from ticks
  // and the history seeded from Pocket Option must be at the same granularity.
  const bot = new PocketOptionPriceBot({
    verbose: false, // suppress per-tick noise; signals are the focus
    saveToFile: true,
    outputFile: './live-prices.json',
    defaultAssets: assets,
    candlePeriod: expiry * 60,
  });

  // --- Wire ticks → signal engine ---
  bot.onTick((tick) => {
    engine.ingestTick(tick.assetId, tick);
  });

  // --- Evaluate on every candle close ---
  // A candle close = the capture engine just appended a new candle.
  // We evaluate the asset whose candle just closed. Pass the SERVER clock
  // (fix #2) so the engine's timing math aligns with candle boundaries.
  bot.onCandle((candle) => {
    const candles = bot.getCandles(candle.assetId);
    const price = bot.getPrice(candle.assetId);
    if (price > 0) {
      engine.evaluate(candle.assetId, candles, price, bot.getServerTime(), payoutFor(bot, candle.assetId));
    }
  });

  bot.onConnect(() => {
    console.log('✅ Connected to Pocket Option — live signal generation active\n');
    // Confirm to Telegram that the bot is live (only if enabled)
    void telegram.sendStartup();
    // Validate Telegram config (token + chat id) — logs precise errors, never throws
    void telegram.validate();
  });
  bot.onDisconnect(() => {
    console.log('⚠️ Disconnected — will attempt reconnect\n');
  });
  bot.onError((err) => {
    console.error(`❌ Capture error: ${err.message}\n`);
  });

  // --- Periodic evaluation inside the candle (catches signals between closes) ---
  // v3: evaluate every 15s (not 5s) — less noise, signals are deliberate.
  // Quality over quantity: the engine's own filters (HTF alignment, 3+ agreeing,
  // volatility gate, best-of-per-window) do the heavy lifting.
  const evalTimer = setInterval(() => {
    const serverNow = bot.getServerTime();
    for (const asset of assets) {
      const candles = bot.getCandles(asset);
      const price = bot.getPrice(asset);
      if (price > 0 && candles.length > 0) {
        engine.evaluate(asset, candles, price, serverNow, payoutFor(bot, asset));
      }
    }
  }, 15000);

  await bot.connect();

  // --- Health HTTP server (for Render.com / platform health checks) ---
  // Render web services expect a responding HTTP port. We expose a tiny server
  // returning current bot status. PORT defaults to 10000 (Render convention).
  const PORT = Number(process.env.PORT) || 10000;
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const assetList = bot.getAssetList();
      const prices = new Map<string, number>();
      for (const a of assetList) {
        const p = bot.getPrice(a.id);
        if (p > 0) prices.set(a.id, p);
      }
      const lastSignals = assetList.map(a => engine.getLastSignal(a.id)).filter(Boolean) as Signal[];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        // Reflect the actual capture-engine connection state (fix #18): a
        // hardcoded `true` would make the health check pass while the WS is
        // down and mid-reconnect, hiding outages from Render.
        connected: bot.isConnected(),
        assets: prices.size,
        prices: Object.fromEntries(prices),
        recentSignals: lastSignals.length,
        expiry: `${expiry}m`,
        telegram: telegram.isEnabled(),
        timestamp: Date.now(),
      }));
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  healthServer.listen(PORT, () => {
    console.log(`🩺 Health server listening on :${PORT} (/health)`);
  });

  // --- Status printer: shows the engine is alive and receiving data ---
  let tickCount = 0;
  bot.onTick(() => { tickCount++; });
  let statusCounter = 0;
  const statusTimer = setInterval(() => {
    const assets = bot.getAssetList();
    const candleTotals = assets.map(a => `${a.id.split('_')[0]}:${a.candles.length}`).join(' ');
    const serverNow = bot.getServerTime();

    // Show the best (highest |confidence|) live evaluation for visibility
    let best: { id: string; dir: string; conf: number; comp: string } | null = null;
    for (const a of assets) {
      const price = bot.getPrice(a.id);
      const candles = bot.getCandles(a.id);
      if (price > 0 && candles.length > 0) {
        const s = engine.evaluate(a.id, candles, price, serverNow, payoutFor(bot, a.id));
        const comp = `ofi:${s.components.ofi} can:${s.components.candleSignal} mom:${s.components.momentum} str:${s.components.structure} htf:${s.components.htfTrend}${s.components.htfAligned ? '' : 'x'} ${s.components.agreeing}/4`;
        if (!best || Math.abs(s.confidence) > best.conf) {
          best = { id: a.id, dir: s.direction, conf: s.confidence, comp };
        }
      }
    }
    const lastSignals = assets.map(a => {
      const s = engine.getLastSignal(a.id);
      return s ? `${a.id.split('_')[0]}:${s.direction}/${s.confidence}` : null;
    }).filter(Boolean).join(' ');
    console.log(
      `[STATUS] ticks=${tickCount} candles=[${candleTotals}] bestEval=${
        best ? `${best.id.split('_')[0]} ${best.dir}/${best.conf}% [${best.comp}]` : 'n/a'
      } lastSig=[${lastSignals || 'none'}]`
    );

    // Telegram heartbeat every ~5 min (20 * 15s) — only if enabled & connected
    statusCounter++;
    if (telegram.isEnabled() && statusCounter % 20 === 0) {
      const prices = new Map<string, number>();
      const candleCounts = new Map<string, number>();
      for (const a of assets) {
        const p = bot.getPrice(a.id);
        if (p > 0) {
          prices.set(a.id, p);
          candleCounts.set(a.id, a.candles.length);
        }
      }
      if (prices.size > 0) void telegram.sendHeartbeat(prices, candleCounts);
    }
  }, 15000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    clearInterval(evalTimer);
    clearInterval(statusTimer);
    healthServer.close();
    bot.disconnect();
    console.log(`Signals logged to ${logPath}`);
    process.exit(0);
  });
}

// ============================================
// HELPERS
// ============================================

/** Look up the broker payout fraction for an asset (0..1), defaulting to 0.92. */
function payoutFor(bot: PocketOptionPriceBot, assetId: string): number {
  const a = bot.getAssetList().find(x => x.id === assetId);
  return a && a.payout > 0 ? a.payout : 0.92;
}

// ============================================
// SIGNAL PRINTER
// ============================================

function printSignal(s: Signal): void {
  const emoji = s.direction === 'CALL' ? '🟢' : s.direction === 'PUT' ? '🔴' : '⚪';
  const time = new Date(s.timestamp).toISOString().split('T')[1].slice(0, 8);
  const payoutPct = Math.round(s.payout * 100);

  console.log('');
  console.log('===========================================');
  console.log(`${emoji} ${s.direction} SIGNAL — ${s.assetId} (payout ${payoutPct}%)`);
  console.log('===========================================');
  console.log(`  Entry Price:   ${s.entryPrice.toFixed(5)}`);
  console.log(`  Confidence:    ${s.confidence}%`);
  console.log(`  Expiry:         ${s.expiryMinutes}m`);
  console.log(`  Time Left:      ${s.timeRemainingSec}s (${s.entryQuality})`);
  console.log(`  Time:           ${time}`);
  console.log('  -----------------------------------------');
  console.log('  Components (leading, non-lagging):');
  console.log(`    OFI:            ${s.components.ofi > 0 ? '+' : ''}${s.components.ofi}  (order-flow imbalance)`);
  console.log(`    Candle:         ${s.components.candleSignal > 0 ? '+' : ''}${s.components.candleSignal}  [${s.components.candlePattern}]`);
  console.log(`    Momentum:       ${s.components.momentum > 0 ? '+' : ''}${s.components.momentum}${s.components.momentumDecay > 0.5 ? '  (decaying)' : ''}`);
  console.log(`    Structure:      ${s.components.structure > 0 ? '+' : ''}${s.components.structure}  [${s.components.structureLabel}]`);
  console.log(`    Regime:         ${s.components.regime}  (strength ${s.components.regimeStrength.toFixed(2)})`);
  console.log(`    HTF Trend:      ${s.components.htfTrend}  (${s.components.htfAligned ? 'aligned' : 'NOT aligned'})`);
  console.log(`    Confluence:     ${s.components.agreeing}/4 agree | range ratio ${s.components.rangeRatio.toFixed(2)}`);
  console.log('  -----------------------------------------');
  console.log('  Reasons:');
  for (const r of s.reasons) {
    console.log(`    • ${r}`);
  }
  console.log('===========================================\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
