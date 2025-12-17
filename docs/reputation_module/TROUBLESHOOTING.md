# Reputation Module - Troubleshooting

## Common Issues

### Events Not Processing

**Problem**: Events sent but reputation not changing

**Solutions**:
1. Check X-Service-Key header:
   ```bash
   curl -X POST http://localhost:8021/api/v1/internal/events \
     -H "X-Service-Key: correct-key" \
     -d '{"community_id": 123, "event_type": "subscription", "user_id": 456}'
   ```

2. Verify event type is valid:
   ```python
   # Valid event types
   event_types = ['chatMessage', 'follow', 'subscription', 'warn', etc.]
   ```

3. Check weight configuration:
   ```bash
   curl http://localhost:8021/api/v1/reputation/weights/123
   ```

### Weight Customization Not Working

**Problem**: Custom weights not applying

**Solutions**:
1. Verify premium status:
   ```sql
   SELECT is_premium FROM communities WHERE id = 123;
   ```

2. Clear weight cache:
   ```sql
   -- Restart module to clear cache
   pkill -f reputation_module
   python app.py
   ```

### Score Not Updating

**Problem**: Reputation score frozen

**Solutions**:
```sql
-- Check for database locks
SELECT * FROM pg_locks WHERE NOT granted;

-- Verify events are being created
SELECT COUNT(*) FROM reputation_events
WHERE community_id = 123 AND created_at > NOW() - INTERVAL '1 hour';

-- Check if updates are happening
SELECT reputation, updated_at FROM community_members
WHERE community_id = 123 AND hub_user_id = 456;
```

### Auto-Ban Not Triggering

**Problem**: Low reputation users not being banned

**Solutions**:
1. Check auto-ban configuration:
   ```bash
   curl http://localhost:8021/api/v1/admin/123/reputation/config
   ```

2. Verify threshold:
   ```sql
   SELECT auto_ban_enabled, auto_ban_threshold
   FROM reputation_weights
   WHERE community_id = 123;
   ```

3. Check policy enforcer logs:
   ```bash
   grep "auto_ban" /var/log/waddlebot/reputation_module.log
   ```

## Performance Issues

### Slow Event Processing

**Solutions**:
```sql
-- Add indexes
CREATE INDEX idx_reputation_events_lookup
ON reputation_events(community_id, hub_user_id, created_at DESC);

CREATE INDEX idx_community_members_reputation
ON community_members(community_id, reputation);

-- Clean old events
DELETE FROM reputation_events
WHERE created_at < NOW() - INTERVAL '90 days';
```

### High Memory Usage

**Solutions**:
```python
# Reduce batch size
MAX_BATCH_SIZE = 500  # instead of 1000

# Clear weight cache more frequently
WEIGHT_CACHE_TTL = 60  # instead of 300
```

## Debug Mode

```bash
export LOG_LEVEL=DEBUG
python app.py

# Check logs
tail -f /var/log/waddlebot/reputation_module.log
```
