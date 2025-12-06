# AI Researcher Module Services

## Overview

This directory contains service layer implementations for the AI Researcher module, providing core functionality for semantic memory management and AI-powered research capabilities.

## Services

### Mem0Service

**File:** `mem0_service.py`

**Purpose:** Integration with mem0 for community-wide semantic memory management using Ollama and Qdrant vector store.

#### Features

- **Semantic Memory Storage**: Store and retrieve community memories using vector embeddings
- **Multi-User Support**: Track memories per user or community-wide
- **Context Aggregation**: Build comprehensive community context from stored memories
- **Batch Processing**: Efficiently add multiple chat messages at once
- **Health Monitoring**: Built-in health check functionality

#### Configuration

The service uses configuration from `config.py`:

```python
# Ollama LLM Configuration
OLLAMA_HOST = 'localhost'
OLLAMA_PORT = '11434'
AI_MODEL = 'tinyllama'

# mem0 Embedder Configuration
MEM0_EMBEDDER_MODEL = 'nomic-embed-text'

# Qdrant Vector Store
QDRANT_URL = 'http://localhost:6333'
QDRANT_API_KEY = ''  # Optional
```

#### Usage Example

```python
from services import Mem0Service

# Initialize service for a community
service = Mem0Service(
    community_id=123,
    config={
        'ollama_host': 'localhost',
        'ollama_port': '11434',
        'ai_model': 'tinyllama',
        'embedder_model': 'nomic-embed-text',
        'qdrant_url': 'http://localhost:6333'
    }
)

# Add chat messages
await service.add_messages([
    {"role": "user", "content": "Hello!"},
    {"role": "assistant", "content": "Hi there!"}
])

# Add a memory
result = await service.add_memory(
    content="User prefers Python programming",
    user_id="user123",
    metadata={"category": "preference"}
)

# Search memories
results = await service.search("programming", limit=10)

# Get all memories for a user
memories = await service.get_all(user_id="user123")

# Get community-wide context
context = await service.get_community_context()

# Delete a memory
await service.delete_memory(memory_id="mem_123")

# Health check
is_healthy = await service.health_check()
```

#### Methods

##### `__init__(community_id: int, config: dict)`
Initialize the mem0 service for a specific community.

##### `async add_messages(messages: list[dict]) -> None`
Add chat messages to memory for semantic search.

**Parameters:**
- `messages`: List of message dicts with 'role' and 'content'

##### `async add_memory(content: str, user_id: str = None, metadata: dict = None) -> dict`
Add a single memory entry.

**Parameters:**
- `content`: Memory content text
- `user_id`: Optional user ID (defaults to community)
- `metadata`: Optional metadata dictionary

**Returns:**
- Dictionary with memory_id and status

##### `async search(query: str, limit: int = 10) -> list[dict]`
Search memories using semantic search.

**Parameters:**
- `query`: Search query text
- `limit`: Maximum number of results (default: 10)

**Returns:**
- List of matching memories with scores

##### `async get_all(user_id: str = None) -> list[dict]`
Get all memories for a user or community.

**Parameters:**
- `user_id`: Optional specific user ID (defaults to community)

**Returns:**
- List of all memories

##### `async delete_memory(memory_id: str) -> bool`
Delete a specific memory by ID.

**Parameters:**
- `memory_id`: Memory ID to delete

**Returns:**
- True if deletion was successful

##### `async get_community_context() -> dict`
Get aggregated context for the community.

**Returns:**
- Dictionary with:
  - `total_memories`: Count of stored memories
  - `recent_memories`: Most recent memory entries
  - `context_summary`: Aggregated context information

##### `async health_check() -> bool`
Check if mem0 service is healthy.

**Returns:**
- True if healthy, False otherwise

#### Memory Collection Structure

Each community gets its own Qdrant collection:
- Collection name: `community_{community_id}`
- Embeddings: Generated using Ollama's nomic-embed-text model
- Storage: Qdrant vector database

#### Error Handling

The service includes comprehensive error handling:
- `ValueError`: Invalid input parameters
- `RuntimeError`: Service not initialized
- All methods log errors with full stack traces
- Failed operations raise exceptions with descriptive messages

#### Logging

The service uses Python's standard logging module:
- `INFO`: Successful operations, counts, summaries
- `DEBUG`: Configuration details, health checks
- `ERROR`: Failures with stack traces

#### Performance Considerations

- **Batch Operations**: Use `add_messages()` for multiple messages
- **Concurrent Access**: Service is thread-safe per instance
- **Memory Limits**: Qdrant handles large-scale vector storage
- **Search Performance**: O(log n) with HNSW indexing

#### Dependencies

- `mem0ai>=0.1.0`: Core mem0 library
- `qdrant-client>=1.7.0`: Qdrant vector database client
- Ollama server running with required models

#### Testing

Run the test script:

```bash
cd /home/penguin/code/WaddleBot/core/ai_researcher_module/services
python3 test_mem0_service.py
```

**Prerequisites:**
- Ollama running on localhost:11434
- Qdrant running on localhost:6333
- Models installed: tinyllama, nomic-embed-text

## Architecture

```
Mem0Service
├── Initialization
│   ├── Load configuration
│   ├── Build mem0 config
│   └── Initialize Memory instance
├── Memory Operations
│   ├── Add messages (batch)
│   ├── Add memory (single)
│   ├── Search (semantic)
│   ├── Get all (retrieve)
│   └── Delete memory
├── Context Management
│   └── Get community context
└── Health Monitoring
    └── Health check
```

## Future Enhancements

- [ ] Memory deduplication based on semantic similarity
- [ ] Automatic memory pruning based on age/relevance
- [ ] Multi-provider support (other embedders)
- [ ] Memory categorization and tagging
- [ ] Export/import functionality
- [ ] Memory analytics and insights
- [ ] Cross-community memory search (with permissions)

## License

Part of WaddleBot - see main project LICENSE
