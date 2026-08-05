/**
 * Pocket Option Trading Bot v1.0
 * 
 * A comprehensive trading bot that:
 * 1. Captures live prices from Pocket Option OTC pairs
 * 2. Builds technical indicators (EMA, RSI, MACD, Bollinger, ADX)
 * 3. Generates trading signals (CALL/PUT/WAIT)
 * 4. Tracks trades and performance
 * 5. Manages a trading ledger
 */

import { WebSocket } from "ws";
import { chromium } from "playwright";
import * as fs from "fs";

// ============================================
// TYPES & INTERFACES
// ============================================

export interface Tick {
  assetId: string;
  price: number;
  timestamp: number;
  direction: 'UP' | 'DOWN' | 'FLAT';
}

export interface Candle {
  assetId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
  closeTime: number;
}

export interface TechnicalIndicators {
  ema9: number;
  ema21: number;
  ema50: number;
  rsi: number;
  macd: { value: number; signal: number; histogram: number };
  bollinger: { upper: number; mid: number; lower: number; position: number };
  adx: number;
  atr: number;
  support: number;
  resistance: number;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface TradingSignal {
  assetId: string;
  direction: 'CALL' | 'PUT' | 'WAIT';
  strength: number; // 0-100
  entryPrice: number;
  confidence: number;
  indicators: TechnicalIndicators;
  reasons: string[];
  timestamp: number;
  candleTime: number;
}

export interface Trade {
  id: string;
  assetId: string;
  direction: 'CALL' | 'PUT';
  entryPrice: number;
  exitPrice?: number;
  entryTime: number;
  exitTime?: number;
  result?: 'WIN' | 'LOSS' | 'PENDING';
  payout: number;
  stake: number;
}

export interface AssetState {
  id: string;
  name: string;
  ticks: number[];
  candles: Candle[];
  indicators: TechnicalIndicators | null;
  lastSignal: TradingSignal | null;
  payout: number;
  active: boolean;
}

export interface BotConfig {
  assets: string[];
  minConfidence: number;
  minRSI: number;
  maxRSI: number;
  emaFast: number;
  emaSlow: number;
  candlePeriod: number; // seconds
  signalInterval: number; // seconds between signal checks
  saveResults: boolean;
  outputDir: string;
  verbose: boolean;
}

// ============================================
// DEFAULT CONFIGURATION
// ============================================

const DEFAULT_CONFIG: BotConfig = {
  assets: [
    'EURUSD_otc',
    'GBPUSD_otc', 
    'USDJPY_otc',
    'XAUUSD_otc',
    'AUDUSD_otc',
    'USDCAD_otc'
  ],
  minConfidence: 65,
  minRSI: 30,
  maxRSI: 70,
  emaFast: 9,
  emaSlow: 21,
  candlePeriod: 60,
  signalInterval: 5,
  saveResults: true,
  outputDir: './results',
  verbose: true
};

// ============================================
// TECHNICAL INDICATOR CALCULATIONS
// ============================================

class IndicatorCalculator {
  // Exponential Moving Average
  static calcEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  // Relative Strength Index
  static calcRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // MACD (Moving Average Convergence Divergence)
  static calcMACD(prices: number[], fast: number = 12, slow: number = 26, signal: number = 9): {
    value: number;
    signal: number;
    histogram: number;
  } {
    if (prices.length < slow) return { value: 0, signal: 0, histogram: 0 };
    
    const emaFast = this.calcEMA(prices, fast);
    const emaSlow = this.calcEMA(prices, slow);
    const macdLine = emaFast - emaSlow;
    
    // Calculate signal line using historical MACD values
    const macdHistory: number[] = [];
    for (let i = slow; i < prices.length; i++) {
      const ef = this.calcEMA(prices.slice(0, i + 1), fast);
      const es = this.calcEMA(prices.slice(0, i + 1), slow);
      macdHistory.push(ef - es);
    }
    const signalLine = this.calcEMA(macdHistory, signal);
    
    return {
      value: macdLine,
      signal: signalLine,
      histogram: macdLine - signalLine
    };
  }

  // Bollinger Bands
  static calcBollinger(prices: number[], period: number = 20, stdDev: number = 2): {
    upper: number;
    mid: number;
    lower: number;
    position: number;
  } {
    if (prices.length < period) {
      const last = prices[prices.length - 1] || 1;
      return { upper: last * 1.02, mid: last, lower: last * 0.98, position: 0.5 };
    }
    
    const slice = prices.slice(-period);
    const mid = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, p) => sum + Math.pow(p - mid, 2), 0) / period;
    const std = Math.sqrt(variance);
    const upper = mid + stdDev * std;
    const lower = mid - stdDev * std;
    const currentPrice = prices[prices.length - 1];
    const position = upper === lower ? 0.5 : (currentPrice - lower) / (upper - lower);
    
    return { upper, mid, lower, position };
  }

  // Average True Range
  static calcATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 0;
    const trs: number[] = [highs[1] - lows[1]];
    for (let i = 2; i < closes.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  // ADX (Average Directional Index)
  static calcADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 20;
    
    const trs: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    
    for (let i = 1; i < closes.length; i++) {
      trs.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      ));
      
      const plusDMVal = highs[i] - highs[i - 1] > lows[i - 1] - lows[i]
        ? Math.max(0, highs[i] - highs[i - 1])
        : 0;
      const minusDMVal = lows[i - 1] - lows[i] > highs[i] - highs[i - 1]
        ? Math.max(0, lows[i - 1] - lows[i])
        : 0;
      
      plusDM.push(plusDMVal);
      minusDM.push(minusDMVal);
    }
    
    const atr = this.calcATR(highs, lows, closes, period);
    if (atr === 0) return 20;
    
    const plusDI = (plusDM.slice(-period).reduce((a, b) => a + b, 0) / period / atr) * 100;
    const minusDI = (minusDM.slice(-period).reduce((a, b) => a + b, 0) / period / atr) * 100;
    
    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
    return Math.min(100, dx);
  }

  // Support & Resistance Levels
  static calcSupportResistance(candles: Candle[]): { support: number; resistance: number } {
    if (candles.length < 10) {
      const lastClose = candles[candles.length - 1]?.close || 1;
      return {
        support: lastClose * 0.998,
        resistance: lastClose * 1.002
      };
    }
    
    const recentCandles = candles.slice(-20);
    const lows = recentCandles.map(c => c.low);
    const highs = recentCandles.map(c => c.high);
    
    return {
      support: Math.min(...lows),
      resistance: Math.max(...highs)
    };
  }

  // Calculate all indicators for a given price series
  static calculateAll(prices: number[], highs: number[], lows: number[], candles: Candle[]): TechnicalIndicators {
    const ema9 = this.calcEMA(prices, 9);
    const ema21 = this.calcEMA(prices, 21);
    const ema50 = this.calcEMA(prices, 50);
    const rsi = this.calcRSI(prices);
    const macd = this.calcMACD(prices);
    const bollinger = this.calcBollinger(prices);
    const atr = this.calcATR(highs, lows, prices);
    const adx = this.calcADX(highs, lows, prices);
    const { support, resistance } = this.calcSupportResistance(candles);
    
    // Determine trend
    let trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (ema9 > ema21 && prices[prices.length - 1] > ema9) {
      trend = 'BULLISH';
    } else if (ema9 < ema21 && prices[prices.length - 1] < ema9) {
      trend = 'BEARISH';
    }
    
    return {
      ema9,
      ema21,
      ema50,
      rsi,
      macd,
      bollinger,
      adx,
      atr,
      support,
      resistance,
      trend
    };
  }
}

// ============================================
// SIGNAL GENERATOR
// ============================================

class SignalGenerator {
  private config: BotConfig;
  
  constructor(config: Partial<BotConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  generate(indicators: TechnicalIndicators, price: number): TradingSignal {
    const reasons: string[] = [];
    let bullishScore = 0;
    let bearishScore = 0;
    
    // EMA Analysis
    if (indicators.ema9 > indicators.ema21) {
      bullishScore += 2;
      reasons.push('EMA 9 > EMA 21 (bullish crossover)');
    } else if (indicators.ema9 < indicators.ema21) {
      bearishScore += 2;
      reasons.push('EMA 9 < EMA 21 (bearish crossover)');
    }
    
    // Price vs EMA
    if (price > indicators.ema9) {
      bullishScore += 1;
      reasons.push('Price above EMA 9');
    } else {
      bearishScore += 1;
      reasons.push('Price below EMA 9');
    }
    
    // RSI Analysis
    if (indicators.rsi < this.config.minRSI) {
      bullishScore += 3;
      reasons.push(`RSI oversold (${indicators.rsi.toFixed(1)})`);
    } else if (indicators.rsi > this.config.maxRSI) {
      bearishScore += 3;
      reasons.push(`RSI overbought (${indicators.rsi.toFixed(1)})`);
    } else if (indicators.rsi > 50) {
      bullishScore += 1;
    } else {
      bearishScore += 1;
    }
    
    // MACD Analysis
    if (indicators.macd.histogram > 0) {
      bullishScore += 2;
      reasons.push('MACD histogram positive');
    } else if (indicators.macd.histogram < 0) {
      bearishScore += 2;
      reasons.push('MACD histogram negative');
    }
    
    // Bollinger Bands Position
    if (indicators.bollinger.position < 0.2) {
      bullishScore += 2;
      reasons.push('Price near lower Bollinger band');
    } else if (indicators.bollinger.position > 0.8) {
      bearishScore += 2;
      reasons.push('Price near upper Bollinger band');
    }
    
    // ADX (Trend Strength)
    if (indicators.adx > 25) {
      if (indicators.trend === 'BULLISH') {
        bullishScore += 2;
        reasons.push('Strong bullish trend (ADX > 25)');
      } else if (indicators.trend === 'BEARISH') {
        bearishScore += 2;
        reasons.push('Strong bearish trend (ADX > 25)');
      }
    }
    
    // Calculate confidence and direction
    const totalScore = bullishScore + bearishScore;
    const confidence = Math.min(100, Math.round((Math.max(bullishScore, bearishScore) / 5) * 100));
    
    let direction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
    
    if (confidence >= this.config.minConfidence && totalScore > 0) {
      if (bullishScore > bearishScore) {
        direction = 'CALL';
      } else if (bearishScore > bullishScore) {
        direction = 'PUT';
      }
    }
    
    return {
      assetId: '',
      direction,
      strength: confidence,
      entryPrice: price,
      confidence,
      indicators,
      reasons,
      timestamp: Date.now(),
      candleTime: Math.floor(Date.now() / 60000) * 60000
    };
  }
}

// ============================================
// TRADING BOT
// ============================================

export class PocketOptionTradingBot {
  private ws: WebSocket | null = null;
  private config: BotConfig;
  private assets: Map<string, AssetState> = new Map();
  private signals: Map<string, TradingSignal> = new Map();
  private trades: Trade[] = [];
  private pendingBinaryEvent: string | null = null;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private discoveredWsUrl: string = '';
  private cachedAuthPacket: string = '';
  private cachedCookies: string = '';
  
  // Callbacks
  private onSignalCallback?: (signal: TradingSignal) => void;
  private onTradeCallback?: (trade: Trade) => void;
  private onTickCallback?: (tick: Tick) => void;
  private onConnectCallback?: () => void;
  private onDisconnectCallback?: () => void;

  constructor(config: Partial<BotConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeAssets();
    
    // Create results directory
    if (this.config.saveResults && !fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }
  }

  private initializeAssets(): void {
    for (const assetId of this.config.assets) {
      this.assets.set(assetId, {
        id: assetId,
        name: assetId.replace('_otc', '/OTC').replace('XAUUSD', 'GOLD'),
        ticks: [],
        candles: [],
        indicators: null,
        lastSignal: null,
        payout: 0.92,
        active: true
      });
    }
  }

  // ============================================
  // SESSION DISCOVERY
  // ============================================

  private async discoverSession(): Promise<{ url: string; authPacket: string; cookies: string }> {
    this.log('[DISCOVERY] Launching headless browser...');
    
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
    } catch (err: any) {
      if (err.message?.includes("Executable doesn't exist")) {
        this.log('[DISCOVERY] Installing Chromium...');
        const { execSync } = await import('child_process');
        execSync('npx playwright install chromium', { stdio: 'inherit' });
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
      } else {
        throw err;
      }
    }

    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });
      
      const page = await context.newPage();
      let capturedWsUrl = '';
      let capturedAuthPacket = '';
      
      page.on('websocket', (ws) => {
        const url = ws.url();
        if (url.includes('socket.io') && url.includes('po.market')) {
          capturedWsUrl = url;
          ws.on('framesent', (frame) => {
            const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
            if (payload.includes('"auth"')) {
              capturedAuthPacket = payload;
            }
          });
        }
      });

      const candidates = [
        'https://po.trade/en/cabinet/try-demo/',
        'https://pocketoption.com/en/cabinet/try-demo/'
      ];

      for (const url of candidates) {
        if (capturedWsUrl) break;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(8000);
        } catch (e) {}
      }

      const cookies = await context.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      
      await browser.close();
      return { url: capturedWsUrl, authPacket: capturedAuthPacket, cookies: cookieStr };
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }

  // ============================================
  // WEBSOCKET CONNECTION
  // ============================================

  public async connect(): Promise<void> {
    try {
      const session = await this.discoverSession();
      this.discoveredWsUrl = session.url;
      this.cachedAuthPacket = session.authPacket;
      this.cachedCookies = session.cookies;

      this.log(`[WS] Connecting to: ${this.discoveredWsUrl}`);
      
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': this.discoveredWsUrl.includes('po.trade') ? 'https://po.trade' : 'https://pocketoption.com'
      };
      
      if (this.cachedCookies) {
        headers['Cookie'] = this.cachedCookies;
      }

      this.ws = new WebSocket(this.discoveredWsUrl, { headers });
      
      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('error', (err) => this.log(`[WS ERROR] ${err.message}`));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason.toString()));

    } catch (err) {
      this.log(`[ERROR] ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private handleOpen(): void {
    this.log('[WS] Connection opened');
    this.connected = true;
    this.reconnectAttempts = 0;
    this.onConnectCallback?.();
  }

  private handleMessage(data: any): void {
    let msg: string;
    if (Buffer.isBuffer(data)) {
      msg = data.toString('utf8');
    } else if (typeof data === 'string') {
      msg = data;
    } else if (data instanceof Uint8Array) {
      msg = Buffer.from(data).toString('utf8');
    } else {
      msg = String(data);
    }

    // Heartbeat
    if (msg === '2') {
      this.ws?.send('3');
      return;
    }

    // Handshake
    if (msg.startsWith('0{')) {
      this.ws?.send('40');
      return;
    }

    // Namespace join
    if (msg.startsWith('40')) {
      this.log('[WS] Authenticated');
      if (this.cachedAuthPacket) {
        this.ws?.send(this.cachedAuthPacket);
        setTimeout(() => this.subscribeAllAssets(), 2000);
      }
      return;
    }

    // Binary event indicator
    if (msg.startsWith('45')) {
      try {
        const dashIndex = msg.indexOf('-');
        if (dashIndex !== -1) {
          const parsed = JSON.parse(msg.substring(dashIndex + 1));
          if (Array.isArray(parsed) && parsed[1]?.num !== undefined) {
            this.pendingBinaryEvent = parsed[0];
          }
        }
      } catch (e) {
        this.pendingBinaryEvent = null;
      }
      return;
    }

    // Binary data
    if (this.pendingBinaryEvent !== null && !msg.startsWith('42')) {
      const event = this.pendingBinaryEvent;
      this.pendingBinaryEvent = null;
      try {
        const jsonData = JSON.parse(msg);
        this.processEvent(event, jsonData);
      } catch (e) {}
      return;
    }

    // Standard event
    if (msg.startsWith('42')) {
      try {
        const json = JSON.parse(msg.substring(2));
        if (Array.isArray(json)) {
          const [event, data] = json;
          this.processEvent(event, data);
        }
      } catch (e) {}
    }
  }

  private processEvent(event: string, data: any): void {
    switch (event) {
      case 'updateStream':
        this.processTickData(data);
        break;
      case 'updateAssets':
        this.processAssetsUpdate(data);
        break;
      case 'successauth':
        this.subscribeAllAssets();
        break;
    }
  }

  private processTickData(data: any): void {
    if (!Array.isArray(data)) return;
    
    for (const item of data) {
      let assetId = '';
      let price = 0;
      let timestamp = Date.now();

      if (Array.isArray(item) && item.length >= 2) {
        assetId = String(item[0]);
        price = Number(item.length >= 3 ? item[2] : item[1]);
        timestamp = item.length >= 3 ? Number(item[1]) * 1000 : Date.now();
      } else if (item && typeof item === 'object') {
        assetId = String(item.asset || item.symbol || item.id || '');
        price = Number(item.price || item.close || 0);
      }

      if (!assetId || !price) continue;
      
      // Normalize asset ID
      const normalizedId = this.normalizeAssetId(assetId);
      if (!normalizedId) continue;

      const asset = this.assets.get(normalizedId);
      if (!asset) continue;

      // Calculate direction
      const direction = asset.ticks.length > 0
        ? (price > asset.ticks[asset.ticks.length - 1] ? 'UP' : price < asset.ticks[asset.ticks.length - 1] ? 'DOWN' : 'FLAT')
        : 'FLAT';

      // Store tick
      const tick: Tick = { assetId: normalizedId, price, timestamp, direction };
      asset.ticks.push(price);
      if (asset.ticks.length > 500) asset.ticks.shift();

      // Build candles
      this.updateCandles(asset, price, timestamp);

      // Calculate indicators
      this.updateIndicators(asset);

      // Check for signals periodically
      this.checkForSignal(asset);

      // Callback
      this.onTickCallback?.(tick);
    }
  }

  private normalizeAssetId(rawId: string): string | null {
    const normalized = rawId.replace(/^#/, '').toUpperCase();
    for (const assetId of this.assets.keys()) {
      const assetNorm = assetId.replace(/^#/, '').toUpperCase();
      if (normalized === assetNorm || normalized.includes(assetNorm) || assetNorm.includes(normalized)) {
        return assetId;
      }
    }
    return null;
  }

  private updateCandles(asset: AssetState, price: number, timestamp: number): void {
    const candleTime = Math.floor(timestamp / (this.config.candlePeriod * 1000)) * this.config.candlePeriod * 1000;
    
    let candle = asset.candles.find(c => c.openTime === candleTime);
    
    if (!candle) {
      candle = {
        assetId: asset.id,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1,
        openTime: candleTime,
        closeTime: candleTime + (this.config.candlePeriod * 1000) - 1
      };
      asset.candles.push(candle);
      if (asset.candles.length > 100) asset.candles.shift();
    } else {
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
      candle.volume++;
    }
  }

  private updateIndicators(asset: AssetState): void {
    if (asset.ticks.length < 10) return;

    const prices = asset.ticks;
    const highs = asset.candles.map(c => c.high);
    const lows = asset.candles.map(c => c.low);

    asset.indicators = IndicatorCalculator.calculateAll(prices, highs, lows, asset.candles);
  }

  private lastSignalCheck: Map<string, number> = new Map();

  private checkForSignal(asset: AssetState): void {
    if (!asset.indicators) return;
    
    const lastCheck = this.lastSignalCheck.get(asset.id) || 0;
    if (Date.now() - lastCheck < this.config.signalInterval * 1000) return;
    this.lastSignalCheck.set(asset.id, Date.now());

    const generator = new SignalGenerator(this.config);
    const price = asset.ticks[asset.ticks.length - 1];
    const signal = generator.generate(asset.indicators, price);
    signal.assetId = asset.id;

    // Only emit if signal is different from last or it's a new CALL/PUT
    const lastSignal = this.signals.get(asset.id);
    if (!lastSignal || lastSignal.direction !== signal.direction || signal.direction !== 'WAIT') {
      if (signal.direction !== 'WAIT') {
        this.signals.set(asset.id, signal);
        asset.lastSignal = signal;
        
        this.log(`[SIGNAL] ${asset.id}: ${signal.direction} (${signal.strength}%) @ ${price.toFixed(5)}`);
        this.log(`[SIGNAL] Reasons: ${signal.reasons.join(', ')}`);
        
        this.onSignalCallback?.(signal);
      }
    }
  }

  private processAssetsUpdate(data: any): void {
    if (!Array.isArray(data)) return;
    
    for (const item of data) {
      if (Array.isArray(item) && item.length >= 15) {
        const id = String(item[1]);
        const payout = Number(item[5]) / 100;
        const active = item[14] === true;
        
        const normalizedId = this.normalizeAssetId(id);
        if (normalizedId && this.assets.has(normalizedId)) {
          const asset = this.assets.get(normalizedId)!;
          asset.payout = payout;
          asset.active = active && payout >= 0.85;
        }
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    this.log(`[WS] Disconnected (${code}): ${reason}`);
    this.connected = false;
    this.onDisconnectCallback?.();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= 10) {
      this.log('[WS] Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(3000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
    this.log(`[WS] Reconnecting in ${Math.round(delay / 1000)}s...`);
    
    setTimeout(() => this.connect(), delay);
  }

  private subscribeAsset(assetId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(`42["changeSymbol",{"asset":"${assetId}","period":60}]`);
  }

  private subscribeAllAssets(): void {
    const activeAssets = Array.from(this.assets.values()).filter(a => a.active);
    this.log(`[WS] Subscribing to ${activeAssets.length} assets...`);
    
    activeAssets.forEach((asset, idx) => {
      setTimeout(() => this.subscribeAsset(asset.id), idx * 200);
    });
  }

  // ============================================
  // PUBLIC API
  // ============================================

  public disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getAssets(): AssetState[] {
    return Array.from(this.assets.values());
  }

  public getSignal(assetId: string): TradingSignal | null {
    return this.signals.get(assetId) || null;
  }

  public getAllSignals(): TradingSignal[] {
    return Array.from(this.signals.values()).filter(s => s.direction !== 'WAIT');
  }

  public getCandles(assetId: string): Candle[] {
    return this.assets.get(assetId)?.candles || [];
  }

  public getIndicators(assetId: string): TechnicalIndicators | null {
    return this.assets.get(assetId)?.indicators || null;
  }

  public getPrices(): Map<string, number> {
    const prices = new Map<string, number>();
    for (const [id, asset] of this.assets) {
      if (asset.ticks.length > 0) {
        prices.set(id, asset.ticks[asset.ticks.length - 1]);
      }
    }
    return prices;
  }

  // ============================================
  // TRADE MANAGEMENT
  // ============================================

  public placeTrade(assetId: string, direction: 'CALL' | 'PUT', stake: number = 1): Trade | null {
    const asset = this.assets.get(assetId);
    if (!asset || asset.ticks.length === 0) {
      this.log('[TRADE] Cannot place trade: invalid asset or no price data');
      return null;
    }

    const trade: Trade = {
      id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      assetId,
      direction,
      entryPrice: asset.ticks[asset.ticks.length - 1],
      entryTime: Date.now(),
      payout: asset.payout,
      stake,
      result: 'PENDING'
    };

    this.trades.push(trade);
    this.log(`[TRADE PLACED] ${direction} @ ${trade.entryPrice.toFixed(5)} | Stake: $${stake} | Payout: ${(payout * 100).toFixed(0)}%`);
    
    this.onTradeCallback?.(trade);
    return trade;
  }

  public closeTrade(tradeId: string, exitPrice: number): Trade | null {
    const trade = this.trades.find(t => t.id === tradeId);
    if (!trade) return null;

    trade.exitPrice = exitPrice;
    trade.exitTime = Date.now();
    
    // Determine result based on direction and price movement
    if (trade.direction === 'CALL') {
      trade.result = exitPrice > trade.entryPrice ? 'WIN' : 'LOSS';
    } else {
      trade.result = exitPrice < trade.entryPrice ? 'WIN' : 'LOSS';
    }

    this.log(`[TRADE CLOSED] ${trade.direction} | Entry: ${trade.entryPrice.toFixed(5)} | Exit: ${exitPrice.toFixed(5)} | Result: ${trade.result}`);
    
    if (this.config.saveResults) {
      this.saveResults();
    }
    
    return trade;
  }

  public getOpenTrades(): Trade[] {
    return this.trades.filter(t => t.result === 'PENDING');
  }

  public getTradeHistory(): Trade[] {
    return this.trades.filter(t => t.result !== 'PENDING');
  }

  public getPerformance(): { totalTrades: number; wins: number; losses: number; winRate: number; profit: number } {
    const closedTrades = this.trades.filter(t => t.result !== 'PENDING');
    const wins = closedTrades.filter(t => t.result === 'WIN').length;
    const losses = closedTrades.filter(t => t.result === 'LOSS').length;
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;
    
    // Calculate profit (simplified)
    let profit = 0;
    for (const trade of closedTrades) {
      if (trade.result === 'WIN') {
        profit += trade.stake * trade.payout;
      } else {
        profit -= trade.stake;
      }
    }

    return {
      totalTrades: closedTrades.length,
      wins,
      losses,
      winRate,
      profit
    };
  }

  private saveResults(): void {
    const results = {
      timestamp: new Date().toISOString(),
      performance: this.getPerformance(),
      signals: this.getAllSignals(),
      trades: this.trades
    };

    const filePath = `${this.config.outputDir}/results_${Date.now()}.json`;
    fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
    this.log(`[SAVE] Results saved to ${filePath}`);
  }

  // Event handlers
  public onSignal(callback: (signal: TradingSignal) => void): void {
    this.onSignalCallback = callback;
  }

  public onTrade(callback: (trade: Trade) => void): void {
    this.onTradeCallback = callback;
  }

  public onTick(callback: (tick: Tick) => void): void {
    this.onTickCallback = callback;
  }

  public onConnected(callback: () => void): void {
    this.onConnectCallback = callback;
  }

  public onDisconnected(callback: () => void): void {
    this.onDisconnectCallback = callback;
  }

  private log(msg: string): void {
    if (!this.config.verbose) return;
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
    console.log(`[${timestamp}] ${msg}`);
  }
}

// ============================================
// CLI INTERFACE
// ============================================

async function main() {
  console.log('\n===========================================');
  console.log('  Pocket Option Trading Bot v1.0');
  console.log('  Live Price • Technical Analysis • Signals');
  console.log('===========================================\n');

  const bot = new PocketOptionTradingBot({
    assets: ['EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc'],
    minConfidence: 65,
    verbose: true
  });

  // Event handlers
  bot.onConnected(() => {
    console.log('\n✅ Connected to Pocket Option!\n');
    console.log('Monitoring for trading signals...\n');
  });

  bot.onDisconnected(() => {
    console.log('\n⚠️ Disconnected from Pocket Option\n');
  });

  bot.onSignal((signal) => {
    console.log('\n===========================================');
    console.log(`🎯 SIGNAL: ${signal.direction} on ${signal.assetId}`);
    console.log(`   Entry: ${signal.entryPrice.toFixed(5)}`);
    console.log(`   Strength: ${signal.strength}%`);
    console.log('   Reasons:');
    signal.reasons.forEach(r => console.log(`   • ${r}`));
    console.log('===========================================\n');
  });

  bot.onTrade((trade) => {
    console.log(`\n💰 Trade opened: ${trade.direction} @ ${trade.entryPrice.toFixed(5)}\n`);
  });

  bot.onTick((tick) => {
    // Already logged by verbose mode
  });

  // Start connection
  await bot.connect();

  // Print status every 30 seconds
  setInterval(() => {
    if (bot.isConnected()) {
      const prices = bot.getPrices();
      const signals = bot.getAllSignals();
      const perf = bot.getPerformance();
      
      console.clear();
      console.log('\n===========================================');
      console.log('  Pocket Option Trading Bot - Status');
      console.log('===========================================');
      console.log('\n📊 Live Prices:');
      
      for (const [id, price] of prices) {
        const signal = bot.getSignal(id);
        const status = signal && signal.direction !== 'WAIT' 
          ? `${signal.direction} (${signal.strength}%)` 
          : 'WAITING';
        console.log(`   ${id.padEnd(15)} ${price.toFixed(5)}  ${status}`);
      }
      
      console.log(`\n📈 Performance: ${perf.wins}W / ${perf.losses}L (${perf.winRate.toFixed(1)}%)`);
      console.log(`💵 Profit: $${perf.profit.toFixed(2)}`);
      console.log(`📊 Total Trades: ${perf.totalTrades}`);
      
      if (signals.length > 0) {
        console.log('\n🎯 Active Signals:');
        signals.forEach(s => {
          console.log(`   ${s.assetId}: ${s.direction} @ ${s.entryPrice.toFixed(5)}`);
        });
      }
      
      console.log('\n===========================================\n');
    }
  }, 30000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    
    const perf = bot.getPerformance();
    console.log('\n===========================================');
    console.log('  Final Performance Report');
    console.log('===========================================');
    console.log(`  Total Trades: ${perf.totalTrades}`);
    console.log(`  Wins: ${perf.wins}`);
    console.log(`  Losses: ${perf.losses}`);
    console.log(`  Win Rate: ${perf.winRate.toFixed(1)}%`);
    console.log(`  Profit/Loss: $${perf.profit.toFixed(2)}`);
    console.log('===========================================\n');
    
    bot.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
