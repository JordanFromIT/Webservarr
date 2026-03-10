# ==============================================================================
# WebServarr - Production Dockerfile
# ==============================================================================
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies (redis-server + supervisor for single-container deploy)
RUN apt-get update && apt-get install -y \
    curl \
    redis-server \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy supervisord config
COPY supervisord.conf /etc/supervisord.conf

# Copy application code
COPY app/ ./app/

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 7979

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:7979/health || exit 1

# Run both redis and uvicorn via supervisord
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
