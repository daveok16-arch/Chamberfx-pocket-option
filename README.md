# ChamberFX Market Analyzer — Grok Integration Guide

ChamberFX is a premium institutional-grade quantitative trading and live market analytics platform. This system utilizes high-frequency price feeds and runs continuous market scanning loops on live over-the-counter (OTC) assets to identify high-probability trading signals (BUY, SELL, or NO TRADE).

## Core AI Integration: xAI Grok

To deliver ultra-reliable, institutional-grade market reasoning, this platform integrates the **xAI Grok API** (using the `grok-2` model suite) as its core reasoning engine. All old Gemini fallback models, services, and paths have been completely removed to guarantee strict and pristine Grok-native insights.

### Security Architecture
- **Server-Side Execution**: All AI reasoning, API completions, and indicator calculations occur exclusively on the backend container.
- **No Client Exposure**: The secret `GROK_API_KEY` is loaded directly into the server's environment memory. It is never exposed to the frontend browser context.
- **Zero-Fallback Strictness**: If the `GROK_API_KEY` is missing or invalid, the backend immediately raises a clear error and logs it rather than silently returning mock data or falling back to other models.

---

## Configuration

To run the application locally or in production, configure your environment variables in a `.env` file at the project root.

### Environment Setup

1. Copy the template from `.env.example`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` to include your official xAI API Key:
   ```env
   # .env
   GROK_API_KEY="your_grok_api_key_here"
   APP_URL="http://localhost:3000"
   PORT=3000
   DEBUG_WEBSOCKET=false
   ```

> ⚠️ **Important Security Warning**: Never commit your `.env` file to your Git repository. The `.gitignore` file is pre-configured to ignore all `.env` files.

---

## Structured Live Analytics Logging

The backend utilizes strict structured logging for every single analysis request sent to xAI Grok. This provides full observability and execution safety. Every log entry contains:
1. **Request Started**: Logs the exact asset and context.
2. **Asset being analyzed**: Displays the target currency pair or cryptocurrency.
3. **Request sent to Grok**: Confirms secure server-to-server dispatch.
4. **Response received**: Confirms receipt of the decision payload.
5. **Decision**: Formally logs the verdict (`BUY`, `SELL`, or `NO TRADE`) and confidence.
6. **Response time**: Displays execution latency in milliseconds.

### Example Log Output
```
[GROK SERVICE] Request started - Asset being analyzed: EUR/USD OTC (Market Analysis Route)
[GROK SERVICE] Request sent to Grok - Asset: EUR/USD OTC
[GROK SERVICE] Response received - Asset: EUR/USD OTC - Decision: CALL - Response time: 1450ms
```

In the event of an API error (such as a transient network glitch or rate-limit limit reached), the system logs the exact error details and safely continues scanning other assets without interrupting or crashing the continuous background scanner.
