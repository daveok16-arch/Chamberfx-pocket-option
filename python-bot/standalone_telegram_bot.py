"""
Standalone Telegram Bot
=======================
Simplified version that can be run independently
for testing the inline keyboard interface.
"""

import os
import asyncio
import logging
from typing import Optional

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes
)

from telegram_bot import TelegramTradingBot, ExpirationType

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main():
    """Run the standalone Telegram bot."""
    token = os.getenv("TELEGRAM_TOKEN", "")
    
    if not token:
        logger.error("TELEGRAM_TOKEN not set")
        return
    
    logger.info("Starting standalone Telegram bot...")
    
    # Create bot
    bot = TelegramTradingBot(token=token)
    
    # Set up demo signal callback
    async def demo_signal_callback(chat_id: int, expiration: ExpirationType):
        logger.info(f"Signal requested for {chat_id} with {expiration.label}")
        
        # Simulate analysis
        await asyncio.sleep(2)
        
        # Send demo signal
        await bot.send_signal(
            chat_id=chat_id,
            asset_id="EURUSD_otc",
            direction="CALL",
            entry_price=1.15178,
            confidence=85,
            time_remaining=45,
            expiration=expiration.label,
            reasons=[
                "EMA 9 > EMA 21 (bullish crossover)",
                "RSI oversold (28.5)",
                "Price near lower Bollinger band",
                "Strong momentum detected"
            ]
        )
    
    bot.on_signal_callback = demo_signal_callback
    
    # Start
    await bot.start()
    
    logger.info("Bot is running. Press Ctrl+C to stop.")
    
    # Keep running
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        logger.info("Shutting down...")
    finally:
        await bot.stop()


if __name__ == "__main__":
    asyncio.run(main())
