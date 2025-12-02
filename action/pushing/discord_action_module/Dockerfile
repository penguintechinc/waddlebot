# Discord Action Module Dockerfile
# Build: docker build -f Dockerfile -t waddlebot/discord-action:latest .

FROM python:3.13-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . /app/

# Generate protobuf Python files
RUN python -m grpc_tools.protoc \
    -I./proto \
    --python_out=./proto \
    --grpc_python_out=./proto \
    ./proto/discord_action.proto

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Create non-root user
RUN useradd -m -u 1000 waddlebot && \
    chown -R waddlebot:waddlebot /app /var/log/waddlebotlog

# Switch to non-root user
USER waddlebot

# Expose ports
EXPOSE 50051 8070

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8070/health')"

# Run application
CMD ["python", "app.py"]
