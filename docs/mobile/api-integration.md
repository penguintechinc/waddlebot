# API Integration Guide

This document covers the Hub API endpoints and WebSocket events used by the mobile applications.

## Overview

The mobile apps communicate with the Hub API via:

1. **REST API**: Authentication, user data, community management
2. **WebSocket (Socket.io)**: Real-time chat, typing indicators, live updates

Base URLs:
- REST API: `https://hub-api.waddlebot.io/api/v1`
- WebSocket: `wss://hub-api.waddlebot.io`

## Authentication

### JWT Token Flow

```
+--------+                                +----------+
| Mobile |                                | Hub API  |
+--------+                                +----------+
    |                                          |
    |  POST /api/v1/auth/login                 |
    |  {email, password}                       |
    |----------------------------------------->|
    |                                          |
    |  200 OK                                  |
    |  {accessToken, refreshToken, user}       |
    |<-----------------------------------------|
    |                                          |
    |  GET /api/v1/user/profile                |
    |  Authorization: Bearer <accessToken>     |
    |----------------------------------------->|
    |                                          |
```

### Login Endpoint

**Request:**
```http
POST /api/v1/auth/login
Content-Type: application/json

{
    "email": "user@example.com",
    "password": "password123"
}
```

**Response:**
```json
{
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
    "expiresIn": 3600,
    "user": {
        "id": "user-123",
        "email": "user@example.com",
        "username": "johndoe",
        "avatarUrl": "https://..."
    }
}
```

### Token Refresh

**Request:**
```http
POST /api/v1/auth/refresh
Content-Type: application/json

{
    "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response:**
```json
{
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "expiresIn": 3600
}
```

### Authorization Header

All authenticated requests must include:

```http
Authorization: Bearer <accessToken>
```

---

## REST API Endpoints

### User Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/user/profile` | Get current user profile |
| PUT | `/api/v1/user/profile` | Update user profile |
| GET | `/api/v1/user/communities` | List user's communities |

### Community Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/communities` | List available communities |
| GET | `/api/v1/communities/{id}` | Get community details |
| GET | `/api/v1/communities/{id}/members` | List community members |
| GET | `/api/v1/communities/{id}/channels` | List community channels |

### Example: Get Community Members

**Request:**
```http
GET /api/v1/communities/comm-456/members?page=1&limit=20
Authorization: Bearer <accessToken>
```

**Response:**
```json
{
    "members": [
        {
            "id": "user-123",
            "username": "johndoe",
            "avatarUrl": "https://...",
            "role": "admin",
            "joinedAt": "2024-01-15T10:30:00Z"
        }
    ],
    "pagination": {
        "page": 1,
        "limit": 20,
        "total": 45,
        "totalPages": 3
    }
}
```

---

## WebSocket Events

### Connection

Connect to WebSocket with authentication token:

**Android (Socket.io):**
```kotlin
val options = IO.Options().apply {
    auth = mapOf("token" to authToken)
    transports = arrayOf("websocket")
}
socket = IO.socket(URI.create(baseUrl), options)
socket.connect()
```

**iOS (Native WebSocket):**
```swift
var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: true)!
components.queryItems = [
    URLQueryItem(name: "EIO", value: "4"),
    URLQueryItem(name: "transport", value: "websocket"),
    URLQueryItem(name: "token", value: token)
]
webSocketTask = session.webSocketTask(with: components.url!)
webSocketTask.resume()
```

### Chat Events

#### Join Channel

Join a chat channel to receive messages.

**Emit:**
```json
Event: "chat:join"
Payload: {
    "communityId": "comm-456",
    "channelName": "general"
}
```

#### Send Message

Send a message to the channel.

**Emit:**
```json
Event: "chat:message"
Payload: {
    "communityId": "comm-456",
    "channelName": "general",
    "content": "Hello everyone!",
    "type": "text"
}
```

**Receive:**
```json
Event: "chat:message"
Payload: {
    "id": "msg-789",
    "communityId": "comm-456",
    "senderId": "user-123",
    "senderUsername": "johndoe",
    "senderAvatarUrl": "https://...",
    "content": "Hello everyone!",
    "type": "text",
    "createdAt": "2024-01-20T14:30:00.000Z"
}
```

#### Typing Indicator

Notify when user is typing.

**Emit:**
```json
Event: "chat:typing"
Payload: {
    "communityId": "comm-456",
    "channelName": "general",
    "isTyping": true
}
```

**Receive:**
```json
Event: "chat:typing"
Payload: {
    "communityId": "comm-456",
    "channelName": "general",
    "userId": "user-123",
    "username": "johndoe",
    "isTyping": true
}
```

#### Request History

Fetch previous messages for pagination.

**Emit:**
```json
Event: "chat:history"
Payload: {
    "communityId": "comm-456",
    "channelName": "general",
    "limit": 50,
    "before": "2024-01-20T14:00:00.000Z"
}
```

**Receive:**
```json
Event: "chat:history"
Payload: {
    "messages": [
        {
            "id": "msg-788",
            "communityId": "comm-456",
            "senderId": "user-456",
            "senderUsername": "janedoe",
            "senderAvatarUrl": null,
            "content": "Hi there!",
            "type": "text",
            "createdAt": "2024-01-20T13:55:00.000Z"
        }
    ]
}
```

---

## Event Summary Table

| Event | Direction | Description |
|-------|-----------|-------------|
| `chat:join` | Client -> Server | Join a chat channel |
| `chat:message` | Bidirectional | Send/receive chat messages |
| `chat:typing` | Bidirectional | Typing indicator |
| `chat:history` | Client -> Server (request), Server -> Client (response) | Fetch message history |

---

## Error Handling

### HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Process response |
| 400 | Bad Request | Show validation error |
| 401 | Unauthorized | Refresh token or re-login |
| 403 | Forbidden | Show permission error |
| 404 | Not Found | Show not found message |
| 429 | Rate Limited | Implement backoff |
| 500 | Server Error | Show generic error, retry |

### WebSocket Error Handling

```
Connection Lost
      |
      v
Attempt Reconnection (1-5 attempts)
      |
      +---> Success: Rejoin channels
      |
      +---> Failure: Show error, allow manual retry
```

### Error Response Format

```json
{
    "error": {
        "code": "INVALID_TOKEN",
        "message": "The authentication token has expired",
        "details": {}
    }
}
```

---

## Message Types

| Type | Description |
|------|-------------|
| `text` | Plain text message |
| `image` | Image attachment |
| `file` | File attachment |
| `system` | System notification |

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| REST API | 100 requests/minute |
| WebSocket messages | 30 messages/minute |
| Chat history | 10 requests/minute |

---

## Implementation Examples

### Android: Sending a Message

```kotlin
fun sendMessage(communityId: String, channelName: String, content: String) {
    if (connectionState.value != ConnectionState.CONNECTED) {
        emitError(WebSocketError.NotConnected)
        return
    }

    val payload = JSONObject().apply {
        put("communityId", communityId)
        put("channelName", channelName)
        put("content", content)
        put("type", "text")
    }

    socket?.emit("chat:message", payload)
}
```

### iOS: Receiving Messages

```swift
webSocketManager.incomingMessages
    .receive(on: DispatchQueue.main)
    .sink { [weak self] message in
        self?.messages.append(message)
    }
    .store(in: &cancellables)
```

---

## Security Considerations

1. **Token Storage**: Store tokens securely (Keychain on iOS, EncryptedSharedPreferences on Android)
2. **Token Refresh**: Implement automatic token refresh before expiration
3. **TLS**: All connections use TLS 1.2+
4. **Input Validation**: Validate all user input before sending
5. **Certificate Pinning**: Consider for production builds

---

*For architecture details, see [Architecture](architecture.md)*
