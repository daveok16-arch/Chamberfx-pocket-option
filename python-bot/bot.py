#!/usr/bin/env python3
"""
CHAMBERFX Trading Bot - Render Deployment Entry Point
===================================================
Production-ready bot for Render.com hosting.
Includes health check endpoint for web service compatibility.
"""

import asyncio
import logging
import os
import signal
from aiohttp import web
from dotenv import load_dotenv

# Load .env if exists
load_dotenv()

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Global reference to trading engine
_engine = None


async def health_handler(request):
    """Health check endpoint for Render.com."""
    return web.Response(text="OK", status=200)


async def start_background_tasks(app):
    """Start the trading engine in background."""
    global _engine
    from trading_engine import TradingEngine
    
    telegram_token = os.getenv("TELEGRAM_TOKEN")
    if not telegram_token:
        logger.error("TELEGRAM_TOKEN environment variable is required")
        return
    
    min_confidence = int(os.getenv("MIN_CONFIDENCE", "70"))
    tick_threshold = int(os.getenv("TICK_THRESHOLD", "175"))
    
    logger.info("=" * 60)
    logger.info("CHAMBERFX Trading Bot - Production Mode")
    logger.info("=" * 60)
    
    _engine = TradingEngine(
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
    
    # Start the engine
    asyncio.create_task(_engine.start())


async def cleanup_background_tasks(app):
    """Stop the trading engine on shutdown."""
    global _engine
    if _engine:
        await _engine.stop()
        logger.info("Trading engine stopped")


async def main():
    """Main entry point with web server."""
    # Create aiohttp application
    app = web.Application()
    
    # Add routes
    app.router.add_get('/health', health_handler)
    
    # Start/stop hooks
    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(cleanup_background_tasks)
    
    # Get port from environment (Render sets PORT)
    port = int(os.getenv("PORT", "10000"))
    
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    
    logger.info(f"Health check server running on port {port}")
    logger.info(f"Visit http://0.0.0.0:{port}/health for status")
    
    # Keep running
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
