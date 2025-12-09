# OpenWhisk Action Module Implementation

## Overview

This module implements the OpenWhisk action pushing functionality for WaddleBot. It receives action tasks from the router/processor via gRPC and executes them on Apache OpenWhisk serverless platform.

## Architecture

```
Router/Processor → gRPC → OpenWhisk Action Module → OpenWhisk REST API
                                ↓
                         Database (PyDAL)
```

## Components

### 1. Configuration (config.py)

- Environment-based configuration
- Validation of required settings
- Support for self-signed certificates (OPENWHISK_INSECURE)
- Configurable timeouts and limits

**Key Settings:**
- `OPENWHISK_API_HOST`: OpenWhisk API endpoint
- `OPENWHISK_AUTH_KEY`: Authentication key (namespace:key format)
- `OPENWHISK_NAMESPACE`: Default namespace
- `MODULE_SECRET_KEY`: 64-character shared secret for JWT

### 2. OpenWhisk Service (services/openwhisk_service.py)

Handles all communication with OpenWhisk REST API using aiohttp:

**Methods:**
- `invoke_action()`: Blocking or non-blocking action invocation
- `invoke_action_async()`: Async-only action invocation
- `invoke_sequence()`: Execute action sequences
- `invoke_web_action()`: Invoke web-accessible actions
- `fire_trigger()`: Fire OpenWhisk triggers
- `list_actions()`: List available actions
- `get_activation()`: Retrieve activation details

**Features:**
- Async HTTP with aiohttp
- Connection pooling and reuse
- Basic authentication with namespace:key
- SSL/TLS support with optional insecure mode
- Comprehensive error handling and logging

### 3. Auth Service (services/auth_service.py)

JWT token management:
- `create_token()`: Generate JWT tokens
- `verify_token()`: Validate JWT tokens
- `validate_api_key()`: Validate API keys

### 4. gRPC Handler (services/grpc_handler.py)

Implements `OpenWhiskActionService` gRPC interface:

**gRPC Methods:**
- `InvokeAction`: Single action invocation
- `InvokeActionAsync`: Async action invocation
- `InvokeSequence`: Sequence invocation
- `InvokeWebAction`: Web action invocation
- `FireTrigger`: Trigger firing
- `GetActivation`: Activation retrieval
- `ListActions`: Action listing

**Features:**
- JSON payload parsing
- Error handling and logging
- Result serialization

### 5. Main Application (app.py)

Quart-based REST API and gRPC server:

**REST Endpoints:**
- `GET /health`: Health check (no auth)
- `POST /api/v1/auth/token`: Generate JWT token
- `POST /api/v1/actions/invoke`: Invoke action
- `POST /api/v1/actions/invoke-async`: Async invocation
- `POST /api/v1/sequences/invoke`: Invoke sequence
- `POST /api/v1/web-actions/invoke`: Invoke web action
- `POST /api/v1/triggers/fire`: Fire trigger
- `GET /api/v1/activations/<id>`: Get activation
- `GET /api/v1/actions`: List actions
- `GET /api/v1/stats`: Module statistics

**Features:**
- Comprehensive AAA logging
- PyDAL database integration
- JWT authentication on all endpoints (except /health)
- Concurrent gRPC and REST servers
- Execution tracking and history

### 6. Database Schema

**Table: openwhisk_action_executions**
- `execution_id`: Unique execution identifier
- `namespace`: OpenWhisk namespace
- `action_name`: Action/sequence/trigger name
- `action_type`: action, sequence, web_action, trigger
- `payload`: JSON payload
- `blocking`: Blocking mode flag
- `timeout`: Timeout in milliseconds
- `activation_id`: OpenWhisk activation ID
- `result`: Execution result (JSON)
- `duration_ms`: Execution duration
- `status`: Execution status
- `success`: Success/failure flag
- `error`: Error message if failed
- `created_at`: Execution start time
- `completed_at`: Execution completion time

### 7. Protobuf Definition (proto/openwhisk_action.proto)

gRPC service definition with:
- Request/response messages for all operations
- Support for JSON payloads
- Activation tracking
- Error reporting

## Deployment

### Docker Build

```bash
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
  -e DATABASE_URL=postgresql://user:pass@host/waddlebot \
  -e MODULE_SECRET_KEY=your-64-char-secret \
  waddlebot/openwhisk-action:latest
```

## Integration with WaddleBot

1. **Router Configuration**: Router configured to use OpenWhisk for # commands
2. **Module Registration**: Module registers with router on startup
3. **Command Processing**: Router forwards # commands to OpenWhisk module
4. **Action Execution**: Module invokes OpenWhisk action
5. **Result Handling**: Results returned to router, then to user

## OpenWhisk REST API Mapping

| Module Operation | OpenWhisk Endpoint |
|-----------------|-------------------|
| InvokeAction | POST /api/v1/namespaces/{ns}/actions/{action} |
| FireTrigger | POST /api/v1/namespaces/{ns}/triggers/{trigger} |
| GetActivation | GET /api/v1/namespaces/{ns}/activations/{id} |
| ListActions | GET /api/v1/namespaces/{ns}/actions |
| InvokeWebAction | POST /api/v1/web/{ns}/{package}/{action} |

## Security

- **Authentication**: Basic auth for OpenWhisk, JWT for REST API
- **Authorization**: Module secret key validation
- **Transport**: HTTPS for OpenWhisk API calls
- **Secrets**: All secrets via environment variables
- **Database**: Prepared statements via PyDAL

## Performance

- **Async HTTP**: Non-blocking OpenWhisk API calls
- **Connection Pooling**: HTTP connection reuse
- **Concurrent Processing**: Multiple actions processed in parallel
- **Database Pooling**: PyDAL connection pool (size: 10)
- **Configurable Timeouts**: Per-action timeout settings

## Monitoring

- **Health Endpoint**: `/health` with database connectivity check
- **Statistics**: `/api/v1/stats` with execution counts
- **Logging**: Comprehensive AAA logging to console, file, and syslog
- **Database**: Full execution history in database

## Testing

### Unit Tests (Future)

- Test OpenWhisk service methods
- Test JWT authentication
- Test gRPC handlers
- Test database operations

### Integration Tests (Future)

- Test with mock OpenWhisk server
- Test gRPC service end-to-end
- Test REST API endpoints
- Test error handling

## Future Enhancements

1. **Retry Logic**: Automatic retry for transient failures
2. **Circuit Breaker**: Prevent cascading failures
3. **Rate Limiting**: Protect OpenWhisk from overload
4. **Caching**: Cache action results for idempotent operations
5. **Metrics**: Prometheus metrics export
6. **Tracing**: Distributed tracing integration
7. **Webhooks**: Support for OpenWhisk webhook actions
8. **Packages**: Full package management support
9. **Rules**: Support for OpenWhisk rules
10. **API Gateway**: Integration with OpenWhisk API Gateway

## References

- [Apache OpenWhisk](https://openwhisk.apache.org/)
- [OpenWhisk REST API](https://github.com/apache/openwhisk/blob/master/docs/rest_api.md)
- [WaddleBot Architecture](../../CLAUDE.md)
