"""Tiny Python host (wasmtime-py's component API) that fakes the WIT imports
and drives the compiled `bundle.wasm`'s `transform` export with two
`PlatformEvent`s, per the spike task: `!alias add foo bar` and `!alias foo`.

Host imports:
  - `db-execute(sql, params_json) -> rows_json` -- logs every call, answers
    from a small canned table keyed on substrings of `sql`/`params` (a real
    host would be a Rust `penguin-bundle-host` talking to the real DB).
  - `context-get() -> json` -- fixed BundleContext (tenant=acme,
    community=42 [a numeric string, since `community_id = int(ctx.community)`],
    app_id=waddles.social.alias.default).
  - `log(level, msg)` -- printed to stderr, prefixed `[guest log]`.

Not a production host -- a feasibility-spike fake, per the task.
"""

from __future__ import annotations

import json
import sys
import time

from wasmtime import Engine, Store, WasiConfig
from wasmtime.component import Component, Linker

WASM_PATH = sys.argv[1] if len(sys.argv) > 1 else "evidence/bundle.wasm"

CALL_LOG: list[dict[str, object]] = []


def db_execute(store, sql: str, params: str) -> str:  # noqa: ANN001 - wasmtime callback shape
    parsed_params = json.loads(params)
    CALL_LOG.append({"sql": sql, "params": parsed_params})
    print(f"[host] db-execute sql={sql!r} params={parsed_params!r}", file=sys.stderr)

    # -- community_members.role lookup (_caller_is_moderator_or_admin) --
    if "community_members" in sql and "role" in sql:
        # Both the platform_user_id and display_name variants land here;
        # always answer "admin" so the spike's write path proceeds.
        return json.dumps([{"role": "admin"}])

    # -- command_aliases SELECT (query-builder path: _lookup_alias / the
    #    existing-row check inside _upsert_alias) --
    if sql.startswith("SELECT") and "command_aliases" in sql:
        # params[-1] is always the alias name being looked up in this bundle's
        # two call shapes (community_id, alias) or (community_id, alias, ...).
        alias_name = parsed_params[1] if len(parsed_params) > 1 else None
        if alias_name == "bar":
            # Pretend "bar" is itself a pre-existing alias -> exercises the
            # "flatten an alias-of-an-alias" branch in _cmd_set_alias.
            return json.dumps(
                [{"id": 7, "community_id": parsed_params[0], "alias": "bar",
                  "target_command": "ping", "deleted_at": None, "created_by": "penguin"}]
            )
        # "foo" (the new alias being set) has no existing row -> INSERT path.
        return json.dumps([])

    # -- command_aliases INSERT/UPDATE (query-builder path) --
    if sql.startswith("INSERT INTO command_aliases") or sql.startswith("UPDATE command_aliases"):
        return json.dumps([])

    # Unhandled shape -- fail loudly rather than silently return [].
    raise RuntimeError(f"fake host db-execute: no canned answer for sql={sql!r}")


def context_get(store) -> str:  # noqa: ANN001
    return json.dumps({"tenant": "acme", "community": "42", "app_id": "waddles.social.alias.default"})


def log(store, level: str, msg: str) -> None:  # noqa: ANN001
    print(f"[guest log] {level}: {msg}", file=sys.stderr)


def main() -> None:
    engine = Engine()
    linker = Linker(engine)
    linker.add_wasip2()

    with linker.root() as root:
        root.add_func("db-execute", db_execute)
        root.add_func("context-get", context_get)
        root.add_func("log", log)

    component = Component.from_file(engine, WASM_PATH)

    store = Store(engine)
    wasi = WasiConfig()
    wasi.inherit_stdout()
    wasi.inherit_stderr()
    wasi.inherit_env()
    store.set_wasi(wasi)

    instance = linker.instantiate(store, component)
    transform = instance.get_func(store, "transform")
    assert transform is not None, "transform export not found"

    events = {
        "alias_add": {
            "platform": "discord",
            "event_type": "message",
            "actor": "penguin",
            "payload": {"text": "!alias add foo bar", "channel_id": "chan-123", "author_id": "u-1"},
            "occurred_at": "2026-09-14T00:00:00+00:00",
        },
        "alias_bare": {
            "platform": "discord",
            "event_type": "message",
            "actor": "penguin",
            "payload": {"text": "!alias foo", "channel_id": "chan-123", "author_id": "u-1"},
            "occurred_at": "2026-09-14T00:00:05+00:00",
        },
    }

    results = {}
    for label, event in events.items():
        CALL_LOG.clear()
        start = time.perf_counter()
        result = transform(store, json.dumps(event))
        elapsed_ms = (time.perf_counter() - start) * 1000
        results[label] = {
            "input_text": event["payload"]["text"],
            "result": json.loads(result) if result is not None else None,
            "db_execute_calls": list(CALL_LOG),
            "elapsed_ms": round(elapsed_ms, 3),
        }
        print(f"\n=== {label} ({elapsed_ms:.3f} ms) ===")
        print("input:", event["payload"]["text"])
        print("db-execute calls:", len(CALL_LOG))
        print("result:", result)

    with open("evidence/run_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)


if __name__ == "__main__":
    main()
