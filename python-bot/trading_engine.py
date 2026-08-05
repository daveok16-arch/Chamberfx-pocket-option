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
from telegram_bot import TelegramTradingBot, ExpirationType

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
            'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc',
            'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc'
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
            on_signal_callback=self._on_telegram_signal_request
        )
        
        # Indicator pipeline (for tick-volume bars)
        self.indicators = TechnicalIndicatorPipeline(min_bars=50)
        
        # Signal debouncing
        self._signal_cooldown: Dict[str, float] = {}  # asset -> last_signal_time
        self._signal_cooldown_seconds = 60
        
        # Active analysis sessions (chat_id -> task)
        self._analysis_tasks: Dict[int, asyncio.Task] = {}
        
        # Trade tracking
        self._active_trades: Dict[str, TradingSignal] = {}
        self._trade_history: List[TradeResult] = []
        
        # Callbacks
        self._on_signal: Optional[Callable[[TradingSignal], Awaitable None]] = None
    
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
        
        # Connect to Pocket Option
        logger.info("[ENGINE] Connecting to Pocket Option...")
        if not await self.po_client.connect():
            logger.error("[ENGINE] Failed to connect to Pocket Option")
            return
        
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
        
        # Cancel analysis tasks
        for task in self._analysis_tasks.values():
            task.cancel()
        
        # Disconnect
        await self.po_client.disconnect()
        await self.telegram.stop()
        
        logger.info("[ENGINE] Shutdown complete")
    
    def _on_tick(self, update: PriceUpdate) -> None:
        """Handle raw tick update."""
        logger.debug(
            f"[TICK] {update.asset_id}: {update.price:.5f} "
            f"({update.direction})"
        )
    
    def _on_bar_complete(self, asset_id: str, bar: TickVolumeBar) -> None:
        """Handle completed tick-volume bar."""
        logger.debug(
            f"[BAR] {asset_id}: O={bar.open:.5f} H={bar.high:.5f} "
            f"L={bar.low:.5f} C={bar.close:.5f} ({bar.tick_count} ticks)"
        )
    
    def _on_tvv(self, asset_id: str, tvv: TVVReading) -> None:
        """Handle TVV reading update."""
        if tvv.signal != "WAIT":
            logger.info(
                f"[TVV] {asset_id}: {tvv.signal} "
                f"(conf={tvv.confidence}%, bias={tvv.tick_direction_bias:.2f})"
            )
    
    async def _on_telegram_signal_request(
        self,
        chat_id: int,
        expiration: ExpirationType
    ) -> None:
        """
        Handle signal request from Telegram.
        Runs analysis for 1-3 seconds then sends signal.
        """
        logger.info(f"[ENGINE] Analysis request from {chat_id} for {expiration.label}")
        
        # Cancel existing analysis for this chat
        if chat_id in self._analysis_tasks:
            self._analysis_tasks[chat_id].cancel()
        
        # Run analysis
        task = asyncio.create_task(
            self._run_analysis(chat_id, expiration)
        )
        self._analysis_tasks[chat_id] = task
        
        try:
            await task
        except asyncio.CancelledError:
            logger.info(f"[ENGINE] Analysis cancelled for {chat_id}")
        except Exception as e:
            logger.error(f"[ENGINE] Analysis error: {e}")
            await self.telegram.send_error(chat_id, str(e))
    
    async def _run_analysis(
        self,
        chat_id: int,
        expiration: ExpirationType
    ) -> None:
        """
        Run market analysis for specified duration.
        Returns when conditions match or timeout reached.
        """
        # Analysis duration based on expiration
        if expiration.seconds <= 15:
            analysis_duration = 1.0  # 1 second for turbo
        elif expiration.seconds <= 60:
            analysis_duration = 2.0  # 2 seconds for short
        else:
            analysis_duration = 3.0  # 3 seconds for longer
        
        start_time = asyncio.get_event_loop().time()
        deadline = start_time + analysis_duration
        
        # Strategy selection
        if expiration.seconds <= 15:
            strategy = "MICRO_MOMENTUM"
        else:
            strategy = "TICK_VOLUME"
        
        logger.info(
            f"[ANALYSIS] Starting {strategy} analysis for {expiration.label} "
            f"(duration: {analysis_duration}s)"
        )
        
        while asyncio.get_event_loop().time() < deadline:
            # Check for trading opportunity
            signal = await self._check_conditions(expiration, strategy)
            
            if signal and signal.direction != "WAIT":
                logger.info(
                    f"[ANALYSIS] Signal found: {signal.direction} "
                    f"{signal.asset_id} (confidence: {signal.confidence}%)"
                )
                
                # Send to Telegram
                await self.telegram.send_signal(
                    chat_id=chat_id,
                    asset_id=signal.asset_id,
                    direction=signal.direction,
                    entry_price=signal.entry_price,
                    confidence=signal.confidence,
                    time_remaining=signal.time_remaining,
                    expiration=signal.expiration,
                    reasons=signal.reasons
                )
                
                # Fire callback
                if self._on_signal:
                    await self._on_signal(signal)
                
                return  # Analysis complete
            
            await asyncio.sleep(0.1)  # Check every 100ms
        
        # No signal found within deadline
        logger.info(f"[ANALYSIS] No signal found within {analysis_duration}s")
        
        # Send "no signal" message
        await self.telegram._application.bot.send_message(
            chat_id=chat_id,
            text="⏰ <b>Analysis Complete</b>\n\n"
                 "No suitable trading opportunity found.\n"
                 "Try again in a moment.",
            parse_mode='HTML'
        )
    
    async def _check_conditions(
        self,
        expiration: ExpirationType,
        strategy: str
    ) -> Optional[TradingSignal]:
        """
        Check if trading conditions are met.
        Returns TradingSignal if conditions match, None otherwise.
        """
        time_remaining = self._get_time_remaining()
        
        for asset_id in self.assets:
            # Check cooldown
            if asset_id in self._signal_cooldown:
                last_signal = self._signal_cooldown[asset_id]
                if datetime.now().timestamp() - last_signal < self._signal_cooldown_seconds:
                    continue
            
            if strategy == "MICRO_MOMENTUM":
                signal = await self._check_micro_momentum(asset_id, expiration, time_remaining)
            else:
                signal = await self._check_tick_volume(asset_id, expiration, time_remaining)
            
            if signal and signal.direction != "WAIT":
                self._signal_cooldown[asset_id] = datetime.now().timestamp()
                return signal
        
        return None
    
    async def _check_micro_momentum(
        self,
        asset_id: str,
        expiration: ExpirationType,
        time_remaining: int
    ) -> Optional[TradingSignal]:
        """Check trading conditions using micro-momentum (TVV)."""
        tvv = self.po_client.get_tvv_reading(asset_id)
        
        if not tvv or tvv.signal == "WAIT":
            return None
        
        if tvv.confidence < self.min_confidence:
            return None
        
        current_price = self.po_client._last_prices.get(asset_id)
        if not current_price:
            return None
        
        reasons = [
            f"TVV momentum score: {tvv.momentum_score}",
            f"Tick direction bias: {tvv.tick_direction_bias:.2f}",
            f"Volatility index: {tvv.volatility_index:.2f}",
        ]
        
        if tvv.price_acceleration > 0:
            reasons.append("Positive price acceleration")
        else:
            reasons.append("Negative price acceleration")
        
        return TradingSignal(
            asset_id=asset_id,
            direction=tvv.signal,
            entry_price=current_price,
            confidence=tvv.confidence,
            time_remaining=time_remaining,
            expiration=expiration.label,
            strategy="MICRO_MOMENTUM",
            reasons=reasons,
            tvv=tvv
        )
    
    async def _check_tick_volume(
        self,
        asset_id: str,
        expiration: ExpirationType,
        time_remaining: int
    ) -> Optional[TradingSignal]:
        """Check trading conditions using tick-volume bars."""
        bars = self.po_client.get_current_bars(asset_id)
        
        if len(bars) < 50:
            return None
        
        result = self.indicators.calculate(bars)
        
        if not result or result.signal == "WAIT":
            return None
        
        if result.signal_strength < self.min_confidence:
            return None
        
        current_price = self.po_client._last_prices.get(asset_id)
        if not current_price:
            return None
        
        return TradingSignal(
            asset_id=asset_id,
            direction=result.signal,
            entry_price=current_price,
            confidence=result.signal_strength,
            time_remaining=time_remaining,
            expiration=expiration.label,
            strategy="TICK_VOLUME",
            reasons=result.reasons,
            indicators=result
        )
    
    def _get_time_remaining(self) -> int:
        """Get seconds remaining in current candle."""
        now = datetime.now().timestamp()
        candle_period = 60
        candle_start = int(now / candle_period) * candle_period
        candle_end = candle_start + candle_period
        return int(candle_end - now)


async def main():
    """Main entry point."""
    import os
    from dotenv import load_dotenv
    
    load_dotenv()
    
    TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "")
    
    if not TELEGRAM_TOKEN:
        logger.error("TELEGRAM_TOKEN not found in environment")
        return
    
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
