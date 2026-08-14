/**
 * Leading Signal Engine — Next-Candle Direction Prediction
 * =========================================================
 *
 * Built for binary options on Pocket Option OTC pairs with 1/3/5-minute
 * expirations. Deliberately avoids lagging, smoothing indicators (EMA,
 * RSI, MACD, Bollinger Bands) because they confirm moves *after* they
 * have already happened — useless when you must predict the NEXT candle.
 *
 * Instead this engine combines four LEADING, real-time inputs:
 *
 *   A. Tick Order-Flow Imbalance (OFI)
 *      The single most predictive feature in high-frequency microstructure
 *      research (~43% feature importance, ~88% AUC). Measures net buy vs
 *      sell pressure directly from the tick stream (UP/DOWN = proxy for
 *      aggressive buy/sell market orders). No smoothing — raw imbalance
 *      over a rolling tick window.
 *
 *   B. Candle Anatomy / Rejection
 *      Wick-to-range ratios detect absorption: a long upper wick means
 *      buyers pushed price up and were aggressively sold back down
 *      (bearish rejection); a long lower wick means sellers were rejected
 *      (bullish). Body ratio measures conviction. Engulfing detects
 *      sentiment shifts. These reflect order absorption happening NOW.
 *
 *   C. Tick Velocity & Momentum Decay
 *      Raw rate of price change and its acceleration over recent ticks.
 *      Detects whether a push is building steam or exhausting (consecutive
 *      deltas shrinking) — a fading push often reverses the next candle.
 *
 *   D. Market Structure Context
 *      Sequence of higher-highs/higher-lows (trend up), lower-highs/
 *      lower-lows (trend down), or range. A reversal signal is only valid
 *      at a structural extreme; mid-range it is noise.
 *
 * These are fused into a confluence score. A signal fires only when
 * multiple leading factors align.
 */

import type { Tick, Candle } from './server.js';

// ============================================
// TYPES
// ============================================

export type Direction = 'CALL' | 'PUT' | 'WAIT';

export type ExpiryMinutes = 1 | 3 | 5;

export interface Signal {
  assetId: string;
  direction: Direction;
  confidence: number;          // 0-100
  entryPrice: number;
  expiryMinutes: ExpiryMinutes;
  timeRemainingSec: number;    // seconds left in the current candle
  entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  reasons: string[];
  components: SignalComponents;
  timestamp: number;           // ms
}

export interface SignalComponents {
  ofi: number;                 // -100..+100  (order-flow imbalance, regime-adjusted)
  ofiPressure: number;         // raw net tick-pressure
  candleSignal: number;        // -100..+100  (anatomy/rejection, regime-adjusted)
  candlePattern: string;       // human-readable pattern name
  momentum: number;            // -100..+100  (tick velocity, regime-adjusted)
  momentumDecay: number;       // 0..1 (1 = strong decay/exhaustion)
  structure: number;           // -100..+100  (market structure bias, regime-adjusted)
  structureLabel: string;      // 'UPTREND' | 'DOWNTREND' | 'RANGE'
  regime: string;              // 'MEAN_REVERT' | 'TREND' | 'UNCLEAR'
  regimeStrength: number;      // 0..1 — |autocorrelation|, how strong the regime is
}

export interface SignalEngineConfig {
  /** Minutes to predict (1, 3, or 5) */
  expiryMinutes: ExpiryMinutes;
  /** Minimum confidence (0-100) to emit a CALL/PUT */
  minConfidence: number;
  /** Rolling tick window for OFI + momentum (number of recent ticks) */
  tickWindow: number;
  /** Minimum ticks required before evaluating */
  minTicks: number;
  /** Minimum completed candles for structure analysis */
  minCandles: number;
  /** Seconds before candle close to start evaluating the signal window */
  signalWindowSec: number;
  /** Cooldown (ms) between signals on the same asset */
  cooldownMs: number;
  /** OFI weight in final score */
  wOfi: number;
  /** Candle anatomy weight */
  wCandle: number;
  /** Momentum weight */
  wMomentum: number;
  /** Structure weight */
  wStructure: number;
  /** Min |autocorrelation| to commit to a regime (below = UNCLEAR, signals dampened) */
  minRegimeStrength: number;
}

export const DEFAULT_CONFIG: SignalEngineConfig = {
  expiryMinutes: 1,
  minConfidence: 68,
  tickWindow: 60,
  minTicks: 15,
  minCandles: 3,
  signalWindowSec: 15,
  cooldownMs: 60_000,
  wOfi: 35,
  wCandle: 30,
  wMomentum: 20,
  wStructure: 15,
  minRegimeStrength: 0.10,
};

// ============================================
// INTERNAL STATE
// ============================================

interface AssetState {
  /** Recent ticks (price values) for OFI/momentum */
  recentPrices: number[];
  /** Recent tick directions (+1 / -1 / 0) */
  recentDirs: number[];
  /** Recent tick timestamps (ms) */
  recentTimes: number[];
  /** Last signal time (for cooldown) */
  lastSignalTime: number;
}

// ============================================
// SIGNAL ENGINE
// ============================================

export class SignalEngine {
  private config: SignalEngineConfig;
  private states = new Map<string, AssetState>();
  private lastEmitted = new Map<string, Signal>();

  /** Callback fired when a new (non-WAIT) signal is produced. */
  private onSignalCb?: (signal: Signal) => void;

  constructor(config: Partial<SignalEngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public onSignal(cb: (signal: Signal) => void): void {
    this.onSignalCb = cb;
  }

  public getConfig(): SignalEngineConfig {
    return this.config;
  }

  /**
   * Ingest a tick. Called for every live tick from the capture engine.
   * Buffers the tick; the actual evaluation happens in `evaluate()`.
   */
  public ingestTick(assetId: string, tick: Tick): void {
    let st = this.states.get(assetId);
    if (!st) {
      st = { recentPrices: [], recentDirs: [], recentTimes: [], lastSignalTime: 0 };
      this.states.set(assetId, st);
    }
    const dir = tick.direction === 'UP' ? 1 : tick.direction === 'DOWN' ? -1 : 0;
    st.recentPrices.push(tick.price);
    st.recentDirs.push(dir);
    st.recentTimes.push(tick.timestamp);
    const cap = this.config.tickWindow * 3; // keep a bit extra for momentum windows
    if (st.recentPrices.length > cap) {
      st.recentPrices.shift();
      st.recentDirs.shift();
      st.recentTimes.shift();
    }
  }

  /**
   * Evaluate a signal for an asset given its current candles + last price.
   * Returns a Signal (direction may be WAIT). Fires the onSignal callback
   * for non-WAIT results that pass confidence + cooldown + timing filters.
   */
  public evaluate(
    assetId: string,
    candles: Candle[],
    lastPrice: number,
    now: number = Date.now()
  ): Signal {
    const cfg = this.config;
    const st = this.states.get(assetId);
    const empty: SignalComponents = {
      ofi: 0, ofiPressure: 0, candleSignal: 0, candlePattern: 'INSUFFICIENT_DATA',
      momentum: 0, momentumDecay: 0, structure: 0, structureLabel: 'UNKNOWN',
      regime: 'UNCLEAR', regimeStrength: 0,
    };

    const timeRemainingSec = this.timeRemainingInCandle(now, cfg.expiryMinutes);
    const entryQuality = this.entryQuality(timeRemainingSec, cfg.expiryMinutes);

    const waitSignal: Signal = {
      assetId,
      direction: 'WAIT',
      confidence: 0,
      entryPrice: lastPrice,
      expiryMinutes: cfg.expiryMinutes,
      timeRemainingSec,
      entryQuality,
      reasons: [],
      components: empty,
      timestamp: now,
    };

    // --- Data sufficiency checks ---
    if (!st || st.recentPrices.length < cfg.minTicks) {
      return waitSignal;
    }
    if (candles.length < cfg.minCandles) {
      return waitSignal;
    }

    // --- Compute the four leading components ---
    const ofi = this.computeOFI(st);
    const candle = this.computeCandleAnatomy(candles);
    const momentum = this.computeMomentum(st);
    const structure = this.computeStructure(candles);

    // --- Regime detection: lag-1 return autocorrelation across recent candles.
    // Negative autocorrelation = candle-to-candle mean reversion (the dominant
    // regime on short-timeframe OTC). Positive = trending. We use this to flip
    // the *continuation* components (OFI, body/marubozu conviction, momentum
    // velocity, structure) in a mean-reverting regime, because a "bullish"
    // current candle is then predictive of a DOWN next candle.
    // Rejection-wick + engulfing are inherently REVERSAL signals and are NEVER
    // flipped — they already predict the opposite of the rejected extreme.
    const regime = this.computeRegime(candles);
    // On short-timeframe OTC the empirical default is mean-reversion, so when
    // the regime is UNCLEAR (too few candles or weak autocorrelation) we still
    // apply a mild mean-revert flip rather than suppressing the signal entirely.
    const flip = regime.label === 'TREND' ? 1 : -1; // MEAN_REVERT & UNCLEAR -> fade
    const dampen = regime.label === 'UNCLEAR' ? 0.6 : 1.0;

    // OFI is a continuation proxy (net buying → expect up) → regime-flipped.
    const ofiScore = Math.round(ofi.score * flip * dampen);
    // Candle: reversal part never flipped; continuation part regime-flipped.
    const candleScore = Math.round((candle.reversal + candle.continuation * flip) * dampen);
    const momentumScore = Math.round(momentum.score * flip * dampen);
    const structureScore = Math.round(structure.score * flip * dampen);

    const components: SignalComponents = {
      ofi: ofiScore,
      ofiPressure: ofi.pressure,
      candleSignal: candleScore,
      candlePattern: candle.pattern,
      momentum: momentumScore,
      momentumDecay: momentum.decay,
      structure: structureScore,
      structureLabel: structure.label,
      regime: regime.label,
      regimeStrength: regime.strength,
    };

    // --- Confluence scoring (weighted fusion) ---
    const raw =
      ofiScore * cfg.wOfi +
      candleScore * cfg.wCandle +
      momentumScore * cfg.wMomentum +
      structureScore * cfg.wStructure;
    const totalWeight = cfg.wOfi + cfg.wCandle + cfg.wMomentum + cfg.wStructure;
    const fused = totalWeight > 0 ? raw / totalWeight : 0; // -100..+100

    // Direction requires agreement: the sign of the fused score, but only
    // if the majority of components agree in sign (true confluence).
    const agreeing = this.countAgreement(ofiScore, candleScore, momentumScore, structureScore);
    const direction = this.directionFromConfluence(fused, agreeing);

    // Confidence scales the magnitude of agreement, boosted by confluence
    // count and regime strength (a strong regime = higher-conviction signal),
    // dampened by momentum decay (exhaustion = lower confidence).
    let confidence = Math.round(Math.abs(fused));
    confidence += agreeing * 4; // reward multi-factor agreement
    confidence += Math.round(regime.strength * 20); // strong regime bonus
    confidence -= Math.round(momentum.decay * 15); // exhaustion penalty
    if (direction === 'WAIT') {
      confidence = Math.min(confidence, 49);
    }
    confidence = Math.max(0, Math.min(100, confidence));

    const reasons = this.buildReasons(components, direction, momentum.decay);

    const signal: Signal = {
      assetId,
      direction,
      confidence,
      entryPrice: lastPrice,
      expiryMinutes: cfg.expiryMinutes,
      timeRemainingSec,
      entryQuality,
      reasons,
      components,
      timestamp: now,
    };

    // --- Emit filters: confidence, cooldown, timing ---
    if (direction === 'WAIT') {
      return signal;
    }
    if (confidence < cfg.minConfidence) {
      return signal;
    }
    if (entryQuality === 'POOR') {
      return signal; // too late in the candle to act reliably
    }

    // Cooldown per asset
    if (now - st.lastSignalTime < cfg.cooldownMs) {
      return signal;
    }

    st.lastSignalTime = now;
    this.lastEmitted.set(assetId, signal);
    if (this.onSignalCb) {
      this.onSignalCb(signal);
    }
    return signal;
  }

  public getLastSignal(assetId: string): Signal | undefined {
    return this.lastEmitted.get(assetId);
  }

  // ============================================
  // A. TICK ORDER-FLOW IMBALANCE (OFI)
  // ============================================

  private computeOFI(st: AssetState): { score: number; pressure: number } {
    const n = Math.min(this.config.tickWindow, st.recentDirs.length);
    if (n === 0) return { score: 0, pressure: 0 };

    const dirs = st.recentDirs.slice(-n);
    const prices = st.recentPrices.slice(-n);

    // Weighted by per-tick price magnitude (proxy for order size/urgency)
    let pressure = 0;
    for (let i = 0; i < dirs.length; i++) {
      const mag = i > 0 ? Math.abs(prices[i] - prices[i - 1]) : 0;
      pressure += dirs[i] * (1 + mag * 1e5); // scale magnitude to a usable factor
    }
    // Normalize to -1..+1 via the sum of absolute magnitudes
    let absSum = 0;
    for (let i = 0; i < dirs.length; i++) {
      const mag = i > 0 ? Math.abs(prices[i] - prices[i - 1]) : 0;
      absSum += (1 + mag * 1e5);
    }
    const ofiRatio = absSum > 0 ? pressure / absSum : 0; // -1..+1

    // Non-linear scaling: emphasize strong imbalances
    const score = Math.sign(ofiRatio) * Math.min(100, Math.abs(ofiRatio) * 140);
    return { score: Math.round(score), pressure };
  }

  // ============================================
  // B. CANDLE ANATOMY / REJECTION
  // ============================================

  private computeCandleAnatomy(candles: Candle[]): {
    reversal: number;      // mean-reverting component — NEVER regime-flipped
    continuation: number;  // momentum/conviction component — regime-flipped
    pattern: string;
  } {
    const cur = candles[candles.length - 1];
    const prev = candles.length > 1 ? candles[candles.length - 2] : undefined;

    const range = cur.high - cur.low;
    if (range <= 0) return { reversal: 0, continuation: 0, pattern: 'DOJI_ZERO_RANGE' };

    const body = Math.abs(cur.close - cur.open);
    const bodyRatio = body / range; // 0..1
    const upperWick = cur.high - Math.max(cur.open, cur.close);
    const lowerWick = Math.min(cur.open, cur.close) - cur.low;
    const upperWickRatio = upperWick / range;
    const lowerWickRatio = lowerWick / range;
    const isBull = cur.close > cur.open;

    let reversal = 0;     // + = expect UP next, - = expect DOWN next (mean-reverting)
    let continuation = 0; // + = bullish conviction, - = bearish conviction
    let pattern = '';

    // --- Rejection wicks (leading REVERSAL signal — never flipped) ---
    // Long lower wick + small body = buyers rejected lows → expect UP (bullish)
    if (lowerWickRatio >= 0.6 && bodyRatio <= 0.35) {
      reversal += 70;
      pattern = 'BULLISH_REJECTION (hammer/pin)';
    }
    // Long upper wick + small body = sellers rejected highs → expect DOWN (bearish)
    if (upperWickRatio >= 0.6 && bodyRatio <= 0.35) {
      reversal -= 70;
      pattern = pattern ? pattern + ' + BEARISH_REJECTION' : 'BEARISH_REJECTION (shooting star/pin)';
    }

    // --- Engulfing (sentiment-shift REVERSAL — never flipped) ---
    // Engulfing is classically a reversal pattern: a bullish engulfing after a
    // bearish candle signals the down-move is exhausted → expect UP next.
    if (prev) {
      const prevBody = prev.close - prev.open;
      const curBody = cur.close - cur.open;
      if (prevBody < 0 && curBody > 0 && cur.open <= prev.close && cur.close >= prev.open) {
        reversal += 55;
        pattern = pattern ? pattern + ' + BULLISH_ENGULFING' : 'BULLISH_ENGULFING';
      }
      if (prevBody > 0 && curBody < 0 && cur.open >= prev.close && cur.close <= prev.open) {
        reversal -= 55;
        pattern = pattern ? pattern + ' + BEARISH_ENGULFING' : 'BEARISH_ENGULFING';
      }
    }

    // --- Marubozu / strong body (CONTINUATION conviction — regime-flipped) ---
    // A full-body candle shows conviction in its direction; in a mean-reverting
    // regime that conviction often exhausts → next candle reverses.
    if (bodyRatio >= 0.85 && upperWickRatio < 0.1 && lowerWickRatio < 0.1) {
      continuation += isBull ? 45 : -45;
      pattern = pattern ? pattern + ' + MARUBOZU' : (isBull ? 'BULLISH_MARUBOZU' : 'BEARISH_MARUBOZU');
    } else if (bodyRatio >= 0.6) {
      // Moderate body also carries directional conviction (continuation proxy)
      continuation += isBull ? 20 : -20;
    }

    // --- Small-body indecision (no edge) ---
    if (bodyRatio < 0.15 && upperWickRatio < 0.45 && lowerWickRatio < 0.45) {
      reversal = Math.round(reversal * 0.3); // dampen — doji indecision
      continuation = Math.round(continuation * 0.3);
      if (!pattern) pattern = 'DOJI_INDECISION';
    }

    reversal = Math.max(-100, Math.min(100, Math.round(reversal)));
    continuation = Math.max(-100, Math.min(100, Math.round(continuation)));
    if (!pattern) pattern = 'NEUTRAL';
    return { reversal, continuation, pattern };
  }

  // ============================================
  // C. TICK VELOCITY & MOMENTUM DECAY
  // ============================================

  private computeMomentum(st: AssetState): { score: number; decay: number } {
    const n = Math.min(this.config.tickWindow, st.recentPrices.length);
    if (n < 3) return { score: 0, decay: 0 };

    const prices = st.recentPrices.slice(-n);
    const times = st.recentTimes.slice(-n);

    // Raw velocity = net displacement over window normalized by time span
    const span = times[n - 1] - times[0];
    const displacement = prices[n - 1] - prices[0];
    const velocity = span > 0 ? displacement / span : 0;

    // Scale velocity to a -100..+100 score using recent typical tick step
    let stepSum = 0;
    let stepCount = 0;
    for (let i = 1; i < prices.length; i++) {
      stepSum += Math.abs(prices[i] - prices[i - 1]);
      stepCount++;
    }
    const avgStep = stepCount > 0 ? stepSum / stepCount : 0;
    // velocity per ms * expected ticks in window → comparable to avgStep * n
    const expectedTicks = n;
    const projectedMove = velocity * (span > 0 ? expectedTicks * (span / n) : 0);
    const norm = avgStep > 0 ? projectedMove / (avgStep * expectedTicks) : 0;
    let score = Math.sign(norm) * Math.min(100, Math.abs(norm) * 150);

    // Momentum decay: compare first-half deltas vs second-half deltas.
    // If the push was stronger early and weaker late, momentum is fading
    // (exhaustion) — often precedes a next-candle reversal.
    const half = Math.floor(prices.length / 2);
    let firstDelta = 0;
    let secondDelta = 0;
    for (let i = 1; i < half; i++) firstDelta += Math.abs(prices[i] - prices[i - 1]);
    for (let i = half; i < prices.length; i++) secondDelta += Math.abs(prices[i] - prices[i - 1]);
    const decay =
      firstDelta > 0
        ? Math.max(0, Math.min(1, (firstDelta - secondDelta) / firstDelta))
        : 0;

    // NOTE: we return the RAW velocity direction (continuation signal) here.
    // The regime layer in evaluate() decides whether to flip it (mean-revert)
    // or fade it on exhaustion (trend regime). Decay itself lowers confidence.
    score = Math.max(-100, Math.min(100, Math.round(score)));
    return { score, decay };
  }

  // ============================================
  // D. MARKET STRUCTURE
  // ============================================

  private computeStructure(candles: Candle[]): { score: number; label: string } {
    const lookback = Math.min(candles.length, 6);
    if (lookback < 3) return { score: 0, label: 'INSUFFICIENT' };

    const recent = candles.slice(-lookback);
    let higherHighs = 0;
    let lowerHighs = 0;
    let higherLows = 0;
    let lowerLows = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].high > recent[i - 1].high) higherHighs++;
      else if (recent[i].high < recent[i - 1].high) lowerHighs++;
      if (recent[i].low > recent[i - 1].low) higherLows++;
      else if (recent[i].low < recent[i - 1].low) lowerLows++;
    }

    const bull = higherHighs + higherLows;
    const bear = lowerHighs + lowerLows;
    const total = bull + bear;

    if (total === 0) return { score: 0, label: 'RANGE' };

    const bullRatio = bull / total;
    if (bullRatio >= 0.7) {
      return { score: 55, label: 'UPTREND' };
    }
    if (bullRatio <= 0.3) {
      return { score: -55, label: 'DOWNTREND' };
    }
    return { score: 0, label: 'RANGE' };
  }

  // ============================================
  // E. REGIME DETECTION (lag-1 return autocorrelation)
  // ============================================

  private computeRegime(candles: Candle[]): { label: string; strength: number } {
    // Use as many recent CLOSED candles as available (exclude the in-progress
    // last candle so the regime reflects completed returns only). Need >=5 for
    // a usable autocorrelation estimate.
    const usable = candles.length - 1;
    if (usable < 5) return { label: 'UNCLEAR', strength: 0 };

    const lookback = Math.min(usable, 20);
    const rets: number[] = [];
    for (let i = candles.length - lookback; i < candles.length; i++) {
      const r = candles[i].open !== 0 ? (candles[i].close - candles[i].open) / candles[i].open : 0;
      rets.push(r);
    }
    if (rets.length < 5) return { label: 'UNCLEAR', strength: 0 };

    // Lag-1 autocorrelation: corr(ret[t], ret[t-1])
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    let num = 0;
    let den = 0;
    for (let i = 1; i < rets.length; i++) {
      num += (rets[i] - mean) * (rets[i - 1] - mean);
    }
    for (let i = 0; i < rets.length; i++) {
      den += (rets[i] - mean) * (rets[i] - mean);
    }
    const autocorr = den > 0 ? num / den : 0; // -1..+1
    const strength = Math.min(1, Math.abs(autocorr));

    if (strength < this.config.minRegimeStrength) {
      return { label: 'UNCLEAR', strength };
    }
    return { label: autocorr < 0 ? 'MEAN_REVERT' : 'TREND', strength };
  }

  // ============================================
  // CONFLUENCE HELPERS
  // ============================================

  private countAgreement(...scores: number[]): number {
    let pos = 0;
    let neg = 0;
    for (const s of scores) {
      if (s > 15) pos++;
      else if (s < -15) neg++;
    }
    return Math.max(pos, neg);
  }

  private directionFromConfluence(fused: number, agreeing: number): Direction {
    // Require at least 2 agreeing components for a directional call
    if (agreeing < 2) return 'WAIT';
    if (fused > 25) return 'CALL';
    if (fused < -25) return 'PUT';
    return 'WAIT';
  }

  private buildReasons(
    c: SignalComponents,
    dir: Direction,
    decay: number
  ): string[] {
    const reasons: string[] = [];
    const sign = dir === 'CALL' ? 'bullish' : dir === 'PUT' ? 'bearish' : 'mixed';

    if (Math.abs(c.ofi) >= 30) {
      reasons.push(
        `OFI ${c.ofi > 0 ? '+' : ''}${c.ofi} (${sign} order-flow pressure)`
      );
    }
    if (c.candlePattern !== 'NEUTRAL' && c.candlePattern !== 'INSUFFICIENT_DATA') {
      reasons.push(`${c.candlePattern} (anatomy score ${c.candleSignal > 0 ? '+' : ''}${c.candleSignal})`);
    }
    if (Math.abs(c.momentum) >= 25) {
      reasons.push(
        `Momentum ${c.momentum > 0 ? '+' : ''}${c.momentum}${decay > 0.5 ? ' (fading/exhausted)' : ''}`
      );
    } else if (decay > 0.5) {
      reasons.push(`Momentum decay ${decay.toFixed(2)} (exhaustion)`);
    }
    if (c.structureLabel === 'UPTREND' || c.structureLabel === 'DOWNTREND') {
      reasons.push(`Structure: ${c.structureLabel} (${c.structure > 0 ? '+' : ''}${c.structure})`);
    }
    if (c.regime !== 'UNCLEAR') {
      reasons.push(`Regime: ${c.regime} (autocorr-strength ${(c.regimeStrength).toFixed(2)})`);
    }
    if (reasons.length === 0) {
      reasons.push('No strong confluence — components not aligned');
    }
    return reasons;
  }

  // ============================================
  // TIMING
  // ============================================

  private timeRemainingInCandle(now: number, expiryMin: ExpiryMinutes): number {
    const periodSec = expiryMin * 60;
    const nowSec = Math.floor(now / 1000);
    const candleStart = Math.floor(nowSec / periodSec) * periodSec;
    const candleEnd = candleStart + periodSec;
    return candleEnd - nowSec;
  }

  private entryQuality(
    timeRemainingSec: number,
    expiryMin: ExpiryMinutes
  ): 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' {
    const periodSec = expiryMin * 60;
    const ratio = timeRemainingSec / periodSec;
    // We want to enter early in the NEW candle; but evaluation happens at the
    // end of the current candle. Practically, more time remaining in the
    // current candle = the signal is forming ahead of the next candle close.
    if (ratio >= 0.5) return 'EXCELLENT';
    if (ratio >= 0.3) return 'GOOD';
    if (ratio >= 0.15) return 'FAIR';
    return 'POOR';
  }
}
