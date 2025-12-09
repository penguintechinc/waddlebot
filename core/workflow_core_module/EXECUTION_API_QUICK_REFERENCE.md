# Execution API - Quick Reference

## Files Created/Modified

### Created
1. **`controllers/execution_api.py`** (997 lines)
   - 5 REST API endpoints
   - Error handling decorator
   - Permission validation
   - AAA logging integration

2. **`docs/execution-api.md`** (700+ lines)
   - Complete API documentation
   - Request/response examples
   - Error codes and handling
   - Best practices

3. **`EXECUTION_API_IMPLEMENTATION.md`**
   - Implementation summary
   - Architecture details
   - Integration checklist

### Modified
1. **`app.py`**
   - Import execution_api blueprint
   - Initialize WorkflowEngine
   - Register execution API
   - Cleanup on shutdown

2. **`config.py`**
   - Added execution configuration parameters
   - Environment variable support

## API Endpoints

| Method | Endpoint | Purpose | Auth | Perm |
|--------|----------|---------|------|------|
| POST | `/workflows/:id/execute` | Start execution | Yes | execute |
| GET | `/workflows/executions/:id` | Get execution details | Yes | - |
| POST | `/workflows/executions/:id/cancel` | Cancel execution | Yes | - |
| GET | `/workflows/:id/executions` | List executions | Yes | view |
| POST | `/workflows/:id/test` | Dry-run test | Yes | execute |

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success (GET/POST results) |
| 202 | Accepted (async execution started) |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (missing auth) |
| 403 | Forbidden (permission denied) |
| 404 | Not Found |
| 500 | Internal Server Error |
| 504 | Gateway Timeout (execution timeout) |

## Response Format

### Success
```json
{
  "success": true,
  "message": "Optional message",
  "data": { /* endpoint data */ },
  "meta": { /* optional pagination */ }
}
```

### Error
```json
{
  "success": false,
  "message": "Error description",
  "error_code": "CODE",
  "details": {}
}
```

## Execution Statuses

- `pending` - Waiting to start
- `running` - Currently executing
- `completed` - Finished successfully
- `failed` - Failed with error
- `cancelled` - User cancelled
- `paused` - Paused (future)

## Node Execution Statuses

- `pending` - Not started
- `ready` - Ready to execute
- `running` - Executing
- `completed` - Finished
- `failed` - Failed
- `skipped` - Skipped
- `cancelled` - Cancelled
- `paused` - Paused

## Key Features

✓ Real-time execution status tracking
✓ Permission-based access control
✓ Detailed execution traces (test mode)
✓ Node-by-node logs and metrics
✓ Execution cancellation
✓ Paginated execution history
✓ Comprehensive AAA logging
✓ Error handling with proper codes
✓ Async execution (non-blocking)
✓ Dry-run testing without side effects

## Configuration Parameters

```python
WORKFLOW_TIMEOUT = 300                    # Default timeout (seconds)
MAX_LOOP_ITERATIONS = 100                 # Max loop iterations
MAX_TOTAL_OPERATIONS = 1000               # Max total operations
MAX_LOOP_DEPTH = 10                       # Max nested loop depth
MAX_PARALLEL_NODES = 10                   # Max concurrent nodes
```

## Code Structure

### Blueprint Registration
```python
from controllers.execution_api import register_execution_api

@app.before_serving
async def startup():
    workflow_engine = WorkflowEngine(...)
    register_execution_api(app, workflow_engine)
```

### Error Handling
```python
@handle_execution_errors
async def endpoint():
    # Converts exceptions to HTTP responses
    # WorkflowTimeoutException → 504
    # WorkflowEngineException → 400
    # PermissionError → 403
    # ValueError → 400
    # Generic Exception → 500
```

### Permission Checking
```python
has_permission = await permission_service.check_permission(
    workflow_id=workflow_id,
    user_id=user_id,
    permission_type="can_execute",
    community_id=community_id
)
```

### Logging
```python
logger.info("Action description",
    extra={
        "event_type": "AUDIT|AUTHZ|ERROR|SYSTEM",
        "workflow_id": workflow_id,
        "user": str(user_id),
        "community": str(community_id),
        "action": "action_name",
        "result": "SUCCESS|FAILURE|DENIED"
    }
)
```

## Usage Examples

### Execute Workflow
```bash
curl -X POST http://localhost:8070/api/v1/workflows/550e8400-e29b-41d4-a716-446655440001/execute \
  -H "X-API-Key: key" \
  -H "Content-Type: application/json" \
  -d '{"community_id": 123, "variables": {"param": "value"}}'
```

### Check Status
```bash
curl http://localhost:8070/api/v1/workflows/executions/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: key"
```

### List Executions
```bash
curl "http://localhost:8070/api/v1/workflows/550e8400-e29b-41d4-a716-446655440001/executions?community_id=123&page=1&per_page=20" \
  -H "X-API-Key: key"
```

### Test Workflow
```bash
curl -X POST http://localhost:8070/api/v1/workflows/550e8400-e29b-41d4-a716-446655440001/test \
  -H "X-API-Key: key" \
  -H "Content-Type: application/json" \
  -d '{"community_id": 123, "variables": {"test": "value"}}'
```

### Cancel Execution
```bash
curl -X POST http://localhost:8070/api/v1/workflows/executions/550e8400-e29b-41d4-a716-446655440000/cancel \
  -H "X-API-Key: key"
```

## Integration Checklist

- [x] Create execution_api.py controller
- [x] Implement 5 REST endpoints
- [x] Add error handling decorator
- [x] Integrate permission service
- [x] Add AAA logging
- [x] Update app.py for registration
- [x] Add configuration parameters
- [x] Create documentation
- [x] Add type hints
- [x] Implement response standardization

## Logging Examples

### Successful Execution
```
[2025-12-09T12:00:00Z] INFO workflow_core AUDIT community=123 user=456 action=execute_workflow result=SUCCESS
```

### Permission Denied
```
[2025-12-09T12:00:01Z] WARNING workflow_core AUTHZ community=123 user=789 action=execute_workflow result=DENIED
```

### Execution Error
```
[2025-12-09T12:00:02Z] ERROR workflow_core ERROR workflow_id=uuid user=456 action=execute_workflow result=FAILURE
```

## Database Requirements

The system expects a `workflow_executions` table with:

```sql
CREATE TABLE workflow_executions (
    execution_id UUID PRIMARY KEY,
    workflow_id UUID NOT NULL,
    status VARCHAR(20),
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    execution_time_seconds FLOAT,
    nodes_executed INT,
    error_message TEXT,
    final_output JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Security Notes

1. All endpoints require X-API-Key header authentication
2. Permission checks validate user access before action
3. Owners have automatic full permissions
4. All actions logged for audit trail
5. Error messages are generic (no data leakage)
6. Timeouts prevent resource exhaustion
7. Input validation on all requests

## Performance Notes

- Execute: O(1) returns immediately (202)
- Get Details: O(1) lookup by ID
- List Executions: O(n) query + O(n log n) sort
- Cancel: O(1) flag update
- Test: O(n) full execution

## Error Codes

| Code | Meaning |
|------|---------|
| BAD_REQUEST | Invalid input |
| UNAUTHORIZED | Missing/invalid API key |
| PERMISSION_DENIED | User lacks permission |
| WORKFLOW_NOT_FOUND | Workflow doesn't exist |
| EXECUTION_ERROR | Workflow execution failed |
| EXECUTION_TIMEOUT | Execution exceeded timeout |
| INTERNAL_ERROR | Server error |
| NOT_FOUND | Resource not found |

## WaddleBot Patterns

✓ Quart async framework
✓ Blueprint-based routing
✓ Permission service integration
✓ AAA logging (Auth/Authz/Audit)
✓ AsyncDAL database access
✓ Environment-based configuration
✓ Standard response format
✓ Comprehensive docstrings
✓ Type hints throughout
✓ Async/await patterns
✓ Middleware integration
✓ Error handling with codes

---

**Status**: Implementation Complete - Ready for Testing
