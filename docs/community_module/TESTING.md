# Community Module - Testing Guide

## Unit Tests

```python
import pytest
from app import app

@pytest.mark.asyncio
async def test_module_status(client):
    """Test status endpoint."""
    response = await client.get('/api/v1/status')
    assert response.status_code == 200
    data = await response.get_json()
    assert data['success'] is True
    assert data['data']['module'] == 'community_module'
```

## Database Tests

### Test Community Creation

```sql
-- Create test community
INSERT INTO communities (name, owner_id)
VALUES ('Test Community', 1)
RETURNING id;

-- Verify creation
SELECT * FROM communities WHERE name = 'Test Community';

-- Cleanup
DELETE FROM communities WHERE name = 'Test Community';
```

### Test Member Management

```sql
-- Add test member
INSERT INTO community_members (community_id, hub_user_id, role)
VALUES (1, 2, 'member');

-- Verify membership
SELECT * FROM community_members
WHERE community_id = 1 AND hub_user_id = 2;

-- Update role
UPDATE community_members SET role = 'moderator'
WHERE community_id = 1 AND hub_user_id = 2;

-- Verify update
SELECT role FROM community_members
WHERE community_id = 1 AND hub_user_id = 2;

-- Cleanup
DELETE FROM community_members
WHERE community_id = 1 AND hub_user_id = 2;
```

## Integration Tests

### Test with Reputation Module

```python
@pytest.mark.asyncio
async def test_member_reputation_integration():
    """Test community member has default reputation."""
    # Create member
    dal.community_members.insert(
        community_id=123,
        hub_user_id=456,
        role='member'
    )
    dal.commit()

    # Check default reputation
    member = dal(
        (dal.community_members.community_id == 123) &
        (dal.community_members.hub_user_id == 456)
    ).select().first()

    assert member.reputation == 600  # Default FICO score
```

## Manual Testing

### Test Module Startup

```bash
# Start module
cd core/community_module
python app.py

# Verify health
curl http://localhost:8020/health

# Check status
curl http://localhost:8020/api/v1/status
```

### Test Database Connection

```bash
# Connect to database
psql -d waddlebot

# Check tables exist
\dt

# Query communities
SELECT * FROM communities LIMIT 5;
```

## Performance Testing

### Query Performance

```sql
-- Test member lookup performance
EXPLAIN ANALYZE
SELECT * FROM community_members
WHERE community_id = 123 AND hub_user_id = 456;

-- Should use index. If not, create:
CREATE INDEX idx_community_members_lookup
ON community_members(community_id, hub_user_id);
```
