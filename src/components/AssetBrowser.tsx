import React, { useState, useMemo } from "react";
import { Search, Shield, Pin, TrendingUp, TrendingDown, AlertTriangle, Eye } from "lucide-react";
import { PairRankData } from "../types";

interface AssetBrowserProps {
  rankings: PairRankData[];
  selectedAssetId: string;
  setSelectedAssetId: (id: string) => void;
  minQualityScore?: number;
  onSelectAssetForDetail?: (asset: PairRankData) => void;
  operationalMode?: string;
}

export const AssetBrowser: React.FC<AssetBrowserProps> = ({
  rankings,
  selectedAssetId,
  setSelectedAssetId,
  onSelectAssetForDetail,
  operationalMode = "QUANTITATIVE"
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [onlyHighPayout, setOnlyHighPayout] = useState(true);

  // Filter and sort rankings: Payout >= 88%
  const processedRankings = useMemo(() => {
    return [...rankings]
      .filter(r => {
        const matchesSearch = r.assetId.toLowerCase().includes(searchQuery.toLowerCase()) ||
                              r.name.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesPayout = onlyHighPayout ? r.payout >= 0.88 : true;
        return matchesSearch && matchesPayout;
      })
      .sort((a, b) => {
        const scoreA = a.qualityScore * 0.6 + (a.payout * 100) * 0.4;
        const scoreB = b.qualityScore * 0.6 + (b.payout * 100) * 0.4;
        return scoreB - scoreA;
      })
      .map((item, idx) => ({
        ...item,
        isPinned: idx < 2,
        rank: idx + 1
      }));
  }, [rankings, searchQuery, onlyHighPayout]);

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A] rounded-3xl border border-[#222222] overflow-hidden shadow-2xl font-mono" id="live-rankings-panel">
      
      {/* Header */}
      <div className="p-5 border-b border-[#1F1F1F] bg-[#0E0E0E]">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5">
            <Shield className="w-5 h-5 text-sky-400" />
            <h3 className="text-sm font-black text-white uppercase tracking-wider font-sans">
              High-Payout Asset Scanner (88%+)
            </h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setOnlyHighPayout(!onlyHighPayout)}
              className={`text-[10px] px-3 py-1.5 rounded-lg border font-mono font-bold uppercase tracking-wider transition-all cursor-pointer ${
                onlyHighPayout
                  ? "bg-emerald-950/40 text-emerald-400 border-emerald-500/30"
                  : "bg-[#141414] text-neutral-400 border-[#262626] hover:text-white"
              }`}
            >
              {onlyHighPayout ? "High Payout Only (88%+)" : "All Pairs"}
            </button>
            <span className="text-[10px] bg-sky-950/40 text-sky-400 border border-sky-500/30 px-2.5 py-1 rounded-md uppercase font-bold">
              ● 1-Min OTC Ticks
            </span>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="h-4 w-4 text-neutral-500 absolute left-4 top-3.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search active currency pairs..."
            className="w-full bg-[#121212] border border-[#222222] focus:border-sky-500/50 rounded-xl pl-11 pr-4 py-3 text-xs text-white placeholder-neutral-500 focus:outline-none transition-all font-mono"
          />
        </div>
      </div>

      {/* Asset Cards Grid */}
      <div className="p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[700px] overflow-y-auto scrollbar-thin">
        {processedRankings.length === 0 ? (
          <div className="col-span-full py-16 text-center text-neutral-500 font-mono text-xs">
            No active currency pairs match 88%+ payout filter.
          </div>
        ) : (
          processedRankings.map((pair) => {
            const rawDirection = (pair as any).direction || "WAIT";
            const confidence = pair.qualityScore || 0;
            const isBelowFloor = confidence < 82;
            const directionText = isBelowFloor ? "WAIT" : (rawDirection === "BUY" ? "CALL" : rawDirection === "SELL" ? "PUT" : rawDirection);
            const isCall = directionText === "CALL";
            const isPut = directionText === "PUT";

            return (
              <div
                key={pair.assetId}
                onClick={() => {
                  setSelectedAssetId(pair.assetId);
                  if (onSelectAssetForDetail) onSelectAssetForDetail(pair);
                }}
                className={`p-4 rounded-2xl border transition-all duration-200 cursor-pointer relative overflow-hidden flex flex-col justify-between gap-4 ${
                  isBelowFloor
                    ? "bg-[#080808] border-[#1A1A1A] opacity-45 grayscale-[40%] hover:opacity-80"
                    : "bg-[#111111] border-[#222222] hover:border-[#333333] hover:shadow-lg"
                }`}
              >
                {/* Top Row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {pair.isPinned && <Pin className="w-3.5 h-3.5 text-sky-400 rotate-45" />}
                    <span className="text-xs font-black text-neutral-400">#{pair.rank}</span>
                    <h4 className="text-sm font-black text-white font-sans tracking-tight">
                      {pair.name.replace(" OTC", "")} <span className="text-emerald-400 font-mono text-[10px]">OTC</span>
                    </h4>
                  </div>

                  <span className="text-xs font-black text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-2 py-0.5 rounded-lg">
                    {(pair.payout * 100).toFixed(0)}%
                  </span>
                </div>

                {/* Middle Row: Direction & Signal Strength */}
                <div className="flex items-center justify-between py-2 border-y border-[#1A1A1A]">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-black px-2.5 py-1 rounded-lg uppercase flex items-center gap-1 ${
                      isCall
                        ? "bg-emerald-950/50 text-emerald-400 border border-emerald-500/30"
                        : isPut
                        ? "bg-rose-950/50 text-rose-400 border border-rose-500/30"
                        : "bg-[#181818] text-neutral-400 border border-[#2A2A2A]"
                    }`}>
                      {isCall ? <TrendingUp className="w-3.5 h-3.5" /> : isPut ? <TrendingDown className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                      {directionText}
                    </span>

                    {pair.regime && (
                      <span className="text-[9px] bg-sky-950/40 text-sky-400 border border-sky-500/30 px-1.5 py-0.5 rounded uppercase font-bold">
                        {pair.regime}
                      </span>
                    )}
                  </div>

                  <div className="text-right">
                    <span className="text-[9px] text-neutral-500 uppercase block font-bold">SIGNAL STRENGTH</span>
                    <span className={`text-sm font-black ${isBelowFloor ? "text-amber-400/80" : "text-white"}`}>
                      {confidence}%
                    </span>
                  </div>
                </div>

                {/* Bottom Row */}
                <div className="flex items-center justify-between text-xs text-neutral-400">
                  <span>Price: <strong className="text-white">{pair.price.toFixed(5)}</strong></span>
                  <span className="text-[10px] text-sky-400 flex items-center gap-1 font-bold">
                    <Eye className="w-3 h-3" /> View Details
                  </span>
                </div>

              </div>
            );
          })
        )}
      </div>

    </div>
  );
};
