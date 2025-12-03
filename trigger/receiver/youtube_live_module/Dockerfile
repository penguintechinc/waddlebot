# Build from parent directory: docker build -f trigger/receiver/youtube_live_module/Dockerfile -t waddlebot/youtube-live:latest .

FROM python:3.13-slim

WORKDIR /app

# Copy shared library
COPY libs/flask_core /app/libs/flask_core

# Install shared library
RUN cd /app/libs/flask_core && pip install --no-cache-dir .

# Copy module files
COPY trigger/receiver/youtube_live_module/requirements.txt /app/
COPY trigger/receiver/youtube_live_module /app/

# Install module dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Expose port
EXPOSE 8006

# Run with Hypercorn
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8006", "--workers", "4"]
