# Lambda Action Module Dockerfile
# Build from parent directory: docker build -f action/pushing/lambda_action_module/Dockerfile -t waddlebot/lambda-action:latest .

FROM python:3.13-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY action/pushing/lambda_action_module/requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY action/pushing/lambda_action_module /app/

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Create databases directory for PyDAL
RUN mkdir -p /app/databases

# Generate protobuf Python files
RUN python -m grpc_tools.protoc \
    -I./proto \
    --python_out=./proto \
    --grpc_python_out=./proto \
    ./proto/lambda_action.proto

# Expose ports
EXPOSE 50060 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"

# Run application with Hypercorn
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8080", "--workers", "4"]
