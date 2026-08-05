# CHAMBERFX Pocket Option Trading Bot v2.0

## рҹҡҖ Deployment Ready for Render.com

### Quick Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Fork this repository
2. Create a new Web Service on Render.com
3. Connect your GitHub repo
4. Set environment variable `TELEGRAM_TOKEN`
5. Deploy!

## Overview

Refactored Python implementation with **Tick-Volume Bars** and **Interactive Telegram Interface**.

### Key Features

1. **10 OTC Pairs** with payout information (EURUSD 88%, GBPUSD 85%, etc.)
2. **Tick-Volume Bars** - Aggregates 150-200 tick packets into OHLC bars (no time-based lag)
3. **Micro-Momentum Engine** - Ultra-low latency TVV calculation for 5s/15s expirations
4. **Technical Indicators** - pandas-ta integration with EMA, RSI, MACD, Bollinger Bands
5. **Telegram Inline Keyboard** - Real-time interactive trading interface
6. **Fully Async** - Non-blocking WebSocket, Engine.IO heartbeat, Telegram handlers

## OTC Pairs with Payouts

| Pair | Payout | Category |
|------|--------|----------|
| рҹ’° EURUSD | 88% | Major |
| рҹ’° GBPUSD | 85% | Major |
| рҹ’° USDJPY | 85% | Major |
| рҹҘҮ XAUUSD | 80% | Commodity |
| рҹҰҳ AUDUSD | 82% | Minor |
| рҹҚҒ USDCAD | 80% | Minor |
| рҹҮірҹҮҝ NZDUSD | 78% | Minor |
| рҹҮӘрҹҮәрҹҮ¬рҹҮ§ EURGBP | 78% | Minor |
| вӮҝ BTCUSD | 75% | Crypto |
| Оһ ETHUSD | 75% | Crypto |

## Architecture

```
в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ
в”Ӯ                    TELEGRAM BOT                               в”Ӯ
в”Ӯ  в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ  в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ  в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ  в”Ӯ
в”Ӯ  в”Ӯ  /start    в”Ӯ  в”Ӯ  Inline KB   в”Ӯ  в”Ӯ  Signal Display     в”Ӯ  в”Ӯ
в”Ӯ  в”Ӯ  Menu      в”Ӯ  в”Ӯ  Expiration  в”Ӯ  в”Ӯ  рҹ“Ҳ CALL / рҹ“ү PUT   в”Ӯ  в”Ӯ
в”Ӯ  в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ  в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ  в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ  в”Ӯ
в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ
                            вҶ“
в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ
в”Ӯ                  TRADING ENGINE                              в”Ӯ
в”Ӯ  в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ  в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ  в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ в”Ӯ
в”Ӯ  в”Ӯ Tick-Volume    в”Ӯ  в”Ӯ Micro-Momentum   в”Ӯ  в”Ӯ Indicator   в”Ӯ в”Ӯ
в”Ӯ  в”Ӯ Bar Builder    в”Ӯ  в”Ӯ (TVV) Engine     в”Ӯ  в”Ӯ Pipeline    в”Ӯ в”Ӯ
в”Ӯ  в”Ӯ 175 ticks/bar  в”Ӯ  в”Ӯ 50 tick window   в”Ӯ  в”Ӯ pandas-ta   в”Ӯ в”Ӯ
в”Ӯ  в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ  в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ  в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ в”Ӯ
в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ
                            вҶ“
в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ
в”Ӯ                 POCKET OPTION CLIENT                         в”Ӯ
в”Ӯ  в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ  в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ  в”Ңв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”җ в”Ӯ
в”Ӯ  в”Ӯ  Playwright в”Ӯ  в”Ӯ  WebSocket   в”Ӯ  в”Ӯ  Socket.IO          в”Ӯ в”Ӯ
в”Ӯ  в”Ӯ  Discovery  в”Ӯ  в”Ӯ  Connect     в”Ӯ  в”Ӯ  Binary Protocol    в”Ӯ в”Ӯ
в”Ӯ  в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ  в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ  в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ в”Ӯ
в””в”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”Җв”ҳ
```

## Installation

### Local Development

```bash
cd python-bot
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your Telegram token
python bot.py
```

### Docker

```bash
docker-compose up -d
```

### Render.com Deployment

1. **Fork this repository** on GitHub

2. **Create Render Account** at https://render.com

3. **Create Web Service**:
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Select the `python-bot` directory
   - Set the following:
     - **Root Directory**: `python-bot`
     - **Build Command**: `pip install -r requirements.txt`
     - **Start Command**: `python bot.py`

4. **Add Environment Variable**:
   - Key: `TELEGRAM_TOKEN`
   - Value: Your Telegram bot token from @BotFather

5. **Deploy!** - Click "Create Web Service"

### Render Blueprint (Alternative)

Use `render.yaml` for one-click deployment:

```bash
render blueprints apply
```

## Usage

### Local Development

```bash
python bot.py
```

### Docker

```bash
docker-compose up -d
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
вҡЎ 5s    вҡЎ 15s
1m       2m       3m
5m       15m      30m
в¬…пёҸ Back  рҹ“ұ Main Menu
```

### Analysis Flow

1. User selects expiration вҶ’ Inline keyboard cleared
2. Bot shows analysis message with countdown
3. Engine runs for 1-3 seconds (based on expiration)
4. When signal found вҶ’ Message pushed to chat
5. User follows signal on Pocket Option platform

## Tick-Volume Bars

### How It Works

Instead of resampling by clock time (60s), bars are formed by tick count:

```python
tick_threshold = 175  # Every 175 ticks = 1 OHLC bar

# Each tick updates the current bar
tick вҶ’ update HIGH if price > high
      вҶ’ update LOW if price < low
      вҶ’ update CLOSE to current price
      вҶ’ increment tick_count

# When tick_count >= threshold:
#   вҶ’ Close current bar
#   вҶ’ Emit completed bar
#   вҶ’ Start new bar
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
