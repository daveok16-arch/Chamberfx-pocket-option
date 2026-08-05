# Pocket Option Trading Bot v1.0

A comprehensive trading bot that captures real-time price data from Pocket Option OTC (Over-The-Counter) currency pairs and generates trading signals based on technical analysis.

## Features

- **Real-time Price Capture**: Live tick data via WebSocket (Socket.IO protocol)
- **Technical Analysis**: EMA, RSI, MACD, Bollinger Bands, ADX, ATR
- **Signal Generation**: CALL/PUT/WAIT signals based on indicator confluence
- **Trade Tracking**: Record trades, wins, losses, and performance
- **Auto-Discovery**: Playwright automatically discovers WebSocket session
- **Multi-Asset**: Monitor up to 6 OTC pairs simultaneously

## Quick Start

```bash
npm install
npm run trading
```

## Trading Bot (`trading-bot.ts`)

The trading bot provides:
- Live price monitoring
- Technical indicator calculation
- Automatic signal generation
- Trade tracking and performance metrics
- Colorful CLI dashboard

## Features

- **Real-time Price Capture**: Connects to Pocket Option WebSocket and captures live tick data
- **Multiple Asset Support**: Tracks up to 9 major OTC currency pairs simultaneously
- **Candle Building**: Automatically builds 1-minute candles from tick data
- **Session Auto-Discovery**: Uses Playwright to automatically discover WebSocket connection parameters
- **Auto-Reconnection**: Automatically reconnects on connection loss with exponential backoff
- **Price History**: Maintains tick history for each asset
- **Export**: Saves prices to JSON file periodically

## Supported OTC Pairs

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
       │        "EURUSD_otc","period":60}]   │
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
│  1-Minute Candle                                          │
├─────────────────────────────────────────────────────────────┤
│  Open:  1.08530  (first tick)                             │
│  High:  1.08542  (max tick)                               │
│  Low:   1.08530  (min tick)                               │
│  Close: 1.08542  (last tick)                              │
│  Volume: 5      (tick count)                              │
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install
```

## Usage

### Start the bot

```bash
npm run dev
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
