/**
 * Pocket Option Live Price Capture Bot
 * 
 * This bot connects to Pocket Option via WebSocket (Socket.IO protocol)
 * and captures real-time price data for OTC currency pairs.
 * 
 * Price Capture Flow:
 * 1. Discover WebSocket URL via Playwright headless browser
 * 2. Connect to Pocket Option WebSocket
 * 3. Authenticate session
 * 4. Subscribe to asset price streams
 * 5. Process incoming tick data
 * 6. Build candles and emit prices
 */

import { WebSocket } from "ws";
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

// ============================================
// TYPES
// ============================================

export interface Tick {
  assetId: string;
  price: number;
  timestamp: number; // ms
  direction: 'UP' | 'DOWN' | 'FLAT';
}

export interface Candle {
  assetId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number; // ms
  closeTime: number; // ms
}

export interface AssetInfo {
  id: string;
  name: string;
  payout: number;
  active: boolean;
  lastPrice: number;
  lastTickTime: number;
  ticks: number[];
  candles: Candle[];
}

export interface PriceCaptureConfig {
  /** Default assets to track */
  defaultAssets: string[];
  /** WebSocket connection URL (auto-discovered if empty) */
  wsUrl?: string;
  /** Session cookies (auto-captured if empty) */
  cookies?: string;
  /** Auth packet (auto-intercepted if empty) */
  authPacket?: string;
  /** Save prices to file */
  saveToFile: boolean;
  /** Output file path for prices */
  outputFile: string;
  /** Enable console logging */
  verbose: boolean;
  /** Reconnection delay in ms */
  reconnectDelay: number;
  /** Max reconnection attempts */
  maxReconnectAttempts: number;
  /** Candle period in seconds (default 60 = 1-minute candles).
   *  Must match the signal expiry (1/3/5 minutes → 60/180/300) so the
   *  candles built from ticks align with the period the engine predicts. */
  candlePeriod: number;
  /** Subscription period (seconds) sent to Pocket Option in the changeSymbol
   *  packet. Defaults to candlePeriod. Pocket Option returns history at this
   *  granularity, so it must match candlePeriod for correct seeding. */
  subscribePeriod?: number;
}

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_CONFIG: PriceCaptureConfig = {
  defaultAssets: [
    "EURUSD_otc",
    "GBPUSD_otc",
    "USDJPY_otc",
    "XAUUSD_otc",
    "AUDUSD_otc",
    "USDCAD_otc",
    "USDCHF_otc",
    "NZDUSD_otc",
    "EURGBP_otc"
  ],
  saveToFile: true,
  outputFile: "./prices.json",
  verbose: true,
  reconnectDelay: 3000,
  maxReconnectAttempts: 10,
  candlePeriod: 60
};

const POCKET_OPTION_URLS = [
  "wss://api-us.po.market/socket.io/?EIO=4&transport=websocket",
  "wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket",
  "wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket"
];

// ============================================
// PRICE CAPTURE ENGINE
// ============================================

export class PocketOptionPriceBot {
  private ws: WebSocket | null = null;
  private config: PriceCaptureConfig;
  private assets: Map<string, AssetInfo> = new Map();
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private lastPingTime: number = 0;
  
  // Discovered session data
  private discoveredWsUrl: string = "";
  private cachedAuthPacket: string = "";
  private cachedCookies: string = "";
  private isAuthenticated: boolean = false;
  
  // Binary attachment handling
  private pendingBinaryEvent: string | null = null;
  private binaryDataBuffer: Buffer[] = [];
  
  // Price history (for export)
  private priceHistory: Map<string, Tick[]> = new Map();
  
  // Callbacks (multiple listeners supported)
  private tickListeners: ((tick: Tick) => void)[] = [];
  private candleListeners: ((candle: Candle) => void)[] = [];
  private connectListeners: (() => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  private errorListeners: ((error: Error) => void)[] = [];

  /**
   * Create a new Pocket Option price capture bot.
   * @param config - Configuration options for price capture, connection, and data persistence
   */
  constructor(config: Partial<PriceCaptureConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeAssets();
  }

  /**
   * Initialize asset tracking data structures for configured assets.
   */
  private initializeAssets(): void {
    for (const assetId of this.config.defaultAssets) {
      this.assets.set(assetId, {
        id: assetId,
        name: assetId.replace("_otc", "/OTC").replace("XAUUSD", "GOLD"),
        payout: 0.92,
        active: true,
        lastPrice: 0,
        lastTickTime: 0,
        ticks: [],
        candles: []
      });
      this.priceHistory.set(assetId, []);
    }
  }

  // ============================================
  // SESSION DISCOVERY (Playwright)
  // ============================================

  /**
   * Discover Pocket Option WebSocket URL and session credentials using Playwright.
   * Launches a headless browser to capture WebSocket connection details and auth packets.
   * @returns Session information including WebSocket URL, auth packet, and cookies
   */
  private async discoverSession(): Promise<{ url: string; authPacket: string; cookies: string }> {
    this.log("[DISCOVERY] Launching headless browser to intercept Pocket Option session...");
    
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      });
    } catch (err: any) {
      if (err.message?.includes("Executable doesn't exist")) {
        this.log("[DISCOVERY] Installing Chromium...");
        const { execSync } = await import("child_process");
        execSync("npx playwright install chromium", { stdio: "inherit" });
        browser = await chromium.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        });
      } else {
        throw err;
      }
    }

    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      });
      
      const page = await context.newPage();
      let capturedWsUrl = "";
      let capturedAuthPacket = "";
      
      // Intercept WebSocket connections
      page.on("websocket", (ws) => {
        const url = ws.url();
        if (url.includes("socket.io") && (url.includes("po.market") || url.includes("po.trade") || url.includes("po.cash"))) {
          this.log(`[DISCOVERY] Captured WebSocket: ${url}`);
          capturedWsUrl = url;
          
          // Capture auth packets
          ws.on("framesent", (frame) => {
            const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8");
            if (payload.includes('"auth"')) {
              capturedAuthPacket = payload;
              this.log(`[DISCOVERY] Captured auth packet: ${payload.slice(0, 100)}...`);
            }
          });
        }
      });

      // Try multiple Pocket Option URLs
      const candidates = [
        "https://po.trade/en/cabinet/try-demo/",
        "https://pocketoption.com/en/cabinet/try-demo/",
        "https://po.cash/en/cabinet/try-demo/"
      ];

      for (const url of candidates) {
        if (capturedWsUrl) break;
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(8000); // Wait for WebSocket handshake
        } catch (e) {
          this.log(`[DISCOVERY] Failed to load ${url}`);
        }
      }

      const cookies = await context.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
      
      await browser.close();

      if (capturedWsUrl) {
        return { url: capturedWsUrl, authPacket: capturedAuthPacket, cookies: cookieStr };
      }
      
      throw new Error("Failed to discover WebSocket URL");
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }

  // ============================================
  // WEBSOCKET CONNECTION
  // ============================================

  /**
   * Connect to Pocket Option WebSocket and authenticate the session.
   * Discovers session credentials if not provided in configuration.
   */
  public async connect(): Promise<void> {
    try {
      // Discover session if URL not provided
      if (!this.config.wsUrl) {
        const session = await this.discoverSession();
        this.discoveredWsUrl = session.url;
        this.cachedAuthPacket = session.authPacket;
        this.cachedCookies = session.cookies;
      } else {
        this.discoveredWsUrl = this.config.wsUrl;
        this.cachedCookies = this.config.cookies || "";
        this.cachedAuthPacket = this.config.authPacket || "";
      }

      this.log(`[WS] Connecting to: ${this.discoveredWsUrl}`);
      
      const headers: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Origin": this.discoveredWsUrl.includes("po.trade") ? "https://po.trade" : "https://pocketoption.com"
      };
      
      if (this.cachedCookies) {
        headers["Cookie"] = this.cachedCookies;
      }

      this.ws = new WebSocket(this.discoveredWsUrl, { headers });
      
      this.ws.on("open", () => this.handleOpen());
      this.ws.on("message", (data) => {
        // Handle both string and binary data
        let msg: string;
        if (Buffer.isBuffer(data)) {
          msg = data.toString('utf8');
        } else if (typeof data === 'string') {
          msg = data;
        } else if (data instanceof Uint8Array) {
          msg = Buffer.from(data).toString('utf8');
        } else {
          msg = String(data);
        }
        this.handleMessage(msg);
      });
      this.ws.on("error", (err) => this.handleError(err));
      this.ws.on("close", (code, reason) => this.handleClose(code, reason.toString()));

    } catch (err) {
      this.handleError(err as Error);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle WebSocket connection open event.
   */
  private handleOpen(): void {
    this.log("[WS] Connection opened");
    this.connected = true;
    this.reconnectAttempts = 0;
    this.connectListeners.forEach(cb => cb());
  }

  /**
   * Handle incoming WebSocket messages and route to appropriate processors.
   * @param msg - Raw message string from WebSocket
   */
  private handleMessage(msg: string): void {
    // Socket.IO Heartbeat
    if (msg === "2") {
      this.ws?.send("3");
      this.lastPingTime = Date.now();
      return;
    }

    // Engine.IO Handshake Response (0{"sid":"..."})
    if (msg.startsWith("0{")) {
      this.log("[WS] Handshake received, sending namespace join...");
      this.ws?.send("40");
      return;
    }

    // Namespace join success (40)
    if (msg.startsWith("40")) {
      this.log("[WS] Joined namespace, authenticating...");
      this.isAuthenticated = true;
      
      if (this.cachedAuthPacket) {
        this.log(`[WS] Sending auth packet: ${this.cachedAuthPacket.slice(0, 80)}...`);
        this.ws?.send(this.cachedAuthPacket);
        setTimeout(() => {
          this.log("[WS] Auth timeout, subscribing assets...");
          this.subscribeAllAssets();
        }, 2000);
      } else {
        this.log("[WS] No auth packet, subscribing directly...");
        this.subscribeAllAssets();
      }
      return;
    }
    
    // Binary event indicator (45)-["eventName",{"_placeholder":true,"num":0}]
    if (msg.startsWith("45")) {
      try {
        const dashIndex = msg.indexOf("-");
        if (dashIndex !== -1) {
          const jsonPart = msg.substring(dashIndex + 1);
          const parsed = JSON.parse(jsonPart);
          if (Array.isArray(parsed) && parsed[1]?.num !== undefined) {
            this.pendingBinaryEvent = parsed[0];
            this.binaryDataBuffer = [];
          }
        }
      } catch (e) {
        this.pendingBinaryEvent = null;
      }
      return;
    }
    
    // Binary data - if we have a pending event, this is the binary payload
    if (this.pendingBinaryEvent !== null && !msg.startsWith("42")) {
      const event = this.pendingBinaryEvent;
      this.pendingBinaryEvent = null;
      
      // Parse the binary data as JSON
      try {
        const data = JSON.parse(msg);
        this.processEvent(event, data);
      } catch (e) {
        this.log(`[WS] Failed to parse binary data for event: ${event}`);
      }
      return;
    }

    // Standard Socket.IO event message (42)["eventName",data]. If we had a
    // pending binary placeholder that never got its binary frame (e.g. an
    // intervening 42 event arrived out of order), drop the stale pending state
    // so the state machine cannot desync and swallow later frames.
    if (msg.startsWith("42")) {
      this.pendingBinaryEvent = null;
      this.processSocketIOEvent(msg.substring(2));
    }
  }
  
  /**
   * Process binary-encoded Socket.IO events.
   * @param event - Event name
   * @param data - Event data payload
   */
  private processEvent(event: string, data: any): void {
    switch (event) {
      case "updateStream":
        this.processTickData(data);
        break;
      case "successauth":
        this.log("[WS] Authentication successful (binary)");
        this.subscribeAllAssets();
        break;
      case "updateAssets":
        this.processAssetsUpdate(data);
        break;
      case "updateHistoryNewFast":
      case "updateHistory":
        this.processHistoryData(data);
        break;
      default:
        if (this.config.verbose) {
          this.log(`[WS] Event: ${event}`);
        }
    }
  }

  /**
   * Process standard Socket.IO events (non-binary).
   * @param payload - JSON payload string
   */
  private processSocketIOEvent(payload: string): void {
    try {
      const json = JSON.parse(payload);
      if (!Array.isArray(json)) return;
      
      const [event, data] = json;
      
      switch (event) {
        case "updateStream":
          this.processTickData(data);
          break;
        case "successauth":
          this.log("[WS] Authentication successful");
          this.subscribeAllAssets();
          break;
        case "updateAssets":
          this.processAssetsUpdate(data);
          break;
        default:
          if (this.config.verbose) {
            this.log(`[WS] Unknown event: ${event}`);
          }
      }
    } catch (e) {
      // Ignore parse errors for now
    }
  }

  /**
   * Process incoming tick (price update) data from the WebSocket stream.
   * Updates asset prices, builds candles, and notifies tick listeners.
   * @param data - Array of tick data from updateStream event
   */
  private processTickData(data: any): void {
    if (!Array.isArray(data)) return;
    
    const now = Date.now();
    
    for (const item of data) {
      let assetId = "";
      let price = 0;
      let timestamp = now;

      if (Array.isArray(item) && item.length >= 2) {
        assetId = String(item[0]);
        price = Number(item.length >= 3 ? item[2] : item[1]);
        timestamp = item.length >= 3 ? Number(item[1]) * 1000 : now;
      } else if (item && typeof item === "object") {
        assetId = String(item.asset || item.symbol || item.id || "");
        price = Number(item.price || item.close || item.value || 0);
        timestamp = Number(item.time || item.timestamp || now);
      }

      if (!assetId || !price || price <= 0) continue;
      
      // Normalize asset ID
      assetId = this.normalizeAssetId(assetId);
      
      const asset = this.assets.get(assetId);
      if (!asset) continue;

      // Calculate price direction
      let direction: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
      if (asset.lastPrice > 0) {
        direction = price > asset.lastPrice ? 'UP' : price < asset.lastPrice ? 'DOWN' : 'FLAT';
      }

      // Create tick
      const tick: Tick = {
        assetId,
        price,
        timestamp,
        direction
      };

      // Update asset
      asset.lastPrice = price;
      asset.lastTickTime = timestamp;
      asset.ticks.push(price);
      if (asset.ticks.length > 100) asset.ticks.shift();

      // Update candles
      this.updateCandles(asset, price, timestamp);

      // Store in history
      const history = this.priceHistory.get(assetId) || [];
      history.push(tick);
      if (history.length > 1000) history.shift();
      this.priceHistory.set(assetId, history);

      // Callbacks
      this.tickListeners.forEach(cb => cb(tick));

      if (this.config.verbose) {
        this.log(`[TICK] ${assetId}: ${price.toFixed(5)} (${direction})`);
      }
    }
  }

  /**
   * Normalize various asset ID formats to a known asset identifier.
   * Handles case variations, leading '#', and '_otc' suffix differences.
   * @param rawId - Raw asset identifier from WebSocket data
   * @returns Normalized asset ID or the raw ID if no match found
   */
  private normalizeAssetId(rawId: string): string {
    // Normalize various ID formats to a known asset id. Use strict matching to
    // avoid cross-mapping short ids (e.g. "USD") to the wrong asset — only an
    // exact match or a matched "_otc"/non-_otc variant is accepted.
    let id = rawId.replace(/^#/, "").toUpperCase();

    // 1) Exact match (case-insensitive, leading '#' stripped).
    for (const assetId of this.assets.keys()) {
      if (assetId.replace(/^#/, "").toUpperCase() === id) return assetId;
    }

    // 2) Same base with an optional "_otc" suffix: EURUSD <-> EURUSD_otc.
    const baseOf = (s: string) => s.replace(/^#/, "").toUpperCase().replace(/_OTC$/, "");
    const rawBase = baseOf(rawId);
    for (const assetId of this.assets.keys()) {
      if (baseOf(assetId) === rawBase) return assetId;
    }

    // Unknown asset — return the normalized raw id (caller will no-op on miss).
    return rawId;
  }

  /**
   * Update or create candles from incoming tick data.
   * Maintains a rolling window of up to 100 candles per asset.
   * @param asset - Asset info object to update
   * @param price - Current price from tick
   * @param timestamp - Tick timestamp in milliseconds
   */
  private updateCandles(asset: AssetInfo, price: number, timestamp: number): void {
    const periodMs = (this.config.candlePeriod || 60) * 1000;
    const candleTime = Math.floor(timestamp / periodMs) * periodMs;

    // Replace a stale in-progress candle if the last candle is no longer the
    // current bucket (e.g. after a gap in ticks). `find` is fine for the small
    // capped candle array, but checking the tail first avoids an O(n) scan.
    let candle = asset.candles.length > 0 && asset.candles[asset.candles.length - 1].openTime === candleTime
      ? asset.candles[asset.candles.length - 1]
      : asset.candles.find(c => c.openTime === candleTime);

    if (!candle) {
      const newCandle: Candle = {
        assetId: asset.id,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1,
        openTime: candleTime,
        closeTime: candleTime + periodMs - 1
      };
      asset.candles.push(newCandle);
      if (asset.candles.length > 100) asset.candles.shift();

      // Emit new candle
      this.candleListeners.forEach(cb => cb(newCandle));
    } else {
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
      candle.volume++;
    }
  }

  /**
   * Process asset metadata updates (payout rates, active status).
   * @param data - Array of asset update data
   */
  private processAssetsUpdate(data: any): void {
    if (!Array.isArray(data)) return;

    for (const item of data) {
      if (Array.isArray(item) && item.length >= 15) {
        const id = String(item[1]);
        const name = String(item[2]);
        const payout = Number(item[5]) / 100;
        const active = item[14] === true;
        
        if (id.endsWith("_otc") && (active || payout >= 0.88)) {
          if (this.assets.has(id)) {
            const asset = this.assets.get(id)!;
            asset.name = name;
            asset.payout = payout;
            asset.active = active;
          }
        }
      }
    }
  }

  /**
   * Process historical candle data received on subscription.
   * Seeds the candle array with historical OHLCV data.
   * @param data - History data array: [assetId, [[time, open, high, low, close, volume], ...]]
   */
  private processHistoryData(data: any): void {
    // Pocket Option history event: [assetId, [[time, open, high, low, close, volume], ...]]
    if (!Array.isArray(data) || data.length < 2) return;

    const rawId = String(data[0]);
    const assetId = this.normalizeAssetId(rawId);
    const candles = data[1];

    if (!Array.isArray(candles)) return;

    const asset = this.assets.get(assetId);
    if (!asset) return;

    // Build a set of already-known openTimes so a reconnect (which re-sends
    // history) does NOT append duplicate candles. Without this, every reconnect
    // corrupts the candle array (and thus structure/regime/HTF calculations).
    const known = new Set(asset.candles.map(c => c.openTime));

    for (const c of candles) {
      if (!Array.isArray(c) || c.length < 5) continue;
      const time = Number(c[0]) * 1000;
      const period = this.config.candlePeriod ? this.config.candlePeriod * 1000 : 60000;
      // Skip duplicates of candles we already have.
      if (known.has(time)) continue;
      const candle: Candle = {
        assetId: assetId,
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]) || 0,
        openTime: time,
        closeTime: time + period - 1
      };
      asset.candles.push(candle);
      known.add(time);
    }

    // Keep candles sorted by openTime and trim to the last 100.
    asset.candles.sort((a, b) => a.openTime - b.openTime);
    if (asset.candles.length > 100) {
      asset.candles = asset.candles.slice(-100);
    }

    // Seed lastPrice from the most recent historical close
    if (asset.candles.length > 0) {
      asset.lastPrice = asset.candles[asset.candles.length - 1].close;
    }

    this.log(`[HISTORY] ${assetId}: loaded ${candles.length} candles (last close: ${asset.lastPrice.toFixed(5)})`);
  }

  /**
   * Handle WebSocket errors.
   * @param err - Error object
   */
  private handleError(err: Error): void {
    this.log(`[WS ERROR] ${err.message}`);
    this.errorListeners.forEach(cb => cb(err));
  }

  /**
   * Handle WebSocket connection close event.
   * @param code - WebSocket close code
   * @param reason - Close reason string
   */
  private handleClose(code: number, reason: string): void {
    this.log(`[WS] Connection closed (${code}): ${reason}`);
    this.connected = false;
    this.isAuthenticated = false;
    this.disconnectListeners.forEach(cb => cb());
    this.scheduleReconnect();
  }

  /**
   * Schedule automatic reconnection with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.log("[WS] Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.config.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
    
    this.log(`[WS] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
    
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Subscribe to price updates for a specific asset.
   * @param assetId - Asset identifier to subscribe to
   */
  private subscribeAsset(assetId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const period = this.config.subscribePeriod ?? this.config.candlePeriod ?? 60;
    // Subscribe to candles for asset at the configured period (matches candlePeriod).
    this.ws.send(`42["changeSymbol",{"asset":"${assetId}","period":${period}}]`);
    this.log(`[WS] Subscribed to: ${assetId} (period ${period}s)`);
  }

  /**
   * Subscribe to all active tracked assets with staggered timing.
   */
  private subscribeAllAssets(): void {
    const activeAssets = Array.from(this.assets.values()).filter(a => a.active);
    this.log(`[WS] Subscribing to ${activeAssets.length} assets...`);
    
    activeAssets.forEach((asset, idx) => {
      setTimeout(() => {
        this.subscribeAsset(asset.id);
      }, idx * 200);
    });
  }

  // ============================================
  // PUBLIC API
  // ============================================

  /**
   * Disconnect from the WebSocket and clean up resources.
   */
  public disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.connected = false;
    this.isAuthenticated = false;
  }

  /**
   * Get the current price for a specific asset.
   * @param assetId - Asset identifier
   * @returns Current price or 0 if not available
   */
  public getPrice(assetId: string): number {
    return this.assets.get(assetId)?.lastPrice || 0;
  }

  /**
   * Get current prices for all tracked assets.
   * @returns Map of asset IDs to current prices
   */
  public getPrices(): Map<string, number> {
    const prices = new Map<string, number>();
    for (const [id, asset] of this.assets) {
      prices.set(id, asset.lastPrice);
    }
    return prices;
  }

  /**
   * Get recent tick prices for a specific asset (up to 100 most recent).
   * @param assetId - Asset identifier
   * @returns Array of recent tick prices
   */
  public getTicks(assetId: string): number[] {
    return this.assets.get(assetId)?.ticks || [];
  }

  /**
   * Get historical candles for a specific asset (up to 100 most recent).
   * @param assetId - Asset identifier
   * @returns Array of candles sorted by time
   */
  public getCandles(assetId: string): Candle[] {
    return this.assets.get(assetId)?.candles || [];
  }

  /**
   * Get full tick history for a specific asset (up to 1000 most recent).
   * @param assetId - Asset identifier
   * @returns Array of tick objects with price, timestamp, and direction
   */
  public getTickHistory(assetId: string): Tick[] {
    return this.priceHistory.get(assetId) || [];
  }

  /**
   * Get information for all tracked assets.
   * @returns Array of asset info objects
   */
  public getAssetList(): AssetInfo[] {
    return Array.from(this.assets.values());
  }

  /**
   * Check if the WebSocket is currently connected.
   * @returns True if connected
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a raw Socket.IO payload string over the authenticated WebSocket.
   * Used by the strategy/execution layers to raise orders (openOrder) or
   * re-request balance/candles while reusing this bot's authenticated session.
   * Returns false if the socket is not open (no-op, never throws).
   */
  public send(message: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(message);
      return true;
    } catch (err) {
      this.handleError(err as Error);
      return false;
    }
  }

  /**
   * True when the authenticated session is a DEMO account (vs live/real).
   * Detected from the `isDemo` field in the captured auth packet. Defaults to
   * true when not determinable, so an execution layer is never accidentally
   * aimed at a real account by default.
   *
   * NOTE: the `isDemo` key is bare JSON, immediately after `{` or `,` — there
   * is NO `\b` word boundary at that position in JS regexes (both neighbors are
   * non-word chars), so a `\b` prefix would make this never match. The
   * captured auth packet is exactly `42["auth",{...}]`, JSON-ish; we search the
   * raw string for the key so it works whether quoted with `"` or not.
   */
  public isDemoMode(): boolean {
    const m = /"isDemo"\s*:\s*(\d)/.exec(this.cachedAuthPacket) ?? /isDemo\s*:\s*(\d)/.exec(this.cachedAuthPacket);
    if (m) return m[1] === "1";
    // Not found in the auth packet — assume demo as the safe default.
    return true;
  }

  /**
   * For testability: expose the captured auth packet so isDemoMode() and
   * execution gating can be unit-tested without a live WebSocket session.
   */
  public setAuthPacketForTest(packet: string): void {
    this.cachedAuthPacket = packet;
  }

  /**
   * Best-effort estimate of Pocket Option's SERVER clock (ms). Candle
   * openTime/closeTime are derived from tick timestamps which carry the
   * server clock, which is ~2h ahead of the container's Date.now() on this
   * host. Signal timing (time-remaining-in-candle, entry quality) MUST use
   * the server clock, not Date.now(), or it will be wrong by the skew.
   *
   * Falls back to Date.now() only when no candles are available yet.
   */
  public getServerTime(): number {
    for (const asset of this.assets.values()) {
      if (asset.candles.length > 0) {
        const last = asset.candles[asset.candles.length - 1];
        // The in-progress candle's closeTime is its bucket end; combine with
        // lastTickTime (a server-clock ms) to stay inside the current bucket.
        const t = asset.lastTickTime > 0 ? asset.lastTickTime : last.closeTime;
        return t;
      }
    }
    return Date.now();
  }

  /**
   * Register a callback for tick (price update) events.
   * @param callback - Function to call when a tick is received
   */
  public onTick(callback: (tick: Tick) => void): void {
    this.tickListeners.push(callback);
  }

  /**
   * Register a callback for candle close events.
   * @param callback - Function to call when a candle closes
   */
  public onCandle(callback: (candle: Candle) => void): void {
    this.candleListeners.push(callback);
  }

  /**
   * Register a callback for connection events.
   * @param callback - Function to call when connected
   */
  public onConnect(callback: () => void): void {
    this.connectListeners.push(callback);
  }

  /**
   * Register a callback for disconnection events.
   * @param callback - Function to call when disconnected
   */
  public onDisconnect(callback: () => void): void {
    this.disconnectListeners.push(callback);
  }

  /**
   * Register a callback for error events.
   * @param callback - Function to call when an error occurs
   */
  public onError(callback: (error: Error) => void): void {
    this.errorListeners.push(callback);
  }

  /**
   * Save current prices and asset information to a JSON file.
   */
  public savePricesToFile(): void {
    const data: any = {
      timestamp: new Date().toISOString(),
      prices: Object.fromEntries(this.getPrices()),
      assets: this.getAssetList().map(a => ({
        id: a.id,
        name: a.name,
        payout: a.payout,
        active: a.active,
        lastPrice: a.lastPrice,
        lastTickTime: a.lastTickTime
      }))
    };
    
    fs.writeFileSync(this.config.outputFile, JSON.stringify(data, null, 2));
    this.log(`[SAVE] Prices saved to ${this.config.outputFile}`);
  }

  /**
   * Log a message with timestamp.
   * @param msg - Message to log
   */
  private log(msg: string): void {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
    console.log(`[${timestamp}] ${msg}`);
  }
}

// ============================================
// CLI INTERFACE
// ============================================

/**
 * Main entry point when running server.ts directly.
 * Starts price capture with default configuration and event logging.
 */
async function main() {
  console.log("\n===========================================");
  console.log("  Pocket Option Live Price Capture Bot v1.0");
  console.log("===========================================\n");

  const bot = new PocketOptionPriceBot({
    verbose: true,
    saveToFile: true,
    outputFile: "./live-prices.json",
    defaultAssets: [
      "EURUSD_otc",
      "GBPUSD_otc",
      "USDJPY_otc",
      "XAUUSD_otc",
      "AUDUSD_otc",
      "USDCAD_otc"
    ]
  });

  // Event handlers
  bot.onConnect(() => {
    console.log("\n✅ Connected to Pocket Option!\n");
  });

  bot.onDisconnect(() => {
    console.log("\n⚠️ Disconnected from Pocket Option\n");
  });

  bot.onTick((tick) => {
    // Tick is already logged by verbose mode
  });

  bot.onCandle((candle) => {
    console.log(`\n🕯️ CANDLE CLOSED: ${candle.assetId} | O:${candle.open.toFixed(5)} H:${candle.high.toFixed(5)} L:${candle.low.toFixed(5)} C:${candle.close.toFixed(5)} V:${candle.volume}\n`);
  });

  bot.onError((err) => {
    console.error(`\n❌ Error: ${err.message}\n`);
  });

  // Start connection
  await bot.connect();

  // Auto-save prices every 30 seconds
  setInterval(() => {
    if (bot.isConnected()) {
      bot.savePricesToFile();
    }
  }, 30000);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\nShutting down...");
    bot.disconnect();
    process.exit(0);
  });
}

// Run only when executed directly (not when imported as a module)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', '').replace('.ts', '.js')) ||
    (process.argv[1] && process.argv[1].endsWith('server.ts'))) {
  main().catch(console.error);
}
