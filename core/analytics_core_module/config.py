"""
Analytics Core Module Configuration
"""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    """Analytics module configuration from environment variables."""

    # Module identity
    MODULE_NAME = 'analytics-core'
    MODULE_VERSION = '1.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8040'))

    # Database
    DATABASE_URL = os.getenv(
        'DATABASE_URL',
        'postgresql://waddlebot:waddlebot123@localhost:5432/waddlebot'
    )

    # Redis for caching
    REDIS_HOST = os.getenv('REDIS_HOST', 'localhost')
    REDIS_PORT = int(os.getenv('REDIS_PORT', '6379'))
    REDIS_PASSWORD = os.getenv('REDIS_PASSWORD', '')
    REDIS_DB = int(os.getenv('REDIS_DB', '0'))

    # Internal service URLs
    ROUTER_API_URL = os.getenv(
        'ROUTER_API_URL',
        'http://router:8000/api/v1/router'
    )
    REPUTATION_API_URL = os.getenv(
        'REPUTATION_API_URL',
        'http://reputation:8021/api/v1/reputation'
    )

    # Logging
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    SECRET_KEY = os.getenv('SECRET_KEY', 'change-me-in-production')
    SERVICE_API_KEY = os.getenv('SERVICE_API_KEY', '')

    # Analytics configuration
    DEFAULT_POLLING_INTERVAL = 30  # seconds
    DEFAULT_RAW_RETENTION_DAYS = 30
    DEFAULT_AGGREGATED_RETENTION_DAYS = 365

    # Time bucket sizes
    BUCKET_SIZES = ['1h', '1d', '1w', '1m']

    # Premium feature requirements
    PREMIUM_FEATURES = [
        'community_health',
        'bad_actor_detection',
        'user_journey',
        'retention_cohorts',
        'engagement_funnels'
    ]

    # Health grade thresholds
    HEALTH_GRADES = {
        'A+': {'min': 95, 'max': 100},
        'A': {'min': 90, 'max': 94},
        'B+': {'min': 85, 'max': 89},
        'B': {'min': 80, 'max': 84},
        'C+': {'min': 75, 'max': 79},
        'C': {'min': 70, 'max': 74},
        'D': {'min': 60, 'max': 69},
        'F': {'min': 0, 'max': 59}
    }
