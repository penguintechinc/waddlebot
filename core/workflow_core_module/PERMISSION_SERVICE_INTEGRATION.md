# Permission Service Integration Guide

## Quick Start

### 1. Import and Initialize

```python
from core.workflow_core_module.services import PermissionService
from flask_core import init_database, setup_aaa_logging

# In your app.py or module initialization
dal = init_database(Config.DATABASE_URI)
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)
permission_service = PermissionService(dal, logger)

# Store in app context if needed
app.config['permission_service'] = permission_service
```

### 2. Use in Controllers

```python
from quart import request
from flask_core import auth_required, error_response, success_response

@app.route('/api/v1/workflows/<workflow_id>', methods=['GET'])
@auth_required
async def get_workflow(workflow_id):
    user_id = request.auth.user_id
    community_id = request.auth.community_id

    # Check permission
    if not await permission_service.check_permission(
        workflow_id=workflow_id,
        user_id=user_id,
        permission_type="can_view",
        community_id=community_id
    ):
        return error_response("FORBIDDEN", "Access denied", 403)

    # Get workflow data
    # ...

    return success_response(data=workflow_data)


@app.route('/api/v1/workflows/<workflow_id>', methods=['PUT'])
@auth_required
async def update_workflow(workflow_id):
    user_id = request.auth.user_id

    # Check edit permission
    if not await permission_service.check_permission(
        workflow_id=workflow_id,
        user_id=user_id,
        permission_type="can_edit"
    ):
        return error_response("FORBIDDEN", "Permission denied", 403)

    # Update workflow
    # ...

    return success_response(data=updated_workflow)
```

## Permission Checking Pattern

### Controller Protection Pattern

```python
async def check_workflow_access(permission_type: str):
    """Decorator-like pattern for permission checking"""
    async def wrapper(workflow_id: str, user_id: int):
        has_access = await permission_service.check_permission(
            workflow_id=workflow_id,
            user_id=user_id,
            permission_type=permission_type
        )
        return has_access
    return wrapper


# Usage in controller
@app.route('/api/v1/workflows/<workflow_id>/execute', methods=['POST'])
@auth_required
async def execute_workflow(workflow_id):
    user_id = request.auth.user_id

    # Check execution permission
    if not await check_workflow_access("can_execute")(workflow_id, user_id):
        return error_response("FORBIDDEN", "Cannot execute workflow", 403)

    # Execute workflow
    # ...

    return success_response()
```

## Permission Management APIs

### Grant Permissions to User

```python
from core.workflow_core_module.services import GrantResult

result = await permission_service.grant_permission(
    workflow_id=workflow_id,
    target_type="user",
    target_id=user_to_grant_id,
    permissions_dict={
        "can_view": True,
        "can_edit": True,
        "can_execute": True,
        "can_delete": False,
        "can_manage_permissions": False,
    },
    granted_by=current_user_id
)

if not result.success:
    logger.error(f"Failed to grant permission: {result.error}")
    return error_response("ERROR", result.message, 400)
```

### Grant Permissions to Role

```python
result = await permission_service.grant_permission(
    workflow_id=workflow_id,
    target_type="role",
    target_id=role_id,  # e.g., "moderator" role ID
    permissions_dict={
        "can_view": True,
        "can_edit": False,
        "can_execute": True,
        "can_delete": False,
        "can_manage_permissions": False,
    },
    granted_by=admin_user_id
)
```

### Grant Entity-Level Permissions

```python
# All users in entity get these permissions
result = await permission_service.grant_permission(
    workflow_id=workflow_id,
    target_type="entity",
    target_id=entity_id,
    permissions_dict={
        "can_view": True,
        "can_edit": False,
        "can_execute": False,
        "can_delete": False,
        "can_manage_permissions": False,
    },
    granted_by=admin_user_id
)
```

### Revoke Permissions

```python
result = await permission_service.revoke_permission(
    workflow_id=workflow_id,
    target_type="user",
    target_id=user_id,
    revoked_by=admin_user_id
)

if result.success:
    logger.info(f"Revoked permissions for user {user_id}")
```

## Listing and Discovery

### List Workflows User Can Edit

```python
workflows = await permission_service.list_workflows_for_user(
    user_id=user_id,
    entity_id=entity_id,
    permission="can_edit"
)

print(f"User can edit {len(workflows)} workflows")
for workflow_id in workflows:
    print(f"  - {workflow_id}")
```

### Get All User Permissions on Workflow

```python
perms = await permission_service.get_user_permissions(
    workflow_id=workflow_id,
    user_id=user_id,
    community_id=community_id
)

# Check specific permission
if perms.can_edit:
    print("User can edit workflow")

# Convert to dict for API response
perms_dict = perms.to_dict()
return success_response(data={
    "workflow_id": workflow_id,
    "permissions": perms_dict
})
```

## API Endpoint Examples

### Create Permission Management API

```python
from quart import request, jsonify

@app.route('/api/v1/workflows/<workflow_id>/permissions', methods=['GET'])
@auth_required
async def get_workflow_permissions(workflow_id):
    """Get user's permissions on a workflow"""
    user_id = request.auth.user_id

    perms = await permission_service.get_user_permissions(
        workflow_id=workflow_id,
        user_id=user_id
    )

    return success_response(data=perms.to_dict())


@app.route('/api/v1/workflows/<workflow_id>/permissions/<target_type>/<int:target_id>', methods=['PUT'])
@auth_required
async def update_permissions(workflow_id, target_type, target_id):
    """Grant or update permissions"""
    user_id = request.auth.user_id

    # Check if user can manage permissions
    if not await permission_service.check_permission(
        workflow_id=workflow_id,
        user_id=user_id,
        permission_type="can_manage_permissions"
    ):
        return error_response("FORBIDDEN", "Cannot manage permissions", 403)

    # Get permission dict from request
    permissions_dict = request.json.get('permissions', {})

    result = await permission_service.grant_permission(
        workflow_id=workflow_id,
        target_type=target_type,
        target_id=target_id,
        permissions_dict=permissions_dict,
        granted_by=user_id
    )

    if not result.success:
        return error_response("ERROR", result.message, 400)

    return success_response(data=result.__dict__)


@app.route('/api/v1/workflows/<workflow_id>/permissions/<target_type>/<int:target_id>', methods=['DELETE'])
@auth_required
async def delete_permissions(workflow_id, target_type, target_id):
    """Revoke permissions"""
    user_id = request.auth.user_id

    # Check if user can manage permissions
    if not await permission_service.check_permission(
        workflow_id=workflow_id,
        user_id=user_id,
        permission_type="can_manage_permissions"
    ):
        return error_response("FORBIDDEN", "Cannot manage permissions", 403)

    result = await permission_service.revoke_permission(
        workflow_id=workflow_id,
        target_type=target_type,
        target_id=target_id,
        revoked_by=user_id
    )

    if not result.success:
        return error_response("ERROR", result.message, 400)

    return success_response(data={"message": result.message})


@app.route('/api/v1/users/<int:user_id>/workflows', methods=['GET'])
@auth_required
async def list_user_workflows(user_id):
    """List workflows user has access to"""
    requester_id = request.auth.user_id
    entity_id = request.auth.entity_id
    permission = request.args.get('permission', 'can_view')

    # Only users can list their own workflows, admins can list others
    if user_id != requester_id:
        # TODO: Add admin check
        return error_response("FORBIDDEN", "Cannot list other user's workflows", 403)

    workflows = await permission_service.list_workflows_for_user(
        user_id=user_id,
        entity_id=entity_id,
        permission=permission
    )

    return success_response(data={
        "user_id": user_id,
        "permission": permission,
        "workflow_ids": workflows,
        "count": len(workflows)
    })
```

## Error Handling

### Graceful Error Handling

```python
try:
    has_permission = await permission_service.check_permission(
        workflow_id=workflow_id,
        user_id=user_id,
        permission_type="can_edit"
    )
except Exception as e:
    logger.error(f"Error checking permission: {e}")
    # Default to deny on error
    has_permission = False


# Result handling
if has_permission:
    # Proceed
    pass
else:
    # Deny access
    return error_response("FORBIDDEN", "Access denied", 403)
```

### Validation Error Handling

```python
result = await permission_service.grant_permission(
    workflow_id=workflow_id,
    target_type="invalid_type",  # Will be rejected
    target_id=42,
    permissions_dict={"can_view": True}
)

if not result.success:
    print(f"Error: {result.error}")
    # {"success": False, "message": "Invalid target_type: invalid_type", "error": "..."}
```

## Testing

### Unit Test Example

```python
import pytest
from core.workflow_core_module.services import PermissionService, PermissionInfo

@pytest.mark.asyncio
async def test_owner_has_all_permissions(dal_mock, logger_mock):
    service = PermissionService(dal_mock, logger_mock)

    # Mock: User is owner
    dal_mock.executesql.return_value = [(42,)]  # created_by = 42

    result = await service.check_permission(
        workflow_id="test-workflow-id",
        user_id=42,
        permission_type="can_edit"
    )

    assert result is True


@pytest.mark.asyncio
async def test_grant_permission(dal_mock, logger_mock):
    service = PermissionService(dal_mock, logger_mock)

    result = await service.grant_permission(
        workflow_id="test-workflow-id",
        target_type="user",
        target_id=42,
        permissions_dict={"can_view": True, "can_edit": True},
        granted_by=1
    )

    assert result.success is True
    assert result.message == "Permission granted"
    assert dal_mock.executesql.called


@pytest.mark.asyncio
async def test_permission_aggregation(dal_mock, logger_mock):
    service = PermissionService(dal_mock, logger_mock)

    perms = await service.get_user_permissions(
        workflow_id="test-workflow-id",
        user_id=42
    )

    assert isinstance(perms, PermissionInfo)
    assert perms.to_dict() is not None
```

## Logging Examples

### Check Permission Logs

```
[2025-12-09 10:23:45.123] INFO workflow_core_module:1.0.0 AUTHZ community=1 user=42 action=check_permission result=ALLOWED workflow_id=550e8400... permission=can_edit

[2025-12-09 10:24:01.456] INFO workflow_core_module:1.0.0 AUTHZ community=1 user=42 action=check_permission result=DENIED workflow_id=550e8400... permission=can_delete
```

### Grant Permission Logs

```
[2025-12-09 10:24:12.789] INFO workflow_core_module:1.0.0 AUDIT user=1 action=grant_permission result=SUCCESS workflow_id=550e8400... target_type=user target_id=42 permissions={"can_view": true, "can_edit": true}
```

### Revoke Permission Logs

```
[2025-12-09 10:25:00.012] INFO workflow_core_module:1.0.0 AUDIT user=1 action=revoke_permission result=SUCCESS workflow_id=550e8400... target_type=user target_id=42
```

## Best Practices

1. **Always Check Permissions First**: Verify access before performing operations
2. **Use Owner Bypass**: Owner check is performed automatically, no need to special-case
3. **Log Permission Changes**: Grant/revoke operations are automatically logged for audit
4. **Cache Permission Checks**: For high-traffic endpoints, consider caching permission checks
5. **Validate Input**: Permission service validates target_type and permission_type
6. **Handle Errors Gracefully**: Returns False/empty on errors, never throws exceptions
7. **Community Scope**: Include community_id in checks when available for better logging
8. **Role Inheritance**: Users inherit permissions from all their roles (OR logic)

## Migration from Old System

If migrating from an old permission system:

```python
async def migrate_permissions(old_permissions, dal, logger):
    """Migrate from old permission format"""
    perm_service = PermissionService(dal, logger)

    for old_perm in old_permissions:
        await perm_service.grant_permission(
            workflow_id=old_perm['workflow_id'],
            target_type=old_perm['type'],  # user, role, entity
            target_id=old_perm['id'],
            permissions_dict={
                "can_view": old_perm.get('read', False),
                "can_edit": old_perm.get('write', False),
                "can_execute": old_perm.get('execute', False),
                "can_delete": old_perm.get('delete', False),
                "can_manage_permissions": old_perm.get('admin', False),
            },
            granted_by=1  # System migration
        )
```

## Performance Tips

### Caching Strategy

```python
from functools import lru_cache
import asyncio

# Cache for 5 minutes
_permission_cache = {}

async def cached_check_permission(workflow_id, user_id, permission_type):
    cache_key = f"{workflow_id}:{user_id}:{permission_type}"

    if cache_key in _permission_cache:
        return _permission_cache[cache_key]

    result = await permission_service.check_permission(
        workflow_id=workflow_id,
        user_id=user_id,
        permission_type=permission_type
    )

    _permission_cache[cache_key] = result

    # Invalidate cache after 5 minutes
    asyncio.create_task(invalidate_cache_after(cache_key, 300))

    return result
```

### Bulk Operations

```python
async def grant_to_multiple_users(workflow_id, user_ids, permissions_dict, granted_by):
    """Grant same permissions to multiple users"""
    results = []
    for user_id in user_ids:
        result = await permission_service.grant_permission(
            workflow_id=workflow_id,
            target_type="user",
            target_id=user_id,
            permissions_dict=permissions_dict,
            granted_by=granted_by
        )
        results.append(result)

    return results
```

## Troubleshooting

### Permission Denied But Should Be Allowed

1. Check if user is owner: `await service._is_workflow_owner(workflow_id, user_id)`
2. Check user-level permissions: `await service._get_permission(workflow_id, "user", user_id)`
3. Check user roles: `await service._get_user_roles(user_id, community_id)`
4. Check entity permissions: `await service._get_all_workflow_entity_permissions(workflow_id)`
5. Check logs for DENIED results

### Unexpected Cascading Permissions

Permissions use OR logic across levels. If permission should not cascade:
- Remove role assignment from user
- Or revoke the specific permission at role level

### Database Not Updating

Ensure:
- `workflow_permissions` table exists (from migration 003)
- Database write access is available
- AsyncDAL is properly initialized
