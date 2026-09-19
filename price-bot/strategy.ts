/**
 * Strategy Layer — feature & label collection
 * ===========================================
 * Defines the pluggable `Strategy` contract and implements Phase 1: a
 * data-collection engine that turns the live tick feed into a supervised
 * learning dataset. There is deliberately NO model and NO trade decisioning
 * here — this only records market state and its outcome.
 *
 * Each observation captures:
 *   - a 60s rolling feature window (pre-entry state), and
 *   - the outcome over the next 60s (target state), labelled binary.
 *
 * Emitted artifacts:
 *   - `live-prices.json`  — real-time features (latest evaluated window/asset)
 *   - `signals.json`      — completed, labelled observations (append-only)
 *
 * Timing uses Pocket Option's server clock (`ctx.serverTime`), never
 * `Date.now()` — the server clock is ~2h ahead of the container clock, so
 * `Date.now()` would misalign windows against the candle boundaries.
 */

import type { Candle, Tick } from './server.js';

export type StrategyDirection = 'call' | 'put';

export interface StrategySignal {
  direction: StrategyDirection;
  /** Stake amount proposed (subject to whatever risk layer exists later). */
  amount: number;
  /** Expiry in seconds (60 | 180 | 300). */
  duration: number;
}

export interface StrategyContext {
  /** Last-known price of the asset (0 if none yet). */
  price: number;
  /** Closed candles for the asset, oldest first. */
  candles: Candle[];
  /** Recent raw ticks for the asset, oldest first (server-clock ms). */
  ticks: Tick[];
  /** Pocket Option server/session clock in ms. */
  serverTime: number;
}

export interface Strategy {
  readonly name: string;
  /**
   * Called once per asset on each evaluate cycle. Returns a proposed trade, or
   * null to wait. Phase 1 returns null always: no trading logic exists yet.
   */
  evaluate(ctx: StrategyContext, asset: string): StrategySignal | null;
}

// ============================================
// FEATURE / LABEL COLLECTOR
// ============================================

/** Rolling feature-window length (ms). */
export const WINDOW_MS = 60_000;
/** Prediction horizon / label resolution delay (ms). */
export const HORIZON_MS = 60_000;

export interface FeatureWindow {
  /** Server-clock ms of the most recent tick in the trailing window. */
  lastTickAt: number;
  /** Number of ticks that landed in the window. */
  tickCount: number;
  /** Price at the start / end of the window. */
  open: number;
  close: number;
  high: number;
  low: number;
  /** close - open. */
  netChange: number;
  /** netChange / open. */
  netChangePct: number;
  /** high - low. */
  range: number;
  /** Mean absolute tick-to-tick delta (realized micro-volatility). */
  avgAbsDelta: number;
  /** Sample stddev of tick prices. */
  stdDev: number;
  /** Share of ticks classified UP (0..1). */
  upRatio: number;
  /** Seconds spanned by the ticks actually present (may be < WINDOW_MS). */
  windowSpanSec: number;
  /** 60s momentum: close vs close 60s earlier (0 if insufficient history). */
  momentum60s: number;
}

export interface LabelRecord {
  type: 'OBSERVATION';
  asset: string;
  /**
   * Server-clock ms when the observation was armed — the boundary between the
   * trailing feature window and the forward outcome horizon.
   */
  entryAt: number;
  /** Price at entry. */
  entryPrice: number;
  /** Server-clock ms when the outcome was resolved (entryAt + horizonMs). */
  resolvedAt: number;
  /** Market price at expiration (the outcome snapshot). */
  expirationPrice: number;
  /** expirationPrice - entryPrice. */
  delta: number;
  /** Binary outcome: 1 = UP, 0 = DOWN (ties resolve to 0). */
  label: 0 | 1;
  /** Direction name for readability. */
  outcome: 'UP' | 'DOWN';
  /** Trailing 60s state at entry (features). */
  features: FeatureWindow;
  /** Source is always the live capture engine. */
  source: string;
}

export interface CollectorConfig {
  /** Feature window length in ms (default 60_000). */
  windowMs: number;
  /** Outcome horizon in ms (default 60_000). */
  horizonMs: number;
  /**
   * Minimum fraction of the window that must actually be covered by ticks
   * before an observation is armed (0..1). Guards against emitting junk labels
   * from a partially-filled window right after (re)connect.
   */
  minCoverage: number;
  /** Real-time feature snapshot file (default ./live-prices.json). */
  featuresFile: string;
  /** Append-only labelled output file (default ./signals.json). */
  signalsFile: string;
}

/**
 * Phase 1 collector: implements `Strategy` purely to consume the live feed.
 *
 * `evaluate()` streams ticks from `ctx.ticks`, maintains a 60s rolling window
 * per asset, writes real-time features to `featuresFile`, then arms an
 * observation whose outcome is resolved against the live price 60s later and
 * appended to `signalsFile`.
 *
 * It ALWAYS returns null — it proposes no trades. `evaluate()` doubles as the
 * per-cycle driver because `Strategy` is the only hook the pipeline exposes.
 */
export class FeatureLabelCollector implements Strategy {
  readonly name = 'feature-label-collector';

  private readonly cfg: CollectorConfig;

  /** Per-asset rolling tick buffer (pruned to windowMs). */
  private windows = new Map<string, Tick[]>();
  /** Dedup keys per asset so overlapping ctx.ticks snapshots aren't double-counted. */
  private seen = new Map<string, Set<string>>();
  /** Observations awaiting their 60s outcome. */
  private pending: { asset: string; entryAt: number; entryPrice: number; features: FeatureWindow }[] = [];
  /** Latest feature window per asset, for the real-time snapshot. */
  private latestFeatures = new Map<string, FeatureWindow>();
  /** Most recent 60s bucket already armed/observed, per asset. */
  private lastEntryBucket = new Map<string, number>();
  /** All completed labels (kept in memory so the JSON array can be rewritten). */
  private labels: LabelRecord[] = [];
  /** Per-asset count of windows skipped for insufficient tick coverage. */
  private skipped = new Map<string, number>();

  constructor(cfg: Partial<CollectorConfig> = {}) {
    this.cfg = {
      windowMs: cfg.windowMs ?? WINDOW_MS,
      horizonMs: cfg.horizonMs ?? HORIZON_MS,
      minCoverage: cfg.minCoverage ?? 0.5,
      featuresFile: cfg.featuresFile ?? './live-prices.json',
      signalsFile: cfg.signalsFile ?? './signals.json',
    };
  }

  evaluate(ctx: StrategyContext, asset: string): StrategySignal | null {
    if (!(ctx.price > 0)) return null;

    const now = ctx.serverTime;
    this.ingest(asset, ctx.ticks, now);

    const buf = this.windows.get(asset) ?? [];
    if (buf.length < 2) return null; // not enough ticks to form a window yet

    const features = this.computeFeatures(buf, now);
    this.latestFeatures.set(asset, features);

    // Arm at most ONE observation per aligned 60s bucket. The bucket boundary
    // is only a dedup key — each 1s evaluate cycle would otherwise arm a new
    // observation and oversample the window.
    const bucket = Math.floor(now / this.cfg.windowMs) * this.cfg.windowMs;
    if (this.lastEntryBucket.get(asset) !== bucket) {
      this.lastEntryBucket.set(asset, bucket);

      const spanMs = features.windowSpanSec * 1000;
      if (spanMs >= this.cfg.windowMs * this.cfg.minCoverage) {
        this.pending.push({
          asset,
          entryAt: now, // actual arm time, so resolvedAt - entryAt == horizonMs
          entryPrice: ctx.price,
          features,
        });
      } else {
        // Not enough history yet (e.g. just after reconnect) — skip rather than
        // emit a label built on a near-empty window.
        this.skipped.set(asset, (this.skipped.get(asset) ?? 0) + 1);
      }
    }

    this.resolveExpired(asset, ctx.price, now);
    return null; // Phase 1: never proposes a trade.
  }

  /** Fold a ctx.ticks snapshot into the rolling buffer, deduped by tick identity. */
  private ingest(asset: string, ticks: Tick[], now: number): void {
    if (!ticks || ticks.length === 0) return;

    let seen = this.seen.get(asset);
    if (!seen) {
      seen = new Set<string>();
      this.seen.set(asset, seen);
    }
    let buf = this.windows.get(asset);
    if (!buf) {
      buf = [];
      this.windows.set(asset, buf);
    }

    const cutoff = now - this.cfg.windowMs;
    let changed = false;
    for (const t of ticks) {
      if (!t || !(t.price > 0)) continue;
      if (t.timestamp < cutoff) continue; // outside the window
      const key = `${t.timestamp}:${t.price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buf.push(t);
      changed = true;
    }

    if (changed) buf.sort((a, b) => a.timestamp - b.timestamp);

    // Prune anything older than the window (the buffer is the window).
    const keepFrom = buf.findIndex((t) => t.timestamp >= cutoff);
    if (keepFrom > 0) {
      buf.splice(0, keepFrom);
      changed = true;
    }

    // Bound the dedup set so long sessions don't grow unbounded; anything
    // dropped here is already outside the window and can never be re-added.
    if (seen.size > 20_000) {
      const fresh = new Set<string>();
      for (const t of buf) fresh.add(`${t.timestamp}:${t.price}`);
      this.seen.set(asset, fresh);
    }
  }

  /** Derive the feature vector from a window's ticks. */
  private computeFeatures(buf: Tick[], now: number): FeatureWindow {
    let high = -Infinity;
    let low = Infinity;
    let absDeltaSum = 0;
    let upCount = 0;
    let sum = 0;

    for (let i = 0; i < buf.length; i++) {
      const p = buf[i].price;
      if (p > high) high = p;
      if (p < low) low = p;
      sum += p;
      if (i > 0) absDeltaSum += Math.abs(p - buf[i - 1].price);
      if (buf[i].direction === 'UP') upCount++;
    }

    const open = buf[0].price;
    const close = buf[buf.length - 1].price;
    const mean = sum / buf.length;
    let varianceSum = 0;
    for (const t of buf) varianceSum += (t.price - mean) ** 2;
    const stdDev = buf.length > 1 ? Math.sqrt(varianceSum / (buf.length - 1)) : 0;

    // 60s momentum: compare against the oldest tick in the window.
    const momentum60s = open > 0 ? (close - open) / open : 0;

    return {
      lastTickAt: buf[buf.length - 1].timestamp,
      tickCount: buf.length,
      open,
      close,
      high,
      low,
      netChange: close - open,
      netChangePct: open > 0 ? (close - open) / open : 0,
      range: high - low,
      avgAbsDelta: buf.length > 1 ? absDeltaSum / (buf.length - 1) : 0,
      stdDev,
      upRatio: buf.length > 0 ? upCount / buf.length : 0,
      windowSpanSec: (buf[buf.length - 1].timestamp - buf[0].timestamp) / 1000,
      momentum60s,
    };
  }

  /** Resolve any observation whose horizon has elapsed against the live price. */
  private resolveExpired(asset: string, currentPrice: number, now: number): void {
    let i = 0;
    while (i < this.pending.length) {
      const o = this.pending[i];
      if (o.asset !== asset || now - o.entryAt < this.cfg.horizonMs) {
        i++;
        continue;
      }

      const expirationPrice = currentPrice;
      const delta = expirationPrice - o.entryPrice;
      // Ties (delta === 0) resolve to DOWN: a binary option at the strike is
      // not a win, so it must not be labelled as an UP.
      const label: 0 | 1 = delta > 0 ? 1 : 0;

      const rec: LabelRecord = {
        type: 'OBSERVATION',
        asset,
        entryAt: o.entryAt,
        entryPrice: o.entryPrice,
        resolvedAt: now,
        expirationPrice,
        delta,
        label,
        outcome: label === 1 ? 'UP' : 'DOWN',
        features: o.features,
        source: this.name,
      };
      this.labels.push(rec);
      this.pending.splice(i, 1);
    }
  }

  /** Real-time feature snapshot for all assets (written to featuresFile). */
  getFeatureSnapshot(nowMs: number): {
    timestamp: string;
    serverTime: number;
    windowSec: number;
    horizonSec: number;
    assets: Record<string, FeatureWindow>;
  } {
    return {
      timestamp: new Date().toISOString(),
      serverTime: nowMs,
      windowSec: this.cfg.windowMs / 1000,
      horizonSec: this.cfg.horizonMs / 1000,
      assets: Object.fromEntries(this.latestFeatures),
    };
  }

  /** All completed labels. */
  getLabels(): LabelRecord[] {
    return this.labels;
  }

  /** Counts for observability. */
  getStats(): { labels: number; pending: number; assets: number; skipped: number } {
    let skipped = 0;
    for (const n of this.skipped.values()) skipped += n;
    return {
      labels: this.labels.length,
      pending: this.pending.length,
      assets: this.latestFeatures.size,
      skipped,
    };
  }
}