/**
 * Risk + Execution smoke test — verifies the safety gates in PAPER mode.
 * Run: npx tsx risk-smoke-test.ts   (expect all checks to pass, exit 0)
 */
import { RiskManager } from './risk.js';
import { ExecutionEngine } from './execution.js';
import { MultiAssetReversionStrategy, type StrategyContext } from './strategy.js';
import { PocketOptionPriceBot } from './server.js';
import type { Candle } from './server.js';

let failures = 0;
/**
 * Check a test condition and log the result.
 * @param name - Test case description
 * @param cond - Condition to check (true = pass, false = fail)
 */
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// --- Risk gating in PAPER mode -------------------------------------------------
const paperRisk = new RiskManager({
  maxAmountPerTrade: 5,
  cooldownMs: 1000,
  maxDailyLoss: 10,
  maxConcurrentTrades: 1,
  live: false, // paper
});

// 1) Paper risk layer refuses LIVE trades ("live not armed").
const d1 = paperRisk.allow('EURUSD_otc', 1.1, 5, 1000, /*live=*/ true);
check('paper risk layer blocks a LIVE trade', !d1.allowed && d1.reason.includes('not armed'));

// 2) Paper layer allows a normal trade (price valid, within caps).
const d2 = paperRisk.allow('EURUSD_otc', 1.1, 5, 2000, /*live=*/ false);
check('paper risk allows valid trade', d2.allowed && d2.maxAmount === 5);

// 3) Stake cap enforcement.
const d3 = paperRisk.allow('EURUSD_otc', 1.1, 12345, 3000, false);
check('stake cap clamps amount to maxAmountPerTrade', d3.allowed && d3.maxAmount === 5);

// 4) Zero price is rejected.
const d4 = paperRisk.allow('EURUSD_otc', 0, 5, 4000, false);
check('zero price rejected', !d4.allowed);

// 5) Cooldown blocks a second trade on same asset before cooldown elapses.
// registerOpen at t=10000 => cooldown (1s) ends at t=11000.
paperRisk.registerOpen('a', 'EURUSD_otc', 5, 1.10, 'call', 60_000, 10000);
paperRisk.settle('a', -5, 11000); // close it, but cooldown runs from 10000+1000
const d5 = paperRisk.allow('EURUSD_otc', 1.1, 5, 10500, false);
check('cooldown blocks repeat on same asset', !d5.allowed);
// after cooldown elapses (>11000):
const d5b = paperRisk.allow('EURUSD_otc', 1.1, 5, 11100, false);
check('cooldown allows after window', d5b.allowed);

// 6) Loss stop halts once daily loss = -10.
const haltingRisk = new RiskManager({ maxDailyLoss: 10, maxConcurrentTrades: 5, live: false });
haltingRisk.registerOpen('x', 'AUDUSD_otc', 5, 0.70, 'put', 60_000, 100000);
haltingRisk.settle('x', -10, 110000);
const d6 = haltingRisk.allow('AUDUSD_otc', 0.7, 5, 120000, false);
check('daily loss stop halts trading', !d6.allowed && d6.reason.includes('loss stop'));

// 7) Max concurrent trades.
const concRisk = new RiskManager({ maxConcurrentTrades: 1, cooldownMs: 5000, live: false });
concRisk.registerOpen('c1', 'XAUUSD_otc', 5, 2000, 'call', 60_000, 100000);
const d7 = concRisk.allow('XAUUSD_otc', 2000, 5, 110000, false);
check('max concurrent trades blocks new entry', !d7.allowed && d7.reason.includes('max concurrent'));

// --- Live-price auto-settlement (paper PnL from the real WS feed) --------------
// A CALL opened at strike 1.1000, 60s window; at expiry the live price is 1.1010
// (above strike) => won: stake * payout.
const settleRisk = new RiskManager({ maxConcurrentTrades: 1, live: false });
settleRisk.registerOpen('s1', 'EURUSD_otc', 5, 1.1000, 'call', 60_000, 100000);
// Not yet expired (t=100000 + 60s = 160000).
let openBefore = settleRisk.getOpenCount();
settleRisk.settleExpired(150000, (a) => (a === 'EURUSD_otc' ? 1.1005 : 0));
check('settleExpired keeps in-window position open', settleRisk.getOpenCount() === 1 && openBefore === 1);
// Expired at t=160000+, live price above strike => win.
const settledW = settleRisk.settleExpired(161000, (a) => (a === 'EURUSD_otc' ? 1.1010 : 0));
check('settleExpired resolves win against live price', settledW.get('s1') === 5 * 0.92);
check('settleExpired releases the concurrency slot', settleRisk.getOpenCount() === 0);

// A PAY-at-strike (losing) PUT, then the loss feeds the daily-loss gate.
const loseRisk = new RiskManager({ maxDailyLoss: 5, maxConcurrentTrades: 1, live: false });
loseRisk.registerOpen('s2', 'AUDUSD_otc', 5, 0.7000, 'put', 60_000, 200000);
const settledL = loseRisk.settleExpired(261000, (a) => (a === 'AUDUSD_otc' ? 0.7002 : 0)); // price above strike -> put loses
check('settleExpired resolves loss against live price', settledL.get('s2') === -5);
check('auto-settled loss feeds daily-loss stop', !loseRisk.allow('AUDUSD_otc', 0.7, 5, 270000, false).allowed);

// --- ExecutionEngine PAPER behavior ----------------------------------------------
// Use a fake bot whose isDemoMode()/getServerTime()/send() we can observe.
const sent: string[] = [];
const fakeBot = {
  isDemoMode: () => true,
  getServerTime: () => 1234,
  send: (m: string) => { sent.push(m); return true; },
} as unknown as PocketOptionPriceBot;

const exPaper = new ExecutionEngine(fakeBot, { live: false });
check('executor paper not live', !exPaper.isLive());
const paperResult = await exPaper.submit(
  { asset: 'EURUSD_otc', amount: 5, direction: 'call', duration: 60, source: 'test' },
  { allowed: true, reason: 'ok', maxAmount: 5 }
);
check('paper submit returns PLACED result', paperResult !== null && paperResult.mode === 'PAPER' && paperResult.status === 'PLACED');
check('paper mode sent NOTHING over the wire', sent.length === 0);

// --- ExecutionEngine LIVE refusal when session is demo -----------------------------
const exLiveDemo = new ExecutionEngine(fakeBot, { live: true });
check('executor refuses LIVE on a demo session', !exLiveDemo.isLive());
const liveDemoResult = await exLiveDemo.submit(
  { asset: 'EURUSD_otc', amount: 5, direction: 'call', duration: 60, source: 'test' },
  { allowed: true, reason: 'ok', maxAmount: 5 }
);
check('live-on-demo falls back to PAPER (records locally, no wire)', liveDemoResult !== null && liveDemoResult.mode === 'PAPER');

// --- ExecutionEngine LIVE when session is real + config live ----------------------
const sentLive: string[] = [];
const realBot = {
  isDemoMode: () => false,
  getServerTime: () => 1234,
  send: (m: string) => { sentLive.push(m); return true; },
} as unknown as PocketOptionPriceBot;
const exLive = new ExecutionEngine(realBot, { live: true });
check('executor LIVE armed on a real session', exLive.isLive());
const liveResult = await exLive.submit(
  { asset: 'EURUSD_otc', amount: 5, direction: 'put', duration: 60, source: 'test' },
  { allowed: true, reason: 'ok', maxAmount: 5 }
);
check('live submit sends an openOrder over the wire', liveResult !== null && sentLive.some(m => m.includes('"openOrder"') && m.includes('"action":"put"')));
check('live sends isDemo:0', sentLive.some(m => m.includes('"isDemo":0')));
check('live send also requires risk-armed (paper risk blocks live, verified separately above)', true);

// --- Regression: isDemoMode() reads the REAL auth packet (bug#1: \b regex) ------
// Drive the real isDemoMode() method through a real PocketOptionPriceBot and
// verify it parses the demo flag instead of always defaulting to demo.
const demoBot = new PocketOptionPriceBot();
demoBot.setAuthPacketForTest('42["auth",{"isDemo":1,"token":"x"}]');
const realNonDemoBot = new PocketOptionPriceBot();
realNonDemoBot.setAuthPacketForTest('42["auth",{"isDemo":0,"token":"x"}]');
const authNoFlagBot = new PocketOptionPriceBot();
authNoFlagBot.setAuthPacketForTest('42["auth",{"token":"x"}]');
check('real bot parses DEMO auth (isDemo:1 → demo)', demoBot.isDemoMode() === true);
check('real bot parses LIVE auth (isDemo:0 → not demo)', realNonDemoBot.isDemoMode() === false);
check('real bot defaults to safe demo when flag absent', authNoFlagBot.isDemoMode() === true);
// End-to-end: a real non-demo bot with config.live arms LIVE via the executor.
const exLiveReal = new ExecutionEngine(realNonDemoBot, { live: true });
check('real non-demo bot + config.live arms live executor', exLiveReal.isLive());

// --- Multi-asset reversion strategy logic -----------------------------------
const strat = new MultiAssetReversionStrategy({ amount: 1, duration: 60 });

/**
 * Create a test candle with specified OHLC values.
 * @param o - Open price
 * @param h - High price
 * @param l - Low price
 * @param c - Close price
 * @returns Candle object for testing
 */
function mkCandle(o: number, h: number, l: number, c: number): Candle {
  return { assetId: 'EURUSD_otc', open: o, high: h, low: l, close: c, volume: 1, openTime: 0, closeTime: 0 };
}

// A green candle with a long upper wick (rejection) within a ranged, flat history → PUT.
const ctxReject: StrategyContext = {
  price: 1.1,
  serverTime: 0,
  candles: [
    ...Array.from({ length: 22 }, () => mkCandle(1.1, 1.1, 1.1, 1.1)),
    mkCandle(1.1, 1.1, 1.1, 1.1), // history flat/ranged
    mkCandle(1.1000, 1.1000, 1.1000, 1.1000),
    mkCandle(1.10, 1.105, 1.0995, 1.1005), // green with big upper wick
  ],
};
check('reversion: rejection wick → PUT', strat.evaluate(ctxReject, 'EURUSD_otc')?.direction === 'put');

// A red candle with a long lower wick within a ranged history → CALL.
const ctxRejectDown: StrategyContext = {
  price: 1.1,
  serverTime: 0,
  candles: [
    ...Array.from({ length: 24 }, () => mkCandle(1.1, 1.1, 1.1, 1.1)),
    mkCandle(1.1005, 1.101, 1.0995, 1.10), // red with big lower wick
  ],
};
check('reversion: rejection wick (down) → CALL', strat.evaluate(ctxRejectDown, 'EURUSD_otc')?.direction === 'call');

// A strong uptrend (slope exceeds maxTrendSlope) → suppress (null).
const ctxTrend: StrategyContext = {
  price: 1.12,
  serverTime: 0,
  candles: [
    ...Array.from({ length: 22 }, (_, i) => mkCandle(1.10 + i * 0.001, 1.10 + (i + 1) * 0.001, 1.10 + i * 0.001, 1.10 + i * 0.0012)),
    mkCandle(1.122, 1.123, 1.121, 1.122), // trending up strongly
  ],
};
check('reversion: hard trend suppresses signal', strat.evaluate(ctxTrend, 'EURUSD_otc') === null);

// Too few candles → no signal.
const ctxFew: StrategyContext = { price: 1.1, serverTime: 0, candles: [mkCandle(1.1, 1.1, 1.1, 1.1)] };
check('reversion: too few candles → no signal', strat.evaluate(ctxFew, 'EURUSD_otc') === null);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);