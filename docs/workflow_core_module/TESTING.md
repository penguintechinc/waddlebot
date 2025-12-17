# Workflow Core Module - Testing Guide

## Overview

This document describes testing procedures, test files, and how to run tests for the Workflow Core Module.

**Module Version:** 1.0.0

---

## Table of Contents

1. [Test Overview](#test-overview)
2. [Running Tests](#running-tests)
3. [Unit Tests](#unit-tests)
4. [Integration Tests](#integration-tests)
5. [API Testing](#api-testing)
6. [Test Coverage](#test-coverage)
7. [CI/CD Integration](#cicd-integration)

---

## Test Overview

### Test Framework

- **Framework:** pytest
- **Async Support:** pytest-asyncio
- **Coverage:** pytest-cov
- **Mocking:** unittest.mock

### Test Structure

```
core/workflow_core_module/
├── services/
│   ├── test_node_executor.py          # Node execution tests
│   ├── test_license_service_examples.py # License service tests
│   └── validation_service_tests.py    # Validation tests
├── tests/ (if exists)
│   ├── test_workflow_service.py
│   ├── test_workflow_engine.py
│   ├── test_permission_service.py
│   └── test_api_endpoints.py
└── pytest.ini (configuration)
```

### Test Types

| Type | Purpose | Location |
|------|---------|----------|
| **Unit Tests** | Test individual functions and classes | `services/test_*.py` |
| **Integration Tests** | Test service interactions | `tests/test_integration.py` |
| **API Tests** | Test REST endpoints | `tests/test_api_endpoints.py` |
| **End-to-End Tests** | Test complete workflows | `tests/test_e2e.py` |

---

## Running Tests

### Prerequisites

1. Install dependencies:
```bash
cd /home/penguin/code/WaddleBot/core/workflow_core_module
pip install -r requirements.txt
```

2. Set up test database:
```bash
# Create test database
createdb waddlebot_test

# Run migrations
python scripts/migrate.py --database waddlebot_test
```

3. Configure test environment:
```bash
export DATABASE_URI=postgresql://waddlebot:password@localhost:5432/waddlebot_test
export REDIS_URL=redis://localhost:6379/1
export LOG_LEVEL=DEBUG
```

### Run All Tests

```bash
# Run all tests
pytest

# Run with verbose output
pytest -v

# Run with coverage
pytest --cov=. --cov-report=html

# Run specific test file
pytest services/test_node_executor.py

# Run specific test
pytest services/test_node_executor.py::TestNodeExecutor::test_execute_action_module
```

### Run Tests in Docker

```bash
# Build test image
docker build -f Dockerfile.test -t waddlebot/workflow-core:test .

# Run tests
docker run --rm \
  -e DATABASE_URI=postgresql://... \
  -e REDIS_URL=redis://... \
  waddlebot/workflow-core:test pytest -v
```

---

## Unit Tests

### Node Executor Tests

**File:** `services/test_node_executor.py`

Tests individual node execution logic.

#### Test Cases

```python
import pytest
from services.node_executor import NodeExecutor
from models.nodes import ActionChatMessageConfig, ConditionIfConfig
from models.execution import ExecutionContext

@pytest.mark.asyncio
async def test_execute_chat_message_node():
    """Test action_chat_message node execution"""
    # Setup
    executor = NodeExecutor()
    node = ActionChatMessageConfig(
        node_id="msg1",
        label="Test Message",
        position={"x": 0, "y": 0},
        config={
            "message": "Hello, {{username}}!",
            "target": "chat"
        }
    )
    context = ExecutionContext(
        execution_id="test-exec",
        workflow_id="test-workflow",
        workflow_version="1.0.0",
        session_id="test-session",
        entity_id="123",
        user_id="456",
        variables={"username": "TestUser"}
    )

    # Execute
    result = await executor.execute_node(node, context)

    # Assert
    assert result.success is True
    assert result.output_data["message"] == "Hello, TestUser!"
    assert "Message prepared" in result.logs


@pytest.mark.asyncio
async def test_execute_condition_if_node():
    """Test condition_if node execution"""
    executor = NodeExecutor()
    node = ConditionIfConfig(
        node_id="cond1",
        label="Test Condition",
        position={"x": 0, "y": 0},
        config={
            "condition": {
                "operator": "equals",
                "left": "{{status}}",
                "right": "active"
            }
        }
    )
    context = ExecutionContext(
        execution_id="test-exec",
        workflow_id="test-workflow",
        workflow_version="1.0.0",
        session_id="test-session",
        entity_id="123",
        user_id="456",
        variables={"status": "active"}
    )

    # Execute
    result = await executor.execute_node(node, context)

    # Assert
    assert result.success is True
    assert result.output_port == "true"


@pytest.mark.asyncio
async def test_execute_loop_foreach_node():
    """Test loop_foreach node execution"""
    executor = NodeExecutor()
    # ... (similar structure)
```

#### Run Node Executor Tests

```bash
pytest services/test_node_executor.py -v
```

### Validation Service Tests

**File:** `services/validation_service_tests.py`

Tests workflow validation logic.

#### Test Cases

```python
import pytest
from services.validation_service import WorkflowValidationService
from models.workflow import WorkflowDefinition, WorkflowMetadata, WorkflowConnection
from models.nodes import TriggerCommandConfig, ActionChatMessageConfig, FlowEndConfig

def test_validate_valid_workflow():
    """Test validation of a valid workflow"""
    # Create workflow
    workflow = WorkflowDefinition(
        metadata=WorkflowMetadata(
            workflow_id="test-id",
            name="Test Workflow",
            description="Test",
            author_id="123",
            community_id="456"
        ),
        nodes={
            "trigger1": TriggerCommandConfig(...),
            "action1": ActionChatMessageConfig(...),
            "end1": FlowEndConfig(...)
        },
        connections=[
            WorkflowConnection(
                connection_id="c1",
                from_node_id="trigger1",
                from_port_name="output",
                to_node_id="action1",
                to_port_name="input"
            ),
            WorkflowConnection(
                connection_id="c2",
                from_node_id="action1",
                from_port_name="output",
                to_node_id="end1",
                to_port_name="input"
            )
        ]
    )

    # Validate
    validator = WorkflowValidationService()
    result = validator.validate(workflow)

    # Assert
    assert result.is_valid is True
    assert len(result.errors) == 0


def test_validate_workflow_missing_trigger():
    """Test validation fails when no trigger node"""
    workflow = WorkflowDefinition(
        metadata=WorkflowMetadata(...),
        nodes={
            "action1": ActionChatMessageConfig(...),
            "end1": FlowEndConfig(...)
        },
        connections=[]
    )

    validator = WorkflowValidationService()
    result = validator.validate(workflow)

    assert result.is_valid is False
    assert any("trigger" in error.lower() for error in result.errors)


def test_validate_workflow_circular_dependency():
    """Test validation detects circular dependencies"""
    workflow = WorkflowDefinition(
        metadata=WorkflowMetadata(...),
        nodes={
            "node1": ...,
            "node2": ...,
            "node3": ...
        },
        connections=[
            WorkflowConnection(..., from_node_id="node1", to_node_id="node2"),
            WorkflowConnection(..., from_node_id="node2", to_node_id="node3"),
            WorkflowConnection(..., from_node_id="node3", to_node_id="node1")  # Cycle!
        ]
    )

    validator = WorkflowValidationService()
    result = validator.validate(workflow)

    assert result.is_valid is False
    assert any("circular" in error.lower() or "cycle" in error.lower() for error in result.errors)
```

#### Run Validation Tests

```bash
pytest services/validation_service_tests.py -v
```

### License Service Tests

**File:** `services/test_license_service_examples.py`

Tests license validation logic.

#### Run License Tests

```bash
pytest services/test_license_service_examples.py -v
```

---

## Integration Tests

### Workflow Engine Integration Test

Tests complete workflow execution from trigger to completion.

```python
import pytest
from services.workflow_engine import WorkflowEngine
from services.workflow_service import WorkflowService
from models.workflow import WorkflowDefinition

@pytest.mark.asyncio
async def test_complete_workflow_execution(dal, router_url):
    """Test complete workflow execution"""
    # Create workflow
    workflow_id = "test-workflow-id"
    workflow = WorkflowDefinition(
        metadata=...,
        nodes={
            "trigger1": TriggerCommandConfig(...),
            "action1": ActionChatMessageConfig(...),
            "end1": FlowEndConfig(...)
        },
        connections=[...]
    )

    # Save workflow
    workflow_service = WorkflowService(dal, ...)
    await workflow_service.create_workflow(workflow)

    # Execute workflow
    engine = WorkflowEngine(dal, router_url)
    trigger_data = {
        "workflow_id": workflow_id,
        "user_id": "123",
        "username": "TestUser",
        "message": "!test"
    }

    result = await engine.execute_workflow(workflow_id, trigger_data)

    # Assert
    assert result.status == "completed"
    assert len(result.execution_path) == 3  # trigger, action, end
    assert result.error_message is None
```

### Database Integration Test

Tests database operations.

```python
@pytest.mark.asyncio
async def test_workflow_crud_operations(dal):
    """Test workflow CRUD operations"""
    workflow_service = WorkflowService(dal, ...)

    # Create
    workflow_data = {...}
    created = await workflow_service.create_workflow(workflow_data, ...)
    assert created["workflow_id"] is not None

    # Read
    retrieved = await workflow_service.get_workflow(created["workflow_id"], ...)
    assert retrieved["name"] == workflow_data["name"]

    # Update
    updates = {"name": "Updated Name"}
    updated = await workflow_service.update_workflow(created["workflow_id"], updates, ...)
    assert updated["name"] == "Updated Name"

    # Delete
    deleted = await workflow_service.delete_workflow(created["workflow_id"], ...)
    assert deleted["status"] == "archived"
```

---

## API Testing

### REST API Tests

Test all API endpoints.

#### Workflow API Tests

```python
import pytest
from quart.testing import QuartClient

@pytest.mark.asyncio
async def test_create_workflow_api(client: QuartClient, auth_token):
    """Test POST /api/v1/workflows"""
    response = await client.post(
        "/api/v1/workflows",
        headers={"Authorization": f"Bearer {auth_token}"},
        json={
            "name": "Test Workflow",
            "description": "Test",
            "entity_id": 123,
            "community_id": 456,
            "nodes": {},
            "connections": []
        }
    )

    assert response.status_code == 201
    data = await response.get_json()
    assert data["success"] is True
    assert data["data"]["workflow_id"] is not None


@pytest.mark.asyncio
async def test_list_workflows_api(client: QuartClient, auth_token):
    """Test GET /api/v1/workflows"""
    response = await client.get(
        "/api/v1/workflows?entity_id=123",
        headers={"Authorization": f"Bearer {auth_token}"}
    )

    assert response.status_code == 200
    data = await response.get_json()
    assert data["success"] is True
    assert "pagination" in data["meta"]


@pytest.mark.asyncio
async def test_execute_workflow_api(client: QuartClient, auth_token, workflow_id):
    """Test POST /api/v1/workflows/:id/execute"""
    response = await client.post(
        f"/api/v1/workflows/{workflow_id}/execute",
        headers={"Authorization": f"Bearer {auth_token}"},
        json={
            "community_id": 456,
            "variables": {"username": "TestUser"}
        }
    )

    assert response.status_code == 202
    data = await response.get_json()
    assert data["success"] is True
    assert data["data"]["execution_id"] is not None


@pytest.mark.asyncio
async def test_validate_workflow_api(client: QuartClient, auth_token, workflow_id):
    """Test POST /api/v1/workflows/:id/validate"""
    response = await client.post(
        f"/api/v1/workflows/{workflow_id}/validate",
        headers={"Authorization": f"Bearer {auth_token}"}
    )

    assert response.status_code == 200
    data = await response.get_json()
    assert data["success"] is True
    assert "is_valid" in data["data"]
```

#### Webhook API Tests

```python
@pytest.mark.asyncio
async def test_trigger_webhook_public(client: QuartClient, webhook_token):
    """Test POST /api/v1/workflows/webhooks/:token"""
    response = await client.post(
        f"/api/v1/workflows/webhooks/{webhook_token}",
        headers={"Content-Type": "application/json"},
        json={"event": "test", "data": "value"}
    )

    assert response.status_code == 200
    data = await response.get_json()
    assert data["success"] is True
    assert data["data"]["execution_id"] is not None


@pytest.mark.asyncio
async def test_create_webhook_api(client: QuartClient, auth_token, workflow_id):
    """Test POST /api/v1/workflows/:id/webhooks"""
    response = await client.post(
        f"/api/v1/workflows/{workflow_id}/webhooks",
        headers={"Authorization": f"Bearer {auth_token}"},
        json={
            "name": "Test Webhook",
            "require_signature": True
        }
    )

    assert response.status_code == 201
    data = await response.get_json()
    assert data["success"] is True
    assert data["data"]["webhook_id"] is not None
    assert data["data"]["token"] is not None
```

### Run API Tests

```bash
pytest tests/test_api_endpoints.py -v
```

---

## Test Coverage

### Generate Coverage Report

```bash
# Run tests with coverage
pytest --cov=. --cov-report=html --cov-report=term

# View HTML report
open htmlcov/index.html
```

### Coverage Goals

| Component | Target Coverage |
|-----------|-----------------|
| **Services** | 80%+ |
| **Models** | 90%+ |
| **Controllers** | 75%+ |
| **Overall** | 80%+ |

### Coverage Report Example

```
---------- coverage: platform linux, python 3.13 -----------
Name                                      Stmts   Miss  Cover
-------------------------------------------------------------
services/workflow_engine.py                 450     45    90%
services/node_executor.py                   380     50    87%
services/validation_service.py              150     15    90%
services/workflow_service.py                280     40    86%
services/permission_service.py              180     25    86%
models/workflow.py                          120      5    96%
models/nodes.py                             250     10    96%
models/execution.py                         100      5    95%
controllers/workflow_api.py                 200     50    75%
controllers/execution_api.py                220     55    75%
-------------------------------------------------------------
TOTAL                                      2330    300    87%
```

---

## CI/CD Integration

### GitHub Actions Workflow

**File:** `.github/workflows/test-workflow-module.yml`

```yaml
name: Test Workflow Core Module

on:
  push:
    branches: [main, develop]
    paths:
      - 'core/workflow_core_module/**'
  pull_request:
    branches: [main, develop]
    paths:
      - 'core/workflow_core_module/**'

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: waddlebot
          POSTGRES_PASSWORD: password
          POSTGRES_DB: waddlebot_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

      redis:
        image: redis:7
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 6379:6379

    steps:
      - uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.13'

      - name: Install dependencies
        run: |
          cd core/workflow_core_module
          pip install -r requirements.txt

      - name: Run tests
        env:
          DATABASE_URI: postgresql://waddlebot:password@localhost:5432/waddlebot_test
          REDIS_URL: redis://localhost:6379/1
          LOG_LEVEL: DEBUG
        run: |
          cd core/workflow_core_module
          pytest --cov=. --cov-report=xml --cov-report=term

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          file: ./core/workflow_core_module/coverage.xml
          flags: workflow-core-module
```

---

## Manual Testing Procedures

### 1. Test Workflow Creation

```bash
# Create workflow
curl -X POST http://localhost:8070/api/v1/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Manual Test Workflow",
    "description": "Testing workflow creation",
    "entity_id": 123,
    "community_id": 456,
    "nodes": {
      "trigger1": {
        "node_type": "trigger_command",
        "label": "Test Command",
        "position": {"x": 100, "y": 100},
        "config": {"command_name": "test"}
      },
      "action1": {
        "node_type": "action_chat_message",
        "label": "Response",
        "position": {"x": 300, "y": 100},
        "config": {"message": "Test successful!"}
      },
      "end1": {
        "node_type": "flow_end",
        "label": "End",
        "position": {"x": 500, "y": 100}
      }
    },
    "connections": [
      {
        "connection_id": "c1",
        "from_node_id": "trigger1",
        "from_port_name": "output",
        "to_node_id": "action1",
        "to_port_name": "input"
      },
      {
        "connection_id": "c2",
        "from_node_id": "action1",
        "from_port_name": "output",
        "to_node_id": "end1",
        "to_port_name": "input"
      }
    ]
  }' | jq .

# Expected: 201 Created with workflow_id
```

### 2. Test Workflow Execution

```bash
# Execute workflow
WORKFLOW_ID="..." # From previous step

curl -X POST http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "community_id": 456,
    "variables": {
      "username": "TestUser"
    }
  }' | jq .

# Expected: 202 Accepted with execution_id
```

### 3. Test Execution Status

```bash
# Get execution status
EXECUTION_ID="..." # From previous step

curl -X GET http://localhost:8070/api/v1/workflows/executions/$EXECUTION_ID \
  -H "Authorization: Bearer $TOKEN" | jq .

# Expected: 200 OK with execution details
```

### 4. Test Webhook Trigger

```bash
# Create webhook
curl -X POST http://localhost:8070/api/v1/workflows/$WORKFLOW_ID/webhooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Webhook",
    "require_signature": false
  }' | jq .

# Get webhook token
WEBHOOK_TOKEN="..." # From response

# Trigger webhook
curl -X POST http://localhost:8070/api/v1/workflows/webhooks/$WEBHOOK_TOKEN \
  -H "Content-Type: application/json" \
  -d '{"event": "test"}' | jq .

# Expected: 200 OK with execution_id
```

---

## Troubleshooting Tests

### Common Issues

#### Database Connection Failed

**Error:** `Failed to connect to database`

**Solution:**
```bash
# Verify PostgreSQL is running
pg_isready -h localhost -p 5432

# Create test database if missing
createdb waddlebot_test

# Verify DATABASE_URI environment variable
echo $DATABASE_URI
```

#### Redis Connection Failed

**Error:** `Failed to connect to Redis`

**Solution:**
```bash
# Verify Redis is running
redis-cli ping

# Should return: PONG
```

#### Import Errors

**Error:** `ModuleNotFoundError: No module named 'flask_core'`

**Solution:**
```bash
# Install flask_core library
cd libs/flask_core
pip install -e .
```

#### Async Test Errors

**Error:** `RuntimeError: Event loop is closed`

**Solution:**
```python
# Add to conftest.py
import pytest
import asyncio

@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()
```

---

## Test Fixtures

### Conftest.py

```python
import pytest
import asyncio
from quart import Quart
from app import app

@pytest.fixture(scope="session")
def event_loop():
    """Create event loop for async tests"""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()

@pytest.fixture
async def client():
    """Create test client"""
    async with app.test_client() as client:
        yield client

@pytest.fixture
def auth_token():
    """Generate test JWT token"""
    import jwt
    token = jwt.encode(
        {"user_id": "123", "username": "testuser"},
        "test-secret-key",
        algorithm="HS256"
    )
    return token

@pytest.fixture
async def dal():
    """Create test database connection"""
    from pydal import DAL
    dal = DAL(
        "postgresql://waddlebot:password@localhost:5432/waddlebot_test",
        folder="databases",
        pool_size=10
    )
    yield dal
    dal.close()

@pytest.fixture
async def workflow_id(client, auth_token):
    """Create test workflow and return ID"""
    response = await client.post(
        "/api/v1/workflows",
        headers={"Authorization": f"Bearer {auth_token}"},
        json={
            "name": "Test Workflow",
            "entity_id": 123,
            "community_id": 456,
            "nodes": {},
            "connections": []
        }
    )
    data = await response.get_json()
    return data["data"]["workflow_id"]
```
