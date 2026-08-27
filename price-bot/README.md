# Pocket Option OTC Trade Bot — Capture Foundation

A TypeScript foundation that captures **real-time OTC price data** from Pocket
Option over the Socket.IO WebSocket (ticks + candles) and exposes a clean hook
for implementing trading strategies. The previous signal engine was
deliberately removed to make room for new strategies.

## Features

- **Real-time Price Capture**: Live tick data via WebSocket (Socket.IO protocol)
- **Candle Building**: Configurable candle period (60/180/300s)
- **Strategy Hook**: `onTick` / `onCandle` callbacks in `trade-bot.ts`
- **Auto-Discovery**: Playwright automatically discovers the WebSocket session
- **Multi-Asset**: Monitor 6 OTC pairs simultaneously
- **Health Endpoint**: tiny HTTP `/health` server for platform health checks

## Quick Start

```bash
npm install
npx playwright install chromium
npx tsx trade-bot.ts            # default 1m candles, PAPER mode
npx tsx trade-bot.ts --period 300   # 5-minute candles
npx tsx risk-smoke-test.ts      # verify the safety gates (npm run test:risk)
```

> ⚠️ **PAPER mode by default** — the bot records every proposed trade locally
> and never sends a real order. To arm real-money execution you must run with
> `ALLOW_LIVE=1` AND have an authenticated non-demo session.

## Architecture

Layered pipeline, wired in `trade-bot.ts`:

- `server.ts` — live price-capture engine (`PocketOptionPriceBot`)
- `strategy.ts` — decides direction (pluggable `Strategy` interface)
- `risk.ts` — hard safety gates (`RiskManager`)
- `execution.ts` — executes `openOrder` over the WS (PAPER by default)
- `trade-bot.ts` — entrypoint wiring capture → strategy → risk → execution + health

The active strategy is `MultiAssetReversionStrategy` (multi-asset, small-stake
range-reversion using the volatility filter + rejection-wick anatomy; skips
hard trends). A strategy's `evaluate(ctx, asset)` receives `ctx.candles`
(closed candles, oldest first), `ctx.price` (last price), and `ctx.serverTime`
(Pocket Option's clock — not `Date.now()`), and returns a
`{direction, amount, duration}` proposal or null to wait. Swap strategies by
editing `trade-bot.ts`.

# Supported OTC Pairs

| Asset ID | Name | Typical Payout |
|----------|------|----------------|
| EURUSD_otc | EUR/USD OTC | 92% |
| GBPUSD_otc | GBP/USD OTC | 90% |
| USDJPY_otc | USD/JPY OTC | 91% |
| XAUUSD_otc | GOLD OTC | 92% |
| AUDUSD_otc | AUD/USD OTC | 88% |
| USDCAD_otc | USD/CAD OTC | 90% |
| USDCHF_otc | USD/CHF OTC | 88% |
| NZDUSD_otc | NZD/USD OTC | 85% |
| EURGBP_otc | EUR/GBP OTC | 89% |

## How Price Capture Works

### 1. Session Discovery (Playwright)

```
┌─────────────────────────────────────────────────────────────┐
│  Playwright Headless Browser                                │
│  ├── Navigate to po.trade/en/cabinet/try-demo/             │
│  ├── Intercept WebSocket connection                         │
│  ├── Capture:                                              │
│  │   ├── WebSocket URL (wss://api-*.po.market/...)         │
│  │   ├── Session cookies                                   │
│  │   └── Authentication packet                             │
│  └── Return session data                                    │
└─────────────────────────────────────────────────────────────┘
```

### 2. WebSocket Connection (Socket.IO Protocol)

```
┌──────────────┐                    ┌──────────────────┐
│   Bot        │                    │  Pocket Option    │
│   Client     │                    │  Server          │
└──────┬───────┘                    └────────┬─────────┘
       │                                     │
       │  1. Connect (WebSocket)             │
       │────────────────────────────────────►│
       │                                     │
       │  2. Engine.IO Handshake (0)          │
       │◄────────────────────────────────────│
       │                                     │
       │  3. Send Namespace Join (40)        │
       │────────────────────────────────────►│
       │                                     │
       │  4. Namespace Success (40)           │
       │◄────────────────────────────────────│
       │                                     │
       │  5. Send Auth Packet                │
       │────────────────────────────────────►│
       │                                     │
       │  6. Auth Success (successauth)       │
       │◄────────────────────────────────────│
       │                                     │
       │  7. Subscribe to Assets             │
       │     42["changeSymbol",{"asset":     │
       │        "EURUSD_otc","period":60}]   │  (period = candlePeriod = expiry*60)
       │────────────────────────────────────►│
```

### 3. Price Data Processing

```
┌─────────────────────────────────────────────────────────────┐
│  Incoming Tick Data Format                                  │
├─────────────────────────────────────────────────────────────┤
│  Array format:                                             │
│  ["EURUSD_otc", 1234567890, 1.08542]                      │
│   └─ Asset ID   └─ Timestamp └─ Price                     │
│                                                             │
│  Object format:                                             │
│  { asset: "EURUSD_otc", price: 1.08542, time: 1234567890 } │
└─────────────────────────────────────────────────────────────┘
```

### 4. Candle Building

```
Ticks: 1.08530 → 1.08535 → 1.08540 → 1.08538 → 1.08542
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────┐
│  Candle (period = candlePeriod, default/expiry 60s = 1m)   │
├─────────────────────────────────────────────────────────────┤
│  Open:  1.08530  (first tick)                             │
│  High:  1.08542  (max tick)                               │
│  Low:   1.08530  (min tick)                               │
│  Close: 1.08542  (last tick)                              │
│  Volume: 5      (tick count)                              │
└─────────────────────────────────────────────────────────────┘
```

Candle period follows the signal expiry (`candlePeriod = expiry * 60`), so 3m
and 5m expiries build/seed 3m and 5m candles. Timestamps come from Pocket
Option's server clock (~2h ahead of the container clock); timing math in the
engine is anchored to candle boundaries, not `Date.now()`.

## Installation

```bash
npm install
```

## Usage

### Start the bot

```bash
npx tsx trade-bot.ts
# or: npm run capture
```

### Run the price-capture engine standalone

```bash
npx tsx server.ts
```

### Programmatic Usage

```typescript
import { PocketOptionPriceBot } from './server';

// Create bot instance
const bot = new PocketOptionPriceBot({
  defaultAssets: ['EURUSD_otc', 'GBPUSD_otc', 'XAUUSD_otc'],
  verbose: true,
  saveToFile: true,
  outputFile: './prices.json'
});

// Set up event handlers
bot.onConnect(() => {
  console.log('Connected!');
});

bot.onTick((tick) => {
  console.log(`${tick.assetId}: ${tick.price} (${tick.direction})`);
});

bot.onCandle((candle) => {
  console.log(`Candle closed: ${candle.assetId} O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`);
});

// Connect
await bot.connect();

// Get prices
const prices = bot.getPrices();
console.log('Current prices:', prices);

// Disconnect when done
bot.disconnect();
```

### API Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `connect()` | Connect to Pocket Option | Promise<void> |
| `disconnect()` | Disconnect from Pocket Option | void |
| `getPrice(assetId)` | Get last price for asset | number |
| `getPrices()` | Get all current prices | Map<string, number> |
| `getTicks(assetId)` | Get recent ticks | number[] |
| `getCandles(assetId)` | Get built candles | Candle[] |
| `getTickHistory(assetId)` | Get tick history | Tick[] |
| `getAssetList()` | Get all asset info | AssetInfo[] |
| `isConnected()` | Check connection status | boolean |
| `getServerTime()` | Pocket Option server-clock ms (for clock-skew-safe timing) | number |
| `savePricesToFile()` | Save prices to JSON | void |

### Events

| Event | Callback Parameter | Description |
|-------|-------------------|-------------|
| `onConnect` | - | Fired when WebSocket connects |
| `onDisconnect` | - | Fired when WebSocket disconnects |
| `onTick` | `Tick` | Fired for each price tick |
| `onCandle` | `Candle` | Fired when candle closes |
| `onError` | `Error` | Fired on error |

## Output Format

### Live Prices JSON

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "prices": {
    "EURUSD_otc": 1.08542,
    "GBPUSD_otc": 1.26530,
    "USDJPY_otc": 148.235,
    "XAUUSD_otc": 2048.50,
    "AUDUSD_otc": 0.66520
  },
  "assets": [
    {
      "id": "EURUSD_otc",
      "name": "EUR/USD OTC",
      "payout": 0.92,
      "active": true,
      "lastPrice": 1.08542,
      "lastTickTime": 1705315800000
    }
  ]
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PocketOptionPriceBot                         │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────────┐    ┌──────────────────┐   │
│  │  Playwright│    │  WebSocket      │    │  Price Engine    │   │
│  │  Session   │───►│  Connection     │───►│  - Tick buffer   │   │
│  │  Discovery │    │  (Socket.IO)    │    │  - Candle builder│   │
│  └─────────────┘    └─────────────────┘    └──────────────────┘   │
│                              │                      │              │
│                              │                      ▼              │
│                              │              ┌──────────────────┐   │
│                              │              │  Event Emitters │   │
│                              │              │  - onTick       │   │
│                              │              │  - onCandle     │   │
│                              │              └──────────────────┘   │
│                              │                      │              │
│                              ▼                      ▼              │
│                      ┌──────────────────────────────────────┐      │
│                      │        User Callbacks / CLI Output   │      │
│                      └──────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

## Troubleshooting

### Connection Issues

1. **"Failed to discover WebSocket URL"**
   - Try running again (session may have expired)
   - Check internet connection
   - Pocket Option demo server may be temporarily down

2. **Auto-reconnection loops**
   - Max 10 attempts by default
   - Check if Pocket Option is available

### Price Issues

1. **No ticks received**
   - Verify assets are active/tradeable
   - Check if WebSocket is authenticated

2. **Stale prices**
   - Connection may have dropped
   - Bot will auto-reconnect

## License

MIT - Use at your own risk. This is for educational purposes.
