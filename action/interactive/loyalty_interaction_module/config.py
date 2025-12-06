"""
Loyalty Interaction Module Configuration
"""
import os


class Config:
    """Configuration from environment variables"""

    # Module info
    MODULE_NAME = 'loyalty_interaction_module'
    MODULE_VERSION = '1.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8032'))

    # Database
    DATABASE_URL = os.getenv(
        'DATABASE_URL',
        'postgresql://waddlebot:waddlebot_secret@localhost:5432/waddlebot'
    )

    # Redis
    REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379')

    # Internal service URLs
    ROUTER_API_URL = os.getenv('ROUTER_API_URL', 'http://router:8000')
    REPUTATION_API_URL = os.getenv('REPUTATION_API_URL', 'http://reputation:8021')

    # Service authentication
    SERVICE_API_KEY = os.getenv('SERVICE_API_KEY', '')

    # Default earning rates
    DEFAULT_EARN_CHAT = int(os.getenv('DEFAULT_EARN_CHAT', '1'))
    DEFAULT_EARN_CHAT_COOLDOWN = int(os.getenv('DEFAULT_EARN_CHAT_COOLDOWN', '60'))
    DEFAULT_EARN_WATCH_TIME = int(os.getenv('DEFAULT_EARN_WATCH_TIME', '2'))
    DEFAULT_EARN_FOLLOW = int(os.getenv('DEFAULT_EARN_FOLLOW', '50'))
    DEFAULT_EARN_SUB_T1 = int(os.getenv('DEFAULT_EARN_SUB_T1', '500'))
    DEFAULT_EARN_SUB_T2 = int(os.getenv('DEFAULT_EARN_SUB_T2', '1000'))
    DEFAULT_EARN_SUB_T3 = int(os.getenv('DEFAULT_EARN_SUB_T3', '2500'))

    # Gambling limits
    MIN_BET = int(os.getenv('MIN_BET', '10'))
    MAX_BET = int(os.getenv('MAX_BET', '10000'))

    # Giveaway defaults
    GIVEAWAY_REPUTATION_FLOOR = int(os.getenv('GIVEAWAY_REPUTATION_FLOOR', '450'))

    # Duel settings
    DUEL_TIMEOUT_MINUTES = int(os.getenv('DUEL_TIMEOUT_MINUTES', '5'))

    # Reputation tiers for weighted giveaways
    REPUTATION_TIERS = {
        'exceptional': {'min': 800, 'max': 850, 'weight': 1.5},
        'very_good': {'min': 740, 'max': 799, 'weight': 1.25},
        'good': {'min': 670, 'max': 739, 'weight': 1.1},
        'fair': {'min': 580, 'max': 669, 'weight': 1.0},
        'poor': {'min': 300, 'max': 579, 'weight': 0.75},
    }
