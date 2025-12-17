# Workflow Core Module - Troubleshooting Guide

## Overview

This guide provides solutions to common issues encountered when using the Workflow Core Module.

**Module Version:** 1.0.0

---

## Table of Contents

1. [Startup & Connection Issues](#startup--connection-issues)
2. [Workflow Execution Errors](#workflow-execution-errors)
3. [Node-Specific Issues](#node-specific-issues)
4. [Performance Problems](#performance-problems)
5. [Security & Permission Issues](#security--permission-issues)
6. [Webhook Problems](#webhook-problems)
7. [Database Issues](#database-issues)
8. [Logging & Debugging](#logging--debugging)

---

## Startup & Connection Issues

### Module Won't Start

#### Symptom
```
Error: Failed to start workflow_core_module
```

#### Possible Causes & Solutions

**1. Database Connection Failed**

Check database connectivity:
```bash
# Test PostgreSQL connection
psql -h localhost -U waddlebot -d waddlebot -c "SELECT 1"

# Verify DATABASE_URI
echo $DATABASE_URI
```

**Solution:**
- Verify PostgreSQL is running: `pg_isready`
- Check credentials in `DATABASE_URI`
- Ensure database exists: `createdb waddlebot`
- Check firewall rules

**2. Redis Connection Failed**

Check Redis connectivity:
```bash
# Test Redis connection
redis-cli ping
# Should return: PONG

# Verify REDIS_URL
echo $REDIS_URL
```

**Solution:**
- Start Redis: `redis-server`
- Check Redis configuration
- Verify REDIS_URL format: `redis://:password@host:port/db`

**3. Port Already in Use**

```
Error: Address already in use: 8070
```

**Solution:**
```bash
# Find process using port
lsof -i :8070
# or
netstat -tulpn | grep 8070

# Kill process
kill -9 <PID>

# Or change port
export MODULE_PORT=8071
```

**4. Missing Dependencies**

```
ModuleNotFoundError: No module named 'quart'
```

**Solution:**
```bash
cd /home/penguin/code/WaddleBot/core/workflow_core_module
pip install -r requirements.txt
```

**5. flask_core Library Not Found**

```
ModuleNotFoundError: No module named 'flask_core'
```

**Solution:**
```bash
cd /home/penguin/code/WaddleBot/libs/flask_core
pip install -e .
```

---

### gRPC Server Won't Start

#### Symptom
```
Warning: Failed to start gRPC server
```

#### Solutions

**1. Port Conflict**
```bash
# Check if gRPC port is available
netstat -tulpn | grep 50070

# Change GRPC_PORT if needed
export GRPC_PORT=50071
```

**2. Proto Files Missing**
```bash
# Regenerate proto files
cd /home/penguin/code/WaddleBot/core/workflow_core_module/proto
python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. workflow.proto
```

**3. gRPC Dependencies Missing**
```bash
pip install grpcio>=1.67.0 grpcio-tools>=1.67.0
```

---

## Workflow Execution Errors

### Workflow Execution Fails Immediately

#### Symptom
```json
{
  "status": "failed",
  "error_message": "Workflow execution failed",
  "error_node_id": null
}
```

#### Diagnostic Steps

**1. Check Workflow Validation**
```bash
curl -X POST http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/validate \
  -H "Authorization: Bearer $TOKEN"
```

Look for validation errors:
- Missing trigger nodes
- Invalid connections
- Circular dependencies
- Invalid node configurations

**2. Check Execution Logs**
```bash
# View logs
tail -f /var/log/waddlebotlog/workflow_core.log

# Filter for specific execution
grep "execution_id=$EXECUTION_ID" /var/log/waddlebotlog/workflow_core.log
```

**3. Test with Dry-Run**
```bash
curl -X POST http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/test \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "community_id": 456,
    "variables": {"test": "value"}
  }'
```

Review trace output for specific failures.

---

### Workflow Times Out

#### Symptom
```json
{
  "error": "Workflow execution timeout",
  "error_code": "EXECUTION_TIMEOUT"
}
```

#### Solutions

**1. Increase Timeout**

In workflow definition:
```json
{
  "metadata": {
    "max_execution_time_seconds": 600
  }
}
```

Or globally:
```bash
export WORKFLOW_TIMEOUT_SECONDS=600
```

**2. Optimize Workflow**
- Remove unnecessary delay nodes
- Reduce loop iterations
- Use parallel execution for independent tasks
- Check for slow external API calls

**3. Check for Infinite Loops**
```bash
# Review execution trace
curl -X GET http://localhost:8070/api/v1/workflows/executions/$EXECUTION_ID \
  -H "Authorization: Bearer $TOKEN"
```

Look for repeated node executions indicating a loop issue.

---

### Loop Limit Exceeded

#### Symptom
```
Error: Maximum loop iterations exceeded (100)
```

#### Solutions

**1. Increase Loop Limit**

Globally:
```bash
export MAX_LOOP_ITERATIONS=200
```

Per-node:
```json
{
  "node_type": "loop_foreach",
  "config": {
    "max_iterations": 200
  }
}
```

**2. Optimize Loop**
- Add loop_break conditions
- Filter collection before looping
- Process in batches

**3. Check Loop Logic**
```json
{
  "node_type": "loop_while",
  "config": {
    "condition": {
      "operator": "less_than",
      "left": "{{counter}}",
      "right": 1000
    }
  }
}
```

Ensure condition will eventually become false.

---

### Total Operations Limit Exceeded

#### Symptom
```
Error: Maximum total operations exceeded (1000)
```

#### Solutions

**1. Increase Limit**
```bash
export MAX_TOTAL_OPERATIONS=2000
```

**2. Simplify Workflow**
- Remove unnecessary nodes
- Combine multiple actions into single node
- Use sub-workflows (when available)

**3. Check for Nested Loops**

Nested loops multiply operations:
```
Outer loop: 50 iterations
Inner loop: 50 iterations
Total operations: 50 * 50 = 2,500
```

Reduce iterations or refactor logic.

---

## Node-Specific Issues

### Condition Node Always Evaluates False

#### Symptom
Condition node always takes the `false` branch.

#### Diagnostic Steps

**1. Check Variable Values**

Add a data_transform node before condition to log variables:
```json
{
  "node_type": "data_transform",
  "config": {
    "transform_code": "output = {'status': status, 'expected': 'active'}"
  }
}
```

**2. Check Operator**

Ensure correct operator:
```json
{
  "condition": {
    "operator": "equals",  // Not "equal" or "=="
    "left": "{{status}}",
    "right": "active"
  }
}
```

**3. Check Data Types**

```python
# String comparison
{"operator": "equals", "left": "{{count}}", "right": "10"}  # "10" == "10" ✓

# Numeric comparison
{"operator": "equals", "left": "{{count}}", "right": 10}     // "10" == 10 ✗
```

Convert types if needed:
```json
{
  "transform_code": "output = int(count)"
}
```

---

### Action Module Node Fails

#### Symptom
```
Error: Failed to execute module action
```

#### Diagnostic Steps

**1. Check Router Service**
```bash
# Test router connectivity
curl http://router-service:8000/health

# Verify ROUTER_URL
echo $ROUTER_URL
```

**2. Check Module Exists**
```bash
curl http://router-service:8000/api/v1/modules
```

Verify module_name exists in response.

**3. Check Module Parameters**

Review module documentation for required parameters:
```json
{
  "node_type": "action_module",
  "config": {
    "module_name": "music_module",
    "action": "play_song",
    "params": {
      "song_name": "{{requested_song}}",  // Ensure variable exists
      "volume": 80
    }
  }
}
```

**4. Check Execution Logs**
```bash
grep "action_module" /var/log/waddlebotlog/workflow_core.log
```

---

### Webhook Action Fails

#### Symptom
```
Error: Webhook request failed
```

#### Diagnostic Steps

**1. Test Webhook URL**
```bash
# Test manually
curl -X POST https://api.example.com/endpoint \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

**2. Check Timeout**

Increase timeout:
```json
{
  "config": {
    "url": "https://slow-api.com/endpoint",
    "timeout_seconds": 60  // Increase from default 30
  }
}
```

**3. Check Authentication**

Verify headers:
```json
{
  "config": {
    "headers": {
      "Authorization": "Bearer {{api_token}}",  // Ensure token variable exists
      "Content-Type": "application/json"
    }
  }
}
```

**4. Check Response**

Add error handling:
```json
{
  "nodes": {
    "webhook": {"node_type": "action_webhook", ...},
    "check": {
      "node_type": "condition_if",
      "config": {
        "condition": {
          "operator": "equals",
          "left": "{{webhook_response.status_code}}",
          "right": 200
        }
      }
    },
    "success": {...},
    "error": {...}
  }
}
```

---

### Data Transform Node Fails

#### Symptom
```
Error: Transform execution failed
```

#### Common Issues

**1. Syntax Error**

```python
# Bad
output = input['value'  # Missing closing bracket

# Good
output = input['value']
```

**2. Restricted Function**

```python
# Restricted (not allowed)
import os
output = os.system('ls')

# Allowed
import json
output = json.loads(input)
```

**Allowed imports:**
- `json`, `re`, `datetime`, `math`, `random`
- Standard Python builtins (safe subset)

**3. Variable Not Defined**

```python
# Bad
output = undefined_variable

# Good
output = variables.get('my_var', 'default')
```

**4. Output Not Set**

```python
# Bad
result = input * 2  # 'result' not used

# Good
output = input * 2  # Must set 'output'
```

---

### Loop ForEach Node Fails

#### Symptom
```
Error: Variable 'collection' is not a collection
```

#### Solutions

**1. Check Variable Type**

Ensure variable is a list/array:
```json
{
  "node_type": "data_variable_set",
  "config": {
    "variable_name": "items",
    "value": ["item1", "item2", "item3"]  // Array, not string
  }
}
```

**2. Check Variable Exists**

Add default:
```json
{
  "config": {
    "collection_variable": "items",
    "default_collection": []
  }
}
```

**3. Transform Data**

Convert to array:
```json
{
  "node_type": "data_transform",
  "config": {
    "transform_code": "output = input.split(',')"  // Convert CSV to array
  }
}
```

---

## Performance Problems

### Slow Workflow Execution

#### Symptom
Workflows take longer than expected to execute.

#### Diagnostic Steps

**1. Check Execution Metrics**
```bash
curl -X GET "http://localhost:8070/api/v1/workflows/executions/$EXECUTION_ID?include_metrics=true" \
  -H "Authorization: Bearer $TOKEN"
```

Review:
- Total execution time
- Per-node execution time
- Number of operations

**2. Identify Slow Nodes**

Look for nodes with high duration in trace:
```json
{
  "trace": [
    {
      "node_id": "webhook1",
      "duration_seconds": 25.3  // Slow!
    }
  ]
}
```

**3. Optimize Slow Nodes**

- **Webhooks:** Reduce timeout, use faster endpoints
- **Loops:** Reduce iterations, add early exits
- **Transforms:** Optimize code, avoid complex operations
- **Delays:** Remove unnecessary delays

**4. Use Parallel Execution**

Convert sequential to parallel:
```json
{
  "nodes": {
    "parallel": {"node_type": "flow_parallel"},
    "action1": {...},
    "action2": {...},
    "action3": {...},
    "merge": {"node_type": "flow_merge"}
  }
}
```

---

### High Memory Usage

#### Symptom
```
Warning: High memory usage detected
```

#### Solutions

**1. Limit Concurrent Workflows**
```bash
export MAX_CONCURRENT_WORKFLOWS=5
```

**2. Reduce Loop Iterations**
```bash
export MAX_LOOP_ITERATIONS=50
```

**3. Clear Old Executions**

Archive old execution data:
```sql
DELETE FROM workflow_executions
WHERE created_at < NOW() - INTERVAL '30 days';
```

**4. Optimize Workflow Variables**

Avoid storing large data in variables:
```json
// Bad
{
  "variable_name": "large_dataset",
  "value": [/* 10,000 items */]
}

// Good - use pagination
{
  "variable_name": "current_page",
  "value": 0
}
```

---

### Database Connection Pool Exhausted

#### Symptom
```
Error: Failed to acquire database connection
```

#### Solutions

**1. Increase Pool Size**

In PyDAL configuration:
```python
dal = DAL(
    DATABASE_URI,
    pool_size=20,  # Increase from default
    max_pool_size=50
)
```

**2. Close Connections Properly**

Ensure executions complete:
```bash
# Check for stuck executions
SELECT * FROM workflow_executions
WHERE status = 'running'
AND start_time < NOW() - INTERVAL '1 hour';

# Cancel stuck executions
UPDATE workflow_executions
SET status = 'cancelled'
WHERE execution_id = 'stuck-exec-id';
```

**3. Monitor Connections**
```sql
SELECT count(*) FROM pg_stat_activity
WHERE application_name = 'waddlebot';
```

---

## Security & Permission Issues

### Permission Denied Errors

#### Symptom
```json
{
  "error": "Permission denied",
  "error_code": "PERMISSION_DENIED"
}
```

#### Diagnostic Steps

**1. Check User Permissions**
```sql
SELECT * FROM workflow_permissions
WHERE workflow_id = 'workflow-id'
AND user_id = 'user-id';
```

**2. Check Workflow Owner**
```sql
SELECT author_id FROM workflows
WHERE workflow_id = 'workflow-id';
```

**3. Grant Permissions**
```sql
INSERT INTO workflow_permissions (
    workflow_id, user_id, can_view, can_edit, can_execute
) VALUES (
    'workflow-id', 'user-id', true, true, true
);
```

**4. Check Community Access**

Ensure user belongs to workflow's community:
```sql
SELECT * FROM community_members
WHERE community_id = (SELECT community_id FROM workflows WHERE workflow_id = 'workflow-id')
AND user_id = 'user-id';
```

---

### License Validation Failed

#### Symptom
```json
{
  "error": "License validation failed",
  "error_code": "PAYMENT_REQUIRED"
}
```

#### Solutions

**1. Check License Server**
```bash
curl https://license.penguintech.io/health
```

**2. Verify License Key**
```bash
curl -X POST https://license.penguintech.io/api/v1/licenses/validate \
  -H "Content-Type: application/json" \
  -d '{
    "community_id": 456,
    "license_key": "your-license-key",
    "feature": "workflows"
  }'
```

**3. Check Feature Limits**

Review license details:
- `workflows_max`: Maximum workflows allowed
- `advanced_workflows`: Advanced node types enabled
- `workflow_schedules`: Scheduling enabled

**4. Bypass Validation (Development)**
```bash
export RELEASE_MODE=false
```

**WARNING:** Only use in development environments!

---

## Webhook Problems

### Webhook Trigger Returns 404

#### Symptom
```
Error: Webhook not found
```

#### Solutions

**1. Verify Token**
```bash
# List webhooks
curl -X GET http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/webhooks \
  -H "Authorization: Bearer $TOKEN"

# Check token matches
```

**2. Check Workflow Status**

Webhook workflow must be published:
```sql
SELECT status FROM workflows WHERE workflow_id = 'workflow-id';
-- Should be 'active', not 'draft'
```

**3. Check Webhook Enabled**
```sql
SELECT enabled FROM workflow_webhooks WHERE token = 'webhook-token';
-- Should be true
```

---

### Webhook Signature Verification Failed

#### Symptom
```json
{
  "error": "Invalid webhook signature",
  "error_code": "SIGNATURE_INVALID"
}
```

#### Solutions

**1. Verify Signature Calculation**

Python example:
```python
import hmac
import hashlib

token = "your-webhook-token"
secret = "your-webhook-secret"
body = b'{"event":"test"}'

message = token.encode() + body
signature = 'sha256=' + hmac.new(
    secret.encode(),
    message,
    hashlib.sha256
).hexdigest()

print(f"X-Webhook-Signature: {signature}")
```

**2. Check Header Name**

Must be exactly:
```
X-Webhook-Signature: sha256=<hex>
```

**3. Disable Signature Verification (Testing Only)**
```bash
curl -X PUT http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/webhooks/$WEBHOOK_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"require_signature": false}'
```

---

### Webhook Rate Limit Exceeded

#### Symptom
```json
{
  "error": "Rate limit exceeded",
  "error_code": "RATE_LIMIT_EXCEEDED"
}
```

#### Solutions

**1. Increase Rate Limit**
```bash
curl -X PUT http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/webhooks/$WEBHOOK_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rate_limit_max": 120,
    "rate_limit_window": 60
  }'
```

**2. Implement Client-Side Rate Limiting**

Space out requests:
```python
import time

for event in events:
    trigger_webhook(event)
    time.sleep(1)  # 1 second between requests
```

**3. Use Batch Processing**

Combine multiple events into one webhook call:
```json
{
  "events": [
    {"type": "event1", "data": "..."},
    {"type": "event2", "data": "..."}
  ]
}
```

---

### Webhook IP Not Allowed

#### Symptom
```json
{
  "error": "IP address not allowed",
  "error_code": "IP_NOT_ALLOWED"
}
```

#### Solutions

**1. Add IP to Allowlist**
```bash
curl -X PUT http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/webhooks/$WEBHOOK_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ip_allowlist": [
      "192.168.1.100",
      "10.0.0.0/24",
      "2001:db8::/32"
    ]
  }'
```

**2. Clear Allowlist (Allow All)**
```bash
curl -X PUT http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/webhooks/$WEBHOOK_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ip_allowlist": []}'
```

---

## Database Issues

### Database Migration Failed

#### Symptom
```
Error: Migration failed
```

#### Solutions

**1. Check Database Version**
```sql
SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;
```

**2. Manual Migration**
```bash
cd /home/penguin/code/WaddleBot/config/postgres/migrations

# Apply missing migrations
psql -U waddlebot -d waddlebot -f 001_create_workflows.sql
psql -U waddlebot -d waddlebot -f 002_create_executions.sql
# ...
```

**3. Rollback and Retry**
```sql
-- Rollback last migration
DELETE FROM schema_migrations WHERE version = 'latest-version';

-- Re-run migration
python scripts/migrate.py
```

---

### Execution Data Not Persisting

#### Symptom
Execution completes but data not in database.

#### Solutions

**1. Check Database Connection**
```sql
SELECT 1;  -- Should return 1
```

**2. Check Table Exists**
```sql
\dt workflow_executions
```

**3. Check Permissions**
```sql
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'workflow_executions';
```

**4. Check Transaction Commits**

Ensure autocommit is enabled or transactions are committed properly.

---

## Logging & Debugging

### Enable Debug Logging

```bash
export LOG_LEVEL=DEBUG
```

Restart service to apply.

### View Logs

```bash
# Real-time logs
tail -f /var/log/waddlebotlog/workflow_core.log

# Filter by execution
grep "execution_id=exec-123" /var/log/waddlebotlog/workflow_core.log

# Filter by error
grep "ERROR" /var/log/waddlebotlog/workflow_core.log

# Filter by user
grep "user_id=456" /var/log/waddlebotlog/workflow_core.log
```

### Debug Workflow Execution

Use test endpoint with detailed trace:
```bash
curl -X POST http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/test \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "community_id": 456,
    "variables": {"debug": true}
  }' | jq '.data.trace'
```

### Debug Variables

Add debug transform nodes:
```json
{
  "node_type": "data_transform",
  "config": {
    "transform_code": "import json\noutput = json.dumps(variables, indent=2)"
  }
}
```

Check output in execution logs.

---

## Getting Help

If issues persist:

1. **Check Documentation**
   - API.md for API reference
   - CONFIGURATION.md for configuration
   - ARCHITECTURE.md for system design

2. **Search Issues**
   - GitHub: https://github.com/your-org/waddlebot/issues

3. **Create Issue**
   Include:
   - Module version
   - Error message
   - Workflow definition (if applicable)
   - Execution ID
   - Relevant logs

4. **Contact Support**
   - Email: support@waddlebot.io
   - Discord: https://discord.gg/waddlebot
