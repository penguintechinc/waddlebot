# Reputation Module - Usage Guide

## Quick Start

```bash
cd core/reputation_module
python app.py
```

## Common Operations

### Check User Reputation

```bash
curl http://localhost:8021/api/v1/reputation/123/user/456
```

### View Leaderboard

```bash
curl http://localhost:8021/api/v1/reputation/123/leaderboard?limit=10
```

### Process Event (Internal)

```bash
curl -X POST http://localhost:8021/api/v1/internal/events \
  -H "X-Service-Key: service-key" \
  -H "Content-Type: application/json" \
  -d '{
    "community_id": 123,
    "user_id": 456,
    "platform": "twitch",
    "platform_user_id": "12345",
    "event_type": "subscription"
  }'
```

### Batch Process Events

```bash
curl -X POST http://localhost:8021/api/v1/internal/events \
  -H "X-Service-Key: service-key" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {"community_id": 123, "event_type": "chatMessage", "user_id": 456},
      {"community_id": 123, "event_type": "follow", "user_id": 456},
      {"community_id": 123, "event_type": "subscription", "user_id": 456}
    ]
  }'
```

## Admin Operations

### Manually Set Reputation

```bash
curl -X PUT http://localhost:8021/api/v1/admin/123/reputation/456 \
  -H "Content-Type: application/json" \
  -d '{
    "score": 700,
    "reason": "Manual adjustment for migration",
    "admin_id": 789
  }'
```

### Configure Auto-Ban

```bash
curl -X POST http://localhost:8021/api/v1/admin/123/reputation/auto-ban \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "threshold": 450,
    "admin_id": 789
  }'
```

### Customize Weights (Premium Only)

```bash
curl -X PUT http://localhost:8021/api/v1/admin/123/reputation/config \
  -H "Content-Type: application/json" \
  -d '{
    "admin_id": 789,
    "weights": {
      "chat_message": 0.02,
      "subscription": 10.0,
      "warn": -30.0
    }
  }'
```

### View At-Risk Users

```bash
curl http://localhost:8021/api/v1/admin/123/reputation/at-risk?buffer=50
```

## Python Client Example

```python
import aiohttp

async def process_subscription(community_id, user_id):
    """Process subscription event."""
    async with aiohttp.ClientSession() as session:
        url = "http://localhost:8021/api/v1/internal/events"
        headers = {"X-Service-Key": "service-key"}
        data = {
            "community_id": community_id,
            "user_id": user_id,
            "event_type": "subscription",
            "platform": "twitch",
            "platform_user_id": "12345"
        }

        async with session.post(url, json=data, headers=headers) as resp:
            result = await resp.json()
            print(f"Processed: {result}")
```

## Monitoring

### Check Reputation Distribution

```sql
SELECT
    CASE
        WHEN reputation >= 800 THEN 'Exceptional'
        WHEN reputation >= 740 THEN 'Very Good'
        WHEN reputation >= 670 THEN 'Good'
        WHEN reputation >= 580 THEN 'Fair'
        ELSE 'Poor'
    END as tier,
    COUNT(*) as user_count,
    AVG(reputation) as avg_score
FROM community_members
WHERE community_id = 123
GROUP BY tier;
```

### Recent Events

```sql
SELECT * FROM reputation_events
WHERE community_id = 123
ORDER BY created_at DESC
LIMIT 20;
```
