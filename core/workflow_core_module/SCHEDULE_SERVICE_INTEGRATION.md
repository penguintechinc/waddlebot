# Schedule Service Integration Guide

## Overview

This guide covers how to integrate the `ScheduleService` into the workflow_core_module application, including initialization, lifecycle management, and API integration.

## Architecture Integration

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Flask/Quart Application (app.py)                            │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐│
│ │ Startup/Shutdown Handlers                                ││
│ │ - Initialize ScheduleService                             ││
│ │ - Start scheduler background task                        ││
│ │ - Graceful shutdown on app stop                          ││
│ └──────────────────────────────────────────────────────────┘│
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐│
│ │ API Endpoints (controllers/schedule_api.py - new)        ││
│ │ - POST /api/v1/schedules - Create schedule              ││
│ │ - GET /api/v1/schedules/{id} - Get schedule             ││
│ │ - PUT /api/v1/schedules/{id} - Update schedule          ││
│ │ - DELETE /api/v1/schedules/{id} - Remove schedule       ││
│ └──────────────────────────────────────────────────────────┘│
│          │                                                   │
│          ▼                                                   │
│ ┌──────────────────────────────────────────────────────────┐│
│ │ ScheduleService (services/schedule_service.py)           ││
│ │ - Schedule CRUD operations                               ││
│ │ - APScheduler management                                 ││
│ │ - Execution triggering via WorkflowEngine                ││
│ └──────────────────────────────────────────────────────────┘│
│          │                                                   │
│          ├──────────────────────────────────────────┐       │
│          ▼                                          ▼       │
│ ┌─────────────────────────┐        ┌──────────────────────┐│
│ │ WorkflowEngine          │        │ APScheduler          ││
│ │ - Execute workflows     │        │ - Background jobs    ││
│ │ - Track execution state │        │ - Cron/Interval jobs ││
│ │ - Error handling        │        │ - Job listeners      ││
│ └─────────────────────────┘        └──────────────────────┘│
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐│
│ │ AsyncDAL (Database)                                      ││
│ │ - PostgreSQL workflow_schedules table                    ││
│ │ - Async database operations                             ││
│ │ - Connection pooling                                    ││
│ └──────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Step-by-Step Integration

### Step 1: Update imports in app.py

```python
# app.py
import logging
from flask import Flask
from quart import Quart
import asyncio

from config import Config
from flask_core import AsyncDAL, setup_aaa_logging, get_logger

from services import (
    WorkflowEngine,
    ScheduleService,
    LicenseService,
    PermissionService,
    WorkflowValidationService,
)

logger = get_logger(__name__)
```

### Step 2: Initialize ScheduleService in Application

```python
# app.py - application factory

async def create_app():
    """Create and configure Flask/Quart application"""
    app = Quart(__name__)
    app.config.from_object(Config)

    # Setup logging
    setup_aaa_logging(
        module_name=Config.MODULE_NAME,
        version=Config.MODULE_VERSION,
        log_dir=Config.LOG_DIR,
        log_level=Config.LOG_LEVEL
    )

    # Initialize database
    dal = AsyncDAL(
        database_uri=Config.DATABASE_URI,
        read_replica_uris=Config.READ_REPLICA_URIS
    )
    await dal.initialize()

    # Initialize services
    license_service = LicenseService(dal=dal)
    permission_service = PermissionService(dal=dal)
    validation_service = WorkflowValidationService()

    workflow_engine = WorkflowEngine(
        dal=dal,
        router_url=Config.ROUTER_URL,
        max_loop_iterations=100,
        max_total_operations=1000,
        max_loop_depth=10,
        default_timeout=Config.WORKFLOW_TIMEOUT_SECONDS
    )

    # Initialize ScheduleService
    schedule_service = ScheduleService(
        dal=dal,
        workflow_engine=workflow_engine,
        grace_period_minutes=15,
        logger_instance=logger
    )

    # Store services in app context
    app.dal = dal
    app.workflow_engine = workflow_engine
    app.schedule_service = schedule_service
    app.license_service = license_service
    app.permission_service = permission_service
    app.validation_service = validation_service

    # Register startup/shutdown handlers
    @app.before_serving
    async def startup():
        """Initialize services on startup"""
        try:
            logger.info(
                "Starting workflow_core_module",
                extra={
                    "event_type": "SYSTEM",
                    "action": "app_startup",
                }
            )

            # Start schedule service and scheduler
            await app.schedule_service.start_scheduler()
            logger.info("ScheduleService started successfully")

        except Exception as e:
            logger.error(
                f"Failed to start application: {str(e)}",
                extra={
                    "event_type": "ERROR",
                    "action": "app_startup",
                    "result": "FAILURE",
                },
                exc_info=True
            )
            raise

    @app.after_serving
    async def shutdown():
        """Cleanup on shutdown"""
        try:
            logger.info(
                "Shutting down workflow_core_module",
                extra={
                    "event_type": "SYSTEM",
                    "action": "app_shutdown",
                }
            )

            # Stop scheduler gracefully
            await app.schedule_service.stop_scheduler()

            # Close database connections
            await app.dal.close()

            logger.info("Shutdown complete")

        except Exception as e:
            logger.error(
                f"Error during shutdown: {str(e)}",
                extra={
                    "event_type": "ERROR",
                    "action": "app_shutdown",
                },
                exc_info=True
            )

    # Register blueprints
    from controllers.workflow_api import workflow_bp
    from controllers.schedule_api import schedule_bp  # New!

    app.register_blueprint(workflow_bp)
    app.register_blueprint(schedule_bp)

    return app
```

### Step 3: Create Schedule API Controller

Create `/home/penguin/code/WaddleBot/core/workflow_core_module/controllers/schedule_api.py`:

```python
"""
Schedule API Controller
=======================

REST API endpoints for schedule management.

Endpoints:
- POST /api/v1/schedules - Create schedule
- GET /api/v1/schedules/{schedule_id} - Get schedule details
- PUT /api/v1/schedules/{schedule_id} - Update schedule
- DELETE /api/v1/schedules/{schedule_id} - Remove schedule
- GET /api/v1/schedules/workflow/{workflow_id} - List schedules for workflow
"""

import logging
from quart import Blueprint, request, current_app
from datetime import datetime

from services.schedule_service import (
    ScheduleService,
    InvalidScheduleException,
    ScheduleNotFoundException,
    ScheduleServiceException,
)

logger = logging.getLogger(__name__)

schedule_bp = Blueprint("schedules", __name__, url_prefix="/api/v1")


def _require_auth():
    """Extract and verify authentication"""
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        return None, "Missing Authorization header"

    try:
        parts = auth_header.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return None, "Invalid Authorization header format"

        # In production, validate token properly
        # For now, extract user info from token
        token = parts[1]
        return {"user_id": 1, "community_id": 1}, None

    except Exception as e:
        return None, f"Authentication error: {str(e)}"


def _json_response(data, status=200):
    """Return JSON response"""
    from quart import jsonify
    response = jsonify(data)
    response.status_code = status
    return response


def _error_response(message, status=400):
    """Return error response"""
    return _json_response({"error": message}, status=status)


@schedule_bp.route("/schedules", methods=["POST"])
async def create_schedule():
    """
    Create a new schedule.

    Request body:
    {
        "workflow_id": "uuid",
        "schedule_config": {
            "schedule_type": "cron|interval|one_time",
            "cron_expression": "0 12 * * *",  # For cron
            "interval_seconds": 3600,           # For interval
            "scheduled_time": "2024-12-25T15:30:00",  # For one_time
            "timezone": "UTC",
            "max_executions": null
        },
        "context_data": {}  # Optional
    }
    """
    try:
        auth, error = _require_auth()
        if error:
            return _error_response(error, status=401)

        data = await request.json

        # Validate required fields
        workflow_id = data.get("workflow_id")
        schedule_config = data.get("schedule_config")

        if not workflow_id or not schedule_config:
            return _error_response(
                "Missing required fields: workflow_id, schedule_config",
                status=400
            )

        # Create schedule
        result = await current_app.schedule_service.add_schedule(
            workflow_id=workflow_id,
            schedule_config=schedule_config,
            user_id=auth["user_id"],
            community_id=auth["community_id"],
            context_data=data.get("context_data")
        )

        return _json_response(result, status=201)

    except InvalidScheduleException as e:
        logger.warning(f"Invalid schedule: {e.message}")
        return _error_response(e.message, status=400)

    except ScheduleServiceException as e:
        logger.error(f"Schedule service error: {e.message}")
        return _error_response(e.message, status=e.status_code)

    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}", exc_info=True)
        return _error_response("Internal server error", status=500)


@schedule_bp.route("/schedules/<schedule_id>", methods=["GET"])
async def get_schedule(schedule_id):
    """Get schedule details"""
    try:
        auth, error = _require_auth()
        if error:
            return _error_response(error, status=401)

        # Get schedule from memory cache or database
        if schedule_id in current_app.schedule_service._active_schedules:
            schedule = current_app.schedule_service._active_schedules[schedule_id]
            return _json_response(schedule)

        # Try database
        query = "SELECT * FROM workflow_schedules WHERE schedule_id = ?"
        row = await current_app.dal.executesql(query, [schedule_id])

        if not row:
            return _error_response(f"Schedule not found: {schedule_id}", status=404)

        return _json_response({
            "schedule_id": row[0][0],
            "workflow_id": row[0][1],
            "schedule_type": row[0][2],
            "next_execution_at": row[0][3],
            "is_active": row[0][4],
            "execution_count": row[0][5],
        })

    except Exception as e:
        logger.error(f"Error getting schedule: {str(e)}", exc_info=True)
        return _error_response("Internal server error", status=500)


@schedule_bp.route("/schedules/<schedule_id>", methods=["PUT"])
async def update_schedule(schedule_id):
    """Update schedule configuration"""
    try:
        auth, error = _require_auth()
        if error:
            return _error_response(error, status=401)

        data = await request.json
        schedule_config = data.get("schedule_config")

        if not schedule_config:
            return _error_response("Missing schedule_config", status=400)

        result = await current_app.schedule_service.update_schedule(
            schedule_id=schedule_id,
            schedule_config=schedule_config,
            user_id=auth["user_id"]
        )

        return _json_response(result)

    except ScheduleNotFoundException as e:
        return _error_response(e.message, status=404)

    except InvalidScheduleException as e:
        return _error_response(e.message, status=400)

    except Exception as e:
        logger.error(f"Error updating schedule: {str(e)}", exc_info=True)
        return _error_response("Internal server error", status=500)


@schedule_bp.route("/schedules/<schedule_id>", methods=["DELETE"])
async def delete_schedule(schedule_id):
    """Remove schedule"""
    try:
        auth, error = _require_auth()
        if error:
            return _error_response(error, status=401)

        await current_app.schedule_service.remove_schedule(
            schedule_id=schedule_id,
            user_id=auth["user_id"]
        )

        return _json_response({"status": "removed", "schedule_id": schedule_id})

    except ScheduleNotFoundException as e:
        return _error_response(e.message, status=404)

    except Exception as e:
        logger.error(f"Error deleting schedule: {str(e)}", exc_info=True)
        return _error_response("Internal server error", status=500)


@schedule_bp.route("/schedules/workflow/<workflow_id>", methods=["GET"])
async def list_workflow_schedules(workflow_id):
    """List all schedules for a workflow"""
    try:
        auth, error = _require_auth()
        if error:
            return _error_response(error, status=401)

        query = """
        SELECT schedule_id, schedule_type, next_execution_at,
               is_active, execution_count, max_executions
        FROM workflow_schedules
        WHERE workflow_id = ?
        ORDER BY next_execution_at ASC
        """

        rows = await current_app.dal.executesql(query, [workflow_id])

        schedules = [
            {
                "schedule_id": row[0],
                "schedule_type": row[1],
                "next_execution_at": row[2],
                "is_active": row[3],
                "execution_count": row[4],
                "max_executions": row[5],
            }
            for row in rows
        ]

        return _json_response({
            "workflow_id": workflow_id,
            "schedules": schedules,
            "count": len(schedules)
        })

    except Exception as e:
        logger.error(f"Error listing schedules: {str(e)}", exc_info=True)
        return _error_response("Internal server error", status=500)


@schedule_bp.route("/health", methods=["GET"])
async def health_check():
    """Health check endpoint"""
    return _json_response({
        "status": "healthy",
        "module": "workflow_core_module",
        "scheduler_running": current_app.schedule_service._is_running,
        "active_schedules": len(current_app.schedule_service._active_schedules),
    })
```

### Step 4: Main Entry Point

```python
# app.py - main entry point

import asyncio
from config import Config


async def main():
    """Main entry point"""
    app = await create_app()

    # Run with Hypercorn
    from hypercorn.config import Config as HypercornConfig
    from hypercorn.asyncio import serve

    config = HypercornConfig()
    config.bind = [f"0.0.0.0:{Config.PORT}"]
    config.workers = 4

    await serve(app, config)


if __name__ == "__main__":
    asyncio.run(main())
```

### Step 5: Docker Configuration

```dockerfile
# Dockerfile (example update)

FROM python:3.13-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Run application
CMD ["python", "-m", "hypercorn", "app:create_app", "--bind", "0.0.0.0:8070"]
```

### Step 6: Environment Variables

```bash
# .env (example)

# Module Configuration
MODULE_NAME=workflow_core_module
MODULE_PORT=8070

# Database
DATABASE_URI=postgresql://waddlebot:password@postgres:5432/waddlebot
READ_REPLICA_URIS=postgresql://waddlebot:password@postgres-replica:5433/waddlebot

# Redis
REDIS_URL=redis://redis:6379/0

# Scheduler
SCHEDULER_TIMEZONE=UTC
SCHEDULER_JOB_DEFAULTS_MAX_INSTANCES=3
SCHEDULER_JOB_DEFAULTS_COALESCE=true

# Workflow Execution
MAX_CONCURRENT_WORKFLOWS=10
WORKFLOW_TIMEOUT_SECONDS=3600
WORKFLOW_MAX_RETRIES=3

# Schedule Service
SCHEDULE_GRACE_PERIOD_MINUTES=15

# Logging
LOG_DIR=/var/log/waddlebotlog
LOG_LEVEL=INFO

# Security
SECRET_KEY=your-secret-key-here
API_KEY=your-api-key-here
```

## Lifecycle Management

### Startup Sequence

```
1. Flask application starts
2. Configuration loaded from environment
3. Database connections initialized
4. Services created:
   - WorkflowEngine
   - ScheduleService
5. Scheduler starts:
   - Loads active schedules from database
   - Registers with APScheduler
   - Starts background check_due_schedules loop
6. API endpoints ready for requests
```

### Shutdown Sequence

```
1. Shutdown signal received
2. Stop accepting new requests
3. Allow pending operations to complete (5 sec grace)
4. Scheduler shuts down:
   - Stop background loop
   - Wait for pending jobs
5. Database connections closed
6. Cleanup complete
```

## Testing Integration

### Unit Test Setup

```python
# tests/test_schedule_service_integration.py

import pytest
import asyncio
from datetime import datetime, timedelta

from services.schedule_service import ScheduleService


@pytest.fixture
async def app(monkeypatch):
    """Create test application"""
    from app import create_app

    app = await create_app()
    yield app

    # Cleanup
    await app.schedule_service.stop_scheduler()
    await app.dal.close()


@pytest.fixture
async def schedule_service(app):
    """Get schedule service from app"""
    return app.schedule_service


@pytest.mark.asyncio
async def test_schedule_service_startup(schedule_service):
    """Test scheduler starts correctly"""
    assert schedule_service._is_running


@pytest.mark.asyncio
async def test_create_cron_schedule(schedule_service):
    """Test creating cron schedule"""
    config = {
        "schedule_type": "cron",
        "cron_expression": "0 12 * * *"
    }

    result = await schedule_service.add_schedule(
        workflow_id="test-workflow",
        schedule_config=config,
        user_id=1,
        community_id=1
    )

    assert result["schedule_id"]
    assert result["schedule_type"] == "cron"
```

### Integration Test Example

```python
# tests/test_schedule_api.py

import pytest
from quart.testing import QuartClient


@pytest.mark.asyncio
async def test_create_schedule_api(app):
    """Test schedule creation via API"""
    client = app.test_client()

    response = await client.post(
        "/api/v1/schedules",
        json={
            "workflow_id": "test-workflow",
            "schedule_config": {
                "schedule_type": "cron",
                "cron_expression": "0 12 * * *"
            }
        },
        headers={
            "Authorization": "Bearer test-token"
        }
    )

    assert response.status_code == 201
    data = await response.json
    assert data["schedule_id"]
```

## Monitoring and Observability

### Logging

All operations are logged with AAA logging:

```python
# Example logs from schedule service

2024-12-20 10:00:00 INFO workflow_core_module:1.0.0 SYSTEM action=scheduler_start active_schedules=5
2024-12-20 10:05:00 INFO workflow_core_module:1.0.0 AUDIT action=schedule_create schedule_id=abc-123 user=42 result=SUCCESS
2024-12-20 12:00:00 INFO workflow_core_module:1.0.0 AUDIT action=schedule_triggered schedule_id=abc-123 execution_id=xyz-789
2024-12-20 23:59:59 INFO workflow_core_module:1.0.0 SYSTEM action=app_shutdown
```

### Metrics

Monitor key metrics:

```python
# In application monitoring code

metrics = {
    "scheduler_running": app.schedule_service._is_running,
    "active_schedules": len(app.schedule_service._active_schedules),
    "apscheduler_jobs": len(app.schedule_service.scheduler.get_jobs()),
    "workflow_executions": # Count from database
}
```

### Health Checks

```bash
# Health check endpoint
curl http://localhost:8070/api/v1/health
{
  "status": "healthy",
  "module": "workflow_core_module",
  "scheduler_running": true,
  "active_schedules": 5
}
```

## Troubleshooting

### Common Issues

**Scheduler not starting:**
1. Check database connectivity
2. Verify AsyncDAL initialization
3. Check logs for errors
4. Ensure PostgreSQL is running

**Schedules not executing:**
1. Verify scheduler is running: `schedule_service._is_running`
2. Check schedule is active: `SELECT is_active FROM workflow_schedules WHERE schedule_id = 'xxx'`
3. Verify next_execution_at: `SELECT next_execution_at FROM workflow_schedules WHERE schedule_id = 'xxx'`
4. Check WorkflowEngine is initialized
5. Review audit logs for execution attempts

**High memory usage:**
1. Check active schedule count
2. Monitor APScheduler job count
3. Implement max_executions on schedules
4. Verify database cleanup of old schedules

## Performance Tuning

### Database Optimization

```sql
-- Ensure indexes exist
CREATE INDEX IF NOT EXISTS idx_workflow_schedules_workflow_id
  ON workflow_schedules(workflow_id);

CREATE INDEX IF NOT EXISTS idx_workflow_schedules_is_active
  ON workflow_schedules(is_active);

CREATE INDEX IF NOT EXISTS idx_workflow_schedules_next_execution
  ON workflow_schedules(next_execution_at);

-- Analyze query plans
EXPLAIN ANALYZE
  SELECT * FROM workflow_schedules
  WHERE is_active = TRUE
    AND next_execution_at <= NOW();
```

### APScheduler Configuration

```python
# In config.py

SCHEDULER_JOB_DEFAULTS = {
    'coalesce': True,           # Don't execute multiple times if missed
    'max_instances': 3,         # Max concurrent instances of same job
}

SCHEDULER_EXECUTORS = {
    'default': {
        'type': 'asyncio',
        'pool_size': 10,        # Thread pool size
    }
}
```

## Next Steps

1. Review the SCHEDULE_SERVICE_README.md for detailed API documentation
2. Implement schedule management UI in hub_module frontend
3. Add schedule templates for common patterns
4. Implement schedule monitoring dashboard
5. Set up automated testing and CI/CD

See [SCHEDULE_SERVICE_README.md](./SCHEDULE_SERVICE_README.md) for complete API documentation.
