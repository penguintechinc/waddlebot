FROM python:3.13-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy shared libraries
COPY libs/ /app/libs/

# Install shared library
RUN cd /app/libs/flask_core && pip install --no-cache-dir .

# Copy requirements and install dependencies
COPY trigger/receiver/kick_module_flask/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY trigger/receiver/kick_module_flask/ .

# Copy standard healthcheck script
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py
RUN chmod 755 /usr/local/bin/healthcheck.py

# Create non-root user
RUN useradd -m -s /bin/bash appuser && chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 8007

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python3 /usr/local/bin/healthcheck.py http://localhost:8007/healthz

# Run application
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8007"]
