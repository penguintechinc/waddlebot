"""
Python 3.13 Optimized Dataclasses
==================================

Shared dataclasses used across all WaddleBot modules.
Optimized with slots=True for memory efficiency and performance.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Dict, Any, List
from enum import Enum


class MessageType(str, Enum):
    """Message/event types"""
    CHAT_MESSAGE = "chatMessage"
    SUBSCRIPTION = "subscription"
    FOLLOW = "follow"
    DONATION = "donation"
    CHEER = "cheer"
    RAID = "raid"
    HOST = "host"
    SUBGIFT = "subgift"
    RESUB = "resub"
    REACTION = "reaction"
    MEMBER_JOIN = "member_join"
    MEMBER_LEAVE = "member_leave"
    VOICE_JOIN = "voice_join"
    VOICE_LEAVE = "voice_leave"
    VOICE_TIME = "voice_time"
    BOOST = "boost"
    BAN = "ban"
    KICK = "kick"
    TIMEOUT = "timeout"
    WARN = "warn"
    FILE_SHARE = "file_share"
    APP_MENTION = "app_mention"
    CHANNEL_JOIN = "channel_join"


class Platform(str, Enum):
    """Platform types"""
    TWITCH = "twitch"
    DISCORD = "discord"
    SLACK = "slack"
    UNKNOWN = "unknown"


class ResponseAction(str, Enum):
    """Module response action types"""
    CHAT = "chat"
    MEDIA = "media"
    TICKER = "ticker"
    GENERAL = "general"
    FORM = "form"


@dataclass(slots=True, frozen=True)
class CommandRequest:
    """
    Command request from platform to router.
    Immutable and memory-efficient with slots.
    """
    entity_id: str
    user_id: str
    message: str
    message_type: MessageType
    platform: Platform
    session_id: Optional[str] = None
    username: Optional[str] = None
    display_name: Optional[str] = None
    channel_id: Optional[str] = None
    server_id: Optional[str] = None
    timestamp: datetime = field(default_factory=datetime.utcnow)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class CommandResult:
    """
    Result of command execution.
    Mutable to allow updating during processing.
    """
    execution_id: str
    command_id: Optional[int]
    success: bool
    response_action: Optional[ResponseAction] = None
    response_data: Dict[str, Any] = field(default_factory=dict)
    processing_time_ms: int = 0
    error_message: Optional[str] = None
    session_id: Optional[str] = None
    retry_count: int = 0
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass(slots=True, frozen=True)
class IdentityPayload:
    """
    User identity information for context API.
    """
    platform: Platform
    platform_user_id: str
    platform_username: str
    entity_id: str
    waddlebot_user_id: Optional[str] = None
    display_name: Optional[str] = None
    is_verified: bool = False
    reputation_score: int = 0
    roles: List[str] = field(default_factory=list)
    labels: List[str] = field(default_factory=list)


@dataclass(slots=True, frozen=True)
class Activity:
    """
    User activity for reputation tracking.
    """
    entity_id: str
    user_id: str
    username: str
    activity_type: MessageType
    platform: Platform
    amount: int  # Points value
    metadata: Dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass(slots=True)
class EventPayload:
    """
    Generic event payload for platform events.
    """
    event_id: str
    event_type: MessageType
    platform: Platform
    entity_id: str
    user_id: str
    username: str
    display_name: Optional[str] = None
    data: Dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.utcnow)
    processed: bool = False
    error_message: Optional[str] = None


@dataclass(slots=True)
class ModuleResponse:
    """
    Response from interaction module back to router.
    """
    execution_id: str
    session_id: str
    module_name: str
    success: bool
    response_action: ResponseAction
    response_data: Dict[str, Any] = field(default_factory=dict)
    media_type: Optional[str] = None
    media_url: Optional[str] = None
    ticker_text: Optional[str] = None
    ticker_duration: int = 10
    chat_message: Optional[str] = None
    error_message: Optional[str] = None
    processing_time_ms: int = 0
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass(slots=True, frozen=True)
class OAuthToken:
    """
    OAuth token storage.
    """
    platform: Platform
    access_token: str
    refresh_token: Optional[str] = None
    token_type: str = "Bearer"
    expires_at: Optional[datetime] = None
    scope: List[str] = field(default_factory=list)


@dataclass(slots=True)
class BrowserSourceMessage:
    """
    Message to browser source via WebSocket.
    """
    source_type: str  # 'ticker', 'media', 'general'
    action: str  # 'display', 'update', 'clear'
    content: Dict[str, Any]
    duration: int = 10
    priority: int = 0
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass(slots=True, frozen=True)
class APIKeyInfo:
    """
    API key information.
    """
    key_id: str
    name: str
    user_id: str
    key_hash: str
    permissions: List[str]
    is_active: bool
    created_at: datetime
    expires_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None


@dataclass(slots=True)
class RateLimitInfo:
    """
    Rate limit tracking information.
    """
    key: str  # Unique identifier for rate limit
    window_start: datetime
    request_count: int
    limit: int
    window_seconds: int

    def is_exceeded(self) -> bool:
        """Check if rate limit is exceeded"""
        return self.request_count >= self.limit

    def reset_if_expired(self, now: Optional[datetime] = None) -> None:
        """Reset counter if window expired"""
        now = now or datetime.utcnow()
        window_end = self.window_start.timestamp() + self.window_seconds
        if now.timestamp() >= window_end:
            self.window_start = now
            self.request_count = 0


@dataclass(slots=True, frozen=True)
class CoordinationClaim:
    """
    Coordination system claim for horizontal scaling.
    """
    entity_id: str
    platform: Platform
    server_id: Optional[str]
    channel_id: Optional[str]
    claimed_by: str  # Container ID
    claimed_at: datetime
    claim_expires: datetime
    heartbeat_interval: int = 300  # 5 minutes
    is_live: bool = False
    viewer_count: int = 0
    priority: int = 0


@dataclass(slots=True)
class HealthCheckResult:
    """
    Health check result for module monitoring.
    """
    module_name: str
    status: str  # 'healthy', 'degraded', 'unhealthy'
    version: str
    uptime_seconds: int
    database_connected: bool
    redis_connected: bool
    timestamp: datetime = field(default_factory=datetime.utcnow)
    details: Dict[str, Any] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)


@dataclass(slots=True)
class MetricsSnapshot:
    """
    Performance metrics snapshot.
    """
    module_name: str
    requests_total: int
    requests_success: int
    requests_failed: int
    avg_response_time_ms: float
    p95_response_time_ms: float
    p99_response_time_ms: float
    active_connections: int
    cache_hit_rate: float
    timestamp: datetime = field(default_factory=datetime.utcnow)


# Type aliases for Python 3.13
type CommandHandler = callable[[CommandRequest], CommandResult]
type AsyncCommandHandler = callable[[CommandRequest], CommandResult]
type EventHandler = callable[[EventPayload], None]
type AsyncEventHandler = callable[[EventPayload], None]
