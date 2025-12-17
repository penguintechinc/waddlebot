# Workflow Core Module - Configuration Guide

## Overview

This document describes all configuration options for the Workflow Core Module, including environment variables, database settings, execution limits, and deployment configuration.

**Module:** workflow_core_module
**Version:** 1.0.0

---

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Database Configuration](#database-configuration)
3. [Service Integration](#service-integration)
4. [Workflow Execution Settings](#workflow-execution-settings)
5. [Security Configuration](#security-configuration)
6. [Scheduler Configuration](#scheduler-configuration)
7. [Docker Configuration](#docker-configuration)
8. [Logging Configuration](#logging-configuration)
9. [Example Configurations](#example-configurations)

---

## Environment Variables

### Module Information

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MODULE_PORT` | integer | `8070` | HTTP/REST API port |
| `GRPC_PORT` | integer | `50070` | gRPC service port |

### Database Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DATABASE_URI` | string | `postgresql://waddlebot:password@localhost:5432/waddlebot` | Primary database connection URI |
| `READ_REPLICA_URIS` | string | `postgresql://waddlebot:password@localhost:5433/waddlebot` | Comma-separated read replica URIs |

**Example:**
```bash
DATABASE_URI=postgresql://user:pass@db-host:5432/waddlebot
READ_REPLICA_URIS=postgresql://user:pass@replica1:5432/waddlebot,postgresql://user:pass@replica2:5432/waddlebot
```

### Redis Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `REDIS_URL` | string | `redis://localhost:6379/0` | Redis connection URL for caching and sessions |

**Example:**
```bash
REDIS_URL=redis://:password@redis-host:6379/0
```

### Service Integration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ROUTER_URL` | string | `http://router-service:8000` | Router service URL for module execution |
| `LICENSE_SERVER_URL` | string | `https://license.penguintech.io` | License validation server URL |

### Feature Flags

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `RELEASE_MODE` | boolean | `false` | Enable release mode (stricter validation) |
| `FEATURE_WORKFLOWS_ENABLED` | boolean | `true` | Enable/disable workflow functionality |

### Security

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SECRET_KEY` | string | `change-me-in-production` | Secret key for JWT validation and encryption |
| `API_KEY` | string | `change-me-in-production` | API key for service-to-service authentication |

**WARNING:** Always change these values in production environments!

### Logging

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `LOG_DIR` | string | `/var/log/waddlebotlog` | Directory for log files |
| `LOG_LEVEL` | string | `INFO` | Logging level: `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |

### Scheduler (APScheduler)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SCHEDULER_TIMEZONE` | string | `UTC` | Timezone for scheduled workflows |
| `SCHEDULER_JOB_DEFAULTS_MAX_INSTANCES` | integer | `3` | Maximum concurrent instances per scheduled job |
| `SCHEDULER_JOB_DEFAULTS_COALESCE` | boolean | `true` | Combine missed runs into single execution |

### Workflow Execution Limits

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MAX_CONCURRENT_WORKFLOWS` | integer | `10` | Maximum concurrent workflow executions |
| `WORKFLOW_TIMEOUT_SECONDS` | integer | `300` | Default workflow execution timeout (5 minutes) |
| `WORKFLOW_MAX_RETRIES` | integer | `3` | Maximum retries for failed workflows |
| `MAX_LOOP_ITERATIONS` | integer | `100` | Maximum iterations per loop node |
| `MAX_TOTAL_OPERATIONS` | integer | `1000` | Maximum total node executions per workflow |
| `MAX_LOOP_DEPTH` | integer | `10` | Maximum nested loop depth |
| `MAX_PARALLEL_NODES` | integer | `10` | Maximum parallel node executions |

---

## Database Configuration

### Connection Pool Settings

The module uses PyDAL for database access. Connection pooling is managed automatically.

### Required Database Tables

The following tables must exist in the database:

#### workflows

```sql
CREATE TABLE workflows (
    workflow_id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    entity_id INTEGER NOT NULL,
    community_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    status VARCHAR(50) DEFAULT 'draft',
    version VARCHAR(20) DEFAULT '1.0.0',
    nodes JSONB NOT NULL,
    connections JSONB NOT NULL,
    global_variables JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    published_at TIMESTAMP,
    enabled BOOLEAN DEFAULT true
);
```

#### workflow_executions

```sql
CREATE TABLE workflow_executions (
    execution_id UUID PRIMARY KEY,
    workflow_id UUID NOT NULL REFERENCES workflows(workflow_id),
    status VARCHAR(50) NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    execution_time_seconds DECIMAL(10, 3),
    nodes_executed INTEGER DEFAULT 0,
    execution_path JSONB DEFAULT '[]',
    node_states JSONB DEFAULT '{}',
    final_variables JSONB DEFAULT '{}',
    final_output JSONB,
    error_message TEXT,
    error_node_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);
```

#### workflow_webhooks

```sql
CREATE TABLE workflow_webhooks (
    webhook_id UUID PRIMARY KEY,
    workflow_id UUID NOT NULL REFERENCES workflows(workflow_id),
    token VARCHAR(64) UNIQUE NOT NULL,
    secret VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    url VARCHAR(512),
    enabled BOOLEAN DEFAULT true,
    require_signature BOOLEAN DEFAULT true,
    ip_allowlist TEXT[],
    rate_limit_max INTEGER DEFAULT 60,
    rate_limit_window INTEGER DEFAULT 60,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_triggered_at TIMESTAMP,
    trigger_count INTEGER DEFAULT 0,
    last_execution_id UUID
);
```

#### workflow_permissions

```sql
CREATE TABLE workflow_permissions (
    permission_id SERIAL PRIMARY KEY,
    workflow_id UUID NOT NULL REFERENCES workflows(workflow_id),
    user_id INTEGER,
    role_id INTEGER,
    community_id INTEGER,
    can_view BOOLEAN DEFAULT false,
    can_edit BOOLEAN DEFAULT false,
    can_delete BOOLEAN DEFAULT false,
    can_execute BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);
```

#### workflow_schedules

```sql
CREATE TABLE workflow_schedules (
    schedule_id UUID PRIMARY KEY,
    workflow_id UUID NOT NULL REFERENCES workflows(workflow_id),
    name VARCHAR(255) NOT NULL,
    cron_expression VARCHAR(255) NOT NULL,
    enabled BOOLEAN DEFAULT true,
    timezone VARCHAR(50) DEFAULT 'UTC',
    last_run_at TIMESTAMP,
    next_run_at TIMESTAMP,
    run_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### Indexes

Recommended indexes for performance:

```sql
-- Workflow indexes
CREATE INDEX idx_workflows_entity_id ON workflows(entity_id);
CREATE INDEX idx_workflows_community_id ON workflows(community_id);
CREATE INDEX idx_workflows_status ON workflows(status);
CREATE INDEX idx_workflows_author_id ON workflows(author_id);

-- Execution indexes
CREATE INDEX idx_executions_workflow_id ON workflow_executions(workflow_id);
CREATE INDEX idx_executions_status ON workflow_executions(status);
CREATE INDEX idx_executions_start_time ON workflow_executions(start_time DESC);

-- Webhook indexes
CREATE INDEX idx_webhooks_workflow_id ON workflow_webhooks(workflow_id);
CREATE INDEX idx_webhooks_token ON workflow_webhooks(token);

-- Permission indexes
CREATE INDEX idx_permissions_workflow_id ON workflow_permissions(workflow_id);
CREATE INDEX idx_permissions_user_id ON workflow_permissions(user_id);
CREATE INDEX idx_permissions_community_id ON workflow_permissions(community_id);

-- Schedule indexes
CREATE INDEX idx_schedules_workflow_id ON workflow_schedules(workflow_id);
CREATE INDEX idx_schedules_next_run ON workflow_schedules(next_run_at) WHERE enabled = true;
```

---

## Service Integration

### Router Service

The workflow engine communicates with the Router Module to execute action nodes (modules, commands, etc.).

**Configuration:**
```bash
ROUTER_URL=http://router-service:8000
```

**Required Router Endpoints:**
- `POST /api/v1/modules/execute` - Execute module actions
- `POST /api/v1/commands/execute` - Execute command actions

### License Service

Validates workflow creation and execution against licenses.

**Configuration:**
```bash
LICENSE_SERVER_URL=https://license.penguintech.io
```

**License Features Checked:**
- `workflows` - Basic workflow creation
- `advanced_workflows` - Advanced node types
- `workflow_schedules` - Scheduled executions

---

## Workflow Execution Settings

### Timeout Configuration

Control how long workflows can run before timeout:

```bash
# Default workflow timeout (seconds)
WORKFLOW_TIMEOUT_SECONDS=300

# Per-workflow override in workflow definition:
# metadata.max_execution_time_seconds
```

### Concurrency Limits

Prevent resource exhaustion:

```bash
# Maximum concurrent workflow executions
MAX_CONCURRENT_WORKFLOWS=10

# Maximum parallel node executions within a workflow
MAX_PARALLEL_NODES=10
```

### Loop Protection

Prevent infinite loops and excessive iterations:

```bash
# Maximum iterations for loop nodes
MAX_LOOP_ITERATIONS=100

# Maximum total node executions per workflow
MAX_TOTAL_OPERATIONS=1000

# Maximum nested loop depth
MAX_LOOP_DEPTH=10
```

**Example:** A workflow with nested loops can execute at most:
- 100 iterations per loop
- 10 levels of nesting
- 1000 total node executions

### Retry Configuration

Configure automatic retry behavior:

```bash
# Maximum retries for failed workflows
WORKFLOW_MAX_RETRIES=3

# Per-workflow override in workflow definition:
# metadata.max_retries
# metadata.retry_failed_nodes
```

**Retry Strategy:**
- Exponential backoff: 2^retry_count seconds
- Retry 1: 2 seconds
- Retry 2: 4 seconds
- Retry 3: 8 seconds

---

## Security Configuration

### JWT Authentication

JWT tokens are validated using the secret key:

```bash
SECRET_KEY=your-256-bit-secret-key-here
```

**Token Requirements:**
- Algorithm: HS256
- Required claims: `user_id`
- Optional claims: `username`, `exp`

### API Key Authentication

Service-to-service authentication:

```bash
API_KEY=your-api-key-here
```

**Usage:**
```
X-API-Key: your-api-key-here
```

### Webhook Security

Webhooks support multiple security mechanisms:

#### HMAC Signature Verification

```python
import hmac
import hashlib

message = token.encode() + body_bytes
signature = 'sha256=' + hmac.new(
    secret.encode(),
    message,
    hashlib.sha256
).hexdigest()
```

#### IP Allowlist

Configure allowed IPs per webhook:

```json
{
  "ip_allowlist": [
    "192.168.1.0/24",
    "10.0.0.1",
    "2001:db8::/32"
  ]
}
```

Supports:
- Individual IPs: `192.168.1.1`
- CIDR notation: `192.168.1.0/24`
- IPv6: `2001:db8::/32`

#### Rate Limiting

Per-webhook rate limiting:

```json
{
  "rate_limit_max": 60,
  "rate_limit_window": 60
}
```

Default: 60 requests per 60 seconds

---

## Scheduler Configuration

### APScheduler Settings

The module uses APScheduler for scheduled workflow execution.

```bash
# Timezone for schedule evaluation
SCHEDULER_TIMEZONE=America/New_York

# Max concurrent instances of same scheduled job
SCHEDULER_JOB_DEFAULTS_MAX_INSTANCES=3

# Combine missed runs into one
SCHEDULER_JOB_DEFAULTS_COALESCE=true
```

### Cron Expression Format

Schedules use standard cron syntax:

```
* * * * *
│ │ │ │ │
│ │ │ │ └─── Day of week (0-6, Sunday=0)
│ │ │ └───── Month (1-12)
│ │ └─────── Day of month (1-31)
│ └───────── Hour (0-23)
└─────────── Minute (0-59)
```

**Examples:**
- Every hour: `0 * * * *`
- Every day at 9 AM: `0 9 * * *`
- Every Monday at 3 PM: `0 15 * * 1`
- Every 15 minutes: `*/15 * * * *`

---

## Docker Configuration

### Dockerfile

The module includes a production-ready Dockerfile:

```dockerfile
FROM python:3.13-slim

WORKDIR /app

# Copy shared library
COPY libs/flask_core /app/libs/flask_core
RUN cd /app/libs/flask_core && pip install --no-cache-dir .

# Copy module files
COPY core/workflow_core_module/requirements.txt /app/
COPY core/workflow_core_module /app/

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Create non-root user
RUN useradd -m -u 1000 waddlebot && \
    mkdir -p /var/log/waddlebotlog && \
    chown -R waddlebot:waddlebot /app /var/log/waddlebotlog

USER waddlebot

EXPOSE 8070

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python3 /usr/local/bin/healthcheck.py http://localhost:8070/health

# Run with Hypercorn
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8070", "--workers", "4"]
```

### Build Command

```bash
docker build -f core/workflow_core_module/Dockerfile -t waddlebot/workflow-core:latest .
```

### Docker Compose

```yaml
version: '3.8'

services:
  workflow-core:
    image: waddlebot/workflow-core:latest
    ports:
      - "8070:8070"
      - "50070:50070"
    environment:
      - DATABASE_URI=postgresql://waddlebot:password@postgres:5432/waddlebot
      - REDIS_URL=redis://redis:6379/0
      - ROUTER_URL=http://router-service:8000
      - SECRET_KEY=${SECRET_KEY}
      - LOG_LEVEL=INFO
      - MAX_CONCURRENT_WORKFLOWS=10
      - WORKFLOW_TIMEOUT_SECONDS=300
    volumes:
      - ./logs:/var/log/waddlebotlog
    depends_on:
      - postgres
      - redis
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "python3", "/usr/local/bin/healthcheck.py", "http://localhost:8070/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
```

---

## Logging Configuration

### Log Levels

```bash
# Set log level
LOG_LEVEL=INFO
```

Available levels:
- `DEBUG` - Detailed debug information
- `INFO` - General informational messages
- `WARNING` - Warning messages
- `ERROR` - Error messages
- `CRITICAL` - Critical errors only

### Log Directory

```bash
# Directory for log files
LOG_DIR=/var/log/waddlebotlog
```

**Permissions:**
```bash
mkdir -p /var/log/waddlebotlog
chown waddlebot:waddlebot /var/log/waddlebotlog
chmod 755 /var/log/waddlebotlog
```

### Log Format

The module uses AAA (Authentication, Authorization, Audit) logging format:

```json
{
  "timestamp": "2025-12-16T12:00:00Z",
  "level": "INFO",
  "module": "workflow_core_module",
  "event_type": "AUDIT",
  "action": "workflow_execute_start",
  "user": "123",
  "workflow_id": "uuid",
  "execution_id": "uuid",
  "result": "SUCCESS",
  "message": "Workflow execution started"
}
```

### Log Rotation

Recommended logrotate configuration:

```
/var/log/waddlebotlog/*.log {
    daily
    rotate 30
    compress
    delaycompress
    notifempty
    create 0644 waddlebot waddlebot
    sharedscripts
    postrotate
        systemctl reload workflow-core || true
    endscript
}
```

---

## Example Configurations

### Development Environment

```bash
# .env.development
MODULE_PORT=8070
GRPC_PORT=50070

DATABASE_URI=postgresql://waddlebot:password@localhost:5432/waddlebot
REDIS_URL=redis://localhost:6379/0
ROUTER_URL=http://localhost:8000

SECRET_KEY=dev-secret-key-not-for-production
API_KEY=dev-api-key

LOG_LEVEL=DEBUG
LOG_DIR=./logs

RELEASE_MODE=false
FEATURE_WORKFLOWS_ENABLED=true

MAX_CONCURRENT_WORKFLOWS=5
WORKFLOW_TIMEOUT_SECONDS=60
MAX_LOOP_ITERATIONS=50
MAX_PARALLEL_NODES=5
```

### Production Environment

```bash
# .env.production
MODULE_PORT=8070
GRPC_PORT=50070

DATABASE_URI=postgresql://waddlebot:${DB_PASSWORD}@postgres-primary:5432/waddlebot
READ_REPLICA_URIS=postgresql://waddlebot:${DB_PASSWORD}@postgres-replica1:5432/waddlebot,postgresql://waddlebot:${DB_PASSWORD}@postgres-replica2:5432/waddlebot
REDIS_URL=redis://:${REDIS_PASSWORD}@redis-cluster:6379/0
ROUTER_URL=http://router-service:8000

LICENSE_SERVER_URL=https://license.penguintech.io

SECRET_KEY=${SECRET_KEY}
API_KEY=${API_KEY}

LOG_LEVEL=INFO
LOG_DIR=/var/log/waddlebotlog

RELEASE_MODE=true
FEATURE_WORKFLOWS_ENABLED=true

SCHEDULER_TIMEZONE=UTC

MAX_CONCURRENT_WORKFLOWS=50
WORKFLOW_TIMEOUT_SECONDS=300
WORKFLOW_MAX_RETRIES=3
MAX_LOOP_ITERATIONS=100
MAX_TOTAL_OPERATIONS=1000
MAX_LOOP_DEPTH=10
MAX_PARALLEL_NODES=10
```

### Kubernetes ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-core-config
data:
  MODULE_PORT: "8070"
  GRPC_PORT: "50070"
  ROUTER_URL: "http://router-service:8000"
  LOG_LEVEL: "INFO"
  LOG_DIR: "/var/log/waddlebotlog"
  RELEASE_MODE: "true"
  FEATURE_WORKFLOWS_ENABLED: "true"
  MAX_CONCURRENT_WORKFLOWS: "50"
  WORKFLOW_TIMEOUT_SECONDS: "300"
  MAX_LOOP_ITERATIONS: "100"
  MAX_TOTAL_OPERATIONS: "1000"
  MAX_LOOP_DEPTH: "10"
  MAX_PARALLEL_NODES: "10"
  SCHEDULER_TIMEZONE: "UTC"
  SCHEDULER_JOB_DEFAULTS_MAX_INSTANCES: "3"
  SCHEDULER_JOB_DEFAULTS_COALESCE: "true"
```

### Kubernetes Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: workflow-core-secrets
type: Opaque
stringData:
  DATABASE_URI: postgresql://waddlebot:PASSWORD@postgres:5432/waddlebot
  REDIS_URL: redis://:PASSWORD@redis:6379/0
  SECRET_KEY: your-secret-key-here
  API_KEY: your-api-key-here
```

---

## Configuration Validation

The module validates configuration on startup:

### Required Variables

The following must be set:
- `DATABASE_URI`
- `SECRET_KEY` (in production)

### Warnings

The module will log warnings for:
- Using default SECRET_KEY
- Using default API_KEY
- RELEASE_MODE=false in production
- Overly permissive execution limits

---

## Performance Tuning

### Database

```bash
# Use read replicas for list/query operations
READ_REPLICA_URIS=postgresql://...

# Optimize connection pool
# (configured in PyDAL automatically)
```

### Redis

```bash
# Use Redis for:
# - License caching
# - Session storage
# - Rate limiting state

REDIS_URL=redis://redis-cluster:6379/0
```

### Concurrency

```bash
# Balance between throughput and resource usage
MAX_CONCURRENT_WORKFLOWS=50
MAX_PARALLEL_NODES=10

# Hypercorn workers (in Dockerfile CMD)
CMD ["hypercorn", "app:app", "--workers", "4"]
```

### Execution Limits

```bash
# Prevent runaway workflows
WORKFLOW_TIMEOUT_SECONDS=300
MAX_LOOP_ITERATIONS=100
MAX_TOTAL_OPERATIONS=1000
```

---

## Troubleshooting

### Common Configuration Issues

#### Database Connection Failed

**Symptom:** `Failed to connect to database`

**Solutions:**
- Verify `DATABASE_URI` format
- Check network connectivity to database
- Verify credentials
- Ensure database exists

#### Redis Connection Failed

**Symptom:** `Failed to connect to Redis`

**Solutions:**
- Verify `REDIS_URL` format
- Check Redis server is running
- Verify authentication if required

#### Port Already in Use

**Symptom:** `Address already in use`

**Solutions:**
- Change `MODULE_PORT` or `GRPC_PORT`
- Kill process using the port
- Use Docker port mapping

#### Permission Denied (Logs)

**Symptom:** `Permission denied: /var/log/waddlebotlog`

**Solutions:**
```bash
mkdir -p /var/log/waddlebotlog
chown -R waddlebot:waddlebot /var/log/waddlebotlog
chmod 755 /var/log/waddlebotlog
```
