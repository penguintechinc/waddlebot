"""
Date and time range models.

Provides validated date range models with cross-field validation
to ensure end dates are after start dates.
"""

from __future__ import annotations

from datetime import date, datetime, time, timezone
from typing import Optional

from pydantic import Field, model_validator

from .base import WaddleRequestModel


class DateRange(WaddleRequestModel):
    """
    Date range with optional start and end dates.

    Validates that end_date is after start_date when both are provided.

    Usage:
        class EventSearchParams(DateRange):
            category: Optional[str] = None

        params = EventSearchParams(
            start_date=date(2024, 1, 1),
            end_date=date(2024, 12, 31),
            category="meetup"
        )
    """

    start_date: Optional[date] = Field(
        None,
        description="Start date (inclusive)"
    )
    end_date: Optional[date] = Field(
        None,
        description="End date (inclusive)"
    )

    @model_validator(mode="after")
    def validate_date_range(self) -> "DateRange":
        """Ensure end_date is after or equal to start_date."""
        if self.start_date is not None and self.end_date is not None:
            if self.end_date < self.start_date:
                raise ValueError("end_date must be at or after start_date")
        return self


class DateTimeRange(WaddleRequestModel):
    """
    DateTime range with optional start and end times.

    Validates that end_datetime is after start_datetime when both are provided.

    Usage:
        class EventCreateRequest(DateTimeRange):
            title: str
            description: Optional[str] = None

        event = EventCreateRequest(
            title="Team Meeting",
            start_datetime=datetime(2024, 6, 15, 10, 0),
            end_datetime=datetime(2024, 6, 15, 11, 0)
        )
    """

    start_datetime: Optional[datetime] = Field(
        None,
        description="Start datetime (ISO 8601 format)"
    )
    end_datetime: Optional[datetime] = Field(
        None,
        description="End datetime (ISO 8601 format)"
    )

    @model_validator(mode="after")
    def validate_datetime_range(self) -> "DateTimeRange":
        """Ensure end_datetime is after start_datetime."""
        if self.start_datetime is not None and self.end_datetime is not None:
            if self.end_datetime <= self.start_datetime:
                raise ValueError("end_datetime must be after start_datetime")
        return self


class DateTimeRangeStrict(WaddleRequestModel):
    """
    Strict DateTime range where both start and end are required.

    Use when a complete time range is mandatory.
    """

    start_datetime: datetime = Field(
        ...,
        description="Start datetime (ISO 8601 format)"
    )
    end_datetime: datetime = Field(
        ...,
        description="End datetime (ISO 8601 format)"
    )

    @model_validator(mode="after")
    def validate_datetime_range(self) -> "DateTimeRangeStrict":
        """Ensure end_datetime is after start_datetime."""
        if self.end_datetime <= self.start_datetime:
            raise ValueError("end_datetime must be after start_datetime")
        return self


class TimeSlot(WaddleRequestModel):
    """
    Time slot within a single day.

    Useful for scheduling recurring events or availability windows.
    """

    start_time: time = Field(
        ...,
        description="Start time (HH:MM:SS format)"
    )
    end_time: time = Field(
        ...,
        description="End time (HH:MM:SS format)"
    )

    @model_validator(mode="after")
    def validate_time_slot(self) -> "TimeSlot":
        """Ensure end_time is after start_time."""
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class FutureDateTimeRange(WaddleRequestModel):
    """
    DateTime range that must be in the future.

    Used for scheduling future events where past dates are invalid.
    """

    start_datetime: datetime = Field(
        ...,
        description="Start datetime (must be in the future)"
    )
    end_datetime: Optional[datetime] = Field(
        None,
        description="End datetime (must be after start)"
    )
    timezone_str: str = Field(
        default="UTC",
        max_length=50,
        description="Timezone identifier (e.g., America/New_York)"
    )

    @model_validator(mode="after")
    def validate_future_range(self) -> "FutureDateTimeRange":
        """Validate the datetime range is in the future."""
        now = datetime.now(timezone.utc)

        # Make start_datetime timezone-aware for comparison
        start_compare = self.start_datetime
        if start_compare.tzinfo is None:
            start_compare = start_compare.replace(tzinfo=timezone.utc)

        if start_compare < now:
            raise ValueError("start_datetime must be in the future")

        if self.end_datetime is not None:
            end_compare = self.end_datetime
            if end_compare.tzinfo is None:
                end_compare = end_compare.replace(tzinfo=timezone.utc)

            if end_compare <= start_compare:
                raise ValueError("end_datetime must be after start_datetime")

        return self


class DateRangeWithTimezone(WaddleRequestModel):
    """
    Date range with timezone support.

    Includes timezone information for proper date calculations
    across different time zones.
    """

    start_date: Optional[date] = Field(
        None,
        description="Start date (inclusive)"
    )
    end_date: Optional[date] = Field(
        None,
        description="End date (inclusive)"
    )
    timezone_str: str = Field(
        default="UTC",
        max_length=50,
        description="Timezone identifier"
    )

    @model_validator(mode="after")
    def validate_date_range(self) -> "DateRangeWithTimezone":
        """Ensure end_date is after or equal to start_date."""
        if self.start_date is not None and self.end_date is not None:
            if self.end_date < self.start_date:
                raise ValueError("end_date must be at or after start_date")
        return self


def is_overlapping(
    range1_start: datetime,
    range1_end: datetime,
    range2_start: datetime,
    range2_end: datetime,
) -> bool:
    """
    Check if two datetime ranges overlap.

    Args:
        range1_start: Start of first range
        range1_end: End of first range
        range2_start: Start of second range
        range2_end: End of second range

    Returns:
        True if ranges overlap, False otherwise
    """
    return range1_start < range2_end and range2_start < range1_end


def get_duration_minutes(start: datetime, end: datetime) -> int:
    """
    Calculate duration in minutes between two datetimes.

    Args:
        start: Start datetime
        end: End datetime

    Returns:
        Duration in minutes (always positive)
    """
    delta = abs(end - start)
    return int(delta.total_seconds() / 60)


__all__ = [
    "DateRange",
    "DateTimeRange",
    "DateTimeRangeStrict",
    "TimeSlot",
    "FutureDateTimeRange",
    "DateRangeWithTimezone",
    "is_overlapping",
    "get_duration_minutes",
]
