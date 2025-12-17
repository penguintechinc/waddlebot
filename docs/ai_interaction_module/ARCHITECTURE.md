# AI Interaction Module - Architecture

## System Overview

The AI Interaction Module is a Quart-based asynchronous microservice that provides intelligent chat responses for streaming communities using pluggable AI provider backends.

```
┌─────────────────────────────────────────────────────────────┐
│                   AI Interaction Module                      │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │   Quart App  │───▶│  AI Service  │───▶│   Providers  │ │
│  │  (app.py)    │    │              │    │              │ │
│  └──────────────┘    └──────────────┘    └──────────────┘ │
│         │                    │                    │         │
│         │                    │                    ├─Ollama  │
│         ▼                    ▼                    └─WaddleAI│
│  ┌──────────────┐    ┌──────────────┐                      │
│  │   Router     │    │Cache Manager │                      │
│  │   Service    │    │              │                      │
│  └──────────────┘    └──────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Component Architecture

### 1. Application Layer (app.py)

**Framework:** Quart (async Flask alternative)
**Port:** 8005 (default)

**Responsibilities:**
- HTTP request handling
- Route registration
- Service initialization
- Health checks
- Request validation

**Key Components:**
- Main app instance
- Blueprint registration (ai_bp, health_bp)
- Startup/shutdown lifecycle management
- Error handling middleware

### 2. Service Layer

#### AI Service (services/ai_service.py)

**Purpose:** Core AI interaction logic

**Responsibilities:**
- Provider selection and initialization
- Response generation
- Context management
- Prompt construction
- Error handling and retries

**Key Methods:**
```python
class AIService:
    @classmethod
    def create() -> AIService
    async def health_check() -> bool
    async def generate_response(
        message_content: str,
        message_type: str,
        user_id: str,
        platform: str,
        context: dict
    ) -> str
    async def get_available_models() -> list
```

#### Router Service (services/router_service.py)

**Purpose:** Communication with router module

**Responsibilities:**
- Submit responses back to router
- Handle router communication errors
- Retry logic for failed submissions

**Key Methods:**
```python
class RouterService:
    async def submit_response(response_data: dict) -> bool
```

#### Cache Manager (services/cache_manager.py)

**Purpose:** Conversation context caching

**Responsibilities:**
- Store recent messages per user/session
- Retrieve conversation history
- Context cleanup and expiry
- Memory management

---

### 3. Provider Layer

#### Ollama Provider (services/ollama_provider.py)

**Purpose:** Direct Ollama server integration

**Features:**
- HTTP/HTTPS connection support
- TLS certificate handling
- Streaming response support
- Connection pooling
- Circuit breaker pattern

**Configuration:**
- Host/port/TLS settings
- Model selection
- Temperature/max_tokens
- Timeout configuration

#### WaddleAI Provider (services/waddleai_provider.py)

**Purpose:** WaddleAI proxy integration

**Features:**
- Centralized API key management
- Intelligent model routing
- Multi-provider support
- Automatic fallback
- Usage tracking

**Configuration:**
- Base URL and API key
- Model preferences
- Routing rules
- Timeout settings

---

## Data Flow

### Interaction Request Flow

```
1. Router → POST /api/v1/ai/interaction
   ├─ Validate request data
   ├─ Extract user context
   └─ Return immediate ACK

2. Async Processing
   ├─ Check trigger patterns
   │  ├─ Greetings (hi, hello, o7)
   │  ├─ Farewells (bye, !lurk)
   │  ├─ Questions (contains ?)
   │  └─ Events (sub, follow, raid)
   │
   ├─ Retrieve conversation context
   │  └─ Cache Manager → Last N messages
   │
   ├─ Build prompt
   │  ├─ System prompt
   │  ├─ Conversation history
   │  └─ Current message
   │
   ├─ Call AI Provider
   │  ├─ Ollama direct OR
   │  └─ WaddleAI proxy
   │
   └─ Submit response to router
      └─ POST /api/v1/router/response

3. Router receives response
   └─ Delivers to platform
```

### Chat Completions Flow

```
1. Client → POST /api/v1/ai/chat/completions
   ├─ Authenticate request
   ├─ Validate messages array
   └─ Extract parameters

2. Process Request
   ├─ Build context from messages
   ├─ Generate AI response
   └─ Format OpenAI-compatible response

3. Return Response
   └─ {id, object, created, model, choices, usage}
```

---

## Database Schema

### Context Storage

```sql
-- Conversation context (if persisted)
CREATE TABLE ai_conversation_context (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    message_role VARCHAR(20) NOT NULL, -- user/assistant
    message_content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),

    INDEX idx_session (session_id),
    INDEX idx_user_platform (user_id, platform)
);
```

### Configuration Storage

```sql
-- Community-specific AI config
CREATE TABLE ai_module_config (
    community_id INTEGER PRIMARY KEY,
    provider VARCHAR(50) DEFAULT 'waddleai',
    model VARCHAR(100),
    temperature FLOAT DEFAULT 0.7,
    max_tokens INTEGER DEFAULT 500,
    system_prompt TEXT,
    api_key_encrypted TEXT,
    base_url VARCHAR(500),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Async Architecture

### Event Loop Management

**Framework:** Quart with asyncio
**Server:** Hypercorn (ASGI)

**Async Components:**
1. **Request Handlers**: All endpoints are async
2. **AI Provider Calls**: Non-blocking HTTP requests
3. **Database Operations**: Async DAL (AsyncDAL)
4. **Router Communication**: Async HTTP client
5. **Background Tasks**: asyncio.create_task()

### Concurrency Control

```python
# Semaphore for concurrent request limiting
semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

async def process_interaction():
    async with semaphore:
        # Process request
        response = await ai_service.generate_response(...)
```

---

## Error Handling

### Circuit Breaker Pattern

```python
class CircuitBreaker:
    States: CLOSED → OPEN → HALF_OPEN

    Triggers:
    - Failure threshold (5 failures)
    - Timeout threshold (30s)

    Recovery:
    - Wait period (60s)
    - Test request in half-open state
```

### Retry Strategy

```python
# Exponential backoff with jitter
retry_delays = [1, 2, 4, 8, 16]  # seconds
max_retries = 5

for attempt in range(max_retries):
    try:
        return await provider.generate()
    except Exception as e:
        if attempt < max_retries - 1:
            await asyncio.sleep(retry_delays[attempt])
        else:
            raise
```

---

## Logging Architecture

### Structured Logging (AAA Format)

**Levels:**
- **system**: Lifecycle events (startup, shutdown)
- **audit**: Security and compliance events
- **error**: Error conditions
- **info**: Informational messages
- **debug**: Detailed debugging

**Log Format:**
```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "level": "audit",
  "module": "ai_interaction_module",
  "action": "process_interaction",
  "user": "johndoe",
  "community": "twitch:channel:123",
  "result": "SUCCESS",
  "execution_time": 1250,
  "message": "AI response generated"
}
```

---

## Security Architecture

### Authentication Layers

1. **API Key Authentication**
   - Header-based: `Authorization: Bearer <key>`
   - Validated against VALID_API_KEYS config

2. **Service-to-Service**
   - Router uses internal API key
   - Trusted network communication

### Data Protection

1. **API Key Encryption**
   - Provider API keys encrypted at rest
   - Decrypted only in memory

2. **PII Handling**
   - User IDs hashed for logging
   - Message content not persisted (default)

---

## Scalability Design

### Horizontal Scaling

**Stateless Design:**
- No session affinity required
- Shared database for configuration
- Redis for distributed caching (optional)

**Load Balancing:**
```
┌─────────┐
│  Nginx  │
└────┬────┘
     │
     ├─── AI Module Instance 1 (Port 8005)
     ├─── AI Module Instance 2 (Port 8006)
     └─── AI Module Instance 3 (Port 8007)
```

### Caching Strategy

1. **Conversation Context**: In-memory with Redis fallback
2. **Model Lists**: Cached for 1 hour
3. **Configuration**: Cached with TTL

---

## Monitoring & Observability

### Health Checks

```
GET /health → Module health
GET /metrics → Prometheus metrics
```

### Metrics Collected

- Request count by endpoint
- Response times (p50, p95, p99)
- AI provider latencies
- Error rates by type
- Cache hit/miss ratios
- Concurrent request counts

### Tracing

- Request ID propagation
- Distributed tracing support
- Execution time tracking

---

## Deployment Architecture

### Container Structure

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["python", "app.py"]
```

### Environment Separation

**Development:**
- Local Ollama instance
- Debug logging
- Mock router responses

**Staging:**
- WaddleAI staging endpoint
- Info logging
- Real router integration

**Production:**
- WaddleAI production endpoint
- Error logging with audit
- HA router cluster
- Redis-backed caching

---

## Dependencies

### Core Dependencies

- `quart>=0.19.0` - ASGI web framework
- `hypercorn>=0.15.0` - ASGI server
- `httpx>=0.25.0` - Async HTTP client
- `pydantic>=2.0.0` - Data validation
- `asyncpg>=0.29.0` - Async PostgreSQL driver

### Provider-Specific

- `ollama` (optional) - Ollama Python SDK
- `openai` (optional) - OpenAI SDK for WaddleAI compatibility

---

## Testing Architecture

### Unit Tests
- Provider mocking
- Service layer testing
- Validation testing

### Integration Tests
- Full request/response flow
- Database interactions
- Router communication

### Load Tests
- Concurrent request handling
- Provider timeout scenarios
- Memory leak detection

---

## Future Enhancements

1. **WebSocket Support**: Real-time streaming responses
2. **Multi-Model Routing**: Intelligent model selection per request type
3. **Fine-Tuning Integration**: Custom model support
4. **Advanced Context**: Multi-turn conversation with vector search
5. **A/B Testing**: Response quality comparison
6. **Rate Limiting**: Per-user/community limits
