FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Install minimal system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code from python-bot/
COPY python-bot/ ./python-bot/

# Set working directory to python-bot
WORKDIR /app/python-bot

# Create non-root user
RUN useradd -m botuser && chown -R botuser:botuser /app/python-bot
USER botuser

# Run the bot (background worker)
CMD ["python", "bot.py"]
