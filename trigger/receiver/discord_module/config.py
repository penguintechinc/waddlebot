"""Configuration for discord_module"""
import os

from dotenv import load_dotenv


load_dotenv()


class Config:
    MODULE_NAME = 'discord_module'
    MODULE_VERSION = '2.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8003'))
    DATABASE_URL = os.getenv(
        'DATABASE_URL',
        'postgresql://waddlebot:password@localhost:5432/waddlebot'
    )
    CORE_API_URL = os.getenv('CORE_API_URL', 'http://router-service:8000')
    ROUTER_API_URL = os.getenv('ROUTER_API_URL', 'http://router-service:8000/api/v1/router')
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    SECRET_KEY = os.getenv('SECRET_KEY', 'change-me-in-production')

    # Discord Bot Configuration
    DISCORD_BOT_TOKEN = os.getenv('DISCORD_BOT_TOKEN', '')
    DISCORD_APPLICATION_ID = os.getenv('DISCORD_APPLICATION_ID', '')

    # Redis for interaction context storage (optional)
    REDIS_URL = os.getenv('REDIS_URL', '')
