"""
HTML/XSS sanitization and input validation utilities.

Provides functions to sanitize user input and prevent XSS attacks,
SQL injection, and path traversal vulnerabilities.
"""

import html
import os
import re
from typing import Dict, List, Optional
from urllib.parse import urlparse

# Try to import bleach for HTML sanitization, fall back to basic escaping
try:
    from bleach import clean as bleach_clean
    BLEACH_AVAILABLE = True
except ImportError:
    BLEACH_AVAILABLE = False


# ============================================================================
# Configuration
# ============================================================================

# Allowed HTML tags for rich text content
ALLOWED_TAGS: List[str] = [
    "b", "i", "u", "em", "strong", "a",
    "p", "br", "span", "div",
    "ul", "ol", "li",
    "code", "pre", "blockquote",
]

# Allowed HTML attributes per tag
ALLOWED_ATTRIBUTES: Dict[str, List[str]] = {
    "a": ["href", "title", "rel"],
    "span": ["class"],
    "div": ["class"],
    "code": ["class"],
}

# Protocols allowed in links
ALLOWED_PROTOCOLS: List[str] = ["http", "https", "mailto"]

# HTML entity map for escaping
HTML_ENTITIES: Dict[str, str] = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "/": "&#x2F;",
}


# ============================================================================
# Core Sanitization Functions
# ============================================================================

def escape_html(text: str) -> str:
    """
    Escape HTML entities to prevent XSS.

    Args:
        text: String to escape.

    Returns:
        Escaped string safe for HTML insertion.

    Example:
        >>> escape_html("<script>alert('xss')</script>")
        '&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;'
    """
    if not isinstance(text, str):
        text = str(text)

    result = text
    for char, entity in HTML_ENTITIES.items():
        result = result.replace(char, entity)
    return result


def sanitize_html(
    text: str,
    tags: Optional[List[str]] = None,
    attributes: Optional[Dict[str, List[str]]] = None,
    protocols: Optional[List[str]] = None,
    strip: bool = True,
) -> str:
    """
    Remove potentially dangerous HTML/JS from user input while preserving safe HTML.

    Args:
        text: Input text to sanitize.
        tags: Allowed HTML tags (default: ALLOWED_TAGS).
        attributes: Allowed attributes per tag (default: ALLOWED_ATTRIBUTES).
        protocols: Allowed protocols in links (default: ALLOWED_PROTOCOLS).
        strip: Strip disallowed tags instead of escaping them.

    Returns:
        Sanitized text with only allowed HTML.

    Example:
        >>> sanitize_html("<b>Bold</b><script>evil()</script>")
        '<b>Bold</b>'
    """
    if not text:
        return ""

    if tags is None:
        tags = ALLOWED_TAGS
    if attributes is None:
        attributes = ALLOWED_ATTRIBUTES
    if protocols is None:
        protocols = ALLOWED_PROTOCOLS

    if BLEACH_AVAILABLE:
        return bleach_clean(
            text,
            tags=tags,
            attributes=attributes,
            protocols=protocols,
            strip=strip,
        ).strip()
    else:
        # Fallback: strip all HTML
        return strip_html(text)


def strip_html(text: str) -> str:
    """
    Strip all HTML tags from text.

    Args:
        text: Input text with HTML.

    Returns:
        Plain text with all HTML removed.
    """
    if not text:
        return ""

    # Remove script/style content first
    text = re.sub(r"<script[^<]*(?:(?!</script>)<[^<]*)*</script>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<style[^<]*(?:(?!</style>)<[^<]*)*</style>", "", text, flags=re.IGNORECASE)

    # Remove all HTML tags
    text = re.sub(r"<[^>]+>", "", text)

    # Decode HTML entities
    text = html.unescape(text)

    return text.strip()


def sanitize_input(text: str, allow_html: bool = False) -> str:
    """
    Sanitize general text input.

    Args:
        text: Input text to sanitize.
        allow_html: If True, allows safe HTML tags. If False, strips all HTML.

    Returns:
        Sanitized text.
    """
    if not text:
        return ""

    if allow_html:
        return sanitize_html(text)
    else:
        return strip_html(text)


def sanitize_sql_like(text: str) -> str:
    """
    Sanitize text for use in SQL LIKE queries by escaping wildcards.

    Args:
        text: Input text to sanitize for LIKE query.

    Returns:
        Sanitized text with escaped SQL LIKE wildcards.

    Note:
        Always use parameterized queries. This is a defense-in-depth measure.
    """
    if not text:
        return ""

    # Escape backslash first, then SQL LIKE wildcards
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def strip_whitespace(text: str) -> str:
    """
    Strip leading/trailing whitespace and normalize internal whitespace.

    Args:
        text: Input text to normalize.

    Returns:
        Text with normalized whitespace.

    Example:
        >>> strip_whitespace("  hello   world  ")
        'hello world'
    """
    if not text:
        return ""

    # Replace multiple spaces/tabs/newlines with single space
    return re.sub(r"\s+", " ", text).strip()


def sanitize_filename(filename: str, max_length: int = 255) -> str:
    """
    Sanitize filename to prevent directory traversal and invalid characters.

    Args:
        filename: Input filename to sanitize.
        max_length: Maximum filename length.

    Returns:
        Safe filename.

    Example:
        >>> sanitize_filename("../../etc/passwd")
        'passwd'
    """
    if not filename:
        return "unnamed"

    # Remove directory paths (prevent path traversal)
    filename = filename.replace("\\", "/").split("/")[-1]

    # Remove null bytes and control characters
    filename = "".join(char for char in filename if ord(char) >= 32)

    # Replace invalid filename characters
    filename = re.sub(r'[<>:"|?*]', "_", filename)

    # Remove leading/trailing dots and spaces
    filename = filename.strip(". ")

    # Truncate to max length, preserving extension
    if len(filename) > max_length:
        parts = filename.rsplit(".", 1)
        if len(parts) == 2:
            name, ext = parts
            max_name_length = max_length - len(ext) - 1
            filename = f"{name[:max_name_length]}.{ext}"
        else:
            filename = filename[:max_length]

    return filename or "unnamed"


def sanitize_path(
    input_path: str,
    allowed_base: Optional[str] = None
) -> Optional[str]:
    """
    Sanitize file paths to prevent directory traversal attacks.

    Args:
        input_path: Path to sanitize.
        allowed_base: Base directory to restrict paths to (optional).

    Returns:
        Sanitized path or None if path traversal detected.
    """
    if not isinstance(input_path, str):
        return None

    # Normalize the path
    normalized = os.path.normpath(input_path)

    # Check for path traversal attempts
    if ".." in normalized or normalized.startswith("/"):
        return None

    # If base directory provided, ensure path stays within it
    if allowed_base:
        resolved_path = os.path.realpath(os.path.join(allowed_base, normalized))
        resolved_base = os.path.realpath(allowed_base)

        if not resolved_path.startswith(resolved_base):
            return None

        return resolved_path

    return normalized


def sanitize_url(
    url: str,
    allowed_schemes: Optional[List[str]] = None
) -> Optional[str]:
    """
    Sanitize URL to prevent XSS via dangerous protocols.

    Args:
        url: Input URL to sanitize.
        allowed_schemes: Allowed URL schemes (default: ['http', 'https']).

    Returns:
        Sanitized URL or None if invalid/dangerous.
    """
    if not url:
        return None

    if allowed_schemes is None:
        allowed_schemes = ["http", "https"]

    url = url.strip()
    url_lower = url.lower()

    # Check for dangerous protocols
    dangerous_protocols = ["javascript:", "data:", "vbscript:", "file:"]
    for protocol in dangerous_protocols:
        if url_lower.startswith(protocol):
            return None

    # Validate allowed schemes
    try:
        parsed = urlparse(url)
        if parsed.scheme and parsed.scheme.lower() not in allowed_schemes:
            return None
        # Require scheme for absolute URLs
        if parsed.netloc and not parsed.scheme:
            return None
    except Exception:
        return None

    return url


def sanitize_email(email: str) -> Optional[str]:
    """
    Sanitize and validate email addresses.

    Args:
        email: Email to validate.

    Returns:
        Sanitized email or None if invalid.
    """
    if not isinstance(email, str):
        return None

    trimmed = email.strip().lower()

    # Basic email validation regex
    email_regex = r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$"
    if not re.match(email_regex, trimmed):
        return None

    # Length validation
    if len(trimmed) > 254:
        return None

    return trimmed


def sanitize_json_string(text: str) -> str:
    """
    Escape special characters for safe JSON string inclusion.

    Args:
        text: Input text to sanitize.

    Returns:
        Text with JSON special characters escaped.
    """
    if not text:
        return ""

    replacements = {
        "\\": "\\\\",
        '"': '\\"',
        "\n": "\\n",
        "\r": "\\r",
        "\t": "\\t",
        "\b": "\\b",
        "\f": "\\f",
    }

    result = text
    for char, escaped in replacements.items():
        result = result.replace(char, escaped)

    return result


def truncate_text(text: str, max_length: int, suffix: str = "...") -> str:
    """
    Truncate text to maximum length with optional suffix.

    Args:
        text: Input text to truncate.
        max_length: Maximum length (including suffix).
        suffix: Text to append if truncated.

    Returns:
        Truncated text.
    """
    if not text or len(text) <= max_length:
        return text or ""

    truncate_at = max_length - len(suffix)
    if truncate_at < 0:
        truncate_at = max_length

    return text[:truncate_at] + suffix


__all__ = [
    # Core sanitization
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
    # Configuration constants
    "ALLOWED_TAGS",
    "ALLOWED_ATTRIBUTES",
    "ALLOWED_PROTOCOLS",
    "BLEACH_AVAILABLE",
]
