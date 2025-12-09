# Build from parent directory: docker build -f twitch_module_flask/Dockerfile -t waddlebot/twitch:latest .

FROM python:3.13-slim

WORKDIR /app

# Copy shared library
COPY libs/flask_core /app/libs/flask_core

# Install shared library
RUN cd /app/libs/flask_core && pip install --no-cache-dir .

# Copy module files
COPY twitch_module_flask/requirements.txt /app/
COPY twitch_module_flask /app/

# Install module dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Expose port
EXPOSE 8002
# Copy standard healthcheck script
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py
RUN chmod 755 /usr/local/bin/healthcheck.py


# Run with Hypercorn
# Health check (using /healthz for Kubernetes compatibility)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python3 /usr/local/bin/healthcheck.py http://localhost:8002/healthz

CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8002", "--workers", "4"]
