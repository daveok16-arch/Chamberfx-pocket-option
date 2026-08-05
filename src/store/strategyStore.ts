import { create } from 'zustand';
import { StrategyId, STRATEGIES, StrategyConfig } from '../config/strategies';
import { DecisionObject } from '../types';

export interface StrategyStoreState {
  activeStrategy: StrategyId;
  config: StrategyConfig;
  isScanning: boolean;
  lastScanTime: number;
  circuitBreakerActive: boolean;
  turboLatencyMs: number;
  decision: DecisionObject | null;
  
  // Actions
  setStrategy: (strategy: StrategyId) => Promise<void>;
  triggerScan: () => Promise<void>;
  stopScan: () => Promise<void>;
  setDecision: (decision: DecisionObject) => void;
}

export const useStrategyStore = create<StrategyStoreState>((set, get) => ({
  activeStrategy: 'precision',
  config: STRATEGIES['precision'],
  isScanning: false,
  lastScanTime: 0,
  circuitBreakerActive: false,
  turboLatencyMs: 24,
  decision: null,

  setStrategy: async (strategyId: StrategyId) => {
    if (!STRATEGIES[strategyId]) return;
    
    // Optimistically update store
    const config = STRATEGIES[strategyId];
    set({
      activeStrategy: strategyId,
      config,
      isScanning: false
    });

    try {
      const res = await fetch('/api/strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: strategyId })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          set({
            circuitBreakerActive: data.turboCircuitBreakerActive ?? false,
            turboLatencyMs: data.turboLatencyMs ?? 24
          });
        }
      }
    } catch (err) {
      console.error('[STRATEGY_STORE] Failed to switch strategy module:', err);
    }
  },

  triggerScan: async () => {
    const { activeStrategy } = get();
    set({ isScanning: true, lastScanTime: Date.now() });

    try {
      const res = await fetch('/api/scan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: activeStrategy })
      });
      if (!res.ok) {
        console.warn('[STRATEGY_STORE] Scan start response not OK:', res.status);
      }
    } catch (err) {
      console.error('[STRATEGY_STORE] Failed to start scan:', err);
      set({ isScanning: false });
    }
  },

  stopScan: async () => {
    set({ isScanning: false });
    try {
      await fetch('/api/scan/stop', { method: 'POST' });
    } catch (err) {
      console.error('[STRATEGY_STORE] Failed to stop scan:', err);
    }
  },

  setDecision: (decision: DecisionObject) => {
    const pipeline = (decision as any).pipeline;
    const activeStrat = (decision.strategyModule || pipeline?.activeStrategy || get().activeStrategy) as StrategyId;
    const config = STRATEGIES[activeStrat] || STRATEGIES.precision;
    
    set({
      decision,
      activeStrategy: activeStrat,
      config,
      isScanning: pipeline?.state === 'SCANNING',
      circuitBreakerActive: decision.turboCircuitBreakerActive ?? pipeline?.turboCircuitBreakerActive ?? false,
      turboLatencyMs: decision.latencyMetrics?.poToBotLatencyMs || 24
    });
  }
}));
