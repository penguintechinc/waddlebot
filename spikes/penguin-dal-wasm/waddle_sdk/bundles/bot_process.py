"""STUB, not a copy -- stands in for `core/svc_process/bundles/bot_process.py`.

`social_alias_process.py` (unmodified) lazily imports `_BOT_COMMANDS` and
`_FEATURE_MODULES` from this module inside `_known_commands()`, on the
`!alias add ...` write path only (never on read/list/no-match paths).

The REAL `bot_process.py` is a 461-line sibling bundle that, at its own
top level, does `from services.command_alias_store import resolve_alias`
-- which in turn does `import redis.asyncio as redis_asyncio` and
`from config import Config`. Pulling in the real file would drag a Redis
client and an env-config loader into the WASM component purely to answer
"is 'time' a known bot command?" -- orthogonal to this spike's actual
question (can a bundle's *penguin-dal calls* cross a WIT boundary). That
transitive pull is itself a real finding (see REPORT.md "Non-DAL
transitive imports"), not something this stub tries to solve.

This stub reproduces only the two names `social_alias_process.py` reads,
with values chosen to exercise both branches of `_cmd_set_alias`'s
first-word check in the spike's two test events.
"""

from __future__ import annotations

#: Recognized bare bot commands (`bot_process._BOT_COMMANDS` in the real module).
_BOT_COMMANDS: frozenset[str] = frozenset({"time", "help", "ping"})

#: Recognized feature-module dispatch words (`bot_process._FEATURE_MODULES` in the
#: real module, normally `dict[str, Callable]`; `social_alias_process.py` only ever
#: reads `.keys()`, so an empty dict is a faithful-enough stand-in for this spike).
_FEATURE_MODULES: dict[str, object] = {}
