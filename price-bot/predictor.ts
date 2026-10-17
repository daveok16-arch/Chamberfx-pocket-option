/**
 * Predictor Layer — always-on direction prediction
 * ================================================
 * A prediction bot must predict on every window, not only once a trained model
 * happens to exist. This module provides two interchangeable predictors behind
 * one interface, plus a router that prefers the ML model and falls back to a
 * deterministic baseline:
 *
 *   - `LocalPredictor`  — no dependencies, no training, always answers. It is a
 *     transparent baseline (trend + momentum + tick-imbalance, scaled by the
 *     window's own realised volatility). It exists so the bot is continuously
 *     predicting while the dataset grows.
 *   - `PredictionRouter` — tries the Python ML service first; if it is disabled
 *     or returns no model (503), the local baseline answers instead. The source
 *     of every prediction is reported, so an ML answer is never confused with a
 *     baseline one.
 *
 * The local baseline is NOT claimed to be profitable. It is a placeholder that
 * keeps the pipeline honest and observable; the ML model supersedes it
 * automatically once one is trained and served.
 */

import type { FeatureWindow, PredictionResult } from './strategy.js';

/** Anything that can score a feature window into a direction prediction. */
export interface Predictor {
  /** Short identifier surfaced in logs and `/health`. */
  readonly name: string;
  /**
   * Score one window. Implementations must never throw and never return NaN.
   * @returns the prediction, or null when this predictor cannot answer.
   */
  predict(asset: string, features: FeatureWindow): Promise<PredictionResult | null>;
}

/** Floor on the volatility scale, so a dead-flat window cannot divide by zero. */
const MIN_VOL_SCALE = 1e-6;

/**
 * Deterministic baseline predictor.
 *
 * Blends three signals already present in the feature window, each normalised
 * by the window's own volatility so the same weights work across assets with
 * very different price scales (EURUSD ~1.13 vs XAUUSD ~4173):
 *
 *   - trend      : `netChangePct / volScale`  — direction over the window
 *   - momentum   : `momentum60s / open / volScale` — direction over the prior minute
 *   - imbalance  : `(upRatio - 0.5) * 2` — share of ticks that ticked up
 *
 * The blended score is squashed through a logistic. The output is clamped away
 * from 0 and 1 because a placeholder has no business claiming certainty — that
 * would sail straight through the confidence filter on no evidence.
 */
export class LocalPredictor implements Predictor {
  readonly name = 'local-baseline';

  /** Logistic steepness. Higher = more confident outputs. */
  private readonly sensitivity: number;

  constructor(opts: { sensitivity?: number } = {}) {
    this.sensitivity = opts.sensitivity ?? 1.5;
  }

  async predict(asset: string, features: FeatureWindow): Promise<PredictionResult> {
    const open = features.open;
    const volScale =
      Number.isFinite(features.stdDev) && open > 0
        ? Math.max(features.stdDev / open, MIN_VOL_SCALE)
        : MIN_VOL_SCALE;

    const trend =
      Number.isFinite(features.netChangePct) ? features.netChangePct / volScale : 0;
    const momentum =
      Number.isFinite(features.momentum60s) && open > 0
        ? features.momentum60s / open / volScale
        : 0;
    const imbalance =
      (Number.isFinite(features.upRatio) ? features.upRatio : 0.5) - 0.5;

    const score = 0.6 * Math.tanh(trend) + 0.4 * Math.tanh(momentum) + 1.6 * imbalance;
    let probability = 1 / (1 + Math.exp(-this.sensitivity * score));
    if (!Number.isFinite(probability)) probability = 0.5;
    probability = Math.min(Math.max(probability, 0.02), 0.98);

    return {
      asset,
      probability,
      // `>= threshold` matches the ML service's convention (app.py), so a
      // tie at 0.5 resolves the same way on both paths.
      direction: probability >= 0.5 ? 1 : 0,
      threshold: 0.5,
      source: 'local-baseline',
    };
  }
}

/**
 * Prefers the ML service, falls back to the local baseline.
 *
 * The fallback is what keeps the bot predicting continuously: `INFERENCE_URL`
 * may be unset, the service may be down, or no model may be trained yet (503).
 * In every one of those cases the baseline answers instead of the bot going
 * silent. `source` on each result records which predictor actually answered.
 */
export class PredictionRouter implements Predictor {
  readonly name: string;

  constructor(
    private readonly ml: Predictor | null,
    private readonly local: Predictor
  ) {
    this.name = ml ? `ml+${local.name}-fallback` : local.name;
  }

  async predict(asset: string, features: FeatureWindow): Promise<PredictionResult | null> {
    if (this.ml) {
      const fromMl = await this.ml.predict(asset, features);
      if (fromMl) return fromMl;
    }
    return this.local.predict(asset, features);
  }
}
