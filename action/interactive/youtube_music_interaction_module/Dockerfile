# Build from parent directory: docker build -f youtube_music_interaction_module_flask/Dockerfile -t waddlebot/youtube-music-interaction:latest .

FROM python:3.13-slim

WORKDIR /app

# Copy shared library
COPY libs/flask_core /app/libs/flask_core

# Install shared library
RUN cd /app/libs/flask_core && pip install --no-cache-dir .

# Copy module files
COPY youtube_music_interaction_module_flask/requirements.txt /app/
COPY youtube_music_interaction_module_flask /app/

# Install module dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Expose port
EXPOSE 8025

# Run with Hypercorn
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8025", "--workers", "4"]
