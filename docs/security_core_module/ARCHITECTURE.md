# Security Core Module - Architecture

## System Overview

Comprehensive security system providing spam detection, content filtering, warnings, and cross-platform moderation.

**Tech Stack**: Quart, PostgreSQL, Redis, pyDAL

## Architecture Diagram

```
┌────────────────────────────────────────────────┐
│         Security Core Module                   │
│                                                │
│  ┌──────────────┐     ┌──────────────────────┐│
│  │ Public API   │     │  Internal API        ││
│  │ /api/v1/     │     │  /api/v1/internal    ││
│  │ security/*   │     │  - check             ││
│  │              │     │  - warn              ││
│  │              │     │  - sync-action       ││
│  └──────┬───────┘     └──────────┬───────────┘│
│         │                        │            │
│         ▼                        ▼            │
│  ┌─────────────────────────────────────────┐ │
│  │        Security Service                 │ │
│  │  - Config management                    │ │
│  │  - Moderation log                       │ │
│  │  - Cross-platform sync                  │ │
│  └────────────┬────────────────────────────┘ │
│               │                               │
│      ┌────────┼────────┬─────────────┐       │
│      ▼        ▼        ▼             ▼       │
│  ┌────────┐ ┌────────┐ ┌─────────┐ ┌──────┐ │
│  │ Spam   │ │Content │ │Warning  │ │Policy│ │
│  │Detector│ │Filter  │ │Manager  │ │Engine│ │
│  └────┬───┘ └───┬────┘ └────┬────┘ └──┬───┘ │
│       │         │           │          │     │
│       ▼         ▼           ▼          ▼     │
│  ┌────────────────────────────────────────┐ │
│  │      Database & Redis Layer            │ │
│  └────────────────────────────────────────┘ │
└────────────────────────────────────────────────┘
```

## Core Components

### 1. SecurityService
Main orchestrator coordinating all security features:
- Configuration management
- Moderation action logging
- Cross-platform synchronization
- Reputation integration

### 2. SpamDetector
Real-time spam detection:
- Message rate tracking (Redis)
- Duplicate message detection
- Pattern-based spam identification
- Configurable thresholds

### 3. ContentFilter
Message content filtering:
- Blocked word matching
- Regex pattern matching
- Filter match logging
- Configurable actions

### 4. WarningManager
Warning system management:
- Issue warnings (automated/manual)
- Track warning count
- Warning decay
- Threshold escalation
- Auto-timeout/ban

## Data Flow

### Message Check Flow
```
1. Router → POST /internal/check
2. SecurityService.check_message()
3. SpamDetector.check_spam()
   - Query Redis for rate
   - Check duplicate count
   - Return is_spam
4. ContentFilter.check_message()
   - Match blocked words
   - Match regex patterns
   - Return is_filtered
5. Determine action:
   - If spam → warn
   - If filtered → delete/warn/timeout
   - Else → allow
6. Return decision
```

### Warning Flow
```
1. Issue warning (automated or manual)
2. WarningManager.issue_warning()
3. Insert into security_warnings
4. Count active warnings for user
5. Check thresholds:
   - >= timeout_threshold → auto-timeout
   - >= ban_threshold → auto-ban
6. Apply reputation impact
7. Log moderation action
```

### Cross-Platform Sync
```
1. Moderation action occurs on Platform A
2. POST /internal/sync-action
3. SecurityService.sync_moderation_action()
4. Log action in moderation_actions table
5. For each sync_to_platform:
   - Call platform connector API
   - Apply same action on Platform B, C, etc.
6. Update reputation if enabled
```

## Database Schema

### security_config
```sql
community_id INTEGER PRIMARY KEY,
spam_detection_enabled BOOLEAN,
spam_message_threshold INTEGER,
spam_interval_seconds INTEGER,
content_filter_enabled BOOLEAN,
blocked_words JSONB,
blocked_patterns JSONB,
filter_action VARCHAR(20),
warning_enabled BOOLEAN,
warning_threshold_timeout INTEGER,
warning_threshold_ban INTEGER,
warning_decay_days INTEGER
```

### security_warnings
```sql
id SERIAL PRIMARY KEY,
community_id INTEGER,
hub_user_id INTEGER,
platform VARCHAR(50),
platform_user_id VARCHAR(255),
warning_type VARCHAR(50),
warning_reason TEXT,
issued_by INTEGER,
issued_at TIMESTAMP,
expires_at TIMESTAMP,
is_active BOOLEAN,
revoked_by INTEGER,
revoke_reason TEXT
```

### security_moderation_actions
```sql
id SERIAL PRIMARY KEY,
community_id INTEGER,
hub_user_id INTEGER,
platform VARCHAR(50),
platform_user_id VARCHAR(255),
action_type VARCHAR(20),
action_reason TEXT,
moderator_id INTEGER,
synced_to_platforms TEXT[],
reputation_impact DECIMAL,
created_at TIMESTAMP
```

## Redis Usage

### Rate Limiting
```redis
# Message rate
SET security:ratelimit:msg:123:456 1 EX 60
INCR security:ratelimit:msg:123:456

# Command rate
SET security:ratelimit:cmd:123:456 1 EX 60
INCR security:ratelimit:cmd:123:456
```

### Spam Tracking
```redis
# Recent messages
LPUSH security:spam:123:456:messages "message" EXPIRE 10
LLEN security:spam:123:456:messages

# Duplicate tracking
HINCRBY security:spam:123:456:duplicates "message_hash" 1
```

## Integration Points

### Reputation Module
- Apply reputation impact on warnings
- Trigger auto-ban at low reputation
- Query reputation for risk assessment

### Platform Connectors
- Sync moderation actions
- Apply bans/timeouts
- Fetch moderation logs

### Router Module
- Real-time message checking
- Event forwarding
- Service discovery

## Performance Optimizations

1. **Redis for ephemeral data**: Rate limits, spam tracking
2. **Database for persistent data**: Warnings, config, logs
3. **Async processing**: Non-blocking checks
4. **Caching**: Config caching with TTL
5. **Batch operations**: Bulk warning processing
