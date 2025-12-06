# Build from parent directory: docker build -f core/ai_researcher_module/Dockerfile -t waddlebot/ai-researcher:latest .

FROM python:3.13-slim

WORKDIR /app

# Copy shared library
COPY libs/flask_core /app/libs/flask_core

# Install shared library
RUN cd /app/libs/flask_core && pip install --no-cache-dir .

# Copy module files
COPY core/ai_researcher_module/requirements.txt /app/
COPY core/ai_researcher_module /app/

# Install module dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Create non-root user
RUN useradd -m -u 1000 waddlebot && \
    chown -R waddlebot:waddlebot /app /var/log/waddlebotlog

# Switch to non-root user
USER waddlebot

# Expose port
EXPOSE 8070

# Run with Hypercorn
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8070", "--workers", "4"]
