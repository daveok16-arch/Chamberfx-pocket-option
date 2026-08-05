import React from "react";
import { Activity } from "lucide-react";
import { DecisionObject, PairRankData } from "../types";

interface NeuralIntelPanelProps {
  decision: DecisionObject;
  rankings: PairRankData[];
  isAiAnalyzing: boolean;
  aiError: string;
  onAnalyze?: () => void;
  activeModelDisplay: string;
  operationalMode: string;
  setOperationalMode: (mode: string) => void;
  systemConnected: boolean;
  lastScanTime: string;
  performanceStats?: any;
}

export const NeuralIntelPanel: React.FC<NeuralIntelPanelProps> = ({
  decision,
}) => {
  const activeAsset = decision.asset;
  const weights = decision.aiWeights;
  const liveInd = (decision as any).liveIndicators;

  const [nowMs, setNowMs] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  const updatedAt = liveInd?.updatedAt || Date.now();
  const secondsAgo = Math.max(0, (nowMs - updatedAt) / 1000).toFixed(1);

  const rsiValue = liveInd?.rsi != null ? liveInd.rsi.toFixed(1) : "—";
  const macdValue = liveInd?.macdHist != null ? (liveInd.macdHist >= 0 ? `+${liveInd.macdHist.toFixed(5)}` : liveInd.macdHist.toFixed(5)) : "—";
  const adxValue = liveInd?.adx != null ? `${liveInd.adx.toFixed(1)} (${liveInd.adx > 25 ? 'Strong' : 'Moderate'})` : "—";
  const bbPos = liveInd?.bbPosition != null ? (liveInd.bbPosition > 0.8 ? "UPPER BAND" : liveInd.bbPosition < 0.2 ? "LOWER BAND" : "SQUEEZE") : "—";

  const rsiHistory = liveInd?.rsiHistory || [];

  return (
    <div className="bg-[#0A0A0A] border border-[#222222] rounded-3xl p-5 md:p-6 shadow-2xl font-mono" id="technical-indicators-panel">
      <div className="flex items-center justify-between border-b border-[#1F1F1F] pb-3.5 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-sky-950/40 border border-sky-500/30 flex items-center justify-center">
            <Activity className="w-4 h-4 text-sky-400" />
          </div>
          <div>
            <h4 className="text-xs font-black text-white uppercase tracking-wider font-sans">
              LIVE TICK INDICATORS & AI WEIGHT MATRIX
            </h4>
            <p className="text-[10px] text-neutral-400 font-mono">
              Calculated on EVERY tick — {activeAsset ? activeAsset.name.replace(" OTC", "") : "—"}
            </p>
          </div>
        </div>
        <span className="text-[10px] font-mono font-bold bg-sky-950/40 text-sky-400 border border-sky-500/30 px-2.5 py-1 rounded-md uppercase flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
          PER-TICK SYNC ACTIVE
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono text-xs">
        {/* EMA */}
        <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl flex flex-col justify-between hover:border-sky-500/40 transition-colors">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-neutral-400 font-bold uppercase tracking-wider">EMA (9/21)</span>
              <span className="text-[9px] text-sky-400 font-bold">{secondsAgo}s ago</span>
            </div>
            <span className={`text-xs font-black mt-1.5 block uppercase ${
              decision.direction === "CALL" ? "text-emerald-400" : decision.direction === "PUT" ? "text-rose-400" : "text-amber-400"
            }`}>
              {decision.direction === "CALL" ? "BULLISH" : decision.direction === "PUT" ? "BEARISH" : "NEUTRAL"}
            </span>
          </div>
          <span className="text-[9px] text-emerald-400 font-bold mt-2 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Updated: {secondsAgo}s ago
          </span>
        </div>

        {/* RSI with mini sparkline */}
        <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl flex flex-col justify-between hover:border-sky-500/40 transition-colors">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-neutral-400 font-bold uppercase tracking-wider">RSI (14)</span>
              <span className="text-[9px] text-sky-400 font-bold">{secondsAgo}s ago</span>
            </div>
            <span className="text-xs font-black text-white mt-1.5 block animate-pulse">
              {rsiValue}
            </span>
            {/* 20-tick Mini Sparkline */}
            <div className="flex items-end gap-0.5 h-3 mt-1.5 overflow-hidden">
              {rsiHistory.map((v, i) => (
                <div
                  key={i}
                  style={{ height: `${Math.max(15, Math.min(100, v))}%` }}
                  className={`w-1 rounded-t-sm ${v > 60 ? "bg-emerald-400" : v < 40 ? "bg-rose-400" : "bg-sky-400"}`}
                />
              ))}
            </div>
          </div>
          <span className="text-[9px] text-emerald-400 font-bold mt-2 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Updated: {secondsAgo}s ago
          </span>
        </div>

        {/* MACD */}
        <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl flex flex-col justify-between hover:border-sky-500/40 transition-colors">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-neutral-400 font-bold uppercase tracking-wider">MACD</span>
              <span className="text-[9px] text-sky-400 font-bold">{secondsAgo}s ago</span>
            </div>
            <span className={`text-xs font-black mt-1.5 block ${Number(macdValue) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {macdValue}
            </span>
          </div>
          <span className="text-[9px] text-emerald-400 font-bold mt-2 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Updated: {secondsAgo}s ago
          </span>
        </div>

        {/* BOLLINGER */}
        <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl flex flex-col justify-between hover:border-sky-500/40 transition-colors">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-neutral-400 font-bold uppercase tracking-wider">BOLLINGER</span>
              <span className="text-[9px] text-sky-400 font-bold">{secondsAgo}s ago</span>
            </div>
            <span className="text-xs font-black text-amber-400 mt-1.5 block uppercase">
              {bbPos}
            </span>
          </div>
          <span className="text-[9px] text-emerald-400 font-bold mt-2 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Updated: {secondsAgo}s ago
          </span>
        </div>

        {/* ADX */}
        <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl flex flex-col justify-between hover:border-sky-500/40 transition-colors">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-neutral-400 font-bold uppercase tracking-wider">ADX (14)</span>
              <span className="text-[9px] text-sky-400 font-bold">{secondsAgo}s ago</span>
            </div>
            <span className="text-xs font-black text-white mt-1.5 block">
              {adxValue}
            </span>
          </div>
          <span className="text-[9px] text-emerald-400 font-bold mt-2 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Updated: {secondsAgo}s ago
          </span>
        </div>

        {/* MOMENTUM */}
        <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl flex flex-col justify-between hover:border-sky-500/40 transition-colors">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-neutral-400 font-bold uppercase tracking-wider">MOMENTUM</span>
              <span className="text-[9px] text-sky-400 font-bold">{secondsAgo}s ago</span>
            </div>
            <span className="text-xs font-black text-sky-400 mt-1.5 block">
              PER-TICK VELOCITY
            </span>
          </div>
          <span className="text-[9px] text-emerald-400 font-bold mt-2 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Updated: {secondsAgo}s ago
          </span>
        </div>
      </div>
    </div>
  );
};
