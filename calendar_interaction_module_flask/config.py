"""Calendar Module Configuration"""
import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    MODULE_NAME = 'calendar_interaction_module'
    MODULE_VERSION = '2.0.0'
    MODULE_PORT = int(os.getenv('MODULE_PORT', '8030'))
    DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://waddlebot:password@localhost:5432/waddlebot')
    CORE_API_URL = os.getenv('CORE_API_URL', 'http://router-service:8000')
    ROUTER_API_URL = os.getenv('ROUTER_API_URL', 'http://router-service:8000/api/v1/router')
    LABELS_API_URL = os.getenv('LABELS_API_URL', 'http://labels-core-service:8025')
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    SECRET_KEY = os.getenv('SECRET_KEY', 'change-me-in-production')
