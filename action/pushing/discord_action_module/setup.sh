#!/bin/bash
# Setup script for Discord Action Module

set -e

echo "=== Discord Action Module Setup ==="
echo ""

# Check for .env file
if [ ! -f .env ]; then
    echo "Creating .env file from .env.example..."
    cp .env.example .env
    echo "⚠️  Please edit .env file with your Discord bot token and secret key"
    echo ""
fi

# Generate protobuf files
echo "Generating protobuf Python files..."
python3 -m grpc_tools.protoc \
    -I./proto \
    --python_out=./proto \
    --grpc_python_out=./proto \
    ./proto/discord_action.proto

if [ $? -eq 0 ]; then
    echo "✅ Protobuf files generated successfully"
else
    echo "❌ Failed to generate protobuf files"
    echo "Make sure grpcio-tools is installed: pip install grpcio-tools"
    exit 1
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Edit .env file with your configuration"
echo "2. Build Docker container: docker-compose build"
echo "3. Start services: docker-compose up -d"
echo "4. Check health: curl http://localhost:8070/health"
echo "5. Run tests: ./test_api.py --secret-key YOUR_KEY --test health"
echo ""
