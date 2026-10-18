/**
 * Test harness for the capture engine, feature collector, and signal filters.
 *
 * Run:  npm test        (from price-bot/)
 *
 * No test framework: a tiny assert helper keeps the dependency surface at zero
 * and the suite runnable with the same `tsx` the app already uses. Each block
 * guards a documented invariant that previously existed only in prose.
 */

import { PocketOptionPriceBot } from '../server.js';
import type { Tick } from '../server.js';
import { FeatureLabelCollector } from '../strategy.js';
import {
  computeConfidence,
  computeRangePct,
  evaluateSignal,
  passesConfidence,
  passesVolatility,
  MIN_CONFIDENCE_THRESHOLD,
  MAX_SPREAD_VOLATILITY_PCT,
  NO_TRADE_ZONE_LOW,
  NO_TRADE_ZONE_HIGH,
} from '../signalFilter.js';
import type { FeatureWindow, PredictionResult } from '../strategy.js';
import { LocalPredictor, PredictionRouter, type Predictor } from '../predictor.js';
import { TelegramDeliverer, DEFAULT_COOLDOWN_MS } from '../deliverer.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) passed++;
  else failures.push(name);
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function feat(over: Partial<FeatureWindow> = {}): FeatureWindow {
  return {
    lastTickAt: 1_789_863_660_010,
    tickCount: 80,
    open: 1.0,
    close: 1.0,
    high: 1.0,
    low: 1.0,
    netChange: 0,
    netChangePct: 0,
    range: 0,
    avgAbsDelta: 0,
    stdDev: 0,
    upRatio: 0.5,
    windowSpanSec: 59,
    recentMomentumPct: 0,
    ...over,
  };
}

function pred(probability: number, direction: 0 | 1): PredictionResult {
  return { asset: 'EURUSD_otc', probability, direction, threshold: 0.5 };
}

// ============================================================
section('signalFilter — confidence semantics and boundaries');
// ============================================================
check('confidence max(P,1-P) at 0.10', Math.abs(computeConfidence(0.1) - 0.9) < 1e-9);
check('confidence max(P,1-P) at 0.90', Math.abs(computeConfidence(0.9) - 0.9) < 1e-9);
check('confidence of 0.5 is 0.5', computeConfidence(0.5) === 0.5);
check('confidence NaN -> 0.5', computeConfidence(NaN) === 0.5);
check('confidence clamps above 1', computeConfidence(1.7) === 1);
check('confidence clamps below 0', computeConfidence(-0.3) === 1);
check('p=0.35 accepted (conf 0.65)', passesConfidence(0.35) === true);
check('p=0.36 in no-trade zone rejected', passesConfidence(0.36) === false);
check('p=0.64 in no-trade zone rejected', passesConfidence(0.64) === false);
check('p=0.65 accepted', passesConfidence(0.65) === true);
check('p=0.50 rejected', passesConfidence(0.5) === false);
check('p=0.34 accepted (conf 0.66)', passesConfidence(0.34) === true);

// ============================================================
section('signalFilter — volatility boundary');
// ============================================================
check('rangePct exactly 0.02 passes', passesVolatility(feat({ open: 1, range: 0.02 })) === true);
check('rangePct just over 0.02 fails', passesVolatility(feat({ open: 1, range: 0.0201 })) === false);
check('open=0 yields rangePct 0', computeRangePct(feat({ open: 0, range: 5 })) === 0);
check('open=NaN yields rangePct 0', computeRangePct(feat({ open: NaN, range: 5 })) === 0);
check('negative range yields 0', computeRangePct(feat({ open: 1, range: -1 })) === 0);

// ============================================================
section('signalFilter — direction mapping and precedence');
// ============================================================
{
  const up = evaluateSignal(pred(0.9, 1), feat({ open: 1, range: 0.001 }));
  check('high-confidence UP -> CALL', up.accepted === true && up.signal.direction === 'CALL');
  const down = evaluateSignal(pred(0.05, 0), feat({ open: 1, range: 0.001 }));
  check('high-confidence DOWN -> PUT', down.accepted === true && down.signal.direction === 'PUT');
  check('confidence reported is 0.95', down.accepted === true && Math.abs(down.signal.confidence - 0.95) < 1e-9);
  const vol = evaluateSignal(pred(0.9, 1), feat({ open: 1, range: 0.5 }));
  check('volatile window -> UNSTABLE_VOLATILITY', vol.accepted === false && vol.reason === 'UNSTABLE_VOLATILITY');
  const low = evaluateSignal(pred(0.5, 1), feat({ open: 1, range: 0.5 }));
  check('low confidence reported before volatility', low.accepted === false && low.reason === 'LOW_CONFIDENCE');
}

// ============================================================
section('signalFilter — documented constants');
// ============================================================
check('MIN_CONFIDENCE_THRESHOLD = 0.65', MIN_CONFIDENCE_THRESHOLD === 0.65);
check('MAX_SPREAD_VOLATILITY_PCT = 0.02', MAX_SPREAD_VOLATILITY_PCT === 0.02);
check('no-trade zone is [0.36, 0.64]', NO_TRADE_ZONE_LOW === 0.36 && NO_TRADE_ZONE_HIGH === 0.64);

// ============================================================
section('candle engine — normalization, aggregation, dedup');
// ============================================================
{
  const bot: any = new PocketOptionPriceBot({
    defaultAssets: ['EURUSD_otc', 'XAUUSD_otc'],
    candlePeriod: 60,
    verbose: false,
  });

  check('normalize EURUSD -> EURUSD_otc', bot.normalizeAssetId('EURUSD') === 'EURUSD_otc');
  check('normalize strips leading #', bot.normalizeAssetId('#EURUSD_otc') === 'EURUSD_otc');
  check('normalize is case-insensitive', bot.normalizeAssetId('xauusd') === 'XAUUSD_otc');
  check('unknown id returned unmapped', bot.normalizeAssetId('ZZZ') === 'ZZZ');

  const t0 = 1_789_863_600_000;
  bot.processTickData([['EURUSD_otc', t0 / 1000, 1.15]]);
  check('array-format tick parsed', bot.getPrice('EURUSD_otc') === 1.15);
  bot.processTickData([['EURUSD_otc', t0 / 1000 + 1, 1.1501]]);
  const hist = bot.getTickHistory('EURUSD_otc');
  check('tick direction UP computed', hist[hist.length - 1].direction === 'UP');
  bot.processTickData([{ asset: 'XAUUSD_otc', price: 4340.5, time: t0 }]);
  check('object-format tick parsed', bot.getPrice('XAUUSD_otc') === 4340.5);

  const before = bot.getTickHistory('EURUSD_otc').length;
  bot.processTickData([['EURUSD_otc', t0 / 1000 + 2, 0]]);
  bot.processTickData([['EURUSD_otc', t0 / 1000 + 3, -5]]);
  bot.processTickData([['', t0 / 1000 + 4, 1.2]]);
  check('zero/negative/empty ticks ignored', bot.getTickHistory('EURUSD_otc').length === before);
  bot.processTickData('not an array');
  check('non-array payload does not throw', true);

  const b = Math.floor(t0 / 60000) * 60000;
  const c1 = bot.getCandles('EURUSD_otc')[0];
  check('candle openTime aligned to period', c1.openTime === b);
  check('candle closeTime = openTime + period - 1', c1.closeTime === b + 59999);
  check('candle high >= low', c1.high >= c1.low);

  bot.processTickData([['EURUSD_otc', (b + 60000) / 1000, 1.1505]]);
  check('new bucket opens a new candle', bot.getCandles('EURUSD_otc').length === 2);

  const h1 = [b / 1000, 1.15, 1.16, 1.14, 1.155, 10];
  const h2 = [(b + 60000) / 1000, 1.155, 1.17, 1.15, 1.16, 12];
  bot.processHistoryData(['EURUSD_otc', [h1, h2]]);
  const afterFirst = bot.getCandles('EURUSD_otc').length;
  bot.processHistoryData(['EURUSD_otc', [h1, h2]]); // reconnect replay
  check('history dedup on reconnect', bot.getCandles('EURUSD_otc').length === afterFirst);

  const sorted = bot.getCandles('EURUSD_otc');
  check('candles sorted ascending', sorted.every((c: any, i: number) => i === 0 || c.openTime >= sorted[i - 1].openTime));

  for (let i = 0; i < 250; i++) {
    bot.processTickData([['EURUSD_otc', (b + (i + 10) * 60000) / 1000, 1.15 + i * 1e-5]]);
  }
  check('candles capped at 100', bot.getCandles('EURUSD_otc').length <= 100);

  for (let i = 0; i < 1200; i++) {
    bot.processTickData([['XAUUSD_otc', t0 / 1000 + i, 4340 + i]]);
  }
  check('tick history capped at 1000', bot.getTickHistory('XAUUSD_otc').length <= 1000);
  check('getPrice unknown asset = 0', bot.getPrice('NOPE') === 0);
}

// ============================================================
section('collector — windowing, bucket dedup, horizon resolution');
// ============================================================
{
  const asset = 'EURUSD_otc';
  const BASE = 1_789_863_600_000;

  const drive = (col: FeatureLabelCollector, minutes: number, startMs: number) => {
    let px = 1.15;
    let serverMs = startMs;
    const history: Tick[] = [];
    const boundaries: number[] = [];
    col.onBucketBoundary((_a, f) => boundaries.push(f.lastTickAt));
    for (let s = 0; s < minutes * 60; s++) {
      serverMs += 1000;
      const next = px + Math.sin(s / 5) * 5e-5;
      const dir: 'UP' | 'DOWN' = next > px ? 'UP' : 'DOWN';
      px = next;
      history.push({ assetId: asset, price: px, timestamp: serverMs, direction: dir });
      col.evaluate({ price: px, candles: [], ticks: history.slice(-1000), serverTime: serverMs }, asset);
    }
    return { serverMs, boundaries };
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-'));
  const sig = path.join(tmpDir, 'signals.json');
  const featFile = path.join(tmpDir, 'live-prices.json');

  const c1 = new FeatureLabelCollector({ signalsFile: sig, featuresFile: featFile });
  const r1 = drive(c1, 3, BASE);
  const n1 = c1.getLabels().length;
  check('collector arms >= 2 labels over 3 min', n1 >= 2);
  check('at most one arm per 60s bucket', r1.boundaries.length <= 4);
  check('every label horizon is >= 60s', c1.getLabels().every((l) => l.resolvedAt - l.entryAt >= 60000));
  {
    const buckets = c1.getLabels().map((l) => Math.floor(l.entryAt / 60000));
    check('label buckets unique', new Set(buckets).size === buckets.length);
  }

  // Persistence: a new collector resumes the file instead of truncating it.
  fs.writeFileSync(sig, JSON.stringify(c1.getLabels(), null, 2));
  const c2 = new FeatureLabelCollector({ signalsFile: sig, featuresFile: featFile });
  check('collector resumes labels from disk', c2.getLabels().length === n1);
  const r2 = drive(c2, 3, r1.serverMs);
  check('collector appends after resume', c2.getLabels().length > n1);
  {
    const keys = c2.getLabels().map((l) => `${l.asset}:${l.entryAt}`);
    check('no duplicate (asset, entryAt)', new Set(keys).size === keys.length);
  }
  {
    const times = c2.getLabels().map((l) => l.entryAt);
    check('labels sorted by entryAt', times.every((t, i) => i === 0 || t >= times[i - 1]));
  }

  // Replaying an already-covered range must not re-arm (monotonic bucket guard).
  const covered = c2.getLabels().length;
  drive(c2, 3, BASE);
  check('no re-arm of already-labelled buckets', c2.getLabels().length === covered);

  // Cap enforcement.
  const many = Array.from({ length: 50 }, (_, i) => ({
    type: 'OBSERVATION', asset, entryAt: BASE + i * 60000, entryPrice: 1.15,
    resolvedAt: BASE + i * 60000 + 60000, expirationPrice: 1.1501, delta: 1e-4,
    label: 1 as const, outcome: 'UP' as const, features: feat(), source: 'x',
  }));
  fs.writeFileSync(sig, JSON.stringify(many));
  const capped = new FeatureLabelCollector({ signalsFile: sig, featuresFile: featFile, maxLabels: 10 });
  check('maxLabels trims the array', capped.getLabels().length === 10);
  check('maxLabels keeps the newest', capped.getLabels()[9].entryAt === BASE + 49 * 60000);

  // Malformed input is tolerated, never fatal.
  fs.writeFileSync(sig, '{ not json');
  check('corrupt signals.json tolerated', new FeatureLabelCollector({ signalsFile: sig, featuresFile: featFile }).getLabels().length === 0);
  fs.writeFileSync(sig, '{"a":1}');
  check('non-array signals.json tolerated', new FeatureLabelCollector({ signalsFile: sig, featuresFile: featFile }).getLabels().length === 0);
  fs.writeFileSync(sig, JSON.stringify([...many.slice(0, 3), null, { label: 'x' }, { asset: 'A' }]));
  check('malformed records dropped, valid kept', new FeatureLabelCollector({ signalsFile: sig, featuresFile: featFile }).getLabels().length === 3);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ============================================================
section('features — upRatio ignores FLAT ticks; momentum is not a duplicate');
// ============================================================
{
  const asset = 'EURUSD_otc';
  const BASE = 1_789_863_600_000;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-'));

  // Capture the feature window the collector emits at a bucket boundary.
  const captureWindow = (ticks: Tick[]): any => {
    const col = new FeatureLabelCollector({
      signalsFile: path.join(tmp, 's.json'),
      featuresFile: path.join(tmp, 'f.json'),
    });
    let seen: any = null;
    col.onBucketBoundary((_a, f) => { seen = f; });
    // One evaluate per tick, replaying a growing snapshot like the live loop.
    for (let i = 0; i < ticks.length; i++) {
      col.evaluate({ price: ticks[i].price, candles: [], ticks: ticks.slice(0, i + 1), serverTime: ticks[i].timestamp }, asset);
    }
    // Cross a bucket boundary so the window is emitted.
    const last = ticks[ticks.length - 1];
    col.evaluate({ price: last.price, candles: [], ticks, serverTime: BASE + 60001 }, asset);
    return seen;
  };

  // A window whose ticks are mostly FLAT must not read as "mostly down".
  // 3 UP, 1 DOWN, 20 FLAT -> directional ratio is 0.75, not 3/24 = 0.125.
  // Timestamps span the full window so the minCoverage gate does not skip it.
  const spread = (n: number, i: number) => BASE + 1000 + Math.round((i * 58000) / (n - 1));
  const mixed: Tick[] = [];
  let px = 1.15;
  for (let i = 0; i < 24; i++) {
    let dir: 'UP' | 'DOWN' | 'FLAT';
    if (i < 3) { px += 1e-5; dir = 'UP'; }
    else if (i < 4) { px -= 1e-5; dir = 'DOWN'; }
    else { dir = 'FLAT'; }
    mixed.push({ assetId: asset, price: px, timestamp: spread(24, i), direction: dir });
  }
  const f = captureWindow(mixed);
  check('window emitted', f !== null);
  check('upRatio excludes FLAT ticks (0.75, not 0.125)', Math.abs(f.upRatio - 0.75) < 1e-9);
  check('upRatio stays in [0,1]', f.upRatio >= 0 && f.upRatio <= 1);

  // All-flat window is neutral, not "all down".
  const flatOnly: Tick[] = Array.from({ length: 10 }, (_, i) => ({
    assetId: asset, price: 1.15, timestamp: spread(10, i), direction: 'FLAT' as const,
  }));
  const ff = captureWindow(flatOnly);
  check('all-FLAT window is neutral (0.5)', Math.abs(ff.upRatio - 0.5) < 1e-9);

  // recentMomentumPct must differ from netChangePct: a window that falls then
  // recovers ends flat (netChangePct ~ 0) but has positive recent momentum.
  const vShape: Tick[] = [];
  for (let i = 0; i < 20; i++) {
    const p = i < 10 ? 1.15 - i * 1e-5 : 1.15 - (20 - i) * 1e-5;
    vShape.push({ assetId: asset, price: p, timestamp: spread(20, i), direction: p > 1.15 ? 'UP' : 'DOWN' });
  }
  const fv = captureWindow(vShape);
  check('recentMomentumPct is present', typeof fv.recentMomentumPct === 'number');
  check(
    'recentMomentumPct is not a copy of netChangePct',
    Math.abs(fv.recentMomentumPct - fv.netChangePct) > 1e-9
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ============================================================
section('predictor — baseline always answers, router falls back');
// ============================================================
{
  const local = new LocalPredictor();

  // Flat window -> no signal -> a coin flip, never a confident claim.
  const flat = await local.predict('EURUSD_otc', feat());
  check('flat window yields ~0.5', Math.abs(flat.probability - 0.5) < 1e-6);
  check('flat window direction is 1 (ML >= convention)', flat.direction === 1);
  check('baseline tags itself as the source', flat.source === 'local-baseline');
  check('baseline always returns a result', flat !== null);

  // Rising window -> UP.
  const up = await local.predict('EURUSD_otc', feat({
    open: 1.15, close: 1.1510, netChangePct: 0.00087,
    recentMomentumPct: 0.0009, upRatio: 0.9, stdDev: 1e-5,
  }));
  check('rising window predicts UP', up.probability > 0.5 && up.direction === 1);

  // Falling window -> DOWN.
  const down = await local.predict('EURUSD_otc', feat({
    open: 1.15, close: 1.1490, netChangePct: -0.00087,
    recentMomentumPct: -0.0009, upRatio: 0.1, stdDev: 1e-5,
  }));
  check('falling window predicts DOWN', down.probability < 0.5 && down.direction === 0);

  // Extremes must stay inside [0.02, 0.98] — a placeholder has no certainty.
  const extreme = await local.predict('EURUSD_otc', feat({
    open: 1.15, close: 1.30, netChangePct: 0.5, recentMomentumPct: 0.5,
    upRatio: 1.0, stdDev: 1e-9,
  }));
  check('probability clamped <= 0.98', extreme.probability <= 0.98);
  check('probability clamped >= 0.02', extreme.probability >= 0.02);

  // Degenerate inputs must not produce NaN.
  const nan = await local.predict('EURUSD_otc', feat({
    open: 0, stdDev: 0, netChangePct: NaN, recentMomentumPct: NaN, upRatio: NaN,
  }));
  check('degenerate window yields finite probability', Number.isFinite(nan.probability));
  check('degenerate window stays in range', nan.probability >= 0.02 && nan.probability <= 0.98);

  // Router with no ML client -> baseline answers.
  const noMl = new PredictionRouter(null, local);
  const r1 = await noMl.predict('EURUSD_otc', feat());
  check('router without ML falls back to baseline', r1 !== null);
  check('router names the baseline-only mode', noMl.name === 'local-baseline');

  // Router with a healthy ML client -> ML wins, and is tagged as such.
  const fakeMl: Predictor = {
    name: 'fake-ml',
    async predict(asset: string) {
      return { asset, probability: 0.91, direction: 1 as const, threshold: 0.5, source: 'ml' as const };
    },
  };
  const withMl = new PredictionRouter(fakeMl, local);
  const r2 = await withMl.predict('EURUSD_otc', feat());
  check('router prefers ML when it answers', r2 !== null && r2.source === 'ml');
  check('router reports ML probability', r2 !== null && Math.abs(r2.probability - 0.91) < 1e-9);

  // Router with a failing ML client -> falls back instead of going silent.
  const deadMl: Predictor = { name: 'dead', async predict() { return null; } };
  const fallback = new PredictionRouter(deadMl, local);
  const r3 = await fallback.predict('EURUSD_otc', feat());
  check('router falls back when ML returns null', r3 !== null && r3.source === 'local-baseline');
}

// ============================================================
section('deliverer — throttle policy and message formatting');
// ============================================================
{
  // No Telegram credentials in tests: the deliverer must stay inert.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  const disabled = new TelegramDeliverer({ quiet: true });
  check('deliverer disabled without credentials', disabled.isEnabled() === false);
  const sig: any = { timestamp: 1_000_000, asset: 'EURUSD_otc', direction: 'CALL', confidence: 0.8 };
  await disabled.send(sig, feat(), 'local-baseline');
  check('disabled deliverer sends nothing', disabled.getStats().sent === 0);
  check('disabled deliverer counts no throttle', disabled.getStats().throttled === 0);
  check('default cooldown is 5 minutes', DEFAULT_COOLDOWN_MS === 300_000);

  // Formatting is pure, so it can be checked directly.
  const text = TelegramDeliverer.format(
    { timestamp: 1, asset: 'EURUSD_otc', direction: 'PUT', confidence: 0.9 },
    feat({ close: 1.1505, windowSpanSec: 59, tickCount: 110 }),
    'ml'
  );
  check('message names the asset and direction', text.includes('PUT') && text.includes('EURUSD_otc'));
  check('message reports confidence as a percent', text.includes('90.0%'));
  check('PUT message shows P(UP) = 1 - confidence', text.includes('0.100'));
  check('message carries the source', text.includes('source: ml'));

  const callText = TelegramDeliverer.format(
    { timestamp: 1, asset: 'EURUSD_otc', direction: 'CALL', confidence: 0.9 },
    feat(),
    'local-baseline'
  );
  check('CALL message shows P(UP) = confidence', callText.includes('0.900'));
}

// ============================================================
section('deliverer — batching a bucket into one message');
// ============================================================
{
  // Six assets clear the filters in the same evaluate tick because the bucket
  // boundary is wall-clock aligned and shared. Without batching that is six
  // separate chat messages for one market moment.
  const items = ['EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'AUDUSD_otc', 'USDCAD_otc', 'XAUUSD_otc'].map(
    (asset, i) => ({
      signal: {
        timestamp: 1_792_000_000_000,
        asset,
        direction: (i % 2 === 0 ? 'CALL' : 'PUT') as 'CALL' | 'PUT',
        confidence: 0.66 + i * 0.01,
      },
      features: feat({ close: 1.1 + i * 0.01, windowSpanSec: 59 }),
      source: 'ml',
    })
  );

  const batch = TelegramDeliverer.formatBatch(items);
  check('batch header counts every signal', batch.includes('6 signals'));
  check('batch is one message, not six', batch.split('\n\n').length === 3);
  for (const it of items) {
    check(`batch lists ${it.signal.asset}`, batch.includes(it.signal.asset));
  }
  check('batch names every direction', batch.includes('CALL') && batch.includes('PUT'));
  // Strongest signal first, so the most actionable line is at the top.
  const lines = batch.split('\n\n')[1].split('\n');
  check('batch is sorted by confidence desc', lines[0].includes('XAUUSD_otc'));
  check('batch states a single shared source', batch.includes('source: ml'));

  const mixed = TelegramDeliverer.formatBatch([
    { ...items[0], source: 'ml' },
    { ...items[1], source: 'local-baseline' },
  ]);
  check('mixed sources are labelled as such', mixed.includes('source: mixed'));

  const single = TelegramDeliverer.formatBatch([items[0]]);
  check('a one-signal batch reads singular', single.includes('1 signal ') && !single.includes('1 signals'));
}

// ============================================================
section('deliverer — batch window drains to a single send');
// ============================================================
{
  // Credentials are required for `send` to do anything. `fetch` is stubbed so
  // the test never reaches Telegram; only the call count matters here.
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = 'test-chat';
  const savedFetch = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async () => {
    calls++;
    return { ok: true, status: 200 } as any;
  };

  const d = new TelegramDeliverer({ quiet: true, batchWindowMs: 50, cooldownMs: 0 });
  const sig = (asset: string) => ({
    timestamp: 1_792_000_000_000,
    asset,
    direction: 'CALL' as const,
    confidence: 0.7,
  });
  // Six signals enqueued together, as the bucket callback does.
  for (const a of ['A_otc', 'B_otc', 'C_otc', 'D_otc', 'E_otc', 'F_otc']) {
    void d.send(sig(a), feat(), 'ml');
  }
  check('nothing is sent before the batch window closes', calls === 0);

  await d.flush();
  check('one bucket produces exactly one message', calls === 1);
  check('the message covers all six signals', d.getStats().signals === 6);
  check('message count is one, not six', d.getStats().sent === 1);

  // A second bucket with the same assets inside the cooldown must be throttled.
  const d2 = new TelegramDeliverer({ quiet: true, batchWindowMs: 50, cooldownMs: 300_000 });
  calls = 0;
  for (const a of ['A_otc', 'B_otc']) void d2.send(sig(a), feat(), 'ml');
  await d2.flush();
  check('first bucket delivers', calls === 1);
  // 60s later, same assets: still inside the 5-minute cooldown.
  for (const a of ['A_otc', 'B_otc']) {
    void d2.send({ ...sig(a), timestamp: 1_792_000_060_000 }, feat(), 'ml');
  }
  await d2.flush();
  check('cooldown suppresses the next bucket', calls === 1);
  check('suppressed signals are counted as throttled', d2.getStats().throttled === 2);

  // batchWindowMs = 0 restores one message per signal.
  const d3 = new TelegramDeliverer({ quiet: true, batchWindowMs: 0, cooldownMs: 0 });
  calls = 0;
  await d3.send(sig('A_otc'), feat(), 'ml');
  await d3.send(sig('B_otc'), feat(), 'ml');
  check('batchWindowMs=0 sends per signal', calls === 2);
  check('per-signal mode counts two messages', d3.getStats().sent === 2);

  (globalThis as any).fetch = savedFetch;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
}

// ============================================================
section('engine — session merge and liveness watchdog');
// ============================================================
{
  // Regression: a reconnect whose rediscovery captured no auth packet used to
  // overwrite the cached one with "". The socket then opened unauthenticated,
  // subscribed, and received no ticks while isConnected() reported true —
  // observed live as ticks frozen for minutes behind connected: true.
  const bot: any = new PocketOptionPriceBot({
    defaultAssets: ['EURUSD_otc'],
    candlePeriod: 60,
    verbose: false,
  });

  bot.adoptDiscoveredSession({
    url: 'wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket',
    authPacket: '42["auth",{"token":"good"}]',
    cookies: 'sid=abc',
  });
  check('adopts url', bot.discoveredWsUrl.includes('po.market'));
  check('adopts auth packet', bot.cachedAuthPacket.includes('"auth"'));
  check('adopts cookies', bot.cachedCookies === 'sid=abc');

  // A later rediscovery that caught nothing must not clear what we have.
  bot.adoptDiscoveredSession({ url: '', authPacket: '', cookies: '' });
  check('empty rediscovery keeps auth packet', bot.cachedAuthPacket.includes('"auth"'));
  check('empty rediscovery keeps cookies', bot.cachedCookies === 'sid=abc');
  check('empty rediscovery keeps url', bot.discoveredWsUrl.includes('po.market'));

  // A rediscovery with fresh credentials should win.
  bot.adoptDiscoveredSession({ url: '', authPacket: '42["auth",{"token":"new"}]', cookies: '' });
  check('fresh auth packet replaces the old one', bot.cachedAuthPacket.includes('"new"'));
  check('empty cookies in rediscovery keep the old ones', bot.cachedCookies === 'sid=abc');

  // Liveness: an open socket that has stopped delivering ticks must be treated
  // as stalled, and a healthy or not-yet-started one must not.
  const live: any = new PocketOptionPriceBot({
    defaultAssets: ['EURUSD_otc'],
    candlePeriod: 60,
    verbose: false,
    livenessTimeoutMs: 90_000,
  });
  live.connected = true;
  live.lastTickWallClock = 0;
  check('no stall before the first tick', live.hasStalled(Date.now()) === false);
  live.lastTickWallClock = 1_000_000;
  check('no stall while ticks are recent', live.hasStalled(1_000_000 + 89_999) === false);
  check('stall at the threshold', live.hasStalled(1_000_000 + 90_000) === true);
  check('stall well past the threshold', live.hasStalled(1_000_000 + 600_000) === true);
  live.connected = false;
  check('no stall reported while disconnected', live.hasStalled(1_000_000 + 600_000) === false);
  live.connected = true;
  live.config.livenessTimeoutMs = 0;
  check('watchdog disabled by timeout 0', live.hasStalled(1_000_000 + 600_000) === false);
}

// ============================================================
console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
  console.log(`ALL ${passed} CHECKS PASSED`);
  process.exit(0);
}
console.log(`${passed} passed, ${failures.length} FAILED:`);
for (const f of failures) console.log(`  x ${f}`);
process.exit(1);
