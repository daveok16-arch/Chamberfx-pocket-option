import React from "react";
import { StrategyId, STRATEGIES } from "../config/strategies";
import { useStrategyStore } from "../store/strategyStore";

interface StrategySelectorProps {
  currentStrategy?: StrategyId;
  onSelectStrategy?: (strategy: StrategyId) => void;
  disabled?: boolean;
}

export const StrategySelector: React.FC<StrategySelectorProps> = ({
  currentStrategy: propStrategy,
  onSelectStrategy,
  disabled = false
}) => {
  const store = useStrategyStore();
  const activeStrategy = propStrategy || store.activeStrategy;

  const handleSelect = (id: StrategyId) => {
    if (onSelectStrategy) {
      onSelectStrategy(id);
    } else {
      store.setStrategy(id);
    }
  };

  const currentConfig = STRATEGIES[activeStrategy] || STRATEGIES.precision;

  return (
    <div className="w-full bg-[#0d0d0d] border border-[#1f1f1f] p-1.5 rounded-xl">
      <div className="grid grid-cols-2 gap-1.5">
        {Object.values(STRATEGIES).map((strat) => {
          const isActive = activeStrategy === strat.id;
          return (
            <button
              key={strat.id}
              type="button"
              disabled={disabled}
              onClick={() => handleSelect(strat.id as StrategyId)}
              className={`h-[52px] px-5 py-3 rounded-lg text-sm font-bold transition-all duration-150 flex flex-col items-center justify-center gap-0.5 border relative overflow-hidden ${
                isActive
                  ? `bg-[#161618] text-white border-opacity-100 shadow-[0_0_16px_rgba(0,0,0,0.6)] font-black`
                  : "bg-[#121212] hover:bg-[#181818] text-neutral-400 border-[#1f1f1f] hover:border-[#333333]"
              } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
              style={{
                borderColor: isActive ? strat.color : 'transparent'
              }}
            >
              {isActive && (
                <span
                  className="absolute top-0 left-0 right-0 h-1"
                  style={{ background: strat.badgeGradient }}
                />
              )}
              
              <span
                className="text-sm font-sans tracking-tight truncate w-full text-center leading-none uppercase font-black"
                style={{ color: isActive ? strat.color : undefined }}
              >
                {strat.label}
              </span>

              <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-neutral-400 leading-none mt-0.5">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: strat.color }}
                />
                <span className="truncate font-semibold">{strat.risk} RISK</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected Strategy Description Footer */}
      <div className="mt-1.5 pt-1.5 border-t border-[#1a1a1a] px-1 flex items-center justify-between text-[10px] font-mono text-neutral-400">
        <div className="truncate flex items-center gap-2">
          <span className="truncate text-neutral-400">{currentConfig.description}</span>
        </div>
        <span
          className="font-bold px-1.5 py-0.5 rounded border text-[9px] ml-2 shrink-0 font-mono"
          style={{
            color: currentConfig.color,
            borderColor: `${currentConfig.color}44`,
            backgroundColor: `${currentConfig.color}11`
          }}
        >
          {currentConfig.timeframeLabel}
        </span>
      </div>
    </div>
  );
};
