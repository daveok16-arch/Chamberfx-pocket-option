/**
 * Predictor Layer — ML-only direction prediction
 * ==============================================
 * Predictions come from exactly one source: the trained model served by the
 * Python inference service (`inference/app.py`). There is no deterministic
 * baseline fallback. A bot that ships a placeholder's guesses to a chat is
 * worse than a bot that stays quiet, so when no model is served the pipeline
 * collects data and predicts nothing.
 *
 *   - `MlPredictor` — the only predictor. It scores a feature window through
 *     `InferenceClient`; a null answer means "no model", never "guess".
 *   - `PredictionRouter` — the seam between the collector and the predictor.
 *     It forwards to the ML predictor and returns null when the model cannot
 *     answer, so the caller simply skips the window.
 *
 * `source` on every result is always `'ml'`, so downstream code can assert
 * that nothing but the model ever produced a signal.
 */

import type { FeatureWindow, PredictionResult } from './strategy.js';

/** Anything that can score a feature window into a direction prediction. */
export interface Predictor {
  /** Short identifier surfaced in logs and `/health`. */
  readonly name: string;
  /**
   * Score one window. Implementations must never throw and never return NaN.
   * @returns the prediction, or null when this predictor cannot answer (e.g.
   *          no model is being served). A null is never a fallback trigger —
   *          the pipeline treats it as "no prediction for this window".
   */
  predict(asset: string, features: FeatureWindow): Promise<PredictionResult | null>;
}

/**
 * The ML predictor. Wraps whatever scores a window via the inference service
 * and tags every result as `'ml'`, so the source is unambiguous downstream.
 *
 * A null from the underlying scorer (service down, 503 no model, timeout,
 * malformed body) propagates as null: the window is not predicted. This is the
 * fail-closed behaviour — no model, no signal.
 */
export class MlPredictor implements Predictor {
  readonly name: string;

  constructor(private readonly ml: Predictor) {
    this.name = ml.name;
  }

  async predict(asset: string, features: FeatureWindow): Promise<PredictionResult | null> {
    const result = await this.ml.predict(asset, features);
    if (!result) return null;
    return { ...result, source: 'ml' };
  }
}

/**
 * Routes a window to the ML predictor.
 *
 * There is no fallback: a null answer is final and means the window is not
 * predicted. The class exists so the collector depends on a stable interface
 * and the ML-only policy is expressed in one place.
 */
export class PredictionRouter implements Predictor {
  readonly name: string;

  constructor(private readonly ml: Predictor | null) {
    this.name = ml ? ml.name : 'none';
  }

  async predict(asset: string, features: FeatureWindow): Promise<PredictionResult | null> {
    if (!this.ml) return null;
    return this.ml.predict(asset, features);
  }
}
