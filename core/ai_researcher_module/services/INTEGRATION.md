# AI Researcher Services Integration Guide

## Overview

This guide shows how to integrate the AI Researcher services into the module's workflow:
- `Mem0Service` - Semantic memory and context tracking
- `SummaryService` - Stream and weekly summaries
- `BotDetectionService` - Behavioral bot detection

## Table of Contents

1. [Mem0Service Integration](#mem0service-integration)
2. [SummaryService Integration](#summaryservice-integration)
3. [BotDetectionService Integration](#botdetectionservice-integration)

---

## Mem0Service Integration

## Integration Points

### 1. Controller Layer Integration

In your controller (e.g., `controllers/research_controller.py`):

```python
from quart import Blueprint, request, jsonify
from services import Mem0Service
from config import Config

research_bp = Blueprint('research', __name__)

# Initialize service instance (could be done in app startup)
mem0_service = None

@research_bp.before_app_first_request
async def init_mem0():
    """Initialize mem0 service on first request"""
    global mem0_service

    # Get community ID from request context or config
    community_id = Config.DEFAULT_COMMUNITY_ID

    mem0_service = Mem0Service(
        community_id=community_id,
        config=Config.get_mem0_config()
    )

@research_bp.route('/api/v1/research/context', methods=['POST'])
async def add_context():
    """Add messages to community context"""
    data = await request.get_json()

    messages = data.get('messages', [])

    # Add to mem0
    await mem0_service.add_messages(messages)

    return jsonify({"status": "success", "count": len(messages)}), 200

@research_bp.route('/api/v1/research/search', methods=['GET'])
async def search_context():
    """Search community context"""
    query = request.args.get('q', '')
    limit = int(request.args.get('limit', 10))

    # Search mem0
    results = await mem0_service.search(query, limit=limit)

    return jsonify({
        "query": query,
        "results": results,
        "count": len(results)
    }), 200

@research_bp.route('/api/v1/research/context/community', methods=['GET'])
async def get_community_context():
    """Get aggregated community context"""
    context = await mem0_service.get_community_context()

    return jsonify(context), 200
```

### 2. Service Layer Integration

Create a higher-level research service that uses Mem0Service:

```python
# services/research_service.py
from dataclasses import dataclass
from typing import Any
from .mem0_service import Mem0Service
from config import Config

@dataclass
class ResearchService:
    """High-level research service using mem0"""

    community_id: int

    def __post_init__(self):
        # Initialize mem0 service
        self.mem0 = Mem0Service(
            community_id=self.community_id,
            config=Config.get_mem0_config()
        )

    async def process_chat_message(
        self,
        user_id: str,
        message: str,
        platform: str
    ) -> dict[str, Any]:
        """Process a chat message and update context"""

        # Add to memory
        await self.mem0.add_messages([
            {
                "role": "user",
                "content": message,
                "metadata": {
                    "user_id": user_id,
                    "platform": platform
                }
            }
        ])

        # Search for relevant context
        context = await self.mem0.search(message, limit=5)

        return {
            "user_id": user_id,
            "message": message,
            "relevant_context": context
        }

    async def get_user_insights(self, user_id: str) -> dict[str, Any]:
        """Get insights about a specific user"""

        # Get all user memories
        memories = await self.mem0.get_all(user_id=user_id)

        return {
            "user_id": user_id,
            "total_interactions": len(memories),
            "memories": memories
        }

    async def summarize_community(self) -> dict[str, Any]:
        """Generate community summary"""

        # Get community context
        context = await self.mem0.get_community_context()

        # Use AI to generate summary (integrate with ai_provider)
        # This is where you'd call your AI provider with the context

        return context
```

### 3. Background Task Integration

Use mem0 with APScheduler for background processing:

```python
# app.py or background_tasks.py
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from services import Mem0Service
from config import Config

scheduler = AsyncIOScheduler()

async def update_community_memories():
    """Background task to process and update memories"""

    # Get recent chat logs from database
    # (integrate with your DAL layer)
    recent_messages = await fetch_recent_messages()

    # Process for each community
    for community_id, messages in recent_messages.items():
        mem0_service = Mem0Service(
            community_id=community_id,
            config=Config.get_mem0_config()
        )

        # Add messages in batch
        await mem0_service.add_messages(messages)

# Schedule to run every 5 minutes
scheduler.add_job(
    update_community_memories,
    'interval',
    minutes=5,
    id='update_memories'
)
```

### 4. App Initialization

Initialize mem0 service in your Quart app:

```python
# app.py
from quart import Quart
from services import Mem0Service
from config import Config

app = Quart(__name__)

# Store mem0 services per community
mem0_services = {}

@app.before_serving
async def init_services():
    """Initialize services before serving requests"""

    # Health check Qdrant
    logger.info("Initializing mem0 services...")

    # Create default service
    default_service = Mem0Service(
        community_id=1,
        config=Config.get_mem0_config()
    )

    # Health check
    if await default_service.health_check():
        logger.info("mem0 service healthy")
        mem0_services[1] = default_service
    else:
        logger.error("mem0 service health check failed")

def get_mem0_service(community_id: int) -> Mem0Service:
    """Get or create mem0 service for a community"""

    if community_id not in mem0_services:
        mem0_services[community_id] = Mem0Service(
            community_id=community_id,
            config=Config.get_mem0_config()
        )

    return mem0_services[community_id]

# Make available to request context
@app.before_request
async def inject_mem0():
    """Inject mem0 service into request context"""
    from quart import g

    # Get community ID from request headers or session
    community_id = request.headers.get('X-Community-ID', 1)
    g.mem0 = get_mem0_service(int(community_id))
```

## Configuration

Ensure your `config.py` has the helper method:

```python
@classmethod
def get_mem0_config(cls):
    """Get mem0 configuration"""
    return {
        'ollama_host': cls.OLLAMA_HOST,
        'ollama_port': cls.OLLAMA_PORT,
        'ai_model': cls.AI_MODEL,
        'embedder_model': cls.MEM0_EMBEDDER_MODEL,
        'qdrant_url': cls.QDRANT_URL,
        'qdrant_api_key': cls.QDRANT_API_KEY
    }
```

## Best Practices

### 1. Batch Operations
Always prefer batch operations for multiple messages:

```python
# Good - single batch operation
await mem0_service.add_messages(messages)

# Bad - multiple individual operations
for msg in messages:
    await mem0_service.add_memory(msg['content'])
```

### 2. Error Handling
Always wrap mem0 operations in try-except:

```python
try:
    results = await mem0_service.search(query)
except Exception as e:
    logger.error(f"Search failed: {e}")
    results = []  # Return empty results
```

### 3. Context Enrichment
Use mem0 to enrich AI prompts:

```python
async def get_enriched_prompt(query: str, mem0_service: Mem0Service):
    """Get AI prompt enriched with context"""

    # Search relevant memories
    context = await mem0_service.search(query, limit=5)

    # Build enriched prompt
    prompt = f"Query: {query}\n\nRelevant context:\n"
    for i, mem in enumerate(context, 1):
        prompt += f"{i}. {mem['memory']}\n"

    return prompt
```

### 4. Health Monitoring
Regularly check service health:

```python
@app.route('/health')
async def health_check():
    """Health check endpoint"""

    mem0_healthy = await mem0_service.health_check()

    return jsonify({
        "status": "healthy" if mem0_healthy else "unhealthy",
        "services": {
            "mem0": mem0_healthy
        }
    }), 200 if mem0_healthy else 503
```

## Performance Tuning

### Connection Pooling
Reuse Mem0Service instances per community:

```python
# Global cache of services
_service_cache = {}

def get_cached_service(community_id: int) -> Mem0Service:
    """Get cached service instance"""
    if community_id not in _service_cache:
        _service_cache[community_id] = Mem0Service(
            community_id=community_id,
            config=Config.get_mem0_config()
        )
    return _service_cache[community_id]
```

### Async Processing
Process memory operations asynchronously:

```python
import asyncio

async def process_messages_async(messages: list[dict]):
    """Process messages without blocking"""

    # Create task for background processing
    asyncio.create_task(mem0_service.add_messages(messages))

    # Return immediately
    return {"status": "processing"}
```

## Testing

Test mem0 integration:

```python
# tests/test_mem0_integration.py
import pytest
from services import Mem0Service

@pytest.mark.asyncio
async def test_mem0_service():
    """Test mem0 service integration"""

    service = Mem0Service(
        community_id=999,  # Test community
        config={
            'ollama_host': 'localhost',
            'ollama_port': '11434',
            'ai_model': 'tinyllama',
            'embedder_model': 'nomic-embed-text',
            'qdrant_url': 'http://localhost:6333'
        }
    )

    # Test add messages
    messages = [
        {"role": "user", "content": "Test message"}
    ]
    await service.add_messages(messages)

    # Test search
    results = await service.search("test", limit=1)
    assert len(results) >= 0

    # Test context
    context = await service.get_community_context()
    assert context['community_id'] == 999
```

## Troubleshooting

### Connection Issues
If Qdrant or Ollama is unreachable:

```python
try:
    service = Mem0Service(community_id=1, config=config)
except Exception as e:
    logger.error(f"Failed to initialize mem0: {e}")
    # Fallback to non-semantic storage
    use_fallback_storage()
```

### Memory Not Found
Handle empty search results gracefully:

```python
results = await mem0_service.search(query)
if not results:
    logger.info(f"No results found for query: {query}")
    results = []  # Return empty list
```

### Performance Issues
Monitor search latency:

```python
import time

start = time.time()
results = await mem0_service.search(query)
latency = time.time() - start

logger.info(f"Search latency: {latency:.2f}s")
```

---

## SummaryService Integration

### Overview

`SummaryService` generates AI-powered stream and weekly summaries with insights extraction.

### Initialization

```python
from services import SummaryService
from config import Config

# Initialize service (in app.py or startup)
summary_service = SummaryService(
    ai_provider=ai_provider,  # Your AI provider instance
    mem0_service=mem0_service,  # Mem0 service for embeddings
    db_connection=dal  # Database connection
)
```

### 1. Stream Summary Generation

Generate a summary after a stream ends:

```python
from datetime import datetime, timedelta

@app.route('/api/v1/stream/end', methods=['POST'])
async def handle_stream_end():
    """Handle stream end event"""
    data = await request.get_json()
    
    community_id = data['community_id']
    stream_start = datetime.fromisoformat(data['stream_start'])
    stream_end = datetime.fromisoformat(data['stream_end'])
    
    # Generate stream summary
    summary = await summary_service.generate_stream_summary(
        community_id=community_id,
        stream_start=stream_start,
        stream_end=stream_end
    )
    
    return jsonify({
        'success': True,
        'insight_id': summary['insight_id'],
        'summary': summary['summary'],
        'key_topics': summary['key_topics'],
        'viewer_stats': summary['viewer_stats']
    })
```

### 2. Weekly Summary Generation

Generate weekly rollup (scheduled task):

```python
from apscheduler.schedulers.asyncio import AsyncIOScheduler

scheduler = AsyncIOScheduler()

async def generate_weekly_summaries():
    """Background task to generate weekly summaries"""
    
    # Get all active communities
    communities = await get_active_communities()
    
    for community_id in communities:
        try:
            summary = await summary_service.generate_weekly_summary(
                community_id=community_id
            )
            
            logger.info(f"Weekly summary generated for {community_id}")
            
            # Send webhook if configured
            await send_summary_webhook(community_id, summary)
            
        except Exception as e:
            logger.error(f"Failed to generate weekly summary: {e}")

# Schedule for Sunday 9 AM UTC
scheduler.add_job(
    generate_weekly_summaries,
    'cron',
    day_of_week='sun',
    hour=9,
    id='weekly_summaries'
)
```

### 3. Recent Summaries Retrieval

Get recent summaries for display:

```python
@app.route('/api/v1/admin/<int:community_id>/summaries')
async def get_summaries(community_id: int):
    """Get recent summaries for a community"""
    
    limit = request.args.get('limit', 10, type=int)
    
    summaries = await summary_service.get_recent_summaries(
        community_id=community_id,
        limit=limit
    )
    
    return jsonify({
        'community_id': community_id,
        'summaries': summaries,
        'count': len(summaries)
    })
```

### 4. Custom Insight Saving

Save custom insights:

```python
async def save_custom_insight(community_id: int, data: dict):
    """Save a custom insight"""
    
    insight_id = await summary_service.save_insight(
        community_id=community_id,
        insight_type='custom',
        title=data['title'],
        content=data['content'],
        metadata=data.get('metadata', {})
    )
    
    return insight_id
```

### Response Format

#### Stream Summary Response

```json
{
    "insight_id": 123,
    "title": "Stream Summary - Jan 15, 2025",
    "summary": "Today's stream featured discussions about...",
    "key_topics": ["gaming", "tech", "community"],
    "notable_moments": [
        "100 viewer milestone",
        "First time raided by streamerXYZ"
    ],
    "viewer_stats": {
        "unique_chatters": 150,
        "avg_messages_per_user": 5.2,
        "total_messages": 780
    },
    "sentiment": "positive"
}
```

#### Weekly Summary Response

```json
{
    "insight_id": 124,
    "title": "Weekly Summary - Week of Jan 15, 2025",
    "summary": "This week saw increased engagement with...",
    "top_chatters": [
        {"user": "user123", "count": 450},
        {"user": "user456", "count": 320}
    ],
    "popular_topics": ["gaming", "tech", "community"],
    "sentiment_trend": "positive",
    "stream_count": 5,
    "total_messages": 10000
}
```

---

## BotDetectionService Integration

### Overview

`BotDetectionService` analyzes user behavior to detect potential bots with multi-signal analysis.

### Initialization

```python
from services import BotDetectionService

# Initialize service (in app.py or startup)
bot_detection_service = BotDetectionService(
    db_connection=dal,
    is_premium=True  # Enable detailed signals for premium communities
)
```

### 1. Analyze All Users (Post-Stream)

Run bot detection after a stream:

```python
from datetime import datetime, timedelta

@app.route('/api/v1/stream/analyze-bots', methods=['POST'])
async def analyze_stream_bots():
    """Analyze users for bot behavior after stream"""
    data = await request.get_json()
    
    community_id = data['community_id']
    stream_start = datetime.fromisoformat(data['stream_start'])
    stream_end = datetime.fromisoformat(data['stream_end'])
    
    # Analyze all users
    results = await bot_detection_service.analyze_users(
        community_id=community_id,
        period_start=stream_start,
        period_end=stream_end
    )
    
    # Filter high-confidence results
    flagged_users = [r for r in results if r.confidence_score >= 70]
    
    # Save results to database
    if results:
        # Create insight first
        insight_id = await summary_service.save_insight(
            community_id=community_id,
            insight_type='bot_detection',
            title=f"Bot Detection - {stream_end.strftime('%b %d, %Y')}",
            content=f"Analyzed {len(results)} users, flagged {len(flagged_users)}",
            metadata={'flagged_count': len(flagged_users)}
        )
        
        # Save detailed results
        await bot_detection_service.save_results(
            community_id=community_id,
            insight_id=insight_id,
            results=results
        )
    
    return jsonify({
        'success': True,
        'total_analyzed': len(results),
        'flagged_users': [r.to_dict() for r in flagged_users]
    })
```

### 2. Analyze Specific User

Analyze a single user on demand:

```python
@app.route('/api/v1/admin/<int:community_id>/analyze-user/<user_id>')
async def analyze_user(community_id: int, user_id: str):
    """Analyze specific user for bot behavior"""
    
    result = await bot_detection_service.analyze_user(
        community_id=community_id,
        user_id=user_id
    )
    
    return jsonify({
        'success': True,
        'user_id': user_id,
        'analysis': result.to_dict()
    })
```

### 3. Get At-Risk Users

Retrieve users flagged as potential bots:

```python
@app.route('/api/v1/admin/<int:community_id>/at-risk-users')
async def get_at_risk_users(community_id: int):
    """Get users flagged as potential bots"""
    
    threshold = request.args.get('threshold', 85, type=int)
    
    at_risk = await bot_detection_service.get_at_risk_users(
        community_id=community_id,
        threshold=threshold
    )
    
    return jsonify({
        'community_id': community_id,
        'threshold': threshold,
        'users': [r.to_dict() for r in at_risk],
        'count': len(at_risk)
    })
```

### 4. Weekly Bot Detection

Schedule weekly bot detection:

```python
async def run_weekly_bot_detection():
    """Background task for weekly bot detection"""
    
    communities = await get_active_premium_communities()
    
    for community_id in communities:
        try:
            # Analyze last 7 days
            period_end = datetime.utcnow()
            period_start = period_end - timedelta(days=7)
            
            results = await bot_detection_service.analyze_users(
                community_id=community_id,
                period_start=period_start,
                period_end=period_end
            )
            
            # Save to database
            flagged = [r for r in results if r.confidence_score >= 50]
            
            if flagged:
                insight_id = await summary_service.save_insight(
                    community_id=community_id,
                    insight_type='bot_detection',
                    title=f"Weekly Bot Detection - {period_end.strftime('%b %d, %Y')}",
                    content=f"Flagged {len(flagged)} potential bots"
                )
                
                await bot_detection_service.save_results(
                    community_id=community_id,
                    insight_id=insight_id,
                    results=results
                )
                
                # Send alert webhook
                await send_bot_alert_webhook(community_id, flagged)
                
        except Exception as e:
            logger.error(f"Weekly bot detection failed: {e}")

scheduler.add_job(
    run_weekly_bot_detection,
    'cron',
    day_of_week='sun',
    hour=10,
    id='weekly_bot_detection'
)
```

### Response Format

#### BotDetectionResult

```json
{
    "user_id": "12345",
    "username": "suspicious_user",
    "confidence_score": 87.5,
    "signals": {
        "timing_regularity": 4.2,
        "response_latency_avg": 850.5,
        "emote_text_ratio": 0.85,
        "copy_paste_frequency": 5,
        "vocabulary_diversity": 0.25,
        "account_age_days": 3
    },
    "recommended_action": "timeout"
}
```

**Note**: Free tier users only see `confidence_score`; premium users get all signals.

### Signal Thresholds

```python
THRESHOLDS = {
    'timing_regularity_high': 5.0,      # < 5s = very regular
    'response_latency_fast': 1000,      # < 1s = very fast
    'emote_ratio_high': 0.8,            # > 80% emotes
    'vocabulary_diversity_low': 0.3,    # < 30% unique
    'copy_paste_min_users': 3           # Same msg from 3+ users
}

ACTION_THRESHOLDS = {
    'monitor': 50,   # 50-69
    'warn': 70,      # 70-84
    'timeout': 85,   # 85-94
    'ban': 95        # 95+
}
```

### Premium vs Free Tier

**Premium Communities:**
- Full signal breakdown
- Detailed behavioral patterns
- Custom thresholds
- Webhook alerts

**Free Communities:**
- Summary confidence score only
- Basic recommended action
- No detailed signals

---

## Combined Workflow Example

### Complete Post-Stream Analysis

```python
async def post_stream_analysis(community_id: int, stream_start: datetime, stream_end: datetime):
    """Complete post-stream analysis workflow"""
    
    logger.info(f"Starting post-stream analysis for community {community_id}")
    
    # 1. Generate stream summary
    summary = await summary_service.generate_stream_summary(
        community_id=community_id,
        stream_start=stream_start,
        stream_end=stream_end
    )
    
    logger.info(f"Stream summary generated: {summary['insight_id']}")
    
    # 2. Run bot detection (if premium)
    is_premium = await check_premium_status(community_id)
    
    if is_premium:
        bot_results = await bot_detection_service.analyze_users(
            community_id=community_id,
            period_start=stream_start,
            period_end=stream_end
        )
        
        flagged = [r for r in bot_results if r.confidence_score >= 85]
        
        if flagged:
            # Create bot detection insight
            bot_insight_id = await summary_service.save_insight(
                community_id=community_id,
                insight_type='bot_detection',
                title=f"Bot Detection - {stream_end.strftime('%b %d')}",
                content=f"Flagged {len(flagged)} potential bots",
                metadata={'flagged_count': len(flagged)}
            )
            
            # Save detailed results
            await bot_detection_service.save_results(
                community_id=community_id,
                insight_id=bot_insight_id,
                results=bot_results
            )
            
            logger.info(f"Bot detection complete: {len(flagged)} flagged")
    
    # 3. Send webhook notifications
    await send_analysis_webhook(community_id, summary, flagged if is_premium else [])
    
    logger.info("Post-stream analysis complete")
    
    return {
        'summary': summary,
        'bot_detection': {
            'enabled': is_premium,
            'flagged_count': len(flagged) if is_premium else 0
        }
    }
```

## Best Practices

### 1. Error Handling

Always wrap service calls in try-except:

```python
try:
    summary = await summary_service.generate_stream_summary(...)
except Exception as e:
    logger.error(f"Summary generation failed: {e}")
    # Handle gracefully
```

### 2. Background Processing

Use async tasks for long-running operations:

```python
import asyncio

# Don't block request
asyncio.create_task(summary_service.generate_stream_summary(...))
```

### 3. Rate Limiting

Implement rate limits for expensive operations:

```python
from services import RateLimiter

rate_limiter = RateLimiter(redis_client=redis, db_connection=dal)

# Check before analysis
allowed = await rate_limiter.check_rate_limit(
    key=f"bot_detection:{community_id}",
    limit=5,
    window_seconds=3600
)

if not allowed:
    return error_response("Rate limit exceeded", 429)
```

### 4. Caching

Cache recent summaries:

```python
import redis.asyncio as aioredis

redis_client = aioredis.from_url(Config.REDIS_URL)

async def get_cached_summary(community_id: int, insight_id: int):
    """Get summary from cache or database"""
    
    cache_key = f"summary:{community_id}:{insight_id}"
    
    # Try cache first
    cached = await redis_client.get(cache_key)
    if cached:
        return json.loads(cached)
    
    # Fetch from database
    summaries = await summary_service.get_recent_summaries(
        community_id=community_id,
        limit=1
    )
    
    if summaries:
        # Cache for 1 hour
        await redis_client.setex(
            cache_key,
            3600,
            json.dumps(summaries[0])
        )
        return summaries[0]
    
    return None
```

## Testing

### Test SummaryService

```python
import pytest
from datetime import datetime, timedelta

@pytest.mark.asyncio
async def test_stream_summary():
    """Test stream summary generation"""
    
    # Setup
    summary_service = SummaryService(ai_provider, mem0, dal)
    
    stream_start = datetime.utcnow() - timedelta(hours=2)
    stream_end = datetime.utcnow()
    
    # Generate summary
    result = await summary_service.generate_stream_summary(
        community_id=1,
        stream_start=stream_start,
        stream_end=stream_end
    )
    
    assert result['insight_id'] is not None
    assert 'summary' in result
    assert 'key_topics' in result
```

### Test BotDetectionService

```python
@pytest.mark.asyncio
async def test_bot_detection():
    """Test bot detection"""
    
    # Setup
    bot_service = BotDetectionService(dal, is_premium=True)
    
    period_end = datetime.utcnow()
    period_start = period_end - timedelta(days=1)
    
    # Analyze users
    results = await bot_service.analyze_users(
        community_id=1,
        period_start=period_start,
        period_end=period_end
    )
    
    assert isinstance(results, list)
    for result in results:
        assert 0 <= result.confidence_score <= 100
        assert result.recommended_action in ['none', 'monitor', 'warn', 'timeout', 'ban']
```

