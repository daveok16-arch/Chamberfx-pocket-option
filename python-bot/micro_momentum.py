"""
Micro-Momentum Engine
====================
Ultra-low latency momentum calculation using raw tick data.
Bypasses OHLC indicators for 5s/15s expiration trading.
Computes Tick Variance Velocity (TVV) over last 50 raw ticks.
"""

import asyncio
from collections import deque
from dataclasses import dataclass
from typing import Deque, Optional, List, Tuple
from datetime import datetime
import numpy as np
from collections import Counter


@dataclass
class TVVReading:
    """Tick Variance Velocity reading."""
    timestamp: float
    tvv: float                    # Tick Variance Velocity
    momentum_score: float          # -100 to +100
    tick_direction_bias: float     # UP/DOWN ratio
    price_acceleration: float      # Rate of price change
    volatility_index: float        # Tick-to-tick variance
    signal: str                    # CALL, PUT, WAIT
    confidence: int                # 0-100


class MicroMomentumEngine:
    """
    Computes ultra-short term momentum directly from raw ticks.
    Designed for 5s and 15s expiration trading where OHLC bars
    introduce too much lag.
    
    TVV (Tick Variance Velocity) Formula:
    - Track last N=50 raw ticks
    - Calculate tick-to-tick returns
    - Compute rolling variance
    - Direction bias from cumulative tick directions
    """
    
    def __init__(
        self,
        tick_window: int = 50,
        signal_threshold: float = 0.6,
        confidence_threshold: int = 70
    ):
        self.tick_window = tick_window
        self.signal_threshold = signal_threshold  # 60% directional bias
        self.confidence_threshold = confidence_threshold  # Min 70% for signal
        
        # Per-asset tick storage
        self._price_buffer: Deque[float] = deque(maxlen=tick_window)
        self._time_buffer: Deque[float] = deque(maxlen=tick_window)
        self._direction_buffer: Deque[int] = deque(maxlen=tick_window)  # +1 UP, -1 DOWN, 0 FLAT
        
        # Historical TVV readings for smoothing
        self._tvv_history: Deque[float] = deque(maxlen=10)
        
    def reset(self) -> None:
        """Clear all buffers."""
        self._price_buffer.clear()
        self._time_buffer.clear()
        self._direction_buffer.clear()
        self._tvv_history.clear()
    
    def process_tick(
        self, 
        price: float, 
        timestamp: float
    ) -> Optional[TVVReading]:
        """
        Process a single tick and compute TVV metrics.
        
        Returns:
            TVVReading if enough data accumulated, None otherwise
        """
        # Calculate direction
        direction = 0
        if len(self._price_buffer) > 0:
            last_price = self._price_buffer[-1]
            if price > last_price:
                direction = 1
            elif price < last_price:
                direction = -1
        
        # Store in buffers
        self._price_buffer.append(price)
        self._time_buffer.append(timestamp)
        self._direction_buffer.append(direction)
        
        # Need minimum ticks for calculation
        if len(self._price_buffer) < 10:
            return None
        
        return self._compute_tvv(price, timestamp)
    
    def _compute_tvv(self, current_price: float, current_time: float) -> TVVReading:
        """Compute Tick Variance Velocity metrics."""
        prices = list(self._price_buffer)
        directions = list(self._direction_buffer)
        times = list(self._time_buffer)
        
        # 1. Tick Direction Bias (-1 to +1)
        direction_sum = sum(directions)
        direction_bias = direction_sum / len(directions)  # Normalized -1 to +1
        
        # 2. Price Returns
        returns = np.diff(prices) / prices[:-1] if len(prices) > 1 else np.array([0])
        
        # 3. Volatility Index (variance of returns)
        volatility_index = float(np.var(returns)) * 10000  # Scale to readable number
        
        # 4. Price Acceleration (second derivative approximation)
        if len(returns) > 2:
            accelerations = np.diff(returns)
            price_acceleration = float(np.mean(accelerations)) * 10000
        else:
            price_acceleration = 0.0
        
        # 5. TVV Calculation
        # Higher variance with strong directional bias = strong momentum
        variance = float(np.var(prices[-10:]))  # Recent 10 ticks variance
        normalized_variance = variance / current_price if current_price > 0 else 0
        
        # TVV = direction_bias * sqrt(variance) * volatility_factor
        tvv = direction_bias * np.sqrt(normalized_variance + 0.0001) * 1000
        
        # 6. Rolling TVV (smoothing)
        self._tvv_history.append(tvv)
        smoothed_tvv = np.mean(list(self._tvv_history))
        
        # 7. Momentum Score (-100 to +100)
        momentum_score = int(direction_bias * 100)
        
        # 8. Generate Signal
        abs_direction_bias = abs(direction_bias)
        
        if abs_direction_bias >= self.signal_threshold:
            # Strong directional signal
            confidence = int(abs_direction_bias * 100)
            
            # Adjust confidence based on volatility
            if volatility_index > 0.5:
                confidence = min(100, confidence + 20)  # High volatility confirms momentum
            elif volatility_index < 0.1:
                confidence = max(20, confidence - 30)    # Low volatility weakens signal
            
            # Adjust for acceleration
            if direction_bias > 0 and price_acceleration > 0:
                confidence = min(100, confidence + 10)
            elif direction_bias < 0 and price_acceleration < 0:
                confidence = min(100, confidence + 10)
            
            if confidence >= self.confidence_threshold:
                signal = "CALL" if direction_bias > 0 else "PUT"
            else:
                signal = "WAIT"
        else:
            signal = "WAIT"
            confidence = int(abs_direction_bias * 100)
        
        return TVVReading(
            timestamp=current_time,
            tvv=float(smoothed_tvv),
            momentum_score=momentum_score,
            tick_direction_bias=float(direction_bias),
            price_acceleration=price_acceleration,
            volatility_index=volatility_index,
            signal=signal,
            confidence=confidence
        )
    
    def get_reading(self) -> Optional[TVVReading]:
        """Get the latest TVV reading if available."""
        if len(self._price_buffer) < 10:
            return None
        
        current_price = self._price_buffer[-1]
        current_time = self._time_buffer[-1]
        return self._compute_tvv(current_price, current_time)
    
    def predict_next_tick(self) -> Tuple[float, float]:
        """
        Simple linear prediction of next tick price and direction.
        
        Returns:
            (predicted_price, confidence)
        """
        if len(self._price_buffer) < 5:
            return self._price_buffer[-1] if self._price_buffer else 0.0, 0.0
        
        prices = list(self._price_buffer)
        
        # Linear regression for trend
        x = np.arange(len(prices))
        y = np.array(prices)
        
        slope, intercept = np.polyfit(x, y, 1)
        
        # Predict next
        predicted_price = slope * len(prices) + intercept
        
        # Confidence based on R-squared
        y_pred = slope * x + intercept
        ss_res = np.sum((y - y_pred) ** 2)
        ss_tot = np.sum((y - np.mean(y)) ** 2)
        r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0
        
        return predicted_price, float(r_squared)


class MultiAssetMicroMomentum:
    """Manages micro-momentum for multiple assets."""
    
    def __init__(
        self,
        tick_window: int = 50,
        signal_threshold: float = 0.6,
        confidence_threshold: int = 70
    ):
        self.engines: dict[str, MicroMomentumEngine] = {}
        self.tick_window = tick_window
        self.signal_threshold = signal_threshold
        self.confidence_threshold = confidence_threshold
    
    def add_asset(self, asset_id: str) -> None:
        """Add an asset to track."""
        if asset_id not in self.engines:
            self.engines[asset_id] = MicroMomentumEngine(
                tick_window=self.tick_window,
                signal_threshold=self.signal_threshold,
                confidence_threshold=self.confidence_threshold
            )
    
    def process_tick(
        self,
        asset_id: str,
        price: float,
        timestamp: float
    ) -> Optional[TVVReading]:
        """Process tick for an asset."""
        if asset_id not in self.engines:
            self.add_asset(asset_id)
        
        return self.engines[asset_id].process_tick(price, timestamp)
    
    def get_reading(self, asset_id: str) -> Optional[TVVReading]:
        """Get latest reading for an asset."""
        if asset_id not in self.engines:
            return None
        return self.engines[asset_id].get_reading()
    
    def get_all_readings(self) -> dict[str, TVVReading]:
        """Get latest readings for all tracked assets."""
        return {
            asset_id: engine.get_reading()
            for asset_id, engine in self.engines.items()
            if engine.get_reading() is not None
        }
    
    def get_signals(self) -> List[Tuple[str, TVVReading]]:
        """Get all CALL/PUT signals."""
        signals = []
        for asset_id, reading in self.get_all_readings().items():
            if reading.signal != "WAIT":
                signals.append((asset_id, reading))
        return signals
