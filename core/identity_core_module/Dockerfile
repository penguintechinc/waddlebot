# Build from parent directory: docker build -f identity_core_module_flask/Dockerfile -t waddlebot/identity-core:latest .

FROM python:3.13-slim

WORKDIR /app

# Copy shared library
COPY libs/flask_core /app/libs/flask_core

# Install shared library
RUN cd /app/libs/flask_core && pip install --no-cache-dir .

# Copy module files
COPY identity_core_module_flask/requirements.txt /app/
COPY identity_core_module_flask /app/

# Install module dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Create non-root user
RUN groupadd -r waddlebot && useradd -r -g waddlebot -m waddlebot

# Set proper permissions for app directory and log directory
RUN chown -R waddlebot:waddlebot /app /var/log/waddlebotlog

# Expose port
EXPOSE 8050
# Copy standard healthcheck script
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py
RUN chmod 755 /usr/local/bin/healthcheck.py


# Run with Hypercorn
# Health check (using /healthz for Kubernetes compatibility)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python3 /usr/local/bin/healthcheck.py http://localhost:8050/healthz

# Switch to non-root user
USER waddlebot

CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8050", "--workers", "4"]
