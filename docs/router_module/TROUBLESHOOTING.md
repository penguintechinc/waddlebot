# Router Module Troubleshooting Guide

## Overview

Common issues, error messages, and solutions for the Router Module.

**Version:** 2.0.0

---

## Table of Contents

1. [Connection Issues](#connection-issues)
2. [Performance Issues](#performance-issues)
3. [Translation Issues](#translation-issues)
4. [Command Processing Issues](#command-processing-issues)
5. [gRPC Issues](#grpc-issues)
6. [Redis Issues](#redis-issues)
7. [Database Issues](#database-issues)
8. [Deployment Issues](#deployment-issues)
9. [Error Reference](#error-reference)

---

## Connection Issues

### Cannot Connect to Router Module

**Symptoms:**
```
curl: (7) Failed to connect to localhost port 8000: Connection refused
```

**Possible Causes:**
1. Module not running
2. Wrong port configuration
3. Firewall blocking connections
4. Docker network issues

**Solutions:**

#### 1. Check if Module is Running

```bash
# Check Docker container
docker ps | grep router-module

# Check process
ps aux | grep router_module

# Check Kubernetes pod
kubectl get pods -l app=router-module
```

#### 2. Verify Port Configuration

```bash
# Check environment variable
echo $MODULE_PORT

# Check if port is in use
lsof -i :8000
netstat -tuln | grep 8000
```

#### 3. Check Health Endpoint

```bash
# From within the container/pod
curl http://localhost:8000/health

# From host
curl http://router-module:8000/health
```

#### 4. Check Logs

```bash
# Docker
docker logs router-module

# Kubernetes
kubectl logs -l app=router-module --tail=100

# Local
tail -f /var/log/waddlebotlog/router_module.log
```

**Expected Log on Startup:**
```
[INFO] Starting router module
[INFO] Connected to database: postgresql://...
[INFO] Connected to Redis: redis://...
[INFO] Initialized command registry
[INFO] Router module started successfully
```

---

### Timeout Errors

**Symptoms:**
```json
{
  "success": false,
  "error": "Request timeout"
}
```

**Possible Causes:**
1. Slow database queries
2. Module HTTP timeout
3. Network latency
4. gRPC timeout

**Solutions:**

#### 1. Increase Timeout

```env
# Increase HTTP timeout (default: 30s)
ROUTER_REQUEST_TIMEOUT=60
```

#### 2. Check Database Performance

```sql
-- Find slow queries
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;

-- Check active connections
SELECT count(*) FROM pg_stat_activity;
```

#### 3. Check Module Response Time

```bash
# Test module directly
time curl -X POST http://interaction-module:8000/api/v1/execute \
  -H "Content-Type: application/json" \
  -d '{"command": "!help", ...}'
```

#### 4. Monitor Network Latency

```bash
# Check network latency
ping interaction-module

# Trace route
traceroute interaction-module
```

---

## Performance Issues

### High Latency

**Symptoms:**
- Slow response times (> 500ms)
- Timeouts under load
- Queue backlog in Redis Streams

**Diagnostics:**

```bash
# Check router metrics
curl http://localhost:8000/api/v1/router/metrics

# Check Prometheus metrics
curl http://localhost:8000/metrics | grep router_request_duration
```

**Solutions:**

#### 1. Optimize Database Queries

```sql
-- Add missing indexes
CREATE INDEX idx_commands_lookup ON commands(command, community_id, is_active);
CREATE INDEX idx_community_servers_lookup ON community_servers(platform_server_id, is_active);
CREATE INDEX idx_translation_cache_langs ON translation_cache(source_lang, target_lang);
```

#### 2. Increase Cache TTL

```env
# Increase cache TTLs to reduce database load
ROUTER_COMMAND_CACHE_TTL=600    # 10 minutes (default: 5 min)
ROUTER_ENTITY_CACHE_TTL=1200    # 20 minutes (default: 10 min)
```

#### 3. Enable Read Replicas

```env
# Configure read replica for query distribution
READ_REPLICA_URL=postgresql://user:pass@replica:5432/waddlebot
```

#### 4. Increase Worker Count

```env
# Increase concurrent workers (adjust based on CPU cores)
ROUTER_MAX_WORKERS=40           # Default: 20
ROUTER_MAX_CONCURRENT=200       # Default: 100
```

#### 5. Scale Horizontally

```yaml
# Kubernetes: Scale to multiple instances
apiVersion: apps/v1
kind: Deployment
metadata:
  name: router-module
spec:
  replicas: 5  # Scale from 1 to 5
```

---

### High Memory Usage

**Symptoms:**
```
[WARNING] Memory usage: 85%
OOMKilled (Kubernetes)
```

**Diagnostics:**

```bash
# Check memory usage
docker stats router-module

# Kubernetes
kubectl top pod -l app=router-module
```

**Solutions:**

#### 1. Reduce Memory Cache Size

```python
# In translation_service.py
# Reduce LRU cache size
self._memory_cache = TTLCache(maxsize=500, ttl=3600)  # Default: 1000
```

#### 2. Clear Old Cache Entries

```sql
-- Clean up translation cache
SELECT cleanup_translation_cache();

-- Manual cleanup (entries with < 5 accesses, > 30 days old)
DELETE FROM translation_cache
WHERE access_count < 5
  AND last_accessed < NOW() - INTERVAL '30 days';
```

#### 3. Increase Memory Limits

```yaml
# Kubernetes
resources:
  limits:
    memory: "1Gi"  # Increase from 512Mi
  requests:
    memory: "512Mi"
```

#### 4. Monitor Memory Leaks

```python
# Add memory profiling
import tracemalloc

tracemalloc.start()
# ... run application ...
snapshot = tracemalloc.take_snapshot()
top_stats = snapshot.statistics('lineno')
for stat in top_stats[:10]:
    print(stat)
```

---

## Translation Issues

### Translations Not Working

**Symptoms:**
- Messages not being translated
- Translation result is `None`
- No captions appearing in browser source

**Diagnostics:**

```bash
# Check if translation is enabled for community
psql $DATABASE_URL -c "
  SELECT id, name, config->'translation' as translation_config
  FROM communities
  WHERE id = 123;
"
```

**Expected Config:**
```json
{
  "enabled": true,
  "default_language": "en",
  "min_words": 5,
  "confidence_threshold": 0.7
}
```

**Solutions:**

#### 1. Enable Translation

```sql
-- Enable translation for community
UPDATE communities
SET config = jsonb_set(
  COALESCE(config, '{}'::jsonb),
  '{translation}',
  '{"enabled": true, "default_language": "en", "min_words": 5}'::jsonb
)
WHERE id = 123;
```

#### 2. Check WaddleAI Connection

```bash
# Test WaddleAI endpoint
curl http://waddleai-proxy:8090/health

# Check API key
echo $WADDLEAI_API_KEY
```

#### 3. Lower Min Words Threshold

```sql
-- Reduce minimum word count
UPDATE communities
SET config = jsonb_set(
  config,
  '{translation,min_words}',
  '2'::jsonb
)
WHERE id = 123;
```

#### 4. Check Translation Logs

```bash
# Look for translation errors
docker logs router-module | grep -i translation

# Expected log:
# [INFO] Translation completed: es -> en via googletrans
```

---

### Emotes Not Preserved

**Symptoms:**
- Emotes translated instead of preserved
- Broken emotes in translated text

**Diagnostics:**

```bash
# Check emote cache
redis-cli GET "emotes:global:twitch:bttv"

# Check emote API connectivity
curl https://api.betterttv.net/3/cached/emotes/global
```

**Solutions:**

#### 1. Enable Emote Preservation

```sql
UPDATE communities
SET config = jsonb_set(
  config,
  '{translation,preprocessing,preserve_emotes}',
  'true'::jsonb
)
WHERE id = 123;
```

#### 2. Refresh Emote Cache

```bash
# Run emote refresh script
python processing/router_module/scripts/refresh_global_emotes.py
```

#### 3. Check Platform Configuration

```env
# Verify emote API URLs
BTTV_API_URL=https://api.betterttv.net/3
FFZ_API_URL=https://api.frankerfacez.com/v1
SEVENTV_API_URL=https://7tv.io/v3

# Verify Twitch credentials (for Twitch emotes)
TWITCH_CLIENT_ID=your-client-id
TWITCH_CLIENT_SECRET=your-secret
```

---

### Low Translation Confidence

**Symptoms:**
```
[DEBUG] Language detection confidence 0.45 below threshold 0.70
[DEBUG] Skipping translation: Low confidence
```

**Solutions:**

#### 1. Lower Confidence Threshold

```sql
UPDATE communities
SET config = jsonb_set(
  config,
  '{translation,confidence_threshold}',
  '0.5'::jsonb  -- Lower from 0.7 to 0.5
)
WHERE id = 123;
```

#### 2. Use Better Translation Provider

```sql
-- Configure Google Cloud API key (higher accuracy)
UPDATE communities
SET config = jsonb_set(
  config,
  '{translation,google_api_key_encrypted}',
  '"your-encrypted-api-key"'::jsonb
)
WHERE id = 123;
```

---

## Command Processing Issues

### Command Not Found

**Symptoms:**
```json
{
  "success": false,
  "error": "Unknown command: !test",
  "help_url": "/commands"
}
```

**Diagnostics:**

```sql
-- Check if command exists
SELECT * FROM commands
WHERE command = '!test'
  AND is_active = true;

-- Check for community-specific commands
SELECT * FROM commands
WHERE command = '!test'
  AND (community_id = 123 OR community_id IS NULL)
  AND is_active = true;
```

**Solutions:**

#### 1. Register Command

```sql
-- Register new command
INSERT INTO commands (
  command, module_name, description, category, is_enabled, is_active
) VALUES (
  '!test', 'test_module', 'Test command', 'testing', true, true
);
```

#### 2. Enable Command

```sql
-- Enable disabled command
UPDATE commands
SET is_enabled = true
WHERE command = '!test';
```

#### 3. Reload Command Registry

```bash
# Restart router module to reload commands
kubectl rollout restart deployment/router-module

# Or use hot reload API (if available)
curl -X POST http://localhost:8000/api/v1/admin/reload-commands \
  -H "X-Service-Key: your-api-key"
```

---

### Rate Limit Exceeded

**Symptoms:**
```json
{
  "success": false,
  "error": "Rate limit exceeded"
}
```

**Diagnostics:**

```bash
# Check rate limit in Redis
redis-cli GET "waddlebot:ratelimit:67890:!balance"
```

**Solutions:**

#### 1. Increase Rate Limit

```env
# Increase default rate limit (requests per minute)
ROUTER_DEFAULT_RATE_LIMIT=120  # Default: 60
```

#### 2. Adjust Command Cooldown

```sql
-- Reduce cooldown for specific command
UPDATE commands
SET cooldown_seconds = 5  -- Reduce from 10 to 5
WHERE command = '!balance';
```

#### 3. Clear Rate Limit

```bash
# Manually clear rate limit for user
redis-cli DEL "waddlebot:ratelimit:67890:!balance"
```

---

### Module Not Responding

**Symptoms:**
```json
{
  "success": false,
  "error": "Module did not respond"
}
```

**Diagnostics:**

```bash
# Check if interaction module is running
curl http://interaction-module:8000/health

# Check module URL in database
psql $DATABASE_URL -c "
  SELECT name, url, is_active
  FROM hub_modules
  WHERE name = 'economy_module';
"
```

**Solutions:**

#### 1. Verify Module is Running

```bash
# Check module health
curl http://economy-module:8000/health

# Check Kubernetes
kubectl get pods -l app=economy-module
```

#### 2. Update Module URL

```sql
-- Update module URL
UPDATE hub_modules
SET url = 'http://economy-module:8000'
WHERE name = 'economy_module';
```

#### 3. Check Network Connectivity

```bash
# From router container
docker exec router-module curl http://economy-module:8000/health

# From Kubernetes pod
kubectl exec -it router-module-xxx -- curl http://economy-module:8000/health
```

---

## gRPC Issues

### gRPC Connection Failed

**Symptoms:**
```
[WARNING] gRPC call failed, falling back to REST: StatusCode.UNAVAILABLE
```

**Diagnostics:**

```bash
# Check gRPC port
telnet reputation 50021

# Check gRPC health
grpcurl -plaintext reputation:50021 grpc.health.v1.Health/Check
```

**Solutions:**

#### 1. Verify gRPC Host Configuration

```env
# Check gRPC host settings
GRPC_ENABLED=true
REPUTATION_GRPC_HOST=reputation:50021
HUB_GRPC_HOST=hub:50060
```

#### 2. Check gRPC Service

```bash
# Verify service is listening on gRPC port
kubectl get svc reputation

# Expected output shows port 50021
NAME         TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)
reputation   ClusterIP   10.96.123.45    <none>        8021/TCP,50021/TCP
```

#### 3. Disable gRPC (Use REST Only)

```env
# Temporarily disable gRPC to use REST fallback
GRPC_ENABLED=false
```

#### 4. Increase gRPC Timeout

```env
# Increase keepalive timeout
GRPC_KEEPALIVE_TIME_MS=60000      # Default: 30000
GRPC_KEEPALIVE_TIMEOUT_MS=20000   # Default: 10000
```

---

### gRPC Deadline Exceeded

**Symptoms:**
```
[ERROR] gRPC call failed: StatusCode.DEADLINE_EXCEEDED
```

**Solutions:**

#### 1. Increase Call Timeout

```python
# In command_processor.py
await grpc_manager.call_with_retry(
    stub.RecordMessage,
    request,
    timeout=10.0  # Increase from 5.0 to 10.0
)
```

#### 2. Check Target Service Performance

```bash
# Check if target service is slow
time grpcurl -plaintext -d '{}' \
  reputation:50021 reputation.ReputationService/HealthCheck
```

---

## Redis Issues

### Cannot Connect to Redis

**Symptoms:**
```
[ERROR] Error connecting to Redis: Error 111 connecting to redis:6379. Connection refused.
```

**Diagnostics:**

```bash
# Check Redis connectivity
redis-cli ping

# Check Redis from router container
docker exec router-module redis-cli -h redis ping
```

**Solutions:**

#### 1. Verify Redis is Running

```bash
# Check Redis container
docker ps | grep redis

# Check Redis pod
kubectl get pods -l app=redis
```

#### 2. Check Redis Configuration

```env
# Verify Redis settings
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your-password  # If auth enabled
REDIS_DB=0
```

#### 3. Test Redis Connection

```bash
# Test connection with authentication
redis-cli -h redis -p 6379 -a your-password ping
```

---

### Redis Memory Full

**Symptoms:**
```
[ERROR] Redis error: OOM command not allowed when used memory > 'maxmemory'
```

**Solutions:**

#### 1. Increase Redis Memory

```yaml
# Docker Compose
redis:
  image: redis:7
  command: redis-server --maxmemory 2gb --maxmemory-policy allkeys-lru
```

#### 2. Clean Up Old Keys

```bash
# Find large keys
redis-cli --bigkeys

# Clean up old cache entries
redis-cli KEYS "translation:*" | head -1000 | xargs redis-cli DEL
```

#### 3. Adjust Eviction Policy

```bash
# Set LRU eviction policy
redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

---

## Database Issues

### Database Connection Failed

**Symptoms:**
```
[ERROR] psycopg2.OperationalError: FATAL: password authentication failed
```

**Solutions:**

#### 1. Verify Database Credentials

```bash
# Test connection manually
psql $DATABASE_URL

# Check connection string format
echo $DATABASE_URL
# Expected: postgresql://user:password@host:5432/database
```

#### 2. Check Database is Running

```bash
# Docker
docker ps | grep postgres

# Kubernetes
kubectl get pods -l app=postgres
```

#### 3. Check Network Connectivity

```bash
# Test database port
telnet postgres 5432

# From router container
docker exec router-module pg_isready -h postgres -p 5432
```

---

### Slow Database Queries

**Symptoms:**
- Timeouts on database operations
- High CPU usage on database server

**Diagnostics:**

```sql
-- Find slow queries
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;

-- Check for missing indexes
SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE tablename IN ('commands', 'translation_cache', 'community_servers');
```

**Solutions:**

#### 1. Add Missing Indexes

```sql
-- Create recommended indexes
CREATE INDEX CONCURRENTLY idx_commands_lookup
  ON commands(command, community_id, is_active);

CREATE INDEX CONCURRENTLY idx_translation_cache_access
  ON translation_cache(last_accessed, access_count);

CREATE INDEX CONCURRENTLY idx_community_servers_lookup
  ON community_servers(platform_server_id, is_active);
```

#### 2. Analyze Tables

```sql
-- Update table statistics
ANALYZE commands;
ANALYZE translation_cache;
ANALYZE community_servers;
```

#### 3. Vacuum Database

```sql
-- Vacuum to reclaim space
VACUUM ANALYZE;
```

---

## Deployment Issues

### Docker Build Fails

**Symptoms:**
```
ERROR: failed to solve: process "/bin/sh -c pip install -r requirements.txt" did not complete successfully
```

**Solutions:**

#### 1. Clear Docker Cache

```bash
# Build without cache
docker build --no-cache -f processing/router_module/Dockerfile \
  -t waddlebot/router:latest .
```

#### 2. Check Requirements File

```bash
# Verify requirements.txt
cat processing/router_module/requirements.txt
```

#### 3. Update Base Image

```dockerfile
# Update Python version in Dockerfile
FROM python:3.13-slim  # Ensure using latest stable
```

---

### Kubernetes Pod CrashLoopBackOff

**Symptoms:**
```
NAME                            READY   STATUS             RESTARTS
router-module-xxx               0/1     CrashLoopBackOff   5
```

**Diagnostics:**

```bash
# Check pod logs
kubectl logs router-module-xxx

# Check pod events
kubectl describe pod router-module-xxx

# Check previous instance logs
kubectl logs router-module-xxx --previous
```

**Common Causes:**

1. **Missing environment variables**
   ```bash
   # Check ConfigMap and Secrets
   kubectl get configmap router-config -o yaml
   kubectl get secret router-secrets -o yaml
   ```

2. **Database connection failed**
   ```bash
   # Check database connectivity
   kubectl run -it --rm debug --image=postgres:15 --restart=Never -- \
     psql $DATABASE_URL
   ```

3. **Port already in use**
   ```yaml
   # Change port in deployment
   env:
   - name: MODULE_PORT
     value: "8001"  # Change from 8000
   ```

---

## Error Reference

### Common Error Codes

| Status Code | Error | Meaning |
|-------------|-------|---------|
| 400 | `Validation error` | Invalid request format |
| 404 | `Unknown command` | Command not found in registry |
| 429 | `Rate limit exceeded` | Too many requests |
| 500 | `Module did not respond` | Interaction module timeout |
| 503 | `Service unavailable` | Database/Redis connection failed |

### Error Messages

#### "Community not found for this channel"

**Cause:** No community_servers mapping for entity_id

**Solution:**
```sql
-- Create community server mapping
INSERT INTO community_servers (
  community_id, platform, platform_server_id, is_active
) VALUES (
  123, 'twitch', '12345', true
);
```

#### "The 'X' module is disabled for this community"

**Cause:** Module disabled in module_installations

**Solution:**
```sql
-- Enable module
UPDATE module_installations
SET is_enabled = true
WHERE community_id = 123 AND module_id = 'economy_module';
```

#### "Command on cooldown. Wait X seconds."

**Cause:** Command cooldown not expired

**Solution:**
- Wait for cooldown to expire
- Or reduce cooldown in database:
```sql
UPDATE commands
SET cooldown_seconds = 5
WHERE command = '!daily';
```

---

## Debugging Tools

### Enable Debug Logging

```env
# Set log level to DEBUG
LOG_LEVEL=DEBUG
```

### Use Verbose API Test Script

```bash
# Run API tests with verbose output
VERBOSE=1 ./test-api.sh
```

### Monitor Redis Keys

```bash
# Watch Redis keys in real-time
redis-cli MONITOR

# List all keys with pattern
redis-cli KEYS "waddlebot:*"
```

### Database Query Logging

```sql
-- Enable query logging
ALTER SYSTEM SET log_statement = 'all';
SELECT pg_reload_conf();

-- View logs
tail -f /var/log/postgresql/postgresql-15-main.log
```

---

## Getting More Help

### Collect Diagnostic Information

```bash
#!/bin/bash
# diagnose.sh - Collect diagnostic information

echo "=== Router Module Diagnostics ==="

echo "1. Module Health:"
curl -s http://localhost:8000/health | jq

echo "2. Module Version:"
curl -s http://localhost:8000/health | jq '.data.version'

echo "3. Database Connection:"
psql $DATABASE_URL -c "SELECT version();"

echo "4. Redis Connection:"
redis-cli ping

echo "5. Recent Logs:"
docker logs router-module --tail=50

echo "6. Environment Variables:"
env | grep -E "(DATABASE_URL|REDIS_|GRPC_|MODULE_)" | sed 's/=.*/=***/'

echo "7. Resource Usage:"
docker stats router-module --no-stream

echo "=== Diagnostics Complete ==="
```

### Contact Support

Include in your support request:
- Output from `diagnose.sh`
- Error messages and stack traces
- Request/response examples
- Module version
- Deployment environment (Docker/Kubernetes)

---

## See Also

- [API.md](./API.md) - API reference
- [CONFIGURATION.md](./CONFIGURATION.md) - Configuration guide
- [TESTING.md](./TESTING.md) - Testing procedures
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
