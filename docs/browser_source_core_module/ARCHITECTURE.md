# Browser Source Core Module - Architecture

## System Overview

Dual-protocol microservice providing browser source management for OBS with real-time caption streaming.

**Tech Stack**: Quart (async), PostgreSQL, WebSockets, gRPC, pyDAL

## Architecture Diagram

```
┌─────────────────────────────────────────────┐
│    Browser Source Core Module               │
│                                             │
│  ┌────────────┐      ┌──────────────────┐  │
│  │  REST API  │      │  WebSocket Server│  │
│  │ (Port 8027)│      │  /ws/captions/*  │  │
│  └──────┬─────┘      └────────┬─────────┘  │
│         │                     │             │
│         │    ┌────────────────┘             │
│         │    │                              │
│         ▼    ▼                              │
│  ┌──────────────────┐    ┌──────────────┐  │
│  │ Overlay Service  │    │ gRPC Server  │  │
│  │                  │    │ (Port 50050) │  │
│  │ - Key Validation │    └──────────────┘  │
│  │ - HTML Rendering│                       │
│  │ - Access Logging│                       │
│  └──────────────────┘                       │
│           │                                 │
│           ▼                                 │
│  ┌──────────────────┐                       │
│  │ Database (pyDAL) │                       │
│  └──────────────────┘                       │
└─────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐
│   PostgreSQL DB      │
│ - overlay_tokens     │
│ - caption_events     │
│ - access_log         │
└──────────────────────┘
```

## Core Components

### 1. OverlayService
- Validates overlay keys (current + grace period)
- Generates unified overlay HTML
- Logs access attempts
- Manages browser source tokens

### 2. WebSocket Manager
- Global connection registry: `caption_connections = {community_id: set(websockets)}`
- Broadcasts captions to all clients
- Sends recent history on connect
- Cleanup on disconnect

### 3. gRPC Handler
- Service-to-service communication
- Key validation RPC
- Caption broadcast RPC

### 4. REST Endpoints
- Status/health checks
- Internal caption receiver
- Overlay HTML serving

## Data Flow

### Overlay Access Flow
```
1. OBS requests /overlay/{key}
2. Validate key (current or previous within grace period)
3. Log access (IP, user agent, sources)
4. Generate HTML with iframe elements
5. Return HTML with ALLOWALL X-Frame-Options
```

### Caption Broadcast Flow
```
1. Router → POST /api/v1/internal/captions
2. Verify X-Service-Key header
3. Store caption in database
4. Lookup WebSocket connections for community
5. JSON.stringify caption payload
6. ws.send() to all connected clients
7. Remove dead connections
```

### WebSocket Connection Flow
```
1. Client → ws://...?key={overlay_key}
2. Validate overlay key
3. Verify community_id matches
4. Add to caption_connections[community_id]
5. Query last 10 captions (5 min window)
6. Send historical captions
7. Keep connection open for live updates
```

## Security Architecture

### Key Rotation
```
┌──────────────┐
│ Current Key  │ ← Active requests
└──────────────┘
       +
┌──────────────┐
│ Previous Key │ ← Grace period (5 min)
└──────────────┘
```

### Access Validation
```python
async def validate_overlay_key(key):
    # Check current key
    if exists(current_key == key):
        return valid

    # Check previous key with grace period
    if exists(previous_key == key AND rotated_at > now - 5min):
        return valid

    return invalid
```

## Scalability Considerations

- **Horizontal Scaling**: Stateless REST; WebSocket state in registry
- **WebSocket Limits**: ~1000 connections per instance
- **Database Pooling**: Connection pool for concurrent queries
- **Caption History**: Auto-cleanup after 5 minutes

## Integration Points

### Upstream
- Router module (caption forwarding)
- Translation service (caption source)

### Downstream
- OBS browser sources
- WebSocket clients (overlays)

## Performance Optimizations

1. **WebSocket Pooling**: Reuse connections
2. **Query Indexing**: Fast key lookups
3. **Caption Buffering**: Batch database inserts
4. **HTML Caching**: Pre-generate static parts
