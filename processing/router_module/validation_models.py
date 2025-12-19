"""
Router Module Validation Models

Pydantic models for validating router API requests.
"""

from pydantic import BaseModel, Field, field_validator, ConfigDict
from typing import Optional, Dict, Any, List


class RouterEventRequest(BaseModel):
    """
    Validation model for single event processing.
    Used by POST /api/v1/router/events
    """
    platform: str = Field(
        ...,
        pattern=r'^(twitch|discord|slack|kick)$',
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

    @field_validator('channel_id', 'user_id', 'username')
    @classmethod
    def validate_not_empty(cls, v, info):
        """Ensure string fields are not just whitespace."""
        if not v or not v.strip():
            raise ValueError(f'{info.field_name} cannot be empty or whitespace only')
        return v.strip()

    @field_validator('message')
    @classmethod
    def validate_message(cls, v):
        """Validate message is not empty."""
        if not v or not v.strip():
            raise ValueError('message cannot be empty or whitespace only')
        return v

    @field_validator('command')
    @classmethod
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

    model_config = ConfigDict(extra='forbid')


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

    @field_validator('events')
    @classmethod
    def validate_events(cls, v):
        """Validate events list is not empty."""
        if not v:
            raise ValueError('events list cannot be empty')
        if len(v) > 100:
            raise ValueError('cannot process more than 100 events at once')
        return v

    model_config = ConfigDict(extra='forbid')


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
        pattern=r'^(twitch|discord|slack|kick)$',
        description="Platform name (twitch, discord, slack, kick)"
    )
    channel_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Channel ID to send response to"
    )

    @field_validator('event_id', 'channel_id')
    @classmethod
    def validate_not_empty(cls, v, info):
        """Ensure string fields are not just whitespace."""
        if not v or not v.strip():
            raise ValueError(f'{info.field_name} cannot be empty or whitespace only')
        return v.strip()

    @field_validator('response')
    @classmethod
    def validate_response(cls, v):
        """Validate response is not empty."""
        if not v or not v.strip():
            raise ValueError('response cannot be empty or whitespace only')
        return v

    model_config = ConfigDict(extra='forbid')


__all__ = [
    'RouterEventRequest',
    'RouterBatchRequest',
    'RouterResponseRequest',
]
