# Slack Action Module - API Documentation

Complete API reference for the Slack Action Module, covering both REST API and gRPC interfaces.

## Table of Contents

- [Authentication](#authentication)
- [REST API Endpoints](#rest-api-endpoints)
- [gRPC Service](#grpc-service)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)

## Authentication

### JWT Token Authentication

All REST API endpoints (except `/health` and `/api/v1/token`) require JWT authentication.

#### Get Token

```http
POST /api/v1/token
Content-Type: application/json

{
    "api_key": "your-module-secret-key",
    "client_id": "your-client-id"
}
```

**Response:**
```json
{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 3600
}
```

#### Using Token

Include token in Authorization header:
```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## REST API Endpoints

### Health Check

```http
GET /health
```

**Response:**
```json
{
    "status": "healthy",
    "module": "slack_action_module",
    "version": "1.0.0",
    "grpc_port": 50052,
    "rest_port": 8071
}
```

### Send Message

Send message to Slack channel with optional Block Kit blocks.

```http
POST /api/v1/message
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "channel_id": "C01234567",
    "text": "Hello from WaddleBot!",
    "blocks": [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "*Bold text* and _italic text_"
            }
        }
    ],
    "thread_ts": "1234567890.123456"  // Optional: reply in thread
}
```

**Response:**
```json
{
    "success": true,
    "message_ts": "1234567890.123456",
    "error": null
}
```

### Send Ephemeral Message

Send ephemeral message visible only to specific user.

```http
POST /api/v1/ephemeral
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "channel_id": "C01234567",
    "user_id": "U01234567",
    "text": "This message is only visible to you!"
}
```

**Response:**
```json
{
    "success": true,
    "error": null
}
```

### Update Message

Update existing message.

```http
PUT /api/v1/message/{channel_id}/{ts}
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "text": "Updated message text",
    "blocks": []  // Optional: new blocks
}
```

**Response:**
```json
{
    "success": true,
    "error": null
}
```

### Delete Message

Delete message.

```http
DELETE /api/v1/message/{channel_id}/{ts}
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123"
}
```

**Response:**
```json
{
    "success": true,
    "error": null
}
```

### Add Reaction

Add emoji reaction to message.

```http
POST /api/v1/reaction
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "channel_id": "C01234567",
    "ts": "1234567890.123456",
    "emoji": "thumbsup"  // Without colons
}
```

**Response:**
```json
{
    "success": true,
    "error": null
}
```

### Remove Reaction

Remove emoji reaction from message.

```http
DELETE /api/v1/reaction
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "channel_id": "C01234567",
    "ts": "1234567890.123456",
    "emoji": "thumbsup"
}
```

**Response:**
```json
{
    "success": true,
    "error": null
}
```

### Upload File

Upload file to Slack channel.

```http
POST /api/v1/file
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "channel_id": "C01234567",
    "file_content_base64": "base64-encoded-file-content",
    "filename": "document.pdf",
    "title": "Important Document"
}
```

**Response:**
```json
{
    "success": true,
    "file_id": "F01234567",
    "error": null
}
```

### Create Channel

Create new Slack channel.

```http
POST /api/v1/channel
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "name": "new-channel-name",
    "is_private": false
}
```

**Response:**
```json
{
    "success": true,
    "channel_id": "C01234567",
    "error": null
}
```

### Invite to Channel

Invite users to channel.

```http
POST /api/v1/channel/invite
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "channel_id": "C01234567",
    "user_ids": ["U01234567", "U98765432"]
}
```

**Response:**
```json
{
    "success": true,
    "error": null
}
```

### Kick from Channel

Remove user from channel.

```http
POST /api/v1/channel/kick
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "channel_id": "C01234567",
    "user_id": "U01234567"
}
```

**Response:**
```json
{
    "success": true,
    "error": null
}
```

### Set Channel Topic

Set channel topic.

```http
PUT /api/v1/channel/topic
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "channel_id": "C01234567",
    "topic": "New channel topic"
}
```

**Response:**
```json
{
    "success": true,
    "error": null
}
```

### Open Modal

Open modal dialog.

```http
POST /api/v1/modal
Authorization: Bearer {token}
Content-Type: application/json

{
    "community_id": "community-123",
    "trigger_id": "trigger-id-from-interaction",
    "view": {
        "type": "modal",
        "title": {
            "type": "plain_text",
            "text": "Modal Title"
        },
        "blocks": []
    }
}
```

**Response:**
```json
{
    "success": true,
    "view_id": "V01234567",
    "error": null
}
```

### Get Action History

Get action history for community.

```http
GET /api/v1/history/{community_id}?limit=100
Authorization: Bearer {token}
```

**Response:**
```json
{
    "history": [
        {
            "id": 1,
            "community_id": "community-123",
            "action_type": "send_message",
            "channel_id": "C01234567",
            "message_ts": "1234567890.123456",
            "success": true,
            "created_at": "2024-01-01T12:00:00"
        }
    ]
}
```

## gRPC Service

### Service Definition

```protobuf
service SlackActionService {
  rpc SendMessage(SendMessageRequest) returns (SendMessageResponse);
  rpc SendEphemeral(SendEphemeralRequest) returns (SendEphemeralResponse);
  rpc UpdateMessage(UpdateMessageRequest) returns (UpdateMessageResponse);
  rpc DeleteMessage(DeleteMessageRequest) returns (DeleteMessageResponse);
  rpc AddReaction(AddReactionRequest) returns (AddReactionResponse);
  rpc RemoveReaction(RemoveReactionRequest) returns (RemoveReactionResponse);
  rpc UploadFile(UploadFileRequest) returns (UploadFileResponse);
  rpc CreateChannel(CreateChannelRequest) returns (CreateChannelResponse);
  rpc InviteToChannel(InviteToChannelRequest) returns (InviteToChannelResponse);
  rpc KickFromChannel(KickFromChannelRequest) returns (KickFromChannelResponse);
  rpc SetTopic(SetTopicRequest) returns (SetTopicResponse);
  rpc OpenModal(OpenModalRequest) returns (OpenModalResponse);
}
```

### Python gRPC Client Example

```python
import grpc
from proto import slack_action_pb2, slack_action_pb2_grpc

# Create channel
channel = grpc.insecure_channel('localhost:50052')
stub = slack_action_pb2_grpc.SlackActionServiceStub(channel)

# Send message
request = slack_action_pb2.SendMessageRequest(
    community_id='community-123',
    channel_id='C01234567',
    text='Hello from gRPC!',
    blocks_json='[]'  # JSON-encoded blocks
)

response = stub.SendMessage(request)
print(f"Success: {response.success}")
print(f"Message TS: {response.message_ts}")

# Add reaction
request = slack_action_pb2.AddReactionRequest(
    community_id='community-123',
    channel_id='C01234567',
    ts=response.message_ts,
    emoji='wave'
)

response = stub.AddReaction(request)
print(f"Reaction added: {response.success}")

channel.close()
```

## Error Handling

### HTTP Status Codes

- `200 OK` - Request successful
- `401 Unauthorized` - Invalid or missing JWT token
- `403 Forbidden` - Insufficient permissions
- `500 Internal Server Error` - Server error

### Error Response Format

```json
{
    "success": false,
    "error": "Error message description"
}
```

### Common Slack API Errors

- `channel_not_found` - Invalid channel ID
- `not_in_channel` - Bot not in specified channel
- `message_not_found` - Message timestamp not found
- `invalid_auth` - Invalid Slack bot token
- `user_not_found` - Invalid user ID
- `name_taken` - Channel name already exists

## Rate Limiting

The module implements configurable rate limiting:

- **Max Concurrent Requests**: 100 (default)
- **Request Timeout**: 30 seconds (default)

Configured via environment variables:
```bash
MAX_CONCURRENT_REQUESTS=100
REQUEST_TIMEOUT=30
```

## Database Schema

### slack_actions Table

```sql
CREATE TABLE slack_actions (
    id SERIAL PRIMARY KEY,
    community_id VARCHAR(64) NOT NULL,
    action_type VARCHAR(64) NOT NULL,
    channel_id VARCHAR(64),
    user_id VARCHAR(64),
    message_ts VARCHAR(64),
    request_data JSONB,
    response_data JSONB,
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_slack_actions_community ON slack_actions(community_id);
CREATE INDEX idx_slack_actions_created ON slack_actions(created_at);
CREATE INDEX idx_slack_actions_type ON slack_actions(action_type);
```

## Best Practices

1. **Token Management**: Refresh JWT tokens before expiration
2. **Error Handling**: Always check `success` field in responses
3. **Rate Limiting**: Implement exponential backoff for failed requests
4. **Message Threading**: Use `thread_ts` for threaded conversations
5. **Block Kit**: Use Block Kit for rich message formatting
6. **Ephemeral Messages**: Use for temporary user notifications
7. **File Uploads**: Compress large files before uploading

## Support

For issues or questions:
- Check logs in `/var/log/waddlebotlog/`
- Review action history via `/api/v1/history/{community_id}`
- Enable debug logging with `LOG_LEVEL=DEBUG`
