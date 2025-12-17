# Community Module - Architecture

## System Overview

Central community management system coordinating multi-platform communities, member relationships, and cross-platform user identity resolution.

## Architecture Diagram

```
┌────────────────────────────────────────┐
│       Community Module                 │
│                                        │
│  ┌──────────────────────────────────┐ │
│  │       REST API                   │ │
│  │     (Port 8020)                  │ │
│  └────────────┬─────────────────────┘ │
│               │                        │
│               ▼                        │
│  ┌──────────────────────────────────┐ │
│  │   Community Service              │ │
│  │  - Community CRUD                │ │
│  │  - Member management             │ │
│  │  - Platform integration          │ │
│  └────────────┬─────────────────────┘ │
│               │                        │
│               ▼                        │
│  ┌──────────────────────────────────┐ │
│  │   Database Layer (pyDAL)         │ │
│  │  - communities                   │ │
│  │  - community_members             │ │
│  │  - community_platforms           │ │
│  └──────────────────────────────────┘ │
└────────────────────────────────────────┘
```

## Core Concepts

### Multi-Tenant Communities
Each community can have:
- Multiple platforms (Twitch, YouTube, Discord, etc.)
- Multiple members with different roles
- Custom settings and configurations
- Premium/free tier features

### Cross-Platform Identity
- Hub users (hub_users table) = unified identity
- Platform-specific identities (user_identities table)
- Community membership (community_members table)
- Role-based access control

### Integration Points

**Upstream**:
- Hub Module: User authentication and identity
- Router Module: Request routing

**Downstream**:
- Reputation Module: Per-community reputation
- Security Module: Moderation coordination
- All feature modules: Community-scoped functionality

## Data Flow

### Community Creation
```
1. Owner creates community via Hub UI
2. Hub calls Community Module API
3. Create community record
4. Create owner membership
5. Initialize default settings
6. Return community ID
```

### Member Join
```
1. User joins via platform
2. Platform connector identifies user
3. Resolve/create hub_user_id
4. Create community_members record
5. Initialize default reputation (600)
6. Trigger welcome events
```

## Scalability

- Stateless API design
- Database connection pooling
- Indexed queries for member lookups
- Caching layer for community settings
