"""
Security module - Security utilities for Flask/Quart applications.

Provides:
- sanitize: XSS/HTML sanitization, SQL parameter escaping
- headers: Secure headers middleware
- ratelimit: Rate limiting (in-memory + Redis)
- csrf: CSRF protection helpers
- audit: Audit logging
"""

from .audit import (
    AuditCategory,
    AuditEvent,
    AuditLevel,
    AuditLogger,
    AuditLoggerConfig,
    create_audit_logger,
    default_formatter,
    text_formatter,
)
from .csrf import (
    CSRFConfig,
    CSRFError,
    CSRFProtection,
    SignedCSRFProtection,
    csrf_exempt,
    generate_csrf_token,
    is_csrf_exempt,
    timing_safe_compare,
)
from .headers import (
    CORSConfig,
    CSPDirectives,
    HSTSConfig,
    PermissionsPolicy,
    SecurityHeadersConfig,
    cors_middleware,
    secure_headers_middleware,
)
from .ratelimit import (
    InMemoryStorage,
    RateLimitConfig,
    RateLimitExceeded,
    RateLimiter,
    RateLimitResult,
    RedisStorage,
    rate_limit_decorator,
)
from .sanitize import (
    ALLOWED_ATTRIBUTES,
    ALLOWED_PROTOCOLS,
    ALLOWED_TAGS,
    escape_html,
    sanitize_email,
    sanitize_filename,
    sanitize_html,
    sanitize_input,
    sanitize_json_string,
    sanitize_path,
    sanitize_sql_like,
    sanitize_url,
    strip_html,
    strip_whitespace,
    truncate_text,
)

__all__ = [
    # Sanitize
    "escape_html",
    "sanitize_html",
    "strip_html",
    "sanitize_input",
    "sanitize_sql_like",
    "strip_whitespace",
    "sanitize_filename",
    "sanitize_path",
    "sanitize_url",
    "sanitize_email",
    "sanitize_json_string",
    "truncate_text",
    "ALLOWED_TAGS",
    "ALLOWED_ATTRIBUTES",
    "ALLOWED_PROTOCOLS",
    # Headers
    "CSPDirectives",
    "HSTSConfig",
    "PermissionsPolicy",
    "SecurityHeadersConfig",
    "secure_headers_middleware",
    "CORSConfig",
    "cors_middleware",
    # Rate Limiting
    "RateLimitConfig",
    "RateLimitResult",
    "RateLimitExceeded",
    "RateLimiter",
    "InMemoryStorage",
    "RedisStorage",
    "rate_limit_decorator",
    # CSRF
    "CSRFConfig",
    "CSRFError",
    "CSRFProtection",
    "SignedCSRFProtection",
    "generate_csrf_token",
    "timing_safe_compare",
    "csrf_exempt",
    "is_csrf_exempt",
    # Audit
    "AuditLevel",
    "AuditCategory",
    "AuditEvent",
    "AuditLoggerConfig",
    "AuditLogger",
    "create_audit_logger",
    "default_formatter",
    "text_formatter",
]
