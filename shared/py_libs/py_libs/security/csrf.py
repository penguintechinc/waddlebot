"""
CSRF (Cross-Site Request Forgery) protection utilities.

Implements the double-submit cookie pattern for stateless CSRF protection,
suitable for API-based applications.
"""

import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional


@dataclass(slots=True)
class CSRFConfig:
    """CSRF protection configuration."""
    cookie_name: str = "XSRF-TOKEN"
    header_name: str = "X-XSRF-TOKEN"
    token_length: int = 32
    protected_methods: List[str] = field(
        default_factory=lambda: ["POST", "PUT", "DELETE", "PATCH"]
    )
    cookie_httponly: bool = False  # False so JS can read for headers
    cookie_secure: bool = True
    cookie_samesite: str = "Strict"  # Strict, Lax, or None
    cookie_path: str = "/"
    cookie_max_age: int = 86400  # 24 hours


class CSRFError(Exception):
    """Raised when CSRF validation fails."""

    def __init__(self, message: str = "Invalid or missing CSRF token"):
        self.message = message
        super().__init__(message)


def generate_csrf_token(length: int = 32) -> str:
    """
    Generate a cryptographically secure CSRF token.

    Args:
        length: Number of random bytes (hex encoded, so output is 2x length).

    Returns:
        Hex-encoded random token.
    """
    return secrets.token_hex(length)


def timing_safe_compare(a: str, b: str) -> bool:
    """
    Compare two strings in constant time to prevent timing attacks.

    Args:
        a: First string.
        b: Second string.

    Returns:
        True if strings are equal, False otherwise.
    """
    if len(a) != len(b):
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


class CSRFProtection:
    """
    CSRF protection using double-submit cookie pattern.

    The double-submit pattern works by:
    1. Setting a random token in a cookie (readable by JS)
    2. Requiring the same token in a header for state-changing requests
    3. Since same-origin policy prevents other sites from reading cookies,
       only legitimate requests can include the matching header

    Example with Quart:
        from quart import Quart, request, make_response
        from py_libs.security.csrf import CSRFProtection, CSRFConfig

        app = Quart(__name__)
        csrf = CSRFProtection(CSRFConfig())

        @app.before_request
        async def csrf_protect():
            csrf.validate_request(request)

        @app.after_request
        async def add_csrf_cookie(response):
            return csrf.set_cookie(request, response)
    """

    def __init__(self, config: Optional[CSRFConfig] = None):
        self.config = config or CSRFConfig()

    def get_token_from_cookie(self, request: Any) -> Optional[str]:
        """Extract CSRF token from request cookies."""
        cookies = getattr(request, "cookies", {})
        return cookies.get(self.config.cookie_name)

    def get_token_from_header(self, request: Any) -> Optional[str]:
        """Extract CSRF token from request header."""
        headers = getattr(request, "headers", {})
        return headers.get(self.config.header_name)

    def get_token_from_form(self, request: Any) -> Optional[str]:
        """Extract CSRF token from form data."""
        form = getattr(request, "form", {})
        return form.get("_csrf") or form.get("csrf_token")

    def should_validate(self, request: Any) -> bool:
        """Check if request method requires CSRF validation."""
        method = getattr(request, "method", "GET").upper()
        return method in self.config.protected_methods

    def validate_token(self, cookie_token: str, submitted_token: str) -> bool:
        """
        Validate that submitted token matches cookie token.

        Uses constant-time comparison to prevent timing attacks.
        """
        if not cookie_token or not submitted_token:
            return False
        return timing_safe_compare(cookie_token, submitted_token)

    def validate_request(
        self,
        request: Any,
        raise_on_failure: bool = True
    ) -> bool:
        """
        Validate CSRF token for the request.

        Args:
            request: Request object with cookies, headers, method, form.
            raise_on_failure: If True, raise CSRFError on validation failure.

        Returns:
            True if valid, False if invalid (when raise_on_failure=False).

        Raises:
            CSRFError: If validation fails and raise_on_failure=True.
        """
        if not self.should_validate(request):
            return True

        cookie_token = self.get_token_from_cookie(request)
        if not cookie_token:
            if raise_on_failure:
                raise CSRFError("CSRF cookie not found")
            return False

        # Check header first, then form
        submitted_token = (
            self.get_token_from_header(request) or
            self.get_token_from_form(request)
        )

        if not submitted_token:
            if raise_on_failure:
                raise CSRFError("CSRF token not submitted")
            return False

        if not self.validate_token(cookie_token, submitted_token):
            if raise_on_failure:
                raise CSRFError("CSRF token mismatch")
            return False

        return True

    def generate_token(self) -> str:
        """Generate a new CSRF token."""
        return generate_csrf_token(self.config.token_length)

    def set_cookie(
        self,
        request: Any,
        response: Any,
        force_new: bool = False
    ) -> Any:
        """
        Set CSRF cookie on response if not already present.

        Args:
            request: Request object to check for existing cookie.
            response: Response object to set cookie on.
            force_new: Generate new token even if one exists.

        Returns:
            Response with cookie set.
        """
        existing_token = self.get_token_from_cookie(request)

        if existing_token and not force_new:
            # Cookie already exists, no need to set
            return response

        token = self.generate_token()

        # Set cookie - implementation depends on framework
        # This assumes response has set_cookie method (Flask/Quart)
        if hasattr(response, "set_cookie"):
            response.set_cookie(
                self.config.cookie_name,
                token,
                httponly=self.config.cookie_httponly,
                secure=self.config.cookie_secure,
                samesite=self.config.cookie_samesite,
                path=self.config.cookie_path,
                max_age=self.config.cookie_max_age,
            )

        return response

    def get_current_token(self, request: Any) -> Optional[str]:
        """Get the current CSRF token from request cookies."""
        return self.get_token_from_cookie(request)


def csrf_exempt(func: Callable) -> Callable:
    """
    Decorator to mark a view as exempt from CSRF protection.

    Usage:
        @csrf_exempt
        async def webhook_endpoint(request):
            return {"status": "ok"}
    """
    func._csrf_exempt = True
    return func


def is_csrf_exempt(func: Callable) -> bool:
    """Check if a function is marked as CSRF exempt."""
    return getattr(func, "_csrf_exempt", False)


class SignedCSRFProtection:
    """
    CSRF protection using signed tokens.

    More secure than simple double-submit as tokens are cryptographically
    signed and can include expiration.

    Requires a secret key for signing.
    """

    def __init__(
        self,
        secret_key: str,
        config: Optional[CSRFConfig] = None,
        token_expiry: int = 3600,  # 1 hour
    ):
        if not secret_key:
            raise ValueError("Secret key is required for signed CSRF tokens")
        self.secret_key = secret_key.encode("utf-8")
        self.config = config or CSRFConfig()
        self.token_expiry = token_expiry

    def generate_token(self) -> str:
        """
        Generate a signed CSRF token with timestamp.

        Format: {timestamp}.{random}.{signature}
        """
        timestamp = str(int(time.time()))
        random_part = secrets.token_hex(16)

        # Sign: timestamp.random
        message = f"{timestamp}.{random_part}"
        signature = hmac.new(
            self.secret_key,
            message.encode("utf-8"),
            hashlib.sha256
        ).hexdigest()[:32]

        return f"{message}.{signature}"

    def validate_token(self, token: str) -> bool:
        """
        Validate a signed CSRF token.

        Checks:
        1. Token format is correct
        2. Signature is valid
        3. Token has not expired
        """
        if not token:
            return False

        parts = token.split(".")
        if len(parts) != 3:
            return False

        timestamp_str, random_part, provided_signature = parts

        # Verify signature
        message = f"{timestamp_str}.{random_part}"
        expected_signature = hmac.new(
            self.secret_key,
            message.encode("utf-8"),
            hashlib.sha256
        ).hexdigest()[:32]

        if not timing_safe_compare(expected_signature, provided_signature):
            return False

        # Check expiration
        try:
            timestamp = int(timestamp_str)
            if time.time() - timestamp > self.token_expiry:
                return False
        except ValueError:
            return False

        return True


__all__ = [
    "CSRFConfig",
    "CSRFError",
    "CSRFProtection",
    "SignedCSRFProtection",
    "generate_csrf_token",
    "timing_safe_compare",
    "csrf_exempt",
    "is_csrf_exempt",
]
