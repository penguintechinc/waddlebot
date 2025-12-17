# Reputation Module - API Documentation

## Overview

FICO-style automated reputation tracking system (300-850 range, default 600) with event-based scoring, global/community reputation, and auto-ban policies.

**Base URL**: `http://localhost:8021/api/v1`
**gRPC Port**: 50021
**Version**: 2.0.0

---

## Public API Endpoints

### Get User Reputation
```http
GET /reputation/{community_id}/user/{user_id}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "community_id": 123,
    "user_id": 456,
    "score": 650,
    "tier": "fair",
    "tier_label": "Fair",
    "total_events": 142,
    "last_event_at": "2025-01-15T12:00:00Z"
  }
}
```

### Get User History
```http
GET /reputation/{community_id}/user/{user_id}/history?limit=50&offset=0
```

**Response**:
```json
{
  "success": true,
  "data": {
    "events": [
      {
        "id": 1,
        "event_type": "subscription",
        "score_change": 5.0,
        "score_before": 645,
        "score_after": 650,
        "reason": "User subscribed",
        "created_at": "2025-01-15T12:00:00Z",
        "metadata": {"tier": 1}
      }
    ]
  }
}
```

### Get Leaderboard
```http
GET /reputation/{community_id}/leaderboard?limit=25&offset=0
```

### Get Global Reputation
```http
GET /reputation/global/{user_id}
```

### Get Reputation Tiers
```http
GET /reputation/tiers
```

**Response**:
```json
{
  "success": true,
  "data": {
    "tiers": {
      "exceptional": {"min": 800, "max": 850, "label": "Exceptional"},
      "very_good": {"min": 740, "max": 799, "label": "Very Good"},
      "good": {"min": 670, "max": 739, "label": "Good"},
      "fair": {"min": 580, "max": 669, "label": "Fair"},
      "poor": {"min": 300, "max": 579, "label": "Poor"}
    },
    "min_score": 300,
    "max_score": 850,
    "default_score": 600
  }
}
```

### Get Weight Configuration
```http
GET /reputation/weights/{community_id}
```

---

## Internal API (Service-to-Service)

### Process Events
```http
POST /api/v1/internal/events
Headers: X-Service-Key: <service_key>
```

**Request (Single)**:
```json
{
  "community_id": 123,
  "user_id": 456,
  "platform": "twitch",
  "platform_user_id": "12345",
  "event_type": "subscription",
  "metadata": {"tier": 1}
}
```

**Request (Batch)**:
```json
{
  "events": [
    {"community_id": 123, "event_type": "chatMessage", ...},
    {"community_id": 123, "event_type": "follow", ...}
  ]
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "total": 10,
    "processed": 9,
    "skipped": 0,
    "failed": 1
  }
}
```

### Quick Check
```http
GET /api/v1/internal/check/{community_id}/{user_id}
Headers: X-Service-Key: <service_key>
```

### Process Moderation
```http
POST /api/v1/internal/moderation
Headers: X-Service-Key: <service_key>
```

---

## Admin API

### Set Reputation Manually
```http
PUT /api/v1/admin/{community_id}/reputation/{user_id}
```

**Request**:
```json
{
  "score": 700,
  "reason": "Manual adjustment",
  "admin_id": 789
}
```

### Get/Update Configuration
```http
GET /api/v1/admin/{community_id}/reputation/config
PUT /api/v1/admin/{community_id}/reputation/config
```

**Update Request**:
```json
{
  "admin_id": 789,
  "weights": {
    "chat_message": 0.02,
    "subscription": 10.0
  },
  "policy": {
    "auto_ban_enabled": true,
    "auto_ban_threshold": 450
  }
}
```

### Get At-Risk Users
```http
GET /api/v1/admin/{community_id}/reputation/at-risk?buffer=50
```

### Toggle Auto-Ban
```http
POST /api/v1/admin/{community_id}/reputation/auto-ban
```

---

## Event Types

### Positive Events
- `chatMessage`: +0.01
- `follow`: +1.0
- `subscription`: +5.0
- `subscription_tier2`: +10.0
- `subscription_tier3`: +20.0
- `gift_subscription`: +3.0
- `donation_per_dollar`: +1.0/dollar
- `cheer_per_100bits`: +1.0/100 bits
- `raid`: +2.0
- `boost`: +5.0

### Negative Events (Moderation)
- `warn`: -25.0
- `timeout`: -50.0
- `kick`: -75.0
- `ban`: -200.0
- `giveaway_entry`: -1.0 (anti-bot)
- `command_usage`: -0.1 (prevent spam)

---

## Weight Customization (Premium Only)

Non-premium communities use default weights. Premium communities can customize:

```json
{
  "chat_message": 0.01,
  "command_usage": -0.1,
  "follow": 1.0,
  "subscription": 5.0,
  "warn": -25.0,
  "timeout": -50.0,
  "ban": -200.0
}
```
