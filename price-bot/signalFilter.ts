/**
 * Signal Quality Filters & Confidence Guardrails
 * ==============================================
 * Phase 3. This module sits between the ML prediction and whatever consumes it
 * (logs, UI, future execution). Its only job is to reject weak signals.
 *
 * It is a pure, side-effect-free gate: given a prediction and the feature
 * window it came from, it returns either an accepted signal payload or a
 * discard reason. Logging is left to the caller so the rules stay testable.
 *
 * Two filters, applied in order:
 *   1. Confidence — reject the ambiguous band around 0.5.
 *   2. Volatility — reject windows whose 60s range is abnormally wide.
 */

import type { FeatureWindow, PredictionResult } from './strategy.js';

// ============================================
// FILTER CONFIGURATION
// ============================================

/**
 * Minimum confidence required to emit a signal.
 *
 * "Confidence" is the probability of the direction being called, i.e.
 * `max(P, 1 - P)`, NOT `P` itself. A model that is 90% sure of DOWN outputs
 * P(UP) = 0.10, which is a *high*-confidence PUT. Scoring that as 0.10
 * confidence would discard the model's best calls and keep its coin flips.
 */
export const MIN_CONFIDENCE_THRESHOLD = 0.65;

/**
 * Maximum tolerated spread volatility for a 60s window, as a fraction of
 * price: `(high - low) / open`.
 *
 * Windows above this are treated as unstable — a violent 60s range usually
 * means news/illiquidity, where the historical feature distribution the model
 * learned no longer describes the current regime.
 */
export const MAX_SPREAD_VOLATILITY_PCT = 0.02;

/**
 * The ambiguous "No-Trade Zone" in P(UP) space.
 *
 * A probability inside this band is too close to a coin flip to act on.
 * This band is the P-space expression of `MIN_CONFIDENCE_THRESHOLD`: a
 * confidence floor of 0.65 rejects `[0.36, 0.64]` plus the thin slices
 * `(0.35, 0.36)` and `(0.64, 0.65)`. Both checks are applied, so the stricter
 * of the two always wins.
 */
export const NO_TRADE_ZONE_LOW = 0.36;
export const NO_TRADE_ZONE_HIGH = 0.64;

/** Direction labels in the broker's binary-options vocabulary. */
export type SignalDirection = 'CALL' | 'PUT';

/** The structured payload emitted for a signal that clears every filter. */
export interface ValidSignal {
  /** Server-clock ms of the scored window (Pocket Option clock, not Date.now()). */
  timestamp: number;
  asset: string;
  /** CALL = price up, PUT = price down. */
  direction: SignalDirection;
  /** Confidence in the called direction: max(P, 1 - P). */
  confidence: number;
}

/** Discard reasons, kept as a closed union so callers must handle all cases. */
export type DiscardReason = 'LOW_CONFIDENCE' | 'UNSTABLE_VOLATILITY';

export type FilterOutcome =
  | { accepted: true; signal: ValidSignal }
  | { accepted: false; reason: DiscardReason; detail: string };

// ============================================
// FILTERS
// ============================================

/**
 * Spread volatility of a window as a fraction of its open price.
 *
 * `FeatureWindow` carries `range` (absolute) and `open`, but no `rangePct`
 * field, so it is derived here — this is the same quantity the Python model
 * sees as `rangePct`.
 *
 * @returns `(high - low) / open`, or 0 when the window has no usable open
 *          price (rather than Infinity/NaN, which would poison the comparison).
 */
export function computeRangePct(features: FeatureWindow): number {
  const open = features.open;
  if (!Number.isFinite(open) || open <= 0) return 0;
  const range = features.range;
  if (!Number.isFinite(range) || range < 0) return 0;
  return range / open;
}

/**
 * Confidence in the called direction.
 * @returns `max(P, 1 - P)`, clamped to [0, 1]; 0.5 for a non-finite input.
 */
export function computeConfidence(probability: number): number {
  if (!Number.isFinite(probability)) return 0.5;
  const p = Math.min(Math.max(probability, 0), 1);
  return Math.max(p, 1 - p);
}

/**
 * Apply the confidence guardrail.
 *
 * Rejects when EITHER the configured confidence floor is breached OR the
 * probability sits inside the explicit no-trade band. The two overlap by
 * design; the no-trade band is the tighter statement of the same intent.
 */
export function passesConfidence(probability: number): boolean {
  const confidence = computeConfidence(probability);
  if (confidence < MIN_CONFIDENCE_THRESHOLD) return false;

  const p = probability;
  if (p >= NO_TRADE_ZONE_LOW && p <= NO_TRADE_ZONE_HIGH) return false;

  return true;
}

/**
 * Apply the volatility guardrail.
 * @returns false when the window's 60s range exceeds the allowed maximum.
 */
export function passesVolatility(features: FeatureWindow): boolean {
  return computeRangePct(features) <= MAX_SPREAD_VOLATILITY_PCT;
}

/**
 * Run every filter over one prediction + its source window.
 *
 * Order: confidence, then volatility. Both are pure checks, so the order only
 * affects which reason is reported when a signal fails both.
 *
 * @param prediction - the `/predict` response.
 * @param features   - the 60s window that was scored.
 * @returns an accepted signal payload, or the reason it was discarded.
 */
export function evaluateSignal(
  prediction: PredictionResult,
  features: FeatureWindow
): FilterOutcome {
  if (!passesConfidence(prediction.probability)) {
    return {
      accepted: false,
      reason: 'LOW_CONFIDENCE',
      detail: `Low confidence (P = ${prediction.probability.toFixed(2)})`,
    };
  }

  if (!passesVolatility(features)) {
    return {
      accepted: false,
      reason: 'UNSTABLE_VOLATILITY',
      detail:
        `Unstable volatility (rangePct = ${computeRangePct(features).toFixed(4)} ` +
        `> ${MAX_SPREAD_VOLATILITY_PCT})`,
    };
  }

  return {
    accepted: true,
    signal: {
      timestamp: features.lastTickAt,
      asset: prediction.asset,
      direction: prediction.direction === 1 ? 'CALL' : 'PUT',
      confidence: computeConfidence(prediction.probability),
    },
  };
}