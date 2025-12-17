# Router Module Configuration

## Overview

The Router Module is configured through environment variables loaded from `.env` files or Kubernetes ConfigMaps/Secrets.

**Configuration File:** `/processing/router_module/config.py`
**Module Version:** 2.0.0

---

## Table of Contents

1. [Basic Configuration](#basic-configuration)
2. [Database Configuration](#database-configuration)
3. [Redis Configuration](#redis-configuration)
4. [Router Performance](#router-performance)
5. [Module Integration](#module-integration)
6. [Translation Configuration](#translation-configuration)
7. [gRPC Configuration](#grpc-configuration)
8. [Redis Streams Pipeline](#redis-streams-pipeline)
9. [Docker Configuration](#docker-configuration)
10. [Complete Example](#complete-example)

---

## Basic Configuration

### MODULE_NAME
- **Type:** String
- **Default:** `router_module`
- **Description:** Module identifier for logging and monitoring

### MODULE_VERSION
- **Type:** String
- **Default:** `2.0.0`
- **Description:** Current module version

### MODULE_PORT
- **Type:** Integer
- **Default:** `8000`
- **Environment Variable:** `MODULE_PORT`
- **Description:** Port the module listens on

### LOG_LEVEL
- **Type:** String
- **Default:** `INFO`
- **Environment Variable:** `LOG_LEVEL`
- **Options:** `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`
- **Description:** Logging verbosity level

### SECRET_KEY
- **Type:** String
- **Default:** `change-me-in-production`
- **Environment Variable:** `SECRET_KEY`
- **Description:** Secret key for JWT token generation and encryption
- **⚠️ IMPORTANT:** Must be changed in production!

**Example:**
```env
MODULE_PORT=8000
LOG_LEVEL=INFO
SECRET_KEY=your-super-secret-key-here
```

---

## Database Configuration

### DATABASE_URL
- **Type:** String (PostgreSQL connection URL)
- **Default:** `postgresql://waddlebot:password@localhost:5432/waddlebot`
- **Environment Variable:** `DATABASE_URL`
- **Format:** `postgresql://user:password@host:port/database`
- **Description:** Primary database connection

**Example:**
```env
DATABASE_URL=postgresql://waddlebot:secure_password@postgres:5432/waddlebot
```

### READ_REPLICA_URL
- **Type:** String (PostgreSQL connection URL)
- **Default:** Empty string (disabled)
- **Environment Variable:** `READ_REPLICA_URL`
- **Description:** Optional read replica for query load distribution
- **Note:** If empty, all queries use primary database

**Example:**
```env
READ_REPLICA_URL=postgresql://waddlebot:secure_password@postgres-replica:5432/waddlebot
```

---

## Redis Configuration

### REDIS_HOST
- **Type:** String
- **Default:** `redis`
- **Environment Variable:** `REDIS_HOST`
- **Description:** Redis server hostname

### REDIS_PORT
- **Type:** Integer
- **Default:** `6379`
- **Environment Variable:** `REDIS_PORT`
- **Description:** Redis server port

### REDIS_PASSWORD
- **Type:** String
- **Default:** Empty string (no auth)
- **Environment Variable:** `REDIS_PASSWORD`
- **Description:** Redis authentication password

### REDIS_DB
- **Type:** Integer
- **Default:** `0`
- **Environment Variable:** `REDIS_DB`
- **Description:** Redis database number (0-15)

### SESSION_TTL
- **Type:** Integer (seconds)
- **Default:** `3600` (1 hour)
- **Environment Variable:** `SESSION_TTL`
- **Description:** Session expiration time

### SESSION_PREFIX
- **Type:** String
- **Default:** `waddlebot:session:`
- **Environment Variable:** `SESSION_PREFIX`
- **Description:** Redis key prefix for sessions

**Redis Connection String:**
```env
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password
REDIS_DB=0
SESSION_TTL=3600
SESSION_PREFIX=waddlebot:session:
```

**Derived REDIS_URL:**
```python
# Constructed in code:
redis://[:password@]host:port/db
```

---

## Router Performance

### ROUTER_MAX_WORKERS
- **Type:** Integer
- **Default:** `20`
- **Environment Variable:** `ROUTER_MAX_WORKERS`
- **Description:** Maximum database connection pool size
- **Recommendation:** Set to number of CPU cores × 2

### ROUTER_MAX_CONCURRENT
- **Type:** Integer
- **Default:** `100`
- **Environment Variable:** `ROUTER_MAX_CONCURRENT`
- **Description:** Maximum concurrent event processing
- **Recommendation:** Monitor memory usage when increasing

### ROUTER_REQUEST_TIMEOUT
- **Type:** Integer (seconds)
- **Default:** `30`
- **Environment Variable:** `ROUTER_REQUEST_TIMEOUT`
- **Description:** Timeout for HTTP requests to interaction modules

### ROUTER_DEFAULT_RATE_LIMIT
- **Type:** Integer (requests per minute)
- **Default:** `60`
- **Environment Variable:** `ROUTER_DEFAULT_RATE_LIMIT`
- **Description:** Default rate limit for command execution

### ROUTER_COMMAND_CACHE_TTL
- **Type:** Integer (seconds)
- **Default:** `300` (5 minutes)
- **Environment Variable:** `ROUTER_COMMAND_CACHE_TTL`
- **Description:** Cache TTL for command definitions

### ROUTER_ENTITY_CACHE_TTL
- **Type:** Integer (seconds)
- **Default:** `600` (10 minutes)
- **Environment Variable:** `ROUTER_ENTITY_CACHE_TTL`
- **Description:** Cache TTL for entity → community mappings

**Performance Tuning Example:**
```env
ROUTER_MAX_WORKERS=20
ROUTER_MAX_CONCURRENT=100
ROUTER_REQUEST_TIMEOUT=30
ROUTER_DEFAULT_RATE_LIMIT=60
ROUTER_COMMAND_CACHE_TTL=300
ROUTER_ENTITY_CACHE_TTL=600
```

---

## Module Integration

### Hub Module

#### HUB_API_URL
- **Type:** String (HTTP URL)
- **Default:** `http://hub-module:8060`
- **Environment Variable:** `HUB_API_URL`
- **Description:** Hub module API endpoint for activity tracking

#### SERVICE_API_KEY
- **Type:** String
- **Default:** Empty string
- **Environment Variable:** `SERVICE_API_KEY`
- **Description:** API key for service-to-service authentication

**Example:**
```env
HUB_API_URL=http://hub-module:8060
SERVICE_API_KEY=your-service-api-key
```

### Reputation Module

#### REPUTATION_API_URL
- **Type:** String (HTTP URL)
- **Default:** `http://reputation:8021`
- **Environment Variable:** `REPUTATION_API_URL`
- **Description:** Reputation module API endpoint

#### REPUTATION_ENABLED
- **Type:** Boolean
- **Default:** `true`
- **Environment Variable:** `REPUTATION_ENABLED`
- **Options:** `true`, `false`
- **Description:** Enable/disable reputation tracking

**Example:**
```env
REPUTATION_API_URL=http://reputation:8021
REPUTATION_ENABLED=true
```

### Workflow Core Module

#### WORKFLOW_CORE_URL
- **Type:** String (HTTP URL)
- **Default:** `http://workflow-core:8070`
- **Environment Variable:** `WORKFLOW_CORE_URL`
- **Description:** Workflow core module API endpoint

**Example:**
```env
WORKFLOW_CORE_URL=http://workflow-core:8070
```

### Browser Source Module

#### BROWSER_SOURCE_URL
- **Type:** String (HTTP URL)
- **Default:** `http://browser-source:8050`
- **Environment Variable:** `BROWSER_SOURCE_URL`
- **Description:** Browser source module for caption overlays

**Example:**
```env
BROWSER_SOURCE_URL=http://browser-source:8050
```

### AWS Lambda Integration

#### AWS_REGION
- **Type:** String
- **Default:** `us-east-1`
- **Environment Variable:** `AWS_REGION`
- **Description:** AWS region for Lambda functions

#### AWS_ACCESS_KEY_ID
- **Type:** String
- **Default:** Empty string
- **Environment Variable:** `AWS_ACCESS_KEY_ID`
- **Description:** AWS access key

#### AWS_SECRET_ACCESS_KEY
- **Type:** String
- **Default:** Empty string
- **Environment Variable:** `AWS_SECRET_ACCESS_KEY`
- **Description:** AWS secret key

#### LAMBDA_FUNCTION_PREFIX
- **Type:** String
- **Default:** `waddlebot-`
- **Environment Variable:** `LAMBDA_FUNCTION_PREFIX`
- **Description:** Prefix for Lambda function names

**Example:**
```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
LAMBDA_FUNCTION_PREFIX=waddlebot-
```

### OpenWhisk Integration

#### OPENWHISK_API_HOST
- **Type:** String (HTTP URL)
- **Default:** Empty string
- **Environment Variable:** `OPENWHISK_API_HOST`
- **Description:** OpenWhisk API endpoint

#### OPENWHISK_AUTH_KEY
- **Type:** String
- **Default:** Empty string
- **Environment Variable:** `OPENWHISK_AUTH_KEY`
- **Description:** OpenWhisk authentication key

#### OPENWHISK_NAMESPACE
- **Type:** String
- **Default:** `waddlebot`
- **Environment Variable:** `OPENWHISK_NAMESPACE`
- **Description:** OpenWhisk namespace

**Example:**
```env
OPENWHISK_API_HOST=https://openwhisk.example.com
OPENWHISK_AUTH_KEY=your-auth-key
OPENWHISK_NAMESPACE=waddlebot
```

---

## Translation Configuration

### WaddleAI Configuration

#### WADDLEAI_BASE_URL
- **Type:** String (HTTP URL)
- **Default:** `http://waddleai-proxy:8090`
- **Environment Variable:** `WADDLEAI_BASE_URL`
- **Description:** WaddleAI proxy endpoint for AI-powered translation

#### WADDLEAI_API_KEY
- **Type:** String
- **Default:** Empty string
- **Environment Variable:** `WADDLEAI_API_KEY`
- **Description:** WaddleAI API key

#### WADDLEAI_MODEL
- **Type:** String
- **Default:** `tinyllama`
- **Environment Variable:** `WADDLEAI_MODEL`
- **Options:** `tinyllama`, `llama2`, `mistral`, etc.
- **Description:** AI model for translation fallback

#### WADDLEAI_TEMPERATURE
- **Type:** Float
- **Default:** `0.7`
- **Environment Variable:** `WADDLEAI_TEMPERATURE`
- **Range:** 0.0 - 1.0
- **Description:** AI model temperature (creativity)

#### WADDLEAI_MAX_TOKENS
- **Type:** Integer
- **Default:** `500`
- **Environment Variable:** `WADDLEAI_MAX_TOKENS`
- **Description:** Maximum tokens in AI response

#### WADDLEAI_TIMEOUT
- **Type:** Integer (seconds)
- **Default:** `30`
- **Environment Variable:** `WADDLEAI_TIMEOUT`
- **Description:** AI request timeout

**Example:**
```env
WADDLEAI_BASE_URL=http://waddleai-proxy:8090
WADDLEAI_API_KEY=your-waddleai-key
WADDLEAI_MODEL=tinyllama
WADDLEAI_TEMPERATURE=0.7
WADDLEAI_MAX_TOKENS=500
WADDLEAI_TIMEOUT=30
```

### Emote API Configuration

#### BTTV_API_URL
- **Type:** String (HTTPS URL)
- **Default:** `https://api.betterttv.net/3`
- **Environment Variable:** `BTTV_API_URL`
- **Description:** BetterTTV emote API

#### FFZ_API_URL
- **Type:** String (HTTPS URL)
- **Default:** `https://api.frankerfacez.com/v1`
- **Environment Variable:** `FFZ_API_URL`
- **Description:** FrankerFaceZ emote API

#### SEVENTV_API_URL
- **Type:** String (HTTPS URL)
- **Default:** `https://7tv.io/v3`
- **Environment Variable:** `SEVENTV_API_URL`
- **Description:** 7TV emote API

#### TWITCH_CLIENT_ID
- **Type:** String
- **Default:** Empty string
- **Environment Variable:** `TWITCH_CLIENT_ID`
- **Description:** Twitch API client ID

#### TWITCH_CLIENT_SECRET
- **Type:** String
- **Default:** Empty string
- **Environment Variable:** `TWITCH_CLIENT_SECRET`
- **Description:** Twitch API client secret

#### DISCORD_BOT_TOKEN
- **Type:** String
- **Default:** Empty string
- **Environment Variable:** `DISCORD_BOT_TOKEN`
- **Description:** Discord bot token for guild emojis

**Example:**
```env
BTTV_API_URL=https://api.betterttv.net/3
FFZ_API_URL=https://api.frankerfacez.com/v1
SEVENTV_API_URL=https://7tv.io/v3
TWITCH_CLIENT_ID=your-twitch-client-id
TWITCH_CLIENT_SECRET=your-twitch-secret
DISCORD_BOT_TOKEN=your-discord-token
```

### Emote Cache TTL

#### EMOTE_CACHE_TTL_GLOBAL
- **Type:** Integer (seconds)
- **Default:** `2592000` (30 days)
- **Environment Variable:** `EMOTE_CACHE_TTL_GLOBAL`
- **Description:** Cache TTL for global emotes

#### EMOTE_CACHE_TTL_CHANNEL
- **Type:** Integer (seconds)
- **Default:** `86400` (1 day)
- **Environment Variable:** `EMOTE_CACHE_TTL_CHANNEL`
- **Description:** Cache TTL for channel-specific emotes

**Example:**
```env
EMOTE_CACHE_TTL_GLOBAL=2592000  # 30 days
EMOTE_CACHE_TTL_CHANNEL=86400   # 1 day
```

### AI Decision Limits

#### AI_DECISION_MAX_CALLS_PER_MESSAGE
- **Type:** Integer
- **Default:** `3`
- **Environment Variable:** `AI_DECISION_MAX_CALLS_PER_MESSAGE`
- **Description:** Max AI calls per message during translation preprocessing

#### AI_DECISION_TIMEOUT
- **Type:** Integer (seconds)
- **Default:** `2`
- **Environment Variable:** `AI_DECISION_TIMEOUT`
- **Description:** Timeout for AI decision calls

**Example:**
```env
AI_DECISION_MAX_CALLS_PER_MESSAGE=3
AI_DECISION_TIMEOUT=2
```

---

## gRPC Configuration

### GRPC_ENABLED
- **Type:** Boolean
- **Default:** `true`
- **Environment Variable:** `GRPC_ENABLED`
- **Options:** `true`, `false`
- **Description:** Enable/disable gRPC communication

### Action Module gRPC Hosts

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_GRPC_HOST` | `discord-action:50051` | Discord action module |
| `SLACK_GRPC_HOST` | `slack-action:50052` | Slack action module |
| `TWITCH_GRPC_HOST` | `twitch-action:50053` | Twitch action module |
| `YOUTUBE_GRPC_HOST` | `youtube-action:50054` | YouTube action module |
| `LAMBDA_GRPC_HOST` | `lambda-action:50060` | Lambda action module |
| `GCP_FUNCTIONS_GRPC_HOST` | `gcp-functions-action:50061` | GCP Functions action |
| `OPENWHISK_GRPC_HOST` | `openwhisk-action:50062` | OpenWhisk action |

### Core Module gRPC Hosts

| Variable | Default | Description |
|----------|---------|-------------|
| `REPUTATION_GRPC_HOST` | `reputation:50021` | Reputation core module |
| `WORKFLOW_GRPC_HOST` | `workflow-core:50070` | Workflow core module |
| `BROWSER_SOURCE_GRPC_HOST` | `browser-source:50050` | Browser source module |
| `IDENTITY_GRPC_HOST` | `identity-core:50030` | Identity core module |
| `HUB_GRPC_HOST` | `hub:50060` | Hub module |

### gRPC Settings

#### GRPC_KEEPALIVE_TIME_MS
- **Type:** Integer (milliseconds)
- **Default:** `30000` (30 seconds)
- **Environment Variable:** `GRPC_KEEPALIVE_TIME_MS`
- **Description:** Time between keepalive pings

#### GRPC_KEEPALIVE_TIMEOUT_MS
- **Type:** Integer (milliseconds)
- **Default:** `10000` (10 seconds)
- **Environment Variable:** `GRPC_KEEPALIVE_TIMEOUT_MS`
- **Description:** Keepalive ping timeout

#### GRPC_MAX_RETRIES
- **Type:** Integer
- **Default:** `3`
- **Environment Variable:** `GRPC_MAX_RETRIES`
- **Description:** Maximum retry attempts for failed gRPC calls

**gRPC Configuration Example:**
```env
GRPC_ENABLED=true
DISCORD_GRPC_HOST=discord-action:50051
SLACK_GRPC_HOST=slack-action:50052
TWITCH_GRPC_HOST=twitch-action:50053
REPUTATION_GRPC_HOST=reputation:50021
WORKFLOW_GRPC_HOST=workflow-core:50070
BROWSER_SOURCE_GRPC_HOST=browser-source:50050
GRPC_KEEPALIVE_TIME_MS=30000
GRPC_KEEPALIVE_TIMEOUT_MS=10000
GRPC_MAX_RETRIES=3
```

---

## Redis Streams Pipeline

### STREAM_PIPELINE_ENABLED
- **Type:** Boolean
- **Default:** `false`
- **Environment Variable:** `STREAM_PIPELINE_ENABLED`
- **Options:** `true`, `false`
- **Description:** Enable Redis Streams for event processing

### STREAM_BATCH_SIZE
- **Type:** Integer
- **Default:** `10`
- **Environment Variable:** `STREAM_BATCH_SIZE`
- **Description:** Number of events to read per batch

### STREAM_BLOCK_TIME
- **Type:** Integer (milliseconds)
- **Default:** `1000`
- **Environment Variable:** `STREAM_BLOCK_TIME`
- **Description:** Block time for stream reads

### STREAM_MAX_RETRIES
- **Type:** Integer
- **Default:** `3`
- **Environment Variable:** `STREAM_MAX_RETRIES`
- **Description:** Maximum retries before moving to DLQ

### STREAM_CONSUMER_COUNT
- **Type:** Integer
- **Default:** `4`
- **Environment Variable:** `STREAM_CONSUMER_COUNT`
- **Description:** Number of concurrent stream consumers

### STREAM_CONSUMER_GROUP
- **Type:** String
- **Default:** `waddlebot-router`
- **Environment Variable:** `STREAM_CONSUMER_GROUP`
- **Description:** Consumer group name

### STREAM_CONSUMER_NAME
- **Type:** String
- **Default:** `router-{pid}`
- **Environment Variable:** `STREAM_CONSUMER_NAME`
- **Description:** Consumer name prefix

### Stream Names

| Variable | Default | Description |
|----------|---------|-------------|
| `STREAM_INBOUND` | `waddlebot:stream:events:inbound` | Inbound events |
| `STREAM_COMMANDS` | `waddlebot:stream:events:commands` | Parsed commands |
| `STREAM_ACTIONS` | `waddlebot:stream:events:actions` | Actions to execute |
| `STREAM_RESPONSES` | `waddlebot:stream:events:responses` | Module responses |

**Redis Streams Configuration Example:**
```env
STREAM_PIPELINE_ENABLED=true
STREAM_BATCH_SIZE=10
STREAM_BLOCK_TIME=1000
STREAM_MAX_RETRIES=3
STREAM_CONSUMER_COUNT=4
STREAM_CONSUMER_GROUP=waddlebot-router
STREAM_CONSUMER_NAME=router-12345
STREAM_INBOUND=waddlebot:stream:events:inbound
STREAM_COMMANDS=waddlebot:stream:events:commands
STREAM_ACTIONS=waddlebot:stream:events:actions
STREAM_RESPONSES=waddlebot:stream:events:responses
```

---

## Docker Configuration

### Dockerfile Configuration

**Location:** `/processing/router_module/Dockerfile`

**Build Command:**
```bash
docker build -f processing/router_module/Dockerfile -t waddlebot/router:latest .
```

**Key Features:**
- Base Image: `python:3.13-slim`
- Non-root user: `waddlebot`
- Hypercorn ASGI server with 4 workers
- Health check: `/healthz` endpoint every 30s
- Log directory: `/var/log/waddlebotlog`

**Exposed Port:** `8000`

**Health Check:**
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python3 /usr/local/bin/healthcheck.py http://localhost:8000/healthz
```

---

## Complete Example

### Development Environment

```env
# Basic Configuration
MODULE_PORT=8000
LOG_LEVEL=DEBUG
SECRET_KEY=dev-secret-key-change-in-production

# Database
DATABASE_URL=postgresql://waddlebot:password@localhost:5432/waddlebot
READ_REPLICA_URL=

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
SESSION_TTL=3600
SESSION_PREFIX=waddlebot:session:

# Performance
ROUTER_MAX_WORKERS=10
ROUTER_MAX_CONCURRENT=50
ROUTER_REQUEST_TIMEOUT=30
ROUTER_DEFAULT_RATE_LIMIT=60
ROUTER_COMMAND_CACHE_TTL=300
ROUTER_ENTITY_CACHE_TTL=600

# Module Integration
HUB_API_URL=http://localhost:8060
SERVICE_API_KEY=dev-service-key
REPUTATION_API_URL=http://localhost:8021
REPUTATION_ENABLED=true
WORKFLOW_CORE_URL=http://localhost:8070
BROWSER_SOURCE_URL=http://localhost:8050

# Translation
WADDLEAI_BASE_URL=http://localhost:8090
WADDLEAI_API_KEY=
WADDLEAI_MODEL=tinyllama
WADDLEAI_TEMPERATURE=0.7
WADDLEAI_MAX_TOKENS=500
WADDLEAI_TIMEOUT=30

# Emote APIs
BTTV_API_URL=https://api.betterttv.net/3
FFZ_API_URL=https://api.frankerfacez.com/v1
SEVENTV_API_URL=https://7tv.io/v3
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
EMOTE_CACHE_TTL_GLOBAL=2592000
EMOTE_CACHE_TTL_CHANNEL=86400
AI_DECISION_MAX_CALLS_PER_MESSAGE=3
AI_DECISION_TIMEOUT=2

# gRPC
GRPC_ENABLED=true
DISCORD_GRPC_HOST=localhost:50051
SLACK_GRPC_HOST=localhost:50052
TWITCH_GRPC_HOST=localhost:50053
YOUTUBE_GRPC_HOST=localhost:50054
REPUTATION_GRPC_HOST=localhost:50021
WORKFLOW_GRPC_HOST=localhost:50070
BROWSER_SOURCE_GRPC_HOST=localhost:50050
GRPC_KEEPALIVE_TIME_MS=30000
GRPC_KEEPALIVE_TIMEOUT_MS=10000
GRPC_MAX_RETRIES=3

# Redis Streams
STREAM_PIPELINE_ENABLED=false
STREAM_BATCH_SIZE=10
STREAM_BLOCK_TIME=1000
STREAM_MAX_RETRIES=3
STREAM_CONSUMER_COUNT=4
STREAM_CONSUMER_GROUP=waddlebot-router
```

### Production Environment

```env
# Basic Configuration
MODULE_PORT=8000
LOG_LEVEL=INFO
SECRET_KEY=${SECRET_KEY}  # From Kubernetes Secret

# Database
DATABASE_URL=${DATABASE_URL}  # From Kubernetes Secret
READ_REPLICA_URL=${READ_REPLICA_URL}  # From Kubernetes Secret

# Redis
REDIS_HOST=redis-cluster
REDIS_PORT=6379
REDIS_PASSWORD=${REDIS_PASSWORD}  # From Kubernetes Secret
REDIS_DB=0
SESSION_TTL=3600
SESSION_PREFIX=waddlebot:session:

# Performance (scaled for production)
ROUTER_MAX_WORKERS=20
ROUTER_MAX_CONCURRENT=100
ROUTER_REQUEST_TIMEOUT=30
ROUTER_DEFAULT_RATE_LIMIT=60
ROUTER_COMMAND_CACHE_TTL=300
ROUTER_ENTITY_CACHE_TTL=600

# Module Integration (internal service mesh)
HUB_API_URL=http://hub-module:8060
SERVICE_API_KEY=${SERVICE_API_KEY}  # From Kubernetes Secret
REPUTATION_API_URL=http://reputation:8021
REPUTATION_ENABLED=true
WORKFLOW_CORE_URL=http://workflow-core:8070
BROWSER_SOURCE_URL=http://browser-source:8050

# Translation
WADDLEAI_BASE_URL=http://waddleai-proxy:8090
WADDLEAI_API_KEY=${WADDLEAI_API_KEY}  # From Kubernetes Secret
WADDLEAI_MODEL=llama2
WADDLEAI_TEMPERATURE=0.7
WADDLEAI_MAX_TOKENS=500
WADDLEAI_TIMEOUT=30

# Emote APIs
BTTV_API_URL=https://api.betterttv.net/3
FFZ_API_URL=https://api.frankerfacez.com/v1
SEVENTV_API_URL=https://7tv.io/v3
TWITCH_CLIENT_ID=${TWITCH_CLIENT_ID}  # From Kubernetes Secret
TWITCH_CLIENT_SECRET=${TWITCH_CLIENT_SECRET}  # From Kubernetes Secret
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}  # From Kubernetes Secret
EMOTE_CACHE_TTL_GLOBAL=2592000
EMOTE_CACHE_TTL_CHANNEL=86400
AI_DECISION_MAX_CALLS_PER_MESSAGE=3
AI_DECISION_TIMEOUT=2

# gRPC (internal service mesh)
GRPC_ENABLED=true
DISCORD_GRPC_HOST=discord-action:50051
SLACK_GRPC_HOST=slack-action:50052
TWITCH_GRPC_HOST=twitch-action:50053
YOUTUBE_GRPC_HOST=youtube-action:50054
REPUTATION_GRPC_HOST=reputation:50021
WORKFLOW_GRPC_HOST=workflow-core:50070
BROWSER_SOURCE_GRPC_HOST=browser-source:50050
GRPC_KEEPALIVE_TIME_MS=30000
GRPC_KEEPALIVE_TIMEOUT_MS=10000
GRPC_MAX_RETRIES=3

# Redis Streams (enabled in production)
STREAM_PIPELINE_ENABLED=true
STREAM_BATCH_SIZE=10
STREAM_BLOCK_TIME=1000
STREAM_MAX_RETRIES=3
STREAM_CONSUMER_COUNT=4
STREAM_CONSUMER_GROUP=waddlebot-router
```

---

## Configuration Loading Order

1. **Default Values** in `config.py`
2. **Environment Variables** from shell
3. **.env File** via `python-dotenv`
4. **Kubernetes ConfigMaps** (if deployed)
5. **Kubernetes Secrets** (if deployed)

---

## Security Best Practices

### Secrets Management

**Never commit these to version control:**
- `SECRET_KEY`
- `DATABASE_URL`
- `REDIS_PASSWORD`
- `SERVICE_API_KEY`
- `AWS_SECRET_ACCESS_KEY`
- `OPENWHISK_AUTH_KEY`
- `WADDLEAI_API_KEY`
- `TWITCH_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN`

**Use Kubernetes Secrets:**
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: router-secrets
type: Opaque
data:
  secret-key: <base64-encoded>
  database-url: <base64-encoded>
  redis-password: <base64-encoded>
  service-api-key: <base64-encoded>
```

---

## Validation

### Configuration Validation Script

Create a validation script to check configuration:

```bash
#!/bin/bash
# validate-config.sh

echo "Validating Router Module Configuration..."

# Check required variables
REQUIRED_VARS=(
  "DATABASE_URL"
  "REDIS_HOST"
  "SECRET_KEY"
)

for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    echo "ERROR: $var is not set"
    exit 1
  fi
done

echo "✓ All required variables are set"

# Check database connection
python3 -c "
import psycopg2
import os
try:
    conn = psycopg2.connect(os.getenv('DATABASE_URL'))
    conn.close()
    print('✓ Database connection successful')
except Exception as e:
    print(f'ERROR: Database connection failed: {e}')
    exit(1)
"

# Check Redis connection
python3 -c "
import redis
import os
try:
    r = redis.Redis(
        host=os.getenv('REDIS_HOST'),
        port=int(os.getenv('REDIS_PORT', 6379)),
        password=os.getenv('REDIS_PASSWORD', ''),
        db=int(os.getenv('REDIS_DB', 0))
    )
    r.ping()
    print('✓ Redis connection successful')
except Exception as e:
    print(f'ERROR: Redis connection failed: {e}')
    exit(1)
"

echo "✓ Configuration validation complete"
```

---

## Troubleshooting Configuration Issues

### Database Connection Issues

**Problem:** `psycopg2.OperationalError: FATAL: password authentication failed`
**Solution:** Verify `DATABASE_URL` credentials and ensure database is accessible

### Redis Connection Issues

**Problem:** `redis.exceptions.ConnectionError: Error connecting to Redis`
**Solution:** Check `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASSWORD`

### gRPC Connection Issues

**Problem:** `grpc.aio.AioRpcError: StatusCode.UNAVAILABLE`
**Solution:** Verify gRPC host configuration and ensure target service is running

### Translation Not Working

**Problem:** Messages not being translated
**Solution:** Check `WADDLEAI_BASE_URL`, `WADDLEAI_API_KEY`, and ensure translation is enabled in community config

---

## See Also

- [API.md](./API.md) - API endpoints and request/response formats
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture and design
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues and solutions
