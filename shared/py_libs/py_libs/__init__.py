"""
py_libs - Shared Python libraries for secure application development.

This package provides "batteries included" security-focused utilities:
- validation: PyDAL-style input validators
- models: Pydantic v2 base models for API validation
- security: Rate limiting, CSRF, secure headers, sanitization
- crypto: Token generation, hashing, encryption
- http: Request correlation, resilient HTTP client
- grpc: gRPC server/client with security interceptors
"""

__version__ = "1.0.0"
__author__ = "Penguin Tech Inc"
__email__ = "dev@penguintech.io"

# Validation exports
from py_libs.validation import (
    ValidationResult,
    Validator,
    chain,
)

# Models exports (Pydantic v2)
from py_libs.models import (
    WaddleBaseModel,
    WaddleRequestModel,
    WaddleResponseModel,
    PaginationParams,
    Platform,
    CommunityIdRequired,
    DateTimeRange,
)

# Crypto exports (commonly used)
from py_libs.crypto import (
    generate_token,
    generate_url_safe_token,
    generate_api_key,
    hash_password,
    verify_password,
    encrypt,
    decrypt,
)

# Security exports (commonly used)
from py_libs.security import (
    sanitize_html,
    sanitize_input,
    sanitize_url,
    escape_html,
    RateLimiter,
    CSRFProtection,
    AuditLogger,
)

__all__ = [
    "__version__",
    # Validation
    "ValidationResult",
    "Validator",
    "chain",
    # Models
    "WaddleBaseModel",
    "WaddleRequestModel",
    "WaddleResponseModel",
    "PaginationParams",
    "Platform",
    "CommunityIdRequired",
    "DateTimeRange",
    # Crypto
    "generate_token",
    "generate_url_safe_token",
    "generate_api_key",
    "hash_password",
    "verify_password",
    "encrypt",
    "decrypt",
    # Security
    "sanitize_html",
    "sanitize_input",
    "sanitize_url",
    "escape_html",
    "RateLimiter",
    "CSRFProtection",
    "AuditLogger",
]
