"""
Technical Indicators Pipeline
============================
Calculates EMA, RSI, MACD, Bollinger Bands using pandas-ta.
Designed to work with Tick-Volume Bars for reduced lag.
"""

import pandas as pd
import numpy as np
from typing import Optional, Tuple, List
from dataclasses import dataclass
from tick_volume_bars import TickVolumeBar, TickVolumeBarBuilder


@dataclass
class IndicatorResult:
    """Container for all technical indicator results."""
    # EMA values
    ema9: float
    ema21: float
    ema50: float
    
    # RSI
    rsi: float
    
    # MACD
    macd_line: float
    macd_signal: float
    macd_histogram: float
    
    # Bollinger Bands
    bb_upper: float
    bb_middle: float
    bb_lower: float
    bb_position: float  # 0-100, where price is in the band
    
    # ADX
    adx: float
    
    # ATR
    atr: float
    
    # Support/Resistance
    support: float
    resistance: float
    
    # Derived signals
    trend: str  # BULLISH, BEARISH, NEUTRAL
    signal: str  # CALL, PUT, WAIT
    signal_strength: int  # 0-100
    reasons: List[str]
    
    # Bar info
    bar: TickVolumeBar
    

class TechnicalIndicatorPipeline:
    """
    Calculates technical indicators from Tick-Volume Bars.
    Uses pandas-ta for efficient indicator computation.
    """
    
    def __init__(
        self,
        min_bars: int = 50,  # Minimum bars needed for all indicators
        ema_fast: int = 9,
        ema_slow: int = 21,
        ema_trend: int = 50,
        rsi_period: int = 14,
        macd_fast: int = 12,
        macd_slow: int = 26,
        macd_signal: int = 9,
        bb_period: int = 20,
        bb_std: float = 2.0,
        adx_period: int = 14,
        atr_period: int = 14
    ):
        self.min_bars = min_bars
        
        # Indicator parameters
        self.ema_fast = ema_fast
        self.ema_slow = ema_slow
        self.ema_trend = ema_trend
        self.rsi_period = rsi_period
        self.macd_fast = macd_fast
        self.macd_slow = macd_slow
        self.macd_signal = macd_signal
        self.bb_period = bb_period
        self.bb_std = bb_std
        self.adx_period = adx_period
        self.atr_period = atr_period
        
        # Import pandas_ta
        try:
            import pandas_ta as ta
            self.ta = ta
        except ImportError:
            self.ta = None
            print("Warning: pandas_ta not installed. Using manual calculations.")
    
    def calculate(self, bars: List[TickVolumeBar]) -> Optional[IndicatorResult]:
        """
        Calculate all indicators from a list of Tick-Volume Bars.
        
        Args:
            bars: List of completed bars (should include current bar)
            
        Returns:
            IndicatorResult or None if insufficient data
        """
        if len(bars) < self.min_bars:
            return None
        
        # Convert to DataFrame
        df = self._bars_to_dataframe(bars)
        
        if df is None or len(df) < self.min_bars:
            return None
        
        # Calculate indicators
        ema9, ema21, ema50 = self._calculate_ema(df)
        rsi = self._calculate_rsi(df)
        macd_line, macd_signal, macd_histogram = self._calculate_macd(df)
        bb_upper, bb_middle, bb_lower, bb_position = self._calculate_bb(df)
        adx = self._calculate_adx(df)
        atr = self._calculate_atr(df)
        support, resistance = self._calculate_support_resistance(df)
        
        # Current bar
        current_bar = bars[-1]
        current_price = current_bar.close
        
        # Generate signal
        signal, strength, reasons = self._generate_signal(
            current_price=current_price,
            ema9=ema9, ema21=ema21, ema50=ema50,
            rsi=rsi,
            macd_histogram=macd_histogram,
            bb_upper=bb_upper, bb_lower=bb_lower, bb_position=bb_position,
            adx=adx
        )
        
        # Determine trend
        if ema9 > ema21 > ema50:
            trend = "BULLISH"
        elif ema9 < ema21 < ema50:
            trend = "BEARISH"
        else:
            trend = "NEUTRAL"
        
        return IndicatorResult(
            ema9=ema9, ema21=ema21, ema50=ema50,
            rsi=rsi,
            macd_line=macd_line, macd_signal=macd_signal, macd_histogram=macd_histogram,
            bb_upper=bb_upper, bb_middle=bb_middle, bb_lower=bb_lower, bb_position=bb_position,
            adx=adx, atr=atr,
            support=support, resistance=resistance,
            trend=trend, signal=signal, signal_strength=strength,
            reasons=reasons, bar=current_bar
        )
    
    def _bars_to_dataframe(self, bars: List[TickVolumeBar]) -> Optional[pd.DataFrame]:
        """Convert bars to DataFrame for indicator calculation."""
        if not bars:
            return None
        
        data = [{
            'timestamp': bar.open_time,
            'open': bar.open,
            'high': bar.high,
            'low': bar.low,
            'close': bar.close,
            'volume': bar.volume,
            'tick_count': bar.tick_count
        } for bar in bars]
        
        return pd.DataFrame(data)
    
    def _calculate_ema(self, df: pd.DataFrame) -> Tuple[float, float, float]:
        """Calculate EMA values."""
        closes = df['close'].values
        
        if len(closes) < self.ema_trend:
            return closes[-1] if len(closes) > 0 else 0
        
        if self.ta:
            # Using pandas_ta
            ema9 = self.ta.ema(closes, length=self.ema_fast)
            ema21 = self.ta.ema(closes, length=self.ema_slow)
            ema50 = self.ta.ema(closes, length=self.ema_trend)
        else:
            # Manual EMA calculation
            ema9 = self._manual_ema(closes, self.ema_fast)
            ema21 = self._manual_ema(closes, self.ema_slow)
            ema50 = self._manual_ema(closes, self.ema_trend)
        
        return (
            float(ema9[-1] if hasattr(ema9, '__len__') else ema9),
            float(ema21[-1] if hasattr(ema21, '__len__') else ema21),
            float(ema50[-1] if hasattr(ema50, '__len__') else ema50)
        )
    
    def _manual_ema(self, data: np.ndarray, period: int) -> np.ndarray:
        """Manual EMA calculation as fallback."""
        k = 2 / (period + 1)
        ema = np.zeros_like(data)
        ema[0] = data[0]
        
        for i in range(1, len(data)):
            ema[i] = data[i] * k + ema[i-1] * (1 - k)
        
        return ema
    
    def _calculate_rsi(self, df: pd.DataFrame) -> float:
        """Calculate RSI."""
        closes = df['close'].values
        
        if len(closes) < self.rsi_period + 1:
            return 50.0
        
        if self.ta:
            rsi = self.ta.rsi(closes, length=self.rsi_period)
            return float(rsi[-1] if hasattr(rsi, '__len__') else rsi)
        
        # Manual RSI
        deltas = np.diff(closes)
        gains = np.where(deltas > 0, deltas, 0)
        losses = np.where(deltas < 0, -deltas, 0)
        
        avg_gain = np.mean(gains[-self.rsi_period:])
        avg_loss = np.mean(losses[-self.rsi_period:])
        
        if avg_loss == 0:
            return 100.0
        
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
        
        return float(rsi)
    
    def _calculate_macd(
        self, df: pd.DataFrame
    ) -> Tuple[float, float, float]:
        """Calculate MACD."""
        closes = df['close'].values
        
        if len(closes) < self.macd_slow + self.macd_signal:
            return 0.0, 0.0, 0.0
        
        if self.ta:
            macd = self.ta.macd(
                closes,
                fast=self.macd_fast,
                slow=self.macd_slow,
                signal=self.macd_signal
            )
            if hasattr(macd, 'values'):
                macd_df = macd
            else:
                macd_df = pd.DataFrame(macd)
            
            macd_line = float(macd_df.iloc[-1, 0]) if len(macd_df) > 0 else 0
            macd_signal = float(macd_df.iloc[-1, 1]) if len(macd_df) > 0 else 0
            macd_histogram = float(macd_df.iloc[-1, 2]) if len(macd_df) > 0 else 0
        else:
            # Manual MACD
            ema_fast = self._manual_ema(closes, self.macd_fast)
            ema_slow = self._manual_ema(closes, self.macd_slow)
            macd_line = ema_fast[-1] - ema_slow[-1]
            
            # Signal line (EMA of MACD line)
            macd_line_arr = np.array([macd_line])
            macd_signal = self._manual_ema(macd_line_arr, self.macd_signal)[-1]
            macd_histogram = macd_line - macd_signal
        
        return macd_line, macd_signal, macd_histogram
    
    def _calculate_bb(
        self, df: pd.DataFrame
    ) -> Tuple[float, float, float, float]:
        """Calculate Bollinger Bands and position."""
        closes = df['close'].values
        
        if len(closes) < self.bb_period:
            return closes[-1], closes[-1], closes[-1], 50.0
        
        if self.ta:
            bb = self.ta.bbands(
                closes,
                length=self.bb_period,
                std=self.bb_std
            )
            if hasattr(bb, 'values'):
                bb_df = bb
            else:
                bb_df = pd.DataFrame(bb)
            
            bb_upper = float(bb_df.iloc[-1, 0]) if len(bb_df) > 0 else closes[-1]
            bb_middle = float(bb_df.iloc[-1, 1]) if len(bb_df) > 0 else closes[-1]
            bb_lower = float(bb_df.iloc[-1, 2]) if len(bb_df) > 0 else closes[-1]
        else:
            # Manual Bollinger Bands
            sma = np.mean(closes[-self.bb_period:])
            std = np.std(closes[-self.bb_period:])
            
            bb_middle = sma
            bb_upper = sma + (std * self.bb_std)
            bb_lower = sma - (std * self.bb_std)
        
        # Calculate position (0-100)
        current = closes[-1]
        if bb_upper != bb_lower:
            bb_position = ((current - bb_lower) / (bb_upper - bb_lower)) * 100
        else:
            bb_position = 50.0
        
        return bb_upper, bb_middle, bb_lower, float(bb_position)
    
    def _calculate_adx(self, df: pd.DataFrame) -> float:
        """Calculate ADX."""
        highs = df['high'].values
        lows = df['low'].values
        closes = df['close'].values
        
        if len(closes) < self.adx_period + 1:
            return 25.0
        
        if self.ta:
            adx = self.ta.adx(closes, highs, lows, length=self.adx_period)
            return float(adx[-1] if hasattr(adx, '__len__') else adx)
        
        # Simplified ADX approximation
        return 25.0
    
    def _calculate_atr(self, df: pd.DataFrame) -> float:
        """Calculate ATR."""
        highs = df['high'].values
        lows = df['low'].values
        closes = df['close'].values
        
        if len(closes) < self.atr_period + 1:
            return 0.0
        
        if self.ta:
            atr = self.ta.atr(highs, lows, closes, length=self.atr_period)
            return float(atr[-1] if hasattr(atr, '__len__') else atr)
        
        # Manual ATR
        tr = np.maximum(
            highs[1:] - lows[1:],
            np.maximum(
                np.abs(highs[1:] - closes[:-1]),
                np.abs(lows[1:] - closes[:-1])
            )
        )
        atr = np.mean(tr[-self.atr_period:])
        
        return float(atr)
    
    def _calculate_support_resistance(
        self, df: pd.DataFrame
    ) -> Tuple[float, float]:
        """Calculate support and resistance levels."""
        lows = df['low'].values[-20:]
        highs = df['high'].values[-20:]
        
        support = float(np.min(lows))
        resistance = float(np.max(highs))
        
        return support, resistance
    
    def _generate_signal(
        self,
        current_price: float,
        ema9: float, ema21: float, ema50: float,
        rsi: float,
        macd_histogram: float,
        bb_upper: float, bb_lower: float, bb_position: float,
        adx: float
    ) -> Tuple[str, int, List[str]]:
        """
        Generate trading signal from indicators.
        
        Returns:
            (signal, strength, reasons)
        """
        bullish_score = 0
        bearish_score = 0
        reasons = []
        
        # EMA Crossover
        if ema9 > ema21:
            bullish_score += 20
            reasons.append("EMA 9 > EMA 21 (bullish crossover)")
        else:
            bearish_score += 20
            reasons.append("EMA 9 < EMA 21 (bearish crossover)")
        
        # Price relative to EMAs
        if current_price > ema9:
            bullish_score += 10
            reasons.append("Price above EMA 9")
        else:
            bearish_score += 10
            reasons.append("Price below EMA 9")
        
        # Trend alignment with EMA50
        if ema9 > ema50:
            bullish_score += 15
            reasons.append("Short-term bullish vs long-term")
        else:
            bearish_score += 15
            reasons.append("Short-term bearish vs long-term")
        
        # RSI
        if rsi < 30:
            bullish_score += 25
            reasons.append(f"RSI oversold ({rsi:.1f})")
        elif rsi > 70:
            bearish_score += 25
            reasons.append(f"RSI overbought ({rsi:.1f})")
        elif rsi < 45:
            bullish_score += 10
        elif rsi > 55:
            bearish_score += 10
        
        # MACD Histogram
        if macd_histogram > 0:
            bullish_score += 15
            reasons.append("MACD histogram positive")
        else:
            bearish_score += 15
            reasons.append("MACD histogram negative")
        
        # Bollinger Bands
        if bb_position < 20:
            bullish_score += 20
            reasons.append("Price near lower Bollinger band")
        elif bb_position > 80:
            bearish_score += 20
            reasons.append("Price near upper Bollinger band")
        
        # ADX (trend strength)
        if adx > 25:
            if bullish_score > bearish_score:
                reasons.append(f"Strong uptrend (ADX: {adx:.1f})")
            else:
                reasons.append(f"Strong downtrend (ADX: {adx:.1f})")
        
        # Calculate final signal
        total = bullish_score + bearish_score
        strength = 0
        signal = "WAIT"
        
        if total > 0:
            direction_ratio = abs(bullish_score - bearish_score) / total
            base_strength = direction_ratio * 100
            min_score = min(bullish_score, bearish_score) / 2
            strength = int(min(100, base_strength + min_score))
            
            if bullish_score > bearish_score + 15:
                signal = "CALL"
            elif bearish_score > bullish_score + 15:
                signal = "PUT"
        
        return signal, strength, reasons
