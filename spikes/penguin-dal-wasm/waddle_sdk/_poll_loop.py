"""Trimmed copy of componentize-py's own `poll_loop.PollLoop`
(componentize-py 0.25.1, generated into every `componentize-py bindings`
output as an example host loop for `wasi:http`-style async code) --
stripped of the `wasi:http`-specific `send`/`Stream`/`Sink`/`register`
helpers this spike's world doesn't need, since `wasi:http` was never
imported. Kept because it is the ONLY asyncio event loop componentize-py's
own documentation ships that actually runs inside this sandbox at all --
`asyncio.run()` cannot even construct its default `SelectorEventLoop`
here (see REPORT.md: `_make_self_pipe` -> `socket.socketpair()` ->
`PermissionError`).

Load-bearing finding this class also *proves*, by omission: its own
`run_in_executor` is `raise NotImplementedError` -- componentize-py's own
maintainers never implemented it, because there is no real OS thread pool
to hand blocking work to inside this sandbox. `asyncio.to_thread()`
(`social_alias_process.py`'s own pattern for every synchronous DB call)
calls exactly this method. See REPORT.md Sec "asyncio.to_thread" for the
observed traceback.
"""

from __future__ import annotations

import asyncio


class PollLoop(asyncio.AbstractEventLoop):
    """Minimal `asyncio` event loop that never blocks on real OS I/O.

    Sufficient to drive a coroutine that only ever awaits other coroutines
    or values that resolve immediately (no real suspension) -- exactly
    this spike's `flask_core.database.WasmDAL.execute()`, which performs a
    synchronous WIT host call inside an `async def` and never actually
    yields. Does NOT support `run_in_executor` (see module docstring) --
    the wasi:io/poll-based wakers path from the upstream file is likewise
    omitted since nothing here ever calls `register()`.
    """

    def __init__(self) -> None:
        self.running = False
        self.handles: list[asyncio.Handle] = []
        self.exception: BaseException | None = None

    def get_debug(self) -> bool:
        return False

    def run_until_complete(self, future):
        future = asyncio.ensure_future(future, loop=self)

        self.running = True
        asyncio.events._set_running_loop(self)
        while self.running and not future.done():
            handles = self.handles
            self.handles = []
            for handle in handles:
                if not handle._cancelled:
                    handle._run()

            if not handles:
                # Nothing left to run and nothing pending -- would spin
                # forever if the future never completes without real I/O.
                if not future.done():
                    raise RuntimeError(
                        "PollLoop: coroutine suspended waiting on real I/O "
                        "this loop cannot service (no wasi:io/poll wakers "
                        "path in this trimmed copy)"
                    )

            if self.exception is not None:
                raise self.exception

        return future.result()

    def is_running(self) -> bool:
        return self.running

    def is_closed(self) -> bool:
        return not self.running

    def stop(self) -> None:
        self.running = False

    def close(self) -> None:
        self.running = False

    def shutdown_asyncgens(self):
        pass

    def call_exception_handler(self, context) -> None:
        self.exception = context.get("exception", None)

    def call_soon(self, callback, *args, context=None):
        handle = asyncio.Handle(callback, args, self, context)
        self.handles.append(handle)
        return handle

    def create_task(self, coroutine):
        return asyncio.Task(coroutine, loop=self)

    def create_future(self):
        return asyncio.Future(loop=self)

    def run_in_executor(self, executor, func, *args):
        # This is the method `asyncio.to_thread()` calls. componentize-py's
        # own upstream `poll_loop.py` leaves this exact method unimplemented
        # too -- there is no OS thread pool inside this sandbox to hand
        # blocking work to.
        raise NotImplementedError(
            "run_in_executor (and therefore asyncio.to_thread) is not "
            "supported: no real OS threads are available inside "
            "componentize-py's WASI sandbox"
        )
