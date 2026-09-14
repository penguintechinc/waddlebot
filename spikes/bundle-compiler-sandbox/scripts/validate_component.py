#!/usr/bin/env python3
"""Q2 install-time validator for a prebuilt WASI 0.2 component.

Mechanically checks a third-party-supplied component against
`waddle:bundle/stage@0.0.1-spike` using only `wasm-tools` (no execution of
guest code): (a) it must declare our `host` interface -- the marker that it
was built against our world's imports -- and export `transform`; (b) every
import it declares is enumerated; (c) any import outside an explicit
allowlist (our own world's imports, plus a small set of permitted baseline
WASI interfaces) fails the install.

This is the install-flow's "does it target our world, and what does it ask
for" gate: it parses `wasm-tools component wit <file>` text output rather
than re-implementing a WIT resolver, which keeps the check simple and
auditable at the cost of being a text scrape, not a semantic API -- see
REPORT.md for why `wasm-tools component targets` was not used as the sole
mechanism (it requires the *entire* transitive WASI closure spelled out in
the target world file, which turns it into a maintenance burden unsuited to
a per-import allowlist; it is still demonstrated separately in REPORT.md).
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys

OUR_PACKAGE = "waddle:bundle"
OUR_WORLD_VERSION = "0.0.1-spike"
OUR_INTERFACE = f"{OUR_PACKAGE}/host@{OUR_WORLD_VERSION}"
REQUIRED_EXPORT = "transform"

# Baseline WASI interfaces permitted for every bundle, independent of what
# the bundle's own world declares. Namespace-prefix match on "wasi:<ns>/".
PERMITTED_WASI_NAMESPACES = {"wasi:clocks", "wasi:random", "wasi:io"}

IMPORT_LINE_RE = re.compile(r"^\s*import\s+([A-Za-z0-9_:./@-]+)\s*;\s*$")
EXPORT_LINE_RE = re.compile(r"^\s*export\s+([A-Za-z0-9_:./@-]+)\s*:")
WORLD_OPEN_RE = re.compile(r"^\s*world\s+\S+\s*\{\s*$")


class ValidationError(Exception):
    """Raised with a human-readable, install-flow-ready rejection reason."""


def run_wasm_tools_wit(component_path: str) -> str:
    """Invoke `wasm-tools component wit <file>` and return its stdout.

    Raises ValidationError with wasm-tools' own stderr if the file is not a
    valid component at all (e.g. not WebAssembly, or a core module rather
    than a component) -- this is the first, cheapest rejection point.
    """
    try:
        proc = subprocess.run(
            ["wasm-tools", "component", "wit", component_path],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise ValidationError(f"wasm-tools not found on PATH: {exc}") from exc
    if proc.returncode != 0:
        raise ValidationError(
            f"not a valid WASI 0.2 component (wasm-tools rejected it):\n{proc.stderr.strip()}"
        )
    return proc.stdout


def parse_top_world(wit_text: str) -> tuple[list[str], list[str]]:
    """Extract (imports, exports) from the FIRST `world { ... }` block only.

    `wasm-tools component wit` prints the component's own top-level world
    first, then the transitively-used package/interface definitions after
    it (which never contain their own `import`/`export` statements at this
    parser's indentation, but we still bound the scan to be safe).
    """
    lines = wit_text.splitlines()
    imports: list[str] = []
    exports: list[str] = []
    depth = 0
    in_world = False
    for line in lines:
        if not in_world:
            if WORLD_OPEN_RE.match(line):
                in_world = True
                depth = 1
            continue
        depth += line.count("{") - line.count("}")
        m = IMPORT_LINE_RE.match(line)
        if m:
            imports.append(m.group(1))
            continue
        m = EXPORT_LINE_RE.match(line)
        if m:
            exports.append(m.group(1))
        if depth <= 0:
            break
    return imports, exports


def is_permitted(import_name: str, permitted_namespaces: set[str]) -> bool:
    """An import is permitted iff it is our own interface or a baseline WASI
    interface from the permitted namespace set (checked by exact
    `wasi:<namespace>/` prefix, not substring, so e.g. `wasi:sockets` never
    matches `wasi:io`)."""
    if import_name == OUR_INTERFACE:
        return True
    if ":" not in import_name or "/" not in import_name:
        return False
    namespace_pkg = import_name.split("/", 1)[0]  # e.g. "wasi:clocks@0.2.9" -> strip version
    namespace_pkg = namespace_pkg.split("@", 1)[0]
    return namespace_pkg in permitted_namespaces


def validate(component_path: str, permitted_namespaces: set[str]) -> dict:
    """Run the full a/b/c check. Returns a result dict on success; raises
    ValidationError (with the exact rejection reason) on failure."""
    wit_text = run_wasm_tools_wit(component_path)
    imports, exports = parse_top_world(wit_text)

    # (a) targets our world: must declare our host interface AND export transform.
    if OUR_INTERFACE not in imports:
        raise ValidationError(
            f"does not target {OUR_PACKAGE}/stage@{OUR_WORLD_VERSION}: "
            f"missing import of `{OUR_INTERFACE}` "
            f"(found imports: {', '.join(imports) or '(none)'})"
        )
    if REQUIRED_EXPORT not in exports:
        raise ValidationError(
            f"does not target {OUR_PACKAGE}/stage@{OUR_WORLD_VERSION}: "
            f"missing required export `{REQUIRED_EXPORT}` "
            f"(found exports: {', '.join(exports) or '(none)'})"
        )

    # (c) allowlist enforcement over every OTHER declared import.
    disallowed = [i for i in imports if not is_permitted(i, permitted_namespaces)]
    if disallowed:
        raise ValidationError(
            "imports outside the permitted allowlist "
            f"(our world's imports + {sorted(permitted_namespaces)}): "
            f"{', '.join(sorted(disallowed))}"
        )

    return {"imports": imports, "exports": exports}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", help="path to the .wasm component to validate")
    parser.add_argument(
        "--extra-wasi",
        action="append",
        default=[],
        metavar="wasi:namespace",
        help="additional permitted WASI namespace beyond the strict baseline "
        "(clocks/random/io) -- e.g. --extra-wasi wasi:cli --extra-wasi wasi:filesystem "
        "for the 'practical' allowlist variant discussed in REPORT.md",
    )
    args = parser.parse_args()
    permitted = set(PERMITTED_WASI_NAMESPACES) | set(args.extra_wasi)

    try:
        result = validate(args.component, permitted)
    except ValidationError as exc:
        print(f"REJECT {args.component}: {exc}")
        return 1

    print(f"ACCEPT {args.component}")
    print(f"  imports ({len(result['imports'])}): {', '.join(result['imports'])}")
    print(f"  exports ({len(result['exports'])}): {', '.join(result['exports'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
