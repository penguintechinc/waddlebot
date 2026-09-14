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
import socket

import _asyncio_patch  # noqa: F401 -- Round 2 blocker (1): must patch asyncio.to_thread FIRST,
# before `flask_core`/`bundles` (and therefore `social_alias_process.py`) import `asyncio`
# themselves -- patching `asyncio.to_thread` as a module attribute is safe regardless of
# import order (callers do `asyncio.to_thread(...)`, not `from asyncio import to_thread`),
# but importing it first here keeps the intent obvious at a glance.
import _buildtime_marker  # noqa: F401 -- import-time side effect is the point, see its docstring
import _bundle_preimports  # noqa: F401 -- Round 2 blocker (2): auto-generated, see that file's docstring
import wit_world
from _poll_loop import PollLoop
from flask_core import PlatformEvent, bundle_context, set_bundle_dal
from flask_core.database import WasmDAL

import bundles.social_alias_process as social_alias_process


def _probe_socket_denied() -> None:
    """Round 2 blocker (3): a clean, deliberate probe -- NOT part of the
    bundle, which never attempts network I/O itself -- proving that
    opening a real socket from inside this WASM guest fails cleanly rather
    than hanging or crashing the component. Logged via the `log` WIT
    import so the host can observe the outcome. See REPORT.md Round 2 for
    why this, not hand-authored `wasi:sockets/*` deny-stubs, is the
    practical way to demonstrate the deny behavior with wasmtime-py's
    exposed component API (no resource-typed stub-authoring surface
    without WIT-driven codegen, and no capability to grant network access
    from `WasiConfig` in the first place -- so the *only* observable
    outcome is denial, whether or not a stub is hand-written).

    Deliberately NOT called at module top level: componentize-py's own
    build step runs an actual sandboxed dry-run of this module with every
    CUSTOM (non-WASI) WIT import wired to a TRAPPING stub (discovered the
    hard way -- an earlier version of this file called this function at
    import time and the `componentize` build itself crashed with `called
    trapping stub: log`; see REPORT.md Round 2 for the corrected
    understanding this forced of Round 1's build-time-execution claim).
    Called instead from `WitWorld.transform()`, once, on first real
    invocation under an actual host that answers `log` for real.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.close()
        wit_world.log("WARN", "socket probe: socket() unexpectedly SUCCEEDED")
    except Exception as exc:  # noqa: BLE001 -- this IS the probe; any exception is the expected/desired outcome
        wit_world.log("INFO", f"socket probe: socket() denied cleanly -- {type(exc).__name__}: {exc}")


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

_socket_probe_done = False


class WitWorld:
    """componentize-py's expected app-class name (matches the generated
    `wit_world.WitWorld` Protocol) -- it instantiates this with no args and
    calls its methods for each guest export invocation.
    """

    def transform(self, event: str) -> str | None:
        """The world's sole export. JSON `PlatformEvent` in, JSON (or none) out."""
        global _socket_probe_done
        if not _socket_probe_done:
            _probe_socket_denied()  # Round 2 blocker (3) -- see that function's docstring for why it's here, not at module level
            _socket_probe_done = True

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
