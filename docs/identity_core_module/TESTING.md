# Identity Core Module - Testing Guide

## Overview

This document provides comprehensive testing instructions for the Identity Core Module, including unit tests, integration tests, API tests, and load testing strategies.

---

## Table of Contents

1. [Test Structure](#test-structure)
2. [Running Tests](#running-tests)
3. [API Testing](#api-testing)
4. [Unit Testing](#unit-testing)
5. [Integration Testing](#integration-testing)
6. [gRPC Testing](#grpc-testing)
7. [Load Testing](#load-testing)
8. [Test Coverage](#test-coverage)
9. [Continuous Integration](#continuous-integration)
10. [Troubleshooting Tests](#troubleshooting-tests)

---

## Test Structure

### Test Directory Layout

```
identity_core_module/
├── app.py
├── config.py
├── services/
│   ├── grpc_handler.py
│   └── __init__.py
├── tests/                    # To be created
│   ├── __init__.py
│   ├── conftest.py          # Pytest fixtures
│   ├── test_app.py          # Application tests
│   ├── test_auth.py         # Authentication tests
│   ├── test_identity.py     # Identity linking tests
│   ├── test_grpc.py         # gRPC service tests
│   └── integration/
│       ├── test_platform_linking.py
│       └── test_cross_platform.py
└── test-api.sh              # API testing script
```

---

## Running Tests

### Prerequisites

**Install Test Dependencies:**
```bash
pip install pytest pytest-asyncio pytest-cov httpx
```

### Quick Test Run

**Run all tests:**
```bash
cd /home/penguin/code/WaddleBot/core/identity_core_module
pytest
```

**Run with coverage:**
```bash
pytest --cov=. --cov-report=html --cov-report=term
```

**Run specific test file:**
```bash
pytest tests/test_auth.py
```

**Run specific test:**
```bash
pytest tests/test_auth.py::test_login_success
```

**Run with verbose output:**
```bash
pytest -v
```

---

## API Testing

### Using test-api.sh Script

The module includes a comprehensive API test script at `/home/penguin/code/WaddleBot/core/identity_core_module/test-api.sh`.

#### Basic Usage

**Test local instance:**
```bash
cd /home/penguin/code/WaddleBot/core/identity_core_module
./test-api.sh
```

**Test with custom URL:**
```bash
./test-api.sh --url http://identity-core:8050
```

**Test with API key:**
```bash
./test-api.sh --api-key "your-api-key-here"
```

**Verbose mode:**
```bash
./test-api.sh --verbose
```

#### Environment Variables

```bash
# Set default URL
export IDENTITY_CORE_URL=http://localhost:8050

# Set API key
export IDENTITY_CORE_API_KEY=your-api-key

# Run tests
./test-api.sh
```

#### Test Categories

The script tests these endpoint groups:

1. **Health Check Endpoints**
   - `GET /health`
   - `GET /healthz`
   - `GET /metrics`

2. **API Status**
   - `GET /api/v1/status`

3. **Identity Linking** (requires API key)
   - `POST /identity/link`
   - `POST /identity/verify`
   - `DELETE /identity/unlink`

4. **Identity Lookup** (requires API key)
   - `GET /identity/user/<user_id>`
   - `GET /identity/platform/<platform>/<platform_id>`

5. **Verification Management** (requires API key)
   - `GET /identity/pending`
   - `POST /identity/resend`

6. **API Key Management** (requires API key)
   - `POST /identity/api-keys`
   - `GET /identity/api-keys`
   - `POST /identity/api-keys/<key_id>/regenerate`
   - `DELETE /identity/api-keys/<key_id>`

7. **User Authentication**
   - `POST /auth/register`
   - `POST /auth/login`
   - `GET /auth/profile`
   - `PUT /auth/profile`
   - `POST /auth/logout`

8. **Monitoring**
   - `GET /identity/stats`
   - `GET /identity/health`

#### Example Output

```bash
$ ./test-api.sh

========================================
Identity Core Module API Tests
========================================
Base URL: http://localhost:8050
========================================

Testing Health Check Endpoints...
----------------------------------------
[PASS] /health - Basic health check
[PASS] /healthz - Kubernetes liveness probe
[PASS] /metrics - Prometheus metrics

Testing API Status Endpoint...
----------------------------------------
[PASS] /api/v1/status - Module status

Testing Identity Linking Endpoints...
----------------------------------------
[SKIP] Identity linking tests - API key required
[SKIP] POST /identity/link - Initiate identity linking
[SKIP] POST /identity/verify - Verify identity
[SKIP] DELETE /identity/unlink - Unlink identity

...

========================================
Test Summary
========================================
Passed:  12
Failed:  0
Skipped: 18
========================================
All tests passed!
```

---

### Manual API Testing with curl

#### Test Health Endpoint

```bash
curl -i http://localhost:8050/health
```

**Expected Response:**
```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "healthy",
  "module": "identity_core_module",
  "version": "2.0.0"
}
```

#### Test Authentication

```bash
# Register user
curl -X POST http://localhost:8050/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPass123!",
    "username": "testuser"
  }'

# Login
curl -X POST http://localhost:8050/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPass123!"
  }'
```

#### Test Identity Linking

```bash
# Set token from login response
TOKEN="your-jwt-token-here"

# Link platform
curl -X POST http://localhost:8050/identity/link \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "twitch",
    "platform_id": "123456789",
    "platform_username": "teststreamer"
  }'

# Verify with code
curl -X POST http://localhost:8050/identity/verify \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "verification_code": "ABCD-1234",
    "platform": "twitch"
  }'
```

---

### Testing with Postman

**Import Collection:**

Create a Postman collection with these requests:

```json
{
  "info": {
    "name": "Identity Core Module",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Health Check",
      "request": {
        "method": "GET",
        "url": "{{base_url}}/health"
      }
    },
    {
      "name": "Register User",
      "request": {
        "method": "POST",
        "url": "{{base_url}}/auth/register",
        "body": {
          "mode": "raw",
          "raw": "{\n  \"email\": \"test@example.com\",\n  \"password\": \"TestPass123!\",\n  \"username\": \"testuser\"\n}"
        }
      }
    }
  ],
  "variable": [
    {
      "key": "base_url",
      "value": "http://localhost:8050"
    }
  ]
}
```

---

## Unit Testing

### Test Fixtures (conftest.py)

```python
import pytest
import asyncio
from quart import Quart
from config import Config

@pytest.fixture
def app():
    """Create test application"""
    app = Quart(__name__)
    app.config['TESTING'] = True
    app.config['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test_db'
    return app

@pytest.fixture
def client(app):
    """Create test client"""
    return app.test_client()

@pytest.fixture
def mock_dal(mocker):
    """Mock database access layer"""
    dal = mocker.Mock()
    dal.hub_users = mocker.Mock()
    dal.hub_user_identities = mocker.Mock()
    return dal

@pytest.fixture
def auth_token():
    """Generate test authentication token"""
    # Implementation depends on JWT library
    return "test-jwt-token"
```

---

### Authentication Tests (test_auth.py)

```python
import pytest
from app import app

@pytest.mark.asyncio
async def test_health_endpoint():
    """Test health check endpoint"""
    async with app.test_client() as client:
        response = await client.get('/health')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'healthy'
        assert data['module'] == 'identity_core_module'

@pytest.mark.asyncio
async def test_register_user_success():
    """Test successful user registration"""
    async with app.test_client() as client:
        response = await client.post('/auth/register', json={
            'email': 'newuser@example.com',
            'password': 'SecurePass123!',
            'username': 'newuser'
        })

        assert response.status_code == 200
        data = await response.get_json()
        assert 'user_id' in data
        assert data['email'] == 'newuser@example.com'

@pytest.mark.asyncio
async def test_register_user_duplicate_email():
    """Test registration with duplicate email"""
    async with app.test_client() as client:
        # First registration
        await client.post('/auth/register', json={
            'email': 'duplicate@example.com',
            'password': 'Pass123!',
            'username': 'user1'
        })

        # Second registration with same email
        response = await client.post('/auth/register', json={
            'email': 'duplicate@example.com',
            'password': 'Pass456!',
            'username': 'user2'
        })

        assert response.status_code == 409  # Conflict
        data = await response.get_json()
        assert 'error' in data

@pytest.mark.asyncio
async def test_login_success():
    """Test successful login"""
    async with app.test_client() as client:
        # Register user first
        await client.post('/auth/register', json={
            'email': 'logintest@example.com',
            'password': 'LoginPass123!',
            'username': 'loginuser'
        })

        # Login
        response = await client.post('/auth/login', json={
            'email': 'logintest@example.com',
            'password': 'LoginPass123!'
        })

        assert response.status_code == 200
        data = await response.get_json()
        assert 'token' in data
        assert 'user_id' in data

@pytest.mark.asyncio
async def test_login_invalid_credentials():
    """Test login with invalid credentials"""
    async with app.test_client() as client:
        response = await client.post('/auth/login', json={
            'email': 'nonexistent@example.com',
            'password': 'WrongPass123!'
        })

        assert response.status_code == 401  # Unauthorized
```

---

### Identity Linking Tests (test_identity.py)

```python
import pytest
from services.grpc_handler import IdentityServiceServicer, LookupIdentityRequest

@pytest.mark.asyncio
async def test_link_identity(client, auth_token):
    """Test initiating identity link"""
    response = await client.post(
        '/identity/link',
        headers={'Authorization': f'Bearer {auth_token}'},
        json={
            'platform': 'twitch',
            'platform_id': '123456789',
            'platform_username': 'teststreamer'
        }
    )

    assert response.status_code == 200
    data = await response.get_json()
    assert 'verification_id' in data
    assert 'verification_code' in data
    assert 'expires_at' in data

@pytest.mark.asyncio
async def test_verify_identity_success(client, auth_token):
    """Test successful identity verification"""
    # First, link identity to get verification code
    link_response = await client.post(
        '/identity/link',
        headers={'Authorization': f'Bearer {auth_token}'},
        json={
            'platform': 'twitch',
            'platform_id': '123456789',
            'platform_username': 'teststreamer'
        }
    )
    verification_code = (await link_response.get_json())['verification_code']

    # Verify
    response = await client.post(
        '/identity/verify',
        headers={'Authorization': f'Bearer {auth_token}'},
        json={
            'verification_code': verification_code,
            'platform': 'twitch'
        }
    )

    assert response.status_code == 200
    data = await response.get_json()
    assert data['success'] is True

@pytest.mark.asyncio
async def test_verify_identity_expired_code(client, auth_token):
    """Test verification with expired code"""
    response = await client.post(
        '/identity/verify',
        headers={'Authorization': f'Bearer {auth_token}'},
        json={
            'verification_code': 'EXPIRED-CODE',
            'platform': 'twitch'
        }
    )

    assert response.status_code == 404  # Not found

@pytest.mark.asyncio
async def test_lookup_identity_by_platform(client, auth_token):
    """Test looking up hub user by platform identity"""
    # Link identity first
    await client.post(
        '/identity/link',
        headers={'Authorization': f'Bearer {auth_token}'},
        json={
            'platform': 'twitch',
            'platform_id': '123456789',
            'platform_username': 'teststreamer'
        }
    )

    # Lookup
    response = await client.get(
        '/identity/platform/twitch/123456789',
        headers={'Authorization': f'Bearer {auth_token}'}
    )

    assert response.status_code == 200
    data = await response.get_json()
    assert 'user_id' in data
    assert data['platform'] == 'twitch'

@pytest.mark.asyncio
async def test_unlink_identity(client, auth_token):
    """Test unlinking platform identity"""
    # Link identity first
    await client.post(
        '/identity/link',
        headers={'Authorization': f'Bearer {auth_token}'},
        json={
            'platform': 'twitch',
            'platform_id': '123456789',
            'platform_username': 'teststreamer'
        }
    )

    # Unlink
    response = await client.delete(
        '/identity/unlink',
        headers={'Authorization': f'Bearer {auth_token}'},
        json={
            'platform': 'twitch',
            'platform_id': '123456789'
        }
    )

    assert response.status_code == 200
    data = await response.get_json()
    assert data['success'] is True
```

---

## Integration Testing

### Database Integration Tests

```python
import pytest
from flask_core import init_database
from config import Config

@pytest.fixture(scope='module')
def test_db():
    """Initialize test database"""
    dal = init_database(Config.DATABASE_URL)
    yield dal
    # Cleanup after tests
    dal.cleanup()

def test_create_user(test_db):
    """Test creating user in database"""
    user_id = test_db.hub_users.insert(
        email='dbtest@example.com',
        username='dbtest',
        password_hash='hashed_password'
    )

    assert user_id is not None

    # Verify user was created
    user = test_db.hub_users.get(id=user_id)
    assert user.email == 'dbtest@example.com'

def test_link_platform_identity(test_db):
    """Test linking platform identity"""
    # Create user
    user_id = test_db.hub_users.insert(
        email='linktest@example.com',
        username='linktest',
        password_hash='hashed'
    )

    # Link identity
    identity_id = test_db.hub_user_identities.insert(
        hub_user_id=user_id,
        platform='twitch',
        platform_user_id='123456789',
        platform_username='teststreamer'
    )

    assert identity_id is not None

    # Verify link
    identity = test_db.hub_user_identities.get(id=identity_id)
    assert identity.platform == 'twitch'
    assert identity.hub_user_id == user_id
```

---

## gRPC Testing

### Using grpcurl

**Install grpcurl:**
```bash
# macOS
brew install grpcurl

# Linux
wget https://github.com/fullstorydev/grpcurl/releases/download/v1.8.7/grpcurl_1.8.7_linux_x86_64.tar.gz
tar -xzf grpcurl_1.8.7_linux_x86_64.tar.gz
sudo mv grpcurl /usr/local/bin/
```

**List available services:**
```bash
grpcurl -plaintext localhost:50030 list
```

**Test LookupIdentity RPC:**
```bash
grpcurl -plaintext \
  -d '{
    "token": "test-token",
    "platform": "twitch",
    "platform_user_id": "123456789"
  }' \
  localhost:50030 \
  waddlebot.identity.IdentityService/LookupIdentity
```

**Test GetLinkedPlatforms RPC:**
```bash
grpcurl -plaintext \
  -d '{
    "token": "test-token",
    "hub_user_id": 42
  }' \
  localhost:50030 \
  waddlebot.identity.IdentityService/GetLinkedPlatforms
```

---

### gRPC Unit Tests (test_grpc.py)

```python
import pytest
from services.grpc_handler import (
    IdentityServiceServicer,
    LookupIdentityRequest,
    GetLinkedPlatformsRequest
)

@pytest.mark.asyncio
async def test_lookup_identity_success(mock_dal):
    """Test successful identity lookup via gRPC"""
    servicer = IdentityServiceServicer(dal=mock_dal)

    request = LookupIdentityRequest(
        token='valid-token',
        platform='twitch',
        platform_user_id='123456789'
    )

    response = await servicer.LookupIdentity(request)

    assert response.success is True
    assert response.hub_user_id > 0
    assert len(response.linked_platforms) > 0

@pytest.mark.asyncio
async def test_lookup_identity_invalid_token(mock_dal):
    """Test identity lookup with invalid token"""
    servicer = IdentityServiceServicer(dal=mock_dal)

    request = LookupIdentityRequest(
        token='',  # Empty token
        platform='twitch',
        platform_user_id='123456789'
    )

    response = await servicer.LookupIdentity(request)

    assert response.success is False
    assert 'Invalid authentication token' in response.error

@pytest.mark.asyncio
async def test_get_linked_platforms(mock_dal):
    """Test getting linked platforms via gRPC"""
    servicer = IdentityServiceServicer(dal=mock_dal)

    request = GetLinkedPlatformsRequest(
        token='valid-token',
        hub_user_id=42
    )

    response = await servicer.GetLinkedPlatforms(request)

    assert response.success is True
    assert len(response.platforms) >= 0
```

---

## Load Testing

### Using Apache Bench (ab)

**Test health endpoint:**
```bash
ab -n 1000 -c 10 http://localhost:8050/health
```

**Test with authentication:**
```bash
ab -n 1000 -c 10 \
  -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:8050/api/v1/status
```

---

### Using Locust

**Install Locust:**
```bash
pip install locust
```

**Create locustfile.py:**
```python
from locust import HttpUser, task, between

class IdentityUser(HttpUser):
    wait_time = between(1, 3)
    host = "http://localhost:8050"

    def on_start(self):
        """Login and get token"""
        response = self.client.post("/auth/login", json={
            "email": "loadtest@example.com",
            "password": "LoadTest123!"
        })
        self.token = response.json().get('token')

    @task(3)
    def health_check(self):
        """Test health endpoint"""
        self.client.get("/health")

    @task(2)
    def get_profile(self):
        """Test profile endpoint"""
        self.client.get(
            "/auth/profile",
            headers={"Authorization": f"Bearer {self.token}"}
        )

    @task(1)
    def lookup_identity(self):
        """Test identity lookup"""
        self.client.get(
            "/identity/platform/twitch/123456789",
            headers={"Authorization": f"Bearer {self.token}"}
        )
```

**Run load test:**
```bash
locust -f locustfile.py --host=http://localhost:8050
```

**Access web UI:** http://localhost:8089

---

### Using k6

**Install k6:**
```bash
# macOS
brew install k6

# Linux
sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

**Create k6 script (load-test.js):**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '30s', target: 20 },  // Ramp up
    { duration: '1m', target: 20 },   // Stay at 20 users
    { duration: '30s', target: 0 },   // Ramp down
  ],
};

export default function () {
  // Test health endpoint
  let res = http.get('http://localhost:8050/health');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'is healthy': (r) => r.json('status') === 'healthy',
  });

  sleep(1);
}
```

**Run k6 test:**
```bash
k6 run load-test.js
```

---

## Test Coverage

### Generate Coverage Report

```bash
pytest --cov=. --cov-report=html --cov-report=term
```

**View HTML report:**
```bash
open htmlcov/index.html
```

### Coverage Goals

| Component | Target Coverage |
|-----------|----------------|
| API Endpoints | 90%+ |
| Service Layer | 85%+ |
| gRPC Handlers | 85%+ |
| Authentication | 95%+ |
| Database Layer | 80%+ |

---

## Continuous Integration

### GitHub Actions Workflow

Create `.github/workflows/test.yml`:

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test_db
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.13'

      - name: Install dependencies
        run: |
          cd core/identity_core_module
          pip install -r requirements.txt
          pip install pytest pytest-asyncio pytest-cov

      - name: Run tests
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test_db
          SECRET_KEY: test-secret-key
        run: |
          cd core/identity_core_module
          pytest --cov=. --cov-report=xml

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          file: ./coverage.xml
```

---

## Troubleshooting Tests

### Common Test Failures

**Issue: Database connection failed**
```
Error: could not connect to database
```
**Solution:**
- Ensure PostgreSQL is running
- Check `DATABASE_URL` in test configuration
- Verify database credentials

**Issue: Port already in use**
```
Error: Address already in use: 0.0.0.0:8050
```
**Solution:**
- Stop other instances of the service
- Use different port for tests
- Kill zombie processes: `lsof -ti:8050 | xargs kill -9`

**Issue: Async test failures**
```
RuntimeError: Event loop is closed
```
**Solution:**
- Ensure `@pytest.mark.asyncio` decorator
- Install `pytest-asyncio`
- Check pytest-asyncio configuration

**Issue: Import errors**
```
ModuleNotFoundError: No module named 'flask_core'
```
**Solution:**
- Install shared library: `cd libs/flask_core && pip install .`
- Set PYTHONPATH: `export PYTHONPATH=/home/penguin/code/WaddleBot:$PYTHONPATH`

---

## Test Data Management

### Creating Test Data

```python
# fixtures/test_data.py
TEST_USERS = [
    {
        'email': 'test1@example.com',
        'username': 'testuser1',
        'password': 'TestPass123!'
    },
    {
        'email': 'test2@example.com',
        'username': 'testuser2',
        'password': 'TestPass456!'
    }
]

TEST_IDENTITIES = [
    {
        'platform': 'twitch',
        'platform_user_id': '123456789',
        'platform_username': 'twitchuser1'
    },
    {
        'platform': 'discord',
        'platform_user_id': '987654321',
        'platform_username': 'discorduser#1234'
    }
]
```

### Cleanup Test Data

```python
@pytest.fixture(autouse=True)
def cleanup_db(test_db):
    """Clean up test data after each test"""
    yield
    # Delete test users
    test_db.hub_users.delete().where(
        test_db.hub_users.email.like('test%@example.com')
    )
    # Delete test identities
    test_db.hub_user_identities.delete().where(
        test_db.hub_user_identities.platform_username.like('test%')
    )
```

---

## Performance Testing Checklist

- [ ] Health endpoints respond < 50ms
- [ ] Authentication < 200ms
- [ ] Identity lookup < 100ms (REST)
- [ ] Identity lookup < 50ms (gRPC)
- [ ] Concurrent users: 100+ without errors
- [ ] Database connection pool handles load
- [ ] No memory leaks during extended tests
- [ ] Error rate < 0.1% under normal load

---

## Additional Resources

- [pytest Documentation](https://docs.pytest.org/)
- [pytest-asyncio Guide](https://pytest-asyncio.readthedocs.io/)
- [Locust Documentation](https://docs.locust.io/)
- [k6 Documentation](https://k6.io/docs/)
- [grpcurl Guide](https://github.com/fullstorydev/grpcurl)
