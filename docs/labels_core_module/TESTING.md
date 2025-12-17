# Labels Core Module - Testing Guide

## Test Environment Setup

### Prerequisites

```bash
# Python 3.9+
python --version

# PostgreSQL 13+
psql --version

# Install dependencies
cd core/labels_core_module
pip install -r requirements.txt
```

### Test Database Setup

```bash
# Create test database
createdb waddlebot_test

# Set test environment variable
export DATABASE_URL="postgresql://waddlebot:password@localhost:5432/waddlebot_test"
```

### Environment Configuration

Create `.env.test`:
```bash
MODULE_PORT=8024
DATABASE_URL=postgresql://waddlebot:password@localhost:5432/waddlebot_test
LOG_LEVEL=DEBUG
SECRET_KEY=test-secret-key
```

---

## Running Tests

### Manual API Testing

Start the module in test mode:
```bash
cd core/labels_core_module
python app.py
```

### cURL Test Suite

#### 1. Health Check Test
```bash
curl -X GET http://localhost:8023/health
# Expected: 200 OK with health status
```

#### 2. Create Label Test
```bash
curl -X POST http://localhost:8023/api/v1/labels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Label",
    "category": "user",
    "description": "Test label for automated testing",
    "color": "#ff0000",
    "icon": "test",
    "created_by": "test_user"
  }'
# Expected: 201 Created with label_id
```

#### 3. List Labels Test
```bash
curl -X GET "http://localhost:8023/api/v1/labels?category=user"
# Expected: 200 OK with labels array
```

#### 4. Get Specific Label Test
```bash
curl -X GET http://localhost:8023/api/v1/labels/1
# Expected: 200 OK with label details
```

#### 5. Update Label Test
```bash
curl -X PUT http://localhost:8023/api/v1/labels/1 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Test Label",
    "color": "#00ff00"
  }'
# Expected: 200 OK with success message
```

#### 6. Apply Label Test
```bash
curl -X POST http://localhost:8023/api/v1/labels/apply \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "test_user_123",
    "entity_type": "user",
    "label_id": 1,
    "applied_by": "test_admin"
  }'
# Expected: 201 Created with entity_label_id
```

#### 7. Get Entity Labels Test
```bash
curl -X GET http://localhost:8023/api/v1/entity/user/test_user_123/labels
# Expected: 200 OK with labels array
```

#### 8. Search By Labels Test
```bash
curl -X GET "http://localhost:8023/api/v1/labels/search?entity_type=user&labels=Test%20Label"
# Expected: 200 OK with search results
```

#### 9. Remove Label Test
```bash
curl -X POST http://localhost:8023/api/v1/labels/remove \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "test_user_123",
    "entity_type": "user",
    "label_id": 1
  }'
# Expected: 200 OK with success message
```

#### 10. Delete Label Test
```bash
curl -X DELETE http://localhost:8023/api/v1/labels/1
# Expected: 200 OK with success message
```

---

## Python Test Suite

### Unit Tests

Create `tests/test_labels.py`:

```python
import pytest
import asyncio
from app import app, dal

@pytest.fixture
async def client():
    """Create test client."""
    async with app.test_client() as client:
        yield client

@pytest.mark.asyncio
async def test_create_label(client):
    """Test label creation."""
    response = await client.post('/api/v1/labels', json={
        'name': 'Test Label',
        'category': 'user',
        'description': 'Test',
        'color': '#ff0000',
        'created_by': 'test'
    })
    assert response.status_code == 201
    data = await response.get_json()
    assert data['success'] is True
    assert 'label_id' in data['data']

@pytest.mark.asyncio
async def test_list_labels(client):
    """Test listing labels."""
    response = await client.get('/api/v1/labels')
    assert response.status_code == 200
    data = await response.get_json()
    assert data['success'] is True
    assert 'labels' in data['data']

@pytest.mark.asyncio
async def test_apply_label(client):
    """Test applying label to entity."""
    # First create a label
    create_resp = await client.post('/api/v1/labels', json={
        'name': 'Test Apply',
        'category': 'user',
        'created_by': 'test'
    })
    label_id = (await create_resp.get_json())['data']['label_id']

    # Apply the label
    response = await client.post('/api/v1/labels/apply', json={
        'entity_id': 'test_user',
        'entity_type': 'user',
        'label_id': label_id,
        'applied_by': 'test'
    })
    assert response.status_code == 201
    data = await response.get_json()
    assert data['success'] is True

@pytest.mark.asyncio
async def test_label_limit(client):
    """Test label limit enforcement."""
    # Create a label
    create_resp = await client.post('/api/v1/labels', json={
        'name': 'Limit Test',
        'category': 'user',
        'created_by': 'test'
    })
    label_id = (await create_resp.get_json())['data']['label_id']

    # Apply up to limit (5 for users)
    for i in range(5):
        resp = await client.post('/api/v1/labels/apply', json={
            'entity_id': 'limit_test_user',
            'entity_type': 'user',
            'label_id': label_id,
            'applied_by': 'test'
        })
        if i < 5:
            assert resp.status_code in [201, 409]  # 409 if duplicate

    # Try to exceed limit
    response = await client.post('/api/v1/labels/apply', json={
        'entity_id': 'limit_test_user',
        'entity_type': 'user',
        'label_id': label_id + 1,
        'applied_by': 'test'
    })
    # Should fail if we've hit the limit
    if response.status_code == 400:
        data = await response.get_json()
        assert 'maximum' in data['error'].lower()

@pytest.mark.asyncio
async def test_system_label_protection(client):
    """Test that system labels cannot be modified."""
    # Create system label directly in DB
    label_id = dal.labels.insert(
        name='System Label',
        category='user',
        is_system=True,
        created_by='system'
    )
    dal.commit()

    # Try to update
    response = await client.put(f'/api/v1/labels/{label_id}', json={
        'name': 'Modified System Label'
    })
    assert response.status_code == 403

    # Try to delete
    response = await client.delete(f'/api/v1/labels/{label_id}')
    assert response.status_code == 403

@pytest.mark.asyncio
async def test_bulk_apply(client):
    """Test bulk label application."""
    # Create label
    create_resp = await client.post('/api/v1/labels', json={
        'name': 'Bulk Test',
        'category': 'user',
        'created_by': 'test'
    })
    label_id = (await create_resp.get_json())['data']['label_id']

    # Bulk apply
    bulk_data = [
        {
            'entity_id': f'user_{i}',
            'entity_type': 'user',
            'label_id': label_id,
            'applied_by': 'test'
        }
        for i in range(10)
    ]

    response = await client.post('/api/v1/labels/apply', json=bulk_data)
    assert response.status_code == 200
    data = await response.get_json()
    assert data['data']['summary']['successful'] == 10

@pytest.mark.asyncio
async def test_search_labels(client):
    """Test label search functionality."""
    # Create test labels and apply them
    label1 = await client.post('/api/v1/labels', json={
        'name': 'Search Test 1',
        'category': 'user',
        'created_by': 'test'
    })
    lid1 = (await label1.get_json())['data']['label_id']

    await client.post('/api/v1/labels/apply', json={
        'entity_id': 'search_user_1',
        'entity_type': 'user',
        'label_id': lid1,
        'applied_by': 'test'
    })

    # Search
    response = await client.get('/api/v1/labels/search?entity_type=user&labels=Search%20Test%201')
    assert response.status_code == 200
    data = await response.get_json()
    assert len(data['data']['results']) > 0
```

### Run Unit Tests

```bash
pytest tests/test_labels.py -v
```

---

## Integration Tests

### Test Label Workflow

```python
import asyncio
import aiohttp

async def test_complete_workflow():
    """Test complete label lifecycle."""
    base_url = "http://localhost:8023/api/v1"

    async with aiohttp.ClientSession() as session:
        # 1. Create label
        async with session.post(f"{base_url}/labels", json={
            "name": "Workflow Test",
            "category": "user",
            "description": "Testing complete workflow",
            "color": "#0000ff",
            "created_by": "test"
        }) as resp:
            assert resp.status == 201
            result = await resp.json()
            label_id = result['data']['label_id']
            print(f"✓ Created label {label_id}")

        # 2. List labels
        async with session.get(f"{base_url}/labels") as resp:
            assert resp.status == 200
            result = await resp.json()
            assert len(result['data']['labels']) > 0
            print(f"✓ Listed {result['data']['total']} labels")

        # 3. Apply label
        async with session.post(f"{base_url}/labels/apply", json={
            "entity_id": "workflow_user",
            "entity_type": "user",
            "label_id": label_id,
            "applied_by": "test"
        }) as resp:
            assert resp.status == 201
            print("✓ Applied label to user")

        # 4. Get entity labels
        async with session.get(f"{base_url}/entity/user/workflow_user/labels") as resp:
            assert resp.status == 200
            result = await resp.json()
            assert len(result['data']['labels']) > 0
            print(f"✓ Retrieved {len(result['data']['labels'])} entity labels")

        # 5. Search by label
        async with session.get(
            f"{base_url}/labels/search",
            params={"entity_type": "user", "labels": "Workflow Test"}
        ) as resp:
            assert resp.status == 200
            result = await resp.json()
            print(f"✓ Search found {result['data']['total']} entities")

        # 6. Remove label
        async with session.post(f"{base_url}/labels/remove", json={
            "entity_id": "workflow_user",
            "entity_type": "user",
            "label_id": label_id
        }) as resp:
            assert resp.status == 200
            print("✓ Removed label from user")

        # 7. Delete label
        async with session.delete(f"{base_url}/labels/{label_id}") as resp:
            assert resp.status == 200
            print("✓ Deleted label")

        print("\n✓ Complete workflow test passed!")

asyncio.run(test_complete_workflow())
```

---

## Load Testing

### Simple Load Test

```python
import asyncio
import aiohttp
import time

async def load_test_create_labels(num_requests=100):
    """Load test label creation."""
    base_url = "http://localhost:8023/api/v1/labels"

    async def create_label(session, i):
        async with session.post(base_url, json={
            "name": f"Load Test {i}",
            "category": "user",
            "created_by": "load_test"
        }) as resp:
            return resp.status

    start = time.time()
    async with aiohttp.ClientSession() as session:
        tasks = [create_label(session, i) for i in range(num_requests)]
        results = await asyncio.gather(*tasks)

    duration = time.time() - start
    success_count = sum(1 for r in results if r == 201)

    print(f"Created {success_count}/{num_requests} labels in {duration:.2f}s")
    print(f"Rate: {num_requests/duration:.2f} requests/second")

asyncio.run(load_test_create_labels(100))
```

---

## Performance Testing

### Database Query Performance

```sql
-- Test label lookup performance
EXPLAIN ANALYZE
SELECT * FROM labels
WHERE category = 'user' AND is_active = true;

-- Test entity label join performance
EXPLAIN ANALYZE
SELECT el.*, l.name, l.color
FROM entity_labels el
JOIN labels l ON l.id = el.label_id
WHERE el.entity_id = 'test_user' AND el.entity_type = 'user';

-- Test search performance
EXPLAIN ANALYZE
SELECT el.entity_id, COUNT(*) as label_count
FROM entity_labels el
WHERE el.label_id IN (1, 2, 3)
AND el.entity_type = 'user'
AND el.is_active = true
GROUP BY el.entity_id;
```

---

## Test Coverage

### Coverage Report

```bash
# Install coverage
pip install pytest-cov

# Run tests with coverage
pytest tests/ --cov=app --cov-report=html

# View coverage report
open htmlcov/index.html
```

### Target Coverage

- **Overall**: > 80%
- **API endpoints**: > 90%
- **Database operations**: > 85%
- **Error handling**: > 75%

---

## Validation Tests

### Input Validation Tests

```python
@pytest.mark.asyncio
async def test_invalid_entity_type(client):
    """Test invalid entity type rejection."""
    response = await client.post('/api/v1/labels', json={
        'name': 'Test',
        'category': 'invalid_type',
        'created_by': 'test'
    })
    assert response.status_code == 400

@pytest.mark.asyncio
async def test_missing_required_fields(client):
    """Test missing required fields."""
    response = await client.post('/api/v1/labels', json={
        'name': 'Test'
        # Missing category and created_by
    })
    assert response.status_code == 400

@pytest.mark.asyncio
async def test_duplicate_label(client):
    """Test duplicate label prevention."""
    label_data = {
        'name': 'Duplicate Test',
        'category': 'user',
        'created_by': 'test'
    }

    # Create first time
    response1 = await client.post('/api/v1/labels', json=label_data)
    assert response1.status_code == 201

    # Try to create duplicate
    response2 = await client.post('/api/v1/labels', json=label_data)
    assert response2.status_code == 409
```

---

## Cleanup After Tests

```python
async def cleanup_test_data():
    """Clean up test data from database."""
    dal.executesql("""
        DELETE FROM entity_labels
        WHERE applied_by = 'test' OR applied_by = 'load_test'
    """)
    dal.executesql("""
        DELETE FROM labels
        WHERE created_by = 'test' OR created_by = 'load_test'
    """)
    dal.commit()
    print("✓ Test data cleaned up")
```

---

## Continuous Integration

### GitHub Actions Example

```yaml
name: Labels Module Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:13
        env:
          POSTGRES_USER: waddlebot
          POSTGRES_PASSWORD: password
          POSTGRES_DB: waddlebot_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v2

      - name: Set up Python
        uses: actions/setup-python@v2
        with:
          python-version: '3.9'

      - name: Install dependencies
        run: |
          cd core/labels_core_module
          pip install -r requirements.txt
          pip install pytest pytest-asyncio pytest-cov

      - name: Run tests
        env:
          DATABASE_URL: postgresql://waddlebot:password@localhost:5432/waddlebot_test
        run: |
          cd core/labels_core_module
          pytest tests/ -v --cov=app

      - name: Upload coverage
        uses: codecov/codecov-action@v2
```

---

## Monitoring Tests

### Health Check Monitoring

```bash
# Monitor health endpoint
while true; do
  curl -s http://localhost:8023/health | jq .
  sleep 5
done
```

### Performance Monitoring

```bash
# Monitor response times
time curl -X GET http://localhost:8023/api/v1/labels

# Monitor with Apache Bench
ab -n 1000 -c 10 http://localhost:8023/api/v1/labels
```
