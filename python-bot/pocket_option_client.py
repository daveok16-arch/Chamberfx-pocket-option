"""
Pocket Option WebSocket Client v2
===============================
Async WebSocket client for capturing live OTC prices.
Uses Playwright-based session discovery to capture auth packet.
"""

import asyncio
import json
import logging
from typing import Optional, Callable, Dict, List
from dataclasses import dataclass
from datetime import datetime
import websockets
from websockets.client import WebSocketClientProtocol

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tick_volume_bars import Tick, TickVolumeBar
from micro_momentum import TVVReading, MicroMomentumEngine

logger = logging.getLogger(__name__)


@dataclass
class PriceUpdate:
    """Single price update from Pocket Option."""
    asset_id: str
    price: float
    timestamp: float
    direction: str  # UP, DOWN, FLAT


class PocketOptionClient:
    """
    Async client for Pocket Option WebSocket API.
    Captures live OTC prices and manages tick data.
    Uses Playwright for session discovery.
    """
    
    # Default WebSocket URL
    DEFAULT_WS_URL = "wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket"
    
    def __init__(
        self,
        assets: Optional[List[str]] = None,
        tick_threshold: int = 175
    ):
        self.assets = assets or [
            'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc',
            'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc',
            'NZDUSD_otc', 'EURGBP_otc',
            'BTCUSD_otc', 'ETHUSD_otc'
        ]
        self.tick_threshold = tick_threshold
        
        # WebSocket state
        self._ws: Optional[WebSocketClientProtocol] = None
        
        # Session data
        self._ws_url: str = self.DEFAULT_WS_URL
        self._auth_packet: str = ""
        self._cookies: str = ""
        
        # Connection state
        self._connected = False
        self._authenticated = False
        self._running = False
        self._reconnect_attempts = 0
        self._max_reconnect_attempts = 10
        self._base_reconnect_delay = 5  # seconds
        self._max_reconnect_delay = 60  # seconds
        
        # Message handler task
        self._message_handler_task: Optional[asyncio.Task] = None
        
        # Heartbeat
        self._heartbeat_task: Optional[asyncio.Task] = None
        
        # Callbacks
        self._on_tick: Optional[Callable[[PriceUpdate], None]] = None
        self._on_bar_complete: Optional[Callable[[str, TickVolumeBar], None]] = None
        self._on_tvv: Optional[Callable[[str, TVVReading], None]] = None
        self._on_connection_status: Optional[Callable[[str, bool], None]] = None  # (status, is_connected)
        
        # Price tracking
        self._last_prices: Dict[str, float] = {}
        
        # Tick counter for debugging
        self._tick_count = 0
        self._last_tick_time: Optional[float] = None
        
        # Tick-volume bars
        self._bar_builders: Dict[str, 'TickVolumeBarBuilder'] = {}
        for asset in self.assets:
            from tick_volume_bars import TickVolumeBarBuilder
            self._bar_builders[asset] = TickVolumeBarBuilder(tick_threshold=tick_threshold)
        
        # Micro-momentum engines
        self._micro_engines: Dict[str, MicroMomentumEngine] = {}
        for asset in self.assets:
            self._micro_engines[asset] = MicroMomentumEngine()
    
    @property
    def connected(self) -> bool:
        return self._connected
    
    @property
    def authenticated(self) -> bool:
        return self._authenticated
    
    def set_connection_status_callback(self, callback: Callable[[str, bool], None]) -> None:
        """Set callback for connection status changes."""
        self._on_connection_status = callback
    
    async def _notify_connection_status(self, status: str, is_connected: bool) -> None:
        """Notify listeners of connection status changes."""
        if self._on_connection_status:
            try:
                self._on_connection_status(status, is_connected)
            except Exception as e:
                logger.error(f"[CONN] Status callback error: {e}")
    
    def _calculate_reconnect_delay(self) -> float:
        """Calculate exponential backoff delay."""
        delay = min(
            self._base_reconnect_delay * (2 ** self._reconnect_attempts),
            self._max_reconnect_delay
        )
        # Add jitter (±20%)
        import random
        jitter = delay * 0.2 * (random.random() * 2 - 1)
        return delay + jitter
    
    def set_tick_callback(
        self, 
        callback: Callable[[PriceUpdate], None]
    ) -> None:
        """Set callback for price updates."""
        self._on_tick = callback
    
    def set_bar_callback(
        self, 
        callback: Callable[[str, TickVolumeBar], None]
    ) -> None:
        """Set callback for completed bars."""
        self._on_bar_complete = callback
    
    def set_tvv_callback(
        self,
        callback: Callable[[str, TVVReading], None]
    ) -> None:
        """Set callback for TVV readings."""
        self._on_tvv = callback
    
    async def discover_session(self) -> bool:
        """
        Discover WebSocket session using Playwright.
        Opens headless browser, navigates to Pocket Option, captures auth packet.
        """
        logger.info("[DISCOVERY] Starting Playwright session discovery...")
        
        try:
            from playwright.async_api import async_playwright
            
            captured = {'ws_url': '', 'auth_packet': '', 'cookies': ''}
            
            async with async_playwright() as p:
                # Launch browser
                browser = await p.chromium.launch(
                    headless=True,
                    args=[
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                    ]
                )
                
                context = await browser.new_context(
                    user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                )
                
                page = await context.new_page()
                
                # Intercept console messages to find auth token
                auth_token = {'value': None}
                
                def on_console(msg):
                    text = msg.text
                    # Look for auth success message
                    if 'Success auth' in text or 'successauth' in text.lower():
                        logger.info(f"[DISCOVERY] Auth success detected in console!")
                        # Try to extract token from localStorage
                
                page.on('console', on_console)
                
                # Track WebSocket
                ws_info = {'url': '', 'ready': asyncio.Event()}
                
                def on_websocket(ws):
                    url = ws.url
                    if 'socket.io' in url and 'po.market' in url:
                        ws_info['url'] = url
                        logger.info(f"[DISCOVERY] Captured WebSocket: {url[:60]}...")
                
                page.on('websocket', on_websocket)
                
                # Navigate to Pocket Option
                urls_to_try = [
                    "https://po.trade/en/cabinet/try-demo/",
                    "https://pocketoption.com/en/cabinet/try-demo/",
                    "https://po.cash/en/cabinet/try-demo/"
                ]
                
                for url in urls_to_try:
                    if ws_info['url']:
                        break
                    logger.info(f"[DISCOVERY] Loading: {url}")
                    try:
                        await page.goto(url, wait_until='domcontentloaded', timeout=30000)
                        # Wait for WebSocket
                        try:
                            await asyncio.wait_for(ws_info['ready'].wait(), timeout=10)
                        except asyncio.TimeoutError:
                            pass
                    except Exception as e:
                        logger.warning(f"[DISCOVERY] Failed: {e}")
                
                # Wait for page to fully initialize
                await asyncio.sleep(10)
                
                # Try to extract token from page's JavaScript context
                token = await page.evaluate("""() => {
                    // Try to find token in various places
                    let token = null;
                    
                    // Check localStorage
                    for (let i = 0; i < localStorage.length; i++) {
                        let key = localStorage.key(i);
                        if (key && (key.includes('token') || key.includes('auth'))) {
                            let val = localStorage.getItem(key);
                            if (val && val.includes('token')) {
                                try {
                                    let parsed = JSON.parse(val);
                                    if (parsed.token) token = parsed.token;
                                } catch(e) {}
                            }
                        }
                    }
                    
                    // Check if window object has token
                    if (window.token) token = window.token;
                    if (window.authToken) token = window.authToken;
                    
                    return token;
                }""")
                
                if not token:
                    # Generate a fallback token (may work for demo)
                    import uuid
                    token = str(uuid.uuid4())[:10]
                    logger.info(f"[DISCOVERY] No token found, using generated: {token}")
                else:
                    logger.info(f"[DISCOVERY] Found token: {token}")
                
                # Get cookies
                cookies = await context.cookies()
                captured['cookies'] = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
                captured['ws_url'] = ws_info['url'] or self.DEFAULT_WS_URL
                
                await browser.close()
            
            # Set session data
            self._ws_url = captured['ws_url']
            self._cookies = captured['cookies']
            
            # Create auth packet with token
            self._auth_packet = f'42["auth",{{"token":"{token}","balance":50000,"isFastHistory":true}}]'
            
            logger.info(f"[DISCOVERY] URL: {self._ws_url[:60]}...")
            logger.info(f"[DISCOVERY] Auth: {self._auth_packet[:70]}...")
            logger.info(f"[DISCOVERY] Discovery complete")
            
            return True
            
        except ImportError:
            logger.warning("[DISCOVERY] Playwright not available")
            return self._fallback_discovery()
        except Exception as e:
            logger.error(f"[DISCOVERY] Error: {e}")
            return self._fallback_discovery()
    
    def _generate_auth_from_cookies(self) -> str:
        """Generate auth packet from cookies."""
        import uuid
        # Generate a token (for demo mode)
        token = str(uuid.uuid4())[:10]
        return f'42["auth",{{"token":"{token}","balance":50000,"isFastHistory":true}}]'
    
    def _fallback_discovery(self) -> bool:
        """Fallback when Playwright is not available."""
        logger.info("[DISCOVERY] Using fallback discovery (no browser)")
        self._ws_url = self.DEFAULT_WS_URL
        # Use the correct auth format with token
        import uuid
        token = str(uuid.uuid4())[:10]
        self._auth_packet = f'42["auth",{{"token":"{token}","balance":50000,"isFastHistory":true}}]'
        return True
    
    async def connect(self) -> bool:
        """
        Connect to Pocket Option WebSocket with automatic reconnection.
        Uses Playwright session discovery to get auth packet.
        """
        if not self._ws_url:
            await self.discover_session()
        
        self._running = True
        self._reconnect_attempts = 0
        
        while self._running:
            try:
                logger.info(f"[WS] Connecting to {self._ws_url[:60]}... (attempt {self._reconnect_attempts + 1})")
                
                # Build headers with cookies
                headers = {
                    "Origin": "https://po.trade",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
                
                # Connect
                self._ws = await websockets.connect(
                    self._ws_url,
                    extra_headers=headers,
                    max_size=20 * 1024 * 1024,
                    ping_interval=20,
                    ping_timeout=10
                )
                
                self._connected = True
                self._reconnect_attempts = 0  # Reset on successful connection
                logger.info("[WS] Connected, starting handlers...")
                
                # Start message handler (and keep reference to cancel it later)
                self._message_handler_task = asyncio.create_task(self._message_handler())
                
                # Start heartbeat
                self._heartbeat_task = asyncio.create_task(self._heartbeat())
                
                # Notify connected
                await self._notify_connection_status("connected", True)
                
                logger.info("[WS] Connection established, waiting for auth...")
                
                # Wait for auth (with timeout)
                auth_timeout = 15
                for i in range(auth_timeout):
                    await asyncio.sleep(1)
                    if self._authenticated:
                        logger.info("[WS] Authentication confirmed")
                        await self._notify_connection_status("authenticated", True)
                        break
                    if not self._running:
                        break
                
                # Wait for the connection to close
                while self._running and self._connected:
                    try:
                        # Sleep in small increments to check _running flag
                        await asyncio.sleep(1)
                    except asyncio.CancelledError:
                        break
                
            except websockets.exceptions.ConnectionClosed as e:
                logger.warning(f"[WS] Connection closed: {e.code} - {e.reason}")
                await self._notify_connection_status("disconnected", False)
            except asyncio.CancelledError:
                logger.info("[WS] Connection cancelled")
                break
            except Exception as e:
                logger.error(f"[WS] Connection error: {e}")
                await self._notify_connection_status("error", False)
            
            # Handle reconnection
            if self._running and self._reconnect_attempts < self._max_reconnect_attempts:
                self._reconnect_attempts += 1
                delay = self._calculate_reconnect_delay()
                logger.info(f"[WS] Reconnecting in {delay:.1f} seconds... (attempt {self._reconnect_attempts}/{self._max_reconnect_attempts})")
                
                # Wait before reconnecting
                for _ in range(int(delay)):
                    if not self._running:
                        break
                    await asyncio.sleep(1)
            elif self._running:
                logger.error(f"[WS] Max reconnection attempts ({self._max_reconnect_attempts}) reached, giving up")
                await self._notify_connection_status("failed", False)
                break
        
        self._connected = False
        self._authenticated = False
        return self._authenticated
    
    async def disconnect(self) -> None:
        """Disconnect from WebSocket."""
        logger.info("[WS] Disconnecting...")
        self._running = False
        self._connected = False
        self._authenticated = False
        
        # Cancel message handler task
        if self._message_handler_task:
            self._message_handler_task.cancel()
            try:
                await self._message_handler_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.debug(f"[WS] Message handler cancel error: {e}")
            self._message_handler_task = None
        
        # Cancel heartbeat task
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.debug(f"[WS] Heartbeat cancel error: {e}")
            self._heartbeat_task = None
        
        # Close WebSocket
        if self._ws:
            try:
                await self._ws.close()
            except Exception as e:
                logger.debug(f"[WS] WebSocket close error: {e}")
            self._ws = None
        
        await self._notify_connection_status("disconnected", False)
        logger.info("[WS] Disconnected")
    
    async def subscribe_assets(self) -> None:
        """Subscribe to all configured assets."""
        if not self._ws or not self._connected:
            logger.warning("[WS] Cannot subscribe - not connected")
            return
        
        logger.info(f"[WS] Subscribing to {len(self.assets)} assets...")
        
        for i, asset in enumerate(self.assets):
            msg = json.dumps([
                "changeSymbol",
                {"asset": asset, "period": 60}
            ])
            packet = f"42{msg}"
            
            await self._ws.send(packet)
            await asyncio.sleep(0.2)
            
            logger.info(f"[WS] Subscribed: {asset}")
    
    async def set_active_symbol(self, asset_id: str) -> None:
        """Change the active symbol being streamed."""
        if not self._ws or not self._connected:
            logger.warning("[WS] Cannot change symbol - not connected")
            return
        
        try:
            msg = json.dumps([
                "changeSymbol",
                {"asset": asset_id, "period": 60}
            ])
            packet = f"42{msg}"
            
            await self._ws.send(packet)
            logger.info(f"[WS] Symbol changed to: {asset_id}")
            
        except Exception as e:
            logger.error(f"[WS] Failed to change symbol: {e}")
    
    async def _message_handler(self) -> None:
        """Handle incoming WebSocket messages."""
        pending_binary_event = None
        auth_sent = False
        subscribed = False
        
        try:
            async for message in self._ws:
                if not self._running:
                    break
                
                try:
                    # Handle binary messages
                    if isinstance(message, bytes):
                        msg_str = message.decode('utf-8', errors='ignore')
                    elif isinstance(message, str):
                        msg_str = message
                    else:
                        continue
                    
                    # Skip empty or very long messages
                    if not msg_str or len(msg_str) > 50000:
                        continue
                    
                    # Engine.IO Heartbeat (2)
                    if msg_str == '2':
                        await self._ws.send('3')
                        continue
                    
                    # Pong (3)
                    if msg_str == '3':
                        continue
                    
                    # Engine.IO Handshake (0{...})
                    if msg_str.startswith('0{'):
                        logger.info("[WS] Engine.IO handshake received")
                        # Send Socket.IO namespace connect
                        await self._ws.send('40')
                        logger.info("[WS] Sent namespace connect")
                        continue
                    
                    # Socket.IO namespace connect response (40{...})
                    if msg_str.startswith('40{'):
                        logger.info("[WS] Namespace connected, authenticating...")
                        # Send auth packet
                        if self._auth_packet:
                            await self._ws.send(self._auth_packet)
                            logger.info("[WS] Sent auth packet")
                            auth_sent = True
                        continue
                    
                    # Auth success (43["successauth",...])
                    if 'successauth' in msg_str.lower():
                        logger.info("[WS] AUTHENTICATION SUCCESSFUL!")
                        self._authenticated = True
                        if not subscribed:
                            await asyncio.sleep(1)
                            await self.subscribe_assets()
                            subscribed = True
                        continue
                    
                    # Binary event indicator (45-["event",...])
                    if msg_str.startswith('45-'):
                        try:
                            json_part = msg_str[msg_str.index('['):]
                            data = json.loads(json_part)
                            if isinstance(data, list) and len(data) > 0:
                                pending_binary_event = data[0]
                        except (json.JSONDecodeError, ValueError):
                            pending_binary_event = None
                        continue
                    
                    # Binary data follows
                    if pending_binary_event and not msg_str.startswith('42'):
                        event = pending_binary_event
                        pending_binary_event = None
                        try:
                            await self._process_event(event, json.loads(msg_str))
                        except json.JSONDecodeError:
                            pass
                        continue
                    
                    # Standard event (42["event",...])
                    if msg_str.startswith('42'):
                        try:
                            json_part = msg_str[2:]
                            data = json.loads(json_part)
                            if isinstance(data, list) and len(data) > 0:
                                event = data[0]
                                payload = data[1] if len(data) > 1 else None
                                if event == 'updateStream':
                                    await self._handle_price_update(payload)
                                elif event == 'successauth':
                                    logger.info("[WS] Auth success confirmed (text)")
                                elif event:
                                    logger.info(f"[WS] Event: {event}")
                        except json.JSONDecodeError:
                            pass
                        continue
                    
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.debug(f"[WS] Message error: {e}")
                    continue
                    
        except websockets.exceptions.ConnectionClosed as e:
            logger.warning(f"[WS] Connection closed: {e.code}")
        except asyncio.CancelledError:
            logger.info("[WS] Message handler cancelled")
        except Exception as e:
            logger.error(f"[WS] Handler error: {e}")
        finally:
            self._connected = False
            self._authenticated = False
            logger.info("[WS] Message handler stopped")
    
    async def _process_event(self, event: str, data) -> None:
        """Process a Socket.IO event."""
        if event == 'updateStream':
            await self._handle_price_update(data)
        elif event == 'successauth':
            logger.info("[WS] Auth success confirmed")
    
    async def _handle_price_update(self, data) -> None:
        """Handle price update from stream."""
        if not isinstance(data, list):
            logger.warning(f"[WS] Price update data is not a list: {type(data)}, data={data}")
            return
        
        logger.info(f"[WS] Price update: {len(data)} items")
        
        for item in data:
            if not isinstance(item, list) or len(item) < 2:
                continue
            
            # Parse tick data
            asset_id = str(item[0]).replace('#', '')
            timestamp = float(item[1]) if len(item) > 1 else datetime.now().timestamp()
            price = float(item[2]) if len(item) > 2 else float(item[1])
            
            if len(item) == 2:
                price = float(item[1])
                timestamp = datetime.now().timestamp()
            
            # Normalize asset ID
            for known_asset in self.assets:
                if known_asset.replace('_otc', '').upper() in asset_id.replace('_otc', '').upper():
                    asset_id = known_asset
                    break
            
            # Calculate direction
            direction = 'FLAT'
            if asset_id in self._last_prices:
                if price > self._last_prices[asset_id]:
                    direction = 'UP'
                elif price < self._last_prices[asset_id]:
                    direction = 'DOWN'
            
            self._last_prices[asset_id] = price
            
            # Create price update
            update = PriceUpdate(
                asset_id=asset_id,
                price=price,
                timestamp=timestamp,
                direction=direction
            )
            
            # Track tick
            self._tick_count += 1
            self._last_tick_time = timestamp
            
            # Log first few ticks for debugging, then periodically
            if self._tick_count <= 10:
                logger.info(f"[TICK] #{self._tick_count} {asset_id}: {price:.5f} ({direction})")
            elif self._tick_count % 100 == 0:
                logger.info(f"[TICK] #{self._tick_count} {asset_id}: {price:.5f} ({direction})")
            
            # Fire tick callback
            if self._on_tick:
                try:
                    self._on_tick(update)
                except Exception as e:
                    logger.error(f"[TICK] Callback error: {e}")
            
            # Process tick-volume bar
            if asset_id in self._bar_builders:
                tick = Tick(
                    asset_id=asset_id,
                    price=price,
                    timestamp=timestamp,
                    direction=direction
                )
                
                completed_bar = self._bar_builders[asset_id].process_tick(tick)
                
                if completed_bar and self._on_bar_complete:
                    try:
                        self._on_bar_complete(asset_id, completed_bar)
                    except Exception as e:
                        logger.error(f"[BAR] Callback error: {e}")
            
            # Process micro-momentum
            if asset_id in self._micro_engines:
                tvv_reading = self._micro_engines[asset_id].process_tick(price, timestamp)
                
                if tvv_reading and self._on_tvv:
                    try:
                        self._on_tvv(asset_id, tvv_reading)
                    except Exception as e:
                        logger.error(f"[TVV] Callback error: {e}")
    
    async def _heartbeat(self) -> None:
        """Send Engine.IO heartbeats."""
        while self._running:
            try:
                await asyncio.sleep(25)
                if self._ws and self._connected:
                    await self._ws.send('2')
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[HEARTBEAT] Error: {e}")
    
    def get_current_bars(self, asset_id: str) -> List[TickVolumeBar]:
        """Get all bars for an asset."""
        if asset_id in self._bar_builders:
            return self._bar_builders[asset_id].all_bars
        return []
    
    def get_tvv_reading(self, asset_id: str) -> Optional[TVVReading]:
        """Get current TVV reading for an asset."""
        if asset_id in self._micro_engines:
            return self._micro_engines[asset_id].get_reading()
        return None
    
    def get_all_tvv_readings(self) -> Dict[str, TVVReading]:
        """Get TVV readings for all assets."""
        return {
            asset_id: engine.get_reading()
            for asset_id, engine in self._micro_engines.items()
            if engine.get_reading() is not None
        }
