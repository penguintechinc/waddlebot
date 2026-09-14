"""Trivial spike bundle for the `waddle:bundle/stage@0.0.1-spike` world.

Calls only `log` from the world's three declared imports (`http-request`
and `kv-get` are left uncalled) -- see bundles/rust and bundles/js for the
other two import subsets exercised by this spike.

Also carries a deliberate top-level side effect (a stderr print) to prove
for Q1 that componentize-py evaluates a bundle's top-level module code at
BUILD time, not just at instantiation/call time. An earlier version of this
same top-level code tried to *write a file* instead (both an absolute /tmp
path and a relative one) -- componentize-py's own build-time execution
sandbox has zero filesystem preopens by default, independent of the outer
container, and rejected both with FileNotFoundError; see REPORT.md Q1 for
the exact transcript. Reduced to a print here so the "good" build succeeds.
"""
import sys

import wit_world
from wit_world.imports.host import log

print("componentize-py evaluated this module's top level at build time", file=sys.stderr)


class WitWorld(wit_world.WitWorld):
    def transform(self, event: str) -> str | None:
        log("info", f"python bundle: transform called for '{event}'")
        return f"seen:{event}"
