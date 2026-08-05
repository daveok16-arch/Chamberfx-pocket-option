# CHAMBERFX Pocket Option Trading Bot v2.0

## Overview

Refactored Python implementation with **Tick-Volume Bars** and **Interactive Telegram Interface**.

### Key Features

1. **Tick-Volume Bars** - Aggregates 150-200 tick packets into OHLC bars (no time-based lag)
2. **Micro-Momentum Engine** - Ultra-low latency TVV calculation for 5s/15s expirations
3. **Technical Indicators** - pandas-ta integration with EMA, RSI, MACD, Bollinger Bands
4. **Telegram Inline Keyboard** - Real-time interactive trading interface
5. **Fully Async** - Non-blocking WebSocket, Engine.IO heartbeat, Telegram handlers

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TELEGRAM BOT                               │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │  /start    │  │  Inline KB   │  │  Signal Display     │  │
│  │  Menu      │  │  Expiration  │  │  📈 CALL / 📉 PUT   │  │
│  └─────────────┘  └──────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                  TRADING ENGINE                              │
│  ┌────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ Tick-Volume    │  │ Micro-Momentum   │  │ Indicator   │ │
│  │ Bar Builder    │  │ (TVV) Engine     │  │ Pipeline    │ │
│  │ 175 ticks/bar  │  │ 50 tick window   │  │ pandas-ta   │ │
│  └────────────────┘  └─────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                 POCKET OPTION CLIENT                         │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │  Playwright │  │  WebSocket   │  │  Socket.IO          │ │
│  │  Discovery  │  │  Connect     │  │  Binary Protocol    │ │
│  └─────────────┘  └──────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
cd python-bot
pip install -r requirements.txt

# Copy environment template
cp .env.example .env
# Edit .env with your Telegram token
```

## Usage

### Standalone Telegram Bot (Test Mode)

```bash
python standalone_telegram_bot.py
```

### Full Trading Engine

```bash
# Set environment variable
export TELEGRAM_TOKEN="your_token_here"

# Run trading engine
python trading_engine.py
```

## Telegram Interface

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Open main menu with expiration selection |
| `/help` | Show help information |
| `/status` | View bot status and tracked assets |
| `/signal` | Request current trading signal |

### Inline Keyboard

```
⚡ 5s    ⚡ 15s
1m       2m       3m
5m       15m      30m
⬅️ Back  📱 Main Menu
```

### Analysis Flow

1. User selects expiration → Inline keyboard cleared
2. Bot shows analysis message with countdown
3. Engine runs for 1-3 seconds (based on expiration)
4. When signal found → Message pushed to chat
5. User follows signal on Pocket Option platform

## Tick-Volume Bars

### How It Works

Instead of resampling by clock time (60s), bars are formed by tick count:

```python
tick_threshold = 175  # Every 175 ticks = 1 OHLC bar

# Each tick updates the current bar
tick → update HIGH if price > high
      → update LOW if price < low
      → update CLOSE to current price
      → increment tick_count

# When tick_count >= threshold:
#   → Close current bar
#   → Emit completed bar
#   → Start new bar
```

### Advantages

- **Zero Lag** - Bars complete based on market activity, not wall clock
- **Responsive** - More bars during volatile periods
- **Consistent** - Same tick count per bar regardless of timeframe

## Micro-Momentum (TVV)

For ultra-short expirations (5s, 15s), bypass OHLC entirely:

```python
class MicroMomentumEngine:
    def _compute_tvv(self, prices, directions):
        # 1. Tick Direction Bias (-1 to +1)
        direction_bias = sum(directions) / len(directions)
        
        # 2. Volatility Index
        returns = diff(prices) / prices[:-1]
        volatility = var(returns) * 10000
        
        # 3. TVV = bias * sqrt(variance)
        tvv = direction_bias * sqrt(normalized_variance)
        
        # 4. Signal if |bias| >= threshold
```

## Signal Generation

### Entry Quality

| Time Remaining | Quality |
|----------------|---------|
| 50+ seconds | EXCELLENT |
| 40-50 seconds | GOOD |
| 20-40 seconds | FAIR |
| <20 seconds | POOR (skip) |

### Confidence Scoring

```
Base Score = |bullish_score - bearish_score| / total * 100
Bonus = min(bullish, bearish) / 2
Final = min(100, Base + Bonus)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_TOKEN` | - | Telegram bot token (required) |
| `MIN_CONFIDENCE` | 70 | Minimum signal confidence |
| `TICK_THRESHOLD` | 175 | Ticks per volume bar |
| `SIGNAL_COOLDOWN` | 60 | Seconds between same-asset signals |
| `LOG_LEVEL` | INFO | Logging level |

## Files

| File | Purpose |
|------|---------|
| `tick_volume_bars.py` | Tick-count OHLC bar aggregation |
| `micro_momentum.py` | TVV calculation for turbo trades |
| `indicators.py` | Technical analysis with pandas-ta |
| `pocket_option_client.py` | WebSocket client for OTC data |
| `telegram_bot.py` | Inline keyboard interface |
| `trading_engine.py` | Main orchestrator |
| `standalone_telegram_bot.py` | Test bot without OTC |

## License

MIT License - CHAMBERFX
