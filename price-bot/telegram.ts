/**
 * Telegram Notification Service with Interactive Inline Keyboard Support
 * Sends trading signals and alerts to Telegram with callback query handling
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
}

// ============================================
// INTERFACES
// ============================================

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

export interface CallbackQuery {
  id: string;
  from: { id: number; is_bot: boolean; first_name: string };
  chat?: { id: number; type: string };
  message?: {
    chat: { id: number };
    message_id: number;
  };
  data: string;
}

export interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
}

// ============================================
// CALLBACK DATA VALIDATOR
// ============================================

const VALID_ASSET_CALLBACKS = [
  'setpair_EURUSD_otc', 'setpair_GBPUSD_otc', 'setpair_USDJPY_otc',
  'setpair_XAUUSD_otc', 'setpair_AUDUSD_otc', 'setpair_USDCAD_otc',
  'setpair_NZDUSD_otc', 'setpair_EURGBP_otc', 'setpair_BTCUSD_otc',
  'setpair_ETHUSD_otc'
];

const VALID_EXPIRATION_CALLBACKS = [
  'exp_5s', 'exp_15s', 'exp_1m', 'exp_2m', 'exp_3m',
  'exp_5m', 'exp_15m', 'exp_30m'
];

const VALID_NAVIGATION_CALLBACKS = ['nav_asset', 'refresh', 'back', 'main_menu'];

const MAX_CALLBACK_LENGTH = 64;
const SAFE_CALLBACK_PATTERN = /^[a-zA-Z0-9_]+$/;

/**
 * Validate and sanitize callback data
 */
function validateCallbackData(data: string | undefined): string | null {
  if (!data) return null;
  if (data.length > MAX_CALLBACK_LENGTH) return null;
  if (!SAFE_CALLBACK_PATTERN.test(data)) return null;
  return data;
}

/**
 * Check if callback data is a valid asset selection
 */
function isValidAssetCallback(data: string): boolean {
  return VALID_ASSET_CALLBACKS.includes(data);
}

/**
 * Check if callback data is a valid expiration selection
 */
function isValidExpirationCallback(data: string): boolean {
  return VALID_EXPIRATION_CALLBACKS.includes(data);
}

/**
 * Check if callback data is a valid navigation command
 */
function isValidNavigationCallback(data: string): boolean {
  return VALID_NAVIGATION_CALLBACKS.includes(data);
}

// ============================================
// CALLBACK HANDLER TYPE
// ============================================

export type CallbackHandler = (query: CallbackQuery) => Promise<void>;

interface TelegramCallbacks {
  onAssetSelect?: (assetId: string, query: CallbackQuery) => Promise<void>;
  onExpirationSelect?: (expiration: string, query: CallbackQuery) => Promise<void>;
  onNavigation?: (action: string, query: CallbackQuery) => Promise<void>;
}

// ============================================
// TELEGRAM SERVICE
// ============================================

class TelegramService {
  private botToken: string;
  private chatId: string;
  private enabled: boolean = true;
  private callbacks: TelegramCallbacks = {};
  private updateOffset: number = 0;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private isPolling: boolean = false;

  constructor(botToken?: string, chatId?: string) {
    this.botToken = botToken || BOT_TOKEN;
    this.chatId = chatId || CHAT_ID;
  }

  /**
   * Register callback handlers for inline keyboard interactions
   */
  registerCallbacks(callbacks: TelegramCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
    console.log('[TELEGRAM] Callbacks registered');
  }

  /**
   * Start polling for updates (for long-polling mode)
   */
  startPolling(intervalMs: number = 1000): void {
    if (this.isPolling) {
      console.log('[TELEGRAM] Already polling');
      return;
    }

    this.isPolling = true;
    this.pollUpdates(intervalMs);
    console.log(`[TELEGRAM] Started polling every ${intervalMs}ms`);
  }

  /**
   * Stop polling for updates
   */
  stopPolling(): void {
    this.isPolling = false;
    if (this.pollingInterval) {
      clearTimeout(this.pollingInterval);
      this.pollingInterval = null;
    }
    console.log('[TELEGRAM] Stopped polling');
  }

  /**
   * Poll for updates (long polling)
   */
  private async pollUpdates(intervalMs: number): Promise<void> {
    if (!this.isPolling) return;

    try {
      const updates = await this.getUpdates();
      if (updates.length > 0) {
        for (const update of updates) {
          if (update.callback_query) {
            await this.handleCallbackQuery(update.callback_query);
          }
        }
      }
    } catch (error) {
      console.error('[TELEGRAM] Polling error:', error);
    }

    // Schedule next poll
    if (this.isPolling) {
      this.pollingInterval = setTimeout(() => this.pollUpdates(intervalMs), intervalMs);
    }
  }

  /**
   * Get updates from Telegram using long polling
   */
  private async getUpdates(): Promise<Update[]> {
    try {
      const response = await fetch(
        `${API_URL}/getUpdates?offset=${this.updateOffset}&timeout=10`,
        { method: 'GET' }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.ok && data.result) {
        // Update offset to next update
        const updates = data.result as Update[];
        if (updates.length > 0) {
          const lastUpdate = updates[updates.length - 1];
          this.updateOffset = lastUpdate.update_id + 1;
        }
        return updates;
      }
      return [];
    } catch (error) {
      console.error('[TELEGRAM] Get updates error:', error);
      return [];
    }
  }

  /**
   * Handle incoming callback query
   */
  private async handleCallbackQuery(query: CallbackQuery): Promise<void> {
    const data = validateCallbackData(query.data);
    
    if (data === null) {
      console.warn(`[TELEGRAM] Invalid callback data from ${query.from.id}: ${query.data}`);
      await this.answerCallbackQuery(query.id, '⚠️ Invalid input');
      return;
    }

    console.log(`[TELEGRAM] Callback from ${query.from.id}: ${data}`);

    // Route to appropriate handler
    if (data.startsWith('setpair_')) {
      if (this.callbacks.onAssetSelect) {
        const assetId = data.replace('setpair_', '');
        if (isValidAssetCallback(data)) {
          await this.callbacks.onAssetSelect(assetId, query);
        } else {
          await this.answerCallbackQuery(query.id, '⚠️ Invalid asset');
        }
      }
    } else if (data.startsWith('exp_')) {
      if (this.callbacks.onExpirationSelect) {
        if (isValidExpirationCallback(data)) {
          await this.callbacks.onExpirationSelect(data, query);
        } else {
          await this.answerCallbackQuery(query.id, '⚠️ Invalid expiration');
        }
      }
    } else if (isValidNavigationCallback(data)) {
      if (this.callbacks.onNavigation) {
        await this.callbacks.onNavigation(data, query);
      }
    } else {
      console.warn(`[TELEGRAM] Unknown callback data: ${data}`);
      await this.answerCallbackQuery(query.id, '⚠️ Unknown command');
    }
  }

  /**
   * Answer a callback query
   */
  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    showAlert: boolean = false
  ): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text,
          show_alert: showAlert
        })
      });

      const data = await response.json();
      return data.ok === true;
    } catch (error) {
      console.error('[TELEGRAM] Answer callback error:', error);
      return false;
    }
  }

  /**
   * Edit message reply markup
   */
  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: any
  ): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: replyMarkup
        })
      });

      const data = await response.json();
      return data.ok === true;
    } catch (error) {
      console.error('[TELEGRAM] Edit message error:', error);
      return false;
    }
  }

  /**
   * Send message to Telegram
   */
  async sendMessage(
    text: string, 
    parseMode: 'HTML' | 'Markdown' = 'HTML',
    replyMarkup?: any
  ): Promise<boolean> {
    if (!this.enabled) return false;

    try {
      const response = await fetch(`${API_URL}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
          reply_markup: replyMarkup
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
   * Send signal alert with inline keyboard
   */
  async sendSignal(
    signal: SignalMessage,
    replyMarkup?: any
  ): Promise<boolean> {
    const emoji = signal.direction === 'CALL' ? '📈' : signal.direction === 'PUT' ? '📉' : '⏳';
    
    const message = `
${emoji} <b>NEW SIGNAL</b> ${emoji}

<b>Asset:</b> ${signal.assetId.replace('_otc', '/OTC')}
<b>Direction:</b> <code>${signal.direction}</code>
<b>Entry Price:</b> ${signal.entryPrice.toFixed(5)}

📊 <b>Confidence:</b> ${signal.direction === 'WAIT' ? 'N/A' : signal.confidence + '%'}
⏱️ <b>Time Remaining:</b> ${signal.timeRemaining}s
🎯 <b>Entry Quality:</b> ${signal.entryQuality}

📝 <b>Analysis:</b>
${signal.reasons.map(r => `   • ${r}`).join('\n')}

⏰ <b>Time:</b> ${new Date(signal.timestamp).toLocaleString()}
`;

    return this.sendMessage(message, 'HTML', replyMarkup);
  }

  /**
   * Send signal with inline keyboard for new signal / back navigation
   */
  buildSignalKeyboard(): any {
    return {
      inline_keyboard: [
        [
          { text: '🔄 New Signal', callback_data: 'refresh' },
          { text: '⬅️ Back to Pairs', callback_data: 'nav_asset' }
        ]
      ]
    };
  }

  /**
   * Build asset selection keyboard
   */
  buildAssetKeyboard(): any {
    return {
      inline_keyboard: [
        [
          { text: '💰 EURUSD', callback_data: 'setpair_EURUSD_otc' },
          { text: '💰 GBPUSD', callback_data: 'setpair_GBPUSD_otc' }
        ],
        [
          { text: '💰 USDJPY', callback_data: 'setpair_USDJPY_otc' },
          { text: '🥇 XAUUSD', callback_data: 'setpair_XAUUSD_otc' }
        ],
        [
          { text: '🦘 AUDUSD', callback_data: 'setpair_AUDUSD_otc' },
          { text: '🍁 USDCAD', callback_data: 'setpair_USDCAD_otc' }
        ],
        [
          { text: '🇳🇿 NZDUSD', callback_data: 'setpair_NZDUSD_otc' },
          { text: '🇪🇺🇬🇧 EURGBP', callback_data: 'setpair_EURGBP_otc' }
        ],
        [
          { text: '₿ BTCUSD', callback_data: 'setpair_BTCUSD_otc' },
          { text: 'Ξ ETHUSD', callback_data: 'setpair_ETHUSD_otc' }
        ]
      ]
    };
  }

  /**
   * Build expiration selection keyboard
   */
  buildExpirationKeyboard(assetDisplay: string): any {
    return {
      inline_keyboard: [
        [
          { text: '⚡ 5s', callback_data: 'exp_5s' },
          { text: '⚡ 15s', callback_data: 'exp_15s' }
        ],
        [
          { text: '1️⃣ 1m', callback_data: 'exp_1m' },
          { text: '2️⃣ 2m', callback_data: 'exp_2m' },
          { text: '3️⃣ 3m', callback_data: 'exp_3m' }
        ],
        [
          { text: '5️⃣ 5m', callback_data: 'exp_5m' },
          { text: '1️⃣5️⃣ 15m', callback_data: 'exp_15m' },
          { text: '3️⃣0️⃣ 30m', callback_data: 'exp_30m' }
        ],
        [
          { text: '⬅️ Back to Pairs', callback_data: 'nav_asset' }
        ]
      ]
    };
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

// Export class for multiple instances
export default TelegramService;

// Export constants for external use
export {
  VALID_ASSET_CALLBACKS,
  VALID_EXPIRATION_CALLBACKS,
  VALID_NAVIGATION_CALLBACKS,
  validateCallbackData,
  isValidAssetCallback,
  isValidExpirationCallback,
  isValidNavigationCallback
};
