# Spike: penguin-dal-compatible bundle in WASM (componentize-py + wasmtime)

**Question:** can an unchanged WaddleBot process-stage bundle that calls the DB
through `flask_core.get_bundle_dal()` be compiled to a WASI 0.2 component with
`componentize-py`, using a same-import-name `flask_core`/`bundles` shim that
routes statement execution to a WIT host import, and run under `wasmtime`
with the host side faked?

**Verdict: PARTIAL.** It builds, instantiates, and runs. The WIT plumbing,
the query-builder-to-SQL facade, and the host round trip all work correctly
and fast. But the bundle's actual DB read/write helpers all wrap their call
in `asyncio.to_thread()`, and that raises `NotImplementedError` in this
sandbox -- no real OS threads exist, and componentize-py's own official
async event loop (`poll_loop.PollLoop`, shipped in its example bindings)
explicitly leaves `run_in_executor` unimplemented. The ONE DB call this
bundle makes *without* `to_thread` (`_caller_is_moderator_or_admin`'s
`await dal.execute(...)`) completes correctly end-to-end. Everything else
degrades gracefully (bundle's own `try/except`) rather than crashing, but
never actually reaches the database.

---

## 1. Verdict table

| Question | Answer |
|---|---|
| Compiles unmodified bundle to a WASM component? | **Yes** -- 3.4-3.9s wall, 21.6 MB `.wasm` |
| Component instantiates + runs under `wasmtime`? | **Yes** -- via `wasmtime`-py's component API, WASIp2 linked |
| `flask_core`/DAL shim resolvable under the bundle's real import names? | **Yes** -- `from flask_core import ... get_bundle_dal` needs zero bundle changes |
| Query builder (`==`, `is_null()`, `&`) -> correct `(sql, params)`? | **Yes** -- verified host-side, see Sec 6 |
| Raw `await dal.execute(sql, params)` round-trips through `db-execute` WIT import? | **Yes** -- 2.2-3.7 ms/call observed in-sandbox |
| `select()`/`update()`/`insert_async()` (all wrapped in `asyncio.to_thread`) execute in-sandbox? | **No** -- `NotImplementedError`, caught by the bundle's own `except Exception`, returns a normal chat-error reply (no crash) |
| `asyncio.run()` usable at all in this sandbox? | **No** -- default event loop's self-pipe (`socket.socketpair()`) raises `PermissionError`; had to swap in componentize-py's own `PollLoop` |
| Deferred/lazy cross-module import (`_known_commands()`'s `from bundles.bot_process import ...`) auto-embedded? | **No** -- `ModuleNotFoundError` at runtime (component **traps**, does not degrade) unless the harness statically pre-imports it |
| Does componentize-py execute the bundle's top-level code on the build host? | **No** -- proven via import-time marker file, see Sec 4 |
| PostHog/license feature-flag check reachable? | N/A by design -- no outbound sockets from inside the sandbox; degrades to `default` per the bundle's own documented behavior |

---

## 2. Versions (pinned, recorded)

| Tool | Version | How pinned |
|---|---|---|
| `python:3.13-slim` | `python@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285` | `docker pull` + `docker inspect --format '{{index .RepoDigests 0}}'` |
| `componentize-py` (PyPI, in-container venv) | `0.25.1` (latest on PyPI at spike time) | `pip install componentize-py==0.25.1` |
| `wasmtime` (PyPI, in-container venv, host runner) | `48.0.0` (latest on PyPI at spike time) | `pip install wasmtime==48.0.0` |
| `wasmtime` CLI (native binary, sanity checks only) | `v48.0.2` (latest GitHub release) | Downloaded release tarball; no published checksum manifest, sha256 self-computed below |
| `wasm-tools` CLI | `v1.259.0` (latest GitHub release) | Downloaded release tarball; sha256 self-computed below |

Self-computed SHA256 (release has no published checksums file):
```
f2b0ad1ce9253f2f9a38793c2c42cd1cba4e90b27dc40d685eaf723dc8438d94  wasmtime-v48.0.2-x86_64-linux.tar.xz
3e9b374b4c7715b771b69bf0d65a337990ed4546ec5e97e01c0ff587dfc52160  wasm-tools-1.259.0-x86_64-linux.tar.gz
```

Note: `wasmtime` CLI (48.0.2) and the `wasmtime` PyPI package (48.0.0) are the
latest-at-spike-time releases of two independently-versioned artifacts from
the same project; the CLI was used only for local sanity checks
(`--version`), the actual component instantiation/run went through the
pinned Python package per the task's own allowance ("Python `wasmtime`
package is fine"). No PRC-origin tooling used.

All builds ran via (venv created inside the mounted spike dir with
`python3 -m venv`, packages installed with
`pip install componentize-py==0.25.1 wasmtime==48.0.0` -- never installed
on the host):
```bash
docker run --rm -u 1000:1000 -v "$PWD":/work -w /work \
  python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285 \
  /work/.venv/bin/componentize-py -d /work/wit -w stage componentize -p /work/waddle_sdk app_entry -o /work/evidence/bundle.wasm
```

---

## 3. Bundle chosen + its real import surface

`core/svc_process/bundles/social_alias_process.py` (`!alias`/`!unalias` --
CRUD on `command_aliases`), copied byte-for-byte into
`waddle_sdk/bundles/social_alias_process.py` -- verified identical
(sha256 `57f47adf1307d36fa0ab62a8f172026e4414d350657511951a1279a5414346bf`
on both copies).

Imports, by family:

| Family | Symbols |
|---|---|
| stdlib | `__future__.annotations`, `asyncio`, `dataclasses`, `importlib`, `inspect`, `logging`, `re`, `datetime.{UTC,datetime}` |
| `flask_core` (top-level) | `BundleContext`, `PlatformEvent`, `get_bundle_context`, `get_bundle_dal` |
| `flask_core.feature_flags` | `feature_enabled` |
| `waddle_transports` | **none** -- this is a process-stage bundle; transport imports are action-stage only |
| `penguin_dal` / `pydal` | **none directly** -- DB access is exclusively through the object `get_bundle_dal()` returns; no `import pydal`/`import penguin_dal` anywhere in this file |
| lazy/dynamic (function-local, not static imports) | `from bundles.bot_process import _BOT_COMMANDS, _FEATURE_MODULES` (inside `_known_commands()`); `importlib.import_module("services.command_alias_store")` (inside `_invalidate_alias_cache()`, already `try/except`-guarded in the real code) |

**Finding -- "penguin-dal" is a misnomer for what this bundle actually calls.**
`libs/flask_core/flask_core/database.py::AsyncDAL` does `from pydal import
DAL, Field` -- it wraps upstream **pydal**, not the separate in-house
`penguin_dal` PyPI package (`penguin-libs/packages/python-dal`), which has
its own, different `Field`/`Query`/`FieldProxy` API (SQLAlchemy-Core-backed,
no `.is_null()` method at all). A bundle never imports either directly --
only through `flask_core.get_bundle_dal()` -- so the real contract this
spike had to reproduce is the **pydal-flavored attribute/query-builder
surface `AsyncDAL.__getattr__` exposes**, not `penguin_dal`'s own surface.
The authoritative reference for that surface turned out to be
`core/svc_process/tests/test_bundles_social_alias_process.py::_FakeDal` --
an existing, already-shipped test double for exactly this bundle -- used
directly as the facade's spec (see Sec 5).

---

## 4. WIT world

`wit/world.wit` (validated with `wasm-tools component wit`):

```wit
package waddle:bundle@0.0.1-spike;

world stage {
    export transform: func(event: string) -> option<string>;
    import db-execute: func(sql: string, params: string) -> string;
    import context-get: func() -> string;
    import log: func(level: string, msg: string);
}
```

**Build-time execution: NO.** `waddle_sdk/_buildtime_marker.py` writes to a
file named by `SPIKE_BUILDTIME_MARKER_PATH` on import; `app_entry.py`
imports it at module top level. Three consecutive builds with that env var
set to a path under `evidence/` produced **zero** marker-file writes --
componentize-py's dependency discovery is static (AST/bytecode-level), not
"import and observe" on the build host.

**Import that failed (dependency discovery gap, not a native-extension
issue):** `ModuleNotFoundError: No module named 'bundles.bot_process'` at
guest **runtime** (not build time), even though `bundles/bot_process.py`
sits right next to the successfully-embedded `social_alias_process.py` on
the same `-p` python-path. Root cause: componentize-py's dependency-closure
walk only follows **statically visible, module-level** import edges from
the entry app module (`app_entry.py` -> `bundles.social_alias_process` ->
whatever `social_alias_process.py` imports at ITS OWN module level).
`_known_commands()`'s `from bundles.bot_process import ...` is a
**function-local, deliberately deferred** import (the bundle's own
docstring: avoids a circular import, since the real `bot_process.py`
imports `social_alias_process` back) -- invisible to that walk. Fix
(harness-only, `social_alias_process.py` untouched): add
`import bundles.bot_process` as a plain top-level statement in
`app_entry.py` to force embedding. **This generalizes**: a real bundle host
componentizing arbitrary "unchanged" bundles cannot rely on
`componentize-py`'s own dependency discovery for any bundle using deferred
or `try/except`-guarded imports (this bundle uses two) -- it would need to
walk the bundle's own installed directory and force-import every module in
it before invoking `componentize`.

**Component size:** 21,618,181 bytes (21 MB) for one bundle with 3 trivial
imports and 1 export -- dominated by the embedded CPython interpreter +
stdlib, not application code (`waddle_sdk` itself is ~200 KB of source).

**Build time:** 3.4s / 3.6s / 3.9s wall across three consecutive rebuilds
(same container, warm pip cache, cold `componentize-py` invocation each
time).

**WASI surface actually required -- bigger than the world we wrote.** Our
world declares 3 custom imports and 0 WASI interfaces. `wasm-tools
component wit` on the compiled output shows the component actually needs
the **full WASI Preview 2 surface** regardless -- `wasi:io/poll`,
`wasi:clocks/*`, `wasi:random/random`, `wasi:cli/*` (stdio, environment,
exit, terminal), `wasi:filesystem/*`, and the **entire `wasi:sockets/*`
family** (network, instance-network, udp, udp-create-socket, tcp,
tcp-create-socket, ip-name-lookup) -- because componentize-py's embedded
CPython runtime references them internally, independent of what the guest
app actually uses. A bundle host granting only the 3 declared imports would
need `wasmtime`'s `add_wasip2()` (or equivalent) regardless; the socket
imports in particular are worth flagging to a security reviewer even though
this bundle never dials out -- see Sec 7.

---

## 5. The `waddle_sdk` shim

```
waddle_sdk/
  app_entry.py             # componentize-py app module (WitWorld class); NOT part of the bundle
  _poll_loop.py             # trimmed copy of componentize-py's own example event loop
  _buildtime_marker.py      # import-time proof probe (Sec 4)
  bundles/
    __init__.py
    social_alias_process.py  # byte-for-byte copy, sha256 verified (Sec 3)
    bot_process.py            # STUB, not a copy -- see its own docstring
  flask_core/
    __init__.py
    stream_pipeline.py        # PlatformEvent only (field-for-field copy of the real dataclass)
    bundle_runtime.py         # BundleContext + get_bundle_dal/get_bundle_context + contextvar (near-verbatim, pure stdlib)
    feature_flags.py          # feature_enabled() -> always `default` (documented real degrade path, no PostHog reachable)
    database.py               # WasmDAL -- the actual penguin-dal-compatible facade
```

**What `WasmDAL` (in `database.py`) reproduces**, built directly against
`_FakeDal`/`_FakeTable`/`_FakeColumn`/`_FakeQuery`/`_FakeRows` (the existing
test double for this exact bundle -- the authoritative reference, not the
`penguin_dal` PyPI package, per Sec 3's finding):

| Feature | Reproduced? | Notes |
|---|---|---|
| Attribute-style field access (`dal.command_aliases.alias`) | Yes | `_Table.__getattr__` -> `_Field` |
| `==`, `!=`, `is_null()` -> combinable query | Yes | `_Field`/`_Query`, `&`/`\|` |
| `.select(query)` -> `Rows` (`.first()`, iterable, dict+attr row access) | Yes | Builds `SELECT * FROM t WHERE ...`, one `db-execute` call |
| `.update(query, **fields)` | Yes | Builds `UPDATE t SET ... WHERE ...` |
| `.insert_async(table, **fields)` | Yes | Builds `INSERT INTO t (...) VALUES (...)` |
| Raw `.execute(sql, params)` with `$1/$2/...` | Yes | Direct passthrough to `db-execute`; mirrors the real `AsyncDAL.execute`'s own UUID->str / dict,list->JSON param coercion |
| `belongs`/`like`/`ilike`/sort/pagination/joins/`count`/transactions/`define_table` | **No** | This bundle never calls them -- out of scope, not attempted |
| Async (PyDAL's own thread-pool-backed sync calls wrapped by `asyncio.to_thread`) | **No -- this is the core blocker** | See Sec 6 |

Host-side, no-WASM sanity check of the facade's SQL generation (isolates
"is the facade correct" from "does `to_thread` work") --
`evidence/facade_sql_check.py`, all 4 assertions pass:
```
PASS select (AND + is_null): SELECT * FROM command_aliases WHERE ((command_aliases.community_id = $1) AND (command_aliases.alias = $2)) AND (command_aliases.deleted_at IS NULL) [42, 'bar']
PASS update: UPDATE command_aliases SET deleted_at = $1 WHERE command_aliases.id = $2 ['2026-09-14T00:00:00+00:00', 7]
PASS insert_async: INSERT INTO command_aliases (community_id, alias, target_command, created_by) VALUES ($1, $2, $3, $4) [42, 'foo', 'ping', 'penguin']
PASS execute (raw SQL passthrough): SELECT role FROM community_members WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3 LIMIT 1 [42, 'discord', 'u-1']
```

---

## 6. Running under `wasmtime` (the `asyncio` blocker, in detail)

Host: `host/run_component.py`, a small Python program using `wasmtime-py`'s
**component API** (`wasmtime.component.{Engine,Linker,Component,Store}`) --
`wasmtime run` alone cannot satisfy custom (non-WASI-standard) imports like
`db-execute`, so a real host program is required, exactly as the task
anticipated. Fakes `db-execute`/`context-get`/`log`, logs every call, and
sends the two `PlatformEvent`s specified.

**Blocker #1 (fatal to the naive approach): `asyncio.run()` cannot even
start.**
```
File "/python/asyncio/unix_events.py", ... _make_self_pipe
File "/python/socket.py", line 619, in _fallback_socketpair
PermissionError: [Errno 2] Permission denied
```
`asyncio.run()`'s default `SelectorEventLoop` needs a self-pipe (a
`socket.socketpair()`) for its wakeup mechanism; this sandbox's WASI
sockets refuse it. **Fix:** componentize-py ships its own
`asyncio.AbstractEventLoop` subclass (`poll_loop.PollLoop`, found in every
`componentize-py bindings` output -- official, documented pattern for
`wasi:http`-style async code) that avoids the self-pipe entirely. Trimmed
copy in `waddle_sdk/_poll_loop.py` (`wasi:http`-specific helpers removed,
kept only the loop itself), used via `asyncio.set_event_loop(PollLoop());
loop.run_until_complete(coro)` instead of `asyncio.run(coro)`.

**Blocker #2 (fatal to `asyncio.to_thread`, and it is load-bearing):**
`PollLoop.run_in_executor` is `raise NotImplementedError` **in
componentize-py's own upstream copy** -- confirmed by inspecting the
installed package source, not just our trimmed copy -- because there is no
real OS thread pool to hand blocking work to inside this sandbox.
`asyncio.to_thread()` (Python stdlib) calls exactly this method. This
bundle wraps **every** `select()`/`update()`/`insert_async()` call site
(`_lookup_alias`, `_upsert_alias`, `_soft_delete_alias`, `_list_aliases`)
in `asyncio.to_thread(...)` -- the standard pattern `flask_core.database
.AsyncDAL`'s own docs recommend for keeping PyDAL's blocking calls off the
event loop. None of those four helpers can execute inside this sandbox as
built.

**Observed behavior is graceful, not a crash -- with one exception.** The
write-path helpers are called inside `_cmd_set_alias`'s own
`try/except Exception as exc: return f"Failed to set alias: {exc}"` -- so
the `NotImplementedError` becomes a normal, well-formed chat reply, not a
trap. By contrast, `_known_commands()` (Sec 4's `bundles.bot_process` gap)
is called **outside** any try/except, so *that* failure mode traps the
whole `wasmtime` store (`wasm trap: unreachable`) rather than degrading --
the blast radius differs by nothing more than which line inside the SAME
unmodified bundle happens to run afoul of the sandbox, which matters a lot
for a bundle host's isolation design (one bad statement placement is the
difference between "one bad reply" and "the whole instance is dead").

### Two required test events, actual results

| Event | `db-execute` calls | Result | Elapsed |
|---|---|---|---|
| `!alias add foo bar` | 1: `SELECT role FROM community_members WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3 LIMIT 1` params `[42, "discord", "u-1"]` -> host answers `[{"role":"admin"}]` (permission check passes) | `"Failed to set alias: run_in_executor (and therefore asyncio.to_thread) is not supported: no real OS threads are available inside componentize-py's WASI sandbox"` (bundle's own caught-exception reply; never reaches `_lookup_alias`'s actual DB read) | 2.2-3.7 ms (3 runs) |
| `!alias foo` | 0 (positional form with no expansion text short-circuits to usage before any DB call -- real bundle behavior, not a spike simplification) | `"Usage: !alias <name> <command> [options] \| !alias add <name> <command> \| !alias list \| !alias delete <name> \| !unalias <name>"` | 0.25-0.46 ms (3 runs) |

Full JSON in `evidence/run_results.json`. Whole-process wall time
(container start + component load/instantiate + both calls): **2.8s** --
dominated by cold-loading the 21 MB component and starting the embedded
CPython, not by per-call `transform()` cost.

---

## 7. Blockers, summarized

| # | Blocker | Severity | Where it bites |
|---|---|---|---|
| 1 | `asyncio.to_thread()` (-> `run_in_executor`) unimplemented -- no real OS threads in this sandbox | **Hard, structural** | Every synchronous DB call this bundle (and, per `database.py`'s own docstring, every PyDAL-backed bundle in the repo) makes goes through this pattern |
| 2 | `asyncio.run()`'s default event loop cannot start (`socket.socketpair()` denied) | Workaroundable | Fixed by swapping in componentize-py's own `PollLoop`, but that same loop is what surfaces Blocker 1 |
| 3 | Deferred/`try-except`-guarded cross-module imports invisible to componentize-py's dependency discovery | Workaroundable per-bundle, but must be automated for a real host | `_known_commands()` (this bundle), and by extension any bundle using the same lazy-import pattern the codebase already uses elsewhere |
| 4 | Component requires the full WASI Preview 2 surface (including all of `wasi:sockets/*`) regardless of the declared world | Needs security review, not a build blocker | Every componentize-py component, not specific to this bundle |
| 5 | 21 MB component for one bundle with trivial logic | Operational (cold-start/pooling), not correctness | CPython + stdlib embed dominates size; would need instance pooling in a real host |
| 6 | `penguin_dal` (PyPI) is NOT what a bundle actually calls through -- `flask_core.database.AsyncDAL` wraps upstream `pydal` | Documentation/framing correction | Any future SDK work should target the pydal-flavored surface (`_FakeDal`), not `penguin_dal`'s SQLAlchemy-Core-backed one |

---

## 8. What a real SDK must implement beyond this spike

- **A working async story.** Either (a) rewrite affected bundles to stop
  using `asyncio.to_thread` for DB calls (bundles would no longer be
  "byte-for-byte unchanged" -- contradicts this spike's own premise for any
  bundle using the pattern), or (b) get real threading support into the
  WASM target (`wasm32-wasip1-threads` / a future WASI threads proposal,
  if/when componentize-py supports it), or (c) make the facade's
  `select`/`update`/`insert_async` themselves `async def` and have the SDK
  patch/monkeypatch `AsyncDAL`'s `to_thread` call sites at the shim layer
  instead of inside the query builder -- technically possible ONLY because
  `get_bundle_dal()` is the sole indirection point, but it means the shim
  must intercept the `asyncio.to_thread(closure)` call itself, not just
  what's inside the closure, which `to_thread` provides no hook for. None
  of these are in scope for a spike.
- **A dependency-closure prepass**, not reliance on `componentize-py`'s own
  discovery: walk every `.py` file in the bundle's installed directory
  (`ingest`/`process`/`action` bundle trees ship as a container image
  layer today) and statically pre-import each one before invoking
  `componentize`, so deferred/dynamic imports (this repo already has at
  least two in one file) don't produce runtime `ModuleNotFoundError`s that
  the discovery step should have caught at build time.
- **Full PII/secret sanitization at the WIT boundary** -- this spike's fake
  host trivially logs raw SQL+params; a real `db-execute` implementation
  needs the same auto-sanitization `penguin-utils` logging provides (see
  `critical-rules.md` Observability), since every parameter value now
  crosses a serialization boundary (JSON) that plaintext logging can
  trivially capture.
- **A pooled/warm instantiation story** given the ~2.8s cold path and 21 MB
  component size observed here -- a per-event cold `Component`/`Store`
  would be far too slow for the latency SLA this repo targets elsewhere
  (input-to-response ~3s for text; a cold WASM instantiate alone eats most
  of that budget).
- **Full pydal-surface coverage** beyond this one bundle's needs
  (`belongs`, `like`/`ilike`, sorting, pagination, joins, `count`,
  `define_table`, transactions) -- untouched here because this specific
  bundle never calls them, not because they're known to work.
- **Resolve the WASI-sockets-by-default question** with a security
  reviewer before this pattern goes anywhere near production -- a bundle
  host granting the full `wasi:sockets` surface to every component "because
  CPython needs it internally" undermines the sandboxing story a bundle
  host exists to provide in the first place.

---

## 9. Evidence files

| File | What it is |
|---|---|
| `wit/world.wit` | The WIT world, `wasm-tools`-validated |
| `waddle_sdk/` | The shim + harness (`app_entry.py`, `_poll_loop.py`, `_buildtime_marker.py`, `flask_core/*`, `bundles/*`) |
| `bundle/social_alias_process.py` | Pristine reference copy (sha256-verified against the repo original) |
| `evidence/component_wit.txt` | `wasm-tools component wit` output on the compiled `bundle.wasm` |
| `evidence/run_results.json` | Full JSON results of both test events (db-execute calls, replies, timing) |
| `evidence/facade_sql_check.py` | Host-side (no WASM) proof the query builder generates correct SQL/params |
| `host/run_component.py` | The wasmtime-py component-API host used to run `bundle.wasm` |
| `bindings_preview/wit_world/__init__.py` | componentize-py's generated Python bindings for our world (shows the `WitWorld` Protocol + free import functions) |
| `evidence/bundle.wasm` | The compiled component (21.6 MB; **gitignored**, rebuild via Sec 2's command) |

Reproduce end-to-end:
```bash
# 1. build (from spikes/penguin-dal-wasm/)
docker run --rm -u 1000:1000 -v "$PWD":/work -w /work \
  python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285 \
  bash -lc "python3 -m venv .venv && .venv/bin/pip install -q componentize-py==0.25.1 wasmtime==48.0.0 && \
            .venv/bin/componentize-py -d wit -w stage componentize -p waddle_sdk app_entry -o evidence/bundle.wasm"

# 2. run
docker run --rm -u 1000:1000 -v "$PWD":/work -w /work \
  python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285 \
  /work/.venv/bin/python3 /work/host/run_component.py /work/evidence/bundle.wasm
```
