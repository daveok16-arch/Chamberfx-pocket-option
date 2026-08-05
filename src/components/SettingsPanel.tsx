import React from "react";
import { Sliders, CheckCircle2 } from "lucide-react";
import { Modal } from "./UIPrimitives";

export interface ModeConfig {
  minStrength: number;
  entryWindow: number;
  adxThreshold: number;
}

export const MODES: Record<string, ModeConfig & { label: string; description: string }> = {
  QUANTITATIVE: {
    label: "Quantitative (Standard)",
    minStrength: 82,
    entryWindow: 18,
    adxThreshold: 25,
    description: "Standard balanced strategy. Requires 82% minimum Signal Strength and 18s entry window."
  },
  CONSERVATIVE: {
    label: "Conservative",
    minStrength: 88,
    entryWindow: 15,
    adxThreshold: 30,
    description: "High-conviction, selective filter. Requires 88% Signal Strength and 15s entry window."
  },
  AGGRESSIVE: {
    label: "Aggressive",
    minStrength: 78,
    entryWindow: 22,
    adxThreshold: 20,
    description: "Higher signal frequency. Accepts 78% Signal Strength and 22s entry window."
  }
};

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  operationalMode: string;
  setOperationalMode: (mode: string) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen,
  onClose,
  operationalMode,
  setOperationalMode,
}) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Analysis Mode & Parameters" icon={<Sliders className="w-5 h-5 text-emerald-400" />}>
      <div className="space-y-6 font-mono" id="app-settings-container">
        
        <div className="space-y-3">
          <label className="text-xs font-bold text-neutral-300 uppercase tracking-wider block">
            Select Analysis Mode
          </label>
          <div className="grid grid-cols-1 gap-3">
            {Object.entries(MODES).map(([key, config]) => {
              const isSelected = operationalMode === key;
              return (
                <button
                  key={key}
                  onClick={() => setOperationalMode(key)}
                  className={`p-4 rounded-2xl border text-left transition-all cursor-pointer relative ${
                    isSelected
                      ? "bg-emerald-950/30 border-emerald-500/50 text-white shadow-lg shadow-emerald-500/5"
                      : "bg-[#111111] border-[#222222] text-neutral-400 hover:border-[#333333] hover:text-white"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-sans font-black text-sm text-white">
                      {config.label}
                    </span>
                    {isSelected && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    )}
                  </div>

                  <p className="text-xs text-neutral-400 font-sans mb-3 leading-relaxed">
                    {config.description}
                  </p>

                  <div className="grid grid-cols-3 gap-2 text-[10px] bg-[#0A0A0A] p-2.5 rounded-xl border border-[#1A1A1A]">
                    <div>
                      <span className="text-neutral-500 block uppercase">Min Signal Strength</span>
                      <span className="font-bold text-emerald-400 mt-0.5 block">{config.minStrength}%</span>
                    </div>
                    <div>
                      <span className="text-neutral-500 block uppercase">Entry Window</span>
                      <span className="font-bold text-white mt-0.5 block">{config.entryWindow}s</span>
                    </div>
                    <div>
                      <span className="text-neutral-500 block uppercase">ADX Trend Floor</span>
                      <span className="font-bold text-sky-400 mt-0.5 block">≥ {config.adxThreshold}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#0F0F0F] border border-[#222222] text-[11px] text-neutral-400 leading-relaxed font-sans">
          ● All signals are strictly standardized to <strong>1-Minute</strong> option contracts with an 18s entry window.
        </div>

      </div>
    </Modal>
  );
};
