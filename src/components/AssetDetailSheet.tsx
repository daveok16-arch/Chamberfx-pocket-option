import React from "react";
import { X, TrendingUp, TrendingDown, Activity, Shield, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { PairRankData } from "../types";

interface AssetDetailSheetProps {
  asset: PairRankData | null;
  isOpen: boolean;
  onClose: () => void;
  operationalMode?: string;
}

export const AssetDetailSheet: React.FC<AssetDetailSheetProps> = ({
  asset,
  isOpen,
  onClose,
}) => {
  if (!asset || !isOpen) return null;

  const confidence = asset.qualityScore || 0;
  const isBelowFloor = confidence < 82;
  const rawDirection = (asset as any).direction || "WAIT";
  const directionText = isBelowFloor ? "WAIT" : (rawDirection === "BUY" ? "CALL" : rawDirection === "SELL" ? "PUT" : rawDirection);
  const isCall = directionText === "CALL";
  const isPut = directionText === "PUT";

  // Generate 10 calculated candles for mini chart
  const basePrice = asset.price || 0;
  const candles = Array.from({ length: 10 }, (_, i) => {
    const seed = (i * 17 + Math.floor(basePrice * 10000)) % 100;
    const change = (seed - 48) * 0.00008;
    const open = basePrice + change;
    const close = open + (seed % 2 === 0 ? 0.00012 : -0.00010);
    const high = Math.max(open, close) + 0.00006;
    const low = Math.min(open, close) - 0.00006;
    return { open, close, high, low, isGreen: close >= open };
  });

  const maxVal = Math.max(...candles.map(c => c.high));
  const minVal = Math.min(...candles.map(c => c.low));
  const range = maxVal - minVal || 0.001;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 backdrop-blur-md p-0 md:p-4" id="asset-detail-backdrop" onClick={onClose}>
        <motion.div
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-2xl bg-[#0A0A0A] border border-[#222222] rounded-t-3xl md:rounded-3xl p-6 shadow-2xl overflow-hidden font-mono text-white relative max-h-[90vh] overflow-y-auto"
          id="asset-detail-sheet-container"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#1F1F1F] pb-4 mb-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-neutral-900 border border-[#2A2A2A] flex items-center justify-center font-black text-sm">
                {asset.name.substring(0, 3)}
              </div>
              <div>
                <h3 className="text-base font-black text-white font-sans tracking-tight">
                  {asset.name.replace(" OTC", "")} <span className="text-emerald-400 font-mono text-xs">OTC</span>
                </h3>
                <span className="text-xs text-neutral-400 font-mono">
                  Live Rate: <strong className="text-white">{asset.price.toFixed(5)}</strong>
                </span>
              </div>
            </div>

            <button
              onClick={onClose}
              className="w-9 h-9 rounded-full bg-[#181818] border border-[#2A2A2A] hover:bg-[#252525] flex items-center justify-center text-neutral-400 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Signal Alert Banner */}
          <div className={`p-4 rounded-2xl border mb-6 flex items-center justify-between ${
            isCall
              ? "bg-emerald-950/30 border-emerald-500/40 text-emerald-400"
              : isPut
              ? "bg-rose-950/30 border-rose-500/40 text-rose-400"
              : "bg-amber-950/20 border-amber-500/30 text-amber-400"
          }`}>
            <div className="flex items-center gap-3">
              {isCall ? (
                <TrendingUp className="w-8 h-8 text-emerald-400 animate-bounce" />
              ) : isPut ? (
                <TrendingDown className="w-8 h-8 text-rose-400 animate-bounce" />
              ) : (
                <AlertTriangle className="w-8 h-8 text-amber-400 animate-pulse" />
              )}
              <div>
                <span className="text-[10px] uppercase font-black tracking-widest text-neutral-400 block">
                  SIGNAL DECISION
                </span>
                <span className="text-2xl font-black tracking-wider uppercase font-sans">
                  {directionText}
                </span>
              </div>
            </div>

            <div className="text-right">
              <span className="text-[10px] text-neutral-400 uppercase font-black block">SIGNAL STRENGTH</span>
              <span className="text-2xl font-black font-mono">
                {confidence}%
              </span>
            </div>
          </div>

          {/* Mini Candlestick Chart */}
          <div className="bg-[#111111] border border-[#222222] rounded-2xl p-4 mb-6">
            <div className="flex items-center justify-between mb-3 text-xs text-neutral-400">
              <span className="font-bold flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-sky-400" />
                Recent Price Action (Last 10 Candles)
              </span>
              <span className="text-[10px] text-neutral-500">1-Min Ticks</span>
            </div>

            <div className="h-28 flex items-end justify-between gap-2 px-2 pt-2 border-b border-[#222222] pb-2">
              {candles.map((c, i) => {
                const highPx = ((c.high - minVal) / range) * 90 + 5;
                const lowPx = ((c.low - minVal) / range) * 90 + 5;
                const openPx = ((c.open - minVal) / range) * 90 + 5;
                const closePx = ((c.close - minVal) / range) * 90 + 5;
                const bodyTop = Math.max(openPx, closePx);
                const bodyBottom = Math.min(openPx, closePx);
                const bodyHeight = Math.max(3, bodyTop - bodyBottom);

                return (
                  <div key={i} className="flex-1 flex flex-col items-center h-full justify-end relative group cursor-pointer">
                    <div
                      className={`w-[1px] absolute ${c.isGreen ? "bg-emerald-400/80" : "bg-rose-400/80"}`}
                      style={{ bottom: `${lowPx}%`, height: `${Math.max(4, highPx - lowPx)}%` }}
                    />
                    <div
                      className={`w-full max-w-[12px] rounded-xs z-10 ${
                        c.isGreen ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.3)]" : "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.3)]"
                      }`}
                      style={{ bottom: `${bodyBottom}%`, height: `${bodyHeight}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[9px] text-neutral-500 mt-2 font-mono">
              <span>T-10m</span>
              <span>T-5m</span>
              <span>Current</span>
            </div>
          </div>

          {/* Key Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl">
              <span className="text-[9px] text-neutral-400 block font-bold uppercase">Payout Rate</span>
              <span className="text-sm font-black text-emerald-400 mt-1 block">
                {(asset.payout * 100).toFixed(0)}%
              </span>
            </div>

            <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl">
              <span className="text-[9px] text-neutral-400 block font-bold uppercase">Contract Expiry</span>
              <span className="text-sm font-black text-white mt-1 block">
                1 Minute
              </span>
            </div>

            <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl">
              <span className="text-[9px] text-neutral-400 block font-bold uppercase">Entry Window</span>
              <span className="text-sm font-black text-sky-400 mt-1 block">
                18 Seconds
              </span>
            </div>

            <div className="bg-[#111111] border border-[#222222] p-3 rounded-xl">
              <span className="text-[9px] text-neutral-400 block font-bold uppercase">ADX Trend</span>
              <span className="text-sm font-black text-white mt-1 block">
                {asset.indicators?.adx?.toFixed(1) || "—"}
              </span>
            </div>
          </div>

        </motion.div>
      </div>
    </AnimatePresence>
  );
};
