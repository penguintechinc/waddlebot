"""
WaddleBot Flask Core Library
============================

Shared utilities for all WaddleBot Flask/Quart modules.

Provides:
- AsyncDAL: Async wrapper for PyDAL database operations
- Auth utilities: Flask-Security-Too and OAuth integration
- Datamodels: Python 3.13 optimized dataclasses with slots
- Logging: Comprehensive AAA (Authentication, Authorization, Audit) logging
- API utilities: Standardized API responses and error handling
"""

__version__ = "2.0.0"
__author__ = "WaddleBot Team"

from .database import AsyncDAL, init_database
from .auth import setup_auth, OAuthProvider, create_jwt_token, verify_jwt_token, verify_service_key
from .datamodels import (
    CommandRequest,
    CommandResult,
    IdentityPayload,
    Activity,
    EventPayload,
    ModuleResponse
)
from .logging_config import setup_aaa_logging, get_logger
from .api_utils import (
    success_response,
    error_response,
    paginate_response,
    async_endpoint,
    auth_required,
    create_health_blueprint,
    record_request_metrics
)

__all__ = [
    # Database
    "AsyncDAL",
    "init_database",
    # Auth
    "setup_auth",
    "OAuthProvider",
    "create_jwt_token",
    "verify_jwt_token",
    "verify_service_key",
    # Datamodels
    "CommandRequest",
    "CommandResult",
    "IdentityPayload",
    "Activity",
    "EventPayload",
    "ModuleResponse",
    # Logging
    "setup_aaa_logging",
    "get_logger",
    # API Utils
    "success_response",
    "error_response",
    "paginate_response",
    "async_endpoint",
    "auth_required",
    # Health & Metrics
    "create_health_blueprint",
    "record_request_metrics",
]
