# OpenWhisk Action Module

Action pushing module for Apache OpenWhisk serverless platform. This module receives action tasks from the WaddleBot router/processor via gRPC and executes them on OpenWhisk.

## Features

- **gRPC API**: Receives action tasks from router
- **REST API**: Third-party integration with JWT authentication
- **Action Invocation**: Blocking and non-blocking action execution
- **Sequence Support**: Execute OpenWhisk action sequences
- **Web Actions**: Invoke web-accessible OpenWhisk actions
- **Triggers**: Fire OpenWhisk triggers
- **Activation Tracking**: Monitor action execution and retrieve results
- **Action Management**: List available actions in namespace
- **Async HTTP**: Uses aiohttp for high-performance HTTP calls
- **Database Logging**: PyDAL-based execution logging
- **Comprehensive AAA Logging**: Authentication, Authorization, and Auditing

## Architecture

This module is part of WaddleBot's action pushing architecture:

```
Router/Processor → gRPC → OpenWhisk Action Module → OpenWhisk API
                                ↓
                           Database Logging
```

## OpenWhisk REST API Integration

The module uses OpenWhisk REST API endpoints:

- `POST /api/v1/namespaces/{namespace}/actions/{action}` - Invoke action
- `POST /api/v1/namespaces/{namespace}/triggers/{trigger}` - Fire trigger
- `GET /api/v1/namespaces/{namespace}/activations/{id}` - Get activation
- `GET /api/v1/namespaces/{namespace}/actions` - List actions
- `POST /api/v1/web/{namespace}/{package}/{action}` - Invoke web action

## Configuration

All configuration is done via environment variables. See `.env.example` for all options.

### Required Environment Variables

```bash
OPENWHISK_API_HOST=https://openwhisk.example.com
OPENWHISK_AUTH_KEY=namespace:key
OPENWHISK_NAMESPACE=guest
DATABASE_URL=postgresql://user:pass@host:5432/waddlebot
MODULE_SECRET_KEY=your-64-char-secret-key
```

### OpenWhisk Authentication

OpenWhisk uses Basic authentication with the auth key in `namespace:key` format. The module automatically encodes this for HTTP requests.

For self-signed certificates, set `OPENWHISK_INSECURE=true`.

## API Endpoints

### Health Check

```bash
GET /health
```

No authentication required.

### Generate JWT Token

```bash
POST /api/v1/auth/token
Content-Type: application/json

{
  "api_key": "your-module-secret-key",
  "service": "my-service"
}
```

### Invoke Action

```bash
POST /api/v1/actions/invoke
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "namespace": "guest",
  "action_name": "hello",
  "payload": {"name": "World"},
  "blocking": true,
  "timeout": 60000
}
```

### Invoke Action Async

```bash
POST /api/v1/actions/invoke-async
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "namespace": "guest",
  "action_name": "hello",
  "payload": {"name": "World"}
}
```

### Invoke Sequence

```bash
POST /api/v1/sequences/invoke
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "namespace": "guest",
  "sequence_name": "my-sequence",
  "payload": {"input": "data"}
}
```

### Invoke Web Action

```bash
POST /api/v1/web-actions/invoke
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "namespace": "guest",
  "package_name": "default",
  "action_name": "hello",
  "payload": {"name": "World"},
  "method": "POST",
  "headers": {}
}
```

### Fire Trigger

```bash
POST /api/v1/triggers/fire
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "namespace": "guest",
  "trigger_name": "my-trigger",
  "payload": {"event": "data"}
}
```

### Get Activation

```bash
GET /api/v1/activations/<activation_id>?namespace=guest
Authorization: Bearer <jwt-token>
```

### List Actions

```bash
GET /api/v1/actions?namespace=guest&limit=30&skip=0
Authorization: Bearer <jwt-token>
```

### Get Statistics

```bash
GET /api/v1/stats
Authorization: Bearer <jwt-token>
```

## gRPC Service

The module implements the `OpenWhiskActionService` gRPC service defined in `proto/openwhisk_action.proto`.

### gRPC Methods

- `InvokeAction` - Invoke single action (blocking or non-blocking)
- `InvokeActionAsync` - Invoke action asynchronously
- `InvokeSequence` - Invoke action sequence
- `InvokeWebAction` - Invoke web action
- `FireTrigger` - Fire trigger
- `GetActivation` - Get activation details
- `ListActions` - List actions in namespace

## Database Schema

The module uses PyDAL with the following table:

```sql
openwhisk_action_executions (
    id SERIAL PRIMARY KEY,
    execution_id VARCHAR(255) NOT NULL,
    namespace VARCHAR(255) NOT NULL,
    action_name VARCHAR(255) NOT NULL,
    action_type VARCHAR(50) NOT NULL,  -- action, sequence, web_action, trigger
    payload TEXT,
    blocking BOOLEAN DEFAULT TRUE,
    timeout INTEGER,
    activation_id VARCHAR(255),
    result TEXT,
    duration_ms INTEGER,
    status VARCHAR(50),
    success BOOLEAN,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
)
```

## Building and Running

### Docker Build

```bash
# Build from repository root
docker build -f action/pushing/openwhisk_action_module/Dockerfile \
  -t waddlebot/openwhisk-action:latest .
```

### Docker Run

```bash
docker run -d \
  --name openwhisk-action \
  -p 8082:8082 \
  -p 50062:50062 \
  -e OPENWHISK_API_HOST=https://openwhisk.example.com \
  -e OPENWHISK_AUTH_KEY=namespace:key \
  -e DATABASE_URL=postgresql://user:pass@host:5432/waddlebot \
  -e MODULE_SECRET_KEY=your-secret-key \
  waddlebot/openwhisk-action:latest
```

### Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Generate gRPC code
python -m grpc_tools.protoc \
  -I./proto \
  --python_out=./proto \
  --grpc_python_out=./proto \
  ./proto/openwhisk_action.proto

# Run with Hypercorn
hypercorn app:app --bind 0.0.0.0:8082 --workers 4
```

## OpenWhisk Setup

### Install OpenWhisk

Follow the [OpenWhisk documentation](https://openwhisk.apache.org/documentation.html) to install OpenWhisk.

### Configure OpenWhisk CLI

```bash
# Set API host
wsk property set --apihost https://openwhisk.example.com

# Set auth key
wsk property set --auth namespace:key

# Test connection
wsk list
```

### Create Test Action

```bash
# Create simple action
cat > hello.js << EOF
function main(params) {
    return {payload: 'Hello, ' + params.name + '!'};
}
EOF

wsk action create hello hello.js
```

### Test Action

```bash
# Invoke action
wsk action invoke hello --param name World --result
```

## Logging

The module implements comprehensive AAA (Authentication, Authorization, and Auditing) logging:

- **Console**: All logs to stdout/stderr
- **File**: Rotating logs to `/var/log/waddlebotlog/openwhisk_action.log`
- **Syslog** (optional): Remote logging support

### Log Format

```
[timestamp] LEVEL module:function:line message
```

### Log Categories

- `INFO`: Normal operations
- `WARNING`: Authentication failures, invalid requests
- `ERROR`: Action execution failures, API errors
- `DEBUG`: Detailed execution flow (when LOG_LEVEL=DEBUG)

## Performance

- **Async HTTP**: aiohttp for non-blocking OpenWhisk API calls
- **Connection Pooling**: Reuses HTTP connections
- **Concurrent Processing**: Multiple actions processed concurrently
- **Configurable Timeouts**: Per-action timeout settings
- **Database Connection Pool**: PyDAL connection pooling

## Security

- **JWT Authentication**: All REST endpoints (except /health) require JWT
- **Basic Auth**: OpenWhisk API authentication with namespace:key
- **HTTPS Support**: TLS for OpenWhisk API calls
- **Self-signed Certs**: Optional support for development environments
- **Secret Management**: All secrets via environment variables

## Monitoring

### Health Check

```bash
curl http://localhost:8082/health
```

### Statistics

```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:8082/api/v1/stats
```

### Execution Logs

Query the `openwhisk_action_executions` table for detailed execution history.

## Integration with WaddleBot Router

The router invokes OpenWhisk actions for community modules (# prefix commands):

1. User types `#weather 90210`
2. Router finds command mapping to OpenWhisk action
3. Router sends gRPC request to OpenWhisk Action Module
4. Module invokes action on OpenWhisk
5. Result returned to router
6. Router sends response to user

## Troubleshooting

### Connection Refused

- Check `OPENWHISK_API_HOST` is correct
- Verify OpenWhisk is running and accessible
- Test with `curl $OPENWHISK_API_HOST/api/v1`

### Authentication Failed

- Verify `OPENWHISK_AUTH_KEY` format is `namespace:key`
- Test with OpenWhisk CLI: `wsk list`
- Check namespace exists

### Self-signed Certificate Errors

- Set `OPENWHISK_INSECURE=true` for development
- For production, use valid SSL certificates

### Action Timeout

- Increase `timeout` parameter in action invocation
- Check action is not hanging or in infinite loop
- Review action logs with `wsk activation logs <activation_id>`

## Development

### Generate gRPC Code

After modifying `proto/openwhisk_action.proto`:

```bash
python -m grpc_tools.protoc \
  -I./proto \
  --python_out=./proto \
  --grpc_python_out=./proto \
  ./proto/openwhisk_action.proto
```

### Run Tests

```bash
# TODO: Add pytest tests
pytest tests/
```

## Local Testing with Docker Compose

The easiest way to test the OpenWhisk integration locally is using docker-compose with the included test script.

### Quick Start

```bash
# Start OpenWhisk standalone and the action module
docker-compose up -d openwhisk openwhisk-action postgres redis

# Run the integration test
./scripts/test-openwhisk.sh
```

### Test Actions

A sample hello world action is included for testing:

**Location:** `actions/hello.js`

```javascript
function main(params) {
    const name = params.name || 'World';
    return {
        message: `Hello ${name}`,
        success: true
    };
}
```

### What the Test Does

1. Waits for OpenWhisk standalone to be healthy (port 3233)
2. Deploys the hello action to OpenWhisk via REST API
3. Waits for the openwhisk-action module to be healthy (port 8082)
4. Gets a JWT token from the module
5. Invokes the action through the WaddleBot openwhisk-action module
6. Verifies the response contains "Hello World"

### Environment Variables for Testing

The test script uses these defaults (can be overridden):

```bash
OPENWHISK_HOST=localhost
OPENWHISK_PORT=3233
ACTION_MODULE_HOST=localhost
ACTION_MODULE_PORT=8082
MODULE_SECRET_KEY=dev-secret-key-for-testing-only-change-in-production
```

## License

Part of WaddleBot. See repository LICENSE file.

## References

- [Apache OpenWhisk Documentation](https://openwhisk.apache.org/documentation.html)
- [OpenWhisk REST API](https://github.com/apache/openwhisk/blob/master/docs/rest_api.md)
- [WaddleBot Architecture](../../CLAUDE.md)
