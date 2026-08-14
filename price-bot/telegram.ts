/**
 * Telegram Notification Service for Signal Delivery
 * ==================================================
 * Sends live CALL/PUT signals (and status) to a Telegram chat via the Bot API.
 * Uses Node's built-in fetch — no extra dependencies.
 *
 * Configuration (environment variables):
 *   TELEGRAM_BOT_TOKEN  — Bot token from @BotFather
 *   TELEGRAM_CHAT_ID    — Target chat/channel id to deliver signals to
 *
 * If either is unset, the notifier disables itself and warns (does NOT crash
 * the bot) so the signal engine keeps running and logging to signals.jsonl.
 */

import type { Signal } from './signal.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

export class TelegramNotifier {
  private enabled: boolean;
  private readonly chatId: string;

  constructor() {
    this.enabled = Boolean(BOT_TOKEN && CHAT_ID);
    this.chatId = CHAT_ID;
    if (!this.enabled) {
      console.warn(
        '[TELEGRAM] Disabled — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to deliver signals to Telegram.'
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Send arbitrary text (HTML parse mode). Returns true on success. */
  async send(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await fetch(`${API_URL}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
      });
      const data = await res.json() as { ok: boolean; description?: string };
      if (!data.ok) {
        console.error('[TELEGRAM] sendMessage failed:', data.description);
      }
      return data.ok === true;
    } catch (err) {
      console.error('[TELEGRAM] send error:', (err as Error).message);
      return false;
    }
  }

  /** Format and deliver a trading signal. */
  async sendSignal(s: Signal): Promise<boolean> {
    if (!this.enabled) return false;
    const emoji = s.direction === 'CALL' ? '🟢📈' : s.direction === 'PUT' ? '🔴📉' : '⚪';
    const asset = s.assetId.replace('_otc', '/OTC');
    const c = s.components;

    const lines: string[] = [];
    lines.push(`${emoji} <b>${s.direction} SIGNAL</b> — ${asset}`);
    lines.push('');
    lines.push(`💰 <b>Entry:</b> <code>${s.entryPrice.toFixed(5)}</code>`);
    lines.push(`🎯 <b>Confidence:</b> <b>${s.confidence}%</b>`);
    lines.push(`⏱ <b>Expiry:</b> ${s.expiryMinutes}m  (${s.timeRemainingSec}s left, ${s.entryQuality})`);
    lines.push('');
    lines.push('🧩 <b>Leading components:</b>');
    lines.push(`  • OFI: <code>${fmt(c.ofi)}</code>  • Candle: <code>${fmt(c.candleSignal)}</code> [${esc(c.candlePattern)}]`);
    lines.push(`  • Momentum: <code>${fmt(c.momentum)}</code>${c.momentumDecay > 0.5 ? ' (decaying)' : ''}  • Structure: <code>${fmt(c.structure)}</code> [${esc(c.structureLabel)}]`);
    lines.push(`  • Regime: <b>${esc(c.regime)}</b> (strength ${c.regimeStrength.toFixed(2)})`);
    lines.push('');
    lines.push('📝 <b>Reasons:</b>');
    for (const r of s.reasons) lines.push(`  • ${esc(r)}`);
    lines.push('');
    lines.push(`🕐 ${new Date(s.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC`);

    return this.send(lines.join('\n'));
  }

  /** Startup/connectivity confirmation. */
  async sendStartup(): Promise<boolean> {
    return this.send('✅ <b>Pocket Option OTC Signal Bot</b> is online.\nLive capture + leading signal engine active. Signals will be delivered here.');
  }

  /** Periodic heartbeat with live prices. */
  async sendHeartbeat(prices: Map<string, number>, candleCounts: Map<string, number>): Promise<boolean> {
    const priceList = Array.from(prices.entries())
      .map(([a, p]) => `  ${a.replace('_otc', '')}: ${p.toFixed(5)} (${candleCounts.get(a) ?? 0} candles)`)
      .join('\n');
    return this.send(`🔔 <b>Heartbeat</b>\n📊 <b>Live prices:</b>\n${priceList}\n🕐 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  }
}

function fmt(n: number): string {
  return (n > 0 ? '+' : '') + String(n);
}
// Minimal HTML escaping for user-facing strings embedded in HTML parse mode.
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const telegram = new TelegramNotifier();
export default TelegramNotifier;
