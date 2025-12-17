# Labels Core Module - Configuration

## Environment Variables

### Required

```bash
# Database connection (PostgreSQL)
DATABASE_URL=postgresql://waddlebot:password@localhost:5432/waddlebot
```

### Optional

```bash
# Module identity
MODULE_PORT=8023

# Service URLs
CORE_API_URL=http://router-service:8000
ROUTER_API_URL=http://router-service:8000/api/v1/router

# Logging
LOG_LEVEL=INFO

# Security
SECRET_KEY=change-me-in-production
```

---

## Configuration Parameters

### Module Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MODULE_NAME` | `labels_core_module` | Module identifier |
| `MODULE_VERSION` | `2.0.0` | Current version |
| `MODULE_PORT` | `8023` | HTTP port for REST API |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://waddlebot:password@localhost:5432/waddlebot` | PostgreSQL connection string |

### Service Integration

| Variable | Default | Description |
|----------|---------|-------------|
| `CORE_API_URL` | `http://router-service:8000` | Core API endpoint |
| `ROUTER_API_URL` | `http://router-service:8000/api/v1/router` | Router service endpoint |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `INFO` | Log verbosity (DEBUG, INFO, WARNING, ERROR) |

---

## Entity Type Configuration

### Supported Entity Types

The module supports these entity types by default:

```python
ENTITY_TYPES = [
    'user',           # User labels
    'module',         # Module labels
    'community',      # Community labels
    'entityGroup',    # Entity group labels
    'item',           # Generic items
    'event',          # Calendar events
    'memory',         # Memories (quotes, urls, notes)
    'playlist',       # Music playlists
    'browser_source', # Browser sources
    'command',        # Custom commands
    'alias',          # Command aliases
]
```

### Label Limits Per Entity Type

```python
LABEL_LIMITS = {
    'community': 5,
    'user': 5,        # Per community
    'item': 10,       # Items can have more labels
    'event': 5,
    'memory': 10,
    'default': 5,
}
```

To modify these limits, update the `LABEL_LIMITS` dictionary in `app.py`.

---

## Database Configuration

### Tables

The module creates two main tables:

#### labels
Stores label definitions:
- `id`: Primary key
- `name`: Label name (max 100 chars)
- `category`: Entity type
- `description`: Text description
- `color`: Hex color code (default: #6366f1)
- `icon`: Icon identifier (max 50 chars)
- `is_system`: Boolean flag for system labels
- `created_by`: Creator identifier (max 100 chars)
- `created_at`: Creation timestamp
- `updated_at`: Last update timestamp
- `is_active`: Soft delete flag

#### entity_labels
Stores label assignments to entities:
- `id`: Primary key
- `entity_id`: Entity identifier (max 255 chars)
- `entity_type`: Entity type (max 50 chars)
- `label_id`: Foreign key to labels table
- `community_id`: Community context (optional)
- `applied_by`: Who applied the label (max 100 chars)
- `applied_at`: Application timestamp
- `expires_at`: Optional expiration timestamp
- `metadata`: JSON field for additional data
- `is_active`: Soft delete flag

### Indexes

Recommended indexes for performance:

```sql
CREATE INDEX idx_labels_category ON labels(category);
CREATE INDEX idx_labels_name ON labels(name);
CREATE INDEX idx_entity_labels_entity ON entity_labels(entity_id, entity_type);
CREATE INDEX idx_entity_labels_label ON entity_labels(label_id);
CREATE INDEX idx_entity_labels_community ON entity_labels(community_id);
```

---

## System Labels

System labels are created by the system and cannot be modified or deleted by users. They have `is_system=true`.

Example system labels:
- Premium subscribers
- Bot accounts
- Moderators
- Verified users

System labels should be created via database migrations or admin scripts.

---

## Color Codes

Labels support hex color codes for visual identification:

- Default: `#6366f1` (indigo)
- Premium: `#fbbf24` (amber)
- Warning: `#ef4444` (red)
- Success: `#10b981` (green)
- Info: `#3b82f6` (blue)

---

## Expiration Handling

Labels can have optional expiration dates via the `expires_at` field. The system does NOT automatically remove expired labels - implement a cleanup cron job:

```python
# Example cleanup script
dal.executesql("""
    UPDATE entity_labels
    SET is_active = false
    WHERE expires_at < NOW()
    AND is_active = true
""")
```

---

## Metadata Structure

The `metadata` field in `entity_labels` accepts any JSON structure:

```json
{
  "reason": "Annual VIP renewal",
  "granted_by": "promotion_2025",
  "tier_level": 3,
  "custom_data": {
    "source": "twitch_sub",
    "duration_months": 12
  }
}
```

---

## Performance Tuning

### Bulk Operations

When applying labels to many entities, use the bulk endpoint:

```http
POST /labels/apply
[
  {"entity_id": "...", "label_id": 1, ...},
  {"entity_id": "...", "label_id": 1, ...}
]
```

Limit: 1000 items per bulk request.

### Caching

Consider implementing Redis caching for frequently accessed labels:
- Cache label definitions by ID
- Cache entity label sets
- TTL: 5-15 minutes

---

## Security Considerations

1. **System Labels**: Protect system labels from modification
2. **Validation**: Validate entity types against allowed list
3. **Rate Limiting**: Apply rate limits to label operations
4. **Audit Logging**: All label changes are logged via AAA logger
5. **Access Control**: Implement permission checks at application level

---

## Migration Notes

When upgrading or migrating:

1. Backup `labels` and `entity_labels` tables
2. Run schema migrations
3. Verify label limits are appropriate
4. Check for any expired labels to clean up
5. Validate system labels are present

---

## Example Configuration File

Create a `.env` file:

```bash
# Labels Core Module Configuration
MODULE_PORT=8023
DATABASE_URL=postgresql://waddlebot:password@localhost:5432/waddlebot
CORE_API_URL=http://router-service:8000
ROUTER_API_URL=http://router-service:8000/api/v1/router
LOG_LEVEL=INFO
SECRET_KEY=your-secret-key-here
```
