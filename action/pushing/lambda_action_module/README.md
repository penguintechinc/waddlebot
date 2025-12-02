# Lambda Action Module

Stateless, clusterable module for pushing actions to AWS Lambda functions. Receives tasks via gRPC from the processor/router and provides REST API for third-party integrations.

## Features

- **AWS Lambda Integration**: Invoke Lambda functions synchronously and asynchronously
- **Function Management**: List functions and retrieve function configurations
- **Batch Invocations**: Support for batch Lambda invocations
- **Dual API Support**: Both gRPC and REST endpoints
- **JWT Authentication**: Secure API access with JWT tokens
- **Database Logging**: Track all Lambda invocations in database
- **Async Support**: Built on Quart for high-performance async operations
- **Version Control**: Support for Lambda aliases and versions
- **Comprehensive Logging**: AAA logging with rotating file and syslog support

## Architecture

- **Framework**: Quart (async Flask) + gRPC
- **AWS SDK**: boto3 with async executor support
- **Database**: PyDAL with PostgreSQL
- **Authentication**: JWT with 64-character shared secret
- **Ports**: gRPC (50060), REST (8080)

## Installation

### Prerequisites

- Python 3.13+
- AWS credentials with Lambda invoke permissions
- PostgreSQL database
- Docker (for containerized deployment)

### Local Development

```bash
# Clone repository
cd /path/to/WaddleBot/action/pushing/lambda_action_module

# Install dependencies
pip install -r requirements.txt

# Generate protobuf files
python -m grpc_tools.protoc \
    -I./proto \
    --python_out=./proto \
    --grpc_python_out=./proto \
    ./proto/lambda_action.proto

# Copy environment file and configure
cp .env.example .env
# Edit .env with your AWS credentials and configuration

# Run application
python app.py
```

### Docker Deployment

```bash
# Build container
docker build -f Dockerfile -t waddlebot/lambda-action:latest .

# Run container
docker run -d \
    --name lambda-action \
    -p 50060:50060 \
    -p 8080:8080 \
    -e AWS_ACCESS_KEY_ID=your_key \
    -e AWS_SECRET_ACCESS_KEY=your_secret \
    -e AWS_REGION=us-east-1 \
    -e DATABASE_URL=postgresql://user:pass@host:5432/waddlebot \
    -e MODULE_SECRET_KEY=your_64_char_secret_key \
    waddlebot/lambda-action:latest
```

## Configuration

All configuration is done via environment variables. See `.env.example` for all available options.

### Required Configuration

- `AWS_ACCESS_KEY_ID`: AWS access key ID
- `AWS_SECRET_ACCESS_KEY`: AWS secret access key
- `AWS_REGION`: AWS region (default: us-east-1)
- `DATABASE_URL`: PostgreSQL connection string
- `MODULE_SECRET_KEY`: 64-character JWT secret key

### Optional Configuration

- `GRPC_PORT`: gRPC server port (default: 50060)
- `REST_PORT`: REST API port (default: 8080)
- `LAMBDA_FUNCTION_PREFIX`: Prefix for Lambda functions (default: waddlebot-)
- `LAMBDA_TIMEOUT`: Lambda timeout in seconds (default: 300)
- `LAMBDA_MEMORY_SIZE`: Lambda memory size in MB (default: 512)
- `MAX_CONCURRENT_REQUESTS`: Maximum concurrent requests (default: 100)
- `LOG_LEVEL`: Logging level (default: INFO)

## API Reference

### REST API

#### Health Check

```bash
GET /health
```

Returns module health status and configuration summary.

#### Generate Token

```bash
POST /api/v1/token
Content-Type: application/json

{
    "client_id": "your_client_id",
    "client_secret": "your_client_secret"
}
```

Returns JWT token for API authentication.

#### Invoke Function

```bash
POST /api/v1/invoke
Authorization: Bearer <token>
Content-Type: application/json

{
    "function_name": "my-function",
    "payload": "{\"key\": \"value\"}",
    "invocation_type": "RequestResponse",
    "alias": "prod",
    "version": "1"
}
```

Invokes Lambda function synchronously or asynchronously.

**Invocation Types:**
- `RequestResponse`: Synchronous invocation (default)
- `Event`: Asynchronous invocation
- `DryRun`: Validate parameters without invoking

#### Invoke Async

```bash
POST /api/v1/invoke-async
Authorization: Bearer <token>
Content-Type: application/json

{
    "function_name": "my-function",
    "payload": "{\"key\": \"value\"}"
}
```

Invokes Lambda function asynchronously (Event invocation type).

#### Batch Invoke

```bash
POST /api/v1/batch
Authorization: Bearer <token>
Content-Type: application/json

{
    "invocations": [
        {
            "function_name": "function1",
            "payload": "{\"key\": \"value1\"}"
        },
        {
            "function_name": "function2",
            "payload": "{\"key\": \"value2\"}"
        }
    ]
}
```

Invokes multiple Lambda functions in sequence.

#### List Functions

```bash
GET /api/v1/functions?max_items=50&next_marker=marker
Authorization: Bearer <token>
```

Lists Lambda functions in the configured AWS account.

#### Get Function Config

```bash
GET /api/v1/functions/<function_name>
Authorization: Bearer <token>
```

Retrieves configuration for a specific Lambda function.

### gRPC API

See `proto/lambda_action.proto` for complete gRPC service definition.

**Services:**
- `InvokeFunction`: Invoke Lambda function with options
- `InvokeAsync`: Invoke Lambda function asynchronously
- `BatchInvoke`: Batch invoke multiple functions
- `ListFunctions`: List available Lambda functions
- `GetFunctionConfig`: Get function configuration

## Database Schema

### lambda_invocations

Tracks all Lambda invocations for audit and debugging.

```sql
CREATE TABLE lambda_invocations (
    id SERIAL PRIMARY KEY,
    function_name VARCHAR(255) NOT NULL,
    invocation_type VARCHAR(50) NOT NULL,
    payload TEXT,
    alias VARCHAR(255),
    version VARCHAR(50),
    status_code INTEGER,
    response_payload TEXT,
    function_error VARCHAR(255),
    executed_version VARCHAR(50),
    request_id VARCHAR(255),
    success BOOLEAN,
    error_message TEXT,
    invoked_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);
```

## Security

- **JWT Authentication**: All API endpoints (except `/health`) require JWT authentication
- **64-Character Secret**: Minimum 64-character secret key for JWT signing
- **AWS IAM**: Uses AWS IAM credentials for Lambda access
- **Non-Root Container**: Docker container runs as non-root user
- **Rate Limiting**: Configurable max concurrent requests

## Performance

- **Async Operations**: All AWS calls run in executor for async compatibility
- **Connection Pooling**: Database connection pooling (10 connections)
- **Worker Threads**: gRPC server with 10 worker threads
- **Hypercorn Workers**: REST API with 4 Hypercorn workers
- **Batch Processing**: Support for batch invocations

## Logging

Comprehensive AAA (Authentication, Authorization, Auditing) logging:

- **Console**: stdout for container orchestration
- **File**: Rotating file handler (10MB, 5 backups)
- **Syslog**: Optional syslog support
- **Database**: All invocations logged to database

## Error Handling

- **Retry Logic**: Configurable retry count and delay
- **Graceful Failures**: Detailed error messages in responses
- **Database Logging**: All errors logged to database
- **Health Checks**: Automatic health monitoring

## Integration

### Router Integration

The router module invokes Lambda functions through this action module:

```python
# Router sends gRPC request
response = await lambda_client.InvokeFunction(
    function_name="waddlebot-command-handler",
    payload=json.dumps({"command": "!help", "user": "john"}),
    invocation_type="RequestResponse",
    token=jwt_token
)
```

### Lambda Function Format

Lambda functions should accept the following format:

```python
def lambda_handler(event, context):
    # event contains the payload from router
    command = event.get('command')
    user = event.get('user')

    # Process command
    result = process_command(command, user)

    # Return response
    return {
        'statusCode': 200,
        'body': json.dumps(result)
    }
```

## Monitoring

- **Health Endpoint**: `/health` for liveness/readiness probes
- **Database Metrics**: Track invocation counts and success rates
- **AWS CloudWatch**: Lambda execution logs and metrics
- **Log Files**: Rotating log files for troubleshooting

## Development

### Run Tests

```bash
# Install test dependencies
pip install pytest pytest-asyncio pytest-cov

# Run tests
pytest tests/ -v --cov=.
```

### Generate Protobuf

```bash
python -m grpc_tools.protoc \
    -I./proto \
    --python_out=./proto \
    --grpc_python_out=./proto \
    ./proto/lambda_action.proto
```

### Lint Code

```bash
# Install linting tools
pip install flake8 black isort

# Run linters
flake8 .
black --check .
isort --check .
```

## License

Licensed under AGPL-3.0 with Contributor Employer Exception. See LICENSE file for details.

## Support

For issues and questions, visit: https://www.penguintech.io
