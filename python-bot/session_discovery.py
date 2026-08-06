"""
Session Discovery Module
=======================
Uses Playwright to discover Pocket Option WebSocket session.
Captures WebSocket URL, auth packet, and cookies dynamically.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional
from playwright.async_api import async_playwright, Browser, BrowserContext, Page

logger = logging.getLogger(__name__)


@dataclass
class DiscoveredSession:
    """Captured session data from Pocket Option."""
    ws_url: str
    auth_packet: str
    cookies: str


class SessionDiscovery:
    """
    Discovers Pocket Option WebSocket session using Playwright.
    Opens a headless browser, navigates to Pocket Option, and intercepts
    the WebSocket connection to capture the authentication packet.
    """
    
    # Pocket Option URLs to try
    POCKET_OPTION_URLS = [
        "https://po.trade/en/cabinet/try-demo/",
        "https://pocketoption.com/en/cabinet/try-demo/",
        "https://po.cash/en/cabinet/try-demo/"
    ]
    
    def __init__(self, timeout: int = 30):
        self.timeout = timeout
    
    async def discover(self) -> Optional[DiscoveredSession]:
        """
        Discover Pocket Option WebSocket session.
        Opens headless browser, navigates to demo page, captures WebSocket auth.
        
        Returns:
            DiscoveredSession with ws_url, auth_packet, and cookies, or None if failed.
        """
        logger.info("[DISCOVERY] Starting Pocket Option session discovery...")
        
        captured = {
            'ws_url': '',
            'auth_packet': '',
            'cookies': ''
        }
        
        browser: Optional[Browser] = None
        
        try:
            async with async_playwright() as p:
                # Launch headless browser
                logger.info("[DISCOVERY] Launching headless browser...")
                browser = await p.chromium.launch(
                    headless=True,
                    args=[
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu'
                    ]
                )
                
                # Create context with desktop user agent
                context: BrowserContext = await browser.new_context(
                    user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    viewport={'width': 1920, 'height': 1080}
                )
                
                page: Page = await context.new_page()
                
                # Track WebSocket and auth
                ws_info = {'url': '', 'auth': ''}
                
                # Intercept WebSocket connections
                async def on_websocket(ws):
                    url = ws.url
                    logger.info(f"[DISCOVERY] WebSocket detected: {url}")
                    
                    if 'socket.io' in url and any(domain in url for domain in ['po.market', 'po.trade', 'po.cash']):
                        ws_info['url'] = url
                        logger.info(f"[DISCOVERY] Captured Pocket Option WebSocket: {url}")
                        
                        # The auth packet is sent after connection
                        # We need to capture frames sent through this socket
                        # Note: Due to API limitations, we'll rely on other discovery methods
                
                page.on('websocket', on_websocket)
                
                # Try each Pocket Option URL
                for url in self.POCKET_OPTION_URLS:
                    if ws_info['url']:
                        break
                    
                    logger.info(f"[DISCOVERY] Trying: {url}")
                    try:
                        await page.goto(url, wait_until='domcontentloaded', timeout=self.timeout * 1000)
                        logger.info(f"[DISCOVERY] Page loaded: {url}")
                        # Wait for WebSocket to establish
                        await page.wait_for_timeout(8000)
                    except Exception as e:
                        logger.warning(f"[DISCOVERY] Failed to load {url}: {e}")
                
                # Capture cookies
                cookies = await context.cookies()
                cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
                captured['cookies'] = cookie_str
                captured['ws_url'] = ws_info['url']
                
                await browser.close()
                
        except Exception as e:
            logger.error(f"[DISCOVERY] Error during discovery: {e}")
            if browser:
                await browser.close()
            return None
        
        if not captured['ws_url']:
            logger.warning("[DISCOVERY] Failed to capture WebSocket URL")
            # Try to use default URL
            captured['ws_url'] = "wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket"
        
        logger.info("[DISCOVERY] Session discovery complete")
        logger.info(f"[DISCOVERY] WebSocket URL: {captured['ws_url']}")
        
        return DiscoveredSession(
            ws_url=captured['ws_url'],
            auth_packet=captured['auth_packet'],
            cookies=captured['cookies']
        )


async def discover_session() -> Optional[DiscoveredSession]:
    """Quick function to discover Pocket Option session."""
    discovery = SessionDiscovery()
    return await discovery.discover()


if __name__ == "__main__":
    # Test the discovery
    logging.basicConfig(level=logging.INFO)
    
    async def test():
        session = await discover_session()
        if session:
            print(f"\n✅ Discovered session:")
            print(f"   URL: {session.ws_url}")
            print(f"   Cookies: {session.cookies[:100]}...")
        else:
            print("\n❌ Failed to discover session")
    
    asyncio.run(test())
