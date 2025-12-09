# GCP Functions Action Module

A stateless, clusterable action module for invoking Google Cloud Functions from the WaddleBot ecosystem. This module receives tasks from the processor/router via gRPC and executes actions on GCP Cloud Functions.

## Features

- **Dual API**: Both gRPC and REST API support
- **Cloud Functions Integration**: Full support for GCP Cloud Functions v2 API
- **Authentication**: JWT-based authentication with service account support
- **Async Operations**: High-performance async operations using Quart
- **Batch Processing**: Support for batch function invocations
- **Function Management**: List and inspect Cloud Functions
- **Database Logging**: Complete audit trail in PostgreSQL
- **Comprehensive Logging**: AAA (Authentication, Authorization, Auditing) logging
- **Health Monitoring**: Built-in health check endpoint
- **Docker Ready**: Fully containerized with Kubernetes support

## Architecture

### Components

1. **REST API** (Port 8081): HTTP/JSON interface for third-party integrations
2. **gRPC Server** (Port 50061): High-performance RPC interface for internal communication
3. **GCP Functions Service**: Cloud Functions invocation and management
4. **Auth Service**: JWT token generation and validation
5. **Database**: PostgreSQL for storing invocation history

### Technology Stack

- **Python 3.13**: Modern Python with async support
- **Quart**: Async web framework (Flask-compatible API)
- **gRPC**: High-performance RPC framework
- **PyDAL**: Database abstraction layer
- **Google Cloud Functions API**: Official GCP client libraries
- **aiohttp**: Async HTTP client for function invocations
- **JWT**: Secure token-based authentication

## Installation

### Prerequisites

- Docker and Docker Compose
- GCP Project with Cloud Functions API enabled
- Service Account with Cloud Functions Invoker role
- PostgreSQL database

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Required
GCP_PROJECT_ID=your-gcp-project-id
GCP_SERVICE_ACCOUNT_KEY=/path/to/key.json
MODULE_SECRET_KEY=your-64-character-secret-key

# Optional (with defaults)
GCP_REGION=us-central1
DATABASE_URL=postgresql://waddlebot:password@postgres:5432/waddlebot
GRPC_PORT=50061
REST_PORT=8081
```

### Docker Build

```bash
# Build from repository root
cd /path/to/WaddleBot
docker build -f action/pushing/gcp_functions_action_module/Dockerfile \
  -t waddlebot/gcp-functions-action:latest .
```

### Docker Run

```bash
docker run -d \
  --name gcp-functions-action \
  --env-file .env \
  -p 8081:8081 \
  -p 50061:50061 \
  waddlebot/gcp-functions-action:latest
```

### Docker Compose

```yaml
version: '3.8'
services:
  gcp-functions-action:
    image: waddlebot/gcp-functions-action:latest
    environment:
      GCP_PROJECT_ID: ${GCP_PROJECT_ID}
      GCP_SERVICE_ACCOUNT_KEY: ${GCP_SERVICE_ACCOUNT_KEY}
      DATABASE_URL: postgresql://waddlebot:password@postgres:5432/waddlebot
      MODULE_SECRET_KEY: ${MODULE_SECRET_KEY}
    ports:
      - "8081:8081"
      - "50061:50061"
    depends_on:
      - postgres
    restart: unless-stopped
```

## REST API Usage

### Authentication

First, obtain a JWT token:

```bash
curl -X POST http://localhost:8081/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-module-secret-key",
    "service": "my-service"
  }'
```

Response:
```json
{
  "token": "eyJ0eXAiOiJKV1QiLCJhbGc...",
  "expires_in": 3600
}
```

Use this token in subsequent requests:
```bash
curl -H "Authorization: Bearer <token>" ...
```

### Invoke Cloud Function

```bash
curl -X POST http://localhost:8081/api/v1/functions/invoke \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "function_name": "my-function",
    "project": "my-project",
    "region": "us-central1",
    "payload": {
      "key": "value"
    }
  }'
```

Response:
```json
{
  "success": true,
  "status_code": 200,
  "response": "{\"result\": \"success\"}",
  "execution_time_ms": 245,
  "execution_id": "my-function_1701234567"
}
```

### Invoke HTTP Function

```bash
curl -X POST http://localhost:8081/api/v1/functions/invoke-http \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://us-central1-project.cloudfunctions.net/my-function",
    "method": "POST",
    "payload": {
      "data": "value"
    }
  }'
```

### Batch Invoke

```bash
curl -X POST http://localhost:8081/api/v1/functions/batch \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "invocations": [
      {
        "function_name": "function1",
        "payload": {"key": "value1"}
      },
      {
        "function_name": "function2",
        "payload": {"key": "value2"}
      }
    ]
  }'
```

Response:
```json
{
  "responses": [...],
  "total_count": 2,
  "success_count": 2,
  "failure_count": 0
}
```

### List Functions

```bash
curl -X GET "http://localhost:8081/api/v1/functions/list?project=my-project&region=us-central1" \
  -H "Authorization: Bearer <token>"
```

### Get Function Details

```bash
curl -X GET "http://localhost:8081/api/v1/functions/my-function/details?project=my-project&region=us-central1" \
  -H "Authorization: Bearer <token>"
```

### Health Check

```bash
curl http://localhost:8081/health
```

Response:
```json
{
  "status": "healthy",
  "module": "gcp_functions_action_module",
  "version": "1.0.0",
  "timestamp": "2024-12-02T10:00:00",
  "database": "connected",
  "gcp_project": "my-project",
  "gcp_region": "us-central1",
  "grpc_port": 50061,
  "rest_port": 8081
}
```

### Statistics

```bash
curl -X GET http://localhost:8081/api/v1/stats \
  -H "Authorization: Bearer <token>"
```

## gRPC API Usage

### Proto Definition

The gRPC service is defined in `proto/gcp_functions_action.proto`:

```protobuf
service GCPFunctionsActionService {
  rpc InvokeFunction(InvokeFunctionRequest) returns (InvokeFunctionResponse);
  rpc InvokeHTTPFunction(InvokeHTTPRequest) returns (InvokeHTTPResponse);
  rpc BatchInvoke(BatchInvokeRequest) returns (BatchInvokeResponse);
  rpc ListFunctions(ListFunctionsRequest) returns (ListFunctionsResponse);
  rpc GetFunctionDetails(GetFunctionDetailsRequest) returns (GetFunctionDetailsResponse);
}
```

### Python Client Example

```python
import grpc
from proto import gcp_functions_action_pb2
from proto import gcp_functions_action_pb2_grpc

# Create channel
channel = grpc.insecure_channel('localhost:50061')
stub = gcp_functions_action_pb2_grpc.GCPFunctionsActionServiceStub(channel)

# Invoke function
request = gcp_functions_action_pb2.InvokeFunctionRequest(
    project="my-project",
    region="us-central1",
    function_name="my-function",
    payload='{"key": "value"}'
)

response = stub.InvokeFunction(request)
print(f"Success: {response.success}")
print(f"Status: {response.status_code}")
print(f"Response: {response.response}")
```

## GCP Service Account Setup

### Create Service Account

```bash
# Create service account
gcloud iam service-accounts create waddlebot-functions \
  --display-name="WaddleBot Functions Invoker"

# Grant Cloud Functions Invoker role
gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:waddlebot-functions@my-project.iam.gserviceaccount.com" \
  --role="roles/cloudfunctions.invoker"

# Create and download key
gcloud iam service-accounts keys create ~/waddlebot-functions-key.json \
  --iam-account=waddlebot-functions@my-project.iam.gserviceaccount.com
```

### Required Permissions

The service account needs the following IAM roles:
- `roles/cloudfunctions.invoker` - Invoke Cloud Functions
- `roles/cloudfunctions.viewer` - List and view functions (optional)

## Database Schema

The module creates the following table:

```sql
CREATE TABLE gcp_function_invocations (
    id SERIAL PRIMARY KEY,
    execution_id VARCHAR(255) UNIQUE,
    project_id VARCHAR(255),
    region VARCHAR(100),
    function_name VARCHAR(255),
    payload TEXT,
    status_code INTEGER,
    success BOOLEAN,
    response TEXT,
    error TEXT,
    execution_time_ms INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GCP_PROJECT_ID` | Yes | - | GCP project ID |
| `GCP_REGION` | No | `us-central1` | Default GCP region |
| `GCP_SERVICE_ACCOUNT_KEY` | Yes | - | Path to key file or JSON string |
| `GCP_SERVICE_ACCOUNT_EMAIL` | No | - | Service account email |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `GRPC_PORT` | No | `50061` | gRPC server port |
| `REST_PORT` | No | `8081` | REST API port |
| `MODULE_SECRET_KEY` | Yes | - | 64-character secret key for JWT |
| `MAX_WORKERS` | No | `20` | Max worker threads |
| `MAX_BATCH_SIZE` | No | `100` | Max batch invocation size |
| `FUNCTION_TIMEOUT` | No | `60` | Function timeout (seconds) |
| `LOG_LEVEL` | No | `INFO` | Logging level |

## Performance Considerations

### Concurrency

- **Async Operations**: All I/O operations are async using `aiohttp` and `asyncio`
- **Worker Threads**: Configurable thread pool for gRPC operations
- **Batch Processing**: Support for concurrent batch invocations

### Scaling

- **Stateless Design**: Can be horizontally scaled without session affinity
- **Database Connection Pooling**: PyDAL manages connection pool
- **Resource Limits**: Configure `MAX_WORKERS` and `MAX_BATCH_SIZE` based on resources

### Optimization Tips

1. Use batch invocations for multiple functions
2. Configure appropriate timeouts for long-running functions
3. Monitor database connection pool size
4. Use read replicas for high-read scenarios

## Monitoring and Logging

### Logging Levels

- `DEBUG`: Detailed debug information
- `INFO`: General informational messages
- `WARNING`: Warning messages
- `ERROR`: Error messages with stack traces

### Log Outputs

1. **Console**: All logs to stdout/stderr
2. **File**: Rotating log files in `/var/log/waddlebotlog/`
3. **Syslog**: Optional syslog integration

### Metrics

Access `/api/v1/stats` endpoint for:
- Total invocations
- Success/failure counts
- Average execution time
- GCP configuration details

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `401 Unauthorized` | Invalid JWT token | Generate new token |
| `403 Forbidden` | Missing GCP permissions | Add IAM roles to service account |
| `404 Not Found` | Function doesn't exist | Verify function name and region |
| `504 Timeout` | Function execution timeout | Increase `FUNCTION_TIMEOUT` |
| `500 Server Error` | Internal error | Check logs for details |

### Retry Logic

The module implements automatic retries with exponential backoff for transient errors:
- Max retries: `MAX_RETRIES` (default: 3)
- Initial delay: `RETRY_DELAY` (default: 1 second)
- Backoff multiplier: 2x

## Security

### Authentication

- **JWT Tokens**: All REST API endpoints require JWT authentication (except `/health`)
- **Secret Key**: 64-character secret key for signing tokens
- **Token Expiration**: Configurable expiration (default: 1 hour)

### GCP Credentials

- **Service Account**: Use service account with least-privilege principle
- **Key Management**: Store keys securely, never commit to version control
- **Environment Variables**: Use secrets management for production

### Network Security

- **HTTPS**: Use HTTPS in production with TLS termination at load balancer
- **Firewall**: Restrict access to gRPC and REST ports
- **VPC**: Deploy within GCP VPC for internal communication

## Troubleshooting

### Module Won't Start

1. Check GCP credentials:
   ```bash
   gcloud auth application-default print-access-token
   ```

2. Verify database connectivity:
   ```bash
   psql $DATABASE_URL -c "SELECT 1"
   ```

3. Check logs:
   ```bash
   docker logs gcp-functions-action
   ```

### Function Invocation Fails

1. Verify function exists:
   ```bash
   gcloud functions list --region=us-central1
   ```

2. Test function directly:
   ```bash
   gcloud functions call my-function --data='{"key":"value"}'
   ```

3. Check IAM permissions:
   ```bash
   gcloud functions get-iam-policy my-function --region=us-central1
   ```

## Development

### Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Generate proto files
python -m grpc_tools.protoc \
  -I./proto \
  --python_out=./proto \
  --grpc_python_out=./proto \
  ./proto/gcp_functions_action.proto

# Run locally
export $(cat .env | xargs)
python app.py
```

### Testing

```bash
# Install test dependencies
pip install pytest pytest-asyncio pytest-cov

# Run tests
pytest tests/ -v --cov=.

# Run specific test
pytest tests/test_gcp_service.py -v
```

## Contributing

1. Follow WaddleBot code standards
2. Add tests for new features
3. Update documentation
4. Ensure all tests pass
5. Run linting: `flake8`, `black`, `mypy`

## License

Part of the WaddleBot project. See main LICENSE file.

## Support

For issues and questions:
- GitHub Issues: https://github.com/penguintech/WaddleBot
- Documentation: https://docs.waddlebot.io
- Company: https://www.penguintech.io
