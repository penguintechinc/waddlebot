# Build from parent directory: docker build -f community_hub_module_flask/Dockerfile -t waddlebot/community-hub:latest .

FROM python:3.13-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy shared library first
COPY libs/flask_core /app/libs/flask_core

# Install shared library
RUN cd /app/libs/flask_core && pip install --no-cache-dir .

# Copy module requirements and install
COPY community_hub_module_flask/requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Copy module files
COPY community_hub_module_flask /app/

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Create non-root user
RUN useradd -m -u 1000 waddlebot && chown -R waddlebot:waddlebot /app /var/log/waddlebotlog

USER waddlebot

# Environment variables
ENV MODULE_NAME=community_hub_module
ENV MODULE_PORT=8060
ENV PYTHONUNBUFFERED=1

# Expose port
EXPOSE 8060

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8060/health || exit 1

# Run with Hypercorn
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8060", "--workers", "4"]
