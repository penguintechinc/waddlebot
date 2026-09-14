"""The penguin-dal-compatible facade -- `get_bundle_dal()` returns a `WasmDAL`.

Built directly against `core/svc_process/tests/test_bundles_social_alias_process
.py::_FakeDal`/`_FakeTable`/`_FakeColumn`/`_FakeQuery`/`_FakeRows` -- the
existing, already-shipped test double for exactly this bundle -- because
that fake, not the real `penguin_dal` PyPI package, is what actually
documents the attribute/query-builder surface `social_alias_process.py`
depends on. (Finding, see REPORT.md: the real `flask_core.database.AsyncDAL`
wraps upstream `pydal` -- `from pydal import DAL, Field` -- not the separate
in-house `penguin_dal` package; a bundle only ever touches either through
`flask_core.get_bundle_dal()`, never a direct import, so this facade
reproduces the pydal-flavored surface the test fake encodes.)

What's reproduced: attribute-style field access (`dal.command_aliases
.alias`), `==`/`is_null()`/`&` producing a combinable query object,
`.select(query)` -> `Rows` (`.first()`, iterable), `.update(query,
**fields)`, `.insert_async(table, **fields)`, and raw `.execute(sql,
params)` with `$1/$2/...` placeholders (mirrors
`flask_core.database.AsyncDAL.execute`'s own param-coercion: UUID -> str,
dict/list -> JSON). What's NOT reproduced, because this bundle never
touches it: `belongs`/`like`/`ilike`/sorting/pagination/joins/`count`/
transactions/schema definition (`define_table`) -- the full SQLAlchemy
Core engine the real `penguin_dal.field_proxy.FieldProxy` sits on top of.

Every statement crosses the component boundary through exactly one WIT
import, `db-execute(sql, params_json) -> rows_json` -- the query builder
below runs entirely in guest Python; only the final (sql, params) tuple
and the returned rows cross the host/guest boundary.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any
from uuid import UUID


def _coerce_param(value: Any) -> Any:
    """Mirror `flask_core.database.AsyncDAL.execute`'s own param conversion.

    The real method converts `UUID` -> `str` and `dict`/`list` -> a JSON
    string before handing parameters to psycopg2; datetimes are added here
    since `_soft_delete_alias` passes `datetime.now(UTC)` directly and JSON
    can't encode a raw `datetime`.
    """
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


class _Field:
    """One `table.column` reference -- `dal.command_aliases.alias` etc."""

    __slots__ = ("_table", "_name")

    def __init__(self, table: str, name: str) -> None:
        self._table = table
        self._name = name

    def __eq__(self, other: Any) -> "_Query":  # type: ignore[override]
        if other is None:
            return _Query(f"{self._table}.{self._name} IS NULL", [], self._table)
        return _Query(f"{self._table}.{self._name} = \0", [other], self._table)

    def __ne__(self, other: Any) -> "_Query":  # type: ignore[override]
        if other is None:
            return _Query(f"{self._table}.{self._name} IS NOT NULL", [], self._table)
        return _Query(f"{self._table}.{self._name} != \0", [other], self._table)

    def is_null(self) -> "_Query":
        return _Query(f"{self._table}.{self._name} IS NULL", [], self._table)

    def __repr__(self) -> str:
        return f"_Field({self._table}.{self._name})"


class _Query:
    """A combinable WHERE-clause fragment. `\\0` marks one `$N` placeholder slot."""

    __slots__ = ("sql", "params", "table")

    def __init__(self, sql: str, params: list[Any], table: str) -> None:
        self.sql = sql
        self.params = list(params)
        self.table = table

    def __and__(self, other: "_Query") -> "_Query":
        return _Query(f"({self.sql}) AND ({other.sql})", self.params + other.params, self.table)

    def __or__(self, other: "_Query") -> "_Query":
        return _Query(f"({self.sql}) OR ({other.sql})", self.params + other.params, self.table)

    def render(self, start: int = 1) -> tuple[str, int]:
        """Replace each `\\0` left-to-right with `$N` starting at `start`."""
        idx = start
        pieces = self.sql.split("\0")
        rendered = pieces[0]
        for piece in pieces[1:]:
            rendered += f"${idx}{piece}"
            idx += 1
        return rendered, idx

    def __repr__(self) -> str:
        return f"_Query({self.sql!r}, params={self.params!r})"


class _Table:
    """`dal.command_aliases` -- attribute access yields a `_Field` for any column name."""

    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    def __getattr__(self, name: str) -> _Field:
        if name.startswith("_"):
            raise AttributeError(name)
        return _Field(self._name, name)

    def __repr__(self) -> str:
        return f"_Table({self._name})"


class _Row:
    """One result row -- dict AND attribute access, matching the real `Row`/`_FakeRow`."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def __getitem__(self, key: str) -> Any:
        return self._data[key]

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            return self._data[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __repr__(self) -> str:
        return f"_Row({self._data!r})"


class _Rows:
    """A result set -- truthy/iterable/`.first()`, matching the real `Rows`/`_FakeRows`."""

    def __init__(self, rows: list[_Row]) -> None:
        self.rows = rows

    def __bool__(self) -> bool:
        return bool(self.rows)

    def __iter__(self):
        return iter(self.rows)

    def first(self) -> _Row | None:
        return self.rows[0] if self.rows else None


class WasmDAL:
    """`get_bundle_dal()`'s return value -- see module docstring for scope."""

    def __init__(self) -> None:
        self.command_aliases = _Table("command_aliases")

    def _cross(self, sql: str, params: list[Any]) -> list[dict[str, Any]]:
        """The one place every statement crosses the WIT `db-execute` import."""
        from wit_world import db_execute  # generated binding -- only resolvable in-component

        coerced = [_coerce_param(p) for p in params]
        raw = db_execute(sql, json.dumps(coerced))
        result: list[dict[str, Any]] = json.loads(raw)
        return result

    def select(self, query: _Query) -> _Rows:
        """`dal.select(query)` -- pydal's synchronous, table-attribute-scoped select."""
        where_sql, _next = query.render(1)
        sql = f"SELECT * FROM {query.table} WHERE {where_sql}"
        rows = self._cross(sql, query.params)
        return _Rows([_Row(r) for r in rows])

    def update(self, query: _Query, **fields: Any) -> Any:
        """`dal.update(query, **fields)` -- pydal's synchronous update-by-query."""
        set_cols = list(fields.keys())
        set_clause = ", ".join(f"{col} = ${i + 1}" for i, col in enumerate(set_cols))
        where_sql, _next = query.render(len(set_cols) + 1)
        sql = f"UPDATE {query.table} SET {set_clause} WHERE {where_sql}"
        params = [fields[c] for c in set_cols] + query.params
        return self._cross(sql, params)

    def insert_async(self, table: _Table, **fields: Any) -> Any:
        """`dal.insert_async(table, **fields)` -- called synchronously by this bundle
        (inside its own `asyncio.to_thread` closure), matching the test fake's shape.
        """
        cols = list(fields.keys())
        col_list = ", ".join(cols)
        placeholders = ", ".join(f"${i + 1}" for i in range(len(cols)))
        sql = f"INSERT INTO {table.name} ({col_list}) VALUES ({placeholders})"
        params = [fields[c] for c in cols]
        return self._cross(sql, params)

    async def execute(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        """`await dal.execute(sql, params)` -- raw SQL, `$1/$2/...` already in `sql`."""
        return self._cross(sql, list(params) if params else [])
