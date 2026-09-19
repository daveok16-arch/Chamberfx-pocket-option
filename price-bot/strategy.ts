/**
 * Strategy Layer — the decision seam behind the trade bot
 * ======================================================
 * Strategy is the ONLY place that decides trade direction. It consumes raw
 * market data (ticks + candles) and proposes CALL/PUT with an amount. The risk
 * layer then gate-keeps; the execution layer then acts.
 *
 * The previous rule-based implementations (candle-direction, range-reversion)
 * were removed on 2026-09-19 to make room for an AI/ML predictor. This file now
 * defines only the contract the predictor must satisfy; no trading logic lives
 * here. Provide an implementation and wire it in `trade-bot.ts`.
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
 * Placeholder strategy — never trades.
 *
 * Keeps the pipeline (capture -> strategy -> risk -> execution) intact and
 * safely inert until the AI/ML predictor is wired in. Replace this in
 * `trade-bot.ts` with the predictor's `Strategy` implementation.
 */
export class NullStrategy implements Strategy {
  readonly name = 'null';

  evaluate(_ctx: StrategyContext, _asset: string): StrategySignal | null {
    return null;
  }
}