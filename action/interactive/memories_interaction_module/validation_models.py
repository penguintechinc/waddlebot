"""
Validation Models for Memories Interaction Module

Pydantic models for validating requests to quotes, bookmarks, and reminders endpoints.
"""

from pydantic import BaseModel, Field, validator
from typing import Optional, List
from datetime import datetime
import re

from flask_core.sanitization import sanitized_url_validator


# ============================================================================
# QUOTE VALIDATION MODELS
# ============================================================================

class QuoteCreateRequest(BaseModel):
    """Validation model for creating quotes."""
    community_id: int = Field(..., gt=0, description="Community ID (must be positive)")
    quote_text: str = Field(
        ...,
        min_length=1,
        max_length=5000,
        description="Quote text (1-5000 characters)"
    )
    created_by_username: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Username of quote creator"
    )
    created_by_user_id: Optional[int] = Field(
        None,
        gt=0,
        description="User ID of quote creator"
    )
    author_username: Optional[str] = Field(
        None,
        max_length=255,
        description="Username being quoted"
    )
    author_user_id: Optional[int] = Field(
        None,
        gt=0,
        description="User ID being quoted"
    )
    category: Optional[str] = Field(
        None,
        max_length=100,
        description="Quote category"
    )

    @validator('quote_text')
    def validate_quote_text(cls, v):
        """Validate quote text is not empty or whitespace."""
        if not v or not v.strip():
            raise ValueError('quote_text cannot be empty or whitespace only')
        return v.strip()

    @validator('created_by_username', 'author_username')
    def validate_username(cls, v):
        """Validate username format."""
        if v is not None:
            if not v.strip():
                raise ValueError('username cannot be empty or whitespace only')
            return v.strip()
        return v

    @validator('category')
    def validate_category(cls, v):
        """Validate category format."""
        if v is not None:
            if not v.strip():
                raise ValueError('category cannot be empty or whitespace only')
            return v.strip()
        return v

    class Config:
        extra = 'allow'  # Allow extra fields like created_by_user_id


class QuoteSearchParams(BaseModel):
    """Validation model for searching quotes."""
    search_query: Optional[str] = Field(
        None,
        max_length=500,
        description="Search query text"
    )
    category: Optional[str] = Field(
        None,
        max_length=100,
        description="Filter by category"
    )
    author: Optional[str] = Field(
        None,
        max_length=255,
        description="Filter by author username"
    )
    limit: int = Field(
        default=50,
        ge=1,
        le=100,
        description="Results limit (1-100)"
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="Pagination offset"
    )

    @validator('search_query', 'category', 'author')
    def strip_whitespace(cls, v):
        """Strip whitespace from string fields."""
        if v is not None:
            return v.strip() if v.strip() else None
        return v

    class Config:
        extra = 'forbid'


class QuoteVoteRequest(BaseModel):
    """Validation model for voting on quotes."""
    user_id: int = Field(..., gt=0, description="User ID voting")
    username: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Username voting"
    )
    vote_type: str = Field(
        ...,
        regex=r'^(up|down|upvote|downvote)$',
        description="Vote type: 'up', 'down', 'upvote', or 'downvote'"
    )

    @validator('username')
    def validate_username(cls, v):
        """Validate username format."""
        if not v or not v.strip():
            raise ValueError('username cannot be empty or whitespace only')
        return v.strip()

    @validator('vote_type')
    def normalize_vote_type(cls, v):
        """Normalize vote type to 'up' or 'down'."""
        v = v.lower()
        if v in ('up', 'upvote'):
            return 'up'
        elif v in ('down', 'downvote'):
            return 'down'
        return v

    class Config:
        extra = 'forbid'


class QuoteDeleteRequest(BaseModel):
    """Validation model for deleting quotes."""
    user_id: int = Field(..., gt=0, description="User ID requesting deletion")

    class Config:
        extra = 'forbid'


# ============================================================================
# BOOKMARK VALIDATION MODELS
# ============================================================================

class BookmarkCreateRequest(BaseModel):
    """Validation model for creating bookmarks."""
    community_id: int = Field(..., gt=0, description="Community ID (must be positive)")
    url: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="Bookmark URL"
    )
    created_by_username: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Username of bookmark creator"
    )
    created_by_user_id: Optional[int] = Field(
        None,
        gt=0,
        description="User ID of bookmark creator"
    )
    title: Optional[str] = Field(
        None,
        max_length=500,
        description="Bookmark title"
    )
    description: Optional[str] = Field(
        None,
        max_length=2000,
        description="Bookmark description"
    )
    tags: Optional[List[str]] = Field(
        None,
        description="Bookmark tags"
    )
    auto_fetch_metadata: Optional[bool] = Field(
        True,
        description="Automatically fetch page metadata"
    )

    @validator('url')
    def validate_url(cls, v):
        """Validate and sanitize URL."""
        return sanitized_url_validator(v)

    @validator('created_by_username')
    def validate_username(cls, v):
        """Validate username format."""
        if not v or not v.strip():
            raise ValueError('username cannot be empty or whitespace only')
        return v.strip()

    @validator('title', 'description')
    def strip_whitespace(cls, v):
        """Strip whitespace from string fields."""
        if v is not None:
            return v.strip() if v.strip() else None
        return v

    @validator('tags')
    def validate_tags(cls, v):
        """Validate tags list."""
        if v is not None:
            if not isinstance(v, list):
                raise ValueError('tags must be a list')
            # Validate each tag
            validated_tags = []
            for tag in v:
                if not isinstance(tag, str):
                    raise ValueError('each tag must be a string')
                tag = tag.strip()
                if len(tag) > 100:
                    raise ValueError('each tag must be 100 characters or less')
                if tag:  # Only add non-empty tags
                    validated_tags.append(tag)
            return validated_tags if validated_tags else None
        return v

    class Config:
        extra = 'allow'  # Allow extra fields


class BookmarkSearchParams(BaseModel):
    """Validation model for searching bookmarks."""
    search_query: Optional[str] = Field(
        None,
        max_length=500,
        description="Search query text"
    )
    tags: Optional[List[str]] = Field(
        None,
        description="Filter by tags"
    )
    created_by: Optional[str] = Field(
        None,
        max_length=255,
        description="Filter by creator username"
    )
    limit: int = Field(
        default=50,
        ge=1,
        le=100,
        description="Results limit (1-100)"
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="Pagination offset"
    )

    @validator('search_query', 'created_by')
    def strip_whitespace(cls, v):
        """Strip whitespace from string fields."""
        if v is not None:
            return v.strip() if v.strip() else None
        return v

    @validator('tags')
    def validate_tags(cls, v):
        """Validate tags list."""
        if v is not None:
            if not isinstance(v, list):
                # Try to parse comma-separated string
                if isinstance(v, str):
                    v = [tag.strip() for tag in v.split(',') if tag.strip()]
                else:
                    raise ValueError('tags must be a list or comma-separated string')
            return v if v else None
        return v

    class Config:
        extra = 'forbid'


class BookmarkDeleteRequest(BaseModel):
    """Validation model for deleting bookmarks."""
    user_id: int = Field(..., gt=0, description="User ID requesting deletion")

    class Config:
        extra = 'forbid'


class PopularBookmarksParams(BaseModel):
    """Validation model for getting popular bookmarks."""
    limit: int = Field(
        default=10,
        ge=1,
        le=100,
        description="Results limit (1-100)"
    )

    class Config:
        extra = 'forbid'


# ============================================================================
# REMINDER VALIDATION MODELS
# ============================================================================

class ReminderCreateRequest(BaseModel):
    """Validation model for creating reminders."""
    community_id: int = Field(..., gt=0, description="Community ID (must be positive)")
    user_id: int = Field(..., gt=0, description="User ID for reminder")
    username: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Username for reminder"
    )
    reminder_text: str = Field(
        ...,
        min_length=1,
        max_length=1000,
        description="Reminder text (1-1000 characters)"
    )
    remind_in: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="When to remind (e.g., '5m', '2h', '1d', or ISO timestamp)"
    )
    channel: Optional[str] = Field(
        'twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform channel"
    )
    platform_channel_id: Optional[str] = Field(
        None,
        max_length=255,
        description="Platform-specific channel ID"
    )
    recurring_rule: Optional[str] = Field(
        None,
        max_length=200,
        description="Recurring rule in RRULE format"
    )

    @validator('reminder_text')
    def validate_reminder_text(cls, v):
        """Validate reminder text is not empty or whitespace."""
        if not v or not v.strip():
            raise ValueError('reminder_text cannot be empty or whitespace only')
        return v.strip()

    @validator('username')
    def validate_username(cls, v):
        """Validate username format."""
        if not v or not v.strip():
            raise ValueError('username cannot be empty or whitespace only')
        return v.strip()

    @validator('remind_in')
    def validate_remind_in(cls, v):
        """Validate remind_in format."""
        if not v or not v.strip():
            raise ValueError('remind_in cannot be empty or whitespace only')
        v = v.strip()

        # Check if it's a relative time format (e.g., 5m, 2h, 1d)
        relative_pattern = r'^(\d+)([smhd])$'
        if re.match(relative_pattern, v):
            return v

        # Check if it's an ISO timestamp
        try:
            datetime.fromisoformat(v.replace('Z', '+00:00'))
            return v
        except (ValueError, AttributeError):
            raise ValueError(
                'remind_in must be either a relative time (e.g., "5m", "2h", "1d") '
                'or an ISO 8601 timestamp'
            )

    @validator('recurring_rule')
    def validate_recurring_rule(cls, v):
        """Validate RRULE format."""
        if v is not None:
            v = v.strip()
            if v and not v.startswith('FREQ='):
                raise ValueError('recurring_rule must be in RRULE format (starting with FREQ=)')
            return v if v else None
        return v

    class Config:
        extra = 'allow'  # Allow extra fields


class ReminderSearchParams(BaseModel):
    """Validation model for searching reminders."""
    user_id: Optional[int] = Field(
        None,
        gt=0,
        description="Filter by user ID"
    )
    is_sent: Optional[bool] = Field(
        None,
        description="Filter by sent status"
    )
    community_id: Optional[int] = Field(
        None,
        gt=0,
        description="Filter by community ID"
    )
    limit: int = Field(
        default=50,
        ge=1,
        le=100,
        description="Results limit (1-100)"
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="Pagination offset"
    )

    class Config:
        extra = 'forbid'


class ReminderMarkSentRequest(BaseModel):
    """Validation model for marking reminder as sent."""
    schedule_next: bool = Field(
        default=True,
        description="Schedule next reminder for recurring reminders"
    )

    class Config:
        extra = 'forbid'


class ReminderDeleteRequest(BaseModel):
    """Validation model for deleting/canceling reminders."""
    user_id: int = Field(..., gt=0, description="User ID requesting deletion")

    class Config:
        extra = 'forbid'


class UserRemindersParams(BaseModel):
    """Validation model for getting user reminders."""
    include_sent: bool = Field(
        default=False,
        description="Include sent reminders"
    )

    class Config:
        extra = 'forbid'


__all__ = [
    # Quote models
    'QuoteCreateRequest',
    'QuoteSearchParams',
    'QuoteVoteRequest',
    'QuoteDeleteRequest',
    # Bookmark models
    'BookmarkCreateRequest',
    'BookmarkSearchParams',
    'BookmarkDeleteRequest',
    'PopularBookmarksParams',
    # Reminder models
    'ReminderCreateRequest',
    'ReminderSearchParams',
    'ReminderMarkSentRequest',
    'ReminderDeleteRequest',
    'UserRemindersParams',
]
