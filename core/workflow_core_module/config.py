"""Configuration for workflow_core_module"""
import os

from dotenv import load_dotenv

load_dotenv()


class Config:
    """Workflow Core Module Configuration"""

    # Module Information
    MODULE_NAME = 'workflow_core_module'
    MODULE_VERSION = '1.0.0'
    PORT = int(os.getenv('MODULE_PORT', '8070'))
    GRPC_PORT = int(os.getenv('GRPC_PORT', '50070'))

    # Database Configuration
    DATABASE_URI = os.getenv(
        'DATABASE_URL',
        'postgresql://waddlebot:password@postgres:5432/waddlebot'
    )
    READ_REPLICA_URIS = os.getenv(
        'READ_REPLICA_URIS',
        'postgresql://waddlebot:password@postgres:5433/waddlebot'
    ).split(',')

    # Redis Configuration
    REDIS_URL = os.getenv(
        'REDIS_URL',
        'redis://redis:6379/0'
    )

    # Router Service Configuration
    ROUTER_URL = os.getenv(
        'ROUTER_URL',
        'http://router-service:8000'
    )

    # License Server Configuration
    LICENSE_SERVER_URL = os.getenv(
        'LICENSE_SERVER_URL',
        'https://license.penguintech.io'
    )

    # Release Mode & Feature Flags
    RELEASE_MODE = os.getenv('RELEASE_MODE', 'false').lower() == 'true'
    FEATURE_WORKFLOWS_ENABLED = os.getenv('FEATURE_WORKFLOWS_ENABLED', 'true').lower() == 'true'

    # Logging Configuration
    LOG_DIR = os.getenv('LOG_DIR', '/var/log/waddlebotlog')
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')

    # Security
    SECRET_KEY = os.getenv('SECRET_KEY', 'change-me-in-production')
    API_KEY = os.getenv('API_KEY', 'change-me-in-production')

    # APScheduler Configuration
    SCHEDULER_TIMEZONE = os.getenv('SCHEDULER_TIMEZONE', 'UTC')
    SCHEDULER_JOB_DEFAULTS_MAX_INSTANCES = int(os.getenv('SCHEDULER_JOB_DEFAULTS_MAX_INSTANCES', '3'))
    SCHEDULER_JOB_DEFAULTS_COALESCE = os.getenv('SCHEDULER_JOB_DEFAULTS_COALESCE', 'true').lower() == 'true'

    # Workflow Execution Configuration
    MAX_CONCURRENT_WORKFLOWS = int(os.getenv('MAX_CONCURRENT_WORKFLOWS', '10'))
    WORKFLOW_TIMEOUT = int(os.getenv('WORKFLOW_TIMEOUT_SECONDS', '300'))
    WORKFLOW_MAX_RETRIES = int(os.getenv('WORKFLOW_MAX_RETRIES', '3'))
    MAX_LOOP_ITERATIONS = int(os.getenv('MAX_LOOP_ITERATIONS', '100'))
    MAX_TOTAL_OPERATIONS = int(os.getenv('MAX_TOTAL_OPERATIONS', '1000'))
    MAX_LOOP_DEPTH = int(os.getenv('MAX_LOOP_DEPTH', '10'))
    MAX_PARALLEL_NODES = int(os.getenv('MAX_PARALLEL_NODES', '10'))
