# WaddleBot Module Conversion Guide

## Quick Reference: py4web → Flask/Quart

### Import Changes

```python
# OLD (py4web)
from py4web import action, request, response, Field, HTTP
from py4web.core import Fixture

# NEW (Flask/Quart)
from quart import Blueprint, request
from flask_core import async_endpoint, auth_required, success_response, error_response
```

### Endpoint Declaration

```python
# OLD
@action('endpoint_name', method=['POST'])
@action.uses(auth)
def my_endpoint():
    data = request.json
    return {"result": data}

# NEW
@bp.route('/endpoint_name', methods=['POST'])
@async_endpoint
@auth_required
async def my_endpoint():
    data = await request.get_json()
    return success_response(data)
```

### Database Operations

```python
# OLD
db = DAL(DATABASE_URL)
rows = db(query).select()
id = db.table.insert(**fields)

# NEW
dal = init_database(DATABASE_URL)
rows = await dal.select_async(query)
id = await dal.insert_async(table, **fields)
```

### Response Formats

```python
# OLD
return {"status": "ok", "data": result}
raise HTTP(400, "Error message")

# NEW
return success_response(result)
return error_response("Error message", status_code=400)
```

### Async Patterns

```python
# OLD (blocking)
result = some_blocking_call()
for item in items:
    process_item(item)

# NEW (async)
result = await some_async_call()
await asyncio.gather(*[process_item(item) for item in items])

# OR with Python 3.13 TaskGroup
async with asyncio.TaskGroup() as tg:
    for item in items:
        tg.create_task(process_item(item))
```

---

## Step-by-Step Conversion Process

### 1. Create Module Structure

```bash
mkdir -p module_name_flask/{services,controllers}
cd module_name_flask
```

### 2. Create Base Files

**app.py**:
```python
from quart import Quart
from flask_core import setup_aaa_logging, init_database
from config import Config

app = Quart(__name__)
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

@app.before_serving
async def startup():
    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal
    # Initialize services

@app.route('/health')
async def health():
    return {"status": "healthy"}, 200

if __name__ == '__main__':
    import hypercorn.asyncio, asyncio
    from hypercorn.config import Config as HyperConfig
    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
```

**config.py**:
```python
import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    MODULE_NAME = 'module_name'
    MODULE_VERSION = '2.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8000'))
    DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://...')
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
```

**requirements.txt**:
```
quart>=0.19.0
hypercorn>=0.16.0
-e ../libs/flask_core
httpx>=0.26.0
python-dotenv>=1.0.0
```

**Dockerfile**:
```dockerfile
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p /var/log/waddlebotlog
CMD ["hypercorn", "app:app", "--bind", "0.0.0.0:8000", "--workers", "4"]
```

### 3. Convert Controllers

For each py4web controller file:
1. Create Blueprint instead of action decorators
2. Convert to async functions
3. Update imports
4. Use flask_core utilities

### 4. Convert Services

For each service:
1. Make methods async
2. Update database calls to use AsyncDAL
3. Use httpx for HTTP requests (async)
4. Add proper error handling

### 5. Update Models

```python
# Use Python 3.13 dataclasses
from dataclasses import dataclass, field
from datetime import datetime

@dataclass(slots=True, frozen=True)
class Event:
    id: str
    title: str
    date: datetime
    created_at: datetime = field(default_factory=datetime.utcnow)
```

### 6. Add Logging

```python
from flask_core import get_logger

logger = get_logger('module_name')

logger.audit(
    action='create_event',
    user=username,
    community=community_id,
    result='SUCCESS',
    execution_time=100
)
```

### 7. Test Module

```bash
# Install dependencies
pip install -e .

# Run module
python app.py

# Test endpoints
curl http://localhost:8000/health
curl -X POST http://localhost:8000/api/v1/endpoint -H "Content-Type: application/json" -d '{"data": "test"}'
```

---

## Module-Specific Notes

### Collector Modules (Twitch, Discord, Slack)
- Keep platform-specific SDKs (py-cord, Slack SDK, etc.)
- Convert webhook handlers to Quart routes
- Make OAuth flows async
- Use coordination system for horizontal scaling

### Interaction Modules
- Convert command handlers to async
- Use AsyncDAL for database operations
- Integrate with router for responses
- Add comprehensive logging

### Core Modules (Portal, Marketplace, Identity)
- Portal: Create separate React frontend
- Marketplace: Async module installation
- Identity: Convert OAuth flows to Authlib

---

## Python 3.13 Features to Use

### 1. Dataclasses with Slots
```python
@dataclass(slots=True, frozen=True)
class MyData:
    field1: str
    field2: int
```

### 2. Structural Pattern Matching
```python
match event_type:
    case "subscription":
        await handle_subscription(event)
    case "follow" | "raid":
        await handle_activity(event)
    case _:
        logger.warning(f"Unknown type: {event_type}")
```

### 3. Type Aliases
```python
type Handler = Callable[[Request], Awaitable[Response]]
type EventProcessor = Callable[[Event], Awaitable[None]]
```

### 4. TaskGroup for Structured Concurrency
```python
async with asyncio.TaskGroup() as tg:
    for item in items:
        tg.create_task(process_item(item))
# All tasks completed or exception raised
```

---

## Common Pitfalls

### ❌ Don't Do This
```python
# Blocking operations
result = requests.get(url)  # Use httpx.AsyncClient

# Sync database calls
rows = db(query).select()  # Use await dal.select_async()

# Missing await
data = request.get_json()  # Use await request.get_json()
```

### ✅ Do This
```python
# Async HTTP
async with httpx.AsyncClient() as client:
    response = await client.get(url)

# Async database
rows = await dal.select_async(query)

# Proper async
data = await request.get_json()
```

---

## Checklist for Each Module

- [ ] Created module_name_flask/ directory
- [ ] app.py with Quart application
- [ ] config.py with all environment variables
- [ ] requirements.txt with dependencies
- [ ] Dockerfile with Python 3.13
- [ ] .env.example with configuration template
- [ ] All controllers converted to Blueprints
- [ ] All methods are async
- [ ] Using AsyncDAL for database
- [ ] Using httpx for HTTP requests
- [ ] AAA logging implemented
- [ ] Error handling added
- [ ] Type hints on all functions
- [ ] Dataclasses use slots=True
- [ ] Pattern matching where appropriate
- [ ] Unit tests written
- [ ] Integration tests written
- [ ] Documentation updated

---

## Examples

Complete examples available:
- **AI Interaction**: `/ai_interaction_module_flask/`
- **Router**: `/router_module_flask/`
- **Calendar**: `/calendar_interaction_module_flask/`

Use these as templates for other modules!
