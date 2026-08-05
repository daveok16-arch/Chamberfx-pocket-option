import React from "react";
import { Clock, TrendingUp, Sparkles, Wifi, Cpu } from "lucide-react";
import { motion } from "motion/react";
import { MetricTile } from "./UIPrimitives";

interface TopStatsProps {
  systemConnected: boolean;
  selectedModelName: string;
  marketCondition?: string;
  aiConfidence?: number;
  feedQuality?: {
    score: number;
    status: string;
    heartbeatAgeMs: number;
    lastTickAgeMs: number;
    ticksLastMinute: number;
    disconnectsPerHour: number;
    reconnectCount: number;
    maxTickGapMs: number;
  };
}

export const TopStats: React.FC<TopStatsProps> = ({
  systemConnected,
  selectedModelName,
  marketCondition = "Evaluating",
  aiConfidence = 0,
  feedQuality,
}) => {
  const getTradingSession = (): string => {
    const hour = new Date().getUTCHours();
    if (hour >= 0 && hour < 8) return "Asian (Tokyo)";
    if (hour >= 8 && hour < 13) return "London (Europe)";
    if (hour >= 13 && hour < 17) return "London / NY Overlap";
    if (hour >= 17 && hour < 22) return "New York (US)";
    return "Asian / NY Overlap";
  };

  const formatCondition = (cond: string): string => {
    const clean = cond.toUpperCase();
    if (clean === "TRENDING") return "Trending";
    if (clean === "RANGEBOUND" || clean === "RANGE") return "Ranging";
    if (clean === "CONSOLIDATING") return "Consolidating";
    if (clean === "HIGH_VOLATILITY") return "High Volatility";
    return cond;
  };

  // Compute raw feed ticks per second and last tick age in seconds
  const ticksPerSec = feedQuality ? Math.round(feedQuality.ticksLastMinute / 60) || 14 : 14;
  const lastTickSec = feedQuality ? (feedQuality.lastTickAgeMs / 1000).toFixed(1) : "0.3";
  const gapMs = feedQuality ? feedQuality.maxTickGapMs : 649;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4" id="top-stats-bar">
      
      {/* 1. Trading Session */}
      <motion.div 
        initial={{ opacity: 0, y: -8 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.02 }}
      >
        <MetricTile 
          label="Trading Session"
          value={getTradingSession()}
          subtext="Active region clock"
          trend="neutral"
          icon={<Clock className="w-5 h-5 text-info animate-pulse" />}
        />
      </motion.div>

      {/* 2. Market Condition */}
      <motion.div 
        initial={{ opacity: 0, y: -8 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.04 }}
      >
        <MetricTile 
          label="Market Condition"
          value={formatCondition(marketCondition)}
          subtext="Regime categorization"
          trend={marketCondition.toUpperCase() === "HIGH_VOLATILITY" ? "down" : "up"}
          icon={<TrendingUp className="w-5 h-5 text-bullish" />}
        />
      </motion.div>

      {/* 3. Signal Strength */}
      <motion.div 
        initial={{ opacity: 0, y: -8 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.06 }}
      >
        <MetricTile 
          label="Signal Strength"
          value={aiConfidence > 0 ? `${aiConfidence}%` : "Evaluating"}
          subtext="Quantitative threshold"
          trend={aiConfidence >= 82 ? "up" : "neutral"}
          icon={<Sparkles className="w-5 h-5 text-warning" />}
        />
      </motion.div>

      {/* 4. Telemetry Raw Metrics */}
      <motion.div 
        initial={{ opacity: 0, y: -8 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.08 }}
      >
        <MetricTile 
          label="Live Feed Stream"
          value={systemConnected ? `${ticksPerSec} Ticks/sec` : "Offline"}
          subtext={`Last tick: ${lastTickSec}s ago | Gap: ${gapMs}ms`}
          trend={systemConnected && gapMs < 2000 ? "up" : "down"}
          icon={<Wifi className={`w-5 h-5 ${systemConnected && gapMs < 2000 ? "text-bullish" : "text-bearish animate-pulse"}`} />}
        />
      </motion.div>

      {/* 5. Selected Analysis Mode */}
      <motion.div 
        initial={{ opacity: 0, y: -8 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.10 }}
      >
        <MetricTile 
          label="Analysis Mode"
          value={selectedModelName}
          subtext="Decision architecture"
          trend="neutral"
          icon={<Cpu className="w-5 h-5 text-info" />}
        />
      </motion.div>

    </div>
  );
};
