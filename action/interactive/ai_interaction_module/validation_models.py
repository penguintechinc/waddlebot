"""
WaddleBot AI Interaction Module - Validation Models

Pydantic models for input validation of AI interaction requests,
provider configuration, and conversation search parameters.
"""

from pydantic import BaseModel, Field, validator
from typing import Optional, List, Dict
from datetime import datetime
from flask_core.sanitization import sanitized_input, sanitized_url_validator


# ============================================================================
# Chat Request Validation
# ============================================================================

class ChatRequest(BaseModel):
    """
    Validation model for AI chat requests.

    Ensures all required fields are present and within acceptable ranges.
    Sanitizes prompt input to prevent injection attacks.
    """
    community_id: int = Field(
        ...,
        gt=0,
        description="Community ID (must be positive integer)"
    )
    user_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="User ID from platform"
    )
    username: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Username for display"
    )
    prompt: str = Field(
        ...,
        min_length=1,
        max_length=10000,
        description="User's message/prompt to the AI"
    )
    platform: str = Field(
        ...,
        regex=r'^(twitch|discord|slack)$',
        description="Platform name (twitch, discord, or slack)"
    )
    channel_id: Optional[str] = Field(
        None,
        max_length=255,
        description="Channel/room ID where message originated"
    )
    context: Optional[List[Dict[str, str]]] = Field(
        None,
        description="Conversation history (max 20 items)"
    )
    provider: Optional[str] = Field(
        'ollama',
        regex=r'^(ollama|openai|mcp)$',
        description="AI provider to use"
    )
    model: Optional[str] = Field(
        None,
        max_length=100,
        description="Model name to use"
    )
    temperature: Optional[float] = Field(
        0.7,
        ge=0.0,
        le=2.0,
        description="Temperature for response generation (0.0-2.0)"
    )
    max_tokens: Optional[int] = Field(
        500,
        ge=1,
        le=4096,
        description="Maximum tokens in response (1-4096)"
    )

    @validator('user_id', 'username')
    def validate_string_fields(cls, v):
        """Validate and sanitize string fields."""
        if not v or not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    @validator('prompt')
    def sanitize_prompt(cls, v):
        """
        Sanitize prompt to prevent injection attacks.

        Strips all HTML and normalizes whitespace while preserving
        the original message intent.
        """
        if not v or not v.strip():
            raise ValueError('prompt cannot be empty')

        # Sanitize input (strip HTML, prevent XSS)
        sanitized = sanitized_input(v, allow_html=False)

        if not sanitized or len(sanitized.strip()) == 0:
            raise ValueError('prompt cannot be empty after sanitization')

        # Ensure it's within length limits after sanitization
        if len(sanitized) > 10000:
            raise ValueError('prompt exceeds maximum length after sanitization')

        return sanitized

    @validator('context')
    def validate_context(cls, v):
        """Validate conversation context doesn't exceed limits."""
        if v is not None:
            if len(v) > 20:
                raise ValueError('context cannot exceed 20 items')

            # Validate each context item has required keys
            for idx, item in enumerate(v):
                if not isinstance(item, dict):
                    raise ValueError(
                        f'context item {idx} must be a dictionary'
                    )
                if 'role' not in item or 'content' not in item:
                    raise ValueError(
                        f'context item {idx} must have "role" and "content" keys'
                    )
                # Sanitize content in context
                if isinstance(item.get('content'), str):
                    item['content'] = sanitized_input(
                        item['content'],
                        allow_html=False
                    )

        return v

    @validator('channel_id')
    def validate_channel_id(cls, v):
        """Validate and sanitize channel_id."""
        if v is not None:
            v = v.strip()
            if not v:
                return None
        return v

    class Config:
        extra = 'forbid'  # Reject unknown fields


# ============================================================================
# Provider Configuration Validation
# ============================================================================

class ProviderConfigRequest(BaseModel):
    """
    Validation model for AI provider configuration requests.

    Validates provider settings including API keys, base URLs, and
    model parameters.
    """
    community_id: int = Field(
        ...,
        gt=0,
        description="Community ID (must be positive integer)"
    )
    provider: str = Field(
        ...,
        regex=r'^(ollama|openai|mcp)$',
        description="AI provider name"
    )
    api_key: Optional[str] = Field(
        None,
        max_length=500,
        description="API key for the provider"
    )
    base_url: Optional[str] = Field(
        None,
        max_length=500,
        description="Base URL for the provider API"
    )
    model: Optional[str] = Field(
        None,
        max_length=100,
        description="Model name to use"
    )
    temperature: Optional[float] = Field(
        None,
        ge=0.0,
        le=2.0,
        description="Temperature for response generation (0.0-2.0)"
    )
    max_tokens: Optional[int] = Field(
        None,
        ge=1,
        le=4096,
        description="Maximum tokens in response (1-4096)"
    )
    system_prompt: Optional[str] = Field(
        None,
        max_length=2000,
        description="System prompt for AI behavior"
    )

    @validator('api_key')
    def validate_api_key(cls, v):
        """Validate and sanitize API key."""
        if v is not None:
            v = v.strip()
            if not v:
                return None
            # Ensure no whitespace or control characters
            if any(char.isspace() for char in v):
                raise ValueError('api_key cannot contain whitespace')
        return v

    @validator('base_url')
    def validate_base_url(cls, v):
        """Validate and sanitize base URL."""
        if v is not None:
            v = v.strip()
            if not v:
                return None
            # Use sanitized_url_validator to prevent XSS
            return sanitized_url_validator(v)
        return v

    @validator('model')
    def validate_model(cls, v):
        """Validate and sanitize model name."""
        if v is not None:
            v = v.strip()
            if not v:
                return None
            # Sanitize to prevent injection
            v = sanitized_input(v, allow_html=False)
        return v

    @validator('system_prompt')
    def validate_system_prompt(cls, v):
        """Validate and sanitize system prompt."""
        if v is not None:
            v = v.strip()
            if not v:
                return None
            # Sanitize but preserve formatting
            v = sanitized_input(v, allow_html=False)
            if len(v) > 2000:
                raise ValueError('system_prompt exceeds maximum length')
        return v

    class Config:
        extra = 'forbid'


# ============================================================================
# Conversation Search Parameters Validation
# ============================================================================

class ConversationSearchParams(BaseModel):
    """
    Validation model for conversation history search parameters.

    Used for querying conversation history with filtering and pagination.
    """
    community_id: Optional[int] = Field(
        None,
        gt=0,
        description="Filter by community ID"
    )
    user_id: Optional[str] = Field(
        None,
        max_length=255,
        description="Filter by user ID"
    )
    platform: Optional[str] = Field(
        None,
        regex=r'^(twitch|discord|slack)$',
        description="Filter by platform"
    )
    start_date: Optional[datetime] = Field(
        None,
        description="Filter by start date (ISO 8601 format)"
    )
    end_date: Optional[datetime] = Field(
        None,
        description="Filter by end date (ISO 8601 format)"
    )
    limit: int = Field(
        50,
        ge=1,
        le=100,
        description="Number of results to return (1-100)"
    )
    offset: int = Field(
        0,
        ge=0,
        description="Number of results to skip"
    )

    @validator('end_date')
    def validate_date_range(cls, v, values):
        """Ensure end_date is after start_date."""
        if v and 'start_date' in values and values['start_date']:
            if v <= values['start_date']:
                raise ValueError('end_date must be after start_date')
        return v

    @validator('user_id')
    def validate_user_id(cls, v):
        """Validate and sanitize user_id."""
        if v is not None:
            v = v.strip()
            if not v:
                return None
            v = sanitized_input(v, allow_html=False)
        return v

    class Config:
        extra = 'forbid'


# ============================================================================
# Interaction Request Validation (for main interaction endpoint)
# ============================================================================

class InteractionRequest(BaseModel):
    """
    Validation model for main interaction endpoint.

    Used for processing messages and events from the router.
    """
    session_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Session ID for tracking the request"
    )
    message_type: str = Field(
        'chatMessage',
        max_length=100,
        description="Type of message/event"
    )
    message_content: str = Field(
        '',
        max_length=10000,
        description="Content of the message"
    )
    user_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="User ID from platform"
    )
    entity_id: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Entity/channel ID"
    )
    platform: str = Field(
        ...,
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )
    username: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Username for display"
    )
    display_name: Optional[str] = Field(
        None,
        max_length=255,
        description="Display name for user"
    )

    @validator('session_id', 'user_id', 'username', 'entity_id')
    def validate_string_fields(cls, v):
        """Validate and sanitize required string fields."""
        if not v or not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return sanitized_input(v.strip(), allow_html=False)

    @validator('message_content')
    def sanitize_message_content(cls, v):
        """Sanitize message content to prevent injection attacks."""
        if v:
            return sanitized_input(v, allow_html=False)
        return ''

    @validator('message_type')
    def validate_message_type(cls, v):
        """Validate and sanitize message type."""
        if v:
            v = v.strip()
            return sanitized_input(v, allow_html=False)
        return 'chatMessage'

    @validator('display_name')
    def validate_display_name(cls, v):
        """Validate and sanitize display name."""
        if v is not None:
            v = v.strip()
            if not v:
                return None
            return sanitized_input(v, allow_html=False)
        return v

    class Config:
        extra = 'ignore'  # Allow extra fields for flexibility


__all__ = [
    'ChatRequest',
    'ProviderConfigRequest',
    'ConversationSearchParams',
    'InteractionRequest',
]
