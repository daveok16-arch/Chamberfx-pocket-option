import { StrategyModuleId } from "../types";

export type StrategyId = Exclude<StrategyModuleId, "turbo">;

export interface StrategyConfig {
  id: StrategyId;
  label: string;
  risk: 'HIGH' | 'MODERATE' | 'LOW';
  color: string;
  badgeGradient: string;
  timeframeMs: number;
  timeframeLabel: string;
  minStrength: number;
  confluenceTarget: number;
  cooldownMs: number;
  aiEnabled: boolean;
  aiConfidenceMin: number;
  scanButtonLabel: string;
  autoScanIntervalMs: number;
  description: string;
  parameters: {
    tickWindow?: number;
    momentumThreshold?: number;
    volatilityMin?: number;
    maxConcurrent?: number;
    circuitBreakerLosses?: number;
    circuitBreakerCooldownMs?: number;
    streakMin?: number;
    tickPressureMin: number;
    candleEntryWindow?: { min: number; max: number };
    trendRequired?: boolean;
    trendConfirmationMin?: number;
    srProximityMax?: number;
    streakMinReversal?: number;
    streakMinMomentum?: number;
  };
  ui: {
    showTickBurst: boolean;
    showCandleTimer: boolean;
    showStreak: boolean;
    showSR: boolean;
    showConfluenceMeter: boolean;
    showLatency: boolean;
    signalBadge: string;
  };
}

export const STRATEGIES: Record<string, StrategyConfig> = {
  precision: {
    id: 'precision',
    label: 'PRECISION',
    risk: 'MODERATE',
    color: '#4488FF',
    badgeGradient: 'linear-gradient(135deg, #4488FF, #2266DD)',
    timeframeMs: 60000,
    timeframeLabel: '1 Minute',
    minStrength: 70,
    confluenceTarget: 3,
    cooldownMs: 90000,
    aiEnabled: true,
    aiConfidenceMin: 75,
    scanButtonLabel: 'SCAN',
    autoScanIntervalMs: 60000,
    description: '3+ confluence requirement, 90s cooldown, 75%+ AI confidence.',
    parameters: {
      streakMin: 2,
      tickPressureMin: 65,
      candleEntryWindow: { min: 10, max: 50 },
      trendRequired: true
    },
    ui: {
      showTickBurst: false,
      showCandleTimer: true,
      showStreak: true,
      showSR: false,
      showConfluenceMeter: true,
      showLatency: false,
      signalBadge: '1M'
    }
  },
  swing: {
    id: 'swing',
    label: 'SWING',
    risk: 'LOW',
    color: '#FFAA00',
    badgeGradient: 'linear-gradient(135deg, #FFAA00, #DD8800)',
    timeframeMs: 300000,
    timeframeLabel: '5 Minutes',
    minStrength: 80,
    confluenceTarget: 4,
    cooldownMs: 300000,
    aiEnabled: true,
    aiConfidenceMin: 85,
    scanButtonLabel: 'SCAN',
    autoScanIntervalMs: 300000,
    description: 'Sustained trend & S/R level bounce. 85%+ AI reasoning.',
    parameters: {
      trendConfirmationMin: 180000,
      srProximityMax: 0.05,
      streakMinReversal: 4,
      streakMinMomentum: 5,
      tickPressureMin: 70
    },
    ui: {
      showTickBurst: false,
      showCandleTimer: true,
      showStreak: true,
      showSR: true,
      showConfluenceMeter: true,
      showLatency: false,
      signalBadge: '5M'
    }
  }
};
