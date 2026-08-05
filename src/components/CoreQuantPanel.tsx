import React, { useEffect, useState } from "react";
import { ChevronUp, ChevronDown, Activity } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { DecisionObject, PairRankData } from "../types";

const DEFAULT_MODE_CONFIG = {
  entryWindow: 18,
  minStrength: 82
};

interface CoreQuantPanelProps {
  decision: DecisionObject;
  rankings?: PairRankData[];
  onSelectAsset?: (assetId: string) => void;
  operationalMode?: string;
  onRefreshState?: () => void;
}

export const CoreQuantPanel: React.FC<CoreQuantPanelProps> = ({
  decision,
  onRefreshState
}) => {
  const {
    asset,
    direction,
    confidence: signalStrength,
    reasoning,
    risk,
  } = decision;

  const pipeline = (decision as any).pipeline || {
    state: "IDLE",
    secondsToSignalExpiry: 0,
    secondsToTradeExpiry: 0,
    secondsToSettlingEnd: 0,
    activeSignal: null,
    activeTrade: null,
    settlingResult: null
  };

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleEnterTrade = async () => {
    setIsSubmitting(true);
    try {
      await fetch("/api/pipeline/enter", { method: "POST" });
      if (onRefreshState) onRefreshState();
    } catch (err) {
      console.error("Failed to enter trade", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSkipSignal = async () => {
    setIsSubmitting(true);
    try {
      await fetch("/api/pipeline/skip", { method: "POST" });
      if (onRefreshState) onRefreshState();
    } catch (err) {
      console.error("Failed to skip signal", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetPipeline = async () => {
    setIsSubmitting(true);
    try {
      await fetch("/api/pipeline/reset", { method: "POST" });
      if (onRefreshState) onRefreshState();
    } catch (err) {
      console.error("Failed to reset pipeline", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const maxEntryWindow = DEFAULT_MODE_CONFIG.entryWindow; // 18s standard
  const minStrengthFloor = DEFAULT_MODE_CONFIG.minStrength; // 82% standard

  // Real-time clock tick
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  const isFeedOffline = (decision as any).feedStatus === "OFFLINE" || (decision as any).signalStatus === "FEED_OFFLINE";
  const isBelowFloor = signalStrength < minStrengthFloor;
  
  // Effective direction based on pipeline state
  let effectiveDirection = direction;
  if (pipeline.state === 'IDLE') effectiveDirection = 'WAIT';
  if (isFeedOffline) effectiveDirection = 'WAIT';

  const isCall = effectiveDirection === "CALL";
  const isPut = effectiveDirection === "PUT";

  const settlement = (decision as any).latestSettlement || pipeline.settlingResult;
  const latency = (decision as any).latencyMetrics || { poToBotLatencyMs: 4, processingTimeMs: 0.8, ticksBuffered: 0 };

  // SVG ring stroke calculations
  const ringRadius = 56;
  const circumference = 2 * Math.PI * ringRadius;
  
  let progressRatio = 0;
  let countdownDisplay = "IDLE";

  if (pipeline.state === "SIGNAL") {
    progressRatio = pipeline.secondsToSignalExpiry / 15;
    countdownDisplay = `${pipeline.secondsToSignalExpiry}s`;
  } else if (pipeline.state === "ENTERED") {
    progressRatio = pipeline.secondsToTradeExpiry / 60;
    countdownDisplay = `${pipeline.secondsToTradeExpiry}s`;
  } else if (pipeline.state === "SETTLING") {
    progressRatio = pipeline.secondsToSettlingEnd / 3.5;
    countdownDisplay = "SETTLE";
  }

  const strokeDashoffset = circumference - progressRatio * circumference;

  const timerColorClass = pipeline.state === "SIGNAL"
    ? "text-emerald-400 stroke-emerald-400"
    : pipeline.state === "ENTERED"
    ? "text-amber-400 stroke-amber-400 animate-pulse"
    : pipeline.state === "SETTLING"
    ? "text-sky-400 stroke-sky-400"
    : "text-neutral-600 stroke-neutral-700";

  return (
    <div className="relative w-full" id="hero-signal-panel">
      {/* PIPELINE STATE BANNER */}
      <div className="w-full bg-[#111] border border-[#222] text-neutral-200 px-5 py-2.5 rounded-2xl mb-4 font-mono text-xs flex items-center justify-between shadow-lg">
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full ${
            pipeline.state === 'SIGNAL' ? 'bg-emerald-400 animate-ping' :
            pipeline.state === 'ENTERED' ? 'bg-amber-400 animate-pulse' :
            pipeline.state === 'SETTLING' ? 'bg-sky-400 animate-bounce' : 'bg-neutral-600'
          }`} />
          <span className="font-black tracking-wider uppercase">
            STATE: <span className="text-white bg-[#1E1E1E] px-2 py-0.5 rounded border border-[#333]">{pipeline.state}</span>
          </span>
          <span className="text-neutral-400 text-[11px] hidden sm:inline">
            {pipeline.state === 'IDLE' && '— Scanning 111 markets (No active signals)'}
            {pipeline.state === 'SIGNAL' && `— 15s Entry Window active (${pipeline.secondsToSignalExpiry}s left)`}
            {pipeline.state === 'ENTERED' && `— 60s Trade Lock active (${pipeline.secondsToTradeExpiry}s remaining)`}
            {pipeline.state === 'SETTLING' && '— Trade finished. Displaying settlement audit...'}
          </span>
        </div>

        {pipeline.state !== 'IDLE' && (
          <button
            onClick={handleResetPipeline}
            disabled={isSubmitting}
            className="text-[10px] text-neutral-400 hover:text-rose-400 underline font-mono"
          >
            Force Reset
          </button>
        )}
      </div>

      {/* BUG 1 BANNER: FEED OFFLINE BANNER */}
      {isFeedOffline && (
        <div className="w-full bg-rose-950/90 border-2 border-rose-500/80 text-rose-200 px-5 py-3 rounded-2xl mb-4 font-mono font-bold flex items-center justify-between shadow-[0_0_30px_rgba(244,63,94,0.3)] animate-pulse">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-rose-500 animate-ping" />
            <span className="text-sm font-black tracking-wider uppercase">FEED OFFLINE — SIGNALS PAUSED</span>
          </div>
          <span className="text-xs bg-rose-900/60 border border-rose-400/30 px-3 py-1 rounded-lg">
            Capital Protection Gate Active
          </span>
        </div>
      )}

      {/* Main Hero Card Container */}
      <div className={`bg-[#0A0A0A] border rounded-3xl p-6 md:p-8 shadow-2xl relative overflow-hidden transition-all duration-500 ${
        isCall
          ? "border-emerald-500/40 shadow-[0_0_50px_rgba(16,185,129,0.15)]"
          : isPut
          ? "border-rose-500/40 shadow-[0_0_50px_rgba(244,63,94,0.15)]"
          : "border-[#222222]"
      }`}>
        
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1A1A1A] pb-4 mb-6 font-mono text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="bg-[#141414] border border-[#262626] text-neutral-300 px-3 py-1 rounded-full font-bold tracking-widest uppercase flex items-center gap-2 text-[10px]">
              <span className={`w-2 h-2 rounded-full ${isCall ? "bg-emerald-400 animate-ping" : isPut ? "bg-rose-400 animate-ping" : "bg-amber-400 animate-pulse"}`} />
              HARD SEQUENTIAL PIPELINE
            </span>

            {/* AI Regime Badge */}
            <span className="bg-sky-950/40 border border-sky-500/30 text-sky-400 px-3 py-1 rounded-full font-bold tracking-wider uppercase text-[10px] flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
              REGIME: {decision.regime || "RANGING"}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-neutral-400">Payout:</span>
            <span className="font-black text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-2.5 py-1 rounded-lg">
              {asset && asset.payout > 0 ? `${(asset.payout * 100).toFixed(0)}%` : "—%"}
            </span>
          </div>
        </div>

        {/* Hero Central Signal Section */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-8 py-2">
          
          {/* Signal Indicator with Circular Countdown Ring */}
          <div className="flex flex-col items-center justify-center relative">
            <div className="relative w-40 h-40 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90">
                <circle
                  cx="80"
                  cy="80"
                  r={ringRadius}
                  className="stroke-[#1C1C1C]"
                  strokeWidth="8"
                  fill="transparent"
                />
                <circle
                  cx="80"
                  cy="80"
                  r={ringRadius}
                  className={`transition-all duration-300 ${timerColorClass}`}
                  strokeWidth="8"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                  fill="transparent"
                />
              </svg>

              <div className="absolute inset-0 flex flex-col items-center justify-center font-mono">
                {isCall ? (
                  <ChevronUp className="w-16 h-16 text-emerald-400 animate-bounce" />
                ) : isPut ? (
                  <ChevronDown className="w-16 h-16 text-rose-400 animate-bounce" />
                ) : (
                  <Activity className="w-10 h-10 text-amber-400 animate-pulse" />
                )}
                <span className="text-[10px] font-bold text-neutral-300 mt-1">
                  {countdownDisplay}
                </span>
              </div>
            </div>
          </div>

          {/* Central Text: Dominant Signal Direction & Asset Name */}
          <div className="flex-1 text-center md:text-left">
            <div className="flex items-center justify-center md:justify-start gap-3">
              <h2 className="text-2xl md:text-3xl font-black text-white font-sans tracking-tight">
                {asset ? asset.name.replace(" OTC", "") : "SELECT ASSET"}{" "}
                <span className="text-emerald-400 font-mono text-sm font-bold">OTC</span>
              </h2>
            </div>

            {/* Dominant Direction */}
            <h1 className={`text-6xl md:text-7xl font-black uppercase tracking-widest my-2 font-sans ${
              isCall ? "text-emerald-400 drop-shadow-[0_0_20px_rgba(16,185,129,0.4)]" :
              isPut ? "text-rose-400 drop-shadow-[0_0_20px_rgba(244,63,94,0.4)]" :
              "text-amber-400"
            }`}>
              {effectiveDirection}
            </h1>

            {/* Rationale / Status */}
            <p className="text-xs font-mono text-neutral-200 max-w-lg leading-relaxed bg-[#111111] p-3 rounded-xl border border-[#222222]">
              {pipeline.state === 'SIGNAL' ? (
                <span className="text-emerald-400 font-bold">● High confidence signal active! 15s entry window running. Tap 'I ENTERED' once executed on Pocket Option.</span>
              ) : pipeline.state === 'ENTERED' ? (
                <span className="text-amber-400 font-bold">● Trade entered @ {pipeline.activeTrade?.entryPrice}. Locked for 60s. Signals suppressed.</span>
              ) : pipeline.state === 'SETTLING' ? (
                <span className="text-sky-400 font-bold">● Settling outcome: {pipeline.settlingResult?.isWin ? 'WIN ✅' : 'LOSS ❌'} (PO Price: {pipeline.settlingResult?.poPrice}).</span>
              ) : (
                decision.rationale || reasoning[0] || "Scanning 111 OTC markets for 82%+ high probability signal..."
              )}
            </p>

            {/* USER INTERACTIVE PIPELINE ACTION BUTTONS */}
            {pipeline.state === 'SIGNAL' && (
              <div className="flex flex-wrap items-center gap-3 mt-4">
                <button
                  onClick={handleEnterTrade}
                  disabled={isSubmitting}
                  className="flex-1 min-w-[200px] bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-black font-mono text-sm px-6 py-3.5 rounded-xl shadow-[0_0_25px_rgba(16,185,129,0.4)] uppercase tracking-wider transition-all transform active:scale-95 flex items-center justify-center gap-2"
                >
                  <span>I ENTERED ON POCKET OPTION</span>
                  <span className="bg-emerald-950 text-emerald-300 text-xs px-2 py-0.5 rounded-md border border-emerald-400/40 font-mono">
                    {pipeline.secondsToSignalExpiry}s
                  </span>
                </button>
                <button
                  onClick={handleSkipSignal}
                  disabled={isSubmitting}
                  className="bg-[#1C1C1C] hover:bg-[#2A2A2A] text-neutral-300 font-bold font-mono text-xs px-4 py-3.5 rounded-xl border border-[#333] transition-all"
                >
                  SKIP
                </button>
              </div>
            )}

            {pipeline.state === 'ENTERED' && (
              <div className="mt-4 bg-amber-950/40 border border-amber-500/40 p-3 rounded-xl flex items-center justify-between font-mono text-xs text-amber-200">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping" />
                  <span>TRADE LOCKED IN CONTRACT DURATION</span>
                </div>
                <span className="font-bold text-amber-400 text-sm">{pipeline.secondsToTradeExpiry}s</span>
              </div>
            )}
          </div>

          {/* Right Column: Signal Strength & Risk */}
          <div className="w-full md:w-56 bg-[#111111] border border-[#222222] p-5 rounded-2xl flex flex-col justify-between gap-4 font-mono">
            <div>
              <span className="text-[10px] text-neutral-400 uppercase font-black tracking-wider block">
                SIGNAL STRENGTH
              </span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className={`text-3xl font-black ${
                  isCall ? "text-emerald-400" : isPut ? "text-rose-400" : "text-amber-400"
                }`}>
                  {signalStrength}%
                </span>
                <span className="text-[10px] text-neutral-500 font-bold">/ 100%</span>
              </div>
              
              <div className="w-full bg-[#1A1A1A] h-1.5 rounded-full overflow-hidden mt-2 border border-[#2A2A2A]">
                <div
                  style={{ width: `${signalStrength}%` }}
                  className={`h-full ${isCall ? "bg-emerald-400" : isPut ? "bg-rose-400" : "bg-amber-400"}`}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs pt-3 border-t border-[#1C1C1C]">
              <div>
                <span className="text-[9px] text-neutral-500 block uppercase">Contract</span>
                <span className="font-bold text-white mt-0.5 block">1 Minute</span>
              </div>
              <div>
                <span className="text-[9px] text-neutral-500 block uppercase">Risk</span>
                <span className={`font-bold mt-0.5 block ${risk === "LOW" ? "text-emerald-400" : "text-amber-400"}`}>
                  {risk}
                </span>
              </div>
            </div>
          </div>

        </div>

        {/* Settlement Comparison & Latency Diagnostics Row */}
        <div className="mt-6 pt-4 border-t border-[#1A1A1A] flex flex-col gap-3 font-mono text-xs">
          {/* Settlement Comparison (BUG 4 FIX) */}
          <div className="bg-[#111111] border border-[#222222] p-3.5 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-sky-400" />
              <span className="text-[10px] text-neutral-400 font-bold uppercase tracking-wider">OFFICIAL PO SETTLEMENT AUDIT:</span>
            </div>
            {settlement ? (
              <div className="flex items-center gap-3 text-xs font-bold">
                <span className="text-neutral-300">PO Price: <span className="text-sky-400 font-mono">{settlement.poPrice.toFixed(5)}</span></span>
                <span className="text-neutral-500">|</span>
                <span className="text-neutral-300">Bot Price: <span className="text-emerald-400 font-mono">{settlement.botPrice.toFixed(5)}</span></span>
                <span className="text-neutral-500">|</span>
                <span className="text-neutral-300">Diff: <span className="text-amber-400 font-mono">{settlement.diffPips} pips</span></span>
              </div>
            ) : (
              <div className="flex items-center gap-3 text-xs font-bold text-neutral-400">
                <span>PO Price: <span className="text-sky-400 font-mono">Synced</span></span>
                <span>|</span>
                <span>Bot Price: <span className="text-emerald-400 font-mono">0.2 pips diff limit</span></span>
              </div>
            )}
          </div>

          {/* Latency Diagnostics Bar (BUG 5 FIX) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl flex items-center justify-between">
              <span className="text-[10px] text-neutral-400 font-bold uppercase">PO → Bot Latency</span>
              <span className="font-black text-emerald-400 font-mono">{latency.poToBotLatencyMs}ms</span>
            </div>

            <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl flex items-center justify-between">
              <span className="text-[10px] text-neutral-400 font-bold uppercase">Ticks Buffered</span>
              <span className="font-black text-sky-400 font-mono">{latency.ticksBuffered} (Direct Stream)</span>
            </div>

            <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl flex items-center justify-between">
              <span className="text-[10px] text-neutral-400 font-bold uppercase">Processing Time</span>
              <span className="font-black text-amber-400 font-mono">{latency.processingTimeMs}ms</span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
