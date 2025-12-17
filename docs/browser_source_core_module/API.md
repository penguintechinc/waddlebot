# Browser Source Core Module - API Documentation

## Overview

Unified browser source management for OBS with overlay support, caption streaming via WebSocket, and secure token-based access.

**Base URL**: `http://localhost:8027`

**Version**: 2.0.0

**Protocols**: REST API (HTTP), WebSocket, gRPC

---

## REST API Endpoints

### Status

#### Get Module Status
```http
GET /api/v1/status
```

**Response**:
```json
{
  "success": true,
  "data": {
    "status": "operational",
    "module": "browser_source_core_module"
  }
}
```

### Internal Endpoints

#### Receive Caption (Service-to-Service)
```http
POST /api/v1/internal/captions
Headers: X-Service-Key: <service_api_key>
```

**Request Body**:
```json
{
  "community_id": 123,
  "platform": "twitch",
  "username": "viewer123",
  "original_message": "Hello world",
  "translated_message": "Hola mundo",
  "detected_language": "en",
  "target_language": "es",
  "confidence": 0.95
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "received": true
  }
}
```

**Behavior**:
- Broadcasts caption to all connected WebSocket clients for the community
- Stores caption in database for recent history (last 5 minutes)
- Requires valid `X-Service-Key` header

---

## Overlay Endpoints

### Serve Unified Overlay
```http
GET /overlay/<overlay_key>
```

Serves the unified overlay HTML for OBS browser source.

**Parameters**:
- `overlay_key` (path): 64-character hex overlay key

**Response**: HTML page with embedded iframes for all enabled sources

**Headers**:
```
Content-Type: text/html
X-Frame-Options: ALLOWALL
Cache-Control: no-cache
```

**Example**:
```
http://localhost:8027/overlay/a1b2c3d4e5f6...
```

### Serve Caption Overlay
```http
GET /overlay/captions/<overlay_key>
```

Serves the caption-specific overlay HTML.

**Parameters**:
- `overlay_key` (path): 64-character hex overlay key

**Response**: HTML page for live caption display

---

## WebSocket API

### Caption WebSocket
```
ws://localhost:8027/ws/captions/<community_id>?key=<overlay_key>
```

Real-time caption streaming for OBS overlays.

**Connection**:
```javascript
const ws = new WebSocket('ws://localhost:8027/ws/captions/123?key=abc123...');

ws.onopen = () => {
  console.log('Connected');
};

ws.onmessage = (event) => {
  const caption = JSON.parse(event.data);
  displayCaption(caption);
};
```

**Message Format**:
```json
{
  "type": "caption",
  "username": "viewer123",
  "original": "Hello world",
  "translated": "Hola mundo",
  "detected_lang": "en",
  "target_lang": "es",
  "confidence": 0.95,
  "timestamp": "2025-01-15T12:00:00"
}
```

**Connection Behavior**:
- Validates overlay key on connection
- Sends last 10 captions from past 5 minutes on connect
- Supports ping/pong for keepalive
- Auto-cleanup on disconnect

**Ping/Pong**:
```javascript
// Send ping
ws.send('ping');

// Receive pong
ws.onmessage = (event) => {
  if (event.data === 'pong') {
    console.log('Connection alive');
  }
};
```

---

## gRPC API

### Port
Default gRPC port: `50050`

### Service Definition

```protobuf
service BrowserSourceService {
  rpc ValidateOverlayKey(ValidateRequest) returns (ValidateResponse);
  rpc GetOverlayConfig(ConfigRequest) returns (ConfigResponse);
  rpc BroadcastCaption(CaptionRequest) returns (CaptionResponse);
}
```

### ValidateOverlayKey
Validates an overlay key and returns configuration.

**Request**:
```protobuf
message ValidateRequest {
  string overlay_key = 1;
}
```

**Response**:
```protobuf
message ValidateResponse {
  bool valid = 1;
  int32 community_id = 2;
  map<string, string> theme_config = 3;
  repeated string enabled_sources = 4;
}
```

### BroadcastCaption
Broadcasts a caption to WebSocket clients.

**Request**:
```protobuf
message CaptionRequest {
  int32 community_id = 1;
  string username = 2;
  string original_message = 3;
  string translated_message = 4;
  string detected_language = 5;
  string target_language = 6;
  float confidence = 7;
}
```

**Response**:
```protobuf
message CaptionResponse {
  bool success = 1;
  int32 clients_notified = 2;
}
```

---

## Authentication

### Overlay Key Authentication
- 64-character hexadecimal keys
- Stored in `community_overlay_tokens` table
- Supports key rotation with 5-minute grace period
- Validated on every overlay/WebSocket access

### Service-to-Service Authentication
- `X-Service-Key` header required for internal endpoints
- Configured via `SERVICE_API_KEY` environment variable
- Uses constant-time comparison to prevent timing attacks

---

## Database Schema

### community_overlay_tokens
```sql
CREATE TABLE community_overlay_tokens (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL,
    overlay_key VARCHAR(64) NOT NULL UNIQUE,
    previous_key VARCHAR(64),
    rotated_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    theme_config JSONB,
    enabled_sources TEXT[],
    access_count INTEGER DEFAULT 0,
    last_accessed TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### caption_events
```sql
CREATE TABLE caption_events (
    id SERIAL PRIMARY KEY,
    community_id INTEGER NOT NULL,
    platform VARCHAR(50),
    username VARCHAR(255),
    original_message TEXT,
    translated_message TEXT,
    detected_language VARCHAR(10),
    target_language VARCHAR(10),
    confidence_score DECIMAL(3,2),
    created_at TIMESTAMP DEFAULT NOW()
);
```

### overlay_access_log
```sql
CREATE TABLE overlay_access_log (
    id SERIAL PRIMARY KEY,
    community_id INTEGER,
    overlay_key VARCHAR(64),
    ip_address VARCHAR(45),
    user_agent TEXT,
    source_types_requested TEXT[],
    was_valid BOOLEAN,
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Error Responses

### Invalid Overlay Key
```html
<html><body><h1>Invalid overlay key</h1></body></html>
```
Status: 404

### Unauthorized (Missing Service Key)
```json
{
  "error": "Unauthorized"
}
```
Status: 401

### WebSocket Closure Codes
- `1008`: Invalid overlay key or unauthorized

---

## Rate Limiting

No explicit rate limiting implemented. Consider adding:
- Per-IP rate limiting for overlay access
- Per-community rate limiting for captions
- WebSocket connection limits per community

---

## Example Usage

### OBS Browser Source Setup

1. **Get Overlay URL**:
   ```
   http://localhost:8027/overlay/abc123def456...
   ```

2. **Add to OBS**:
   - Source → Browser
   - URL: `http://localhost:8027/overlay/{your_key}`
   - Width: 1920
   - Height: 1080
   - FPS: 30
   - Custom CSS: (optional)

3. **Caption Overlay Setup**:
   - Source → Browser
   - URL: `http://localhost:8027/overlay/captions/{your_key}`
   - Width: 1920
   - Height: 200
   - Position: Bottom of screen

### JavaScript Client Example

```javascript
class CaptionClient {
  constructor(communityId, overlayKey) {
    this.ws = new WebSocket(
      `ws://localhost:8027/ws/captions/${communityId}?key=${overlayKey}`
    );

    this.ws.onmessage = (event) => {
      const caption = JSON.parse(event.data);
      this.displayCaption(caption);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onclose = () => {
      console.log('Disconnected, reconnecting in 5s...');
      setTimeout(() => this.reconnect(), 5000);
    };
  }

  displayCaption(caption) {
    const div = document.getElementById('caption-display');
    div.innerHTML = `
      <div class="caption">
        <span class="username">${caption.username}:</span>
        <span class="translated">${caption.translated}</span>
      </div>
    `;

    setTimeout(() => div.innerHTML = '', 5000);
  }

  reconnect() {
    this.ws.close();
    new CaptionClient(this.communityId, this.overlayKey);
  }
}

// Usage
const client = new CaptionClient(123, 'abc123...');
```

---

## Performance Considerations

- WebSocket connections: ~1000 concurrent connections per module instance
- Caption history: Last 5 minutes per community
- Database cleanup: Implement cron job for old caption_events
- Access logging: Consider rotation/archival strategy
