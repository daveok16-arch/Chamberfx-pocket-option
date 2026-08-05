"""
Quick test for Telegram inline keyboard
"""

import os
import asyncio
from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application

TELEGRAM_TOKEN = "8214823027:AAFecgXUdvfnI9uPhvDD7wmE26N9DWZmpzs"


def build_keyboard():
    keyboard = [
        # Row 1: Turbo options
        [
            InlineKeyboardButton("⚡ 5s", callback_data="exp_S5"),
            InlineKeyboardButton("⚡ 15s", callback_data="exp_S15"),
        ],
        # Row 2: Short term
        [
            InlineKeyboardButton("1️⃣ 1m", callback_data="exp_M1"),
            InlineKeyboardButton("2️⃣ 2m", callback_data="exp_M2"),
            InlineKeyboardButton("3️⃣ 3m", callback_data="exp_M3"),
        ],
        # Row 3: Medium term
        [
            InlineKeyboardButton("5️⃣ 5m", callback_data="exp_M5"),
            InlineKeyboardButton("1️⃣5️⃣ 15m", callback_data="exp_M15"),
            InlineKeyboardButton("3️⃣0️⃣ 30m", callback_data="exp_M30"),
        ],
        # Row 4: Navigation
        [
            InlineKeyboardButton("⬅️ Back", callback_data="back"),
            InlineKeyboardButton("📱 Main Menu", callback_data="main_menu"),
        ],
    ]
    return InlineKeyboardMarkup(keyboard)


async def main():
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    await app.initialize()
    
    # Send test message with keyboard
    message = await app.bot.send_message(
        chat_id=7779937295,
        text="🎯 <b>Test Inline Keyboard</b>\n\nSelect your trade expiration time:",
        reply_markup=build_keyboard(),
        parse_mode='HTML'
    )
    
    print(f"Message sent: {message.message_id}")
    
    await app.stop()


if __name__ == "__main__":
    asyncio.run(main())
