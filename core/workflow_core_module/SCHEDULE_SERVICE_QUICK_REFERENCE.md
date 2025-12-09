# Schedule Service - Quick Reference

## Initialization

```python
from services.schedule_service import ScheduleService

schedule_service = ScheduleService(
    dal=dal,
    workflow_engine=workflow_engine,
    grace_period_minutes=15,
    logger_instance=logger
)
```

## Startup/Shutdown

```python
# Start scheduler and load active schedules
await schedule_service.start_scheduler()

# Stop gracefully
await schedule_service.stop_scheduler()
```

## Create Schedules

### Cron (Daily at noon)

```python
await schedule_service.add_schedule(
    workflow_id="abc-123",
    schedule_config={
        "schedule_type": "cron",
        "cron_expression": "0 12 * * *",
        "timezone": "UTC"
    },
    user_id=42,
    community_id=1
)
```

### Interval (Every hour)

```python
await schedule_service.add_schedule(
    workflow_id="abc-123",
    schedule_config={
        "schedule_type": "interval",
        "interval_seconds": 3600,
        "max_executions": 24
    },
    user_id=42,
    community_id=1
)
```

### One-Time (Specific datetime)

```python
from datetime import datetime, timedelta

await schedule_service.add_schedule(
    workflow_id="abc-123",
    schedule_config={
        "schedule_type": "one_time",
        "scheduled_time": (datetime.utcnow() + timedelta(hours=2)).isoformat()
    },
    user_id=42,
    community_id=1
)
```

## Update Schedule

```python
await schedule_service.update_schedule(
    schedule_id="schedule-uuid",
    schedule_config={
        "schedule_type": "cron",
        "cron_expression": "0 9 * * *"
    },
    user_id=42
)
```

## Remove Schedule

```python
await schedule_service.remove_schedule(
    schedule_id="schedule-uuid",
    user_id=42
)
```

## Check Due Schedules

```python
# Manually check for due schedules
triggered = await schedule_service.check_due_schedules()

for item in triggered:
    print(f"Triggered: {item['schedule_id']}")
```

## Calculate Next Execution

```python
next_run = ScheduleService.calculate_next_execution(
    schedule_type="cron",
    cron_expression="0 12 * * *",
    timezone="UTC"
)
```

## Common Cron Expressions

| Pattern | Cron Expression |
|---------|-----------------|
| Every minute | `* * * * *` |
| Every 15 minutes | `*/15 * * * *` |
| Every hour | `0 * * * *` |
| Daily at noon | `0 12 * * *` |
| Daily at 9 AM | `0 9 * * *` |
| Every 6 hours | `0 */6 * * *` |
| Monday at 9 AM | `0 9 * * 1` |
| Weekdays at 8 AM | `0 8 * * 1-5` |
| First day of month | `0 0 1 * *` |
| Every Sunday | `0 0 * * 0` |
| Every Sunday at 2 AM | `0 2 * * 0` |
| 1st and 15th at 10 AM | `0 10 1,15 * *` |
| Every Dec 25 at 6 PM | `0 18 25 12 *` |

## Common Intervals

| Duration | Seconds |
|----------|---------|
| 1 minute | `60` |
| 5 minutes | `300` |
| 15 minutes | `900` |
| 30 minutes | `1800` |
| 1 hour | `3600` |
| 6 hours | `21600` |
| 12 hours | `43200` |
| 1 day | `86400` |
| 1 week | `604800` |

## Exception Handling

```python
from services.schedule_service import (
    ScheduleServiceException,
    InvalidScheduleException,
    ScheduleNotFoundException
)

try:
    await schedule_service.add_schedule(...)
except InvalidScheduleException as e:
    print(f"Config error: {e.message}")
except ScheduleNotFoundException as e:
    print(f"Not found: {e.message}")
except ScheduleServiceException as e:
    print(f"Service error: {e.message}")
```

## API Endpoints

```bash
# Create schedule
POST /api/v1/schedules
{
  "workflow_id": "abc-123",
  "schedule_config": { ... },
  "context_data": { ... }
}

# Get schedule
GET /api/v1/schedules/{schedule_id}

# Update schedule
PUT /api/v1/schedules/{schedule_id}
{
  "schedule_config": { ... }
}

# Delete schedule
DELETE /api/v1/schedules/{schedule_id}

# List workflow schedules
GET /api/v1/schedules/workflow/{workflow_id}

# Health check
GET /api/v1/health
```

## Monitoring

```python
# Check scheduler status
is_running = schedule_service._is_running

# Count active schedules
count = len(schedule_service._active_schedules)

# Get APScheduler jobs
jobs = schedule_service.scheduler.get_jobs()
```

## Logging Events

All operations are logged with AAA logging:

- `schedule_service_init` - Service initialized
- `scheduler_start` - Scheduler started
- `scheduler_stop` - Scheduler stopped
- `schedule_create` - Schedule created
- `schedule_update` - Schedule updated
- `schedule_remove` - Schedule removed
- `schedule_triggered` - Workflow triggered
- `schedule_executed` - Successfully executed
- `schedule_missed` - Missed grace period
- `schedule_limit_reached` - Max executions reached

## Environment Variables

```bash
SCHEDULER_TIMEZONE=UTC
SCHEDULER_JOB_DEFAULTS_MAX_INSTANCES=3
SCHEDULER_JOB_DEFAULTS_COALESCE=true
MAX_CONCURRENT_WORKFLOWS=10
WORKFLOW_TIMEOUT_SECONDS=3600
WORKFLOW_MAX_RETRIES=3
SCHEDULE_GRACE_PERIOD_MINUTES=15
LOG_LEVEL=INFO
```

## Database Queries

```sql
-- List all active schedules
SELECT * FROM workflow_schedules WHERE is_active = TRUE;

-- Find schedules due for execution
SELECT * FROM workflow_schedules
WHERE is_active = TRUE
  AND next_execution_at <= NOW();

-- Count executions per workflow
SELECT workflow_id, COUNT(*) FROM workflow_schedules GROUP BY workflow_id;

-- List schedules by type
SELECT * FROM workflow_schedules WHERE schedule_type = 'cron';
```

## Performance Tips

1. **Set max_executions** to prevent runaway schedules
2. **Use grace_period** to handle missed executions (default: 15 min)
3. **Create indexes** on frequently queried columns
4. **Monitor scheduler** active job count regularly
5. **Archive old schedules** periodically
6. **Use timezone awareness** for cross-region scheduling

## Troubleshooting Checklist

- [ ] Scheduler running? `schedule_service._is_running`
- [ ] Schedule active? `SELECT is_active FROM workflow_schedules WHERE schedule_id = '...'`
- [ ] Next execution set? `SELECT next_execution_at FROM workflow_schedules WHERE schedule_id = '...'`
- [ ] WorkflowEngine initialized? Check app context
- [ ] Database connected? Check AsyncDAL connection
- [ ] Cron expression valid? Use croniter to test
- [ ] Log level set to INFO? Check CONFIG
- [ ] Permissions configured? Check permission_service

## See Also

- [Full Documentation](./SCHEDULE_SERVICE_README.md)
- [Integration Guide](./SCHEDULE_SERVICE_INTEGRATION.md)
- [API Reference](../../docs/api-reference.md)
- [Database Schema](../../docs/database-schema.md)
