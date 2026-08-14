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
    this.chatId = CHAT_ID.trim();
    if (!this.enabled) {
      console.warn(
        '[TELEGRAM] Disabled — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to deliver signals to Telegram.'
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Validate the bot token + chat id at startup.
   * Calls getMe (token check) and getChat (chat check). Logs a precise,
   * actionable error if either fails. Never throws — the bot keeps running.
   */
  async validate(): Promise<boolean> {
    if (!this.enabled) return false;
    // 1) Token check
    let meOk = false;
    let botId = '';
    try {
      const res = await fetch(`${API_URL}/getMe`);
      const data = await res.json() as { ok: boolean; description?: string; result?: { id?: number; username?: string } };
      if (data.ok && data.result) {
        meOk = true;
        botId = String(data.result.id ?? '');
        console.log(`[TELEGRAM] Bot token OK — @${data.result.username} (id ${botId})`);
      } else {
        console.error(`[TELEGRAM] Bot token INVALID: ${data.description}`);
        return false;
      }
    } catch (err) {
      console.error(`[TELEGRAM] getMe network error: ${(err as Error).message}`);
      return false;
    }
    // Common mistake: using the bot's own id as the chat id.
    if (botId && this.chatId === botId) {
      console.error(`[TELEGRAM] TELEGRAM_CHAT_ID (${this.chatId}) is the BOT's own id — a bot cannot message itself.`);
      console.error('[TELEGRAM] Fix: set TELEGRAM_CHAT_ID to YOUR personal Telegram user id (from @userinfobot), after sending /start to your bot.');
      return false;
    }
    // 2) Chat check
    let chatOk = false;
    try {
      const res = await fetch(`${API_URL}/getChat?chat_id=${encodeURIComponent(this.chatId)}`);
      const data = await res.json() as { ok: boolean; description?: string; result?: { type?: string; title?: string; username?: string; first_name?: string } };
      if (data.ok && data.result) {
        chatOk = true;
        const name = data.result.title || data.result.username || data.result.first_name || '';
        console.log(`[TELEGRAM] Chat OK — type=${data.result.type} ${name ? `(${name})` : ''} id=${this.chatId}`);
      } else {
        console.error(`[TELEGRAM] Chat NOT accessible: ${data.description}`);
        if (data.description && data.description.toLowerCase().includes('chat not found')) {
          console.error('[TELEGRAM] Fix: for a private chat, send /start to your bot first, then use your numeric user id (from @userinfobot). For a channel, add the bot as admin and use the id with the -100 prefix (e.g. -1001234567890).');
        } else if (data.description && data.description.toLowerCase().includes("can't send messages to the bot")) {
          console.error('[TELEGRAM] Fix: TELEGRAM_CHAT_ID points at a bot. Use YOUR personal user id (from @userinfobot) instead.');
        } else {
          console.error('[TELEGRAM] Fix: confirm TELEGRAM_CHAT_ID is correct and that the bot can write to that chat.');
        }
      }
    } catch (err) {
      console.error(`[TELEGRAM] getChat network error: ${(err as Error).message}`);
    }
    return meOk && chatOk;
  }

  /** Send arbitrary text (HTML parse mode, falls back to plain text on parse error). */
  async send(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
    if (!this.enabled) return false;
    const ok = await this._sendOnce(text, parseMode);
    if (!ok && parseMode === 'HTML') {
      // Retry as plain text in case the HTML entities failed to parse.
      return this._sendOnce(text.replace(/<[^>]+>/g, ''), undefined);
    }
    return ok;
  }

  private async _sendOnce(text: string, parseMode: 'HTML' | 'Markdown' | undefined): Promise<boolean> {
    try {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true,
      };
      if (parseMode) body.parse_mode = parseMode;
      const res = await fetch(`${API_URL}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok: boolean; description?: string };
      if (!data.ok) {
        console.error(`[TELEGRAM] sendMessage failed (chat_id=${this.chatId}): ${data.description}`);
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
