# Bundle Compiler Sandbox -- Feasibility Spike

Throwaway spike, branch `spike/bundle-compiler-sandbox` off `origin/release/v3.0.X`. All work under `spikes/bundle-compiler-sandbox/`. Not pushed.

## Verdicts

| Question | Verdict |
|---|---|
| **Q1** -- compile step runs inside bubblewrap, no network, read-only toolchain | **PARTIAL, superseded.** Nested bwrap-in-Docker *does* work on this host, but only with the outer container running as real root plus broad `--security-opt`/`--cap-add` grants -- a rootless-containers violation, rejected (see below). The real design instead sandboxes the compiler at the **pod boundary** (gVisor RuntimeClass), modeled here as `docker run --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp`. Under that model: **YES for Python, JS, and Rust** -- all three build hermetically, no network, from an unwritable toolchain image plus a `/tmp` tmpfs scratch. componentize-py confirmed to execute top-level bundle code at build time. |
| **Q2** -- mechanically validate a prebuilt component against our WIT world + enumerate/allowlist its host imports, via `wasm-tools` | **YES.** `wasm-tools component wit` gives a parseable enumeration; a ~150-line script asserts world-conformance, lists every import, and allowlists by namespace. Correctly accepts 2/3 "good" components outright and the 3rd under a documented, still-precise widened allowlist; correctly rejects both bad components with exact, actionable messages. |

---

## Rejected approach: nested bwrap-in-container (root exception)

The spike setup asked for `bwrap --unshare-all --unshare-net ...` nested inside `docker run --rm -u 1000:1000 ...`. This was investigated first; a sibling spike investigating the same primitive independently hit the same wall. Full trail, since the failure modes are reusable diagnostic knowledge:

**Host:** Ubuntu 24.04.4 LTS, kernel `7.0.0-31-generic`, bubblewrap `0.9.0-1ubuntu0.1`. `kernel.unprivileged_userns_clone=1` (allowed) but `kernel.apparmor_restrict_unprivileged_userns=1` (Ubuntu 24.04's post-CVE mitigation): any unconfined process creating a `CLONE_NEWUSER` namespace is transitioned into a restrictive `unprivileged_userns` AppArmor profile that denies **all** capabilities inside the new namespace -- this is enforced by the **host kernel**, identically whether the calling process is bare-metal or inside a Docker container, and identically regardless of the container's own base image (tested both `ubuntu:24.04` and `debian:12-slim`; Debian's `bubblewrap` package, 0.8.0-2+deb12u1, ships no exception profile either).

| Attempt (outer `docker run -u 1000:1000 ...`) | Result |
|---|---|
| No extra flags | `bwrap: No permissions to create new namespace` (Docker's default seccomp profile blocks the `unshare`/`clone(CLONE_NEWUSER)` path outright) |
| `--security-opt seccomp=unconfined` | `bwrap: Failed to make / slave: Permission denied` (AppArmor `docker-default` blocks `mount`) |
| + `--security-opt apparmor=unconfined` | `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` -- same failure as bare host; the AppArmor `unprivileged_userns` transition still applies |
| + `--cap-add SYS_ADMIN --cap-add NET_ADMIN` (still `-u 1000`) | `bwrap: capset failed: Operation not permitted` -- added capabilities land in the bounding/permitted set but not the *effective* set for a non-root `execve()`, so bwrap's own namespace setup can't use them |
| `setcap cap_sys_admin,cap_net_admin+ep /usr/bin/bwrap` (file capabilities, still `-u 1000`) | `bwrap: Unexpected capabilities but not setuid, old file caps config?` -- bwrap **deliberately refuses to run** in this configuration (upstream hardening check) |
| `chmod u+s /usr/bin/bwrap` (classic setuid-root, still `-u 1000`) | `bwrap: capset failed: Operation not permitted` -- Docker's *default* root capability set (even via setuid transition) still excludes `SYS_ADMIN`; not pursued further combined with `--cap-add` given the next row already works and a standing setuid binary in the image is a worse trade-off anyway |
| Outer container as **real root** (`-u 0:0`) + `--cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt apparmor=unconfined --security-opt seccomp=unconfined --security-opt systempaths=unconfined` | **Works.** Full `--unshare-all --unshare-net`, loopback setup, fresh `/proc` mount all succeed. Confirmed hermetic: a DNS lookup inside `--unshare-net` fails (`curl` error 6, cannot resolve host); the identical lookup without `--unshare-net` succeeds (HTTP 200). `--privileged` also works (strictly more than needed). |

**Why rejected:** the only working configuration requires the *outer* wrapper container to run as real root with broad capabilities/AppArmor/seccomp disabled -- a rootless-containers exception per `devops-containers.md`, and one the team decided isn't worth taking merely to nest bwrap inside a container that itself needs elevated privilege to make that nesting possible. The alternative -- sandbox at the pod boundary instead of nesting a second sandboxer inside a generic container -- gets the same "no network, minimal writable surface" property without ever running anything as root. That alternative is what Q1's answer below actually exercises.

---

## Q1 -- Hermetic build (pod-boundary model)

Modeled per-language as: `docker run --rm -u 1000:1000 --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp ... <toolchain-image> <build command>`. The toolchain image (Rust/cargo-component, Python/componentize-py, Node/jco) is built once, network-enabled, with every tool version pinned exactly; the per-bundle build step that follows has **zero** network access and an **unwritable root filesystem** -- everything the build needs is already resident in the image, and the only writable path is a `tmpfs` at `/tmp`.

| Language | Builds hermetically? | Network proven blocked? | Wall time (hermetic build) | Component size |
|---|---|---|---|---|
| Rust (cargo-component 0.21.1) | YES | YES -- see below | 0.40 s | 67,795 B (`good-rust.wasm`) |
| Python (componentize-py 0.25.1) | YES | YES -- `socket.gethostbyname` -> `gaierror: Temporary failure in name resolution` | 5.52 s | 18,330,414 B (`good-python.wasm`, `--stub-wasi`) |
| JS (jco 1.34.0 / componentize-js 0.19.3) | YES | YES -- Node `https.get` -> `EAI_AGAIN` | 5.13 s | 12,476,087 B (`good-js.wasm`, `--disable all`) |

### componentize-py executes top-level code at build time (confirmed)

Adding a stderr `print()` at the top level of `app.py` (outside any function) causes it to appear in the `componentize-py componentize` build log itself, before the component is even instantiated for a call -- proving the bundle's own module-level code runs during compilation, not just at first invocation.

A **stronger** result than the spike originally set out to show: an earlier version of `app.py` tried a top-level *file write* instead of a print, both as an absolute path (`/tmp/componentize_py_build_marker.txt`) and a relative one (`componentize_py_build_marker.txt`). Both failed identically:

```
FileNotFoundError: [Errno 44] No such file or directory: '/tmp/componentize_py_build_marker.txt'
```

componentize-py's own build-time execution harness (a `wasmtime`-hosted preview run of the top-level module) has **zero filesystem preopens by default** -- this is enforced by componentize-py itself, independent of whatever the outer container permits. A malicious bundle's top-level code cannot write anywhere during build, full stop, unless componentize-py is explicitly reconfigured (no such CLI flag exists today). This is a stronger, tool-native guarantee than the outer-sandbox-enforced "can only write to /tmp" the spike set out to demonstrate.

### Hidden network dependency in the Rust toolchain (found, then fixed)

The first hermetic-build attempt for Rust failed:

```
error: component download failed for rust-std-wasm32-wasip1: ... Read-only file system
error: failed to install the `wasm32-wasip1` target
```

`cargo component build` silently auto-installs the `wasm32-wasip1` rustup target **on first use** if it isn't already present -- a real, easy-to-miss hidden network fetch that only surfaces once the sandboxed (no-network, read-only) build is attempted. Fix: `rustup target add wasm32-wasip1` at image-build time (network-enabled stage), alongside `wasm32-wasip2` (added for a separate comparison, see Q2 below). **General rule for the real compiler job: run one real "does everything resolve offline" build inside the exact hermetic sandbox as part of every toolchain image's own CI, not just at first bundle-author use -- auto-installed targets/toolchains are the most likely way a build silently regains a network dependency.**

### Pre-vendoring recipe per language

| Language | What needs vendoring | Mechanism used here |
|---|---|---|
| Rust | crates.io deps (`wit-bindgen-rt`, `bitflags`, transitively) + the `wasm32-wasip1`/`wasm32-wasip2` rustc target components | `cargo install`/`rustup target add` at image-build time populate `$CARGO_HOME` (`/usr/local/cargo`, chowned to the build user); sandboxed build runs `cargo component build --offline` against that already-populated registry cache. Functionally equivalent to `cargo vendor` + a source-replacement `.cargo/config.toml`; the registry-cache approach was simpler to demonstrate at this scale and needed no extra config file. Real per-product bundles with more dependencies should prefer explicit `cargo vendor` for an auditable, diffable vendor tree. |
| Python | `componentize-py` itself and its bundled WASI-target CPython runtime | `pip install` at image-build time; no bundle-specific deps existed for this trivial spike bundle. A real bundle with third-party pip deps would need `pip download`/`pip wheel` into a local index mirrored into the image, then `pip install --no-index --find-links=...` -- not exercised here. |
| JS | `jco`/`componentize-js` and their npm deps | `npm install -g` at image-build time. This trivial bundle has zero of its own npm dependencies (plain `.js`, no `package.json`), so there was nothing bundle-specific to vendor. A real bundle with npm deps would need `npm ci` against a pre-populated local cache (`npm config set cache`) or a vendored `node_modules/` shipped alongside the source -- not exercised here. |

### Container settings needed (pod-boundary model)

Beyond the flags the coordinator specified, three extra adjustments were needed -- all mount/env plumbing, never a capability or security-opt relaxation:

- **`--tmpfs /tmp` needs the `exec` mount option** (`--tmpfs /tmp:exec,size=1g`): Cargo compiles and then *executes* `wit-bindgen-rt`'s `build.rs` build-script binary from `$CARGO_TARGET_DIR`. Docker's plain `--tmpfs /tmp` mounted without `exec` produced a non-obvious `Permission denied (os error 13)` trying to run a binary that clearly existed -- any toolchain with a build-script/codegen step that compiles-then-runs its own helper binaries (Rust build scripts, but potentially others) needs this.
- `--tmpfs /home/node/.cache` for jco/wizer (wizer's cache-dir resolution reads the real passwd-db home directory, not `$HOME`)
- `-e CARGO_TARGET_DIR=/tmp/target -e HOME=/tmp/home` for cargo-component (multiple incidental writes -- target dir, minor `$HOME`-relative state)

No `--cap-add` or `--security-opt` relaxation was needed for any of the three hermetic builds -- `--cap-drop ALL --security-opt no-new-privileges` held throughout.

---

## Q2 -- Prebuilt component validation + import allowlist

### Tooling behavior observed

`wasm-tools component wit <file>` prints the component's own top-level `world { ... }` block (imports/exports) followed by every transitively-referenced package's full definition -- reliable, scriptable, and (per the text form used here) easy to parse: every import line in the top-level block is either `import <ns>:<pkg>/<iface>@<ver>;` or, for bare/unnamed world-level function imports, `import <name>: func(...);` (not used in this spike's final WIT -- see below).

`wasm-tools component targets <wit> -w <world> <file>` is **stricter than a subset check** -- it requires the target world to declare (directly or transitively) **every** import the component actually needs, including standard WASI runtime-init interfaces the component's own source never explicitly asked for:

```
$ wasm-tools component targets wit/world.wit -w stage out/good-rust.wasm
error: failed to validate encoded bytes
Caused by:
    0: type mismatch for import `stage`
       missing import named `wasi:cli/environment@0.2.3` (at offset 0x1098e)
```

This happens even for the spike's own "good" Rust component, because the minimal `stage` world (deliberately) declares only our three custom functions, not the WASI baggage every real toolchain pulls in (see below) -- `targets` isn't wrong, it's answering "is this world's declared surface sufficient to instantiate the component," and our minimal world genuinely isn't sufficient on its own. **Recommendation for the real compiler job:** don't hand-author a `targets`-ready world file (it would have to enumerate the full transitive WASI closure and be kept in lockstep with every toolchain's runtime-init requirements); use `component wit`'s text/JSON enumeration plus a custom allowlist check instead (what `scripts/validate_component.py` does) -- `targets` remains useful as a *secondary* smoke check ("will this even instantiate against a fully-populated host"), not as the primary per-import security gate.

### A critical, unplanned finding: default builds leak far more than the bundle's own imports

Building each language's "good" bundle with each toolchain's **default** settings showed that none of them produce a component whose import list matches only what the source code calls -- every language runtime drags in extra WASI interfaces just from being linked in:

| Language (default build) | Extra imports beyond `waddle:bundle/host` | Notably includes |
|---|---|---|
| Rust (cargo-component, wasm32-wasip1) | `wasi:cli/{environment,exit,stdin,stdout,stderr}`, `wasi:filesystem/{types,preopens}` | -- |
| Rust (wasm32-wasip2 **native** target, for comparison) | Same families, **plus** `wasi:io/poll`, `wasi:clocks/monotonic-clock`, `wasi:cli/terminal-{input,output,stdin,stdout,stderr}` | native wasip2 is *not* leaner than the wasip1+adapter path -- it's worse |
| Python (componentize-py, default) | `wasi:cli/*`, `wasi:filesystem/*`, `wasi:clocks/*`, `wasi:random/random`, `wasi:io/*`, **and `wasi:sockets/*`** (`tcp`, `udp`, `tcp-create-socket`, `udp-create-socket`, `ip-name-lookup`, `instance-network`, `network`) | CPython's stdlib `socket` module is always linked in, unconditionally importing real network capability even though this bundle never calls it |
| JS (jco/componentize-js, default StarlingMonkey backend) | `wasi:cli/*` (incl. `terminal-*`), `wasi:filesystem/*`, `wasi:http/{types,outgoing-handler}`, `wasi:random/random`, `wasi:io/*`, `wasi:clocks/*` | `fetch()` polyfill support wires real `wasi:http` outbound-request capability by default |

This means a strict "world imports + `wasi:clocks`/`wasi:random`/`wasi:io` only" allowlist -- the baseline this spike was asked to enforce -- would **reject every one of these bundles as built by default**, including the "good" ones, and the Python default build would be rejected specifically for something genuinely dangerous (real socket creation) that a superficial "did it target the right world" check would never catch. This is exactly the failure mode Q2's install-flow validation exists to catch, and it shows up organically rather than needing to be contrived.

**Mitigations found, per language:**

| Language | Mitigation | Result |
|---|---|---|
| Python | `componentize-py componentize ... --stub-wasi` | Every WASI import disappears entirely (traps at runtime instead); only `waddle:bundle/host@0.0.1-spike` remains. **Used as the spike's canonical "good" Python component.** Documented cost: PRNG seed gets baked in at build time (no real randomness), and any code path that actually touches stdio/filesystem/sockets/clocks traps at runtime rather than failing at build time -- acceptable for bundles that only use the custom `host` interface, not acceptable for one that needs real WASI capability. |
| JS | `jco componentize ... --disable all` | Same result -- only `waddle:bundle/host@0.0.1-spike` remains. **Used as the spike's canonical "good" JS component.** Same runtime-trap caveat as above. |
| Rust | **No equivalent flag exists in cargo-component 0.21.1.** | Not resolved within this spike's time-box. Two options for the real compiler job: (a) widen the permitted baseline to include `wasi:cli` (environment/exit/stdio -- low marginal risk, inert unless the host actually wires real stdio) and `wasi:filesystem` (higher risk -- only safe if the host never grants real preopens, which is already how every one of these runtimes is intended to be hosted); or (b) invest in a `#![no_std]` Rust bundle template, avoiding Rust's std runtime-init entirely -- bigger lift, not attempted here. |

### Import enumeration granularity differs by language

Rust (via `wasm-ld`/LTO dead-code elimination) gets genuine **per-function** import elision: this spike's Rust bundle calls only `kv-get` and `log`, and `http-request` is verifiably **absent** from the compiled component's import section -- confirmed by inspecting `wasm-tools component wit` output. Python and JS, by contrast, import the **whole `host` interface as a unit** the moment any one of its functions is referenced (confirmed: the JS bundle calls only `httpRequest`+`log`, but its component still declares `import waddle:bundle/host@0.0.1-spike;` covering all three). **Implication:** per-function allowlisting/display in the install UI can only be trusted at that granularity for Rust bundles; for Python/JS, the achievable and honest granularity is "this bundle imports our whole `host` interface," which is an acceptable over-approximation for our own interface but would matter more if the allowlist ever tried to scope third-party host capabilities function-by-function.

### The validation script

`scripts/validate_component.py` -- parses `wasm-tools component wit`'s text output for the top-level world block, then:

- **(a)** rejects unless the component imports `waddle:bundle/host@0.0.1-spike` (proof of targeting our interface) **and** exports `transform`
- **(b)** enumerates every declared import
- **(c)** rejects if any import falls outside the permitted set (our interface, plus a configurable set of WASI namespaces -- defaults to the spike's literal baseline `{wasi:clocks, wasi:random, wasi:io}`; `--extra-wasi wasi:cli --extra-wasi wasi:filesystem` demonstrates the "practical" widened variant discussed above)

**Results -- strict baseline** (`wasi:clocks`/`wasi:random`/`wasi:io` only):

| Component | Result |
|---|---|
| `good-python.wasm` (`--stub-wasi`) | **ACCEPT** -- imports: `waddle:bundle/host@0.0.1-spike` only |
| `good-js.wasm` (`--disable all`) | **ACCEPT** -- imports: `waddle:bundle/host@0.0.1-spike` only |
| `good-rust.wasm` (default cargo-component) | REJECT -- `wasi:cli/*`, `wasi:filesystem/*` outside allowlist |
| `bad-wrong-world.wasm` | **REJECT** -- `does not target waddle:bundle/stage@0.0.1-spike: missing import of waddle:bundle/host@0.0.1-spike` |
| `bad-extra-import.wasm` (Python, default/non-stub build -- a real, organically-produced `wasi:sockets` importer) | **REJECT** -- names `wasi:sockets/tcp-create-socket@0.2.9`, `wasi:sockets/tcp@0.2.9`, etc. explicitly among the disallowed set, alongside `wasi:cli/*`/`wasi:filesystem/*` |

**Results -- practical baseline** (`+wasi:cli +wasi:filesystem`, `--extra-wasi wasi:cli --extra-wasi wasi:filesystem`):

| Component | Result |
|---|---|
| `good-rust.wasm` | **ACCEPT** -- imports: `waddle:bundle/host@0.0.1-spike`, `wasi:cli/*`, `wasi:filesystem/*` |
| `bad-extra-import.wasm` | **still REJECT** -- `wasi:sockets/*` remains outside the widened set; the allowlist is precise, not a blanket give-up |
| `bad-wrong-world.wasm` | still REJECT -- interface check is independent of the namespace allowlist |

All three "good" components pass under one of the two documented allowlist variants; both bad components are rejected under **every** variant tried, with the exact disallowed-import list named in the rejection message every time.

---

## Q4 -- `.cwasm` precompilation

`wasmtime compile <component>.wasm -o <component>.cwasm`, wasmtime 48.0.2:

| Component | Compile time | `.wasm` size | `.cwasm` size |
|---|---|---|---|
| `good-rust.wasm` | 0.072 s | 67,795 B | 211,456 B |
| `good-python.wasm` | 7.816 s | 18,330,414 B | 32,543,224 B |
| `good-js.wasm` | 8.721 s | 12,476,087 B | 33,534,560 B |
| `bad-wrong-world.wasm` | 0.098 s | 64,339 B | 199,240 B |
| `bad-extra-import.wasm` | 8.556 s | 18,331,055 B | 32,532,696 B |

Compile time and `.cwasm` size scale with the size of the embedded language runtime (CPython/StarlingMonkey), not with the bundle's own trivial logic -- full-runtime components cost seconds to precompile per unit, tiny Rust components cost tens of milliseconds.

### Cross-version `.cwasm` loading: confirmed incompatible, both directions

```
$ wasmtime-20.0.0 run --allow-precompiled good-rust.cwasm   # .cwasm built by wasmtime 48.0.2
Error: Module was compiled with incompatible Wasmtime version '48'

$ wasmtime-48.0.2 run --allow-precompiled good-rust-old.cwasm   # .cwasm built by wasmtime 20.0.0
Error: failed to load code for: good-rust-old.cwasm
Caused by:
    Module was compiled with incompatible version '20.0.0'
```

Same-version round-trip (`wasmtime-48.0.2` loading a `.cwasm` it just produced) gets **past** the version check and fails only at the expected later stage (missing host-side linker implementation for our custom `waddle:bundle/host` interface, since the bare `wasmtime run` CLI doesn't know how to provide it) -- confirming the version check itself, not something else, is what blocks the cross-version cases.

**Rule for the real compiler job, confirmed:** a `.cwasm` is tied to the exact wasmtime version (not just major-compatible) that produced it. Precompiled artifacts must be regenerated on every wasmtime version bump in the runtime service, and the runtime must pin (and record) exactly which wasmtime version produced each cached `.cwasm` so a version mismatch is caught at deploy time, not as a runtime crash.

---

## Versions & digests

| Tool | Version | Source |
|---|---|---|
| `debian:12-slim` (all toolchain images) | -- | `sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171` |
| `ubuntu:24.04` (host-parity probe only, not used in final images) | -- | `sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254` |
| `rust:1.97-slim-bookworm` | rustc/cargo 1.97.1 | `sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3` |
| `python:3.13-slim-bookworm` | Python 3.13.15 | `sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e` |
| `node:26-bookworm-slim` | Node v26.8.2 | `sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae` |
| bubblewrap | 0.9.0-1ubuntu0.1 (host, Ubuntu 24.04) / 0.8.0-2+deb12u1 (Debian bookworm images) | apt, exact version pin |
| cargo-component | 0.21.1 | crates.io, `cargo install --locked` |
| wasm-tools | 1.259.0 | crates.io, `cargo install --locked` |
| componentize-py | 0.25.1 | PyPI |
| jco | 1.34.0 (bundles componentize-js 0.19.3) | npm |
| wasmtime-cli | 48.0.2 (current) | GitHub release, digest `sha256:f2b0ad1ce9253f2f9a38793c2c42cd1cba4e90b27dc40d685eaf723dc8438d94` (published by GitHub's release API) |
| wasmtime-cli | 20.0.0 (deliberately old, cross-major, for Q4) | GitHub release; no digest published by GitHub for this older asset -- computed on download and pinned here: `sha256:c604a929f1039df20b4a2055496fd211a9190b493183b3311bf332be0018f0e2` |

---

## Recommendations for the real compiler job

1. **Sandbox at the pod boundary (gVisor RuntimeClass), not by nesting bwrap inside a generic build container.** Nesting works but only via a root exception on the outer container; sandboxing at the pod level gets the same no-network/read-only/no-new-privileges guarantees without ever running the wrapper as root.
2. **Default every language's componentize step to its minimal-WASI-surface flag**: `componentize-py --stub-wasi`, `jco componentize --disable all`. For Rust, since no equivalent exists yet, either accept `wasi:cli`+`wasi:filesystem` into the baseline allowlist (documented, bounded risk) or invest in a `#![no_std]` template.
3. **Validate with `wasm-tools component wit` + a custom allowlist script, not `wasm-tools component targets` as the primary gate** -- `targets` needs the full transitive WASI closure spelled out in the target world and is better used as a secondary "will this instantiate at all" smoke check.
4. **Run one full no-network build inside the real hermetic sandbox as part of every toolchain image's own CI**, not just at first bundle-author use -- this is how the Rust `wasm32-wasip1` auto-install regression was actually caught here, and it's the only reliable way to catch a toolchain silently regaining a network dependency (auto-installed targets, lazily-fetched runtime blobs, etc.).
5. **Pin `.cwasm` precompilation to an exact wasmtime version and record it per artifact** -- confirmed incompatible across even a two-major-version gap, both directions, with a clear and detectable error, so this is a deploy-time check to add, not a runtime crash to discover later.
6. **Treat "does it target our world" and "what does it import" as two separate checks**, and always enumerate before allowlisting -- this spike's own default-built "good" components would have been silently over-permissioned (Python: real `wasi:sockets`; Rust/JS: `wasi:cli`+`wasi:filesystem`/`wasi:http`) had the install flow only checked world-targeting and skipped per-import enumeration.
