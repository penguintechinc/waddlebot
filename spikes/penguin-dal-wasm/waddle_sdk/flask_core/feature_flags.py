"""Spike stand-in for `flask_core.feature_flags.feature_enabled`.

The real function evaluates a PostHog flag + license-tier entitlement,
degrading to `default` on any outage (never raising). No PostHog/license
server exists inside a WASM sandbox with no outbound sockets, so this
spike goes straight to the documented degrade path: always return
`default`. Same signature as the real function so the unmodified bundle's
call site (`feature_enabled(_FEATURE_FLAG, tenant=..., community=..., default=True)`)
needs no changes.
"""

from __future__ import annotations


async def feature_enabled(
    flag_key: str,
    *,
    tenant: str,
    community: int | None = None,
    default: bool = False,
) -> bool:
    """Always return `default` -- no PostHog/license server reachable from inside WASI."""
    return default
