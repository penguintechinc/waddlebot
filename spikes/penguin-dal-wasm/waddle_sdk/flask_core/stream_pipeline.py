"""Spike stand-in for `flask_core.stream_pipeline` -- `PlatformEvent` only.

Field-for-field copy of the real dataclass's shape (waddlebot
`libs/flask_core/flask_core/stream_pipeline.py::PlatformEvent`) so
`social_alias_process.py` (unmodified) sees the identical attribute
surface (`event.payload`, `event.actor`, `event.platform`,
`dataclasses.replace(event, payload=...)`). `StageEnvelope`/`EnvelopeError`
and everything Valkey-stream-key related are NOT reproduced -- this bundle
never imports them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(slots=True, frozen=True)
class PlatformEvent:
    """A normalized inbound platform event -- see the real module's docstring."""

    platform: str
    event_type: str
    actor: str | None
    payload: dict[str, Any]
    occurred_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "platform": self.platform,
            "event_type": self.event_type,
            "actor": self.actor,
            "payload": dict(self.payload),
            "occurred_at": self.occurred_at,
        }

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "PlatformEvent":
        return cls(
            platform=str(d["platform"]),
            event_type=str(d["event_type"]),
            actor=(None if d.get("actor") is None else str(d["actor"])),
            payload=dict(d["payload"]),
            occurred_at=str(d["occurred_at"]),
        )
