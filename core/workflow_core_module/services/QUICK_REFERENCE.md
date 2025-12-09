# LicenseService Quick Reference

## Import
```python
from services import (
    LicenseService,
    LicenseStatus,
    LicenseTier,
    LicenseException,
    LicenseValidationException
)
```

## Initialize
```python
license_service = LicenseService(
    license_server_url="https://license.penguintech.io",
    redis_url="redis://localhost:6379/0",
    release_mode=True,  # false = dev mode
    logger_instance=logger
)
await license_service.connect()
```

## Check License Status
```python
status = await license_service.check_license_status(community_id=123)
# Returns: {
#   "status": "active",
#   "tier": "premium",
#   "expires_at": "2025-12-31",
#   "features": {"workflows": True},
#   "cached": True
# }
```

## Validate Workflow Creation
```python
try:
    await license_service.validate_workflow_creation(
        community_id=123,
        entity_id="workflow_uuid"
    )
    # Success: create workflow
except LicenseValidationException as e:
    # e.status_code == 402
    # e.message == error message
    return error_response(e.message, 402)
```

## Validate Workflow Execution
```python
try:
    await license_service.validate_workflow_execution(
        workflow_id="workflow_uuid",
        community_id=123
    )
    # Success: execute workflow
except LicenseValidationException as e:
    return error_response(e.message, 402)
```

## Get License Info
```python
info = await license_service.get_license_info(community_id=123)
# Returns: {
#   "tier": "premium",
#   "status": "active",
#   "expires_at": "2025-12-31",
#   "features": {"workflows": True},
#   "workflow_limit": None,  # None = unlimited, 0 = free
#   "cached": True
# }
```

## Invalidate Cache
```python
await license_service.invalidate_cache(community_id=123)
```

## Cleanup
```python
await license_service.disconnect()
```

## Environment Variables
```bash
LICENSE_SERVER_URL=https://license.penguintech.io
RELEASE_MODE=true          # or false for dev
REDIS_URL=redis://localhost:6379/0
```

## Error Codes
- **200**: Success
- **402**: Payment Required (license validation failed)
- **500**: Server error

## License Tiers
- **FREE**: `tier="free"`, workflows=0
- **PREMIUM**: `tier="premium"`, workflows=unlimited

## Response Times
- Cached: <5ms
- First check: 100-200ms
- Dev mode: <1ms

## Key Methods
| Method | Purpose | Returns | Raises |
|--------|---------|---------|--------|
| `check_license_status()` | Check status | Dict with status | LicenseException |
| `validate_workflow_creation()` | Create allowed? | True | LicenseValidationException (402) |
| `validate_workflow_execution()` | Execute allowed? | True | LicenseValidationException (402) |
| `get_license_info()` | Get full info | Dict with tier, limit | Exception |
| `invalidate_cache()` | Clear cache | None | (logs error) |

## Common Patterns

### In Controller
```python
@api_bp.route('/workflows', methods=['POST'])
async def create_workflow():
    try:
        data = await request.get_json()
        await license_service.validate_workflow_creation(
            community_id=data['community_id'],
            entity_id=str(uuid.uuid4())
        )
        # Create workflow...
    except LicenseValidationException as e:
        return error_response(e.message, 402)
```

### With Database
```python
# Get license key from database
query = "SELECT license_key FROM communities WHERE id = $1"
rows = await dal.execute(query, [community_id])
license_key = rows[0]['license_key'] if rows else None

# Validate with explicit key
await license_service.validate_workflow_creation(
    community_id=community_id,
    entity_id=workflow_id,
    license_key=license_key
)
```

### Logging
```python
logger.audit(
    "License validation completed",
    action="license_check",
    community=str(community_id),
    result="SUCCESS"
)
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Always returns premium in prod | Check `RELEASE_MODE=true` |
| Timeout on license server | Check network/firewall, increase timeout |
| Cache not working | Check Redis connection, logs show fallback status |
| Always denied | Check license key format: `PENG-XXXX-XXXX-XXXX-XXXX-ABCD` |
| 402 errors | Confirm license status in PenguinTech system |

## Files
- **Implementation**: `services/license_service.py` (643 lines)
- **Tests**: `services/test_license_service_examples.py` (506 lines)
- **Full Guide**: `services/LICENSE_SERVICE_README.md` (617 lines)
- **Integration**: `services/LICENSE_SERVICE_INTEGRATION.md` (460 lines)

## Links
- [Full README](LICENSE_SERVICE_README.md)
- [Integration Guide](LICENSE_SERVICE_INTEGRATION.md)
- [Test Examples](test_license_service_examples.py)
- [Implementation Summary](../IMPLEMENTATION_SUMMARY_LICENSE_SERVICE.md)
