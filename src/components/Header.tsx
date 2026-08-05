import React from "react";
import { Layers } from "lucide-react";

interface HeaderProps {
  systemConnected?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ systemConnected = true }) => {
  return (
    <header className="sticky top-0 z-30 w-full bg-[#000000]/90 backdrop-blur-xl border-b border-[#1A1A1A]" id="app-global-header">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8 h-16 flex items-center justify-between">
        
        {/* Minimal Clean Header Identity */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            <Layers className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-base md:text-lg font-black text-white tracking-wider font-sans">
              Chamber <span className="text-emerald-400 font-extrabold">FX</span>
            </h1>
            <span className="text-[10px] text-neutral-500 font-mono font-bold tracking-widest uppercase">
              v4.3.0
            </span>
          </div>
        </div>

        {/* Essential Status Indicators ONLY */}
        <div className="flex items-center gap-3 sm:gap-4 text-xs font-mono font-bold">
          
          <div className="flex items-center gap-2 bg-[#0A0A0A] border border-[#222222] px-3 py-1.5 rounded-full">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-neutral-400 uppercase text-[10px]">Quant Engine:</span>
            <span className="text-white text-[10px]">Active</span>
          </div>

          <div className="flex items-center gap-2 bg-[#0A0A0A] border border-[#222222] px-3 py-1.5 rounded-full">
            <span className={`w-2 h-2 rounded-full ${systemConnected ? "bg-emerald-400 animate-pulse" : "bg-rose-500"}`} />
            <span className="text-neutral-400 uppercase text-[10px]">Feed:</span>
            <span className={`text-[10px] ${systemConnected ? "text-emerald-400" : "text-rose-400"}`}>
              {systemConnected ? "Live" : "Offline"}
            </span>
          </div>

        </div>

      </div>
    </header>
  );
};
