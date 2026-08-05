"""
Telegram Interactive Trading Bot
================================
Provides inline keyboard interface for expiration selection
and real-time signal delivery.
"""

import asyncio
import logging
from typing import Optional, Dict, Callable, Awaitable
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
    ConversationHandler
)


# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)


class ExpirationType(Enum):
    """Available expiration times."""
    S5 = ("5s", 5)
    S15 = ("15s", 15)
    M1 = ("1m", 60)
    M2 = ("2m", 120)
    M3 = ("3m", 180)
    M5 = ("5m", 300)
    M15 = ("15m", 900)
    M30 = ("30m", 1800)
    
    def __init__(self, label: str, seconds: int):
        self.label = label
        self.seconds = seconds


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
    selected_expiration: Optional[ExpirationType] = None
    selected_asset: Optional[str] = None
    analysis_message: Optional[Message] = None
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
        reasons: list[str]
    ) -> str:
        """Format a new trading signal."""
        emoji = "📈" if direction == "CALL" else "📉"
        
        reasons_text = "\n".join([f"   • {r}" for r in reasons])
        
        return f"""
{emoji} <b>NEW SIGNAL</b> {emoji}

🏷️ <b>Asset:</b> {asset_id.replace('_otc', '/OTC')}
📊 <b>Direction:</b> <code>{direction}</code>
💰 <b>Entry:</b> {entry_price:.5f}

⏱️ <b>Expiration:</b> {expiration}
⏰ <b>Time Left:</b> {time_remaining}s
🎯 <b>Confidence:</b> {confidence}%
📍 <b>Entry Quality:</b> {"EXCELLENT" if time_remaining >= 50 else "GOOD" if time_remaining >= 40 else "FAIR"}

📝 <b>Analysis:</b>
{reasons_text}

⏰ <b>Time:</b> {datetime.now().strftime('%H:%M:%S')}
"""
    
    @staticmethod
    def format_analysis_started(
        expiration: str,
        asset: str
    ) -> str:
        """Format the analysis-in-progress message."""
        return f"""
⏳ <b>ANALYSIS MODE</b>

📊 <b>Asset:</b> {asset.replace('_otc', '/OTC')}
⏱️ <b>Expiration:</b> {expiration}

🔍 <i>The bot is looking for the most suitable moment to enter the deal...</i>

⚠️ <b>For correct operation, do not press any buttons.</b>

<i>Analyzing market data...</i>
"""
    
    @staticmethod
    def format_error(message: str) -> str:
        """Format an error message."""
        return f"❌ <b>Error</b>\n\n{message}"
    
    @staticmethod
    def format_status(
        connected: bool,
        assets: list[str],
        active_sessions: int
    ) -> str:
        """Format bot status."""
        status = "🟢 Online" if connected else "🔴 Offline"
        assets_text = "\n".join([f"   • {a.replace('_otc', '/OTC')}" for a in assets])
        
        return f"""
<b>🤖 CHAMBERFX Trading Bot Status</b>

📡 <b>Status:</b> {status}
📊 <b>Tracked Assets:</b> {len(assets)}
👥 <b>Active Sessions:</b> {active_sessions}

<b>Available Assets:</b>
{assets_text}

<b>Commands:</b>
/start - Open main menu
/signal - Get current signal
/status - Bot status
/help - Help information
"""


class TelegramTradingBot:
    """
    Interactive Telegram bot with inline keyboard for trading.
    """
    
    # Callback data constants
    CALLBACK_EXPIRATION = "exp_{}"
    CALLBACK_ASSET = "asset_{}"
    CALLBACK_BACK = "back"
    CALLBACK_MAIN_MENU = "main_menu"
    CALLBACK_REFRESH = "refresh"
    
    def __init__(
        self,
        token: str,
        on_signal_callback: Optional[Callable[[str, ExpirationType], Awaitable None]] = None
    ):
        self.token = token
        self.on_signal_callback = on_signal_callback
        
        # Session management
        self._sessions: Dict[int, TradingSession] = {}
        
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
            CallbackQueryHandler(self.handle_callback)
        )
        
        # Start polling
        await self._application.initialize()
        await self._application.start()
        await self._application.updater.start_polling(allowed_updates=Update.ALL_TYPES)
        
        self._connected = True
        logger.info("Telegram bot started successfully")
    
    async def stop(self) -> None:
        """Stop the bot."""
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
                chat_id=0  # Will be set on first interaction
            )
        return self._sessions[user_id]
    
    async def cmd_start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /start command - show main menu."""
        session = self.get_session(update.effective_user.id)
        session.chat_id = update.effective_chat.id
        session.state = BotState.SELECTING_EXPIRATION
        
        keyboard = self._build_expiration_keyboard()
        
        await update.message.reply_text(
            "🎯 <b>Welcome to CHAMBERFX Trading Bot</b>\n\n"
            "Select your trade expiration time:",
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
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
• <code>5s</code> - Turbo (ultra-fast)
• <code>15s</code> - Quick trade
• <code>1m</code> - 1 minute
• <code>2m</code> - 2 minutes
• <code>3m</code> - 3 minutes
• <code>5m</code> - 5 minutes

<b>Signal Interpretation:</b>
📈 <b>CALL</b> - Price expected to rise (buy UP)
📉 <b>PUT</b> - Price expected to fall (buy DOWN)

<b>Tips:</b>
• Higher confidence = more reliable signal
• Wait for EXCELLENT/GOOD entry quality
• Don't press buttons during analysis
"""
        await update.message.reply_text(help_text, parse_mode='HTML')
    
    async def cmd_status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /status command."""
        assets = ['EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'XAUUSD_otc']
        
        status_text = self.formatter.format_status(
            connected=self._connected,
            assets=assets,
            active_sessions=len(self._sessions)
        )
        
        await update.message.reply_text(status_text, parse_mode='HTML')
    
    async def cmd_signal(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /signal command - request current signal."""
        session = self.get_session(update.effective_user.id)
        session.chat_id = update.effective_chat.id
        
        # Use 1 minute as default
        keyboard = self._build_expiration_keyboard()
        
        await update.message.reply_text(
            "📊 <b>Select expiration to get signal:</b>",
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    async def handle_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle inline button callbacks."""
        query = update.callback_query
        if not query:
            return
        
        await query.answer()
        
        data = query.data
        user_id = update.effective_user.id
        session = self.get_session(user_id)
        session.chat_id = query.message.chat_id
        
        try:
            # Parse callback data
            if data == self.CALLBACK_BACK:
                await self._handle_back(query, session)
            elif data == self.CALLBACK_MAIN_MENU:
                await self._handle_main_menu(query, session)
            elif data.startswith("exp_"):
                await self._handle_expiration_select(query, session, data)
            elif data.startswith("asset_"):
                await self._handle_asset_select(query, session, data)
            elif data == self.CALLBACK_REFRESH:
                await self._handle_refresh(query, session)
        except Exception as e:
            logger.error(f"Callback error: {e}")
            await query.edit_message_text(
                self.formatter.format_error(str(e)),
                parse_mode='HTML'
            )
    
    async def _handle_back(
        self, 
        query: CallbackQuery, 
        session: TradingSession
    ):
        """Handle back button."""
        session.state = BotState.SELECTING_EXPIRATION
        session.selected_expiration = None
        session.selected_asset = None
        
        keyboard = self._build_expiration_keyboard()
        
        await query.edit_message_text(
            "🎯 <b>Back to Expiration Selection</b>\n\n"
            "Select your trade expiration time:",
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    async def _handle_main_menu(
        self, 
        query: CallbackQuery, 
        session: TradingSession
    ):
        """Handle main menu button."""
        session.state = BotState.SELECTING_EXPIRATION
        session.selected_expiration = None
        session.selected_asset = None
        
        keyboard = self._build_expiration_keyboard()
        
        await query.edit_message_text(
            "🏠 <b>Main Menu</b>\n\n"
            "Select your trade expiration time:",
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    async def _handle_expiration_select(
        self,
        query: CallbackQuery,
        session: TradingSession,
        data: str
    ):
        """Handle expiration selection and start analysis."""
        # Parse expiration
        exp_name = data.replace("exp_", "")
        expiration = None
        
        for exp in ExpirationType:
            if exp.name == exp_name:
                expiration = exp
                break
        
        if not expiration:
            return
        
        session.selected_expiration = expiration
        session.state = BotState.ANALYZING
        
        # Clear keyboard to prevent multi-click
        await query.edit_message_text(
            self.formatter.format_analysis_started(
                expiration=expiration.label,
                asset="All OTC Pairs"
            ),
            reply_markup=InlineKeyboardMarkup([[]]),  # Empty keyboard
            parse_mode='HTML'
        )
        
        # Trigger signal callback
        if self.on_signal_callback:
            asyncio.create_task(
                self.on_signal_callback(
                    session.chat_id,
                    expiration
                )
            )
    
    async def _handle_asset_select(
        self,
        query: CallbackQuery,
        session: TradingSession,
        data: str
    ):
        """Handle asset selection."""
        asset = data.replace("asset_", "")
        session.selected_asset = asset
        
        # Start analysis for specific asset
        await self._start_analysis(query, session)
    
    async def _handle_refresh(
        self,
        query: CallbackQuery,
        session: TradingSession
    ):
        """Handle refresh button."""
        # Just acknowledge
        await query.answer("Refreshing...")
    
    async def _start_analysis(
        self,
        query: CallbackQuery,
        session: TradingSession
    ):
        """Start market analysis for selected parameters."""
        session.state = BotState.ANALYZING
        
        await query.edit_message_text(
            self.formatter.format_analysis_started(
                expiration=session.selected_expiration.label if session.selected_expiration else "1m",
                asset=session.selected_asset or "All OTC Pairs"
            ),
            reply_markup=InlineKeyboardMarkup([[]]),
            parse_mode='HTML'
        )
    
    def _build_expiration_keyboard(self) -> InlineKeyboardMarkup:
        """Build the expiration selection keyboard."""
        keyboard = [
            # Row 1: Turbo options
            [
                InlineKeyboardButton(
                    "⚡ 5s",
                    callback_data=self.CALLBACK_EXPIRATION.format("S5")
                ),
                InlineKeyboardButton(
                    "⚡ 15s",
                    callback_data=self.CALLBACK_EXPIRATION.format("S15")
                ),
            ],
            # Row 2: Short term
            [
                InlineKeyboardButton(
                    "1️⃣ 1m",
                    callback_data=self.CALLBACK_EXPIRATION.format("M1")
                ),
                InlineKeyboardButton(
                    "2️⃣ 2m",
                    callback_data=self.CALLBACK_EXPIRATION.format("M2")
                ),
                InlineKeyboardButton(
                    "3️⃣ 3m",
                    callback_data=self.CALLBACK_EXPIRATION.format("M3")
                ),
            ],
            # Row 3: Medium term
            [
                InlineKeyboardButton(
                    "5️⃣ 5m",
                    callback_data=self.CALLBACK_EXPIRATION.format("M5")
                ),
                InlineKeyboardButton(
                    "1️⃣5️⃣ 15m",
                    callback_data=self.CALLBACK_EXPIRATION.format("M15")
                ),
                InlineKeyboardButton(
                    "3️⃣0️⃣ 30m",
                    callback_data=self.CALLBACK_EXPIRATION.format("M30")
                ),
            ],
            # Row 4: Navigation
            [
                InlineKeyboardButton(
                    "⬅️ Back",
                    callback_data=self.CALLBACK_BACK
                ),
                InlineKeyboardButton(
                    "📱 Main Menu",
                    callback_data=self.CALLBACK_MAIN_MENU
                ),
            ],
        ]
        
        return InlineKeyboardMarkup(keyboard)
    
    async def send_signal(
        self,
        chat_id: int,
        asset_id: str,
        direction: str,
        entry_price: float,
        confidence: int,
        time_remaining: int,
        expiration: str,
        reasons: list[str]
    ) -> Optional[Message]:
        """
        Send a trading signal to a user.
        Call this when a trading opportunity is found.
        """
        if not self._application:
            return None
        
        # Format and send signal
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("🔄 New Signal", callback_data=self.CALLBACK_REFRESH)],
            [InlineKeyboardButton("📱 Main Menu", callback_data=self.CALLBACK_MAIN_MENU)]
        ])
        
        try:
            message = await self._application.bot.send_message(
                chat_id=chat_id,
                text=self.formatter.format_signal(
                    asset_id=asset_id,
                    direction=direction,
                    entry_price=entry_price,
                    confidence=confidence,
                    time_remaining=time_remaining,
                    expiration=expiration,
                    reasons=reasons
                ),
                reply_markup=keyboard,
                parse_mode='HTML'
            )
            
            logger.info(f"Signal sent to {chat_id}: {direction} {asset_id}")
            return message
            
        except Exception as e:
            logger.error(f"Failed to send signal: {e}")
            return None
    
    async def send_error(self, chat_id: int, error: str) -> None:
        """Send an error message."""
        if not self._application:
            return
        
        try:
            keyboard = InlineKeyboardMarkup([
                [InlineKeyboardButton("📱 Main Menu", callback_data=self.CALLBACK_MAIN_MENU)]
            ])
            
            await self._application.bot.send_message(
                chat_id=chat_id,
                text=self.formatter.format_error(error),
                reply_markup=keyboard,
                parse_mode='HTML'
            )
        except Exception as e:
            logger.error(f"Failed to send error: {e}")
