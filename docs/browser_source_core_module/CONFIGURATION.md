# Browser Source Core Module - Configuration

## Environment Variables

```bash
# Module Identity
MODULE_PORT=8027              # REST API port
GRPC_PORT=50050              # gRPC server port

# Database
DATABASE_URL=postgresql://waddlebot:password@localhost:5432/waddlebot

# Service URLs
CORE_API_URL=http://router-service:8000
ROUTER_API_URL=http://router-service:8000/api/v1/router

# Security
SECRET_KEY=change-me-in-production
MODULE_SECRET_KEY=change-me-in-production
JWT_ALGORITHM=HS256
SERVICE_API_KEY=internal-service-key

# Logging
LOG_LEVEL=INFO
```

## Configuration Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| MODULE_PORT | 8027 | HTTP REST API port |
| GRPC_PORT | 50050 | gRPC server port |
| DATABASE_URL | postgresql://... | PostgreSQL connection |
| LOG_LEVEL | INFO | Logging verbosity |

## Overlay Configuration

### Overlay Key Format
- Length: 64 characters
- Format: Hexadecimal (0-9, a-f)
- Example: `a1b2c3d4e5f6...` (64 chars)

### Key Rotation Grace Period
- Default: 5 minutes
- Previous key remains valid after rotation
- Configurable via `KEY_GRACE_PERIOD_MINUTES` in code

### Theme Configuration (JSON)
```json
{
  "background": "transparent",
  "font_family": "Arial, sans-serif",
  "font_size": "16px",
  "text_color": "#ffffff",
  "shadow_enabled": true
}
```

### Enabled Sources
Array of source types: `['ticker', 'media', 'general', 'captions']`

## WebSocket Configuration

- Max connections per community: 100 (recommended)
- Ping interval: 30 seconds
- Reconnect delay: 5 seconds
- Message buffer: Last 10 captions (5 minute window)

## Database Tables

Required tables auto-created on startup:
- `community_overlay_tokens`
- `caption_events`
- `overlay_access_log`

## Performance Tuning

```bash
# Increase worker count for production
QUART_WORKERS=4

# Database connection pooling
DATABASE_POOL_SIZE=20
DATABASE_MAX_OVERFLOW=10
```

## Security Settings

```bash
# Enable service-to-service auth
SERVICE_API_KEY=your-secure-random-key-here

# Enable HTTPS (production)
SSL_CERT_PATH=/path/to/cert.pem
SSL_KEY_PATH=/path/to/key.pem
```
