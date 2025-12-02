# Discord Action Module - Quick Reference

## Directory Structure
```
discord_action_module/
├── app.py                    # Main application (gRPC + REST)
├── config.py                 # Configuration management
├── requirements.txt          # Python dependencies
├── Dockerfile                # Container definition
├── docker-compose.yml        # Local development
├── k8s-deployment.yaml       # Kubernetes deployment
├── setup.sh                  # Setup script
├── test_api.py              # API testing script
├── .env.example             # Environment template
├── .gitignore               # Git ignore patterns
├── README.md                # Full documentation
├── API.md                   # API reference
├── SUMMARY.md               # Overview
├── QUICKREF.md              # This file
├── proto/
│   ├── discord_action.proto # gRPC service definition
│   └── __init__.py
└── services/
    ├── discord_service.py   # Discord API integration
    ├── grpc_handler.py      # gRPC request handler
    └── __init__.py
```

## Setup Commands
```bash
# Clone/navigate to module
cd /home/penguin/code/WaddleBot/action/pushing/discord_action_module/

# Setup environment
cp .env.example .env
nano .env  # Edit with your values

# Generate protobuf files
./setup.sh

# Start services
docker-compose up -d

# Check health
curl http://localhost:8070/health

# View logs
docker-compose logs -f discord-action
```

## Configuration (Environment Variables)
```bash
# Required
DISCORD_BOT_TOKEN=your_bot_token
MODULE_SECRET_KEY=64_char_secret_key
DATABASE_URL=postgresql://user:pass@host:5432/waddlebot

# Optional (with defaults)
GRPC_PORT=50051
REST_PORT=8070
JWT_EXPIRATION_SECONDS=3600
MAX_CONCURRENT_REQUESTS=100
REQUEST_TIMEOUT=30
LOG_LEVEL=INFO
```

## REST API Quick Reference

### Authentication
```bash
# Get token
curl -X POST http://localhost:8070/api/v1/token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"test","client_secret":"test"}'

# Use token
curl -H "Authorization: Bearer TOKEN" ...
```

### Send Message
```bash
curl -X POST http://localhost:8070/api/v1/message \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "1234567890",
    "content": "Hello!"
  }'
```

### Send Embed
```bash
curl -X POST http://localhost:8070/api/v1/embed \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "1234567890",
    "embed": {
      "title": "Title",
      "description": "Description",
      "color": "FF5733"
    }
  }'
```

### Add Reaction
```bash
curl -X POST http://localhost:8070/api/v1/reaction \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "1234567890",
    "message_id": "9876543210",
    "emoji": "👍"
  }'
```

### Manage Role
```bash
curl -X POST http://localhost:8070/api/v1/role \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "guild_id": "1234567890",
    "user_id": "9876543210",
    "role_id": "5555555555",
    "action": "add"
  }'
```

### Timeout User
```bash
curl -X POST http://localhost:8070/api/v1/moderation/timeout \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "guild_id": "1234567890",
    "user_id": "9876543210",
    "duration_seconds": 600,
    "reason": "Spam"
  }'
```

## gRPC Quick Reference

### Python Client
```python
import grpc
import jwt
from proto import discord_action_pb2, discord_action_pb2_grpc

# Generate token
token = jwt.encode(
    {"client_id": "processor"},
    "YOUR_64_CHAR_SECRET_KEY",
    algorithm="HS256"
)

# Connect
channel = grpc.insecure_channel('localhost:50051')
stub = discord_action_pb2_grpc.DiscordActionStub(channel)

# Send message
request = discord_action_pb2.SendMessageRequest(
    channel_id="1234567890",
    content="Hello!",
    token=token
)
response = stub.SendMessage(request)
print(f"Success: {response.success}")
```

## Testing Commands
```bash
# Health check only
./test_api.py --secret-key KEY --test health

# Test message sending
./test_api.py --secret-key KEY --channel-id ID --test message

# Test embed sending
./test_api.py --secret-key KEY --channel-id ID --test embed

# Test reaction
./test_api.py --secret-key KEY \
  --channel-id CHANNEL_ID \
  --message-id MESSAGE_ID \
  --test reaction

# Test role management
./test_api.py --secret-key KEY \
  --guild-id GUILD_ID \
  --user-id USER_ID \
  --role-id ROLE_ID \
  --test role

# Run all tests
./test_api.py --secret-key KEY \
  --channel-id CHANNEL_ID \
  --test all
```

## Docker Commands
```bash
# Build
docker build -t waddlebot/discord-action:latest .

# Run standalone
docker run -d \
  -p 50051:50051 -p 8070:8070 \
  -e DISCORD_BOT_TOKEN=TOKEN \
  -e DATABASE_URL=postgresql://... \
  -e MODULE_SECRET_KEY=KEY \
  waddlebot/discord-action:latest

# Using docker-compose
docker-compose up -d          # Start
docker-compose down           # Stop
docker-compose logs -f        # Logs
docker-compose ps             # Status
docker-compose restart        # Restart
```

## Kubernetes Commands
```bash
# Deploy
kubectl apply -f k8s-deployment.yaml

# Check status
kubectl -n waddlebot get pods -l app=discord-action
kubectl -n waddlebot get svc

# View logs
kubectl -n waddlebot logs -f deployment/discord-action

# Scale manually
kubectl -n waddlebot scale deployment/discord-action --replicas=5

# Delete
kubectl delete -f k8s-deployment.yaml
```

## Database Queries
```sql
-- View all actions
SELECT * FROM discord_actions ORDER BY created_at DESC LIMIT 10;

-- View failed actions
SELECT * FROM discord_actions WHERE success = FALSE;

-- Count actions by type
SELECT action_type, COUNT(*)
FROM discord_actions
GROUP BY action_type
ORDER BY COUNT(*) DESC;

-- View actions for specific channel
SELECT * FROM discord_actions
WHERE channel_id = '1234567890'
ORDER BY created_at DESC;
```

## Troubleshooting
```bash
# Check if service is running
curl http://localhost:8070/health

# View logs
docker-compose logs discord-action
# or
kubectl -n waddlebot logs deployment/discord-action

# Check database connection
docker-compose exec postgres psql -U waddlebot -d waddlebot

# Regenerate protobuf files
./setup.sh

# Test Discord API connection
curl -H "Authorization: Bot YOUR_TOKEN" \
  https://discord.com/api/v10/users/@me
```

## Common Issues

### "grpcio-tools not found"
```bash
pip install grpcio-tools
./setup.sh
```

### "Discord API 401 Unauthorized"
Check DISCORD_BOT_TOKEN in .env file

### "Database connection failed"
Check DATABASE_URL and ensure PostgreSQL is running

### "Token verification failed"
Ensure MODULE_SECRET_KEY is exactly 64 characters

### "Rate limited"
Discord API has limits - module handles retries automatically

## Performance Tuning
```bash
# Increase workers (docker-compose.yml)
# Change: --workers 4  to  --workers 8

# Increase concurrent requests
MAX_CONCURRENT_REQUESTS=200

# Adjust timeouts
REQUEST_TIMEOUT=60

# Scale Kubernetes deployment
kubectl -n waddlebot scale deployment/discord-action --replicas=10
```

## Security Checklist
- [ ] Change MODULE_SECRET_KEY to 64-char random string
- [ ] Secure DISCORD_BOT_TOKEN
- [ ] Use HTTPS in production
- [ ] Configure database firewall rules
- [ ] Enable Kubernetes network policies
- [ ] Rotate JWT tokens regularly
- [ ] Monitor audit logs

## Monitoring
```bash
# Health endpoint
curl http://localhost:8070/health

# gRPC health check
grpc_health_probe -addr=localhost:50051

# Check metrics
# View database action counts
# Monitor API response times
# Track rate limit encounters
```

## Support Files
- **README.md** - Full documentation
- **API.md** - Complete API reference
- **SUMMARY.md** - Module overview
- **QUICKREF.md** - This file
