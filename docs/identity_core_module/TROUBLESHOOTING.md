# Identity Core Module - Troubleshooting Guide

## Overview

This guide provides solutions to common issues encountered when deploying, configuring, and using the Identity Core Module.

---

## Table of Contents

1. [Service Won't Start](#service-wont-start)
2. [Database Connection Issues](#database-connection-issues)
3. [Authentication Problems](#authentication-problems)
4. [Platform Linking Failures](#platform-linking-failures)
5. [gRPC Service Issues](#grpc-service-issues)
6. [Performance Issues](#performance-issues)
7. [Docker & Deployment](#docker--deployment)
8. [API Errors](#api-errors)
9. [Logging & Debugging](#logging--debugging)
10. [Common Error Messages](#common-error-messages)

---

## Service Won't Start

### Issue: Module fails to start with import error

**Error Message:**
```
ModuleNotFoundError: No module named 'flask_core'
```

**Cause:** Shared library not installed

**Solution:**
```bash
# Install shared library
cd /home/penguin/code/WaddleBot/libs/flask_core
pip install .

# Verify installation
python3 -c "import flask_core; print('OK')"
```

---

### Issue: Port already in use

**Error Message:**
```
OSError: [Errno 98] Address already in use: 0.0.0.0:8050
```

**Cause:** Another service is using port 8050 or 50030

**Solution 1 - Change Port:**
```bash
# Edit .env file
MODULE_PORT=8051
GRPC_PORT=50031

# Restart service
```

**Solution 2 - Kill Conflicting Process:**
```bash
# Find process using port 8050
lsof -ti:8050

# Kill the process
kill -9 $(lsof -ti:8050)

# For gRPC port
kill -9 $(lsof -ti:50030)
```

---

### Issue: Missing environment variables

**Error Message:**
```
AssertionError: DATABASE_URL must be set
```

**Cause:** Required environment variables not configured

**Solution:**
```bash
# Create .env file
cat > .env << EOF
MODULE_PORT=8050
GRPC_PORT=50030
DATABASE_URL=postgresql://waddlebot:password@localhost:5432/waddlebot
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
LOG_LEVEL=INFO
EOF

# Verify configuration
python3 -c "from config import Config; print(Config.DATABASE_URL)"
```

---

### Issue: Python version incompatibility

**Error Message:**
```
SyntaxError: invalid syntax
```

**Cause:** Python version < 3.10

**Solution:**
```bash
# Check Python version
python3 --version

# Install Python 3.13
sudo apt update
sudo apt install python3.13 python3.13-venv

# Create virtual environment with correct Python
python3.13 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

---

## Database Connection Issues

### Issue: Cannot connect to database

**Error Message:**
```
psycopg2.OperationalError: could not connect to server: Connection refused
```

**Diagnostic Steps:**
```bash
# 1. Check if PostgreSQL is running
sudo systemctl status postgresql

# 2. Check database exists
psql -U waddlebot -d waddlebot -c "SELECT 1"

# 3. Test connection string
psql "postgresql://waddlebot:password@localhost:5432/waddlebot"

# 4. Check network connectivity (if remote database)
telnet postgres-host 5432
```

**Solution 1 - Start PostgreSQL:**
```bash
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

**Solution 2 - Create Database:**
```bash
# Connect as postgres user
sudo -u postgres psql

# Create database and user
CREATE DATABASE waddlebot;
CREATE USER waddlebot WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE waddlebot TO waddlebot;
\q
```

**Solution 3 - Fix Connection String:**
```bash
# Verify format: postgresql://user:password@host:port/database
DATABASE_URL=postgresql://waddlebot:correct_password@localhost:5432/waddlebot
```

---

### Issue: Database schema not initialized

**Error Message:**
```
psycopg2.errors.UndefinedTable: relation "hub_users" does not exist
```

**Cause:** Database migrations not applied

**Solution:**
```bash
# Run initialization script
psql -U waddlebot -d waddlebot -f /home/penguin/code/WaddleBot/config/postgres/init.sql

# Run migrations
psql -U waddlebot -d waddlebot -f /home/penguin/code/WaddleBot/config/postgres/migrations/001_add_performance_indexes.sql

# Verify tables exist
psql -U waddlebot -d waddlebot -c "\dt"
```

---

### Issue: Connection pool exhausted

**Error Message:**
```
sqlalchemy.exc.TimeoutError: QueuePool limit of size 10 overflow 20 reached
```

**Cause:** Too many concurrent database connections

**Solution 1 - Increase Pool Size:**
```python
# In flask_core configuration
pool_size = 20
max_overflow = 40
```

**Solution 2 - Check for Connection Leaks:**
```bash
# Monitor active connections
psql -U waddlebot -d waddlebot -c "
SELECT count(*), state
FROM pg_stat_activity
WHERE datname = 'waddlebot'
GROUP BY state;
"

# Kill idle connections
psql -U waddlebot -d waddlebot -c "
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'waddlebot'
  AND state = 'idle'
  AND state_change < now() - interval '10 minutes';
"
```

---

### Issue: Slow database queries

**Symptom:** API responses taking > 1 second

**Diagnostic:**
```sql
-- Enable query logging
ALTER DATABASE waddlebot SET log_min_duration_statement = 100;

-- Check slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Check missing indexes
SELECT schemaname, tablename, attname, n_distinct, correlation
FROM pg_stats
WHERE schemaname = 'public'
  AND tablename IN ('hub_users', 'hub_user_identities')
ORDER BY abs(correlation) DESC;
```

**Solution:**
```bash
# Ensure indexes are created
psql -U waddlebot -d waddlebot -f config/postgres/migrations/001_add_performance_indexes.sql

# Analyze tables
psql -U waddlebot -d waddlebot -c "
ANALYZE hub_users;
ANALYZE hub_user_identities;
ANALYZE hub_sessions;
"

# Vacuum if needed
psql -U waddlebot -d waddlebot -c "VACUUM ANALYZE;"
```

---

## Authentication Problems

### Issue: Login returns 401 Unauthorized

**Error Message:**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid credentials"
  }
}
```

**Diagnostic Steps:**
```bash
# 1. Verify user exists
curl -X GET http://localhost:8050/api/v1/status

# 2. Check credentials
# Try registering new user first
curl -X POST http://localhost:8050/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "debug@example.com",
    "password": "DebugPass123!",
    "username": "debuguser"
  }'

# 3. Try login with new credentials
curl -X POST http://localhost:8050/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "debug@example.com",
    "password": "DebugPass123!"
  }'
```

**Common Causes:**
1. Incorrect password
2. Email not registered
3. Account not active
4. Password hash mismatch (database corruption)

---

### Issue: Token expired error

**Error Message:**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Token expired"
  }
}
```

**Cause:** JWT token past expiration time

**Solution:**
```bash
# Login again to get new token
curl -X POST http://localhost:8050/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "YourPassword123!"
  }'

# Extract token from response
TOKEN=$(curl -s -X POST http://localhost:8050/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"YourPassword123!"}' \
  | jq -r '.token')

# Use new token
curl -H "Authorization: Bearer $TOKEN" http://localhost:8050/auth/profile
```

---

### Issue: API key not working

**Error Message:**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```

**Diagnostic:**
```bash
# Verify API key format (should start with "wbt_")
echo "wbt_1234567890abcdef1234567890abcdef"

# Check header format
curl -v -H "X-API-Key: wbt_your_key_here" http://localhost:8050/api/v1/status
```

**Common Issues:**
1. API key expired
2. API key revoked
3. Wrong header name (should be `X-API-Key`)
4. Extra whitespace in key
5. Key not created yet

**Solution:**
```bash
# Create new API key
TOKEN=$(curl -s -X POST http://localhost:8050/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"Pass123!"}' \
  | jq -r '.token')

API_KEY=$(curl -s -X POST http://localhost:8050/identity/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Debug Key","expires_in_days":30}' \
  | jq -r '.api_key')

# Test new key
curl -H "X-API-Key: $API_KEY" http://localhost:8050/api/v1/status
```

---

### Issue: SECRET_KEY validation error

**Error Message:**
```
AssertionError: SECRET_KEY must be changed for production
```

**Cause:** Using default SECRET_KEY value

**Solution:**
```bash
# Generate secure key
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")

# Add to .env
echo "SECRET_KEY=$SECRET_KEY" >> .env

# Or export directly
export SECRET_KEY=$SECRET_KEY

# Restart service
```

---

## Platform Linking Failures

### Issue: Verification code expired

**Error Message:**
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Verification code not found or expired"
  }
}
```

**Cause:** More than 1 hour elapsed since code generation

**Solution:**
```bash
# Request new verification code
curl -X POST http://localhost:8050/identity/resend \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "verification_id": "ver_abc123"
  }'
```

---

### Issue: Platform identity already linked

**Error Message:**
```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Platform identity already linked to another account"
  }
}
```

**Cause:** Platform ID already associated with different hub user

**Diagnostic:**
```bash
# Check which user has the identity
curl -X GET "http://localhost:8050/identity/platform/twitch/123456789" \
  -H "X-API-Key: $API_KEY"
```

**Solution:**
```bash
# Option 1: Unlink from other account first
curl -X DELETE http://localhost:8050/identity/unlink \
  -H "Authorization: Bearer $OTHER_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "twitch",
    "platform_id": "123456789"
  }'

# Option 2: Contact support to merge accounts
```

---

### Issue: Platform not supported

**Error Message:**
```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Platform not supported"
  }
}
```

**Cause:** Unsupported platform name

**Supported Platforms:**
- `twitch`
- `discord`
- `youtube`
- `kick`
- `tiktok`

**Solution:**
```bash
# Use correct platform name (lowercase)
curl -X POST http://localhost:8050/identity/link \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "twitch",
    "platform_id": "123456789",
    "platform_username": "streamername"
  }'
```

---

## gRPC Service Issues

### Issue: gRPC server not starting

**Error Message:**
```
Failed to initialize gRPC server: [Errno 98] Address already in use
```

**Diagnostic:**
```bash
# Check if port 50030 is in use
lsof -i:50030

# Check gRPC port configuration
grep GRPC_PORT .env
```

**Solution:**
```bash
# Option 1: Change port
echo "GRPC_PORT=50031" >> .env

# Option 2: Kill process using port
kill -9 $(lsof -ti:50030)

# Restart service
```

---

### Issue: grpcurl connection refused

**Error Message:**
```
Failed to dial target host "localhost:50030": context deadline exceeded
```

**Diagnostic:**
```bash
# Check if gRPC server is running
curl http://localhost:8050/health | jq '.grpc_server'

# Check port is listening
netstat -tulpn | grep 50030

# Check logs
tail -f /var/log/waddlebotlog/identity-core.log | grep gRPC
```

**Solution:**
```bash
# Verify gRPC port in logs
# Should see: "gRPC server started on 0.0.0.0:50030"

# If not running, check app startup
python3 app.py
```

---

### Issue: Proto file not found

**Error Message:**
```
grpcurl: proto file not found
```

**Solution:**
```bash
# Use absolute path to proto file
grpcurl -plaintext \
  -proto /home/penguin/code/WaddleBot/libs/grpc_protos/identity.proto \
  localhost:50030 \
  list

# Or run from proto directory
cd /home/penguin/code/WaddleBot/libs/grpc_protos
grpcurl -plaintext -proto identity.proto localhost:50030 list
```

---

### Issue: gRPC returns placeholder data

**Symptom:** All gRPC responses return test data

**Cause:** Database integration not complete (TODO items in code)

**Workaround:**
```python
# This is expected in current version
# gRPC servicer methods have TODO comments for database integration
# Use REST API for production until gRPC database integration is complete
```

**Track Progress:**
```bash
# Check for TODO comments
grep -r "TODO" services/grpc_handler.py
```

---

## Performance Issues

### Issue: Slow API response times

**Symptom:** Requests taking > 1 second

**Diagnostic:**
```bash
# Measure response time
time curl http://localhost:8050/health

# Check worker count
ps aux | grep hypercorn | wc -l

# Check system resources
top
htop
```

**Solutions:**

**1. Increase Workers:**
```bash
# Edit Dockerfile or startup command
hypercorn app:app --bind 0.0.0.0:8050 --workers 8
```

**2. Database Connection Pool:**
```python
# Increase pool size in flask_core configuration
pool_size = 20
max_overflow = 40
```

**3. Enable Caching:**
```python
# Implement Redis caching for identity lookups
# (Planned for future version)
```

**4. Check Database Indexes:**
```sql
-- Verify indexes exist
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('hub_users', 'hub_user_identities');
```

---

### Issue: High memory usage

**Symptom:** Container using > 1GB RAM

**Diagnostic:**
```bash
# Check memory usage
docker stats waddlebot-identity-core

# Python memory profiling
pip install memory_profiler
python -m memory_profiler app.py
```

**Solutions:**

**1. Limit Worker Count:**
```bash
# Reduce workers if memory constrained
hypercorn app:app --bind 0.0.0.0:8050 --workers 2
```

**2. Set Container Memory Limit:**
```yaml
# docker-compose.yml
services:
  identity-core:
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M
```

---

### Issue: High CPU usage

**Diagnostic:**
```bash
# Check CPU usage per process
top -p $(pgrep -d',' -f identity)

# Profile Python code
pip install py-spy
py-spy top --pid $(pgrep -f "hypercorn.*identity")
```

**Solutions:**

**1. Check for Infinite Loops:**
```bash
# Review logs for repeated errors
tail -f /var/log/waddlebotlog/identity-core.log
```

**2. Optimize Database Queries:**
```sql
-- Check query execution plans
EXPLAIN ANALYZE
SELECT * FROM hub_user_identities
WHERE platform = 'twitch' AND platform_user_id = '123';
```

---

## Docker & Deployment

### Issue: Docker build fails

**Error Message:**
```
ERROR [stage-1 3/8] COPY libs/flask_core /app/libs/flask_core
COPY failed: file not found in build context
```

**Cause:** Building from wrong directory

**Solution:**
```bash
# Build from parent directory (to access libs/)
cd /home/penguin/code/WaddleBot
docker build -f core/identity_core_module/Dockerfile \
  -t waddlebot/identity-core:latest .

# NOT from module directory
```

---

### Issue: Container exits immediately

**Diagnostic:**
```bash
# Check container logs
docker logs waddlebot-identity-core

# Check container status
docker ps -a | grep identity-core

# Run interactively to debug
docker run -it --rm \
  -e DATABASE_URL=postgresql://... \
  waddlebot/identity-core:latest \
  /bin/bash
```

**Common Causes:**
1. Missing environment variables
2. Database not accessible
3. Port conflict
4. Permission issues

---

### Issue: Health check failing in Docker

**Error Message:**
```
Health check failed: Connection refused
```

**Diagnostic:**
```bash
# Check if service is listening inside container
docker exec waddlebot-identity-core netstat -tulpn

# Test health endpoint from inside container
docker exec waddlebot-identity-core curl http://localhost:8050/health
```

**Solution:**
```yaml
# Fix healthcheck in docker-compose.yml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8050/healthz"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 40s  # Increase if startup is slow
```

---

### Issue: Permission denied for log directory

**Error Message:**
```
PermissionError: [Errno 13] Permission denied: '/var/log/waddlebotlog/identity-core.log'
```

**Cause:** Container running as non-root, log directory not writable

**Solution:**
```dockerfile
# In Dockerfile, ensure permissions are set
RUN mkdir -p /var/log/waddlebotlog
RUN chown -R waddlebot:waddlebot /var/log/waddlebotlog

# Or mount volume with correct permissions
docker run -v identity-logs:/var/log/waddlebotlog ...
```

---

## API Errors

### Issue: 400 Bad Request

**Common Causes:**

**1. Invalid JSON:**
```bash
# Wrong (single quotes)
curl -d '{'email':'test@example.com'}'

# Correct (double quotes)
curl -d '{"email":"test@example.com"}'
```

**2. Missing Required Fields:**
```bash
# Wrong (missing password)
curl -d '{"email":"test@example.com"}'

# Correct
curl -d '{"email":"test@example.com","password":"Pass123!"}'
```

**3. Invalid Field Values:**
```bash
# Wrong (invalid email format)
curl -d '{"email":"notanemail","password":"Pass123!"}'

# Correct
curl -d '{"email":"valid@example.com","password":"Pass123!"}'
```

---

### Issue: 404 Not Found

**Common Causes:**

**1. Wrong Endpoint:**
```bash
# Wrong
curl http://localhost:8050/identities/user/42

# Correct
curl http://localhost:8050/identity/user/42
```

**2. Missing URL Prefix:**
```bash
# Wrong (missing /api/v1)
curl http://localhost:8050/status

# Correct
curl http://localhost:8050/api/v1/status
```

---

### Issue: 429 Too Many Requests

**Error Message:**
```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests"
  }
}
```

**Cause:** Exceeded rate limit (100 requests/minute)

**Solution:**
```bash
# Wait for rate limit reset
# Check headers for reset time
curl -i http://localhost:8050/health | grep X-RateLimit

# Implement exponential backoff in client code
```

---

### Issue: 500 Internal Server Error

**Diagnostic:**
```bash
# Check logs for stack trace
tail -50 /var/log/waddlebotlog/identity-core.log

# Check application logs
docker logs waddlebot-identity-core

# Enable debug logging
export LOG_LEVEL=DEBUG
```

**Common Causes:**
1. Database connection lost
2. Unhandled exception in code
3. Corrupted data
4. Out of memory

---

## Logging & Debugging

### Enable Debug Logging

```bash
# Set log level to DEBUG
export LOG_LEVEL=DEBUG

# Restart service
systemctl restart identity-core

# Or in .env file
echo "LOG_LEVEL=DEBUG" >> .env
```

### View Real-time Logs

```bash
# Tail log file
tail -f /var/log/waddlebotlog/identity-core.log

# Docker logs
docker logs -f waddlebot-identity-core

# Filter for errors only
tail -f /var/log/waddlebotlog/identity-core.log | grep ERROR

# Filter for specific user
tail -f /var/log/waddlebotlog/identity-core.log | grep "user_id.*42"
```

### Log Format

```json
{
  "timestamp": "2025-12-16T10:30:00.123Z",
  "level": "INFO",
  "module": "identity_core_module",
  "version": "2.0.0",
  "type": "AUTH",
  "user_id": 42,
  "action": "login",
  "platform": "twitch",
  "result": "SUCCESS",
  "duration_ms": 45,
  "context": {}
}
```

### Common Log Messages

**Successful Startup:**
```
[SYSTEM] Starting identity_core_module
[SYSTEM] Database initialized
[SYSTEM] gRPC server started on 0.0.0.0:50030
[SYSTEM] identity_core_module started - SUCCESS
```

**Authentication Success:**
```
[AUTH] user_id=42 action=login platform=local result=SUCCESS
```

**Authentication Failure:**
```
[AUTH] email=user@example.com action=login result=FAILED reason=invalid_credentials
```

**Identity Linking:**
```
[AUTHZ] user_id=42 action=link_identity platform=twitch result=ALLOWED
[INFO] Verification code generated: user_id=42 platform=twitch code=ABCD-1234
```

---

## Common Error Messages

### Error Reference Table

| Error Code | HTTP Status | Common Cause | Solution |
|------------|-------------|--------------|----------|
| INVALID_REQUEST | 400 | Malformed JSON, missing fields | Validate request body |
| UNAUTHORIZED | 401 | Invalid/expired token | Re-login or refresh token |
| FORBIDDEN | 403 | Insufficient permissions | Check user role/permissions |
| NOT_FOUND | 404 | Resource doesn't exist | Verify ID/endpoint |
| CONFLICT | 409 | Resource already exists | Check for duplicates |
| RATE_LIMITED | 429 | Too many requests | Implement backoff |
| INTERNAL_ERROR | 500 | Server error | Check logs |
| SERVICE_UNAVAILABLE | 503 | Database down, service offline | Check dependencies |

---

## Getting Help

### Before Asking for Help

1. **Check Logs:**
   ```bash
   tail -100 /var/log/waddlebotlog/identity-core.log
   ```

2. **Verify Configuration:**
   ```bash
   python3 -c "from config import Config; print(Config.__dict__)"
   ```

3. **Test Health Endpoint:**
   ```bash
   curl http://localhost:8050/health
   ```

4. **Check Service Status:**
   ```bash
   systemctl status identity-core
   # or
   docker ps | grep identity
   ```

### Information to Provide

When reporting issues, include:

1. **Version:** 2.0.0
2. **Environment:** Development/Staging/Production
3. **Deployment Method:** Docker/SystemD/Manual
4. **Error Message:** Full error text
5. **Logs:** Last 50-100 lines
6. **Steps to Reproduce:** Exact commands/requests
7. **Expected Behavior:** What should happen
8. **Actual Behavior:** What actually happens

### Support Channels

- **Documentation:** `/home/penguin/code/WaddleBot/docs/identity_core_module/`
- **Source Code:** `/home/penguin/code/WaddleBot/core/identity_core_module/`
- **Issue Tracker:** GitHub Issues
- **Community:** Discord #support channel

---

## Appendix: Diagnostic Commands

### Quick Health Check Script

```bash
#!/bin/bash
# health-check.sh

echo "=== Identity Core Module Health Check ==="
echo ""

echo "1. Service Status:"
systemctl status identity-core 2>/dev/null || docker ps | grep identity

echo ""
echo "2. Port Status:"
netstat -tulpn | grep -E "8050|50030"

echo ""
echo "3. Health Endpoint:"
curl -s http://localhost:8050/health | jq '.'

echo ""
echo "4. Database Connection:"
psql -U waddlebot -d waddlebot -c "SELECT 1" 2>&1

echo ""
echo "5. Recent Errors:"
tail -20 /var/log/waddlebotlog/identity-core.log | grep ERROR

echo ""
echo "=== Health Check Complete ==="
```

### Connection Test Script

```bash
#!/bin/bash
# test-connectivity.sh

BASE_URL="http://localhost:8050"

echo "Testing connectivity to Identity Core Module..."

# Test health
echo -n "Health endpoint... "
if curl -sf "$BASE_URL/health" > /dev/null; then
  echo "✓ OK"
else
  echo "✗ FAILED"
fi

# Test metrics
echo -n "Metrics endpoint... "
if curl -sf "$BASE_URL/metrics" > /dev/null; then
  echo "✓ OK"
else
  echo "✗ FAILED"
fi

# Test gRPC
echo -n "gRPC server... "
if grpcurl -plaintext localhost:50030 list > /dev/null 2>&1; then
  echo "✓ OK"
else
  echo "✗ FAILED"
fi

echo "Test complete."
```

---

*For additional assistance, consult the full documentation suite in `/home/penguin/code/WaddleBot/docs/identity_core_module/`*
