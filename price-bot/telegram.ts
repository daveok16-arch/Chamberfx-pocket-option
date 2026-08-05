/**
 * Telegram Notification Service
 * Sends trading signals and alerts to Telegram
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
}

export interface SignalMessage {
  assetId: string;
  direction: 'CALL' | 'PUT' | 'WAIT';
  entryPrice: number;
  confidence: number;
  timeRemaining: number;
  entryQuality: string;
  reasons: string[];
  timestamp: number;
}

export interface TradeMessage {
  tradeId: string;
  direction: 'CALL' | 'PUT';
  entryPrice: number;
  expiryTime: number;
  stake: number;
  assetId: string;
}

export interface ResultMessage {
  tradeId: string;
  assetId: string;
  direction: 'CALL' | 'PUT';
  entryPrice: number;
  exitPrice: number;
  result: 'WIN' | 'LOSS';
  profit: number;
}

class TelegramService {
  private botToken: string;
  private chatId: string;
  private enabled: boolean = true;

  constructor(botToken?: string, chatId?: string) {
    this.botToken = botToken || BOT_TOKEN;
    this.chatId = chatId || CHAT_ID;
  }

  /**
   * Send message to Telegram
   */
  async sendMessage(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
    if (!this.enabled) return false;

    try {
      const response = await fetch(`${API_URL}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true
        })
      });

      const data = await response.json();
      return data.ok === true;
    } catch (error) {
      console.error('[TELEGRAM] Send error:', error);
      return false;
    }
  }

  /**
   * Send signal alert
   */
  async sendSignal(signal: SignalMessage): Promise<boolean> {
    const emoji = signal.direction === 'CALL' ? '📈' : signal.direction === 'PUT' ? '📉' : '⏳';
    const color = signal.direction === 'CALL' ? '🟢' : signal.direction === 'PUT' ? '🔴' : '⚪';
    
    const message = `
${emoji} <b>NEW SIGNAL</b> ${emoji}

${color} <b>Asset:</b> ${signal.assetId.replace('_otc', '/OTC')}
${color} <b>Direction:</b> <code>${signal.direction}</code>
${color} <b>Entry Price:</b> ${signal.entryPrice.toFixed(5)}

📊 <b>Confidence:</b> ${signal.direction === 'WAIT' ? 'N/A' : signal.confidence + '%'}
⏱️ <b>Time Remaining:</b> ${signal.timeRemaining}s
🎯 <b>Entry Quality:</b> ${signal.entryQuality}

📝 <b>Analysis:</b>
${signal.reasons.map(r => `   • ${r}`).join('\n')}

⏰ <b>Time:</b> ${new Date(signal.timestamp).toLocaleString()}
`;

    return this.sendMessage(message);
  }

  /**
   * Send trade placed notification
   */
  async sendTradePlaced(trade: TradeMessage): Promise<boolean> {
    const emoji = trade.direction === 'CALL' ? '🟢' : '🔴';
    
    const message = `
💰 <b>TRADE PLACED</b> 💰

${emoji} <b>Asset:</b> ${trade.assetId.replace('_otc', '/OTC')}
${emoji} <b>Direction:</b> <code>${trade.direction}</code>
${emoji} <b>Entry:</b> ${trade.entryPrice.toFixed(5)}
${emoji} <b>Stake:</b> $${trade.stake}

⏰ <b>Expiry:</b> ${new Date(trade.expiryTime * 1000).toLocaleTimeString()}
🔖 <b>Trade ID:</b> <code>${trade.tradeId}</code>
`;

    return this.sendMessage(message);
  }

  /**
   * Send trade result notification
   */
  async sendTradeResult(result: ResultMessage): Promise<boolean> {
    const emoji = result.result === 'WIN' ? '🎉' : '😢';
    const color = result.result === 'WIN' ? '🟢' : '🔴';
    
    const message = `
${emoji} <b>TRADE ${result.result}</b> ${emoji}

${color} <b>Asset:</b> ${result.assetId.replace('_otc', '/OTC')}
${color} <b>Direction:</b> <code>${result.direction}</code>

📊 <b>Entry:</b> ${result.entryPrice.toFixed(5)}
📊 <b>Exit:</b> ${result.exitPrice.toFixed(5)}

${result.result === 'WIN' ? '💵' : '💸'} <b>Profit:</b> ${result.result === 'WIN' ? '+' : ''}$${result.profit.toFixed(2)}

🔖 <b>Trade ID:</b> <code>${result.tradeId}</code>
`;

    return this.sendMessage(message);
  }

  /**
   * Send performance summary
   */
  async sendPerformance(performance: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    profit: number;
  }): Promise<boolean> {
    const message = `
📊 <b>PERFORMANCE REPORT</b>

📈 <b>Total Trades:</b> ${performance.totalTrades}
🟢 <b>Wins:</b> ${performance.wins}
🔴 <b>Losses:</b> ${performance.losses}
📊 <b>Win Rate:</b> ${performance.winRate.toFixed(1)}%

${performance.profit >= 0 ? '💵' : '💸'} <b>Profit:</b> ${performance.profit >= 0 ? '+' : ''}$${performance.profit.toFixed(2)}

⏰ <b>Updated:</b> ${new Date().toLocaleString()}
`;

    return this.sendMessage(message);
  }

  /**
   * Send status heartbeat
   */
  async sendHeartbeat(prices: Map<string, number>, activeSignals: SignalMessage[]): Promise<boolean> {
    const priceList = Array.from(prices.entries())
      .map(([asset, price]) => `   ${asset.replace('_otc', '')}: ${price.toFixed(5)}`)
      .join('\n');

    const signalList = activeSignals.length > 0
      ? activeSignals.map(s => `   • ${s.assetId}: ${s.direction} (${s.confidence}%)`).join('\n')
      : '   No active signals';

    const message = `
🔔 <b>BOT HEARTBEAT</b>

📊 <b>Live Prices:</b>
${priceList}

🎯 <b>Active Signals:</b>
${signalList}

⏰ <b>Time:</b> ${new Date().toLocaleTimeString()}
`;

    return this.sendMessage(message);
  }

  /**
   * Test connection
   */
  async test(): Promise<boolean> {
    const message = `
✅ <b>Telegram Bot Connected!</b>

Bot is ready to receive trading signals.
`;

    return this.sendMessage(message);
  }

  /**
   * Enable/disable notifications
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

// Export singleton instance
export const telegram = new TelegramService();

// Also export class for multiple instances
export default TelegramService;
