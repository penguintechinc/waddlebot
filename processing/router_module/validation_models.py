"""
Router Module Validation Models

Pydantic models for validating router API requests.
"""

from pydantic import BaseModel, Field, validator
from typing import Optional, Dict, Any, List


class RouterEventRequest(BaseModel):
    """
    Validation model for single event processing.
    Used by POST /api/v1/router/events
    """
    platform: str = Field(
        ...,
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name (twitch, discord, slack, kick)"
    )
    channel_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Channel ID where event occurred"
    )
    user_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="User ID who triggered the event"
    )
    username: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Username who triggered the event"
    )
    message: str = Field(
        ...,
        min_length=1,
        max_length=5000,
        description="Message content"
    )
    command: Optional[str] = Field(
        None,
        max_length=255,
        description="Extracted command (if any)"
    )
    metadata: Optional[Dict[str, Any]] = Field(
        None,
        description="Additional event metadata"
    )

    @validator('channel_id', 'user_id', 'username')
    def validate_not_empty(cls, v, field):
        """Ensure string fields are not just whitespace."""
        if not v or not v.strip():
            raise ValueError(f'{field.name} cannot be empty or whitespace only')
        return v.strip()

    @validator('message')
    def validate_message(cls, v):
        """Validate message is not empty."""
        if not v or not v.strip():
            raise ValueError('message cannot be empty or whitespace only')
        return v

    @validator('command')
    def validate_command(cls, v):
        """Validate command format if provided."""
        if v is not None and v:
            # Strip whitespace
            v = v.strip()
            if not v:
                return None
            # Command should not exceed 255 chars
            if len(v) > 255:
                raise ValueError('command cannot exceed 255 characters')
        return v if v else None

    class Config:
        extra = 'forbid'  # Reject unknown fields


class RouterBatchRequest(BaseModel):
    """
    Validation model for batch event processing.
    Used by POST /api/v1/router/events/batch
    """
    events: List[RouterEventRequest] = Field(
        ...,
        min_items=1,
        max_items=100,
        description="List of events to process (1-100 items)"
    )

    @validator('events')
    def validate_events(cls, v):
        """Validate events list is not empty."""
        if not v:
            raise ValueError('events list cannot be empty')
        if len(v) > 100:
            raise ValueError('cannot process more than 100 events at once')
        return v

    class Config:
        extra = 'forbid'  # Reject unknown fields


class RouterResponseRequest(BaseModel):
    """
    Validation model for module responses.
    Used by POST /api/v1/router/responses
    """
    event_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Event ID this response is for"
    )
    response: str = Field(
        ...,
        min_length=1,
        max_length=5000,
        description="Response message to send"
    )
    platform: str = Field(
        ...,
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name (twitch, discord, slack, kick)"
    )
    channel_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Channel ID to send response to"
    )

    @validator('event_id', 'channel_id')
    def validate_not_empty(cls, v, field):
        """Ensure string fields are not just whitespace."""
        if not v or not v.strip():
            raise ValueError(f'{field.name} cannot be empty or whitespace only')
        return v.strip()

    @validator('response')
    def validate_response(cls, v):
        """Validate response is not empty."""
        if not v or not v.strip():
            raise ValueError('response cannot be empty or whitespace only')
        return v

    class Config:
        extra = 'forbid'  # Reject unknown fields


__all__ = [
    'RouterEventRequest',
    'RouterBatchRequest',
    'RouterResponseRequest',
]
