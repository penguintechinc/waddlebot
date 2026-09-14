"""Spike `flask_core` shim -- same import name, same public surface, as far as
`bundles/social_alias_process.py` (unmodified) needs. See `database.py`,
`bundle_runtime.py`, `feature_flags.py`, `stream_pipeline.py` docstrings for
what each piece reproduces and what it deliberately does not.
"""

from __future__ import annotations

from .bundle_runtime import (
    BundleContext,
    BundleRuntimeError,
    bundle_context,
    get_bundle_context,
    get_bundle_dal,
    reset_bundle_dal_for_tests,
    set_bundle_dal,
)
from .stream_pipeline import PlatformEvent

__all__ = [
    "BundleContext",
    "BundleRuntimeError",
    "PlatformEvent",
    "bundle_context",
    "get_bundle_context",
    "get_bundle_dal",
    "reset_bundle_dal_for_tests",
    "set_bundle_dal",
]
