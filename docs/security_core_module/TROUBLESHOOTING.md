# Security Core Module - Troubleshooting

## Common Issues

### Module Won't Start

**Problem**: Redis connection failed

**Solution**:
```bash
# Check Redis is running
redis-cli ping
# Should return PONG

# Start Redis if not running
sudo systemctl start redis

# Or use Docker
docker run -d -p 6379:6379 redis:7

# Verify connection
redis-cli -h localhost -p 6379 ping
```

**Problem**: Database connection failed

**Solution**:
```bash
# Check PostgreSQL
sudo systemctl status postgresql

# Test connection
psql -U waddlebot -d waddlebot -c "SELECT 1;"

# Check DATABASE_URL
echo $DATABASE_URL
```

## Spam Detection Issues

### Spam Not Being Detected

**Problem**: Messages not being flagged as spam

**Solutions**:
1. Check spam detection is enabled:
   ```bash
   curl http://localhost:8041/api/v1/security/123/config | jq .data.spam_detection_enabled
   ```

2. Verify Redis is working:
   ```bash
   redis-cli KEYS "security:ratelimit:*"
   redis-cli LLEN "security:spam:123:12345:messages"
   ```

3. Check thresholds:
   ```bash
   curl http://localhost:8041/api/v1/security/123/config | jq '{
     threshold: .data.spam_message_threshold,
     interval: .data.spam_interval_seconds
   }'
   ```

4. Lower thresholds:
   ```bash
   curl -X PUT http://localhost:8041/api/v1/security/123/config \
     -H "Content-Type: application/json" \
     -d '{"spam_message_threshold": 3, "spam_interval_seconds": 5}'
   ```

### False Positives

**Problem**: Legitimate users being flagged as spam

**Solutions**:
1. Increase thresholds
2. Whitelist trusted users (future feature)
3. Reduce spam interval
4. Review spam patterns

## Content Filter Issues

### Blocked Words Not Working

**Problem**: Messages with blocked words not being filtered

**Solutions**:
1. Verify content filter enabled:
   ```bash
   curl http://localhost:8041/api/v1/security/123/config | jq .data.content_filter_enabled
   ```

2. Check blocked words list:
   ```bash
   curl http://localhost:8041/api/v1/security/123/config | jq .data.blocked_words
   ```

3. Add blocked words:
   ```bash
   curl -X POST http://localhost:8041/api/v1/security/123/blocked-words \
     -H "Content-Type: application/json" \
     -d '{"words": ["spam", "scam"]}'
   ```

4. Check case sensitivity:
   ```python
   # Filtering is case-insensitive by default
   # "SPAM" will match "spam"
   ```

### Filter Too Aggressive

**Problem**: Too many false positives in content filtering

**Solutions**:
1. Review blocked words/patterns
2. Remove overly broad patterns
3. Change filter action from "ban" to "warn"
4. Implement word boundaries (future feature)

## Warning System Issues

### Warnings Not Issuing

**Problem**: Warnings not being created

**Solutions**:
```sql
-- Check security_warnings table exists
SELECT * FROM information_schema.tables
WHERE table_name = 'security_warnings';

-- Manually insert test warning
INSERT INTO security_warnings (
    community_id, platform, platform_user_id,
    warning_type, warning_reason, issued_by
) VALUES (123, 'twitch', '12345', 'test', 'Test warning', 1);

-- Verify
SELECT * FROM security_warnings WHERE community_id = 123;
```

### Auto-Timeout Not Triggering

**Problem**: Users not being timed out after threshold

**Solutions**:
1. Check auto-timeout enabled:
   ```bash
   curl http://localhost:8041/api/v1/security/123/config | jq .data.auto_timeout_enabled
   ```

2. Check warning count:
   ```sql
   SELECT COUNT(*) FROM security_warnings
   WHERE community_id = 123
   AND platform_user_id = '12345'
   AND is_active = true;
   ```

3. Check threshold:
   ```bash
   curl http://localhost:8041/api/v1/security/123/config | jq .data.warning_threshold_timeout
   ```

4. Enable auto-timeout:
   ```bash
   curl -X PUT http://localhost:8041/api/v1/security/123/config \
     -H "Content-Type: application/json" \
     -d '{"auto_timeout_enabled": true}'
   ```

## Redis Issues

### Redis Out of Memory

**Problem**: Redis running out of memory

**Solutions**:
```bash
# Check memory usage
redis-cli INFO memory

# Set max memory
redis-cli CONFIG SET maxmemory 256mb
redis-cli CONFIG SET maxmemory-policy allkeys-lru

# Or in redis.conf
maxmemory 256mb
maxmemory-policy allkeys-lru
```

### Redis Keys Not Expiring

**Problem**: Old rate limit keys not expiring

**Solutions**:
```bash
# Check TTL
redis-cli TTL "security:ratelimit:msg:123:12345"

# Manually expire old keys
redis-cli --scan --pattern "security:*" | xargs redis-cli DEL

# Enable key expiration monitoring
redis-cli CONFIG SET notify-keyspace-events Ex
```

## Performance Issues

### Slow Message Checks

**Solutions**:
```sql
-- Add indexes
CREATE INDEX idx_security_warnings_lookup
ON security_warnings(community_id, platform_user_id, is_active);

CREATE INDEX idx_security_filter_matches
ON security_filter_matches(community_id, created_at DESC);

-- Analyze tables
ANALYZE security_warnings;
ANALYZE security_moderation_actions;
```

### High Redis CPU

**Solutions**:
1. Reduce rate limit checks
2. Increase Redis maxmemory
3. Use Redis cluster
4. Optimize key patterns

## Debug Mode

```bash
# Enable debug logging
export LOG_LEVEL=DEBUG
python app.py

# Check logs
tail -f /var/log/waddlebot/security_core_module.log

# Enable Redis slow log
redis-cli CONFIG SET slowlog-log-slower-than 10000
redis-cli SLOWLOG GET 10
```

## Data Cleanup

```sql
-- Clean expired warnings
DELETE FROM security_warnings
WHERE expires_at < NOW();

-- Clean old filter matches (keep 30 days)
DELETE FROM security_filter_matches
WHERE created_at < NOW() - INTERVAL '30 days';

-- Clean old moderation actions (keep 90 days)
DELETE FROM security_moderation_actions
WHERE created_at < NOW() - INTERVAL '90 days';
```

## Health Checks

```bash
# Module health
curl http://localhost:8041/health

# Redis health
redis-cli ping

# Database health
psql -U waddlebot -d waddlebot -c "SELECT 1;"

# Check rate limiting working
redis-cli GET "security:ratelimit:msg:123:12345"
```
