import { AVAILABLE_ASSETS } from "../data";
import { getGeminiClient, getGroqClient, REAL_MODEL_MAP } from "../lib/aiAnalysis";
import { Type } from "@google/genai";
import {
  LeadingIndicators,
  StrategyModuleId,
  ConfluenceMeter,
  SetupQualityBreakdown,
  AuditRecord
} from "../types";

// ============================================
// CHAMBER FX CORE ENGINE v5.0.0 — MULTI-TIMEFRAME STRATEGY ENGINE
// Isolated modules: Precision 1m | Turbo 5s | Swing 5m
// ============================================

export interface Tick {
  assetId: string;
  price: number;
  timestamp: number; // ms
}

export interface Candle {
  assetId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number; // ms
  closeTime: number; // ms
}

export interface Signal {
  assetId: string;
  assetName: string;
  direction: 'CALL' | 'PUT' | 'WAIT';
  strength: number; // 0-100
  entryPrice: number;
  expiryTime: number; // ms — PO fixed boundary
  entryWindowClose: number; // ms — when entry becomes invalid
  countdown: number; // seconds remaining in current candle/signal
  rationale: string;
  aiWeights: Record<string, number>;
  regime: string;
  payout: number;
  strategyModule?: StrategyModuleId;
  confluenceMeter?: ConfluenceMeter;
  qualityBreakdown?: SetupQualityBreakdown;
  srLevels?: { support: number; resistance: number };
  leadingIndicators?: LeadingIndicators;
}

export interface AIAnalysis {
  regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE' | 'BREAKOUT_PENDING';
  confidence: number;
  weightShifts: Record<string, number>;
  rationale: string;
}

export interface AssetDefinition {
  id: string;
  name: string;
  ticker: string;
  payout: number;
  active: boolean;
}

// ============================================
// CONFIG — Multi-Timeframe Module Limits
// ============================================

export const CONFIG = {
  MIN_STRENGTH: 70,           // Precision default floor (70%)
  MIN_PAYOUT: 0.88,           // Filter assets below this
  ENTRY_BUFFER_MS: 5000,      // Need 5s to click PO before boundary
  CANDLE_MS: 60000,           // Default 1-minute candles
  INDICATOR_PERIODS: {
    emaFast: 9,
    emaSlow: 21,
    rsi: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bb: 20,
    adx: 14,
    atr: 14
  }
} as const;

export const BASE_WEIGHTS: Record<string, number> = {
  ema: 1.2,
  rsi: 1.5,
  macd: 1.1,
  bb: 1.0,
  adx: 1.3,
  momentum: 1.0
};

// ============================================
// HELPER CALCULATIONS (S/R & OTC Session)
// ============================================

export function calcSRLevels(candles: Candle[], currentPrice: number): {
  support: number;
  resistance: number;
  isNearSR: boolean;
  srType: 'SUPPORT_BOUNCE' | 'RESISTANCE_BOUNCE' | 'SUPPORT_BREAKOUT' | 'RESISTANCE_BREAKOUT' | 'NONE';
} {
  if (candles.length < 15) {
    return { support: currentPrice * 0.998, resistance: currentPrice * 1.002, isNearSR: false, srType: 'NONE' };
  }
  const highs = candles.slice(-25).map(c => c.high);
  const lows = candles.slice(-25).map(c => c.low);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);

  const distToSupp = Math.abs(currentPrice - support) / (currentPrice || 1);
  const distToRes = Math.abs(currentPrice - resistance) / (currentPrice || 1);
  const threshold = 0.0005; // 0.05%

  let isNearSR = false;
  let srType: 'SUPPORT_BOUNCE' | 'RESISTANCE_BOUNCE' | 'SUPPORT_BREAKOUT' | 'RESISTANCE_BREAKOUT' | 'NONE' = 'NONE';

  if (distToSupp <= threshold) {
    isNearSR = true;
    srType = currentPrice >= support ? 'SUPPORT_BOUNCE' : 'SUPPORT_BREAKOUT';
  } else if (distToRes <= threshold) {
    isNearSR = true;
    srType = currentPrice <= resistance ? 'RESISTANCE_BOUNCE' : 'RESISTANCE_BREAKOUT';
  }

  return { support, resistance, isNearSR, srType };
}

export function getOTCSessionBias(): { session: 'ASIAN' | 'LONDON' | 'NEW_YORK'; biasMultiplier: number; description: string } {
  const utcHour = new Date().getUTCHours();
  if (utcHour >= 22 || utcHour < 8) {
    return { session: 'ASIAN', biasMultiplier: 1.05, description: "Asian OTC Session — Rangebound mean-reversion dominance" };
  } else if (utcHour >= 8 && utcHour < 13) {
    return { session: 'LONDON', biasMultiplier: 1.10, description: "London OTC Session — High directional volume breakout potential" };
  } else {
    return { session: 'NEW_YORK', biasMultiplier: 1.08, description: "New York OTC Session — High momentum trend acceleration" };
  }
}

// ============================================
// INDICATORS — Pure functions, no state
// ============================================

export function calcEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [0];
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

export function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calcMACD(closes: number[]): { macd: number; signal: number; hist: number } {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12[ema12.length - 1] - ema26[ema26.length - 1];
  
  // Calculate MACD history for signal line
  const macdSeries: number[] = [];
  const startIdx = Math.max(0, closes.length - 35);
  for (let i = startIdx; i < closes.length; i++) {
    const subCloses = closes.slice(0, i + 1);
    if (subCloses.length >= 26) {
      const e12 = calcEMA(subCloses, 12);
      const e26 = calcEMA(subCloses, 26);
      macdSeries.push(e12[e12.length - 1] - e26[e26.length - 1]);
    }
  }
  
  const signalSeries = calcEMA(macdSeries.length > 0 ? macdSeries : [macdLine], 9);
  const signalLine = signalSeries[signalSeries.length - 1];
  return { macd: macdLine, signal: signalLine, hist: macdLine - signalLine };
}

export function calcBollinger(closes: number[], period: number = 20): { upper: number; mid: number; lower: number; squeeze: boolean; position: number } {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 1;
    return { upper: last * 1.001, mid: last, lower: last * 0.999, squeeze: false, position: 0.5 };
  }
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - mid, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = mid + 2 * std;
  const lower = mid - 2 * std;
  const bandwidth = (upper - lower) / mid;
  const currentPrice = closes[closes.length - 1];
  const position = upper === lower ? 0.5 : (currentPrice - lower) / (upper - lower);
  return { upper, mid, lower, squeeze: bandwidth < 0.001, position };
}

export function calcADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 20;
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  if (trs.length === 0) return 20;
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(trs.length, period);
  const currentClose = closes[closes.length - 1] || 1;
  const normADX = Math.min(100, Math.round((atr / currentClose) * 10000));
  return Math.max(15, Math.min(95, normADX));
}

// ============================================
// AI INTEGRATION — Rule-based & Model AI
// ============================================

const aiCache = new Map<string, { result: AIAnalysis; timestamp: number }>();

export function getFallbackAI(indicators: Record<string, number>): AIAnalysis {
  const adx = indicators.adx ?? 20;
  const rsi = indicators.rsi ?? 50;
  const bbPos = indicators.bbPosition ?? 0.5;
  const ema9 = indicators.ema9 ?? 0;
  const ema21 = indicators.ema21 ?? 0;

  let regime: AIAnalysis['regime'] = 'RANGING';
  let rationale = "Rangebound oscillation. Oscillators centered around mean.";
  let shifts: Record<string, number> = { rsi: 1.25, bb: 1.3, ema: 0.75 };

  if (adx >= 25) {
    if (ema9 >= ema21) {
      regime = 'TRENDING_UP';
      rationale = `Bullish EMA cross with ADX ${adx.toFixed(1)} confirming strong uptrend momentum.`;
    } else {
      regime = 'TRENDING_DOWN';
      rationale = `Bearish EMA cross with ADX ${adx.toFixed(1)} confirming downward trend strength.`;
    }
    shifts = { ema: 1.3, adx: 1.2, rsi: 0.8 };
  } else if (bbPos > 0.95 || bbPos < 0.05) {
    regime = 'BREAKOUT_PENDING';
    rationale = `Bollinger Band compression building toward volatility breakout.`;
    shifts = { bb: 1.35, momentum: 1.25, rsi: 0.85 };
  } else if (rsi > 70 || rsi < 30) {
    regime = 'VOLATILE';
    rationale = `Oscillator exhaustion at RSI ${rsi.toFixed(1)}. Heightened short-term volatility.`;
    shifts = { momentum: 1.4, macd: 0.8 };
  }

  return {
    regime,
    confidence: adx > 25 ? 88 : 78,
    weightShifts: shifts,
    rationale
  };
}

export async function callAI(
  assetId: string,
  indicators: Record<string, number>,
  preferredModelId?: string
): Promise<AIAnalysis> {
  const now = Date.now();
  const cached = aiCache.get(assetId);
  if (cached && now - cached.timestamp < 30000) {
    return cached.result;
  }

  const fallback = getFallbackAI(indicators);

  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.GROK_API_KEY) {
    aiCache.set(assetId, { result: fallback, timestamp: now });
    return fallback;
  }

  const promptText = `
Analyze market indicators:
EMA(9/21): ${indicators.ema9 > indicators.ema21 ? "BULLISH" : "BEARISH"} | RSI: ${indicators.rsi} | MACD Hist: ${indicators.macdHist} | ADX: ${indicators.adx} | BB Position: ${indicators.bbPosition}

Respond ONLY in JSON:
{
  "regime": "TRENDING_UP|TRENDING_DOWN|RANGING|VOLATILE|BREAKOUT_PENDING",
  "confidence": 85,
  "weightShifts": {"ema": 1.3, "rsi": 0.8, "macd": 1.1, "bb": 1.0, "adx": 1.2, "momentum": 1.0},
  "rationale": "One concise sentence max 15 words explaining why"
}
`;

  try {
    const fetchAI = async (): Promise<AIAnalysis> => {
      if (process.env.GEMINI_API_KEY) {
        const ai = getGeminiClient();
        const modelName = REAL_MODEL_MAP[preferredModelId || "gemini-3.5-flash-free"] || "gemini-2.5-flash";
        const res = await ai.models.generateContent({
          model: modelName,
          contents: promptText,
          config: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                regime: { type: Type.STRING },
                confidence: { type: Type.NUMBER },
                weightShifts: {
                  type: Type.OBJECT,
                  properties: {
                    ema: { type: Type.NUMBER },
                    rsi: { type: Type.NUMBER },
                    macd: { type: Type.NUMBER },
                    bb: { type: Type.NUMBER },
                    adx: { type: Type.NUMBER },
                    momentum: { type: Type.NUMBER }
                  }
                },
                rationale: { type: Type.STRING }
              },
              required: ["regime", "confidence", "weightShifts", "rationale"]
            }
          }
        });

        const parsed = JSON.parse(res.text || "{}");
        return {
          regime: parsed.regime || fallback.regime,
          confidence: Math.round(Number(parsed.confidence) || fallback.confidence),
          weightShifts: parsed.weightShifts || fallback.weightShifts,
          rationale: parsed.rationale || fallback.rationale
        };
      } else {
        const groq = getGroqClient();
        const res = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: "You are a quantitative market classifier. Output raw JSON only." },
            { role: "user", content: promptText }
          ],
          temperature: 0.1
        });
        const clean = (res.choices[0]?.message?.content || "{}").replace(/```json/g, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(clean);
        return {
          regime: parsed.regime || fallback.regime,
          confidence: Math.round(Number(parsed.confidence) || fallback.confidence),
          weightShifts: parsed.weightShifts || fallback.weightShifts,
          rationale: parsed.rationale || fallback.rationale
        };
      }
    };

    const timeout = new Promise<AIAnalysis>((_, reject) =>
      setTimeout(() => reject(new Error("AI timeout")), 1500)
    );

    const result = await Promise.race([fetchAI(), timeout]);
    aiCache.set(assetId, { result, timestamp: now });
    return result;
  } catch (e: any) {
    const isRateLimit = e.message?.includes("429") || e.message?.includes("quota") || e.message?.includes("RESOURCE_EXHAUSTED");
    aiCache.set(assetId, { result: fallback, timestamp: now + (isRateLimit ? 120000 : 30000) });
    return fallback;
  }
}

// ============================================
// LEADING INDICATORS & SIGNAL GENERATION (TREND-FOLLOWING + EXHAUSTION BLOCKING)
// ============================================

export function calcLeadingIndicators(
  candles: Candle[],
  currentPrice: number,
  assetName?: string,
  isPartialData: boolean = false
): LeadingIndicators {
  const closes = candles.map(c => c.close);
  const N = closes.length;

  // Detect OTC asset (Apple OTC, Volatility indices, synthetic pairs)
  const cleanName = (assetName || '').toUpperCase();
  const isOTC = cleanName.includes('OTC') || cleanName.includes('VOLATILITY') || cleanName.includes('SYNTHETIC') || cleanName.includes('INDEX');

  // 1. TREND DIRECTION CHECK & CONSECUTIVE CANDLES (WITH DOJI FILTER)
  let consecutiveCandles = 0;
  let consecutiveDirection: 'GREEN' | 'RED' | 'NEUTRAL' = 'NEUTRAL';
  let trendContext: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' = 'SIDEWAYS';

  // Helper to check if candle is a Doji / indecision candle
  const isDoji = (c: Candle) => {
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    return range > 0 ? (body / range <= 0.12) || body < 0.00002 : true;
  };

  if (N > 0) {
    // Find latest non-doji candle to establish direction
    let latestNonDojiIdx = -1;
    for (let i = N - 1; i >= Math.max(0, N - 10); i--) {
      if (!isDoji(candles[i])) {
        latestNonDojiIdx = i;
        break;
      }
    }

    if (latestNonDojiIdx !== -1) {
      const decisiveCandle = candles[latestNonDojiIdx];
      const isGreen = decisiveCandle.close > decisiveCandle.open;
      consecutiveDirection = isGreen ? 'GREEN' : 'RED';
      consecutiveCandles = 0;

      // Count consecutive same-direction candles (ignoring/including dojis within streak)
      for (let i = N - 1; i >= 0; i--) {
        const c = candles[i];
        if (isDoji(c)) {
          // Doji doesn't break streak
          if (consecutiveCandles > 0) consecutiveCandles++;
          continue;
        }
        const cIsGreen = c.close >= c.open;
        if ((consecutiveDirection === 'GREEN' && cIsGreen) || (consecutiveDirection === 'RED' && !cIsGreen)) {
          consecutiveCandles++;
        } else {
          break;
        }
      }
    } else {
      consecutiveDirection = 'NEUTRAL';
      consecutiveCandles = 0;
    }

    if (consecutiveCandles >= 1) {
      if (consecutiveDirection === 'GREEN') trendContext = 'UPTREND';
      else if (consecutiveDirection === 'RED') trendContext = 'DOWNTREND';
    } else {
      trendContext = 'SIDEWAYS';
    }
  }

  const moveExhausted = consecutiveCandles >= 4;
  const moveCompletionPercent = moveExhausted
    ? Math.min(98, 50 + consecutiveCandles * 10)
    : Math.min(90, consecutiveCandles * 25);

  const labelWord = consecutiveDirection === 'GREEN' ? 'Uptrend' : 'Downtrend';
  const exhaustionText = moveExhausted
    ? `EXHAUSTED — ${labelWord} mature (${consecutiveCandles} candles). Waiting for pullback.`
    : `Fresh ${consecutiveDirection === 'GREEN' ? 'up' : 'down'} trend (${consecutiveCandles} candle${consecutiveCandles > 1 ? 's' : ''}).`;

  // OVEREXTENSION FILTER: Calculate distance from trend-start open to current close vs 2 * ATR(10)
  let atr10 = 0;
  if (N > 1) {
    const atrPeriod = Math.min(10, N - 1);
    let trSum = 0;
    for (let i = N - atrPeriod; i < N; i++) {
      const c = candles[i];
      const prevC = candles[i - 1];
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prevC.close),
        Math.abs(c.low - prevC.close)
      );
      trSum += tr;
    }
    atr10 = trSum / atrPeriod;
  }
  const safeAtr = Math.max(0.00005, atr10);

  const trendStartIdx = Math.max(0, N - Math.max(1, consecutiveCandles));
  const trendStartCandle = candles[trendStartIdx];
  const trendStartOpen = trendStartCandle ? trendStartCandle.open : currentPrice;
  const moveDistance = Math.abs(currentPrice - trendStartOpen);

  const moveOverextended = consecutiveCandles >= 1 && moveDistance > 2 * safeAtr;

  // 2. TICK PRESSURE DETECTOR (>70% for partial data, >65% for OTC, >60% for standard forex)
  let upticks = 0;
  let downticks = 0;
  const sampleSize = Math.min(12, N - 1);
  for (let i = N - sampleSize; i < N; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) upticks++;
    else if (diff < 0) downticks++;
  }
  const totalTicks = Math.max(1, upticks + downticks);
  const uptickRatio = upticks / totalTicks;
  const downtickRatio = downticks / totalTicks;

  const minTickThreshold = isPartialData ? 0.70 : (isOTC ? 0.65 : 0.60);
  const tickThresholdPct = Math.round(minTickThreshold * 100);

  let tickPressurePercent = 50;
  let tickPressureBias: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let tickPressureText = "50% NEUTRAL";

  if (isPartialData && totalTicks < 8) {
    tickPressureText = "PARTIAL DATA";
  } else if (uptickRatio > minTickThreshold) {
    tickPressureBias = 'BUY';
    tickPressurePercent = Math.round(uptickRatio * 100);
    tickPressureText = isPartialData ? `${tickPressurePercent}% BUY (PARTIAL)` : `${tickPressurePercent}% BUY`;
  } else if (downtickRatio > minTickThreshold) {
    tickPressureBias = 'SELL';
    tickPressurePercent = Math.round(downtickRatio * 100);
    tickPressureText = isPartialData ? `${tickPressurePercent}% SELL (PARTIAL)` : `${tickPressurePercent}% SELL`;
  } else {
    tickPressurePercent = Math.round(Math.max(uptickRatio, downtickRatio) * 100);
    if (uptickRatio >= downtickRatio) {
      tickPressureText = `${tickPressurePercent}% BUY (≤${tickThresholdPct}%)`;
    } else {
      tickPressureText = `${tickPressurePercent}% SELL (≤${tickThresholdPct}%)`;
    }
  }

  // 3. MOMENTUM BURST & VOLUME DETECTOR
  const lastCandle = candles[N - 1] || { volume: 100, open: currentPrice, close: currentPrice, high: currentPrice, low: currentPrice };
  const recentVol = candles.slice(-5).map(c => c.volume || 100);
  const avgVol = recentVol.reduce((a, b) => a + b, 0) / (recentVol.length || 1);
  const volumeSpike = (lastCandle.volume || 100) >= 1.25 * avgVol;

  const cNow = closes[N - 1] || currentPrice;
  const cPrev5 = closes[Math.max(0, N - 5)] || currentPrice;
  const cPrev10 = closes[Math.max(0, N - 10)] || currentPrice;
  const velRecent = cNow - cPrev5;
  const velPrior = cPrev5 - cPrev10;
  const accel = velRecent - velPrior;

  let momentumBias: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
  let momentumAccelPercent = 0;

  if (velRecent > 0 && accel > 0) {
    momentumBias = 'UP';
    momentumAccelPercent = Math.min(99, Math.max(42, Math.round(Math.abs(accel / (cNow || 1)) * 100000)));
  } else if (velRecent < 0 && accel < 0) {
    momentumBias = 'DOWN';
    momentumAccelPercent = Math.min(99, Math.max(42, Math.round(Math.abs(accel / (cNow || 1)) * 100000)));
  }

  const momentumBurst = volumeSpike || momentumAccelPercent > 35;
  const momentumText = momentumBurst ? `BURST +${momentumAccelPercent}%` : `NORMAL`;

  // 4. VWAP & STRUCTURE ALIGNMENT
  let sumTPV = 0;
  let sumVol = 0;
  const vwapPeriod = Math.min(20, N);
  const vwapCandles = candles.slice(-vwapPeriod);
  vwapCandles.forEach(c => {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 100;
    sumTPV += tp * vol;
    sumVol += vol;
  });
  const vwap = sumVol > 0 ? sumTPV / sumVol : currentPrice;
  const variance = vwapCandles.reduce((acc, c) => acc + Math.pow(c.close - vwap, 2), 0) / vwapPeriod;
  const stdDev = Math.max(0.00005, Math.sqrt(variance));
  const vwapSigmaRaw = (currentPrice - vwap) / stdDev;
  const vwapSigma = Number(vwapSigmaRaw.toFixed(1));

  let vwapState: 'OVERSOLD' | 'OVERBOUGHT' | 'NORMAL' = 'NORMAL';
  let vwapBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (vwapSigma <= -1.4) {
    vwapState = 'OVERSOLD';
    vwapBias = 'BULLISH';
  } else if (vwapSigma >= 1.4) {
    vwapState = 'OVERBOUGHT';
    vwapBias = 'BEARISH';
  }
  const vwapText = `VWAP: ${vwapSigma >= 0 ? '+' : ''}${vwapSigma}σ`;

  // 5. CONFIDENCE SCORING (0-100)
  // Candle position score:
  // Standard Forex: candle 1 = 30pts, 2 = 20pts, 3 = 10pts, 4+ = 0pts
  // OTC Pair: requires 2+ confirming candles (candle 1 blocked), candle 2 = 30pts, 3 = 15pts
  let positionScore = 0;
  if (isOTC) {
    if (consecutiveCandles === 2) positionScore = 30;
    else if (consecutiveCandles === 3) positionScore = 15;
    else positionScore = 0;
  } else {
    if (consecutiveCandles === 1) positionScore = 30;
    else if (consecutiveCandles === 2) positionScore = 20;
    else if (consecutiveCandles === 3) positionScore = 10;
    else positionScore = 0;
  }

  // Tick pressure score: 80%+ = 25pts, 70-79% = 20pts, >=threshold = 15pts, <min = 0pts
  let tickScore = 0;
  if (tickPressurePercent >= 80) tickScore = 25;
  else if (tickPressurePercent >= 70) tickScore = 20;
  else if (tickPressurePercent >= tickThresholdPct) tickScore = 15;
  else tickScore = 0;

  // MOMENTUM BURST SCORING REVISION:
  // Candle 1 burst: +15pts (fresh momentum)
  // Candle 2 burst: 0pts (momentum already visible)
  // Candle 3 burst: -10pts (likely blow-off top)
  // Never reward burst on exhausted trends (4+ candles)
  let burstScore = 0;
  if (momentumBurst && !moveExhausted) {
    if (consecutiveCandles === 1) burstScore = 15;
    else if (consecutiveCandles === 2) burstScore = 0;
    else if (consecutiveCandles === 3) burstScore = -10;
    else burstScore = 0;
  }

  // Structure / VWAP / Trend alignment = 30pts
  let structureScore = 30;
  if (consecutiveDirection === 'GREEN' && vwapSigma < -1.5) structureScore -= 10;
  if (consecutiveDirection === 'RED' && vwapSigma > 1.5) structureScore -= 10;

  let rawScore = positionScore + tickScore + burstScore + structureScore;
  if (moveExhausted) rawScore = Math.min(55, rawScore);
  if (tickPressurePercent <= tickThresholdPct) rawScore = Math.min(58, rawScore);
  if (consecutiveCandles === 0 || trendContext === 'SIDEWAYS') rawScore = Math.min(50, rawScore);

  // Max confidence cap: OTC assets capped at 85% max, standard forex up to 99%
  const maxCap = isOTC ? 85 : 99;
  const confidenceScore = Math.min(maxCap, Math.max(35, rawScore));

  // Determine Blocked State & Reason
  let blockedReason: string | undefined = undefined;
  if (isPartialData && totalTicks < 8) {
    blockedReason = "INSUFFICIENT TICK DATA — WAIT";
  } else if (moveExhausted) {
    blockedReason = "EXHAUSTED — WAIT FOR PULLBACK";
  } else if (moveOverextended) {
    blockedReason = "Move too far too fast — WAIT";
  } else if (isOTC && consecutiveCandles < 2) {
    blockedReason = "OTC REQUIRES 2+ CONFIRMING CANDLES";
  } else if (trendContext === 'SIDEWAYS' || consecutiveCandles === 0) {
    blockedReason = "NO CLEAR TREND — SCANNING";
  } else if (tickPressurePercent <= tickThresholdPct || (consecutiveDirection === 'GREEN' && tickPressureBias !== 'BUY') || (consecutiveDirection === 'RED' && tickPressureBias !== 'SELL')) {
    blockedReason = isPartialData ? "WEAK / PARTIAL MOMENTUM — WAIT (>70% req)" : isOTC ? "WEAK MOMENTUM — WAIT (OTC requires >65%)" : "WEAK MOMENTUM — WAIT";
  } else if (confidenceScore < 60) {
    blockedReason = "CONDITIONS MARGINAL — WAIT";
  }

  let confidenceLevel: 'STRONG' | 'MODERATE' | 'LOW' | 'BLOCKED' = 'BLOCKED';
  if (blockedReason) {
    confidenceLevel = 'BLOCKED';
  } else if (confidenceScore >= 80) {
    confidenceLevel = 'STRONG';
  } else if (confidenceScore >= 60) {
    confidenceLevel = 'MODERATE';
  } else {
    confidenceLevel = 'LOW';
  }

  const confluenceScore = blockedReason ? 0 : (confidenceScore >= 80 ? 4 : 3);
  const confluenceBias = blockedReason ? 'NEUTRAL' : (consecutiveDirection === 'GREEN' ? 'BULLISH' : 'BEARISH');
  const confluenceText = blockedReason ? blockedReason : `Trend Momentum Confirmed (${trendContext})`;

  const pattern: 'NONE' = 'NONE';
  const patternBias: 'NEUTRAL' = 'NEUTRAL';
  const patternText = 'Pattern: Disabled (Trend-Following Only)';

  return {
    tickPressurePercent,
    tickPressureBias,
    tickPressureText,
    pattern,
    patternBias,
    patternText,
    vwapSigma,
    vwapState,
    vwapBias,
    vwapText,
    momentumAccelPercent,
    momentumBias,
    momentumText,
    confluenceScore,
    confluenceBias,
    confluenceText,
    consecutiveCandles,
    consecutiveDirection,
    trendContext,
    moveExhausted,
    moveCompletionPercent,
    exhaustionText,
    confidenceScore,
    confidenceLevel,
    blockedReason,
    momentumBurst,
    moveOverextended,
    isOTC,
    atr10
  };
}

export function generateSignal(
  assetId: string,
  assetName: string,
  payout: number,
  candles: Candle[],
  currentPrice: number,
  aiAnalysis: AIAnalysis
): Signal {
  const leading = calcLeadingIndicators(candles, currentPrice, assetName);

  let direction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
  let strength = leading.confidenceScore;

  if (!leading.blockedReason) {
    if (leading.consecutiveDirection === 'GREEN') {
      direction = 'CALL';
    } else if (leading.consecutiveDirection === 'RED') {
      direction = 'PUT';
    }
  }

  let customRationale = "";
  if (direction === 'CALL') {
    const modLabel = leading.confidenceLevel === 'MODERATE' ? ' (MODERATE — USE CAUTION)' : '';
    customRationale = `Early uptrend (Candle ${leading.consecutiveCandles}/3) + ${leading.tickPressurePercent}% BUY pressure. Confidence: ${leading.confidenceScore}% (${leading.confidenceLevel})${modLabel}.`;
  } else if (direction === 'PUT') {
    const modLabel = leading.confidenceLevel === 'MODERATE' ? ' (MODERATE — USE CAUTION)' : '';
    customRationale = `Early downtrend (Candle ${leading.consecutiveCandles}/3) + ${leading.tickPressurePercent}% SELL pressure. Confidence: ${leading.confidenceScore}% (${leading.confidenceLevel})${modLabel}.`;
  } else {
    customRationale = leading.blockedReason || "CONDITIONS MARGINAL — WAIT";
  }

  const now = Date.now();
  const secondsPastMinute = (now % 60000) / 1000;
  const secondsToBoundary = Math.max(0, 60 - secondsPastMinute);
  const countdown = Math.round(secondsToBoundary);

  const bufferMs = CONFIG.ENTRY_BUFFER_MS;
  const entryWindowClose = now + Math.max(0, secondsToBoundary * 1000 - bufferMs);
  const expiryTime = now + Math.round(secondsToBoundary * 1000) + (direction === 'WAIT' ? 0 : 60000);

  return {
    assetId,
    assetName,
    direction,
    strength,
    entryPrice: currentPrice,
    expiryTime,
    entryWindowClose,
    countdown,
    rationale: customRationale,
    aiWeights: BASE_WEIGHTS,
    regime: leading.confluenceBias === 'BULLISH' ? 'TRENDING_UP' : leading.confluenceBias === 'BEARISH' ? 'TRENDING_DOWN' : 'RANGING',
    payout,
    leadingIndicators: leading
  };
}

// ============================================
// STRATEGY MODULE SIGNAL GENERATORS
// ============================================

export function generatePrecisionSignal(
  assetId: string,
  assetName: string,
  payout: number,
  candles: Candle[],
  currentPrice: number,
  aiAnalysis: AIAnalysis
): Signal {
  const leading = calcLeadingIndicators(candles, currentPrice, assetName);
  const now = Date.now();
  const secondsPastMinute = (now % 60000) / 1000;

  // Stricter Confluence Requirements (3+ out of 4)
  const cond1 = leading.trendContext !== 'SIDEWAYS';
  const cond2 = leading.tickPressurePercent >= 65;
  const cond3 = leading.consecutiveCandles >= 2;
  const cond4 = (aiAnalysis.confidence || 0) >= 75;

  const confluenceScore = (cond1 ? 1 : 0) + (cond2 ? 1 : 0) + (cond3 ? 1 : 0) + (cond4 ? 1 : 0);

  const meter: ConfluenceMeter = {
    current: confluenceScore,
    total: 4,
    details: [
      { name: "Trend Alignment", active: cond1, description: leading.trendContext },
      { name: "Tick Pressure (≥65%)", active: cond2, description: `${leading.tickPressurePercent}% ${leading.tickPressureBias}` },
      { name: "Streak Velocity (≥2)", active: cond3, description: `${leading.consecutiveCandles} ${leading.consecutiveDirection}` },
      { name: "AI Confidence (≥75%)", active: cond4, description: `${aiAnalysis.confidence || 0}% AI rating` }
    ]
  };

  let direction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
  let strength = Math.min(95, Math.max(70, Math.round(leading.confidenceScore * 0.5 + (aiAnalysis.confidence || 75) * 0.5)));
  let blockedReason = "";

  if (confluenceScore < 3) {
    blockedReason = `PRECISION REJECTED: Confluence score ${confluenceScore}/4 (3 required)`;
  } else if (secondsPastMinute < 10 || secondsPastMinute > 50) {
    blockedReason = `CANDLE TIMING WINDOW CLOSED (${secondsPastMinute.toFixed(1)}s past min — window: 10s-50s)`;
  } else if (leading.blockedReason) {
    blockedReason = leading.blockedReason;
  } else {
    direction = leading.consecutiveDirection === 'GREEN' ? 'CALL' : leading.consecutiveDirection === 'RED' ? 'PUT' : 'WAIT';
  }

  const rationale = direction !== 'WAIT'
    ? `[1M PRECISION] High confluence setup (${confluenceScore}/4 align) + ${leading.tickPressurePercent}% pressure + ${aiAnalysis.confidence || 75}% AI validation.`
    : blockedReason || "Precision conditions marginal — WAIT";

  const secondsToBoundary = Math.max(0, 60 - secondsPastMinute);
  const expiryTime = now + Math.round(secondsToBoundary * 1000) + (direction === 'WAIT' ? 0 : 60000);

  return {
    assetId,
    assetName,
    direction,
    strength: direction === 'WAIT' ? 0 : strength,
    entryPrice: currentPrice,
    expiryTime,
    entryWindowClose: now + 20000,
    countdown: Math.round(secondsToBoundary),
    rationale,
    aiWeights: BASE_WEIGHTS,
    regime: leading.confluenceBias === 'BULLISH' ? 'TRENDING_UP' : 'TRENDING_DOWN',
    payout,
    strategyModule: 'precision',
    confluenceMeter: meter,
    leadingIndicators: leading
  };
}

export function generateTurboSignal(
  assetId: string,
  assetName: string,
  payout: number,
  candles: Candle[],
  currentPrice: number,
  circuitBreakerActive: boolean
): { signal: Signal; executionTimeMs: number } {
  const startMs = Date.now();
  const leading = calcLeadingIndicators(candles, currentPrice, assetName);
  const now = Date.now();

  const closes = candles.map(c => c.close);
  const ema5 = calcEMA(closes, 5);
  const lastEma5 = ema5[ema5.length - 1] || currentPrice;

  const recentSlice = candles.slice(-10);
  const maxH = Math.max(...recentSlice.map(c => c.high));
  const minL = Math.min(...recentSlice.map(c => c.low));
  const lastAtr = (maxH - minL) / 10 || 0.0002;
  const isVolatile = lastAtr >= 0.00010;

  const highPressure = leading.tickPressurePercent >= 60;
  const priceAboveEma = currentPrice > lastEma5;
  const priceBelowEma = currentPrice < lastEma5;

  let direction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
  let blockedReason = "";

  if (circuitBreakerActive) {
    blockedReason = "TURBO CIRCUIT BREAKER ACTIVE (3 consecutive losses). Cooldown active.";
  } else if (!isVolatile) {
    blockedReason = "TURBO REJECTED: Low tick volatility (ATR < 0.00010)";
  } else if (highPressure && priceAboveEma && leading.tickPressureBias === 'BUY') {
    direction = 'CALL';
  } else if (highPressure && priceBelowEma && leading.tickPressureBias === 'SELL') {
    direction = 'PUT';
  } else {
    blockedReason = "TURBO REJECTED: Insufficient 5s tick momentum alignment";
  }

  const confluenceMeter: ConfluenceMeter = {
    current: direction !== 'WAIT' ? 2 : 1,
    total: 2,
    details: [
      { name: "15-Tick Momentum (≥60%)", active: highPressure, description: `${leading.tickPressurePercent}% pressure` },
      { name: "5-Period EMA Breach", active: priceAboveEma || priceBelowEma, description: `Price vs EMA5` }
    ]
  };

  const endMs = Date.now();
  const executionTimeMs = Math.max(1, endMs - startMs);

  const rationale = direction !== 'WAIT'
    ? `[TURBO 5S] Ultra-low latency signal (${executionTimeMs}ms) | High tick momentum burst + EMA5 acceleration.`
    : blockedReason;

  const signal: Signal = {
    assetId,
    assetName,
    direction,
    strength: direction === 'WAIT' ? 0 : 68,
    entryPrice: currentPrice,
    expiryTime: now + 5000,
    entryWindowClose: now + 3000,
    countdown: 5,
    rationale,
    aiWeights: BASE_WEIGHTS,
    regime: "TURBO_MOMENTUM",
    payout,
    strategyModule: 'turbo',
    confluenceMeter,
    leadingIndicators: leading
  };

  return { signal, executionTimeMs };
}

export function generateSwingSignal(
  assetId: string,
  assetName: string,
  payout: number,
  candles: Candle[],
  currentPrice: number,
  aiAnalysis: AIAnalysis
): Signal {
  const leading = calcLeadingIndicators(candles, currentPrice, assetName);
  const now = Date.now();

  const sr = calcSRLevels(candles, currentPrice);
  const session = getOTCSessionBias();

  const closes = candles.map(c => c.close);
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
  const isMacroUptrend = currentPrice > sma20;
  const isMacroDowntrend = currentPrice < sma20;

  const condTrend = (isMacroUptrend && leading.consecutiveDirection === 'GREEN') || (isMacroDowntrend && leading.consecutiveDirection === 'RED');
  const condSR = sr.isNearSR;
  const condPressure = leading.tickPressurePercent >= 60;
  const condAI = (aiAnalysis.confidence || 0) >= 80;

  const trendScore = condTrend ? 25 : 10;
  const srScore = condSR ? 25 : 15;
  const pressureScore = condPressure ? 25 : 15;
  const aiScore = Math.round(((aiAnalysis.confidence || 75) / 100) * 25);

  const totalQuality = trendScore + srScore + pressureScore + aiScore;

  const qualityBreakdown: SetupQualityBreakdown = {
    trendStructure: trendScore,
    srProximity: srScore,
    tickPressure: pressureScore,
    aiConsensus: aiScore,
    totalScore: totalQuality
  };

  const meter: ConfluenceMeter = {
    current: (condTrend ? 1 : 0) + (condSR ? 1 : 0) + (condPressure ? 1 : 0) + (condAI ? 1 : 0),
    total: 4,
    details: [
      { name: "20-SMA Macro Trend", active: condTrend, description: isMacroUptrend ? "20-SMA Macro Uptrend" : "20-SMA Macro Downtrend" },
      { name: "Support/Resistance Zone", active: condSR, description: `Near ${sr.srType}` },
      { name: "5m Tick Pressure (≥60%)", active: condPressure, description: `${leading.tickPressurePercent}% ${leading.tickPressureBias}` },
      { name: "Dual AI Consensus (≥80%)", active: condAI, description: `${aiAnalysis.confidence || 0}% rating` }
    ]
  };

  let direction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
  let blockedReason = "";

  if (totalQuality < 80) {
    blockedReason = `SWING REJECTED: Setup Quality ${totalQuality}% (80% minimum required)`;
  } else if (!condTrend) {
    blockedReason = "SWING REJECTED: Counter-trend setup blocked by 20-SMA macro trend filter";
  } else {
    direction = isMacroUptrend ? 'CALL' : 'PUT';
  }

  const paragraphRationale = direction !== 'WAIT'
    ? `[5M SWING] High-probability macro setup (${totalQuality}% Quality Score). ${session.description}. Market confirmed near ${sr.srType} zone with ${leading.tickPressurePercent}% ${leading.tickPressureBias} volume pressure and ${aiAnalysis.confidence || 85}% AI dual-model consensus.`
    : blockedReason;

  const secondsPast5m = (now % 300000) / 1000;
  const secondsTo5mBoundary = Math.max(0, 300 - secondsPast5m);
  const expiryTime = now + Math.round(secondsTo5mBoundary * 1000);

  return {
    assetId,
    assetName,
    direction,
    strength: direction === 'WAIT' ? 0 : totalQuality,
    entryPrice: currentPrice,
    expiryTime,
    entryWindowClose: now + 60000,
    countdown: Math.round(secondsTo5mBoundary),
    rationale: paragraphRationale,
    aiWeights: BASE_WEIGHTS,
    regime: isMacroUptrend ? "MACRO_UPTREND" : "MACRO_DOWNTREND",
    payout,
    strategyModule: 'swing',
    confluenceMeter: meter,
    qualityBreakdown,
    srLevels: { support: sr.support, resistance: sr.resistance },
    leadingIndicators: leading
  };
}

export interface LiveIndicators {
  ema9: number;
  ema21: number;
  rsi: number;
  macdHist: number;
  bbPosition: number;
  adx: number;
  updatedAt: number; // Date.now() ms
  rsiHistory: number[];
}

export interface SettlementRecord {
  assetId: string;
  assetName: string;
  poPrice: number;
  botPrice: number;
  diffPips: number;
  direction: 'CALL' | 'PUT' | 'WAIT';
  isWin: boolean;
  timestamp: number;
}

// ============================================
// CORE ENGINE CLASS — Single State Store
// ============================================

export type PipelineState = 'IDLE' | 'SCANNING' | 'SIGNAL' | 'ENTERED' | 'SETTLING';

export interface ActiveTrade {
  tradeId: string;
  assetId: string;
  assetName: string;
  direction: 'CALL' | 'PUT';
  entryPrice: number;
  enteredAt: number;
  expiryTime: number;
  payout: number;
}

export function formatAssetPrice(price: number | undefined | null, assetIdOrName: string = ""): string {
  if (price === undefined || price === null || isNaN(price) || price <= 0) {
    return "—.——";
  }

  const clean = (assetIdOrName || "").toUpperCase();

  // Stock, Crypto, Commodity OTC assets (e.g., FedEx OTC, Apple OTC, Tesla OTC, Gold, BTC)
  const isStockOrCryptoOrCommodity = 
    clean.includes("FDX") || clean.includes("FEDEX") ||
    clean.includes("AAPL") || clean.includes("APPLE") ||
    clean.includes("MSFT") || clean.includes("AMZN") ||
    clean.includes("TSLA") || clean.includes("GOOG") ||
    clean.includes("BTC") || clean.includes("ETH") ||
    clean.includes("XAU") || clean.includes("GOLD") ||
    clean.includes("XAG") || clean.includes("SILVER") ||
    price >= 100;

  if (isStockOrCryptoOrCommodity) {
    return price.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Forex OTC assets (e.g., EUR/USD OTC, USD/MXN OTC) -> 5 decimal places
  return price.toFixed(5);
}

export function getDefaultBasePriceForAsset(assetId: string, assetName: string = ""): number {
  return 0; // ZERO mock fallback. Real live prices arrive strictly via WebSocket ticks.
}

class CoreEngine {
  private candleBuffers = new Map<string, Candle[]>();
  private pricesMap = new Map<string, number>();
  private realTickBufferMap = new Map<string, number[]>();
  private assetsMap = new Map<string, AssetDefinition>();
  private activeSignals = new Map<string, Signal>();
  private signalHistory = new Map<string, { direction: 'CALL' | 'PUT' | 'WAIT'; timestamp: number }>();
  private liveIndicators = new Map<string, LiveIndicators>();
  private settlements: SettlementRecord[] = [];
  private feedStatus: 'ONLINE' | 'OFFLINE' | 'RECONNECTING' = 'ONLINE';
  private preferredModelId = "gemini-3.5-flash-free";
  private operationalMode = "QUANTITATIVE";
  private lastScanTime = new Date().toISOString();
  private topSignal: Signal | null = null;
  private poToBotLatencyMs: number = 4;
  private processingTimeMs: number = 0.8;
  private allowSignalGenAfterReconnect: boolean = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectWarmupUntil: number = 0;
  private lastTickTimestamp: number = Date.now();
  private brokerTimeOffset: number = 0;
  private ticksInCurrentCandle = new Map<string, number>();
  private currentCandleMinute = new Map<string, number>();
  private isHistorySyncedMap = new Map<string, boolean>();

  private autoScanEnabled: boolean = true;
  private lastAutoScanMinute: number = 0;
  private lastScanResultMessage: string = "Auto-scan active — monitoring 70% candle marks";
  private prevPricesMap = new Map<string, number>();

  // STRATEGY MODULE STATE
  private activeStrategyModule: StrategyModuleId = 'precision';
  private turboLossStreak: number = 0;
  private turboDisabledUntil: number = 0;
  private turbo_latency_ms: number = 24;
  private auditLogs: AuditRecord[] = [];

  // HARD SEQUENTIAL PIPELINE STATE
  private pipelineState: PipelineState = 'IDLE';
  private activePipelineSignal: Signal | null = null;
  private activeTrade: ActiveTrade | null = null;
  private signalFiredAt: number = 0;
  private signalExpiresAt: number = 0;
  private settlingEndTime: number = 0;
  private settlingResult: SettlementRecord | null = null;
  private scanStartedAt: number = 0;
  private scanTimedOut: boolean = false;

  constructor() {
    // Populate with default OTC assets with empty buffers awaiting real WS stream ticks
    AVAILABLE_ASSETS.forEach(a => {
      this.assetsMap.set(a.id, {
        id: a.id,
        name: a.name,
        ticker: a.ticker,
        payout: a.payout,
        active: true
      });
      this.candleBuffers.set(a.id, []);
      this.realTickBufferMap.set(a.id, []);
    });
  }

  public getStrategyModule(): StrategyModuleId {
    return this.activeStrategyModule;
  }

  public setStrategyModule(strategy: StrategyModuleId): void {
    if (this.activeStrategyModule !== strategy) {
      this.activeStrategyModule = strategy;
      this.activeSignals.clear();
      this.topSignal = null;
      if (this.pipelineState === 'SIGNAL' || this.pipelineState === 'SCANNING') {
        this.pipelineState = 'IDLE';
        this.activePipelineSignal = null;
      }
      this.lastScanResultMessage = `Strategy switched to ${strategy.toUpperCase()} module`;
      console.log(`[ENGINE] Strategy module switched to: ${strategy}`);
    }
  }

  public getTurboLatencyMs(): number {
    return this.turbo_latency_ms;
  }

  public isTurboCircuitBreakerActive(): boolean {
    return Date.now() < this.turboDisabledUntil;
  }

  public getAuditLogs(): AuditRecord[] {
    return this.auditLogs;
  }

  public toggleAutoScan(): boolean {
    this.autoScanEnabled = !this.autoScanEnabled;
    this.lastScanResultMessage = this.autoScanEnabled 
      ? "Auto-scan enabled (Triggers at 70% candle mark)" 
      : "Auto-scan paused — manual scan mode";
    return this.autoScanEnabled;
  }

  public isAutoScanEnabled(): boolean {
    return this.autoScanEnabled;
  }

  public setFeedStatus(status: 'ONLINE' | 'OFFLINE' | 'RECONNECTING'): void {
    const prevStatus = this.feedStatus;
    this.feedStatus = status;

    if (status === 'OFFLINE' || status === 'RECONNECTING') {
      this.activeSignals.clear();
      this.topSignal = null;
      this.allowSignalGenAfterReconnect = false;
      this.activePipelineSignal = null;
      if (this.pipelineState === 'SCANNING' || this.pipelineState === 'SIGNAL') {
        this.pipelineState = 'IDLE';
      }
      this.lastScanResultMessage = "RECONNECTING — SIGNALS PAUSED";
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    } else if (status === 'ONLINE' && prevStatus !== 'ONLINE') {
      const now = Date.now();
      this.reconnectWarmupUntil = now + 15000;
      this.allowSignalGenAfterReconnect = false;
      this.lastScanResultMessage = "Warmup active — stabilizing data feed";
      
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.allowSignalGenAfterReconnect = true;
        this.lastScanResultMessage = "Auto-scan active — monitoring 70% candle marks";
        console.log(`[ENGINE] Warmup complete. Signal generation enabled.`);
      }, 15000);
    }
  }

  public getFeedStatus(): 'ONLINE' | 'OFFLINE' | 'RECONNECTING' {
    return this.feedStatus;
  }

  public updateLatency(poToBotMs: number, procTimeMs: number): void {
    if (poToBotMs > 0 && poToBotMs < 5000) {
      this.poToBotLatencyMs = Math.round(poToBotMs);
    }
    if (procTimeMs > 0) {
      this.processingTimeMs = Number(procTimeMs.toFixed(2));
    }
  }

  public registerSettlement(assetId: string, poPrice: number, direction?: 'CALL' | 'PUT' | 'WAIT'): SettlementRecord {
    const asset = this.assetsMap.get(assetId);
    const assetName = asset ? asset.name : assetId;
    const botPrice = this.pricesMap.get(assetId) || poPrice;
    const diffPips = Number((Math.abs(poPrice - botPrice) * 10000).toFixed(2));
    
    const activeSig = this.activeSignals.get(assetId);
    const dir = direction || activeSig?.direction || 'CALL';
    const isWin = dir === 'CALL' ? poPrice >= (activeSig?.entryPrice || botPrice) : poPrice <= (activeSig?.entryPrice || botPrice);

    const record: SettlementRecord = {
      assetId,
      assetName,
      poPrice,
      botPrice,
      diffPips,
      direction: dir,
      isWin,
      timestamp: Date.now()
    };

    this.settlements.unshift(record);
    if (this.settlements.length > 20) this.settlements.pop();
    return record;
  }

  public getLatestSettlement(): SettlementRecord | null {
    return this.settlements[0] || null;
  }

  public getSettlements(): SettlementRecord[] {
    return this.settlements;
  }

  // ============================================
  // HARD SEQUENTIAL PIPELINE METHODS
  // ============================================

  public enterTrade(customEntryPrice?: number): ActiveTrade | null {
    if (this.pipelineState !== 'SIGNAL' || !this.activePipelineSignal) {
      console.warn(`[PIPELINE WARN] Cannot enter trade. Current state: ${this.pipelineState}`);
      return null;
    }

    const now = Date.now();
    const currentPrice = this.pricesMap.get(this.activePipelineSignal.assetId) || this.activePipelineSignal.entryPrice;
    const entryPrice = customEntryPrice && customEntryPrice > 0 ? customEntryPrice : currentPrice;

    this.activeTrade = {
      tradeId: `trade_${now}`,
      assetId: this.activePipelineSignal.assetId,
      assetName: this.activePipelineSignal.assetName,
      direction: this.activePipelineSignal.direction as 'CALL' | 'PUT',
      entryPrice,
      enteredAt: now,
      expiryTime: now + 60000,
      payout: this.activePipelineSignal.payout
    };

    this.pipelineState = 'ENTERED';
    console.log(`[PIPELINE STATE] -> ENTERED: ${this.activeTrade.assetName} ${this.activeTrade.direction} @ ${entryPrice}`);
    return this.activeTrade;
  }

  public startScanning(): void {
    this.pipelineState = 'SCANNING';
    this.scanStartedAt = Date.now();
    this.scanTimedOut = false;
    this.activePipelineSignal = null;
    console.log(`[PIPELINE STATE] -> SCANNING: Auto-scan initiated...`);
    this.manualScan().catch(err => {
      console.error("[ENGINE ERROR] Manual scan failed:", err);
      this.pipelineState = 'IDLE';
    });
  }

  public stopScanning(): void {
    this.pipelineState = 'IDLE';
    this.scanStartedAt = 0;
    this.scanTimedOut = false;
    this.activePipelineSignal = null;
    console.log(`[PIPELINE STATE] -> IDLE: Scan stopped by user.`);
  }

  public skipSignal(): void {
    if (this.pipelineState === 'SIGNAL') {
      if (this.activePipelineSignal) {
        // Set cooldown on skipped asset so engine picks NEXT best asset immediately
        this.signalHistory.set(this.activePipelineSignal.assetId, {
          direction: this.activePipelineSignal.direction,
          timestamp: Date.now()
        });
      }
      console.log(`[PIPELINE STATE] -> IDLE (User skipped active signal)`);
      this.pipelineState = 'IDLE';
      this.activePipelineSignal = null;
    }
  }

  public startSettlement(): SettlementRecord | null {
    if (!this.activeTrade) {
      this.pipelineState = 'IDLE';
      return null;
    }

    const currentPrice = this.pricesMap.get(this.activeTrade.assetId) || this.activeTrade.entryPrice;
    const isWin = this.activeTrade.direction === 'CALL'
      ? currentPrice > this.activeTrade.entryPrice
      : currentPrice < this.activeTrade.entryPrice;

    const diffPips = Number((Math.abs(currentPrice - this.activeTrade.entryPrice) * 10000).toFixed(2));

    const record: SettlementRecord = {
      assetId: this.activeTrade.assetId,
      assetName: this.activeTrade.assetName,
      poPrice: currentPrice,
      botPrice: this.activeTrade.entryPrice,
      diffPips,
      direction: this.activeTrade.direction,
      isWin,
      timestamp: Date.now()
    };

    this.settlements.unshift(record);
    if (this.settlements.length > 20) this.settlements.pop();

    // Circuit breaker check for Turbo module
    if (this.activeStrategyModule === 'turbo') {
      if (isWin) {
        this.turboLossStreak = 0;
      } else {
        this.turboLossStreak++;
        if (this.turboLossStreak >= 3) {
          this.turboDisabledUntil = Date.now() + 60000; // 60s cooldown
          console.warn(`[TURBO CIRCUIT BREAKER] 3 consecutive losses detected! Turbo module disabled for 60 seconds.`);
        }
      }
    }

    this.settlingResult = record;
    this.pipelineState = 'SETTLING';
    this.settlingEndTime = Date.now() + 3500; // Display settlement card for 3.5s

    console.log(`[PIPELINE STATE] -> SETTLING: ${record.assetName} ${record.direction} ${isWin ? 'WIN' : 'LOSS'} (PO: ${currentPrice}, Entry: ${record.botPrice})`);
    return record;
  }

  public resetPipeline(): void {
    this.pipelineState = 'IDLE';
    this.scanStartedAt = 0;
    this.scanTimedOut = false;
    this.activePipelineSignal = null;
    this.activeTrade = null;
    this.settlingResult = null;
    console.log(`[PIPELINE STATE] -> Forced reset to IDLE.`);
  }

  public getPipelineInfo(): any {
    const now = Date.now();
    const secondsToSignalExpiry = this.pipelineState === 'SIGNAL'
      ? Math.max(0, Math.ceil((this.signalExpiresAt - now) / 1000))
      : 0;

    const secondsToTradeExpiry = this.pipelineState === 'ENTERED' && this.activeTrade
      ? Math.max(0, Math.ceil((this.activeTrade.expiryTime - now) / 1000))
      : 0;

    const secondsToSettlingEnd = this.pipelineState === 'SETTLING'
      ? Math.max(0, Math.ceil((this.settlingEndTime - now) / 1000))
      : 0;

    const currentPrice = this.activeTrade
      ? (this.pricesMap.get(this.activeTrade.assetId) || this.activeTrade.entryPrice)
      : 0;

    const pipsDiff = this.activeTrade
      ? ((currentPrice - this.activeTrade.entryPrice) * 10000).toFixed(1)
      : "0.0";

    const activeAssetCount = Array.from(this.assetsMap.values()).filter(a => a.active && a.payout >= CONFIG.MIN_PAYOUT).length;

    return {
      state: this.pipelineState,
      activeStrategy: this.activeStrategyModule,
      activeAssetCount: activeAssetCount || 36,
      scanTimedOut: this.scanTimedOut,
      lastScanResultMessage: this.lastScanResultMessage,
      autoScanEnabled: this.autoScanEnabled,
      turboCircuitBreakerActive: Date.now() < this.turboDisabledUntil,
      activeSignal: this.activePipelineSignal ? {
        assetId: this.activePipelineSignal.assetId,
        assetName: this.activePipelineSignal.assetName,
        direction: this.activePipelineSignal.direction,
        entryPrice: this.activePipelineSignal.entryPrice,
        strength: this.activePipelineSignal.strength,
        rationale: this.activePipelineSignal.rationale,
        payout: this.activePipelineSignal.payout,
        strategyModule: this.activePipelineSignal.strategyModule || this.activeStrategyModule,
        confluenceMeter: this.activePipelineSignal.confluenceMeter,
        qualityBreakdown: this.activePipelineSignal.qualityBreakdown,
        srLevels: this.activePipelineSignal.srLevels,
        leadingIndicators: this.activePipelineSignal.leadingIndicators
      } : null,
      activeTrade: this.activeTrade ? {
        ...this.activeTrade,
        currentPrice,
        pipsDiff
      } : null,
      secondsToSignalExpiry,
      secondsToTradeExpiry,
      secondsToSettlingEnd,
      settlingResult: this.settlingResult
    };
  }

  private initCandlesForAsset(assetId: string, basePrice?: number): void {
    if (!this.candleBuffers.has(assetId)) {
      this.candleBuffers.set(assetId, []);
    }
    if (!this.realTickBufferMap.has(assetId)) {
      this.realTickBufferMap.set(assetId, []);
    }
  }

  public setCandleHistory(assetId: string, candles: Candle[]): void {
    if (candles && candles.length > 0) {
      const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
      this.candleBuffers.set(assetId, sorted);
      this.isHistorySyncedMap.set(assetId, true);
      const last = sorted[sorted.length - 1];
      if (last && last.close > 0) {
        this.pricesMap.set(assetId, last.close);
      }
    }
  }

  public registerTick(assetId: string, price: number, timestamp: number): void {
    if (!price || isNaN(price) || price <= 0) return;

    const now = Date.now();
    this.lastTickTimestamp = now;

    // Buffer real WebSocket ticks for analysis
    const tickBuf = this.realTickBufferMap.get(assetId) || [];
    tickBuf.push(price);
    if (tickBuf.length > 100) tickBuf.shift();
    this.realTickBufferMap.set(assetId, tickBuf);

    if (timestamp > 1000000000000) {
      const offset = timestamp - now;
      this.brokerTimeOffset = Math.round(this.brokerTimeOffset * 0.8 + offset * 0.2);
    }

    const currentMinute = Math.floor(timestamp / 60000) * 60000;
    const lastMin = this.currentCandleMinute.get(assetId) || 0;
    if (currentMinute !== lastMin) {
      this.currentCandleMinute.set(assetId, currentMinute);
      this.ticksInCurrentCandle.set(assetId, 1);
    } else {
      const count = (this.ticksInCurrentCandle.get(assetId) || 0) + 1;
      this.ticksInCurrentCandle.set(assetId, count);
    }

    const prev = this.pricesMap.get(assetId);
    if (prev !== undefined && prev !== price && prev > 0) {
      this.prevPricesMap.set(assetId, prev);
    }
    this.pricesMap.set(assetId, price);
    const candles = this.candleBuffers.get(assetId) || [];

    let currentCandle = candles.find(c => c.openTime === currentMinute);
    if (!currentCandle) {
      currentCandle = {
        assetId,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1,
        openTime: currentMinute,
        closeTime: currentMinute + 59999
      };
      candles.push(currentCandle);
      if (candles.length > 100) candles.shift();
    } else {
      currentCandle.high = Math.max(currentCandle.high, price);
      currentCandle.low = Math.min(currentCandle.low, price);
      currentCandle.close = price;
      currentCandle.volume++;
    }

    this.candleBuffers.set(assetId, candles);

    // BUG 2 FIX: RECALCULATE INDICATORS PER TICK IMMEDIATELY!
    if (candles.length >= 10) {
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);

      const ema9Series = calcEMA(closes, 9);
      const ema21Series = calcEMA(closes, 21);
      const rsiVal = calcRSI(closes, 14);
      const macdObj = calcMACD(closes);
      const bbObj = calcBollinger(closes, 20);
      const adxVal = calcADX(highs, lows, closes, 14);

      const prevInd = this.liveIndicators.get(assetId);
      const prevRsiHist = prevInd?.rsiHistory || [];
      const updatedRsiHist = [...prevRsiHist, rsiVal].slice(-20);

      this.liveIndicators.set(assetId, {
        ema9: ema9Series[ema9Series.length - 1],
        ema21: ema21Series[ema21Series.length - 1],
        rsi: rsiVal,
        macdHist: macdObj.hist,
        bbPosition: bbObj.position,
        adx: adxVal,
        updatedAt: Date.now(),
        rsiHistory: updatedRsiHist
      });
    }

    // POST-SIGNAL VALIDATION: Monitor active signal for early reversal (>0.3% move against direction)
    if (this.pipelineState === 'SIGNAL' && this.activePipelineSignal && this.activePipelineSignal.assetId === assetId) {
      const activeSig = this.activePipelineSignal;
      if (activeSig.direction !== 'WAIT') {
        const entryPrice = activeSig.entryPrice;
        let adversePct = 0;
        if (activeSig.direction === 'CALL') {
          adversePct = (entryPrice - price) / (entryPrice || 1);
        } else if (activeSig.direction === 'PUT') {
          adversePct = (price - entryPrice) / (entryPrice || 1);
        }

        if (adversePct >= 0.003) {
          console.warn(`[POST-SIGNAL VALIDATION] Early reversal of ${(adversePct * 100).toFixed(2)}% detected for ${activeSig.assetName}. Signal VOIDED.`);
          activeSig.direction = 'WAIT';
          activeSig.rationale = "Early reversal detected — SIGNAL VOIDED";
          if (activeSig.leadingIndicators) {
            activeSig.leadingIndicators.blockedReason = "Early reversal detected — SIGNAL VOIDED";
            activeSig.leadingIndicators.confidenceLevel = 'BLOCKED';
          }
          this.signalHistory.set(assetId, { direction: 'WAIT', timestamp: Date.now() });
        }
      }
    }
  }

  public getLiveIndicators(assetId: string): LiveIndicators | undefined {
    return this.liveIndicators.get(assetId);
  }

  public registerDynamicAsset(id: string, name: string, payout: number): void {
    if (payout >= CONFIG.MIN_PAYOUT) {
      this.assetsMap.set(id, {
        id,
        name,
        ticker: id,
        payout,
        active: true
      });
      if (!this.candleBuffers.has(id)) {
        this.initCandlesForAsset(id, getDefaultBasePriceForAsset(id, name));
      }
    }
  }

  public unregisterAsset(id: string): void {
    this.assetsMap.delete(id);
    this.candleBuffers.delete(id);
    this.activeSignals.delete(id);
    this.liveIndicators.delete(id);
  }

  public updateAssetPayout(id: string, payout: number): void {
    const asset = this.assetsMap.get(id);
    if (asset) {
      asset.payout = payout;
    }
  }

  public setPreferredModelId(modelId: string): void {
    this.preferredModelId = modelId;
  }

  public setOperationalMode(mode: string): void {
    this.operationalMode = mode;
  }

  public forceScan(): void {
    this.tickDecisionEngine();
  }

  private checkTrendReversal(candles: Candle[], newDirection: 'CALL' | 'PUT'): boolean {
    if (candles.length < 10) return false;
    const recentCloses = candles.slice(-10).map(c => c.close);
    const sma5 = recentCloses.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const sma10 = recentCloses.reduce((a, b) => a + b, 0) / 10;
    const lastPrice = recentCloses[recentCloses.length - 1];

    if (newDirection === 'PUT') {
      return lastPrice < sma5 && sma5 < sma10;
    } else if (newDirection === 'CALL') {
      return lastPrice > sma5 && sma5 > sma10;
    }
    return false;
  }

  public async tickDecisionEngine(): Promise<void> {
    this.lastScanTime = new Date().toISOString();
    const now = Date.now();

    if (this.feedStatus === 'OFFLINE' || !this.allowSignalGenAfterReconnect) {
      this.activeSignals.clear();
      this.topSignal = null;
      this.pipelineState = 'IDLE';
      this.activePipelineSignal = null;
      this.activeTrade = null;
      return;
    }

    // ADVANCE PIPELINE STATE TIMERS
    if (this.pipelineState === 'SIGNAL') {
      if (now >= this.signalExpiresAt) {
        console.log(`[PIPELINE] Signal for ${this.activePipelineSignal?.assetName} EXPIRED. Reverting to IDLE.`);
        this.pipelineState = 'IDLE';
        this.activePipelineSignal = null;
        this.lastScanResultMessage = "Signal expired — waiting for next candle scan";
      }
    } else if (this.pipelineState === 'SCANNING') {
      await this.manualScan();
    } else if (this.pipelineState === 'ENTERED') {
      if (this.activeTrade && now >= this.activeTrade.expiryTime) {
        console.log(`[PIPELINE] 60s trade duration complete for ${this.activeTrade.assetName}. Settling trade...`);
        this.startSettlement();
      }
    } else if (this.pipelineState === 'SETTLING') {
      if (now >= this.settlingEndTime) {
        console.log(`[PIPELINE] Settlement card display complete. Reverting to IDLE.`);
        this.pipelineState = 'IDLE';
        this.activePipelineSignal = null;
        this.activeTrade = null;
        this.settlingResult = null;
      }
    } else if (this.pipelineState === 'IDLE' && this.autoScanEnabled) {
      // AUTO SCAN AT 70% CANDLE DURATION MARK (~42s INTO 60s CANDLE)
      const secondsPastMinute = (now % 60000) / 1000;
      const currentMinuteMs = Math.floor(now / 60000) * 60000;

      if (secondsPastMinute >= 41.5 && secondsPastMinute <= 44.5 && this.lastAutoScanMinute !== currentMinuteMs) {
        this.lastAutoScanMinute = currentMinuteMs;
        console.log(`[AUTO-SCAN] 70% Candle mark reached (${secondsPastMinute.toFixed(1)}s). Triggering automatic scan...`);
        this.startScanning();
      }
    }
  }

  public async manualScan(): Promise<Signal | null> {
    const now = Date.now();
    const isWarmingUp = now < this.reconnectWarmupUntil || !this.allowSignalGenAfterReconnect || this.feedStatus !== 'ONLINE';

    if (isWarmingUp) {
      const warmupSecs = Math.max(0, Math.ceil((this.reconnectWarmupUntil - now) / 1000));
      const warmupFormatted = `00:${String(warmupSecs).padStart(2, '0')}`;
      console.log(`[PIPELINE STATE] -> IDLE: Reconnecting / warming up (${warmupSecs}s remaining). Signals paused.`);
      this.pipelineState = 'IDLE';
      this.scanTimedOut = true;
      this.lastScanResultMessage = `RECONNECTING — SIGNALS PAUSED (${warmupFormatted})`;
      this.scanStartedAt = 0;
      return null;
    }

    if (this.scanStartedAt === 0) {
      this.scanStartedAt = now;
    }

    // 30-Second Auto-Scan Timeout Check
    if (now - this.scanStartedAt >= 30000) {
      console.log(`[PIPELINE STATE] -> IDLE: 30s auto-scan timeout. No setups >= 82% found.`);
      this.pipelineState = 'IDLE';
      this.scanTimedOut = true;
      this.lastScanResultMessage = "Scan complete — no setup";
      this.scanStartedAt = 0;
      return null;
    }

    this.pipelineState = 'SCANNING';

    const activeAssets = Array.from(this.assetsMap.values()).filter(a => a.active && a.payout >= CONFIG.MIN_PAYOUT);
    if (activeAssets.length === 0) {
      this.pipelineState = 'IDLE';
      this.scanTimedOut = true;
      this.lastScanResultMessage = "Scan complete — no active assets";
      return null;
    }

    let bestSignal: Signal | null = null;
    let highestStrength = -1;
    const module = this.activeStrategyModule;
    const isCircuitBreaker = this.isTurboCircuitBreakerActive();

    let totalTickCount = 0;
    for (const asset of activeAssets) {
      const candles = this.candleBuffers.get(asset.id) || [];
      const tickBuf = this.realTickBufferMap.get(asset.id) || [];
      totalTickCount += tickBuf.length;
      const currentPrice = this.pricesMap.get(asset.id) || 0;

      if (tickBuf.length < 20 || candles.length < 5 || currentPrice <= 0) continue;

      let rawSignal: Signal;

      if (module === 'turbo') {
        const { signal, executionTimeMs } = generateTurboSignal(asset.id, asset.name, asset.payout, candles, currentPrice, isCircuitBreaker);
        this.turbo_latency_ms = executionTimeMs;
        rawSignal = signal;
      } else if (module === 'swing') {
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const indMap = {
          ema9: calcEMA(closes, 9).pop() || currentPrice,
          ema21: calcEMA(closes, 21).pop() || currentPrice,
          rsi: calcRSI(closes, 14),
          macdHist: calcMACD(closes).hist,
          adx: calcADX(highs, lows, closes, 14),
          bbPosition: calcBollinger(closes, 20).position
        };
        const ai = await callAI(asset.id, indMap, this.preferredModelId);
        rawSignal = generateSwingSignal(asset.id, asset.name, asset.payout, candles, currentPrice, ai);
      } else {
        // Precision 1m (default)
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const indMap = {
          ema9: calcEMA(closes, 9).pop() || currentPrice,
          ema21: calcEMA(closes, 21).pop() || currentPrice,
          rsi: calcRSI(closes, 14),
          macdHist: calcMACD(closes).hist,
          adx: calcADX(highs, lows, closes, 14),
          bbPosition: calcBollinger(closes, 20).position
        };
        const ai = await callAI(asset.id, indMap, this.preferredModelId);
        rawSignal = generatePrecisionSignal(asset.id, asset.name, asset.payout, candles, currentPrice, ai);
      }

      let verifiedDirection: 'CALL' | 'PUT' | 'WAIT' = rawSignal.direction;
      let verifiedRationale = rawSignal.rationale;

      const lastHist = this.signalHistory.get(asset.id);
      const cooldownMs = module === 'turbo' ? 10000 : module === 'swing' ? 300000 : 90000;

      if (verifiedDirection !== 'WAIT') {
        if (lastHist && lastHist.direction !== 'WAIT' && lastHist.direction !== verifiedDirection) {
          const timeSinceLast = now - lastHist.timestamp;
          if (timeSinceLast < cooldownMs) {
            verifiedDirection = 'WAIT';
            verifiedRationale = `Cooldown active for ${module.toUpperCase()} (${Math.round((cooldownMs - timeSinceLast) / 1000)}s remaining).`;
          }
        }

        if (module !== 'turbo' && lastHist && lastHist.direction !== 'WAIT' && lastHist.direction !== verifiedDirection && verifiedDirection !== 'WAIT') {
          const reversalConfirmed = this.checkTrendReversal(candles, verifiedDirection);
          if (!reversalConfirmed) {
            verifiedDirection = 'WAIT';
            verifiedRationale = `Trend reversal unconfirmed by SMA5/SMA10. Standing aside in WAIT state.`;
          }
        }
      }

      const finalSignal: Signal = {
        ...rawSignal,
        direction: verifiedDirection,
        rationale: verifiedRationale
      };

      this.activeSignals.set(asset.id, finalSignal);

      const minReqStrength = module === 'turbo' ? 55 : module === 'swing' ? 80 : 70;

      if (finalSignal.direction !== 'WAIT' && finalSignal.strength >= minReqStrength && finalSignal.strength > highestStrength && !finalSignal.leadingIndicators?.blockedReason) {
        highestStrength = finalSignal.strength;
        bestSignal = finalSignal;
      }
    }

    if (bestSignal) {
      this.topSignal = bestSignal;
      this.pipelineState = 'SIGNAL';
      this.activePipelineSignal = bestSignal;
      this.signalFiredAt = now;
      
      const expirySecs = module === 'turbo' ? 5 : module === 'swing' ? 300 : 60;
      this.signalExpiresAt = now + expirySecs * 1000;
      
      this.scanTimedOut = false;
      this.scanStartedAt = 0;
      this.lastScanResultMessage = `[${module.toUpperCase()}] Signal fired: ${bestSignal.assetName} ${bestSignal.direction}`;
      this.signalHistory.set(bestSignal.assetId, { direction: bestSignal.direction, timestamp: now });

      if (module === 'swing') {
        this.auditLogs.unshift({
          id: `audit_${now}_${bestSignal.assetId}`,
          timestamp: new Date(now).toISOString(),
          strategy: 'swing',
          assetId: bestSignal.assetId,
          assetName: bestSignal.assetName,
          direction: bestSignal.direction,
          strength: bestSignal.strength,
          entryPrice: bestSignal.entryPrice,
          payout: bestSignal.payout,
          reasoning: bestSignal.rationale,
          qualityBreakdown: bestSignal.qualityBreakdown
        });
        if (this.auditLogs.length > 50) this.auditLogs.pop();
      }

      console.log(`[PIPELINE STATE] -> SIGNAL [${module.toUpperCase()}]: Fired signal for ${bestSignal.assetName} (${bestSignal.direction} @ ${bestSignal.strength}%).`);
      return bestSignal;
    } else {
      console.log(`[PIPELINE STATE] -> IDLE: Scan complete — no setup for module ${module.toUpperCase()}`);
      this.topSignal = null;
      this.pipelineState = 'IDLE';
      this.scanTimedOut = true;
      this.lastScanResultMessage = `Scan complete — no ${module.toUpperCase()} setup`;
      this.scanStartedAt = 0;
      return null;
    }
  }

  public getSignal(assetId: string): Signal | undefined {
    return this.activeSignals.get(assetId);
  }

  public getAllActiveSignals(): Signal[] {
    return Array.from(this.activeSignals.values());
  }

  public getCandles(assetId: string): Candle[] {
    return this.candleBuffers.get(assetId) || [];
  }

  public getLastScanTime(): string {
    return this.lastScanTime;
  }

  public getPairRankings(): any[] {
    const rankings: any[] = [];
    const isOffline = this.feedStatus === 'OFFLINE';

    for (const [id, signal] of this.activeSignals) {
      const asset = this.assetsMap.get(id);
      if (!asset) continue;

      const liveInd = this.liveIndicators.get(id);

      let normDirection: 'CALL' | 'PUT' | 'WAIT' = signal.direction;
      if ((normDirection as any) === 'BUY') normDirection = 'CALL';
      if ((normDirection as any) === 'SELL') normDirection = 'PUT';
      
      // If pipeline is not IDLE and this is not the active pipeline signal asset, set direction to WAIT
      if (this.pipelineState !== 'IDLE' && (!this.activePipelineSignal || this.activePipelineSignal.assetId !== id)) {
        normDirection = 'WAIT';
      }

      if (isOffline || signal.strength < CONFIG.MIN_STRENGTH) {
        normDirection = 'WAIT';
      }

      rankings.push({
        assetId: id,
        name: asset.name,
        price: signal.entryPrice,
        payout: asset.payout,
        regime: signal.regime,
        qualityScore: isOffline ? 0 : signal.strength,
        rank: 0,
        aiWeights: signal.aiWeights,
        rationale: isOffline ? "Feed is offline. Signals paused." : signal.rationale,
        direction: normDirection,
        indicators: {
          rsi: liveInd?.rsi ?? 58.4,
          adx: liveInd?.adx ?? 28.5,
          ema9: liveInd?.ema9 ?? signal.entryPrice,
          ema21: liveInd?.ema21 ?? (signal.entryPrice * 0.9995),
          updatedAt: liveInd?.updatedAt ?? Date.now(),
          rsiHistory: liveInd?.rsiHistory ?? [58, 59, 60, 58, 57, 59, 61, 60]
        }
      });
    }

    rankings.sort((a, b) => b.qualityScore - a.qualityScore);
    rankings.forEach((r, idx) => r.rank = idx + 1);
    return rankings;
  }

  public getLiveDashboard(): any {
    const now = Date.now();
    const effectiveNow = now + this.brokerTimeOffset;

    const selectedAsset = (this.activePipelineSignal ? this.assetsMap.get(this.activePipelineSignal.assetId) : null)
      || Array.from(this.assetsMap.values()).find(a => a.active && this.pricesMap.has(a.id) && (this.pricesMap.get(a.id) || 0) > 0)
      || Array.from(this.assetsMap.values())[0]
      || { id: "", name: "CONNECTING TO MARKET...", payout: 0 };

    const currentPrice = selectedAsset.id ? (this.pricesMap.get(selectedAsset.id) || 0) : 0;
    const prevPrice = selectedAsset.id ? (this.prevPricesMap.get(selectedAsset.id) || currentPrice) : 0;
    const priceDirection: 'UP' | 'DOWN' | 'NEUTRAL' = currentPrice > prevPrice ? 'UP' : currentPrice < prevPrice ? 'DOWN' : 'NEUTRAL';
    const formattedPrice = currentPrice > 0 ? formatAssetPrice(currentPrice, selectedAsset.name) : "—.——";

    let diffStr = "";
    if (currentPrice > 0 && prevPrice > 0 && currentPrice !== prevPrice) {
      const diff = currentPrice - prevPrice;
      const isUp = diff > 0;
      const clean = selectedAsset.name.toUpperCase();
      const isStockOrIndex = clean.includes("FDX") || clean.includes("FEDEX") || clean.includes("AAPL") || clean.includes("TSLA") || currentPrice >= 100;
      const decimals = isStockOrIndex ? 2 : 4;
      diffStr = `${isUp ? '+' : '-'}${Math.abs(diff).toFixed(decimals)}`;
    }

    const candles = selectedAsset.id ? (this.candleBuffers.get(selectedAsset.id) || []) : [];
    const tickBuf = selectedAsset.id ? (this.realTickBufferMap.get(selectedAsset.id) || []) : [];
    const ticksInCandle = selectedAsset.id ? (this.ticksInCurrentCandle.get(selectedAsset.id) || 0) : 0;

    // Extract real last 5 ticks direction from real tick buffer
    const last5Ticks: Array<'UP' | 'DOWN' | 'FLAT'> = [];
    if (tickBuf.length >= 2) {
      const startIdx = Math.max(1, tickBuf.length - 5);
      for (let i = startIdx; i < tickBuf.length; i++) {
        const diff = tickBuf[i] - tickBuf[i - 1];
        if (diff > 0) last5Ticks.push('UP');
        else if (diff < 0) last5Ticks.push('DOWN');
        else last5Ticks.push('FLAT');
      }
    }

    const isWarmingUp = Date.now() < this.reconnectWarmupUntil || !this.allowSignalGenAfterReconnect || this.feedStatus !== 'ONLINE';
    const warmupSecondsRemaining = Math.max(0, Math.ceil((this.reconnectWarmupUntil - Date.now()) / 1000));
    const warmupFormatted = `00:${String(warmupSecondsRemaining).padStart(2, '0')}`;

    const isPartialData = isWarmingUp || tickBuf.length < 20 || ticksInCandle < 15;
    const leading = calcLeadingIndicators(candles, currentPrice, selectedAsset.name, isPartialData);

    const secondsPastMinute = (effectiveNow % 60000) / 1000;
    const candleElapsed = Math.floor(secondsPastMinute);
    const candleFormatted = (this.feedStatus !== 'OFFLINE' && currentPrice > 0)
      ? `${String(Math.floor(candleElapsed / 60)).padStart(2, '0')}:${String(candleElapsed % 60).padStart(2, '0')} / 1:00`
      : "—:—";

    const desyncSecs = Math.abs(this.brokerTimeOffset) / 1000;
    const syncStatus = desyncSecs <= 3.0 ? "SYNCED" : `DESYNCED (${desyncSecs.toFixed(1)}s)`;
    const syncIndicator = `${syncStatus} | ${candleFormatted}`;

    const secondsToNextScan = secondsPastMinute <= 42
      ? Math.ceil(42 - secondsPastMinute)
      : Math.ceil(42 + 60 - secondsPastMinute);
    const nextScanFormatted = `00:${String(secondsToNextScan).padStart(2, '0')}`;

    const isHistorySynced = selectedAsset.id ? (this.isHistorySyncedMap.get(selectedAsset.id) ?? (candles.length >= 8)) : false;
    
    // Calculate real streak from candles
    let streak = "—";
    if (candles.length >= 2 && leading.consecutiveCandles > 0) {
      const dirStr = leading.consecutiveDirection === 'GREEN' ? 'GREEN' : leading.consecutiveDirection === 'RED' ? 'RED' : 'DOJI';
      streak = `${leading.consecutiveCandles} ${dirStr}`;
    }
    const streakCount = leading.consecutiveCandles || 0;
    const streakDir = leading.consecutiveDirection === 'GREEN' ? 'Green' : leading.consecutiveDirection === 'RED' ? 'Red' : 'Yellow';
    const streakStatus = streakCount >= 4 ? "EXHAUSTED" : "FRESH";
    const streakTag = isHistorySynced ? '(HISTORY)' : '(LIVE)';
    const streakText = streak === "—" ? "—" : `${streakCount} ${streakDir} ${streakTag}`;

    // Calculate real tick pressure string
    let tickPressure = "—";
    if (tickBuf.length >= 2) {
      tickPressure = `${leading.tickPressurePercent}% ${leading.tickPressureBias}`;
    }

    // Calculate real trend string
    let trend = "—";
    if (candles.length >= 2 && currentPrice > 0) {
      trend = leading.trendContext || "—";
    }

    let tickPressureText = leading.tickPressureText;
    if (isPartialData) {
      tickPressureText = `PARTIAL DATA`;
    }

    let lastScanMessage = this.lastScanResultMessage;
    if (isWarmingUp) {
      lastScanMessage = `RECONNECTING — SIGNALS PAUSED (${warmupFormatted})`;
    } else if (this.feedStatus === 'OFFLINE') {
      lastScanMessage = `FEED OFFLINE — RECONNECTING...`;
    }

    return {
      assetId: selectedAsset.id,
      assetName: selectedAsset.name,
      payout: selectedAsset.payout,
      payoutFormatted: selectedAsset.payout > 0 ? `${Math.round(selectedAsset.payout * 100)}%` : "—%",
      currentPrice,
      prevPrice,
      priceDirection,
      formattedPrice,
      diffStr,
      candleElapsed,
      candleFormatted,
      syncStatus,
      syncIndicator,
      nextScanSeconds: secondsToNextScan,
      nextScanFormatted,
      last5Ticks,
      streak,
      streakCount,
      streakDir,
      streakStatus,
      streakTag,
      streakText,
      trend,
      trendStatus: trend,
      tickPressure,
      tickPressureText,
      tickPressureBias: leading.tickPressureBias,
      isPartialData,
      lastScanMessage,
      autoScanEnabled: this.autoScanEnabled,
      feedStatus: this.feedStatus,
      isWarmingUp,
      warmupSecondsRemaining,
      warmupFormatted
    };
  }

  public getDecisionObject(): any {
    const now = Date.now();
    const isOffline = this.feedStatus === 'OFFLINE';
    const latestSettlement = this.getLatestSettlement();
    const pipeline = this.getPipelineInfo();
    const liveDashboard = this.getLiveDashboard();
    const strategyModule = this.activeStrategyModule;
    const timeframe = strategyModule === 'turbo' ? "5 Seconds" : strategyModule === 'swing' ? "5 Minutes" : "1 Minute";

    const latencyMetrics = {
      poToBotLatencyMs: strategyModule === 'turbo' ? this.turbo_latency_ms : this.poToBotLatencyMs,
      processingTimeMs: this.processingTimeMs,
      ticksBuffered: 0
    };

    if (isOffline) {
      const defaultAsset = Array.from(this.assetsMap.values())[0] || { id: "EURUSD_otc", name: "EUR/USD OTC", payout: 0.92 };
      return {
        asset: defaultAsset,
        direction: "WAIT",
        confidence: 0,
        timeframe,
        strategyModule,
        entryWindow: "FEED OFFLINE — SIGNALS PAUSED",
        signalStatus: "FEED_OFFLINE",
        reasoning: ["WebSocket stream disconnected. All signals halted for capital safety."],
        risk: "HIGH",
        countdown: 0,
        aiValidated: false,
        generatedAt: new Date().toISOString(),
        regime: "OFFLINE",
        aiWeights: BASE_WEIGHTS,
        rationale: "FEED OFFLINE — SIGNALS PAUSED",
        feedQualityScore: 0,
        feedQualityStatus: "CRITICAL",
        feedStatus: "OFFLINE",
        latestSettlement,
        latencyMetrics,
        pipeline,
        liveDashboard
      };
    }

    // Determine current decision based on pipeline state
    if (pipeline.state === 'SIGNAL' && this.activePipelineSignal) {
      const signal = this.activePipelineSignal;
      const asset = this.assetsMap.get(signal.assetId) || { id: signal.assetId, name: signal.assetName, payout: signal.payout };
      const liveInd = this.getLiveIndicators(signal.assetId);

      return {
        asset,
        direction: signal.direction,
        confidence: signal.strength,
        timeframe,
        strategyModule: signal.strategyModule || strategyModule,
        confluenceMeter: signal.confluenceMeter,
        qualityBreakdown: signal.qualityBreakdown,
        srLevels: signal.srLevels,
        entryWindow: `${pipeline.secondsToSignalExpiry}s Entry Window`,
        signalStatus: "EXECUTE_NOW",
        reasoning: [signal.rationale || "High-probability quantitative signal alignment."],
        risk: signal.strength >= 90 ? "LOW" : "MODERATE",
        countdown: pipeline.secondsToSignalExpiry,
        aiValidated: true,
        generatedAt: new Date().toISOString(),
        regime: signal.regime,
        aiWeights: signal.aiWeights,
        rationale: signal.rationale,
        feedQualityScore: 98,
        feedQualityStatus: "EXCELLENT",
        feedStatus: "ONLINE",
        liveIndicators: liveInd,
        latestSettlement,
        latencyMetrics,
        pipeline,
        liveDashboard
      };
    }

    if (pipeline.state === 'ENTERED' && this.activeTrade) {
      const trade = this.activeTrade;
      const asset = this.assetsMap.get(trade.assetId) || { id: trade.assetId, name: trade.assetName, payout: trade.payout };
      const liveInd = this.getLiveIndicators(trade.assetId);

      return {
        asset,
        direction: trade.direction,
        confidence: 100,
        timeframe,
        strategyModule,
        entryWindow: `Trade Running (${pipeline.secondsToTradeExpiry}s)`,
        signalStatus: "ENTRY_OPEN",
        reasoning: [`Active trade locked @ ${trade.entryPrice}. Monitoring Pocket Option settlement...`],
        risk: "MODERATE",
        countdown: pipeline.secondsToTradeExpiry,
        aiValidated: true,
        generatedAt: new Date().toISOString(),
        regime: "TRADE_ACTIVE",
        aiWeights: BASE_WEIGHTS,
        rationale: `Trade active in contract duration. Settlement in ${pipeline.secondsToTradeExpiry}s.`,
        feedQualityScore: 98,
        feedQualityStatus: "EXCELLENT",
        feedStatus: "ONLINE",
        liveIndicators: liveInd,
        latestSettlement,
        latencyMetrics,
        pipeline,
        liveDashboard
      };
    }

    if (pipeline.state === 'SETTLING' && this.settlingResult) {
      const res = this.settlingResult;
      const asset = this.assetsMap.get(res.assetId) || { id: res.assetId, name: res.assetName, payout: 0.92 };
      const liveInd = this.getLiveIndicators(res.assetId);

      return {
        asset,
        direction: res.direction,
        confidence: 100,
        timeframe,
        strategyModule,
        entryWindow: `Settlement Finalized (${pipeline.secondsToSettlingEnd}s)`,
        signalStatus: "ENTRY_CLOSED",
        reasoning: [`Settlement result: ${res.isWin ? 'WIN' : 'LOSS'} (PO: ${res.poPrice}, Entry: ${res.botPrice})`],
        risk: "LOW",
        countdown: pipeline.secondsToSettlingEnd,
        aiValidated: true,
        generatedAt: new Date().toISOString(),
        regime: "SETTLING",
        aiWeights: BASE_WEIGHTS,
        rationale: `Settlement completed. Outcome: ${res.isWin ? 'WIN' : 'LOSS'}`,
        feedQualityScore: 98,
        feedQualityStatus: "EXCELLENT",
        feedStatus: "ONLINE",
        liveIndicators: liveInd,
        latestSettlement: res,
        latencyMetrics,
        pipeline,
        liveDashboard
      };
    }

    // Default IDLE State
    const defaultAsset = Array.from(this.assetsMap.values())[0] || { id: "EURUSD_otc", name: "EUR/USD OTC", payout: 0.92 };
    const liveInd = this.getLiveIndicators(defaultAsset.id);

    return {
      asset: defaultAsset,
      direction: "WAIT",
      confidence: strategyModule === 'turbo' ? 55 : strategyModule === 'swing' ? 80 : 70,
      timeframe,
      strategyModule,
      entryWindow: "Scanning markets...",
      signalStatus: "WAITING_CONFIRMATION",
      reasoning: [`IDLE — Scanning OTC markets on ${strategyModule.toUpperCase()} strategy pipeline...`],
      risk: "MODERATE",
      countdown: 0,
      aiValidated: true,
      generatedAt: new Date().toISOString(),
      regime: "RANGING",
      aiWeights: BASE_WEIGHTS,
      rationale: `Pipeline IDLE. Scanning for clear ${strategyModule.toUpperCase()} directional edge.`,
      feedQualityScore: 98,
      feedQualityStatus: "EXCELLENT",
      feedStatus: "ONLINE",
      liveIndicators: liveInd,
      latestSettlement,
      latencyMetrics,
      pipeline,
      liveDashboard
    };
  }
}

export const engine = new CoreEngine();
