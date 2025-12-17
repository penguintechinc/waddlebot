# Security Core Module - API Documentation

## Overview

Comprehensive security module providing spam detection, content filtering, warning system, and cross-platform moderation synchronization.

**Base URL**: `http://localhost:8041/api/v1/security`
**Version**: 1.0.0

---

## Public API Endpoints

### Get Module Status
```http
GET /api/v1/security/status
```

**Response**:
```json
{
  "success": true,
  "data": {
    "module": "security-core",
    "version": "1.0.0",
    "status": "healthy"
  }
}
```

### Get Security Configuration
```http
GET /api/v1/security/{community_id}/config
```

**Response**:
```json
{
  "success": true,
  "data": {
    "community_id": 123,
    "spam_detection_enabled": true,
    "spam_message_threshold": 5,
    "spam_interval_seconds": 10,
    "spam_duplicate_threshold": 3,
    "content_filter_enabled": true,
    "blocked_words": ["word1", "word2"],
    "blocked_patterns": ["pattern1"],
    "filter_action": "delete",
    "warning_enabled": true,
    "warning_threshold_timeout": 3,
    "warning_threshold_ban": 5,
    "warning_decay_days": 30,
    "rate_limit_enabled": true,
    "rate_limit_commands_per_minute": 10,
    "rate_limit_messages_per_minute": 30,
    "auto_timeout_enabled": true,
    "timeout_base_duration_minutes": 10,
    "cross_platform_sync": false,
    "reputation_integration_enabled": true
  }
}
```

### Update Security Configuration
```http
PUT /api/v1/security/{community_id}/config
```

**Request**:
```json
{
  "spam_detection_enabled": true,
  "spam_message_threshold": 5,
  "content_filter_enabled": true,
  "warning_enabled": true,
  "auto_timeout_enabled": true
}
```

### Get Warnings
```http
GET /api/v1/security/{community_id}/warnings?status=active&page=1&limit=25
```

**Query Parameters**:
- `status`: active, expired, all (default: active)
- `page`: page number (default: 1)
- `limit`: results per page (default: 25)

### Issue Manual Warning
```http
POST /api/v1/security/{community_id}/warnings
```

**Request**:
```json
{
  "platform": "twitch",
  "platform_user_id": "12345",
  "warning_reason": "Spamming chat",
  "issued_by": 789
}
```

### Revoke Warning
```http
DELETE /api/v1/security/{community_id}/warnings/{warning_id}
```

**Request**:
```json
{
  "revoked_by": 789,
  "revoke_reason": "Warning issued in error"
}
```

### Get Filter Matches
```http
GET /api/v1/security/{community_id}/filter-matches?page=1&limit=50
```

### Manage Blocked Words
```http
POST /api/v1/security/{community_id}/blocked-words
DELETE /api/v1/security/{community_id}/blocked-words
```

**Request**:
```json
{
  "words": ["word1", "word2", "word3"]
}
```

### Get Moderation Log
```http
GET /api/v1/security/{community_id}/moderation-log?page=1&limit=50
```

---

## Internal API (Service-to-Service)

### Check Message
```http
POST /api/v1/internal/check
```

**Request**:
```json
{
  "community_id": 123,
  "platform": "twitch",
  "platform_user_id": "12345",
  "message": "User message here",
  "metadata": {}
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "allowed": true
  }
}
```

**Or if blocked**:
```json
{
  "success": true,
  "data": {
    "allowed": false,
    "blocked_reason": "spam_detected",
    "action_taken": "warn"
  }
}
```

### Issue Automated Warning
```http
POST /api/v1/internal/warn
```

**Request**:
```json
{
  "community_id": 123,
  "platform": "twitch",
  "platform_user_id": "12345",
  "warning_type": "spam",
  "warning_reason": "Exceeded message rate limit",
  "trigger_message": "spam spam spam"
}
```

### Sync Moderation Action
```http
POST /api/v1/internal/sync-action
```

**Request**:
```json
{
  "community_id": 123,
  "platform": "twitch",
  "platform_user_id": "12345",
  "action_type": "timeout",
  "action_reason": "Spamming",
  "moderator_id": 789,
  "sync_to_platforms": ["discord", "youtube"]
}
```

---

## Security Features

### Spam Detection
- Message rate limiting
- Duplicate message detection
- Pattern-based spam detection
- Configurable thresholds

### Content Filtering
- Blocked word list
- Regex pattern matching
- Configurable actions (delete, warn, timeout)
- Filter match logging

### Warning System
- Automated and manual warnings
- Warning accumulation
- Warning decay (configurable days)
- Escalation thresholds
- Auto-timeout/ban on threshold

### Cross-Platform Moderation
- Sync bans across platforms
- Sync timeouts across platforms
- Unified moderation log
- Platform-specific overrides

### Rate Limiting
- Per-user message limits
- Per-user command limits
- Redis-based rate limiting
- Configurable windows

### Reputation Integration
- Negative reputation impact on moderation
- Auto-ban integration
- Reputation-based filtering

---

## Configuration Defaults

```python
DEFAULT_SPAM_MESSAGE_THRESHOLD = 5
DEFAULT_SPAM_INTERVAL_SECONDS = 10
DEFAULT_SPAM_DUPLICATE_THRESHOLD = 3
DEFAULT_RATE_LIMIT_MESSAGES_PER_MINUTE = 30
DEFAULT_RATE_LIMIT_COMMANDS_PER_MINUTE = 10
DEFAULT_WARNING_THRESHOLD_TIMEOUT = 3
DEFAULT_WARNING_THRESHOLD_BAN = 5
DEFAULT_WARNING_DECAY_DAYS = 30
DEFAULT_AUTO_TIMEOUT_FIRST = 5  # minutes
DEFAULT_AUTO_TIMEOUT_SECOND = 60  # minutes
DEFAULT_AUTO_TIMEOUT_THIRD = 1440  # 24 hours
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
