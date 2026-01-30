# Engagement Module

Python/Quart-based community engagement module for polls and forms with granular visibility controls.

## Features

- Community polls with multiple choice, single/multi-select
- Timed poll expiration
- Customizable forms with various field types
- Visibility controls: public, registered, community, admins
- Separate view vs submit/vote permissions
- Anonymous submission support
- One submission per user enforcement

## Configuration

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `REST_PORT` | HTTP REST API port | 8091 |
| `GRPC_PORT` | gRPC service port | 50066 |
| `DB_HOST` | PostgreSQL host | localhost |
| `DB_PORT` | PostgreSQL port | 5432 |
| `DB_NAME` | Database name | waddlebot |
| `DB_USER` | Database user | waddlebot |
| `DB_PASS` | Database password | - |

## API Endpoints

### Polls

- `GET /api/v1/polls` - List polls for a community
- `GET /api/v1/polls/:poll_id` - Get poll with results
- `POST /api/v1/polls` - Create a poll
- `DELETE /api/v1/polls/:poll_id` - Delete a poll
- `POST /api/v1/polls/:poll_id/vote` - Vote in a poll

### Forms

- `GET /api/v1/forms` - List forms for a community
- `GET /api/v1/forms/:form_id` - Get form details
- `POST /api/v1/forms` - Create a form
- `DELETE /api/v1/forms/:form_id` - Delete a form
- `POST /api/v1/forms/:form_id/submit` - Submit form response
- `GET /api/v1/forms/:form_id/submissions` - Get submissions (admin)

### Health

- `GET /health` - Health check

## Database Tables

### Polls
- `community_polls` - Poll definitions with visibility/access settings
- `poll_options` - Poll answer options
- `poll_votes` - User votes

### Forms
- `community_forms` - Form definitions with visibility/access settings
- `form_fields` - Form field definitions
- `form_submissions` - User form submissions
- `form_field_values` - Individual field values per submission

## Visibility Levels

| Level | Description |
|-------|-------------|
| `public` | Anyone can access |
| `registered` | Logged-in users only |
| `community` | Community members only |
| `admins` | Community admins only |

## Form Field Types

- `text` - Single line text input
- `textarea` - Multi-line text input
- `email` - Email input with validation
- `number` - Numeric input
- `select` - Dropdown selection
- `radio` - Radio button group
- `checkbox` - Checkbox group
- `date` - Date picker

## Docker

```bash
docker build -t waddlebot/engagement .
docker run -p 8091:8091 -p 50066:50066 waddlebot/engagement
```

## Poll Options

| Option | Description |
|--------|-------------|
| `allow_multiple_choices` | Allow selecting multiple options |
| `max_choices` | Maximum selections when multiple allowed |
| `expires_at` | Poll expiration timestamp |

## Form Options

| Option | Description |
|--------|-------------|
| `allow_anonymous` | Allow submissions without login |
| `submit_once_per_user` | Limit to one submission per user |
