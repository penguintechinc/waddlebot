# Browser Source Core Module - Testing Guide

## Unit Tests

### Test Overlay Key Validation

```python
import pytest
from services.overlay_service import OverlayService

@pytest.mark.asyncio
async def test_valid_overlay_key(dal):
    service = OverlayService(dal)

    # Create test key
    dal.executesql("""
        INSERT INTO community_overlay_tokens
        (community_id, overlay_key, is_active)
        VALUES (123, 'a1b2c3'*10 + '1234', true)
    """)

    result = await service.validate_overlay_key('a1b2c3'*10 + '1234')
    assert result is not None
    assert result['community_id'] == 123

@pytest.mark.asyncio
async def test_grace_period_key(dal):
    service = OverlayService(dal)

    # Create key with rotation
    dal.executesql("""
        INSERT INTO community_overlay_tokens
        (community_id, overlay_key, previous_key, rotated_at, is_active)
        VALUES (123, 'new_key'*10 + '1234', 'old_key'*10 + '1234',
                NOW() - INTERVAL '2 minutes', true)
    """)

    # Previous key should still work
    result = await service.validate_overlay_key('old_key'*10 + '1234')
    assert result is not None
    assert result.get('grace_period') is True
```

## Integration Tests

### WebSocket Connection Test

```python
import pytest
import websockets
import json

@pytest.mark.asyncio
async def test_websocket_caption_stream():
    overlay_key = 'test_key'*10 + '1234'

    # Connect
    uri = f"ws://localhost:8027/ws/captions/123?key={overlay_key}"
    async with websockets.connect(uri) as ws:
        # Should receive recent captions
        message = await ws.recv()
        data = json.loads(message)
        assert 'type' in data
        assert data['type'] == 'caption'

        # Test ping/pong
        await ws.send('ping')
        response = await ws.recv()
        assert response == 'pong'
```

### Caption Broadcast Test

```python
@pytest.mark.asyncio
async def test_caption_broadcast(client):
    caption_data = {
        'community_id': 123,
        'username': 'test_user',
        'original_message': 'Test',
        'translated_message': 'Prueba',
        'detected_language': 'en',
        'target_language': 'es',
        'confidence': 0.95
    }

    response = await client.post(
        '/api/v1/internal/captions',
        json=caption_data,
        headers={'X-Service-Key': 'test-key'}
    )

    assert response.status_code == 200
    data = await response.get_json()
    assert data['success'] is True
    assert data['data']['received'] is True
```

## Manual Testing

### Test Overlay Rendering

```bash
# Get overlay HTML
curl http://localhost:8027/overlay/YOUR_KEY > overlay.html

# Open in browser
open overlay.html

# Check for iframes
grep -c "<iframe" overlay.html
```

### Test Caption WebSocket

```javascript
// Run in browser console
const ws = new WebSocket('ws://localhost:8027/ws/captions/123?key=YOUR_KEY');

ws.onopen = () => console.log('Connected');
ws.onmessage = (e) => console.log('Received:', JSON.parse(e.data));
ws.onerror = (e) => console.error('Error:', e);
ws.onclose = () => console.log('Closed');

// Send test ping
ws.send('ping');
```

### Test gRPC Endpoints

```python
import grpc
from proto import browser_source_pb2, browser_source_pb2_grpc

channel = grpc.insecure_channel('localhost:50050')
stub = browser_source_pb2_grpc.BrowserSourceServiceStub(channel)

# Test key validation
request = browser_source_pb2.ValidateRequest(overlay_key='YOUR_KEY')
response = stub.ValidateOverlayKey(request)
print(f"Valid: {response.valid}, Community: {response.community_id}")
```

## Load Testing

### WebSocket Connection Load Test

```python
import asyncio
import websockets

async def connect_client(community_id, key, client_id):
    uri = f"ws://localhost:8027/ws/captions/{community_id}?key={key}"
    try:
        async with websockets.connect(uri) as ws:
            print(f"Client {client_id} connected")
            # Keep alive for 60 seconds
            await asyncio.sleep(60)
    except Exception as e:
        print(f"Client {client_id} error: {e}")

async def load_test_websockets(num_clients=100):
    tasks = [
        connect_client(123, 'YOUR_KEY', i)
        for i in range(num_clients)
    ]
    await asyncio.gather(*tasks)

asyncio.run(load_test_websockets(100))
```

### Caption Throughput Test

```python
import aiohttp
import asyncio
import time

async def send_caption(session, i):
    async with session.post(
        'http://localhost:8027/api/v1/internal/captions',
        json={
            'community_id': 123,
            'username': f'user_{i}',
            'original_message': f'Message {i}',
            'translated_message': f'Mensaje {i}',
            'detected_language': 'en',
            'target_language': 'es',
            'confidence': 0.9
        },
        headers={'X-Service-Key': 'test-key'}
    ) as resp:
        return resp.status

async def load_test_captions(num_captions=1000):
    start = time.time()
    async with aiohttp.ClientSession() as session:
        tasks = [send_caption(session, i) for i in range(num_captions)]
        results = await asyncio.gather(*tasks)

    duration = time.time() - start
    success = sum(1 for r in results if r == 200)
    print(f"Sent {success}/{num_captions} in {duration:.2f}s")
    print(f"Rate: {num_captions/duration:.2f} captions/sec")

asyncio.run(load_test_captions(1000))
```

## Performance Monitoring

```sql
-- Caption event rate
SELECT
    DATE_TRUNC('minute', created_at) as minute,
    COUNT(*) as caption_count
FROM caption_events
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY minute
ORDER BY minute DESC;

-- Access patterns
SELECT
    community_id,
    COUNT(*) as access_count,
    MAX(created_at) as last_access
FROM overlay_access_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY community_id;
```
