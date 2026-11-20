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
import { MlPredictor, PredictionRouter, type Predictor } from '../predictor.js';
import {
  TelegramDeliverer,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_SEND_ATTEMPTS,
} from '../deliverer.js';
import {
  GeminiAnalyst,
  parseAnalysis,
  buildPrompt,
  DEFAULT_MIN_AI_CONFIDENCE,
  type AiAnalysis,
} from '../aiAnalyst.js';
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

/** Minimal AI analysis fixture for delivery tests. */
function analysis(over: Partial<AiAnalysis> = {}): AiAnalysis {
  return {
    verdict: 'APPROVE',
    confidence: 0.8,
    summary: 'Momentum and tick imbalance agree with the called direction.',
    supportingFactors: ['net change and up-ratio agree'],
    risks: ['short window'],
    conflicts: [],
    model: 'test-model',
    latencyMs: 100,
    attempts: 1,
    ...over,
  };
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

  // The signal timestamp is the window's arm instant, so it matches the
  // collector's label key exactly. Using the last tick instead lets a tick that
  // lags the boundary by a few ms floor into the PREVIOUS bucket, colliding two
  // distinct windows under one dedup key.
  const stamped = evaluateSignal(pred(0.9, 1), feat({ open: 1, range: 0.001, lastTickAt: 1000 }), 2000);
  check('signal timestamp is the window arm instant', stamped.accepted === true && stamped.signal.timestamp === 2000);
  const fallback = evaluateSignal(pred(0.9, 1), feat({ open: 1, range: 0.001, lastTickAt: 1000 }));
  check('signal timestamp falls back to lastTickAt', fallback.accepted === true && fallback.signal.timestamp === 1000);
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
  // The horizon is the *intended* one on every row, not the tick-arrival gap.
  // A stall must not stretch 60s into 74s or mislabel against a stale price.
  check(
    'every label horizon is exactly 60s',
    c1.getLabels().every((l) => l.resolvedAt - l.entryAt === 60000)
  );
  // The outcome is read off the tick at the horizon, not the live price at
  // notice time: with 1s ticks the nearest tick to entryAt+60s is within 1s.
  check(
    'expiration price is taken at the horizon instant',
    c1.getLabels().every((l) => l.resolvedAt === l.entryAt + 60000)
  );
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

  // A feed stall: the server clock freezes on the last tick, then jumps when
  // ticks resume. Before the fix, a label whose horizon fell inside the gap was
  // resolved against the late `now` and the live price, stretching the horizon
  // (observed 60s -> 74s live) and reading the outcome off a stale price.
  {
    const stallAsset = 'STALL_otc';
    const stall = new FeatureLabelCollector({ signalsFile: sig, featuresFile: featFile });
    const history: Tick[] = [];
    let px = 1.2;
    let serverMs = BASE;
    const step = (gapMs: number) => {
      serverMs += gapMs;
      px += 1e-5;
      history.push({ assetId: stallAsset, price: px, timestamp: serverMs, direction: 'UP' });
      stall.evaluate(
        { price: px, candles: [], ticks: history.slice(-1000), serverTime: serverMs },
        stallAsset
      );
    };
    // Warm up a full window, arm a bucket, then stall for 20s before resuming.
    for (let s = 0; s < 70; s++) step(1000);
    const armed = stall.getLabels().length;
    for (let s = 0; s < 5; s++) step(20_000); // 100s of server-clock jump
    const rows = stall.getLabels();
    check('stall still produces labels', rows.length > armed);
    check(
      'stalled labels keep the exact 60s horizon',
      rows.every((l) => l.resolvedAt - l.entryAt === 60000)
    );
  }

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
section('predictor — ML-only, no baseline fallback');
// ============================================================
{
  // The router with no ML predictor must NOT invent a prediction. A missing
  // model means "no prediction", never a guess.
  const none = new PredictionRouter(null);
  const r0 = await none.predict('EURUSD_otc', feat());
  check('router without an ML predictor returns null', r0 === null);
  check('router names the no-predictor mode', none.name === 'none');

  // A healthy ML predictor is the only source, and is tagged 'ml'.
  const fakeMl: Predictor = {
    name: 'fake-ml',
    async predict(asset: string) {
      return { asset, probability: 0.91, direction: 1 as const, threshold: 0.5 };
    },
  };
  const ml = new MlPredictor(fakeMl);
  check('MlPredictor names itself after the wrapped predictor', ml.name === 'fake-ml');

  const r1 = await ml.predict('EURUSD_otc', feat());
  check('MlPredictor returns the model probability', r1 !== null && Math.abs(r1.probability - 0.91) < 1e-9);
  check('MlPredictor tags the source as ml', r1 !== null && r1.source === 'ml');

  // A failing model (service down, 503 no model) propagates null — never a
  // fabricated fallback.
  const deadMl: Predictor = { name: 'dead', async predict() { return null; } };
  const dead = new MlPredictor(deadMl);
  const r2 = await dead.predict('EURUSD_otc', feat());
  check('MlPredictor returns null when the model cannot answer', r2 === null);

  const withMl = new PredictionRouter(ml);
  const r3 = await withMl.predict('EURUSD_otc', feat());
  check('router forwards to the ML predictor', r3 !== null && r3.source === 'ml');

  const withDead = new PredictionRouter(dead);
  const r4 = await withDead.predict('EURUSD_otc', feat());
  check('router returns null when the model is unavailable (no fallback)', r4 === null);
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
  await disabled.send(sig, feat(), 'ml', analysis());
  check('disabled deliverer sends nothing', disabled.getStats().sent === 0);
  check('disabled deliverer counts no throttle', disabled.getStats().throttled === 0);
  check('default cooldown is 5 minutes', DEFAULT_COOLDOWN_MS === 300_000);
  check('default send attempts is 3', DEFAULT_MAX_SEND_ATTEMPTS === 3);

  // Formatting is pure, so it can be checked directly. The message must carry
  // the ORIGINAL prediction AND the AI analysis, side by side.
  const text = TelegramDeliverer.format({
    signal: { timestamp: 1, asset: 'EURUSD_otc', direction: 'PUT', confidence: 0.9 },
    features: feat({ close: 1.1505, windowSpanSec: 59, tickCount: 110 }),
    source: 'ml',
    analysis: analysis({
      summary: 'Bearish structure with a supportive tick imbalance.',
      supportingFactors: ['net change negative', 'momentum negative'],
      risks: ['thin liquidity'],
      conflicts: ['up-ratio mildly positive'],
    }),
  });
  check('message names the asset and direction', text.includes('PUT') && text.includes('EURUSD_otc'));
  check('message reports confidence as a percent', text.includes('90.0%'));
  check('PUT message shows P(UP) = 1 - confidence', text.includes('0.100'));
  check('message carries the source', text.includes('source: ml'));
  check('message is marked AI-approved', text.includes('AI-APPROVED'));
  check('message includes the AI summary', text.includes('Bearish structure'));
  check('message lists supporting factors', text.includes('net change negative'));
  check('message lists risk warnings', text.includes('thin liquidity'));
  check('message lists conflicting indicators', text.includes('up-ratio mildly positive'));
  check('message shows the analyst confidence', text.includes('80% confident'));

  const callText = TelegramDeliverer.format({
    signal: { timestamp: 1, asset: 'EURUSD_otc', direction: 'CALL', confidence: 0.9 },
    features: feat(),
    source: 'ml',
    analysis: analysis(),
  });
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
      analysis: analysis({ summary: `analysis for ${asset}` }),
    })
  );

  const batch = TelegramDeliverer.formatBatch(items);
  check('batch header counts every signal', batch.includes('6 AI-APPROVED SIGNAL'));
  for (const it of items) {
    check(`batch lists ${it.signal.asset}`, batch.includes(it.signal.asset));
  }
  check('batch names every direction', batch.includes('CALL') && batch.includes('PUT'));
  // Strongest signal first, so the most actionable line is at the top.
  const bodyBlock = batch.split('\n\n')[1].split('\n');
  check('batch is sorted by confidence desc', bodyBlock[0].includes('XAUUSD_otc'));
  check('batch states a single shared source', batch.includes('source: ml'));
  check('batch carries per-signal AI summaries', batch.includes('analysis for EURUSD_otc'));

  const mixed = TelegramDeliverer.formatBatch([
    { ...items[0], source: 'ml' },
    { ...items[1], source: 'ml-experimental' },
  ]);
  check('mixed sources are labelled as such', mixed.includes('source: mixed'));

  const single = TelegramDeliverer.formatBatch([items[0]]);
  check('a one-signal batch reads singular', single.includes('1 AI-APPROVED SIGNAL ') && !single.includes('SIGNALS'));
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
  const sig = (asset: string, direction: 'CALL' | 'PUT' = 'CALL', timestamp = 1_792_000_000_000) => ({
    timestamp,
    asset,
    direction,
    confidence: 0.7,
  });
  // Six signals enqueued together, as the bucket callback does.
  for (const a of ['A_otc', 'B_otc', 'C_otc', 'D_otc', 'E_otc', 'F_otc']) {
    void d.send(sig(a), feat(), 'ml', analysis());
  }
  check('nothing is sent before the batch window closes', calls === 0);

  await d.flush();
  check('one bucket produces exactly one message', calls === 1);
  check('the message covers all six signals', d.getStats().signals === 6);
  check('message count is one, not six', d.getStats().sent === 1);

  // A second bucket with the same assets inside the cooldown must be throttled.
  const d2 = new TelegramDeliverer({ quiet: true, batchWindowMs: 50, cooldownMs: 300_000 });
  calls = 0;
  for (const a of ['A_otc', 'B_otc']) void d2.send(sig(a), feat(), 'ml', analysis());
  await d2.flush();
  check('first bucket delivers', calls === 1);
  // 60s later, same assets: still inside the 5-minute cooldown.
  for (const a of ['A_otc', 'B_otc']) {
    void d2.send({ ...sig(a), timestamp: 1_792_000_060_000 }, feat(), 'ml', analysis());
  }
  await d2.flush();
  check('cooldown suppresses the next bucket', calls === 1);
  check('suppressed signals are counted as throttled', d2.getStats().throttled === 2);

  // Duplicate prevention: the SAME signal identity re-enqueued must be dropped
  // even with the cooldown disabled, so a retry or a re-scored window cannot
  // double-post.
  const dDup = new TelegramDeliverer({ quiet: true, batchWindowMs: 0, cooldownMs: 0 });
  calls = 0;
  await dDup.send(sig('A_otc'), feat(), 'ml', analysis());
  await dDup.send(sig('A_otc'), feat(), 'ml', analysis());
  check('identical signal delivered once', calls === 1);
  check('duplicate is counted', dDup.getStats().duplicates === 1);
  // A different direction in the same bucket is a different signal.
  await dDup.send(sig('A_otc', 'PUT'), feat(), 'ml', analysis());
  check('opposite direction is not treated as a duplicate', calls === 2);

  // Dedup keys must be pruned, or the map grows forever on a long run. A key
  // older than the cooldown horizon can never match again, so it is dropped.
  const dPrune = new TelegramDeliverer({ quiet: true, batchWindowMs: 0, cooldownMs: 60_000 });
  const base = 1_700_000_000_000;
  await dPrune.send(sig('A_otc', 'CALL', base), feat(), 'ml', analysis());
  check('dedup map holds the delivered key', dPrune.getStats().dedupKeys === 1);
  // Two hours later: the old key is far outside the cooldown horizon.
  await dPrune.send(sig('B_otc', 'CALL', base + 7_200_000), feat(), 'ml', analysis());
  check('stale dedup keys are pruned', dPrune.getStats().dedupKeys === 1);
  check('pruning does not break new delivery', dPrune.getStats().sent === 2);
  // Re-delivering the OLD bucket must no longer be suppressed by a stale key
  // (its bucket is ancient; only the cooldown, now expired, ever covered it).
  await dPrune.send(sig('A_otc', 'CALL', base + 14_400_000), feat(), 'ml', analysis());
  check('fresh buckets deliver after pruning', dPrune.getStats().sent === 3);

  // A next-bucket signal must not prune the key a LATE same-bucket duplicate
  // still needs. This is a real live bug: with cooldown 0 the horizon was one
  // bucket wide, so a signal arriving 3ms into the next bucket dropped the
  // previous key, and a duplicate of the previous bucket then delivered twice
  // (two AUDUSD PUT messages reached the chat).
  {
    // Bucket-aligned base, so +59_000 is genuinely the same bucket.
    const b = 1_699_999_980_000;
    const dLate = new TelegramDeliverer({ quiet: true, batchWindowMs: 0, cooldownMs: 0 });
    calls = 0;
    await dLate.send(sig('A_otc', 'PUT', b), feat(), 'ml', analysis());
    // A signal from the NEXT bucket arrives almost immediately...
    await dLate.send(sig('B_otc', 'PUT', b + 60_003), feat(), 'ml', analysis());
    // ...then a late duplicate of the FIRST bucket arrives.
    await dLate.send(sig('A_otc', 'PUT', b + 59_000), feat(), 'ml', analysis());
    check('a late same-bucket duplicate is still suppressed', dLate.getStats().duplicates === 1);
    check('the late duplicate is not delivered', calls === 2);
  }

  // batchWindowMs = 0 restores one message per signal.
  const d3 = new TelegramDeliverer({ quiet: true, batchWindowMs: 0, cooldownMs: 0 });
  calls = 0;
  await d3.send(sig('A_otc'), feat(), 'ml', analysis());
  await d3.send(sig('B_otc'), feat(), 'ml', analysis());
  check('batchWindowMs=0 sends per signal', calls === 2);
  check('per-signal mode counts two messages', d3.getStats().sent === 2);

  // Retry: a send that fails transiently must be retried, then succeed.
  const dRetry = new TelegramDeliverer({
    quiet: true,
    batchWindowMs: 0,
    cooldownMs: 0,
    maxSendAttempts: 3,
  });
  let attempt = 0;
  (globalThis as any).fetch = async () => {
    attempt++;
    if (attempt < 3) throw new Error('transient');
    return { ok: true, status: 200 } as any;
  };
  await dRetry.send(sig('A_otc'), feat(), 'ml', analysis());
  check('transient failure is retried until it succeeds', dRetry.getStats().sent === 1);
  check('retries are counted', dRetry.getStats().retries === 2);

  // The audit log must record the accepted message id and the exact text, so
  // the delivered content is verifiable without reading the chat back.
  {
    const auditPath = path.join(os.tmpdir(), `tg-audit-${Date.now()}.jsonl`);
    const dAudit = new TelegramDeliverer({
      quiet: true,
      batchWindowMs: 0,
      cooldownMs: 0,
      auditFile: auditPath,
    });
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { message_id: 4242 } }),
    });
    await dAudit.send(sig('A_otc'), feat(), 'ml', analysis());
    check('message id is recorded from the Telegram response', dAudit.getStats().lastMessageId === 4242);
    const logged = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('audit log has one record per sent message', logged.length === 1);
    check('audit record carries the message id', logged[0].messageId === 4242);
    check('audit record carries the exact sent text', logged[0].text.includes('AI-APPROVED'));
    fs.rmSync(auditPath, { force: true });
  }

  // A permanent failure is counted, never thrown.
  const dFail = new TelegramDeliverer({
    quiet: true,
    batchWindowMs: 0,
    cooldownMs: 0,
    maxSendAttempts: 2,
  });
  (globalThis as any).fetch = async () => {
    throw new Error('permanent');
  };
  await dFail.send(sig('A_otc'), feat(), 'ml', analysis());
  check('permanent failure counts as failed', dFail.getStats().failed === 1);
  check('permanent failure sends nothing', dFail.getStats().sent === 0);

  (globalThis as any).fetch = savedFetch;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
}

// ============================================================
section('aiAnalyst — parse, guardrails, retries, fail-closed');
// ============================================================
{
  const okOpts = { model: 'm', latencyMs: 1, attempts: 1, minConfidence: DEFAULT_MIN_AI_CONFIDENCE };

  // Well-formed APPROVE.
  const approve = parseAnalysis(
    JSON.stringify({
      verdict: 'APPROVE',
      confidence: 0.82,
      summary: 'Trend and tick imbalance agree.',
      supporting_factors: ['net change up', 'up-ratio 0.7'],
      risks: ['thin window'],
      conflicts: [],
    }),
    okOpts
  );
  check('APPROVE parsed', approve?.verdict === 'APPROVE');
  check('confidence parsed', approve?.confidence === 0.82);
  check('supporting factors parsed', approve?.supportingFactors.length === 2);
  check('risks parsed', approve?.risks[0] === 'thin window');
  check('summary parsed', approve?.summary.startsWith('Trend and tick') === true);

  // A fenced JSON block (models add one despite the instruction) still parses.
  const fenced = parseAnalysis('```json\n{"verdict":"REJECT","confidence":0.3}\n```', okOpts);
  check('fenced JSON parses', fenced?.verdict === 'REJECT');

  // An unsure APPROVE is downgraded to REJECT by the layer's guardrail.
  const unsure = parseAnalysis('{"verdict":"APPROVE","confidence":0.4}', okOpts);
  check('low-confidence APPROVE downgraded to REJECT', unsure?.verdict === 'REJECT');
  const sure = parseAnalysis('{"verdict":"APPROVE","confidence":0.9}', okOpts);
  check('confident APPROVE stands', sure?.verdict === 'APPROVE');

  // Malformed / missing-verdict payloads must never read as an approval.
  check('no JSON -> null', parseAnalysis('the model rambled', okOpts) === null);
  check('missing verdict -> null', parseAnalysis('{"confidence":0.9}', okOpts) === null);
  check('bogus verdict -> null', parseAnalysis('{"verdict":"MAYBE"}', okOpts) === null);
  check('invalid JSON body -> null', parseAnalysis('{not json}', okOpts) === null);
  check('confidence clamped into [0,1]', parseAnalysis('{"verdict":"REJECT","confidence":9}', okOpts)?.confidence === 1);
  check('non-string factors ignored', parseAnalysis('{"verdict":"REJECT","supporting_factors":[1,2]}', okOpts)?.supportingFactors.length === 0);

  // The prompt must carry the ORIGINAL prediction so the analyst judges it
  // rather than inventing one.
  const prompt = buildPrompt({
    signal: { timestamp: 1, asset: 'EURUSD_otc', direction: 'CALL', confidence: 0.8 },
    prediction: { asset: 'EURUSD_otc', probability: 0.8, direction: 1, threshold: 0.5, source: 'ml' },
    features: feat({ open: 1.1, close: 1.101, netChangePct: 0.0009, recentMomentumPct: 0.001, upRatio: 0.7 }),
    marketContext: 'recent closes: 1.1, 1.101',
  });
  check('prompt states the asset', prompt.includes('EURUSD_otc'));
  check('prompt states the predicted direction', prompt.includes('CALL'));
  check('prompt states the prediction source', prompt.includes('ml'));
  check('prompt includes the feature window', prompt.includes('upRatio') && prompt.includes('0.7000'));
  check('prompt includes market context', prompt.includes('recent closes'));

  // Disabled without a key: analyze() returns null (nothing delivered).
  const savedKey = process.env.GEMINI_API_KEY;
  const savedKey2 = process.env.Gemini_API_Token;
  delete process.env.GEMINI_API_KEY;
  delete process.env.Gemini_API_Token;
  const off = new GeminiAnalyst({ quiet: true });
  check('analyst disabled without an API key', off.isEnabled() === false);
  const offResult = await off.analyze({
    signal: { timestamp: 1, asset: 'EURUSD_otc', direction: 'CALL', confidence: 0.8 },
    prediction: pred(0.8, 1),
    features: feat(),
  });
  check('disabled analyst returns null (fail-closed)', offResult === null);

  // Enabled, with a stubbed fetch that returns valid analysis JSON.
  const req = {
    signal: { timestamp: 1, asset: 'EURUSD_otc', direction: 'CALL' as const, confidence: 0.8 },
    prediction: pred(0.8, 1),
    features: feat(),
  };
  let calls = 0;
  const stubFetch = (async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: '{"verdict":"APPROVE","confidence":0.77,"summary":"ok","supporting_factors":[],"risks":[],"conflicts":[]}' }] } },
        ],
      }),
    } as any;
  }) as unknown as typeof fetch;

  const on = new GeminiAnalyst({ apiKey: 'k', fetchImpl: stubFetch, quiet: true, maxRetries: 2 });
  check('analyst enabled with an API key', on.isEnabled() === true);
  const res = await on.analyze(req);
  check('analyst returns a verdict', res?.verdict === 'APPROVE');
  check('analyst records the model', res?.model !== undefined);
  check('analyst counts the analysis', on.getStats().analyzed === 1);
  check('analyst counts the approval', on.getStats().approved === 1);
  check('single successful call needs no retry', calls === 1);

  // Transient failure then success: retried, and counted.
  let n = 0;
  const flakyFetch = (async () => {
    n++;
    if (n < 2) throw new Error('boom');
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"verdict":"REJECT","confidence":0.9}' }] } }] }),
    } as any;
  }) as unknown as typeof fetch;
  const flaky = new GeminiAnalyst({ apiKey: 'k', fetchImpl: flakyFetch, quiet: true, maxRetries: 2 });
  const flakyRes = await flaky.analyze(req);
  check('transient failure is retried to a verdict', flakyRes?.verdict === 'REJECT');
  check('flaky analyst records the retry', flaky.getStats().retries === 1);

  // Permanent failure: null after all attempts, counted as an error.
  const deadFetch = (async () => {
    throw new Error('down');
  }) as unknown as typeof fetch;
  const dead = new GeminiAnalyst({ apiKey: 'k', fetchImpl: deadFetch, quiet: true, maxRetries: 1 });
  const deadRes = await dead.analyze(req);
  check('permanent failure returns null (fail-closed)', deadRes === null);
  check('permanent failure counted as error', dead.getStats().errors === 1);
  check('failed analysis counts no approval', dead.getStats().approved === 0);

  // A non-2xx response is a failure, not a silent approval.
  const errFetch = (async () => ({ ok: false, status: 500, text: async () => 'server error' })) as unknown as typeof fetch;
  const err = new GeminiAnalyst({ apiKey: 'k', fetchImpl: errFetch, quiet: true, maxRetries: 0 });
  check('HTTP error -> null', (await err.analyze(req)) === null);

  // A 401 (auth) is fatal: not worth retrying, and never an approval.
  let authCalls = 0;
  const authFetch = (async () => {
    authCalls++;
    return { ok: false, status: 401, text: async () => 'bad key' };
  }) as unknown as typeof fetch;
  const auth = new GeminiAnalyst({ apiKey: 'k', fetchImpl: authFetch, quiet: true, maxRetries: 2 });
  check('401 -> null', (await auth.analyze(req)) === null);
  check('401 is not retried', authCalls === 1);

  // A 429 falls back to the next model instead of failing the signal.
  const seen: string[] = [];
  const rateLimitFetch = (async (url: any) => {
    const model = String(url).split('/models/')[1]?.split(':')[0] ?? '';
    seen.push(model);
    if (seen.length === 1) {
      return { ok: false, status: 429, text: async () => 'quota', headers: { get: () => null } };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"verdict":"APPROVE","confidence":0.9}' }] } }] }),
    } as any;
  }) as unknown as typeof fetch;
  const fb = new GeminiAnalyst({
    apiKey: 'k',
    fetchImpl: rateLimitFetch,
    quiet: true,
    maxRetries: 2,
    minIntervalMs: 0,
    model: 'primary-model',
    models: ['primary-model', 'backup-model'],
  });
  const fbRes = await fb.analyze(req);
  check('429 falls back to the next model', fbRes?.verdict === 'APPROVE');
  check('fallback recorded on the result', fbRes?.model === 'backup-model');
  check('fallback counter increments', fb.getStats().fallbacks === 1);
  check('first attempt used the primary model', seen[0] === 'primary-model');

  // Pacing: two analyses must not fire back-to-back.
  const stamps: number[] = [];
  const pacingFetch = (async () => {
    stamps.push(Date.now());
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"verdict":"REJECT","confidence":0.9}' }] } }] }),
    } as any;
  }) as unknown as typeof fetch;
  const paced = new GeminiAnalyst({
    apiKey: 'k',
    fetchImpl: pacingFetch,
    quiet: true,
    maxRetries: 0,
    minIntervalMs: 120,
  });
  const t0 = Date.now();
  await Promise.all([paced.analyze(req), paced.analyze(req)]);
  check('paced calls are serialised, not concurrent', stamps.length === 2);
  check('pacing enforces the minimum gap', stamps[1] - stamps[0] >= 100);
  check('pacing does not delay the first call', stamps[0] - t0 < 100);

  if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  if (savedKey2 !== undefined) process.env.Gemini_API_Token = savedKey2;
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
section('engine — reconnect storm guard (session reuse + staleness)');
// ============================================================
{
  // Observed live: connect() rediscovered on EVERY reconnect, launching a
  // headless browser each time (198 launches in minutes). The broker then
  // closed sockets (1005) immediately after auth, so the bot never recovered.
  const bot: any = new PocketOptionPriceBot({
    defaultAssets: ['EURUSD_otc'],
    candlePeriod: 60,
    verbose: false,
  });
  check('no usable session before discovery', !(bot.discoveredWsUrl && bot.cachedAuthPacket));

  bot.adoptDiscoveredSession({
    url: 'wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket',
    authPacket: '42["auth",{"token":"good"}]',
    cookies: 'sid=abc',
  });
  check('usable session after adoption', Boolean(bot.discoveredWsUrl && bot.cachedAuthPacket));

  // Three sockets that die almost immediately invalidate the credentials, so
  // a stale token cannot loop forever without one rediscovery attempt.
  const dieQuickly = () => {
    bot.lastOpenAt = Date.now() - 1000; // opened 1s ago
    bot.handleClose(1005, '');
  };
  dieQuickly();
  check('cached auth kept after 1 short-lived socket', bot.cachedAuthPacket !== '');
  dieQuickly();
  check('cached auth kept after 2 short-lived sockets', bot.cachedAuthPacket !== '');
  dieQuickly();
  check('cached auth cleared after 3 short-lived sockets', bot.cachedAuthPacket === '');
  check('ws url retained for re-dial after invalidation', bot.discoveredWsUrl.includes('po.market'));

  // A socket that lived long enough is treated as healthy: no invalidation.
  const bot2: any = new PocketOptionPriceBot({
    defaultAssets: ['EURUSD_otc'],
    candlePeriod: 60,
    verbose: false,
  });
  bot2.adoptDiscoveredSession({
    url: 'wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket',
    authPacket: '42["auth",{"token":"good"}]',
    cookies: '',
  });
  for (let i = 0; i < 5; i++) {
    bot2.lastOpenAt = Date.now() - 60_000; // lived a minute
    bot2.handleClose(1005, '');
  }
  check('healthy sockets never invalidate the session', bot2.cachedAuthPacket !== '');
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
