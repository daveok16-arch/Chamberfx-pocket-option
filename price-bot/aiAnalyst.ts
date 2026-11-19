/**
 * AI Analysis Layer — independent verification of a prediction before delivery
 * ===========================================================================
 * This module is a *filter*, not a predictor. It receives the original
 * prediction produced by the project's prediction engine (`predictor.ts` ->
 * `PredictionRouter` -> the ML service in `inference/app.py`) together with the
 * feature window it was scored from, and asks a language model to independently
 * judge it.
 *
 * Hard rules encoded here:
 *   - The analyst never invents a prediction. The prompt forbids it, and the
 *     original `PredictionResult` / `ValidSignal` objects are passed through
 *     untouched — the analysis is returned as a separate object.
 *   - Weak, incomplete or unreliable signals are rejected. A failed analysis
 *     (network error, timeout, unparseable response) is FAIL-CLOSED: the
 *     caller receives `null` and must not deliver. This is what keeps
 *     unverified signals off Telegram.
 *   - The model's own confidence is not trusted blindly: an APPROVE below the
 *     configured floor is downgraded to REJECT by this layer.
 *
 * The model is called over plain `fetch` (no SDK), so the dependency surface
 * stays at zero. The HTTP boundary is injectable (`fetchImpl`) purely so the
 * parsing/retry/guardrail logic can be tested without a live API key.
 */

import type { FeatureWindow, PredictionResult } from './strategy.js';
import type { ValidSignal } from './signalFilter.js';

/** Everything the analyst is allowed to see about one signal. */
export interface AnalysisRequest {
  /** The filtered signal proposed by the prediction engine. */
  signal: ValidSignal;
  /** The raw prediction that produced it (kept intact, never mutated). */
  prediction: PredictionResult;
  /** The trailing feature window the prediction was scored from. */
  features: FeatureWindow;
  /** Compact, human-readable recent market context (e.g. last closes). */
  marketContext?: string;
}

/** The analyst's verdict plus the evidence behind it. */
export interface AiAnalysis {
  verdict: 'APPROVE' | 'REJECT';
  /** The analyst's confidence in its own verdict, 0..1. */
  confidence: number;
  /** One-paragraph explanation. */
  summary: string;
  /** Factors that support the prediction. */
  supportingFactors: string[];
  /** Risk warnings. */
  risks: string[];
  /** Indicators that contradict the prediction. */
  conflicts: string[];
  /** Which model produced the verdict. */
  model: string;
  /** Wall-clock latency of the (successful) call, ms. */
  latencyMs: number;
  /** How many attempts were needed. */
  attempts: number;
}

export interface AnalystStats {
  enabled: boolean;
  model: string;
  /** Signals sent for analysis. */
  analyzed: number;
  approved: number;
  rejected: number;
  /** Analyses that could not be completed (fail-closed; nothing delivered). */
  errors: number;
  /** Retries performed across all analyses. */
  retries: number;
  /** Attempts that moved to a fallback model after a 429/404/5xx. */
  fallbacks: number;
}

/** Anything that can independently judge a prediction. */
export interface SignalAnalyst {
  readonly name: string;
  isEnabled(): boolean;
  /** @returns the analysis, or null when it could not be produced. */
  analyze(req: AnalysisRequest): Promise<AiAnalysis | null>;
  getStats(): AnalystStats;
}

/** Default model. Flash-lite is fast and has more free-tier headroom. */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest';
/**
 * Models tried in order when the configured one is rate-limited (429) or
 * unavailable (404). Observed live: the free tier exhausts `gemini-2.5-flash`
 * while `gemini-flash-lite-latest` still answers, and a six-asset bucket fires
 * six analyses at once. Falling back keeps the gate running instead of
 * withholding every signal.
 */
export const DEFAULT_MODEL_FALLBACKS = [
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];
/** Default per-attempt timeout (ms). */
export const DEFAULT_AI_TIMEOUT_MS = 20_000;
/** Default number of retries after the first attempt. */
export const DEFAULT_AI_MAX_RETRIES = 2;
/**
 * Minimum gap between two outbound analyses (ms). The bucket boundary is
 * wall-clock aligned, so all six assets are scored in the same tick and would
 * otherwise fire six concurrent requests — the exact burst that triggers a 429.
 * Serialising with a gap keeps the request rate under the limit.
 */
export const DEFAULT_MIN_INTERVAL_MS = 4_000;
/**
 * Minimum analyst confidence for an APPROVE to stand.
 *
 * An approval below this is downgraded to REJECT by this layer. The point of
 * the gate is to keep weak signals off the chat, so an unsure approval is
 * treated as a rejection rather than trusted.
 */
export const DEFAULT_MIN_AI_CONFIDENCE = 0.6;

const SYSTEM_INSTRUCTION = [
  'You are an independent quantitative risk analyst reviewing trade signals for',
  'binary-options OTC currency pairs. A separate prediction engine produced the',
  'signal. Your job is to judge it, not to replace it.',
  '',
  'You must NOT invent a new prediction, change the direction, or propose a',
  'different asset. Evaluate only the signal you are given.',
  '',
  'Assess:',
  '  1. Whether the feature window actually supports the claimed direction.',
  '  2. The strength and reliability of the signal (magnitude, consistency of',
  '     tick imbalance vs net change vs recent momentum, tick coverage).',
  '  3. Conflicting indicators between the features (e.g. trend up but tick',
  '     imbalance down, or momentum disagreeing with net change).',
  '  4. Risks and weaknesses (low tick count, short window coverage, abnormal',
  '     volatility, near-threshold probability, weak/unproven model source).',
  '  5. Whether the prediction is sufficiently supported to act on.',
  '',
  'Reject weak, incomplete, internally contradictory, or unreliable signals.',
  'Be strict: a signal that is merely plausible is not enough.',
  '',
  'Reply with ONLY a JSON object, no prose and no code fences:',
  '{',
  '  "verdict": "APPROVE" | "REJECT",',
  '  "confidence": <number 0..1, your confidence in this verdict>,',
  '  "summary": "<one or two sentences>",',
  '  "supporting_factors": ["<factor>", ...],',
  '  "risks": ["<risk>", ...],',
  '  "conflicts": ["<conflicting indicator>", ...]',
  '}',
].join('\n');

/** Coerce a value into a bounded float, defaulting on anything unusable. */
function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read an environment variable as a non-empty string.
 * An unset OR empty value is treated as absent — an empty string is what a
 * shell passes for `VAR=""`, and treating it as set would silently override a
 * default with "".
 */
function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.length > 0 ? v : undefined;
}

/** Coerce a value into an array of non-empty trimmed strings. */
function strList(v: unknown, cap = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, cap);
}

/** Coerce a value into a trimmed string with a length cap. */
function str(v: unknown, cap = 600): string {
  return typeof v === 'string' ? v.trim().slice(0, cap) : '';
}

/**
 * Parse the model's JSON reply into an `AiAnalysis`.
 *
 * Tolerates a fenced code block around the JSON (models add one despite the
 * instruction). Returns null when the payload has no usable verdict, so a
 * malformed reply can never be read as an approval.
 *
 * @param text      - raw model output.
 * @param opts.model - model id, recorded on the result.
 * @param opts.latencyMs - measured latency, recorded on the result.
 * @param opts.attempts - attempts used, recorded on the result.
 * @param opts.minConfidence - approvals below this are downgraded to REJECT.
 */
export function parseAnalysis(
  text: string,
  opts: { model: string; latencyMs: number; attempts: number; minConfidence: number }
): AiAnalysis | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const rawVerdict = str(parsed.verdict).toUpperCase();
  if (rawVerdict !== 'APPROVE' && rawVerdict !== 'REJECT') return null;

  const confidence = Math.min(Math.max(num(parsed.confidence, 0), 0), 1);

  // Guardrail: an unsure approval is not an approval.
  let verdict: AiAnalysis['verdict'] = rawVerdict;
  if (verdict === 'APPROVE' && confidence < opts.minConfidence) verdict = 'REJECT';

  return {
    verdict,
    confidence,
    summary: str(parsed.summary) || (verdict === 'APPROVE' ? 'Approved.' : 'Rejected.'),
    supportingFactors: strList(parsed.supporting_factors),
    risks: strList(parsed.risks),
    conflicts: strList(parsed.conflicts),
    model: opts.model,
    latencyMs: opts.latencyMs,
    attempts: opts.attempts,
  };
}

/** Render the analysis request as the user-facing prompt text. */
export function buildPrompt(req: AnalysisRequest): string {
  const f = req.features;
  const open = f.open > 0 ? f.open : 0;
  const pct = (x: number) => (open > 0 ? (x / open) * 100 : 0).toFixed(4);
  const pUp = req.signal.direction === 'CALL' ? req.signal.confidence : 1 - req.signal.confidence;

  const lines = [
    `ASSET: ${req.signal.asset}`,
    `PREDICTED DIRECTION: ${req.signal.direction} (${
      req.signal.direction === 'CALL' ? 'price up' : 'price down'
    })`,
    `MODEL P(UP): ${pUp.toFixed(4)}`,
    `CONFIDENCE IN CALLED DIRECTION: ${(req.signal.confidence * 100).toFixed(1)}%`,
    `PREDICTION SOURCE: ${req.prediction.source ?? 'unknown'}`,
    `DECISION THRESHOLD: ${req.prediction.threshold}`,
    '',
    'FEATURE WINDOW (trailing 60s of ticks):',
    `  tickCount: ${f.tickCount}`,
    `  windowSpanSec: ${f.windowSpanSec.toFixed(1)}`,
    `  netChangePct: ${(f.netChangePct * 100).toFixed(5)}%`,
    `  recentMomentumPct: ${(f.recentMomentumPct * 100).toFixed(5)}%`,
    `  rangePct: ${pct(f.range)}%`,
    `  avgAbsDeltaPct: ${pct(f.avgAbsDelta)}%`,
    `  stdDevPct: ${pct(f.stdDev)}%`,
    `  upRatio (directional ticks only): ${f.upRatio.toFixed(4)}`,
    `  close: ${f.close}`,
    '',
    'RECENT MARKET CONTEXT:',
    `  ${req.marketContext ?? 'not available'}`,
    '',
    'Judge this signal and reply with the JSON object only.',
  ];
  return lines.join('\n');
}

/**
 * Gemini-backed analyst.
 *
 * Enabled only when an API key is present, so the bot still runs (without
 * delivery) when the key is absent. Every network path is retried with
 * exponential backoff and bounded by a timeout; a total failure returns null.
 *
 * Rate limiting is handled in three ways, all observed to matter live:
 *   - calls are serialised with a minimum gap (`minIntervalMs`), because a
 *     wall-clock-aligned bucket fires one analysis per asset at once;
 *   - a 429 (or 404, a retired model) moves to the next model in the fallback
 *     list instead of failing the signal;
 *   - `Retry-After` is honoured when the API supplies it.
 */
export class GeminiAnalyst implements SignalAnalyst {
  readonly name = 'gemini-analyst';

  private readonly apiKey: string;
  private readonly models: string[];
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minConfidence: number;
  private readonly minIntervalMs: number;
  private readonly enabled: boolean;
  private readonly fetchImpl: typeof fetch;

  private analyzed = 0;
  private approved = 0;
  private rejected = 0;
  private errors = 0;
  private retries = 0;
  private fallbacks = 0;
  /** Tail of the serialisation chain; also the pacing clock. */
  private chain: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(
    opts: {
      apiKey?: string;
      model?: string;
      models?: string[];
      timeoutMs?: number;
      maxRetries?: number;
      minConfidence?: number;
      minIntervalMs?: number;
      fetchImpl?: typeof fetch;
      quiet?: boolean;
    } = {}
  ) {
    // GEMINI_API_KEY is the canonical name; Gemini_API_Token is the registered
    // secret name in this workspace, accepted so the key does not have to be
    // duplicated under two names.
    this.apiKey = opts.apiKey ?? envStr('GEMINI_API_KEY') ?? envStr('Gemini_API_Token') ?? '';

    const primary = opts.model ?? envStr('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL;
    // Primary first, then the built-in fallbacks, de-duplicated.
    this.models = opts.models ?? [...new Set([primary, ...DEFAULT_MODEL_FALLBACKS])];

    const timeout = opts.timeoutMs ?? Number(envStr('GEMINI_TIMEOUT_MS') ?? NaN);
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_AI_TIMEOUT_MS;

    const retries = opts.maxRetries ?? Number(envStr('GEMINI_MAX_RETRIES') ?? NaN);
    this.maxRetries =
      Number.isFinite(retries) && retries >= 0 ? retries : DEFAULT_AI_MAX_RETRIES;

    const minConf = opts.minConfidence ?? Number(envStr('AI_MIN_CONFIDENCE') ?? NaN);
    this.minConfidence =
      Number.isFinite(minConf) && minConf >= 0 && minConf <= 1
        ? minConf
        : DEFAULT_MIN_AI_CONFIDENCE;

    const interval = opts.minIntervalMs ?? Number(envStr('AI_MIN_INTERVAL_MS') ?? NaN);
    this.minIntervalMs =
      Number.isFinite(interval) && interval >= 0 ? interval : DEFAULT_MIN_INTERVAL_MS;

    this.enabled = this.apiKey.length > 0;
    this.fetchImpl = opts.fetchImpl ?? fetch;

    if (!opts.quiet) {
      console.log(
        this.enabled
          ? `[AI] analysis enabled (models ${this.models.join(' -> ')}, timeout ${
              this.timeoutMs
            }ms, ${this.maxRetries} retries, ${this.minIntervalMs}ms pacing, ` +
              `min approval confidence ${this.minConfidence})`
          : '[AI] no Gemini API key — AI analysis disabled; signals will NOT be delivered'
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStats(): AnalystStats {
    return {
      enabled: this.enabled,
      model: this.models[0],
      analyzed: this.analyzed,
      approved: this.approved,
      rejected: this.rejected,
      errors: this.errors,
      retries: this.retries,
      fallbacks: this.fallbacks,
    };
  }

  /**
   * One HTTP attempt against one model.
   * @returns the model's text, or a tagged failure so the caller can decide
   *          whether to retry, fall back to another model, or give up.
   */
  private async attempt(
    model: string,
    prompt: string
  ): Promise<{ text: string } | { retryAfterMs: number | null } | { fatal: true }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`[AI] ${model} HTTP ${res.status} ${detail.slice(0, 160)}`);
        // 429/404/5xx are worth trying on another model; 4xx otherwise is not.
        if (res.status === 429 || res.status === 404 || res.status >= 500) {
          const header = Number(res.headers?.get?.('retry-after') ?? NaN);
          return { retryAfterMs: Number.isFinite(header) && header > 0 ? header * 1000 : null };
        }
        return { fatal: true };
      }

      const body = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      return text.length > 0 ? { text } : { fatal: true };
    } catch (e) {
      console.error(`[AI] ${model} request failed: ${(e as Error).message}`);
      return { retryAfterMs: null };
    }
  }

  /** Wait out the pacing gap, then run the analysis under the serial chain. */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastCallAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();
      return fn();
    });
    // Keep the chain alive regardless of this call's outcome.
    this.chain = run.catch(() => undefined);
    return run;
  }

  async analyze(req: AnalysisRequest): Promise<AiAnalysis | null> {
    if (!this.enabled) return null;

    const prompt = buildPrompt(req);

    return this.schedule(async () => {
      const startedAt = Date.now();
      let attempts = 0;

      for (let i = 0; i <= this.maxRetries; i++) {
        // Rotate through the model list on each retry so a rate-limited primary
        // does not consume every attempt.
        const model = this.models[Math.min(i, this.models.length - 1)];
        if (i > 0 && model !== this.models[0]) this.fallbacks++;

        attempts++;
        const outcome = await this.attempt(model, prompt);

        if ('text' in outcome) {
          const analysis = parseAnalysis(outcome.text, {
            model,
            latencyMs: Date.now() - startedAt,
            attempts,
            minConfidence: this.minConfidence,
          });
          if (analysis) {
            this.analyzed++;
            if (analysis.verdict === 'APPROVE') this.approved++;
            else this.rejected++;
            return analysis;
          }
          console.error(`[AI] ${model} returned no valid analysis JSON`);
        } else if ('fatal' in outcome) {
          break; // not worth retrying (auth error, empty body)
        }

        if (i < this.maxRetries) {
          this.retries++;
          // Honour Retry-After when given; otherwise exponential backoff capped.
          const wait =
            ('retryAfterMs' in outcome && outcome.retryAfterMs !== null
              ? outcome.retryAfterMs
              : Math.min(1000 * 2 ** i, 8000)) + 250;
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      // Fail-closed: no verdict means no delivery.
      this.errors++;
      console.error(
        `[AI] analysis unavailable after ${attempts} attempt(s) — signal will NOT be delivered`
      );
      return null;
    });
  }
}
