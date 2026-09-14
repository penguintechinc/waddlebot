"""Round 2, blocker (1): makes `asyncio.to_thread()` work in this sandbox.

Round 1 found `asyncio.to_thread()` raises `NotImplementedError` here --
no real OS threads exist inside componentize-py's WASI sandbox, and its
own official `PollLoop` (see `_poll_loop.py`) leaves `run_in_executor`
unimplemented for exactly that reason. `social_alias_process.py`
(unmodified) wraps every synchronous DB call in `asyncio.to_thread(...)`.

**Why running the callable synchronously in place is semantically safe
here, specifically:** the whole reason `to_thread` exists is to keep a
*blocking* call off the event loop so other coroutines keep making
progress concurrently. In this sandbox there IS no concurrent work to
starve -- one `transform()` call runs start-to-finish before the next
begins (`core/svc_process/runner.py`'s own real stage runner is a
`while True: rpop` loop, never concurrent `asyncio.gather` fan-out,
per `flask_core/bundle_runtime.py`'s module docstring), and the
"blocking" work itself is a single synchronous `db-execute` WIT host
call, not real disk/network I/O with unpredictable latency. Running it
in place changes nothing observable for THIS workload.

**Why this does NOT generalize:** a bundle using `asyncio.to_thread` for
genuine CPU-bound work expecting real parallelism (e.g. hashing a large
payload alongside other in-flight coroutines) would silently have that
work serialized instead -- functionally different, just usually still
"correct", never actually parallel. A real SDK shipping this patch must
document that boundary explicitly, not assume every `to_thread` call is
DB-shaped like this one.

Imported first thing by `app_entry.py`, before `flask_core`/`bundles`,
so the patched `asyncio.to_thread` is in place before
`social_alias_process.transform()` ever calls it.
"""

from __future__ import annotations

import asyncio
import functools


async def _sync_to_thread(func, /, *args, **kwargs):
    """Drop-in replacement for `asyncio.to_thread` -- runs `func` in place.

    Matches the real function's signature and calling convention
    (`func(*args, **kwargs)`, returned via `await`) exactly, so no caller
    needs to change. Unlike the real one, no `contextvars.copy_context()`
    dance is needed -- there's no other thread for a copied context to
    protect against.
    """
    call = functools.partial(func, *args, **kwargs)
    return call()


asyncio.to_thread = _sync_to_thread
