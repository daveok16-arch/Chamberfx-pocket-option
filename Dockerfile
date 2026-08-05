FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for Playwright
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browsers
RUN pip install playwright \
    && playwright install chromium \
    && playwright install-deps

# Copy application code from python-bot/
COPY python-bot/ ./python-bot/

# Set working directory to python-bot
WORKDIR /app/python-bot

# Create non-root user
RUN useradd -m botuser && chown -R botuser:botuser /app/python-bot
USER botuser

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:10000/health', timeout=2)" || exit 1

# Expose port
EXPOSE 10000

# Run the bot
CMD ["python", "bot.py"]
