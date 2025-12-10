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

<<<<<<< HEAD
# Create non-root user
RUN groupadd -r waddlebot && useradd -r -g waddlebot -m waddlebot

# Set proper permissions for app directory and log directory
RUN chown -R waddlebot:waddlebot /app /var/log/waddlebotlog

=======
>>>>>>> origin/main
# Create databases directory for PyDAL
RUN mkdir -p /app/databases

# Generate gRPC code from proto file
RUN python -m grpc_tools.protoc \
    -I./grpc_proto \
    --python_out=./grpc_proto \
    --grpc_python_out=./grpc_proto \
    ./grpc_proto/openwhisk_action.proto && \
    # Fix import paths in generated grpc file
    sed -i 's/^import openwhisk_action_pb2/from grpc_proto import openwhisk_action_pb2/' ./grpc_proto/openwhisk_action_pb2_grpc.py

# Expose ports
EXPOSE 8082 50062
# Copy standard healthcheck script
COPY scripts/healthcheck.py /usr/local/bin/healthcheck.py
RUN chmod 755 /usr/local/bin/healthcheck.py


# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python3 /usr/local/bin/healthcheck.py http://localhost:8082/healthz

# Run with Hypercorn (async ASGI server)
<<<<<<< HEAD
# Switch to non-root user
USER waddlebot

=======
>>>>>>> origin/main
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8082", "--workers", "4"]
