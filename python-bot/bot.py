#!/usr/bin/env python3
"""
CHAMBERFX Trading Bot - Render Deployment Entry Point
===================================================
Production-ready bot for Render.com hosting.
"""

import asyncio
import logging
import os
import signal
from dotenv import load_dotenv

# Load .env if exists
load_dotenv()

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)


async def main():
    """Main entry point for the trading bot."""
    from trading_engine import TradingEngine
    
    # Get configuration from environment
    telegram_token = os.getenv("TELEGRAM_TOKEN")
    
    if not telegram_token:
        logger.error("TELEGRAM_TOKEN environment variable is required")
        logger.error("Please set TELEGRAM_TOKEN in your Render environment variables")
        return
    
    min_confidence = int(os.getenv("MIN_CONFIDENCE", "70"))
    tick_threshold = int(os.getenv("TICK_THRESHOLD", "175"))
    
    logger.info("=" * 60)
    logger.info("CHAMBERFX Trading Bot - Production Mode")
    logger.info("=" * 60)
    logger.info(f"Min Confidence: {min_confidence}")
    logger.info(f"Tick Threshold: {tick_threshold}")
    
    # Initialize engine
    engine = TradingEngine(
        telegram_token=telegram_token,
        assets=[
            'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc',
            'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc',
            'NZDUSD_otc', 'EURGBP_otc',
            'BTCUSD_otc', 'ETHUSD_otc',
        ],
        tick_threshold=tick_threshold,
        min_confidence=min_confidence
    )
    
    # Setup graceful shutdown
    loop = asyncio.get_event_loop()
    
    def shutdown_handler():
        logger.info("Shutdown signal received...")
        asyncio.create_task(engine.stop())
    
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown_handler)
    
    try:
        await engine.start()
        
        # Keep running
        while True:
            await asyncio.sleep(1)
            
    except Exception as e:
        logger.error(f"Main loop error: {e}")
    finally:
        await engine.stop()
        logger.info("Bot shutdown complete")


if __name__ == "__main__":
    asyncio.run(main())
