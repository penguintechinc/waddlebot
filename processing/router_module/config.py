"""Router Module Configuration"""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    MODULE_NAME = 'router_module'
    MODULE_VERSION = '2.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8000'))

    DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://waddlebot:password@localhost:5432/waddlebot')
    READ_REPLICA_URL = os.getenv('READ_REPLICA_URL', '')

    REDIS_HOST = os.getenv('REDIS_HOST', 'redis')
    REDIS_PORT = int(os.getenv('REDIS_PORT', '6379'))
    REDIS_PASSWORD = os.getenv('REDIS_PASSWORD', '')
    REDIS_DB = int(os.getenv('REDIS_DB', '0'))
    SESSION_TTL = int(os.getenv('SESSION_TTL', '3600'))
    SESSION_PREFIX = os.getenv('SESSION_PREFIX', 'waddlebot:session:')

    ROUTER_MAX_WORKERS = int(os.getenv('ROUTER_MAX_WORKERS', '20'))
    ROUTER_MAX_CONCURRENT = int(os.getenv('ROUTER_MAX_CONCURRENT', '100'))
    ROUTER_REQUEST_TIMEOUT = int(os.getenv('ROUTER_REQUEST_TIMEOUT', '30'))
    ROUTER_DEFAULT_RATE_LIMIT = int(os.getenv('ROUTER_DEFAULT_RATE_LIMIT', '60'))

    ROUTER_COMMAND_CACHE_TTL = int(os.getenv('ROUTER_COMMAND_CACHE_TTL', '300'))
    ROUTER_ENTITY_CACHE_TTL = int(os.getenv('ROUTER_ENTITY_CACHE_TTL', '600'))

    AWS_REGION = os.getenv('AWS_REGION', 'us-east-1')
    AWS_ACCESS_KEY_ID = os.getenv('AWS_ACCESS_KEY_ID', '')
    AWS_SECRET_ACCESS_KEY = os.getenv('AWS_SECRET_ACCESS_KEY', '')
    LAMBDA_FUNCTION_PREFIX = os.getenv('LAMBDA_FUNCTION_PREFIX', 'waddlebot-')

    OPENWHISK_API_HOST = os.getenv('OPENWHISK_API_HOST', '')
    OPENWHISK_AUTH_KEY = os.getenv('OPENWHISK_AUTH_KEY', '')
    OPENWHISK_NAMESPACE = os.getenv('OPENWHISK_NAMESPACE', 'waddlebot')

    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    SECRET_KEY = os.getenv('SECRET_KEY', 'change-me-in-production')

    # Hub integration for activity tracking
    HUB_API_URL = os.getenv('HUB_API_URL', 'http://hub-module:8060')
    SERVICE_API_KEY = os.getenv('SERVICE_API_KEY', '')
