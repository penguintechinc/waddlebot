# Router Module Usage Guide

## Overview

This guide provides practical examples and workflows for using the Router Module in various scenarios.

**Version:** 2.0.0

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Basic Operations](#basic-operations)
3. [Command Processing](#command-processing)
4. [Translation Features](#translation-features)
5. [Workflow Integration](#workflow-integration)
6. [Rate Limiting](#rate-limiting)
7. [Activity Tracking](#activity-tracking)
8. [Advanced Usage](#advanced-usage)

---

## Getting Started

### Running Locally

```bash
# 1. Set up environment
cd /home/penguin/code/WaddleBot/processing/router_module
cp .env.example .env
# Edit .env with your configuration

# 2. Install dependencies
pip install -r requirements.txt

# 3. Install flask_core library
cd ../../libs/flask_core
pip install -e .
cd ../../processing/router_module

# 4. Run the module
python app.py
```

### Running with Docker

```bash
# Build image
docker build -f processing/router_module/Dockerfile \
  -t waddlebot/router:latest .

# Run container
docker run -d \
  --name router-module \
  -p 8000:8000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  -e REDIS_HOST="redis" \
  -e REDIS_PORT="6379" \
  waddlebot/router:latest
```

### Health Check

```bash
# Check if module is running
curl http://localhost:8000/health

# Expected response:
# {
#   "success": true,
#   "data": {
#     "status": "healthy",
#     "module": "router_module",
#     "version": "2.0.0"
#   }
# }
```

---

## Basic Operations

### Processing a Single Event

```bash
# POST /api/v1/router/events
curl -X POST http://localhost:8000/api/v1/router/events \
  -H "Content-Type: application/json" \
  -H "X-Service-Key: your-api-key" \
  -d '{
    "platform": "twitch",
    "channel_id": "12345",
    "user_id": "67890",
    "username": "penguin_user",
    "message": "!help"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "session_id": "sess_abc123def456...",
    "command": "!help",
    "module": "core_commands",
    "processed": true,
    "response": {
      "content": "Available commands: !help, !stats, !balance, !inventory...",
      "type": "message"
    }
  }
}
```

### Processing Batch Events

```bash
# POST /api/v1/router/events/batch
curl -X POST http://localhost:8000/api/v1/router/events/batch \
  -H "Content-Type: application/json" \
  -H "X-Service-Key: your-api-key" \
  -d '{
    "events": [
      {
        "platform": "twitch",
        "channel_id": "12345",
        "user_id": "user1",
        "username": "user1",
        "message": "!balance"
      },
      {
        "platform": "discord",
        "channel_id": "98765",
        "user_id": "user2",
        "username": "user2",
        "message": "!stats"
      }
    ]
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "success": true,
        "session_id": "sess_abc123...",
        "command": "!balance",
        "response": {"content": "Your balance: 1,234 coins"}
      },
      {
        "success": true,
        "session_id": "sess_def456...",
        "command": "!stats",
        "response": {"content": "Your stats: 100 messages, 50 hours watched"}
      }
    ],
    "count": 2
  }
}
```

### Listing Available Commands

```bash
# GET /api/v1/router/commands
curl http://localhost:8000/api/v1/router/commands

# Filter by community
curl "http://localhost:8000/api/v1/router/commands?community_id=123"

# Filter by category
curl "http://localhost:8000/api/v1/router/commands?category=fun"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "command": "!help",
      "module_name": "core_commands",
      "description": "Show available commands",
      "usage": "!help [command]",
      "category": "general",
      "permission_level": "everyone",
      "is_enabled": true,
      "cooldown_seconds": 5
    }
  ]
}
```

---

## Command Processing

### Command Execution Flow

#### 1. Chat Message with Command

```python
import aiohttp

async def send_chat_command():
    event = {
        "platform": "twitch",
        "channel_id": "12345",
        "user_id": "67890",
        "username": "penguin_user",
        "message": "!balance",
        "metadata": {
            "display_name": "Penguin User",
            "badges": ["subscriber"]
        }
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(
            "http://router-module:8000/api/v1/router/events",
            json=event,
            headers={"X-Service-Key": "your-api-key"}
        ) as resp:
            result = await resp.json()
            print(f"Balance: {result['data']['response']['content']}")
```

#### 2. Discord Slash Command

```python
async def send_slash_command():
    event = {
        "platform": "discord",
        "channel_id": "discord-channel-id",
        "user_id": "discord-user-id",
        "username": "penguin_user",
        "message": "/help stats",
        "message_type": "slashCommand",
        "metadata": {
            "command_name": "help",
            "options": {"topic": "stats"},
            "interaction_id": "interaction-id",
            "interaction_token": "interaction-token"
        }
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(
            "http://router-module:8000/api/v1/router/events",
            json=event,
            headers={"X-Service-Key": "your-api-key"}
        ) as resp:
            result = await resp.json()
            # Result includes interaction_id for deferred response
            print(result)
```

#### 3. Interaction (Button Click)

```python
async def send_button_interaction():
    event = {
        "platform": "discord",
        "channel_id": "discord-channel-id",
        "user_id": "discord-user-id",
        "username": "penguin_user",
        "message": "",
        "message_type": "button_click",
        "metadata": {
            "custom_id": "inventory:buy:item_123",
            "interaction_id": "interaction-id",
            "interaction_token": "interaction-token"
        }
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(
            "http://router-module:8000/api/v1/router/events",
            json=event,
            headers={"X-Service-Key": "your-api-key"}
        ) as resp:
            result = await resp.json()
            # Router parses custom_id and routes to inventory module
            print(f"Module: {result['data']['module']}")
            print(f"Action: {result['data']['action']}")
            print(f"Context: {result['data']['context']}")
```

### Command with Arguments

```bash
# Command: !give @user 100 coins
curl -X POST http://localhost:8000/api/v1/router/events \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "twitch",
    "channel_id": "12345",
    "user_id": "67890",
    "username": "moderator",
    "message": "!give @penguin_user 100 coins"
  }'
```

**Router parses:**
- Command: `!give`
- Args: `@penguin_user 100 coins`
- Sends to economy module for processing

---

## Translation Features

### Enabling Translation for a Community

```sql
-- Update community config to enable translation
UPDATE communities
SET config = jsonb_set(
  COALESCE(config, '{}'::jsonb),
  '{translation}',
  '{
    "enabled": true,
    "default_language": "en",
    "min_words": 5,
    "confidence_threshold": 0.7,
    "preprocessing": {
      "preserve_mentions": true,
      "preserve_commands": true,
      "preserve_emails": true,
      "preserve_urls": true,
      "preserve_emotes": true
    }
  }'::jsonb
)
WHERE id = 123;
```

### Translation Workflow

#### 1. Send Message (Non-English)

```bash
curl -X POST http://localhost:8000/api/v1/router/events \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "twitch",
    "channel_id": "12345",
    "user_id": "67890",
    "username": "spanish_user",
    "message": "Hola @penguin_user, mira este link https://example.com y usa !help"
  }'
```

**Router Processing:**
1. Detects Spanish (`es`) with confidence 0.95
2. Preserves tokens: `@penguin_user`, `https://example.com`, `!help`
3. Translates: "Hola, mira este link y usa" → "Hello, check out this link and use"
4. Restores tokens: "Hello @penguin_user, check out this link https://example.com and use !help"
5. Sends caption to browser source overlay
6. Updates event metadata with translation

**Response includes translation:**
```json
{
  "success": true,
  "data": {
    "session_id": "sess_abc123...",
    "processed": true,
    "metadata": {
      "translation": {
        "translated_text": "Hello @penguin_user, check out this link https://example.com and use !help",
        "detected_lang": "es",
        "target_lang": "en",
        "confidence": 0.95,
        "provider": "googletrans",
        "tokens_preserved": 3
      },
      "original_message": "Hola @penguin_user, mira este link https://example.com y usa !help"
    }
  }
}
```

#### 2. Translation with Emotes

```bash
# Message with Twitch emotes
curl -X POST http://localhost:8000/api/v1/router/events \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "twitch",
    "channel_id": "12345",
    "user_id": "67890",
    "username": "emote_user",
    "message": "Hola Kappa esto es genial PogChamp"
  }'
```

**Processing:**
1. Detects emotes: `Kappa`, `PogChamp`
2. Replaces with placeholders: "Hola __TOKEN_0__ esto es genial __TOKEN_1__"
3. Translates: "Hola esto es genial" → "Hello this is great"
4. Restores emotes: "Hello Kappa this is great PogChamp"

#### 3. Skip Conditions

**Message too short (< 5 words):**
```bash
# This will NOT be translated
curl -X POST http://localhost:8000/api/v1/router/events \
  -d '{"message": "Hola amigo"}'
# Only 2 words, below min_words threshold
```

**Already in target language:**
```bash
# This will NOT be translated
curl -X POST http://localhost:8000/api/v1/router/events \
  -d '{"message": "Hello world this is a test"}'
# Detected as 'en', same as target language
```

**Low confidence:**
```bash
# This will NOT be translated if confidence < 0.7
curl -X POST http://localhost:8000/api/v1/router/events \
  -d '{"message": "asdfgh qwerty zxcvbn"}'
# Unrecognizable language, low confidence
```

---

## Workflow Integration

### Triggering a Workflow from Command

#### 1. Create Workflow Trigger

```sql
INSERT INTO workflows (
  community_id,
  entity_id,
  trigger_type,
  trigger_config,
  status,
  is_active
) VALUES (
  123,
  '12345',
  'command',
  '{"command": "!giveaway"}'::jsonb,
  'published',
  true
);
```

#### 2. Execute Command

```bash
curl -X POST http://localhost:8000/api/v1/router/events \
  -d '{
    "platform": "twitch",
    "channel_id": "12345",
    "user_id": "67890",
    "username": "streamer",
    "message": "!giveaway"
  }'
```

**Router Flow:**
1. Process command normally
2. Check for workflow triggers matching `!giveaway`
3. Trigger workflow via gRPC/HTTP
4. Pass event data as trigger context

### Triggering Workflow from Event

```sql
-- Create workflow triggered by subscription events
INSERT INTO workflows (
  community_id,
  entity_id,
  trigger_type,
  trigger_config,
  status,
  is_active
) VALUES (
  123,
  '12345',
  'event',
  '{"event_type": "subscription"}'::jsonb,
  'published',
  true
);
```

**Router automatically triggers workflow on subscription events:**
```bash
curl -X POST http://localhost:8000/api/v1/router/events \
  -d '{
    "platform": "twitch",
    "channel_id": "12345",
    "user_id": "67890",
    "username": "new_subscriber",
    "message": "",
    "message_type": "subscription",
    "metadata": {
      "tier": "1000",
      "is_gift": false
    }
  }'
```

---

## Rate Limiting

### Default Rate Limits

- **Commands:** 60 requests per 60 seconds per `user_id:command`
- **Module Calls:** 30 seconds timeout

### Testing Rate Limits

```python
import asyncio
import aiohttp

async def test_rate_limit():
    event = {
        "platform": "twitch",
        "channel_id": "12345",
        "user_id": "67890",
        "username": "spam_user",
        "message": "!balance"
    }

    async with aiohttp.ClientSession() as session:
        # Send 65 requests rapidly
        tasks = []
        for i in range(65):
            tasks.append(
                session.post(
                    "http://localhost:8000/api/v1/router/events",
                    json=event
                )
            )

        responses = await asyncio.gather(*tasks)

        success_count = 0
        rate_limited_count = 0

        for resp in responses:
            data = await resp.json()
            if data.get('success'):
                success_count += 1
            elif 'rate limit' in data.get('error', '').lower():
                rate_limited_count += 1

        print(f"Success: {success_count}")
        print(f"Rate Limited: {rate_limited_count}")
        # Expected: ~60 success, ~5 rate limited
```

### Custom Command Cooldowns

```sql
-- Set custom cooldown for specific command
UPDATE commands
SET cooldown_seconds = 30
WHERE command = '!daily'
  AND community_id = 123;
```

**User can only use `!daily` once every 30 seconds.**

---

## Activity Tracking

### Message Activity Tracking

Every chat message is automatically tracked for leaderboards:

```bash
curl -X POST http://localhost:8000/api/v1/router/events \
  -d '{
    "platform": "twitch",
    "channel_id": "12345",
    "user_id": "67890",
    "username": "active_user",
    "message": "Hello everyone!"
  }'
```

**Router sends to Hub module:**
- `community_id`: 123
- `platform`: "twitch"
- `platform_user_id`: "67890"
- `platform_username`: "active_user"
- `channel_id`: "12345"

**Hub tracks:**
- Message count
- Last message timestamp
- Activity streaks

### Stream Event Tracking

```bash
# New subscription
curl -X POST http://localhost:8000/api/v1/router/events \
  -d '{
    "platform": "twitch",
    "channel_id": "12345",
    "user_id": "67890",
    "username": "new_subscriber",
    "message": "",
    "message_type": "subscription",
    "metadata": {
      "tier": "1000",
      "is_gift": false
    }
  }'

# Channel raid
curl -X POST http://localhost:8000/api/v1/router/events \
  -d '{
    "platform": "twitch",
    "channel_id": "12345",
    "user_id": "raider_id",
    "username": "raider_username",
    "message": "",
    "message_type": "raid",
    "metadata": {
      "viewer_count": 50
    }
  }'
```

**Router tracks all events in Hub module for analytics.**

---

## Advanced Usage

### Using Python Client

```python
import aiohttp
from typing import Dict, Optional

class RouterClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.api_key = api_key
        self.session = None

    async def __aenter__(self):
        self.session = aiohttp.ClientSession(
            headers={"X-Service-Key": self.api_key}
        )
        return self

    async def __aexit__(self, *args):
        await self.session.close()

    async def process_event(self, event: Dict) -> Dict:
        """Process single event."""
        async with self.session.post(
            f"{self.base_url}/api/v1/router/events",
            json=event
        ) as resp:
            return await resp.json()

    async def process_batch(self, events: list) -> Dict:
        """Process batch of events."""
        async with self.session.post(
            f"{self.base_url}/api/v1/router/events/batch",
            json={"events": events}
        ) as resp:
            return await resp.json()

    async def list_commands(
        self,
        community_id: Optional[int] = None,
        category: Optional[str] = None
    ) -> Dict:
        """List available commands."""
        params = {}
        if community_id:
            params['community_id'] = community_id
        if category:
            params['category'] = category

        async with self.session.get(
            f"{self.base_url}/api/v1/router/commands",
            params=params
        ) as resp:
            return await resp.json()


# Usage
async def main():
    async with RouterClient(
        "http://localhost:8000",
        "your-api-key"
    ) as client:
        # Process single event
        result = await client.process_event({
            "platform": "twitch",
            "channel_id": "12345",
            "user_id": "67890",
            "username": "user",
            "message": "!help"
        })
        print(result)

        # Process batch
        batch_result = await client.process_batch([
            {"platform": "twitch", "message": "!balance", ...},
            {"platform": "discord", "message": "!stats", ...}
        ])
        print(batch_result)

        # List commands
        commands = await client.list_commands(community_id=123)
        print(commands)
```

### Redis Streams Mode

#### Enable Streams Pipeline

```env
STREAM_PIPELINE_ENABLED=true
STREAM_BATCH_SIZE=10
STREAM_CONSUMER_COUNT=4
```

#### Publish to Stream

```python
from services.command_processor import CommandProcessor

# In command_processor.py
async def publish_command_result(result: Dict):
    if Config.STREAM_PIPELINE_ENABLED:
        await stream_pipeline.publish(
            Config.STREAM_ACTIONS,
            result
        )
```

#### Consume from Stream

Router automatically starts 4 consumer workers:
- `router-{pid}-0`
- `router-{pid}-1`
- `router-{pid}-2`
- `router-{pid}-3`

**Each consumer:**
1. Reads from `waddlebot:stream:events:inbound`
2. Processes events
3. Acknowledges or moves to DLQ on failure

### gRPC Communication

#### Call Hub Module via gRPC

```python
from services.grpc_clients import get_grpc_manager

async def record_message_via_grpc(event_data: Dict):
    grpc_manager = get_grpc_manager()

    # Get channel
    channel = await grpc_manager.get_channel('hub_internal')

    # Create stub
    from hub_internal_pb2_grpc import HubInternalServiceStub
    stub = HubInternalServiceStub(channel)

    # Build request
    from hub_internal_pb2 import RecordMessageRequest
    request = RecordMessageRequest(
        token=grpc_manager.generate_token(),
        community_id=123,
        platform="twitch",
        platform_user_id="67890",
        platform_username="user",
        channel_id="12345",
        message_content="Hello world"
    )

    # Call with retry
    response = await grpc_manager.call_with_retry(
        stub.RecordMessage,
        request,
        timeout=5.0
    )

    print(response)
```

### Custom Translation Provider

```python
from services.translation_providers.base_provider import TranslationProvider, TranslationResult

class CustomProvider(TranslationProvider):
    def __init__(self, api_key: str):
        self.api_key = api_key

    async def translate(
        self,
        text: str,
        target_lang: str,
        source_lang: str = "auto"
    ) -> TranslationResult:
        # Call your custom translation API
        translated = await self._call_api(text, target_lang)

        return TranslationResult(
            translated_text=translated,
            detected_lang=source_lang,
            target_lang=target_lang,
            confidence=0.9,
            provider="custom"
        )

    async def detect_language(self, text: str) -> tuple[str, float]:
        # Detect language
        lang = await self._detect_api(text)
        return lang, 0.9

    async def health_check(self) -> bool:
        # Check if API is available
        return True

# Register provider in translation_service.py
self._providers['custom'] = CustomProvider(api_key)
```

---

## Performance Monitoring

### Get Router Metrics

```bash
curl http://localhost:8000/api/v1/router/metrics
```

**Response:**
```json
{
  "success": true,
  "data": {
    "requests_processed": 12345,
    "avg_response_time_ms": 45.2,
    "cache_hit_rate": 0.85
  }
}
```

### Prometheus Metrics

```bash
curl http://localhost:8000/metrics
```

**Example metrics:**
```text
# HELP router_requests_total Total number of requests
# TYPE router_requests_total counter
router_requests_total{status="success"} 10000
router_requests_total{status="error"} 50

# HELP router_request_duration_seconds Request duration
# TYPE router_request_duration_seconds histogram
router_request_duration_seconds_bucket{le="0.1"} 9500
router_request_duration_seconds_bucket{le="0.5"} 9950

# HELP router_cache_hits_total Cache hits
# TYPE router_cache_hits_total counter
router_cache_hits_total{cache="memory"} 5000
router_cache_hits_total{cache="redis"} 3000
router_cache_hits_total{cache="database"} 500
```

---

## Common Workflows

### 1. New User Sends First Message

```
User sends message
  ↓
Router receives event
  ↓
Create session ID
  ↓
Record message activity (Hub)
  ↓
Record reputation event (Reputation)
  ↓
Translate message (if enabled)
  ↓
Send caption to overlay (Browser Source)
  ↓
Return success response
```

### 2. User Executes Command

```
User sends "!balance"
  ↓
Router receives event
  ↓
Parse command
  ↓
Rate limit check (60/60s)
  ↓
Lookup command in registry
  ↓
Check module enabled
  ↓
Check command cooldown
  ↓
Execute via HTTP/gRPC
  ↓
Store response in cache
  ↓
Record activity (Hub)
  ↓
Record reputation (Reputation)
  ↓
Check workflow triggers
  ↓
Return response
```

### 3. Streamer Starts Stream

```
Stream goes online
  ↓
Router receives stream_online event
  ↓
Record stream activity (Hub)
  ↓
Check workflow triggers
  ↓
Execute "stream_start" workflows
  ↓
Return success
```

---

## See Also

- [API.md](./API.md) - Complete API reference
- [CONFIGURATION.md](./CONFIGURATION.md) - Configuration options
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
- [TESTING.md](./TESTING.md) - Testing guide
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues
