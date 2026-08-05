/**
 * Pocket Option Trading Bot with Telegram Notifications
 * 
 * Features:
 * - Live price capture from Pocket Option OTC
 * - Candle-aware signal generation
 * - Telegram alerts for signals, trades, and results
 */

import { WebSocket } from "ws";
import { chromium } from "playwright";
import { telegram } from "./telegram.js";

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  assets: ['EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc'],
  candlePeriod: 60,      // 1 minute candles
  tradeDuration: 60,     // 1 minute trades
  minConfidence: 65,     // Minimum signal confidence
  entryBuffer: 5,       // Seconds before candle close
};

// ============================================
// TYPES
// ============================================

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
  isComplete: boolean;
}

interface Trade {
  id: string;
  assetId: string;
  direction: 'CALL' | 'PUT';
  entryPrice: number;
  entryTime: number;
  expiryTime: number;
  result?: 'WIN' | 'LOSS' | 'PENDING';
}

interface Signal {
  assetId: string;
  direction: 'CALL' | 'PUT' | 'WAIT';
  entryPrice: number;
  confidence: number;
  timeRemaining: number;
  entryQuality: string;
  reasons: string[];
  timestamp: number;
}

// ============================================
// CANDLE ANALYSIS
// ============================================

function analyzeCandle(candles: Candle[], currentPrice: number, timeRemaining: number): Signal {
  const reasons: string[] = [];
  let bullishScore = 0;
  let bearishScore = 0;
  
  // Entry quality
  let entryQuality = 'POOR';
  if (timeRemaining >= 50) entryQuality = 'EXCELLENT';
  else if (timeRemaining >= 40) entryQuality = 'GOOD';
  else if (timeRemaining >= 20) entryQuality = 'FAIR';
  
  // Skip if candle closing soon
  if (timeRemaining < 10) {
    return { assetId: '', direction: 'WAIT', entryPrice: currentPrice, confidence: 0, timeRemaining, entryQuality, reasons: ['Candle closing'], timestamp: Date.now() };
  }
  
  if (candles.length < 3) {
    return { assetId: '', direction: 'WAIT', entryPrice: currentPrice, confidence: 0, timeRemaining, entryQuality, reasons: ['Collecting data...'], timestamp: Date.now() };
  }
  
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];
  
  // === PATTERN DETECTION ===
  
  // Single candle patterns
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  const bodyRatio = range > 0 ? body / range : 0;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const lowerWickRatio = range > 0 ? lowerWick / range : 0;
  const upperWick = last.high - Math.max(last.open, last.close);
  const upperWickRatio = range > 0 ? upperWick / range : 0;
  
  // Hammer (bullish reversal)
  if (lowerWickRatio > 0.6 && bodyRatio < 0.3) {
    bullishScore += 25;
    reasons.push('Hammer pattern detected');
  }
  
  // Shooting star (bearish reversal)
  if (upperWickRatio > 0.6 && bodyRatio < 0.3) {
    bearishScore += 25;
    reasons.push('Shooting star pattern');
  }
  
  // Marubozu (strong directional)
  if (bodyRatio > 0.85) {
    if (last.close > last.open) {
      bullishScore += 20;
      reasons.push('Bullish Marubozu');
    } else {
      bearishScore += 20;
      reasons.push('Bearish Marubozu');
    }
  }
  
  // Doji (indecision)
  if (bodyRatio < 0.1) {
    reasons.push('Doji - market indecision');
  }
  
  // === ENGULFING PATTERNS ===
  
  // Bullish Engulfing
  if (prev.close < prev.open && last.close > last.open) {
    if (last.open < prev.close && last.close > prev.open) {
      bullishScore += 30;
      reasons.push('Bullish Engulfing pattern');
    }
  }
  
  // Bearish Engulfing
  if (prev.close > prev.open && last.close < last.open) {
    if (last.open > prev.close && last.close < prev.open) {
      bearishScore += 30;
      reasons.push('Bearish Engulfing pattern');
    }
  }
  
  // === MOMENTUM ANALYSIS ===
  
  const recentBodies = candles.slice(-5).map(c => Math.abs(c.close - c.open));
  const avgBody = recentBodies.reduce((a, b) => a + b, 0) / recentBodies.length;
  const currentBody = Math.abs(currentPrice - last.open);
  
  // Strong momentum
  if (last.close > last.open && recentBodies[recentBodies.length - 1] > avgBody * 1.5) {
    bullishScore += 15;
    reasons.push('Strong bullish momentum');
  }
  if (last.close < last.open && recentBodies[recentBodies.length - 1] > avgBody * 1.5) {
    bearishScore += 15;
    reasons.push('Strong bearish momentum');
  }
  
  // === TREND ANALYSIS (EMA) ===
  
  const closes = candles.map(c => c.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  
  if (ema9 > ema21) {
    bullishScore += 15;
    reasons.push('EMA bullish crossover');
  } else {
    bearishScore += 15;
    reasons.push('EMA bearish crossover');
  }
  
  // Price above/below EMAs
  if (currentPrice > ema9) {
    bullishScore += 5;
  } else {
    bearishScore += 5;
  }
  
  // === RSI ===
  
  const rsi = calcRSI(closes);
  if (rsi < 30) {
    bullishScore += 20;
    reasons.push(`RSI oversold (${rsi.toFixed(1)})`);
  } else if (rsi > 70) {
    bearishScore += 20;
    reasons.push(`RSI overbought (${rsi.toFixed(1)})`);
  }
  
  // === SUPPORT/RESISTANCE ===
  
  const recent = candles.slice(-10);
  const support = Math.min(...recent.map(c => c.low));
  const resistance = Math.max(...recent.map(c => c.high));
  const distToSupport = (currentPrice - support) / currentPrice;
  const distToResistance = (resistance - currentPrice) / currentPrice;
  
  if (distToSupport < 0.001) {
    bullishScore += 20;
    reasons.push('Near support level');
  }
  if (distToResistance < 0.001) {
    bearishScore += 20;
    reasons.push('Near resistance level');
  }
  
  // === EXHAUSTION CHECK ===
  
  if (last.close > prev.close && last.close > prev2.close) {
    // Potential bullish exhaustion
    const priceGain = last.close - prev2.close;
    if (priceGain / prev2.close > 0.003) {
      bearishScore += 15;
      reasons.push('Bullish exhaustion detected');
    }
  }
  if (last.close < prev.close && last.close < prev2.close) {
    // Potential bearish exhaustion
    const priceDrop = prev2.close - last.close;
    if (priceDrop / prev2.close > 0.003) {
      bullishScore += 15;
      reasons.push('Bearish exhaustion detected');
    }
  }
  
  // === FINAL SIGNAL ===
  
  const total = bullishScore + bearishScore;
  let confidence = 0;
  let direction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
  
  if (total > 0) {
    const ratio = Math.abs(bullishScore - bearishScore) / total;
    confidence = Math.min(100, Math.round(ratio * 100 + Math.min(bullishScore, bearishScore) / 2));
    
    if (bullishScore > bearishScore + 15 && confidence >= CONFIG.minConfidence) {
      direction = 'CALL';
    } else if (bearishScore > bullishScore + 15 && confidence >= CONFIG.minConfidence) {
      direction = 'PUT';
    }
  }
  
  // Adjust confidence based on entry quality
  if (entryQuality === 'POOR') {
    confidence = Math.round(confidence * 0.5);
    direction = 'WAIT';
  } else if (entryQuality === 'FAIR') {
    confidence = Math.round(confidence * 0.8);
  }
  
  return {
    assetId: '',
    direction,
    entryPrice: currentPrice,
    confidence,
    timeRemaining,
    entryQuality,
    reasons,
    timestamp: Date.now()
  };
}

function calcEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(prices: number[], period: number = 14): number {
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

// ============================================
// MAIN BOT CLASS
// ============================================

class TradingBot {
  private ws: WebSocket | null = null;
  private candles: Map<string, Candle[]> = new Map();
  private currentPrices: Map<string, number> = new Map();
  private trades: Trade[] = [];
  private pendingBinaryEvent: string | null = null;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private discoveredWsUrl: string = '';
  private cachedAuthPacket: string = '';
  
  // Signal state
  private lastSignalTime: Map<string, number> = new Map();
  private activeSignals: Map<string, Signal> = new Map();
  
  constructor() {
    for (const asset of CONFIG.assets) {
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
      const session = await this.discoverSession();
      this.discoveredWsUrl = session.url;
      this.cachedAuthPacket = session.authPacket;
      
      console.log(`[WS] Connecting to: ${this.discoveredWsUrl}`);
      
      this.ws = new WebSocket(this.discoveredWsUrl);
      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('error', (err) => console.log(`[WS ERROR] ${err.message}`));
      this.ws.on('close', () => this.handleClose());
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
    if (Buffer.isBuffer(data)) msg = data.toString('utf8');
    else if (typeof data === 'string') msg = data;
    else msg = String(data);
    
    if (msg === '2') {
      this.ws?.send('3');
      return;
    }
    
    if (msg.startsWith('0{')) {
      this.ws?.send('40');
      return;
    }
    
    if (msg.startsWith('40')) {
      console.log('[WS] Authenticated');
      if (this.cachedAuthPacket) {
        this.ws?.send(this.cachedAuthPacket);
        setTimeout(() => this.subscribeAll(), 2000);
      }
      return;
    }
    
    if (msg.startsWith('45')) {
      try {
        const dashIndex = msg.indexOf('-');
        if (dashIndex !== -1) {
          const parsed = JSON.parse(msg.substring(dashIndex + 1));
          if (Array.isArray(parsed) && parsed[1]?.num !== undefined) {
            this.pendingBinaryEvent = parsed[0];
          }
        }
      } catch {}
      return;
    }
    
    if (this.pendingBinaryEvent && !msg.startsWith('42')) {
      const event = this.pendingBinaryEvent;
      this.pendingBinaryEvent = null;
      if (event === 'updateStream') {
        try {
          this.processTickData(JSON.parse(msg));
        } catch {}
      }
      return;
    }
    
    if (msg.startsWith('42')) {
      try {
        const json = JSON.parse(msg.substring(2));
        if (Array.isArray(json) && json[0] === 'updateStream') {
          this.processTickData(json[1]);
        }
      } catch {}
    }
  }

  private processTickData(data: any): void {
    if (!Array.isArray(data)) return;
    
    const now = Date.now();
    const timeRemaining = this.getTimeRemaining(now);
    
    for (const item of data) {
      if (!Array.isArray(item) || item.length < 2) continue;
      
      const assetId = String(item[0]).replace('#', '');
      const price = Number(item.length >= 3 ? item[2] : item[1]);
      const timestamp = item.length >= 3 ? Number(item[1]) * 1000 : now;
      
      if (!CONFIG.assets.some(a => a.includes(assetId.replace('_otc', '')))) continue;
      
      this.currentPrices.set(assetId, price);
      this.updateCandle(assetId, price, timestamp);
      
      // Check for signals
      if (this.shouldCheckSignal(assetId)) {
        this.checkSignal(assetId, timeRemaining);
      }
    }
  }

  private updateCandle(assetId: string, price: number, timestamp: number): void {
    const candles = this.candles.get(assetId) || [];
    const candlePeriod = CONFIG.candlePeriod * 1000;
    const candleTime = Math.floor(timestamp / candlePeriod) * candlePeriod;
    
    let candle = candles.find(c => c.openTime === candleTime);
    
    if (!candle) {
      if (candles.length > 0) {
        candles[candles.length - 1].isComplete = true;
      }
      
      candle = {
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1,
        openTime: candleTime,
        isComplete: false
      };
      candles.push(candle);
      if (candles.length > 50) candles.shift();
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
    return Date.now() - lastCheck > 2000;
  }

  private checkSignal(assetId: string, timeRemaining: number): void {
    this.lastSignalTime.set(assetId, Date.now());
    
    const candles = this.candles.get(assetId) || [];
    const currentPrice = this.currentPrices.get(assetId);
    
    if (candles.length < 5 || !currentPrice) return;
    
    const signal = analyzeCandle(candles, currentPrice, timeRemaining);
    signal.assetId = assetId;
    
    // Only send notification for new signals
    const existingSignal = this.activeSignals.get(assetId);
    if (signal.direction !== 'WAIT' && 
        (!existingSignal || existingSignal.direction !== signal.direction || 
         Date.now() - existingSignal.timestamp > 60000)) {
      
      this.activeSignals.set(assetId, signal);
      
      console.log('\n' + '='.repeat(50));
      console.log(`🎯 SIGNAL: ${signal.direction} on ${assetId}`);
      console.log(`   Entry: ${signal.entryPrice.toFixed(5)}`);
      console.log(`   Confidence: ${signal.confidence}%`);
      console.log(`   Quality: ${signal.entryQuality}`);
      console.log(`   Time Left: ${signal.timeRemaining}s`);
      console.log('   Reasons:');
      signal.reasons.forEach(r => console.log(`   • ${r}`));
      console.log('='.repeat(50) + '\n');
      
      // Send to Telegram
      telegram.sendSignal(signal).then(success => {
        if (success) console.log('[TELEGRAM] Signal sent ✓');
        else console.log('[TELEGRAM] Signal failed to send');
      });
    }
  }

  private handleClose(): void {
    console.log('[WS] Disconnected');
    this.connected = false;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= 5) {
      console.log('[WS] Max reconnection attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = 3000 * this.reconnectAttempts;
    console.log(`[WS] Reconnecting in ${delay / 1000}s... (${this.reconnectAttempts}/5)`);
    setTimeout(() => this.connect(), delay);
  }

  private subscribeAll(): void {
    console.log('[WS] Subscribing to assets...');
    for (let i = 0; i < CONFIG.assets.length; i++) {
      setTimeout(() => {
        this.ws?.send(`42["changeSymbol",{"asset":"${CONFIG.assets[i]}","period":${CONFIG.candlePeriod}}]`);
      }, i * 300);
    }
  }

  private getTimeRemaining(timestamp: number): number {
    const now = Math.floor(timestamp / 1000);
    const candleStart = Math.floor(now / CONFIG.candlePeriod) * CONFIG.candlePeriod;
    const candleEnd = candleStart + CONFIG.candlePeriod;
    return candleEnd - now;
  }

  public disconnect(): void {
    this.ws?.close();
  }

  public getPrices(): Map<string, number> {
    return this.currentPrices;
  }

  public getSignals(): Signal[] {
    return Array.from(this.activeSignals.values()).filter(s => s.direction !== 'WAIT');
  }

  public getPerformance(): { total: number; wins: number; losses: number; winRate: number; profit: number } {
    const closed = this.trades.filter(t => t.result !== 'PENDING');
    const wins = closed.filter(t => t.result === 'WIN').length;
    let profit = 0;
    for (const t of closed) {
      if (t.result === 'WIN') profit += 0.92;
      else profit -= 1;
    }
    return {
      total: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
      profit
    };
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('\n' + '='.repeat(50));
  console.log('  Pocket Option Trading Bot');
  console.log('  Live Signals → Telegram Notifications');
  console.log('='.repeat(50) + '\n');
  
  // Test Telegram connection
  console.log('[TELEGRAM] Testing connection...');
  const connected = await telegram.test();
  if (connected) {
    console.log('[TELEGRAM] Bot connected successfully! ✓\n');
  } else {
    console.log('[TELEGRAM] Connection failed, continuing anyway...\n');
  }
  
  const bot = new TradingBot();
  
  // Send heartbeat every 5 minutes
  setInterval(async () => {
    const prices = bot.getPrices();
    const signals = bot.getSignals();
    if (prices.size > 0) {
      await telegram.sendHeartbeat(prices, signals);
    }
  }, 300000);
  
  // Send performance every 10 minutes
  setInterval(async () => {
    const perf = bot.getPerformance();
    if (perf.total > 0) {
      await telegram.sendPerformance(perf);
    }
  }, 600000);
  
  await bot.connect();
  
  // Status display every 30 seconds
  setInterval(() => {
    const prices = bot.getPrices();
    const signals = bot.getSignals();
    
    if (prices.size > 0) {
      console.clear();
      console.log('\n' + '='.repeat(50));
      console.log('  Pocket Option Trading Bot - LIVE');
      console.log('='.repeat(50));
      console.log('\n📊 Live Prices:');
      for (const [asset, price] of prices) {
        console.log(`   ${asset.padEnd(12)} ${price.toFixed(5)}`);
      }
      
      if (signals.length > 0) {
        console.log('\n🎯 Active Signals:');
        for (const s of signals) {
          console.log(`   ${s.assetId.padEnd(12)} ${s.direction} (${s.confidence}%)`);
        }
      }
      
      const perf = bot.getPerformance();
      console.log('\n📈 Performance:');
      console.log(`   Trades: ${perf.total} (${perf.wins}W / ${perf.losses}L)`);
      console.log(`   Win Rate: ${perf.winRate.toFixed(1)}%`);
      console.log(`   Profit: $${perf.profit.toFixed(2)}`);
      
      console.log('\n' + '='.repeat(50) + '\n');
    }
  }, 30000);
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    
    const perf = bot.getPerformance();
    await telegram.sendPerformance(perf);
    
    bot.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
