/**
 * Strategy Layer — the decision engine behind the trade bot
 * =========================================================
 * Strategy is the ONLY place that decides trade direction. It consumes raw
 * market data (ticks + candles) and proposes CALL/PUT/WAIT with an amount.
 * The risk layer then gate-keeps; the execution layer then acts.
 *
 * This is intentionally a clean, pluggable interface for building the next
 * generation of strategies. A simple reference strategy is provided below.
 */

import type { Candle } from './server.js';

export type StrategyDirection = 'call' | 'put';

export interface StrategySignal {
  direction: StrategyDirection;
  /** Stake amount proposed (still subject to the risk cap). */
  amount: number;
  /** Expiry in seconds (60 | 180 | 300), matching the candle period. */
  duration: number;
}

export interface StrategyContext {
  /** Last-known price of the asset (0 if none yet). */
  price: number;
  /** Closed candles for the asset, oldest first. */
  candles: Candle[];
  /** Server/session clock in ms (use this, not Date.now(), for timing). */
  serverTime: number;
}

export interface Strategy {
  readonly name: string;
  /**
   * Called once per asset on each evaluate cycle (after a candle closes, and
   * periodically inside the candle). Returns a proposed trade, or null to wait.
   */
  evaluate(ctx: StrategyContext, asset: string): StrategySignal | null;
}

/**
 * Reference strategy — "candle-direction continuation".
 * If the just-closed candle closed above its open, propose CALL for the next
 * candle; below → PUT. Otherwise wait.
 *
 * Deliberately simple: it demonstrates the interface, and is a clean slot to
 * replace with the real next-generation strategy you plan to build.
 */
export class CandleDirectionStrategy implements Strategy {
  readonly name = 'candle-direction';

  evaluate(ctx: StrategyContext, _asset: string): StrategySignal | null {
    const last = ctx.candles[ctx.candles.length - 1];
    if (!last || !(ctx.price > 0)) return null;

    if (last.close > last.open) {
      return { direction: 'call', amount: 1, duration: 60 };
    }
    if (last.close < last.open) {
      return { direction: 'put', amount: 1, duration: 60 };
    }
    return null;
  }
}

export interface MultiAssetReversionConfig {
  /** Stake per proposed trade (small by design — spread across many assets). */
  amount: number;
  /** Candle/option duration (60 | 180 | 300), matched to the candle period. */
  duration: number;
  /** Minimum candles needed before trading an asset. */
  minCandles: number;
  /**
   * Minimum range (high - low) of the just-closed candle, as a fraction of
   * price. Filters out random-walk micro-candles that carry no edge.
   */
  minRangeRatio: number;
  /** How many candles (incl. the last) to inspect for trend alignment. */
  lookback: number;
  /** Skip trading if the recent net move exceeds this fraction of price. */
  maxTrendSlope: number;
}

/**
 * Multi-asset, small-stake range-reversion strategy.
 *
 * Idea (led by the OTC short-timeframe behavior observed on this feed): over a
 * 1/3/5-minute OTC candle, an over-extended push in one direction tends to get
 * faded — the next candle frequently reverses the just-closed one. So:
 *
 *   - Only act when the just-closed candle has REAL range (volatility filter),
 *     i.e. > minRangeRatio × price, so we're not betting on a random-walk slip.
 *   - Read the leading signal from candle anatomy: a long upper wick on a green
 *     candle = rejection of up-moves → propose PUT (fade it); a long lower wick
 *     on a red candle = rejection of down-moves → propose CALL.
 *   - Prefer a neutral/ranged setting: skip when the asset has been trending
 *     hard (net lookback slope > maxTrendSlope), because range-reversion
 *     logic misfires inside a strong trend.
 *   - Small, equal stake per trade across all 6 assets (the "small-stake,
 *     multi-asset" approach) — spread risk rather than concentrate it.
 *
 * This is leading (candle anatomy + range, no lagging indicators), consistent
 * with the project's design constraints.
 */
export class MultiAssetReversionStrategy implements Strategy {
  readonly name = 'multi-asset-reversion';

  private readonly cfg: MultiAssetReversionConfig;

  constructor(cfg: Partial<MultiAssetReversionConfig> = {}) {
    this.cfg = {
      amount: cfg.amount ?? 1,
      duration: cfg.duration ?? 60,
      minCandles: cfg.minCandles ?? 20,
      minRangeRatio: cfg.minRangeRatio ?? 0.0004,
      lookback: cfg.lookback ?? 8,
      maxTrendSlope: cfg.maxTrendSlope ?? 0.0005,
    };
  }

  evaluate(ctx: StrategyContext, _asset: string): StrategySignal | null {
    const candles = ctx.candles;
    if (candles.length < this.cfg.minCandles) return null;
    if (!(ctx.price > 0)) return null;

    const last = candles[candles.length - 1];
    const range = last.high - last.low;
    if (!(range > 0)) return null;

    // --- Volatility filter: skip micro/random-walk candles ---
    if (range < this.cfg.minRangeRatio * ctx.price) return null;

    // --- Trend-alignment filter: skip a strongly trending asset ---
    const look0 = candles[candles.length - this.cfg.lookback];
    const slope = Math.abs(last.close - look0.open) / look0.open;
    if (slope > this.cfg.maxTrendSlope) return null;

    const body = Math.abs(last.close - last.open);
    // Interested in rejection candles (small-to-moderate body, long opposing wick).
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;

    const minWick = this.cfg.minRangeRatio * ctx.price * 0.5;

    if (last.close > last.open && upperWick > body * 0.8 && upperWick > minWick) {
      // Green candle with an over-extended upper wick → rejected higher prices → fade down.
      return { direction: 'put', amount: this.cfg.amount, duration: this.cfg.duration };
    }
    if (last.close < last.open && lowerWick > body * 0.8 && lowerWick > minWick) {
      // Red candle with an over-extended lower wick → rejected lower prices → fade up.
      return { direction: 'call', amount: this.cfg.amount, duration: this.cfg.duration };
    }

    return null;
  }
}