# Browser Source Core Module - Troubleshooting

## Overlay Issues

### Overlay Not Loading in OBS

**Problem**: OBS shows blank/black screen

**Solutions**:
1. Verify URL in browser first
2. Check overlay key is 64 characters
3. Enable "Refresh browser when scene becomes active"
4. Check firewall allows localhost:8027

### Invalid Overlay Key Error

**Problem**: 404 error with "Invalid overlay key"

**Solutions**:
```sql
-- Verify key exists
SELECT * FROM community_overlay_tokens WHERE overlay_key = 'YOUR_KEY';

-- Check if active
SELECT is_active FROM community_overlay_tokens WHERE overlay_key = 'YOUR_KEY';

-- Generate new key if needed
UPDATE community_overlay_tokens
SET overlay_key = encode(gen_random_bytes(32), 'hex')
WHERE community_id = 123;
```

## WebSocket Issues

### Captions Not Appearing

**Problem**: WebSocket connects but no captions show

**Solutions**:
1. Check WebSocket connection:
   ```javascript
   // Browser console
   const ws = new WebSocket('ws://localhost:8027/ws/captions/123?key=YOUR_KEY');
   ws.onopen = () => console.log('Connected');
   ws.onerror = (e) => console.error(e);
   ```

2. Send test caption:
   ```bash
   curl -X POST http://localhost:8027/api/v1/internal/captions \
     -H "X-Service-Key: test-key" \
     -H "Content-Type: application/json" \
     -d '{"community_id": 123, "username": "test", "original_message": "test", "translated_message": "test", "detected_language": "en", "target_language": "es", "confidence": 0.9}'
   ```

3. Check caption_connections registry:
   ```python
   from app import caption_connections
   print(caption_connections)
   ```

### Connection Keeps Dropping

**Problem**: WebSocket disconnects frequently

**Solutions**:
1. Enable ping/pong keepalive in client
2. Check network stability
3. Increase timeout in OBS browser source
4. Check server logs for errors

## Performance Issues

### High Memory Usage

**Problem**: Module consuming excessive memory

**Solutions**:
```python
# Check connection count
from app import caption_connections
total = sum(len(conns) for conns in caption_connections.values())
print(f"Total connections: {total}")

# Clean up dead connections
for community_id, conns in caption_connections.items():
    caption_connections[community_id] = {
        c for c in conns if not c.closed
    }
```

### Caption Lag

**Problem**: Captions appear with delay

**Solutions**:
1. Check database query performance:
   ```sql
   EXPLAIN ANALYZE
   SELECT * FROM caption_events
   WHERE community_id = 123
   ORDER BY created_at DESC
   LIMIT 10;
   ```

2. Add index:
   ```sql
   CREATE INDEX idx_caption_events_lookup
   ON caption_events(community_id, created_at DESC);
   ```

3. Clean old captions:
   ```sql
   DELETE FROM caption_events
   WHERE created_at < NOW() - INTERVAL '1 hour';
   ```

## Database Issues

### Table Missing Errors

**Problem**: "relation does not exist"

**Solutions**:
```sql
-- Create missing tables manually
CREATE TABLE IF NOT EXISTS community_overlay_tokens (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL,
    overlay_key VARCHAR(64) UNIQUE,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS caption_events (
    id SERIAL PRIMARY KEY,
    community_id INTEGER,
    username VARCHAR(255),
    original_message TEXT,
    translated_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
```

## Debug Mode

```bash
# Enable debug logging
export LOG_LEVEL=DEBUG
python app.py

# View logs
tail -f /var/log/waddlebot/browser_source_core_module.log
```
