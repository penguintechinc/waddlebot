# Slack Action Module

Stateless container module for pushing actions to Slack. Receives tasks from the processor/router via gRPC and provides a REST API for third-party integrations.

## Features

- **gRPC Server**: Receives action tasks from processor/router
- **REST API**: Third-party integration endpoint
- **JWT Authentication**: Secure API access with 64-char shared key
- **PyDAL Database**: Action logging and audit trail
- **Stateless & Clusterable**: Horizontally scalable design

## Slack Actions Supported

### Messaging
- `send_message` - Send message to channel with optional Block Kit blocks
- `send_ephemeral` - Send ephemeral message (visible only to specific user)
- `update_message` - Update existing message
- `delete_message` - Delete message

### Reactions
- `add_reaction` - Add emoji reaction to message
- `remove_reaction` - Remove emoji reaction from message

### File Operations
- `upload_file` - Upload file to channel

### Channel Management
- `create_channel` - Create new channel (public or private)
- `invite_to_channel` - Invite users to channel
- `kick_from_channel` - Remove user from channel
- `set_topic` - Set channel topic

### Modals
- `open_modal` - Open modal dialog

## Environment Variables

```bash
# Slack API Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token  # Optional for socket mode

# Database Configuration
DATABASE_URL=postgresql://user:pass@localhost:5432/waddlebot

# gRPC Configuration
GRPC_PORT=50052
GRPC_MAX_WORKERS=10

# REST API Configuration
REST_PORT=8071

# JWT Authentication
MODULE_SECRET_KEY=your-64-char-shared-key

# Performance Settings
MAX_CONCURRENT_REQUESTS=100
REQUEST_TIMEOUT=30

# Logging Configuration
LOG_LEVEL=INFO
LOG_DIR=/var/log/waddlebotlog
ENABLE_SYSLOG=false
SYSLOG_HOST=localhost
SYSLOG_PORT=514
SYSLOG_FACILITY=LOCAL0
```

## Building and Running

### Generate Proto Files

```bash
python -m grpc_tools.protoc \
    -I./proto \
    --python_out=./proto \
    --grpc_python_out=./proto \
    ./proto/slack_action.proto
```

### Docker Build

```bash
docker build -t waddlebot/slack-action:latest .
```

### Docker Run

```bash
docker run -d \
    -p 8071:8071 \
    -p 50052:50052 \
    -e SLACK_BOT_TOKEN=xoxb-your-token \
    -e DATABASE_URL=postgresql://user:pass@host:5432/waddlebot \
    -e MODULE_SECRET_KEY=your-secret-key \
    waddlebot/slack-action:latest
```

### Local Development

```bash
pip install -r requirements.txt
python -m grpc_tools.protoc -I./proto --python_out=./proto --grpc_python_out=./proto ./proto/slack_action.proto
hypercorn app:app --bind 0.0.0.0:8071 --workers 4
```

## REST API Usage

### Generate JWT Token

```bash
curl -X POST http://localhost:8071/api/v1/token \
    -H "Content-Type: application/json" \
    -d '{
        "api_key": "your-module-secret-key",
        "client_id": "my-client"
    }'
```

### Send Message

```bash
curl -X POST http://localhost:8071/api/v1/message \
    -H "Authorization: Bearer your-jwt-token" \
    -H "Content-Type: application/json" \
    -d '{
        "community_id": "community-123",
        "channel_id": "C01234567",
        "text": "Hello from WaddleBot!",
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "*Hello* from WaddleBot!"
                }
            }
        ]
    }'
```

### Add Reaction

```bash
curl -X POST http://localhost:8071/api/v1/reaction \
    -H "Authorization: Bearer your-jwt-token" \
    -H "Content-Type: application/json" \
    -d '{
        "community_id": "community-123",
        "channel_id": "C01234567",
        "ts": "1234567890.123456",
        "emoji": "thumbsup"
    }'
```

### Get Action History

```bash
curl -X GET "http://localhost:8071/api/v1/history/community-123?limit=50" \
    -H "Authorization: Bearer your-jwt-token"
```

## gRPC Client Example

```python
import grpc
from proto import slack_action_pb2, slack_action_pb2_grpc

# Create channel
channel = grpc.insecure_channel('localhost:50052')
stub = slack_action_pb2_grpc.SlackActionServiceStub(channel)

# Send message
request = slack_action_pb2.SendMessageRequest(
    community_id='community-123',
    channel_id='C01234567',
    text='Hello from gRPC!'
)

response = stub.SendMessage(request)
print(f"Success: {response.success}")
print(f"Message TS: {response.message_ts}")
```

## Database Schema

### slack_actions Table

Tracks all Slack actions performed by the module:

```sql
CREATE TABLE slack_actions (
    id SERIAL PRIMARY KEY,
    community_id VARCHAR(64) NOT NULL,
    action_type VARCHAR(64) NOT NULL,
    channel_id VARCHAR(64),
    user_id VARCHAR(64),
    message_ts VARCHAR(64),
    request_data JSONB,
    response_data JSONB,
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_slack_actions_community ON slack_actions(community_id);
CREATE INDEX idx_slack_actions_created ON slack_actions(created_at);
CREATE INDEX idx_slack_actions_type ON slack_actions(action_type);
```

## Health Check

```bash
curl http://localhost:8071/health
```

Response:
```json
{
    "status": "healthy",
    "module": "slack_action_module",
    "version": "1.0.0",
    "grpc_port": 50052,
    "rest_port": 8071
}
```

## Architecture

```
┌─────────────────┐
│ Processor/      │
│ Router          │
└────────┬────────┘
         │ gRPC
         ▼
┌─────────────────┐      ┌─────────────┐
│ Slack Action    │◄────►│ PostgreSQL  │
│ Module          │      │ (PyDAL)     │
└────────┬────────┘      └─────────────┘
         │
         │ REST API (JWT Auth)
         ▼
┌─────────────────┐
│ Third-party     │
│ Integrations    │
└─────────────────┘
```

## Module Information

- **Name**: slack_action_module
- **Version**: 1.0.0
- **Type**: Pushing action module
- **Platform**: Slack
- **Protocol**: gRPC + REST API
- **Authentication**: JWT with shared secret key
- **Database**: PostgreSQL via PyDAL
- **Stateless**: Yes, fully clusterable
