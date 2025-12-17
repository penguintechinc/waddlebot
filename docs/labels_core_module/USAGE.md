# Labels Core Module - Usage Guide

## Quick Start

### Starting the Module

```bash
cd core/labels_core_module
python app.py
```

The module starts on port 8023 by default.

### Verify Module is Running

```bash
curl http://localhost:8023/health
```

Expected response:
```json
{
  "status": "healthy",
  "module": "labels_core_module",
  "version": "2.0.0"
}
```

---

## Common Use Cases

### 1. Creating User Labels

Create labels to categorize users:

```bash
# Create VIP label
curl -X POST http://localhost:8023/api/v1/labels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "VIP Member",
    "category": "user",
    "description": "VIP community member with special privileges",
    "color": "#fbbf24",
    "icon": "crown",
    "created_by": "admin"
  }'
```

### 2. Applying Labels to Users

Apply the VIP label to a user:

```bash
curl -X POST http://localhost:8023/api/v1/labels/apply \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "user_12345",
    "entity_type": "user",
    "label_id": 1,
    "applied_by": "moderator_789",
    "community_id": "community_456"
  }'
```

### 3. Checking User Labels

Get all labels for a user:

```bash
curl http://localhost:8023/api/v1/entity/user/user_12345/labels
```

Response:
```json
{
  "success": true,
  "data": {
    "entity_id": "user_12345",
    "entity_type": "user",
    "labels": [
      {
        "label_name": "VIP Member",
        "label_color": "#fbbf24",
        "label_icon": "crown",
        "applied_by": "moderator_789",
        "applied_at": "2025-01-15T14:30:00"
      }
    ],
    "total": 1,
    "limit": 5
  }
}
```

### 4. Temporary Labels with Expiration

Apply a temporary promotional label:

```bash
curl -X POST http://localhost:8023/api/v1/labels/apply \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "user_12345",
    "entity_type": "user",
    "label_id": 2,
    "applied_by": "system",
    "expires_at": "2025-12-31T23:59:59Z",
    "metadata": {
      "promotion": "winter_sale_2025",
      "discount_percent": 20
    }
  }'
```

### 5. Bulk Label Application

Apply labels to multiple users at once:

```bash
curl -X POST http://localhost:8023/api/v1/labels/apply \
  -H "Content-Type: application/json" \
  -d '[
    {
      "entity_id": "user_100",
      "entity_type": "user",
      "label_id": 1,
      "applied_by": "admin"
    },
    {
      "entity_id": "user_200",
      "entity_type": "user",
      "label_id": 1,
      "applied_by": "admin"
    },
    {
      "entity_id": "user_300",
      "entity_type": "user",
      "label_id": 1,
      "applied_by": "admin"
    }
  ]'
```

### 6. Searching Users by Labels

Find all users with specific labels:

```bash
# Find users with VIP label
curl "http://localhost:8023/api/v1/labels/search?entity_type=user&labels=VIP%20Member"

# Find users with BOTH VIP and Premium labels
curl "http://localhost:8023/api/v1/labels/search?entity_type=user&labels=VIP%20Member,Premium&match_all=true"
```

### 7. Removing Labels

Remove a label from a user:

```bash
curl -X POST http://localhost:8023/api/v1/labels/remove \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "user_12345",
    "entity_type": "user",
    "label_id": 1
  }'
```

---

## Entity Type Examples

### Labeling Playlists

```bash
# Create playlist category label
curl -X POST http://localhost:8023/api/v1/labels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Chill Vibes",
    "category": "playlist",
    "description": "Relaxing and chill music",
    "color": "#3b82f6",
    "icon": "music",
    "created_by": "dj_user"
  }'

# Apply to playlist
curl -X POST http://localhost:8023/api/v1/labels/apply \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "playlist_xyz789",
    "entity_type": "playlist",
    "label_id": 3,
    "applied_by": "dj_user"
  }'
```

### Labeling Events

```bash
# Create event label
curl -X POST http://localhost:8023/api/v1/labels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Tournament",
    "category": "event",
    "description": "Competitive tournament event",
    "color": "#ef4444",
    "icon": "trophy",
    "created_by": "event_manager"
  }'

# Apply to event
curl -X POST http://localhost:8023/api/v1/labels/apply \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "event_2025_championship",
    "entity_type": "event",
    "label_id": 4,
    "applied_by": "event_manager"
  }'
```

### Labeling Custom Commands

```bash
# Create command category label
curl -X POST http://localhost:8023/api/v1/labels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Mod Only",
    "category": "command",
    "description": "Restricted to moderators",
    "color": "#f59e0b",
    "icon": "shield",
    "created_by": "admin"
  }'

# Apply to command
curl -X POST http://localhost:8023/api/v1/labels/apply \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "command_ban",
    "entity_type": "command",
    "label_id": 5,
    "applied_by": "admin"
  }'
```

---

## Python Client Examples

### Using aiohttp

```python
import aiohttp
import asyncio

async def create_and_apply_label():
    """Create a label and apply it to a user."""
    async with aiohttp.ClientSession() as session:
        # Create label
        create_url = "http://localhost:8023/api/v1/labels"
        create_data = {
            "name": "Subscriber",
            "category": "user",
            "description": "Active subscriber",
            "color": "#10b981",
            "icon": "star",
            "created_by": "system"
        }
        async with session.post(create_url, json=create_data) as resp:
            result = await resp.json()
            label_id = result['data']['label_id']
            print(f"Created label ID: {label_id}")

        # Apply label
        apply_url = "http://localhost:8023/api/v1/labels/apply"
        apply_data = {
            "entity_id": "user_abc123",
            "entity_type": "user",
            "label_id": label_id,
            "applied_by": "system"
        }
        async with session.post(apply_url, json=apply_data) as resp:
            result = await resp.json()
            print(f"Applied label: {result}")

asyncio.run(create_and_apply_label())
```

### Bulk Label Operations

```python
import aiohttp
import asyncio

async def bulk_label_users(user_ids, label_id):
    """Apply a label to multiple users in bulk."""
    async with aiohttp.ClientSession() as session:
        bulk_data = [
            {
                "entity_id": user_id,
                "entity_type": "user",
                "label_id": label_id,
                "applied_by": "admin"
            }
            for user_id in user_ids
        ]

        url = "http://localhost:8023/api/v1/labels/apply"
        async with session.post(url, json=bulk_data) as resp:
            result = await resp.json()
            summary = result['data']['summary']
            print(f"Bulk operation: {summary['successful']} successful, {summary['failed']} failed")

user_list = ["user_1", "user_2", "user_3", "user_4", "user_5"]
asyncio.run(bulk_label_users(user_list, label_id=1))
```

### Search and Filter

```python
import aiohttp
import asyncio

async def find_vip_users():
    """Find all users with VIP label."""
    async with aiohttp.ClientSession() as session:
        url = "http://localhost:8023/api/v1/labels/search"
        params = {
            "entity_type": "user",
            "labels": "VIP Member",
            "limit": 100
        }
        async with session.get(url, params=params) as resp:
            result = await resp.json()
            users = result['data']['results']
            print(f"Found {len(users)} VIP users")
            for user in users:
                print(f"  - {user['entity_id']}: {len(user['labels'])} labels")

asyncio.run(find_vip_users())
```

---

## Best Practices

### 1. Label Naming Conventions

- **Be descriptive**: Use clear, meaningful names
- **Consistent capitalization**: "VIP Member" not "vip member"
- **Avoid special characters**: Stick to alphanumeric and spaces
- **Keep it short**: Max 50 characters recommended

### 2. Color Coding

Use consistent color schemes:
- **Membership tiers**: Gold (#fbbf24), Silver (#9ca3af), Bronze (#d97706)
- **Permissions**: Admin (#ef4444), Moderator (#f59e0b), User (#3b82f6)
- **Status**: Active (#10b981), Suspended (#f59e0b), Banned (#ef4444)

### 3. Metadata Usage

Store contextual information in metadata:

```json
{
  "metadata": {
    "granted_date": "2025-01-15",
    "granted_by": "admin_user",
    "reason": "Annual subscription renewal",
    "tier_level": 3,
    "benefits": ["ad_free", "custom_emotes", "priority_support"]
  }
}
```

### 4. Expiration Management

For temporary labels:
- Always set `expires_at` for promotional labels
- Use ISO 8601 format: "2025-12-31T23:59:59Z"
- Implement cleanup cron job to remove expired labels
- Consider renewal workflow for expiring labels

### 5. Bulk Operations

When applying many labels:
- Use bulk endpoint for 10+ operations
- Batch in groups of 500-1000
- Handle partial failures gracefully
- Log detailed results for auditing

### 6. Search Optimization

For better search performance:
- Use specific entity types
- Limit result sets with `limit` parameter
- Cache frequently searched labels
- Use `match_all` only when necessary

---

## Troubleshooting

### Label Not Appearing

**Problem**: Applied label doesn't show up

**Solutions**:
1. Check `is_active` flag is true
2. Verify entity_id matches exactly
3. Check for expiration: `expires_at` hasn't passed
4. Query with correct entity_type

### Label Limit Exceeded

**Problem**: Error "can have maximum N labels"

**Solutions**:
1. Remove unused labels first
2. Check limit for entity type in `/status` endpoint
3. Consider label consolidation
4. Request limit increase if needed

### Duplicate Label Error

**Problem**: "Label already exists in category"

**Solutions**:
1. List existing labels: `GET /labels?category=user`
2. Use different name
3. Update existing label instead
4. Check for soft-deleted labels

### Bulk Operation Partial Failure

**Problem**: Some items in bulk operation failed

**Solutions**:
1. Check `results` array in response
2. Identify failed items by `success: false`
3. Review `error` field for each failure
4. Retry failed items individually

---

## Monitoring and Maintenance

### Health Checks

Regular health check:
```bash
curl http://localhost:8023/health
```

### Database Cleanup

Periodic cleanup of expired labels:
```sql
UPDATE entity_labels
SET is_active = false
WHERE expires_at < NOW()
AND is_active = true;
```

### Audit Log Review

Check AAA logs for label operations:
```bash
grep "create_label\|apply_label" /var/log/waddlebot/labels_core_module.log
```

### Performance Monitoring

Monitor these metrics:
- Label creation rate
- Application rate per entity type
- Search query performance
- Database query times
- API response times

---

## Integration Examples

### Integration with User Module

```python
# When user subscribes, apply subscriber label
async def on_user_subscribe(user_id):
    await apply_label(
        entity_id=user_id,
        entity_type="user",
        label_id=SUBSCRIBER_LABEL_ID,
        applied_by="system"
    )
```

### Integration with Command Module

```python
# Check if command has "Admin Only" label before executing
async def can_execute_command(command_id, user):
    labels = await get_entity_labels(command_id, "command")
    admin_only = any(l['label_name'] == 'Admin Only' for l in labels)

    if admin_only and not user.is_admin:
        return False
    return True
```

### Integration with Event Module

```python
# Filter events by label
async def get_tournament_events():
    result = await search_by_labels(
        entity_type="event",
        labels=["Tournament"],
        limit=50
    )
    return result['results']
```
