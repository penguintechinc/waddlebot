"""Round 2: load a precompiled `.cwasm` component (produced via `wasmtime compile`,
CLI) with the `wasmtime` PyPI package's `Component.deserialize_file`, and time
it against a cold `Component.from_file` (recompile-each-time, Round 1's path).
Then run both required test events once to confirm it still works, and time
per-call latency warm.
"""

from __future__ import annotations

import json
import sys
import time

from wasmtime import Engine, Store, WasiConfig
from wasmtime.component import Component, Linker

WASM_PATH = sys.argv[1]
CWASM_PATH = sys.argv[2]


def db_execute(store, sql: str, params: str) -> str:  # noqa: ANN001
    parsed = json.loads(params)
    if "community_members" in sql and "role" in sql:
        return json.dumps([{"role": "admin"}])
    if sql.startswith("SELECT") and "command_aliases" in sql:
        alias_name = parsed[1] if len(parsed) > 1 else None
        if alias_name == "bar":
            return json.dumps(
                [{"id": 7, "community_id": parsed[0], "alias": "bar",
                  "target_command": "ping", "deleted_at": None, "created_by": "penguin"}]
            )
        return json.dumps([])
    if sql.startswith("INSERT INTO command_aliases") or sql.startswith("UPDATE command_aliases"):
        return json.dumps([])
    raise RuntimeError(f"no canned answer for sql={sql!r}")


def context_get(store) -> str:  # noqa: ANN001
    return json.dumps({"tenant": "acme", "community": "42", "app_id": "waddles.social.alias.default"})


def log(store, level: str, msg: str) -> None:  # noqa: ANN001
    print(f"[guest log] {level}: {msg}", file=sys.stderr)


def build_linker(engine):
    linker = Linker(engine)
    linker.add_wasip2()
    with linker.root() as root:
        root.add_func("db-execute", db_execute)
        root.add_func("context-get", context_get)
        root.add_func("log", log)
    return linker


def new_store(engine):
    store = Store(engine)
    wasi = WasiConfig()
    wasi.inherit_stdout()
    wasi.inherit_stderr()
    wasi.inherit_env()
    store.set_wasi(wasi)
    return store


def run_two_events(engine, component, label):
    linker = build_linker(engine)
    store = new_store(engine)
    instance = linker.instantiate(store, component)
    transform = instance.get_func(store, "transform")
    assert transform is not None

    events = [
        {"platform": "discord", "event_type": "message", "actor": "penguin",
         "payload": {"text": "!alias add foo bar", "channel_id": "chan-123", "author_id": "u-1"},
         "occurred_at": "2026-09-14T00:00:00+00:00"},
        {"platform": "discord", "event_type": "message", "actor": "penguin",
         "payload": {"text": "!alias foo", "channel_id": "chan-123", "author_id": "u-1"},
         "occurred_at": "2026-09-14T00:00:05+00:00"},
    ]
    for event in events:
        start = time.perf_counter()
        result = transform(store, json.dumps(event))
        elapsed_ms = (time.perf_counter() - start) * 1000
        print(f"[{label}] {event['payload']['text']!r} -> {result!r} ({elapsed_ms:.3f} ms)")


def main() -> None:
    engine = Engine()

    print("--- cold path: Component.from_file (recompile every time, Round 1's path) ---")
    t0 = time.perf_counter()
    component_cold = Component.from_file(engine, WASM_PATH)
    load_ms_cold = (time.perf_counter() - t0) * 1000
    print(f"Component.from_file load time: {load_ms_cold:.1f} ms")
    run_two_events(engine, component_cold, "from_file")

    print("\n--- precompiled path: Component.deserialize_file (wasmtime-compiled .cwasm) ---")
    t0 = time.perf_counter()
    component_precompiled = Component.deserialize_file(engine, CWASM_PATH)
    load_ms_precompiled = (time.perf_counter() - t0) * 1000
    print(f"Component.deserialize_file load time: {load_ms_precompiled:.1f} ms")
    run_two_events(engine, component_precompiled, "deserialize_file")

    print(f"\nSUMMARY: from_file={load_ms_cold:.1f}ms  deserialize_file={load_ms_precompiled:.1f}ms  speedup={load_ms_cold / load_ms_precompiled:.1f}x")


if __name__ == "__main__":
    main()
