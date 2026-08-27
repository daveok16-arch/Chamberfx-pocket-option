/**
 * Execution Layer — raises trades over the authenticated Pocket Option session
 * ============================================================================
 * Speaks the broker's Socket.IO order protocol (the same `openOrder` message
 * used by the community Pocket Option APIs, verified against their source):
 *
 *   42["openOrder",{"asset":"EURUSD_otc","amount":5,"action":"call",
 *                   "isDemo":1,"requestId":"...","optionType":100,"time":60}]
 *
 * Two modes:
 *   - PAPER (default): trades are simulated and recorded locally. No real
 *     order is sent over the wire. This is the only safe default.
 *   - LIVE: the order is actually sent over the bot's authenticated WebSocket.
 *     Only reachable when explicitly enabled (config.live) AND the session is
 *     confirmed to be a NON-demo account.
 *

 * The execution layer intentionally carries NO decision logic — a strategy
 * decides CALL/PUT; this layer only executes + tracks.
 */

import { PocketOptionPriceBot } from './server.js';
import type { RiskManager, RiskDecision } from './risk.js';

export type TradeDirection = 'call' | 'put';

export interface TradeOrder {
  /** Broker asset id, e.g. "EURUSD_otc" */
  asset: string;
  /** Stake amount in account currency (capped by the risk layer before here) */
  amount: number;
  direction: TradeDirection;
  /** Expiry in seconds (60 | 180 | 300) — the candle/option duration */
  duration: number;
  /** Reference to the strategy that decided this trade (for logging) */
  source: string;
}

export interface TradeResult {
  requestId: string;
  asset: string;
  amount: number;
  direction: TradeDirection;
  duration: number;
  source: string;
  /** PAPER | LIVE — how this trade was executed */
  mode: 'PAPER' | 'LIVE';
  /** Client-supplied status; server-confirmed placement not yet received */
  status: 'PENDING' | 'PLACED' | 'FAILED';
  placedAt: number; // server/session clock ms when raised
  error?: string;
}

export interface ExecutionConfig {
  /** When true, orders are actually sent over the WS. FALSE (paper) by default. */
  live: boolean;
}

export class ExecutionEngine {
  private readonly bot: PocketOptionPriceBot;
  private readonly config: ExecutionConfig;

  constructor(bot: PocketOptionPriceBot, config: Partial<ExecutionConfig> = {}) {
    this.bot = bot;
    this.config = {
      // Paper trading is the ONLY safe default. No real money until explicitly
      // passed { live: true } AND the session is confirmed non-demo.
      live: config.live ?? false,
    };
  }

  /** True when live (real money) execution is currently armed. */
  isLive(): boolean {
    // Even if config.live is true, refuse to arm unless the authenticated
    // session is a real (non-demo) account. The auth packet's isDemo field
    // drives this; isDemoMode() defaults to true (demo) when unknown.
    return this.config.live && !this.bot.isDemoMode();
  }

  /**
   * Submit a trade, subject to the risk manager's gates. In paper mode this
   * only records the trade locally and returns a PLACED (simulated) result;
   * in live mode it sends the real openOrder message over the WebSocket.
   */
  async submit(order: TradeOrder, risk: RiskDecision): Promise<TradeResult | null> {
    if (!risk.allowed) {
      console.log(`[EXEC] BLOCKED ${order.direction.toUpperCase()} ${order.asset} — ${risk.reason}`);
      return null;
    }

    // Enforce the cap from the risk layer as a final safety net.
    const amount = Math.min(order.amount, risk.maxAmount);

    const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `trade-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const result: TradeResult = {
      requestId,
      asset: order.asset,
      amount,
      direction: order.direction,
      duration: order.duration,
      source: order.source,
      mode: this.isLive() ? 'LIVE' : 'PAPER',
      status: 'PENDING',
      placedAt: this.bot.getServerTime(),
    };

    if (this.isLive()) {
      // Real-money path: send the broker's openOrder message over the WS.
      const msg = `42["openOrder",{"asset":"${order.asset}","amount":${amount},"action":"${order.direction}","isDemo":0,"requestId":"${requestId}","optionType":100,"time":${order.duration}}]`;
      const sent = this.bot.send(msg);
      result.status = sent ? 'PLACED' : 'FAILED';
      if (!sent) result.error = 'socket not open';
      console.log(
        `[EXEC] ${result.status} LIVE ${order.direction.toUpperCase()} ${order.asset} @${amount} (${order.duration}s)`
      );
    } else {
      // Paper path: record locally, no wire traffic.
      result.status = 'PLACED';
      console.log(
        `[EXEC] ${result.status} [PAPER] ${order.direction.toUpperCase()} ${order.asset} @${amount} (${order.duration}s)`
      );
    }

    return result;
  }
}