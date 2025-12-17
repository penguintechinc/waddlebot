# Community Module - API Documentation

## Overview

Community management module for multi-platform community coordination, member tracking, and cross-platform user identity management.

**Base URL**: `http://localhost:8020/api/v1`
**Version**: 2.0.0

---

## Endpoints

### Get Status
```http
GET /status
```

**Response**:
```json
{
  "success": true,
  "data": {
    "status": "operational",
    "module": "community_module"
  }
}
```

---

## Database Schema

The community module uses the following core tables:

### communities
```sql
CREATE TABLE communities (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    owner_id INTEGER REFERENCES hub_users(id),
    description TEXT,
    avatar_url VARCHAR(512),
    is_premium BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### community_members
```sql
CREATE TABLE community_members (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id),
    hub_user_id INTEGER REFERENCES hub_users(id),
    role VARCHAR(50) DEFAULT 'member',
    reputation INTEGER DEFAULT 600,
    is_active BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### community_platforms
```sql
CREATE TABLE community_platforms (
    id SERIAL PRIMARY KEY,
    community_id INTEGER REFERENCES communities(id),
    platform VARCHAR(50) NOT NULL,
    platform_community_id VARCHAR(255),
    credentials JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Future Endpoints (Roadmap)

### Community Management
- `POST /communities` - Create community
- `GET /communities/{id}` - Get community details
- `PUT /communities/{id}` - Update community
- `DELETE /communities/{id}` - Deactivate community

### Member Management
- `GET /communities/{id}/members` - List members
- `POST /communities/{id}/members` - Add member
- `DELETE /communities/{id}/members/{user_id}` - Remove member
- `PUT /communities/{id}/members/{user_id}/role` - Update role

### Platform Integration
- `POST /communities/{id}/platforms` - Connect platform
- `GET /communities/{id}/platforms` - List connected platforms
- `DELETE /communities/{id}/platforms/{platform}` - Disconnect platform

---

## Integration with Other Modules

### Hub Module
- Community ownership linked to hub_users
- Member management via hub_user_id

### Reputation Module
- Reputation scores stored in community_members
- Per-community reputation tracking

### Security Module
- Cross-platform moderation coordination
- Member ban/timeout synchronization
