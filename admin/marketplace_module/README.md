# WaddleBot Marketplace Module

The Marketplace Module handles module distribution and community subscriptions for WaddleBot. It provides a centralized platform for browsing, installing, and managing modules across communities.

## Features

- **Module Management**: CRUD operations for marketplace modules (super admin only)
- **Module Browsing**: Public browsing with search, filtering, and ratings
- **Community Subscriptions**: Install/uninstall modules per community
- **Configuration Management**: Per-community module configuration
- **Analytics**: Track installations, reviews, and usage statistics

## Architecture

```
marketplace_module/
├── backend/
│   ├── src/
│   │   ├── config/         # Configuration and database
│   │   ├── controllers/    # Route handlers
│   │   ├── middleware/     # Auth, validation, error handling
│   │   ├── routes/         # Route definitions
│   │   ├── services/       # Business logic
│   │   └── utils/          # Logging utilities
│   └── package.json
├── Dockerfile
└── README.md
```

## Database Schema

The module uses existing tables from the hub_module:

### hub_modules
- Module metadata (name, description, version, author)
- Publication status and categorization
- Configuration schema

### hub_module_installations
- Community module subscriptions
- Per-community configuration
- Enable/disable status

### hub_module_reviews
- User ratings and reviews
- Community-specific feedback

## API Endpoints

### Public Endpoints

```
GET /api/v1/modules                    # Browse modules
GET /api/v1/modules/:id                # Get module details
```

### Community Admin Endpoints

```
GET    /api/v1/communities/:communityId/subscriptions                # List subscriptions
POST   /api/v1/communities/:communityId/subscriptions                # Subscribe to module
PUT    /api/v1/communities/:communityId/subscriptions/:id           # Update config
DELETE /api/v1/communities/:communityId/subscriptions/:id           # Unsubscribe
```

### Super Admin Endpoints

```
POST   /api/v1/modules                 # Create module
PUT    /api/v1/modules/:id             # Update module
DELETE /api/v1/modules/:id             # Delete module
GET    /api/v1/modules/:id/subscriptions # View installation stats
```

## Environment Variables

```bash
# Server
NODE_ENV=production
PORT=8070
HOST=0.0.0.0

# Database
DATABASE_URL=postgresql://waddlebot:password@localhost:5432/waddlebot
DATABASE_POOL_SIZE=10

# Security
JWT_SECRET=your-jwt-secret
SERVICE_API_KEY=your-service-key

# Integration
HUB_API_URL=http://hub-module:8060
ROUTER_API_URL=http://router:8000

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Logging
LOG_LEVEL=info
LOG_DIR=/var/log/waddlebotlog

# CORS
CORS_ORIGIN=http://localhost:5173
```

## Development

```bash
# Install dependencies
cd backend
npm install

# Run in development mode (with auto-reload)
npm run dev

# Run in production mode
npm start

# Lint code
npm run lint
```

## Docker

```bash
# Build image
docker build -t waddlebot-marketplace:latest -f admin/marketplace_module/Dockerfile .

# Run container
docker run -p 8070:8070 \
  -e DATABASE_URL=postgresql://... \
  -e JWT_SECRET=... \
  waddlebot-marketplace:latest
```

## Authentication

The module uses JWT-based authentication shared with the hub_module:

1. **No Auth**: Public module browsing
2. **User Auth**: Required for all write operations
3. **Community Admin**: Required for subscription management
4. **Super Admin**: Required for module CRUD operations

## Security Features

- **Helmet.js**: Security headers and CSP
- **Rate Limiting**: Protect against abuse
- **XSS Protection**: Input sanitization
- **SQL Injection**: Parameterized queries
- **Role-based Access**: Granular permissions

## Logging

Structured JSON logging with categories:
- **HTTP**: Request/response logging
- **AUTH**: Authentication events
- **AUTHZ**: Authorization decisions
- **AUDIT**: Important actions (install, uninstall, etc.)
- **SYSTEM**: System events (startup, shutdown)

## Integration

### Hub Module
- Shares authentication/session tables
- Uses community and user data

### Router Module
- Notifies on module installation changes
- Coordinates module configuration updates

## Module Lifecycle

1. **Creation**: Super admin creates module with metadata
2. **Publication**: Module marked as published
3. **Discovery**: Communities browse marketplace
4. **Installation**: Community admin subscribes
5. **Configuration**: Per-community settings
6. **Updates**: Version changes managed by super admin
7. **Uninstallation**: Community admin unsubscribes

## Best Practices

1. **Core Modules**: Cannot be uninstalled (is_core flag)
2. **Featured Modules**: Highlighted in marketplace
3. **Versioning**: Semantic versioning for modules
4. **Config Schema**: JSON schema for validation
5. **Auditing**: All changes logged for compliance

## Health Checks

```bash
# Basic health check
curl http://localhost:8070/health

# Detailed metrics
curl http://localhost:8070/metrics
```

## Error Handling

Standard error response format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  }
}
```

## Performance

- Connection pooling (configurable)
- Query optimization with indexes
- Slow query logging (>1s)
- Metrics tracking

## Contributing

Follow WaddleBot coding standards:
- ESLint configuration
- Structured logging
- Error handling patterns
- Transaction management
- Security best practices

## License

Part of the WaddleBot project.
