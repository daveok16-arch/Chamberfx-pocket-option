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
 * Batching: every asset is scored against the same wall-clock-aligned 60s
 * bucket (`floor(serverTime / windowMs)`), so all six cross the boundary in the
 * same evaluate tick and clear the filters within ~1s of each other. Sending
 * each one as it clears delivers a burst of six separate messages — one per
 * asset — for a single market moment. Instead, signals are held briefly
 * (`SIGNAL_BATCH_WINDOW_MS`, default 2s) and flushed as ONE message listing
 * every asset that qualified. Set the window to 0 to restore per-signal sends.
 *
 * Per-asset cooldown: a signal that clears the filters on consecutive windows is
 * usually the *same* market state re-detected 60s later, not a new opportunity.
 * Six assets predicting every minute would otherwise deliver ~360 messages/hour.
 * `SIGNAL_COOLDOWN_MS` (default 5 min) throttles delivery per asset; suppressed
 * signals are still counted and logged, so nothing is hidden — only the chat is
 * spared. The cooldown is applied at flush time, so a batched message contains
 * only assets that were actually due.
 */

import type { FeatureWindow } from './strategy.js';
import type { ValidSignal } from './signalFilter.js';

/** Default per-asset cooldown between delivered signals (ms). */
export const DEFAULT_COOLDOWN_MS = 300_000;
/** Default window over which accepted signals are gathered into one message (ms). */
export const DEFAULT_BATCH_WINDOW_MS = 2_000;

export interface DeliveryStats {
  enabled: boolean;
  /** Messages sent. A batch covering six signals counts once. */
  sent: number;
  failed: number;
  throttled: number;
  /** Individual signals included in the messages above. */
  signals: number;
}

/** A signal awaiting delivery, with the context needed to render it. */
export interface PendingSignal {
  signal: ValidSignal;
  features: FeatureWindow;
  source: string;
}

export class TelegramDeliverer {
  private readonly token: string;
  private readonly chatId: string;
  private readonly enabled: boolean;
  private readonly cooldownMs: number;
  private readonly batchWindowMs: number;
  private readonly lastSentAt = new Map<string, number>();
  /** Accepted signals waiting for the batch window to close. */
  private buffer: PendingSignal[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** Sends are chained so bursts cannot reorder or stampede the API. */
  private chain: Promise<void> = Promise.resolve();
  private sent = 0;
  private failed = 0;
  private throttled = 0;
  private signals = 0;

  constructor(
    opts: { cooldownMs?: number; batchWindowMs?: number; quiet?: boolean } = {}
  ) {
    this.token = process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.chatId = process.env.TELEGRAM_CHAT_ID ?? '';
    this.enabled = this.token.length > 0 && this.chatId.length > 0;

    const configured = opts.cooldownMs ?? Number(process.env.SIGNAL_COOLDOWN_MS);
    this.cooldownMs =
      Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_COOLDOWN_MS;

    const batch = opts.batchWindowMs ?? Number(process.env.SIGNAL_BATCH_WINDOW_MS);
    this.batchWindowMs =
      Number.isFinite(batch) && batch >= 0 ? batch : DEFAULT_BATCH_WINDOW_MS;

    if (!opts.quiet) {
      const batching =
        this.batchWindowMs > 0
          ? `batched per ${this.batchWindowMs / 1000}s`
          : 'one message per signal';
      console.log(
        this.enabled
          ? `[DELIVER] Telegram delivery enabled (per-asset cooldown ${
              this.cooldownMs / 1000
            }s, ${batching})`
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
      signals: this.signals,
    };
  }

  /**
   * Decide whether a signal may be delivered now, and record the attempt.
   *
   * Split out from the network call so the throttle policy can be tested
   * without touching Telegram. Uses the broker server clock already carried on
   * the signal, so it stays aligned with window boundaries.
   *
   * @returns true when the caller should include it in the outgoing message.
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

  /** Render one signal as a compact line. Shared by both message formats. */
  private static line(item: PendingSignal): string {
    const arrow = item.signal.direction === 'CALL' ? '\u2191' : '\u2193';
    const pct = (item.signal.confidence * 100).toFixed(1);
    return (
      `${arrow} ${item.signal.direction} ${item.signal.asset}  ` +
      `${pct}%  entry ${item.features.close}`
    );
  }

  /** Render a single signal as a compact chat message. */
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

  /**
   * Render a whole bucket as one message. Sorted by confidence so the strongest
   * signal is read first, and the source is only repeated when it varies.
   */
  static formatBatch(items: PendingSignal[]): string {
    const sorted = [...items].sort((a, b) => b.signal.confidence - a.signal.confidence);
    const sources = new Set(sorted.map((i) => i.source));
    const when = new Date(sorted[0].signal.timestamp);
    const hh = String(when.getUTCHours()).padStart(2, '0');
    const mm = String(when.getUTCMinutes()).padStart(2, '0');
    const spanSec = Math.round(sorted[0].features.windowSpanSec);

    const head =
      `\u{1F4CA} ${sorted.length} signal${sorted.length === 1 ? '' : 's'} ` +
      `\u00b7 ${hh}:${mm} UTC \u00b7 ${spanSec}s window`;
    const body = sorted.map((i) => TelegramDeliverer.line(i)).join('\n');
    const tail = sources.size === 1 ? `source: ${sorted[0].source}` : 'source: mixed';
    return `${head}\n\n${body}\n\n${tail}`;
  }

  /**
   * Queue one signal for delivery. Never throws, never blocks the caller.
   *
   * With batching on (the default) the signal is buffered and a flush is
   * scheduled; the flush applies the per-asset cooldown and sends one message
   * for the whole bucket. With `batchWindowMs === 0` it is sent immediately.
   */
  send(signal: ValidSignal, features: FeatureWindow, source: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();

    if (this.batchWindowMs === 0) {
      return this.dispatch([{ signal, features, source }]);
    }

    this.buffer.push({ signal, features, source });
    this.scheduleFlush();
    return Promise.resolve();
  }

  /** Arm the batch window. Only the first signal of a batch starts the clock. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.batchWindowMs);
    // Never hold the process open just to flush a batch.
    this.flushTimer.unref?.();
  }

  /**
   * Deliver everything buffered so far as one message.
   *
   * Public so shutdown can drain the buffer before exit — otherwise the last
   * bucket of a run is silently dropped. Safe to call with an empty buffer.
   */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) return Promise.resolve();

    // Cooldown is applied here, not at enqueue time, so a message reports only
    // the assets that were actually due to be sent.
    const due = batch.filter((item) => this.claim(item.signal));
    if (due.length === 0) return Promise.resolve();

    return this.dispatch(due);
  }

  /** Format and send one message covering `items`. Serialised against other sends. */
  private dispatch(items: PendingSignal[]): Promise<void> {
    const text =
      items.length === 1
        ? TelegramDeliverer.format(items[0].signal, items[0].features, items[0].source)
        : TelegramDeliverer.formatBatch(items);
    const count = items.length;

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
          this.signals += count;
        } catch (e) {
          this.failed++;
          console.error(`[DELIVER] Telegram send failed: ${(e as Error).message}`);
        }
      });

    return this.chain;
  }
}
