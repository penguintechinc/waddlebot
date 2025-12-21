# Lambda Action Module Dockerfile
# Build from parent directory: docker build -f action/pushing/lambda_action_module/Dockerfile -t waddlebot/lambda-action:latest .

FROM python:3.12-slim

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

# Compile Protobuf messages
RUN python -m grpc_tools.protoc -I./grpc_proto --python_out=./grpc_proto --grpc_python_out=./grpc_proto ./grpc_proto/lambda_action.proto

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Create non-root user
RUN groupadd -r waddlebot && useradd -r -g waddlebot -m waddlebot

# Set proper permissions for app directory and log directory
RUN chown -R waddlebot:waddlebot /app /var/log/waddlebotlog

CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8080", "--workers", "4"]
