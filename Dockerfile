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

# Version (set by CI from git tag, defaults to "dev")
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# Copy application code
COPY app/ ./app/

# Copy the entrypoint that fixes volume ownership before privileges are dropped
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Create data/upload dirs and an unprivileged user to run redis + uvicorn.
RUN mkdir -p /app/data /app/data/ticket_uploads /app/app/static/uploads \
    && groupadd -g 10001 appuser \
    && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 7979

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:7979/health || exit 1

# Entrypoint (root) fixes mounted-volume ownership, then supervisord runs both
# redis and uvicorn as the unprivileged appuser (see supervisord.conf).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
