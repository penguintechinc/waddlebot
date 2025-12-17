# AI Interaction Module - API Reference

## Overview

The AI Interaction Module provides intelligent chat responses using multiple AI provider backends (Ollama direct or WaddleAI proxy). This API documentation covers all available endpoints for AI interaction, configuration, and testing.

**Base URL:** `http://<host>:8005`
**API Version:** v1
**Module Version:** 2.0.0

---

## Authentication

### API Key Authentication
Most endpoints require authentication using API keys in the request header:

```http
Authorization: Bearer <api_key>
```

### Public Endpoints
- `GET /` - Module information
- `GET /health` - Health check
- `POST /api/v1/ai/interaction` - Main interaction endpoint (no auth required)

---

## Endpoints

### Module Information

#### GET /
Get module information and available endpoints.

**Response:**
```json
{
  "success": true,
  "data": {
    "module": "ai_interaction_module",
    "version": "2.0.0",
    "provider": "waddleai",
    "model": "auto",
    "status": "operational",
    "endpoints": [
      "/health",
      "/api/v1/ai/interaction",
      "/api/v1/ai/chat/completions",
      "/api/v1/ai/models",
      "/api/v1/ai/config",
      "/api/v1/ai/test"
    ]
  }
}
```

---

### Health Check

#### GET /health
Check module health and readiness status.

**Response:**
```json
{
  "status": "healthy",
  "module": "ai_interaction_module",
  "version": "2.0.0",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

---

### AI Interaction

#### POST /api/v1/ai/interaction
Main interaction endpoint for processing messages and events from the router.

**Request Body:**
```json
{
  "session_id": "sess_abc123",
  "message_type": "chatMessage",
  "message_content": "Hello, how are you?",
  "user_id": "user_12345",
  "entity_id": "twitch:channel:98765",
  "platform": "twitch",
  "username": "johndoe",
  "display_name": "JohnDoe"
}
```

**Request Fields:**
- `session_id` (string, required): Unique session identifier
- `message_type` (string, required): Type of message (chatMessage, subscription, follow, etc.)
- `message_content` (string, required): The actual message content
- `user_id` (string, required): User identifier
- `entity_id` (string, required): Community/channel identifier
- `platform` (string, required): Platform name (twitch, discord, etc.)
- `username` (string, required): User's username
- `display_name` (string, optional): User's display name

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Processing request",
    "session_id": "sess_abc123"
  }
}
```

**Trigger Patterns:**
- **Greetings:** o7, hi, hello, hey, howdy, greetings, sup, hiya
- **Farewells:** !lurk, bye, goodbye, later, cya
- **Questions:** Any message containing configured question triggers (default: ?)
- **Events:** subscription, follow, donation, cheer, raid, boost (if enabled)

**Notes:**
- This endpoint returns immediately and processes the interaction asynchronously
- Response is sent back to the router via `/api/v1/router/response` endpoint
- Processing time is tracked and included in response metadata

---

### OpenAI-Compatible Chat Completions

#### POST /api/v1/ai/chat/completions
OpenAI-compatible chat completions endpoint for direct API integration.

**Authentication:** Required

**Request Body:**
```json
{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is the weather like?"}
  ],
  "model": "auto",
  "temperature": 0.7,
  "max_tokens": 500
}
```

**Request Fields:**
- `messages` (array, required): Array of message objects with role and content
- `model` (string, optional): Model to use (defaults to configured model)
- `temperature` (float, optional): Response randomness (0.0-2.0)
- `max_tokens` (integer, optional): Maximum response length

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "chatcmpl-user_12345",
    "object": "chat.completion",
    "created": 1705320600,
    "model": "auto",
    "choices": [
      {
        "index": 0,
        "message": {
          "role": "assistant",
          "content": "I don't have access to real-time weather data..."
        },
        "finish_reason": "stop"
      }
    ],
    "usage": {
      "prompt_tokens": 15,
      "completion_tokens": 25,
      "total_tokens": 40
    }
  }
}
```

**Validation:**
- `messages` array is required and cannot be empty
- `messages` array cannot exceed 50 items
- Each message must have `role` and `content` fields

---

### Get Available Models

#### GET /api/v1/ai/models
Retrieve list of available AI models from the current provider.

**Response:**
```json
{
  "success": true,
  "data": {
    "provider": "waddleai",
    "models": [
      "gpt-4",
      "gpt-3.5-turbo",
      "claude-3-sonnet",
      "claude-3-haiku",
      "llama3.2"
    ],
    "current_model": "auto"
  }
}
```

---

### Configuration Management

#### GET /api/v1/ai/config
Get current AI module configuration.

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "provider": "waddleai",
    "model": "auto",
    "temperature": 0.7,
    "max_tokens": 500,
    "system_prompt": "You are a helpful chatbot assistant...",
    "question_triggers": ["?"],
    "respond_to_events": true,
    "event_response_types": [
      "subscription",
      "follow",
      "donation",
      "cheer",
      "raid",
      "boost"
    ]
  }
}
```

#### PUT /api/v1/ai/config
Update AI module configuration.

**Authentication:** Required

**Request Body:**
```json
{
  "community_id": 123,
  "model": "gpt-4",
  "temperature": 0.8,
  "max_tokens": 300,
  "system_prompt": "You are a friendly streaming bot..."
}
```

**Request Fields:**
- `community_id` (integer, required): Community ID
- `model` (string, optional): Model identifier
- `temperature` (float, optional): Temperature setting (0.0-2.0)
- `max_tokens` (integer, optional): Max tokens (1-10000)
- `system_prompt` (string, optional): Custom system prompt (max 2000 chars)
- `api_key` (string, optional): Provider API key (stored securely)
- `base_url` (string, optional): Custom provider base URL

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Configuration updated successfully",
    "config": {
      "provider": "waddleai",
      "model": "gpt-4",
      "temperature": 0.8,
      "max_tokens": 300
    }
  }
}
```

---

### Test Endpoint

#### POST /api/v1/ai/test
Test AI generation with custom input.

**Authentication:** Required

**Request Body:**
```json
{
  "message": "Tell me a joke about programming"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "input": "Tell me a joke about programming",
    "output": "Why do programmers prefer dark mode? Because light attracts bugs!",
    "provider": "waddleai",
    "model": "auto"
  }
}
```

**Validation:**
- `message` field is required
- Message cannot exceed 10,000 characters

---

## Error Responses

All endpoints return error responses in this format:

```json
{
  "success": false,
  "error": {
    "message": "Error description",
    "code": "ERROR_CODE"
  }
}
```

### Common Error Codes

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 400 | INVALID_REQUEST | Missing required fields or invalid data |
| 401 | UNAUTHORIZED | Missing or invalid authentication |
| 403 | FORBIDDEN | Insufficient permissions |
| 404 | NOT_FOUND | Resource not found |
| 429 | RATE_LIMITED | Too many requests |
| 500 | INTERNAL_ERROR | Server error |
| 503 | SERVICE_UNAVAILABLE | AI provider unavailable |

---

## Rate Limiting

- **Default:** 10 concurrent requests maximum
- **Timeout:** 30 seconds per request
- **Provider-specific:** Subject to provider rate limits (Ollama/WaddleAI)

---

## WebSocket Support

Currently not implemented. All interactions are HTTP-based with async processing.

---

## Code Examples

### Python Example

```python
import requests

# Send interaction
response = requests.post(
    "http://localhost:8005/api/v1/ai/interaction",
    json={
        "session_id": "sess_123",
        "message_type": "chatMessage",
        "message_content": "Hello!",
        "user_id": "user_456",
        "entity_id": "twitch:channel:789",
        "platform": "twitch",
        "username": "testuser"
    }
)

print(response.json())
```

### cURL Example

```bash
# Test endpoint with authentication
curl -X POST http://localhost:8005/api/v1/ai/test \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is AI?"}'
```

### JavaScript Example

```javascript
// Chat completions
const response = await fetch('http://localhost:8005/api/v1/ai/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your-api-key',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    messages: [
      {role: 'user', content: 'Hello!'}
    ],
    model: 'auto',
    temperature: 0.7
  })
});

const data = await response.json();
console.log(data.data.choices[0].message.content);
```

---

## Changelog

### Version 2.0.0
- Added WaddleAI proxy provider support
- Implemented OpenAI-compatible /chat/completions endpoint
- Added configuration management endpoints
- Improved async request handling
- Added comprehensive validation

### Version 1.0.0
- Initial release with Ollama support
- Basic interaction endpoint
- Health check endpoint
