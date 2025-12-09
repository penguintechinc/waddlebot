# Router Module Input Validation

This document describes the input validation implemented for the Router Module using Pydantic models.

## Overview

The Router Module now uses the `flask_core.validation` library with Pydantic models to validate all incoming requests. This provides:

- **Type Safety**: Ensures all fields are the correct type
- **Length Validation**: Prevents excessively long inputs
- **Format Validation**: Validates platform names, IDs, and other structured data
- **Security**: Rejects unknown fields and malformed data
- **Better Error Messages**: Returns detailed validation errors to clients

## Validated Endpoints

### 1. POST /api/v1/router/events

**Purpose**: Process a single event

**Validation Model**: `RouterEventRequest`

**Required Fields**:
- `platform` (string): Must be one of: `twitch`, `discord`, `slack`, `kick`
- `channel_id` (string): 1-255 characters, cannot be empty/whitespace
- `user_id` (string): 1-255 characters, cannot be empty/whitespace
- `username` (string): 1-255 characters, cannot be empty/whitespace
- `message` (string): 1-5000 characters, cannot be empty/whitespace

**Optional Fields**:
- `command` (string): Max 255 characters, extracted command name
- `metadata` (object): Additional event metadata as key-value pairs

**Example Valid Request**:
```json
{
  "platform": "twitch",
  "channel_id": "12345",
  "user_id": "67890",
  "username": "testuser",
  "message": "!help",
  "command": "help",
  "metadata": {
    "timestamp": "2025-12-09T10:30:00Z",
    "subscriber": true
  }
}
```

**Example Error Response**:
```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "platform",
      "message": "string does not match regex \"^(twitch|discord|slack|kick)$\"",
      "type": "value_error.str.regex"
    }
  ]
}
```

---

### 2. POST /api/v1/router/events/batch

**Purpose**: Process multiple events concurrently (up to 100)

**Validation Model**: `RouterBatchRequest`

**Required Fields**:
- `events` (array): Array of 1-100 `RouterEventRequest` objects

**Constraints**:
- Minimum 1 event
- Maximum 100 events
- Each event must pass `RouterEventRequest` validation

**Example Valid Request**:
```json
{
  "events": [
    {
      "platform": "discord",
      "channel_id": "111",
      "user_id": "222",
      "username": "user1",
      "message": "!ping"
    },
    {
      "platform": "slack",
      "channel_id": "333",
      "user_id": "444",
      "username": "user2",
      "message": "!status"
    }
  ]
}
```

**Example Error Response**:
```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "events",
      "message": "ensure this value has at least 1 items",
      "type": "value_error.list.min_items"
    }
  ]
}
```

---

### 3. POST /api/v1/router/responses

**Purpose**: Receive responses from interaction modules

**Validation Model**: `RouterResponseRequest`

**Required Fields**:
- `event_id` (string): 1-255 characters, event ID this response is for
- `response` (string): 1-5000 characters, response message
- `platform` (string): Must be one of: `twitch`, `discord`, `slack`, `kick`
- `channel_id` (string): 1-255 characters, channel to send response to

**Example Valid Request**:
```json
{
  "event_id": "evt_12345",
  "response": "Command executed successfully!",
  "platform": "twitch",
  "channel_id": "67890"
}
```

**Example Error Response**:
```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "response",
      "message": "response cannot be empty or whitespace only",
      "type": "value_error"
    }
  ]
}
```

---

## Validation Rules Summary

### Platform Validation
- **Allowed Values**: `twitch`, `discord`, `slack`, `kick`
- **Case Sensitive**: Must be lowercase
- **No Spaces**: Exact match required

### String Length Limits
- **IDs** (channel_id, user_id, username, event_id): 1-255 characters
- **Messages & Responses**: 1-5000 characters
- **Commands**: 0-255 characters (optional)

### Whitespace Handling
- Leading/trailing whitespace is trimmed
- Empty strings (after trimming) are rejected
- Whitespace-only strings are rejected

### Extra Fields
- All models use `Config.extra = 'forbid'`
- Unknown fields are rejected with validation error
- Prevents accidental data leakage or injection

### Batch Processing
- Minimum: 1 event per batch
- Maximum: 100 events per batch
- Each event validated independently
- One invalid event fails entire batch

---

## Testing

A comprehensive test suite is available in `test_validation.py`:

```bash
# Run validation tests (requires pydantic installed)
python3 test_validation.py
```

The test suite validates:
- ✓ Valid requests are accepted
- ✓ Invalid platforms are rejected
- ✓ Oversized messages are rejected
- ✓ Empty/whitespace fields are rejected
- ✓ Extra fields are rejected
- ✓ Batch size limits are enforced

---

## Implementation Details

### File Structure
```
processing/router_module/
├── validation_models.py          # Pydantic validation models
├── controllers/
│   └── router.py                 # Controller with @validate_json decorators
└── test_validation.py            # Validation test suite
```

### Decorator Usage

The `@validate_json` decorator from `flask_core.validation`:
1. Extracts JSON from request body
2. Validates against Pydantic model
3. Returns 400 error if validation fails
4. Passes validated data to endpoint function
5. Logs validation success/failure

### Error Response Format

All validation errors return HTTP 400 with this structure:
```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "field.name.path",
      "message": "Human-readable error message",
      "type": "pydantic_error_type"
    }
  ]
}
```

---

## Security Considerations

1. **Input Sanitization**: All strings are trimmed and validated
2. **Length Limits**: Prevents DoS via extremely large payloads
3. **Type Safety**: Prevents type confusion attacks
4. **Unknown Fields**: Rejected to prevent injection attacks
5. **Platform Restriction**: Only approved platforms accepted
6. **Logging**: All validation failures are logged for security monitoring

---

## Future Enhancements

- [ ] Add rate limiting per platform
- [ ] Validate metadata structure based on platform
- [ ] Add request size limits at HTTP layer
- [ ] Implement command format validation
- [ ] Add platform-specific username validation
- [ ] Support additional platforms (matrix, teams, irc)

---

## Related Documentation

- `/home/penguin/code/WaddleBot/libs/flask_core/flask_core/validation.py` - Validation library
- `/home/penguin/code/WaddleBot/docs/api-reference.md` - Full API documentation
- `/home/penguin/code/WaddleBot/docs/development-rules.md` - Development standards
