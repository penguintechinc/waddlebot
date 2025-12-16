# WaddleBot Marketplace SDK

This guide explains how to create marketplace modules that integrate with WaddleBot
via webhooks. Your module can be hosted on AWS Lambda, Google Cloud Run, OpenWhisk,
or any HTTP endpoint.

## Quick Start

1. Create a webhook endpoint that accepts POST requests
2. Submit your module via the WaddleBot Marketplace seller portal
3. Wait for global admin approval
4. Communities can subscribe and use your module

## Webhook Payload

When your module is triggered, WaddleBot sends a POST request with this payload:

```json
{
  "community": {
    "id": 123,
    "name": "AwesomeStreamers",
    "is_subscribed": true,
    "subscription_order_id": "ord_abc123",
    "seat_count": 45
  },
  "trigger": {
    "type": "command",
    "command": "#weather",
    "context_text": "London UK",
    "event_type": null,
    "event_data": null
  },
  "user": {
    "id": "user_456",
    "username": "CoolViewer",
    "platform": "twitch",
    "platform_user_id": "12345678"
  },
  "entity": {
    "id": "entity_789",
    "platform": "twitch",
    "platform_entity_id": "channel123"
  },
  "request_id": "req_xyz789",
  "timestamp": "2025-12-15T10:30:00Z"
}
```

## Expected Response

Your endpoint must return JSON within the configured timeout (default 5s, max 30s):

```json
{
  "success": true,
  "response_type": "text",
  "message": "Weather in London: 12°C, Cloudy",
  "overlay_data": null,
  "browser_source_url": null,
  "targets": ["platform"]
}
```

### Response Types
- `text` - Send a chat message (include `message` field)
- `overlay` - Update an overlay (include `overlay_data` field)
- `browser_source` - Trigger browser source (include `browser_source_url` field)
- `none` - No visible response (silent processing)

### Targets
- `platform` - Send to the originating platform chat
- `overlay` - Send to community overlays
- `hub` - Send to community Hub dashboard

## Verifying Webhook Signatures

All requests include an HMAC-SHA256 signature in the `X-WaddleBot-Signature` header:

```python
import hmac
import hashlib

def verify_signature(payload: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(
        secret.encode(),
        payload,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)
```

## Platform Examples

### AWS Lambda (Python)

```python
import json
import hmac
import hashlib

def lambda_handler(event, context):
    # Parse body
    body = json.loads(event['body'])

    # Verify signature (recommended)
    # signature = event['headers'].get('X-WaddleBot-Signature')
    # verify_signature(event['body'].encode(), signature, YOUR_SECRET)

    # Check subscription
    if not body['community']['is_subscribed']:
        return {
            'statusCode': 200,
            'body': json.dumps({
                'success': False,
                'message': 'Community not subscribed'
            })
        }

    # Handle command
    command = body['trigger']['command']
    context_text = body['trigger']['context_text']

    if command == '#weather':
        # Your logic here
        weather = get_weather(context_text)
        return {
            'statusCode': 200,
            'body': json.dumps({
                'success': True,
                'response_type': 'text',
                'message': f'Weather in {context_text}: {weather}',
                'targets': ['platform']
            })
        }

    return {
        'statusCode': 200,
        'body': json.dumps({'success': False, 'message': 'Unknown command'})
    }
```

### Google Cloud Run (Node.js)

```javascript
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

function verifySignature(payload, signature, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

app.post('/webhook', (req, res) => {
  const { community, trigger, user } = req.body;

  // Check subscription
  if (!community.is_subscribed) {
    return res.json({ success: false, message: 'Not subscribed' });
  }

  // Handle command
  if (trigger.command === '#translate') {
    const translated = translateText(trigger.context_text);
    return res.json({
      success: true,
      response_type: 'text',
      message: `Translation: ${translated}`,
      targets: ['platform']
    });
  }

  res.json({ success: false, message: 'Unknown command' });
});

app.listen(process.env.PORT || 8080);
```

### Apache OpenWhisk (Python)

```python
def main(args):
    community = args.get('community', {})
    trigger = args.get('trigger', {})

    if not community.get('is_subscribed'):
        return {'success': False, 'message': 'Not subscribed'}

    if trigger.get('command') == '#joke':
        joke = get_random_joke()
        return {
            'success': True,
            'response_type': 'text',
            'message': joke,
            'targets': ['platform']
        }

    return {'success': False, 'message': 'Unknown command'}
```

## Handling Events

For platform events (not commands), the payload includes event data:

```json
{
  "trigger": {
    "type": "event",
    "command": null,
    "context_text": null,
    "event_type": "twitch.subscription",
    "event_data": {
      "subscriber": "NewFollower123",
      "tier": "1000",
      "is_gift": false
    }
  }
}
```

## Error Handling

If your module fails, return:

```json
{
  "success": false,
  "error": "Description of what went wrong"
}
```

WaddleBot will not retry failed requests by default.

## Testing Your Module

Before submitting, test your webhook locally:

```bash
curl -X POST http://localhost:8080/webhook \
  -H "Content-Type: application/json" \
  -H "X-WaddleBot-Signature: sha256=test" \
  -d '{
    "community": {"id": 1, "name": "Test", "is_subscribed": true},
    "trigger": {"type": "command", "command": "#yourcommand", "context_text": "test"},
    "user": {"username": "tester", "platform": "twitch"},
    "request_id": "test123",
    "timestamp": "2025-01-01T00:00:00Z"
  }'
```

## Submission Checklist

- [ ] Webhook returns valid JSON responses
- [ ] Response time under 5 seconds
- [ ] Signature verification implemented
- [ ] Handles missing/invalid data gracefully
- [ ] Returns `success: false` for non-subscribed communities
- [ ] Documented all commands and expected responses
