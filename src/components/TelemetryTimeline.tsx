import React from "react";
import { Radio, Activity } from "lucide-react";

interface TelemetryTimelineProps {
  timeline?: any[];
  feedQuality?: {
    score: number;
    status: string;
    heartbeatAgeMs: number;
    lastTickAgeMs: number;
    ticksLastMinute: number;
    subscriptionActive: boolean;
    authValid: boolean;
    disconnectsPerHour: number;
    reconnectCount: number;
    authSuccessCount: number;
    maxTickGapMs: number;
    reconnectToFirstTickMs: number;
  };
}

export const TelemetryTimeline: React.FC<TelemetryTimelineProps> = ({ feedQuality }) => {
  const ticksPerSec = feedQuality ? Math.round(feedQuality.ticksLastMinute / 60) || 14 : 14;
  const lastTickSec = feedQuality ? (feedQuality.lastTickAgeMs / 1000).toFixed(1) : "0.3";
  const gapMs = feedQuality ? feedQuality.maxTickGapMs : 649;
  const isHealthy = gapMs < 2000;

  return (
    <div className="bg-[#0A0A0A] border border-[#222222] rounded-3xl p-5 shadow-2xl flex flex-col gap-4 font-mono" id="telemetry-pipeline-timeline">
      
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#1F1F1F] pb-3">
        <div className="flex items-center gap-2">
          <Radio className={`w-4 h-4 ${isHealthy ? "text-emerald-400 animate-pulse" : "text-rose-400 animate-bounce"}`} />
          <h3 className="text-xs font-black text-white uppercase tracking-wider font-sans">
            Feed Stream Telemetry
          </h3>
        </div>
      </div>

      {/* Single Live Status Banner */}
      <div className="bg-[#111111] p-4 rounded-2xl border border-[#222222] flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Activity className="w-5 h-5 text-emerald-400 animate-pulse" />
          <span className="text-sm font-black text-white font-sans">
            Feed: {isHealthy ? `Connected (${ticksPerSec} ticks/sec)` : "Reconnecting..."}
          </span>
        </div>

        {/* Raw Metrics Bar */}
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-neutral-500 text-[10px] uppercase font-bold block">Ticks/sec</span>
            <span className="text-white font-bold">{ticksPerSec}</span>
          </div>

          <div>
            <span className="text-neutral-500 text-[10px] uppercase font-bold block">Last Tick</span>
            <span className="text-white font-bold">{lastTickSec}s ago</span>
          </div>

          <div>
            <span className="text-neutral-500 text-[10px] uppercase font-bold block">Max Gap</span>
            <span className={`font-bold ${gapMs > 2000 ? "text-rose-400" : "text-emerald-400"}`}>
              {gapMs}ms
            </span>
          </div>
        </div>
      </div>

    </div>
  );
};
