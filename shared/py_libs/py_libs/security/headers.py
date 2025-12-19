"""
Secure HTTP headers middleware for Quart/Flask applications.

Implements security best practices for HTTP headers including:
- Content Security Policy (CSP)
- HTTP Strict Transport Security (HSTS)
- X-Frame-Options
- X-Content-Type-Options
- Referrer-Policy
- Permissions-Policy
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union


@dataclass(frozen=True, slots=True)
class CSPDirectives:
    """Content Security Policy directives configuration."""
    default_src: List[str] = field(default_factory=lambda: ["'self'"])
    script_src: List[str] = field(default_factory=lambda: ["'self'"])
    style_src: List[str] = field(default_factory=lambda: ["'self'", "'unsafe-inline'"])
    img_src: List[str] = field(default_factory=lambda: ["'self'", "data:", "https:"])
    font_src: List[str] = field(default_factory=lambda: ["'self'", "data:"])
    connect_src: List[str] = field(default_factory=lambda: ["'self'"])
    frame_ancestors: List[str] = field(default_factory=lambda: ["'none'"])
    base_uri: List[str] = field(default_factory=lambda: ["'self'"])
    form_action: List[str] = field(default_factory=lambda: ["'self'"])
    object_src: List[str] = field(default_factory=lambda: ["'none'"])

    def to_header(self) -> str:
        """Convert directives to CSP header value."""
        parts = []
        for key, values in self.__dict__.items():
            if values:
                directive_name = key.replace("_", "-")
                parts.append(f"{directive_name} {' '.join(values)}")
        return "; ".join(parts)


@dataclass(frozen=True, slots=True)
class HSTSConfig:
    """HTTP Strict Transport Security configuration."""
    max_age: int = 31536000  # 1 year
    include_subdomains: bool = True
    preload: bool = True

    def to_header(self) -> str:
        """Convert config to HSTS header value."""
        value = f"max-age={self.max_age}"
        if self.include_subdomains:
            value += "; includeSubDomains"
        if self.preload:
            value += "; preload"
        return value


@dataclass(frozen=True, slots=True)
class PermissionsPolicy:
    """Permissions Policy configuration."""
    camera: List[str] = field(default_factory=lambda: ["'none'"])
    microphone: List[str] = field(default_factory=lambda: ["'none'"])
    geolocation: List[str] = field(default_factory=lambda: ["'none'"])
    payment: List[str] = field(default_factory=lambda: ["'none'"])
    usb: List[str] = field(default_factory=lambda: ["'none'"])
    fullscreen: List[str] = field(default_factory=lambda: ["'self'"])

    def to_header(self) -> str:
        """Convert config to Permissions-Policy header value."""
        parts = []
        for key, values in self.__dict__.items():
            if values:
                parts.append(f"{key}=({' '.join(values)})")
        return ", ".join(parts)


@dataclass(slots=True)
class SecurityHeadersConfig:
    """Security headers configuration."""
    csp: Optional[CSPDirectives] = None
    csp_report_only: bool = False
    hsts: Optional[HSTSConfig] = None
    frame_options: str = "DENY"  # DENY, SAMEORIGIN, or ALLOW-FROM uri
    no_sniff: bool = True
    referrer_policy: str = "strict-origin-when-cross-origin"
    xss_protection: bool = True
    permissions_policy: Optional[PermissionsPolicy] = None
    custom_headers: Dict[str, str] = field(default_factory=dict)

    @classmethod
    def default(cls) -> "SecurityHeadersConfig":
        """Create default secure configuration."""
        return cls(
            csp=CSPDirectives(),
            hsts=HSTSConfig(),
            permissions_policy=PermissionsPolicy(),
        )

    @classmethod
    def relaxed(cls) -> "SecurityHeadersConfig":
        """Create relaxed configuration for development."""
        return cls(
            csp=CSPDirectives(
                script_src=["'self'", "'unsafe-inline'", "'unsafe-eval'"],
                style_src=["'self'", "'unsafe-inline'"],
            ),
            hsts=None,  # Disable HSTS in development
            frame_options="SAMEORIGIN",
        )


def secure_headers_middleware(
    config: Optional[SecurityHeadersConfig] = None
) -> Callable:
    """
    Create Quart/Flask middleware to set secure HTTP headers.

    Args:
        config: Security headers configuration. Uses defaults if not provided.

    Returns:
        Middleware function.

    Usage with Quart:
        from quart import Quart
        from py_libs.security.headers import secure_headers_middleware

        app = Quart(__name__)

        @app.after_request
        async def add_security_headers(response):
            return secure_headers_middleware()(response)

    Usage with Flask:
        from flask import Flask
        from py_libs.security.headers import secure_headers_middleware

        app = Flask(__name__)

        @app.after_request
        def add_security_headers(response):
            return secure_headers_middleware()(response)
    """
    if config is None:
        config = SecurityHeadersConfig.default()

    def apply_headers(response: Any) -> Any:
        """Apply security headers to response."""
        headers = response.headers

        # Content-Security-Policy
        if config.csp:
            header_name = (
                "Content-Security-Policy-Report-Only"
                if config.csp_report_only
                else "Content-Security-Policy"
            )
            headers[header_name] = config.csp.to_header()

        # HSTS (should only be set over HTTPS, but we set it anyway
        # and let the reverse proxy handle HTTPS)
        if config.hsts:
            headers["Strict-Transport-Security"] = config.hsts.to_header()

        # X-Frame-Options
        if config.frame_options:
            headers["X-Frame-Options"] = config.frame_options

        # X-Content-Type-Options
        if config.no_sniff:
            headers["X-Content-Type-Options"] = "nosniff"

        # Referrer-Policy
        if config.referrer_policy:
            headers["Referrer-Policy"] = config.referrer_policy

        # X-XSS-Protection (legacy but still useful for older browsers)
        if config.xss_protection:
            headers["X-XSS-Protection"] = "1; mode=block"

        # Permissions-Policy
        if config.permissions_policy:
            headers["Permissions-Policy"] = config.permissions_policy.to_header()

        # Remove X-Powered-By if present
        headers.pop("X-Powered-By", None)

        # Custom headers
        for key, value in config.custom_headers.items():
            headers[key] = value

        return response

    return apply_headers


@dataclass(slots=True)
class CORSConfig:
    """CORS (Cross-Origin Resource Sharing) configuration."""
    origin: Union[bool, str, List[str]] = False
    methods: List[str] = field(
        default_factory=lambda: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    )
    allowed_headers: List[str] = field(
        default_factory=lambda: ["Content-Type", "Authorization"]
    )
    exposed_headers: List[str] = field(default_factory=list)
    credentials: bool = False
    max_age: int = 86400  # 24 hours


def cors_middleware(config: Optional[CORSConfig] = None) -> Callable:
    """
    Create CORS middleware with security defaults.

    Args:
        config: CORS configuration.

    Returns:
        Middleware function that applies CORS headers.
    """
    if config is None:
        config = CORSConfig()

    def apply_cors(response: Any, request_origin: Optional[str] = None) -> Any:
        """Apply CORS headers to response."""
        headers = response.headers

        # Handle origin
        if config.origin is True:
            headers["Access-Control-Allow-Origin"] = request_origin or "*"
        elif isinstance(config.origin, str):
            headers["Access-Control-Allow-Origin"] = config.origin
        elif isinstance(config.origin, list) and request_origin:
            if request_origin in config.origin:
                headers["Access-Control-Allow-Origin"] = request_origin

        # Other CORS headers
        headers["Access-Control-Allow-Methods"] = ", ".join(config.methods)
        headers["Access-Control-Allow-Headers"] = ", ".join(config.allowed_headers)

        if config.exposed_headers:
            headers["Access-Control-Expose-Headers"] = ", ".join(config.exposed_headers)

        if config.credentials:
            headers["Access-Control-Allow-Credentials"] = "true"

        headers["Access-Control-Max-Age"] = str(config.max_age)

        return response

    return apply_cors


__all__ = [
    "CSPDirectives",
    "HSTSConfig",
    "PermissionsPolicy",
    "SecurityHeadersConfig",
    "secure_headers_middleware",
    "CORSConfig",
    "cors_middleware",
]
