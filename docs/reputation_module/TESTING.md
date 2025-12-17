# Reputation Module - Testing Guide

## Unit Tests

```python
import pytest
from services.reputation_service import ReputationService

@pytest.mark.asyncio
async def test_reputation_calculation():
    """Test basic reputation calculation."""
    service = ReputationService(dal, weight_manager, logger)

    result = await service.adjust(
        community_id=123,
        user_id=456,
        event_type='subscription',
        platform='twitch',
        platform_user_id='12345'
    )

    assert result.success is True
    assert result.score_after > result.score_before
    assert result.score_change == 5.0  # default subscription weight

@pytest.mark.asyncio
async def test_tier_calculation():
    """Test tier assignment."""
    service = ReputationService(dal, weight_manager, logger)

    tier, label = service._get_tier(650)
    assert tier == 'fair'
    assert label == 'Fair'

    tier, label = service._get_tier(800)
    assert tier == 'exceptional'

@pytest.mark.asyncio
async def test_score_clamping():
    """Test score stays within bounds."""
    service = ReputationService(dal, weight_manager, logger)

    # Test max clamp
    clamped = service._clamp_score(900, 300, 850)
    assert clamped == 850

    # Test min clamp
    clamped = service._clamp_score(250, 300, 850)
    assert clamped == 300
```

## Integration Tests

```python
@pytest.mark.asyncio
async def test_event_processing(client):
    """Test event processing endpoint."""
    response = await client.post(
        '/api/v1/internal/events',
        json={
            'community_id': 123,
            'user_id': 456,
            'event_type': 'subscription',
            'platform': 'twitch',
            'platform_user_id': '12345'
        },
        headers={'X-Service-Key': 'test-key'}
    )

    assert response.status_code == 200
    data = await response.get_json()
    assert data['data']['processed'] == 1

@pytest.mark.asyncio
async def test_batch_processing(client):
    """Test batch event processing."""
    events = [
        {'community_id': 123, 'event_type': 'chatMessage', 'user_id': 456},
        {'community_id': 123, 'event_type': 'follow', 'user_id': 456}
    ]

    response = await client.post(
        '/api/v1/internal/events',
        json={'events': events},
        headers={'X-Service-Key': 'test-key'}
    )

    data = await response.get_json()
    assert data['data']['total'] == 2
    assert data['data']['processed'] == 2
```

## Load Testing

```python
import asyncio
import aiohttp

async def load_test_event_processing(num_events=1000):
    """Load test event processing."""
    async with aiohttp.ClientSession() as session:
        tasks = []
        for i in range(num_events):
            task = session.post(
                'http://localhost:8021/api/v1/internal/events',
                json={
                    'community_id': 123,
                    'user_id': i,
                    'event_type': 'chatMessage',
                    'platform': 'twitch',
                    'platform_user_id': str(i)
                },
                headers={'X-Service-Key': 'test-key'}
            )
            tasks.append(task)

        results = await asyncio.gather(*tasks)
        success = sum(1 for r in results if r.status == 200)
        print(f"Processed {success}/{num_events} events")

asyncio.run(load_test_event_processing(1000))
```
