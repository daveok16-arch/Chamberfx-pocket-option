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

from telegram_bot import TelegramTradingBot, ExpirationType, OTC_PAYOUTS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main():
    """Run the standalone Telegram bot."""
    token = os.getenv("TELEGRAM_TOKEN", "")
    
    if not token:
        logger.error("TELEGRAM_TOKEN not set")
        return
    
    logger.info("Starting standalone Telegram bot...")
    
    # Create bot - pass None for trading_engine since we're testing keyboard only
    bot = TelegramTradingBot(token=token, trading_engine=None)
    
    # Start in polling mode (no webhook needed for testing)
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
