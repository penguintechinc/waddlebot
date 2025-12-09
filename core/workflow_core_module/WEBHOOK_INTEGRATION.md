# Webhook API Integration Guide

This document explains how to integrate the webhook API controller into the workflow_core_module application.

## Prerequisites

The webhook API requires:
1. WorkflowService instance
2. PermissionService instance
3. WorkflowEngine instance
4. AsyncDAL database instance
5. Proper database schema (see below)

## Integration Steps

### 1. Update Database Schema

Add the `workflow_webhooks` table to your database migrations:

```sql
-- config/postgres/migrations/003_add_webhooks_table.sql

CREATE TABLE IF NOT EXISTS workflow_webhooks (
    webhook_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL,
    token VARCHAR(255) UNIQUE NOT NULL,
    secret VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    url TEXT,
    enabled BOOLEAN DEFAULT true,
    require_signature BOOLEAN DEFAULT true,
    ip_allowlist TEXT[] DEFAULT '{}',
    rate_limit_max INTEGER DEFAULT 60,
    rate_limit_window INTEGER DEFAULT 60,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_triggered_at TIMESTAMP,
    last_execution_id UUID,
    trigger_count INTEGER DEFAULT 0,

    FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_webhooks_token ON workflow_webhooks(token);
CREATE INDEX idx_workflow_webhooks_workflow ON workflow_webhooks(workflow_id);
CREATE INDEX idx_workflow_webhooks_enabled ON workflow_webhooks(enabled);
```

### 2. Update app.py

Modify `/home/penguin/code/WaddleBot/core/workflow_core_module/app.py`:

```python
"""Workflow Core Module - Quart Application"""
import asyncio
import os
import sys

from quart import Blueprint, Quart

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))

from config import Config  # noqa: E402
from flask_core import (  # noqa: E402
    async_endpoint, create_health_blueprint, init_database, setup_aaa_logging, success_response,
)

# Import services
from services.license_service import LicenseService  # noqa: E402
from services.permission_service import PermissionService  # noqa: E402
from services.validation_service import WorkflowValidationService  # noqa: E402
from services.workflow_service import WorkflowService  # noqa: E402
from services.workflow_engine import WorkflowEngine  # noqa: E402

# Import controllers
from controllers.workflow_api import register_workflow_api  # noqa: E402
from controllers.webhook_api import register_webhook_api  # noqa: E402

app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

# API Blueprint for v1
api_bp = Blueprint('api', __name__, url_prefix='/api/v1')

# Initialize logging
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

# Service instances
dal = None
license_service = None
permission_service = None
validation_service = None
workflow_service = None
workflow_engine = None


@app.before_serving
async def startup():
    """Initialize application on startup"""
    global dal, license_service, permission_service, validation_service, workflow_service, workflow_engine

    logger.system(
        "Starting workflow_core_module",
        action="startup",
        extra={"port": Config.PORT, "feature_workflows": Config.FEATURE_WORKFLOWS_ENABLED}
    )
    try:
        # Initialize database
        dal = init_database(Config.DATABASE_URI)
        app.config['dal'] = dal

        # Initialize services
        license_service = LicenseService(
            license_server_url=Config.LICENSE_SERVER_URL,
            redis_url=Config.REDIS_URL,
            release_mode=Config.RELEASE_MODE,
            logger_instance=logger
        )
        await license_service.connect()

        permission_service = PermissionService(dal=dal, logger=logger)

        validation_service = WorkflowValidationService()

        workflow_service = WorkflowService(
            dal=dal,
            license_service=license_service,
            permission_service=permission_service,
            validation_service=validation_service,
            logger_instance=logger
        )

        # Initialize workflow engine
        workflow_engine = WorkflowEngine(
            dal=dal,
            router_url=Config.ROUTER_URL,
            max_loop_iterations=Config.WORKFLOW_MAX_LOOP_ITERATIONS,
            max_total_operations=Config.WORKFLOW_MAX_TOTAL_OPERATIONS,
            max_loop_depth=Config.WORKFLOW_MAX_LOOP_DEPTH,
            default_timeout=Config.WORKFLOW_TIMEOUT,
            max_parallel_nodes=Config.WORKFLOW_MAX_PARALLEL_NODES
        )

        # Register workflow API
        register_workflow_api(app, workflow_service)

        # Register webhook API
        register_webhook_api(app, workflow_service, permission_service, workflow_engine)

        logger.system("workflow_core_module started successfully", result="SUCCESS")
    except Exception as e:
        logger.error(f"Failed to start workflow_core_module: {str(e)}", result="FAILURE")
        raise


@app.after_serving
async def shutdown():
    """Cleanup on shutdown"""
    global license_service

    logger.system("Shutting down workflow_core_module", action="shutdown")
    try:
        # Disconnect license service
        if license_service:
            await license_service.disconnect()

        # Close database connection if needed
        if dal:
            pass

        logger.system("workflow_core_module shutdown complete", result="SUCCESS")
    except Exception as e:
        logger.error(f"Error during shutdown: {str(e)}", result="FAILURE")


@api_bp.route('/status', methods=['GET'])
@async_endpoint
async def status():
    """Get workflow module status"""
    return success_response({
        "status": "operational",
        "module": Config.MODULE_NAME,
        "version": Config.MODULE_VERSION,
        "features": {
            "workflows_enabled": Config.FEATURE_WORKFLOWS_ENABLED,
            "webhooks_enabled": True,
            "release_mode": Config.RELEASE_MODE
        }
    })


@api_bp.route('/health', methods=['GET'])
@async_endpoint
async def health_check():
    """Health check endpoint"""
    return success_response({
        "healthy": True,
        "module": Config.MODULE_NAME
    })


# Register API blueprint
app.register_blueprint(api_bp)


if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
```

### 3. Update Config

Add webhook-related configuration to `config.py`:

```python
# Workflow execution settings
WORKFLOW_TIMEOUT = int(os.getenv('WORKFLOW_TIMEOUT', '300'))  # 5 minutes
WORKFLOW_MAX_LOOP_ITERATIONS = int(os.getenv('WORKFLOW_MAX_LOOP_ITERATIONS', '100'))
WORKFLOW_MAX_TOTAL_OPERATIONS = int(os.getenv('WORKFLOW_MAX_TOTAL_OPERATIONS', '1000'))
WORKFLOW_MAX_LOOP_DEPTH = int(os.getenv('WORKFLOW_MAX_LOOP_DEPTH', '10'))
WORKFLOW_MAX_PARALLEL_NODES = int(os.getenv('WORKFLOW_MAX_PARALLEL_NODES', '10'))

# Router service URL for webhook execution
ROUTER_URL = os.getenv('ROUTER_URL', 'http://router-service:8000')
```

### 4. Update Controllers __init__.py

Update `/home/penguin/code/WaddleBot/core/workflow_core_module/controllers/__init__.py`:

```python
"""Controllers for workflow_core_module"""

from .workflow_api import (
    workflow_api,
    register_workflow_api,
)
from .webhook_api import (
    webhook_api,
    register_webhook_api,
    WebhookConfig,
    WebhookRateLimiter,
)

__all__ = [
    "workflow_api",
    "register_workflow_api",
    "webhook_api",
    "register_webhook_api",
    "WebhookConfig",
    "WebhookRateLimiter",
]
```

### 5. Update Services __init__.py

Update `/home/penguin/code/WaddleBot/core/workflow_core_module/services/__init__.py`:

```python
"""Services for workflow_core_module"""

from .license_service import (
    LicenseService,
    LicenseStatus,
    LicenseTier,
    LicenseException,
    LicenseValidationException
)
from .validation_service import (
    WorkflowValidationService,
    ValidationResult,
)
from .permission_service import (
    PermissionService,
    PermissionInfo,
    GrantResult,
)
from .workflow_engine import (
    WorkflowEngine,
    WorkflowEngineException,
    WorkflowTimeoutException,
    WorkflowLoopException,
    NodeExecutionException,
)
from .workflow_service import (
    WorkflowService,
    WorkflowServiceException,
    WorkflowNotFoundException,
    WorkflowPermissionException,
)

__all__ = [
    "LicenseService",
    "LicenseStatus",
    "LicenseTier",
    "LicenseException",
    "LicenseValidationException",
    "WorkflowValidationService",
    "ValidationResult",
    "PermissionService",
    "PermissionInfo",
    "GrantResult",
    "WorkflowEngine",
    "WorkflowEngineException",
    "WorkflowTimeoutException",
    "WorkflowLoopException",
    "NodeExecutionException",
    "WorkflowService",
    "WorkflowServiceException",
    "WorkflowNotFoundException",
    "WorkflowPermissionException",
]
```

## API Endpoints

After integration, the following endpoints will be available:

### Webhook Management (Authenticated)

- `GET /api/v1/workflows/:id/webhooks` - List webhooks
- `POST /api/v1/workflows/:id/webhooks` - Create webhook
- `DELETE /api/v1/workflows/:id/webhooks/:webhookId` - Delete webhook

### Public Webhook Trigger

- `POST /api/v1/workflows/webhooks/:token` - Trigger workflow (no auth required)

## Testing Integration

### 1. Run the Application

```bash
cd /home/penguin/code/WaddleBot/core/workflow_core_module
python app.py
```

### 2. Create a Webhook

```bash
curl -X POST http://localhost:8000/api/v1/workflows/{workflow_id}/webhooks \
  -H "X-API-Key: test-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Webhook",
    "require_signature": true
  }'
```

### 3. Trigger the Webhook

```bash
curl -X POST http://localhost:8000/api/v1/workflows/webhooks/{token} \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

## Troubleshooting

### Webhook Not Found

- Verify token is correct
- Check token is not typo'd
- Ensure webhook is enabled

### Signature Invalid

- Verify secret is correct
- Check message construction: `token + body`
- Ensure HMAC algorithm is SHA256

### Rate Limit Exceeded

- Reduce request frequency
- Configure higher rate_limit_max
- Increase rate_limit_window

### Permission Denied

- Verify user has `can_edit` permission on workflow
- Check API key is correct
- Ensure user is authenticated

## Production Deployment

### Docker

```dockerfile
FROM python:3.13-slim

WORKDIR /app

COPY . /app
RUN pip install -r requirements.txt

EXPOSE 8000

CMD ["python", "app.py"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workflow-core
spec:
  replicas: 3
  selector:
    matchLabels:
      app: workflow-core
  template:
    metadata:
      labels:
        app: workflow-core
    spec:
      containers:
      - name: workflow-core
        image: waddlebot/workflow-core:latest
        ports:
        - containerPort: 8000
        env:
        - name: DATABASE_URI
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: uri
        - name: FEATURE_WORKFLOWS_ENABLED
          value: "true"
        livenessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 5
```

## Performance Considerations

- **Rate Limiting**: In-memory sliding window (resets on restart)
- **Concurrency**: Multiple webhook requests processed concurrently
- **Database**: Async operations, connection pooling recommended
- **Execution**: Workflow execution is asynchronous, returns immediately

## Security Checklist

- [x] HMAC signature verification implemented
- [x] IP allowlisting supported
- [x] Rate limiting per webhook
- [x] Comprehensive audit logging
- [x] Permission checks on management endpoints
- [x] Public endpoint has no auth requirement (secure via signature)
- [ ] Enable HTTPS in production
- [ ] Configure firewall rules appropriately
- [ ] Regular security audits of webhook configurations

## References

- [Webhook API Documentation](../docs/webhook-api.md)
- [Workflow API Documentation](../docs/api-reference.md)
- [Database Schema](../docs/database-schema.md)
