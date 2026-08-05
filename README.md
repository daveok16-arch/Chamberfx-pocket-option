# CHAMBERFX Pocket Option Trading Bot

A production-ready algorithmic trading bot for Pocket Option OTC markets with real-time market data processing and Telegram signal delivery.

![Python](https://img.shields.io/badge/Python-3.11+-blue.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)

## 🚀 Features

### Trading Engine
- **Tick-Volume Bars** - Market-based candle aggregation (150-200 ticks per bar)
- **Micro-Momentum (TVV)** - Ultra-low latency signals for 5s/15s turbo trades
- **Technical Analysis** - EMA, RSI, MACD, Bollinger Bands via pandas-ta
- **Multi-Asset** - Support for 10+ OTC currency pairs and crypto

### Telegram Integration
- **Interactive Inline Keyboard** - Real-time signal generation
- **8 Expiration Options** - 5s, 15s, 1m, 2m, 3m, 5m, 15m, 30m
- **Live Notifications** - CALL/PUT signals with confidence scores
- **Auto Reconnection** - Stable WebSocket handling

### OTC Pairs with Payouts

| Pair | Payout | Category |
|------|--------|----------|
| 💰 EURUSD | 88% | Major |
| 💰 GBPUSD | 85% | Major |
| 💰 USDJPY | 85% | Major |
| 🥇 XAUUSD | 80% | Commodity |
| 🦘 AUDUSD | 82% | Minor |
| 🍁 USDCAD | 80% | Minor |
| 🇳🇿 NZDUSD | 78% | Minor |
| 🇪🇺🇬🇧 EURGBP | 78% | Minor |
| ₿ BTCUSD | 75% | Crypto |
| Ξ ETHUSD | 75% | Crypto |

## 📁 Project Structure

```
Chamberfx-pocket-option/
├── python-bot/              # Python implementation (recommended)
│   ├── bot.py              # Production entry point
│   ├── trading_engine.py    # Main orchestrator
│   ├── pocket_option_client.py  # WebSocket client
│   ├── telegram_bot.py      # Telegram handler
│   ├── tick_volume_bars.py  # Market-based candles
│   ├── micro_momentum.py    # TVV engine
│   ├── indicators.py        # Technical analysis
│   ├── requirements.txt     # Dependencies
│   ├── Dockerfile           # Container config
│   └── render.yaml          # Render deployment
├── price-bot/               # TypeScript implementation
│   ├── src/
│   │   ├── trading-bot.ts  # Main trading bot
│   │   └── telegram.ts      # Telegram notifications
│   └── package.json
├── ts-bot/                  # Alternative TypeScript bot
└── trading-bot/             # Original TypeScript bot
```

## 🛠️ Installation

### Python Bot (Recommended)

```bash
# Clone repository
git clone https://github.com/daveok16-arch/Chamberfx-pocket-option.git
cd Chamberfx-pocket-option/python-bot

# Create virtual environment
python -m venv venv
source venv/bin/activate  # Linux/Mac
# or: venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt

# Copy environment template
cp .env.example .env

# Edit .env with your credentials
nano .env
```

### TypeScript Bot

```bash
cd price-bot
npm install
```

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in `python-bot/`:

```env
# Required
TELEGRAM_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Optional (with defaults)
MIN_CONFIDENCE=70
TICK_THRESHOLD=175
SIGNAL_COOLDOWN=60
LOG_LEVEL=INFO
```

### Getting Telegram Credentials

1. **Bot Token**:
   - Message @BotFather on Telegram
   - Send `/newbot` and follow instructions
   - Copy the token provided

2. **Chat ID**:
   - Message @userinfobot on Telegram
   - Your Chat ID will be displayed
   - Or use @getidsbot for group chats

## 🚀 Deployment

### Render.com (Recommended)

1. Fork this repository on GitHub

2. Create a new Web Service on [Render.com](https://render.com):
   - Connect your GitHub account
   - Select this repository
   - Set root directory to `python-bot`
   - Build command: `pip install -r requirements.txt`
   - Start command: `python bot.py`

3. Add environment variables:
   - `TELEGRAM_TOKEN` (required)
   - `TELEGRAM_CHAT_ID` (required)

4. Deploy!

### Docker

```bash
# Build image (from repository root)
docker build -t chamberfx-bot .

# Run container
docker run -d \
  --name chamberfx \
  -e TELEGRAM_TOKEN=your_token \
  -e TELEGRAM_CHAT_ID=your_chat_id \
  chamberfx-bot
```

### Docker Compose

```bash
# Create .env file
cp .env.example .env
# Edit .env with your credentials

# Start the bot
docker-compose up -d
```

## 📱 Usage

### Python Bot

```bash
# Development mode
python bot.py

# Or use trading engine directly
python trading_engine.py
```

### TypeScript Bot

```bash
cd price-bot
npx ts-node src/trading-bot.ts
```

## 📊 Signal Format

When a trading signal is generated, you'll receive:

```
📈 NEW SIGNAL 📈

🏷️ Asset: EURUSD/OTC
📊 Direction: CALL
💰 Entry: 1.15178
💵 Payout: 88%

⏱️ Expiration: 1m
⏰ Time Left: 45s
🎯 Confidence: 85%
📍 Entry Quality: GOOD
🔧 Strategy: Tick-Volume Bars

📝 Analysis:
   • EMA crossover
   • RSI oversold
   • BB lower band

💎 Potential Profit: $8.8 (on $10 stake)
```

## 🔧 Troubleshooting

### WebSocket Connection Issues

If the bot fails to connect:
1. Check your internet connection
2. Verify Pocket Option demo account is accessible
3. Wait 5-10 minutes if rate-limited
4. Check logs for specific error messages

### Telegram Not Receiving Messages

1. Ensure the bot token is correct
2. Verify the bot has been started by your user
3. Check if Chat ID is correct
4. Verify bot has permission to send messages

### No Signals Generated

1. Check confidence threshold (default: 70%)
2. Verify tick data is being received
3. Check indicator calculations in logs
4. Try different trading pairs

## 📈 Strategy Details

### Tick-Volume Bars

Unlike time-based candles, tick-volume bars aggregate a fixed number of price ticks (default: 175):

```
Advantages:
✓ Zero lag - bars complete based on market activity
✓ Responsive - more bars during volatile periods
✓ Consistent - same tick count per bar regardless of timeframe
```

### Micro-Momentum (TVV)

For ultra-short expirations (5s, 15s), TVV provides:

```
TVV = direction_bias × √variance

Where:
- direction_bias = Σ(tick_directions) / n
- variance = Var(returns) × 10000
```

### Confidence Scoring

```
Base Score = |bullish - bearish| / total × 100
Bonus = min(bullish, bearish) / 2
Final = min(100, Base + Bonus)
```

## 📝 License

MIT License - see LICENSE file for details.

## ⚠️ Disclaimer

This software is for educational purposes only. Trading binary options involves substantial risk of loss. Past performance does not guarantee future results. Use at your own risk.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
5. Open a Pull Request

## 📞 Support

- Open an issue on GitHub
- Check the [wiki](https://github.com/daveok16-arch/Chamberfx-pocket-option/wiki) for guides
