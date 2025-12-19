"""
Reusable Pydantic v2 field validators.

Provides commonly-used validators that can be imported and reused
across validation models to eliminate duplication.

Usage:
    from pydantic import Field, field_validator
    from py_libs.models import WaddleBaseModel
    from py_libs.models.validators import (
        validate_not_empty_string,
        validate_positive_int,
        validate_date_not_in_past,
    )

    class EventRequest(WaddleBaseModel):
        title: str = Field(..., min_length=3)
        max_attendees: int = Field(..., gt=0)
        event_date: datetime

        _validate_title = field_validator('title')(validate_not_empty_string)
        _validate_attendees = field_validator('max_attendees')(validate_positive_int)
        _validate_date = field_validator('event_date')(validate_date_not_in_past)
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Optional


# ============================================================================
# String Validators
# ============================================================================

def validate_not_empty_string(v: str) -> str:
    """
    Validate that a string is not empty or whitespace-only.

    Args:
        v: String value to validate

    Returns:
        Stripped string value

    Raises:
        ValueError: If string is empty or whitespace-only
    """
    if not v or not v.strip():
        raise ValueError("cannot be empty or whitespace only")
    return v.strip()


def validate_no_leading_trailing_whitespace(v: str) -> str:
    """
    Validate and strip leading/trailing whitespace.

    This is less strict than validate_not_empty_string - it allows
    the string to be just whitespace after stripping.

    Args:
        v: String value to validate

    Returns:
        Stripped string value
    """
    return v.strip() if v else v


def validate_alphanumeric(v: str) -> str:
    """
    Validate that a string contains only alphanumeric characters.

    Args:
        v: String value to validate

    Returns:
        Original string value

    Raises:
        ValueError: If string contains non-alphanumeric characters
    """
    if not v.isalnum():
        raise ValueError("must contain only letters and numbers")
    return v


def validate_alphanumeric_with_extras(v: str, extras: str = "_-") -> str:
    """
    Validate alphanumeric string with allowed extra characters.

    Args:
        v: String value to validate
        extras: Additional allowed characters (default: underscore and hyphen)

    Returns:
        Original string value

    Raises:
        ValueError: If string contains invalid characters
    """
    pattern = f"^[a-zA-Z0-9{re.escape(extras)}]+$"
    if not re.match(pattern, v):
        raise ValueError(f"must contain only letters, numbers, and {extras}")
    return v


def validate_slug(v: str) -> str:
    """
    Validate a URL-safe slug format.

    Args:
        v: String value to validate

    Returns:
        Lowercased slug value

    Raises:
        ValueError: If string is not a valid slug
    """
    pattern = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
    v_lower = v.lower()
    if not re.match(pattern, v_lower):
        raise ValueError("must be a valid slug (lowercase, alphanumeric, hyphens only)")
    return v_lower


def validate_email_format(v: str) -> str:
    """
    Basic email format validation.

    Args:
        v: Email string to validate

    Returns:
        Lowercased email

    Raises:
        ValueError: If email format is invalid
    """
    pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
    if not re.match(pattern, v):
        raise ValueError("invalid email format")
    return v.lower().strip()


def validate_url_format(v: str) -> str:
    """
    Basic URL format validation.

    Args:
        v: URL string to validate

    Returns:
        Original URL string

    Raises:
        ValueError: If URL format is invalid
    """
    pattern = r"^https?://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(/.*)?$"
    if not re.match(pattern, v):
        raise ValueError("invalid URL format (must start with http:// or https://)")
    return v.strip()


def validate_username_format(v: str) -> str:
    """
    Validate username format (alphanumeric, underscores, hyphens).

    Args:
        v: Username to validate

    Returns:
        Validated username

    Raises:
        ValueError: If username format is invalid
    """
    if len(v) < 3 or len(v) > 50:
        raise ValueError("username must be 3-50 characters")

    pattern = r"^[a-zA-Z0-9_-]+$"
    if not re.match(pattern, v):
        raise ValueError("username can only contain letters, numbers, hyphens, and underscores")
    return v.strip()


# ============================================================================
# Numeric Validators
# ============================================================================

def validate_positive_int(v: int) -> int:
    """
    Validate that an integer is positive (> 0).

    Args:
        v: Integer value to validate

    Returns:
        Original integer value

    Raises:
        ValueError: If integer is not positive
    """
    if v <= 0:
        raise ValueError("must be a positive integer")
    return v


def validate_non_negative_int(v: int) -> int:
    """
    Validate that an integer is non-negative (>= 0).

    Args:
        v: Integer value to validate

    Returns:
        Original integer value

    Raises:
        ValueError: If integer is negative
    """
    if v < 0:
        raise ValueError("must be a non-negative integer")
    return v


def validate_positive_float(v: float) -> float:
    """
    Validate that a float is positive (> 0).

    Args:
        v: Float value to validate

    Returns:
        Original float value

    Raises:
        ValueError: If float is not positive
    """
    if v <= 0:
        raise ValueError("must be a positive number")
    return v


def validate_percentage(v: float) -> float:
    """
    Validate that a float is a valid percentage (0-100).

    Args:
        v: Float value to validate

    Returns:
        Original float value

    Raises:
        ValueError: If float is not in range 0-100
    """
    if v < 0 or v > 100:
        raise ValueError("must be between 0 and 100")
    return v


# ============================================================================
# Date/Time Validators
# ============================================================================

def validate_date_not_in_past(v: datetime) -> datetime:
    """
    Validate that a datetime is not in the past.

    Args:
        v: Datetime value to validate

    Returns:
        Original datetime value

    Raises:
        ValueError: If datetime is in the past
    """
    # Make timezone-aware comparison
    now = datetime.now(timezone.utc)
    compare_v = v if v.tzinfo else v.replace(tzinfo=timezone.utc)

    if compare_v < now:
        raise ValueError("date cannot be in the past")
    return v


def validate_date_not_in_future(v: datetime) -> datetime:
    """
    Validate that a datetime is not in the future.

    Args:
        v: Datetime value to validate

    Returns:
        Original datetime value

    Raises:
        ValueError: If datetime is in the future
    """
    now = datetime.now(timezone.utc)
    compare_v = v if v.tzinfo else v.replace(tzinfo=timezone.utc)

    if compare_v > now:
        raise ValueError("date cannot be in the future")
    return v


def validate_timezone_string(v: str) -> str:
    """
    Validate that a string is a valid timezone identifier.

    Note: This is a basic validation. For full validation,
    use pytz or zoneinfo.

    Args:
        v: Timezone string to validate

    Returns:
        Original timezone string

    Raises:
        ValueError: If timezone format appears invalid
    """
    # Common timezone patterns: UTC, America/New_York, Europe/London, etc.
    pattern = r"^[A-Z][a-z]+(/[A-Z][a-z_]+)*$|^UTC$"
    if not re.match(pattern, v):
        raise ValueError("invalid timezone format")
    return v


# ============================================================================
# Cross-Field Validators (for model_validator)
# ============================================================================

def validate_end_after_start(
    start_field: str,
    end_field: str,
    values: dict[str, Any],
    allow_equal: bool = False,
) -> None:
    """
    Validate that end date/time is after start date/time.

    Use within a model_validator.

    Args:
        start_field: Name of the start field
        end_field: Name of the end field
        values: Dictionary of field values
        allow_equal: Whether to allow equal values

    Raises:
        ValueError: If end is not after start
    """
    start = values.get(start_field)
    end = values.get(end_field)

    if start is None or end is None:
        return

    if allow_equal:
        if end < start:
            raise ValueError(f"{end_field} must be at or after {start_field}")
    else:
        if end <= start:
            raise ValueError(f"{end_field} must be after {start_field}")


def validate_optional_end_after_start(
    start_field: str,
    end_field: str,
    values: dict[str, Any],
) -> None:
    """
    Validate end after start only if end is provided.

    Args:
        start_field: Name of the start field
        end_field: Name of the end field
        values: Dictionary of field values

    Raises:
        ValueError: If end is provided and not after start
    """
    start = values.get(start_field)
    end = values.get(end_field)

    if end is not None and start is not None:
        if end <= start:
            raise ValueError(f"{end_field} must be after {start_field}")


__all__ = [
    # String validators
    "validate_not_empty_string",
    "validate_no_leading_trailing_whitespace",
    "validate_alphanumeric",
    "validate_alphanumeric_with_extras",
    "validate_slug",
    "validate_email_format",
    "validate_url_format",
    "validate_username_format",
    # Numeric validators
    "validate_positive_int",
    "validate_non_negative_int",
    "validate_positive_float",
    "validate_percentage",
    # Date/Time validators
    "validate_date_not_in_past",
    "validate_date_not_in_future",
    "validate_timezone_string",
    # Cross-field validators
    "validate_end_after_start",
    "validate_optional_end_after_start",
]
