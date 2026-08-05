"""
Trading Engine
==============
Main orchestrator that integrates:
- Tick-Volume Bars
- Technical Indicators
- Micro-Momentum (TVV)
- Telegram Bot Interface
- Pocket Option WebSocket Client
"""

import asyncio
import logging
from typing import Optional, Dict, List, Callable, Awaitable
from dataclasses import dataclass, field
from datetime import datetime
from collections import deque

from pocket_option_client import PocketOptionClient, PriceUpdate
from tick_volume_bars import TickVolumeBar, Tick
from micro_momentum import TVVReading
from indicators import TechnicalIndicatorPipeline, IndicatorResult
from telegram_bot import TelegramTradingBot

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)


@dataclass
class TradingSignal:
    """Complete trading signal with all analysis data."""
    asset_id: str
    direction: str  # CALL, PUT, WAIT
    entry_price: float
    confidence: int
    time_remaining: int
    expiration: str
    strategy: str  # TICK_VOLUME, MICRO_MOMENTUM, HYBRID
    reasons: List[str]
    indicators: Optional[IndicatorResult] = None
    tvv: Optional[TVVReading] = None
    timestamp: float = field(default_factory=datetime.now().timestamp)


@dataclass
class TradeResult:
    """Result of a completed trade."""
    signal: TradingSignal
    result: str  # WIN, LOSS
    exit_price: float
    pnl: float
    duration: float


class TradingEngine:
    """
    Main trading engine that coordinates all components.
    Fully integrated with TelegramTradingBot for live signals.
    """
    
    def __init__(
        self,
        telegram_token: str,
        assets: Optional[List[str]] = None,
        tick_threshold: int = 175,
        min_confidence: int = 65
    ):
        # Configuration
        self.assets = assets or [
            # Major Pairs (highest payout)
            'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc',
            # Commodity & Minor
            'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc',
            'NZDUSD_otc', 'EURGBP_otc',
            # Crypto
            'BTCUSD_otc', 'ETHUSD_otc',
        ]
        self.tick_threshold = tick_threshold
        self.min_confidence = min_confidence
        
        # Components
        self.po_client = PocketOptionClient(
            assets=self.assets,
            tick_threshold=tick_threshold
        )
        
        self.telegram = TelegramTradingBot(
            token=telegram_token,
            trading_engine=self  # Pass self for direct access
        )
        
        # Indicator pipeline (for tick-volume bars)
        self.indicators = TechnicalIndicatorPipeline(min_bars=50)
        
        # Per-asset indicator results cache
        self._indicator_results: Dict[str, Optional[IndicatorResult]] = {}
        
        # Signal debouncing
        self._signal_cooldown: Dict[str, float] = {}  # asset -> last_signal_time
        self._signal_cooldown_seconds = 60
        
        # Connection state
        self._running = False
        
        # Trade tracking
        self._active_trades: Dict[str, TradingSignal] = {}
        self._trade_history: List[TradeResult] = []
        
        # Callbacks
        self._on_signal: Optional[Callable[[TradingSignal], Awaitable None]] = None
    
    @property
    def connected(self) -> bool:
        """Check if Pocket Option is connected."""
        return self.po_client and self.po_client.connected
    
    def set_signal_callback(
        self, 
        callback: Callable[[TradingSignal], Awaitable None]
    ) -> None:
        """Set callback for new signals."""
        self._on_signal = callback
    
    async def start(self) -> None:
        """Start the trading engine."""
        logger.info("=" * 50)
        logger.info("Starting Trading Engine")
        logger.info("=" * 50)
        
        self._running = True
        
        # Connect to Pocket Option
        logger.info("[ENGINE] Connecting to Pocket Option...")
        if not await self.po_client.connect():
            logger.error("[ENGINE] Failed to connect to Pocket Option")
        
        # Set up callbacks
        self.po_client.set_tick_callback(self._on_tick)
        self.po_client.set_bar_callback(self._on_bar_complete)
        self.po_client.set_tvv_callback(self._on_tvv)
        
        # Start Telegram bot
        logger.info("[ENGINE] Starting Telegram bot...")
        await self.telegram.start()
        
        logger.info("[ENGINE] All systems online")
    
    async def stop(self) -> None:
        """Stop the trading engine."""
        logger.info("[ENGINE] Shutting down...")
        self._running = False
        
        # Stop Telegram
        await self.telegram.stop()
        
        # Disconnect Pocket Option
        await self.po_client.disconnect()
        
        logger.info("[ENGINE] Shutdown complete")
    
    # ============================================
    # PUBLIC API FOR TELEGRAM BOT
    # ============================================
    
    def get_all_tvv_readings(self) -> Dict[str, Optional[TVVReading]]:
        """Get TVV readings for all tracked assets."""
        return {
            asset_id: self.po_client.get_tvv_reading(asset_id)
            for asset_id in self.assets
        }
    
    def get_single_tvv_reading(self, asset_id: str) -> Optional[TVVReading]:
        """Get TVV reading for a specific asset."""
        return self.po_client.get_tvv_reading(asset_id)
    
    def get_all_indicator_results(self) -> Dict[str, Optional[IndicatorResult]]:
        """Get indicator results for all assets."""
        return self._indicator_results.copy()
    
    def get_single_indicator_result(self, asset_id: str) -> Optional[IndicatorResult]:
        """Get indicator result for a specific asset."""
        return self._indicator_results.get(asset_id)
    
    def get_current_price(self, asset_id: str) -> Optional[float]:
        """Get current price for an asset."""
        return self.po_client._last_prices.get(asset_id)
    
    def get_time_remaining(self) -> int:
        """Get seconds remaining in current candle."""
        now = datetime.now().timestamp()
        candle_period = 60
        candle_start = int(now / candle_period) * candle_period
        candle_end = candle_start + candle_period
        return int(candle_end - now)
    
    def is_in_cooldown(self, asset_id: str) -> bool:
        """Check if asset is in signal cooldown."""
        if asset_id not in self._signal_cooldown:
            return False
        
        elapsed = datetime.now().timestamp() - self._signal_cooldown[asset_id]
        return elapsed < self._signal_cooldown_seconds
    
    def set_cooldown(self, asset_id: str) -> None:
        """Set cooldown for an asset after signal."""
        self._signal_cooldown[asset_id] = datetime.now().timestamp()
    
    def change_symbol(self, asset_id: str) -> None:
        """Change the active symbol being streamed."""
        if self.po_client:
            self.po_client.set_active_symbol(asset_id)
    
    # ============================================
    # INTERNAL CALLBACKS
    # ============================================
    
    def _on_tick(self, update: PriceUpdate) -> None:
        """Handle raw tick update."""
        logger.debug(
            f"[TICK] {update.asset_id}: {update.price:.5f} "
            f"({update.direction})"
        )
    
    def _on_bar_complete(self, asset_id: str, bar: TickVolumeBar) -> None:
        """Handle completed tick-volume bar - calculate indicators."""
        logger.debug(
            f"[BAR] {asset_id}: O={bar.open:.5f} H={bar.high:.5f} "
            f"L={bar.low:.5f} C={bar.close:.5f} ({bar.tick_count} ticks)"
        )
        
        # Calculate indicators for this asset
        bars = self.po_client.get_current_bars(asset_id)
        if len(bars) >= 50:
            result = self.indicators.calculate(bars)
            self._indicator_results[asset_id] = result
            
            if result and result.signal != "WAIT":
                logger.info(
                    f"[INDICATORS] {asset_id}: {result.signal} "
                    f"(strength: {result.signal_strength}%)"
                )
    
    def _on_tvv(self, asset_id: str, tvv: TVVReading) -> None:
        """Handle TVV reading update."""
        if tvv.signal != "WAIT":
            logger.info(
                f"[TVV] {asset_id}: {tvv.signal} "
                f"(conf={tvv.confidence}%, bias={tvv.tick_direction_bias:.2f})"
            )


async def main():
    """Main entry point."""
    import os
    from dotenv import load_dotenv
    
    load_dotenv()
    
    TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "8214823027:AAFecgXUdvfnI9uPhvDD7wmE26N9DWZmpzs")
    
    engine = TradingEngine(
        telegram_token=TELEGRAM_TOKEN,
        assets=['EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'XAUUSD_otc'],
        tick_threshold=175,
        min_confidence=70
    )
    
    try:
        await engine.start()
        
        # Keep running
        while True:
            await asyncio.sleep(1)
            
    except KeyboardInterrupt:
        logger.info("Received interrupt signal")
    finally:
        await engine.stop()


if __name__ == "__main__":
    asyncio.run(main())
