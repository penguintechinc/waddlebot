# Community Module - Usage Guide

## Quick Start

```bash
cd core/community_module
python app.py
```

Module starts on port 8020.

## Basic Operations

### Check Module Status

```bash
curl http://localhost:8020/api/v1/status
```

## Database Queries

### List Communities

```sql
SELECT id, name, owner_id, is_premium, created_at
FROM communities
WHERE is_active = true
ORDER BY created_at DESC;
```

### List Community Members

```sql
SELECT cm.id, hu.username, cm.role, cm.reputation, cm.joined_at
FROM community_members cm
JOIN hub_users hu ON hu.id = cm.hub_user_id
WHERE cm.community_id = 123
AND cm.is_active = true
ORDER BY cm.reputation DESC;
```

### Check Member Role

```sql
SELECT role FROM community_members
WHERE community_id = 123 AND hub_user_id = 456;
```

### List Connected Platforms

```sql
SELECT platform, platform_community_id, created_at
FROM community_platforms
WHERE community_id = 123
AND is_active = true;
```

## Admin Operations

### Create Community (via SQL)

```sql
INSERT INTO communities (name, owner_id, description, is_premium)
VALUES ('My Community', 789, 'An awesome community', false)
RETURNING id;
```

### Add Member

```sql
INSERT INTO community_members (community_id, hub_user_id, role)
VALUES (123, 456, 'member');
```

### Update Member Role

```sql
UPDATE community_members
SET role = 'moderator', updated_at = NOW()
WHERE community_id = 123 AND hub_user_id = 456;
```

### Connect Platform

```sql
INSERT INTO community_platforms (community_id, platform, platform_community_id)
VALUES (123, 'twitch', 'channel_name');
```

## Monitoring

### Community Statistics

```sql
SELECT
    c.id,
    c.name,
    COUNT(DISTINCT cm.hub_user_id) as total_members,
    COUNT(DISTINCT cp.platform) as connected_platforms,
    c.is_premium
FROM communities c
LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.is_active = true
LEFT JOIN community_platforms cp ON cp.community_id = c.id AND cp.is_active = true
WHERE c.is_active = true
GROUP BY c.id, c.name, c.is_premium
ORDER BY total_members DESC;
```

### Active Members by Role

```sql
SELECT
    role,
    COUNT(*) as count
FROM community_members
WHERE community_id = 123
AND is_active = true
GROUP BY role;
```

## Future API Usage (When Implemented)

### Create Community

```bash
curl -X POST http://localhost:8020/api/v1/communities \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Community",
    "description": "An awesome community",
    "owner_id": 789
  }'
```

### Get Community

```bash
curl http://localhost:8020/api/v1/communities/123
```

### List Members

```bash
curl http://localhost:8020/api/v1/communities/123/members?limit=50
```
