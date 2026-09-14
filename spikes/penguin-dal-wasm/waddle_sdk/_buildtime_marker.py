"""Import-time marker -- proves whether `componentize-py componentize` actually
EXECUTES the app's top-level code during the build (vs. only statically
analyzing it for the import graph). Imported by `app_entry.py` at module
level; if `evidence/buildtime_marker.txt` exists after a build with no
component ever having been run, the build step executed guest Python code
on the BUILD MACHINE (not inside a WASM sandbox) -- a supply-chain-relevant
fact for a bundle host, since `social_alias_process.py`'s own top-level
code is inert (no side effects at import time) but a malicious bundle's
would not be.
"""

from __future__ import annotations

import os
import time

_MARKER_PATH = os.environ.get("SPIKE_BUILDTIME_MARKER_PATH", "/tmp/componentize_py_buildtime_marker.txt")

try:
    with open(_MARKER_PATH, "a", encoding="utf-8") as _f:
        _f.write(f"imported at build time: {time.time()}\n")
except OSError:
    pass
