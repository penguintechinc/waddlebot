# Twitch Action Module

Stateless, clusterable container that receives tasks from the processor/router via gRPC and pushes actions to Twitch via the Helix API.

## Features

- **gRPC Server**: Receives action tasks from processor/router
- **REST API**: Third-party access with JWT authentication
- **Twitch Helix API**: Complete integration for all Twitch actions
- **Token Management**: OAuth token storage and automatic refresh
- **Stateless Design**: Horizontally scalable, clusterable architecture
- **PyDAL Database**: Cross-database compatibility
- **Comprehensive Logging**: AAA logging with rotation and syslog support

## Supported Actions

### Chat Actions
- `chat_message` - Send chat message
- `whisper` - Send whisper to user
- `announcement` - Send announcement with color

### Moderation Actions
- `ban` - Ban user permanently
- `timeout` - Timeout user for duration
- `unban` - Unban user
- `delete_message` - Delete specific message
- `mod_add` - Add moderator
- `mod_remove` - Remove moderator
- `vip_add` - Add VIP
- `vip_remove` - Remove VIP

### Stream Management
- `update_title` - Update stream title
- `update_game` - Update stream game/category
- `marker` - Create stream marker
- `clip` - Create clip
- `raid` - Start raid to another channel

### Interactive Actions
- `poll_create` - Create poll
- `poll_end` - End poll
- `prediction_create` - Create prediction
- `prediction_resolve` - Resolve prediction

## Architecture

```
Processor/Router (gRPC) ──> Twitch Action Module (gRPC Server + REST API)
                                    │
                                    ├─> Twitch Helix API
                                    ├─> Token Manager (PyDAL)
                                    └─> Database (PostgreSQL)
```

## Environment Variables

```bash
# Twitch API
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret

# Database
DATABASE_URL=postgresql://user:pass@host:5432/waddlebot

# Server Configuration
GRPC_PORT=50053
REST_PORT=8072

# Security
MODULE_SECRET_KEY=64_char_shared_key

# Performance
MAX_WORKERS=20
REQUEST_TIMEOUT=30
MAX_BATCH_SIZE=100
TOKEN_REFRESH_BUFFER=300

# Logging
LOG_LEVEL=INFO
LOG_DIR=/var/log/waddlebotlog
ENABLE_SYSLOG=false
SYSLOG_HOST=localhost
SYSLOG_PORT=514
SYSLOG_FACILITY=LOCAL0
```

## REST API Endpoints

### Authentication

**Generate JWT Token**
```http
POST /api/v1/auth/token
Content-Type: application/json

{
  "api_key": "module_secret_key",
  "service": "processor"
}

Response:
{
  "token": "eyJ...",
  "expires_in": 3600
}
```

### Actions

**Execute Single Action**
```http
POST /api/v1/actions/execute
Authorization: Bearer <token>
Content-Type: application/json

{
  "action_type": "chat_message",
  "broadcaster_id": "123456",
  "parameters": {
    "message": "Hello, chat!"
  }
}

Response:
{
  "success": true,
  "message": "Action chat_message executed successfully",
  "action_id": "uuid",
  "result_data": {},
  "error": ""
}
```

**Execute Batch Actions**
```http
POST /api/v1/actions/batch
Authorization: Bearer <token>
Content-Type: application/json

{
  "actions": [
    {
      "action_type": "chat_message",
      "broadcaster_id": "123456",
      "parameters": {"message": "Message 1"}
    },
    {
      "action_type": "announcement",
      "broadcaster_id": "123456",
      "parameters": {"message": "Important!", "color": "purple"}
    }
  ]
}

Response:
{
  "responses": [...],
  "total_count": 2,
  "success_count": 2,
  "failure_count": 0
}
```

### Token Management

**Store OAuth Token**
```http
POST /api/v1/tokens/store
Authorization: Bearer <token>
Content-Type: application/json

{
  "broadcaster_id": "123456",
  "access_token": "access_token",
  "refresh_token": "refresh_token",
  "expires_in": 3600,
  "scopes": ["chat:write", "moderator:manage:banned_users"]
}
```

**Revoke Token**
```http
POST /api/v1/tokens/revoke
Authorization: Bearer <token>
Content-Type: application/json

{
  "broadcaster_id": "123456"
}
```

### Statistics

**Get Module Statistics**
```http
GET /api/v1/stats
Authorization: Bearer <token>

Response:
{
  "module": "twitch_action_module",
  "version": "1.0.0",
  "stats": {
    "registered_broadcasters": 42,
    "grpc_port": 50053,
    "rest_port": 8072
  },
  "timestamp": "2025-12-02T..."
}
```

### Health Check

```http
GET /health

Response:
{
  "status": "healthy",
  "module": "twitch_action_module",
  "version": "1.0.0",
  "timestamp": "2025-12-02T...",
  "database": "connected",
  "grpc_port": 50053,
  "rest_port": 8072
}
```

## gRPC Service

The module implements the `TwitchActionService` gRPC service defined in `proto/twitch_action.proto`:

```protobuf
service TwitchActionService {
  rpc ExecuteAction (ActionRequest) returns (ActionResponse);
  rpc BatchExecuteActions (BatchActionRequest) returns (BatchActionResponse);
  rpc GetActionStatus (StatusRequest) returns (StatusResponse);
}
```

## Database Schema

```sql
-- OAuth tokens with automatic refresh
twitch_action_tokens (
    broadcaster_id STRING UNIQUE,
    access_token STRING,
    refresh_token STRING,
    token_type STRING,
    expires_at DATETIME,
    scopes LIST:STRING,
    last_refreshed DATETIME,
    created_at DATETIME,
    updated_at DATETIME
)
```

## Token Management

- Tokens are stored in database with expiration time
- Automatic refresh before expiration (5 minute buffer)
- Thread-safe token retrieval and refresh
- Supports multiple scopes per broadcaster

## Building and Running

### Docker Build
```bash
docker build -f action/pushing/twitch_action_module/Dockerfile -t waddlebot/twitch-action:latest .
```

### Docker Run
```bash
docker run -d \
  -p 8072:8072 \
  -p 50053:50053 \
  -e TWITCH_CLIENT_ID=your_client_id \
  -e TWITCH_CLIENT_SECRET=your_client_secret \
  -e DATABASE_URL=postgresql://user:pass@host:5432/waddlebot \
  -e MODULE_SECRET_KEY=your_64_char_key \
  waddlebot/twitch-action:latest
```

### Local Development
```bash
# Install dependencies
pip install -r requirements.txt

# Generate gRPC code
python -m grpc_tools.protoc \
  -I./proto \
  --python_out=./proto \
  --grpc_python_out=./proto \
  ./proto/twitch_action.proto

# Run with Hypercorn
hypercorn app:app --bind 0.0.0.0:8072 --workers 4
```

## Testing

```bash
# Run tests
pytest tests/ -v --cov

# Test health endpoint
curl http://localhost:8072/health

# Generate token
curl -X POST http://localhost:8072/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"api_key":"your_secret_key","service":"test"}'

# Execute action
curl -X POST http://localhost:8072/api/v1/actions/execute \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "action_type":"chat_message",
    "broadcaster_id":"123456",
    "parameters":{"message":"Hello!"}
  }'
```

## Deployment

### Kubernetes
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: twitch-action
spec:
  replicas: 3  # Stateless, horizontally scalable
  selector:
    matchLabels:
      app: twitch-action
  template:
    metadata:
      labels:
        app: twitch-action
    spec:
      containers:
      - name: twitch-action
        image: waddlebot/twitch-action:latest
        ports:
        - containerPort: 8072
          name: rest
        - containerPort: 50053
          name: grpc
        env:
        - name: TWITCH_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: twitch-action-secrets
              key: client_id
        - name: TWITCH_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: twitch-action-secrets
              key: client_secret
        - name: MODULE_SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: twitch-action-secrets
              key: module_secret
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: database-secrets
              key: url
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8072
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 8072
          initialDelaySeconds: 5
          periodSeconds: 10
```

## Security

- JWT authentication for REST API
- OAuth token storage in database
- Automatic token refresh
- No plaintext credentials in logs
- Rate limiting at API gateway level
- TLS termination at ingress

## Performance

- Asynchronous I/O with Quart
- Connection pooling for database
- Automatic token refresh to avoid expired tokens
- Batch action support for efficiency
- Stateless design for horizontal scaling
- Multi-worker support with Hypercorn

## Monitoring

- Health check endpoint for liveness/readiness
- Comprehensive AAA logging
- Structured logging for log aggregation
- Performance metrics in logs
- Error tracking and alerting

## License

Limited AGPL3 with Contributor Employer Exception
See LICENSE file in repository root
