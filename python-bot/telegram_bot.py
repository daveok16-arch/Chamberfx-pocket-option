"""
Telegram Interactive Trading Bot - OTC Stream Router
===================================================
Provides OTC Asset Selection Hub with inline keyboard interface
for real-time trading signal delivery.
"""

import asyncio
import logging
from typing import Optional, Dict, TYPE_CHECKING
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


# ============================================
# CONSTANTS
# ============================================

# Available OTC pairs with display name and typical payout
# Format: (asset_id, display_name, emoji)
OTC_PAIRS = [
    # Major Pairs (highest payout ~80-90%)
    ("EURUSD_otc", "EURUSD/OTC", "💰"),
    ("GBPUSD_otc", "GBPUSD/OTC", "💰"),
    ("USDJPY_otc", "USDJPY/OTC", "💰"),
    # Commodity & Minor (75-85%)
    ("XAUUSD_otc", "XAUUSD/OTC", "🥇"),  # Gold
    ("AUDUSD_otc", "AUDUSD/OTC", "🦘"),
    ("USDCAD_otc", "USDCAD/OTC", "🍁"),
    ("NZDUSD_otc", "NZDUSD/OTC", "🇳🇿"),
    ("EURGBP_otc", "EURGBP/OTC", "🇪🇺🇬🇧"),
    # Crypto (70-80%)
    ("BTCUSD_otc", "BTCUSD/OTC", "₿"),
    ("ETHUSD_otc", "ETHUSD/OTC", "Ξ"),
]

# Payout info for each pair (approximate OTC payouts)
OTC_PAYOUTS = {
    "EURUSD_otc": 88,
    "GBPUSD_otc": 85,
    "USDJPY_otc": 85,
    "XAUUSD_otc": 80,
    "AUDUSD_otc": 82,
    "USDCAD_otc": 80,
    "NZDUSD_otc": 78,
    "EURGBP_otc": 78,
    "BTCUSD_otc": 75,
    "ETHUSD_otc": 75,
}

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

# Strategy routing: seconds <= 15 -> TVV
TURBO_EXPIRATIONS = {"exp_5s", "exp_15s"}


# ============================================
# MENU STATES
# ============================================

class MenuState(Enum):
    """Bot menu states."""
    ASSET_SELECTION = "asset_selection"
    EXPIRATION_SELECTION = "expiration_selection"
    ANALYZING = "analyzing"


# ============================================
# USER CONTEXT
# ============================================

@dataclass
class UserContext:
    """Tracks a user's conversation state."""
    user_id: int
    chat_id: int
    state: MenuState = MenuState.ASSET_SELECTION
    active_asset: Optional[str] = None  # e.g., "EURUSD_otc"
    selected_expiration: Optional[str] = None
    selected_seconds: int = 60
    

# ============================================
# SIGNAL FORMATTER
# ============================================

class SignalFormatter:
    """Formats trading signals for Telegram display."""
    
    @staticmethod
    def format_otc_menu() -> tuple[str, InlineKeyboardMarkup]:
        """Format the OTC Asset Selection Hub menu with 10 pairs."""
        text = """📱 <b>CHAMBERFX OTC STREAM ROUTER</b>

Select an active OTC currency pair:
💰 Major Pairs (88-85% Payout)"""
        
        keyboard = []
        
        # Row 1: Major Pairs (top payout)
        keyboard.append([
            InlineKeyboardButton("💰 EURUSD (88%)", callback_data="setpair_EURUSD_otc"),
            InlineKeyboardButton("💰 GBPUSD (85%)", callback_data="setpair_GBPUSD_otc"),
        ])
        
        keyboard.append([
            InlineKeyboardButton("💰 USDJPY (85%)", callback_data="setpair_USDJPY_otc"),
            InlineKeyboardButton("🥇 XAUUSD (80%)", callback_data="setpair_XAUUSD_otc"),
        ])
        
        # Section 2: Minor Pairs
        text += "\n🦘 Minor Pairs (82-78% Payout)"
        
        keyboard.append([
            InlineKeyboardButton("🦘 AUDUSD (82%)", callback_data="setpair_AUDUSD_otc"),
            InlineKeyboardButton("🍁 USDCAD (80%)", callback_data="setpair_USDCAD_otc"),
        ])
        
        keyboard.append([
            InlineKeyboardButton("🇳🇿 NZDUSD (78%)", callback_data="setpair_NZDUSD_otc"),
            InlineKeyboardButton("🇪🇺🇬🇧 EURGBP (78%)", callback_data="setpair_EURGBP_otc"),
        ])
        
        # Section 3: Crypto
        text += "\n₿ Crypto Pairs (75% Payout)"
        
        keyboard.append([
            InlineKeyboardButton("₿ BTCUSD (75%)", callback_data="setpair_BTCUSD_otc"),
            InlineKeyboardButton("Ξ ETHUSD (75%)", callback_data="setpair_ETHUSD_otc"),
        ])
        
        return text, InlineKeyboardMarkup(keyboard)
    
    @staticmethod
    def format_expiration_menu(asset_display: str) -> tuple[str, InlineKeyboardMarkup]:
        """Format the Expiration Selection menu."""
        text = f"📊 <b>Target: {asset_display}</b>\n\nSelect trade expiration time:"
        
        keyboard = [
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
            # Row 4: Back button
            [
                InlineKeyboardButton("⬅️ Back to Pairs", callback_data="nav_asset"),
            ],
        ]
        
        return text, InlineKeyboardMarkup(keyboard)
    
    @staticmethod
    def format_analysis_started(expiration: str, asset: str) -> str:
        """Format the analysis-in-progress message."""
        return f"""
⏳ <b>Expiration targeted:</b> {expiration}

🔍 <i>The bot is looking for the most suitable moment to enter the deal.</i>

⚠️ <b>For correct operation, do not press any buttons.</b>

<i>Analysis will take from ~1 to ~3 seconds</i>
"""
    
    @staticmethod
    def format_signal(
        asset_id: str,
        direction: str,
        entry_price: float,
        confidence: int,
        time_remaining: int,
        expiration: str,
        reasons: list[str],
        strategy: str = "TICK_VOLUME",
        payout: int = 85
    ) -> str:
        """Format a new trading signal with payout info."""
        emoji = "📈" if direction == "CALL" else "📉"
        reasons_text = "\n".join([f"   • {r}" for r in reasons])
        quality = "EXCELLENT" if time_remaining >= 50 else "GOOD" if time_remaining >= 40 else "FAIR"
        
        # Calculate potential profit ($10 stake)
        profit = round(10 * payout / 100, 2)
        
        return f"""
{emoji} <b>NEW SIGNAL</b> {emoji}

🏷️ <b>Asset:</b> {asset_id.replace('_otc', '/OTC')}
📊 <b>Direction:</b> <code>{direction}</code>
💰 <b>Entry:</b> {entry_price:.5f}
💵 <b>Payout:</b> {payout}%

⏱️ <b>Expiration:</b> {expiration}
⏰ <b>Time Left:</b> {time_remaining}s
🎯 <b>Confidence:</b> {confidence}%
📍 <b>Entry Quality:</b> {quality}
🔧 <b>Strategy:</b> {strategy}

📝 <b>Analysis:</b>
{reasons_text}

💎 <b>Potential Profit:</b> ${profit} (on $10 stake)

⏰ <b>Time:</b> {datetime.now().strftime('%H:%M:%S')}
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


# ============================================
# TELEGRAM TRADING BOT
# ============================================

class TelegramTradingBot:
    """
    Interactive Telegram bot with OTC Asset Selection Hub.
    Fully integrated with TradingEngine for live signal generation.
    """
    
    def __init__(self, token: str, trading_engine: Optional['TradingEngine'] = None):
        self.token = token
        self.trading_engine = trading_engine
        
        # User contexts
        self._contexts: Dict[int, UserContext] = {}
        self._analysis_tasks: Dict[int, asyncio.Task] = {}
        
        # Telegram app
        self._application: Optional[Application] = None
        self._connected = False
        
        # Formatter
        self.formatter = SignalFormatter()
    
    @property
    def connected(self) -> bool:
        return self._connected
    
    async def start(self, webhook_url: Optional[str] = None) -> None:
        """Initialize and start the bot with webhook or polling."""
        self._application = Application.builder().token(self.token).build()
        
        # Register handlers
        self._application.add_handler(CommandHandler("start", self.cmd_start))
        self._application.add_handler(CommandHandler("help", self.cmd_help))
        self._application.add_handler(CommandHandler("status", self.cmd_status))
        
        # Callback query handler - catches ALL button presses
        self._application.add_handler(
            CallbackQueryHandler(self.handle_callback)
        )
        
        # Initialize app
        await self._application.initialize()
        
        # Use webhook if URL provided
        if webhook_url:
            await self._application.bot.set_webhook(f"{webhook_url}/telegram", drop_pending_updates=True)
            logger.info(f"Telegram bot using webhook: {webhook_url}/telegram")
        else:
            # Use polling - PTB 20.x style
            await self._application.start()
            await self._application.updater.start_polling(
                drop_pending_updates=True,
                errors_callback=self._handle_polling_error
            )
        
        self._connected = True
        logger.info("Telegram bot started successfully")
    
    def _handle_polling_error(self, error: Exception) -> None:
        """Handle polling errors gracefully."""
        logger.warning(f"Polling error: {error}")
        if "Conflict" in str(error):
            logger.warning("Telegram conflict detected - another instance may be running")
    
    async def stop(self) -> None:
        """Stop the bot."""
        for task in self._analysis_tasks.values():
            task.cancel()
        
        if self._application:
            try:
                await self._application.updater.stop()
            except Exception:
                pass
            await self._application.stop()
        self._connected = False
        logger.info("Telegram bot stopped")
    
    def get_context(self, user_id: int) -> UserContext:
        """Get or create a user context."""
        if user_id not in self._contexts:
            self._contexts[user_id] = UserContext(user_id=user_id, chat_id=0)
        return self._contexts[user_id]
    
    def _get_asset_display(self, asset_id: str) -> str:
        """Get display name with payout for an asset."""
        payout = OTC_PAYOUTS.get(asset_id, 85)
        for aid, display, emoji in OTC_PAIRS:
            if aid == asset_id:
                return f"{display} ({payout}%)"
        return f"{asset_id.replace('_otc', '/OTC')} ({payout}%)"
    
    # ============================================
    # COMMAND HANDLERS
    # ============================================
    
    async def cmd_start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /start - show OTC Asset Selection Hub."""
        ctx = self.get_context(update.effective_user.id)
        ctx.chat_id = update.effective_chat.id
        ctx.state = MenuState.ASSET_SELECTION
        
        text, keyboard = self.formatter.format_otc_menu()
        await update.message.reply_text(text, reply_markup=keyboard, parse_mode='HTML')
    
    async def cmd_help(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /help command."""
        help_text = """
<b>📚 CHAMBERFX Trading Bot Help</b>

<b>How to Trade:</b>
1. Send /start to open the OTC router
2. Select your OTC pair (EURUSD, AUDUSD, etc.)
3. Choose expiration (5s to 30m)
4. Bot analyzes and sends signals automatically

<b>Turbo Trading (5s/15s):</b>
• Uses TVV (Tick Variance Velocity)
• Analyzes raw tick momentum
• Ultra-fast execution

<b>Standard Trading (1m+):</b>
• Uses Tick-Volume Bars
• Technical indicators (EMA, RSI, MACD)
• More time to react

<b>Signal Types:</b>
📈 <b>CALL</b> - Price will rise
📉 <b>PUT</b> - Price will fall
"""
        await update.message.reply_text(help_text, parse_mode='HTML')
    
    async def cmd_status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /status command."""
        connected = self._connected and self.trading_engine is not None
        po_connected = self.trading_engine.connected if self.trading_engine else False
        
        text = f"""
<b>🤖 CHAMBERFX Status</b>

📡 <b>Telegram:</b> {"🟢 Online" if connected else "🔴 Offline"}
📊 <b>Pocket Option:</b> {"🟢 Connected" if po_connected else "🔴 Disconnected"}
👥 <b>Active Users:</b> {len(self._contexts)}

<b>Commands:</b>
/start - Open OTC Router
/help - Help info
/status - This status
"""
        await update.message.reply_text(text, parse_mode='HTML')
    
    # ============================================
    # MAIN CALLBACK HANDLER
    # ============================================
    
    async def handle_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        Handle ALL inline button callbacks.
        Routes based on callback_data prefix.
        """
        query = update.callback_query
        if not query:
            return
        
        user_id = update.effective_user.id
        ctx = self.get_context(user_id)
        ctx.chat_id = query.message.chat_id
        data = query.data or ""
        
        logger.info(f"[TG] Callback from {user_id}: {data}")
        
        try:
            # Step A: Stop loading spinner immediately
            await query.answer()
            
            # Route based on callback prefix
            if data.startswith("setpair_"):
                await self._handle_set_pair(query, ctx, data)
            
            elif data.startswith("exp_"):
                await self._handle_expiration_select(query, ctx, data)
            
            elif data == "nav_asset":
                await self._handle_nav_asset(query, ctx)
            
            elif data == "refresh":
                await self._handle_refresh(query, ctx)
            
            elif data == "back":
                await self._handle_back(query, ctx)
            
        except Exception as e:
            logger.error(f"[TG] Callback error: {e}")
            try:
                await query.message.reply_text(
                    self.formatter.format_error(str(e)),
                    parse_mode='HTML'
                )
            except:
                pass
    
    # ============================================
    # ASSET SELECTION HANDLERS
    # ============================================
    
    async def _handle_set_pair(
        self, 
        query: 'CallbackQuery', 
        ctx: UserContext,
        data: str
    ):
        """
        Handle OTC pair selection.
        1. Extract asset ID
        2. Update WebSocket subscription
        3. Cache in user context
        4. Auto-advance to expiration menu
        """
        # Step 1: Extract asset
        asset_id = data.replace("setpair_", "")
        
        # Validate asset
        valid_assets = [pair[0] for pair in OTC_PAIRS]
        if asset_id not in valid_assets:
            logger.error(f"[TG] Invalid asset: {asset_id}")
            return
        
        # Step 2: Update WebSocket subscription
        if self.trading_engine and self.trading_engine.connected:
            # Change symbol subscription
            await self._change_symbol(asset_id)
        
        # Step 3: Cache asset in context
        ctx.active_asset = asset_id
        ctx.state = MenuState.EXPIRATION_SELECTION
        
        # Get display name with payout
        asset_display = self._get_asset_display(asset_id)
        
        # Step 4: Auto-advance to expiration menu
        text, keyboard = self.formatter.format_expiration_menu(asset_display)
        await query.message.edit_message_text(
            text=text,
            reply_markup=keyboard,
            parse_mode='HTML'
        )
        
        logger.info(f"[TG] Asset selected: {asset_id} -> Expiration menu")
    
    async def _change_symbol(self, asset_id: str):
        """Change WebSocket symbol subscription."""
        try:
            if self.trading_engine and self.trading_engine.po_client:
                await self.trading_engine.po_client.change_symbol(asset_id)
                logger.info(f"[TG] WebSocket symbol changed to: {asset_id}")
        except Exception as e:
            logger.error(f"[TG] Failed to change symbol: {e}")
    
    async def _handle_nav_asset(self, query: 'CallbackQuery', ctx: UserContext):
        """Navigate back to asset selection hub."""
        # Cancel any running analysis
        if ctx.user_id in self._analysis_tasks:
            self._analysis_tasks[ctx.user_id].cancel()
            del self._analysis_tasks[ctx.user_id]
        
        ctx.state = MenuState.ASSET_SELECTION
        ctx.selected_expiration = None
        
        text, keyboard = self.formatter.format_otc_menu()
        await query.message.edit_message_text(
            text=text,
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    # ============================================
    # EXPIRATION HANDLERS
    # ============================================
    
    async def _handle_expiration_select(
        self,
        query: 'CallbackQuery',
        ctx: UserContext,
        data: str
    ):
        """Handle expiration selection and start analysis."""
        # Parse expiration
        if data not in EXPIRATION_MAP:
            logger.error(f"[TG] Unknown expiration: {data}")
            return
        
        expiration_label, expiration_seconds = EXPIRATION_MAP[data]
        ctx.selected_expiration = expiration_label
        ctx.selected_seconds = expiration_seconds
        ctx.state = MenuState.ANALYZING
        
        # Get asset display name
        asset_display = next(
            (display for aid, display in OTC_PAIRS if aid == ctx.active_asset),
            ctx.active_asset or "Unknown"
        )
        
        # Show analysis message (buttons cleared)
        await query.message.edit_message_text(
            text=self.formatter.format_analysis_started(expiration_label, asset_display),
            parse_mode='HTML'
        )
        
        # Cancel existing analysis task
        if ctx.user_id in self._analysis_tasks:
            self._analysis_tasks[ctx.user_id].cancel()
        
        # Determine if turbo
        is_turbo = data in TURBO_EXPIRATIONS
        
        # Start new analysis task
        task = asyncio.create_task(
            self._run_analysis(
                chat_id=ctx.chat_id,
                user_id=ctx.user_id,
                asset_id=ctx.active_asset,
                expiration=expiration_label,
                seconds=expiration_seconds,
                is_turbo=is_turbo
            )
        )
        self._analysis_tasks[ctx.user_id] = task
    
    async def _handle_refresh(self, query: 'CallbackQuery', ctx: UserContext):
        """Handle refresh - restart with same settings."""
        if ctx.active_asset:
            ctx.state = MenuState.EXPIRATION_SELECTION
            asset_display = self._get_asset_display(ctx.active_asset)
            text, keyboard = self.formatter.format_expiration_menu(asset_display)
            await query.message.edit_message_text(
                text=text,
                reply_markup=keyboard,
                parse_mode='HTML'
            )
        else:
            await self._handle_nav_asset(query, ctx)
    
    async def _handle_back(self, query: 'CallbackQuery', ctx: UserContext):
        """Handle back button - return to expiration or asset menu."""
        if ctx.active_asset and ctx.state == MenuState.ANALYZING:
            if ctx.user_id in self._analysis_tasks:
                self._analysis_tasks[ctx.user_id].cancel()
                del self._analysis_tasks[ctx.user_id]
            
            ctx.state = MenuState.EXPIRATION_SELECTION
            asset_display = self._get_asset_display(ctx.active_asset)
            text, keyboard = self.formatter.format_expiration_menu(asset_display)
            await query.message.edit_message_text(
                text=text,
                reply_markup=keyboard,
                parse_mode='HTML'
            )
        else:
            await self._handle_nav_asset(query, ctx)
    
    # ============================================
    # ANALYSIS ENGINE
    # ============================================
    
    async def _run_analysis(
        self,
        chat_id: int,
        user_id: int,
        asset_id: str,
        expiration: str,
        seconds: int,
        is_turbo: bool
    ):
        """Run market analysis for 1-3 seconds."""
        strategy = "TVV" if is_turbo else "TICK_VOLUME"
        logger.info(f"[ANALYSIS] {strategy} for {asset_id} @ {expiration}")
        
        # Analysis duration based on expiration
        if seconds <= 15:
            duration = 1.0
        elif seconds <= 60:
            duration = 2.0
        else:
            duration = 3.0
        
        deadline = asyncio.get_event_loop().time() + duration
        
        try:
            while asyncio.get_event_loop().time() < deadline:
                # Check if cancelled
                if user_id not in self._analysis_tasks:
                    logger.info(f"[ANALYSIS] Cancelled for {user_id}")
                    return
                
                # Check conditions
                signal = await self._check_conditions(asset_id, is_turbo)
                
                if signal:
                    logger.info(f"[ANALYSIS] Signal: {signal['direction']} {signal['asset_id']}")
                    await self._send_signal(chat_id, signal, expiration, strategy)
                    return
                
                await asyncio.sleep(0.1)
            
            # No signal found
            logger.info(f"[ANALYSIS] No signal for {expiration}")
            await self._send_no_signal(chat_id, expiration)
            
        except asyncio.CancelledError:
            logger.info(f"[ANALYSIS] Cancelled: {user_id}")
        except Exception as e:
            logger.error(f"[ANALYSIS] Error: {e}")
            await self._send_error(chat_id, str(e))
        finally:
            if user_id in self._analysis_tasks:
                del self._analysis_tasks[user_id]
    
    async def _check_conditions(self, asset_id: str, is_turbo: bool) -> Optional[Dict]:
        """Check trading conditions for specific asset."""
        if not self.trading_engine or not self.trading_engine.connected:
            return None
        
        engine = self.trading_engine
        time_remaining = engine.get_time_remaining()
        
        if is_turbo:
            # TVV analysis for specific asset
            tvv = engine.get_single_tvv_reading(asset_id)
            if tvv and tvv.signal != "WAIT" and tvv.confidence >= engine.min_confidence:
                price = engine.get_current_price(asset_id)
                if price:
                    return {
                        "asset_id": asset_id,
                        "direction": tvv.signal,
                        "entry_price": price,
                        "confidence": tvv.confidence,
                        "time_remaining": time_remaining,
                        "reasons": [
                            f"TVV Score: {tvv.momentum_score}",
                            f"Tick Bias: {tvv.tick_direction_bias:.2f}",
                            f"Volatility: {tvv.volatility_index:.2f}",
                        ],
                        "strategy": "TVV (Micro-Momentum)"
                    }
        else:
            # Tick-Volume analysis for specific asset
            result = engine.get_single_indicator_result(asset_id)
            if result and result.signal != "WAIT" and result.signal_strength >= engine.min_confidence:
                price = engine.get_current_price(asset_id)
                if price:
                    return {
                        "asset_id": asset_id,
                        "direction": result.signal,
                        "entry_price": price,
                        "confidence": result.signal_strength,
                        "time_remaining": time_remaining,
                        "reasons": result.reasons,
                        "strategy": "Tick-Volume Bars"
                    }
        
        return None
    
    # ============================================
    # MESSAGE SENDERS
    # ============================================
    
    async def _send_signal(self, chat_id: int, signal: Dict, expiration: str, strategy: str):
        """Send trading signal."""
        if not self._application:
            return
        
        # Get payout for this asset
        payout = OTC_PAYOUTS.get(signal['asset_id'], 85)
        
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("🔄 New Signal", callback_data="refresh")],
            [InlineKeyboardButton("⬅️ Back to Pairs", callback_data="nav_asset")],
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
                strategy=signal.get('strategy', strategy),
                payout=payout
            ),
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    async def _send_no_signal(self, chat_id: int, expiration: str):
        """Send no-signal message with back to pairs."""
        if not self._application:
            return
        
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("🔄 Try Again", callback_data="refresh")],
            [InlineKeyboardButton("⬅️ Back to Pairs", callback_data="nav_asset")],
        ])
        
        text = self.formatter.format_no_signal(expiration)
        await self._application.bot.send_message(
            chat_id=chat_id,
            text=text,
            reply_markup=keyboard,
            parse_mode='HTML'
        )
    
    async def _send_error(self, chat_id: int, error: str):
        """Send error message."""
        if not self._application:
            return
        
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("⬅️ Back to Pairs", callback_data="nav_asset")],
        ])
        
        text = self.formatter.format_error(error)
        await self._application.bot.send_message(
            chat_id=chat_id,
            text=text,
            reply_markup=keyboard,
            parse_mode='HTML'
        )
