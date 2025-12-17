# Community Module - Troubleshooting

## Common Issues

### Module Won't Start

**Problem**: Port already in use

**Solution**:
```bash
# Find process using port 8020
lsof -i :8020

# Kill process
kill -9 <PID>

# Or change port
export MODULE_PORT=8021
python app.py
```

### Database Connection Issues

**Problem**: Cannot connect to database

**Solutions**:
```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Test connection
psql postgresql://waddlebot:password@localhost:5432/waddlebot

# Check DATABASE_URL
echo $DATABASE_URL

# Verify credentials
psql -U waddlebot -d waddlebot -c "SELECT 1;"
```

## Database Issues

### Missing Tables

**Problem**: "relation does not exist"

**Solution**:
```sql
-- Create communities table
CREATE TABLE IF NOT EXISTS communities (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    owner_id INTEGER,
    description TEXT,
    is_premium BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create community_members table
CREATE TABLE IF NOT EXISTS community_members (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id),
    hub_user_id INTEGER,
    role VARCHAR(50) DEFAULT 'member',
    reputation INTEGER DEFAULT 600,
    is_active BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create community_platforms table
CREATE TABLE IF NOT EXISTS community_platforms (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id),
    platform VARCHAR(50) NOT NULL,
    platform_community_id VARCHAR(255),
    credentials JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Orphaned Members

**Problem**: Members without valid community

**Solution**:
```sql
-- Find orphaned members
SELECT cm.*
FROM community_members cm
LEFT JOIN communities c ON c.id = cm.community_id
WHERE c.id IS NULL;

-- Clean up
DELETE FROM community_members
WHERE community_id NOT IN (SELECT id FROM communities);
```

## Performance Issues

### Slow Member Queries

**Solution**:
```sql
-- Add indexes
CREATE INDEX IF NOT EXISTS idx_community_members_community
ON community_members(community_id);

CREATE INDEX IF NOT EXISTS idx_community_members_user
ON community_members(hub_user_id);

CREATE INDEX IF NOT EXISTS idx_community_members_lookup
ON community_members(community_id, hub_user_id);

-- Analyze tables
ANALYZE community_members;
```

## Debug Mode

```bash
# Enable debug logging
export LOG_LEVEL=DEBUG
python app.py

# View logs
tail -f /var/log/waddlebot/community_module.log
```

## Data Integrity Checks

```sql
-- Check for duplicate memberships
SELECT community_id, hub_user_id, COUNT(*)
FROM community_members
WHERE is_active = true
GROUP BY community_id, hub_user_id
HAVING COUNT(*) > 1;

-- Check for communities without owners
SELECT * FROM communities
WHERE owner_id IS NULL;

-- Check for inactive communities with active members
SELECT c.id, c.name, COUNT(cm.id) as active_members
FROM communities c
JOIN community_members cm ON cm.community_id = c.id
WHERE c.is_active = false AND cm.is_active = true
GROUP BY c.id, c.name;
```
