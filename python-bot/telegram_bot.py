"""
Telegram Interactive Trading Bot
================================
Provides inline keyboard interface for expiration selection
and real-time signal delivery.
"""

import asyncio
import logging
from typing import Optional, Dict, Callable, Awaitable, TYPE_CHECKING
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from telegram import (
    Update, 
    InlineKeyboardButton, 
    InlineKeyboardMarkup,
    Message
)
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
    ConversationHandler,
    CallbackContext
)

if TYPE_CHECKING:
    from trading_engine import TradingEngine

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)


# Expiration mapping: callback_data -> (label, seconds)
EXPIRATION_MAP = {
    "exp_5s": ("5s", 5),
    "exp_15s": ("15s", 15),
    "exp_1m": ("1m", 60),
    "exp_2m": ("2m", 120),
    "exp_3m": ("3m", 180),
    "exp_5m": ("5m", 300),
    "exp_15m": ("15m", 900),
    "exp_30m": ("30m", 1800),
}

# Strategy routing: seconds <= 15 -> MICRO_MOMENTUM, else -> TICK_VOLUME
TURBO_EXPIRATIONS = {"exp_5s", "exp_15s"}


class BotState(Enum):
    """Bot conversation states."""
    IDLE = 1
    SELECTING_EXPIRATION = 2
    ANALYZING = 3
    AWAITING_RESULT = 4


@dataclass
class TradingSession:
    """Tracks a user's trading session."""
    user_id: int
    chat_id: int
    state: BotState = BotState.IDLE
    selected_expiration: Optional[str] = None  # "5s", "1m", etc.
    selected_seconds: int = 60
    analysis_message_id: Optional[int] = None
    last_signal_time: float = 0
    created_at: datetime = field(default_factory=datetime.now)


class SignalFormatter:
    """Formats trading signals for Telegram display."""
    
    @staticmethod
    def format_signal(
        asset_id: str,
        direction: str,
        entry_price: float,
        confidence: int,
        time_remaining: int,
        expiration: str,
        reasons: list[str],
        strategy: str = "TICK_VOLUME"
    ) -> str:
        """Format a new trading signal."""
        emoji = "📈" if direction == "CALL" else "📉"
        
        reasons_text = "\n".join([f"   • {r}" for r in reasons])
        
        quality = "EXCELLENT" if time_remaining >= 50 else "GOOD" if time_remaining >= 40 else "FAIR"
        
        return f"""
{emoji} <b>NEW SIGNAL</b> {emoji}

🏷️ <b>Asset:</b> {asset_id.replace('_otc', '/OTC')}
📊 <b>Direction:</b> <code>{direction}</code>
💰 <b>Entry:</b> {entry_price:.5f}

⏱️ <b>Expiration:</b> {expiration}
⏰ <b>Time Left:</b> {time_remaining}s
🎯 <b>Confidence:</b> {confidence}%
📍 <b>Entry Quality:</b> {quality}
🔧 <b>Strategy:</b> {strategy}

📝 <b>Analysis:</b>
{reasons_text}

⏰ <b>Time:</b> {datetime.now().strftime('%H:%M:%S')}
"""
    
    @staticmethod
    def format_analysis_started(expiration: str) -> str:
        """Format the analysis-in-progress message."""
        return f"""
⏳ <b>Expiration targeted:</b> {expiration}

🔍 <i>The bot is looking for the most suitable moment to enter the deal.</i>

⚠️ <b>For correct operation, do not press any buttons.</b>

<i>Analysis will take from ~1 to ~3 seconds</i>
"""
    
    @staticmethod
    def format_no_signal(expiration: str) -> str:
        """Format no-signal message."""
        return f"""
❌ <b>Analysis Complete</b>

No high-probability setup found for {expiration}.

Please select another expiry.
"""
    
    @staticmethod
    def format_error(message: str) -> str:
        """Format an error message."""
        return f"❌ <b>Error</b>\n\n{message}"
    
    @staticmethod
    def format_main_menu() -> tuple[str, InlineKeyboardMarkup]:
        """Format main menu with keyboard."""
        text = "🎯 <b>Welcome to CHAMBERFX Trading Bot</b>\n\nSelect your trade expiration time:"
        keyboard = InlineKeyboardMarkup([
            # Row 1: Turbo options
            [
                InlineKeyboardButton("⚡ 5s", callback_data="exp_5s"),
                InlineKeyboardButton("⚡ 15s", callback_data="exp_15s"),
            ],
            # Row 2: Short term
            [
                InlineKeyboardButton("1️⃣ 1m", callback_data="exp_1m"),
                InlineKeyboardButton("2️⃣ 2m", callback_data="exp_2m"),
                InlineKeyboardButton("3️⃣ 3m", callback_data="exp_3m"),
            ],
            # Row 3: Medium term
            [
                InlineKeyboardButton("5️⃣ 5m", callback_data="exp_5m"),
                InlineKeyboardButton("1️⃣5️⃣ 15m", callback_data="exp_15m"),
                InlineKeyboardButton("3️⃣0️⃣ 30m", callback_data="exp_30m"),
            ],
        ])
        return text, keyboard


class TelegramTradingBot:
    """
    Interactive Telegram bot with inline keyboard for trading.
    Fully integrated with TradingEngine for live signal generation.
    """
    
    def __init__(
        self,
        token: str,
        trading_engine: Optional['TradingEngine'] = None
    ):
        self.token = token
        self.trading_engine = trading_engine
        
        # Session management
        self._sessions: Dict[int, TradingSession] = {}
        self._analysis_tasks: Dict[int, asyncio.Task] = {}
        
        # State
        self._application: Optional[Application] = None
        self._connected = False
        
        # Formatter
        self.formatter = SignalFormatter()
    
    @property
    def connected(self) -> bool:
        return self._connected
    
    async def start(self) -> None:
        """Initialize and start the bot."""
        self._application = Application.builder().token(self.token).build()
        
        # Register handlers
        self._application.add_handler(CommandHandler("start", self.cmd_start))
        self._application.add_handler(CommandHandler("help", self.cmd_help))
        self._application.add_handler(CommandHandler("status", self.cmd_status))
        self._application.add_handler(CommandHandler("signal", self.cmd_signal))
        
        # Callback query handler for inline buttons
        self._application.add_handler(
            CallbackQueryHandler(self.handle_callback, pattern="^(exp_|back|main_menu|refresh)")
        )
        
        # Start polling
        await self._application.initialize()
        await self._application.start()
        await self._application.updater.start_polling(allowed_updates=Update.ALL_TYPES)
        
        self._connected = True
        logger.info("Telegram bot started successfully")
    
    async def stop(self) -> None:
        """Stop the bot."""
        # Cancel all analysis tasks
        for task in self._analysis_tasks.values():
            task.cancel()
        
        if self._application:
            await self._application.stop()
            await self._application.updater.stop()
            self._connected = False
            logger.info("Telegram bot stopped")
    
    def get_session(self, user_id: int) -> TradingSession:
        """Get or create a session for a user."""
        if user_id not in self._sessions:
            self._sessions[user_id] = TradingSession(
                user_id=user_id,
                chat_id=0
            )
        return self._sessions[user_id]
    
    async def cmd_start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /start command - show main menu."""
        text, keyboard = self.formatter.format_main_menu()
        await update.message.reply_text(text, reply_markup=keyboard, parse_mode='HTML')
    
    async def cmd_help(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /help command."""
        help_text = """
<b>📚 CHAMBERFX Bot Help</b>

<b>How to Trade:</b>
1. Click /start to open the trading menu
2. Select your desired expiration time
3. The bot will analyze market conditions
4. When a signal is found, it will be sent automatically
5. Follow the signal direction and place your trade

<b>Expiration Times:</b>
• <code>5s</code> - Turbo (uses TVV micro-momentum)
• <code>15s</code> - Quick trade (uses TVV)
• <code>1m</code> - 1 minute (uses tick-volume bars)
• <code>2m</code> - 2 minutes (uses tick-volume bars)
• <code>3m</code> - 3 minutes (uses tick-volume bars)
• <code>5m</code> - 5 minutes (uses tick-volume bars)

<b>Signal Interpretation:</b>
📈 <b>CALL</b> - Price expected to rise (buy UP)
📉 <b>PUT</b> - Price expected to fall (buy DOWN)

<b>Strategies:</b>
• <b>TVV (Tick Variance Velocity)</b>: For 5s/15s - analyzes raw tick momentum
• <b>Tick-Volume Bars</b>: For 1m+ - uses OHLC bars with indicators
"""
        await update.message.reply_text(help_text, parse_mode='HTML')
    
    async def cmd_status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /status command."""
        connected = self._connected and self.trading_engine is not None and self.trading_engine.connected
        
        text = f"""
<b>🤖 CHAMBERFX Trading Bot Status</b>

📡 <b>Status:</b> {"🟢 Online" if connected else "🔴 Offline"}
📊 <b>Tracked Assets:</b> {len(self.trading_engine.assets) if self.trading_engine else 0}
👥 <b>Active Sessions:</b> {len(self._sessions)}

<b>Commands:</b>
/start - Open main menu
/signal - Get current signal
/status - Bot status
/help - Help information
"""
        await update.message.reply_text(text, parse_mode='HTML')
    
    async def cmd_signal(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /signal command - request current signal."""
        text, keyboard = self.formatter.format_main_menu()
        await update.message.reply_text(text, reply_markup=keyboard, parse_mode='HTML')
    
    async def handle_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        Handle ALL inline button callbacks.
        This is the main entry point for button interactions.
        """
        query = update.callback_query
        if not query:
            return
        
        user_id = update.effective_user.id
        session = self.get_session(user_id)
        session.chat_id = query.message.chat_id
        data = query.data
        
        logger.info(f"[TG] Callback from {user_id}: {data}")
        
        try:
            # Step A: Immediately stop the loading spinner
            await query.answer()
            
            # Route based on callback data
            if data == "back" or data == "main_menu":
                await self._handle_back_to_menu(query, session)
            
            elif data == "refresh":
                await self._handle_refresh(query, session)
            
            elif data.startswith("exp_"):
                await self._handle_expiration_select(query, session, data)
            
        except Exception as e:
            logger.error(f"[TG] Callback error: {e}")
            try:
                await query.message.reply_text(
                    self.formatter.format_error(str(e)),
                    parse_mode='HTML'
                )
            except:
                pass
    
    async def _handle_back_to_menu(
        self, 
        query: 'CallbackQuery', 
        session: TradingSession
    ):
        """Return to main menu, cancel any running analysis."""
        # Cancel running analysis
        if session.user_id in self._analysis_tasks:
            self._analysis_tasks[session.user_id].cancel()
            del self._analysis_tasks[session.user_id]
        
        session.state = BotState.IDLE
        session.selected_expiration = None
        
        text, keyboard = self.formatter.format_main_menu()
        await query.message.edit_message_text(
            text=text,
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    async def _handle_refresh(
        self,
        query: 'CallbackQuery',
        session: TradingSession
    ):
        """Handle refresh - show menu to start new analysis."""
        text, keyboard = self.formatter.format_main_menu()
        await query.message.edit_message_text(
            text=text,
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    async def _handle_expiration_select(
        self,
        query: 'CallbackQuery',
        session: TradingSession,
        data: str
    ):
        """
        Handle expiration selection and START ANALYSIS.
        
        Step 1: Parse expiration
        Step 2: Update message to analysis mode (clear buttons)
        Step 3: Start analysis task with proper strategy routing
        """
        # Parse expiration from callback data
        if data not in EXPIRATION_MAP:
            logger.error(f"[TG] Unknown expiration: {data}")
            return
        
        expiration_label, expiration_seconds = EXPIRATION_MAP[data]
        session.selected_expiration = expiration_label
        session.selected_seconds = expiration_seconds
        session.state = BotState.ANALYZING
        
        # Step 2: Clear buttons and show analysis message
        await query.message.edit_message_text(
            text=self.formatter.format_analysis_started(expiration_label),
            parse_mode='HTML'
        )
        
        # Step 3: Cancel any existing analysis task for this user
        if session.user_id in self._analysis_tasks:
            self._analysis_tasks[session.user_id].cancel()
        
        # Step 4: Start new analysis task
        task = asyncio.create_task(
            self._run_analysis(
                chat_id=session.chat_id,
                user_id=session.user_id,
                expiration=expiration_label,
                seconds=expiration_seconds,
                is_turbo=data in TURBO_EXPIRATIONS
            )
        )
        self._analysis_tasks[session.user_id] = task
    
    async def _run_analysis(
        self,
        chat_id: int,
        user_id: int,
        expiration: str,
        seconds: int,
        is_turbo: bool
    ):
        """
        Dynamic strategy routing loop.
        
        - Turbo (5s/15s): Use Micro-Momentum (TVV) over 50-tick window
        - Standard (1m+): Use Tick-Volume Bars with indicators
        
        Runs for 1-3 seconds, checks conditions every 100ms.
        Posts signal or "no signal" message at the end.
        """
        strategy = "TVV" if is_turbo else "TICK_VOLUME"
        logger.info(f"[ANALYSIS] Starting {strategy} analysis for {expiration}")
        
        # Determine analysis duration
        if seconds <= 15:
            analysis_duration = 1.0
        elif seconds <= 60:
            analysis_duration = 2.0
        else:
            analysis_duration = 3.0
        
        start_time = asyncio.get_event_loop().time()
        deadline = start_time + analysis_duration
        
        try:
            while asyncio.get_event_loop().time() < deadline:
                # Check if cancelled
                if user_id not in self._analysis_tasks:
                    logger.info(f"[ANALYSIS] Analysis cancelled for user {user_id}")
                    return
                
                # Check trading conditions based on strategy
                signal = await self._check_conditions(
                    expiration=expiration,
                    seconds=seconds,
                    is_turbo=is_turbo
                )
                
                if signal:
                    # Signal found! Send it.
                    logger.info(f"[ANALYSIS] Signal found: {signal['direction']} {signal['asset_id']}")
                    
                    await self._send_signal_message(
                        chat_id=chat_id,
                        signal=signal,
                        expiration=expiration,
                        strategy=strategy
                    )
                    return
                
                # Wait before next check
                await asyncio.sleep(0.1)
            
            # No signal found within deadline
            logger.info(f"[ANALYSIS] No signal found for {expiration}")
            await self._send_no_signal_message(chat_id=chat_id, expiration=expiration)
            
        except asyncio.CancelledError:
            logger.info(f"[ANALYSIS] Analysis cancelled for user {user_id}")
        except Exception as e:
            logger.error(f"[ANALYSIS] Error: {e}")
            await self._send_error_message(chat_id=chat_id, error=str(e))
        finally:
            # Clean up task reference
            if user_id in self._analysis_tasks:
                del self._analysis_tasks[user_id]
    
    async def _check_conditions(
        self,
        expiration: str,
        seconds: int,
        is_turbo: bool
    ) -> Optional[Dict]:
        """
        Check trading conditions based on selected strategy.
        
        Returns signal dict if conditions match, None otherwise.
        """
        if not self.trading_engine or not self.trading_engine.connected:
            return None
        
        engine = self.trading_engine
        
        if is_turbo:
            # Use TVV (Tick Variance Velocity)
            return await self._check_tvv_conditions(engine, expiration)
        else:
            # Use Tick-Volume Bars with indicators
            return await self._check_tvb_conditions(engine, expiration)
    
    async def _check_tvv_conditions(
        self,
        engine: 'TradingEngine',
        expiration: str
    ) -> Optional[Dict]:
        """
        Check conditions using Micro-Momentum (TVV).
        Looks at 50-tick sliding window for turbo expirations.
        """
        # Get all TVV readings
        readings = engine.get_all_tvv_readings()
        
        time_remaining = engine.get_time_remaining()
        
        for asset_id, tvv in readings.items():
            if not tvv:
                continue
            
            # Check cooldown
            if engine.is_in_cooldown(asset_id):
                continue
            
            # TVV gives direct signal
            if tvv.signal != "WAIT" and tvv.confidence >= engine.min_confidence:
                current_price = engine.get_current_price(asset_id)
                
                if current_price:
                    reasons = [
                        f"TVV Score: {tvv.momentum_score}",
                        f"Tick Bias: {tvv.tick_direction_bias:.2f}",
                        f"Volatility: {tvv.volatility_index:.2f}",
                    ]
                    if tvv.price_acceleration > 0:
                        reasons.append("Positive acceleration")
                    else:
                        reasons.append("Negative acceleration")
                    
                    return {
                        "asset_id": asset_id,
                        "direction": tvv.signal,
                        "entry_price": current_price,
                        "confidence": tvv.confidence,
                        "time_remaining": time_remaining,
                        "reasons": reasons,
                        "strategy": "TVV (Micro-Momentum)"
                    }
        
        return None
    
    async def _check_tvb_conditions(
        self,
        engine: 'TradingEngine',
        expiration: str
    ) -> Optional[Dict]:
        """
        Check conditions using Tick-Volume Bars with indicators.
        """
        # Get all indicator results
        results = engine.get_all_indicator_results()
        
        time_remaining = engine.get_time_remaining()
        
        for asset_id, result in results.items():
            if not result:
                continue
            
            # Check cooldown
            if engine.is_in_cooldown(asset_id):
                continue
            
            # Check signal from indicators
            if result.signal != "WAIT" and result.signal_strength >= engine.min_confidence:
                current_price = engine.get_current_price(asset_id)
                
                if current_price:
                    return {
                        "asset_id": asset_id,
                        "direction": result.signal,
                        "entry_price": current_price,
                        "confidence": result.signal_strength,
                        "time_remaining": time_remaining,
                        "reasons": result.reasons,
                        "strategy": "Tick-Volume Bars"
                    }
        
        return None
    
    async def _send_signal_message(
        self,
        chat_id: int,
        signal: Dict,
        expiration: str,
        strategy: str
    ):
        """Send the trading signal message."""
        if not self._application:
            return
        
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("🔄 New Signal", callback_data="refresh")],
            [InlineKeyboardButton("📱 Main Menu", callback_data="main_menu")]
        ])
        
        await self._application.bot.send_message(
            chat_id=chat_id,
            text=self.formatter.format_signal(
                asset_id=signal['asset_id'],
                direction=signal['direction'],
                entry_price=signal['entry_price'],
                confidence=signal['confidence'],
                time_remaining=signal['time_remaining'],
                expiration=expiration,
                reasons=signal['reasons'],
                strategy=signal.get('strategy', strategy)
            ),
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    async def _send_no_signal_message(self, chat_id: int, expiration: str):
        """Send 'no signal' message and restore menu."""
        if not self._application:
            return
        
        text = self.formatter.format_no_signal(expiration)
        _, keyboard = self.formatter.format_main_menu()
        
        await self._application.bot.send_message(
            chat_id=chat_id,
            text=text,
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    async def _send_error_message(self, chat_id: int, error: str):
        """Send error message and restore menu."""
        if not self._application:
            return
        
        text = self.formatter.format_error(error)
        _, keyboard = self.formatter.format_main_menu()
        
        await self._application.bot.send_message(
            chat_id=chat_id,
            text=text,
            reply_markup=keyboard,
            parse_mode='HTML'
        )
