"""
Pocket Option WebSocket Client
==============================
Async WebSocket client for capturing live OTC prices.
Uses Engine.IO/Socket.IO protocol with binary data handling.
"""

import asyncio
import json
import logging
from typing import Optional, Callable, Dict, List
from dataclasses import dataclass
from datetime import datetime
from playwright.async_api import async_playwright, Browser, Page
import websockets
from websockets.client import WebSocketClientProtocol

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tick_volume_bars import Tick, TickVolumeBar
from micro_momentum import TVVReading, MicroMomentumEngine

logging.basicConfig(level=logging.INFO)
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
    """
    
    def __init__(
        self,
        assets: Optional[List[str]] = None,
        tick_threshold: int = 175
    ):
        self.assets = assets or [
            'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc',
            'XAUUSD_otc', 'AUDUSD_otc', 'USDCAD_otc'
        ]
        self.tick_threshold = tick_threshold
        
        # WebSocket state
        self._ws: Optional[WebSocketClientProtocol] = None
        self._browser: Optional[Browser] = None
        self._page: Optional[Page] = None
        
        # Session data
        self._ws_url: str = ""
        self._auth_packet: str = ""
        
        # Connection state
        self._connected = False
        self._running = False
        
        # Heartbeat
        self._heartbeat_task: Optional[asyncio.Task] = None
        
        # Callbacks
        self._on_tick: Optional[Callable[[PriceUpdate], None]] = None
        self._on_bar_complete: Optional[Callable[[str, TickVolumeBar], None]] = None
        self._on_tvv: Optional[Callable[[str, TVVReading], None]] = None
        
        # Price tracking
        self._last_prices: Dict[str, float] = {}
        
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
        Use Playwright to discover WebSocket URL and auth token.
        This replicates the successful approach from the TypeScript version.
        """
        logger.info("[DISCOVERY] Launching headless browser...")
        
        try:
            async with async_playwright() as p:
                self._browser = await p.chromium.launch(
                    headless=True,
                    args=['--no-sandbox', '--disable-setuid-sandbox']
                )
                
                context = await self._browser.new_context()
                self._page = await context.new_page()
                
                captured_url = None
                captured_auth = None
                
                async def on_websocket(ws: 'WebSocket'):
                    nonlocal captured_url, captured_auth
                    if 'socket.io' in ws.url and 'po.market' in ws.url:
                        captured_url = ws.url
                        
                        # Capture outgoing frames for auth packet
                        original_send = ws.send
                        async def capture_send(data):
                            nonlocal captured_auth
                            if isinstance(data, str) and 'auth' in data:
                                captured_auth = data
                            await original_send(data)
                        ws.send = capture_send
                
                self._page.on("websocket", on_websocket)
                
                try:
                    await self._page.goto(
                        'https://po.trade/en/cabinet/try-demo/',
                        wait_until='domcontentloaded',
                        timeout=30000
                    )
                    await asyncio.sleep(8)  # Wait for WebSocket connection
                except Exception as e:
                    logger.warning(f"Page navigation warning: {e}")
                
                if captured_url and captured_auth:
                    self._ws_url = captured_url
                    self._auth_packet = captured_auth
                    logger.info(f"[DISCOVERY] Found WebSocket URL: {self._ws_url[:50]}...")
                    logger.info("[DISCOVERY] Found auth packet")
                    return True
                else:
                    logger.error("[DISCOVERY] Failed to capture WebSocket data")
                    return False
                    
        except Exception as e:
            logger.error(f"[DISCOVERY] Error: {e}")
            return False
        finally:
            if self._browser:
                await self._browser.close()
    
    async def connect(self) -> bool:
        """
        Connect to Pocket Option WebSocket.
        Must call discover_session() first.
        """
        if not self._ws_url:
            if not await self.discover_session():
                return False
        
        try:
            logger.info(f"[WS] Connecting to {self._ws_url[:50]}...")
            
            self._ws = await websockets.connect(
                self._ws_url,
                extra_headers={},
                max_size=10 * 1024 * 1024  # 10MB max message
            )
            
            self._running = True
            self._connected = True
            
            # Start handlers
            asyncio.create_task(self._message_handler())
            self._heartbeat_task = asyncio.create_task(self._heartbeat())
            
            logger.info("[WS] Connected successfully")
            return True
            
        except Exception as e:
            logger.error(f"[WS] Connection failed: {e}")
            self._connected = False
            return False
    
    async def disconnect(self) -> None:
        """Disconnect from WebSocket."""
        self._running = False
        
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
        
        if self._ws:
            await self._ws.close()
        
        self._connected = False
        logger.info("[WS] Disconnected")
    
    async def subscribe_assets(self) -> None:
        """Subscribe to all configured assets."""
        if not self._ws or not self._connected:
            return
        
        logger.info(f"[WS] Subscribing to {len(self.assets)} assets...")
        
        for i, asset in enumerate(self.assets):
            msg = json.dumps([
                "changeSymbol",
                {"asset": asset, "period": 60}
            ])
            packet = f"42{msg}"
            
            await self._ws.send(packet)
            await asyncio.sleep(0.3)  # Stagger subscriptions
            
            logger.info(f"[WS] Subscribed to {asset}")
    
    async def _message_handler(self) -> None:
        """Handle incoming WebSocket messages."""
        pending_binary_event = None
        
        try:
            async for message in self._ws:
                if not self._running:
                    break
                
                # Handle binary messages
                if isinstance(message, bytes):
                    msg_str = message.decode('utf-8')
                elif isinstance(message, str):
                    msg_str = message
                else:
                    continue
                
                # Engine.IO heartbeat
                if msg_str == '2':
                    # Heartbeat - will be handled by heartbeat task
                    continue
                
                # Handshake response
                if msg_str.startswith('0{'):
                    logger.info("[WS] Received handshake")
                    await self._ws.send('40')
                    continue
                
                # Namespace acknowledgment
                if msg_str.startswith('40'):
                    logger.info("[WS] Namespace connected")
                    if self._auth_packet:
                        await self._ws.send(self._auth_packet)
                        await asyncio.sleep(2)
                        await self.subscribe_assets()
                    continue
                
                # Binary event indicator (45-["event",{...}])
                if msg_str.startswith('45-'):
                    try:
                        json_part = msg_str[msg_str.index('['):]
                        data = json.loads(json_part)
                        if isinstance(data, list) and len(data) > 1:
                            pending_binary_event = data[0]
                    except:
                        pending_binary_event = None
                    continue
                
                # Binary data follows indicator
                if pending_binary_event and not msg_str.startswith('42'):
                    event = pending_binary_event
                    pending_binary_event = None
                    
                    try:
                        await self._process_event(event, json.loads(msg_str))
                    except json.JSONDecodeError:
                        pass
                    continue
                
                # Standard event (42["event",{...}])
                if msg_str.startswith('42'):
                    try:
                        json_part = msg_str[2:]
                        data = json.loads(json_part)
                        if isinstance(data, list) and len(data) > 0:
                            event = data[0]
                            payload = data[1] if len(data) > 1 else None
                            await self._process_event(event, payload)
                    except json.JSONDecodeError:
                        pass
                    continue
                    
        except websockets.exceptions.ConnectionClosed:
            logger.warning("[WS] Connection closed")
        except Exception as e:
            logger.error(f"[WS] Handler error: {e}")
        finally:
            self._connected = False
    
    async def _process_event(self, event: str, data) -> None:
        """Process a Socket.IO event."""
        if event == 'updateStream':
            await self._handle_price_update(data)
        elif event == 'successauth':
            logger.info("[WS] Authentication successful")
    
    async def _handle_price_update(self, data) -> None:
        """Handle price update from stream."""
        if not isinstance(data, list):
            return
        
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
            
            # Filter to known assets
            if not any(a.replace('_otc', '') in asset_id.replace('_otc', '') for a in self.assets):
                continue
            
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
                await asyncio.sleep(25)  # Heartbeat every 25 seconds
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
