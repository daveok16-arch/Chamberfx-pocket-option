/**
 * Pocket Option Candle-Aware Signal Bot v1.0
 * 
 * Built for Pocket Option OTC which operates on CANDLESTICK EXPIRATION:
 * - Trades expire at specific candle close times
 * - Signal accuracy depends on TIMING, not just direction
 * - Must predict NEXT candle direction, not current movement
 */

import { WebSocket } from "ws";
import { chromium } from "playwright";
import * as fs from "fs";

// ============================================
// CANDLE EXPIRATION CONFIG
// ============================================

const CANDLE_PERIODS = {
  M1: 60,      // 1 minute candle
  M5: 300,     // 5 minute candle
  M15: 900,    // 15 minute candle
};

interface ExpiryConfig {
  period: number;      // Candle period in seconds
  tradeDuration: number; // Trade expiry in seconds
  entryBuffer: number;   // Seconds before candle close to enter
}

const DEFAULT_EXPIRY: ExpiryConfig = {
  period: CANDLE_PERIODS.M1,
  tradeDuration: 60,
  entryBuffer: 5,  // Enter 5 seconds before candle close
};

// ============================================
// TYPES
// ============================================

interface Tick {
  assetId: string;
  price: number;
  timestamp: number;
  direction: 'UP' | 'DOWN' | 'FLAT';
}

interface Candle {
  assetId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
  closeTime: number;
  isComplete: boolean;
}

interface CandlePattern {
  type: 'DOJI' | 'HAMMER' | 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING' | 
        'MORNING_STAR' | 'EVENING_STAR' | 'INSIDE_BAR' | 'PIN_BAR' | 'NONE';
  bullish: boolean;
  strength: number; // 0-100
  description: string;
}

interface CandleAnalysis {
  patterns: CandlePattern[];
  momentum: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
  trend: 'UP' | 'DOWN' | 'SIDEWAYS';
  strength: number; // 0-100
  recommendedDirection: 'CALL' | 'PUT' | 'WAIT';
  confidence: number;
  reasons: string[];
  timeRemaining: number; // Seconds until candle close
  entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
}

interface TradingSignal {
  assetId: string;
  direction: 'CALL' | 'PUT' | 'WAIT';
  entryPrice: number;
  targetExpiry: number;      // Unix timestamp when trade should expire
  confidence: number;        // 0-100
  timeRemaining: number;     // Seconds until candle close
  entryQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  analysis: CandleAnalysis;
  timestamp: number;
  candles: Candle[];         // Recent candles for reference
}

interface Trade {
  id: string;
  assetId: string;
  direction: 'CALL' | 'PUT';
  entryPrice: number;
  entryTime: number;
  expiryTime: number;
  result?: 'WIN' | 'LOSS' | 'PENDING' | 'EXPIRED';
  actualClose?: number;
  expectedClose?: number;
  patterns?: string[];
  confidence?: number;
}

// ============================================
// CANDLE PATTERN RECOGNITION
// ============================================

class CandlePatternRecognizer {
  
  // Identify single candle patterns
  static identifySingleCandle(candle: Candle): CandlePattern {
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    
    if (range === 0) {
      return { type: 'DOJI', bullish: false, strength: 50, description: 'Doji - indecision' };
    }
    
    const bodyRatio = body / range;
    const upperWickRatio = upperWick / range;
    const lowerWickRatio = lowerWick / range;
    
    const isBullish = candle.close > candle.open;
    
    // Doji - very small body
    if (bodyRatio < 0.1) {
      return { type: 'DOJI', bullish: false, strength: 60, description: 'Doji - market indecision' };
    }
    
    // Hammer - small body, long lower wick
    if (lowerWickRatio > 0.6 && bodyRatio < 0.3) {
      return { 
        type: 'HAMMER', 
        bullish: true, 
        strength: 75, 
        description: 'Hammer - potential bullish reversal' 
      };
    }
    
    // Inverted Hammer
    if (upperWickRatio > 0.6 && bodyRatio < 0.3) {
      return { 
        type: 'PIN_BAR', 
        bullish: false, 
        strength: 70, 
        description: 'Shooting Star - potential bearish reversal' 
      };
    }
    
    // Marubozu - strong directional candle
    if (bodyRatio > 0.85) {
      return { 
        type: 'NONE', 
        bullish: isBullish, 
        strength: isBullish ? 85 : 85, 
        description: isBullish ? 'Bullish Marubozu - strong buying' : 'Bearish Marubozu - strong selling' 
      };
    }
    
    return { type: 'NONE', bullish: isBullish, strength: 50, description: 'Normal candle' };
  }
  
  // Identify two-candle patterns (Engulfing)
  static identifyEngulfing(candle1: Candle, candle2: Candle): CandlePattern | null {
    const isBullishEngulfing = 
      candle1.close < candle1.open &&  // First candle is bearish
      candle2.close > candle2.open &&   // Second candle is bullish
      candle2.open < candle1.close &&   // Second opens below first close
      candle2.close > candle1.open;     // Second closes above first open
    
    if (isBullishEngulfing) {
      return { 
        type: 'BULLISH_ENGULFING', 
        bullish: true, 
        strength: 80, 
        description: 'Bullish Engulfing - strong reversal pattern' 
      };
    }
    
    const isBearishEngulfing = 
      candle1.close > candle1.open &&  // First candle is bullish
      candle2.close < candle2.open &&   // Second candle is bearish
      candle2.open > candle1.close &&   // Second opens above first close
      candle2.close < candle1.open;     // Second closes below first open
    
    if (isBearishEngulfing) {
      return { 
        type: 'BEARISH_ENGULFING', 
        bullish: false, 
        strength: 80, 
        description: 'Bearish Engulfing - strong reversal pattern' 
      };
    }
    
    return null;
  }
  
  // Analyze momentum based on candle bodies and wicks
  static analyzeMomentum(candles: Candle[]): CandleAnalysis['momentum'] {
    if (candles.length < 5) return 'NEUTRAL';
    
    const recent = candles.slice(-5);
    let bullScore = 0;
    let bearScore = 0;
    
    for (const candle of recent) {
      const body = candle.close - candle.open;
      if (body > 0) bullScore += Math.abs(body);
      else bearScore += Math.abs(body);
    }
    
    const ratio = bullScore / (bullScore + bearScore);
    
    if (ratio > 0.75) return 'STRONG_BULL';
    if (ratio > 0.55) return 'BULL';
    if (ratio < 0.25) return 'STRONG_BEAR';
    if (ratio < 0.45) return 'BEAR';
    return 'NEUTRAL';
  }
  
  // Analyze trend using EMA crossover on candle closes
  static analyzeTrend(candles: Candle[]): { trend: CandleAnalysis['trend'], strength: number } {
    if (candles.length < 20) return { trend: 'SIDEWAYS', strength: 50 };
    
    const closes = candles.map(c => c.close);
    const ema9 = this.calcEMA(closes, 9);
    const ema21 = this.calcEMA(closes, 21);
    const ema50 = this.calcEMA(closes, Math.min(50, closes.length));
    
    if (ema9 > ema21 && ema21 > ema50) {
      return { trend: 'UP', strength: Math.min(100, ((ema9 - ema50) / ema50) * 10000) };
    }
    if (ema9 < ema21 && ema21 < ema50) {
      return { trend: 'DOWN', strength: Math.min(100, ((ema50 - ema9) / ema50) * 10000) };
    }
    return { trend: 'SIDEWAYS', strength: 50 };
  }
  
  static calcEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }
}

// ============================================
// CANDLE-AWARE SIGNAL GENERATOR
// ============================================

class CandleAwareSignalGenerator {
  private config: ExpiryConfig;
  
  constructor(config: Partial<ExpiryConfig> = {}) {
    this.config = { ...DEFAULT_EXPIRY, ...config };
  }
  
  generate(candles: Candle[], currentPrice: number, currentTime: number): CandleAnalysis {
    const reasons: string[] = [];
    let bullishScore = 0;
    let bearishScore = 0;
    
    // Calculate time remaining in current candle
    const timeRemaining = this.getTimeRemaining(currentTime);
    const candleProgress = 1 - (timeRemaining / this.config.period);
    
    // Determine entry quality based on time remaining
    let entryQuality: CandleAnalysis['entryQuality'] = 'POOR';
    if (timeRemaining >= 50) entryQuality = 'EXCELLENT';
    else if (timeRemaining >= 40) entryQuality = 'GOOD';
    else if (timeRemaining >= 20) entryQuality = 'FAIR';
    
    // Skip analysis if candle is almost complete
    if (timeRemaining < 10) {
      return {
        patterns: [],
        momentum: 'NEUTRAL',
        trend: 'SIDEWAYS',
        strength: 0,
        recommendedDirection: 'WAIT',
        confidence: 0,
        reasons: ['Candle closing - wait for new candle'],
        timeRemaining,
        entryQuality
      };
    }
    
    // ===== PATTERN ANALYSIS =====
    if (candles.length >= 2) {
      const lastCandle = candles[candles.length - 1];
      const prevCandle = candles[candles.length - 2];
      
      // Single candle patterns
      const singlePattern = CandlePatternRecognizer.identifySingleCandle(lastCandle);
      if (singlePattern.type !== 'NONE') {
        reasons.push(singlePattern.description);
        if (singlePattern.bullish) bullishScore += singlePattern.strength;
        else bearishScore += singlePattern.strength;
      }
      
      // Engulfing patterns
      const engulfing = CandlePatternRecognizer.identifyEngulfing(prevCandle, lastCandle);
      if (engulfing) {
        reasons.push(engulfing.description);
        if (engulfing.bullish) bullishScore += engulfing.strength;
        else bearishScore += engulfing.strength;
      }
    }
    
    // ===== MOMENTUM ANALYSIS =====
    const momentum = CandlePatternRecognizer.analyzeMomentum(candles);
    switch (momentum) {
      case 'STRONG_BULL':
        bullishScore += 30;
        reasons.push('Strong bullish momentum');
        break;
      case 'BULL':
        bullishScore += 15;
        reasons.push('Bullish momentum');
        break;
      case 'STRONG_BEAR':
        bearishScore += 30;
        reasons.push('Strong bearish momentum');
        break;
      case 'BEAR':
        bearishScore += 15;
        reasons.push('Bearish momentum');
        break;
    }
    
    // ===== TREND ANALYSIS =====
    const { trend, strength: trendStrength } = CandlePatternRecognizer.analyzeTrend(candles);
    switch (trend) {
      case 'UP':
        bullishScore += 25;
        reasons.push(`Uptrend confirmed (strength: ${trendStrength.toFixed(0)}%)`);
        break;
      case 'DOWN':
        bearishScore += 25;
        reasons.push(`Downtrend confirmed (strength: ${trendStrength.toFixed(0)}%)`);
        break;
      case 'SIDEWAYS':
        reasons.push('Sideways market - caution');
    }
    
    // ===== PRICE ACTION ANALYSIS =====
    if (candles.length >= 3) {
      const recent = candles.slice(-3);
      const avgBody = recent.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 3;
      const currentBody = Math.abs(currentPrice - recent[recent.length - 1].open);
      
      // Is current price extending beyond recent range?
      if (currentPrice > recent[recent.length - 1].high) {
        bearishScore += 10;
        reasons.push('Price extended above recent high - reversal risk');
      } else if (currentPrice < recent[recent.length - 1].low) {
        bullishScore += 10;
        reasons.push('Price extended below recent low - reversal risk');
      }
      
      // Check for exhaustion (large candle followed by small)
      const lastBody = Math.abs(lastCandle.close - lastCandle.open);
      if (lastBody > avgBody * 2) {
        reasons.push('Large candle - possible exhaustion');
        // If last candle was large, expect reversal
        if (lastCandle.close > lastCandle.open) {
          bearishScore += 15; // Bullish exhaustion -> expect pullback
          reasons.push('Bullish exhaustion detected');
        } else {
          bullishScore += 15; // Bearish exhaustion -> expect bounce
          reasons.push('Bearish exhaustion detected');
        }
      }
    }
    
    // ===== RSI ANALYSIS =====
    const closes = candles.map(c => c.close);
    const rsi = this.calcRSI(closes);
    if (rsi < 30) {
      bullishScore += 20;
      reasons.push(`RSI oversold (${rsi.toFixed(1)}) - bounce likely`);
    } else if (rsi > 70) {
      bearishScore += 20;
      reasons.push(`RSI overbought (${rsi.toFixed(1)}) - pullback likely`);
    }
    
    // ===== SUPPORT/RESISTANCE =====
    const { support, resistance } = this.calcSupportResistance(candles);
    const distToSupport = (currentPrice - support) / currentPrice;
    const distToResistance = (resistance - currentPrice) / currentPrice;
    
    if (distToSupport < 0.002) {
      bullishScore += 25;
      reasons.push('Near support - bounce expected');
    }
    if (distToResistance < 0.002) {
      bearishScore += 25;
      reasons.push('Near resistance - rejection expected');
    }
    
    // ===== FINAL SIGNAL CALCULATION =====
    const totalScore = bullishScore + bearishScore;
    let confidence = 0;
    let recommendedDirection: CandleAnalysis['recommendedDirection'] = 'WAIT';
    
    if (totalScore > 0) {
      const directionRatio = Math.abs(bullishScore - bearishScore) / totalScore;
      confidence = Math.min(100, directionRatio * 100 + Math.min(bullishScore, bearishScore) / 2);
      
      if (bullishScore > bearishScore + 20) {
        recommendedDirection = 'CALL';
      } else if (bearishScore > bullishScore + 20) {
        recommendedDirection = 'PUT';
      }
    }
    
    // Entry quality affects confidence
    if (entryQuality === 'EXCELLENT' || entryQuality === 'GOOD') {
      confidence = Math.min(100, confidence * 1.1);
    } else {
      confidence = confidence * 0.7;
      recommendedDirection = 'WAIT'; // Don't trade in poor entry quality
      reasons.push('Entry quality too low - skipping signal');
    }
    
    return {
      patterns: [CandlePatternRecognizer.identifySingleCandle(candles[candles.length - 1])],
      momentum,
      trend,
      strength: confidence,
      recommendedDirection,
      confidence: Math.round(confidence),
      reasons,
      timeRemaining,
      entryQuality
    };
  }
  
  private calcRSI(prices: number[], period: number = 14): number {
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
    return 100 - (100 / (1 + avgGain / avgLoss));
  }
  
  private calcSupportResistance(candles: Candle[]): { support: number; resistance: number } {
    if (candles.length < 10) {
      const lastClose = candles[candles.length - 1]?.close || 1;
      return { support: lastClose * 0.998, resistance: lastClose * 1.002 };
    }
    const recent = candles.slice(-20);
    return {
      support: Math.min(...recent.map(c => c.low)),
      resistance: Math.max(...recent.map(c => c.high))
    };
  }
  
  getTimeRemaining(currentTime: number): number {
    const candleStart = Math.floor(currentTime / 1000 / this.config.period) * this.config.period;
    const candleEnd = candleStart + this.config.period;
    return candleEnd - Math.floor(currentTime / 1000);
  }
  
  getNextExpiryTime(currentTime: number): number {
    const now = Math.floor(currentTime / 1000);
    const nextCandleStart = Math.ceil(now / this.config.period) * this.config.period;
    return nextCandleStart + this.config.tradeDuration;
  }
}

// ============================================
// MAIN TRADING BOT
// ============================================

export class CandleAwareTradingBot {
  private ws: WebSocket | null = null;
  private candles: Map<string, Candle[]> = new Map();
  private currentPrices: Map<string, number> = new Map();
  private signals: Map<string, TradingSignal> = new Map();
  private trades: Trade[] = [];
  private expiryConfig: ExpiryConfig;
  private connected: boolean = false;
  private pendingBinaryEvent: string | null = null;
  private reconnectAttempts: number = 0;
  private discoveredWsUrl: string = '';
  private cachedAuthPacket: string = '';
  private assets: string[] = ['EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc'];
  
  private signalGenerator: CandleAwareSignalGenerator;
  private lastSignalTime: Map<string, number> = new Map();
  
  // Callbacks
  private onSignal?: (signal: TradingSignal) => void;
  private onCandle?: (candle: Candle) => void;
  private onTrade?: (trade: Trade) => void;
  
  constructor(config: Partial<ExpiryConfig> = {}) {
    this.expiryConfig = { ...DEFAULT_EXPIRY, ...config };
    this.signalGenerator = new CandleAwareSignalGenerator(this.expiryConfig);
    
    for (const asset of this.assets) {
      this.candles.set(asset, []);
    }
  }
  
  // ============================================
  // SESSION DISCOVERY
  // ============================================
  
  private async discoverSession(): Promise<{ url: string; authPacket: string }> {
    console.log('[DISCOVERY] Launching headless browser...');
    
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    } catch {
      console.log('[DISCOVERY] Installing Chromium...');
      const { execSync } = await import('child_process');
      execSync('npx playwright install chromium', { stdio: 'inherit' });
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
    
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      let capturedWsUrl = '';
      let capturedAuthPacket = '';
      
      page.on('websocket', (ws) => {
        if (ws.url().includes('socket.io') && ws.url().includes('po.market')) {
          capturedWsUrl = ws.url();
          ws.on('framesent', (frame) => {
            const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
            if (payload.includes('"auth"')) capturedAuthPacket = payload;
          });
        }
      });
      
      try {
        await page.goto('https://po.trade/en/cabinet/try-demo/', { 
          waitUntil: 'domcontentloaded', 
          timeout: 20000 
        });
        await page.waitForTimeout(8000);
      } catch {}
      
      await browser.close();
      return { url: capturedWsUrl, authPacket: capturedAuthPacket };
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
      console.log('[DISCOVERY] Discovering session...');
      const session = await this.discoverSession();
      this.discoveredWsUrl = session.url;
      this.cachedAuthPacket = session.authPacket;
      
      console.log(`[WS] Connecting to: ${this.discoveredWsUrl}`);
      
      this.ws = new WebSocket(this.discoveredWsUrl);
      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('error', (err) => console.log(`[WS ERROR] ${err.message}`));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason?.toString()));
    } catch (err) {
      console.log(`[ERROR] ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }
  
  private handleOpen(): void {
    console.log('[WS] Connection opened');
    this.connected = true;
    this.reconnectAttempts = 0;
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

    // Namespace join - this is when we consider ourselves authenticated
    if (msg.startsWith('40')) {
      console.log('[WS] Authenticated');
      if (this.cachedAuthPacket) {
        this.ws?.send(this.cachedAuthPacket);
        setTimeout(() => this.subscribeAll(), 2000);
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

    // Standard event (42)["eventName",data]
    if (msg.startsWith('42')) {
      try {
        const json = JSON.parse(msg.substring(2));
        if (Array.isArray(json)) {
          this.processEvent(json[0], json[1]);
        }
      } catch {}
      return;
    }
  }
  
  private processEvent(event: string, data: any): void {
    if (event === 'updateStream') {
      this.processTickData(data);
    }
  }
  
  private processTickData(data: any): void {
    if (!Array.isArray(data)) return;
    
    const now = Date.now();
    
    for (const item of data) {
      if (!Array.isArray(item) || item.length < 2) continue;
      
      const assetId = String(item[0]).replace('#', '');
      if (!this.assets.some(a => a.replace('_otc', '').includes(assetId.replace('_otc', '')))) continue;
      
      const price = Number(item.length >= 3 ? item[2] : item[1]);
      const timestamp = item.length >= 3 ? Number(item[1]) * 1000 : now;
      
      this.currentPrices.set(assetId, price);
      this.updateCandle(assetId, price, timestamp);
      
      // Check for signals every 3 seconds
      if (this.shouldCheckSignal(assetId)) {
        this.checkForSignal(assetId);
      }
    }
  }
  
  private updateCandle(assetId: string, price: number, timestamp: number): void {
    const candles = this.candles.get(assetId) || [];
    const candlePeriod = this.expiryConfig.period * 1000;
    const candleTime = Math.floor(timestamp / candlePeriod) * candlePeriod;
    
    let candle = candles.find(c => c.openTime === candleTime);
    
    if (!candle) {
      // New candle starting
      if (candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        if (!lastCandle.isComplete) {
          lastCandle.isComplete = true;
          this.onCandle?.(lastCandle);
        }
      }
      
      candle = {
        assetId,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1,
        openTime: candleTime,
        closeTime: candleTime + candlePeriod - 1,
        isComplete: false
      };
      candles.push(candle);
      
      if (candles.length > 100) candles.shift();
      this.candles.set(assetId, candles);
    } else {
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
      candle.volume++;
    }
  }
  
  private shouldCheckSignal(assetId: string): boolean {
    const lastCheck = this.lastSignalTime.get(assetId) || 0;
    return Date.now() - lastCheck > 3000;
  }
  
  private checkForSignal(assetId: string): void {
    this.lastSignalTime.set(assetId, Date.now());
    
    const candles = this.candles.get(assetId) || [];
    const currentPrice = this.currentPrices.get(assetId);
    
    if (candles.length < 5 || !currentPrice) return;
    
    const analysis = this.signalGenerator.generate(candles, currentPrice, Date.now());
    
    // Only generate signal if we have a clear direction and good entry quality
    if (analysis.recommendedDirection !== 'WAIT' && analysis.confidence >= 60) {
      const existingSignal = this.signals.get(assetId);
      
      // Don't repeat same signal
      if (existingSignal && 
          existingSignal.direction === analysis.recommendedDirection && 
          Date.now() - existingSignal.timestamp < 30000) {
        return;
      }
      
      const signal: TradingSignal = {
        assetId,
        direction: analysis.recommendedDirection,
        entryPrice: currentPrice,
        targetExpiry: this.signalGenerator.getNextExpiryTime(Date.now()),
        confidence: analysis.confidence,
        timeRemaining: analysis.timeRemaining,
        entryQuality: analysis.entryQuality,
        analysis,
        timestamp: Date.now(),
        candles: candles.slice(-3)
      };
      
      this.signals.set(assetId, signal);
      this.onSignal?.(signal);
      
      console.log('\n' + '='.repeat(60));
      console.log(`🎯 CANDLE SIGNAL: ${signal.direction} on ${assetId}`);
      console.log(`   Entry Price: ${signal.entryPrice.toFixed(5)}`);
      console.log(`   Confidence: ${signal.confidence}%`);
      console.log(`   Entry Quality: ${signal.entryQuality}`);
      console.log(`   Time Remaining: ${signal.timeRemaining}s`);
      console.log(`   Target Expiry: ${new Date(signal.targetExpiry * 1000).toISOString()}`);
      console.log('   Analysis:');
      analysis.reasons.forEach(r => console.log(`   • ${r}`));
      console.log('='.repeat(60) + '\n');
    }
  }
  
  private handleClose(code: number = 0, reason: string = ''): void {
    console.log(`[WS] Disconnected (code: ${code}, reason: ${reason})`);
    this.connected = false;
    
    // If we got disconnected right after auth, try with longer delay
    if (code === 1000 || code === 1005) {
      this.reconnectAttempts++;
      const delay = 5000 + Math.random() * 5000;
      console.log(`[WS] Reconnecting in ${Math.round(delay / 1000)}s...`);
      setTimeout(() => this.connect(), delay);
    } else {
      this.scheduleReconnect();
    }
  }
  
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= 10) {
      console.log('[WS] Max reconnection attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
    console.log(`[WS] Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${this.reconnectAttempts})`);
    // Clear old auth packet so we get fresh session
    this.cachedAuthPacket = '';
    setTimeout(() => this.connect(), delay);
  }
  
  private subscribeAll(): void {
    console.log('[WS] Subscribing to assets...');
    for (let i = 0; i < this.assets.length; i++) {
      setTimeout(() => {
        this.ws?.send(`42["changeSymbol",{"asset":"${this.assets[i]}","period":${this.expiryConfig.period}}]`);
      }, i * 200);
    }
  }
  
  // ============================================
  // PUBLIC API
  // ============================================
  
  public disconnect(): void {
    this.ws?.close();
  }
  
  public getSignal(assetId: string): TradingSignal | null {
    return this.signals.get(assetId) || null;
  }
  
  public getAllSignals(): TradingSignal[] {
    return Array.from(this.signals.values()).filter(s => s.direction !== 'WAIT');
  }
  
  public getCandles(assetId: string): Candle[] {
    return this.candles.get(assetId) || [];
  }
  
  public placeTrade(signal: TradingSignal, stake: number = 1): Trade {
    const trade: Trade = {
      id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      assetId: signal.assetId,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      entryTime: Date.now(),
      expiryTime: signal.targetExpiry * 1000,
      result: 'PENDING',
      patterns: signal.analysis.patterns.map(p => p.type),
      confidence: signal.confidence
    };
    
    this.trades.push(trade);
    this.onTrade?.(trade);
    
    console.log(`\n💰 TRADE PLACED:`);
    console.log(`   ID: ${trade.id}`);
    console.log(`   Direction: ${trade.direction}`);
    console.log(`   Entry: ${trade.entryPrice.toFixed(5)}`);
    console.log(`   Expiry: ${new Date(trade.expiryTime).toISOString()}`);
    console.log(`   Stake: $${stake}\n`);
    
    return trade;
  }
  
  public resolveTrade(tradeId: string, resultPrice: number): Trade | null {
    const trade = this.trades.find(t => t.id === tradeId);
    if (!trade) return null;
    
    trade.actualClose = resultPrice;
    trade.expectedClose = trade.direction === 'CALL' 
      ? trade.entryPrice + 0.0001 
      : trade.entryPrice - 0.0001;
    
    trade.result = resultPrice === trade.expectedClose 
      ? 'WIN' 
      : resultPrice > trade.entryPrice ? 'WIN' : 'LOSS';
    
    console.log(`\n📊 TRADE RESULT: ${trade.result}`);
    console.log(`   Entry: ${trade.entryPrice.toFixed(5)}`);
    console.log(`   Close: ${resultPrice.toFixed(5)}`);
    console.log(`   Direction: ${trade.direction}\n`);
    
    return trade;
  }
  
  public getPerformance(): { total: number; wins: number; losses: number; winRate: number } {
    const closed = this.trades.filter(t => t.result !== 'PENDING');
    const wins = closed.filter(t => t.result === 'WIN').length;
    return {
      total: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0
    };
  }
  
  public onSignalCallback(callback: (signal: TradingSignal) => void): void {
    this.onSignal = callback;
  }
  
  public onCandleCallback(callback: (candle: Candle) => void): void {
    this.onCandle = callback;
  }
  
  public onTradeCallback(callback: (trade: Trade) => void): void {
    this.onTrade = callback;
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  Pocket Option Candle-Aware Signal Bot v1.0');
  console.log('  Built for Candlestick Expiration Trading');
  console.log('='.repeat(60) + '\n');
  
  const bot = new CandleAwareTradingBot({
    period: CANDLE_PERIODS.M1,
    tradeDuration: 60,
    entryBuffer: 5
  });
  
  bot.onSignalCallback((signal) => {
    // Auto-place trade with $1 stake (for demo)
    if (signal.confidence >= 70 && signal.entryQuality !== 'POOR') {
      bot.placeTrade(signal, 1);
    }
  });
  
  bot.onTradeCallback((trade) => {
    // Simulate trade result after expiry (for demo purposes)
    setTimeout(() => {
      const candles = bot.getCandles(trade.assetId);
      if (candles.length > 0) {
        const closePrice = candles[candles.length - 1].close;
        bot.resolveTrade(trade.id, closePrice);
        
        const perf = bot.getPerformance();
        console.log(`📈 Performance: ${perf.wins}W / ${perf.losses}L (${perf.winRate.toFixed(1)}%)`);
      }
    }, 65000); // Resolve 65 seconds after entry
  });
  
  await bot.connect();
  
  // Status display
  setInterval(() => {
    if (bot.getAllSignals().length > 0) {
      console.log('\n--- Active Signals ---');
      bot.getAllSignals().forEach(s => {
        console.log(`${s.assetId}: ${s.direction} (${s.confidence}%) - ${s.entryQuality} entry`);
      });
    }
  }, 10000);
  
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    const perf = bot.getPerformance();
    console.log(`\nFinal Performance: ${perf.wins}W / ${perf.losses}L (${perf.winRate.toFixed(1)}%)`);
    bot.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
