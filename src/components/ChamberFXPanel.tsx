import React, { useState, useEffect, useRef } from "react";
import { DecisionObject } from "../types";
import { StrategySelector } from "./StrategySelector";
import { STRATEGIES, StrategyId } from "../config/strategies";
import { useStrategyStore } from "../store/strategyStore";

interface ChamberFXPanelProps {
  decision: DecisionObject;
  onEnterTrade?: () => void;
  onRefreshState?: () => void;
  onToggleAutoScan?: () => void;
  autoScanEnabled?: boolean;
}

export const ChamberFXPanel: React.FC<ChamberFXPanelProps> = ({
  decision,
  onEnterTrade,
  onRefreshState,
  onToggleAutoScan,
  autoScanEnabled = true
}) => {
  const store = useStrategyStore();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const prevSignalStateRef = useRef<string | null>(null);

  const pipeline = (decision as any).pipeline || {
    state: "IDLE",
    activeStrategy: "precision",
    activeAssetCount: 36,
    scanTimedOut: false,
    secondsToSignalExpiry: 0,
    secondsToTradeExpiry: 0,
    lastScanResultMessage: "Auto-scan active"
  };

  const activeStrategy: StrategyId = (decision.strategyModule || pipeline.activeStrategy || store.activeStrategy || "precision") as StrategyId;
  const config = STRATEGIES[activeStrategy] || STRATEGIES.precision;

  const dashboard = (decision as any).liveDashboard || {
    assetId: "",
    assetName: "CONNECTING TO MARKET...",
    currentPrice: 0,
    formattedPrice: "—.——",
    diffStr: "",
    payout: 0,
    payoutFormatted: "—%",
    candleFormatted: "—:—",
    nextScanFormatted: "—s",
    trendStatus: "—",
    trend: "—",
    tickPressure: "—",
    streak: "—",
    last5Ticks: [],
    tickPressureBias: "WAIT",
    tickPressureText: "Awaiting Ticks",
    autoScanEnabled: true,
    lastScanMessage: "Connecting to Pocket Option..."
  };

  const state = pipeline.state || "IDLE";
  const activeSignal = pipeline.activeSignal;
  const secondsToSignalExpiry = pipeline.secondsToSignalExpiry || 0;

  const qualityScore = decision.qualityBreakdown?.totalScore ?? (activeSignal?.strength || config.minStrength || 84);

  // Entry expiry progress
  const maxEntrySeconds = 30;
  const remainingSeconds = secondsToSignalExpiry > 0 ? secondsToSignalExpiry : 22;
  const entryWindowPercent = Math.max(0, Math.min(100, (remainingSeconds / maxEntrySeconds) * 100));
  const entryBarColor = entryWindowPercent > 50 ? "#00c853" : entryWindowPercent > 20 ? "#ffaa00" : "#ff1744";

  // Confluence status
  const trendMet = (decision.qualityBreakdown?.trendStructure ?? 25) >= 15;
  const srMet = (decision.qualityBreakdown?.srProximity ?? 25) >= 15;
  const ticksMet = (decision.qualityBreakdown?.tickPressure ?? 25) >= 15;
  const aiMet = config.aiEnabled;

  // Sound / Vibration feedback trigger when Signal fires
  useEffect(() => {
    if (state === "SIGNAL" && prevSignalStateRef.current !== "SIGNAL") {
      if (typeof window !== "undefined" && "navigator" in window && navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
      }
    }
    prevSignalStateRef.current = state;
  }, [state]);

  const handleSelectStrategy = async (strategy: StrategyId) => {
    setIsSubmitting(true);
    try {
      await store.setStrategy(strategy);
      if (onRefreshState) onRefreshState();
    } catch (err) {
      console.error("Failed to set strategy module", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartScan = async () => {
    setIsSubmitting(true);
    try {
      await store.triggerScan();
      if (onRefreshState) onRefreshState();
    } catch (err) {
      console.error("Failed to start scan", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStopScan = async () => {
    setIsSubmitting(true);
    try {
      await store.stopScan();
      if (onRefreshState) onRefreshState();
    } catch (err) {
      console.error("Failed to stop scan", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnterTradeClick = async () => {
    if (onEnterTrade) {
      setIsSubmitting(true);
      try {
        await onEnterTrade();
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const isCall = activeSignal?.direction === 'CALL';

  return (
    <div className="w-full h-full bg-[#000000] text-white font-sans p-3 sm:p-4 flex flex-col justify-between select-none overflow-hidden gap-3">
      
      {/* 1. HEADER (40px height) */}
      <div className="flex items-center justify-between pb-2 px-1 border-b border-[#1A1A1A] w-full shrink-0 h-10">
        <div className="flex items-center gap-2.5">
          <h1 className="text-lg font-black tracking-tight text-white font-sans flex items-center gap-2">
            CHAMBER FX
          </h1>
          <span
            className="text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider font-mono"
            style={{ background: config.badgeGradient, color: "#FFFFFF" }}
          >
            {config.ui.signalBadge}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_#10B981]" />
          <span className="text-emerald-400 font-bold text-xs tracking-wider">ONLINE</span>
        </div>
      </div>

      {/* 2. STRATEGY SELECTOR */}
      <div className="w-full shrink-0">
        <StrategySelector
          currentStrategy={activeStrategy}
          onSelectStrategy={handleSelectStrategy}
          disabled={isSubmitting}
        />
      </div>

      {/* 3. SIGNAL CARD AREA */}
      <div className="flex-1 min-h-0 w-full overflow-hidden flex flex-col">
        <div 
          className="w-full h-full bg-[#0A0A0A] border border-[#1A1A1A] rounded-2xl p-5 sm:p-6 flex flex-col gap-4 shadow-2xl relative transition-all overflow-y-auto justify-center"
          style={{
            borderLeftWidth: '5px',
            borderLeftColor: state === 'SIGNAL' && activeSignal ? (isCall ? '#00c853' : '#ff1744') : '#1A1A1A'
          }}
        >
          {state === "SIGNAL" && activeSignal ? (
            <>
              {/* Row 1: Direction + Strength Badge + Payout */}
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3.5">
                  <span 
                    className="text-4xl sm:text-5xl font-black tracking-wide font-sans leading-none"
                    style={{ color: isCall ? '#00c853' : '#ff1744' }}
                  >
                    {isCall ? 'CALL' : 'PUT'}
                  </span>
                  <span 
                    className="text-xs px-3 py-1.5 rounded-md font-bold uppercase tracking-wider font-mono text-black leading-none"
                    style={{ backgroundColor: isCall ? '#00c853' : '#ff1744' }}
                  >
                    [{activeSignal.strength}% STRENGTH]
                  </span>
                </div>
                <div className="font-mono text-base sm:text-lg font-black text-emerald-400 bg-emerald-950/40 px-3 py-1 rounded-lg border border-emerald-800/50">
                  {dashboard.payoutFormatted || "—%"} PO
                </div>
              </div>

              {/* Row 2: Asset + Timeframe */}
              <div className="text-lg font-mono text-neutral-200 flex items-center gap-2.5 leading-none shrink-0 border-t border-[#1a1a1a] pt-3">
                <span className="font-bold text-white text-lg">{activeSignal.assetName || dashboard.assetName || "CONNECTING TO MARKET..."}</span>
                <span className="text-[#444]">|</span>
                <span className="text-amber-400 font-bold">{activeSignal.timeframe || config.timeframeLabel}</span>
              </div>

              {/* Row 3: Large Live Price */}
              <div className="flex items-baseline justify-between font-mono shrink-0 bg-[#121212] p-4 rounded-xl border border-[#1A1A1A] min-h-[70px]">
                <div className="flex items-center gap-3">
                  <span className={`text-2xl sm:text-3xl font-black tracking-wider leading-none ${dashboard.feedStatus === 'OFFLINE' ? 'text-neutral-500' : 'text-white'}`}>
                    {dashboard.formattedPrice || "—.——"}
                  </span>
                  {dashboard.feedStatus === 'OFFLINE' && dashboard.currentPrice > 0 && (
                    <span className="text-xs bg-amber-950/80 text-amber-400 px-2 py-0.5 rounded border border-amber-800 font-bold uppercase">
                      STALE
                    </span>
                  )}
                </div>
                {dashboard.currentPrice > 0 && dashboard.diffStr && (
                  <span className={`text-base font-bold ${dashboard.priceDirection === 'UP' ? 'text-emerald-400' : dashboard.priceDirection === 'DOWN' ? 'text-rose-500' : 'text-neutral-400'}`}>
                    {dashboard.diffStr}
                  </span>
                )}
              </div>

              {/* Row 4: Tick Direction Visual */}
              <div className="flex items-center justify-between text-xs font-mono bg-[#121212] px-4 py-3.5 rounded-xl border border-[#1A1A1A] shrink-0 min-h-[50px]">
                <span className="text-[11px] font-bold text-[#666] tracking-[1px] uppercase">LAST 5 TICKS:</span>
                {dashboard.last5Ticks && dashboard.last5Ticks.length > 0 ? (
                  <div className="flex items-center gap-3 font-bold text-sm">
                    {dashboard.last5Ticks.map((d: string, idx: number) => (
                      <span key={idx} className={d === 'UP' ? 'text-emerald-400' : d === 'DOWN' ? 'text-rose-500' : 'text-neutral-500'}>
                        {d === 'UP' ? 'UP' : d === 'DOWN' ? 'DN' : '—'}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                  </div>
                )}
              </div>

              {/* Row 5: Confluence Checklist */}
              <div className="bg-[#121212] p-3.5 rounded-xl border border-[#1A1A1A] space-y-2 font-mono shrink-0 min-h-[60px]">
                <span className="text-[11px] font-bold text-[#666] uppercase tracking-[1px] block">CONFLUENCE MONITOR:</span>
                <div className="grid grid-cols-4 gap-3 text-center font-bold">
                  <div className={`py-2.5 px-3 rounded-lg min-h-[44px] flex items-center justify-center text-[13px] ${trendMet ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800' : 'bg-neutral-900 text-neutral-500'}`}>
                    {trendMet ? 'PASS' : 'FAIL'} Trend
                  </div>
                  <div className={`py-2.5 px-3 rounded-lg min-h-[44px] flex items-center justify-center text-[13px] ${srMet ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800' : 'bg-neutral-900 text-neutral-500'}`}>
                    {srMet ? 'PASS' : 'FAIL'} S/R
                  </div>
                  <div className={`py-2.5 px-3 rounded-lg min-h-[44px] flex items-center justify-center text-[13px] ${ticksMet ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800' : 'bg-neutral-900 text-neutral-500'}`}>
                    {ticksMet ? 'PASS' : 'FAIL'} Pressure
                  </div>
                  <div className={`py-2.5 px-3 rounded-lg min-h-[44px] flex items-center justify-center text-[13px] ${aiMet ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800' : 'bg-neutral-900 text-neutral-500'}`}>
                    {aiMet ? 'PASS' : 'FAIL'} AI
                  </div>
                </div>
              </div>

              {/* Row 6: Entry Countdown + Window Depletion Bar */}
              <div className="bg-[#121212] p-4 rounded-xl border border-[#1A1A1A] space-y-2 font-mono shrink-0">
                <div className="flex items-center justify-between text-xs font-bold text-[#888]">
                  <span>ENTRY CLOSES IN</span>
                  <span className="text-xs font-bold text-neutral-300">{remainingSeconds}s remaining</span>
                </div>
                <div className="text-3xl sm:text-4xl font-black text-[#ffaa00] tracking-widest leading-none">
                  00:{remainingSeconds.toString().padStart(2, '0')}
                </div>
                <div className="w-full h-2.5 bg-[#1F1F1F] rounded-full overflow-hidden">
                  <div 
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${entryWindowPercent}%`,
                      backgroundColor: entryBarColor
                    }}
                  />
                </div>
              </div>

              {/* Row 7: Setup Quality Bar */}
              <div className="space-y-2 font-mono shrink-0 border-t border-[#1a1a1a] pt-3">
                <div className="flex justify-between items-center text-xs text-[#888]">
                  <span>SETUP QUALITY</span>
                  <span className="font-bold text-white text-sm">{qualityScore}%</span>
                </div>
                <div className="w-full h-2.5 bg-[#1F1F1F] rounded-full overflow-hidden">
                  <div 
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${qualityScore}%`,
                      backgroundColor: config.color
                    }}
                  />
                </div>
              </div>

              {/* Row 8: Rationale */}
              <div className="text-sm font-mono text-neutral-300 leading-relaxed pt-2 border-t border-[#1A1A1A] shrink-0">
                <span className="text-emerald-400 font-bold mr-1.5">[{config.id.toUpperCase()}]</span>
                {activeSignal.rationale || "Signal generated from live tick confluence analysis"}
              </div>
            </>
          ) : (
            /* CLEAN IDLE CARD WITH NO STALE LABELS, NO MARKET SNAPSHOT, NO INSTRUCTIONS */
            <>
              {/* Active Asset Row */}
              <div className="flex items-center justify-between font-mono bg-[#121212] p-4 sm:p-5 rounded-xl border border-[#1A1A1A] shrink-0 min-h-[75px]">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-bold text-[#666] tracking-[1px] uppercase">ACTIVE ASSET</span>
                    {dashboard.payoutFormatted && (
                      <span className="text-xs text-emerald-400 font-bold font-mono bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/60">
                        {dashboard.payoutFormatted} PO
                      </span>
                    )}
                  </div>
                  <span className="text-xl font-bold text-white">{dashboard.assetName || "CONNECTING TO MARKET..."}</span>
                </div>
                <div className="text-right flex items-center gap-2">
                  {dashboard.feedStatus === 'OFFLINE' && dashboard.currentPrice > 0 && (
                    <span className="text-xs bg-amber-950/80 text-amber-400 px-2 py-0.5 rounded border border-amber-800 font-bold uppercase">
                      STALE
                    </span>
                  )}
                  <div className="text-right">
                    <span className={`text-2xl sm:text-3xl font-black font-mono tracking-wider block ${dashboard.priceDirection === 'UP' ? 'text-emerald-400' : dashboard.priceDirection === 'DOWN' ? 'text-rose-500' : 'text-white'}`}>
                      {dashboard.formattedPrice || "—.——"}
                    </span>
                    {dashboard.currentPrice > 0 && dashboard.diffStr && (
                      <span className="text-sm font-bold font-mono text-[#888]">
                        {dashboard.diffStr}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Last 5 Ticks Row */}
              <div className="flex items-center justify-between text-xs font-mono bg-[#121212] px-4 py-3.5 rounded-xl border border-[#1A1A1A] shrink-0 min-h-[50px]">
                <span className="text-[11px] font-bold text-[#666] tracking-[1px] uppercase">LAST 5 TICKS:</span>
                {dashboard.last5Ticks && dashboard.last5Ticks.length > 0 ? (
                  <div className="flex items-center gap-3 font-bold text-sm">
                    {dashboard.last5Ticks.map((d: string, idx: number) => (
                      <span key={idx} className={d === 'UP' ? 'text-emerald-400' : d === 'DOWN' ? 'text-rose-500' : 'text-neutral-500'}>
                        {d === 'UP' ? 'UP' : d === 'DOWN' ? 'DN' : '—'}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                    <span className="w-4 h-2 bg-neutral-800 rounded animate-pulse" />
                  </div>
                )}
              </div>

              {/* Confluence Monitor */}
              <div className="bg-[#121212] p-4 rounded-xl border border-[#1A1A1A] space-y-2.5 font-mono shrink-0 min-h-[60px]">
                <span className="text-[11px] font-bold text-[#666] uppercase tracking-[1px] block">CONFLUENCE MONITOR:</span>
                <div className="grid grid-cols-4 gap-3 text-center font-bold">
                  <div className="py-2.5 px-3 rounded-lg min-h-[44px] flex items-center justify-center text-[13px] bg-neutral-900 text-neutral-400 border border-neutral-800">
                    [-] Trend
                  </div>
                  <div className="py-2.5 px-3 rounded-lg min-h-[44px] flex items-center justify-center text-[13px] bg-neutral-900 text-neutral-400 border border-neutral-800">
                    [-] S/R
                  </div>
                  <div className="py-2.5 px-3 rounded-lg min-h-[44px] flex items-center justify-center text-[13px] bg-neutral-900 text-neutral-400 border border-neutral-800">
                    [-] Pressure
                  </div>
                  <div className="py-2.5 px-3 rounded-lg min-h-[44px] flex items-center justify-center text-[13px] bg-neutral-900 text-neutral-400 border border-neutral-800">
                    [-] AI
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 4. MARKET PULSE / FOOTER STATS BAR */}
      <div className="w-full shrink-0">
        <div className="w-full h-9 px-4 bg-[#0A0A0A] border border-[#1A1A1A] rounded-xl flex items-center justify-between text-xs font-mono text-neutral-300">
          <div className="flex items-center gap-3 text-xs truncate w-full justify-around font-semibold">
            <span>
              <span className="text-[#666]">Trend: </span>
              <span className="text-amber-400 font-bold">{dashboard.trend || "—"}</span>
            </span>
            <span className="text-[#333]">·</span>
            <span>
              <span className="text-[#666]">Pressure: </span>
              <span className="text-emerald-400 font-bold">{dashboard.tickPressure || "—"}</span>
            </span>
            <span className="text-[#333]">·</span>
            <span>
              <span className="text-[#666]">Streak: </span>
              <span className="text-emerald-400 font-bold">{dashboard.streak || "—"}</span>
            </span>
          </div>
        </div>
      </div>

      {/* 5. SINGLE ACTION BUTTON */}
      <div className="w-full shrink-0">
        {state === "SIGNAL" && activeSignal ? (
          <button
            onClick={handleEnterTradeClick}
            disabled={isSubmitting}
            className="w-full h-[56px] active:scale-[0.98] text-white font-black font-sans text-base rounded-xl shadow-[0_4px_24px_rgba(16,185,129,0.4)] transition-all uppercase tracking-[1px] flex items-center justify-center gap-2 cursor-pointer"
            style={{ 
              background: isCall 
                ? 'linear-gradient(135deg, #00c853, #047857)' 
                : 'linear-gradient(135deg, #ff1744, #be123c)' 
            }}
          >
            {isSubmitting ? "PROCESSING TRADE..." : `ENTER (${(activeSignal.timeframe || config.timeframeLabel).toUpperCase()})`}
          </button>
        ) : (state === "SCANNING" || isSubmitting) ? (
          <button
            onClick={handleStopScan}
            disabled={isSubmitting}
            className="w-full h-[56px] active:scale-[0.98] text-white font-black font-sans text-base rounded-xl shadow-[0_4px_24px_rgba(0,0,0,0.6)] transition-all uppercase tracking-[1px] flex items-center justify-center gap-2 cursor-pointer hover:brightness-110"
            style={{ background: config.badgeGradient, color: "#FFFFFF" }}
          >
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <span>ANALYZING</span>
          </button>
        ) : (
          <button
            onClick={handleStartScan}
            disabled={isSubmitting}
            className="w-full h-[56px] active:scale-[0.98] text-white font-black font-sans text-base rounded-xl shadow-[0_4px_24px_rgba(0,0,0,0.6)] transition-all uppercase tracking-[1px] flex items-center justify-center gap-2 cursor-pointer hover:brightness-110"
            style={{ background: config.badgeGradient, color: "#FFFFFF" }}
          >
            <span>SCAN</span>
          </button>
        )}
      </div>

      {/* 6. COMPACT FOOTER BAR */}
      <div className="w-full h-[32px] text-center text-[11px] font-mono text-[#666666] flex items-center justify-center gap-2 shrink-0 border-t border-[#1a1a1a] pt-1">
        <span className="font-bold text-neutral-400">v5.0.0</span>
        <span>·</span>
        <span style={{ color: config.color }} className="font-bold">{config.label}</span>
        <span>·</span>
        <span>{config.minStrength}% Floor</span>
        <span>·</span>
        <span>{config.confluenceTarget}+ Confluence</span>
        <span>·</span>
        <span>AI: {config.aiEnabled ? "ON" : "OFF"}</span>
      </div>

    </div>
  );
};
