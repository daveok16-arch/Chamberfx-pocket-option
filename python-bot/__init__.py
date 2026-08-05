"""
CHAMBERFX Pocket Option Trading Bot
==================================

A refactored Python implementation with:
- Tick-Volume Bars (150-200 tick OHLC aggregation)
- Micro-Momentum Engine (TVV for 5s/15s trading)
- Technical Indicators (pandas-ta integration)
- Interactive Telegram Inline Keyboard
- Async/await throughout

Usage:
    from trading_engine import TradingEngine
    
    engine = TradingEngine(
        telegram_token="YOUR_TOKEN",
        assets=['EURUSD_otc', 'GBPUSD_otc'],
        tick_threshold=175,
        min_confidence=70
    )
    
    await engine.start()
"""

__version__ = "2.0.0"
__author__ = "CHAMBERFX"

from .tick_volume_bars import (
    Tick,
    TickVolumeBar,
    TickVolumeBarBuilder,
    MultiAssetTickVolumeEngine
)

from .micro_momentum import (
    TVVReading,
    MicroMomentumEngine,
    MultiAssetMicroMomentum
)

from .indicators import (
    IndicatorResult,
    TechnicalIndicatorPipeline
)

from .pocket_option_client import (
    PriceUpdate,
    PocketOptionClient
)

from .telegram_bot import (
    TelegramTradingBot,
    ExpirationType,
    SignalFormatter,
    BotState,
    TradingSession
)

from .trading_engine import (
    TradingSignal,
    TradeResult,
    TradingEngine
)

__all__ = [
    # Tick-Volume Bars
    'Tick',
    'TickVolumeBar',
    'TickVolumeBarBuilder',
    'MultiAssetTickVolumeEngine',
    
    # Micro-Momentum
    'TVVReading',
    'MicroMomentumEngine',
    'MultiAssetMicroMomentum',
    
    # Indicators
    'IndicatorResult',
    'TechnicalIndicatorPipeline',
    
    # Pocket Option
    'PriceUpdate',
    'PocketOptionClient',
    
    # Telegram
    'TelegramTradingBot',
    'ExpirationType',
    'SignalFormatter',
    'BotState',
    'TradingSession',
    
    # Trading Engine
    'TradingSignal',
    'TradeResult',
    'TradingEngine',
]
