# OpenWhisk Action Module - Quick Start

## Prerequisites

1. **OpenWhisk Installation**: Running OpenWhisk instance (or use docker-compose)
2. **Database**: PostgreSQL database for WaddleBot
3. **Docker**: For containerized deployment

## Fastest: Docker Compose Local Testing

The quickest way to test OpenWhisk integration:

```bash
# From repository root
docker-compose up -d openwhisk openwhisk-action postgres redis

# Run integration test
./scripts/test-openwhisk.sh
```

This starts OpenWhisk standalone, deploys a hello world action, and verifies the full flow through the WaddleBot action module.

## 5-Minute Setup

### 1. Configure OpenWhisk

```bash
# Set OpenWhisk API host
export OPENWHISK_API_HOST=https://your-openwhisk-host.com

# Get your auth key
wsk property get --auth
# Output: whisk auth		namespace:key

# Set auth key
export OPENWHISK_AUTH_KEY=namespace:key

# Test connection
wsk list
```

### 2. Create Test Action

```bash
# Create simple hello action
cat > hello.js << 'EOL'
function main(params) {
    return {payload: 'Hello, ' + params.name + '!'};
}
EOL

wsk action create hello hello.js
```

### 3. Configure Module

```bash
# Copy example config
cp .env.example .env

# Edit configuration
nano .env

# Required settings:
# OPENWHISK_API_HOST=https://your-openwhisk-host.com
# OPENWHISK_AUTH_KEY=namespace:key
# DATABASE_URL=postgresql://user:pass@host/waddlebot
# MODULE_SECRET_KEY=your-64-char-secret-key-here
```

### 4. Run Module

#### Option A: Docker (Recommended)

```bash
# Build
docker build -f Dockerfile -t waddlebot/openwhisk-action:latest .

# Run
docker run -d \
  --name openwhisk-action \
  -p 8082:8082 \
  -p 50062:50062 \
  --env-file .env \
  waddlebot/openwhisk-action:latest

# Check health
curl http://localhost:8082/health
```

#### Option B: Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Generate gRPC code
python -m grpc_tools.protoc \
  -I./proto \
  --python_out=./proto \
  --grpc_python_out=./proto \
  ./proto/openwhisk_action.proto

# Run with Hypercorn
hypercorn app:app --bind 0.0.0.0:8082 --workers 4
```

### 5. Test Module

```bash
# Get JWT token
TOKEN=$(curl -X POST http://localhost:8082/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-module-secret-key",
    "service": "test"
  }' | jq -r .token)

# Invoke action
curl -X POST http://localhost:8082/api/v1/actions/invoke \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action_name": "hello",
    "payload": {"name": "World"},
    "blocking": true
  }' | jq
```

## Expected Output

```json
{
  "success": true,
  "activation_id": "abc123def456",
  "result": {
    "payload": "Hello, World!"
  },
  "duration": 123,
  "status": "success"
}
```

## Common Issues

### Connection Refused

**Problem**: Cannot connect to OpenWhisk API

**Solution**:
```bash
# Verify OpenWhisk is running
curl $OPENWHISK_API_HOST/api/v1

# Check network connectivity
ping openwhisk-host.com
```

### Authentication Failed

**Problem**: 401 Unauthorized from OpenWhisk

**Solution**:
```bash
# Verify auth key format (must be namespace:key)
echo $OPENWHISK_AUTH_KEY

# Test with wsk CLI
wsk list
```

### Self-Signed Certificate Error

**Problem**: SSL certificate verification failed

**Solution**:
```bash
# Set insecure mode for development
export OPENWHISK_INSECURE=true
```

### Module Health Check Fails

**Problem**: `/health` returns unhealthy

**Solution**:
```bash
# Check database connectivity
psql $DATABASE_URL -c "SELECT 1"

# Check logs
docker logs openwhisk-action
```

## Next Steps

1. **Create More Actions**: Build complex OpenWhisk actions
2. **Setup Sequences**: Chain actions together
3. **Configure Router**: Integrate with WaddleBot router
4. **Monitor Logs**: Check `/var/log/waddlebotlog/openwhisk_action.log`
5. **View Stats**: Monitor via `/api/v1/stats` endpoint

## Useful Commands

```bash
# View logs
docker logs -f openwhisk-action

# Restart module
docker restart openwhisk-action

# Check execution history
psql $DATABASE_URL -c "SELECT * FROM openwhisk_action_executions ORDER BY created_at DESC LIMIT 10"

# List OpenWhisk actions
wsk action list

# Get activation logs
wsk activation logs <activation_id>

# Test specific action
wsk action invoke hello --param name Test --result
```

## Production Checklist

- [ ] Set strong `MODULE_SECRET_KEY` (64 characters)
- [ ] Use valid SSL certificates (`OPENWHISK_INSECURE=false`)
- [ ] Configure production database with backups
- [ ] Set appropriate resource limits in Kubernetes
- [ ] Enable syslog for centralized logging
- [ ] Configure monitoring and alerts
- [ ] Test failover scenarios
- [ ] Document OpenWhisk action dependencies
- [ ] Setup rate limiting if needed
- [ ] Review security best practices

## Support

- See [README.md](README.md) for detailed documentation
- See [IMPLEMENTATION.md](IMPLEMENTATION.md) for architecture details
- Check [WaddleBot Documentation](../../CLAUDE.md) for integration details
