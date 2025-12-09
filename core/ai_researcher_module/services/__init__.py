"""
AI Researcher Module Services
==============================

Service layer for AI Researcher module including:
- AI provider abstraction (Ollama, OpenAI, Anthropic)
- mem0 integration for semantic memory
- Rate limiting with Redis primary and DB fallback
- Summary service for stream and weekly summaries
- Bot detection service for behavioral analysis
- Community insights generation and analysis
- Anomaly detection and alerting
- User behavior profiling
- Sentiment analysis and trends
"""

from .ai_provider import AIProvider, AIResponse, AIProviderService
from .mem0_service import Mem0Service
from .rate_limiter import RateLimiter, RateLimitResult
from .summary_service import SummaryService
from .bot_detection import BotDetectionService, BotDetectionResult
from .research_service import ResearchService, ResearchResult
from .insights_service import InsightsService, InsightResult
from .anomaly_detector import AnomalyDetector, AnomalyResult
from .behavior_profiler import BehaviorProfiler, BehaviorProfile
from .sentiment_analyzer import SentimentAnalyzer, SentimentResult

__all__ = [
    'AIProvider',
    'AIResponse',
    'AIProviderService',
    'Mem0Service',
    'RateLimiter',
    'RateLimitResult',
    'SummaryService',
    'BotDetectionService',
    'BotDetectionResult',
    'ResearchService',
    'ResearchResult',
    'InsightsService',
    'InsightResult',
    'AnomalyDetector',
    'AnomalyResult',
    'BehaviorProfiler',
    'BehaviorProfile',
    'SentimentAnalyzer',
    'SentimentResult',
]
