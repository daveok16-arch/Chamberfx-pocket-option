import { TelemetryMetrics, FeedQualityDetails } from "../types";

export class TelemetryService {
  private static instance: TelemetryService | null = null;

  private wsStatus: "CONNECTED" | "DISCONNECTED" | "CONNECTING" = "CONNECTING";
  private ticksTotal = 0;
  private ticksLastMinute = 0;
  private ticksTimestampMap: number[] = []; // to compute moving tick rates

  private apiSuccessCount = 0;
  private apiFailureCount = 0;
  private apiLatencyHistory: number[] = [];
  private lastApiLatencyMs = 0;
  private fallbackCount = 0;
  
  private activeModelId = "nemotron-3-ultra-free";
  private activeModelName = "Llama 3.3 70B (Versatile)";
  private systemLogs: string[] = [];
  private maxLogs = 50;

  private startTimestamp = Date.now();
  private lastTickTime = 0;
  private lastPingTime = Date.now();

  // Quantitative Connection & Transport Performance Metrics
  private reconnectCount = 0;
  private authSuccessCount = 0;
  private lastReconnectTimestamp = 0;
  private lastReconnectToFirstTickMs = 0;
  private maxTickGapMs = 0;

  private telemetryTimeline: Array<{
    timestamp: string;
    type: string;
    status: "OK" | "WARNING" | "FAIL";
    message: string;
  }> = [];

  private constructor() {
    this.log("Telemetry Engine Online. Monitoring real-time streams...");
    this.addTimelineEvent("ENGINE_START", "OK", "Telemetry Engine initialized, awaiting raw WebSocket connection...");
  }

  public addTimelineEvent(type: string, status: "OK" | "WARNING" | "FAIL", message: string) {
    const timestamp = new Date().toISOString();
    this.telemetryTimeline.push({ timestamp, type, status, message });
    if (this.telemetryTimeline.length > 50) {
      this.telemetryTimeline.shift();
    }
    this.log(`[TIMELINE] [${type}] (${status}) ${message}`);
  }

  public registerPing() {
    this.lastPingTime = Date.now();
  }

  public getLastPingTime(): number {
    return this.lastPingTime;
  }

  public registerReconnect() {
    this.reconnectCount++;
    this.lastReconnectTimestamp = Date.now();
  }

  public registerAuthSuccess() {
    this.authSuccessCount++;
  }

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  public log(message: string) {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
    const logLine = `[${timestamp}] ${message}`;
    console.log(logLine);
    this.systemLogs.unshift(logLine);
    if (this.systemLogs.length > this.maxLogs) {
      this.systemLogs.pop();
    }
  }

  public setWsStatus(status: "CONNECTED" | "DISCONNECTED" | "CONNECTING") {
    if (this.wsStatus !== status) {
      this.wsStatus = status;
      if (status === "CONNECTED") {
        this.lastPingTime = Date.now();
      }
      this.log(`Network State Changed: ${status}`);
    }
  }

  public registerTick() {
    const now = Date.now();
    if (this.lastTickTime > 0) {
      const gap = now - this.lastTickTime;
      if (gap > this.maxTickGapMs) {
        this.maxTickGapMs = gap;
      }
    }
    if (this.lastReconnectTimestamp > 0 && this.lastReconnectToFirstTickMs === 0) {
      this.lastReconnectToFirstTickMs = now - this.lastReconnectTimestamp;
    }

    this.ticksTotal++;
    this.lastTickTime = now;
    this.ticksTimestampMap.push(now);
    this.cleanTickTimestamps();
  }

  private cleanTickTimestamps() {
    const now = Date.now();
    // filter timestamps within last 60 seconds
    this.ticksTimestampMap = this.ticksTimestampMap.filter(t => now - t < 60000);
    this.ticksLastMinute = this.ticksTimestampMap.length;
  }

  public getFeedQuality(): FeedQualityDetails {
    const now = Date.now();
    const heartbeatAgeMs = now - this.lastPingTime;
    const lastTickAgeMs = this.ticksTotal > 0 && this.lastTickTime > 0 ? now - this.lastTickTime : 999999;
    const uptimeSeconds = Math.max(1, Math.floor((now - this.startTimestamp) / 1000));
    const uptimeHours = uptimeSeconds / 3600;
    const disconnectsPerHour = parseFloat((this.reconnectCount / Math.max(0.01, uptimeHours)).toFixed(2));

    let score = 0;

    // 1. WebSocket Base Connection Score (30 points)
    if (this.wsStatus === "CONNECTED") {
      score += 30;
    } else if (this.wsStatus === "CONNECTING") {
      score += 10;
    }

    // 2. Heartbeat Health (20 points max)
    if (heartbeatAgeMs <= 5000) {
      score += 20;
    } else if (heartbeatAgeMs <= 15000) {
      score += 15;
    } else if (heartbeatAgeMs <= 30000) {
      score += 5;
    }

    // 3. Tick Freshness (30 points max)
    if (lastTickAgeMs <= 1000) {
      score += 30;
    } else if (lastTickAgeMs <= 3000) {
      score += 25;
    } else if (lastTickAgeMs <= 5000) {
      score += 15;
    } else if (lastTickAgeMs <= 10000) {
      score += 5;
    }

    // 4. Tick Density (20 points max)
    if (this.ticksLastMinute >= 300) {
      score += 20;
    } else if (this.ticksLastMinute >= 100) {
      score += 15;
    } else if (this.ticksLastMinute >= 20) {
      score += 10;
    } else if (this.ticksLastMinute > 0) {
      score += 5;
    }

    let status: "EXCELLENT" | "STABLE" | "DEGRADED" | "CRITICAL" = "CRITICAL";
    if (this.wsStatus !== "CONNECTED") {
      score = 0;
      status = "CRITICAL";
    } else if (score >= 85) {
      status = "EXCELLENT";
    } else if (score >= 70) {
      status = "STABLE";
    } else if (score >= 50) {
      status = "DEGRADED";
    } else {
      status = "CRITICAL";
    }

    return {
      score,
      status,
      heartbeatAgeMs,
      lastTickAgeMs,
      ticksLastMinute: this.ticksLastMinute,
      subscriptionActive: this.wsStatus === "CONNECTED" && this.ticksLastMinute > 0,
      authValid: this.authSuccessCount > 0,
      disconnectsPerHour,
      reconnectCount: this.reconnectCount,
      authSuccessCount: this.authSuccessCount,
      maxTickGapMs: this.maxTickGapMs,
      reconnectToFirstTickMs: this.lastReconnectToFirstTickMs
    };
  }

  public registerApiCall(success: boolean, latencyMs: number, modelId: string, modelName: string, isFallback: boolean) {
    this.lastApiLatencyMs = latencyMs;
    this.activeModelId = modelId;
    this.activeModelName = modelName;

    if (success) {
      this.apiSuccessCount++;
      this.apiLatencyHistory.push(latencyMs);
      if (this.apiLatencyHistory.length > 20) {
        this.apiLatencyHistory.shift();
      }
      this.log(`Inference Complete via ${modelName} in ${latencyMs}ms`);
    } else {
      this.apiFailureCount++;
      this.log(`AI Inference Failed using ${modelName}`);
    }

    if (isFallback) {
      this.fallbackCount++;
      this.log(`Dynamic Fallback triggered. Routed to secondary model pool: ${modelName}`);
    }
  }

  public getMetrics(): TelemetryMetrics {
    this.cleanTickTimestamps();
    
    const sumLatency = this.apiLatencyHistory.reduce((a, b) => a + b, 0);
    const averageApiLatencyMs = this.apiLatencyHistory.length > 0 
      ? Math.round(sumLatency / this.apiLatencyHistory.length) 
      : 0;

    const uptimeSeconds = Math.floor((Date.now() - this.startTimestamp) / 1000);
    const feedQuality = this.getFeedQuality();

    return {
      wsStatus: this.wsStatus,
      ticksTotal: this.ticksTotal,
      ticksPerMinute: this.ticksLastMinute,
      apiSuccessCount: this.apiSuccessCount,
      apiFailureCount: this.apiFailureCount,
      lastApiLatencyMs: this.lastApiLatencyMs,
      averageApiLatencyMs,
      fallbackCount: this.fallbackCount,
      activeModelId: this.activeModelId,
      activeModelName: this.activeModelName,
      uptimeSeconds,
      lastTickTime: this.lastTickTime,
      systemLogs: [...this.systemLogs],
      telemetryTimeline: [...this.telemetryTimeline],
      feedQuality,
      reconnectCount: this.reconnectCount,
      authSuccessCount: this.authSuccessCount,
      maxTickGapMs: this.maxTickGapMs,
      lastReconnectToFirstTickMs: this.lastReconnectToFirstTickMs
    };
  }
}

export const telemetry = TelemetryService.getInstance();
