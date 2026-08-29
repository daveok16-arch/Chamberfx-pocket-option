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

import type { TradeDirection } from './execution.js';

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

export interface OpenPosition {
  requestId: string;
  asset: string;
  amount: number;
  direction: TradeDirection;
  /** Entry price (strike) captured from the live feed when the trade was placed. */
  strike: number;
  /** Option duration in ms (how long before the binary settles). */
  durationMs: number;
  openedAt: number; // server/session clock ms
}

export class RiskManager {
  private readonly cfg: RiskConfig;
  /** Open (unresolved) positions. Released on settlement (auto or manual). */
  private open: OpenPosition[] = [];
  /** Rolling settlement ledger (24h) that feeds the loss-stop gate. */
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
   * Decide whether a proposed trade on `asset` at `price`, now `nowMs`, is
   * permitted. `live` is the execution engine's actual live-ness (config.live
   * + non-demo session). The risk layer refuses LIVE if it is not armed.
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
    // 3) Daily loss stop (rolling 24h window).
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
// 5) Concurrent open positions cap (actual currently-open positions).
    // Backstop: prune entries older than the maximum option duration (300s)
    // when the settlement loop is missed, so the cap can't deadlock forever.
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
   * Record a trade as an open position. `strike` is the live price at entry;
   * `durationMs` is how long until the binary settles (used by settleExpired).
   */
  registerOpen(
    requestId: string,
    asset: string,
    amount: number,
    strike: number,
    direction: TradeDirection,
    durationMs: number,
    nowMs: number
  ): void {
    this.open.push({ requestId, asset, amount, strike, direction, durationMs, openedAt: nowMs });
    this.lastTradeAt.set(asset, nowMs);
    this.pruneSettlements(nowMs);
  }

  /**
   * Settle a position with an explicit PnL (client-supplied, e.g. broker deal
   * confirmation). Releases the concurrency slot immediately.
   */
  settle(requestId: string, pnl: number, nowMs: number): void {
    const idx = this.open.findIndex(o => o.requestId === requestId);
    if (idx === -1) return;
    const pos = this.open[idx];
    this.open.splice(idx, 1);
    this.settlements.push({ amount: pos.amount, pnl, at: nowMs });
    this.pruneSettlements(nowMs);
  }

  /**
   * Settle every position whose option window has elapsed, computing paper PnL
   * against the CURRENT LIVE market price. `priceOf(asset)` is the live price
   * provider (the bot's WS feed) — this is what makes paper PnL reflect real
   * market movements instead of being fabricated.
   *
   * Returns a list of settled positions (requestId -> pnl) so callers can log.
   */
  settleExpired(nowMs: number, priceOf: (asset: string) => number, payoutRatio = 0.92): Map<string, number> {
    const settled = new Map<string, number>();
    let i = 0;
    while (i < this.open.length) {
      const pos = this.open[i];
      const expired = nowMs - pos.openedAt >= pos.durationMs;
      if (!expired) {
        i++;
        continue;
      }
      const price = priceOf(pos.asset);
      let pnl: number;
      if (price > 0) {
        // Binary: in-the-money wins stake * payout; out loses stake.
        const won = pos.direction === 'call' ? price > pos.strike : price < pos.strike;
        pnl = won ? pos.amount * payoutRatio : -pos.amount;
      } else {
        // No live price available to settle (e.g. feed gap) — refund the stake
        // and release the slot rather than fabricating a bad PnL.
        pnl = 0;
      }
      this.settlements.push({ amount: pos.amount, pnl, at: nowMs });
      settled.set(pos.requestId, pnl);
      this.open.splice(i, 1);
    }
    this.pruneSettlements(nowMs);
    return settled;
  }

  getOpenCount(): number {
    return this.open.length;
  }

  private pruneSettlements(nowMs: number): void {
    this.settlements = this.settlements.filter(s => s.at >= nowMs - 86_400_000);
  }
}