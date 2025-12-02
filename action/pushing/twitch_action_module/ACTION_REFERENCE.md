# Twitch Action Reference

Complete reference for all supported Twitch actions and their parameters.

## Chat Actions

### chat_message
Send a chat message to the broadcaster's channel.

**Parameters:**
- `message` (required): Message text

**Example:**
```json
{
  "action_type": "chat_message",
  "broadcaster_id": "123456",
  "parameters": {
    "message": "Hello, chat!"
  }
}
```

### whisper
Send a whisper (direct message) to a user.

**Parameters:**
- `to_user_id` (required): Recipient user ID
- `message` (required): Whisper text

**Example:**
```json
{
  "action_type": "whisper",
  "broadcaster_id": "123456",
  "parameters": {
    "to_user_id": "789012",
    "message": "Private message"
  }
}
```

### announcement
Send an announcement to chat with color.

**Parameters:**
- `message` (required): Announcement text
- `color` (optional): Color (blue, green, orange, purple, primary) - default: primary

**Example:**
```json
{
  "action_type": "announcement",
  "broadcaster_id": "123456",
  "parameters": {
    "message": "Important announcement!",
    "color": "purple"
  }
}
```

## Moderation Actions

### ban
Permanently ban a user from the channel.

**Parameters:**
- `user_id` (required): User ID to ban
- `reason` (optional): Ban reason - default: "Banned by bot"

**Example:**
```json
{
  "action_type": "ban",
  "broadcaster_id": "123456",
  "parameters": {
    "user_id": "789012",
    "reason": "Violated community guidelines"
  }
}
```

### timeout
Temporarily timeout a user.

**Parameters:**
- `user_id` (required): User ID to timeout
- `duration` (optional): Duration in seconds (1-1209600) - default: 600
- `reason` (optional): Timeout reason - default: "Timed out by bot"

**Example:**
```json
{
  "action_type": "timeout",
  "broadcaster_id": "123456",
  "parameters": {
    "user_id": "789012",
    "duration": "600",
    "reason": "Spamming"
  }
}
```

### unban
Remove ban or timeout from a user.

**Parameters:**
- `user_id` (required): User ID to unban

**Example:**
```json
{
  "action_type": "unban",
  "broadcaster_id": "123456",
  "parameters": {
    "user_id": "789012"
  }
}
```

### delete_message
Delete a specific chat message.

**Parameters:**
- `message_id` (required): Message ID to delete

**Example:**
```json
{
  "action_type": "delete_message",
  "broadcaster_id": "123456",
  "parameters": {
    "message_id": "abc123-def456-ghi789"
  }
}
```

### mod_add
Add a moderator to the channel.

**Parameters:**
- `user_id` (required): User ID to make moderator

**Example:**
```json
{
  "action_type": "mod_add",
  "broadcaster_id": "123456",
  "parameters": {
    "user_id": "789012"
  }
}
```

### mod_remove
Remove moderator status from a user.

**Parameters:**
- `user_id` (required): User ID to remove moderator status

**Example:**
```json
{
  "action_type": "mod_remove",
  "broadcaster_id": "123456",
  "parameters": {
    "user_id": "789012"
  }
}
```

### vip_add
Add a VIP to the channel.

**Parameters:**
- `user_id` (required): User ID to make VIP

**Example:**
```json
{
  "action_type": "vip_add",
  "broadcaster_id": "123456",
  "parameters": {
    "user_id": "789012"
  }
}
```

### vip_remove
Remove VIP status from a user.

**Parameters:**
- `user_id` (required): User ID to remove VIP status

**Example:**
```json
{
  "action_type": "vip_remove",
  "broadcaster_id": "123456",
  "parameters": {
    "user_id": "789012"
  }
}
```

## Stream Management Actions

### update_title
Update the stream title.

**Parameters:**
- `title` (required): New stream title

**Example:**
```json
{
  "action_type": "update_title",
  "broadcaster_id": "123456",
  "parameters": {
    "title": "New stream title!"
  }
}
```

### update_game
Update the stream game/category.

**Parameters:**
- `game_id` (required): Twitch game ID

**Example:**
```json
{
  "action_type": "update_game",
  "broadcaster_id": "123456",
  "parameters": {
    "game_id": "509658"
  }
}
```

### marker
Create a stream marker.

**Parameters:**
- `description` (optional): Marker description

**Example:**
```json
{
  "action_type": "marker",
  "broadcaster_id": "123456",
  "parameters": {
    "description": "Epic moment"
  }
}
```

### clip
Create a clip of the current broadcast.

**Parameters:** None

**Example:**
```json
{
  "action_type": "clip",
  "broadcaster_id": "123456",
  "parameters": {}
}
```

**Response includes:**
- `id`: Clip ID
- `edit_url`: URL to edit the clip

### raid
Start a raid to another channel.

**Parameters:**
- `to_broadcaster_id` (required): Target broadcaster ID

**Example:**
```json
{
  "action_type": "raid",
  "broadcaster_id": "123456",
  "parameters": {
    "to_broadcaster_id": "789012"
  }
}
```

## Interactive Actions

### poll_create
Create a poll in the channel.

**Parameters:**
- `title` (required): Poll title
- `choices` (required): Comma-separated poll choices (2-5 items)
- `duration` (optional): Poll duration in seconds (15-1800) - default: 60

**Example:**
```json
{
  "action_type": "poll_create",
  "broadcaster_id": "123456",
  "parameters": {
    "title": "What game should we play next?",
    "choices": "Game A,Game B,Game C",
    "duration": "120"
  }
}
```

### poll_end
End an active poll.

**Parameters:**
- `poll_id` (required): Poll ID to end
- `status` (optional): Poll status (TERMINATED or ARCHIVED) - default: TERMINATED

**Example:**
```json
{
  "action_type": "poll_end",
  "broadcaster_id": "123456",
  "parameters": {
    "poll_id": "abc123-def456",
    "status": "TERMINATED"
  }
}
```

### prediction_create
Create a prediction in the channel.

**Parameters:**
- `title` (required): Prediction title
- `outcomes` (required): Comma-separated outcomes (exactly 2)
- `duration` (optional): Prediction window in seconds (1-1800) - default: 60

**Example:**
```json
{
  "action_type": "prediction_create",
  "broadcaster_id": "123456",
  "parameters": {
    "title": "Will we beat the boss?",
    "outcomes": "Yes,No",
    "duration": "300"
  }
}
```

### prediction_resolve
Resolve a prediction with the winning outcome.

**Parameters:**
- `prediction_id` (required): Prediction ID
- `winning_outcome_id` (required): Winning outcome ID

**Example:**
```json
{
  "action_type": "prediction_resolve",
  "broadcaster_id": "123456",
  "parameters": {
    "prediction_id": "abc123-def456",
    "winning_outcome_id": "outcome-1"
  }
}
```

## Common Response Format

All actions return a consistent response format:

```json
{
  "success": true,
  "message": "Action chat_message executed successfully",
  "action_id": "uuid-here",
  "result_data": {
    // Action-specific result data
  },
  "error": ""
}
```

## Error Response Format

Failed actions return:

```json
{
  "success": false,
  "message": "Action execution failed",
  "action_id": "uuid-here",
  "result_data": {},
  "error": "Detailed error message"
}
```

## Batch Actions

Multiple actions can be executed in a single batch request:

```json
{
  "actions": [
    {
      "action_type": "chat_message",
      "broadcaster_id": "123456",
      "parameters": {"message": "First message"}
    },
    {
      "action_type": "announcement",
      "broadcaster_id": "123456",
      "parameters": {"message": "Announcement", "color": "purple"}
    }
  ]
}
```

**Batch Response:**
```json
{
  "responses": [
    // Individual action responses
  ],
  "total_count": 2,
  "success_count": 2,
  "failure_count": 0
}
```

## Required OAuth Scopes

Different actions require different OAuth scopes:

- **chat_message**: `chat:write`
- **whisper**: `whispers:write`
- **announcement**: `moderator:manage:announcements`
- **ban/unban**: `moderator:manage:banned_users`
- **delete_message**: `moderator:manage:chat_messages`
- **mod_add/mod_remove**: `channel:manage:moderators`
- **vip_add/vip_remove**: `channel:manage:vips`
- **update_title/update_game**: `channel:manage:broadcast`
- **marker**: `channel:manage:broadcast`
- **clip**: `clips:edit`
- **raid**: `channel:manage:raids`
- **poll**: `channel:manage:polls`
- **prediction**: `channel:manage:predictions`

## Rate Limits

Twitch API enforces rate limits per endpoint:

- **Chat messages**: 20 messages per 30 seconds
- **Whispers**: 3 per second, 100 per minute, 1000 per day
- **Announcements**: 10 per minute
- **Moderation actions**: Variable by action type
- **Stream updates**: 5 per minute

The module does not enforce rate limits - implement rate limiting at the processor/router level.
