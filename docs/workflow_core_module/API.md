# Workflow Core Module - API Reference

## Overview

The Workflow Core Module provides REST and gRPC APIs for workflow management and execution. This module handles workflow definition, validation, execution, scheduling, and state management.

**Module Version:** 1.0.0
**Base URL:** `http://localhost:8070`
**gRPC Port:** `50070`

## Table of Contents

1. [Authentication](#authentication)
2. [Workflow Management API](#workflow-management-api)
3. [Execution API](#execution-api)
4. [Webhook API](#webhook-api)
5. [Health & Status API](#health--status-api)
6. [gRPC API](#grpc-api)
7. [Error Codes](#error-codes)

---

## Authentication

All authenticated endpoints require a valid JWT token in the Authorization header:

```
Authorization: Bearer <jwt_token>
```

The JWT token must contain:
- `user_id`: User identifier
- `username`: Username (optional)
- Other claims as needed

### Public Endpoints

The following endpoints do NOT require authentication:
- `POST /api/v1/workflows/webhooks/:token` - Webhook trigger

---

## Workflow Management API

### Create Workflow

Create a new workflow definition.

**Endpoint:** `POST /api/v1/workflows`
**Authentication:** Required
**Permission:** None (creates workflow with user as owner)

#### Request Body

```json
{
  "name": "My Workflow",
  "description": "Workflow description",
  "entity_id": 123,
  "community_id": 456,
  "license_key": "optional-license-key",
  "nodes": {
    "node1": {
      "node_type": "trigger_command",
      "label": "Command Trigger",
      "position": {"x": 100, "y": 100},
      "config": {
        "command_name": "!test"
      }
    },
    "node2": {
      "node_type": "action_chat_message",
      "label": "Send Message",
      "position": {"x": 300, "y": 100},
      "config": {
        "message": "Hello, {{username}}!"
      }
    }
  },
  "connections": [
    {
      "connection_id": "conn1",
      "from_node_id": "node1",
      "from_port_name": "output",
      "to_node_id": "node2",
      "to_port_name": "input"
    }
  ],
  "global_variables": {
    "greeting": "Hello"
  }
}
```

#### Response (201 Created)

```json
{
  "success": true,
  "message": "Workflow created successfully",
  "data": {
    "workflow_id": "uuid-here",
    "name": "My Workflow",
    "status": "draft",
    "created_at": "2025-12-16T10:00:00Z"
  }
}
```

#### Error Responses

| Code | Description |
|------|-------------|
| 400 | Invalid input (missing required fields) |
| 401 | Unauthorized (missing/invalid token) |
| 402 | Payment Required (license validation failed) |
| 500 | Internal server error |

---

### List Workflows

List accessible workflows with pagination and filters.

**Endpoint:** `GET /api/v1/workflows`
**Authentication:** Required
**Permission:** User must have access to entity

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| entity_id | integer | Yes | Entity ID to filter workflows |
| community_id | integer | No | Community ID for context |
| status | string | No | Filter by status: `draft`, `active`, `archived` |
| search | string | No | Search in name/description |
| page | integer | No | Page number (default: 1) |
| per_page | integer | No | Items per page (default: 20, max: 100) |

#### Example Request

```bash
GET /api/v1/workflows?entity_id=123&status=active&page=1&per_page=20
```

#### Response (200 OK)

```json
{
  "success": true,
  "data": [
    {
      "workflow_id": "uuid-1",
      "name": "Workflow 1",
      "description": "Description",
      "status": "active",
      "created_at": "2025-12-16T10:00:00Z",
      "updated_at": "2025-12-16T11:00:00Z"
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "per_page": 20,
      "total": 150,
      "total_pages": 8,
      "has_next": true,
      "has_prev": false
    }
  }
}
```

---

### Get Workflow

Retrieve a single workflow by ID.

**Endpoint:** `GET /api/v1/workflows/:workflow_id`
**Authentication:** Required
**Permission:** `can_view` on workflow

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| workflow_id | string (UUID) | Workflow identifier |

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| community_id | integer | No | Community ID for context |

#### Response (200 OK)

```json
{
  "success": true,
  "data": {
    "workflow_id": "uuid-here",
    "name": "My Workflow",
    "description": "Description",
    "status": "active",
    "nodes": { },
    "connections": [ ],
    "global_variables": { },
    "created_at": "2025-12-16T10:00:00Z",
    "updated_at": "2025-12-16T11:00:00Z"
  }
}
```

---

### Update Workflow

Update an existing workflow.

**Endpoint:** `PUT /api/v1/workflows/:workflow_id`
**Authentication:** Required
**Permission:** `can_edit` on workflow

#### Request Body

```json
{
  "name": "Updated Workflow Name",
  "description": "Updated description",
  "nodes": { },
  "connections": [ ],
  "community_id": 456
}
```

#### Response (200 OK)

```json
{
  "success": true,
  "message": "Workflow updated successfully",
  "data": {
    "workflow_id": "uuid-here",
    "updated_at": "2025-12-16T12:00:00Z"
  }
}
```

---

### Delete Workflow

Archive a workflow (soft delete).

**Endpoint:** `DELETE /api/v1/workflows/:workflow_id`
**Authentication:** Required
**Permission:** `can_delete` on workflow

#### Response (200 OK)

```json
{
  "success": true,
  "message": "Workflow archived successfully",
  "data": {
    "workflow_id": "uuid-here",
    "status": "archived"
  }
}
```

---

### Publish Workflow

Publish and activate a workflow after validation.

**Endpoint:** `POST /api/v1/workflows/:workflow_id/publish`
**Authentication:** Required
**Permission:** `can_edit` on workflow

#### Request Body

```json
{
  "community_id": 456
}
```

#### Response (200 OK)

```json
{
  "success": true,
  "message": "Workflow published successfully",
  "data": {
    "workflow_id": "uuid-here",
    "status": "active",
    "published_at": "2025-12-16T12:00:00Z"
  }
}
```

#### Error Responses

| Code | Description |
|------|-------------|
| 400 | Validation failed (workflow has errors) |
| 403 | Permission denied |
| 404 | Workflow not found |

---

### Validate Workflow

Validate workflow structure and configuration.

**Endpoint:** `POST /api/v1/workflows/:workflow_id/validate`
**Authentication:** Required

#### Response (200 OK)

```json
{
  "success": true,
  "message": "Validation completed",
  "data": {
    "is_valid": true,
    "errors": [],
    "warnings": [
      "Node 'node5' has no outgoing connections"
    ],
    "node_validation_errors": {},
    "error_count": 0,
    "warning_count": 1
  }
}
```

---

## Execution API

### Execute Workflow

Trigger workflow execution.

**Endpoint:** `POST /api/v1/workflows/:workflow_id/execute`
**Authentication:** Required
**Permission:** `can_execute` on workflow

#### Request Body

```json
{
  "community_id": 456,
  "variables": {
    "param1": "value1",
    "param2": "value2"
  },
  "metadata": {
    "trigger_source": "api",
    "session_id": "sess_123"
  }
}
```

#### Response (202 Accepted)

```json
{
  "success": true,
  "message": "Workflow execution started",
  "data": {
    "execution_id": "exec-uuid",
    "workflow_id": "workflow-uuid",
    "status": "running",
    "start_time": "2025-12-16T12:00:00Z",
    "execution_path": []
  }
}
```

#### Error Responses

| Code | Description |
|------|-------------|
| 400 | Invalid input or workflow not found |
| 403 | Permission denied |
| 504 | Workflow timeout |

---

### Get Execution Details

Retrieve execution status and details.

**Endpoint:** `GET /api/v1/workflows/executions/:execution_id`
**Authentication:** Required

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| include_logs | boolean | true | Include node execution logs |
| include_metrics | boolean | false | Include performance metrics |

#### Response (200 OK)

```json
{
  "success": true,
  "data": {
    "execution_id": "exec-uuid",
    "workflow_id": "workflow-uuid",
    "status": "completed",
    "start_time": "2025-12-16T12:00:00Z",
    "end_time": "2025-12-16T12:05:00Z",
    "execution_time_seconds": 300,
    "execution_path": ["node1", "node2", "node3"],
    "node_states": {
      "node1": {
        "node_id": "node1",
        "status": "completed",
        "started_at": "2025-12-16T12:00:00Z",
        "completed_at": "2025-12-16T12:00:10Z",
        "input_data": {},
        "output_data": {},
        "logs": ["Execution started"],
        "error": null
      }
    },
    "final_variables": {},
    "final_output": {},
    "error_message": null,
    "error_node_id": null
  }
}
```

---

### Cancel Execution

Cancel a running workflow execution.

**Endpoint:** `POST /api/v1/workflows/executions/:execution_id/cancel`
**Authentication:** Required

#### Response (200 OK)

```json
{
  "success": true,
  "message": "Execution cancelled successfully",
  "data": {
    "execution_id": "exec-uuid",
    "status": "cancelled",
    "cancelled_at": "2025-12-16T12:03:00Z"
  }
}
```

---

### List Workflow Executions

List executions for a workflow with pagination.

**Endpoint:** `GET /api/v1/workflows/:workflow_id/executions`
**Authentication:** Required
**Permission:** `can_view` on workflow

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| community_id | integer | Yes | Community ID |
| status | string | No | Filter by status: `running`, `completed`, `failed`, `cancelled` |
| page | integer | No | Page number (default: 1) |
| per_page | integer | No | Items per page (default: 20, max: 100) |
| sort_by | string | No | Sort field: `start_time`, `status`, `execution_time` |
| sort_order | string | No | Sort order: `asc`, `desc` (default: `desc`) |

#### Response (200 OK)

```json
{
  "success": true,
  "data": [
    {
      "execution_id": "exec-uuid",
      "workflow_id": "workflow-uuid",
      "status": "completed",
      "start_time": "2025-12-16T12:00:00Z",
      "end_time": "2025-12-16T12:05:00Z",
      "execution_time_seconds": 300,
      "nodes_executed": 5,
      "success": true,
      "error": null
    }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "per_page": 20,
      "total": 150,
      "total_pages": 8,
      "has_next": true,
      "has_prev": false
    }
  }
}
```

---

### Test Workflow

Perform a dry-run test without side effects.

**Endpoint:** `POST /api/v1/workflows/:workflow_id/test`
**Authentication:** Required
**Permission:** `can_execute` on workflow

#### Request Body

```json
{
  "community_id": 456,
  "variables": {
    "param1": "test_value"
  },
  "metadata": {
    "session_id": "test_sess_123"
  }
}
```

#### Response (200 OK)

```json
{
  "success": true,
  "message": "Workflow test completed",
  "data": {
    "execution_id": "test-exec-uuid",
    "workflow_id": "workflow-uuid",
    "test_mode": true,
    "status": "completed",
    "execution_time_seconds": 1.5,
    "trace": [
      {
        "node_id": "node1",
        "status": "completed",
        "duration_seconds": 0.5,
        "input": {},
        "output": {},
        "logs": ["Node execution log"],
        "error": null
      }
    ],
    "final_variables": {},
    "summary": {
      "nodes_executed": 3,
      "nodes_failed": 0,
      "total_duration": 1.5,
      "passed": true
    }
  }
}
```

---

## Webhook API

### Trigger Webhook (Public)

Publicly accessible webhook trigger endpoint.

**Endpoint:** `POST /api/v1/workflows/webhooks/:token`
**Authentication:** None (uses webhook token)

#### Headers

| Header | Required | Description |
|--------|----------|-------------|
| X-Webhook-Signature | Conditional | HMAC-SHA256 signature (if `require_signature=true`) |
| Content-Type | Yes | `application/json` |

#### Signature Calculation

```python
import hmac
import hashlib

message = token.encode() + request_body_bytes
signature = 'sha256=' + hmac.new(
    secret.encode(),
    message,
    hashlib.sha256
).hexdigest()
```

#### Request Body

Any JSON payload that will be passed to workflow as trigger data.

```json
{
  "event": "user_joined",
  "user_id": 123,
  "username": "testuser"
}
```

#### Response (200 OK)

```json
{
  "success": true,
  "message": "Workflow execution triggered",
  "data": {
    "execution_id": "exec-uuid",
    "webhook_id": "webhook-uuid",
    "workflow_id": "workflow-uuid",
    "status": "queued",
    "timestamp": "2025-12-16T12:00:00Z"
  }
}
```

#### Error Responses

| Code | Description |
|------|-------------|
| 400 | Invalid JSON payload |
| 403 | Forbidden (IP not allowed, signature invalid, webhook disabled) |
| 404 | Webhook not found |
| 429 | Rate limit exceeded |

---

### List Webhooks

List all webhooks for a workflow.

**Endpoint:** `GET /api/v1/workflows/:workflow_id/webhooks`
**Authentication:** Required
**Permission:** `can_view` on workflow

#### Response (200 OK)

```json
{
  "success": true,
  "message": "Retrieved 2 webhooks",
  "data": [
    {
      "webhook_id": "webhook-uuid",
      "workflow_id": "workflow-uuid",
      "token": "token123",
      "name": "GitHub Webhook",
      "url": "https://api.example.com/api/v1/workflows/webhooks/token123",
      "enabled": true,
      "require_signature": true,
      "ip_allowlist": ["192.168.1.0/24"],
      "rate_limit_max": 60,
      "rate_limit_window": 60,
      "created_at": "2025-12-16T10:00:00Z",
      "last_triggered_at": "2025-12-16T12:00:00Z",
      "trigger_count": 42
    }
  ]
}
```

---

### Create Webhook

Create a new webhook for a workflow.

**Endpoint:** `POST /api/v1/workflows/:workflow_id/webhooks`
**Authentication:** Required
**Permission:** `can_edit` on workflow

#### Request Body

```json
{
  "name": "My Webhook",
  "description": "Webhook for external triggers",
  "require_signature": true,
  "ip_allowlist": ["192.168.1.0/24", "10.0.0.1"],
  "rate_limit_max": 60,
  "rate_limit_window": 60,
  "community_id": 456
}
```

#### Response (201 Created)

```json
{
  "success": true,
  "message": "Webhook created successfully",
  "data": {
    "webhook_id": "webhook-uuid",
    "workflow_id": "workflow-uuid",
    "token": "generated-token",
    "name": "My Webhook",
    "url": "https://api.example.com/api/v1/workflows/webhooks/generated-token",
    "enabled": true,
    "require_signature": true,
    "created_at": "2025-12-16T12:00:00Z"
  }
}
```

---

### Delete Webhook

Delete a webhook.

**Endpoint:** `DELETE /api/v1/workflows/:workflow_id/webhooks/:webhook_id`
**Authentication:** Required
**Permission:** `can_edit` on workflow

#### Response (200 OK)

```json
{
  "success": true,
  "message": "Webhook deleted successfully",
  "data": {
    "webhook_id": "webhook-uuid"
  }
}
```

---

## Health & Status API

### Module Status

Get workflow module status.

**Endpoint:** `GET /api/v1/status`
**Authentication:** None

#### Response (200 OK)

```json
{
  "success": true,
  "data": {
    "status": "operational",
    "module": "workflow_core_module",
    "version": "1.0.0",
    "features": {
      "workflows_enabled": true,
      "release_mode": false
    }
  }
}
```

---

### Health Check

Health check endpoint for monitoring.

**Endpoint:** `GET /health`
**Authentication:** None

#### Response (200 OK)

```json
{
  "success": true,
  "data": {
    "healthy": true,
    "module": "workflow_core_module"
  }
}
```

---

## gRPC API

The module also exposes a gRPC service on port `50070` with the following RPCs:

### Service Definition

```protobuf
service WorkflowService {
  rpc ExecuteWorkflow(ExecuteWorkflowRequest) returns (ExecuteWorkflowResponse);
  rpc GetExecutionStatus(GetExecutionStatusRequest) returns (GetExecutionStatusResponse);
  rpc CancelExecution(CancelExecutionRequest) returns (CancelExecutionResponse);
}
```

### gRPC Authentication

All gRPC calls require a JWT token in metadata:

```python
metadata = [('authorization', f'Bearer {jwt_token}')]
```

---

## Error Codes

### Standard Error Response Format

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}
  }
}
```

### Error Code Reference

| Code | HTTP Status | Description |
|------|-------------|-------------|
| BAD_REQUEST | 400 | Invalid request parameters or body |
| UNAUTHORIZED | 401 | Missing or invalid authentication token |
| PAYMENT_REQUIRED | 402 | License validation failed |
| FORBIDDEN | 403 | Permission denied for requested operation |
| PERMISSION_DENIED | 403 | User lacks required permission |
| WORKFLOW_NOT_FOUND | 404 | Workflow does not exist |
| NOT_FOUND | 404 | Resource not found |
| RATE_LIMIT_EXCEEDED | 429 | Too many requests (webhooks) |
| INTERNAL_ERROR | 500 | Internal server error |
| EXECUTION_ERROR | 400 | Workflow execution failed |
| EXECUTION_TIMEOUT | 504 | Workflow execution timed out |
| WEBHOOK_NOT_FOUND | 404 | Webhook does not exist |
| WEBHOOK_DISABLED | 403 | Webhook is disabled |
| IP_NOT_ALLOWED | 403 | Client IP not in allowlist |
| SIGNATURE_REQUIRED | 403 | Webhook signature required but missing |
| SIGNATURE_INVALID | 403 | Webhook signature verification failed |
| INVALID_JSON | 400 | Request body is not valid JSON |

---

## Rate Limiting

### Webhook Rate Limiting

- Default: 60 requests per 60 seconds per webhook
- Configurable per webhook
- Uses sliding window algorithm
- Returns `429 Too Many Requests` when exceeded

### Response Headers

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1702742400
```

---

## Pagination

All list endpoints support pagination:

### Request Parameters

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| page | integer | 1 | - | Page number (1-indexed) |
| per_page | integer | 20 | 100 | Items per page |

### Response Metadata

```json
{
  "meta": {
    "pagination": {
      "page": 1,
      "per_page": 20,
      "total": 150,
      "total_pages": 8,
      "has_next": true,
      "has_prev": false
    }
  }
}
```

---

## Examples

### cURL Examples

#### Create Workflow

```bash
curl -X POST http://localhost:8070/api/v1/workflows \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Workflow",
    "description": "A test workflow",
    "entity_id": 123,
    "community_id": 456,
    "nodes": {},
    "connections": []
  }'
```

#### Execute Workflow

```bash
curl -X POST http://localhost:8070/api/v1/workflows/WORKFLOW_ID/execute \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "community_id": 456,
    "variables": {
      "username": "testuser"
    }
  }'
```

#### Trigger Webhook

```bash
curl -X POST http://localhost:8070/api/v1/workflows/webhooks/TOKEN \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=SIGNATURE" \
  -d '{
    "event": "test",
    "data": "value"
  }'
```

---

## SDK Examples

### Python

```python
import aiohttp

async def execute_workflow(workflow_id: str, token: str):
    async with aiohttp.ClientSession() as session:
        headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }
        data = {
            'community_id': 456,
            'variables': {
                'param1': 'value1'
            }
        }
        async with session.post(
            f'http://localhost:8070/api/v1/workflows/{workflow_id}/execute',
            headers=headers,
            json=data
        ) as response:
            return await response.json()
```

### JavaScript

```javascript
async function executeWorkflow(workflowId, token) {
  const response = await fetch(
    `http://localhost:8070/api/v1/workflows/${workflowId}/execute`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        community_id: 456,
        variables: {
          param1: 'value1'
        }
      })
    }
  );
  return await response.json();
}
```
