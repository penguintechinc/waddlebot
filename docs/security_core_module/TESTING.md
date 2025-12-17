# Security Core Module - Testing Guide

## Unit Tests

```python
import pytest
from services.spam_detector import SpamDetector
from services.content_filter import ContentFilter

@pytest.mark.asyncio
async def test_spam_detection():
    """Test spam detection logic."""
    detector = SpamDetector(dal, logger)

    # Simulate rapid messages
    for i in range(10):
        is_spam = await detector.check_spam(
            community_id=123,
            platform='twitch',
            platform_user_id='12345'
        )

    # Should detect spam after threshold
    assert is_spam is True

@pytest.mark.asyncio
async def test_content_filter():
    """Test content filtering."""
    filter = ContentFilter(dal, logger)

    # Test blocked word
    is_filtered, pattern = await filter.check_message(
        community_id=123,
        message="This is spam content"
    )

    assert is_filtered is True
    assert pattern is not None
```

## Integration Tests

```python
@pytest.mark.asyncio
async def test_message_check_flow(client):
    """Test complete message checking flow."""
    response = await client.post(
        '/api/v1/internal/check',
        json={
            'community_id': 123,
            'platform': 'twitch',
            'platform_user_id': '12345',
            'message': 'Normal message'
        }
    )

    data = await response.get_json()
    assert data['data']['allowed'] is True

@pytest.mark.asyncio
async def test_warning_system(client):
    """Test warning issuance."""
    response = await client.post(
        '/api/v1/security/123/warnings',
        json={
            'platform': 'twitch',
            'platform_user_id': '12345',
            'warning_reason': 'Test warning',
            'issued_by': 789
        }
    )

    assert response.status_code == 200
```

## Load Testing

```python
import asyncio
import aiohttp

async def load_test_message_checks(num_messages=1000):
    """Load test message checking."""
    async with aiohttp.ClientSession() as session:
        tasks = []
        for i in range(num_messages):
            task = session.post(
                'http://localhost:8041/api/v1/internal/check',
                json={
                    'community_id': 123,
                    'platform': 'twitch',
                    'platform_user_id': str(i),
                    'message': f'Test message {i}'
                }
            )
            tasks.append(task)

        results = await asyncio.gather(*tasks)
        allowed = sum(1 for r in results if (await r.json())['data']['allowed'])
        print(f"Checked {num_messages} messages: {allowed} allowed")

asyncio.run(load_test_message_checks(1000))
```

## Manual Testing

### Test Spam Detection

```bash
# Send rapid messages
for i in {1..10}; do
  curl -X POST http://localhost:8041/api/v1/internal/check \
    -H "Content-Type: application/json" \
    -d "{\"community_id\": 123, \"platform\": \"twitch\", \"platform_user_id\": \"test_user\", \"message\": \"spam $i\"}"
  sleep 0.5
done

# Should start blocking after threshold
```

### Test Content Filter

```bash
# Test blocked word
curl -X POST http://localhost:8041/api/v1/internal/check \
  -H "Content-Type: application/json" \
  -d '{
    "community_id": 123,
    "platform": "twitch",
    "platform_user_id": "test_user",
    "message": "Check out this spam link"
  }'

# Should return allowed: false
```

### Test Warning System

```bash
# Issue warnings
for i in {1..5}; do
  curl -X POST http://localhost:8041/api/v1/security/123/warnings \
    -H "Content-Type: application/json" \
    -d "{\"platform\": \"twitch\", \"platform_user_id\": \"test_user\", \"warning_reason\": \"Test $i\", \"issued_by\": 1}"
done

# Check if auto-timeout triggered
curl http://localhost:8041/api/v1/security/123/warnings?status=active
```

## Redis Testing

```bash
# Check rate limit keys
redis-cli KEYS "security:ratelimit:*"

# Check spam tracking
redis-cli LLEN "security:spam:123:12345:messages"

# Clear test data
redis-cli FLUSHDB
```

## Database Testing

```sql
-- Check warning count
SELECT platform_user_id, COUNT(*) as warning_count
FROM security_warnings
WHERE community_id = 123 AND is_active = true
GROUP BY platform_user_id
ORDER BY warning_count DESC;

-- Check filter matches
SELECT * FROM security_filter_matches
WHERE community_id = 123
ORDER BY created_at DESC
LIMIT 10;

-- Check moderation actions
SELECT action_type, COUNT(*) as count
FROM security_moderation_actions
WHERE community_id = 123
GROUP BY action_type;
```
