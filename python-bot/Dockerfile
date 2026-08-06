FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for Playwright
# Note: Playwright install-deps handles its own dependencies
RUN apt-get update && apt-get install -y \
    --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright browsers
RUN pip install playwright \
    && playwright install chromium \
    && playwright install-deps

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Note: No setup.py needed - direct Python execution
# The bot.py is run directly via CMD

# Create non-root user
RUN useradd -m botuser && chown -R botuser:botuser /app
USER botuser

# Health check (uses urllib from stdlib - no requests package needed)
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:10000/health')" || exit 1

# Expose port (for web server if needed)
EXPOSE 10000

# Run the bot
CMD ["python", "bot.py"]
