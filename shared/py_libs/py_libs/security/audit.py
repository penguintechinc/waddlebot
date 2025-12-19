"""
Audit logging for security events and compliance.

Tracks security-relevant actions for investigation and compliance purposes.
Supports file logging with rotation and optional Redis/database backends.
"""

import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


class AuditLevel(str, Enum):
    """Audit event severity levels."""
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class AuditCategory(str, Enum):
    """Audit event categories."""
    AUTHENTICATION = "AUTHENTICATION"
    AUTHORIZATION = "AUTHORIZATION"
    DATA_ACCESS = "DATA_ACCESS"
    DATA_MODIFICATION = "DATA_MODIFICATION"
    CONFIGURATION_CHANGE = "CONFIGURATION_CHANGE"
    SECURITY_EVENT = "SECURITY_EVENT"
    USER_MANAGEMENT = "USER_MANAGEMENT"
    SYSTEM_EVENT = "SYSTEM_EVENT"


@dataclass(slots=True)
class AuditEvent:
    """Audit event data structure."""
    timestamp: str
    level: AuditLevel
    category: AuditCategory
    action: str
    success: bool
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    resource: Optional[str] = None
    request_id: Optional[str] = None
    session_id: Optional[str] = None
    error_message: Optional[str] = None
    details: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        result = {
            "timestamp": self.timestamp,
            "level": self.level.value,
            "category": self.category.value,
            "action": self.action,
            "success": self.success,
        }

        # Add optional fields if present
        if self.user_id:
            result["user_id"] = self.user_id
        if self.user_name:
            result["user_name"] = self.user_name
        if self.ip_address:
            result["ip_address"] = self.ip_address
        if self.user_agent:
            result["user_agent"] = self.user_agent
        if self.resource:
            result["resource"] = self.resource
        if self.request_id:
            result["request_id"] = self.request_id
        if self.session_id:
            result["session_id"] = self.session_id
        if self.error_message:
            result["error_message"] = self.error_message
        if self.details:
            result["details"] = self.details

        return result

    def to_json(self) -> str:
        """Serialize to JSON string."""
        return json.dumps(self.to_dict())


@dataclass(slots=True)
class AuditLoggerConfig:
    """Audit logger configuration."""
    log_file_path: Optional[str] = None
    console_output: bool = True
    min_level: AuditLevel = AuditLevel.INFO
    max_file_size: int = 100 * 1024 * 1024  # 100 MB
    max_files: int = 10
    default_metadata: Dict[str, Any] = field(default_factory=dict)
    formatter: Optional[Callable[[AuditEvent], str]] = None


def default_formatter(event: AuditEvent) -> str:
    """Default JSON formatter for audit events."""
    return event.to_json()


def text_formatter(event: AuditEvent) -> str:
    """Human-readable text formatter for audit events."""
    parts = [
        f"[{event.timestamp}]",
        f"[{event.level.value}]",
        f"[{event.category.value}]",
        f"{event.action}",
        "SUCCESS" if event.success else "FAILURE",
    ]

    if event.user_name:
        parts.append(f"user={event.user_name}")
    if event.ip_address:
        parts.append(f"ip={event.ip_address}")
    if event.resource:
        parts.append(f"resource={event.resource}")
    if event.error_message:
        parts.append(f"error={event.error_message}")

    return " ".join(parts)


class AuditLogger:
    """
    Audit logger for security event tracking.

    Example:
        from py_libs.security.audit import AuditLogger, AuditLoggerConfig

        # Create logger
        audit = AuditLogger(AuditLoggerConfig(
            log_file_path="/var/log/waddlebot/audit.log",
            console_output=False,
        ))

        # Log authentication event
        audit.log_auth("login", success=True, user_id="123", ip_address="192.168.1.1")

        # Log security event
        audit.log_security_event("brute_force_attempt", ip_address="192.168.1.100")
    """

    LEVEL_ORDER = [AuditLevel.INFO, AuditLevel.WARNING, AuditLevel.CRITICAL]

    def __init__(self, config: Optional[AuditLoggerConfig] = None):
        self.config = config or AuditLoggerConfig()
        self._file_handle = None
        self._current_file_size = 0
        self._logger = logging.getLogger("audit")

        # Initialize file logging if path provided
        if self.config.log_file_path:
            self._init_file_logging()

    def _init_file_logging(self) -> None:
        """Initialize file logging with rotation support."""
        log_dir = os.path.dirname(self.config.log_file_path)

        # Create directory if it doesn't exist
        if log_dir and not os.path.exists(log_dir):
            os.makedirs(log_dir, mode=0o750)

        # Get current file size if exists
        if os.path.exists(self.config.log_file_path):
            self._current_file_size = os.path.getsize(self.config.log_file_path)

        # Open file for appending
        self._file_handle = open(self.config.log_file_path, "a", encoding="utf-8")

    def _rotate_log(self) -> None:
        """Rotate log files."""
        if not self.config.log_file_path:
            return

        # Close current file
        if self._file_handle:
            self._file_handle.close()

        # Rotate files
        for i in range(self.config.max_files - 1, -1, -1):
            old_path = (
                self.config.log_file_path if i == 0
                else f"{self.config.log_file_path}.{i}"
            )
            new_path = f"{self.config.log_file_path}.{i + 1}"

            if os.path.exists(old_path):
                if i == self.config.max_files - 1:
                    os.remove(old_path)  # Delete oldest
                else:
                    os.rename(old_path, new_path)

        # Reset current file
        self._current_file_size = 0
        self._file_handle = open(self.config.log_file_path, "a", encoding="utf-8")

    def _should_log(self, level: AuditLevel) -> bool:
        """Check if event should be logged based on level."""
        event_level_idx = self.LEVEL_ORDER.index(level)
        min_level_idx = self.LEVEL_ORDER.index(self.config.min_level)
        return event_level_idx >= min_level_idx

    def _format_event(self, event: AuditEvent) -> str:
        """Format event using configured formatter."""
        if self.config.formatter:
            return self.config.formatter(event)
        return default_formatter(event)

    def _write_log(self, event: AuditEvent) -> None:
        """Write log entry to configured outputs."""
        log_entry = self._format_event(event)

        # Console output
        if self.config.console_output:
            self._logger.info(log_entry)

        # File output
        if self._file_handle:
            self._file_handle.write(log_entry + "\n")
            self._file_handle.flush()
            self._current_file_size += len(log_entry) + 1

            # Check if rotation needed
            if self._current_file_size >= self.config.max_file_size:
                self._rotate_log()

    def log(
        self,
        level: AuditLevel,
        category: AuditCategory,
        action: str,
        success: bool = True,
        **kwargs: Any
    ) -> None:
        """
        Log an audit event.

        Args:
            level: Event severity level.
            category: Event category.
            action: Action being performed.
            success: Whether action succeeded.
            **kwargs: Additional event fields (user_id, ip_address, etc.)
        """
        if not self._should_log(level):
            return

        # Merge default metadata
        event_data = {**self.config.default_metadata, **kwargs}

        event = AuditEvent(
            timestamp=datetime.now(timezone.utc).isoformat(),
            level=level,
            category=category,
            action=action,
            success=success,
            user_id=event_data.get("user_id"),
            user_name=event_data.get("user_name"),
            ip_address=event_data.get("ip_address"),
            user_agent=event_data.get("user_agent"),
            resource=event_data.get("resource"),
            request_id=event_data.get("request_id"),
            session_id=event_data.get("session_id"),
            error_message=event_data.get("error_message"),
            details=event_data.get("details"),
        )

        self._write_log(event)

    def log_auth(
        self,
        action: str,
        success: bool,
        **kwargs: Any
    ) -> None:
        """Log authentication event."""
        level = AuditLevel.INFO if success else AuditLevel.WARNING
        self.log(level, AuditCategory.AUTHENTICATION, action, success, **kwargs)

    def log_authz(
        self,
        action: str,
        success: bool,
        **kwargs: Any
    ) -> None:
        """Log authorization event."""
        level = AuditLevel.INFO if success else AuditLevel.WARNING
        self.log(level, AuditCategory.AUTHORIZATION, action, success, **kwargs)

    def log_data_access(
        self,
        resource: str,
        **kwargs: Any
    ) -> None:
        """Log data access event."""
        self.log(
            AuditLevel.INFO,
            AuditCategory.DATA_ACCESS,
            "data_access",
            True,
            resource=resource,
            **kwargs
        )

    def log_data_modification(
        self,
        resource: str,
        action: str,
        **kwargs: Any
    ) -> None:
        """Log data modification event."""
        self.log(
            AuditLevel.INFO,
            AuditCategory.DATA_MODIFICATION,
            action,
            True,
            resource=resource,
            **kwargs
        )

    def log_security_event(
        self,
        action: str,
        **kwargs: Any
    ) -> None:
        """Log high-priority security event."""
        self.log(
            AuditLevel.CRITICAL,
            AuditCategory.SECURITY_EVENT,
            action,
            False,
            **kwargs
        )

    def log_config_change(
        self,
        action: str,
        resource: str,
        **kwargs: Any
    ) -> None:
        """Log configuration change event."""
        self.log(
            AuditLevel.INFO,
            AuditCategory.CONFIGURATION_CHANGE,
            action,
            True,
            resource=resource,
            **kwargs
        )

    def extract_request_info(self, request: Any) -> Dict[str, Any]:
        """
        Extract audit-relevant information from a request object.

        Args:
            request: Request object (Quart, Flask, etc.)

        Returns:
            Dictionary with user_id, ip_address, user_agent, etc.
        """
        info: Dict[str, Any] = {}

        # User info (if authenticated)
        user = getattr(request, "user", None)
        if user:
            info["user_id"] = str(getattr(user, "id", None))
            info["user_name"] = (
                getattr(user, "email", None) or
                getattr(user, "username", None)
            )

        # Request info
        headers = getattr(request, "headers", {})
        info["user_agent"] = headers.get("User-Agent")
        info["request_id"] = (
            getattr(request, "id", None) or
            headers.get("X-Request-ID")
        )

        # Session ID
        info["session_id"] = getattr(request, "session_id", None)

        # IP address
        info["ip_address"] = self._get_client_ip(request)

        return {k: v for k, v in info.items() if v is not None}

    def _get_client_ip(self, request: Any) -> Optional[str]:
        """Extract client IP address from request."""
        headers = getattr(request, "headers", {})

        # Check proxy headers
        forwarded = headers.get("X-Forwarded-For")
        if forwarded:
            ips = forwarded.split(",")
            return ips[0].strip()

        # Direct IP
        return (
            getattr(request, "remote_addr", None) or
            getattr(request, "ip", None)
        )

    def close(self) -> None:
        """Close audit logger and cleanup resources."""
        if self._file_handle:
            self._file_handle.close()
            self._file_handle = None


def create_audit_logger(config: Optional[AuditLoggerConfig] = None) -> AuditLogger:
    """Create an audit logger instance."""
    return AuditLogger(config)


__all__ = [
    "AuditLevel",
    "AuditCategory",
    "AuditEvent",
    "AuditLoggerConfig",
    "AuditLogger",
    "create_audit_logger",
    "default_formatter",
    "text_formatter",
]
