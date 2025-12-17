# Community Module - Configuration

## Environment Variables

```bash
MODULE_PORT=8020
DATABASE_URL=postgresql://waddlebot:password@localhost:5432/waddlebot
CORE_API_URL=http://router-service:8000
ROUTER_API_URL=http://router-service:8000/api/v1/router
LOG_LEVEL=INFO
SECRET_KEY=change-me-in-production
```

## Configuration Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| MODULE_PORT | 8020 | HTTP port |
| DATABASE_URL | postgresql://... | PostgreSQL connection |
| LOG_LEVEL | INFO | Logging level |

## Community Settings

### Premium Features
- Custom reputation weights
- Advanced moderation tools
- Enhanced analytics
- Priority support

### Member Roles
- `owner`: Full control
- `admin`: Administrative privileges
- `moderator`: Moderation capabilities
- `member`: Standard member

### Supported Platforms
- Twitch
- YouTube
- Discord
- Kick

## Database Tables

Core tables managed by community module:
- `communities`: Community definitions
- `community_members`: Member relationships
- `community_platforms`: Platform connections
- `community_settings`: Configuration storage
