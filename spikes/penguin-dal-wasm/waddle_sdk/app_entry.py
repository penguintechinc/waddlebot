"""componentize-py app module for the `waddle:bundle/stage@0.0.1-spike` world.

Plays the role a stage runner (`core/svc_process/runner.py`) plays for a
real bundle: binds the DAL facade once at process/module start
(`set_bundle_dal`, normally `core/svc_process/app.py`'s `before_serving`
hook) and wraps each envelope's `transform()` call in `bundle_context()`
(normally `runner.py::_transform_and_enqueue`). The bundle module itself
(`bundles/social_alias_process.py`) is byte-for-byte unmodified.

Name deliberately not `stage` or `wit_world` -- componentize-py generates
code using those names (see `componentize-py componentize --help`).
"""

from __future__ import annotations

import asyncio
import json
import logging

import _buildtime_marker  # noqa: F401 -- import-time side effect is the point, see its docstring
import wit_world
from _poll_loop import PollLoop
from flask_core import PlatformEvent, bundle_context, set_bundle_dal
from flask_core.database import WasmDAL

import bundles.bot_process  # noqa: F401 -- see comment below: forces componentize-py to embed it
import bundles.social_alias_process as social_alias_process

# WHY THE ABOVE LINE EXISTS (harness-only; social_alias_process.py itself is untouched):
# componentize-py's dependency-closure analysis only follows STATIC
# (module-level) `import`/`from ... import` edges reachable from this app
# module. `social_alias_process.py`'s own `_known_commands()` imports
# `bundles.bot_process` lazily, INSIDE a function body, by deliberate
# design (its own docstring: avoids a circular import at module-load time
# since the real `bot_process.py` imports `social_alias_process` back).
# That edge is invisible to componentize-py's static crawler -- omitting
# this line reproduces a real, observed `ModuleNotFoundError:
# No module named 'bundles.bot_process'` at guest runtime (see REPORT.md).
# A production bundle host would need the equivalent of this workaround
# for every bundle shipping a deferred/dynamic import: pre-import (or
# otherwise force-embed) every module in the bundle's own directory, not
# just the declared entrypoint.


def _run_coro(coro):
    """Drive one coroutine to completion with `PollLoop` -- `asyncio.run()`
    cannot be used here (see `_poll_loop.py` docstring: its default event
    loop's self-pipe construction raises `PermissionError` in this sandbox).
    """
    loop = PollLoop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        asyncio.set_event_loop(None)


class _HostLogHandler(logging.Handler):
    """Routes stdlib `logging` (the bundle uses `logger.debug(...)` throughout)
    to the WIT `log` host import -- the sandbox has no stdout/stderr channel
    a host can casually observe, so this is how DEBUG decision points
    (`social_alias_process.flattened`, `.set_denied`, etc.) become visible.
    """

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover - IO shim
        try:
            wit_world.log(record.levelname, self.format(record))
        except Exception:
            pass


logging.getLogger().addHandler(_HostLogHandler())
logging.getLogger().setLevel(logging.DEBUG)

# Bound once, like a stage runner's own startup -- never inside transform().
set_bundle_dal(WasmDAL())


class WitWorld:
    """componentize-py's expected app-class name (matches the generated
    `wit_world.WitWorld` Protocol) -- it instantiates this with no args and
    calls its methods for each guest export invocation.
    """

    def transform(self, event: str) -> str | None:
        """The world's sole export. JSON `PlatformEvent` in, JSON (or none) out."""
        event_obj = PlatformEvent.from_dict(json.loads(event))
        ctx = json.loads(wit_world.context_get())

        async def _run() -> PlatformEvent | None:
            with bundle_context(
                tenant=ctx["tenant"], community=ctx["community"], app_id=ctx["app_id"]
            ):
                return await social_alias_process.transform(event_obj)

        result = _run_coro(_run())
        if result is None:
            return None
        return json.dumps(result.to_dict())
