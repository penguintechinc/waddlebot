# Lambda Action Module API Documentation

Complete API reference for Lambda Action Module REST and gRPC interfaces.

## Table of Contents

- [Authentication](#authentication)
- [REST API](#rest-api)
  - [Health Check](#health-check)
  - [Token Generation](#token-generation)
  - [Invoke Function](#invoke-function)
  - [Invoke Async](#invoke-async)
  - [Batch Invoke](#batch-invoke)
  - [List Functions](#list-functions)
  - [Get Function Config](#get-function-config)
- [gRPC API](#grpc-api)
- [Error Handling](#error-handling)
- [Examples](#examples)

## Authentication

All API endpoints (except `/health`) require JWT authentication using Bearer tokens.

### Generate Token

```bash
POST /api/v1/token
Content-Type: application/json

{
    "client_id": "your_client_id",
    "client_secret": "your_client_secret"
}
```

**Response:**
```json
{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 3600
}
```

### Using Token

Include the token in the Authorization header:

```bash
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## REST API

### Health Check

Check module health and configuration status.

**Endpoint:** `GET /health`

**Authentication:** None required

**Response:**
```json
{
    "status": "healthy",
    "module": "lambda_action_module",
    "version": "1.0.0",
    "timestamp": "2024-01-15T10:30:00.000000",
    "config": {
        "module_name": "lambda_action_module",
        "module_version": "1.0.0",
        "grpc_port": 50060,
        "rest_port": 8080,
        "database_configured": true,
        "aws_configured": true,
        "aws_region": "us-east-1",
        "max_concurrent_requests": 100,
        "request_timeout": 30,
        "log_level": "INFO"
    }
}
```

### Token Generation

Generate JWT token for API authentication.

**Endpoint:** `POST /api/v1/token`

**Authentication:** None required (credentials validated)

**Request Body:**
```json
{
    "client_id": "your_client_id",
    "client_secret": "your_client_secret"
}
```

**Response:**
```json
{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 3600
}
```

**Error Response:**
```json
{
    "error": "Missing client_id or client_secret"
}
```

### Invoke Function

Invoke a Lambda function synchronously or asynchronously.

**Endpoint:** `POST /api/v1/invoke`

**Authentication:** Required (Bearer token)

**Request Body:**
```json
{
    "function_name": "my-function",
    "payload": "{\"key\": \"value\"}",
    "invocation_type": "RequestResponse",
    "alias": "prod",
    "version": "1"
}
```

**Parameters:**
- `function_name` (required): Name or ARN of Lambda function
- `payload` (required): JSON string payload for the function
- `invocation_type` (optional): One of:
  - `RequestResponse` (default): Synchronous invocation
  - `Event`: Asynchronous invocation
  - `DryRun`: Validate parameters without invoking
- `alias` (optional): Function alias to invoke (e.g., "prod", "dev")
- `version` (optional): Function version to invoke (e.g., "1", "2")

**Success Response:**
```json
{
    "success": true,
    "status_code": 200,
    "payload": "{\"result\": \"success\"}",
    "executed_version": "$LATEST",
    "log_result": "START RequestId: abc123...\nEND RequestId: abc123...\n"
}
```

**Error Response:**
```json
{
    "success": false,
    "error": "Function error message",
    "status_code": 500
}
```

### Invoke Async

Invoke a Lambda function asynchronously (Event invocation type).

**Endpoint:** `POST /api/v1/invoke-async`

**Authentication:** Required (Bearer token)

**Request Body:**
```json
{
    "function_name": "my-function",
    "payload": "{\"key\": \"value\"}"
}
```

**Parameters:**
- `function_name` (required): Name or ARN of Lambda function
- `payload` (required): JSON string payload for the function

**Success Response:**
```json
{
    "success": true,
    "status_code": 202,
    "request_id": "abc123-def456-789"
}
```

**Error Response:**
```json
{
    "success": false,
    "error": "Error message",
    "status_code": 0
}
```

### Batch Invoke

Invoke multiple Lambda functions in sequence.

**Endpoint:** `POST /api/v1/batch`

**Authentication:** Required (Bearer token)

**Request Body:**
```json
{
    "invocations": [
        {
            "function_name": "function1",
            "payload": "{\"key\": \"value1\"}",
            "invocation_type": "RequestResponse"
        },
        {
            "function_name": "function2",
            "payload": "{\"key\": \"value2\"}",
            "alias": "prod"
        }
    ]
}
```

**Parameters:**
- `invocations` (required): Array of invocation requests, each with:
  - `function_name` (required): Name or ARN of Lambda function
  - `payload` (required): JSON string payload
  - `invocation_type` (optional): RequestResponse, Event, or DryRun
  - `alias` (optional): Function alias
  - `version` (optional): Function version

**Success Response:**
```json
{
    "results": [
        {
            "success": true,
            "status_code": 200,
            "payload": "{\"result\": \"success\"}",
            "error": null,
            "executed_version": "$LATEST",
            "log_result": "..."
        },
        {
            "success": true,
            "status_code": 200,
            "payload": "{\"result\": \"success\"}",
            "error": null,
            "executed_version": "prod",
            "log_result": "..."
        }
    ]
}
```

### List Functions

List Lambda functions in the configured AWS account.

**Endpoint:** `GET /api/v1/functions`

**Authentication:** Required (Bearer token)

**Query Parameters:**
- `max_items` (optional): Maximum number of functions to return (default: 50)
- `next_marker` (optional): Pagination marker for next page

**Success Response:**
```json
{
    "success": true,
    "functions": [
        {
            "function_name": "my-function",
            "function_arn": "arn:aws:lambda:us-east-1:123456789012:function:my-function",
            "runtime": "python3.11",
            "role": "arn:aws:iam::123456789012:role/lambda-role",
            "handler": "index.handler",
            "code_size": 1024,
            "description": "My Lambda function",
            "timeout": 300,
            "memory_size": 512,
            "last_modified": "2024-01-15T10:30:00.000+0000",
            "version": "$LATEST"
        }
    ],
    "next_marker": "marker_for_next_page"
}
```

**Error Response:**
```json
{
    "success": false,
    "error": "Error message"
}
```

### Get Function Config

Retrieve configuration for a specific Lambda function.

**Endpoint:** `GET /api/v1/functions/<function_name>`

**Authentication:** Required (Bearer token)

**Path Parameters:**
- `function_name`: Name or ARN of Lambda function

**Success Response:**
```json
{
    "success": true,
    "config": {
        "function_name": "my-function",
        "function_arn": "arn:aws:lambda:us-east-1:123456789012:function:my-function",
        "runtime": "python3.11",
        "role": "arn:aws:iam::123456789012:role/lambda-role",
        "handler": "index.handler",
        "code_size": 1024,
        "description": "My Lambda function",
        "timeout": 300,
        "memory_size": 512,
        "last_modified": "2024-01-15T10:30:00.000+0000",
        "version": "$LATEST"
    }
}
```

**Error Response:**
```json
{
    "success": false,
    "error": "Failed to retrieve function configuration"
}
```

## gRPC API

### Service Definition

```protobuf
service LambdaAction {
  rpc InvokeFunction(InvokeFunctionRequest) returns (InvokeFunctionResponse);
  rpc InvokeAsync(InvokeAsyncRequest) returns (InvokeAsyncResponse);
  rpc BatchInvoke(BatchInvokeRequest) returns (BatchInvokeResponse);
  rpc ListFunctions(ListFunctionsRequest) returns (ListFunctionsResponse);
  rpc GetFunctionConfig(GetFunctionConfigRequest) returns (GetFunctionConfigResponse);
}
```

### Message Types

See `proto/lambda_action.proto` for complete message definitions.

### gRPC Example (Python)

```python
import grpc
from proto import lambda_action_pb2, lambda_action_pb2_grpc

# Create channel
channel = grpc.insecure_channel('localhost:50060')
stub = lambda_action_pb2_grpc.LambdaActionStub(channel)

# Invoke function
request = lambda_action_pb2.InvokeFunctionRequest(
    function_name='my-function',
    payload='{"key": "value"}',
    invocation_type='RequestResponse',
    token='your_jwt_token'
)

response = stub.InvokeFunction(request)
print(f"Success: {response.success}")
print(f"Payload: {response.payload}")
```

## Error Handling

### HTTP Status Codes

- `200`: Success
- `400`: Bad request (missing parameters, invalid format)
- `401`: Unauthorized (missing or invalid token)
- `500`: Server error (AWS error, database error, etc.)
- `503`: Service unavailable (health check failed)

### Error Response Format

All error responses follow this format:

```json
{
    "error": "Error message description"
}
```

### Common Errors

**Authentication Errors:**
```json
{
    "error": "Missing or invalid authorization header"
}
```

```json
{
    "error": "Token expired"
}
```

```json
{
    "error": "Invalid token: ..."
}
```

**Request Errors:**
```json
{
    "error": "Missing function_name or payload"
}
```

**AWS Errors:**
```json
{
    "error": "AWS Lambda client error: ..."
}
```

## Examples

### cURL Examples

#### Get Health Status

```bash
curl -X GET http://localhost:8080/health
```

#### Generate Token

```bash
curl -X POST http://localhost:8080/api/v1/token \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "my_client",
    "client_secret": "my_secret"
  }'
```

#### Invoke Function

```bash
curl -X POST http://localhost:8080/api/v1/invoke \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "function_name": "my-function",
    "payload": "{\"name\": \"John\", \"action\": \"greet\"}",
    "invocation_type": "RequestResponse"
  }'
```

#### Invoke Async

```bash
curl -X POST http://localhost:8080/api/v1/invoke-async \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "function_name": "background-job",
    "payload": "{\"task\": \"process_data\"}"
  }'
```

#### Batch Invoke

```bash
curl -X POST http://localhost:8080/api/v1/batch \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "invocations": [
      {
        "function_name": "function1",
        "payload": "{\"data\": \"value1\"}"
      },
      {
        "function_name": "function2",
        "payload": "{\"data\": \"value2\"}"
      }
    ]
  }'
```

#### List Functions

```bash
curl -X GET "http://localhost:8080/api/v1/functions?max_items=10" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### Get Function Config

```bash
curl -X GET http://localhost:8080/api/v1/functions/my-function \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Python Examples

#### Using Requests Library

```python
import requests
import json

# Base URL
BASE_URL = "http://localhost:8080"

# Generate token
token_response = requests.post(
    f"{BASE_URL}/api/v1/token",
    json={"client_id": "my_client", "client_secret": "my_secret"}
)
token = token_response.json()["token"]

# Headers with token
headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json"
}

# Invoke function
invoke_response = requests.post(
    f"{BASE_URL}/api/v1/invoke",
    headers=headers,
    json={
        "function_name": "my-function",
        "payload": json.dumps({"key": "value"}),
        "invocation_type": "RequestResponse"
    }
)

result = invoke_response.json()
print(f"Success: {result['success']}")
print(f"Result: {result['payload']}")
```

### Lambda Function Example

Example Lambda function that works with this module:

```python
import json

def lambda_handler(event, context):
    """
    Example Lambda function handler

    Args:
        event: Event payload from Lambda Action Module
        context: Lambda context object

    Returns:
        Response with statusCode and body
    """
    # Extract data from event
    action = event.get('action')
    data = event.get('data')

    # Process action
    if action == 'greet':
        name = data.get('name', 'World')
        message = f"Hello, {name}!"
    elif action == 'calculate':
        x = data.get('x', 0)
        y = data.get('y', 0)
        message = f"Result: {x + y}"
    else:
        message = "Unknown action"

    # Return response
    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': message,
            'timestamp': context.request_id
        })
    }
```

## Rate Limiting

The module supports configurable rate limiting:

- `MAX_CONCURRENT_REQUESTS`: Maximum concurrent requests (default: 100)
- `REQUEST_TIMEOUT`: Request timeout in seconds (default: 30)

Rate limiting is enforced at the application level and helps prevent overwhelming the AWS Lambda service.

## Logging

All invocations are logged to the database with the following information:

- Function name
- Invocation type
- Payload
- Response status
- Error messages
- Execution timestamps

Access logs via database:

```sql
SELECT * FROM lambda_invocations
ORDER BY invoked_at DESC
LIMIT 10;
```

## Support

For issues and questions:
- Documentation: See README.md
- Website: https://www.penguintech.io
- License: AGPL-3.0 with Contributor Employer Exception
