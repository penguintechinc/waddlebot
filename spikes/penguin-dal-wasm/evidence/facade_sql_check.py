"""Host-side (no WASM) sanity check of `flask_core.database.WasmDAL`'s query
builder -- isolates whether the (sql, params) generation is correct on its
own, independent of the `asyncio.to_thread` blocker observed inside the
sandbox (see REPORT.md). Not a pytest suite -- a quick, throwaway spike
check, run directly with `python3`.
"""
import asyncio
import json
import sys
import types

# Stand in for the generated `wit_world` module (only resolvable inside a
# componentized guest) so `flask_core.database` imports cleanly here.
calls = []


def _fake_db_execute(sql, params_json):
    calls.append((sql, json.loads(params_json)))
    return json.dumps([])


fake_wit_world = types.ModuleType("wit_world")
fake_wit_world.db_execute = _fake_db_execute
sys.modules["wit_world"] = fake_wit_world

sys.path.insert(0, "waddle_sdk")
from flask_core.database import WasmDAL  # noqa: E402

dal = WasmDAL()

# 1. SELECT with AND + is_null() -- _lookup_alias's exact query shape.
q = (
    (dal.command_aliases.community_id == 42)
    & (dal.command_aliases.alias == "bar")
    & (dal.command_aliases.deleted_at.is_null())
)
dal.select(q)
sql, params = calls[-1]
assert sql == (
    "SELECT * FROM command_aliases WHERE "
    "((command_aliases.community_id = $1) AND (command_aliases.alias = $2)) "
    "AND (command_aliases.deleted_at IS NULL)"
), sql
assert params == [42, "bar"], params
print("PASS select (AND + is_null):", sql, params)

# 2. UPDATE -- _soft_delete_alias's exact shape (deleted_at set, id match).
q2 = dal.command_aliases.id == 7
dal.update(q2, deleted_at="2026-09-14T00:00:00+00:00")
sql2, params2 = calls[-1]
assert sql2 == "UPDATE command_aliases SET deleted_at = $1 WHERE command_aliases.id = $2", sql2
assert params2 == ["2026-09-14T00:00:00+00:00", 7], params2
print("PASS update:", sql2, params2)

# 3. INSERT -- _upsert_alias's exact shape.
dal.insert_async(
    dal.command_aliases,
    community_id=42,
    alias="foo",
    target_command="ping",
    created_by="penguin",
)
sql3, params3 = calls[-1]
assert sql3 == (
    "INSERT INTO command_aliases (community_id, alias, target_command, created_by) "
    "VALUES ($1, $2, $3, $4)"
), sql3
assert params3 == [42, "foo", "ping", "penguin"], params3
print("PASS insert_async:", sql3, params3)


# 4. raw execute() -- _caller_is_moderator_or_admin's exact shape (async).
async def _run_execute():
    return await dal.execute(
        "SELECT role FROM community_members WHERE community_id = $1 AND platform = $2 "
        "AND platform_user_id = $3 LIMIT 1",
        [42, "discord", "u-1"],
    )


asyncio.run(_run_execute())
sql4, params4 = calls[-1]
assert params4 == [42, "discord", "u-1"], params4
print("PASS execute (raw SQL passthrough):", sql4, params4)

print(f"\nAll {len(calls)} facade query-builder checks passed (host-side, no WASM).")
