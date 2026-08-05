export interface Candle {
  time: number; // unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type MarketRegime = "TRENDING" | "RANGEBOUND" | "CONSOLIDATING" | "HIGH_VOLATILITY" | "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "VOLATILE" | "BREAKOUT_PENDING";

export type AIRegime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "VOLATILE" | "BREAKOUT_PENDING";

export interface IndicatorWeights {
  ema: number;      // base: 1.2
  rsi: number;      // base: 1.5
  macd: number;     // base: 1.1
  bb: number;       // base: 1.0
  stoch: number;    // base: 0.9
  adx: number;      // base: 1.3
  velocity: number; // base: 1.0
}

export interface MarketRegimeClassification {
  regime: AIRegime;
  confidence: number;
  suggestedWeights: Partial<IndicatorWeights>;
  rationale: string;
}

export interface TechnicalIndicators {
  rsi: number;
  ema9: number;
  ema21: number;
  macdLine: number;
  macdSignal: number;
  macdHist: number;
  atr: number;
  bbUpper: number;
  bbLower: number;
  bbSMA: number;
  bbPosition: number; // %B position (0 to 1)
  adx: number;
  plusDI: number;
  minusDI: number;
  support: number;
  resistance: number;
  momentum: number; // calculated momentum score
  liquidity: number; // calculated tick frequency or volume proxy
  trendStrength: "STRONG" | "MODERATE" | "WEAK";
  pattern: string; // "HAMMER" | "SHOOTING_STAR" | "BULLISH_ENGULFING" | "BEARISH_ENGULFING" | "NONE"
  tickVelocity?: number; // Price velocity in units/second (1st derivative)
  tickAcceleration?: number; // Price acceleration in units/second^2 (2nd derivative)
  priceRejectionScore?: number; // Score indicating reversal pressure near S/R (-100 bearish to 100 bullish)
  priceRejectionState?: "BULLISH" | "BEARISH" | "NONE";
}

export interface PairRankData {
  assetId: string;
  name: string;
  price: number;
  payout: number;
  regime?: MarketRegime | AIRegime | string;
  indicators?: TechnicalIndicators;
  qualityScore: number; // calculated from indicators alignment
  rank: number;
  aiWeights?: IndicatorWeights;
  rationale?: string;
}

export interface AIAnalysisResult {
  assetId: string;
  pairName: string;
  modelUsed: string;
  timestamp: string;
  commentary: string;
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCERTAIN";
  reasoningChain: string[];
  keyLevels: {
    immediateSupport: number;
    immediateResistance: number;
    targetLevel: number;
    stopLevel: number;
  };
  marketStructure: string;
  volatilityState: string;
  momentumState: string;
  riskAssessment: string;
  durationMs: number; // inference duration
}

export type StrategyModuleId = "precision" | "turbo" | "swing";

export interface ConfluenceMeter {
  current: number;
  total: number;
  details: Array<string | { name: string; active: boolean; description: string }>;
}

export interface SetupQualityBreakdown {
  trendStructure: number; // 0-25%
  srProximity: number;    // 0-25%
  tickPressure: number;   // 0-25%
  aiConsensus: number;    // 0-25%
  totalScore: number;     // 0-100%
  trend?: number;
  sr?: number;
  pressure?: number;
  ai?: number;
  total?: number;
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  strategy: StrategyModuleId;
  assetId: string;
  assetName: string;
  direction: "CALL" | "PUT" | "WAIT";
  strength: number;
  entryPrice: number;
  payout: number;
  reasoning: string;
  srLevels?: {
    support: number;
    resistance: number;
  };
  qualityBreakdown?: SetupQualityBreakdown;
  result?: "WIN" | "LOSS" | "PENDING";
}

export interface TradeSignal {
  assetId: string;
  name: string;
  price: number;
  payout: number;
  direction: "BUY" | "SELL" | "WAIT";
  confidence: number; // 0 to 100
  expiration: "30s" | "1m" | "2m" | "3m" | "5m";
  entryStatus: "Execute Now" | "Wait for Confirmation";
  trendStrength: "STRONG" | "MODERATE" | "WEAK";
  riskLevel: "LOW" | "MODERATE" | "HIGH";
  probability: number; // 0 to 100
  support: number;
  resistance: number;
  reasons: string[];
  timestamp: number;
  timeframe: "1m" | "2m" | "3m" | "5m";
  candleStartTime: number; // unix timestamp in seconds
  candleEndTime: number; // unix timestamp in seconds
  timeRemainingNextCandle: number; // seconds remaining
  signalValidUntil: number; // unix timestamp in seconds
  signalStatus: "READY" | "WAIT_NEXT_CANDLE" | "NO_TRADE";
  firstBlockingRule?: string;
  allBlockingRules?: string[];
  consensusDetails?: ConsensusDetails;
  feedQualityScore?: number;
  feedQualityStatus?: string;
  regime?: MarketRegime | AIRegime | string;
  aiWeights?: IndicatorWeights;
  rationale?: string;
  strategyModule?: StrategyModuleId;
}

export interface ConsensusDetails {
  emaVote: number;
  macdVote: number;
  rsiVote: number;
  bbVote: number;
  dmiVote: number;
  rejectionVote: number;
  velocityVote: number;
  weightedSum: number;
  totalWeight: number;
  consensusRatio: number;
  consensusThreshold: number;
  candidateDirection: "BUY" | "SELL" | "WAIT";
  marketRegime: "TREND" | "REVERSAL";
}

export interface ModelInfo {
  id: string;
  displayName: string;
  status: "ACTIVE" | "FALLBACK" | "OFFLINE" | "RATE_LIMITED";
  provider: string;
  type: string;
  description: string;
}

export interface FeedQualityDetails {
  score: number; // 0 to 100
  status: "EXCELLENT" | "STABLE" | "DEGRADED" | "CRITICAL";
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
}

export interface TelemetryMetrics {
  wsStatus: "CONNECTED" | "DISCONNECTED" | "CONNECTING";
  ticksTotal: number;
  ticksPerMinute: number;
  apiSuccessCount: number;
  apiFailureCount: number;
  lastApiLatencyMs: number;
  averageApiLatencyMs: number;
  turbo_latency_ms?: number;
  fallbackCount: number;
  activeModelId: string;
  activeModelName: string;
  cpuUsage?: number;
  memoryUsage?: string;
  uptimeSeconds: number;
  lastTickTime: number;
  systemLogs: string[];
  telemetryTimeline?: Array<{
    timestamp: string;
    type: string;
    status: "OK" | "WARNING" | "FAIL";
    message: string;
  }>;
  feedQuality?: FeedQualityDetails;
  reconnectCount?: number;
  authSuccessCount?: number;
  maxTickGapMs?: number;
  lastReconnectToFirstTickMs?: number;
}

export interface LedgerSignal {
  id: string;
  assetId: string;
  name: string;
  type: "CALL" | "PUT";
  entryPrice: number;
  currentPrice: number;
  payout: number;
  timestamp: string;
  expirySeconds: number;
  status: "ACTIVE" | "WIN" | "LOSS";
}

export type SignalStatusType = 
  | "SCANNING"
  | "ANALYZING"
  | "WAITING_CONFIRMATION"
  | "SIGNAL_READY"
  | "ENTRY_OPEN"
  | "ENTRY_CLOSED"
  | "FEED_OFFLINE";

export type PipelineState = "IDLE" | "SCANNING" | "SIGNAL" | "ENTERED" | "SETTLING";

export interface ActiveTradeInfo {
  tradeId: string;
  assetId: string;
  assetName: string;
  direction: "CALL" | "PUT";
  entryPrice: number;
  enteredAt: number;
  expiryTime: number;
  payout: number;
  currentPrice?: number;
  pipsDiff?: string;
}

export interface LeadingIndicators {
  tickPressurePercent: number;
  tickPressureBias: 'BUY' | 'SELL' | 'NEUTRAL';
  tickPressureText: string;
  pattern: 'HAMMER' | 'SHOOTING_STAR' | 'NONE';
  patternBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  patternText: string;
  vwapSigma: number;
  vwapState: 'OVERSOLD' | 'OVERBOUGHT' | 'NORMAL';
  vwapBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  vwapText: string;
  momentumAccelPercent: number;
  momentumBias: 'UP' | 'DOWN' | 'NEUTRAL';
  momentumText: string;
  confluenceScore: number;
  confluenceBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confluenceText: string;
  consecutiveCandles: number;
  consecutiveDirection: 'GREEN' | 'RED' | 'NEUTRAL';
  trendContext: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
  moveExhausted: boolean;
  moveCompletionPercent: number;
  exhaustionText: string;
  confidenceScore: number;
  confidenceLevel: 'STRONG' | 'MODERATE' | 'LOW' | 'BLOCKED';
  blockedReason?: string;
  momentumBurst: boolean;
  moveOverextended?: boolean;
  isOTC?: boolean;
  atr10?: number;
}

export interface PipelineInfo {
  state: PipelineState;
  activeStrategy?: StrategyModuleId;
  activeAssetCount?: number;
  scanTimedOut?: boolean;
  activeSignal: {
    assetId: string;
    assetName: string;
    direction: "CALL" | "PUT" | "WAIT";
    entryPrice: number;
    strength: number;
    rationale: string;
    payout: number;
    strategyModule?: StrategyModuleId;
    confluenceMeter?: ConfluenceMeter;
    qualityBreakdown?: SetupQualityBreakdown;
    srLevels?: { support: number; resistance: number };
    leadingIndicators?: LeadingIndicators;
  } | null;
  activeTrade: ActiveTradeInfo | null;
  secondsToSignalExpiry: number;
  secondsToTradeExpiry: number;
  secondsToSettlingEnd: number;
  turboCircuitBreakerActive?: boolean;
  settlingResult: {
    assetId: string;
    assetName: string;
    poPrice: number;
    botPrice: number;
    diffPips: number;
    direction: "CALL" | "PUT" | "WAIT";
    isWin: boolean;
    timestamp: number;
  } | null;
}

export interface DecisionObject {
  asset: {
    id: string;
    name: string;
    price: number;
    payout: number;
  } | null;
  direction: "CALL" | "PUT" | "WAIT";
  confidence: number;
  timeframe: string; // e.g. "1m", "5s", "5m"
  entryWindow: string; // e.g. "1.08240 - 1.08250"
  signalStatus: SignalStatusType;
  reasoning: string[];
  risk: "LOW" | "MODERATE" | "HIGH";
  countdown: number;
  aiValidated: boolean;
  generatedAt: string;
  strategyModule?: StrategyModuleId;
  confluenceMeter?: ConfluenceMeter;
  qualityBreakdown?: SetupQualityBreakdown;
  srLevels?: { support: number; resistance: number };
  turboCircuitBreakerActive?: boolean;
  entryPrice?: number;
  exitPrice?: number;
  result?: "WIN" | "LOSS" | "WAIT" | null;
  regime?: MarketRegime | AIRegime | string;
  feedQualityScore?: number;
  feedQualityStatus?: string;
  aiWeights?: IndicatorWeights;
  rationale?: string;
  pipeline?: PipelineInfo;
  leadingIndicators?: LeadingIndicators;
  latencyMetrics?: {
    poToBotLatencyMs: number;
    processingTimeMs: number;
    ticksBuffered: number;
  };
}

