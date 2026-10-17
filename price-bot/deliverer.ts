/**
 * Signal Delivery — Telegram
 * ==========================
 * Ships accepted signals to a Telegram chat. Kept in its own module (rather
 * than inside `capture.ts`) so the throttling logic is unit-testable and the
 * entrypoint stays focused on capture.
 *
 * Disabled unless BOTH `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, so
 * the bot runs fine with no credentials. Delivery is best-effort: a failed send
 * is logged and counted, never allowed to interrupt capture.
 *
 * Per-asset cooldown: a signal that clears the filters on consecutive windows is
 * usually the *same* market state re-detected 60s later, not a new opportunity.
 * Six assets predicting every minute would otherwise deliver ~360 messages/hour.
 * `SIGNAL_COOLDOWN_MS` (default 5 min) throttles delivery per asset; suppressed
 * signals are still counted and logged, so nothing is hidden — only the chat is
 * spared.
 */

import type { FeatureWindow } from './strategy.js';
import type { ValidSignal } from './signalFilter.js';

/** Default per-asset cooldown between delivered signals (ms). */
export const DEFAULT_COOLDOWN_MS = 300_000;

export interface DeliveryStats {
  enabled: boolean;
  sent: number;
  failed: number;
  throttled: number;
}

export class TelegramDeliverer {
  private readonly token: string;
  private readonly chatId: string;
  private readonly enabled: boolean;
  private readonly cooldownMs: number;
  private readonly lastSentAt = new Map<string, number>();
  /** Sends are chained so bursts cannot reorder or stampede the API. */
  private chain: Promise<void> = Promise.resolve();
  private sent = 0;
  private failed = 0;
  private throttled = 0;

  constructor(opts: { cooldownMs?: number; quiet?: boolean } = {}) {
    this.token = process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.chatId = process.env.TELEGRAM_CHAT_ID ?? '';
    this.enabled = this.token.length > 0 && this.chatId.length > 0;

    const configured = opts.cooldownMs ?? Number(process.env.SIGNAL_COOLDOWN_MS);
    this.cooldownMs =
      Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_COOLDOWN_MS;

    if (!opts.quiet) {
      console.log(
        this.enabled
          ? `[DELIVER] Telegram delivery enabled (per-asset cooldown ${this.cooldownMs / 1000}s)`
          : '[DELIVER] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset — signals logged only'
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStats(): DeliveryStats {
    return {
      enabled: this.enabled,
      sent: this.sent,
      failed: this.failed,
      throttled: this.throttled,
    };
  }

  /**
   * Decide whether a signal may be delivered now, and record the attempt.
   *
   * Split out from the network call so the throttle policy can be tested
   * without touching Telegram. Uses the broker server clock already carried on
   * the signal, so it stays aligned with window boundaries.
   *
   * @returns true when the caller should perform the send.
   */
  private claim(signal: ValidSignal): boolean {
    const last = this.lastSentAt.get(signal.asset);
    if (last !== undefined && signal.timestamp - last < this.cooldownMs) {
      this.throttled++;
      const waitSec = Math.ceil((this.cooldownMs - (signal.timestamp - last)) / 1000);
      console.log(`[DELIVER] ${signal.asset} throttled (${waitSec}s of cooldown left)`);
      return false;
    }
    this.lastSentAt.set(signal.asset, signal.timestamp);
    return true;
  }

  /** Render a signal as a compact chat message. */
  static format(signal: ValidSignal, features: FeatureWindow, source: string): string {
    const arrow = signal.direction === 'CALL' ? '\u2191' : '\u2193';
    const pUp = signal.direction === 'CALL' ? signal.confidence : 1 - signal.confidence;
    return (
      `${arrow} ${signal.direction} ${signal.asset}\n` +
      `confidence ${(signal.confidence * 100).toFixed(1)}%  P(UP) ${pUp.toFixed(3)}\n` +
      `entry ${features.close}  window ${features.windowSpanSec.toFixed(0)}s ` +
      `${features.tickCount} ticks\n` +
      `source: ${source}`
    );
  }

  /** Queue one signal for delivery. Never throws, never blocks the caller. */
  send(signal: ValidSignal, features: FeatureWindow, source: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (!this.claim(signal)) return Promise.resolve();

    const text = TelegramDeliverer.format(signal, features, source);

    // Serialise sends: chain onto the previous one regardless of its outcome.
    this.chain = this.chain
      .catch(() => undefined)
      .then(async () => {
        try {
          const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: this.chatId, text }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.sent++;
        } catch (e) {
          this.failed++;
          console.error(`[DELIVER] Telegram send failed: ${(e as Error).message}`);
        }
      });

    return this.chain;
  }
}
