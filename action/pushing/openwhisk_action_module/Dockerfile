# OpenWhisk Action Module Dockerfile
# Build from parent directory: docker build -f action/pushing/openwhisk_action_module/Dockerfile -t waddlebot/openwhisk-action:latest .

FROM python:3.13-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY action/pushing/openwhisk_action_module/requirements.txt /app/

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy module files
COPY action/pushing/openwhisk_action_module /app/

# Create log directory
RUN mkdir -p /var/log/waddlebotlog

# Create databases directory for PyDAL
RUN mkdir -p /app/databases

# Generate gRPC code from proto file
RUN python -m grpc_tools.protoc \
    -I./proto \
    --python_out=./proto \
    --grpc_python_out=./proto \
    ./proto/openwhisk_action.proto && \
    # Fix import paths in generated grpc file
    sed -i 's/^import openwhisk_action_pb2/from proto import openwhisk_action_pb2/' ./proto/openwhisk_action_pb2_grpc.py

# Expose ports
EXPOSE 8082 50062

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8082/health')"

# Run with Hypercorn (async ASGI server)
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8082", "--workers", "4"]
