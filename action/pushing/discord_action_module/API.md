# Discord Action Module API Documentation

## Overview

The Discord Action Module provides two communication interfaces:
- **gRPC**: Primary interface for processor/router (port 50051)
- **REST API**: Secondary interface for third-party integrations (port 8070)

Both interfaces require JWT authentication using a shared 64-character secret key.

## Authentication

### JWT Token Generation

All requests require a JWT token in the `Authorization` header (REST) or `token` field (gRPC).

**REST API Token Generation:**
```bash
POST /api/v1/token
Content-Type: application/json

{
  "client_id": "your_client_id",
  "client_secret": "your_client_secret"
}
```

**Response:**
```json
{
  "token": "eyJ0eXAiOiJKV1QiLCJhbGc...",
  "expires_in": 3600
}
```

**Using Token in Requests:**
```bash
Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGc...
```

## REST API Endpoints

### Health Check

**GET /health**

No authentication required.

**Response:**
```json
{
  "status": "healthy",
  "module": "discord_action_module",
  "version": "1.0.0",
  "timestamp": "2025-12-02T12:00:00.000000",
  "config": {
    "module_name": "discord_action_module",
    "module_version": "1.0.0",
    "grpc_port": 50051,
    "rest_port": 8070,
    "database_configured": true,
    "discord_token_configured": true
  }
}
```

### Send Message

**POST /api/v1/message**

Send a text message to a Discord channel with optional embed.

**Request:**
```json
{
  "channel_id": "1234567890",
  "content": "Hello from WaddleBot!",
  "embed": {
    "title": "Optional Embed",
    "description": "Embed description",
    "color": "FF5733",
    "url": "https://example.com",
    "thumbnail_url": "https://example.com/thumb.png",
    "image_url": "https://example.com/image.png",
    "footer_text": "Footer text",
    "footer_icon_url": "https://example.com/icon.png",
    "fields": [
      {
        "name": "Field Name",
        "value": "Field Value",
        "inline": true
      }
    ]
  }
}
```

**Response:**
```json
{
  "success": true,
  "message_id": "9876543210"
}
```

### Send Embed

**POST /api/v1/embed**

Send a rich embed to a Discord channel.

**Request:**
```json
{
  "channel_id": "1234567890",
  "embed": {
    "title": "Embed Title",
    "description": "Embed description",
    "color": "FF5733",
    "fields": [
      {
        "name": "Field 1",
        "value": "Value 1",
        "inline": true
      }
    ]
  }
}
```

**Response:**
```json
{
  "success": true,
  "message_id": "9876543210"
}
```

### Add Reaction

**POST /api/v1/reaction**

Add an emoji reaction to a message.

**Request:**
```json
{
  "channel_id": "1234567890",
  "message_id": "9876543210",
  "emoji": "👍"
}
```

**Response:**
```json
{
  "success": true
}
```

### Manage Role

**POST /api/v1/role**

Add or remove a role from a user.

**Request:**
```json
{
  "guild_id": "1234567890",
  "user_id": "9876543210",
  "role_id": "5555555555",
  "action": "add"
}
```

**Actions:** `add` or `remove`

**Response:**
```json
{
  "success": true
}
```

### Create Webhook

**POST /api/v1/webhook**

Create a webhook for a channel.

**Request:**
```json
{
  "channel_id": "1234567890",
  "name": "WaddleBot Webhook"
}
```

**Response:**
```json
{
  "success": true,
  "webhook_url": "https://discord.com/api/webhooks/123/abc..."
}
```

### Send Webhook

**POST /api/v1/webhook/send**

Send a message via webhook.

**Request:**
```json
{
  "webhook_url": "https://discord.com/api/webhooks/123/abc...",
  "content": "Message content",
  "embeds": [
    {
      "title": "Embed Title",
      "description": "Description"
    }
  ]
}
```

**Response:**
```json
{
  "success": true
}
```

### Delete Message

**DELETE /api/v1/message/{channel_id}/{message_id}**

Delete a message.

**Response:**
```json
{
  "success": true
}
```

### Edit Message

**PATCH /api/v1/message/{channel_id}/{message_id}**

Edit a message.

**Request:**
```json
{
  "content": "Updated message content"
}
```

**Response:**
```json
{
  "success": true
}
```

### Kick User

**POST /api/v1/moderation/kick**

Kick a user from a guild.

**Request:**
```json
{
  "guild_id": "1234567890",
  "user_id": "9876543210",
  "reason": "Violation of rules"
}
```

**Response:**
```json
{
  "success": true
}
```

### Ban User

**POST /api/v1/moderation/ban**

Ban a user from a guild.

**Request:**
```json
{
  "guild_id": "1234567890",
  "user_id": "9876543210",
  "reason": "Spam",
  "delete_message_days": 7
}
```

**delete_message_days:** Number of days of messages to delete (0-7)

**Response:**
```json
{
  "success": true
}
```

### Timeout User

**POST /api/v1/moderation/timeout**

Timeout (mute) a user for a specified duration.

**Request:**
```json
{
  "guild_id": "1234567890",
  "user_id": "9876543210",
  "duration_seconds": 600,
  "reason": "Excessive spam"
}
```

**duration_seconds:** Timeout duration in seconds (max 2419200 = 28 days)

**Response:**
```json
{
  "success": true
}
```

## gRPC API

### Service Definition

See `proto/discord_action.proto` for full service definition.

### Python Client Example

```python
import grpc
import jwt
from proto import discord_action_pb2, discord_action_pb2_grpc

# Generate JWT token
token = jwt.encode(
    {"client_id": "processor"},
    "your_64_char_secret_key",
    algorithm="HS256"
)

# Connect to gRPC server
channel = grpc.insecure_channel('localhost:50051')
stub = discord_action_pb2_grpc.DiscordActionStub(channel)

# Send message
request = discord_action_pb2.SendMessageRequest(
    channel_id="1234567890",
    content="Hello from gRPC!",
    token=token
)
response = stub.SendMessage(request)
print(f"Success: {response.success}")
print(f"Message ID: {response.message_id}")
```

### Available gRPC Methods

- `SendMessage(SendMessageRequest) -> SendMessageResponse`
- `SendEmbed(SendEmbedRequest) -> SendEmbedResponse`
- `AddReaction(AddReactionRequest) -> AddReactionResponse`
- `ManageRole(ManageRoleRequest) -> ManageRoleResponse`
- `CreateWebhook(CreateWebhookRequest) -> CreateWebhookResponse`
- `SendWebhook(SendWebhookRequest) -> SendWebhookResponse`
- `DeleteMessage(DeleteMessageRequest) -> DeleteMessageResponse`
- `EditMessage(EditMessageRequest) -> EditMessageResponse`
- `KickUser(KickUserRequest) -> KickUserResponse`
- `BanUser(BanUserRequest) -> BanUserResponse`
- `TimeoutUser(TimeoutUserRequest) -> TimeoutUserResponse`

## Error Responses

### REST API Errors

**401 Unauthorized:**
```json
{
  "error": "Missing or invalid authorization header"
}
```

**400 Bad Request:**
```json
{
  "error": "Missing required fields"
}
```

**500 Internal Server Error:**
```json
{
  "success": false,
  "error": "API error 403: Missing Permissions"
}
```

### gRPC Errors

gRPC methods return structured responses with `success` and `error` fields:

```python
response.success  # bool
response.error    # str (empty if successful)
```

## Rate Limiting

The module implements Discord API rate limiting:
- Global rate limit: 50 requests/second
- Per-channel rate limit: 5 requests/second
- Automatic retry with exponential backoff
- Rate limit headers respected

## Logging

All actions are logged to the database:

```sql
CREATE TABLE discord_actions (
    id SERIAL PRIMARY KEY,
    action_type VARCHAR(50) NOT NULL,
    guild_id VARCHAR(50),
    channel_id VARCHAR(50),
    user_id VARCHAR(50),
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    request_data JSONB,
    response_data JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);
```

## Security

- All requests require JWT authentication
- Tokens expire after configured duration (default: 3600s)
- 64-character shared secret key required
- No API key stored in database (stateless)
- All actions logged for audit trail

## Performance

- Async/await for all operations
- Connection pooling for database
- Rate limit enforcement with retry
- Configurable concurrent request limits
- Maximum 3 retries on transient failures

## Example: Complete Workflow

```bash
# 1. Generate token
curl -X POST http://localhost:8070/api/v1/token \
  -H "Content-Type: application/json" \
  -d '{"client_id": "test", "client_secret": "test"}'

# 2. Send message
curl -X POST http://localhost:8070/api/v1/message \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "1234567890",
    "content": "Hello!"
  }'

# 3. Add reaction
curl -X POST http://localhost:8070/api/v1/reaction \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "1234567890",
    "message_id": "9876543210",
    "emoji": "👍"
  }'
```
