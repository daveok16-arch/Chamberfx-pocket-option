"""
Tick-Volume Bars Engine
=======================
Replaces time-based OHLC bars with tick-count based bars.
Every 150-200 incoming tick packets form a synthetic OHLC bar.
"""

import asyncio
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Optional, List
from datetime import datetime
import pandas as pd
import numpy as np


@dataclass
class TickVolumeBar:
    """A single OHLC bar formed by tick count, not time."""
    asset_id: str
    open: float
    high: float
    low: float
    close: float
    tick_count: int
    open_time: datetime
    close_time: datetime
    volume: float = 0.0
    
    @property
    def is_bullish(self) -> bool:
        return self.close > self.open
    
    @property
    def body_size(self) -> float:
        return abs(self.close - self.open)
    
    @property
    def range(self) -> float:
        return self.high - self.low
    
    @property
    def upper_wick(self) -> float:
        if self.is_bullish:
            return self.high - self.close
        return self.high - self.open
    
    @property
    def lower_wick(self) -> float:
        if self.is_bullish:
            return self.open - self.low
        return self.close - self.low


@dataclass 
class Tick:
    """Single tick data point."""
    asset_id: str
    price: float
    timestamp: float
    direction: str = "FLAT"  # UP, DOWN, FLAT


class TickVolumeBarBuilder:
    """
    Builds OHLC bars based on tick count instead of time intervals.
    Each bar contains exactly `tick_threshold` ticks before closing.
    """
    
    def __init__(
        self, 
        tick_threshold: int = 175,  # Middle of 150-200 range
        warmup_bars: int = 50      # Number of bars to keep in memory
    ):
        self.tick_threshold = tick_threshold
        self.warmup_bars = warmup_bars
        
        # Per-asset state
        self._ticks: Deque[Tick] = deque(maxlen=200)
        self._bars: Deque[TickVolumeBar] = deque(maxlen=warmup_bars)
        self._pending_ticks: List[Tick] = []
        self._pending_open_price: Optional[float] = None
        self._bar_start_time: Optional[datetime] = None
        
    def reset(self) -> None:
        """Clear all accumulated data."""
        self._ticks.clear()
        self._bars.clear()
        self._pending_ticks.clear()
        self._pending_open_price = None
        self._bar_start_time = None
    
    def process_tick(self, tick: Tick) -> Optional[TickVolumeBar]:
        """
        Process a single tick and return completed bar if threshold reached.
        
        Returns:
            TickVolumeBar if bar just completed, None otherwise
        """
        # Calculate tick direction
        if self._ticks:
            last_price = self._ticks[-1].price
            if tick.price > last_price:
                tick.direction = "UP"
            elif tick.price < last_price:
                tick.direction = "DOWN"
            else:
                tick.direction = "FLAT"
        
        self._ticks.append(tick)
        self._pending_ticks.append(tick)
        
        # Initialize new bar if needed
        if self._pending_open_price is None:
            self._pending_open_price = tick.price
            self._bar_start_time = datetime.fromtimestamp(tick.timestamp)
        
        # Check if we've reached tick threshold
        if len(self._pending_ticks) >= self.tick_threshold:
            return self._close_bar(tick)
        
        return None
    
    def _close_bar(self, last_tick: Tick) -> TickVolumeBar:
        """Close the current bar and start a new one."""
        prices = [t.price for t in self._pending_ticks]
        
        bar = TickVolumeBar(
            asset_id=self._pending_ticks[0].asset_id,
            open=self._pending_open_price,
            high=max(prices),
            low=min(prices),
            close=last_tick.price,
            tick_count=len(self._pending_ticks),
            open_time=self._bar_start_time,
            close_time=datetime.fromtimestamp(last_tick.timestamp),
            volume=sum(abs(prices[i] - prices[i-1]) for i in range(1, len(prices)))
        )
        
        self._bars.append(bar)
        self._pending_ticks.clear()
        self._pending_open_price = last_tick.price
        self._bar_start_time = datetime.fromtimestamp(last_tick.timestamp)
        
        return bar
    
    @property
    def current_bar(self) -> Optional[TickVolumeBar]:
        """Get the current (incomplete) bar being built."""
        if not self._pending_ticks:
            return None
        
        prices = [t.price for t in self._pending_ticks]
        return TickVolumeBar(
            asset_id=self._pending_ticks[0].asset_id,
            open=self._pending_open_price,
            high=max(prices),
            low=min(prices),
            close=prices[-1],
            tick_count=len(self._pending_ticks),
            open_time=self._bar_start_time,
            close_time=datetime.now()
        )
    
    @property
    def completed_bars(self) -> List[TickVolumeBar]:
        """Get all completed bars as a list."""
        return list(self._bars)
    
    @property
    def all_bars(self) -> List[TickVolumeBar]:
        """Get all bars including the current incomplete one."""
        bars = list(self._bars)
        current = self.current_bar
        if current:
            bars.append(current)
        return bars
    
    def to_dataframe(self) -> pd.DataFrame:
        """Convert bars to pandas DataFrame for indicator calculation."""
        if not self._bars and not self._pending_ticks:
            return pd.DataFrame()
        
        data = []
        for bar in self._bars:
            data.append({
                'timestamp': bar.open_time,
                'open': bar.open,
                'high': bar.high,
                'low': bar.low,
                'close': bar.close,
                'volume': bar.volume,
                'tick_count': bar.tick_count
            })
        
        # Add current bar if exists
        current = self.current_bar
        if current:
            data.append({
                'timestamp': current.open_time,
                'open': current.open,
                'high': current.high,
                'low': current.low,
                'close': current.close,
                'volume': current.volume,
                'tick_count': current.tick_count
            })
        
        return pd.DataFrame(data)


class MultiAssetTickVolumeEngine:
    """
    Manages tick-volume bars for multiple trading assets simultaneously.
    """
    
    def __init__(
        self,
        tick_threshold: int = 175,
        warmup_bars: int = 100,
        assets: Optional[List[str]] = None
    ):
        self.tick_threshold = tick_threshold
        self.warmup_bars = warmup_bars
        self.assets = assets or []
        
        # One builder per asset
        self._builders: dict[str, TickVolumeBarBuilder] = {}
        
        # Initialize builders for known assets
        for asset in self.assets:
            self._builders[asset] = TickVolumeBarBuilder(
                tick_threshold=tick_threshold,
                warmup_bars=warmup_bars
            )
    
    def add_asset(self, asset_id: str) -> None:
        """Add a new asset to track."""
        if asset_id not in self._builders:
            self._builders[asset_id] = TickVolumeBarBuilder(
                tick_threshold=self.tick_threshold,
                warmup_bars=self.warmup_bars
            )
    
    def remove_asset(self, asset_id: str) -> None:
        """Remove an asset from tracking."""
        if asset_id in self._builders:
            del self._builders[asset_id]
    
    def process_tick(
        self, 
        asset_id: str, 
        price: float, 
        timestamp: float
    ) -> Optional[TickVolumeBar]:
        """
        Process a tick for a specific asset.
        
        Returns:
            Completed TickVolumeBar if threshold reached, None otherwise
        """
        # Auto-add asset if not tracked
        if asset_id not in self._builders:
            self.add_asset(asset_id)
        
        tick = Tick(
            asset_id=asset_id,
            price=price,
            timestamp=timestamp
        )
        
        return self._builders[asset_id].process_tick(tick)
    
    def get_bars(self, asset_id: str) -> List[TickVolumeBar]:
        """Get all bars for an asset."""
        if asset_id not in self._builders:
            return []
        return self._builders[asset_id].all_bars
    
    def get_dataframe(self, asset_id: str) -> pd.DataFrame:
        """Get DataFrame of bars for an asset."""
        if asset_id not in self._builders:
            return pd.DataFrame()
        return self._builders[asset_id].to_dataframe()
    
    def get_raw_ticks(self, asset_id: str) -> Deque[Tick]:
        """Get raw tick deque for an asset."""
        if asset_id not in self._builders:
            return deque()
        return self._builders[asset_id]._ticks
    
    def get_current_bar(self, asset_id: str) -> Optional[TickVolumeBar]:
        """Get current incomplete bar for an asset."""
        if asset_id not in self._builders:
            return None
        return self._builders[asset_id].current_bar
    
    def get_bar_progress(self, asset_id: str) -> float:
        """Get percentage completion of current bar (0.0 to 1.0)."""
        if asset_id not in self._builders:
            return 0.0
        builder = self._builders[asset_id]
        return len(builder._pending_ticks) / self.tick_threshold
