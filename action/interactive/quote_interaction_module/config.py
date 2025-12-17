"""
Configuration for Quote Interaction Module
"""
import os


class Config:
    """Quote module configuration"""

    # Module metadata
    MODULE_NAME = os.getenv('QUOTE_MODULE_NAME', 'quote_interaction_module')
    MODULE_VERSION = os.getenv('QUOTE_MODULE_VERSION', '1.0.0')
    MODULE_PORT = int(os.getenv('QUOTE_MODULE_PORT', 5012))

    # Database configuration
    DATABASE_URL = os.getenv(
        'DATABASE_URL',
        'postgresql://waddlebot:waddlebot@localhost:5432/waddlebot'
    )

    # Optional read replica for queries
    READ_REPLICA_URL = os.getenv('READ_REPLICA_URL')

    # Connection pool settings
    DB_POOL_SIZE = int(os.getenv('DB_POOL_SIZE', 10))

    # API settings
    API_TIMEOUT = int(os.getenv('API_TIMEOUT', 30))
    MAX_PAGE_SIZE = int(os.getenv('MAX_PAGE_SIZE', 100))
    DEFAULT_PAGE_SIZE = int(os.getenv('DEFAULT_PAGE_SIZE', 50))

    # Full-text search settings
    SEARCH_LANGUAGE = 'english'
    MIN_SEARCH_QUERY_LENGTH = 2

    # Quote moderation
    AUTO_APPROVE_QUOTES = os.getenv('AUTO_APPROVE_QUOTES', 'true').lower() == 'true'

    # Logging
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
