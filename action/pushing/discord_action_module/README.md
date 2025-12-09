# Discord Action Module

Stateless, clusterable module for pushing actions to Discord via gRPC and REST API.

## Overview

This module receives tasks from the WaddleBot processor/router and executes Discord actions such as sending messages, managing roles, moderating users, and more.

## Architecture

- **Stateless Design**: No persistent state, fully clusterable
- **gRPC Interface**: Primary interface for processor/router communication
- **REST API**: Secondary interface for third-party integrations
- **JWT Authentication**: 64-character shared key for security
- **PyDAL Database**: Activity logging and audit trail

## Features

### Discord Actions
- Send messages with optional embeds
- Add reactions to messages
- Manage user roles (add/remove)
- Create and send webhooks
- Delete and edit messages
- User moderation (kick, ban, timeout)

### Communication Protocols
- **gRPC Server**: Port 50051 (configurable)
- **REST API**: Port 8070 (configurable)
- **Health Check**: `/health` endpoint

## Configuration

All configuration via environment variables:

```bash
# Discord API
DISCORD_BOT_TOKEN=your_bot_token_here

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/waddlebot

# Server Configuration
GRPC_PORT=50051
REST_PORT=8070
HOST=0.0.0.0

# Security
MODULE_SECRET_KEY=64_char_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
JWT_ALGORITHM=HS256
JWT_EXPIRATION_SECONDS=3600

# Performance
MAX_CONCURRENT_REQUESTS=100
REQUEST_TIMEOUT=30

# Logging
LOG_LEVEL=INFO
LOG_DIR=/var/log/waddlebotlog
ENABLE_SYSLOG=false
SYSLOG_HOST=localhost
SYSLOG_PORT=514
SYSLOG_FACILITY=LOCAL0

# Discord Rate Limiting
DISCORD_RATE_LIMIT_GLOBAL=50
DISCORD_RATE_LIMIT_PER_CHANNEL=5

# Retry Configuration
MAX_RETRIES=3
RETRY_DELAY=1.0
```

## Running with Docker

Build:
```bash
docker build -t waddlebot/discord-action:latest .
```

Run:
```bash
docker run -d \
  -p 50051:50051 \
  -p 8070:8070 \
  -e DISCORD_BOT_TOKEN=your_token \
  -e DATABASE_URL=postgresql://user:pass@host/db \
  -e MODULE_SECRET_KEY=your_64_char_key \
  --name discord-action \
  waddlebot/discord-action:latest
```

## REST API Usage

### 1. Generate JWT Token

```bash
curl -X POST http://localhost:8070/api/v1/token \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "your_client_id",
    "client_secret": "your_client_secret"
  }'
```

Response:
```json
{
  "token": "eyJ0eXAi...",
  "expires_in": 3600
}
```

### 2. Send Message

```bash
curl -X POST http://localhost:8070/api/v1/message \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "1234567890",
    "content": "Hello from WaddleBot!",
    "embed": {
      "title": "Test Embed",
      "description": "This is a test embed",
      "color": "FF5733"
    }
  }'
```

### 3. Add Reaction

```bash
curl -X POST http://localhost:8070/api/v1/reaction \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "1234567890",
    "message_id": "9876543210",
    "emoji": "👍"
  }'
```

### 4. Manage Role

```bash
curl -X POST http://localhost:8070/api/v1/role \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "guild_id": "1234567890",
    "user_id": "9876543210",
    "role_id": "5555555555",
    "action": "add"
  }'
```

### 5. Timeout User

```bash
curl -X POST http://localhost:8070/api/v1/moderation/timeout \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "guild_id": "1234567890",
    "user_id": "9876543210",
    "duration_seconds": 600,
    "reason": "Spam"
  }'
```

## gRPC Usage

### Python Client Example

```python
import grpc
import jwt
from proto import discord_action_pb2, discord_action_pb2_grpc

# Generate JWT token
token = jwt.encode(
    {"client_id": "your_client"},
    "your_64_char_secret_key",
    algorithm="HS256"
)

# Connect to gRPC server
channel = grpc.insecure_channel('localhost:50051')
stub = discord_action_pb2_grpc.DiscordActionStub(channel)

# Send message
request = discord_action_pb2.SendMessageRequest(
    channel_id="1234567890",
    content="Hello from gRPC!",
    token=token
)
response = stub.SendMessage(request)
print(f"Success: {response.success}, Message ID: {response.message_id}")
```

## Database Schema

### discord_actions Table

Stores all Discord action logs for audit trail:

```sql
CREATE TABLE discord_actions (
    id SERIAL PRIMARY KEY,
    action_type VARCHAR(50) NOT NULL,
    guild_id VARCHAR(50),
    channel_id VARCHAR(50),
    user_id VARCHAR(50),
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    request_data JSONB,
    response_data JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);
```

## Health Check

```bash
curl http://localhost:8070/health
```

Response:
```json
{
  "status": "healthy",
  "module": "discord_action_module",
  "version": "1.0.0",
  "timestamp": "2025-12-02T12:00:00.000000",
  "config": {
    "module_name": "discord_action_module",
    "module_version": "1.0.0",
    "grpc_port": 50051,
    "rest_port": 8070,
    "database_configured": true,
    "discord_token_configured": true
  }
}
```

## Clustering

This module is fully stateless and can be deployed in multiple instances:

1. Deploy multiple containers
2. Use load balancer for REST API
3. Use gRPC load balancing for processor connections
4. All instances share same database for logging

## Security

- JWT tokens required for all operations
- 64-character shared secret key
- Token expiration enforced
- Rate limiting per Discord API requirements
- Audit logging for all actions

## Performance

- Async/await for all I/O operations
- Connection pooling for database
- Rate limit enforcement with retry logic
- Configurable concurrent request limits
- Automatic retry on transient failures

## License

Limited AGPL3 with contributor employer exception
