# WaddleBot Development Standards

## Overview

This document defines comprehensive development standards for WaddleBot's microservices architecture. All modules, services, and contributions must adhere to these standards to ensure consistency, maintainability, and quality across the 24+ service ecosystem.

---

## Coding Conventions

### Python Standards

**Version**: Python 3.13+

**Style Guide**: PEP 8 with Black formatting

**Formatting**:
```bash
# Format all Python files
black --line-length 100 .

# Check compliance
flake8 --max-line-length 100 --exclude .venv,venv

# Type checking
mypy --strict --ignore-missing-imports .
```

**Code Structure**:
```python
"""
Module docstring describing purpose and functionality.

This module implements XYZ feature for WaddleBot.
"""

import os
import sys
from typing import Optional, Dict, List, Any
from datetime import datetime

# Third-party imports
import httpx
from quart import Quart, request

# Local imports
from flask_core.auth import require_api_key
from flask_core.database import AsyncDAL
from flask_core.logging import get_logger

logger = get_logger(__name__)


class ServiceName:
    """
    Class docstring describing purpose.

    Attributes:
        attribute_name: Description of attribute
    """

    def __init__(self, config: Dict[str, Any]):
        """
        Initialize service.

        Args:
            config: Configuration dictionary

        Raises:
            ValueError: If configuration is invalid
        """
        self.config = config
        self._client: Optional[httpx.AsyncClient] = None

    async def method_name(self, param: str) -> Dict[str, Any]:
        """
        Method docstring with description.

        Args:
            param: Parameter description

        Returns:
            Dictionary containing result

        Raises:
            ServiceError: If operation fails
        """
        try:
            result = await self._perform_operation(param)
            return {'success': True, 'data': result}
        except Exception as e:
            logger.error(f"Operation failed: {e}")
            raise ServiceError(f"Failed to process {param}") from e


def function_name(arg1: str, arg2: int = 0) -> Optional[str]:
    """
    Function docstring with description.

    Args:
        arg1: First argument description
        arg2: Second argument description (default: 0)

    Returns:
        Result string or None if not found
    """
    if not arg1:
        return None
    return f"{arg1}_{arg2}"
```

**Naming Conventions**:
- **Files**: `snake_case.py` (e.g., `command_processor.py`, `auth_service.py`)
- **Classes**: `PascalCase` (e.g., `CommandProcessor`, `AuthService`)
- **Functions/Methods**: `snake_case` (e.g., `process_command`, `verify_token`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `MAX_RETRIES`, `DEFAULT_TIMEOUT`)
- **Private members**: `_leading_underscore` (e.g., `_internal_method`, `_cache`)

**Type Hints** (Required):
```python
from typing import Optional, Dict, List, Union, Any

async def fetch_user(
    user_id: str,
    include_roles: bool = False
) -> Optional[Dict[str, Any]]:
    """Fetch user with optional role information."""
    pass

def calculate_score(
    points: int,
    multiplier: float = 1.0
) -> int:
    """Calculate final score with multiplier."""
    return int(points * multiplier)
```

**Error Handling**:
```python
# Define custom exceptions
class ServiceError(Exception):
    """Base exception for service errors."""
    pass

class ValidationError(ServiceError):
    """Raised when input validation fails."""
    pass

# Use try-except with specific exceptions
try:
    result = await service.process(data)
except ValidationError as e:
    logger.warning(f"Validation failed: {e}")
    return error_response(400, str(e))
except ServiceError as e:
    logger.error(f"Service error: {e}")
    return error_response(500, 'internal_error')
except Exception as e:
    logger.exception(f"Unexpected error: {e}")
    return error_response(500, 'unexpected_error')
```

**Async/Await Patterns**:
```python
import asyncio
from typing import List

# Concurrent operations
async def fetch_multiple_users(user_ids: List[str]) -> List[Dict]:
    """Fetch multiple users concurrently."""
    tasks = [fetch_user(user_id) for user_id in user_ids]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return [r for r in results if not isinstance(r, Exception)]

# Sequential with dependencies
async def create_user_with_roles(username: str, roles: List[str]) -> Dict:
    """Create user and assign roles sequentially."""
    user = await create_user(username)
    await assign_roles(user.id, roles)
    return user
```

### JavaScript/TypeScript Standards

**Version**: Node.js 20+ with ES2022

**Style Guide**: Airbnb JavaScript Style Guide with Prettier

**Formatting**:
```bash
# Format files
prettier --write "**/*.{js,jsx,ts,tsx}"

# Lint
eslint "**/*.{js,jsx,ts,tsx}"
```

**Code Structure**:
```javascript
/**
 * Module description
 *
 * @module services/authService
 */

import axios from 'axios';
import { validateToken } from '../utils/validation';

/**
 * Authentication service
 *
 * @class AuthService
 */
class AuthService {
  /**
   * Create auth service instance
   *
   * @param {Object} config - Configuration object
   * @param {string} config.apiUrl - API base URL
   */
  constructor(config) {
    this.apiUrl = config.apiUrl;
    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 5000,
    });
  }

  /**
   * Authenticate user with credentials
   *
   * @param {string} username - Username
   * @param {string} password - Password
   * @returns {Promise<Object>} Authentication result
   * @throws {AuthenticationError} If authentication fails
   */
  async authenticate(username, password) {
    try {
      const response = await this.client.post('/auth/login', {
        username,
        password,
      });

      return {
        success: true,
        token: response.data.token,
        user: response.data.user,
      };
    } catch (error) {
      throw new AuthenticationError('Authentication failed', error);
    }
  }
}

export default AuthService;
```

**Naming Conventions**:
- **Files**: `camelCase.js` or `PascalCase.jsx` for components (e.g., `authService.js`, `LoginPage.jsx`)
- **Classes**: `PascalCase` (e.g., `AuthService`, `UserController`)
- **Functions/Variables**: `camelCase` (e.g., `fetchUser`, `apiClient`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `MAX_RETRIES`, `API_TIMEOUT`)
- **React Components**: `PascalCase` (e.g., `UserProfile`, `AdminDashboard`)

**TypeScript Types**:
```typescript
interface User {
  id: string;
  username: string;
  email: string;
  roles: string[];
  createdAt: Date;
}

interface AuthResponse {
  success: boolean;
  token?: string;
  user?: User;
  error?: string;
}

async function authenticateUser(
  username: string,
  password: string
): Promise<AuthResponse> {
  // Implementation
}
```

### Go Standards

**Version**: Go 1.21+

**Style Guide**: Effective Go

**Code Structure**:
```go
// Package gateway provides API gateway functionality
package gateway

import (
    "context"
    "fmt"
    "log"
    "time"
)

// Config holds gateway configuration
type Config struct {
    Port        int
    Timeout     time.Duration
    RateLimits  map[string]int
}

// Gateway represents the API gateway
type Gateway struct {
    config  Config
    logger  *log.Logger
    clients map[string]*Client
}

// NewGateway creates a new gateway instance
func NewGateway(config Config, logger *log.Logger) (*Gateway, error) {
    if config.Port <= 0 {
        return nil, fmt.Errorf("invalid port: %d", config.Port)
    }

    return &Gateway{
        config:  config,
        logger:  logger,
        clients: make(map[string]*Client),
    }, nil
}

// HandleRequest processes an incoming request
func (g *Gateway) HandleRequest(ctx context.Context, req *Request) (*Response, error) {
    g.logger.Printf("Processing request: %s", req.ID)

    // Implementation
    return &Response{
        Status: "success",
    }, nil
}
```

**Naming Conventions**:
- **Files**: `snake_case.go` (e.g., `rate_limiter.go`, `auth_middleware.go`)
- **Packages**: `lowercase` single word (e.g., `gateway`, `auth`, `config`)
- **Exported**: `PascalCase` (e.g., `HandleRequest`, `Config`)
- **Unexported**: `camelCase` (e.g., `processRequest`, `validateToken`)
- **Constants**: `PascalCase` for exported, `camelCase` for unexported

---

## File Naming Conventions

### Module Structure

```
module_name/
├── Dockerfile                    # Container definition
├── requirements.txt              # Python dependencies (pinned versions)
├── pyproject.toml               # Python project metadata (optional)
├── main.py                      # Application entry point
├── config.py                    # Configuration management
├── models.py                    # Data models and schemas
├── handlers/                    # Request handlers by feature
│   ├── __init__.py
│   ├── auth_handler.py
│   ├── command_handler.py
│   └── webhook_handler.py
├── services/                    # Business logic services
│   ├── __init__.py
│   ├── user_service.py
│   ├── notification_service.py
│   └── external_api_client.py
├── utils/                       # Utility functions
│   ├── __init__.py
│   ├── logging.py
│   ├── validation.py
│   └── helpers.py
├── tests/                       # Test files
│   ├── __init__.py
│   ├── test_handlers.py
│   ├── test_services.py
│   └── conftest.py              # Pytest fixtures
└── README.md                    # Module documentation
```

### File Naming Rules

**Python Files**:
- `snake_case.py` - All lowercase with underscores
- Test files: `test_module_name.py`
- Configuration: `config.py` or `settings.py`
- Entry point: `main.py` or `app.py`

**JavaScript/TypeScript Files**:
- Components: `PascalCase.jsx` (e.g., `UserProfile.jsx`)
- Services: `camelCase.js` (e.g., `authService.js`)
- Utilities: `camelCase.js` (e.g., `dateFormatter.js`)
- Tests: `moduleName.test.js` or `moduleName.spec.js`

**Documentation**:
- README files: `README.md` (uppercase)
- Guides: `UPPERCASE_WITH_UNDERSCORES.md` (e.g., `DEPLOYMENT_GUIDE.md`)
- API docs: `api-reference.md` (lowercase with hyphens)

---

## Logging Standards

### Log Levels

| Level | Usage | Example |
|-------|-------|---------|
| `DEBUG` | Detailed diagnostic info | Variable values, flow tracing |
| `INFO` | Normal operations | Service startup, request processing |
| `WARNING` | Unexpected but handled | Deprecated features, rate limits |
| `ERROR` | Error conditions | Failed operations, exceptions |
| `CRITICAL` | System failures | Service crashes, data corruption |

### AAA Logging Format

All security-relevant events must use AAA (Authentication, Authorization, Auditing) format:

```
[timestamp] LEVEL module:version EVENT_TYPE community=X user=Y action=Z result=STATUS
```

**Example Implementation**:
```python
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

# Configure formatter
formatter = logging.Formatter(
    '[%(asctime)s] %(levelname)s %(name)s %(message)s',
    datefmt='%Y-%m-%dT%H:%M:%S'
)

def log_auth_event(community_id: str, user_id: str, action: str, result: str, **kwargs):
    """Log authentication event."""
    logger.info(
        f'AUTH community={community_id} user={user_id} action={action} result={result}',
        extra={
            'event_type': 'AUTH',
            'community': community_id,
            'user': user_id,
            'action': action,
            'result': result,
            **kwargs
        }
    )

def log_authz_event(community_id: str, user_id: str, action: str, result: str, reason: str = None):
    """Log authorization event."""
    msg = f'AUTHZ community={community_id} user={user_id} action={action} result={result}'
    if reason:
        msg += f' reason={reason}'

    logger.info(msg, extra={
        'event_type': 'AUTHZ',
        'community': community_id,
        'user': user_id,
        'action': action,
        'result': result,
        'reason': reason
    })

def log_audit_event(community_id: str, user_id: str, action: str, module: str, result: str):
    """Log audit event."""
    logger.info(
        f'AUDIT community={community_id} user={user_id} action={action} module={module} result={result}',
        extra={
            'event_type': 'AUDIT',
            'community': community_id,
            'user': user_id,
            'action': action,
            'module': module,
            'result': result
        }
    )

def log_error_event(community_id: str, action: str, error: str, duration_ms: int = None):
    """Log error event."""
    msg = f'ERROR community={community_id} action={action} result=failure error={error}'
    if duration_ms:
        msg += f' duration_ms={duration_ms}'

    logger.error(msg, extra={
        'event_type': 'ERROR',
        'community': community_id,
        'action': action,
        'result': 'failure',
        'error': error,
        'duration_ms': duration_ms
    })
```

### Structured Logging

**JSON Format** (Production):
```python
import json
import logging

class JSONFormatter(logging.Formatter):
    """Format logs as JSON."""

    def format(self, record):
        log_data = {
            'timestamp': self.formatTime(record, self.datefmt),
            'level': record.levelname,
            'module': record.name,
            'message': record.getMessage(),
        }

        # Add extra fields
        if hasattr(record, 'event_type'):
            log_data['event_type'] = record.event_type
        if hasattr(record, 'community'):
            log_data['community'] = record.community
        if hasattr(record, 'user'):
            log_data['user'] = record.user

        return json.dumps(log_data)

# Configure handler
handler = logging.StreamHandler()
handler.setFormatter(JSONFormatter())
logger.addHandler(handler)
```

### Log Rotation

```python
import logging.handlers

# Rotating file handler
file_handler = logging.handlers.RotatingFileHandler(
    '/var/log/waddlebot/module.log',
    maxBytes=10_000_000,  # 10 MB
    backupCount=5
)

# Time-based rotation
time_handler = logging.handlers.TimedRotatingFileHandler(
    '/var/log/waddlebot/module.log',
    when='midnight',
    interval=1,
    backupCount=30  # Keep 30 days
)
```

---

## Error Handling Standards

### Exception Hierarchy

```python
class WaddleBotError(Exception):
    """Base exception for all WaddleBot errors."""
    pass

class ValidationError(WaddleBotError):
    """Input validation failed."""
    pass

class AuthenticationError(WaddleBotError):
    """Authentication failed."""
    pass

class AuthorizationError(WaddleBotError):
    """Authorization failed (insufficient permissions)."""
    pass

class ServiceError(WaddleBotError):
    """External service error."""
    pass

class DatabaseError(WaddleBotError):
    """Database operation failed."""
    pass

class RateLimitError(WaddleBotError):
    """Rate limit exceeded."""
    pass
```

### Error Response Format

```python
def error_response(status_code: int, error_code: str, message: str = None, **kwargs):
    """
    Create standardized error response.

    Args:
        status_code: HTTP status code
        error_code: Machine-readable error code
        message: Human-readable error message
        **kwargs: Additional error details

    Returns:
        Tuple of (response_dict, status_code)
    """
    response = {
        'error': error_code,
        'message': message or ERROR_MESSAGES.get(error_code, 'An error occurred'),
        'status': status_code,
        'correlation_id': request.correlation_id,
        'timestamp': datetime.utcnow().isoformat()
    }

    if kwargs:
        response['details'] = kwargs

    return response, status_code

# Usage
@app.route('/api/v1/user/<user_id>')
async def get_user(user_id: str):
    try:
        user = await dal.get_user(user_id)
        if not user:
            return error_response(404, 'user_not_found')
        return {'user': user.as_dict()}
    except ValidationError as e:
        return error_response(400, 'invalid_input', str(e))
    except DatabaseError as e:
        logger.error(f"Database error: {e}")
        return error_response(500, 'database_error')
```

### Error Logging

```python
try:
    result = await risky_operation()
except ValidationError as e:
    # Expected error - log as warning
    logger.warning(f"Validation failed: {e}")
    return error_response(400, 'validation_error', str(e))
except ServiceError as e:
    # Service error - log with context
    logger.error(
        f"Service error in {operation_name}",
        extra={
            'operation': operation_name,
            'error': str(e),
            'user_id': user_id
        }
    )
    return error_response(502, 'service_unavailable')
except Exception as e:
    # Unexpected error - log with full traceback
    logger.exception(f"Unexpected error: {e}")
    return error_response(500, 'internal_error')
```

---

## Docker Standards

### Dockerfile Template

```dockerfile
# Use specific version (never 'latest')
FROM python:3.13.1-slim AS base

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create non-root user
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:${PORT:-8000}/health')"

# Expose port
EXPOSE 8000

# Run application
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Multi-Stage Builds

```dockerfile
# Build stage
FROM python:3.13.1-slim AS builder

WORKDIR /app
COPY requirements.txt .
RUN pip install --user --no-cache-dir -r requirements.txt

# Runtime stage
FROM python:3.13.1-slim

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /root/.local /root/.local

# Copy application
COPY . .

# Create non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

# Add dependencies to PATH
ENV PATH=/root/.local/bin:$PATH

CMD ["python", "main.py"]
```

### Docker Compose Standards

```yaml
version: '3.8'

services:
  router:
    build:
      context: ./processing/router_module
      dockerfile: Dockerfile
    image: waddlebot/router:latest
    container_name: waddlebot-router
    ports:
      - "8000:8000"
    environment:
      - MODULE_NAME=router
      - MODULE_PORT=8000
      - DB_HOST=postgres
      - REDIS_HOST=redis
    env_file:
      - .env
    depends_on:
      - postgres
      - redis
    networks:
      - waddlebot
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

networks:
  waddlebot:
    driver: bridge
```

---

## Testing Requirements

### Unit Tests

**Coverage Requirement**: Minimum 80% code coverage

```python
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

@pytest.mark.asyncio
async def test_create_user_success():
    """Test successful user creation."""
    # Arrange
    dal = AsyncMock()
    dal.insert.return_value = {'id': '123', 'username': 'testuser'}

    # Act
    result = await create_user('testuser', 'test@example.com', dal)

    # Assert
    assert result['username'] == 'testuser'
    dal.insert.assert_called_once()

@pytest.mark.asyncio
async def test_create_user_duplicate():
    """Test user creation with duplicate username."""
    # Arrange
    dal = AsyncMock()
    dal.insert.side_effect = IntegrityError("Duplicate key")

    # Act & Assert
    with pytest.raises(ValidationError, match="Username already exists"):
        await create_user('testuser', 'test@example.com', dal)
```

### Integration Tests

```python
import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_user_registration_flow(test_db, test_client):
    """Test complete user registration flow."""
    # Register user
    response = await test_client.post('/api/v1/auth/register', json={
        'username': 'newuser',
        'email': 'new@example.com',
        'password': 'SecurePass123!'
    })

    assert response.status_code == 201
    data = response.json()
    assert 'token' in data
    assert data['user']['username'] == 'newuser'

    # Verify user in database
    user = await test_db.get_user_by_username('newuser')
    assert user is not None
    assert user.email == 'new@example.com'

    # Login with new user
    login_response = await test_client.post('/api/v1/auth/login', json={
        'username': 'newuser',
        'password': 'SecurePass123!'
    })

    assert login_response.status_code == 200
    assert 'token' in login_response.json()
```

### Test Fixtures

```python
# tests/conftest.py
import pytest
import os
from sqlalchemy import create_engine
from httpx import AsyncClient

@pytest.fixture
async def test_db():
    """Create test database."""
    db_url = os.getenv('TEST_DB_URL', 'postgresql://test:test@localhost/test')
    engine = create_engine(db_url)

    # Create tables
    Base.metadata.create_all(engine)

    yield engine

    # Cleanup
    Base.metadata.drop_all(engine)

@pytest.fixture
async def test_client(test_db):
    """Create test HTTP client."""
    app = create_app(test_db)
    async with AsyncClient(app=app, base_url="http://test") as client:
        yield client

@pytest.fixture
def mock_redis():
    """Mock Redis client."""
    return AsyncMock()
```

### Running Tests

```bash
# Run all tests with coverage
pytest --cov=. --cov-report=html --cov-report=term

# Run specific test file
pytest tests/test_auth.py -v

# Run with markers
pytest -m "not slow" -v

# Run in parallel
pytest -n auto
```

---

## Documentation Standards

### Module README Template

```markdown
# Module Name

Brief description of module purpose and functionality.

## Features

- Feature 1
- Feature 2
- Feature 3

## Architecture

Description of module architecture and design decisions.

## API Endpoints

### POST /api/v1/endpoint

Description of endpoint.

**Request**:
\```json
{
  "param1": "value",
  "param2": 123
}
\```

**Response**:
\```json
{
  "success": true,
  "data": {}
}
\```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| MODULE_PORT | Yes | 8000 | Service port |
| DB_HOST | Yes | - | Database host |

## Development

### Setup

\```bash
# Install dependencies
pip install -r requirements.txt

# Run locally
python main.py
\```

### Testing

\```bash
# Run tests
pytest

# Run with coverage
pytest --cov
\```

## Deployment

### Docker

\```bash
docker build -t waddlebot/module:latest .
docker run -p 8000:8000 waddlebot/module:latest
\```

## License

MIT License - See LICENSE file for details
```

### Code Documentation

```python
def function_name(param1: str, param2: int = 0) -> Dict[str, Any]:
    """
    Short one-line description.

    Longer description providing additional context and details
    about the function's purpose and behavior.

    Args:
        param1: Description of first parameter
        param2: Description of second parameter (default: 0)

    Returns:
        Dictionary containing:
            - key1 (str): Description
            - key2 (int): Description

    Raises:
        ValueError: If param1 is empty
        ServiceError: If external service fails

    Example:
        >>> result = function_name("test", 42)
        >>> print(result['key1'])
        'test_42'
    """
    pass
```

### API Documentation

Use OpenAPI/Swagger for API documentation:

```python
from quart_schema import QuartSchema, validate_request, validate_response
from dataclasses import dataclass

@dataclass
class UserRequest:
    """User creation request."""
    username: str
    email: str
    password: str

@dataclass
class UserResponse:
    """User response."""
    id: str
    username: str
    email: str
    created_at: str

@app.post('/api/v1/users')
@validate_request(UserRequest)
@validate_response(UserResponse, 201)
async def create_user(data: UserRequest) -> UserResponse:
    """
    Create new user.

    Creates a new user account with the provided credentials.
    """
    user = await dal.create_user(data.username, data.email, data.password)
    return UserResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        created_at=user.created_at.isoformat()
    )
```

---

## Deployment Checklist

Before deploying any module:

### Code Quality
- [ ] Passes Black formatting (`black --check .`)
- [ ] Passes Flake8 linting (`flake8 .`)
- [ ] Passes type checking (`mypy .`)
- [ ] All functions have docstrings
- [ ] No hardcoded credentials
- [ ] Comprehensive error handling

### Testing
- [ ] Unit tests written (>80% coverage)
- [ ] Integration tests pass
- [ ] Edge cases tested
- [ ] Performance benchmarked
- [ ] Load testing completed

### Security
- [ ] API authentication required
- [ ] Input validation on all endpoints
- [ ] Webhook signatures verified
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS protection (if applicable)
- [ ] Rate limiting implemented

### Logging
- [ ] AAA logging implemented
- [ ] No sensitive data in logs
- [ ] Structured logging format
- [ ] Log rotation configured

### Documentation
- [ ] README.md with setup instructions
- [ ] API endpoint documentation
- [ ] Environment variables documented
- [ ] Configuration examples provided
- [ ] Deployment guide included

### Docker
- [ ] Dockerfile present and tested
- [ ] Health check endpoint working
- [ ] All dependencies in requirements.txt
- [ ] Non-root user configured
- [ ] Multi-stage build (if applicable)

### Kubernetes
- [ ] Deployment YAML provided
- [ ] Environment variables externalized
- [ ] Resource limits defined
- [ ] Liveness probe configured
- [ ] Readiness probe configured

### Monitoring
- [ ] Metrics exposed (Prometheus format)
- [ ] Health check endpoint functional
- [ ] Alerts configured
- [ ] SLO defined

---

## Related Documentation

- **SECURITY.md**: Security policies and best practices
- **CLAUDE.md**: Project context and AI development guidelines
- **docs/reference/api-reference.md**: Complete API documentation
- **docs/architecture/**: Architecture documentation
- **docs/guides/**: Development guides

---

**Document Version**: 1.0
**Last Updated**: December 2025
**Next Review**: March 2026
**Owner**: Engineering Team
