# Rate Limiter Usage

## Overview

The `RateLimiter` service provides per-user and per-community rate limiting with Redis primary storage and database fallback. It uses a sliding window algorithm for accurate rate limiting.

## Features

- **Per-user rate limiting**: Limit requests per user per hour
- **Per-community rate limiting**: Limit total requests per community per hour
- **Multiple limit types**: Different limits for different operations (research, ask, recall)
- **Redis primary**: Fast in-memory rate limiting
- **Database fallback**: Automatic fallback to database if Redis fails
- **Fail-open**: Allows requests if both Redis and DB fail (for availability)
- **AAA logging**: Comprehensive authentication, authorization, and auditing logs

## Rate Limit Types

| Type | User Limit (per hour) | Community Limit (per hour) |
|------|----------------------|---------------------------|
| `research` | 5 | 50 |
| `ask` | 10 | 100 |
| `recall` | 20 | 200 |

## Initialization

```python
import redis.asyncio as redis
from services import RateLimiter

# Create Redis client
redis_client = redis.Redis(
    host='localhost',
    port=6379,
    decode_responses=True
)

# Initialize rate limiter (with optional DB fallback)
rate_limiter = RateLimiter(
    redis_client=redis_client,
    db_connection=db  # Optional database connection for fallback
)
```

## Basic Usage

### Check Rate Limit (without incrementing)

```python
from services import RateLimiter

result = await rate_limiter.check_limit(
    community_id=123,
    user_id="user_456",
    limit_type="research"
)

if result.allowed:
    print(f"Request allowed. {result.remaining} requests remaining.")
    print(f"Limit resets at {result.reset_at}")
else:
    print(f"Rate limit exceeded. Try again at {result.reset_at}")
```

### Check and Increment (atomic operation)

```python
result = await rate_limiter.increment(
    community_id=123,
    user_id="user_456",
    limit_type="ask"
)

if result.allowed:
    # Process the request
    response = await process_ask_request(...)
else:
    # Return rate limit error
    return error_response("Rate limit exceeded", 429)
```

### Get Current Usage

```python
# Get user usage
usage = await rate_limiter.get_usage(
    community_id=123,
    user_id="user_456"
)

print(usage)
# {
#     'community_id': 123,
#     'user_id': 'user_456',
#     'usage': {
#         'research': {'count': 2, 'limit': 5, 'remaining': 3},
#         'ask': {'count': 5, 'limit': 10, 'remaining': 5},
#         'recall': {'count': 0, 'limit': 20, 'remaining': 20}
#     },
#     'reset_at': '2025-12-06T14:00:00'
# }

# Get community usage
usage = await rate_limiter.get_usage(
    community_id=123,
    user_id=None  # None = community-level usage
)
```

### Reset User Limits

```python
# Reset all limits for a user (admin operation)
success = await rate_limiter.reset_user(
    community_id=123,
    user_id="user_456"
)
```

## Integration Example

### Flask/Quart Endpoint

```python
from quart import Blueprint, request
from services import RateLimiter, RateLimitResult

api_bp = Blueprint('api', __name__)

@api_bp.route('/research', methods=['POST'])
async def research():
    data = await request.get_json()

    # Check and increment rate limit
    result = await rate_limiter.increment(
        community_id=data['community_id'],
        user_id=data['user_id'],
        limit_type='research'
    )

    if not result.allowed:
        return {
            'error': 'Rate limit exceeded',
            'reset_at': result.reset_at.isoformat(),
            'limit': result.limit
        }, 429

    # Process request
    response = await process_research(data)

    # Add rate limit headers
    return response, 200, {
        'X-RateLimit-Limit': str(result.limit),
        'X-RateLimit-Remaining': str(result.remaining),
        'X-RateLimit-Reset': result.reset_at.isoformat()
    }
```

## Redis Key Structure

Rate limit counters are stored in Redis with the following key patterns:

- **User limits**: `ratelimit:{community_id}:{user_id}:{limit_type}:{hour}`
- **Community limits**: `ratelimit:{community_id}:community:{limit_type}:{hour}`

Where `{hour}` is formatted as `YYYYMMDDHH` (e.g., `2025120613` for 1pm on Dec 6, 2025).

Keys automatically expire after 2 hours to prevent memory buildup.

## Database Fallback

If Redis is unavailable, the rate limiter automatically falls back to the `ai_rate_limit_state` database table:

```sql
CREATE TABLE ai_rate_limit_state (
    key VARCHAR(255) PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_rate_limit_expires ON ai_rate_limit_state(expires_at);
```

## Error Handling

The rate limiter follows a **fail-open** policy:

- If both Redis and database fail, requests are **allowed** (with limit=999, remaining=999)
- This ensures availability even during infrastructure issues
- All failures are logged for monitoring

## Logging

All rate limit operations are logged with AAA (Authentication, Authorization, Auditing) metadata:

```python
# Rate limit exceeded (WARNING)
logger.warning(
    "User rate limit exceeded: user_456",
    extra={
        'community_id': 123,
        'user_id': 'user_456',
        'limit_type': 'research',
        'count': 5,
        'limit': 5,
        'action': 'rate_limit_user',
        'result': 'BLOCKED'
    }
)

# Rate limit check passed (INFO)
logger.info(
    "Rate limit check passed",
    extra={
        'community_id': 123,
        'user_id': 'user_456',
        'limit_type': 'research',
        'user_count': 3,
        'community_count': 15,
        'action': 'rate_limit_check',
        'result': 'ALLOWED'
    }
)
```

## Testing

```python
import pytest
from services import RateLimiter, RateLimitResult

@pytest.mark.asyncio
async def test_rate_limit_basic():
    # Create rate limiter
    rate_limiter = RateLimiter(redis_client, db_connection)

    # First 5 requests should succeed
    for i in range(5):
        result = await rate_limiter.increment(
            community_id=1,
            user_id="test_user",
            limit_type="research"
        )
        assert result.allowed is True
        assert result.remaining == 5 - (i + 1)

    # 6th request should fail
    result = await rate_limiter.increment(
        community_id=1,
        user_id="test_user",
        limit_type="research"
    )
    assert result.allowed is False
    assert result.remaining == 0
```

## Performance Considerations

- **Redis operations**: O(1) for all operations (incr, get, expire)
- **Database fallback**: Uses upsert for atomic increment
- **Key expiry**: Automatic cleanup after 2 hours
- **Concurrency**: Safe for concurrent access (Redis atomic operations)

## Customizing Limits

To customize rate limits, modify the `DEFAULT_LIMITS` dictionary in the `RateLimiter` class:

```python
class RateLimiter:
    DEFAULT_LIMITS = {
        'research': {'user': 10, 'community': 100},  # Increase limits
        'ask': {'user': 20, 'community': 200},
        'recall': {'user': 50, 'community': 500},
        'custom_operation': {'user': 15, 'community': 150}  # Add new type
    }
```

Or configure via environment variables by extending the `Config` class.
