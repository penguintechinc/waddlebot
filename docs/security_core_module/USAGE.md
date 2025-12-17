# Security Core Module - Usage Guide

## Quick Start

```bash
cd core/security_core_module
python app.py
```

Module starts on port 8041.

## Configure Security Settings

### Get Current Configuration

```bash
curl http://localhost:8041/api/v1/security/123/config
```

### Update Configuration

```bash
curl -X PUT http://localhost:8041/api/v1/security/123/config \
  -H "Content-Type: application/json" \
  -d '{
    "spam_detection_enabled": true,
    "spam_message_threshold": 5,
    "spam_interval_seconds": 10,
    "content_filter_enabled": true,
    "warning_enabled": true,
    "auto_timeout_enabled": true
  }'
```

## Manage Blocked Words

### Add Blocked Words

```bash
curl -X POST http://localhost:8041/api/v1/security/123/blocked-words \
  -H "Content-Type: application/json" \
  -d '{
    "words": ["spam", "scam", "phishing"]
  }'
```

### Remove Blocked Words

```bash
curl -X DELETE http://localhost:8041/api/v1/security/123/blocked-words \
  -H "Content-Type: application/json" \
  -d '{
    "words": ["spam"]
  }'
```

## Warning Management

### Issue Manual Warning

```bash
curl -X POST http://localhost:8041/api/v1/security/123/warnings \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "twitch",
    "platform_user_id": "12345",
    "warning_reason": "Spamming chat",
    "issued_by": 789
  }'
```

### View Warnings

```bash
# Active warnings
curl http://localhost:8041/api/v1/security/123/warnings?status=active

# All warnings
curl http://localhost:8041/api/v1/security/123/warnings?status=all&limit=50
```

### Revoke Warning

```bash
curl -X DELETE http://localhost:8041/api/v1/security/123/warnings/456 \
  -H "Content-Type: application/json" \
  -d '{
    "revoked_by": 789,
    "revoke_reason": "Warning issued in error"
  }'
```

## Message Checking (Internal)

### Check Single Message

```bash
curl -X POST http://localhost:8041/api/v1/internal/check \
  -H "Content-Type: application/json" \
  -d '{
    "community_id": 123,
    "platform": "twitch",
    "platform_user_id": "12345",
    "message": "Hello everyone!",
    "metadata": {}
  }'
```

**Response if allowed**:
```json
{
  "success": true,
  "data": {
    "allowed": true
  }
}
```

**Response if blocked**:
```json
{
  "success": true,
  "data": {
    "allowed": false,
    "blocked_reason": "content_filtered",
    "matched_pattern": "spam",
    "action_taken": "delete"
  }
}
```

## Moderation Actions

### Sync Moderation Action Across Platforms

```bash
curl -X POST http://localhost:8041/api/v1/internal/sync-action \
  -H "Content-Type: application/json" \
  -d '{
    "community_id": 123,
    "platform": "twitch",
    "platform_user_id": "12345",
    "action_type": "timeout",
    "action_reason": "Spamming",
    "moderator_id": 789,
    "sync_to_platforms": ["discord", "youtube"]
  }'
```

### View Moderation Log

```bash
curl http://localhost:8041/api/v1/security/123/moderation-log?limit=50
```

## Python Client Example

```python
import aiohttp

async def check_message_safety(community_id, platform, user_id, message):
    """Check if message is safe to post."""
    async with aiohttp.ClientSession() as session:
        url = "http://localhost:8041/api/v1/internal/check"
        data = {
            "community_id": community_id,
            "platform": platform,
            "platform_user_id": user_id,
            "message": message
        }

        async with session.post(url, json=data) as resp:
            result = await resp.json()
            return result['data']['allowed']

# Usage
is_safe = await check_message_safety(123, "twitch", "12345", "Hello!")
if is_safe:
    # Post message
    pass
else:
    # Block message
    pass
```

## Monitoring

### View Filter Matches

```bash
curl http://localhost:8041/api/v1/security/123/filter-matches?limit=50
```

### Check Warning Count

```sql
SELECT COUNT(*) as active_warnings
FROM security_warnings
WHERE community_id = 123
AND platform_user_id = '12345'
AND is_active = true
AND expires_at > NOW();
```

### View Recent Moderation Actions

```sql
SELECT * FROM security_moderation_actions
WHERE community_id = 123
ORDER BY created_at DESC
LIMIT 20;
```

## Common Configurations

### Strict Security (Competitive Community)

```json
{
  "spam_detection_enabled": true,
  "spam_message_threshold": 3,
  "spam_interval_seconds": 10,
  "content_filter_enabled": true,
  "filter_action": "timeout",
  "warning_threshold_timeout": 2,
  "warning_threshold_ban": 4,
  "auto_timeout_enabled": true,
  "cross_platform_sync": true
}
```

### Relaxed Security (Casual Community)

```json
{
  "spam_detection_enabled": true,
  "spam_message_threshold": 10,
  "spam_interval_seconds": 5,
  "content_filter_enabled": true,
  "filter_action": "warn",
  "warning_threshold_timeout": 5,
  "warning_threshold_ban": 10,
  "auto_timeout_enabled": false,
  "cross_platform_sync": false
}
```
