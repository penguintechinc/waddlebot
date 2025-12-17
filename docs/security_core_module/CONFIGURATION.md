# Security Core Module - Configuration

## Environment Variables

```bash
# Module Identity
MODULE_PORT=8041

# Database
DATABASE_URL=postgresql://waddlebot:waddlebot123@localhost:5432/waddlebot

# Redis for rate limiting
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=1

# Service URLs
ROUTER_API_URL=http://router:8000/api/v1/router
REPUTATION_API_URL=http://reputation:8021/api/v1/reputation

# Logging
LOG_LEVEL=INFO
SECRET_KEY=change-me-in-production
SERVICE_API_KEY=service-to-service-key
```

## Configuration Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| MODULE_PORT | 8041 | HTTP port |
| REDIS_HOST | localhost | Redis server host |
| REDIS_PORT | 6379 | Redis server port |
| REDIS_DB | 1 | Redis database number |
| LOG_LEVEL | INFO | Logging verbosity |

## Spam Detection Settings

```python
DEFAULT_SPAM_MESSAGE_THRESHOLD = 5      # messages
DEFAULT_SPAM_INTERVAL_SECONDS = 10      # seconds
DEFAULT_SPAM_DUPLICATE_THRESHOLD = 3    # duplicate messages
```

## Rate Limiting

```python
DEFAULT_RATE_LIMIT_MESSAGES_PER_MINUTE = 30
DEFAULT_RATE_LIMIT_COMMANDS_PER_MINUTE = 10
```

## Warning System

```python
DEFAULT_WARNING_THRESHOLD_TIMEOUT = 3   # warnings before timeout
DEFAULT_WARNING_THRESHOLD_BAN = 5       # warnings before ban
DEFAULT_WARNING_DECAY_DAYS = 30         # days until warning expires
```

## Auto-Timeout Escalation

```python
DEFAULT_AUTO_TIMEOUT_FIRST = 5          # minutes
DEFAULT_AUTO_TIMEOUT_SECOND = 60        # minutes (1 hour)
DEFAULT_AUTO_TIMEOUT_THIRD = 1440       # minutes (24 hours)
```

## Reputation Impact

```python
REPUTATION_IMPACT = {
    'warn': -25.0,
    'timeout': -50.0,
    'kick': -75.0,
    'ban': -200.0
}
```

## Database Tables

```sql
security_config            -- Per-community configuration
security_warnings          -- Warning tracking
security_filter_matches    -- Content filter logs
security_moderation_actions -- Moderation action log
security_spam_tracking     -- Spam detection state (Redis preferred)
```

## Redis Keys

```
security:ratelimit:msg:{community_id}:{user_id}
security:ratelimit:cmd:{community_id}:{user_id}
security:spam:{community_id}:{user_id}:messages
security:spam:{community_id}:{user_id}:duplicates
```

## Content Filter Configuration

### Filter Actions
- `delete`: Delete message
- `warn`: Issue warning
- `timeout`: Timeout user
- `ban`: Ban user

### Blocked Words
Stored in `security_config.blocked_words` (JSONB array)

### Blocked Patterns
Regex patterns in `security_config.blocked_patterns` (JSONB array)

Example:
```json
{
  "blocked_words": ["spam", "scam", "phishing"],
  "blocked_patterns": ["http.*\\.scam\\.com", "buy.*pills"]
}
```
