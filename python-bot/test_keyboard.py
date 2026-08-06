"""
Quick test for Telegram inline keyboard

NOTE: Callback data format must match telegram_bot.py EXACTLY:
- exp_5s, exp_15s (Turbo)
- exp_1m, exp_2m, exp_3m (Short term)
- exp_5m, exp_15m, exp_30m (Medium term)
- nav_asset, back, main_menu (Navigation)

Usage:
    1. Set TELEGRAM_TOKEN in .env
    2. Start the bot first with: python standalone_telegram_bot.py
    3. Send /start to your bot from Telegram
    4. The inline keyboard will appear
"""

import os
import asyncio
from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
if not TELEGRAM_TOKEN:
    raise ValueError("TELEGRAM_TOKEN environment variable is required")

# CHAT_ID is optional for keyboard testing
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")


def build_otc_menu_keyboard():
    """Build the OTC Asset Selection Hub keyboard."""
    keyboard = [
        # Row 1: Major Pairs
        [
            InlineKeyboardButton("💰 EURUSD (88%)", callback_data="setpair_EURUSD_otc"),
            InlineKeyboardButton("💰 GBPUSD (85%)", callback_data="setpair_GBPUSD_otc"),
        ],
        [
            InlineKeyboardButton("💰 USDJPY (85%)", callback_data="setpair_USDJPY_otc"),
            InlineKeyboardButton("🥇 XAUUSD (80%)", callback_data="setpair_XAUUSD_otc"),
        ],
        # Row 2: Minor Pairs
        [
            InlineKeyboardButton("🦘 AUDUSD (82%)", callback_data="setpair_AUDUSD_otc"),
            InlineKeyboardButton("🍁 USDCAD (80%)", callback_data="setpair_USDCAD_otc"),
        ],
        [
            InlineKeyboardButton("🇳🇿 NZDUSD (78%)", callback_data="setpair_NZDUSD_otc"),
            InlineKeyboardButton("🇪🇺🇬🇧 EURGBP (78%)", callback_data="setpair_EURGBP_otc"),
        ],
        # Row 3: Crypto
        [
            InlineKeyboardButton("₿ BTCUSD (75%)", callback_data="setpair_BTCUSD_otc"),
            InlineKeyboardButton("Ξ ETHUSD (75%)", callback_data="setpair_ETHUSD_otc"),
        ],
    ]
    return InlineKeyboardMarkup(keyboard)


def build_expiration_keyboard(asset_display: str = "EURUSD/OTC"):
    """Build the expiration selection keyboard."""
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
        # Row 4: Navigation
        [
            InlineKeyboardButton("⬅️ Back to Pairs", callback_data="nav_asset"),
        ],
    ]
    return InlineKeyboardMarkup(keyboard)


async def main():
    """Send test messages with inline keyboards to your chat."""
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    await app.initialize()
    
    if TELEGRAM_CHAT_ID:
        # Send to specific chat
        chat_id = int(TELEGRAM_CHAT_ID)
        
        # Send OTC menu keyboard
        message1 = await app.bot.send_message(
            chat_id=chat_id,
            text="📱 <b>CHAMBERFX OTC STREAM ROUTER</b>\n\nSelect an active OTC currency pair:",
            reply_markup=build_otc_menu_keyboard(),
            parse_mode='HTML'
        )
        print(f"OTC Menu sent: {message1.message_id}")
        
        # Send expiration keyboard
        message2 = await app.bot.send_message(
            chat_id=chat_id,
            text="📊 <b>Target: EURUSD/OTC (88%)</b>\n\nSelect trade expiration time:",
            reply_markup=build_expiration_keyboard(),
            parse_mode='HTML'
        )
        print(f"Expiration Menu sent: {message2.message_id}")
        
        print(f"\nTest messages sent to chat ID: {chat_id}")
    else:
        print("TELEGRAM_CHAT_ID not set - testing keyboard structure only")
        print("\nOTC Menu Keyboard:")
        print(build_otc_menu_keyboard().to_json())
        print("\nExpiration Keyboard:")
        print(build_expiration_keyboard().to_json())
    
    await app.stop()


if __name__ == "__main__":
    asyncio.run(main())
