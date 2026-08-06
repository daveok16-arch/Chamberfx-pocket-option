#!/usr/bin/env python3
"""
CHAMBERFX Trading Bot - Render Deployment Entry Point
===================================================
Production-ready bot for Render.com hosting.
"""

import asyncio
import logging
import os
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
_telegram_bot = None


async def health_handler(request):
    """Health check endpoint for Render.com."""
    return web.Response(text="OK", content_type="text/plain", status=200)


async def root_handler(request):
    """Root endpoint."""
    return web.Response(text="CHAMBERFX Trading Bot is running", content_type="text/plain", status=200)


async def telegram_webhook_handler(request):
    """Handle incoming Telegram webhook updates."""
    global _telegram_bot
    try:
        data = await request.json()
        msg = data.get('message', {})
        cb = data.get('callback_query', {})
        message_text = msg.get('text', 'N/A') if isinstance(msg, dict) else 'N/A'
        callback_data = cb.get('data', 'N/A') if isinstance(cb, dict) else 'N/A'
        logger.info(f"[WEBHOOK] Received: msg={message_text}, callback={callback_data}")
        
        # Wait for bot to be ready (with timeout)
        max_wait = 30  # seconds
        waited = 0
        while not (_telegram_bot and _telegram_bot.ready):
            await asyncio.sleep(0.1)
            waited += 0.1
            if waited > max_wait:
                logger.warning("[WEBHOOK] Telegram bot not ready after waiting")
                return web.Response(text="Bot not ready", status=503)
        
        # Bot is ready, process the update
        logger.info(f"[WEBHOOK] Feeding update to bot queue...")
        await _telegram_bot._application.update_queue.put(data)
        logger.info(f"[WEBHOOK] Update queued successfully")
        
        # Return update_id as per Telegram's webhook API requirements
        update_id = data.get('update_id', 0)
        return web.Response(text=str(update_id), status=200)
    except Exception as e:
        logger.error(f"[WEBHOOK] Telegram webhook error: {e}")
        return web.Response(text="Error", status=500)


async def start_trading_engine(app):
    """Start the trading engine in background."""
    global _engine, _telegram_bot
    from trading_engine import TradingEngine
    
    telegram_token = os.getenv("TELEGRAM_TOKEN")
    if not telegram_token:
        logger.error("TELEGRAM_TOKEN environment variable is required")
        return
    
    min_confidence = int(os.getenv("MIN_CONFIDENCE", "70"))
    tick_threshold = int(os.getenv("TICK_THRESHOLD", "175"))
    
    # Auto-detect webhook URL from Render's environment
    webhook_url = os.getenv("TELEGRAM_WEBHOOK_URL")
    if not webhook_url:
        # Try to auto-detect from Render environment
        render_url = os.getenv("RENDER_EXTERNAL_URL")
        if render_url:
            webhook_url = render_url.rstrip('/')
            logger.info(f"Auto-detected webhook URL: {webhook_url}")
        else:
            logger.warning("No TELEGRAM_WEBHOOK_URL set - Telegram will use polling (may conflict)")
    
    logger.info("=" * 60)
    logger.info("CHAMBERFX Trading Bot - Production Mode")
    logger.info("=" * 60)
    logger.info(f"Min Confidence: {min_confidence}")
    logger.info(f"Tick Threshold: {tick_threshold}")
    if webhook_url:
        logger.info(f"Telegram Webhook: {webhook_url}/telegram")
    
    _engine = TradingEngine(
        telegram_token=telegram_token,
        assets=[
            'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc',
            'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc',
            'NZDUSD_otc', 'EURGBP_otc',
            'BTCUSD_otc', 'ETHUSD_otc',
        ],
        tick_threshold=tick_threshold,
        min_confidence=min_confidence,
        webhook_url=webhook_url
    )
    
    # Store telegram bot reference BEFORE starting (for webhook handling)
    _telegram_bot = _engine.telegram
    
    # Start the engine in background
    asyncio.create_task(_engine.start())
    logger.info("Trading engine starting in background...")


async def stop_trading_engine(app):
    """Stop the trading engine on shutdown."""
    global _engine
    if _engine:
        logger.info("Stopping trading engine...")
        await _engine.stop()
        logger.info("Trading engine stopped")


async def main():
    """Main entry point with web server."""
    # Create aiohttp application
    app = web.Application()
    
    # Add routes
    app.router.add_get('/health', health_handler)
    app.router.add_get('/', root_handler)
    app.router.add_post('/telegram', telegram_webhook_handler)
    app.router.add_get('/telegram', lambda r: web.Response(text="Bot webhooks are live!", status=200))
    
    # Start/stop hooks
    app.on_startup.append(start_trading_engine)
    app.on_cleanup.append(stop_trading_engine)
    
    # Get port from environment (Render sets PORT)
    port = int(os.getenv("PORT", "10000"))
    
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    
    logger.info(f"=" * 50)
    logger.info(f"CHAMBERFX Bot Server started on port {port}")
    logger.info(f"Health check: http://0.0.0.0:{port}/health")
    logger.info(f"Telegram webhook: http://0.0.0.0:{port}/telegram")
    logger.info(f"=" * 50)
    
    # Keep running
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
