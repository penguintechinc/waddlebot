"""Spike stand-in for `flask_core.bundle_runtime` -- same names, same contract.

Reproduced near-verbatim from the real module (pure stdlib: `contextvars`
+ `dataclasses`, no pydal/quart import) since this piece is host-runtime
plumbing, not part of the DAL question this spike is testing. In the real
system a stage runner (`core/svc_process/app.py` / `runner.py`) calls
`set_bundle_dal()` once at process startup and wraps each envelope in
`bundle_context()`; here, `app_entry.py` (this component's WIT-world
implementation) plays that role.
"""

from __future__ import annotations

import contextvars
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any


class BundleRuntimeError(RuntimeError):
    """Raised when `get_bundle_dal()`/`get_bundle_context()` is called unbound."""


_dal: Any = None


def set_bundle_dal(dal: Any) -> None:
    """Bind the process-wide DAL facade every `get_bundle_dal()` call will return."""
    global _dal
    _dal = dal


def get_bundle_dal() -> Any:
    """Return the DAL facade bound by `set_bundle_dal()`."""
    if _dal is None:
        raise BundleRuntimeError("no DAL bound -- call set_bundle_dal() first")
    return _dal


def reset_bundle_dal_for_tests() -> None:
    """Clear the bound DAL (test-only, mirrors the real module)."""
    global _dal
    _dal = None


@dataclass(slots=True, frozen=True)
class BundleContext:
    """The tenant/community/app_id scope of the envelope currently being processed."""

    tenant: str
    community: str | None
    app_id: str


_context: contextvars.ContextVar[BundleContext | None] = contextvars.ContextVar(
    "waddlebot_bundle_context", default=None
)


def get_bundle_context() -> BundleContext:
    """Return the `BundleContext` bound for the envelope currently being processed."""
    ctx = _context.get()
    if ctx is None:
        raise BundleRuntimeError("no bundle context bound -- enter bundle_context() first")
    return ctx


@contextmanager
def bundle_context(*, tenant: str, community: str | None, app_id: str) -> Iterator[BundleContext]:
    """Scope tenant/community/app_id for one bundle entrypoint invocation."""
    ctx = BundleContext(tenant=tenant, community=community, app_id=app_id)
    token = _context.set(ctx)
    try:
        yield ctx
    finally:
        _context.reset(token)
