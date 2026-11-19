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
 *
 * Delivery carries the AI analysis. Only signals the analyst approved reach
 * this module, and every message reproduces the original prediction alongside
 * the analyst's verdict, confidence, supporting factors and risk warnings. The
 * source prediction is never rewritten — the analysis is attached, not merged.
 *
 * Reliability: sends are retried with exponential backoff, and a dedup guard
 * drops a signal whose (asset, direction, bucket) identity was already
 * delivered, so a retry or a repeated window cannot double-post.
 */

import type { FeatureWindow } from './strategy.js';
import type { ValidSignal } from './signalFilter.js';
import type { AiAnalysis } from './aiAnalyst.js';
import * as fs from 'fs';

/** Default per-asset cooldown between delivered signals (ms). */
export const DEFAULT_COOLDOWN_MS = 300_000;
/** Default window over which accepted signals are gathered into one message (ms). */
export const DEFAULT_BATCH_WINDOW_MS = 2_000;
/** Default attempts per Telegram send (1 initial + 2 retries). */
export const DEFAULT_MAX_SEND_ATTEMPTS = 3;

/**
 * Width of the dedup bucket (ms). Matches the engine's 60s evaluation window:
 * one asset+direction per aligned bucket is one signal.
 */
export const BUCKET_MS = 60_000;

export interface DeliveryStats {
  enabled: boolean;
  /** Messages sent. A batch covering six signals counts once. */
  sent: number;
  failed: number;
  throttled: number;
  /** Individual signals included in the messages above. */
  signals: number;
  /** Signals dropped because an identical one was already delivered. */
  duplicates: number;
  /** Send attempts that were retried after a transient failure. */
  retries: number;
  /** Telegram message id of the most recent accepted send, if any. */
  lastMessageId?: number;
  /** Current size of the dedup map (pruned each claim; must stay small). */
  dedupKeys: number;
}

/** A signal awaiting delivery, with the context needed to render it. */
export interface PendingSignal {
  signal: ValidSignal;
  features: FeatureWindow;
  source: string;
  /** The AI verdict attached to this signal. Delivery requires one. */
  analysis: AiAnalysis;
}

export class TelegramDeliverer {
  private readonly token: string;
  private readonly chatId: string;
  private readonly enabled: boolean;
  private readonly cooldownMs: number;
  private readonly batchWindowMs: number;
  private readonly maxSendAttempts: number;
  private readonly lastSentAt = new Map<string, number>();
  /**
   * Dedup keys of signals already delivered: `${asset}|${direction}|${bucket}`
   * mapped to the bucket's start time. Entries older than the cooldown horizon
   * are pruned on every claim, because once the cooldown has passed a repeat of
   * that bucket can no longer be suppressed by the cooldown either — so the key
   * is dead weight. Without pruning this Set grew forever (6 assets/minute is
   * ~8.6k keys/day), a slow leak on a bot meant to run for weeks.
   */
  private readonly delivered = new Map<string, number>();
  /** Accepted signals waiting for the batch window to close. */
  private buffer: PendingSignal[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** Sends are chained so bursts cannot reorder or stampede the API. */
  private chain: Promise<void> = Promise.resolve();
  private sent = 0;
  private failed = 0;
  private throttled = 0;
  private signals = 0;
  private duplicates = 0;
  private retries = 0;
  private lastMessageId?: number;
  /**
   * Append-only log of messages actually accepted by Telegram: message id,
   * timestamp and the exact text sent. A bot cannot read back its own messages,
   * so this is the only way to audit what a recipient received.
   */
  private readonly auditFile: string | null;

  constructor(
    opts: {
      cooldownMs?: number;
      batchWindowMs?: number;
      maxSendAttempts?: number;
      quiet?: boolean;
      auditFile?: string;
    } = {}
  ) {
    this.token = process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.chatId = process.env.TELEGRAM_CHAT_ID ?? '';
    this.enabled = this.token.length > 0 && this.chatId.length > 0;

    const audit = opts.auditFile ?? process.env.TELEGRAM_AUDIT_FILE;
    this.auditFile = audit && audit.length > 0 ? audit : null;

    const configured = opts.cooldownMs ?? Number(process.env.SIGNAL_COOLDOWN_MS);
    this.cooldownMs =
      Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_COOLDOWN_MS;

    const batch = opts.batchWindowMs ?? Number(process.env.SIGNAL_BATCH_WINDOW_MS);
    this.batchWindowMs =
      Number.isFinite(batch) && batch >= 0 ? batch : DEFAULT_BATCH_WINDOW_MS;

    const attempts = opts.maxSendAttempts ?? Number(process.env.TELEGRAM_MAX_ATTEMPTS);
    this.maxSendAttempts =
      Number.isFinite(attempts) && attempts >= 1 ? attempts : DEFAULT_MAX_SEND_ATTEMPTS;

    if (!opts.quiet) {
      const batching =
        this.batchWindowMs > 0
          ? `batched per ${this.batchWindowMs / 1000}s`
          : 'one message per signal';
      console.log(
        this.enabled
          ? `[DELIVER] Telegram delivery enabled (per-asset cooldown ${
              this.cooldownMs / 1000
            }s, ${batching}, up to ${this.maxSendAttempts} send attempts)`
          : '[DELIVER] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset — signals logged only'
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Append one accepted message to the audit log (best effort).
   *
   * Deliberately never throws: an audit-write failure must not be able to fail
   * a delivery that Telegram already accepted.
   */
  private recordAudit(messageId: number | undefined, text: string): void {
    if (!this.auditFile) return;
    try {
      const entry = {
        at: new Date().toISOString(),
        messageId: messageId ?? null,
        text,
      };
      fs.appendFileSync(this.auditFile, JSON.stringify(entry) + '\n');
    } catch (e) {
      console.error(`[DELIVER] audit write failed: ${(e as Error).message}`);
    }
  }

  getStats(): DeliveryStats {
    return {
      enabled: this.enabled,
      sent: this.sent,
      failed: this.failed,
      throttled: this.throttled,
      signals: this.signals,
      duplicates: this.duplicates,
      retries: this.retries,
      lastMessageId: this.lastMessageId,
      dedupKeys: this.delivered.size,
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
    // Prune first so the dedup map cannot grow without bound on a long run.
    this.prune(signal.timestamp);

    // Dedup first: the same asset+direction inside the same window bucket is
    // one signal, no matter how many times it is re-scored or re-sent.
    const bucket = Math.floor(signal.timestamp / BUCKET_MS);
    const key = `${signal.asset}|${signal.direction}|${bucket}`;
    if (this.delivered.has(key)) {
      this.duplicates++;
      console.log(`[DELIVER] ${signal.asset} duplicate of an already-delivered signal — skipped`);
      return false;
    }

    const last = this.lastSentAt.get(signal.asset);
    if (last !== undefined && signal.timestamp - last < this.cooldownMs) {
      this.throttled++;
      const waitSec = Math.ceil((this.cooldownMs - (signal.timestamp - last)) / 1000);
      console.log(`[DELIVER] ${signal.asset} throttled (${waitSec}s of cooldown left)`);
      return false;
    }
    this.lastSentAt.set(signal.asset, signal.timestamp);
    this.delivered.set(key, signal.timestamp);
    return true;
  }

  /**
   * Drop dedup keys whose bucket is old enough that no repeat can arrive.
   *
   * The key is bucketed at 60s, and `now` is the incoming signal's timestamp,
   * which can be up to a full bucket ahead of a key it is pruning. So the
   * horizon must span the cooldown PLUS at least two buckets: one so a same
   * bucket signal arriving late still matches, and one more because the signal
   * triggering the prune may itself be a bucket ahead. Pruning at only the
   * cooldown was a live bug — a next-bucket signal arriving 3ms after a key
   * was recorded dropped that key, and a late duplicate of the same bucket was
   * then delivered twice (observed as two AUDUSD PUT messages).
   */
  private prune(now: number): void {
    if (this.delivered.size === 0) return;
    const horizon = this.cooldownMs + 2 * BUCKET_MS;
    const cutoff = now - horizon;
    for (const [key, at] of this.delivered) {
      if (at < cutoff) this.delivered.delete(key);
    }
  }

  /** Render one signal as a compact line. Shared by both message formats. */
  private static line(item: PendingSignal): string {
    const arrow = item.signal.direction === 'CALL' ? '\u2191' : '\u2193';
    const pct = (item.signal.confidence * 100).toFixed(1);
    return (
      `${arrow} ${item.signal.direction} ${item.signal.asset}  ` +
      `${pct}%  entry ${item.features.close}  ` +
      `AI ${(item.analysis.confidence * 100).toFixed(0)}%`
    );
  }

  /** Render a single AI-approved signal as a full chat message. */
  static format(item: PendingSignal): string {
    const { signal, features, source, analysis } = item;
    const arrow = signal.direction === 'CALL' ? '\u2191' : '\u2193';
    const pUp = signal.direction === 'CALL' ? signal.confidence : 1 - signal.confidence;

    const bullet = (xs: string[], empty: string) =>
      xs.length > 0 ? xs.map((x) => `  \u2022 ${x}`).join('\n') : `  \u2022 ${empty}`;

    return (
      `\u2705 AI-APPROVED SIGNAL\n` +
      `\n${arrow} ${signal.direction} ${signal.asset}\n` +
      `confidence ${(signal.confidence * 100).toFixed(1)}%  P(UP) ${pUp.toFixed(3)}\n` +
      `entry ${features.close}  window ${features.windowSpanSec.toFixed(0)}s ` +
      `${features.tickCount} ticks\n` +
      `source: ${source}\n` +
      `\n\u{1F916} AI ANALYSIS (${(analysis.confidence * 100).toFixed(0)}% confident` +
      `${analysis.model ? `, ${analysis.model}` : ''})\n` +
      `${analysis.summary}\n` +
      `\nKey supporting factors:\n${bullet(analysis.supportingFactors, 'none cited')}` +
      (analysis.risks.length > 0 ? `\n\n\u26A0\uFE0F Risk warnings:\n${bullet(analysis.risks, '')}` : '') +
      (analysis.conflicts.length > 0 ? `\n\n\u26A0 Conflicting indicators:\n${bullet(analysis.conflicts, '')}` : '')
    );
  }

  /**
   * Render a whole bucket as one message. Sorted by confidence so the strongest
   * signal is read first. Each line carries the original prediction plus the
   * analyst's verdict confidence; the per-signal AI reasoning is appended as
   * compact blocks so a batch stays readable.
   */
  static formatBatch(items: PendingSignal[]): string {
    const sorted = [...items].sort((a, b) => b.signal.confidence - a.signal.confidence);
    const sources = new Set(sorted.map((i) => i.source));
    const when = new Date(sorted[0].signal.timestamp);
    const hh = String(when.getUTCHours()).padStart(2, '0');
    const mm = String(when.getUTCMinutes()).padStart(2, '0');
    const spanSec = Math.round(sorted[0].features.windowSpanSec);

    const head =
      `\u2705 ${sorted.length} AI-APPROVED SIGNAL${sorted.length === 1 ? '' : 'S'} ` +
      `\u00b7 ${hh}:${mm} UTC \u00b7 ${spanSec}s window`;
    const body = sorted.map((i) => TelegramDeliverer.line(i)).join('\n');

    // One compact analysis block per signal, strongest first.
    const analysis = sorted
      .map((i) => {
        const risks = i.analysis.risks.length > 0 ? `  risks: ${i.analysis.risks.join('; ')}` : '';
        const conflicts =
          i.analysis.conflicts.length > 0
            ? `  conflicts: ${i.analysis.conflicts.join('; ')}`
            : '';
        return (
          `\u{1F916} ${i.signal.asset}: ${i.analysis.summary}` +
          (risks ? `\n${risks}` : '') +
          (conflicts ? `\n${conflicts}` : '')
        );
      })
      .join('\n\n');

    const tail = sources.size === 1 ? `source: ${sorted[0].source}` : 'source: mixed';
    return `${head}\n\n${body}\n\n${analysis}\n\n${tail}`;
  }

  /**
   * Queue one AI-approved signal for delivery. Never throws, never blocks.
   *
   * With batching on (the default) the signal is buffered and a flush is
   * scheduled; the flush applies the per-asset cooldown and sends one message
   * for the whole bucket. With `batchWindowMs === 0` it is sent immediately.
   */
  send(
    signal: ValidSignal,
    features: FeatureWindow,
    source: string,
    analysis: AiAnalysis
  ): Promise<void> {
    if (!this.enabled) return Promise.resolve();

    // Always buffer, then flush immediately when batching is off. Routing the
    // immediate path through `flush` keeps the dedup and cooldown guards in
    // exactly one place, so they cannot be skipped by a configuration change.
    this.buffer.push({ signal, features, source, analysis });
    if (this.batchWindowMs === 0) return this.flush();

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
        ? TelegramDeliverer.format(items[0])
        : TelegramDeliverer.formatBatch(items);
    const count = items.length;

    // Serialise sends: chain onto the previous one regardless of its outcome.
    this.chain = this.chain
      .catch(() => undefined)
      .then(async () => {
        for (let attempt = 1; attempt <= this.maxSendAttempts; attempt++) {
          try {
            const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: this.chatId, text }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // Record the accepted message id. Telegram assigns it server-side,
            // so it is the one piece of evidence that proves the message
            // actually landed in the chat (an HTTP 200 alone does not). Read
            // defensively: a body that is missing or not JSON must not turn a
            // successful send into a failure.
            let messageId: number | undefined;
            try {
              const body = (await res.json()) as { result?: { message_id?: number } } | null;
              messageId = body?.result?.message_id;
            } catch {
              /* no/invalid JSON body — the send still succeeded */
            }
            this.lastMessageId = messageId ?? this.lastMessageId;
            this.sent++;
            this.signals += count;
            const assets = items.map((i) => `${i.signal.asset} ${i.signal.direction}`).join(', ');
            console.log(
              `[DELIVER] sent ${count} signal(s) as message #${messageId ?? '?'}: ${assets}`
            );
            this.recordAudit(messageId, text);
            return;
          } catch (e) {
            const last = attempt === this.maxSendAttempts;
            if (last) {
              this.failed++;
              console.error(
                `[DELIVER] Telegram send failed after ${attempt} attempt(s): ${(e as Error).message}`
              );
              return;
            }
            this.retries++;
            // Exponential backoff: 1s, 2s, ... capped at 8s.
            const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
            console.error(
              `[DELIVER] Telegram send attempt ${attempt} failed (${(e as Error).message}); ` +
                `retrying in ${wait}ms`
            );
            await new Promise((r) => setTimeout(r, wait));
          }
        }
      });

    return this.chain;
  }
}
