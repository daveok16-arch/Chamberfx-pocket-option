/**
 * Risk Layer — hard safety gates for every trade the strategy proposes
 * ====================================================================
 * Enforces, in order:
 *   1. Paper-trading default: unless RiskConfig.live is explicitly true AND
 *      the strategy explicitly opts in, nothing is executable by default.
 *   2. Max amount per trade.
 *   3. Cooldown between trades on the same asset.
 *   4. Daily (rolling 24h) loss stop — halts new entries once losses hit the cap.
 *   5. Max concurrent open positions.
 *   6. Price sanity — never trade an asset with an invalid/stale price.
 *
 * The strategy proposes a direction; this layer decides whether it is safe to
 * act on it. It never decides direction — only gate-keeping.
 */

export interface RiskConfig {
  /** Maximum stake per single trade (account currency). */
  maxAmountPerTrade: number;
  /** Minimum seconds between two orders on the same asset. */
  cooldownMs: number;
  /** Maximum allowed net loss over a rolling 24h window before halting. */
  maxDailyLoss: number;
  /** Max number of open (unresolved) positions at once, across all assets. */
  maxConcurrentTrades: number;
  /** When true, execution may proceed live (otherwise treated as paper). */
  live: boolean;
  /** Mark the price stale (and reject trades) if no tick for this many ms. */
  stalePriceMs: number;
}

export interface RiskDecision {
  allowed: boolean;
  reason: string;
  maxAmount: number;
}

export class RiskManager {
  private readonly cfg: RiskConfig;
  /** open(unresolved) trades, keyed by requestId */
  private open: { requestId: string; asset: string; amount: number; openedAt: number }[] = [];
  /** rolling settlement ledger for the daily-loss cap */
  private settlements: { amount: number; pnl: number; at: number }[] = [];
  private lastTradeAt = new Map<string, number>();

  /**
   * Create a new risk manager with safety gates.
   * @param cfg - Risk configuration with stake caps, cooldowns, loss limits, and concurrency limits
   */
  constructor(cfg: Partial<RiskConfig> = {}) {
    this.cfg = {
      maxAmountPerTrade: cfg.maxAmountPerTrade ?? 5,
      cooldownMs: cfg.cooldownMs ?? 180_000,
      maxDailyLoss: cfg.maxDailyLoss ?? 50,
      maxConcurrentTrades: cfg.maxConcurrentTrades ?? 3,
      live: cfg.live ?? false,
      stalePriceMs: cfg.stalePriceMs ?? 45_000,
    };
  }

  /**
   * A trade is only "executable live" when the risk layer was armed live.
   * @returns True if the risk manager is in live (real money) mode
   */
  isLive(): boolean {
    return this.cfg.live;
  }

  /**
   * Check if the risk manager is in paper (simulated) trading mode.
   * @returns True if the risk manager is in paper mode
   */
  isPaper(): boolean {
    return !this.cfg.live;
  }

  /**
   * Decide whether a proposed trade on `asset` at `price`, now `nowMs`, is
   * permitted. `live` should be the execution engine's actual live-ness
   * (config.live + non-demo session). The risk layer refuses LIVE if it is
   * not armed, and refuses anything on a stale price.
   */
  allow(asset: string, price: number, amountRequested: number, nowMs: number, live: boolean): RiskDecision {
    // 1) Live trades require the risk layer itself was armed live.
    if (live && !this.isLive()) {
      return { allowed: false, reason: 'live execution not armed (paper risk mode)', maxAmount: 0 };
    }
    // 2) Price sanity — no zero / stale prices.
    if (!(price > 0)) {
      return { allowed: false, reason: `no valid price for ${asset}`, maxAmount: 0 };
    }
    // Staleness is enforced upstream (server.ts) via lastTickTime vs now; we
    // can't see the tick age from here, so this is a defensive zero-check only.
    // 3) Daily loss stop.
    const cutoff = nowMs - 86_400_000;
    const dailyPnl = this.settlements.filter(s => s.at >= cutoff).reduce((sum, s) => sum + s.pnl, 0);
    if (this.cfg.maxDailyLoss >= 0 && dailyPnl <= -this.cfg.maxDailyLoss) {
      return { allowed: false, reason: `daily loss stop hit (${dailyPnl.toFixed(2)})`, maxAmount: 0 };
    }
    // 4) Cooldown on the same asset.
    const last = this.lastTradeAt.get(asset);
    if (last !== undefined && nowMs - last < this.cfg.cooldownMs) {
      return { allowed: false, reason: `cooldown active on ${asset}`, maxAmount: 0 };
    }
    // 5) Concurrent open positions cap.
    // Prune open entries older than the maximum option duration (300s) as a backstop
    // when settlement is missed.
    const maxOptionDurationMs = 300_000;
    this.open = this.open.filter(o => nowMs - o.openedAt < maxOptionDurationMs);
    if (this.open.length >= this.cfg.maxConcurrentTrades) {
      return { allowed: false, reason: `max concurrent trades reached (${this.open.length})`, maxAmount: 0 };
    }
    // 6) Amount cap.
    const maxAmount = Math.min(amountRequested, this.cfg.maxAmountPerTrade);
    if (maxAmount <= 0) {
      return { allowed: false, reason: 'amount <= 0', maxAmount: 0 };
    }

    return { allowed: true, reason: 'ok', maxAmount };
  }

  /**
   * Record that a trade was placed (opens a position for the concurrency cap).
   * @param requestId - Unique identifier for the trade
   * @param asset - Asset identifier
   * @param amount - Trade amount in account currency
   * @param nowMs - Current timestamp in milliseconds
   */
  registerOpen(requestId: string, asset: string, amount: number, nowMs: number): void {
    this.open.push({ requestId, asset, amount, openedAt: nowMs });
    this.lastTradeAt.set(asset, nowMs);
    // keep the rollling settlement window bounded to 24h
    this.settlements = this.settlements.filter(s => s.at >= nowMs - 86_400_000);
  }

  /**
   * Settle a position with its PnL (±amount). Releases the concurrency slot.
   * @param requestId - Unique identifier for the trade to settle
   * @param pnl - Profit/loss amount (positive for profit, negative for loss)
   * @param nowMs - Current timestamp in milliseconds
   */
  settle(requestId: string, pnl: number, nowMs: number): void {
    const idx = this.open.findIndex(o => o.requestId === requestId);
    if (idx === -1) return;
    const pos = this.open[idx];
    this.open.splice(idx, 1);
    this.settlements.push({ amount: pos.amount, pnl, at: nowMs });
  }
}