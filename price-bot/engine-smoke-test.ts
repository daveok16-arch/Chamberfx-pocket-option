/**
 * Offline smoke test for the SignalEngine (no network).
 *
 * Feeds synthetic ticks + candles that contain a clear directional setup and
 * asserts the engine returns a non-WAIT (CALL/PUT) signal with sane component
 * values. Also exercises the regime low-variance guard and the clock-skew-safe
 * timing path. Verifies the engine logic end-to-end without a live capture.
 *
 * Run: npx tsx engine-smoke-test.ts
 */
import { SignalEngine } from './signal.js';
import type { Tick, Candle } from './server.js';

const ASSET = 'EURUSD_otc';
const periodMs = 60_000;

function makeCandles(n: number, trend: 1 | -1): Candle[] {
  const out: Candle[] = [];
  let price = 1.08500;
  const baseOpen = 1_700_000_000_000; // arbitrary fixed server-clock epoch
  for (let i = 0; i < n; i++) {
    const openTime = baseOpen + i * periodMs;
    const closeTime = openTime + periodMs - 1;
    const open = price;
    // strong trending candle: body = ~12 pips in trend direction, small wicks
    const close = +(open + trend * 0.00012).toFixed(5);
    const high = trend > 0 ? close + 0.00003 : open + 0.00003;
    const low = trend > 0 ? open - 0.00003 : close - 0.00003;
    out.push({
      assetId: ASSET, open, high, low: low, close,
      volume: 20, openTime, closeTime: closeTime,
    });
    price = close;
  }
  return out;
}

function feedTicks(engine: SignalEngine, candles: Candle[]): void {
  // Feed enough up ticks to build order-flow imbalance in the up direction.
  const last = candles[candles.length - 1];
  for (let i = 0; i < 30; i++) {
    const p = +(last.close + i * 0.00001).toFixed(5);
    const tick: Tick = {
      assetId: ASSET,
      price: p,
      timestamp: last.closeTime - (30 - i) * 100,
      direction: 'UP', // net-up tick stream for the CALL setup
    };
    engine.ingestTick(ASSET, tick);
  }
}

function feedTicksDown(engine: SignalEngine, candles: Candle[]): void {
  const last = candles[candles.length - 1];
  for (let i = 0; i < 30; i++) {
    const p = +(last.close - i * 0.00001).toFixed(5);
    const tick: Tick = {
      assetId: ASSET,
      price: p,
      timestamp: last.closeTime - (30 - i) * 100,
      direction: 'DOWN', // net-down tick stream for the PUT setup
    };
    engine.ingestTick(ASSET, tick);
  }
}

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✅ ${msg}`);
  } else {
    console.error(`  ❌ ${msg}`);
    failures++;
  }
}

console.log('=== SignalEngine smoke test ===\n');

// --- Test 1: bullish trend produces a CALL (or at least a decisive direction) ---
console.log('[1] Bullish trend → CALL signal');
{
  const engine = new SignalEngine({ expiryMinutes: 1, minConfidence: 0, cooldownMs: 0 });
  const candles = makeCandles(10, 1); // 10 strong up candles
  feedTicks(engine, candles);
  const now = candles[9].openTime + 5000; // 5s into the current candle (GOOD timing window)
  const sig = engine.evaluate(ASSET, candles, candles[9].close, now, 0.92);
  console.log(`    direction=${sig.direction} confidence=${sig.confidence} agreeing=${sig.components.agreeing} regime=${sig.components.regime} htf=${sig.components.htfTrend}`);
  assert(sig.direction === 'CALL', `expected CALL, got ${sig.direction}`);
  assert(sig.confidence > 0, `expected positive confidence, got ${sig.confidence}`);
  assert(sig.payout === 0.92, `payout propagated (${sig.payout})`);
  assert(sig.entryPrice > 0, `entry price set (${sig.entryPrice})`);
  assert(sig.timeRemainingSec >= 0 && sig.timeRemainingSec <= 60, `timeRemainingSec in range (${sig.timeRemainingSec})`);
}

// --- Test 2: bearish trend produces a PUT ---
console.log('\n[2] Bearish trend → PUT signal');
{
  const engine = new SignalEngine({ expiryMinutes: 1, minConfidence: 0, cooldownMs: 0 });
  const candles = makeCandles(10, -1); // 10 strong down candles
  feedTicksDown(engine, candles);
  const now = candles[9].openTime + 5000; // early in the candle (timing gate open)
  const sig = engine.evaluate(ASSET, candles, candles[9].close, now, 0.92);
  console.log(`    direction=${sig.direction} confidence=${sig.confidence} agreeing=${sig.components.agreeing} regime=${sig.components.regime} htf=${sig.components.htfTrend}`);
  assert(sig.direction === 'PUT', `expected PUT, got ${sig.direction}`);
  assert(sig.confidence > 0, `expected positive confidence, got ${sig.confidence}`);
}

// --- Test 3: insufficient data → WAIT ---
console.log('\n[3] Insufficient candles → WAIT');
{
  const engine = new SignalEngine({ expiryMinutes: 1, minConfidence: 0, cooldownMs: 0 });
  const candles = makeCandles(2, 1); // only 2 candles (< minCandles 5)
  feedTicks(engine, candles);
  const now = candles[1].closeTime;
  const sig = engine.evaluate(ASSET, candles, candles[1].close, now, 0.92);
  assert(sig.direction === 'WAIT', `expected WAIT with 2 candles, got ${sig.direction}`);
}

// --- Test 4: clock-skew clamping (container time far behind server) ---
console.log('\n[4] Clock-skew-safe timing (skewed container time)');
{
  const engine = new SignalEngine({ expiryMinutes: 1, minConfidence: 0, cooldownMs: 0 });
  const candles = makeCandles(10, 1);
  feedTicks(engine, candles);
  // Container clock ~2h behind the server-clock candle boundaries:
  const skewedNow = candles[9].openTime - 2 * 3600_000;
  const sig = engine.evaluate(ASSET, candles, candles[9].close, skewedNow, 0.92);
  assert(sig.timeRemainingSec >= 0, `skewed timeRemainingSec not negative (${sig.timeRemainingSec})`);
  assert(['CALL', 'PUT', 'WAIT'].includes(sig.direction), `direction valid under skew (${sig.direction})`);
}

// --- Test 5: regime low-variance guard (flat candles → UNCLEAR) ---
console.log('\n[5] Regime low-variance guard (flat candles → UNCLEAR)');
{
  const engine = new SignalEngine({ expiryMinutes: 1, minConfidence: 0, cooldownMs: 0 });
  // Build 8 perfectly flat candles (open == close) → negligible returns
  const baseOpen = 1_700_000_000_000;
  const flat: Candle[] = [];
  for (let i = 0; i < 8; i++) {
    flat.push({
      assetId: ASSET, open: 1.08500, high: 1.08501, low: 1.08499, close: 1.08500,
      volume: 5, openTime: baseOpen + i * periodMs, closeTime: baseOpen + i * periodMs + periodMs - 1,
    });
  }
  feedTicks(engine, flat);
  const now = flat[7].closeTime;
  const sig = engine.evaluate(ASSET, flat, 1.08500, now, 0.92);
  assert(sig.components.regime === 'UNCLEAR', `flat candles should yield UNCLEAR regime, got ${sig.components.regime}`);
}

console.log('\n=== RESULT ===');
if (failures === 0) {
  console.log('✅ ALL ENGINE SMOKE TESTS PASSED');
} else {
  console.error(`❌ ${failures} TEST(S) FAILED`);
}
process.exit(failures === 0 ? 0 : 1);
