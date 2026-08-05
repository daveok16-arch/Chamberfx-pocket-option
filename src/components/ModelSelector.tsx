import React from "react";
import { Sliders, Check, Zap, ShieldCheck } from "lucide-react";
import { Modal } from "./UIPrimitives";

interface ModelSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  availableModels: any[];
  selectedModelId: string;
  onSelectModel: (modelId: string) => void;
}

const MODES = [
  {
    id: "gemini-3.5-flash-free",
    displayName: "Quantitative (Balanced Momentum)",
    speed: "0.2s",
    accuracy: "High Precision",
    minConviction: 82,
    minAdx: 20,
    windowSeconds: 18,
    description: "Multi-oscillator consensus weighting fast EMAs (9/21), RSI(14), and Bollinger expansion."
  },
  {
    id: "gemini-3.0-pro-free",
    displayName: "Conservative (High Conviction)",
    speed: "0.5s",
    accuracy: "Strict Consensus",
    minConviction: 88,
    minAdx: 25,
    windowSeconds: 12,
    description: "Requires strict ADX > 25 and MACD histogram zero-baseline alignment before signaling."
  },
  {
    id: "gemini-2.5-flash-free",
    displayName: "Aggressive (Scalp Mode)",
    speed: "0.1s",
    accuracy: "Early Breakout",
    minConviction: 78,
    minAdx: 15,
    windowSeconds: 22,
    description: "Optimized for fast candle open momentum micro-bursts with 22-second entry window."
  }
];

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  isOpen,
  onClose,
  selectedModelId,
  onSelectModel,
}) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Select Analysis Mode" icon={<Sliders className="w-5 h-5 text-info" />}>
      <div className="space-y-4" id="analysis-mode-selection-grid">
        <p className="text-sm text-text-secondary leading-relaxed font-mono">
          Choose indicator threshold profile for signal generation:
        </p>

        <div className="space-y-3">
          {MODES.map((mode) => {
            const isSelected = selectedModelId === mode.id || (selectedModelId.includes("flash") && mode.id.includes("flash"));
            return (
              <button
                key={mode.id}
                onClick={() => {
                  onSelectModel(mode.id);
                  onClose();
                }}
                className={`w-full text-left p-5 rounded-2xl border transition-fintech flex flex-col gap-2 min-h-[48px] cursor-pointer relative ${
                  isSelected
                    ? "bg-info/10 border-info/40 shadow-lg shadow-info/5"
                    : "bg-panel-elevated/40 border-border-subtle hover:border-text-muted hover:bg-panel-hover"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-white font-sans">{mode.displayName}</span>
                    <span className="text-[10px] bg-panel-elevated text-info border border-info/20 px-2 py-0.5 rounded font-mono font-bold uppercase">
                      QUANT
                    </span>
                  </div>
                  {isSelected && (
                    <div className="w-5 h-5 rounded-full bg-info flex items-center justify-center">
                      <Check className="w-3.5 h-3.5 text-canvas" />
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 text-[11px] font-mono mt-1">
                  <span className="bg-[#0A0C10] px-2.5 py-1 rounded-lg border border-[#242B3C] text-amber-400 font-bold">
                    Floor: {mode.minConviction}%
                  </span>
                  <span className="bg-[#0A0C10] px-2.5 py-1 rounded-lg border border-[#242B3C] text-info font-bold">
                    ADX: &gt; {mode.minAdx}
                  </span>
                  <span className="bg-[#0A0C10] px-2.5 py-1 rounded-lg border border-[#242B3C] text-emerald-400 font-bold">
                    Window: {mode.windowSeconds}s
                  </span>
                  <span className="bg-[#0A0C10] px-2.5 py-1 rounded-lg border border-[#242B3C] text-text-secondary font-bold">
                    Calc: {mode.speed}
                  </span>
                </div>

                <p className="text-xs text-text-muted leading-relaxed font-sans mt-1">
                  {mode.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
};
