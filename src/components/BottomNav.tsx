import React from "react";
import { Activity, BarChart2, Cpu, Settings } from "lucide-react";

export type NavTab = "signals" | "markets" | "diagnostics";

interface BottomNavProps {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  onOpenSettings: () => void;
  signalCount?: number;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  setActiveTab,
  onOpenSettings,
  signalCount = 0
}) => {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#0A0A0A]/95 backdrop-blur-2xl border-t border-[#1F1F1F] px-4 py-2" id="bottom-navigation-bar">
      <div className="max-w-md mx-auto flex items-center justify-around">
        
        {/* Tab 1: Signals (Main) */}
        <button
          onClick={() => setActiveTab("signals")}
          className={`flex flex-col items-center gap-1 px-4 py-1.5 rounded-xl transition-all cursor-pointer relative ${
            activeTab === "signals"
              ? "text-emerald-400 font-bold"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          id="nav-tab-signals"
        >
          <div className="relative">
            <Activity className="w-5 h-5" />
            {signalCount > 0 && (
              <span className="absolute -top-1 -right-2 bg-emerald-500 text-black text-[9px] font-mono font-black w-4 h-4 rounded-full flex items-center justify-center">
                {signalCount}
              </span>
            )}
          </div>
          <span className="text-[10px] font-mono uppercase tracking-wider">Signals</span>
          {activeTab === "signals" && (
            <span className="absolute -bottom-2 w-8 h-0.5 bg-emerald-400 rounded-full" />
          )}
        </button>

        {/* Tab 2: Markets (Rankings) */}
        <button
          onClick={() => setActiveTab("markets")}
          className={`flex flex-col items-center gap-1 px-4 py-1.5 rounded-xl transition-all cursor-pointer relative ${
            activeTab === "markets"
              ? "text-sky-400 font-bold"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          id="nav-tab-markets"
        >
          <BarChart2 className="w-5 h-5" />
          <span className="text-[10px] font-mono uppercase tracking-wider">Markets</span>
          {activeTab === "markets" && (
            <span className="absolute -bottom-2 w-8 h-0.5 bg-sky-400 rounded-full" />
          )}
        </button>

        {/* Tab 3: Diagnostics */}
        <button
          onClick={() => setActiveTab("diagnostics")}
          className={`flex flex-col items-center gap-1 px-4 py-1.5 rounded-xl transition-all cursor-pointer relative ${
            activeTab === "diagnostics"
              ? "text-amber-400 font-bold"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          id="nav-tab-diagnostics"
        >
          <Cpu className="w-5 h-5" />
          <span className="text-[10px] font-mono uppercase tracking-wider">Diagnostics</span>
          {activeTab === "diagnostics" && (
            <span className="absolute -bottom-2 w-8 h-0.5 bg-amber-400 rounded-full" />
          )}
        </button>

        {/* Settings button */}
        <button
          onClick={onOpenSettings}
          className="flex flex-col items-center gap-1 px-3 py-1.5 rounded-xl text-neutral-500 hover:text-neutral-300 transition-all cursor-pointer"
          id="nav-tab-settings"
          title="Terminal Settings"
        >
          <Settings className="w-5 h-5" />
          <span className="text-[10px] font-mono uppercase tracking-wider">Config</span>
        </button>

      </div>
    </div>
  );
};
