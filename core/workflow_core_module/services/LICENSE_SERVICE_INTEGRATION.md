# License Service Integration Guide

## Overview

The `LicenseService` handles premium license validation for the workflow module with PenguinTech License Server integration. It enforces license tiers and feature access, returning HTTP 402 Payment Required for license violations.

## Quick Start

### 1. Initialize in app.py

```python
from services import LicenseService
from flask_core import setup_aaa_logging

# During startup
async def startup():
    global dal, license_service, logger

    logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)
    dal = init_database(Config.DATABASE_URI)

    # Initialize license service
    license_service = LicenseService(
        license_server_url=Config.LICENSE_SERVER_URL,
        redis_url=Config.REDIS_URL,
        release_mode=Config.RELEASE_MODE,
        logger_instance=logger
    )
    await license_service.connect()
    app.config['license_service'] = license_service

# During shutdown
async def shutdown():
    global license_service
    if license_service:
        await license_service.disconnect()
```

### 2. Use in Controllers

```python
from quart import request
from flask_core import async_endpoint, error_response

@api_bp.route('/workflows', methods=['POST'])
@async_endpoint
async def create_workflow():
    """Create a new workflow with license validation"""
    license_service = current_app.config.get('license_service')

    community_id = request.json.get('community_id')
    workflow_id = str(uuid.uuid4())

    try:
        # Validate license before creating workflow
        await license_service.validate_workflow_creation(
            community_id=community_id,
            entity_id=workflow_id
        )

        # Create workflow...
        return success_response({"workflow_id": workflow_id})

    except LicenseValidationException as e:
        logger.audit(
            "Workflow creation rejected due to license",
            action="workflow_creation",
            community=str(community_id),
            result="FAILURE"
        )
        return error_response(
            message=e.message,
            status_code=402
        )
```

### 3. Validate Workflow Execution

```python
@api_bp.route('/workflows/<workflow_id>/execute', methods=['POST'])
@async_endpoint
async def execute_workflow(workflow_id: str):
    """Execute workflow with license validation"""
    license_service = current_app.config.get('license_service')

    # Get community_id from workflow lookup
    community_id = await get_community_for_workflow(workflow_id)

    try:
        # Validate execution
        await license_service.validate_workflow_execution(
            workflow_id=workflow_id,
            community_id=community_id
        )

        # Execute workflow...
        return success_response({"status": "executing"})

    except LicenseValidationException as e:
        return error_response(
            message=e.message,
            status_code=402
        )
```

### 4. Display License Info

```python
@api_bp.route('/license/info', methods=['GET'])
@async_endpoint
async def get_license_info():
    """Get license information for a community"""
    license_service = current_app.config.get('license_service')

    community_id = request.args.get('community_id', type=int)

    try:
        info = await license_service.get_license_info(community_id)
        return success_response(info)

    except Exception as e:
        return error_response(
            message=f"License check failed: {str(e)}",
            status_code=500
        )
```

## Configuration

### Environment Variables

Required in `.env` or docker environment:

```bash
# License Server
LICENSE_SERVER_URL=https://license.penguintech.io

# Release Mode (controls license enforcement)
RELEASE_MODE=true          # Enforce licenses in production
RELEASE_MODE=false         # Skip enforcement in development

# Redis (for caching)
REDIS_URL=redis://localhost:6379/0
```

### In config.py

```python
class Config:
    LICENSE_SERVER_URL = os.getenv(
        'LICENSE_SERVER_URL',
        'https://license.penguintech.io'
    )
    RELEASE_MODE = os.getenv('RELEASE_MODE', 'false').lower() == 'true'
    REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379/0')
```

## License Tiers

### Free Tier
- Workflow creation: **Blocked** (0 workflows allowed)
- Workflow execution: **Blocked**
- Cost: $0

### Premium Tier
- Workflow creation: **Allowed** (unlimited)
- Workflow execution: **Allowed**
- Cost: Premium subscription

## Error Handling

### HTTP 402 Payment Required

Returned when license validation fails:

```json
{
    "error": true,
    "message": "Free tier does not support workflows. Upgrade to Premium.",
    "status_code": 402,
    "community_id": 123
}
```

### License Status Values

- `active`: License is valid and not expired
- `expired`: License has passed expiration date
- `invalid`: License key is invalid
- `unlicensed`: No license found for community

## Caching

License status is cached in Redis with a **5-minute TTL** (300 seconds).

### Cache Key Format
```
license:community:{community_id}
```

### Manual Cache Invalidation

When a license is updated externally (e.g., via admin panel):

```python
# Invalidate cache for a community
await license_service.invalidate_cache(community_id)
```

### Cache Fallback

If Redis is unavailable, the service falls back to in-memory caching (no TTL). This is suitable for single-instance deployments.

## Development Mode

When `RELEASE_MODE=false`, the service:
- Skips license server validation
- Assumes all communities have Premium tier
- Allows unlimited workflow creation/execution
- Useful for local development and testing

```python
# In development
license_info = await license_service.check_license_status(123)
# Returns: {"status": "active", "tier": "premium", "dev_mode": True, ...}
```

## Logging

The service uses AAA (Authentication, Authorization, Audit) logging:

### Log Categories

- **AUDIT**: License checks, validations passed/denied
- **AUTH**: License key validation
- **ERROR**: License check failures
- **SYSTEM**: Service startup/shutdown, cache operations

### Sample Logs

```
[2025-12-09 10:30:45.123] INFO workflow_core_module:1.0.0 AUDIT community=456 action=license_check result=SUCCESS License validated for community 456
[2025-12-09 10:31:12.456] INFO workflow_core_module:1.0.0 AUDIT community=789 action=workflow_creation_denied result=FAILURE Workflow creation denied: free tier limit reached
[2025-12-09 10:32:00.789] ERROR workflow_core_module:1.0.0 ERROR community=100 result=FAILURE License server connection failed: Connection refused
```

## API Reference

### check_license_status()

Check license status for a community.

```python
status = await license_service.check_license_status(
    community_id=123,
    license_key="PENG-XXXX-XXXX-XXXX-XXXX-ABCD"  # Optional
)

# Returns:
{
    "status": "active",          # LicenseStatus value
    "tier": "premium",           # LicenseTier value
    "expires_at": "2025-12-31",  # ISO datetime or None
    "features": {
        "workflows": True
    },
    "cached": True,              # Whether result was cached
    "dev_mode": False            # True in development mode
}
```

### validate_workflow_creation()

Validate before creating a workflow.

```python
try:
    await license_service.validate_workflow_creation(
        community_id=123,
        entity_id="workflow_uuid",
        license_key=None  # Optional
    )
    # Returns: True if valid
except LicenseValidationException as e:
    # e.status_code = 402
    # e.message = "Error message"
    # e.community_id = 123
```

### validate_workflow_execution()

Validate before executing a workflow.

```python
try:
    await license_service.validate_workflow_execution(
        workflow_id="workflow_uuid",
        community_id=123,
        license_key=None  # Optional
    )
    # Returns: True if valid
except LicenseValidationException as e:
    # Handle 402 error
```

### get_license_info()

Get complete license information.

```python
info = await license_service.get_license_info(
    community_id=123,
    license_key=None  # Optional
)

# Returns:
{
    "tier": "premium",
    "status": "active",
    "expires_at": "2025-12-31",
    "features": {"workflows": True},
    "workflow_limit": None,  # None = unlimited, 0 = free tier
    "cached": True
}
```

### invalidate_cache()

Manually invalidate cached license.

```python
await license_service.invalidate_cache(community_id=123)
```

## Database Integration

When fetching license_key from database:

```python
async def get_workflow_license_key(community_id: int) -> Optional[str]:
    """Fetch license key for community from DB"""
    dal = current_app.config['dal']

    query = "SELECT license_key FROM communities WHERE id = $1"
    rows = await dal.execute(query, [community_id])

    return rows[0]['license_key'] if rows else None

# Usage:
license_key = await get_workflow_license_key(community_id)
await license_service.validate_workflow_creation(
    community_id=community_id,
    entity_id=workflow_id,
    license_key=license_key
)
```

## Testing

### Unit Test Example

```python
import pytest
from services import LicenseService, LicenseValidationException

@pytest.mark.asyncio
async def test_workflow_creation_premium_allowed():
    """Test that premium tier can create workflows"""
    service = LicenseService(
        license_server_url="http://localhost:8080",
        release_mode=False  # Dev mode
    )

    # Should not raise in dev mode
    result = await service.validate_workflow_creation(
        community_id=123,
        entity_id="workflow_1"
    )
    assert result is True

@pytest.mark.asyncio
async def test_workflow_creation_free_denied(mocker):
    """Test that free tier cannot create workflows"""
    service = LicenseService(
        license_server_url="http://localhost:8080",
        release_mode=True  # Production mode
    )

    # Mock license server response
    mocker.patch(
        'services.license_service.LicenseService._validate_with_server',
        return_value={
            "status": "active",
            "tier": "free",
            "features": {"workflows": False}
        }
    )

    with pytest.raises(LicenseValidationException) as exc:
        await service.validate_workflow_creation(
            community_id=123,
            entity_id="workflow_1"
        )

    assert exc.value.status_code == 402
```

## Troubleshooting

### License Check Always Fails

1. Check `RELEASE_MODE` setting - should be `true` in production
2. Verify license server URL is reachable
3. Check license key format: `PENG-XXXX-XXXX-XXXX-XXXX-ABCD`
4. Verify Redis connection (if caching)

### Cache Not Working

1. Check Redis URL is valid
2. Verify Redis is running
3. Check logs for cache connection errors
4. Service will fall back to in-memory cache automatically

### License Expires Soon

Track expiration dates to proactively notify users:

```python
info = await license_service.get_license_info(community_id)

from datetime import datetime, timedelta

if info['expires_at']:
    expires = datetime.fromisoformat(info['expires_at'])
    days_left = (expires - datetime.now()).days

    if days_left <= 7:
        # Send renewal reminder
        logger.audit(
            f"License expiring soon",
            community=str(community_id),
            action="renewal_warning"
        )
```

## Security Considerations

1. **License Keys**: Never log license keys in plain text
2. **HTTPS Only**: Always use HTTPS for license server communication
3. **Caching**: TTL is 5 minutes - balance between performance and freshness
4. **Rate Limiting**: Consider implementing rate limits on license checks
5. **Dev Mode**: Only enable `RELEASE_MODE=false` during development

## Performance

- **First check**: ~100-200ms (network request)
- **Cached check**: <5ms (Redis)
- **In-memory fallback**: <1ms

For high-frequency checks, use the caching feature to minimize license server load.
