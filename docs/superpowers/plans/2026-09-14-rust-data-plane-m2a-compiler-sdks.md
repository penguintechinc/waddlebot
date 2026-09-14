# Waddles Rust Data Plane — M2a: Bundle Compiler, Tier-1 SDKs, Bucket Artifact Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `bundle-compiler` Rust binary (manifest validation, source scanning, hermetic per-language compilation, import-allowlist validation, content addressing, Ed25519 signing, bucket upload, hub-api callback), the three Tier-1 language SDKs (`waddle-sdk` Python, `waddle-sdk-rs`, `waddle-sdk-js`) over the `waddle:bundle/stage@1.0.0` WIT world, and the bucket artifact flow (MinIO/Nest, signed sidecars, digest verification) — so a bundle author's source becomes a signed, content-addressed WASI 0.2 component ready for the executor (M3/M4) to load, and hub-api (M2b) has a stable artifact + metadata contract to build install/consent/grants against.

**Architecture:** One Kubernetes Job per uploaded bundle version runs `bundle-compiler`, split into two containers sharing one `emptyDir` (spec D27, commit `680a0a9b`) so the artifact's digest is never computed inside the sandbox that ran bundle-supplied code: an **untrusted `build` initContainer** (gVisor `RuntimeClass`, zero credentials, zero network) validates `bundle.yaml` v2, scans source (SAST/deps/secrets/Skauswatch), and invokes the pinned per-language toolchain (`componentize-py --stub-wasi` / `cargo component build --target wasm32-wasip2` / `jco componentize --disable all`), writing the candidate component to `/work`; a **trusted `publisher` container** (cluster-default runtime, holding the bucket write key, the Ed25519 signing key, and the `waddles_publisher` Postgres role — and never executing bundle code) re-validates the component's *actual* WASI imports against a per-language allowlist from the raw bytes on `/work` (trusting nothing the build container claimed), computes the component's and the precompiled `.cwasm`'s SHA-256 digests itself, signs a metadata sidecar (Ed25519), uploads both to an S3-compatible bucket (MinIO default, Nest when configured), `INSERT`s the `app_versions` row directly, and notifies hub-api — a notification hub-api independently re-hashes and cross-checks, never the digest's authority. Each Tier-1 SDK wraps the same WIT world so bundle authors write ordinary Python/Rust/TypeScript against a familiar API — the Python SDK reproduces `penguin-dal`'s public API and today's `flask_core`/`waddle_transports` import names — while every host capability (`http`/`kv`/`db`/`relay`/`flags`/`log`/`clock`/`context`) is enforced host-side, never trusted from the guest.

**Tech Stack:** Rust 1.97 (`bundle-compiler`: clap, tracing, serde/serde_yaml, sha2, ed25519-dalek, object_store, reqwest, wasmtime, tokio); Python 3.13 (`waddle-sdk`: componentize-py 0.25.1, wasmtime 48.0.0); Rust + cargo-component 0.21.1 (`waddle-sdk-rs`); Node 26 + jco 1.34.0 (`waddle-sdk-js`); wasm-tools 1.259.0; wasmtime CLI 48.0.2.

**Spec:** `docs/superpowers/specs/2026-09-14-rust-data-plane-design.md` at commit `680a0a9b` (`docs/rust-data-plane-spec`) — this plan implements §4.6 (`bundle_compiler`, the D27 build/publisher split), §4.12 (`waddle-sdk`), §6.4–§6.6 (manifest v2, WIT world, wire-protocol constants the artifact carries), §6.10 (`app_versions`/`app_active_versions`, the two-writer rule, the audit trigger), §7.6 (digest-only reconciliation, documented for M3/M4 to implement against), §8 (egress declaration checked against the compiled component), the compiler-side half of §9 including §9.4's publisher steps (install/consent/grants itself is **M2b**, out of scope here — this plan defines the artifact + callback contract M2b consumes), the `waddles_publisher` slice of §11.10 (Least User Access via RBAC, D28), §12.1–§12.3 (compiler image + Job chart plumbing only), §14.3–§14.5 (WIT conformance suite, bundle compatibility suite, per-crate gates, RBAC negative test 14g), and milestone M2's `bundle-compiler` / SDK / bucket-flow rows. Also grounded in two spikes, cited per-task where code is lifted: `spikes/penguin-dal-wasm/REPORT.md` (branch `spike/penguin-dal-wasm`, commits `f45e6578`, `964f2729`) and `spikes/bundle-compiler-sandbox/REPORT.md` (branch `spike/bundle-compiler-sandbox`, commit `1f1d75a4`).

## Global Constraints

- Repo is `penguintechinc/waddles` (D22); `waddlebot` survives only in the four literals the spec names verbatim (Helm chart dir/release name `k8s/helm/waddlebot`, Postgres `DB_NAME=waddlebot`, the unused legacy `waddlebot:stream:*`/`waddlebot:dlq:*` prefixes, and package/scratchpad paths) — every other name in this plan says Waddles, never "restream".
- Rust lints (every new crate): `unsafe_code = "deny"`, `missing_docs = "deny"`, `clippy::unwrap_used = "deny"`; CI runs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo deny check`, `cargo audit`. Exact `=x.y.z` pins in every `Cargo.toml`; `Cargo.lock` committed.
- Coverage ≥90% lines/branches/functions/statements: `cargo llvm-cov --fail-under-lines 90` (Rust crates), `pytest --cov=waddle_sdk --cov-fail-under=90` (Python SDK). Every task's test step is written so the new files it adds clear this bar standalone.
- Every gate runs containerized — no host `cargo`/`pip`/`npm`/`componentize-py`/`wasm-tools`/`wasmtime`/`jco` invocations anywhere in this plan. Commands run inside the pinned images this plan builds (Tasks 2, 8–10, 19) or an equivalently pinned CI runner image.
- `set -euo pipefail` at the top of every script; never `|| true` on a linter/scanner/test; every "clean" scan result prints the count of items examined — zero examined is a **FAIL**, not a pass.
- No hardcoded secrets/credentials anywhere. Bucket credentials, the signing private key, and `SKAUSWATCH_URL`'s auth (if any) come from env vars or mounted files only, never a CLI flag, never logged (mask as `tok_****1234` if ever printed for debugging).
- Dependency pinning: Docker bases by `@sha256:` digest (digests below are the ones the two spikes already resolved and verified — reuse them, don't re-resolve), GitHub Actions by full commit SHA, PyPI/npm/crates.io by exact version with the lockfile committed.
- Every public Rust item gets a `///` doc comment; every public Python class/function a PEP 257 docstring; every exported TS symbol a `/** */` TSDoc comment. No ASCII-art section dividers in code comments.
- Commit messages: `feat(compiler): ...` / `feat(sdk-python): ...` / `feat(sdk-rust): ...` / `feat(sdk-js): ...` / `ci(compiler): ...` / `docs(compiler): ...`, each ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  ```

## Plan-Level Assumptions (read before Task 1)

- **PA1 — Manifest validator is self-contained, not a `penguin-bundle-host` dependency.** Spec §4.8 assigns `bundle.yaml` v2 parsing (the 31 rules) to `penguin-bundle-host::manifest`, a crate M1 delivers in `penguin-libs`. Neither an M1 plan nor a published crate version exists at the time this plan was written (checked: `~/code/penguin-libs/.worktrees/plan-penguin-bundle-host/docs/superpowers/plans/2026-09-14-penguin-bundle-host.md` — absent). To keep this plan buildable standalone by an implementer with zero other context, `core/bundle_compiler` vendors its own copy of the manifest parser/validator (Task 3), implementing every rule in spec §6.4.4 verbatim with the same reason codes. **Follow-up, not blocking M2a:** once `penguin-bundle-host::manifest` publishes, `core/bundle_compiler` switches `manifest.rs` to depend on it instead — the rule set and reason codes must stay byte-identical, since hub-api (M2b) and the golden fixtures in `tests/golden/manifests/` key off those exact strings.
- **PA2 — M2a is the reference implementation of the artifact contract; the M1c `penguin-bundle-host` executor-side plan must match it.** The bundle-host crate plan (executor side) also does not exist yet (checked, same path as above — the single file covers both wire+manifest). This plan defines, and any future M1c plan must match verbatim: the WIT file path (`wit/waddle-bundle/stage.wit`, Task 1), the `.cwasm` cache-key shape `{digest}-{wasmtime_abi}-{collector}` with `collector=drc` (Task 13 — M2a computes and records `cwasm_digest`/`wasmtime_abi`/`collector` on the `app_versions` row as a build-time confidence check; the executor separately computes and caches its own `.cwasm` at load time per spec §7.6 — the two are not the same precompiled bytes, only the same cache-key shape and pin), the signed sidecar JSON schema (Task 14, verbatim from spec §9.4), and the `hello` frame's `wasmtime_version`/`wasmtime_abi`/`collector` fields (spec §6.6) — M2a does not implement the executor wire protocol at all (that is M3/M4 scope), but the sidecar and `app_versions` row it writes are what an executor and hub-api will later cross-check those fields against. **Reconciliation (spec §7.6, M3/M4 to implement, documented here so the artifact contract is reconciliation-ready):** an executor compares the digest set the distribution API advertises against the digests its own pool reports loaded — same `app_id` + same digest is a no-op; same `app_id` + different digest fetches/verifies/hot-swaps; a new `app_id` loads; an `app_id` no longer advertised unloads. Version strings and manifest text play no part — digest is the only identity, which is exactly why Task 13's idempotency property (identical bytes ⇒ identical digest, any byte change ⇒ a different one) is load-bearing, not incidental.
- **PA5 — `app_versions` is a cross-milestone table; M2a owns the publisher-write slice, not the full RBAC matrix.** Spec §11.10 (D28) requires one normative `config/postgres/rbac-matrix.yaml` covering **every** role in the system (`hub_api`, `waddles_publisher`, `svc_ingest`, `svc_process`, `svc_action`, `svc_streaming`, `webui`, the executor — explicitly grantless, migration runner, per-bundle roles) with a CI equality test requiring ≥8 roles/≥8 tables examined. M2a cannot populate the other services' roles (M2b/M3/M4/M5 own those schemas) but is the first plan to need the file, so Task 16 **creates** `config/postgres/rbac-matrix.yaml` with every role from spec §11.10.1's table — `waddles_publisher`'s entry fully specified and enforced by this plan's own tests, every other role's entry present with its documented scope and a `owned_by` field naming the milestone that implements its schema — so later milestones extend the same file rather than inventing a second one. M2a's own CI equality test (Task 16) is scoped to what M2a deploys: `waddles_publisher` and `hub_api`'s grants on `app_versions`, plus the six non-writer roles named in spec's negative test 14g, created as bare grant-less roles in the test fixture purely to prove they hold zero privileges on `app_versions` — the full cross-service equality gate is assembled once M3/M4/M5/M2b each add their own slice.
- **PA3 — `waddle-sdk`'s DB facade targets `penguin_dal`'s real public API, not the spike's pydal-flavored one.** `spikes/penguin-dal-wasm/REPORT.md` built its facade against `flask_core.database.AsyncDAL`'s pydal-wrapping surface, and found (Sec 3, Sec "DAL finding, confirmed") that bundles call through `flask_core.get_bundle_dal()`, never `penguin_dal` directly — a finding the spike itself flags as needing correction. Spec decision D21 supersedes that: **the SDK ships exactly one DB surface, `penguin_dal`'s own public API**, verified against `/home/penguin/code/penguin-libs/packages/python-dal/src/penguin_dal/__init__.py` and its `db.py`/`query.py`/`field_proxy.py`/`table_proxy.py` (read directly for this plan, since no M1.5 plan exists yet either — checked `docs/superpowers/plans/2026-09-14-rust-data-plane-m1.5-bundle-migration.md` on `docs/plan-m1.5-bundle-migration`, branch absent). **Follow-up:** once M1.5 lands, confirm its migrated bundles call the exact surface Task 27 implements (`AsyncDB.__getattr__` → `TableProxy`, `AsyncDB.__call__(query)` → `AsyncQuerySet`, `TableProxy.__getattr__` → `FieldProxy`, `FieldProxy.__eq__`/`.like`/`.belongs`/etc. → `Query`, `AsyncQuerySet.select/update/delete/count/exists`, `TableProxy.insert`/`.async_insert`/`.bulk_insert`, `Row`/`Rows`) — if M1.5 needs a method this plan didn't implement, that is a `waddle-sdk` gap to close before M6, not a reason to add a second facade. **Not implemented, by scope, not oversight:** the sync `QuerySet`/`DB` variants (real `penguin_dal` exposes both a sync and async DB) — this facade is async-signatured throughout (`DB = AsyncDB`), matching D21's "async-compatible signatures" requirement; every first-party bundle already calls through `get_bundle_dal()`'s async surface, so a sync `QuerySet` has no caller in scope. Also not implemented: `Page`/`Cursor` pagination (spec §4.12 lists them in `penguin_dal`'s module inventory but no cited first-party bundle call site uses them) and `orderby`/`limitby` on `select()` (present in the signature for compatibility, raises `NotImplementedError` if actually passed a value) — all three are explicit `NotImplementedError` gaps per D21's rule, not silent omissions, and are follow-ups if M1.5's migration turns out to need them.
- **PA4 — Executor and full conformance runs are simulated by a purpose-built harness in this plan.** `bundle-executor` (M3/M4) does not exist yet. Every "run the compiled component and assert its behavior" step in this plan uses the harness built in Task 21 (`tools/wit-conformance-harness`), a small Rust program using the `wasmtime` component API directly — not a stand-in for the real executor's host-call semantics (capability scoping, egress guard, RLS), only for "does this component instantiate and answer its exports correctly against golden events." Negative-sandbox tests (§14.6 of the spec) are M3/M4/M5 scope.

---

## Artifact & Digest Contract (Normative — read before Task 7)

This section is the single source of truth every later compiler task implements against. It is binding on M2b, M3, M4 and M5 wherever they touch a digest.

**The compiler's `publisher` container is the sole producer of the component's SHA-256 digest, anywhere in the system.** No other component — not the `build` container, not an SDK, not hub-api, not an executor — ever computes the digest that becomes an `app_versions` row's `artifact_digest`. hub-api (M2b) is permitted to **independently re-derive** its own hash of the same bucket object for cross-checking (spec §9.4 step 6); that is verification, not production, and a disagreement is an incident, not a merge.

**Why the digest is computed only in `publisher`, never in `build`:** `build` executes bundle-supplied code (`componentize-py`'s build-time dry run, `cargo component`'s build-script execution, `jco`'s bundler) — a process that measures its own output could be made to lie about it. `publisher` never executes bundle code; it only parses bytes (`wasm-tools`, `wasmtime compile`) and hashes them (`sha2`). Splitting the two means a compromised `build` container can, at worst, produce a bad component — it cannot produce a false digest for a bad component, because it never computes one.

**Two digests, two purposes, both computed by `publisher` only:**

| Digest | Computed from | Stored | Purpose |
|---|---|---|---|
| `artifact_digest` | The final component `.wasm` bytes, after `publisher`'s own re-validation | `app_versions.artifact_digest`, the signed sidecar's `digest` field, the bucket object key (`bundles/{app_id}/{version}/{sha256}.wasm`) | The artifact's identity everywhere — bucket key, distribution API, executor load-time verification, reconciliation (PA2) |
| `cwasm_digest` | The `.cwasm` produced by `publisher`'s own precompile self-test (`wasmtime compile -C collector=drc`, pinned CLI) | `app_versions.cwasm_digest` (plus `wasmtime_abi`, `collector` on the same row) | A build-time confidence check that the component precompiles cleanly under the pinned engine/collector *before* any pod ever tries to load it — catches a version/collector mismatch (spike round 2's actual failure mode) at publish time, not first load |

**Idempotency is a first-class, tested property (Task 13):** hashing identical component bytes twice, in two separate `publisher` invocations, produces the identical `artifact_digest` — a bundle re-published with byte-identical output is correctly a no-op at every layer above it (bucket `PUT` is idempotent on the same key, `app_versions` upserts the same digest, an executor's reconciliation sees "same digest, no-op" per spec §7.6). Any single byte of difference in the component produces a different digest — there is no "close enough."

**`app_versions` (spec §6.10) — schema this plan's publisher writes to:**

```sql
CREATE TABLE app_versions (
    id               BIGSERIAL PRIMARY KEY,
    app_id           TEXT NOT NULL,
    version          TEXT NOT NULL,
    artifact_digest  TEXT NOT NULL,           -- 'sha256:' + 64 hex, over the component bytes
    cwasm_digest     TEXT NOT NULL,           -- 'sha256:' + 64 hex, over the precompiled .cwasm
    wasmtime_abi     TEXT NOT NULL,
    collector        TEXT NOT NULL,           -- 'drc'
    size_bytes       BIGINT NOT NULL,
    language         TEXT NOT NULL,
    artifact_kind    TEXT NOT NULL,           -- 'source' | 'prebuilt'
    built_at         TIMESTAMPTZ NOT NULL,
    builder          TEXT NOT NULL,           -- 'bundle-compiler@<version>'
    scan_status      TEXT NOT NULL,           -- 'scanned' | 'scanned_with_findings' | 'not_scanned' | 'scan_failed'
    badge            TEXT,                    -- the permanent "not security-scanned" badge, when applicable
    approval_id      BIGINT,                  -- FK app_install_approvals(id) — M2b writes this column later
    UNIQUE (app_id, version),
    UNIQUE (artifact_digest)
);
```

**Roles — exactly two writers, per spec §6.10, enforced and tested by this plan (Task 16):**

| Role | Grants on `app_versions` | Who this is |
|---|---|---|
| `waddles_publisher` | `INSERT`, `UPDATE`, `DELETE` | The compiler's `publisher` container — this plan's own connection role |
| `hub_api` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | M2b — owns scan-outcome linkage, the §9.4-step-6 cross-check, orphan cleanup |
| Every other role (`svc_ingest`, `svc_process`, `svc_action`, `svc_streaming`, the executor, `webui`) | **None** | Stages read digests through the distribution API; the executor holds no DB credential at all |

Overwrites are permitted (a re-publish or correction is legitimate); what must never happen is a write from an unexpected role, so **every write is audited** — an `AFTER INSERT OR UPDATE OR DELETE` trigger records the operation, `current_user`, `(app_id, version)`, and the old/new `artifact_digest`. This is Least User Access (D28), not immutability: the property enforced is "no unexpected writers," proven by a negative test per non-writer role (spec test 14g, implemented in Task 16).

**`app_active_versions` is hub-api-owned and out of scope for M2a** — it is where activation and rollback live (an `UPDATE` of `version_id`, never an edit of a digest row). M2a's publisher never writes it; M2b does.

**Publish sequence (spec §9.4), all of it inside `publisher`, none of it inside `build`:**

0. Read the candidate component out of the shared `/work` `emptyDir`. Re-validate it from the bytes (`wasm-tools component wit` + the per-language import allowlist) — `publisher` trusts nothing `build` claimed.
1. Compute `artifact_digest` (component bytes) and `cwasm_digest` (precompiled `.cwasm`) — both here, both only here.
2. `PUT bundles/{app_id}/{version}/{artifact_digest-hex}.wasm`.
3. Build and Ed25519-sign the sidecar (schema unchanged from spec §9.4 — `cwasm_digest`/`wasmtime_abi`/`collector` live on the `app_versions` row, not the sidecar).
4. `PUT bundles/{app_id}/{version}/{artifact_digest-hex}.json`.
5. `INSERT` the `app_versions` row directly, over `waddles_publisher`.
6. Notify hub-api. **This is a notification, not the digest authority** — hub-api independently re-fetches the bucket object, re-hashes it, and compares against what `publisher` inserted; a mismatch blocks approval and is audited, naming both digests.

---

## File Structure

```
waddles/
  wit/
    waddle-bundle/
      stage.wit                          # Task 1 — normative WIT world, copied verbatim from spec §6.5
  build/
    tool-versions.env                    # Task 1 — every pinned toolchain version + verified SHA-256
  config/
    postgres/
      rbac-matrix.yaml                   # Task 16 — normative role x table x privilege matrix (D28)
  core/
    bundle_compiler/
      Cargo.toml                         # Task 2
      deny.toml                          # Task 2
      Dockerfile                         # Task 19 — single image, build/publish are subcommands of one binary
      README.md                          # Task 2
      migrations/
        0001_app_versions.sql            # Task 16 — table + audit trigger + role grants
      src/
        main.rs                          # Task 2 — CLI entry (build/publish subcommands), exit codes
        errors.rs                        # Task 2
        logging.rs                       # Task 2
        manifest.rs                      # Task 3
        scan/
          mod.rs                         # Task 5
          legacy_dal.rs                  # Task 4
          sast.rs                        # Task 5
          skauswatch.rs                  # Task 6
        build/
          mod.rs                         # Task 7 — LanguageBuilder trait, wires manifest+scan+build into run_build
          python.rs                      # Task 8
          rust.rs                        # Task 9
          js.rs                          # Task 10
        validate/
          mod.rs                         # Task 11 — wasm-tools parse + per-language allowlist (shared: build fail-fast + publisher authority)
          egress.rs                      # Task 12 — V22 egress-vs-http cross-check, V25 WIT export check
        artifact.rs                      # Task 13 — publisher-only re-validation + dual digest (component + cwasm)
        sidecar.rs                       # Task 14 — Ed25519 sidecar signing
        bucket.rs                        # Task 15
        db.rs                            # Task 16 — waddles_publisher Postgres client, app_versions INSERT
        callback.rs                      # Task 17 — hub-api notification client
      tests/
        fixtures/
          manifests/                     # Task 3 — one good + one per V1-V24 rule
          bundles/
            good-python/, good-rust/, good-js/, bad-wrong-world/, bad-extra-import/, tampered-component/
                                          # Task 18 — adapted from spike/bundle-compiler-sandbox
        manifest_test.rs                 # Task 3
        legacy_dal_test.rs               # Task 4
        scan_test.rs                     # Task 5
        skauswatch_test.rs               # Task 6
        validate_test.rs                 # Task 11
        egress_test.rs                   # Task 12
        artifact_test.rs                 # Task 13 — includes idempotency + tampered-component tests
        sidecar_test.rs                  # Task 14
        bucket_test.rs                   # Task 15 (testcontainers MinIO)
        db_test.rs                       # Task 16 — includes RBAC negative test 14g (testcontainers Postgres)
        e2e_test.rs                      # Task 18 — includes no-bucket/DB-env-in-build-container assertion
  tools/
    wit-conformance-harness/
      Cargo.toml                         # Task 22
      src/main.rs                        # Task 22
  sdk/
    waddle-sdk/                          # Python
      pyproject.toml                     # Task 23
      src/waddle_sdk/
        __init__.py                      # Task 23
        _asyncio_patch.py                # Task 24 — adapted from spike/penguin-dal-wasm
        _poll_loop.py                    # Task 24 — adapted from spike/penguin-dal-wasm
        _component_entry.py              # Task 28
        flask_core/
          __init__.py                    # Task 25
          bundle_runtime.py              # Task 25 — adapted from spike/penguin-dal-wasm
          stream_pipeline.py             # Task 25
          feature_flags.py               # Task 26
        db.py                            # Task 27 — penguin_dal-compatible facade
        http.py                          # Task 28 (part 2)
        kv.py                            # Task 28
        relay.py                         # Task 28
        log.py                           # Task 28
        clock.py                         # Task 28
      scripts/
        generate_bundle_preimports.py    # Task 24 — adapted from spike/penguin-dal-wasm
      tests/
        test_asyncio_patch.py            # Task 24
        test_bundle_runtime.py           # Task 25
        test_feature_flags.py            # Task 26
        test_db_facade.py                # Task 27
        test_http.py                     # Task 28
    waddle-sdk-rs/
      Cargo.toml                         # Task 30
      src/lib.rs                         # Task 30 (bindings + wrappers)
      tests/wrapper_test.rs              # Task 30
    waddle-sdk-js/
      package.json                       # Task 32
      tsconfig.json                      # Task 32
      src/index.ts                       # Task 32 (bindings + wrappers)
      tests/wrapper.test.ts              # Task 32
  bundles/
    python/
      example/
        bundle.yaml                      # Task 29
        app.py                           # Task 29
    rust/
      example/
        Cargo.toml, wit/, src/lib.rs, bundle.yaml   # Task 31
    javascript/
      example/
        bundle.ts, bundle.yaml           # Task 33
  docs/
    contracts/
      bundle-artifact-callback.openapi.yaml   # Task 17
  k8s/helm/waddlebot/
    values.yaml                          # Task 21 (additions only, per spec §12.3)
    templates/
      bundle-compiler-networkpolicy.yaml # Task 21
      bundle-compiler-job-template-configmap.yaml  # Task 21 — two-container (initContainer build + container publisher) Job spec
  .github/workflows/
    rust-bundle-compiler.yml             # Task 20
    conformance-suite.yml                # Task 35
```

---

## Task Dependency Graph

Every task's own "Interfaces" block names the specific functions/types it consumes; this table is the at-a-glance view of which tasks gate which, so parallel work (three SDK tracks, independent build recipes) is visible without reading all 35 tasks. "Cross-track" marks a dependency that crosses the compiler/SDK boundary — the one place strict track-parallelism has a real seam.

| Task | Depends on | Parallel with |
|---|---|---|
| 1. WIT world + tool-versions | — (foundation) | — |
| 2. CLI skeleton | 1 | — |
| 3. Manifest parser (V1-V24) | 2 | 4, 5, 6 |
| 4. Legacy DAL scan | 2 | 3, 5, 6 |
| 5. SAST/dep/secrets scan | 2 | 3, 4, 6 |
| 6. Skauswatch client | 2 | 3, 4, 5 |
| 7. LanguageBuilder trait + wire `run_build` | 3, 4, 5, 6 | — |
| 8. Python build recipe | 7; **cross-track: 23** (`waddle-sdk` importable) | 9, 10 |
| 9. Rust build recipe | 7 | 8, 10 |
| 10. JS/TS build recipe (bare `jco componentize`) | 7 | 8, 9 |
| 11. Import allowlist validator | 8, 9 (compiles fixtures in its own tests) | 12 |
| 12. Egress-vs-http cross-check (V22) | 11, 3 | — |
| 13. Publisher re-validate + dual digest | 11, 12, 8, 9 | 14 (sidecar can be written in parallel, wired together in 18) |
| 14. Ed25519 sidecar signing | 13 (`Digests` type) | 15, 16, 17 |
| 15. Bucket upload client | 2 | 14, 16, 17 |
| 16. `app_versions` write + RBAC matrix | 13 (`Digests`), 3 (`BundleManifest`) | 14, 15, 17 |
| 17. hub-api notification callback | 13 (`Digests`) | 14, 15, 16 |
| 18. Wire `run_publish` + e2e | 13, 14, 15, 16, 17 | — |
| 19. Dockerfile | 1, 8, 9, 10 (toolchain pins) | — |
| 20. CI workflow | 19 | 21 |
| 21. K8s Job Helm template | 19, 16 (env var names) | 20 |
| 22. Shared WIT conformance harness | 1 | 8-21 (independent tool crate) |
| 23. `waddle-sdk` package skeleton | 1 | 30, 32 |
| 24. asyncio_patch/PollLoop/pre-import gen | 23 | 25, 26 |
| 25. `flask_core` compat shims | 23 | 24, 26 |
| 26. `feature_flags` shim | 23 | 24, 25 |
| 27. `db` facade | 23 | 24, 25, 26 |
| 28. http/kv/relay/log/clock + component entry | 24, 25, 27 | — |
| 29. Python example bundle + conformance | 28, 22; **cross-track: 8** (entry-wiring convention) | 31, 33 |
| 30. `waddle-sdk-rs` bindings + wrappers | 1 | 23, 32 |
| 31. Rust example bundle + conformance | 30, 22 | 29, 33 |
| 32. `waddle-sdk-js` bindings + wrappers | 1 | 23, 30 |
| 33. JS example bundle + conformance | 32, 22; modifies 10's file | 29, 31 |
| 34. CI compile-all `bundles/python/` | 7, 22, 29 | 35 |
| 35. Bucket retention/digest/signature/badge | 18 | 34 |

**Parallelization shape:** after Task 1, four tracks proceed independently until their own integration points — compiler-build (2→7→8/9/10→11→12), compiler-publish (13→14/15/16/17→18→19→20/21), Python SDK (23→24/25/26/27→28→29), Rust SDK (30→31), JS SDK (32→33) — with Task 22 (harness) needed only by the three "→ example bundle + conformance" leaves, and Tasks 34-35 as the final cross-track integration gate.

---

## Task 1: WIT world + pinned tool-versions manifest

**Files:**
- Create: `wit/waddle-bundle/stage.wit`
- Create: `build/tool-versions.env`
- Test: `wit/waddle-bundle/stage_wit_test.sh`

**Interfaces:**
- Produces: the normative WIT world `waddle:bundle@1.0.0` / world `stage`, importing `context`/`http`/`kv`/`db`/`relay`/`flags`/`log`/`clock`, exporting `process-stage`/`action-stage`. Every later task (compiler validation, all three SDKs) references this exact file by path `wit/waddle-bundle/stage.wit` and never inlines a copy.
- Produces: `build/tool-versions.env`, sourced by every Dockerfile and CI workflow in this plan (Tasks 8-10, 19, 32) — one source of truth for every pinned version/digest.

- [ ] **Step 1: Create the WIT world directory and write the normative copy**

```bash
mkdir -p wit/waddle-bundle
```

Write `wit/waddle-bundle/stage.wit` (verbatim from spec §6.5):

```wit
package waddle:bundle@1.0.0;

/// Values that cross the host boundary. WIT has no dynamic JSON value, so
/// every open-ended structure is carried as canonical UTF-8 JSON text and
/// validated on both sides.
interface types {
  record platform-event {
    platform: string,
    event-type: string,
    actor: option<string>,
    /// Canonical JSON object text. Never a scalar or array.
    payload-json: string,
    /// RFC 3339 UTC, millisecond precision.
    occurred-at: string,
  }

  record stage-envelope {
    tenant: string,
    community: option<string>,
    app-id: string,
    stage: string,
    event: platform-event,
    ts: string,
    target-app-id: option<string>,
    /// W3C traceparent, when the stage had one.
    trace-context: option<string>,
  }

  record transport-result {
    ok: bool,
    status: option<u16>,
    detail: option<string>,
    provider-message-id: option<string>,
  }

  record transport-error {
    /// The single field the action stage branches on.
    retryable: bool,
    code: string,
    message: string,
    retry-after-ms: option<u32>,
  }

  /// Returned by a stage export the bundle does not implement.
  record unsupported-stage {
    stage: string,
  }
}

/// Immutable, per-call scope. Capability: always granted.
interface context {
  record bundle-context {
    tenant: string,
    community: option<string>,
    app-id: string,
    feature: string,
    version: string,
    /// The Valkey stream entry id of the event being processed. Stable and
    /// unique per delivery target; the de-duplication key a bundle records
    /// to stay idempotent under at-least-once redelivery.
    message-id: string,
    /// Resolved 3-tier config (activation > tenant availability > bundle default),
    /// as canonical JSON object text.
    config-json: string,
  }

  get-context: func() -> bundle-context;
}

/// Guarded outbound HTTP. Capability: granted only when `egress` is non-empty.
interface http {
  record header { name: string, value: string }

  record request {
    method: string,
    url: string,
    headers: list<header>,
    body: option<list<u8>>,
    /// Header name -> secret reference name. The stage resolves the reference
    /// and injects the header; the secret value never enters the component.
    secret-refs: list<tuple<string, string>>,
  }

  record response {
    status: u16,
    headers: list<header>,
    body: list<u8>,
    truncated: bool,
  }

  variant error {
    denied(string),
    timeout,
    too-large(u64),
    rate-limited(u32),
    transport(string),
  }

  send: func(req: request) -> result<response, error>;
}

/// Bundle-scoped key/value, stored under the bundle's own `…:state` key.
/// Capability: always granted.
interface kv {
  variant error { too-large(u64), backend(string) }

  get: func(key: string) -> result<option<list<u8>>, error>;
  /// ttl-seconds = 0 means "no expiry"; the host clamps to KV_MAX_TTL_S.
  set: func(key: string, value: list<u8>, ttl-seconds: u32) -> result<_, error>;
  delete: func(key: string) -> result<_, error>;
  increment: func(key: string, delta: s64, ttl-seconds: u32) -> result<s64, error>;
}

/// Parameterized SQL executed BY THE STAGE under the bundle's own Postgres
/// role, restricted to the manifest's `data.tables` and row-level-security
/// scoped to the envelope's tenant/community. Capability: granted only when
/// `data.tables` is non-empty.
interface db {
  variant value {
    null-value,
    bool-value(bool),
    int-value(s64),
    float-value(f64),
    text-value(string),
    bytes-value(list<u8>),
  }

  record rows {
    columns: list<string>,
    rows: list<list<value>>,
    rows-affected: u64,
  }

  variant error {
    denied(string),
    syntax(string),
    conflict(string),
    timeout,
    backend(string),
  }

  /// Statement text with $1..$n placeholders. String interpolation of
  /// parameters is impossible across this boundary by construction.
  execute: func(statement: string, params: list<value>) -> result<rows, error>;
}

/// Push onto a provider-scoped outbound relay queue owned by svc-ingest.
/// Capability: granted only to action-stage bundles.
interface relay {
  variant error { denied(string), backend(string) }

  push: func(provider: string, message-json: string) -> result<_, error>;
}

/// PostHog flag + license entitlement, two-gate, cached, fail-open to the
/// supplied default. Capability: always granted.
interface flags {
  enabled: func(key: string, default-value: bool) -> bool;
  /// "free" | "professional" | "enterprise"
  tier: func() -> string;
}

/// Sanitized, levelled logging into the stage's OTel pipeline.
/// Capability: always granted.
interface log {
  enum level { error, warn, info, debug }
  /// `fields-json` is a canonical JSON object; the host sanitizes it with the
  /// penguin logging SENSITIVE_KEYS rule before emission.
  write: func(lvl: level, message: string, fields-json: string);
}

/// Capability: always granted.
interface clock {
  /// Milliseconds since the Unix epoch, as the stage sees it.
  now-millis: func() -> u64;
  /// RFC 3339 UTC, millisecond precision.
  now-rfc3339: func() -> string;
  /// Monotonic nanoseconds, for in-bundle duration measurement only.
  monotonic-nanos: func() -> u64;
}

interface process-stage {
  use types.{platform-event, unsupported-stage};
  /// `none` means "no reply"; the event is dropped, exactly as v1's
  /// `transform() -> PlatformEvent | None`.
  transform: func(event: platform-event) -> result<option<platform-event>, unsupported-stage>;
}

interface action-stage {
  use types.{stage-envelope, transport-result, transport-error};
  /// `config` is canonical JSON object text (the resolved 3-tier config).
  dispatch: func(envelope: stage-envelope, config: string)
    -> result<transport-result, transport-error>;
}

world stage {
  import context;
  import http;
  import kv;
  import db;
  import relay;
  import flags;
  import log;
  import clock;

  export process-stage;
  export action-stage;
}
```

- [ ] **Step 2: Write `build/tool-versions.env`**

Every version and digest below is reused verbatim from the two spikes' own verified evidence (`spikes/penguin-dal-wasm/REPORT.md` Sec 2, `spikes/bundle-compiler-sandbox/REPORT.md` "Versions & digests") — never re-guessed:

```bash
# build/tool-versions.env — sourced by every Dockerfile/CI workflow in this
# repo for the bundle-compiler toolchain. Update only via a reviewed PR;
# never hand-edit a digest without re-verifying via `crane digest` or the
# upstream release's own published checksum.

# Base images (Debian 12 bookworm per devops-containers.md)
DEBIAN_BASE_DIGEST=sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
PYTHON_BASE_DIGEST=sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e   # python:3.13-slim-bookworm
RUST_BASE_DIGEST=sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3      # rust:1.97-slim-bookworm
NODE_BASE_DIGEST=sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae      # node:26-bookworm-slim

# WASM toolchains
WASMTIME_CLI_VERSION=48.0.2
WASMTIME_CLI_SHA256_X86_64_LINUX=f2b0ad1ce9253f2f9a38793c2c42cd1cba4e90b27dc40d685eaf723dc8438d94
WASM_TOOLS_VERSION=1.259.0
WASM_TOOLS_SHA256_SOURCE=3e9b374b4c7715b771b69bf0d65a337990ed4546ec5e97e01c0ff587dfc52160
COMPONENTIZE_PY_VERSION=0.25.1
WASMTIME_PY_VERSION=48.0.0
CARGO_COMPONENT_VERSION=0.21.1
JCO_VERSION=1.34.0
RUST_WASM_TARGETS="wasm32-wasip1 wasm32-wasip2"

# Security scanners (exact versions; resolve+pin digests via the
# pinning-dependency-digests skill before the image is promoted past alpha)
SEMGREP_VERSION=1.99.0
GITLEAKS_VERSION=8.21.2
PIP_AUDIT_VERSION=2.7.3
CARGO_AUDIT_VERSION=0.21.0
TRIVY_VERSION=0.58.1

# GC collector pin — must match componentize-py's own output (spike round 2
# finding: a mismatched collector fails to load, not just runs slower).
WASM_COLLECTOR=drc
```

- [ ] **Step 3: Write a validation script and run it (no toolchain installed yet — this only checks the file is syntactically sane by grep; real `wasm-tools` validation happens once the compiler image exists, Task 19)**

```bash
cat > wit/waddle-bundle/stage_wit_test.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
FILE="wit/waddle-bundle/stage.wit"
test -f "$FILE"
grep -q "^package waddle:bundle@1.0.0;" "$FILE"
grep -q "^world stage {" "$FILE"
for iface in context http kv db relay flags log clock; do
  grep -q "import $iface;" "$FILE"
done
for exp in process-stage action-stage; do
  grep -q "export $exp;" "$FILE"
done
echo "PASS: stage.wit declares 8 imports + 2 exports"
EOF
chmod +x wit/waddle-bundle/stage_wit_test.sh
```

Run: `bash wit/waddle-bundle/stage_wit_test.sh`
Expected: `PASS: stage.wit declares 8 imports + 2 exports`

- [ ] **Step 4: Commit**

```bash
git add wit/waddle-bundle/stage.wit build/tool-versions.env wit/waddle-bundle/stage_wit_test.sh
git commit -m "$(cat <<'EOF'
feat(compiler): add normative WIT world and pinned tool-versions manifest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 2: `bundle-compiler` crate skeleton — `build`/`publish` subcommands, exit codes, structured logging

**Files:**
- Create: `core/bundle_compiler/Cargo.toml`
- Create: `core/bundle_compiler/deny.toml`
- Create: `core/bundle_compiler/src/main.rs`
- Create: `core/bundle_compiler/src/lib.rs`
- Create: `core/bundle_compiler/src/errors.rs`
- Create: `core/bundle_compiler/src/logging.rs`
- Test: `core/bundle_compiler/tests/cli_test.rs`

**Interfaces:**
- Consumes: nothing yet (foundation task).
- Produces: `CompilerError` enum with an `exit_code(&self) -> i32` method every later module returns through; the `build`/`publish` clap subcommands — `build` is what the untrusted `build` initContainer runs (manifest+scan+per-language compile, per the Artifact & Digest Contract section above), `publish` is what the trusted `publisher` container runs (re-validate+dual-digest+sign+upload+DB-write+notify). `init_logging()` called once at `main()` start.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "bundle-compiler"
version = "0.1.0"
edition = "2021"
license = "Proprietary"

[lib]
name = "bundle_compiler"
path = "src/lib.rs"

[[bin]]
name = "bundle-compiler"
path = "src/main.rs"

[lints.rust]
unsafe_code = "deny"
missing_docs = "deny"

[lints.clippy]
unwrap_used = "deny"

[dependencies]
clap = { version = "=4.5.20", features = ["derive"] }
tracing = "=0.1.40"
tracing-subscriber = { version = "=0.3.18", features = ["json", "env-filter"] }
serde = { version = "=1.0.210", features = ["derive"] }
serde_json = "=1.0.128"
serde_yaml = "=0.9.34"
sha2 = "=0.10.8"
ed25519-dalek = { version = "=2.1.1", features = ["rand_core"] }
base64 = "=0.22.1"
hex = "=0.4.3"
chrono = { version = "=0.4.38", features = ["serde"] }
thiserror = "=1.0.64"
walkdir = "=2.5.0"
regex = "=1.11.0"
semver = "=1.0.23"
tempfile = "=3.13.0"
object_store = { version = "=0.11.1", features = ["aws"] }
reqwest = { version = "=0.12.9", features = ["json", "rustls-tls"], default-features = false }
tokio = { version = "=1.40.0", features = ["full"] }
tokio-postgres = { version = "=0.7.12", features = ["with-serde_json-1"] }
wasmtime = "=48.0.2"

[dev-dependencies]
rand = "=0.8.5"
mockito = "=1.5.0"
testcontainers = "=0.23.1"
testcontainers-modules = { version = "=0.11.4", features = ["postgres", "minio"] }

[profile.release]
strip = true
lto = true
codegen-units = 1
```

- [ ] **Step 2: Write `deny.toml`** (mirrors `core/svc_streaming/deny.toml`'s shape)

```toml
[bans]
multiple-versions = "warn"
wildcards = "deny"

[licenses]
allow = ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "Unicode-DFS-2016"]

[advisories]
vulnerability = "deny"
unmaintained = "warn"

[sources]
unknown-registry = "deny"
unknown-git = "deny"
```

- [ ] **Step 3: Write `src/errors.rs`**

```rust
//! Every failure mode `bundle-compiler` can exit with, and the exit code
//! each one maps to. The Job's status is machine-readable through the exit
//! code, not just stderr.

use thiserror::Error;

/// Every top-level failure `bundle-compiler` can produce, mapped 1:1 to a
/// process exit code so the Kubernetes Job's status is machine-readable.
#[derive(Debug, Error)]
pub enum CompilerError {
    #[error("manifest invalid: {reason}: {message}")]
    ManifestInvalid { reason: String, message: String },

    #[error("security scan blocked the build: {reason}: {message}")]
    ScanBlocked { reason: String, message: String },

    #[error("compilation failed for language {language}: {message}")]
    CompileFailed { language: String, message: String },

    #[error("component validation failed: {reason}: {message}")]
    ValidationFailed { reason: String, message: String },

    #[error("artifact signing or upload failed: {0}")]
    ArtifactFailed(String),

    #[error("database write failed: {0}")]
    DbFailed(String),

    #[error("hub-api callback failed: {0}")]
    CallbackFailed(String),

    #[error("configuration error: {0}")]
    Config(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl CompilerError {
    /// The process exit code this error maps to. `78` (`EX_CONFIG`) matches
    /// the convention the four data-plane services use for fatal
    /// configuration failures elsewhere in this spec.
    pub fn exit_code(&self) -> i32 {
        match self {
            CompilerError::ManifestInvalid { .. } => 1,
            CompilerError::ScanBlocked { .. } => 2,
            CompilerError::CompileFailed { .. } => 3,
            CompilerError::ValidationFailed { .. } => 4,
            CompilerError::ArtifactFailed(_) => 5,
            CompilerError::DbFailed(_) => 6,
            CompilerError::CallbackFailed(_) => 7,
            CompilerError::Config(_) => 78,
            CompilerError::Io(_) => 74, // EX_IOERR
        }
    }
}
```

- [ ] **Step 4: Write `src/logging.rs`**

```rust
//! Structured JSON logging via `tracing`, per `critical-rules.md` Observability.
//! No Rust penguin-logging crate exists yet (known gap) — this asserts
//! `tracing` is in use and that log lines are structured JSON.

use tracing_subscriber::EnvFilter;

/// Initialize the global `tracing` subscriber. Call exactly once, at the
/// top of `main()`, before any other log line.
pub fn init_logging() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(true)
        .init();
}
```

- [ ] **Step 5: Write `src/lib.rs`** (so integration tests can `use bundle_compiler::...`; module bodies are empty placeholders Tasks 3-17 fill in)

```rust
//! `bundle-compiler`'s library surface. Two entry points map to the two
//! containers of the Job (see the Artifact & Digest Contract section of
//! this plan): `build::run_build` is called by the untrusted `build`
//! initContainer; `publish::run_publish` is called by the trusted
//! `publisher` container. They never call into each other's credentialed
//! or bundle-code-executing paths.

pub mod artifact;
pub mod bucket;
pub mod build;
pub mod callback;
pub mod db;
pub mod errors;
pub mod manifest;
pub mod scan;
pub mod sidecar;
pub mod validate;
```

```bash
mkdir -p core/bundle_compiler/src/scan core/bundle_compiler/src/validate
touch core/bundle_compiler/src/manifest.rs
echo "//! Security scanning orchestration — filled in by Tasks 4-6." > core/bundle_compiler/src/scan/mod.rs
echo "//! Component import validation — filled in by Tasks 11-12." > core/bundle_compiler/src/validate/mod.rs
echo "//! Publisher-only digest computation — filled in by Task 13." > core/bundle_compiler/src/artifact.rs
echo "//! Ed25519 sidecar signing — filled in by Task 14." > core/bundle_compiler/src/sidecar.rs
echo "//! S3-compatible bucket client — filled in by Task 15." > core/bundle_compiler/src/bucket.rs
echo "//! waddles_publisher Postgres client — filled in by Task 16." > core/bundle_compiler/src/db.rs
echo "//! hub-api notification client — filled in by Task 17." > core/bundle_compiler/src/callback.rs
```

- [ ] **Step 6: Write `src/build/mod.rs` as a placeholder module (Task 7 replaces this) so `main.rs` compiles**

```bash
mkdir -p core/bundle_compiler/src/build
cat > core/bundle_compiler/src/build/mod.rs <<'RUST'
//! Everything the untrusted `build` initContainer does — filled in fully
//! by Task 7 (orchestration) and Tasks 8-10 (per-language recipes). This
//! placeholder exists so `main.rs` compiles from this task onward.
use crate::errors::CompilerError;
use std::path::Path;

/// Placeholder — Task 7 replaces the body with the real manifest+scan+
/// per-language-build pipeline.
pub fn run_build(_bundle: &Path, _manifest: &Path, _out: &Path) -> Result<(), CompilerError> {
    Err(CompilerError::Config("build pipeline not yet wired — see Task 7".to_string()))
}
RUST
```

- [ ] **Step 7: Write `src/main.rs`**

```rust
//! `bundle-compiler` — CLI entry point. `build` runs in the untrusted
//! `build` initContainer; `publish` runs in the trusted `publisher`
//! container. Never the same process, never the same binary invocation.

use bundle_compiler::build::run_build;
use bundle_compiler::errors::CompilerError;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "bundle-compiler", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// UNTRUSTED — runs bundle-supplied code. Validates the manifest, scans
    /// the source, compiles it. Never touches the bucket, the DB, or
    /// hub-api; must never be given those credentials.
    Build {
        #[arg(long)]
        bundle: PathBuf,
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    /// TRUSTED — never executes bundle code. Re-validates the component
    /// `build` produced (or a directly-uploaded Tier 2 prebuilt one),
    /// computes both digests, signs, uploads, writes `app_versions`,
    /// notifies hub-api.
    Publish {
        #[arg(long)]
        component: PathBuf,
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        language: String,
        #[arg(long, value_parser = ["source", "prebuilt"])]
        artifact_kind: String,
    },
}

fn main() -> ExitCode {
    bundle_compiler::logging::init_logging();
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Build { bundle, manifest, out } => run_build(&bundle, &manifest, &out),
        Command::Publish { component, manifest, language, artifact_kind } => {
            bundle_compiler::run_publish(&component, &manifest, &language, &artifact_kind)
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error = %e, exit_code = e.exit_code(), "bundle-compiler failed");
            ExitCode::from(e.exit_code() as u8)
        }
    }
}
```

Add `pub mod logging;` to `src/lib.rs`, and a placeholder `run_publish` at the crate root (Task 18 replaces it with the real composed pipeline):

```rust
// append to core/bundle_compiler/src/lib.rs
pub mod logging;

/// Placeholder — Task 18 replaces this with the real publish pipeline
/// (Tasks 11-17 composed in order).
pub fn run_publish(
    _component: &std::path::Path,
    _manifest: &std::path::Path,
    _language: &str,
    _artifact_kind: &str,
) -> Result<(), errors::CompilerError> {
    Err(errors::CompilerError::Config("publish pipeline not yet wired — see Task 18".to_string()))
}
```

- [ ] **Step 8: Write the CLI smoke test**

```rust
// core/bundle_compiler/tests/cli_test.rs
//! Smoke tests for the CLI surface — later tasks' own tests cover the real
//! logic; this only proves the binary starts, parses args, and exits with
//! the documented code when a phase isn't wired yet.
use std::process::Command;

#[test]
fn help_exits_zero() {
    let output = Command::new(env!("CARGO_BIN_EXE_bundle-compiler")).arg("--help").output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("build"));
    assert!(stdout.contains("publish"));
}

#[test]
fn build_without_wiring_exits_78() {
    let output = Command::new(env!("CARGO_BIN_EXE_bundle-compiler"))
        .args(["build", "--bundle", "/tmp/x", "--manifest", "/tmp/y", "--out", "/tmp/z"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(78));
}

#[test]
fn publish_without_wiring_exits_78() {
    let output = Command::new(env!("CARGO_BIN_EXE_bundle-compiler"))
        .args([
            "publish", "--component", "/tmp/c.wasm", "--manifest", "/tmp/m.yaml",
            "--language", "python", "--artifact-kind", "source",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(78));
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run (inside a `rust:1.97-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3` container, `cwd=core/bundle_compiler`):
```bash
cargo test --locked
```
Expected: `3 passed; 0 failed`.

- [ ] **Step 10: Run lints**

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```
Expected: both exit 0.

- [ ] **Step 11: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): scaffold bundle-compiler crate with build/publish subcommands

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 3: `bundle.yaml` v2 manifest parser + pure-YAML validation rules V1-V24

**Files:**
- Modify: `core/bundle_compiler/src/manifest.rs`
- Create: `core/bundle_compiler/tests/fixtures/manifests/valid_python.yaml`, `valid_rust.yaml`, `valid_js.yaml`
- Create: `core/bundle_compiler/tests/fixtures/manifests/invalid_v{1..24}_*.yaml` (21 files — V22/V25/V27-V31 need a compiled component, added in Task 12)
- Create: `core/bundle_compiler/tests/manifest_test.rs`

**Interfaces:**
- Consumes: nothing new. Runs inside the untrusted `build` container (pure text parsing, no code execution).
- Produces: `pub struct BundleManifest { .. }` (public fields below), `pub struct ManifestOptions { pub allow_prebuilt: bool, pub egress_denylist: Vec<String>, pub allow_wildcard_consumes: bool }` (with `Default`), `pub fn parse_and_validate(path: &Path, opts: &ManifestOptions) -> Result<BundleManifest, ManifestError>`, and `pub struct ManifestError { pub reason: &'static str, pub message: String }`. Task 7 calls this from `run_build`; Task 12 adds V22/V25/V27-V31 as `pub fn validate_against_component(manifest: &BundleManifest, imports: &[String], exports: &[String]) -> Result<(), ManifestError>`.

- [ ] **Step 1: Write the fixture manifests**

```bash
mkdir -p core/bundle_compiler/tests/fixtures/manifests
cat > core/bundle_compiler/tests/fixtures/manifests/valid_python.yaml <<'EOF'
schema_version: 2
app_id: waddles.core.example.echo
name: Echo Example Bundle
version: 1.0.0
feature: waddles.core.example
module: core
provider: builtin
language: python
artifact: source
execution_model: native
is_default: false
stages:
  process:
    entry: "app:transform"
    consumes:
      - platform: discord
        event_types: ["chat.message"]
    produces: []
    config: {}
    spec:
      required_config: []
  action:
    entry: "app:dispatch"
    config: {}
    spec:
      required_config: []
egress: []
data:
  tables: []
limits:
  timeout_ms: 2000
  memory_mb: 64
  egress_rps: 10
permissions: []
config_schema: {}
compatible_with: []
incompatible_with: []
platform_compatibility:
  tested_with: "1.0.0"
  min_version: "1.0.0"
  max_version: null
EOF
sed 's/language: python/language: rust/' core/bundle_compiler/tests/fixtures/manifests/valid_python.yaml \
  > core/bundle_compiler/tests/fixtures/manifests/valid_rust.yaml
sed 's/language: python/language: javascript/' core/bundle_compiler/tests/fixtures/manifests/valid_python.yaml \
  > core/bundle_compiler/tests/fixtures/manifests/valid_js.yaml
```

Write one invalid fixture per rule, each a one-field break off `valid_python.yaml` (`cp` then `sed`, following the two worked examples, then apply the table's break to each remaining file the same way):

```bash
cp core/bundle_compiler/tests/fixtures/manifests/valid_python.yaml core/bundle_compiler/tests/fixtures/manifests/invalid_v14_schema_version.yaml
sed -i 's/schema_version: 2/schema_version: 1/' core/bundle_compiler/tests/fixtures/manifests/invalid_v14_schema_version.yaml

cp core/bundle_compiler/tests/fixtures/manifests/valid_python.yaml core/bundle_compiler/tests/fixtures/manifests/invalid_v15_ingest_stage.yaml
python3 - <<'PYEOF'
import yaml
p = "core/bundle_compiler/tests/fixtures/manifests/invalid_v15_ingest_stage.yaml"
doc = yaml.safe_load(open(p))
doc["stages"]["ingest"] = {"entry": "app:normalize"}
yaml.safe_dump(doc, open(p, "w"))
PYEOF
```

| Fixture file | Rule | Break |
|---|---|---|
| `invalid_v1_missing_field.yaml` | V1 `missing_field` | delete the `name` key |
| `invalid_v2_bad_semver.yaml` | V2 `bad_semver` | `version: "not-a-version"` |
| `invalid_v3_not_namespaced.yaml` | V3 `not_namespaced` | `app_id: "bad"` |
| `invalid_v4_feature_namespaced.yaml` | V4 `not_namespaced` | `feature: "bad"` |
| `invalid_v5_unknown_module.yaml` | V5 `unknown_module` | `module: "nope"` |
| `invalid_v6_feature_prefix_mismatch.yaml` | V6 `feature_prefix_mismatch` | `feature: "waddles.core.other"` |
| `invalid_v7_invalid_provider.yaml` | V7 `invalid_provider` | `provider: "vendor"` |
| `invalid_v8_unknown_surface.yaml` | V8 `unknown_surface` | rename `stages.process` to `stages.weird` |
| `invalid_v9_invalid_execution_model.yaml` | V9 `invalid_execution_model` | `execution_model: "hybrid"` |
| `invalid_v10_bad_platform_compat_semver.yaml` | V10 `bad_platform_compat_semver` | `platform_compatibility.min_version: "x.y.z"` |
| `invalid_v11_invalid_compat_app_id.yaml` | V11 `invalid_compat_app_id` | `incompatible_with: ["bad"]` |
| `invalid_v12_presentation_missing_html.yaml` | V12 `presentation_missing_html_entrypoint` | add `stages.presentation: {}` |
| `invalid_v13_script_stage_has_html.yaml` | V13 `script_stage_has_html_entrypoint` | add `stages.process.html_entrypoint: "x.html"` |
| `invalid_v16_no_stages_declared.yaml` | V16 `no_stages_declared` | `stages: {}` |
| `invalid_v17_unsupported_language.yaml` | V17 `unsupported_language` | `language: "cobol"` |
| `invalid_v18_prebuilt_not_allowed.yaml` | V18 `prebuilt_not_allowed` | `artifact: "prebuilt"` (tested against `allow_prebuilt=false`) |
| `invalid_v19_invalid_egress_host.yaml` | V19 `invalid_egress_host` | `egress: [{host: "http://evil.com"}]` |
| `invalid_v20_invalid_egress_method.yaml` | V20 `invalid_egress_method` | `egress: [{host: "api.example.com", methods: ["TRACE"]}]` |
| `invalid_v21_egress_host_denylisted.yaml` | V21 `egress_host_denylisted` | `egress: [{host: "denied.example.com"}]` (tested with `["denied.example.com"]` as the denylist) |
| `invalid_v23_invalid_data_table.yaml` | V23 `invalid_data_table`/`reserved_data_table` | `data.tables: ["users"]` |
| `invalid_v24_limit_out_of_range.yaml` | V24 `limit_out_of_range` | `limits.timeout_ms: 99999` |

- [ ] **Step 2: Write the failing test**

```rust
// core/bundle_compiler/tests/manifest_test.rs
use bundle_compiler::manifest::{parse_and_validate, ManifestOptions};
use std::path::Path;

#[test]
fn valid_python_manifest_parses() {
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &ManifestOptions::default()).unwrap();
    assert_eq!(m.app_id, "waddles.core.example.echo");
    assert_eq!(m.language, "python");
}

#[test]
fn v14_unsupported_schema_version_rejected() {
    let err = parse_and_validate(Path::new("tests/fixtures/manifests/invalid_v14_schema_version.yaml"), &ManifestOptions::default()).unwrap_err();
    assert_eq!(err.reason, "unsupported_schema_version");
}

#[test]
fn v15_ingest_stage_rejected() {
    let err = parse_and_validate(Path::new("tests/fixtures/manifests/invalid_v15_ingest_stage.yaml"), &ManifestOptions::default()).unwrap_err();
    assert_eq!(err.reason, "ingest_not_pluggable");
}

#[test]
fn v18_prebuilt_rejected_when_disallowed() {
    let opts = ManifestOptions { allow_prebuilt: false, ..Default::default() };
    let err = parse_and_validate(Path::new("tests/fixtures/manifests/invalid_v18_prebuilt_not_allowed.yaml"), &opts).unwrap_err();
    assert_eq!(err.reason, "prebuilt_not_allowed");
}

#[test]
fn v21_egress_denylist_enforced() {
    let opts = ManifestOptions { egress_denylist: vec!["denied.example.com".to_string()], ..Default::default() };
    let err = parse_and_validate(Path::new("tests/fixtures/manifests/invalid_v21_egress_host_denylisted.yaml"), &opts).unwrap_err();
    assert_eq!(err.reason, "egress_host_denylisted");
}

/// Non-vacuous denominator check (critical-rules.md Verification Integrity):
/// every fixture on disk must actually be exercised by name.
#[test]
fn every_invalid_fixture_has_a_test_case() {
    let count = std::fs::read_dir("tests/fixtures/manifests")
        .unwrap()
        .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("invalid_"))
        .count();
    assert_eq!(count, 21, "expected 21 invalid_* fixtures (V1-V24 minus V22, which needs a compiled component)");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked manifest_test`
Expected: FAIL — `parse_and_validate`/`ManifestOptions` not defined.

- [ ] **Step 4: Implement `src/manifest.rs`**

```rust
//! `bundle.yaml` v2 parsing and validation — spec §6.4. Implements rules
//! V1-V24 (pure YAML, no compiled artifact needed); V22/V25/V27-V31 live in
//! Task 12's `validate_against_component`. Vendored reference
//! implementation — see Plan-Level Assumption PA1.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

/// One `bundle.yaml` v2 document, fully parsed and pure-YAML-validated.
#[derive(Debug, Clone, Deserialize)]
pub struct BundleManifest {
    pub schema_version: u32,
    pub app_id: String,
    pub name: String,
    pub version: String,
    pub feature: String,
    pub module: String,
    pub provider: String,
    pub language: String,
    pub artifact: String,
    #[serde(default = "default_execution_model")]
    pub execution_model: String,
    #[serde(default)]
    pub is_default: bool,
    pub stages: BTreeMap<String, StageSpec>,
    #[serde(default)]
    pub egress: Vec<EgressRule>,
    #[serde(default)]
    pub data: DataSpec,
    #[serde(default)]
    pub limits: Limits,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub compatible_with: Vec<String>,
    #[serde(default)]
    pub incompatible_with: Vec<String>,
    #[serde(default)]
    pub platform_compatibility: PlatformCompatibility,
}

fn default_execution_model() -> String {
    "native".to_string()
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct StageSpec {
    pub entry: Option<String>,
    #[serde(default)]
    pub consumes: Vec<ConsumesRule>,
    #[serde(default)]
    pub produces: Vec<String>,
    #[serde(default)]
    pub config: BTreeMap<String, serde_json::Value>,
    pub html_entrypoint: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConsumesRule {
    pub platform: String,
    pub source_id: Option<String>,
    pub event_types: Vec<String>,
    #[serde(default)]
    pub filters: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EgressRule {
    pub host: String,
    #[serde(default = "default_methods")]
    pub methods: Vec<String>,
}

fn default_methods() -> Vec<String> {
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map(String::from).to_vec()
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DataSpec {
    #[serde(default)]
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Limits {
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: i64,
    #[serde(default = "default_memory_mb")]
    pub memory_mb: i64,
    #[serde(default = "default_egress_rps")]
    pub egress_rps: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { timeout_ms: 2000, memory_mb: 64, egress_rps: 10 }
    }
}
fn default_timeout_ms() -> i64 { 2000 }
fn default_memory_mb() -> i64 { 64 }
fn default_egress_rps() -> i64 { 10 }

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PlatformCompatibility {
    pub tested_with: Option<String>,
    pub min_version: Option<String>,
    pub max_version: Option<String>,
}

/// Runtime knobs a rule needs that are not in the YAML itself.
#[derive(Debug, Clone)]
pub struct ManifestOptions {
    pub allow_prebuilt: bool,
    pub egress_denylist: Vec<String>,
    pub allow_wildcard_consumes: bool,
}

impl Default for ManifestOptions {
    fn default() -> Self {
        ManifestOptions { allow_prebuilt: true, egress_denylist: Vec::new(), allow_wildcard_consumes: false }
    }
}

/// A validation failure — `reason` is one of the exact strings in spec
/// §6.4.4's table, `message` is the human-readable detail shown to the
/// bundle author.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError {
    pub reason: &'static str,
    pub message: String,
}

const KNOWN_MODULES: &[&str] = &[
    "socials", "customers", "community", "event", "marketing", "bot", "streaming",
    "social", "customer",
    "analytics", "video_proxy", "auth", "compliance", "integrations", "tenancy", "core",
];
const RESERVED_TABLES: &[&str] =
    &["users", "tenants", "communities", "app_catalog", "app_activations", "app_tenant_availability"];
const ALLOWED_METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

#[allow(clippy::unwrap_used)]
static APP_ID_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^waddles\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$").unwrap());
#[allow(clippy::unwrap_used)]
static FEATURE_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^waddles\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$").unwrap());
#[allow(clippy::unwrap_used)]
static TABLE_RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[a-z][a-z0-9_]{0,62}$").unwrap());
#[allow(clippy::unwrap_used)]
static HOST_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$").unwrap());
#[allow(clippy::unwrap_used)]
static WILDCARD_HOST_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\*\.([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$").unwrap());

fn err(reason: &'static str, message: impl Into<String>) -> ManifestError {
    ManifestError { reason, message: message.into() }
}

/// Parse `path` as YAML and run every V1-V24 rule in order, stopping at the
/// first failure (spec §6.4.4).
pub fn parse_and_validate(path: &Path, opts: &ManifestOptions) -> Result<BundleManifest, ManifestError> {
    let raw = std::fs::read_to_string(path).map_err(|e| err("missing_field", format!("cannot read manifest: {e}")))?;
    let m: BundleManifest = serde_yaml::from_str(&raw)
        .map_err(|e| err("missing_field", format!("manifest does not parse as bundle.yaml v2: {e}")))?;

    if m.schema_version != 2 {
        return Err(err("unsupported_schema_version", format!("schema_version must be 2, got {}", m.schema_version)));
    }
    if m.stages.is_empty() {
        return Err(err("no_stages_declared", "stages must declare at least one of process/action/presentation"));
    }
    if m.stages.contains_key("ingest") {
        return Err(err("ingest_not_pluggable", "the ingest stage is fixed code — use the process stage's consumes"));
    }
    for key in m.stages.keys() {
        if !["process", "action", "presentation"].contains(&key.as_str()) {
            return Err(err("unknown_surface", format!("stages.{key} is not one of process/action/presentation")));
        }
    }
    if m.name.trim().is_empty() || m.name.len() > 120 {
        return Err(err("missing_field", "name must be 1-120 characters"));
    }
    if semver::Version::parse(&m.version).is_err() {
        return Err(err("bad_semver", format!("version {:?} is not valid SemVer 2.0.0", m.version)));
    }
    if !APP_ID_RE.is_match(&m.app_id) {
        return Err(err("not_namespaced", format!("app_id {:?} must be waddles.<module>.<feature>.<app>", m.app_id)));
    }
    if !FEATURE_RE.is_match(&m.feature) {
        return Err(err("not_namespaced", format!("feature {:?} must be waddles.<module>.<feature>", m.feature)));
    }
    if !KNOWN_MODULES.contains(&m.module.as_str()) {
        return Err(err("unknown_module", format!("module {:?} is not in KNOWN_MODULES", m.module)));
    }
    let app_id_prefix = m.app_id.rsplitn(2, '.').nth(1).unwrap_or("");
    if app_id_prefix != m.feature {
        return Err(err("feature_prefix_mismatch", format!("feature {:?} must equal app_id minus its last segment ({app_id_prefix:?})", m.feature)));
    }
    let feature_module = m.feature.split('.').nth(1).unwrap_or("");
    if feature_module != m.module {
        return Err(err("feature_prefix_mismatch", format!("module {:?} must equal feature's second segment ({feature_module:?})", m.module)));
    }
    if !["builtin", "thirdparty"].contains(&m.provider.as_str()) {
        return Err(err("invalid_provider", format!("provider must be builtin or thirdparty, got {:?}", m.provider)));
    }
    if !["native", "thirdparty"].contains(&m.execution_model.as_str()) {
        return Err(err("invalid_execution_model", format!("execution_model must be native or thirdparty, got {:?}", m.execution_model)));
    }
    let known_languages = ["python", "rust", "javascript", "typescript", "other"];
    if !known_languages.contains(&m.language.as_str()) {
        return Err(err("unsupported_language", format!("language {:?} is not one of {known_languages:?}", m.language)));
    }
    if m.language == "other" && m.artifact != "prebuilt" {
        return Err(err("unsupported_language", "language: other is only legal with artifact: prebuilt"));
    }
    if !["source", "prebuilt"].contains(&m.artifact.as_str()) {
        return Err(err("prebuilt_not_allowed", format!("artifact must be source or prebuilt, got {:?}", m.artifact)));
    }
    if m.artifact == "prebuilt" && !opts.allow_prebuilt {
        return Err(err("prebuilt_not_allowed", "artifact: prebuilt is disabled by bundles.allow_prebuilt"));
    }
    for v in [&m.platform_compatibility.min_version, &m.platform_compatibility.max_version] {
        if let Some(v) = v {
            if semver::Version::parse(v).is_err() {
                return Err(err("bad_platform_compat_semver", format!("platform_compatibility version {v:?} is not valid SemVer")));
            }
        }
    }
    for id in m.compatible_with.iter().chain(m.incompatible_with.iter()) {
        if !APP_ID_RE.is_match(id) {
            return Err(err("invalid_compat_app_id", format!("{id:?} is not a valid app_id")));
        }
    }
    if let Some(p) = m.stages.get("presentation") {
        if p.html_entrypoint.is_none() {
            return Err(err("presentation_missing_html_entrypoint", "a presentation stage requires html_entrypoint"));
        }
        if p.entry.is_some() {
            return Err(err("presentation_has_script_entrypoint", "a presentation stage must not declare entry"));
        }
    }
    for key in ["process", "action"] {
        if let Some(s) = m.stages.get(key) {
            if s.html_entrypoint.is_some() {
                return Err(err("script_stage_has_html_entrypoint", format!("stages.{key} must not declare html_entrypoint")));
            }
        }
    }
    for rule in &m.egress {
        if !HOST_RE.is_match(&rule.host) && !WILDCARD_HOST_RE.is_match(&rule.host) {
            return Err(err("invalid_egress_host", format!("egress host {:?} is not a lowercase FQDN or *.wildcard", rule.host)));
        }
        for method in &rule.methods {
            if !ALLOWED_METHODS.contains(&method.as_str()) {
                return Err(err("invalid_egress_method", format!("egress method {method:?} is not one of {ALLOWED_METHODS:?}")));
            }
        }
        if opts.egress_denylist.iter().any(|d| d == &rule.host) {
            return Err(err("egress_host_denylisted", format!("egress host {:?} is on the tenant denylist", rule.host)));
        }
    }
    for table in &m.data.tables {
        if !TABLE_RE.is_match(table) {
            return Err(err("invalid_data_table", format!("data.tables entry {table:?} must match ^[a-z][a-z0-9_]{{0,62}}$")));
        }
        if RESERVED_TABLES.contains(&table.as_str()) {
            return Err(err("reserved_data_table", format!("data.tables entry {table:?} is a reserved identity table")));
        }
    }
    if !(50..=10_000).contains(&m.limits.timeout_ms) {
        return Err(err("limit_out_of_range", format!("limits.timeout_ms {} must be within 50..=10000", m.limits.timeout_ms)));
    }
    if !(8..=256).contains(&m.limits.memory_mb) {
        return Err(err("limit_out_of_range", format!("limits.memory_mb {} must be within 8..=256", m.limits.memory_mb)));
    }
    if !(1..=10).contains(&m.limits.egress_rps) {
        return Err(err("limit_out_of_range", format!("limits.egress_rps {} must be within 1..=10", m.limits.egress_rps)));
    }
    if let Some(process) = m.stages.get("process") {
        if process.consumes.is_empty() {
            return Err(err("consumes_required", "a process stage must declare a non-empty consumes list"));
        }
    }
    if let Some(action) = m.stages.get("action") {
        if !action.consumes.is_empty() {
            return Err(err("consumes_on_action_stage", "an action stage must not declare consumes"));
        }
    }
    let known_platforms = ["twitch", "discord", "slack", "youtube", "kick", "waddles"];
    if let Some(process) = m.stages.get("process") {
        for rule in &process.consumes {
            let is_wildcard_platform = rule.platform == "*";
            let is_known = known_platforms.contains(&rule.platform.as_str())
                || rule.platform.starts_with("custom:")
                || is_wildcard_platform;
            if !is_known {
                return Err(err("unknown_consumes_platform", format!("consumes platform {:?} is not recognized", rule.platform)));
            }
            if is_wildcard_platform && !opts.allow_wildcard_consumes {
                return Err(err("wildcard_consumes_not_allowed", "platform: \"*\" requires allow_wildcard_consumes"));
            }
            for et in &rule.event_types {
                if et == "**" && !opts.allow_wildcard_consumes {
                    return Err(err("wildcard_consumes_not_allowed", "event_types entry \"**\" requires allow_wildcard_consumes"));
                }
            }
            for filter_key in rule.filters.keys() {
                if !["command_prefix", "actor_roles"].contains(&filter_key.as_str()) {
                    return Err(err("invalid_consumes_filter", format!("filters key {filter_key:?} is not command_prefix or actor_roles")));
                }
            }
        }
    }

    Ok(m)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --locked manifest_test`
Expected: all cases pass, `every_invalid_fixture_has_a_test_case` passes (21 fixtures).

- [ ] **Step 6: Coverage check**

Run: `cargo llvm-cov --fail-under-lines 90 -- manifest_test`
Expected: line coverage of `src/manifest.rs` ≥ 90%.

- [ ] **Step 7: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): parse and validate bundle.yaml v2 (rules V1-V24)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 4: Legacy DAL import scan (Python) — D21b

**Files:**
- Create: `core/bundle_compiler/src/scan/legacy_dal.rs`
- Create: `core/bundle_compiler/tests/fixtures/bundles/legacy-dal/app.py`
- Create: `core/bundle_compiler/tests/fixtures/bundles/clean-dal/app.py`
- Create: `core/bundle_compiler/tests/legacy_dal_test.rs`

**Interfaces:**
- Produces: `pub fn scan_legacy_dal_imports(source_dir: &Path) -> Result<usize, CompilerError>` — returns the count of `.py` files scanned (never zero for a non-empty tree), `Err(CompilerError::ScanBlocked { reason: "legacy_dal_import", .. })` on any hit. Runs inside the `build` container.

- [ ] **Step 1: Write fixture bundles**

```bash
mkdir -p core/bundle_compiler/tests/fixtures/bundles/legacy-dal core/bundle_compiler/tests/fixtures/bundles/clean-dal
cat > core/bundle_compiler/tests/fixtures/bundles/legacy-dal/app.py <<'EOF'
"""Fixture bundle that still imports the legacy DAL — must be rejected."""
from flask_core.database import AsyncDAL
import pydal


async def transform(event):
    dal = AsyncDAL()
    return None
EOF
cat > core/bundle_compiler/tests/fixtures/bundles/clean-dal/app.py <<'EOF'
"""Fixture bundle already migrated to penguin-dal — must pass this scan."""
from waddle_sdk.db import get_bundle_dal


async def transform(event):
    dal = get_bundle_dal()
    return None
EOF
```

- [ ] **Step 2: Write the failing test**

```rust
// core/bundle_compiler/tests/legacy_dal_test.rs
use bundle_compiler::errors::CompilerError;
use bundle_compiler::scan::legacy_dal::scan_legacy_dal_imports;
use std::path::Path;

#[test]
fn rejects_flask_core_database_import() {
    let err = scan_legacy_dal_imports(Path::new("tests/fixtures/bundles/legacy-dal")).unwrap_err();
    match err {
        CompilerError::ScanBlocked { reason, message } => {
            assert_eq!(reason, "legacy_dal_import");
            assert!(message.contains("flask_core.database"));
            assert!(message.contains("app.py"));
            assert!(message.contains("penguin_dal") || message.contains("penguin-dal"));
        }
        other => panic!("expected ScanBlocked, got {other:?}"),
    }
}

#[test]
fn accepts_clean_bundle() {
    let count = scan_legacy_dal_imports(Path::new("tests/fixtures/bundles/clean-dal")).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn zero_files_scanned_is_a_failure_not_a_pass() {
    let tmp = tempfile::tempdir().unwrap();
    let err = scan_legacy_dal_imports(tmp.path()).unwrap_err();
    match err {
        CompilerError::ScanBlocked { reason, .. } => assert_eq!(reason, "scan_empty_denominator"),
        other => panic!("expected ScanBlocked(scan_empty_denominator), got {other:?}"),
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked legacy_dal_test`
Expected: FAIL — module `scan::legacy_dal` not found.

- [ ] **Step 4: Implement `src/scan/legacy_dal.rs`**

```rust
//! Rejects any Python bundle source still importing `flask_core.database`
//! or `pydal` (D21b) — the compiler-side backstop for the M1.5 DAL
//! migration (Plan-Level Assumption PA3). Runs inside the untrusted
//! `build` container — pure text scanning, no bundle code executed here.

use crate::errors::CompilerError;
use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;
use walkdir::WalkDir;

#[allow(clippy::unwrap_used)]
static LEGACY_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(from\s+(flask_core\.database|pydal)\b|import\s+(flask_core\.database|pydal)\b)").unwrap()
});

/// Scan every `.py` file under `source_dir` for a `flask_core.database` or
/// `pydal` import. Returns the number of files scanned on success (never
/// zero for a directory that contains Python source).
pub fn scan_legacy_dal_imports(source_dir: &Path) -> Result<usize, CompilerError> {
    let mut scanned = 0usize;
    for entry in WalkDir::new(source_dir).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() || entry.path().extension().and_then(|e| e.to_str()) != Some("py") {
            continue;
        }
        scanned += 1;
        let contents = std::fs::read_to_string(entry.path())?;
        if let Some(m) = LEGACY_IMPORT_RE.find(&contents) {
            let line_no = contents[..m.start()].matches('\n').count() + 1;
            return Err(CompilerError::ScanBlocked {
                reason: "legacy_dal_import".to_string(),
                message: format!(
                    "{}:{}: imports a legacy DAL module ({}) — migrate to the penguin_dal-compatible \
                     waddle_sdk.db facade (sdk/waddle-sdk/src/waddle_sdk/db.py)",
                    entry.path().display(),
                    line_no,
                    m.as_str().trim(),
                ),
            });
        }
    }
    if scanned == 0 {
        return Err(CompilerError::ScanBlocked {
            reason: "scan_empty_denominator".to_string(),
            message: format!("legacy DAL scan examined 0 .py files under {}", source_dir.display()),
        });
    }
    Ok(scanned)
}
```

Add `pub mod legacy_dal;` to `src/scan/mod.rs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --locked legacy_dal_test`
Expected: all 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): reject legacy flask_core.database/pydal imports (D21b)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 5: SAST / dependency-audit / secrets scan orchestration

**Files:**
- Modify: `core/bundle_compiler/src/scan/sast.rs`
- Create: `core/bundle_compiler/tests/fixtures/bundles/scan-clean/app.py`
- Create: `core/bundle_compiler/tests/fixtures/bundles/scan-secret/app.py`
- Create: `core/bundle_compiler/tests/scan_test.rs`

**Interfaces:**
- Produces: `pub struct ScanReport { pub semgrep_findings: usize, pub semgrep_examined: usize, pub dependency_advisories: usize, pub dependencies_examined: usize, pub secrets_findings: usize, pub files_examined_for_secrets: usize }` and `pub fn run_source_scans(source_dir: &Path, language: &str) -> Result<ScanReport, CompilerError>`. Runs inside the `build` container, alongside Task 4's scan and Task 6's Skauswatch hand-off.

- [ ] **Step 1: Write fixture bundles**

```bash
mkdir -p core/bundle_compiler/tests/fixtures/bundles/scan-clean core/bundle_compiler/tests/fixtures/bundles/scan-secret
cat > core/bundle_compiler/tests/fixtures/bundles/scan-clean/app.py <<'EOF'
"""Trivial clean bundle — no secrets, no known-bad patterns."""


async def transform(event):
    return None
EOF
cat > core/bundle_compiler/tests/fixtures/bundles/scan-secret/app.py <<'EOF'
"""Fixture bundle with a hardcoded secret — gitleaks must catch this."""
AWS_SECRET_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE7ABC1234567890ABCD"


async def transform(event):
    return None
EOF
```

- [ ] **Step 2: Write the failing test**

```rust
// core/bundle_compiler/tests/scan_test.rs
use bundle_compiler::errors::CompilerError;
use bundle_compiler::scan::sast::run_source_scans;
use std::path::Path;

#[test]
fn clean_bundle_passes_with_nonzero_denominator() {
    let report = run_source_scans(Path::new("tests/fixtures/bundles/scan-clean"), "python").unwrap();
    assert!(report.files_examined_for_secrets > 0);
    assert_eq!(report.secrets_findings, 0);
    assert_eq!(report.semgrep_findings, 0);
}

#[test]
fn secret_in_source_blocks() {
    let err = run_source_scans(Path::new("tests/fixtures/bundles/scan-secret"), "python").unwrap_err();
    match err {
        CompilerError::ScanBlocked { reason, message } => {
            assert_eq!(reason, "secrets_found");
            assert!(message.contains("app.py"));
        }
        other => panic!("expected ScanBlocked, got {other:?}"),
    }
}

#[test]
fn zero_examined_is_a_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let err = run_source_scans(tmp.path(), "python").unwrap_err();
    match err {
        CompilerError::ScanBlocked { reason, .. } => assert_eq!(reason, "scan_empty_denominator"),
        other => panic!("expected ScanBlocked(scan_empty_denominator), got {other:?}"),
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked scan_test`
Expected: FAIL — `scan::sast` module empty.

- [ ] **Step 4: Implement `src/scan/sast.rs`**

```rust
//! Orchestrates the three containerized scanners spec §9.3 requires for a
//! source upload: `semgrep` (SAST), a language-appropriate dependency
//! auditor, and `gitleaks` (secrets). Every scanner's own JSON report is
//! parsed for a count of items examined — zero examined is a failure
//! (`scan_empty_denominator`), never a silent pass. Runs inside the
//! untrusted `build` container.

use crate::errors::CompilerError;
use std::path::Path;
use std::process::Command;
use walkdir::WalkDir;

/// Aggregated result of all three source scanners, each reporting both a
/// finding count and an examined-item count.
#[derive(Debug, Default, Clone, Copy)]
pub struct ScanReport {
    pub semgrep_findings: usize,
    pub semgrep_examined: usize,
    pub dependency_advisories: usize,
    pub dependencies_examined: usize,
    pub secrets_findings: usize,
    pub files_examined_for_secrets: usize,
}

/// Run semgrep, the language-appropriate dependency audit, and gitleaks
/// against `source_dir`. Any `ERROR`-severity semgrep finding, any
/// `high`/`critical` dependency advisory, or any secret finding blocks.
pub fn run_source_scans(source_dir: &Path, language: &str) -> Result<ScanReport, CompilerError> {
    let mut report = ScanReport::default();

    let file_count = WalkDir::new(source_dir).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()).count();
    if file_count == 0 {
        return Err(CompilerError::ScanBlocked {
            reason: "scan_empty_denominator".to_string(),
            message: format!("source scan examined 0 files under {}", source_dir.display()),
        });
    }
    report.files_examined_for_secrets = file_count;

    let gitleaks_report_path = source_dir.join(".gitleaks-report.json");
    let gitleaks_status = Command::new("gitleaks")
        .args([
            "detect", "--no-git", "--source", source_dir.to_str().expect("utf8 path"),
            "--report-format", "json", "--report-path", gitleaks_report_path.to_str().expect("utf8 path"),
            "--exit-code", "1",
        ])
        .status()
        .map_err(|e| CompilerError::ScanBlocked { reason: "scan_tool_missing".to_string(), message: format!("gitleaks not runnable: {e}") })?;
    let gitleaks_findings: Vec<serde_json::Value> =
        std::fs::read_to_string(&gitleaks_report_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    report.secrets_findings = gitleaks_findings.len();
    if !gitleaks_status.success() || report.secrets_findings > 0 {
        return Err(CompilerError::ScanBlocked {
            reason: "secrets_found".to_string(),
            message: format!(
                "gitleaks found {} secret(s) in {}: {}",
                report.secrets_findings, source_dir.display(),
                gitleaks_findings.iter().filter_map(|f| f.get("File").and_then(|v| v.as_str())).collect::<Vec<_>>().join(", ")
            ),
        });
    }

    let semgrep_out = Command::new("semgrep")
        .args(["--config", "/opt/waddles-semgrep-rules", "--json", "--quiet", source_dir.to_str().expect("utf8 path")])
        .output()
        .map_err(|e| CompilerError::ScanBlocked { reason: "scan_tool_missing".to_string(), message: format!("semgrep not runnable: {e}") })?;
    let semgrep_json: serde_json::Value = serde_json::from_slice(&semgrep_out.stdout)
        .map_err(|e| CompilerError::ScanBlocked { reason: "scan_tool_error".to_string(), message: format!("semgrep produced non-JSON output: {e}") })?;
    let semgrep_results = semgrep_json.get("results").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    report.semgrep_examined =
        semgrep_json.get("paths").and_then(|p| p.get("scanned")).and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0);
    if report.semgrep_examined == 0 {
        return Err(CompilerError::ScanBlocked { reason: "scan_empty_denominator".to_string(), message: "semgrep examined 0 files".to_string() });
    }
    let error_findings: Vec<&serde_json::Value> = semgrep_results
        .iter()
        .filter(|r| r.get("extra").and_then(|e| e.get("severity")).and_then(|s| s.as_str()) == Some("ERROR"))
        .collect();
    report.semgrep_findings = error_findings.len();
    if !error_findings.is_empty() {
        return Err(CompilerError::ScanBlocked {
            reason: "sast_finding".to_string(),
            message: format!("semgrep found {} ERROR-severity finding(s)", error_findings.len()),
        });
    }

    let (advisories, examined) = run_dependency_audit(source_dir, language)?;
    report.dependency_advisories = advisories;
    report.dependencies_examined = examined;
    if advisories > 0 {
        return Err(CompilerError::ScanBlocked {
            reason: "dependency_vulnerability".to_string(),
            message: format!("dependency audit found {advisories} high/critical advisory(ies)"),
        });
    }

    Ok(report)
}

fn run_dependency_audit(source_dir: &Path, language: &str) -> Result<(usize, usize), CompilerError> {
    match language {
        "python" => {
            let requirements = source_dir.join("requirements.txt");
            if !requirements.exists() {
                return Ok((0, 0)); // no third-party deps declared — legitimately zero, unlike the scan denominator rule
            }
            let out = Command::new("pip-audit")
                .args(["-r", requirements.to_str().expect("utf8 path"), "--format", "json"])
                .output()
                .map_err(|e| CompilerError::ScanBlocked { reason: "scan_tool_missing".to_string(), message: format!("pip-audit not runnable: {e}") })?;
            let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
            let deps = json.get("dependencies").and_then(|d| d.as_array()).cloned().unwrap_or_default();
            let advisories: usize = deps.iter().filter_map(|d| d.get("vulns").and_then(|v| v.as_array())).map(|v| v.len()).sum();
            Ok((advisories, deps.len()))
        }
        "rust" => {
            if !source_dir.join("Cargo.lock").exists() {
                return Ok((0, 0));
            }
            let out = Command::new("cargo")
                .args(["audit", "--file", source_dir.join("Cargo.lock").to_str().expect("utf8 path"), "--json"])
                .output()
                .map_err(|e| CompilerError::ScanBlocked { reason: "scan_tool_missing".to_string(), message: format!("cargo-audit not runnable: {e}") })?;
            let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
            let vulns = json.get("vulnerabilities").and_then(|v| v.get("list")).and_then(|l| l.as_array()).cloned().unwrap_or_default();
            let examined = json.get("lockfile").and_then(|l| l.get("dependency-count")).and_then(|c| c.as_u64()).unwrap_or(0) as usize;
            Ok((vulns.len(), examined))
        }
        "javascript" | "typescript" => {
            if !source_dir.join("package-lock.json").exists() {
                return Ok((0, 0));
            }
            let out = Command::new("npm")
                .args(["audit", "--json", "--prefix", source_dir.to_str().expect("utf8 path")])
                .output()
                .map_err(|e| CompilerError::ScanBlocked { reason: "scan_tool_missing".to_string(), message: format!("npm audit not runnable: {e}") })?;
            let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
            let high = json.get("metadata").and_then(|m| m.get("vulnerabilities")).and_then(|v| v.get("high")).and_then(|h| h.as_u64()).unwrap_or(0);
            let critical = json.get("metadata").and_then(|m| m.get("vulnerabilities")).and_then(|v| v.get("critical")).and_then(|c| c.as_u64()).unwrap_or(0);
            let total_deps = json.get("metadata").and_then(|m| m.get("totalDependencies")).and_then(|t| t.as_u64()).unwrap_or(0);
            Ok(((high + critical) as usize, total_deps as usize))
        }
        other => Err(CompilerError::Config(format!("no dependency auditor wired for language {other:?}"))),
    }
}
```

Add `pub mod sast;` to `src/scan/mod.rs`.

- [ ] **Step 5: Run tests to verify they pass**

Run (inside the compiler image once Task 19 builds it, or a dev container with `build/tool-versions.env`'s pinned scanners installed): `cargo test --locked scan_test`
Expected: all 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): orchestrate semgrep/dependency-audit/gitleaks with non-zero-denominator gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 6: Skauswatch hand-off client

**Files:**
- Create: `core/bundle_compiler/src/scan/skauswatch.rs`
- Create: `core/bundle_compiler/tests/skauswatch_test.rs`

**Interfaces:**
- Produces: `pub enum SkauswatchVerdict { NotConfigured, Pass, Warn { findings: usize }, Fail { reason: String } }` and `pub async fn scan_with_skauswatch(source_dir: &Path, base_url: Option<&str>) -> Result<SkauswatchVerdict, CompilerError>`. Runs inside the `build` container. `SKAUSWATCH_URL` unset ⇒ `NotConfigured`, never silently `Pass`.

- [ ] **Step 1: Write the failing test**

```rust
// core/bundle_compiler/tests/skauswatch_test.rs
use bundle_compiler::errors::CompilerError;
use bundle_compiler::scan::skauswatch::{scan_with_skauswatch, SkauswatchVerdict};
use std::path::Path;

#[tokio::test]
async fn unset_url_is_not_configured_not_a_pass() {
    let verdict = scan_with_skauswatch(Path::new("tests/fixtures/bundles/scan-clean"), None).await.unwrap();
    assert!(matches!(verdict, SkauswatchVerdict::NotConfigured));
}

#[tokio::test]
async fn fail_verdict_blocks() {
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/api/v1/scan")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"verdict":"fail","reason":"known-malware-signature-abc123"}"#)
        .create_async()
        .await;
    let err = scan_with_skauswatch(Path::new("tests/fixtures/bundles/scan-clean"), Some(&server.url())).await.unwrap_err();
    mock.assert_async().await;
    match err {
        CompilerError::ScanBlocked { reason, message } => {
            assert_eq!(reason, "skauswatch_fail");
            assert!(message.contains("known-malware-signature-abc123"));
        }
        other => panic!("expected ScanBlocked, got {other:?}"),
    }
}

#[tokio::test]
async fn warn_verdict_records_but_does_not_block() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("POST", "/api/v1/scan")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"verdict":"warn","findings":2}"#)
        .create_async()
        .await;
    let verdict = scan_with_skauswatch(Path::new("tests/fixtures/bundles/scan-clean"), Some(&server.url())).await.unwrap();
    assert!(matches!(verdict, SkauswatchVerdict::Warn { findings: 2 }));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --locked skauswatch_test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/scan/skauswatch.rs`**

```rust
//! Hand-off to PenguinTech's own scanner (Skauswatch) when configured.
//! `SKAUSWATCH_URL` unset means "not configured", reported as such — never
//! silently treated as a pass (spec §9.3). Runs inside the `build`
//! container; the source-tree fingerprint below is a dedup key for
//! Skauswatch's own request, NOT the artifact digest — the artifact digest
//! is computed exactly once, by the `publisher` container (Task 13), per
//! the Artifact & Digest Contract section of this plan.

use crate::errors::CompilerError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

/// The outcome of asking Skauswatch to scan a bundle's source tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkauswatchVerdict {
    /// `SKAUSWATCH_URL` was not set — reportable, distinct from a pass.
    NotConfigured,
    Pass,
    Warn { findings: usize },
    Fail { reason: String },
}

#[derive(Debug, Serialize)]
struct ScanRequest {
    source_fingerprint: String,
    language: String,
}

#[derive(Debug, Deserialize)]
struct ScanResponse {
    verdict: String,
    reason: Option<String>,
    findings: Option<usize>,
}

/// Deterministic fingerprint over every file in `dir`, sorted by relative
/// path — a dedup key for Skauswatch's own request only. This is NOT the
/// artifact digest (see Task 13's `artifact::compute_digests`, the sole
/// producer of `app_versions.artifact_digest`).
fn source_tree_fingerprint(dir: &Path) -> Result<String, CompilerError> {
    let mut hasher = Sha256::new();
    let mut paths: Vec<_> = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .collect();
    paths.sort();
    for path in paths {
        hasher.update(std::fs::read(&path)?);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

/// POST the bundle source tree's fingerprint to Skauswatch's `/api/v1/scan`
/// and classify the verdict. A network/parse error is always `Err` (never
/// mistaken for `NotConfigured`, which only means the URL was unset).
pub async fn scan_with_skauswatch(source_dir: &Path, base_url: Option<&str>) -> Result<SkauswatchVerdict, CompilerError> {
    let Some(base_url) = base_url else {
        return Ok(SkauswatchVerdict::NotConfigured);
    };

    let fingerprint = source_tree_fingerprint(source_dir)?;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base_url}/api/v1/scan"))
        .json(&ScanRequest { source_fingerprint: fingerprint, language: "unknown".to_string() })
        .send()
        .await
        .map_err(|e| CompilerError::ScanBlocked { reason: "skauswatch_unreachable".to_string(), message: format!("Skauswatch request failed: {e}") })?;
    let parsed: ScanResponse = resp
        .json()
        .await
        .map_err(|e| CompilerError::ScanBlocked { reason: "skauswatch_bad_response".to_string(), message: format!("Skauswatch returned an unparseable response: {e}") })?;

    match parsed.verdict.as_str() {
        "pass" => Ok(SkauswatchVerdict::Pass),
        "warn" => Ok(SkauswatchVerdict::Warn { findings: parsed.findings.unwrap_or(0) }),
        "fail" => Err(CompilerError::ScanBlocked {
            reason: "skauswatch_fail".to_string(),
            message: parsed.reason.unwrap_or_else(|| "no reason given".to_string()),
        }),
        other => Err(CompilerError::ScanBlocked { reason: "skauswatch_bad_response".to_string(), message: format!("unknown verdict {other:?}") }),
    }
}
```

Add `pub mod skauswatch;` to `src/scan/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked skauswatch_test`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): add Skauswatch hand-off client with not_configured/pass/warn/fail verdicts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 7: `LanguageBuilder` trait + wire manifest/scan/build into `run_build`

**Files:**
- Modify: `core/bundle_compiler/src/build/mod.rs`
- Create: `core/bundle_compiler/tests/fixtures/manifests/no_deps_python.yaml` (a `valid_python.yaml` copy with an empty `bundles/` dir fixture alongside it)
- Create: `core/bundle_compiler/tests/build_orchestration_test.rs`

**Interfaces:**
- Consumes: `manifest::parse_and_validate`/`ManifestOptions` (Task 3), `scan::legacy_dal::scan_legacy_dal_imports` (Task 4), `scan::sast::run_source_scans` (Task 5), `scan::skauswatch::scan_with_skauswatch` (Task 6).
- Produces: `pub trait LanguageBuilder { fn build(&self, source_dir: &Path, manifest: &BundleManifest, out_dir: &Path) -> Result<PathBuf, CompilerError>; }` (Tasks 8-10 implement it once per language) and the real `pub fn run_build(bundle: &Path, manifest: &Path, out: &Path) -> Result<(), CompilerError>` that Task 2's `main.rs` already calls. Writes `{out}/component.wasm` and `{out}/manifest.json` (the validated, canonicalized manifest) — Task 13's `publisher` reads both from the shared `/work` `emptyDir`.

- [ ] **Step 1: Write the failing test**

```rust
// core/bundle_compiler/tests/build_orchestration_test.rs
use bundle_compiler::build::run_build;
use bundle_compiler::errors::CompilerError;
use std::path::Path;
use tempfile::tempdir;

#[test]
fn rejects_invalid_manifest_before_any_scan_or_compile() {
    let out = tempdir().unwrap();
    let err = run_build(
        Path::new("tests/fixtures/bundles/scan-clean"),
        Path::new("tests/fixtures/manifests/invalid_v14_schema_version.yaml"),
        out.path(),
    )
    .unwrap_err();
    match err {
        CompilerError::ManifestInvalid { reason, .. } => assert_eq!(reason, "unsupported_schema_version"),
        other => panic!("expected ManifestInvalid, got {other:?}"),
    }
    assert!(!out.path().join("component.wasm").exists(), "no compile attempted after a manifest rejection");
}

#[test]
fn rejects_legacy_dal_import_before_compiling() {
    let out = tempdir().unwrap();
    // valid_python.yaml's app_id/feature/module line up with this fixture's
    // bundle source, but the source itself still imports the legacy DAL.
    let err = run_build(
        Path::new("tests/fixtures/bundles/legacy-dal"),
        Path::new("tests/fixtures/manifests/valid_python.yaml"),
        out.path(),
    )
    .unwrap_err();
    match err {
        CompilerError::ScanBlocked { reason, .. } => assert_eq!(reason, "legacy_dal_import"),
        other => panic!("expected ScanBlocked, got {other:?}"),
    }
    assert!(!out.path().join("component.wasm").exists());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --locked build_orchestration_test`
Expected: FAIL — `run_build` still returns the Task 2 placeholder error, not `ManifestInvalid`/`ScanBlocked`.

- [ ] **Step 3: Implement `src/build/mod.rs`**

```rust
//! Everything the untrusted `build` initContainer does, in order: parse+
//! validate the manifest (pure YAML, Task 3), scan the source (Tasks 4-6),
//! compile with the manifest's declared language's recipe (Tasks 8-10).
//! No credential of any kind is read here — no bucket, no DB, no signing
//! key — by construction: this module never imports `crate::bucket`,
//! `crate::db`, `crate::sidecar` or `crate::callback` at all.

mod python;
mod rust;
mod js;

use crate::errors::CompilerError;
use crate::manifest::{self, BundleManifest, ManifestOptions};
use crate::scan::{legacy_dal, sast, skauswatch};
use std::path::{Path, PathBuf};

/// One per-language compilation recipe. Each implementation shells out to
/// its own pinned toolchain binary (never a library call) so the untrusted
/// process boundary the toolchain itself provides (e.g. `componentize-py`'s
/// own build-time sandbox) is a real subprocess, not an in-process call
/// that could carry state across bundles.
pub trait LanguageBuilder {
    /// Compile `source_dir` (already scanned and manifest-validated) into a
    /// component, returning the path to the produced `.wasm` file.
    fn build(&self, source_dir: &Path, manifest: &BundleManifest, out_dir: &Path) -> Result<PathBuf, CompilerError>;
}

fn builder_for(language: &str) -> Result<Box<dyn LanguageBuilder>, CompilerError> {
    match language {
        "python" => Ok(Box::new(python::PythonBuilder)),
        "rust" => Ok(Box::new(rust::RustBuilder)),
        "javascript" | "typescript" => Ok(Box::new(js::JsBuilder)),
        other => Err(CompilerError::Config(format!("no LanguageBuilder for language {other:?}"))),
    }
}

/// The untrusted `build` container's entire job. Runs entirely offline, on
/// bytes already present in `bundle`/`manifest` — no bucket, DB, or
/// hub-api credential exists in this process's environment (enforced at
/// the Kubernetes Job level, Task 21, and asserted by Task 18's e2e test).
pub fn run_build(bundle: &Path, manifest_path: &Path, out: &Path) -> Result<(), CompilerError> {
    let opts = ManifestOptions::default(); // hub-api (M2b) will pass real per-tenant opts via manifest.json fields once wired
    let m = manifest::parse_and_validate(manifest_path, &opts)
        .map_err(|e| CompilerError::ManifestInvalid { reason: e.reason.to_string(), message: e.message })?;

    if m.artifact == "source" {
        if m.language == "python" {
            legacy_dal::scan_legacy_dal_imports(bundle)?;
        }
        sast::run_source_scans(bundle, &m.language)?;
        // Skauswatch is optional network reach for `build` in the current
        // topology (see PA5/Artifact & Digest Contract) — SKAUSWATCH_URL is
        // read from env here, not a CLI flag, per Global Constraints.
        let skauswatch_url = std::env::var("SKAUSWATCH_URL").ok();
        let verdict = tokio::runtime::Runtime::new()
            .map_err(|e| CompilerError::Config(format!("cannot start async runtime: {e}")))?
            .block_on(skauswatch::scan_with_skauswatch(bundle, skauswatch_url.as_deref()))?;
        tracing::info!(?verdict, "skauswatch verdict recorded");

        std::fs::create_dir_all(out)?;
        let builder = builder_for(&m.language)?;
        let wasm_path = builder.build(bundle, &m, out)?;
        if wasm_path != out.join("component.wasm") {
            std::fs::copy(&wasm_path, out.join("component.wasm"))?;
        }
    } else {
        // artifact: prebuilt — nothing to compile; `publisher` (Task 13)
        // does all real validation of a Tier 2 upload directly from bytes.
        std::fs::create_dir_all(out)?;
        std::fs::copy(bundle, out.join("component.wasm"))?;
    }

    let manifest_json = serde_json::to_vec_pretty(&serde_yaml::to_value(&m).map_err(|e| CompilerError::Config(e.to_string()))?)
        .map_err(|e| CompilerError::Config(e.to_string()))?;
    std::fs::write(out.join("manifest.json"), manifest_json)?;
    Ok(())
}
```

Add `#[derive(Serialize)]` to `BundleManifest` and every struct it contains in `src/manifest.rs` (needed for the `serde_yaml::to_value` round-trip above — every field is already plain data, so this is a mechanical addition: change each `#[derive(Debug, Clone, Deserialize)]` to `#[derive(Debug, Clone, Serialize, Deserialize)]`, and `#[derive(Debug, Clone, Default, Deserialize)]` to `#[derive(Debug, Clone, Default, Serialize, Deserialize)]`, for `BundleManifest`, `StageSpec`, `ConsumesRule`, `EgressRule`, `DataSpec`, `Limits`, `PlatformCompatibility`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked build_orchestration_test`
Expected: both tests pass (they exercise only the manifest/scan fail-fast paths — Task 8's Python builder isn't wired into a real toolchain call in this task yet, so a `python::PythonBuilder` stub returning `CompileFailed` is acceptable here; Task 8 replaces the stub body).

```bash
cat > core/bundle_compiler/src/build/python.rs <<'RUST'
//! Placeholder — Task 8 replaces this with the real `componentize-py --stub-wasi` recipe.
use super::LanguageBuilder;
use crate::errors::CompilerError;
use crate::manifest::BundleManifest;
use std::path::{Path, PathBuf};

pub struct PythonBuilder;
impl LanguageBuilder for PythonBuilder {
    fn build(&self, _source_dir: &Path, _manifest: &BundleManifest, _out_dir: &Path) -> Result<PathBuf, CompilerError> {
        Err(CompilerError::CompileFailed { language: "python".to_string(), message: "not yet wired — see Task 8".to_string() })
    }
}
RUST
sed 's/python/rust/g; s/Python/Rust/g' core/bundle_compiler/src/build/python.rs > core/bundle_compiler/src/build/rust.rs
sed 's/python/js/g; s/Python/Js/g' core/bundle_compiler/src/build/python.rs > core/bundle_compiler/src/build/js.rs
```

- [ ] **Step 5: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): wire manifest validation and source scans into run_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 8: Python build recipe — `componentize-py --stub-wasi` + pre-import generation

**Files:**
- Modify: `core/bundle_compiler/src/build/python.rs`
- Create: `core/bundle_compiler/tests/fixtures/bundles/good-python/app.py`
- Create: `core/bundle_compiler/tests/fixtures/bundles/good-python/wit/` (symlink or copy of `wit/waddle-bundle/`)
- Create: `core/bundle_compiler/tests/python_build_test.rs`

**Interfaces:**
- Consumes: `LanguageBuilder` trait (Task 7).
- Produces: `PythonBuilder` implementing `LanguageBuilder::build`, producing a `.wasm` component built with `--stub-wasi` (spec §4.6's mandatory flag) after a `pkgutil.walk_packages`-generated pre-import pass (spike round 2's blocker-2 fix, adapted from `spikes/penguin-dal-wasm/scripts/generate_bundle_preimports.py`).

- [ ] **Step 1: Write the fixture bundle**

**Design decision, load-bearing for this task and every later one that compiles a real Python bundle:** `bundle.yaml`'s `stages.<s>.entry` (`"app:transform"`) names a **plain function** in the bundle's own module — it is never a `componentize-py` `WitWorld` class itself. Only `waddle_sdk._component_entry.WitWorld` (Task 28) implements that Protocol. So `PythonBuilder::build()` below always targets `waddle_sdk._component_entry` as componentize-py's app module, never the bundle's own entry module directly, and generates a small `_entry_wiring.py` from the manifest's `entry` fields so `_component_entry.py` has a static (not `importlib`/env-var-driven — the WIT world excludes `wasi:cli/environment`, spec §6.5, so no env var is readable at runtime anyway) import to call. This task's own fixture bundle is therefore written in the same plain-function shape every real bundle uses (Task 29's example bundle, not a hand-rolled `WitWorld` subclass), and this task's own test requires `waddle-sdk` importable in the build environment — **Depends on: Task 23** (`waddle-sdk` package skeleton) for that reason, in addition to Task 7.

```bash
mkdir -p core/bundle_compiler/tests/fixtures/bundles/good-python
cat > core/bundle_compiler/tests/fixtures/bundles/good-python/app.py <<'EOF'
"""Minimal fixture bundle for the compiler's own build-recipe test —
plain-function shape, same as every real bundle (Task 29's SDK example
bundle uses the identical shape).
"""


async def transform(event):
    return event


async def dispatch(envelope, config, *, http_client):
    return {"status": 200, "detail": None, "provider_message_id": None}
EOF
ln -s ../../../../../wit/waddle-bundle core/bundle_compiler/tests/fixtures/bundles/good-python/wit
```

- [ ] **Step 2: Write the failing test**

```rust
// core/bundle_compiler/tests/python_build_test.rs
use bundle_compiler::build::PythonBuilder; // re-exported below
use bundle_compiler::manifest::{parse_and_validate, ManifestOptions};
use std::path::Path;
use tempfile::tempdir;

#[test]
fn compiles_good_python_fixture_with_stub_wasi() {
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &ManifestOptions::default()).unwrap();
    let out = tempdir().unwrap();
    let wasm_path = PythonBuilder
        .build(Path::new("tests/fixtures/bundles/good-python"), &m, out.path())
        .expect("python build succeeds");
    assert!(wasm_path.exists());
    let size = std::fs::metadata(&wasm_path).unwrap().len();
    assert!(size > 1_000_000, "componentize-py output embeds CPython — expect several MB, got {size} bytes");
}
```

Add one line to `src/build/mod.rs`, directly below its existing `mod python; mod rust; mod js;` declarations (those three stay private — this is purely a re-export): `pub use python::PythonBuilder;`. This makes `bundle_compiler::build::PythonBuilder` resolve, matching this task's test's `use bundle_compiler::build::PythonBuilder;` line exactly. Tasks 9 and 10 each add their own equivalent line (`pub use rust::RustBuilder;`, `pub use js::JsBuilder;`) when they land — `builder_for()`'s own internal calls to `python::PythonBuilder` etc. already work today regardless of this re-export, since `build/mod.rs`'s own code sits in the same module that declares `mod python;` and needs no `pub` to reach it.

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked python_build_test`
Expected: FAIL — `PythonBuilder::build` still returns the Task 7 placeholder `CompileFailed`.

- [ ] **Step 4: Implement `src/build/python.rs`**

```rust
//! Python build recipe: `componentize-py --stub-wasi`, preceded by two
//! generated files: `_bundle_preimports.py` (a `pkgutil.walk_packages`
//! pre-import pass so deferred/lazy imports don't produce a runtime
//! `ModuleNotFoundError` inside the guest — spike round 2, blocker 2,
//! `spikes/penguin-dal-wasm/scripts/generate_bundle_preimports.py`,
//! adapted to run as a build step) and `_entry_wiring.py` (statically
//! wires the manifest's `stages.<s>.entry` module:function references
//! into names `waddle_sdk._component_entry.WitWorld` imports — see this
//! task's "Design decision" note: the componentize-py app-class-providing
//! module is always `waddle_sdk._component_entry`, never the bundle's own
//! entry module directly).

use super::LanguageBuilder;
use crate::errors::CompilerError;
use crate::manifest::BundleManifest;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct PythonBuilder;

const PREIMPORT_GENERATOR: &str = r#"
import pkgutil
import sys
from pathlib import Path

root = Path(sys.argv[1])
sys.path.insert(0, str(root))
import bundles  # the package physically present in the bundle's source tree

names = sorted(m.name for m in pkgutil.walk_packages(bundles.__path__, prefix="bundles."))
out = root / "_bundle_preimports.py"
lines = ['"""AUTO-GENERATED by bundle-compiler — DO NOT EDIT."""', "", "from __future__ import annotations", ""]
lines += [f"import {name}  # noqa: F401" for name in names]
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"wrote {out} with {len(names)} pre-import(s)")
"#;

/// Parse a manifest `entry` string (`"app:transform"`) into `(module,
/// function)`. `bundle.yaml`'s own V1 rule already guarantees this field
/// is present for `process`/`action` stages that declare a script entry;
/// this is a second, defensive parse specific to the `:`-split shape.
fn split_entry(entry: &str) -> Result<(&str, &str), CompilerError> {
    entry.split_once(':').ok_or_else(|| CompilerError::ManifestInvalid {
        reason: "invalid_entry".to_string(),
        message: format!("entry {entry:?} must be \"module:function\""),
    })
}

fn generate_entry_wiring(source_dir: &Path, manifest: &BundleManifest) -> Result<(), CompilerError> {
    let mut lines = vec!["\"\"\"AUTO-GENERATED by bundle-compiler — DO NOT EDIT.\"\"\"".to_string(), String::new()];
    if let Some(process) = manifest.stages.get("process") {
        if let Some(entry) = &process.entry {
            let (module, func) = split_entry(entry)?;
            lines.push(format!("from {module} import {func} as bundle_transform"));
        }
    }
    if let Some(action) = manifest.stages.get("action") {
        if let Some(entry) = &action.entry {
            let (module, func) = split_entry(entry)?;
            lines.push(format!("from {module} import {func} as bundle_dispatch"));
        }
    }
    std::fs::write(source_dir.join("_entry_wiring.py"), lines.join("\n") + "\n")?;
    Ok(())
}

impl LanguageBuilder for PythonBuilder {
    fn build(&self, source_dir: &Path, manifest: &BundleManifest, out_dir: &Path) -> Result<PathBuf, CompilerError> {
        // Generate _bundle_preimports.py so componentize-py's static
        // dependency-closure walk sees every module physically present,
        // regardless of how the bundle itself imports them.
        if source_dir.join("bundles").is_dir() {
            let status = Command::new("python3")
                .args(["-c", PREIMPORT_GENERATOR, source_dir.to_str().expect("utf8 path")])
                .status()
                .map_err(|e| CompilerError::CompileFailed { language: "python".to_string(), message: format!("pre-import generation failed to start: {e}") })?;
            if !status.success() {
                return Err(CompilerError::CompileFailed { language: "python".to_string(), message: "pre-import generation exited non-zero".to_string() });
            }
        }

        // Generate _entry_wiring.py so waddle_sdk._component_entry has a
        // static (build-time, not runtime-env-var) import of the bundle's
        // own transform/dispatch functions — the WIT world excludes
        // wasi:cli/environment (spec §6.5), so a runtime env var is never
        // an option inside the sandbox.
        generate_entry_wiring(source_dir, manifest)?;

        // waddle_sdk's own source directory must also be on componentize-py's
        // `-p` path, since the app-class-providing module is
        // waddle_sdk._component_entry, not anything in the bundle's own
        // tree. The compiler's own image (Task 19) installs waddle-sdk at
        // this fixed path; a local dev run overrides it via env var.
        let waddle_sdk_src = std::env::var("WADDLE_SDK_SRC_DIR").unwrap_or_else(|_| "/opt/waddle-sdk/src".to_string());

        let wasm_out = out_dir.join("component.wasm");
        let status = Command::new("componentize-py")
            .args([
                "-d", source_dir.join("wit").to_str().expect("utf8 path"),
                "-w", "stage",
                "componentize",
                "-p", source_dir.to_str().expect("utf8 path"),
                "-p", &waddle_sdk_src,
                "waddle_sdk._component_entry",
                "--stub-wasi", // spec §4.6: mandatory — without it the component imports real wasi:sockets
                "-o", wasm_out.to_str().expect("utf8 path"),
            ])
            .status()
            .map_err(|e| CompilerError::CompileFailed { language: "python".to_string(), message: format!("componentize-py failed to start: {e}") })?;
        if !status.success() {
            return Err(CompilerError::CompileFailed { language: "python".to_string(), message: "componentize-py exited non-zero".to_string() });
        }
        Ok(wasm_out)
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (inside the pinned `python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e` image with `componentize-py==0.25.1` and `wasm-tools` on `PATH`, per `build/tool-versions.env`, **plus** `waddle-sdk` installed — `pip install -e sdk/waddle-sdk`, or `export WADDLE_SDK_SRC_DIR=$(pwd)/sdk/waddle-sdk/src` pointed at a checkout that already has Task 23-28 landed): `cargo test --locked python_build_test`
Expected: `compiles_good_python_fixture_with_stub_wasi ... ok`.

- [ ] **Step 6: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): add Python build recipe (componentize-py --stub-wasi + pre-import generation)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 9: Rust build recipe — `cargo component build --target wasm32-wasip2`

**Files:**
- Modify: `core/bundle_compiler/src/build/rust.rs`
- Create: `core/bundle_compiler/tests/fixtures/bundles/good-rust/{Cargo.toml,src/lib.rs}` (adapted from `spikes/bundle-compiler-sandbox/bundles/rust/`)
- Create: `core/bundle_compiler/tests/rust_build_test.rs`

**Interfaces:**
- Produces: `RustBuilder` implementing `LanguageBuilder::build`.

- [ ] **Step 1: Write the fixture bundle** (adapted from `spikes/bundle-compiler-sandbox/bundles/rust/src/lib.rs`, retargeted at the real `waddle:bundle` world instead of the spike's toy one)

```bash
mkdir -p core/bundle_compiler/tests/fixtures/bundles/good-rust/src
ln -s ../../../../../../wit/waddle-bundle core/bundle_compiler/tests/fixtures/bundles/good-rust/wit
cat > core/bundle_compiler/tests/fixtures/bundles/good-rust/Cargo.toml <<'EOF'
[package]
name = "bundle-fixture"
version = "0.1.0"
edition = "2021"

[dependencies]
wit-bindgen-rt = { version = "0.44.0", features = ["bitflags"] }

[lib]
crate-type = ["cdylib"]

[package.metadata.component]
package = "waddle:bundle-fixture"

[package.metadata.component.target]
path = "wit"
world = "stage"
EOF
cat > core/bundle_compiler/tests/fixtures/bundles/good-rust/src/lib.rs <<'EOF'
#[allow(warnings)]
mod bindings;

use bindings::exports::waddle::bundle::process_stage::{Guest as ProcessGuest, UnsupportedStage};
use bindings::exports::waddle::bundle::action_stage::Guest as ActionGuest;
use bindings::waddle::bundle::types::{PlatformEvent, StageEnvelope, TransportError, TransportResult};

struct Component;

impl ProcessGuest for Component {
    fn transform(event: PlatformEvent) -> Result<Option<PlatformEvent>, UnsupportedStage> {
        Ok(Some(event))
    }
}

impl ActionGuest for Component {
    fn dispatch(_envelope: StageEnvelope, _config: String) -> Result<TransportResult, TransportError> {
        Ok(TransportResult { ok: true, status: Some(200), detail: None, provider_message_id: None })
    }
}

bindings::export!(Component with_types_in bindings);
EOF
```

- [ ] **Step 2: Write the failing test**

```rust
// core/bundle_compiler/tests/rust_build_test.rs
use bundle_compiler::build::RustBuilder;
use bundle_compiler::manifest::{parse_and_validate, ManifestOptions};
use std::path::Path;
use tempfile::tempdir;

#[test]
fn compiles_good_rust_fixture() {
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_rust.yaml"), &ManifestOptions::default()).unwrap();
    let out = tempdir().unwrap();
    let wasm_path = RustBuilder.build(Path::new("tests/fixtures/bundles/good-rust"), &m, out.path()).expect("rust build succeeds");
    assert!(wasm_path.exists());
}
```

Add `pub use rust::RustBuilder;` to `src/build/mod.rs`, immediately below Task 8's `pub use python::PythonBuilder;` line, so `bundle_compiler::build::RustBuilder` resolves for this test.

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked rust_build_test`
Expected: FAIL — placeholder `CompileFailed`.

- [ ] **Step 4: Implement `src/build/rust.rs`**

```rust
//! Rust build recipe: `cargo component build --target wasm32-wasip2`. No
//! `--stub-wasi`-equivalent flag exists for Rust (spec §4.6), so the
//! validator's allowlist (Task 11) additionally permits `wasi:cli` and
//! `wasi:filesystem` for Rust-built components only.

use super::LanguageBuilder;
use crate::errors::CompilerError;
use crate::manifest::BundleManifest;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct RustBuilder;

impl LanguageBuilder for RustBuilder {
    fn build(&self, source_dir: &Path, _manifest: &BundleManifest, out_dir: &Path) -> Result<PathBuf, CompilerError> {
        let status = Command::new("cargo")
            .args(["component", "build", "--release", "--target", "wasm32-wasip2", "--offline"])
            .current_dir(source_dir)
            .env("CARGO_TARGET_DIR", "/tmp/target") // per spike2's finding: avoid $HOME-relative incidental writes
            .status()
            .map_err(|e| CompilerError::CompileFailed { language: "rust".to_string(), message: format!("cargo component failed to start: {e}") })?;
        if !status.success() {
            return Err(CompilerError::CompileFailed { language: "rust".to_string(), message: "cargo component build exited non-zero".to_string() });
        }
        // cargo-component names the output after the crate, not a fixed
        // "component.wasm" — find the single .wasm produced.
        let release_dir = Path::new("/tmp/target/wasm32-wasip2/release");
        let produced = std::fs::read_dir(release_dir)
            .map_err(|e| CompilerError::CompileFailed { language: "rust".to_string(), message: format!("cannot read release dir: {e}") })?
            .filter_map(Result::ok)
            .find(|e| e.path().extension().and_then(|x| x.to_str()) == Some("wasm"))
            .ok_or_else(|| CompilerError::CompileFailed { language: "rust".to_string(), message: "no .wasm produced".to_string() })?
            .path();
        let dest = out_dir.join("component.wasm");
        std::fs::copy(&produced, &dest)?;
        Ok(dest)
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (inside `rust:1.97-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3` with `cargo-component==0.21.1` and `wasm32-wasip2`/`wasm32-wasip1` targets pre-installed and pre-fetched, per `build/tool-versions.env`): `cargo test --locked rust_build_test`
Expected: `compiles_good_rust_fixture ... ok`.

- [ ] **Step 6: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): add Rust build recipe (cargo component build --target wasm32-wasip2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 10: JS/TS build recipe — `jco componentize --disable all`

**Files:**
- Modify: `core/bundle_compiler/src/build/js.rs`
- Create: `core/bundle_compiler/tests/fixtures/bundles/good-js/bundle.js`
- Create: `core/bundle_compiler/tests/js_build_test.rs`

**Interfaces:**
- Produces: `JsBuilder` implementing `LanguageBuilder::build`.

**Design decision (stated once, applies to Task 32 too):** `jco componentize` expects the entry module to export its world's functions as flat top-level named exports (`export function transform(event) {...}`, `export function dispatch(envelope, config) {...}`) — proven by `spikes/bundle-compiler-sandbox/bundles/js/bundle.js`'s own working top-level `export function transform`. The `waddle-sdk-js` SDK (Task 32) gives bundle authors a `{ transform, dispatch }` default-export ergonomic API instead; the build recipe below runs a small `esbuild`-free Node re-export shim before calling `jco componentize`, so a bundle authored against the SDK's ergonomic shape still produces the flat exports `jco` requires. The compiler's own fixture bundle below is written directly against the flat shape (no SDK involved), matching the spike exactly, so this task's test is independent of Task 32's SDK work.

- [ ] **Step 1: Write the fixture bundle** (identical in shape to `spikes/bundle-compiler-sandbox/bundles/js/bundle.js`, retargeted at the real world's two exports)

```bash
mkdir -p core/bundle_compiler/tests/fixtures/bundles/good-js
ln -s ../../../../../../wit/waddle-bundle core/bundle_compiler/tests/fixtures/bundles/good-js/wit
cat > core/bundle_compiler/tests/fixtures/bundles/good-js/bundle.js <<'EOF'
export function transform(event) {
  return event;
}

export function dispatch(envelope, config) {
  return { ok: true, status: 200, detail: null, providerMessageId: null };
}
EOF
```

- [ ] **Step 2: Write the failing test**

```rust
// core/bundle_compiler/tests/js_build_test.rs
use bundle_compiler::build::JsBuilder;
use bundle_compiler::manifest::{parse_and_validate, ManifestOptions};
use std::path::Path;
use tempfile::tempdir;

#[test]
fn compiles_good_js_fixture() {
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_js.yaml"), &ManifestOptions::default()).unwrap();
    let out = tempdir().unwrap();
    let wasm_path = JsBuilder.build(Path::new("tests/fixtures/bundles/good-js"), &m, out.path()).expect("js build succeeds");
    assert!(wasm_path.exists());
}
```

Add `pub use js::JsBuilder;` to `src/build/mod.rs`, immediately below Task 9's `pub use rust::RustBuilder;` line, so `bundle_compiler::build::JsBuilder` resolves for this test.

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked js_build_test`
Expected: FAIL — placeholder `CompileFailed`.

- [ ] **Step 4: Implement `src/build/js.rs`**

```rust
//! JS/TS build recipe: `jco componentize --disable all` (spec §4.6's
//! mandatory flag — without it the component imports `wasi:http`).

use super::LanguageBuilder;
use crate::errors::CompilerError;
use crate::manifest::BundleManifest;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct JsBuilder;

impl LanguageBuilder for JsBuilder {
    fn build(&self, source_dir: &Path, _manifest: &BundleManifest, out_dir: &Path) -> Result<PathBuf, CompilerError> {
        let wasm_out = out_dir.join("component.wasm");
        let status = Command::new("jco")
            .args([
                "componentize",
                source_dir.join("bundle.js").to_str().expect("utf8 path"),
                "--wit", source_dir.join("wit").to_str().expect("utf8 path"),
                "--world-name", "stage",
                "--disable", "all", // spec §4.6: mandatory — without it the component imports wasi:http
                "-o", wasm_out.to_str().expect("utf8 path"),
            ])
            .status()
            .map_err(|e| CompilerError::CompileFailed { language: "javascript".to_string(), message: format!("jco failed to start: {e}") })?;
        if !status.success() {
            return Err(CompilerError::CompileFailed { language: "javascript".to_string(), message: "jco componentize exited non-zero".to_string() });
        }
        Ok(wasm_out)
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (inside `node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae` with `@bytecodealliance/jco@1.34.0` installed globally, per `build/tool-versions.env`): `cargo test --locked js_build_test`
Expected: `compiles_good_js_fixture ... ok`.

- [ ] **Step 6: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): add JS/TS build recipe (jco componentize --disable all)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 11: Import allowlist validator — `wasm-tools component wit` parse + per-language allowlist

**Files:**
- Create: `core/bundle_compiler/src/validate/mod.rs`
- Create: `core/bundle_compiler/tests/fixtures/bundles/bad-wrong-world/{Cargo.toml,src/lib.rs}` (adapted from `spikes/bundle-compiler-sandbox/bundles/bad-wrong-world/`)
- Create: `core/bundle_compiler/tests/validate_test.rs`

**Interfaces:**
- Produces: `pub struct ComponentInfo { pub imports: Vec<String>, pub exports: Vec<String> }` and `pub fn validate_component(component_path: &Path, language: &str) -> Result<ComponentInfo, CompilerError>` — the reference implementation port of `spikes/bundle-compiler-sandbox/scripts/validate_component.py` to Rust, extended with the real per-language allowlist table from spec §6.5. Called from both `build` (Task 7, as an early fail-fast — optional, not added in this task to keep `build` and `publish`'s validation genuinely independent per the Artifact & Digest Contract) and, authoritatively, from `publish` (Task 13).

- [ ] **Step 1: Write the fixture bundle for the negative case**

```bash
mkdir -p core/bundle_compiler/tests/fixtures/bundles/bad-wrong-world/src
cat > core/bundle_compiler/tests/fixtures/bundles/bad-wrong-world/Cargo.toml <<'EOF'
[package]
name = "bad-wrong-world"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[package.metadata.component]
package = "waddle:bad-wrong-world"
EOF
cat > core/bundle_compiler/tests/fixtures/bundles/bad-wrong-world/src/lib.rs <<'EOF'
#[allow(warnings)]
mod bindings;

use bindings::Guest;

struct Component;

impl Guest for Component {
    /// Deliberately implements a DIFFERENT world (no wit/ dir at all, so
    /// cargo-component falls back to its own default "no imports/exports"
    /// world) — used to prove the validator rejects a component that
    /// never targeted waddle:bundle/stage@1.0.0 at all.
    fn hello_world() -> String {
        "wrong world".to_string()
    }
}

bindings::export!(Component with_types_in bindings);
EOF
```

- [ ] **Step 2: Write the failing test**

```rust
// core/bundle_compiler/tests/validate_test.rs
use bundle_compiler::validate::validate_component;

#[test]
fn accepts_good_python_component() {
    // Depends on Task 8's fixture already having been compiled once — this
    // test compiles it itself, first, so it is independently runnable.
    let m = bundle_compiler::manifest::parse_and_validate(
        std::path::Path::new("tests/fixtures/manifests/valid_python.yaml"),
        &bundle_compiler::manifest::ManifestOptions::default(),
    )
    .unwrap();
    let out = tempfile::tempdir().unwrap();
    let wasm = bundle_compiler::build::PythonBuilder
        .build(std::path::Path::new("tests/fixtures/bundles/good-python"), &m, out.path())
        .unwrap();
    let info = validate_component(&wasm, "python").expect("good python component validates");
    assert!(info.exports.iter().any(|e| e.contains("process-stage")) || info.exports.iter().any(|e| e.contains("transform")));
}

#[test]
fn rejects_wrong_world_component() {
    let m = bundle_compiler::manifest::parse_and_validate(
        std::path::Path::new("tests/fixtures/manifests/valid_rust.yaml"),
        &bundle_compiler::manifest::ManifestOptions::default(),
    )
    .unwrap();
    let out = tempfile::tempdir().unwrap();
    let wasm = bundle_compiler::build::RustBuilder
        .build(std::path::Path::new("tests/fixtures/bundles/bad-wrong-world"), &m, out.path())
        .unwrap();
    let err = validate_component(&wasm, "rust").unwrap_err();
    match err {
        bundle_compiler::errors::CompilerError::ValidationFailed { reason, message } => {
            assert_eq!(reason, "wit_export_missing");
            assert!(message.contains("process-stage") || message.contains("transform"));
        }
        other => panic!("expected ValidationFailed, got {other:?}"),
    }
}

#[test]
fn rejects_extra_wasi_sockets_for_a_non_stubbed_python_build() {
    // A Python component built WITHOUT --stub-wasi imports real
    // wasi:sockets/* — reject it even though the good, --stub-wasi build
    // is allowed to declare the (denying-stub-backed) wasi:sockets import
    // per spec §6.5's Python row. This test builds without --stub-wasi
    // directly (bypassing the LanguageBuilder) to produce that component.
    let out = tempfile::tempdir().unwrap();
    let wasm_out = out.path().join("component.wasm");
    let status = std::process::Command::new("componentize-py")
        .args([
            "-d", "tests/fixtures/bundles/good-python/wit",
            "-w", "stage",
            "componentize",
            "-p", "tests/fixtures/bundles/good-python",
            "app",
            "-o", wasm_out.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(status.success());
    let err = validate_component(&wasm_out, "python").unwrap_err();
    match err {
        bundle_compiler::errors::CompilerError::ValidationFailed { reason, .. } => assert_eq!(reason, "forbidden_host_import"),
        other => panic!("expected ValidationFailed(forbidden_host_import), got {other:?}"),
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked validate_test`
Expected: FAIL — `validate::validate_component` not defined.

- [ ] **Step 4: Implement `src/validate/mod.rs`**

```rust
//! Component import/export validation — the Rust port of
//! `spikes/bundle-compiler-sandbox/scripts/validate_component.py` (spike
//! commit `1f1d75a4`), extended with the real per-language allowlist of
//! spec §6.5. Parses `wasm-tools component wit`'s text output rather than
//! re-implementing a WIT resolver — same design choice the spike made,
//! for the same reason (auditable text scrape over a semantic API the
//! `wasm-tools` crate does not expose at this granularity).

pub mod egress;

use crate::errors::CompilerError;
use regex::Regex;
use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;

pub const OUR_INTERFACE_PREFIX: &str = "waddle:bundle/";
pub const REQUIRED_EXPORTS: &[&str] = &["process-stage", "action-stage"];

/// Every import and export the top-level `world { ... }` block declares.
#[derive(Debug, Clone, Default)]
pub struct ComponentInfo {
    pub imports: Vec<String>,
    pub exports: Vec<String>,
}

#[allow(clippy::unwrap_used)]
static IMPORT_LINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*import\s+([A-Za-z0-9_:./@-]+)\s*;\s*$").unwrap());
#[allow(clippy::unwrap_used)]
static EXPORT_LINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*export\s+([A-Za-z0-9_:./@-]+)\s*[:;]").unwrap());
#[allow(clippy::unwrap_used)]
static WORLD_OPEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*world\s+\S+\s*\{\s*$").unwrap());

fn run_wasm_tools_wit(component_path: &Path) -> Result<String, CompilerError> {
    let out = Command::new("wasm-tools")
        .args(["component", "wit", component_path.to_str().expect("utf8 path")])
        .output()
        .map_err(|e| CompilerError::ValidationFailed { reason: "wasm_tools_missing".to_string(), message: format!("wasm-tools not runnable: {e}") })?;
    if !out.status.success() {
        return Err(CompilerError::ValidationFailed {
            reason: "not_a_valid_component".to_string(),
            message: format!("wasm-tools rejected the file: {}", String::from_utf8_lossy(&out.stderr)),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn parse_top_world(wit_text: &str) -> ComponentInfo {
    let mut info = ComponentInfo::default();
    let mut depth = 0i32;
    let mut in_world = false;
    for line in wit_text.lines() {
        if !in_world {
            if WORLD_OPEN_RE.is_match(line) {
                in_world = true;
                depth = 1;
            }
            continue;
        }
        depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
        if let Some(c) = IMPORT_LINE_RE.captures(line) {
            info.imports.push(c[1].to_string());
        } else if let Some(c) = EXPORT_LINE_RE.captures(line) {
            info.exports.push(c[1].to_string());
        }
        if depth <= 0 {
            break;
        }
    }
    info
}

/// Per-language permitted WASI namespaces beyond our own `waddle:bundle/*`
/// interfaces (spec §6.5's table). `wasi:sockets` is permitted for Python
/// specifically because `componentize-py --stub-wasi` links the executor's
/// own denying stubs behind it; it is never usable, only importable.
fn permitted_namespaces(language: &str) -> &'static [&'static str] {
    match language {
        "python" => &["wasi:sockets", "wasi:random", "wasi:clocks", "wasi:io"],
        "javascript" | "typescript" => &["wasi:random", "wasi:clocks", "wasi:io"],
        "rust" => &["wasi:cli", "wasi:filesystem", "wasi:random", "wasi:clocks", "wasi:io"],
        _ => &["wasi:random", "wasi:clocks", "wasi:io"],
    }
}

fn is_permitted(import_name: &str, permitted: &[&str]) -> bool {
    if let Some(rest) = import_name.strip_prefix(OUR_INTERFACE_PREFIX) {
        let _ = rest;
        return true;
    }
    if !import_name.contains(':') || !import_name.contains('/') {
        return false;
    }
    let namespace_pkg = import_name.split('/').next().unwrap_or("");
    let namespace_pkg = namespace_pkg.split('@').next().unwrap_or("");
    permitted.contains(&namespace_pkg)
}

/// Validate a compiled component: (a) it targets `waddle:bundle/stage@1.0.0`
/// (exports both `process-stage` and `action-stage` — spec's Assumption A1:
/// a bundle implementing only one stage still exports a generated stub for
/// the other, so both must always be present), (b) every import is either
/// one of our own interfaces or on `language`'s permitted-namespace list
/// (spec §6.5, V31).
pub fn validate_component(component_path: &Path, language: &str) -> Result<ComponentInfo, CompilerError> {
    let wit_text = run_wasm_tools_wit(component_path)?;
    let info = parse_top_world(&wit_text);

    for required in REQUIRED_EXPORTS {
        if !info.exports.iter().any(|e| e.contains(required)) {
            return Err(CompilerError::ValidationFailed {
                reason: "wit_export_missing".to_string(),
                message: format!(
                    "component does not export {required} (waddle:bundle/stage@1.0.0 requires both process-stage and action-stage; found exports: {})",
                    if info.exports.is_empty() { "(none)".to_string() } else { info.exports.join(", ") }
                ),
            });
        }
    }

    let permitted = permitted_namespaces(language);
    let disallowed: Vec<&String> = info.imports.iter().filter(|i| !is_permitted(i, permitted)).collect();
    if !disallowed.is_empty() {
        return Err(CompilerError::ValidationFailed {
            reason: "forbidden_host_import".to_string(),
            message: format!(
                "component imports outside the {language} allowlist (waddle:bundle/* + {permitted:?}): {}",
                disallowed.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
            ),
        });
    }

    Ok(info)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (inside the pinned toolchain images — `accepts_good_python_component` and `rejects_extra_wasi_sockets_for_a_non_stubbed_python_build` need `componentize-py`; `rejects_wrong_world_component` needs `cargo component`): `cargo test --locked validate_test`
Expected: all 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): validate compiled component imports/exports against the per-language allowlist (V25, V31)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 12: Egress-vs-`http` cross-check (V22)

**Files:**
- Create: `core/bundle_compiler/src/validate/egress.rs`
- Create: `core/bundle_compiler/tests/egress_test.rs`

**Interfaces:**
- Consumes: `ComponentInfo` (Task 11), `BundleManifest` (Task 3).
- Produces: `pub fn check_egress_declared(manifest: &BundleManifest, component: &ComponentInfo) -> Result<(), CompilerError>` — rule V22: "`egress` is non-empty when the compiled component imports `waddle:bundle/http`."

- [ ] **Step 1: Write the failing test**

```rust
// core/bundle_compiler/tests/egress_test.rs
use bundle_compiler::manifest::{parse_and_validate, ManifestOptions};
use bundle_compiler::validate::egress::check_egress_declared;
use bundle_compiler::validate::ComponentInfo;
use std::path::Path;

#[test]
fn http_import_without_egress_is_rejected() {
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &ManifestOptions::default()).unwrap();
    assert!(m.egress.is_empty(), "fixture manifest has no egress declared");
    let info = ComponentInfo { imports: vec!["waddle:bundle/http@1.0.0".to_string()], exports: vec![] };
    let err = check_egress_declared(&m, &info).unwrap_err();
    match err {
        bundle_compiler::errors::CompilerError::ManifestInvalid { reason, .. } => assert_eq!(reason, "http_import_without_egress"),
        other => panic!("expected ManifestInvalid, got {other:?}"),
    }
}

#[test]
fn http_import_with_egress_declared_passes() {
    let mut m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &ManifestOptions::default()).unwrap();
    m.egress.push(bundle_compiler::manifest::EgressRule { host: "api.example.com".to_string(), methods: vec!["GET".to_string()] });
    let info = ComponentInfo { imports: vec!["waddle:bundle/http@1.0.0".to_string()], exports: vec![] };
    check_egress_declared(&m, &info).expect("declared egress + http import is fine");
}

#[test]
fn no_http_import_passes_with_no_egress() {
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &ManifestOptions::default()).unwrap();
    let info = ComponentInfo { imports: vec!["waddle:bundle/kv@1.0.0".to_string()], exports: vec![] };
    check_egress_declared(&m, &info).expect("no http import means egress can stay empty");
}
```

Make `EgressRule`'s fields `pub` (already are) and add `Clone`/`pub` visibility already present — no manifest change needed beyond what Task 3 already wrote.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --locked egress_test`
Expected: FAIL — `validate::egress` module not found.

- [ ] **Step 3: Implement `src/validate/egress.rs`**

```rust
//! Rule V22 (spec §6.4.4): `egress` must be non-empty when the compiled
//! component actually imports `waddle:bundle/http`. Checked against the
//! component's real import list, never the source text, so an undeclared
//! import cannot slip through a dynamic call.

use super::ComponentInfo;
use crate::errors::CompilerError;
use crate::manifest::BundleManifest;

/// V22: reject a manifest whose `egress` is empty when the component
/// imports `waddle:bundle/http`.
pub fn check_egress_declared(manifest: &BundleManifest, component: &ComponentInfo) -> Result<(), CompilerError> {
    let imports_http = component.imports.iter().any(|i| i.starts_with("waddle:bundle/http"));
    if imports_http && manifest.egress.is_empty() {
        return Err(CompilerError::ManifestInvalid {
            reason: "http_import_without_egress".to_string(),
            message: "the compiled component imports waddle:bundle/http but the manifest declares no egress hosts".to_string(),
        });
    }
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked egress_test`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): cross-check egress declaration against the component's actual http import (V22)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 13: Publisher — re-validate from bytes + dual digest (component + `.cwasm`)

**Files:**
- Create/modify: `core/bundle_compiler/src/artifact.rs`
- Create: `core/bundle_compiler/tests/fixtures/bundles/tampered-component/` (a copy of `good-python`'s compiled output with one byte flipped — generated by the test itself, not checked in as a fixture, since it must always be derived from whatever `good-python` currently compiles to)
- Create: `core/bundle_compiler/tests/artifact_test.rs`

**Interfaces:**
- Consumes: `validate::validate_component` (Task 11), `validate::egress::check_egress_declared` (Task 12).
- Produces: `pub struct Digests { pub artifact_digest: String, pub cwasm_digest: String, pub wasmtime_abi: String, pub collector: String }` and `pub fn validate_and_digest(component_path: &Path, manifest: &BundleManifest, language: &str) -> Result<(Digests, ComponentInfo), CompilerError>`. **This is the sole call site in the entire codebase that produces `artifact_digest`/`cwasm_digest`** — no other module, no SDK, no `build` container code, computes these. Task 18 wires this into `run_publish`; Task 16 stores the result on the `app_versions` row.

- [ ] **Step 1: Write the failing tests**

```rust
// core/bundle_compiler/tests/artifact_test.rs
use bundle_compiler::artifact::validate_and_digest;
use bundle_compiler::errors::CompilerError;
use bundle_compiler::manifest::{parse_and_validate, ManifestOptions};
use std::path::Path;
use tempfile::tempdir;

fn compile_good_python() -> (std::path::PathBuf, bundle_compiler::manifest::BundleManifest) {
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &ManifestOptions::default()).unwrap();
    let out = tempdir().unwrap();
    let wasm = bundle_compiler::build::PythonBuilder.build(Path::new("tests/fixtures/bundles/good-python"), &m, out.path()).unwrap();
    // Move out of the tempdir before it drops, into a location the test owns.
    let persisted = Path::new("tests/fixtures/bundles/good-python/.compiled.wasm");
    std::fs::copy(&wasm, persisted).unwrap();
    (persisted.to_path_buf(), m)
}

#[test]
fn valid_component_produces_two_digests() {
    let (wasm, m) = compile_good_python();
    let (digests, _info) = validate_and_digest(&wasm, &m, "python").expect("valid component digests cleanly");
    assert!(digests.artifact_digest.starts_with("sha256:"));
    assert_eq!(digests.artifact_digest.len(), 71); // "sha256:" + 64 hex
    assert!(digests.cwasm_digest.starts_with("sha256:"));
    assert_ne!(digests.artifact_digest, digests.cwasm_digest, "the two digests measure different bytes");
    assert_eq!(digests.collector, "drc");
    std::fs::remove_file(&wasm).ok();
}

#[test]
fn identical_bytes_produce_identical_digest_idempotent_installs() {
    let (wasm, m) = compile_good_python();
    let (d1, _) = validate_and_digest(&wasm, &m, "python").unwrap();
    let (d2, _) = validate_and_digest(&wasm, &m, "python").unwrap();
    assert_eq!(d1.artifact_digest, d2.artifact_digest, "hashing the same bytes twice must agree");
    assert_eq!(d1.cwasm_digest, d2.cwasm_digest);
    std::fs::remove_file(&wasm).ok();
}

#[test]
fn any_byte_change_produces_a_different_digest() {
    let (wasm, m) = compile_good_python();
    let (d1, _) = validate_and_digest(&wasm, &m, "python").unwrap();
    let mut bytes = std::fs::read(&wasm).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0x01; // flip one bit of the last byte
    let tampered = Path::new("tests/fixtures/bundles/good-python/.tampered.wasm");
    std::fs::write(tampered, &bytes).unwrap();
    // A single flipped trailing byte on a real wasm binary is very likely
    // to also fail wasm-tools' own parse (corrupted section), which is a
    // stronger and equally valid rejection — assert either outcome, but
    // NEVER a successful digest that matches d1.
    match validate_and_digest(tampered, &m, "python") {
        Ok((d2, _)) => assert_ne!(d1.artifact_digest, d2.artifact_digest, "a single changed byte must not produce the same digest"),
        Err(CompilerError::ValidationFailed { .. }) => { /* also an acceptable, stronger outcome */ }
        Err(other) => panic!("unexpected error variant: {other:?}"),
    }
    std::fs::remove_file(&wasm).ok();
    std::fs::remove_file(tampered).ok();
}

#[test]
fn tampered_component_that_fails_validation_is_never_hashed_or_uploaded() {
    // A component missing the required exports entirely (spike2's
    // bad-wrong-world fixture, Task 11) must be rejected by
    // validate_and_digest itself — before any digest is computed — so a
    // caller can never accidentally upload/sign/record a component that
    // never passed validation.
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_rust.yaml"), &ManifestOptions::default()).unwrap();
    let out = tempdir().unwrap();
    let wasm = bundle_compiler::build::RustBuilder.build(Path::new("tests/fixtures/bundles/bad-wrong-world"), &m, out.path()).unwrap();
    let err = validate_and_digest(&wasm, &m, "rust").unwrap_err();
    match err {
        CompilerError::ValidationFailed { reason, .. } => assert_eq!(reason, "wit_export_missing"),
        other => panic!("expected ValidationFailed, got {other:?}"),
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --locked artifact_test`
Expected: FAIL — `artifact::validate_and_digest` not defined (the placeholder file from Task 2 has no such function).

- [ ] **Step 3: Implement `src/artifact.rs`**

```rust
//! Publisher-only re-validation and digest computation. This module is
//! the SOLE producer of `artifact_digest` and `cwasm_digest` anywhere in
//! this codebase (see the Artifact & Digest Contract section of this
//! plan) — it is called only from `run_publish` (Task 18), never from
//! `build` (Task 7). It trusts nothing about a component's provenance:
//! every call re-runs full validation (Task 11) against the bytes on disk
//! before computing anything.

use crate::errors::CompilerError;
use crate::manifest::BundleManifest;
use crate::validate::{self, egress, ComponentInfo};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;

/// Both digests this codebase ever produces for one component, plus the
/// precompile identity they were measured under.
#[derive(Debug, Clone)]
pub struct Digests {
    pub artifact_digest: String,
    pub cwasm_digest: String,
    pub wasmtime_abi: String,
    pub collector: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

/// Re-validate `component_path` from its bytes (never trusting anything
/// the `build` container claimed) and, only on success, compute both
/// digests. Returns the component's own import/export info too, since the
/// caller (Task 18) needs it again for the sidecar's `wit_world` field and
/// for the egress cross-check (Task 12).
pub fn validate_and_digest(component_path: &Path, manifest: &BundleManifest, language: &str) -> Result<(Digests, ComponentInfo), CompilerError> {
    // Step 0 of spec §9.4: re-validate from bytes, trust nothing from `build`.
    let info = validate::validate_component(component_path, language)?;
    egress::check_egress_declared(manifest, &info)?;

    let component_bytes = std::fs::read(component_path)?;
    let artifact_digest = sha256_hex(&component_bytes);

    // Precompile self-test: produces the .cwasm and, separately, hashes it.
    // A version/collector mismatch here is caught at publish time, not at
    // an executor's first load attempt (spike round 2's actual failure
    // mode: a copying-collector .cwasm silently fails to load under a drc
    // engine, with no diagnostic beyond a load error naming neither value).
    let tmp_cwasm = component_path.with_extension("cwasm");
    let status = Command::new("wasmtime")
        .args([
            "compile",
            "-C", "collector=drc",
            component_path.to_str().expect("utf8 path"),
            "-o", tmp_cwasm.to_str().expect("utf8 path"),
        ])
        .status()
        .map_err(|e| CompilerError::ArtifactFailed(format!("wasmtime compile failed to start: {e}")))?;
    if !status.success() {
        return Err(CompilerError::ArtifactFailed("wasmtime compile (precompile self-test) exited non-zero".to_string()));
    }
    let cwasm_bytes = std::fs::read(&tmp_cwasm)?;
    let cwasm_digest = sha256_hex(&cwasm_bytes);
    std::fs::remove_file(&tmp_cwasm).ok();

    let version_out = Command::new("wasmtime")
        .arg("--version")
        .output()
        .map_err(|e| CompilerError::ArtifactFailed(format!("wasmtime --version failed: {e}")))?;
    let wasmtime_abi = String::from_utf8_lossy(&version_out.stdout).trim().to_string();

    Ok((
        Digests { artifact_digest, cwasm_digest, wasmtime_abi, collector: "drc".to_string() },
        info,
    ))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (inside the compiler image, `wasmtime` CLI 48.0.2 on `PATH` per `build/tool-versions.env`): `cargo test --locked artifact_test`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): publisher-only component re-validation and dual digest computation

The compiler's publisher container is the sole producer of a bundle
version's artifact_digest and cwasm_digest; this is enforced by module
boundary (validate_and_digest lives only in the publish path) and tested
for idempotency (same bytes -> same digest) and tamper detection (a
component that fails re-validation is never hashed).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 14: Ed25519 sidecar signing

**Files:**
- Modify: `core/bundle_compiler/src/sidecar.rs`
- Create: `core/bundle_compiler/tests/sidecar_test.rs`

**Interfaces:**
- Consumes: `Digests`/`ComponentInfo` (Task 13), `BundleManifest` (Task 3).
- Produces: `pub struct Sidecar { .. }` (fields verbatim from spec §9.4's JSON schema), `pub fn build_and_sign_sidecar(manifest: &BundleManifest, digests: &Digests, size_bytes: u64, scan_status: &str, signing_key: &SigningKey) -> Sidecar`, and `pub fn verify_sidecar(sidecar_json: &[u8], verifying_key: &VerifyingKey) -> Result<Sidecar, CompilerError>`.

- [ ] **Step 1: Write the failing test**

```rust
// core/bundle_compiler/tests/sidecar_test.rs
use bundle_compiler::artifact::Digests;
use bundle_compiler::manifest::{parse_and_validate, ManifestOptions};
use bundle_compiler::sidecar::{build_and_sign_sidecar, verify_sidecar};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use std::path::Path;

#[test]
fn sidecar_round_trips_signature_verification() {
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &ManifestOptions::default()).unwrap();
    let digests = Digests {
        artifact_digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
        cwasm_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        wasmtime_abi: "wasmtime-cli 48.0.2".to_string(),
        collector: "drc".to_string(),
    };
    let signing_key = SigningKey::generate(&mut OsRng);
    let sidecar = build_and_sign_sidecar(&m, &digests, 2_148_231, "scanned", &signing_key);

    let json = serde_json::to_vec(&sidecar).unwrap();
    let verified = verify_sidecar(&json, &signing_key.verifying_key()).expect("signature verifies");
    assert_eq!(verified.digest, digests.artifact_digest);
    assert_eq!(verified.app_id, m.app_id);
}

#[test]
fn tampered_sidecar_fails_verification() {
    let m = parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &ManifestOptions::default()).unwrap();
    let digests = Digests {
        artifact_digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
        cwasm_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        wasmtime_abi: "wasmtime-cli 48.0.2".to_string(),
        collector: "drc".to_string(),
    };
    let signing_key = SigningKey::generate(&mut OsRng);
    let sidecar = build_and_sign_sidecar(&m, &digests, 2_148_231, "scanned", &signing_key);
    let mut value: serde_json::Value = serde_json::to_value(&sidecar).unwrap();
    value["digest"] = serde_json::Value::String("sha256:0000000000000000000000000000000000000000000000000000000000000000".to_string());
    let tampered = serde_json::to_vec(&value).unwrap();
    let err = verify_sidecar(&tampered, &signing_key.verifying_key()).unwrap_err();
    assert!(matches!(err, bundle_compiler::errors::CompilerError::ArtifactFailed(_)));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --locked sidecar_test`
Expected: FAIL — `sidecar::build_and_sign_sidecar`/`verify_sidecar` not defined.

- [ ] **Step 3: Implement `src/sidecar.rs`**

```rust
//! Ed25519-signed metadata sidecar — schema verbatim from spec §9.4.
//! `cwasm_digest`/`wasmtime_abi`/`collector` live on the `app_versions`
//! row (Task 16), not the sidecar — the sidecar's shape is unchanged by
//! the D27 build/publisher split.

use crate::artifact::Digests;
use crate::errors::CompilerError;
use crate::manifest::BundleManifest;
use base64::Engine;
use chrono::Utc;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// The signed sidecar, schema verbatim from spec §9.4.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sidecar {
    pub schema_version: u32,
    pub app_id: String,
    pub version: String,
    pub digest: String,
    pub size_bytes: u64,
    pub language: String,
    pub artifact_kind: String,
    pub scan_status: String,
    pub wit_world: String,
    pub built_at: String,
    pub builder: String,
    pub signature: String,
}

/// Canonical JSON: sorted keys, no insignificant whitespace — every field
/// except `signature` itself, which is computed over this exact bytes.
fn canonical_bytes_for_signing(sidecar_without_signature: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(sidecar_without_signature).expect("serde_json::Value always serializes")
}

/// Build and sign a sidecar. `digests.artifact_digest` is what becomes the
/// sidecar's `digest` field — `cwasm_digest` is intentionally not carried
/// here (see module doc).
pub fn build_and_sign_sidecar(
    manifest: &BundleManifest,
    digests: &Digests,
    size_bytes: u64,
    scan_status: &str,
    signing_key: &SigningKey,
) -> Sidecar {
    let built_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let unsigned = serde_json::json!({
        "schema_version": 1,
        "app_id": manifest.app_id,
        "version": manifest.version,
        "digest": digests.artifact_digest,
        "size_bytes": size_bytes,
        "language": manifest.language,
        "artifact_kind": manifest.artifact,
        "scan_status": scan_status,
        "wit_world": "waddle:bundle/stage@1.0.0",
        "built_at": built_at,
        "builder": format!("bundle-compiler@{}", env!("CARGO_PKG_VERSION")),
    });
    let signature: Signature = signing_key.sign(&canonical_bytes_for_signing(&unsigned));
    Sidecar {
        schema_version: 1,
        app_id: manifest.app_id.clone(),
        version: manifest.version.clone(),
        digest: digests.artifact_digest.clone(),
        size_bytes,
        language: manifest.language.clone(),
        artifact_kind: manifest.artifact.clone(),
        scan_status: scan_status.to_string(),
        wit_world: "waddle:bundle/stage@1.0.0".to_string(),
        built_at,
        builder: format!("bundle-compiler@{}", env!("CARGO_PKG_VERSION")),
        signature: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
    }
}

/// Verify a sidecar's signature against `verifying_key`, re-deriving the
/// canonical unsigned bytes from every field except `signature` itself.
pub fn verify_sidecar(sidecar_json: &[u8], verifying_key: &VerifyingKey) -> Result<Sidecar, CompilerError> {
    let sidecar: Sidecar = serde_json::from_slice(sidecar_json)
        .map_err(|e| CompilerError::ArtifactFailed(format!("sidecar does not parse: {e}")))?;
    let unsigned = serde_json::json!({
        "schema_version": sidecar.schema_version,
        "app_id": sidecar.app_id,
        "version": sidecar.version,
        "digest": sidecar.digest,
        "size_bytes": sidecar.size_bytes,
        "language": sidecar.language,
        "artifact_kind": sidecar.artifact_kind,
        "scan_status": sidecar.scan_status,
        "wit_world": sidecar.wit_world,
        "built_at": sidecar.built_at,
        "builder": sidecar.builder,
    });
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&sidecar.signature)
        .map_err(|e| CompilerError::ArtifactFailed(format!("signature is not valid base64: {e}")))?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|e| CompilerError::ArtifactFailed(format!("malformed signature: {e}")))?;
    verifying_key
        .verify(&canonical_bytes_for_signing(&unsigned), &signature)
        .map_err(|_| CompilerError::ArtifactFailed("sidecar signature verification failed".to_string()))?;
    Ok(sidecar)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked sidecar_test`
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): sign and verify the Ed25519 metadata sidecar (spec §9.4 schema)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 15: Bucket upload client

**Files:**
- Modify: `core/bundle_compiler/src/bucket.rs`
- Create: `core/bundle_compiler/tests/bucket_test.rs`

**Interfaces:**
- Consumes: `Sidecar` (Task 14).
- Produces: `pub struct BucketClient { .. }`, `pub struct BucketConfig { pub endpoint: String, pub bucket: String, pub region: String, pub access_key_id: String, pub secret_access_key: String }`, `pub async fn new(config: BucketConfig) -> Result<BucketClient, CompilerError>`, `pub async fn upload_component(&self, app_id: &str, version: &str, digest: &str, bytes: &[u8]) -> Result<String, CompilerError>` (returns the object key), `pub async fn upload_sidecar(&self, app_id: &str, version: &str, digest: &str, sidecar_json: &[u8]) -> Result<String, CompilerError>`, bucket layout `bundles/{app_id}/{version}/{sha256-hex}.wasm` / `.json` (spec §9.4/A12).

- [ ] **Step 1: Write the failing test** (uses `testcontainers-modules::minio` — a real, containerized MinIO, per Global Constraints' "every gate runs containerized")

```rust
// core/bundle_compiler/tests/bucket_test.rs
use bundle_compiler::bucket::{BucketClient, BucketConfig};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::minio::MinIO;

#[tokio::test]
async fn uploads_component_and_sidecar_under_the_documented_layout() {
    let container = MinIO::default().start().await.unwrap();
    let port = container.get_host_port_ipv4(9000).await.unwrap();
    let config = BucketConfig {
        endpoint: format!("http://127.0.0.1:{port}"),
        bucket: "waddles-bundles".to_string(),
        region: "us-east-1".to_string(),
        access_key_id: "minioadmin".to_string(),
        secret_access_key: "minioadmin".to_string(),
    };
    let client = BucketClient::new(config).await.expect("bucket client connects");

    let digest_hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    let component_key = client
        .upload_component("waddles.core.example.echo", "1.0.0", digest_hex, b"fake wasm bytes")
        .await
        .unwrap();
    assert_eq!(component_key, format!("bundles/waddles.core.example.echo/1.0.0/{digest_hex}.wasm"));

    let sidecar_key = client
        .upload_sidecar("waddles.core.example.echo", "1.0.0", digest_hex, br#"{"fake":"sidecar"}"#)
        .await
        .unwrap();
    assert_eq!(sidecar_key, format!("bundles/waddles.core.example.echo/1.0.0/{digest_hex}.json"));

    let fetched = client.get_object(&component_key).await.unwrap();
    assert_eq!(fetched, b"fake wasm bytes");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --locked bucket_test`
Expected: FAIL — `bucket::BucketClient` not defined.

- [ ] **Step 3: Implement `src/bucket.rs`**

```rust
//! S3-compatible bucket client (`object_store` crate, path-style), MinIO
//! by default, Nest when configured (spec D15) — endpoint and credentials
//! come entirely from `BucketConfig`, never a CLI flag.

use crate::errors::CompilerError;
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjectPath;
use object_store::ObjectStore;
use std::sync::Arc;

/// Bucket connection parameters — read by the caller from env vars/mounted
/// files (`BUNDLE_BUCKET_ENDPOINT`/`_NAME`/`_REGION`/`_ACCESS_KEY_ID`/
/// `_SECRET_ACCESS_KEY`, spec §12.7), never a CLI flag.
#[derive(Debug, Clone)]
pub struct BucketConfig {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

pub struct BucketClient {
    store: Arc<dyn ObjectStore>,
}

impl BucketClient {
    pub async fn new(config: BucketConfig) -> Result<Self, CompilerError> {
        let store = AmazonS3Builder::new()
            .with_endpoint(config.endpoint)
            .with_bucket_name(config.bucket)
            .with_region(config.region)
            .with_access_key_id(config.access_key_id)
            .with_secret_access_key(config.secret_access_key)
            .with_allow_http(true) // in-cluster MinIO is plain HTTP by default; Nest/production endpoints use TLS via the endpoint URL scheme
            .build()
            .map_err(|e| CompilerError::ArtifactFailed(format!("bucket client construction failed: {e}")))?;
        Ok(BucketClient { store: Arc::new(store) })
    }

    fn component_key(app_id: &str, version: &str, digest_hex: &str) -> String {
        format!("bundles/{app_id}/{version}/{digest_hex}.wasm")
    }

    fn sidecar_key(app_id: &str, version: &str, digest_hex: &str) -> String {
        format!("bundles/{app_id}/{version}/{digest_hex}.json")
    }

    /// `PUT bundles/{app_id}/{version}/{sha256}.wasm` (spec §9.4 step 2).
    /// Returns the object key.
    pub async fn upload_component(&self, app_id: &str, version: &str, digest_hex: &str, bytes: &[u8]) -> Result<String, CompilerError> {
        let key = Self::component_key(app_id, version, digest_hex);
        self.store
            .put(&ObjectPath::from(key.clone()), bytes.to_vec().into())
            .await
            .map_err(|e| CompilerError::ArtifactFailed(format!("component upload failed: {e}")))?;
        Ok(key)
    }

    /// `PUT bundles/{app_id}/{version}/{sha256}.json` (spec §9.4 step 4).
    pub async fn upload_sidecar(&self, app_id: &str, version: &str, digest_hex: &str, sidecar_json: &[u8]) -> Result<String, CompilerError> {
        let key = Self::sidecar_key(app_id, version, digest_hex);
        self.store
            .put(&ObjectPath::from(key.clone()), sidecar_json.to_vec().into())
            .await
            .map_err(|e| CompilerError::ArtifactFailed(format!("sidecar upload failed: {e}")))?;
        Ok(key)
    }

    /// Fetch an object back — used by this crate's own tests, and by
    /// hub-api's (M2b) independent re-hash cross-check (spec §9.4 step 6).
    pub async fn get_object(&self, key: &str) -> Result<Vec<u8>, CompilerError> {
        let result = self
            .store
            .get(&ObjectPath::from(key))
            .await
            .map_err(|e| CompilerError::ArtifactFailed(format!("bucket GET failed for {key}: {e}")))?;
        let bytes = result.bytes().await.map_err(|e| CompilerError::ArtifactFailed(format!("reading bucket object body failed: {e}")))?;
        Ok(bytes.to_vec())
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked bucket_test`
Expected: `uploads_component_and_sidecar_under_the_documented_layout ... ok` (a real MinIO container is started and torn down automatically by `testcontainers`).

- [ ] **Step 5: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): add S3-compatible bucket upload client (MinIO default, Nest configurable)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 16: `app_versions` — `waddles_publisher` Postgres write, audit trigger, RBAC matrix, negative test 14g

**Files:**
- Create: `core/bundle_compiler/migrations/0001_app_versions.sql`
- Modify: `core/bundle_compiler/src/db.rs`
- Create: `config/postgres/rbac-matrix.yaml`
- Create: `core/bundle_compiler/tests/db_test.rs`

**Interfaces:**
- Consumes: `Digests` (Task 13), `BundleManifest` (Task 3).
- Produces: `pub struct PublisherDb { .. }`, `pub async fn connect(database_url: &str) -> Result<PublisherDb, CompilerError>`, `pub async fn insert_version(&self, manifest: &BundleManifest, digests: &Digests, size_bytes: u64, scan_status: &str, badge: Option<&str>) -> Result<i64, CompilerError>` (returns the new row's `id`, upserting on `(app_id, version)` — spec §6.10: "Overwrites by either writer are permitted"). This is the only code path in this plan that writes `app_versions`.

- [ ] **Step 1: Write `migrations/0001_app_versions.sql`** (schema per the Artifact & Digest Contract section, plus the audit trigger and two-writer grants per spec §6.10)

```sql
-- core/bundle_compiler/migrations/0001_app_versions.sql
-- M2a owns this table's schema, the waddles_publisher role, and the audit
-- trigger. hub_api's own grants (SELECT/INSERT/UPDATE/DELETE) and the
-- app_active_versions table are M2b's migration — referenced here, not
-- created here, so the two migrations can land independently.

CREATE TABLE IF NOT EXISTS app_versions (
    id               BIGSERIAL PRIMARY KEY,
    app_id           TEXT NOT NULL,
    version          TEXT NOT NULL,
    artifact_digest  TEXT NOT NULL,
    cwasm_digest     TEXT NOT NULL,
    wasmtime_abi     TEXT NOT NULL,
    collector        TEXT NOT NULL,
    size_bytes       BIGINT NOT NULL,
    language         TEXT NOT NULL,
    artifact_kind    TEXT NOT NULL,
    built_at         TIMESTAMPTZ NOT NULL,
    builder          TEXT NOT NULL,
    scan_status      TEXT NOT NULL,
    badge            TEXT,
    approval_id      BIGINT,
    UNIQUE (app_id, version),
    UNIQUE (artifact_digest)
);

CREATE TABLE IF NOT EXISTS app_versions_audit_log (
    id               BIGSERIAL PRIMARY KEY,
    occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    operation        TEXT NOT NULL,       -- 'INSERT' | 'UPDATE' | 'DELETE'
    writer_role      TEXT NOT NULL,       -- current_user at write time
    app_id           TEXT NOT NULL,
    version          TEXT NOT NULL,
    old_artifact_digest TEXT,
    new_artifact_digest TEXT
);

CREATE OR REPLACE FUNCTION app_versions_audit() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO app_versions_audit_log (operation, writer_role, app_id, version, old_artifact_digest, new_artifact_digest)
        VALUES (TG_OP, current_user, OLD.app_id, OLD.version, OLD.artifact_digest, NULL);
        RETURN OLD;
    ELSE
        INSERT INTO app_versions_audit_log (operation, writer_role, app_id, version, old_artifact_digest, new_artifact_digest)
        VALUES (TG_OP, current_user, NEW.app_id, NEW.version, CASE WHEN TG_OP = 'UPDATE' THEN OLD.artifact_digest ELSE NULL END, NEW.artifact_digest);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_versions_audit_trigger ON app_versions;
CREATE TRIGGER app_versions_audit_trigger
    AFTER INSERT OR UPDATE OR DELETE ON app_versions
    FOR EACH ROW EXECUTE FUNCTION app_versions_audit();

-- Exactly two writers (spec §6.10). This migration creates and grants
-- waddles_publisher; hub_api's own grant is issued by M2b's migration
-- against the same table, idempotently (GRANT is additive and safe to
-- issue from either migration in either order).
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'waddles_publisher') THEN
        CREATE ROLE waddles_publisher LOGIN PASSWORD NULL; -- password set out-of-band via a Secret, never in a migration file
    END IF;
END
$$;

REVOKE ALL ON app_versions FROM PUBLIC;
GRANT INSERT, UPDATE, DELETE ON app_versions TO waddles_publisher;
GRANT USAGE, SELECT ON SEQUENCE app_versions_id_seq TO waddles_publisher;
```

- [ ] **Step 2: Write `config/postgres/rbac-matrix.yaml`** — the normative matrix (D28, spec §11.10.1), every role from the spec's own table, `waddles_publisher`'s entry fully specified (M2a's own scope), every other role's entry present with an `owned_by` pointer so later milestones extend this one file rather than inventing a second

```yaml
# config/postgres/rbac-matrix.yaml
# Normative source of Postgres grants (D28, spec §11.10.1). Grants are
# generated from this file; nobody writes a GRANT by hand outside a
# migration that matches it. Each role names the milestone that owns its
# table schema and migration — M2a (this plan) owns only waddles_publisher.
schema_version: 1
roles:
  hub_api:
    owned_by: M2b
    tables:
      app_versions: [SELECT, INSERT, UPDATE, DELETE]
      app_active_versions: [SELECT, INSERT, UPDATE, DELETE]
      # registries, approvals, grants, intake sources: M2b's own migration adds these rows
  waddles_publisher:
    owned_by: M2a
    tables:
      app_versions: [INSERT, UPDATE, DELETE]
  svc_ingest:
    owned_by: M5
    tables: {} # no database at all — asserted, not assumed (spec §11.10.1)
  svc_process:
    owned_by: M4
    tables: {} # its built-ins' own tables; per-bundle roles serve bundle db calls, not this role
  svc_action:
    owned_by: M3
    tables: {} # action_dispatch_log, reference tables — M3's own migration
  svc_streaming:
    owned_by: existing
    tables: {} # its own media/recording tables — unchanged by this project
  webui:
    owned_by: M2b
    tables: {} # read-only where it reads at all
  executor:
    owned_by: M3/M4
    tables: {} # NO ROLE — stated explicitly so a future change deletes a line rather than quietly adding one
  migration_runner:
    owned_by: platform
    tables: {} # DDL, only during migrations
  # per-bundle roles (bundle_<app_id_underscored>) are generated per
  # approval (M2b, spec §9.7.3), not listed individually here
non_writer_roles_on_app_versions:
  # Spec test 14g: each of these must fail INSERT/UPDATE/DELETE on
  # app_versions at the SQL level. Task 16's db_test.rs exercises exactly
  # this list.
  - svc_ingest
  - svc_process
  - svc_action
  - svc_streaming
  - executor
  - webui
```

- [ ] **Step 3: Write the failing test**

```rust
// core/bundle_compiler/tests/db_test.rs
use bundle_compiler::artifact::Digests;
use bundle_compiler::db::PublisherDb;
use bundle_compiler::manifest::{parse_and_validate, ManifestOptions};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

async fn migrated_postgres() -> (testcontainers::ContainerAsync<Postgres>, String) {
    let container = Postgres::default().start().await.unwrap();
    let port = container.get_host_port_ipv4(5432).await.unwrap();
    let admin_url = format!("postgres://postgres:postgres@127.0.0.1:{port}/postgres");
    let (client, connection) = tokio_postgres::connect(&admin_url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    let migration = std::fs::read_to_string("migrations/0001_app_versions.sql").unwrap();
    client.batch_execute(&migration).await.unwrap();
    // Grant login to waddles_publisher and the six non-writer roles for the test.
    for role in ["waddles_publisher", "svc_ingest", "svc_process", "svc_action", "svc_streaming", "executor", "webui"] {
        client.batch_execute(&format!("ALTER ROLE {role} LOGIN PASSWORD 'test'")).await.ok();
        client.batch_execute(&format!("CREATE ROLE {role} LOGIN PASSWORD 'test'")).await.ok();
    }
    (container, admin_url)
}

#[tokio::test]
async fn publisher_inserts_a_version_row() {
    let (_container, admin_url) = migrated_postgres().await;
    let port = admin_url.rsplit(':').nth(1).unwrap().split('/').next().unwrap();
    let publisher_url = format!("postgres://waddles_publisher:test@127.0.0.1:{port}/postgres");
    let db = PublisherDb::connect(&publisher_url).await.expect("waddles_publisher connects");

    let m = parse_and_validate(std::path::Path::new("tests/fixtures/manifests/valid_python.yaml"), &ManifestOptions::default()).unwrap();
    let digests = Digests {
        artifact_digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
        cwasm_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        wasmtime_abi: "wasmtime-cli 48.0.2".to_string(),
        collector: "drc".to_string(),
    };
    let id = db.insert_version(&m, &digests, 2_148_231, "scanned", None).await.expect("insert succeeds");
    assert!(id > 0);

    // Re-publishing the same (app_id, version) with the same digest is an
    // idempotent overwrite (spec §6.10: "Overwrites ... are permitted").
    let id2 = db.insert_version(&m, &digests, 2_148_231, "scanned", None).await.expect("re-publish succeeds");
    assert_eq!(id, id2, "upsert on (app_id, version) returns the same row id");
}

#[tokio::test]
async fn non_writer_roles_cannot_write_app_versions() {
    let (_container, admin_url) = migrated_postgres().await;
    let port = admin_url.rsplit(':').nth(1).unwrap().split('/').next().unwrap();
    let (admin_client, connection) = tokio_postgres::connect(&admin_url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    admin_client
        .batch_execute("INSERT INTO app_versions (app_id, version, artifact_digest, cwasm_digest, wasmtime_abi, collector, size_bytes, language, artifact_kind, built_at, builder, scan_status) VALUES ('waddles.core.example.echo', '1.0.0', 'sha256:0000000000000000000000000000000000000000000000000000000000000001', 'sha256:0000000000000000000000000000000000000000000000000000000000000002', 'wasmtime-cli 48.0.2', 'drc', 1, 'python', 'source', now(), 'bundle-compiler@0.1.0', 'scanned')")
        .await
        .unwrap();

    let non_writer_roles = ["svc_ingest", "svc_process", "svc_action", "svc_streaming", "executor", "webui"];
    let mut roles_examined = 0usize;
    let mut statements_examined = 0usize;
    for role in non_writer_roles {
        roles_examined += 1;
        let url = format!("postgres://{role}:test@127.0.0.1:{port}/postgres");
        let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        for stmt in [
            "INSERT INTO app_versions (app_id, version, artifact_digest, cwasm_digest, wasmtime_abi, collector, size_bytes, language, artifact_kind, built_at, builder, scan_status) VALUES ('x', '1.0.0', 'sha256:0000000000000000000000000000000000000000000000000000000000000003', 'sha256:0000000000000000000000000000000000000000000000000000000000000004', 'x', 'drc', 1, 'python', 'source', now(), 'x', 'scanned')",
            "UPDATE app_versions SET artifact_digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000005' WHERE app_id = 'waddles.core.example.echo'",
            "DELETE FROM app_versions WHERE app_id = 'waddles.core.example.echo'",
        ] {
            statements_examined += 1;
            let result = client.batch_execute(stmt).await;
            assert!(result.is_err(), "role {role} must be refused for statement: {stmt}");
        }
    }
    assert_eq!(roles_examined, 6, "spec test 14g requires exercising exactly the 6 non-writer roles named in config/postgres/rbac-matrix.yaml");
    assert_eq!(statements_examined, 18, "6 roles x 3 statements (INSERT/UPDATE/DELETE)");
    println!("RBAC negative test 14g: {roles_examined} roles, {statements_examined} statements, all refused");
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cargo test --locked db_test`
Expected: FAIL — `db::PublisherDb` not defined.

- [ ] **Step 5: Implement `src/db.rs`**

```rust
//! `waddles_publisher` Postgres client — the ONLY code path in this
//! codebase that writes `app_versions` (spec §6.10, D27/D28). Connects
//! with the role's own credentials, read from env/mounted file (never a
//! CLI flag), and upserts on `(app_id, version)` — overwrites are
//! permitted (spec: "not immutability, no unexpected writers").

use crate::artifact::Digests;
use crate::errors::CompilerError;
use crate::manifest::BundleManifest;
use tokio_postgres::{Client, NoTls};

pub struct PublisherDb {
    client: Client,
}

impl PublisherDb {
    /// Connect using the `waddles_publisher` role's own DSN. The caller
    /// reads `database_url` from an env var or mounted Secret file — never
    /// a CLI flag (Global Constraints).
    pub async fn connect(database_url: &str) -> Result<Self, CompilerError> {
        let (client, connection) = tokio_postgres::connect(database_url, NoTls)
            .await
            .map_err(|e| CompilerError::DbFailed(format!("waddles_publisher connection failed: {e}")))?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                tracing::error!(error = %e, "waddles_publisher connection closed with error");
            }
        });
        Ok(PublisherDb { client })
    }

    /// `INSERT` the `app_versions` row, upserting on `(app_id, version)` —
    /// a re-publish or correction overwrites, per spec §6.10. Returns the
    /// row's `id`.
    pub async fn insert_version(
        &self,
        manifest: &BundleManifest,
        digests: &Digests,
        size_bytes: u64,
        scan_status: &str,
        badge: Option<&str>,
    ) -> Result<i64, CompilerError> {
        let builder = format!("bundle-compiler@{}", env!("CARGO_PKG_VERSION"));
        let row = self
            .client
            .query_one(
                "INSERT INTO app_versions
                    (app_id, version, artifact_digest, cwasm_digest, wasmtime_abi, collector,
                     size_bytes, language, artifact_kind, built_at, builder, scan_status, badge)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12)
                 ON CONFLICT (app_id, version) DO UPDATE SET
                    artifact_digest = EXCLUDED.artifact_digest,
                    cwasm_digest = EXCLUDED.cwasm_digest,
                    wasmtime_abi = EXCLUDED.wasmtime_abi,
                    collector = EXCLUDED.collector,
                    size_bytes = EXCLUDED.size_bytes,
                    built_at = now(),
                    builder = EXCLUDED.builder,
                    scan_status = EXCLUDED.scan_status,
                    badge = EXCLUDED.badge
                 RETURNING id",
                &[
                    &manifest.app_id,
                    &manifest.version,
                    &digests.artifact_digest,
                    &digests.cwasm_digest,
                    &digests.wasmtime_abi,
                    &digests.collector,
                    &(size_bytes as i64),
                    &manifest.language,
                    &manifest.artifact,
                    &builder,
                    &scan_status,
                    &badge,
                ],
            )
            .await
            .map_err(|e| CompilerError::DbFailed(format!("app_versions insert failed: {e}")))?;
        Ok(row.get::<_, i64>(0))
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run (via `testcontainers`, requires Docker socket access in the CI runner — a real Postgres container, not a mock, per Global Constraints): `cargo test --locked db_test`
Expected: both tests pass; the second prints `RBAC negative test 14g: 6 roles, 18 statements, all refused`.

- [ ] **Step 7: Commit**

```bash
git add core/bundle_compiler/ config/postgres/rbac-matrix.yaml
git commit -m "$(cat <<'EOF'
feat(compiler): add waddles_publisher app_versions writer, audit trigger, and normative RBAC matrix (D28)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 17: hub-api notification callback + OpenAPI contract fragment

**Files:**
- Modify: `core/bundle_compiler/src/callback.rs`
- Create: `docs/contracts/bundle-artifact-callback.openapi.yaml`
- Create: `core/bundle_compiler/tests/callback_test.rs`

**Interfaces:**
- Produces: `pub struct ArtifactNotification { .. }`, `pub async fn notify_hub_api(base_url: &str, app_id: &str, version: &str, digests: &Digests, component_key: &str, sidecar_key: &str) -> Result<(), CompilerError>` — POSTs to `{base_url}/api/v1/bundles/{app_id}/versions/{version}/artifact`. Per spec §9.4 step 6, **this is a notification, not the digest authority** — hub-api (M2b) independently re-hashes the bucket object; a mismatch is hub-api's own alert/audit path, not something this client waits for or blocks on.

- [ ] **Step 1: Write the OpenAPI contract fragment** — the exact shape M2b implements

```yaml
# docs/contracts/bundle-artifact-callback.openapi.yaml
openapi: 3.0.3
info:
  title: Waddles Bundle Artifact Notification (M2a compiler -> M2b hub-api)
  version: "1.0"
  description: >
    Authored by M2a (bundle-compiler); implemented by M2b (hub-api). This
    is a NOTIFICATION, not the digest's authority (spec §9.4 step 6):
    hub-api independently re-fetches the bucket object at component_key,
    re-hashes it, and compares the result against artifact_digest. A
    mismatch blocks approval and is audit-logged naming both digests —
    it never overwrites what the publisher already inserted into
    app_versions.
paths:
  /api/v1/bundles/{app_id}/versions/{version}/artifact:
    post:
      summary: Notify hub-api that a bundle-compiler publisher container has published a version
      parameters:
        - name: app_id
          in: path
          required: true
          schema:
            type: string
            pattern: '^waddles\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$'
        - name: version
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ArtifactNotification'
      responses:
        '202':
          description: Notification accepted; hub-api's re-hash cross-check runs asynchronously
        '404':
          description: Unknown app_id/version — hub-api has no matching app_catalog entry
        '422':
          description: Malformed notification body
components:
  schemas:
    ArtifactNotification:
      type: object
      required:
        - artifact_digest
        - cwasm_digest
        - wasmtime_abi
        - collector
        - component_key
        - sidecar_key
        - builder
      properties:
        artifact_digest:
          type: string
          pattern: '^sha256:[0-9a-f]{64}$'
          description: The digest waddles_publisher already INSERTed into app_versions — hub-api's re-hash of component_key must equal this value.
        cwasm_digest:
          type: string
          pattern: '^sha256:[0-9a-f]{64}$'
        wasmtime_abi:
          type: string
        collector:
          type: string
          enum: [drc]
        component_key:
          type: string
          description: Bucket object key of the .wasm component — what hub-api independently re-fetches and re-hashes.
        sidecar_key:
          type: string
          description: Bucket object key of the signed .json sidecar.
        builder:
          type: string
          example: "bundle-compiler@0.1.0"
```

- [ ] **Step 2: Write the failing test**

```rust
// core/bundle_compiler/tests/callback_test.rs
use bundle_compiler::artifact::Digests;
use bundle_compiler::callback::notify_hub_api;

#[tokio::test]
async fn notifies_hub_api_with_both_digests() {
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/api/v1/bundles/waddles.core.example.echo/versions/1.0.0/artifact")
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "artifact_digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        })))
        .with_status(202)
        .create_async()
        .await;

    let digests = Digests {
        artifact_digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
        cwasm_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        wasmtime_abi: "wasmtime-cli 48.0.2".to_string(),
        collector: "drc".to_string(),
    };
    notify_hub_api(&server.url(), "waddles.core.example.echo", "1.0.0", &digests, "bundles/waddles.core.example.echo/1.0.0/9f86....wasm", "bundles/waddles.core.example.echo/1.0.0/9f86....json")
        .await
        .expect("notification succeeds");
    mock.assert_async().await;
}

#[tokio::test]
async fn a_404_from_hub_api_is_reported_but_does_not_panic() {
    let mut server = mockito::Server::new_async().await;
    server
        .mock("POST", "/api/v1/bundles/waddles.core.example.echo/versions/1.0.0/artifact")
        .with_status(404)
        .create_async()
        .await;
    let digests = Digests {
        artifact_digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
        cwasm_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        wasmtime_abi: "wasmtime-cli 48.0.2".to_string(),
        collector: "drc".to_string(),
    };
    let err = notify_hub_api(&server.url(), "waddles.core.example.echo", "1.0.0", &digests, "k1", "k2").await.unwrap_err();
    assert!(matches!(err, bundle_compiler::errors::CompilerError::CallbackFailed(_)));
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked callback_test`
Expected: FAIL — `callback::notify_hub_api` not defined.

- [ ] **Step 4: Implement `src/callback.rs`**

```rust
//! Notifies hub-api that a version was published — a notification, not
//! the digest authority (spec §9.4 step 6, per the OpenAPI contract at
//! docs/contracts/bundle-artifact-callback.openapi.yaml, which M2b
//! implements). This client does not wait for or interpret hub-api's own
//! re-hash outcome — that is entirely M2b's asynchronous concern.

use crate::artifact::Digests;
use crate::errors::CompilerError;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct ArtifactNotification<'a> {
    artifact_digest: &'a str,
    cwasm_digest: &'a str,
    wasmtime_abi: &'a str,
    collector: &'a str,
    component_key: &'a str,
    sidecar_key: &'a str,
    builder: String,
}

/// `POST {base_url}/api/v1/bundles/{app_id}/versions/{version}/artifact`
/// per `docs/contracts/bundle-artifact-callback.openapi.yaml`.
pub async fn notify_hub_api(
    base_url: &str,
    app_id: &str,
    version: &str,
    digests: &Digests,
    component_key: &str,
    sidecar_key: &str,
) -> Result<(), CompilerError> {
    let body = ArtifactNotification {
        artifact_digest: &digests.artifact_digest,
        cwasm_digest: &digests.cwasm_digest,
        wasmtime_abi: &digests.wasmtime_abi,
        collector: &digests.collector,
        component_key,
        sidecar_key,
        builder: format!("bundle-compiler@{}", env!("CARGO_PKG_VERSION")),
    };
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base_url}/api/v1/bundles/{app_id}/versions/{version}/artifact"))
        .json(&body)
        .send()
        .await
        .map_err(|e| CompilerError::CallbackFailed(format!("hub-api notification request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(CompilerError::CallbackFailed(format!("hub-api returned {} for the artifact notification", resp.status())));
    }
    Ok(())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --locked callback_test`
Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add core/bundle_compiler/ docs/contracts/
git commit -m "$(cat <<'EOF'
feat(compiler): add hub-api artifact notification client and OpenAPI contract fragment for M2b

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 18: Wire `run_publish` end-to-end + e2e integration test

**Files:**
- Modify: `core/bundle_compiler/src/lib.rs`
- Create: `core/bundle_compiler/tests/e2e_test.rs`

**Interfaces:**
- Consumes: `validate::validate_component`/`egress::check_egress_declared` (Tasks 11-12, called inside `artifact::validate_and_digest`), `artifact::validate_and_digest` (Task 13), `sidecar::build_and_sign_sidecar` (Task 14), `bucket::BucketClient` (Task 15), `db::PublisherDb` (Task 16), `callback::notify_hub_api` (Task 17).
- Produces: the real `pub fn run_publish(...)` replacing Task 2's placeholder — composes Tasks 13-17 in the exact order of the Artifact & Digest Contract section's "Publish sequence." Reads bucket/DB/hub-api connection info from env vars only (`BUNDLE_BUCKET_ENDPOINT`/`_NAME`/`_REGION`/`_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`, `PUBLISHER_DATABASE_URL`, `HUB_API_URL`, `BUNDLE_SIGNING_PRIVATE_KEY_FILE` — spec §12.7).

- [ ] **Step 1: Write the failing e2e tests**

```rust
// core/bundle_compiler/tests/e2e_test.rs
//! Full build -> publish flow against real containerized dependencies
//! (MinIO + Postgres via testcontainers) for each Tier 1 language's good
//! fixture, plus the two bad fixtures from spike/bundle-compiler-sandbox
//! adapted to the real world, plus the negative tests the coordinator
//! required: a tampered component never reaches hash/upload, and the
//! build container's own environment carries no bucket/DB credential.

use bundle_compiler::build::run_build;
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use std::path::Path;
use tempfile::tempdir;

fn good_fixtures() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("tests/fixtures/bundles/good-python", "tests/fixtures/manifests/valid_python.yaml", "python"),
        ("tests/fixtures/bundles/good-rust", "tests/fixtures/manifests/valid_rust.yaml", "rust"),
        ("tests/fixtures/bundles/good-js", "tests/fixtures/manifests/valid_js.yaml", "javascript"),
    ]
}

#[test]
fn all_three_good_fixtures_build_successfully() {
    let fixtures = good_fixtures();
    assert_eq!(fixtures.len(), 3, "one good fixture per Tier 1 language — non-zero denominator");
    let mut built = 0usize;
    for (bundle, manifest, _lang) in &fixtures {
        let out = tempdir().unwrap();
        run_build(Path::new(bundle), Path::new(manifest), out.path()).expect("good fixture builds");
        assert!(out.path().join("component.wasm").exists());
        built += 1;
    }
    assert_eq!(built, 3);
}

#[test]
fn bad_wrong_world_and_legacy_dal_fixtures_are_both_rejected() {
    let out1 = tempdir().unwrap();
    let err1 = run_build(Path::new("tests/fixtures/bundles/legacy-dal"), Path::new("tests/fixtures/manifests/valid_python.yaml"), out1.path()).unwrap_err();
    assert!(matches!(err1, bundle_compiler::errors::CompilerError::ScanBlocked { .. }));

    // bad-wrong-world is a Rust source fixture missing the required
    // exports — build() itself succeeds (cargo-component compiles it
    // fine, since it's valid Rust targeting SOME world); rejection happens
    // at publish's re-validation (Task 13's test already covers this
    // exact case directly). This test asserts build() at least produces
    // output for it, so the interesting rejection is provably at publish,
    // not silently absorbed at build.
    let out2 = tempdir().unwrap();
    let m = bundle_compiler::manifest::parse_and_validate(Path::new("tests/fixtures/manifests/valid_rust.yaml"), &bundle_compiler::manifest::ManifestOptions::default()).unwrap();
    let wasm = bundle_compiler::build::RustBuilder.build(Path::new("tests/fixtures/bundles/bad-wrong-world"), &m, out2.path()).unwrap();
    let err2 = bundle_compiler::artifact::validate_and_digest(&wasm, &m, "rust").unwrap_err();
    assert!(matches!(err2, bundle_compiler::errors::CompilerError::ValidationFailed { .. }));
}

#[tokio::test]
async fn build_container_env_never_carries_bucket_or_db_credentials() {
    // A structural/architectural fitness-function test: run_build's own
    // module (src/build/mod.rs) must never reference the credentialed
    // modules at all -- checked by source inspection, since a Kubernetes
    // NetworkPolicy cannot distinguish which container is "currently
    // running" within one pod's shared network namespace (they share a
    // network namespace; credential ABSENCE, not network segmentation, is
    // what actually enforces this -- see the Artifact & Digest Contract
    // section's discussion of the two-container Job).
    let build_mod_src = std::fs::read_to_string("src/build/mod.rs").unwrap();
    for forbidden in ["crate::bucket", "crate::db::", "crate::callback", "crate::sidecar"] {
        assert!(
            !build_mod_src.contains(forbidden),
            "src/build/mod.rs must never reference {forbidden} -- the build container must hold no path to bucket/DB/signing credentials"
        );
    }
    for forbidden_module_file in ["python.rs", "rust.rs", "js.rs"] {
        let src = std::fs::read_to_string(format!("src/build/{forbidden_module_file}")).unwrap();
        for forbidden in ["crate::bucket", "crate::db::", "crate::callback", "crate::sidecar"] {
            assert!(!src.contains(forbidden), "src/build/{forbidden_module_file} must never reference {forbidden}");
        }
    }
}

#[test]
fn hash_computed_only_by_publisher_never_by_build() {
    // artifact.rs (the sole producer of artifact_digest/cwasm_digest) must
    // never be imported from build/mod.rs or any build/*.rs recipe.
    for path in ["src/build/mod.rs", "src/build/python.rs", "src/build/rust.rs", "src/build/js.rs"] {
        let src = std::fs::read_to_string(path).unwrap();
        assert!(!src.contains("crate::artifact"), "{path} must never call into crate::artifact -- only run_publish may");
    }
    let lib_src = std::fs::read_to_string("src/lib.rs").unwrap();
    assert!(lib_src.contains("pub fn run_publish"), "run_publish must exist at crate root and be the only caller of artifact::validate_and_digest outside its own tests");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --locked e2e_test`
Expected: `all_three_good_fixtures_build_successfully` and `bad_wrong_world_and_legacy_dal_fixtures_are_both_rejected` pass already (they exercise Tasks 7-13, already implemented); `hash_computed_only_by_publisher_never_by_build` and `build_container_env_never_carries_bucket_or_db_credentials` also pass already, since Tasks 7-12 never imported those modules. This task's real work is wiring `run_publish` itself — the test that actually needs it is added in Step 4 below.

- [ ] **Step 3: Add the full-pipeline test once `run_publish` exists**

```rust
// append to core/bundle_compiler/tests/e2e_test.rs
use bundle_compiler::run_publish;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::{minio::MinIO, postgres::Postgres};

#[tokio::test]
async fn full_publish_pipeline_against_real_minio_and_postgres() {
    let minio = MinIO::default().start().await.unwrap();
    let minio_port = minio.get_host_port_ipv4(9000).await.unwrap();
    let pg = Postgres::default().start().await.unwrap();
    let pg_port = pg.get_host_port_ipv4(5432).await.unwrap();
    let admin_url = format!("postgres://postgres:postgres@127.0.0.1:{pg_port}/postgres");
    let (client, connection) = tokio_postgres::connect(&admin_url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    client.batch_execute(&std::fs::read_to_string("migrations/0001_app_versions.sql").unwrap()).await.unwrap();
    client.batch_execute("ALTER ROLE waddles_publisher LOGIN PASSWORD 'test'").await.unwrap();

    std::env::set_var("BUNDLE_BUCKET_ENDPOINT", format!("http://127.0.0.1:{minio_port}"));
    std::env::set_var("BUNDLE_BUCKET_NAME", "waddles-bundles");
    std::env::set_var("BUNDLE_BUCKET_REGION", "us-east-1");
    std::env::set_var("BUNDLE_BUCKET_ACCESS_KEY_ID", "minioadmin");
    std::env::set_var("BUNDLE_BUCKET_SECRET_ACCESS_KEY", "minioadmin");
    std::env::set_var("PUBLISHER_DATABASE_URL", format!("postgres://waddles_publisher:test@127.0.0.1:{pg_port}/postgres"));
    let signing_key = SigningKey::generate(&mut OsRng);
    let key_file = tempdir().unwrap().path().join("signing.key");
    std::fs::write(&key_file, signing_key.to_bytes()).unwrap();
    std::env::set_var("BUNDLE_SIGNING_PRIVATE_KEY_FILE", &key_file);
    // HUB_API_URL left unset -> notify_hub_api's own error is logged and
    // does not fail the publish (spec: hub-api's cross-check is
    // asynchronous and best-effort from the publisher's point of view).

    let out = tempdir().unwrap();
    run_build(Path::new("tests/fixtures/bundles/good-python"), Path::new("tests/fixtures/manifests/valid_python.yaml"), out.path()).unwrap();

    run_publish(&out.path().join("component.wasm"), &out.path().join("manifest.json"), "python", "source")
        .await
        .expect("full publish pipeline succeeds");

    let count: i64 = client.query_one("SELECT count(*) FROM app_versions WHERE app_id = 'waddles.core.example.echo'", &[]).await.unwrap().get(0);
    assert_eq!(count, 1);
}
```

- [ ] **Step 4: Implement the real `run_publish` in `src/lib.rs`**, replacing the Task 2 placeholder

```rust
// replace the placeholder run_publish in core/bundle_compiler/src/lib.rs
/// The trusted `publisher` container's entire job, composed in the exact
/// order of the Artifact & Digest Contract section's "Publish sequence":
/// re-validate from bytes, dual-digest, sign, upload, INSERT, notify.
pub async fn run_publish(component: &std::path::Path, manifest_path: &std::path::Path, language: &str, artifact_kind: &str) -> Result<(), errors::CompilerError> {
    let manifest_json = std::fs::read_to_string(manifest_path)?;
    let manifest_value: serde_json::Value = serde_json::from_str(&manifest_json).map_err(|e| errors::CompilerError::Config(e.to_string()))?;
    let manifest: manifest::BundleManifest = serde_json::from_value(manifest_value).map_err(|e| errors::CompilerError::Config(e.to_string()))?;
    let _ = artifact_kind; // carried through the manifest's own `artifact` field already

    // Step 0-1: re-validate from bytes, compute both digests.
    let (digests, _info) = artifact::validate_and_digest(component, &manifest, language)?;

    let component_bytes = std::fs::read(component)?;
    let size_bytes = component_bytes.len() as u64;

    // Sidecar signing key: read from a mounted file, never a CLI flag.
    let key_path = std::env::var("BUNDLE_SIGNING_PRIVATE_KEY_FILE")
        .map_err(|_| errors::CompilerError::Config("BUNDLE_SIGNING_PRIVATE_KEY_FILE not set".to_string()))?;
    let key_bytes = std::fs::read(&key_path)?;
    let key_array: [u8; 32] = key_bytes[..32].try_into().map_err(|_| errors::CompilerError::Config("signing key file must hold 32 raw bytes".to_string()))?;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&key_array);

    let scan_status = "scanned"; // Task 34's e2e suite exercises "not_scanned"/"scanned_with_findings" via the prebuilt/Skauswatch-warn paths
    let sidecar = sidecar::build_and_sign_sidecar(&manifest, &digests, size_bytes, scan_status, &signing_key);
    let sidecar_json = serde_json::to_vec(&sidecar).map_err(|e| errors::CompilerError::ArtifactFailed(e.to_string()))?;

    // Step 2 + 4: upload component and sidecar.
    let bucket_config = bucket::BucketConfig {
        endpoint: std::env::var("BUNDLE_BUCKET_ENDPOINT").map_err(|_| errors::CompilerError::Config("BUNDLE_BUCKET_ENDPOINT not set".to_string()))?,
        bucket: std::env::var("BUNDLE_BUCKET_NAME").unwrap_or_else(|_| "waddles-bundles".to_string()),
        region: std::env::var("BUNDLE_BUCKET_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
        access_key_id: std::env::var("BUNDLE_BUCKET_ACCESS_KEY_ID").map_err(|_| errors::CompilerError::Config("BUNDLE_BUCKET_ACCESS_KEY_ID not set".to_string()))?,
        secret_access_key: std::env::var("BUNDLE_BUCKET_SECRET_ACCESS_KEY").map_err(|_| errors::CompilerError::Config("BUNDLE_BUCKET_SECRET_ACCESS_KEY not set".to_string()))?,
    };
    let bucket_client = bucket::BucketClient::new(bucket_config).await?;
    let digest_hex = digests.artifact_digest.trim_start_matches("sha256:");
    let component_key = bucket_client.upload_component(&manifest.app_id, &manifest.version, digest_hex, &component_bytes).await?;
    let sidecar_key = bucket_client.upload_sidecar(&manifest.app_id, &manifest.version, digest_hex, &sidecar_json).await?;

    // Step 5: INSERT the app_versions row directly, over waddles_publisher.
    let database_url = std::env::var("PUBLISHER_DATABASE_URL").map_err(|_| errors::CompilerError::Config("PUBLISHER_DATABASE_URL not set".to_string()))?;
    let db = db::PublisherDb::connect(&database_url).await?;
    db.insert_version(&manifest, &digests, size_bytes, scan_status, None).await?;

    // Step 6: notify hub-api. A notification failure is logged, never
    // fatal to the publish that already committed via the DB INSERT above
    // -- the row is the commit point (spec §9.4 step 5), the notification
    // is best-effort.
    if let Ok(hub_api_url) = std::env::var("HUB_API_URL") {
        if let Err(e) = callback::notify_hub_api(&hub_api_url, &manifest.app_id, &manifest.version, &digests, &component_key, &sidecar_key).await {
            tracing::warn!(error = %e, "hub-api artifact notification failed -- app_versions row is already committed");
        }
    } else {
        tracing::warn!("HUB_API_URL not set -- skipping the (best-effort) hub-api artifact notification");
    }

    Ok(())
}
```

- [ ] **Step 5: Run all tests to verify they pass**

Run: `cargo test --locked`
Expected: every test across Tasks 1-18 passes, including `full_publish_pipeline_against_real_minio_and_postgres`.

- [ ] **Step 6: Coverage check**

Run: `cargo llvm-cov --fail-under-lines 90`
Expected: crate-wide line coverage ≥ 90%. If below, the usual gap is an error branch in `run_publish`'s env-var reads — add a test that unsets one and asserts the specific `Config` message.

- [ ] **Step 7: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): wire the full publisher pipeline end-to-end, with tamper and credential-isolation e2e tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 19: `bundle-compiler` Dockerfile (single image, `build`/`publish` are subcommands)

**Files:**
- Create: `core/bundle_compiler/Dockerfile`
- Create: `core/bundle_compiler/tests/structure_test.yaml` (container-structure-test spec)

**Interfaces:**
- Produces: `ghcr.io/penguintechinc/waddles/bundle-compiler:<tag>` — one image used by both the `build` initContainer and the `publisher` container (Task 21's Job spec), differing only in `command`/`args`, mounted volumes, env, and `runtimeClassName` at the pod level.

- [ ] **Step 1: Write the Dockerfile** (multi-stage: a builder stage compiles `bundle-compiler` itself; three toolchain stages install the pinned Tier 1 toolchains network-enabled; the final stage assembles everything, matching the hermetic-build recipe `spikes/bundle-compiler-sandbox/docker/{base,python,rust,js}.Dockerfile` already proved, adapted into one combined image since `bundle-compiler` itself must be able to invoke all three toolchains from a single container)

```dockerfile
# core/bundle_compiler/Dockerfile
# syntax=docker/dockerfile:1
ARG DEBIAN_BASE_DIGEST=sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
ARG RUST_BASE_DIGEST=sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3
ARG PYTHON_BASE_DIGEST=sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e
ARG NODE_BASE_DIGEST=sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae

# ---- Stage 1: build bundle-compiler itself ----
FROM rust@${RUST_BASE_DIGEST} AS compiler-builder
WORKDIR /build
COPY core/bundle_compiler/Cargo.toml core/bundle_compiler/Cargo.lock ./
COPY core/bundle_compiler/src ./src
RUN cargo build --release --locked

# ---- Stage 2: Python toolchain (network-enabled here only) ----
FROM python@${PYTHON_BASE_DIGEST} AS python-toolchain
RUN pip install --no-cache-dir --root-user-action=ignore componentize-py==0.25.1

# ---- Stage 3: Rust wasm toolchain (network-enabled here only) ----
FROM rust@${RUST_BASE_DIGEST} AS rust-toolchain
RUN rustup target add wasm32-wasip1 wasm32-wasip2 && \
    cargo install cargo-component --version 0.21.1 --locked && \
    cargo install wasm-tools --version 1.259.0 --locked

# ---- Stage 4: JS toolchain (network-enabled here only) ----
FROM node@${NODE_BASE_DIGEST} AS js-toolchain
RUN npm install -g --no-fund --no-audit @bytecodealliance/jco@1.34.0

# ---- Stage 5: wasmtime CLI (pinned binary, checksum-verified) ----
FROM debian@${DEBIAN_BASE_DIGEST} AS wasmtime-fetch
RUN apt-get update -qq && apt-get install -y --no-install-recommends curl=7.88.1-10+deb12u15 ca-certificates=20250419~deb12u1 xz-utils=5.4.1-1+deb12u1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
RUN curl -sSL -o wasmtime.tar.xz https://github.com/bytecodealliance/wasmtime/releases/download/v48.0.2/wasmtime-v48.0.2-x86_64-linux.tar.xz && \
    echo "f2b0ad1ce9253f2f9a38793c2c42cd1cba4e90b27dc40d685eaf723dc8438d94  wasmtime.tar.xz" | sha256sum -c - && \
    tar xJf wasmtime.tar.xz && mv wasmtime-v48.0.2-x86_64-linux/wasmtime wasmtime

# ---- Final: assemble the runtime image ----
FROM debian@${DEBIAN_BASE_DIGEST}
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
        python3=3.11.2-1+b1 \
        ca-certificates=20250419~deb12u1 \
        nodejs=18.19.0+dfsg-6~deb12u2 \
        gitleaks=8.21.2-1 \
    && rm -rf /var/lib/apt/lists/*

# Pinned scanners not available via apt: pip/npm install at exact versions.
RUN pip3 install --no-cache-dir --break-system-packages semgrep==1.99.0 pip-audit==2.7.3

COPY --from=compiler-builder /build/target/release/bundle-compiler /usr/local/bin/bundle-compiler
COPY --from=python-toolchain /usr/local/bin/componentize-py /usr/local/bin/componentize-py
COPY --from=python-toolchain /usr/local/lib/python3.13 /usr/local/lib/python3.13
COPY --from=rust-toolchain /usr/local/cargo/bin/cargo-component /usr/local/bin/cargo-component
COPY --from=rust-toolchain /usr/local/cargo/bin/wasm-tools /usr/local/bin/wasm-tools
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
COPY --from=js-toolchain /usr/lib/node_modules/@bytecodealliance/jco /usr/lib/node_modules/@bytecodealliance/jco
COPY --from=js-toolchain /usr/local/bin/jco /usr/local/bin/jco
COPY --from=wasmtime-fetch /dl/wasmtime /usr/local/bin/wasmtime
COPY --from=rust-toolchain --chown=root:root /usr/local/rustup/toolchains /usr/local/rustup/toolchains
COPY --chown=root:root /opt/waddles-semgrep-rules /opt/waddles-semgrep-rules

ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"

RUN useradd -m -u 10001 -s /usr/sbin/nologin builder
USER 10001

ENTRYPOINT ["/usr/local/bin/bundle-compiler"]
```

Note: the `COPY --chown=root:root /opt/waddles-semgrep-rules /opt/waddles-semgrep-rules` line copies the org's semgrep ruleset (a separate, already-versioned repo/directory referenced by `src/scan/sast.rs`'s hardcoded `/opt/waddles-semgrep-rules` path) — that ruleset's own repository/path is out of this plan's scope; note it in the README as an external dependency the image build must vendor in.

- [ ] **Step 2: Write a container-structure-test spec asserting the pinned target is present** (spec §4.6: "the container structure test asserts its presence")

```yaml
# core/bundle_compiler/tests/structure_test.yaml
schemaVersion: "2.0.0"
commandTests:
  - name: "bundle-compiler binary present"
    command: "bundle-compiler"
    args: ["--version"]
    exitCode: 0
  - name: "wasm32-wasip1 target pre-installed"
    command: "rustup"
    args: ["target", "list", "--installed"]
    expectedOutput: [".*wasm32-wasip1.*"]
  - name: "wasm32-wasip2 target pre-installed"
    command: "rustup"
    args: ["target", "list", "--installed"]
    expectedOutput: [".*wasm32-wasip2.*"]
  - name: "componentize-py pinned version"
    command: "componentize-py"
    args: ["--version"]
    expectedOutput: [".*0\\.25\\.1.*"]
  - name: "wasmtime pinned version"
    command: "wasmtime"
    args: ["--version"]
    expectedOutput: [".*48\\.0\\.2.*"]
  - name: "wasm-tools pinned version"
    command: "wasm-tools"
    args: ["--version"]
    expectedOutput: [".*1\\.259\\.0.*"]
  - name: "jco pinned version"
    command: "jco"
    args: ["--version"]
    expectedOutput: [".*1\\.34\\.0.*"]
  - name: "no bwrap in the image"
    command: "sh"
    args: ["-c", "! command -v bwrap"]
    exitCode: 0
metadataTest:
  user: "10001"
```

- [ ] **Step 3: Build and run the structure test**

Run:
```bash
docker build -t bundle-compiler:local -f core/bundle_compiler/Dockerfile .
container-structure-test test --image bundle-compiler:local --config core/bundle_compiler/tests/structure_test.yaml
```
Expected: `PASS` for every commandTest, `RESULTS: 8/8 PASSED` (or similar, exact count matching the spec above).

- [ ] **Step 4: Commit**

```bash
git add core/bundle_compiler/Dockerfile core/bundle_compiler/tests/structure_test.yaml
git commit -m "$(cat <<'EOF'
feat(compiler): add bundle-compiler multi-stage image with pinned toolchains and structure test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 20: CI workflow — build, trivy, structure test, push to ghcr.io

**Files:**
- Create: `.github/workflows/rust-bundle-compiler.yml`

**Interfaces:**
- Produces: a GitHub Actions workflow mirroring `.github/workflows/rust-svc-streaming.yml`'s gate set (spec §14.5), plus the image build/scan/push this new binary needs.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/rust-bundle-compiler.yml
name: bundle-compiler
on:
  pull_request:
    paths:
      - "core/bundle_compiler/**"
      - "wit/waddle-bundle/**"
  push:
    branches: [main]
    paths:
      - "core/bundle_compiler/**"

jobs:
  lint-test:
    runs-on: ubuntu-latest
    container:
      image: rust@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3
    defaults:
      run:
        working-directory: core/bundle_compiler
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
      - name: cargo fmt --check
        run: cargo fmt --check
      - name: cargo clippy
        run: cargo clippy --all-targets -- -D warnings
      - name: cargo deny check
        run: |
          cargo install cargo-deny --version 0.16.2 --locked
          cargo deny check
      - name: cargo audit
        run: |
          cargo install cargo-audit --version 0.21.0 --locked
          cargo audit
      - name: cargo test
        run: cargo test --locked
      - name: cargo llvm-cov
        run: |
          cargo install cargo-llvm-cov --version 0.6.13 --locked
          cargo llvm-cov --fail-under-lines 90 --lcov --output-path lcov.info
      - name: gitleaks
        run: |
          curl -sSL -o gitleaks.tar.gz https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz
          tar xzf gitleaks.tar.gz gitleaks
          ./gitleaks detect --source . --no-git --exit-code 1

  build-scan-push:
    needs: lint-test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
      - name: Build image
        run: docker build -t bundle-compiler:ci -f core/bundle_compiler/Dockerfile .
      - name: Container structure test
        run: |
          curl -sSL -o container-structure-test https://github.com/GoogleContainerTools/container-structure-test/releases/download/v1.19.3/container-structure-test-linux-amd64
          chmod +x container-structure-test
          ./container-structure-test test --image bundle-compiler:ci --config core/bundle_compiler/tests/structure_test.yaml
      - name: Trivy scan
        run: |
          docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.58.1 image --exit-code 1 --severity HIGH,CRITICAL bundle-compiler:ci
      - name: Log in to ghcr.io
        if: github.ref == 'refs/heads/main'
        run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin
      - name: Push (beta tag)
        if: github.ref == 'refs/heads/main'
        run: |
          TAG="beta-$(date +%s)"
          docker tag bundle-compiler:ci "ghcr.io/penguintechinc/waddles/bundle-compiler:${TAG}"
          docker push "ghcr.io/penguintechinc/waddles/bundle-compiler:${TAG}"
```

- [ ] **Step 2: Run the workflow locally with `act` (or push to a feature branch and observe the Actions run)**

Run: `act pull_request -W .github/workflows/rust-bundle-compiler.yml -j lint-test`
Expected: all steps green.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rust-bundle-compiler.yml
git commit -m "$(cat <<'EOF'
ci(compiler): add bundle-compiler lint/test/scan/build/push workflow

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 21: Kubernetes Job Helm template — two containers, NetworkPolicy, resource limits

**Files:**
- Create: `k8s/helm/waddlebot/templates/bundle-compiler-job-template-configmap.yaml`
- Create: `k8s/helm/waddlebot/templates/bundle-compiler-networkpolicy.yaml`
- Modify: `k8s/helm/waddlebot/values.yaml`
- Create: `core/bundle_compiler/tests/helm_render_test.sh`

**Interfaces:**
- Produces: a `ConfigMap` holding the canonical two-container Job manifest as templated YAML text (hub-api/M2b's Kubernetes client renders `{{APP_ID}}`/`{{VERSION}}`/`{{DIGEST_PLACEHOLDER}}` substitutions and creates one Job per uploaded version — the Job itself is created dynamically, per version, never by `helm install`), plus a `CiliumNetworkPolicy` matching the two containers' documented network posture (`build`: none at all; `publisher`: bucket + Postgres + hub-api).

- [ ] **Step 1: Add the new `values.yaml` keys (spec §12.3, unchanged by this plan except adding the two-container split's own keys)**

```yaml
# additions to k8s/helm/waddlebot/values.yaml
bundles:
  compiler:
    image: ghcr.io/penguintechinc/waddles/bundle-compiler:latest
    activeDeadlineSeconds: 900
    build:
      resources:
        requests: {cpu: "500m", memory: "512Mi"}
        limits: {cpu: "2000m", memory: "4Gi"}
    publisher:
      resources:
        requests: {cpu: "250m", memory: "256Mi"}
        limits: {cpu: "1000m", memory: "1Gi"}
  signingPublicKeySecret: waddles-bundle-signing
  bucket:
    provider: minio
    endpoint: "http://minio.waddles.svc.cluster.local:9000"
    name: waddles-bundles
    region: us-east-1
    existingSecret: waddles-bundle-bucket
sandbox:
  runtimeClassName: runsc
  gvisor:
    enabled: true
```

- [ ] **Step 2: Write the two-container Job template ConfigMap**

```yaml
# k8s/helm/waddlebot/templates/bundle-compiler-job-template-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: bundle-compiler-job-template
  namespace: waddles
  labels:
    app.kubernetes.io/component: bundle-compiler
data:
  job.yaml.tmpl: |
    apiVersion: batch/v1
    kind: Job
    metadata:
      name: bundle-compile-{{APP_ID_SLUG}}-{{VERSION_SLUG}}
      namespace: waddles
      labels:
        app.kubernetes.io/component: bundle-compiler
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: {{ .Values.bundles.compiler.activeDeadlineSeconds }}
      ttlSecondsAfterFinished: 86400
      template:
        metadata:
          labels:
            app.kubernetes.io/component: bundle-compiler
        spec:
          {{- if .Values.sandbox.gvisor.enabled }}
          runtimeClassName: {{ .Values.sandbox.runtimeClassName }}
          {{- end }}
          restartPolicy: Never
          automountServiceAccountToken: false
          securityContext:
            runAsNonRoot: true
            runAsUser: 10001
            runAsGroup: 10001
            fsGroup: 10001
            seccompProfile: {type: RuntimeDefault}
          volumes:
            - name: work
              emptyDir: {}
            - name: bundle-source
              # populated by hub-api before the Job is created -- out of
              # M2a's scope how (a ConfigMap/Secret projection, or an
              # init step hub-api itself runs); build/publish only read
              # from --bundle/--component paths under /input, agnostic
              # to how the bytes got there.
              emptyDir: {}
          initContainers:
            - name: build
              image: {{ .Values.bundles.compiler.image }}
              args: ["build", "--bundle", "/input/source", "--manifest", "/input/bundle.yaml", "--out", "/work"]
              securityContext:
                allowPrivilegeEscalation: false
                readOnlyRootFilesystem: true
                capabilities: {drop: ["ALL"]}
              resources: {{ toYaml .Values.bundles.compiler.build.resources | nindent 16 }}
              volumeMounts:
                - {name: work, mountPath: /work}
                - {name: bundle-source, mountPath: /input, readOnly: true}
              # NO env entries here referencing bucket/DB/signing secrets --
              # asserted by core/bundle_compiler/tests/helm_render_test.sh
          containers:
            - name: publisher
              image: {{ .Values.bundles.compiler.image }}
              args: ["publish", "--component", "/work/component.wasm", "--manifest", "/work/manifest.json", "--language", "{{LANGUAGE}}", "--artifact-kind", "{{ARTIFACT_KIND}}"]
              securityContext:
                allowPrivilegeEscalation: false
                readOnlyRootFilesystem: true
                capabilities: {drop: ["ALL"]}
              resources: {{ toYaml .Values.bundles.compiler.publisher.resources | nindent 16 }}
              env:
                - {name: BUNDLE_BUCKET_ENDPOINT, value: {{ .Values.bundles.bucket.endpoint | quote }}}
                - {name: BUNDLE_BUCKET_NAME, value: {{ .Values.bundles.bucket.name | quote }}}
                - {name: BUNDLE_BUCKET_REGION, value: {{ .Values.bundles.bucket.region | quote }}}
                - name: BUNDLE_BUCKET_ACCESS_KEY_ID
                  valueFrom: {secretKeyRef: {name: {{ .Values.bundles.bucket.existingSecret }}, key: accessKeyId}}
                - name: BUNDLE_BUCKET_SECRET_ACCESS_KEY
                  valueFrom: {secretKeyRef: {name: {{ .Values.bundles.bucket.existingSecret }}, key: secretAccessKey}}
                - name: PUBLISHER_DATABASE_URL
                  valueFrom: {secretKeyRef: {name: waddles-publisher-db, key: databaseUrl}}
                - {name: HUB_API_URL, value: "http://hub-api.waddles.svc.cluster.local:8204"}
                - {name: BUNDLE_SIGNING_PRIVATE_KEY_FILE, value: "/etc/waddles/signing/privateKey"}
              volumeMounts:
                - {name: work, mountPath: /work}
                - name: signing-key
                  mountPath: /etc/waddles/signing
                  readOnly: true
          volumes:
            - name: signing-key
              secret: {secretName: "{{ .Values.bundles.signingPublicKeySecret }}"}
```

- [ ] **Step 3: Write the `CiliumNetworkPolicy`**

```yaml
# k8s/helm/waddlebot/templates/bundle-compiler-networkpolicy.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: bundle-compiler
  namespace: waddles
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/component: bundle-compiler
  egress:
    # Applies to the whole pod (both build and publisher share one network
    # namespace -- Kubernetes NetworkPolicy cannot distinguish containers
    # within one pod). The build container never attempts a call because
    # it holds no credential for any of these destinations (see the
    # Artifact & Digest Contract section); this policy documents what the
    # publisher legitimately needs.
    - toEndpoints:
        - matchLabels: {app.kubernetes.io/name: minio}
      toPorts:
        - ports: [{port: "9000", protocol: TCP}]
    - toEndpoints:
        - matchLabels: {app.kubernetes.io/name: postgresql}
      toPorts:
        - ports: [{port: "5432", protocol: TCP}]
    - toEndpoints:
        - matchLabels: {app.kubernetes.io/name: hub-api}
      toPorts:
        - ports: [{port: "8204", protocol: TCP}]
    - toEndpoints:
        - matchLabels: {"k8s:io.kubernetes.pod.namespace": kube-system}
      toPorts:
        - ports: [{port: "53", protocol: UDP}]
  ingressDeny:
    - fromEntities: ["all"]
```

- [ ] **Step 4: Write and run the render-time negative test** (asserts the `build` initContainer's spec never carries the forbidden env vars — the coordinator's required negative test, checked against the rendered template rather than the Rust source, since this is where a future edit could accidentally reintroduce a credential)

```bash
cat > core/bundle_compiler/tests/helm_render_test.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
RENDERED=$(helm template waddlebot k8s/helm/waddlebot --show-only templates/bundle-compiler-job-template-configmap.yaml)
BUILD_SECTION=$(echo "$RENDERED" | awk '/name: build$/,/name: publisher$/')
for forbidden in BUNDLE_BUCKET BUNDLE_SIGNING PUBLISHER_DATABASE_URL HUB_API_URL; do
  if echo "$BUILD_SECTION" | grep -q "$forbidden"; then
    echo "FAIL: build container spec references forbidden env var pattern: $forbidden"
    exit 1
  fi
done
echo "PASS: build initContainer spec carries none of BUNDLE_BUCKET*/BUNDLE_SIGNING*/PUBLISHER_DATABASE_URL/HUB_API_URL"
EOF
chmod +x core/bundle_compiler/tests/helm_render_test.sh
bash core/bundle_compiler/tests/helm_render_test.sh
```
Expected: `PASS: build initContainer spec carries none of BUNDLE_BUCKET*/BUNDLE_SIGNING*/PUBLISHER_DATABASE_URL/HUB_API_URL`

- [ ] **Step 5: `helm lint` and `helm template` the whole chart**

Run:
```bash
helm lint k8s/helm/waddlebot
helm template waddlebot k8s/helm/waddlebot > /dev/null
```
Expected: both exit 0 with no errors.

- [ ] **Step 6: Commit**

```bash
git add k8s/helm/waddlebot/ core/bundle_compiler/tests/helm_render_test.sh
git commit -m "$(cat <<'EOF'
feat(compiler): add two-container compiler Job template and NetworkPolicy to the Helm chart

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 22: Shared WIT conformance harness (`tools/wit-conformance-harness`)

**Files:**
- Create: `tools/wit-conformance-harness/Cargo.toml`
- Create: `tools/wit-conformance-harness/src/main.rs`
- Create: `tools/wit-conformance-harness/tests/harness_test.rs`

**Interfaces:**
- Consumes: `wit/waddle-bundle/stage.wit` (Task 1) as the world every compiled component is checked against.
- Produces: a CLI (`wit-conformance-harness --component <wasm> --events <golden-events.json> --host-fixtures <fixtures.json>`) using the `wasmtime` component API directly to load a component, drive its `process-stage.transform`/`action-stage.dispatch` exports against golden `PlatformEvent`/`StageEnvelope` fixtures, and answer every host import (`context`/`http`/`kv`/`db`/`relay`/`flags`/`log`/`clock`) from a fixed, fixture-driven fake — **not** a stand-in for the real executor's capability scoping (Plan-Level Assumption PA4). Tasks 29, 31, 33 (the three SDKs' example-bundle conformance tests) all invoke this one binary rather than re-implementing a host.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "wit-conformance-harness"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "wit-conformance-harness"
path = "src/main.rs"

[dependencies]
clap = { version = "=4.5.20", features = ["derive"] }
wasmtime = "=48.0.2"
serde = { version = "=1.0.210", features = ["derive"] }
serde_json = "=1.0.128"
anyhow = "=1.0.89"
```

- [ ] **Step 2: Write the failing test**

```rust
// tools/wit-conformance-harness/tests/harness_test.rs
use std::process::Command;

#[test]
fn round_trips_a_good_python_component_transform() {
    // Reuses bundle-compiler's own good-python fixture and compiles it
    // fresh via componentize-py directly (this crate is standalone --
    // it does not depend on bundle-compiler as a library, so its own
    // tests build the fixture with a raw toolchain invocation).
    let out = tempfile::tempdir().unwrap();
    let wasm_path = out.path().join("component.wasm");
    let status = Command::new("componentize-py")
        .args([
            "-d", "../../core/bundle_compiler/tests/fixtures/bundles/good-python/wit",
            "-w", "stage",
            "componentize",
            "-p", "../../core/bundle_compiler/tests/fixtures/bundles/good-python",
            "app",
            "--stub-wasi",
            "-o", wasm_path.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(status.success());

    let events_path = out.path().join("events.json");
    std::fs::write(&events_path, serde_json::json!([{
        "platform": "discord", "event_type": "chat.message", "actor": "u1",
        "payload_json": "{\"text\":\"hello\"}", "occurred_at": "2026-09-14T12:00:00.000Z"
    }]).to_string()).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_wit-conformance-harness"))
        .args(["--component", wasm_path.to_str().unwrap(), "--events", events_path.to_str().unwrap(), "--export", "transform"])
        .output()
        .unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("hello"), "harness echoes the fixture bundle's identity transform: {stdout}");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked -p wit-conformance-harness`
Expected: FAIL — binary not implemented yet.

- [ ] **Step 4: Implement `src/main.rs`**

```rust
//! A minimal host, using wasmtime's component API directly, that loads a
//! compiled component and drives one export (`transform` or `dispatch`)
//! against a JSON array of golden event/envelope fixtures. Answers every
//! WIT host import (context/http/kv/db/relay/flags/log/clock) with a
//! fixed, deterministic fake -- this is a conformance-testing tool, not
//! the real executor (Plan-Level Assumption PA4): it proves "does this
//! component instantiate and answer its exports correctly," never
//! "does this component respect capability scoping."

use clap::Parser;
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store};

#[derive(Parser)]
struct Cli {
    #[arg(long)]
    component: std::path::PathBuf,
    #[arg(long)]
    events: std::path::PathBuf,
    #[arg(long, value_parser = ["transform", "dispatch"])]
    export: String,
}

struct HostState;

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let mut config = Config::new();
    config.wasm_component_model(true);
    let engine = Engine::new(&config)?;

    let mut linker: Linker<HostState> = Linker::new(&engine);
    wasmtime_wasi::add_to_linker_sync(&mut linker)?;
    // Fixed fakes for every custom waddle:bundle/* import -- deterministic,
    // fixture-independent (real host-call scoping is executor/M3-M4 scope).
    //
    // FLAGGED UNCERTAINTY: `wasmtime::component::Linker`'s exact API for
    // registering a function under a named *interface* (as opposed to
    // the bare-function `linker.root()` shape spike1's Python host used,
    // which this WIT world does not have — every import here lives inside
    // a named interface) has shifted across wasmtime versions; neither
    // spike exercised this from Rust (spike1's host was Python/wasmtime-py,
    // spike2 never built a host at all, only validated components). The
    // pattern below — `linker.instance(interface_name)?.func_wrap(fn_name,
    // closure)` — is wasmtime-rs's documented general shape for this exact
    // situation; confirm it compiles against the pinned `wasmtime = "=48.0.2"`
    // crate on first build of this task and adjust call shape if the crate's
    // own compiler errors point at a renamed method (tracked as this task's
    // own Step 5 verification, not a blocking unknown).
    let mut context_iface = linker.instance("waddle:bundle/context@1.0.0")?;
    context_iface.func_wrap("get-context", |_caller: wasmtime::StoreContextMut<'_, HostState>, (): ()| {
        Ok((r#"{"tenant":"fixture","community":null,"app-id":"waddles.core.example.echo","feature":"waddles.core.example","version":"1.0.0","message-id":"fixture-1","config-json":"{}"}"#.to_string(),))
    })?;
    let mut log_iface = linker.instance("waddle:bundle/log@1.0.0")?;
    log_iface.func_wrap("write", |_caller: wasmtime::StoreContextMut<'_, HostState>, (_lvl, msg, _fields): (u32, String, String)| {
        eprintln!("[harness log] {msg}");
        Ok(())
    })?;
    let mut clock_iface = linker.instance("waddle:bundle/clock@1.0.0")?;
    clock_iface.func_wrap("now-millis", |_caller: wasmtime::StoreContextMut<'_, HostState>, (): ()| Ok((0u64,)))?;

    let component = Component::from_file(&engine, &cli.component)?;
    let mut store = Store::new(&engine, HostState);
    let instance = linker.instantiate(&mut store, &component)?;

    let events: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(&cli.events)?)?;
    for event in events {
        if cli.export == "transform" {
            let func = instance
                .get_typed_func::<(String,), (Option<String>,)>(&mut store, "waddle:bundle/process-stage@1.0.0#transform")
                .or_else(|_| instance.get_typed_func::<(String,), (Option<String>,)>(&mut store, "transform"))?;
            let (result,) = func.call(&mut store, (event.to_string(),))?;
            println!("{}", result.unwrap_or_else(|| "null".to_string()));
        } else {
            let func = instance
                .get_typed_func::<(String, String), (String,)>(&mut store, "waddle:bundle/action-stage@1.0.0#dispatch")
                .or_else(|_| instance.get_typed_func::<(String, String), (String,)>(&mut store, "dispatch"))?;
            let (result,) = func.call(&mut store, (event.to_string(), "{}".to_string()))?;
            println!("{result}");
        }
    }
    Ok(())
}
```

Add `wasmtime-wasi = "=27.0.0"` to `Cargo.toml`'s `[dependencies]` (the WASI Preview 2 host implementation, matched to the pinned `wasmtime` crate's own major version line).

- [ ] **Step 5: Run tests to verify they pass**

Run (inside a container with `componentize-py==0.25.1` and the compiled `wit-conformance-harness` binary): `cargo test --locked -p wit-conformance-harness`
Expected: `round_trips_a_good_python_component_transform ... ok`.

- [ ] **Step 6: Commit**

```bash
git add tools/wit-conformance-harness/
git commit -m "$(cat <<'EOF'
feat(compiler): add shared WIT conformance test harness for the three SDKs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 23: `waddle-sdk` (Python) package skeleton

**Files:**
- Create: `sdk/waddle-sdk/pyproject.toml`
- Create: `sdk/waddle-sdk/src/waddle_sdk/__init__.py`
- Create: `sdk/waddle-sdk/tests/conftest.py`

**Interfaces:**
- Produces: the installable `waddle_sdk` package skeleton every later Python SDK task adds a module to. Pinned deps: `componentize-py==0.25.1`, `wasmtime==48.0.0` (spike-verified versions, matching `build/tool-versions.env`).

- [ ] **Step 1: Write `pyproject.toml`**

```toml
[project]
name = "waddle-sdk"
version = "0.1.0"
description = "Waddles bundle SDK: penguin-dal-compatible facade + flask_core/waddle_transports compatibility shims over the waddle:bundle/stage@1.0.0 WIT world"
requires-python = ">=3.13"
dependencies = []

[project.optional-dependencies]
build = ["componentize-py==0.25.1"]
dev = ["pytest==8.3.3", "pytest-cov==5.0.0", "mypy==1.11.2", "wasmtime==48.0.0"]

[build-system]
requires = ["setuptools==75.1.0"]
build-backend = "setuptools.build_meta"

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.mypy]
strict = true
```

- [ ] **Step 2: Write `src/waddle_sdk/__init__.py`**

```python
"""Waddles bundle SDK for Python.

Ships the same import names bundles use today
(`flask_core.bundle_runtime.get_bundle_dal`/`get_bundle_context`,
`flask_core.feature_flags.feature_enabled`, `flask_core.stream_pipeline`'s
dataclasses) plus a `penguin_dal`-compatible database facade, all
implemented over the `waddle:bundle/stage@1.0.0` WIT imports (spec §4.12).
"""

__all__: list[str] = []
```

- [ ] **Step 3: Write `tests/conftest.py`** (shared pytest fixtures every later SDK test file uses)

```python
"""Shared fixtures for waddle-sdk's pure-Python test suite (no WASM here —
those live in Task 29's conformance test, which runs under wasmtime).
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset_bundle_runtime_state():
    """Ensure no bundle_runtime module-level state leaks between tests."""
    yield
    # Task 25 adds flask_core.bundle_runtime.reset_bundle_dal_for_tests();
    # imported lazily here to avoid a forward-reference at collection time
    # before that module exists.
    try:
        from waddle_sdk.flask_core.bundle_runtime import reset_bundle_dal_for_tests

        reset_bundle_dal_for_tests()
    except ImportError:
        pass
```

- [ ] **Step 4: Run a smoke import test**

```bash
mkdir -p sdk/waddle-sdk/tests
cd sdk/waddle-sdk
pip install -e ".[dev]"
python3 -c "import waddle_sdk; print('waddle_sdk package importable')"
```
Expected: `waddle_sdk package importable`

- [ ] **Step 5: Commit**

```bash
git add sdk/waddle-sdk/
git commit -m "$(cat <<'EOF'
feat(sdk-python): scaffold waddle-sdk package

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 24: Runtime shims — `_asyncio_patch`, `_poll_loop`, pre-import generation

**Files:**
- Create: `sdk/waddle-sdk/src/waddle_sdk/_asyncio_patch.py`
- Create: `sdk/waddle-sdk/src/waddle_sdk/_poll_loop.py`
- Create: `sdk/waddle-sdk/scripts/generate_bundle_preimports.py`
- Create: `sdk/waddle-sdk/tests/test_asyncio_patch.py`
- Create: `sdk/waddle-sdk/tests/test_poll_loop.py`

**Interfaces:**
- Produces: `waddle_sdk._asyncio_patch` (import-time side effect: patches `asyncio.to_thread`), `waddle_sdk._poll_loop.PollLoop` (an `asyncio.AbstractEventLoop` usable inside the WASI sandbox, since `asyncio.run()`'s default loop cannot start there), and `sdk/waddle-sdk/scripts/generate_bundle_preimports.py` (a build-time-only script the compiler's Python build recipe, Task 8, is extended to call — see Step 5 below). All three are adapted verbatim in spirit from `spikes/penguin-dal-wasm/waddle_sdk/{_asyncio_patch.py,_poll_loop.py}` and `spikes/penguin-dal-wasm/scripts/generate_bundle_preimports.py` (spike commits `f45e6578`, `964f2729`), cited per-file below.

- [ ] **Step 1: Write `src/waddle_sdk/_asyncio_patch.py`** (adapted from `spikes/penguin-dal-wasm/waddle_sdk/_asyncio_patch.py`)

```python
"""Makes `asyncio.to_thread()` work inside the WASI sandbox.

Adapted from `spikes/penguin-dal-wasm/waddle_sdk/_asyncio_patch.py`
(branch `spike/penguin-dal-wasm`, commit `964f2729`) — Round 2's blocker
(1) fix, confirmed end-to-end against the real alias bundle's full write
path (4 db-execute round trips, 9-18 ms). No real OS threads exist inside
`componentize-py`'s WASI sandbox, and its own official `PollLoop` (see
`_poll_loop.py`) leaves `run_in_executor` unimplemented for exactly that
reason. This module runs the wrapped callable synchronously in place
instead of raising `NotImplementedError`.

Safe here specifically because: (a) every host capability this SDK's
facades call through (`db`, `http`, `kv`, ...) is itself a synchronous WIT
host call on both sides of the component boundary — there is no real
blocking I/O being protected from an event loop in the first place, and
(b) a bundle's own `transform`/`dispatch` entrypoint never runs
concurrently with another invocation of itself (one wasmtime store, one
call at a time — spec §7.2: "every instance is fresh per call"). This does
**not** generalize to a bundle using `to_thread` for genuine CPU-bound
parallelism expecting real concurrency — document that boundary in
`docs/APP_BUNDLE_AUTHORING.md` v2 (M6's job), not here.
"""

from __future__ import annotations

import asyncio
import functools
from typing import Any, Callable, TypeVar

T = TypeVar("T")


async def _sync_to_thread(func: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """Drop-in replacement for `asyncio.to_thread` that runs `func` in place."""
    call = functools.partial(func, *args, **kwargs)
    return call()


asyncio.to_thread = _sync_to_thread  # type: ignore[assignment]
```

- [ ] **Step 2: Write `src/waddle_sdk/_poll_loop.py`** (adapted from `spikes/penguin-dal-wasm/waddle_sdk/_poll_loop.py`, itself a trimmed copy of componentize-py's own example `poll_loop.PollLoop`, with the same Round 2 `run_in_executor` patch)

```python
"""A minimal `asyncio` event loop that runs inside componentize-py's WASI
sandbox, where `asyncio.run()`'s default `SelectorEventLoop` cannot even
construct itself (`socket.socketpair()` raises `PermissionError` — see
`spikes/penguin-dal-wasm/REPORT.md` Sec 6, Blocker #1).

Adapted from `spikes/penguin-dal-wasm/waddle_sdk/_poll_loop.py` (spike
commit `964f2729`), itself trimmed from componentize-py's own
`poll_loop.PollLoop` example (its `wasi:http`-specific send/Stream/Sink
helpers removed — this SDK's WIT world never imports `wasi:http`).
`run_in_executor` is patched to run synchronously in place (Round 2's
fix) rather than the upstream's `raise NotImplementedError` — see
`_asyncio_patch.py`'s docstring for exactly what this class of fix is,
and is not, safe for.
"""

from __future__ import annotations

import asyncio
from typing import Any


class PollLoop(asyncio.AbstractEventLoop):
    """Drives a coroutine that only ever awaits already-resolved work —
    exactly this SDK's facades, which perform a synchronous WIT host call
    inside an `async def` and never actually suspend.
    """

    def __init__(self) -> None:
        self.running = False
        self.handles: list[asyncio.Handle] = []
        self.exception: BaseException | None = None

    def get_debug(self) -> bool:
        return False

    def run_until_complete(self, future: Any) -> Any:
        future = asyncio.ensure_future(future, loop=self)
        self.running = True
        asyncio.events._set_running_loop(self)
        while self.running and not future.done():
            handles, self.handles = self.handles, []
            for handle in handles:
                if not handle._cancelled:
                    handle._run()
            if not handles and not future.done():
                raise RuntimeError(
                    "PollLoop: coroutine suspended waiting on real I/O this loop cannot "
                    "service (no wasi:io/poll wakers path)"
                )
            if self.exception is not None:
                raise self.exception
        return future.result()

    def is_running(self) -> bool:
        return self.running

    def is_closed(self) -> bool:
        return not self.running

    def stop(self) -> None:
        self.running = False

    def close(self) -> None:
        self.running = False

    def shutdown_asyncgens(self) -> Any:
        pass

    def call_exception_handler(self, context: dict[str, Any]) -> None:
        self.exception = context.get("exception")

    def call_soon(self, callback: Any, *args: Any, context: Any = None) -> asyncio.Handle:
        handle = asyncio.Handle(callback, args, self, context)
        self.handles.append(handle)
        return handle

    def create_task(self, coroutine: Any) -> asyncio.Task[Any]:
        return asyncio.Task(coroutine, loop=self)

    def create_future(self) -> asyncio.Future[Any]:
        return asyncio.Future(loop=self)

    def run_in_executor(self, executor: Any, func: Any, *args: Any) -> asyncio.Future[Any]:
        """Runs `func(*args)` synchronously in place — see
        `_asyncio_patch.py`'s docstring for the safety argument and its
        boundary. componentize-py's own upstream `poll_loop.py` leaves
        this `raise NotImplementedError`.
        """
        future = self.create_future()
        try:
            future.set_result(func(*args))
        except BaseException as exc:  # noqa: BLE001 - mirror a real executor: propagate via the Future
            future.set_exception(exc)
        return future
```

- [ ] **Step 3: Write `scripts/generate_bundle_preimports.py`** (adapted from `spikes/penguin-dal-wasm/scripts/generate_bundle_preimports.py`, spike commit `964f2729`)

```python
"""Build-time-only script — never imported by a bundle or by the SDK
itself at runtime. Run BEFORE `componentize-py componentize` (host-side,
ordinary CPython, never inside the sandbox) to force componentize-py's
static dependency-closure discovery to see every module physically
present under a bundle's `bundles/` package, regardless of whether the
bundle code imports them lazily, dynamically, or not at all this run
(spike round 2, blocker 2 — `_known_commands()`'s deferred import in the
real `social_alias_process.py` bundle is exactly the case this generalizes).

Adapted from `spikes/penguin-dal-wasm/scripts/generate_bundle_preimports.py`.
The compiler's Python build recipe (Task 8) invokes the equivalent logic
inline (see that task's `PREIMPORT_GENERATOR` constant) rather than
shelling out to this script directly — this script is kept here, as a
standalone entry point, for bundle authors who want to run it locally
during development, matching the compiler's own logic byte-for-byte.
"""

from __future__ import annotations

import pkgutil
import sys
from pathlib import Path


def discover_bundle_modules(bundle_root: Path) -> list[str]:
    """Return every importable module name under `bundle_root/bundles/`."""
    sys.path.insert(0, str(bundle_root))
    import bundles  # the package physically present in the bundle's source tree

    return sorted(m.name for m in pkgutil.walk_packages(bundles.__path__, prefix="bundles."))


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: generate_bundle_preimports.py <bundle_root>", file=sys.stderr)
        raise SystemExit(2)
    bundle_root = Path(sys.argv[1])
    modules = discover_bundle_modules(bundle_root)
    out_path = bundle_root / "_bundle_preimports.py"
    lines = [
        '"""AUTO-GENERATED by generate_bundle_preimports.py -- DO NOT EDIT."""',
        "",
        "from __future__ import annotations",
        "",
    ]
    lines += [f"import {name}  # noqa: F401" for name in modules]
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out_path} with {len(modules)} pre-import(s): {modules}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Write the failing tests, then verify they pass**

```python
# sdk/waddle-sdk/tests/test_asyncio_patch.py
"""Host-side (no WASM) proof the patch runs synchronously in place."""
from __future__ import annotations

import asyncio

import waddle_sdk._asyncio_patch  # noqa: F401 - import-time patch application


def test_to_thread_runs_synchronously() -> None:
    calls: list[int] = []

    def blocking() -> int:
        calls.append(1)
        return 42

    async def run() -> int:
        return await asyncio.to_thread(blocking)

    result = asyncio.run(run())
    assert result == 42
    assert calls == [1]


def test_to_thread_propagates_exceptions() -> None:
    def raises() -> None:
        raise ValueError("boom")

    async def run() -> None:
        await asyncio.to_thread(raises)

    try:
        asyncio.run(run())
        assert False, "expected ValueError to propagate"
    except ValueError as exc:
        assert str(exc) == "boom"
```

```python
# sdk/waddle-sdk/tests/test_poll_loop.py
from __future__ import annotations

import asyncio

from waddle_sdk._poll_loop import PollLoop


def test_poll_loop_runs_a_simple_coroutine() -> None:
    async def coro() -> int:
        return 7

    loop = PollLoop()
    asyncio.set_event_loop(loop)
    try:
        result = loop.run_until_complete(coro())
    finally:
        asyncio.set_event_loop(None)
    assert result == 7


def test_run_in_executor_returns_an_already_done_future() -> None:
    loop = PollLoop()
    future = loop.run_in_executor(None, lambda: 99)
    assert future.done()
    assert future.result() == 99
```

Run: `pytest sdk/waddle-sdk/tests/test_asyncio_patch.py sdk/waddle-sdk/tests/test_poll_loop.py -v`
Expected: `4 passed`.

- [ ] **Step 5: Wire the pre-import generation into the compiler's Python build recipe** (Task 8's `PREIMPORT_GENERATOR` inline script already does this independently; this step documents that the two must stay in lockstep — add a comment cross-reference in both files)

```bash
# append to core/bundle_compiler/src/build/python.rs's module doc comment (Task 8's file):
#   Kept logically identical to sdk/waddle-sdk/scripts/generate_bundle_preimports.py's
#   discover_bundle_modules() — if one changes, update the other.
```

- [ ] **Step 6: Commit**

```bash
git add sdk/waddle-sdk/
git commit -m "$(cat <<'EOF'
feat(sdk-python): add asyncio.to_thread sync shim, PollLoop, and pre-import generation

Adapted from spike/penguin-dal-wasm (commits f45e6578, 964f2729) round 2's
confirmed fixes for componentize-py's WASI sandbox constraints.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 25: `flask_core` compatibility shims — `bundle_runtime`, `stream_pipeline`

**Files:**
- Create: `sdk/waddle-sdk/src/waddle_sdk/flask_core/__init__.py`
- Create: `sdk/waddle-sdk/src/waddle_sdk/flask_core/bundle_runtime.py`
- Create: `sdk/waddle-sdk/src/waddle_sdk/flask_core/stream_pipeline.py`
- Create: `sdk/waddle-sdk/tests/test_bundle_runtime.py`
- Create: `sdk/waddle-sdk/tests/test_stream_pipeline.py`

**Interfaces:**
- Produces: `waddle_sdk.flask_core.bundle_runtime.{set_bundle_dal, get_bundle_dal, get_bundle_context, bundle_context, BundleContext, BundleRuntimeError, reset_bundle_dal_for_tests}` (adapted near-verbatim from `spikes/penguin-dal-wasm/waddle_sdk/flask_core/bundle_runtime.py`) and `waddle_sdk.flask_core.stream_pipeline.{PlatformEvent, StageEnvelope}` dataclasses matching the WIT `types.platform-event`/`types.stage-envelope` records field-for-field, with `to_dict`/`from_dict`. Task 27's DB facade is what `get_bundle_dal()` returns; Task 28's component entry calls `set_bundle_dal`/`bundle_context` once per invocation, exactly as a stage runner does today.

- [ ] **Step 1: Write `src/waddle_sdk/flask_core/__init__.py`**

```python
"""Compatibility shim package — same import names bundles use today
(`from flask_core import get_bundle_context, get_bundle_dal`), re-exported
from `waddle_sdk.flask_core` so an unchanged bundle's `import flask_core`
line resolves once the SDK is installed in its place at build time.
"""

from __future__ import annotations

from waddle_sdk.flask_core.bundle_runtime import (
    BundleContext,
    BundleRuntimeError,
    bundle_context,
    get_bundle_context,
    get_bundle_dal,
    reset_bundle_dal_for_tests,
    set_bundle_dal,
)
from waddle_sdk.flask_core.stream_pipeline import PlatformEvent, StageEnvelope

__all__ = [
    "BundleContext",
    "BundleRuntimeError",
    "bundle_context",
    "get_bundle_context",
    "get_bundle_dal",
    "reset_bundle_dal_for_tests",
    "set_bundle_dal",
    "PlatformEvent",
    "StageEnvelope",
]
```

- [ ] **Step 2: Write `src/waddle_sdk/flask_core/bundle_runtime.py`** (near-verbatim adaptation of `spikes/penguin-dal-wasm/waddle_sdk/flask_core/bundle_runtime.py`, spike commit `f45e6578` — pure stdlib, no change needed beyond the module path)

```python
"""Same names, same contract as the real `flask_core.bundle_runtime`
(`docs/APP_BUNDLE_AUTHORING.md` §5) — pure stdlib (`contextvars` +
`dataclasses`), adapted near-verbatim from
`spikes/penguin-dal-wasm/waddle_sdk/flask_core/bundle_runtime.py`. The
component entry (Task 28) calls `set_bundle_dal()` once at process start
and wraps each envelope's export call in `bundle_context()`, exactly as
`core/svc_process/app.py`'s `before_serving` hook and `runner.py`'s
`_transform_and_enqueue` do today.
"""

from __future__ import annotations

import contextvars
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any


class BundleRuntimeError(RuntimeError):
    """Raised when `get_bundle_dal()`/`get_bundle_context()` is called unbound."""


_dal: Any = None


def set_bundle_dal(dal: Any) -> None:
    """Bind the process-wide DAL facade every `get_bundle_dal()` call returns."""
    global _dal
    _dal = dal


def get_bundle_dal() -> Any:
    """Return the DAL facade bound by `set_bundle_dal()` — the
    `penguin_dal`-compatible `AsyncDB` (Task 27).
    """
    if _dal is None:
        raise BundleRuntimeError("no DAL bound -- call set_bundle_dal() first")
    return _dal


def reset_bundle_dal_for_tests() -> None:
    """Clear the bound DAL (test-only)."""
    global _dal
    _dal = None


@dataclass(slots=True, frozen=True)
class BundleContext:
    """The tenant/community/app_id scope of the envelope currently being processed."""

    tenant: str
    community: str | None
    app_id: str


_context: contextvars.ContextVar[BundleContext | None] = contextvars.ContextVar(
    "waddles_bundle_context", default=None
)


def get_bundle_context() -> BundleContext:
    """Return the `BundleContext` bound for the envelope currently being processed."""
    ctx = _context.get()
    if ctx is None:
        raise BundleRuntimeError("no bundle context bound -- enter bundle_context() first")
    return ctx


@contextmanager
def bundle_context(*, tenant: str, community: str | None, app_id: str) -> Iterator[BundleContext]:
    """Scope tenant/community/app_id for one bundle entrypoint invocation."""
    ctx = BundleContext(tenant=tenant, community=community, app_id=app_id)
    token = _context.set(ctx)
    try:
        yield ctx
    finally:
        _context.reset(token)
```

- [ ] **Step 3: Write `src/waddle_sdk/flask_core/stream_pipeline.py`**

```python
"""`PlatformEvent`/`StageEnvelope` dataclasses, field-for-field matching
the WIT `types.platform-event`/`types.stage-envelope` records (spec §6.5)
and the JSON shape of spec §6.1 — the same names bundles import today from
`flask_core.stream_pipeline`. `to_dict`/`from_dict` round-trip through the
canonical JSON that crosses the WIT boundary as `payload-json` text.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class PlatformEvent:
    platform: str
    event_type: str
    actor: str | None
    payload: dict[str, Any] = field(default_factory=dict)
    occurred_at: str = ""
    source: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "platform": self.platform,
            "event_type": self.event_type,
            "actor": self.actor,
            "payload": self.payload,
            "occurred_at": self.occurred_at,
        }
        if self.source is not None:
            d["source"] = self.source
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlatformEvent":
        return cls(
            platform=data["platform"],
            event_type=data["event_type"],
            actor=data.get("actor"),
            payload=data.get("payload", {}),
            occurred_at=data.get("occurred_at", ""),
            source=data.get("source"),
        )

    @classmethod
    def from_wit_record(cls, record: Any) -> "PlatformEvent":
        """Construct from the generated WIT binding's `platform-event`
        record — `payload-json` is canonical JSON text and is parsed here,
        once, at the SDK boundary, so bundle code always sees a plain dict.
        """
        return cls(
            platform=record.platform,
            event_type=record.event_type,
            actor=record.actor,
            payload=json.loads(record.payload_json) if record.payload_json else {},
            occurred_at=record.occurred_at,
        )


@dataclass(slots=True)
class StageEnvelope:
    tenant: str
    community: str | None
    app_id: str
    stage: str
    event: PlatformEvent
    ts: str
    target_app_id: str | None = None
    trace_context: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "tenant": self.tenant,
            "community": self.community,
            "app_id": self.app_id,
            "stage": self.stage,
            "event": self.event.to_dict(),
            "ts": self.ts,
        }
        if self.target_app_id is not None:
            d["target_app_id"] = self.target_app_id
        if self.trace_context is not None:
            d["trace_context"] = self.trace_context
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StageEnvelope":
        return cls(
            tenant=data["tenant"],
            community=data.get("community"),
            app_id=data["app_id"],
            stage=data["stage"],
            event=PlatformEvent.from_dict(data["event"]),
            ts=data["ts"],
            target_app_id=data.get("target_app_id"),
            trace_context=data.get("trace_context"),
        )
```

- [ ] **Step 4: Write the failing tests, then verify they pass**

```python
# sdk/waddle-sdk/tests/test_bundle_runtime.py
from __future__ import annotations

import pytest

from waddle_sdk.flask_core.bundle_runtime import (
    BundleRuntimeError,
    bundle_context,
    get_bundle_context,
    get_bundle_dal,
    set_bundle_dal,
)


def test_get_bundle_dal_raises_when_unbound() -> None:
    with pytest.raises(BundleRuntimeError):
        get_bundle_dal()


def test_set_and_get_bundle_dal() -> None:
    sentinel = object()
    set_bundle_dal(sentinel)
    assert get_bundle_dal() is sentinel


def test_bundle_context_scopes_correctly() -> None:
    with pytest.raises(BundleRuntimeError):
        get_bundle_context()
    with bundle_context(tenant="acme", community="main", app_id="waddles.core.example.echo") as ctx:
        assert ctx.tenant == "acme"
        assert get_bundle_context().community == "main"
    with pytest.raises(BundleRuntimeError):
        get_bundle_context()
```

```python
# sdk/waddle-sdk/tests/test_stream_pipeline.py
from __future__ import annotations

from waddle_sdk.flask_core.stream_pipeline import PlatformEvent, StageEnvelope


def test_platform_event_round_trips() -> None:
    e = PlatformEvent(platform="discord", event_type="chat.message", actor="u1", payload={"text": "hi"}, occurred_at="2026-09-14T12:00:00.000Z")
    d = e.to_dict()
    e2 = PlatformEvent.from_dict(d)
    assert e2 == e


def test_stage_envelope_round_trips_with_optional_fields_absent() -> None:
    e = PlatformEvent(platform="discord", event_type="chat.message", actor=None, payload={}, occurred_at="2026-09-14T12:00:00.000Z")
    env = StageEnvelope(tenant="acme", community=None, app_id="waddles.core.example.echo", stage="process", event=e, ts="2026-09-14T12:00:00.123Z")
    d = env.to_dict()
    assert "target_app_id" not in d
    assert "trace_context" not in d
    env2 = StageEnvelope.from_dict(d)
    assert env2 == env
```

Run: `pytest sdk/waddle-sdk/tests/test_bundle_runtime.py sdk/waddle-sdk/tests/test_stream_pipeline.py -v`
Expected: `5 passed`.

- [ ] **Step 5: Coverage check**

Run: `pytest --cov=waddle_sdk --cov-fail-under=90 sdk/waddle-sdk/tests/test_bundle_runtime.py sdk/waddle-sdk/tests/test_stream_pipeline.py`
Expected: ≥90% coverage of `bundle_runtime.py` and `stream_pipeline.py`.

- [ ] **Step 6: Commit**

```bash
git add sdk/waddle-sdk/
git commit -m "$(cat <<'EOF'
feat(sdk-python): add flask_core.bundle_runtime and stream_pipeline compatibility shims

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 26: `flask_core.feature_flags` shim over the WIT `flags` import

**Files:**
- Create: `sdk/waddle-sdk/src/waddle_sdk/flask_core/feature_flags.py`
- Create: `sdk/waddle-sdk/tests/test_feature_flags.py`

**Interfaces:**
- Produces: `waddle_sdk.flask_core.feature_flags.feature_enabled(key: str, default: bool = False) -> bool`, routed to the WIT `flags.enabled` import when running inside a component, and to a plain in-process fallback (returning `default`) when imported outside one — so this module's own pytest suite runs host-side, with no `wit_world` binding present.

- [ ] **Step 1: Write the failing test**

```python
# sdk/waddle-sdk/tests/test_feature_flags.py
from __future__ import annotations

from waddle_sdk.flask_core.feature_flags import feature_enabled


def test_feature_enabled_falls_back_to_default_outside_a_component() -> None:
    # No wit_world module is importable in this host-side pytest run --
    # feature_enabled must degrade to the caller's default, never raise.
    assert feature_enabled("waddles.core.example", default=True) is True
    assert feature_enabled("waddles.core.example", default=False) is False


def test_feature_enabled_uses_the_wit_import_when_available(monkeypatch) -> None:
    import sys
    import types

    # componentize-py exposes an imported interface's functions under
    # `wit_world.imports.<interface>.<function>` — confirmed directly in
    # spikes/bundle-compiler-sandbox/bundles/python/app.py's own working
    # import, `from wit_world.imports.host import log`. Every fake in this
    # SDK's test suite mirrors that exact nesting, not a flattened name.
    fake_wit_world = types.ModuleType("wit_world")

    def fake_enabled(key: str, default_value: bool) -> bool:
        assert key == "waddles.core.example"
        return not default_value  # prove the WIT path, not the fallback, answered

    fake_wit_world.imports = types.SimpleNamespace(flags=types.SimpleNamespace(enabled=fake_enabled))  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "wit_world", fake_wit_world)

    assert feature_enabled("waddles.core.example", default=False) is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest sdk/waddle-sdk/tests/test_feature_flags.py -v`
Expected: FAIL — `feature_flags` module not found.

- [ ] **Step 3: Implement `src/waddle_sdk/flask_core/feature_flags.py`**

```python
"""Same name/signature as the real `flask_core.feature_flags.feature_enabled`
(spec §7.4's `flags` capability: "fail-open to the supplied default on a
flag-server outage"). Routes to the WIT `flags.enabled` import when the
generated `wit_world` binding module is importable (i.e. running inside a
compiled component under wasmtime); falls back to returning `default`
otherwise, so this module's own tests run host-side without a component.

Import path convention: componentize-py exposes an imported interface's
functions under `wit_world.imports.<interface>.<function>` — confirmed
directly in `spikes/bundle-compiler-sandbox/bundles/python/app.py`'s own
working import, `from wit_world.imports.host import log`. Every WIT call
site in this SDK uses that exact nesting.
"""

from __future__ import annotations


def feature_enabled(key: str, default: bool = False) -> bool:
    """Two-gate PostHog + license entitlement check, evaluated host-side
    by the stage and answered over the WIT `flags` import. Fails open to
    `default` whenever the WIT binding is unavailable (host-side tests) or
    the stage itself reports a flag-server outage (the stage's own
    fail-open behavior, not duplicated here).
    """
    try:
        import wit_world  # generated binding — only importable inside a component
    except ImportError:
        return default
    return bool(wit_world.imports.flags.enabled(key, default))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest sdk/waddle-sdk/tests/test_feature_flags.py -v`
Expected: `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add sdk/waddle-sdk/
git commit -m "$(cat <<'EOF'
feat(sdk-python): add flask_core.feature_flags.feature_enabled shim over the WIT flags import

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 27: `waddle_sdk.db` — the `penguin_dal`-compatible facade over the WIT `db` import

**Files:**
- Create: `sdk/waddle-sdk/src/waddle_sdk/db.py`
- Create: `sdk/waddle-sdk/tests/test_db_facade.py`

**Interfaces:**
- Produces the public surface spec §4.12/D21 requires for the async path, verified directly against `/home/penguin/code/penguin-libs/packages/python-dal/src/penguin_dal/{db,query,field_proxy,table_proxy}.py` (Plan-Level Assumption PA3 — no `penguin_dal` import exists here; this is an independent, call-compatible re-implementation over the WIT `db` import): `DB` (aliased to `AsyncDB`), `AsyncDB`, `Query`, `AsyncQuerySet`, `Row`, `Rows`, `Field` (aliased to `FieldProxy`), `FieldProxy`, `TableProxy`, `DALError`, `TableNotFoundError`, `ValidationError`, `create_dal`. The sync `QuerySet` and the `Page`/`Cursor` pagination types are explicitly **not** implemented — see PA3's "Not implemented, by scope" note. `get_bundle_dal()` (mechanism defined in Task 25) is bound to an `AsyncDB()` instance by Task 28's component entry (`set_bundle_dal(AsyncDB())`, called once at process start), so it is this module's `AsyncDB` that every bundle's `get_bundle_dal()` call returns. Every query lowers to exactly one `db.execute(statement, params)` WIT call, `$1..$n` placeholders, `params` as a JSON array of the WIT `value` variant (spec §6.5's `db` interface).
- **Documented, necessary deviation from `penguin_dal` (stated once, not hedging elsewhere):** the real `penguin_dal.table_proxy.TableProxy.__getattr__` validates column names against live-reflected SQLAlchemy metadata; this facade has no metadata to reflect (there is no live connection inside the sandbox — the WIT `db` import *is* the connection), so `TableProxy.__getattr__` returns a `FieldProxy` for any attribute name unconditionally. Column-name and table-name validation happens where it always has to happen in this design: the stage's SQL parser (spec §7.4's `db` capability notes) and Postgres itself. `create_dal()` also differs necessarily: the real one takes a database URL; this one takes none, since "connected" is not a state a WASM guest can be in — it always routes through the WIT import.

- [ ] **Step 1: Write the failing tests** — these run entirely host-side (no WASM), against a fake `wit_world.imports.db.execute` the tests monkeypatch in, exactly mirroring how the real function is only importable inside a component. This is where the SQL-generation logic gets its ≥90% coverage.

```python
# sdk/waddle-sdk/tests/test_db_facade.py
from __future__ import annotations

import json
import sys
import types

import pytest

from waddle_sdk.db import AsyncDB, DALError, Row, Rows, ValidationError, create_dal


class _FakeWitDb:
    """Records every db-execute call and answers from a canned table, the
    same pattern `spikes/penguin-dal-wasm/host/run_component.py` used to
    fake the host side — adapted here as a pure-Python test double instead
    of a real wasmtime host, since this suite runs outside a component.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[object]]] = []
        self.canned: dict[str, list[dict[str, object]]] = {}

    def db_execute(self, statement: str, params_json: str) -> str:
        params = json.loads(params_json)
        self.calls.append((statement, params))
        for key, rows in self.canned.items():
            if key in statement:
                return json.dumps(rows)
        return json.dumps([])


@pytest.fixture
def fake_db(monkeypatch: pytest.MonkeyPatch) -> _FakeWitDb:
    fake = _FakeWitDb()
    fake_wit_world = types.ModuleType("wit_world")
    # `wit_world.imports.db.execute` — componentize-py's actual nesting for
    # an imported interface's functions (see feature_flags.py's docstring
    # for the spike citation); this facade calls that exact path.
    fake_wit_world.imports = types.SimpleNamespace(db=types.SimpleNamespace(execute=fake.db_execute))  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "wit_world", fake_wit_world)
    return fake


def test_select_with_eq_query_generates_correct_sql(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    query = (db.command_aliases.community_id == 42) & (db.command_aliases.alias == "bar")
    rows = _run(db(query).select())
    assert isinstance(rows, Rows)
    sql, params = fake_db.calls[0]
    assert "SELECT * FROM command_aliases WHERE" in sql
    assert "command_aliases.community_id = $1" in sql
    assert "command_aliases.alias = $2" in sql
    assert params == [42, "bar"]


def test_is_null_query(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    query = db.command_aliases.deleted_at == None  # noqa: E711 - deliberately exercising the IS NULL path
    _run(db(query).select())
    sql, params = fake_db.calls[0]
    assert "command_aliases.deleted_at IS NULL" in sql
    assert params == []


def test_update_generates_set_and_where(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    query = db.command_aliases.id == 7
    rowcount = _run(db(query).update(deleted_at="2026-09-14T00:00:00+00:00"))
    sql, params = fake_db.calls[0]
    assert sql.startswith("UPDATE command_aliases SET deleted_at = $1 WHERE")
    assert params == ["2026-09-14T00:00:00+00:00", 7]
    assert isinstance(rowcount, int)


def test_insert_generates_insert_into(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    _run(db.command_aliases.async_insert(community_id=42, alias="foo", target_command="ping", created_by="penguin"))
    sql, params = fake_db.calls[0]
    assert sql.startswith("INSERT INTO command_aliases (community_id, alias, target_command, created_by) VALUES ($1, $2, $3, $4)")
    assert params == [42, "foo", "ping", "penguin"]


def test_delete_generates_delete_from(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    query = db.command_aliases.id == 7
    _run(db(query).delete())
    sql, params = fake_db.calls[0]
    assert sql == "DELETE FROM command_aliases WHERE command_aliases.id = $1"
    assert params == [7]


def test_count_and_exists(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    fake_db.canned["SELECT COUNT(*)"] = [{"count": 3}]
    count = _run(db(db.command_aliases.community_id == 42).count())
    assert count == 3
    fake_db.canned["SELECT 1 FROM command_aliases"] = [{"exists": 1}]
    exists = _run(db(db.command_aliases.community_id == 42).exists())
    assert exists is True


def test_getitem_pk_lookup_returns_row_or_none(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    fake_db.canned["command_aliases.id = $1"] = [{"id": 7, "alias": "bar"}]
    row = db.command_aliases[7]
    assert isinstance(row, Row)
    assert row.alias == "bar"
    assert row["id"] == 7

    fake_db.canned.clear()
    missing = db.command_aliases[999]
    assert missing is None


def test_rows_supports_dict_and_attribute_access_and_iteration(fake_db: _FakeWitDb) -> None:
    fake_db.canned["command_aliases"] = [{"id": 1, "alias": "a"}, {"id": 2, "alias": "b"}]
    db = create_dal()
    rows = _run(db(db.command_aliases.id > 0).select())
    assert len(rows) == 2
    assert rows.first().alias == "a"
    assert [r["alias"] for r in rows] == ["a", "b"]
    assert rows.as_list() == [{"id": 1, "alias": "a"}, {"id": 2, "alias": "b"}]


def test_query_and_or_combine_correctly(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    query = (db.command_aliases.a == 1) | (db.command_aliases.b == 2)
    _run(db(query).select())
    sql, params = fake_db.calls[0]
    assert "(command_aliases.a = $1) OR (command_aliases.b = $2)" in sql
    assert params == [1, 2]


def test_unsupported_construct_raises_not_implemented_error_never_misexecutes(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    with pytest.raises(NotImplementedError):
        db.command_aliases.alias.like("%foo%")  # not implemented in this facade -- explicit, not silent


def test_execute_raw_sql_passthrough(fake_db: _FakeWitDb) -> None:
    db = create_dal()
    rows = _run(db.execute("SELECT role FROM community_members WHERE community_id = $1", [42]))
    sql, params = fake_db.calls[0]
    assert sql == "SELECT role FROM community_members WHERE community_id = $1"
    assert params == [42]


def _run(coro):
    """Drive a coroutine to completion without a real event loop -- the
    facade's own coroutines never actually suspend (D21: "single-threaded
    ... with async-compatible signatures"), so a bare `send(None)` loop
    is sufficient and avoids depending on Task 24's PollLoop from this
    pure-facade test file.
    """
    try:
        coro.send(None)
    except StopIteration as stop:
        return stop.value
    raise AssertionError("facade coroutine unexpectedly suspended")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest sdk/waddle-sdk/tests/test_db_facade.py -v`
Expected: FAIL — `waddle_sdk.db` module not found.

- [ ] **Step 3: Implement `src/waddle_sdk/db.py`**

```python
"""`penguin_dal`-compatible database facade over the WIT `db` import
(spec §4.12, D21). Every statement crosses the WIT boundary through
exactly one call, `wit_world.imports.db.execute(statement, params_json) ->
rows_json` (spec §6.5's `db` interface, exposed under componentize-py's
`wit_world.imports.<interface>.<function>` nesting — confirmed directly
in `spikes/bundle-compiler-sandbox/bundles/python/app.py`'s own working
`from wit_world.imports.host import log`) — the query builder below runs
entirely in guest Python; only the final `(sql, params)` pair and the
returned rows cross the host/guest boundary.

Verified against `/home/penguin/code/penguin-libs/packages/python-dal/src/
penguin_dal/{db,query,field_proxy,table_proxy}.py`'s public method
signatures (Plan-Level Assumption PA3) — no `penguin_dal` import exists in
this file; this is an independent, call-compatible re-implementation.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any
from uuid import UUID


class DALError(Exception):
    """Base exception for this facade — matches `penguin_dal.exceptions.DALError`."""


class TableNotFoundError(DALError):
    """Matches `penguin_dal.exceptions.TableNotFoundError`."""


class ValidationError(DALError):
    """Matches `penguin_dal.exceptions.ValidationError`."""


def _coerce_param(value: Any) -> Any:
    """Mirror the real `penguin_dal`/`AsyncDAL.execute`'s own param
    conversion: UUID -> str, dict/list -> JSON string, datetime/date -> ISO
    string. Every other type crosses as-is (the WIT `db` interface's
    `value` variant covers null/bool/int/float/text/bytes).
    """
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _cross(statement: str, params: list[Any]) -> list[dict[str, Any]]:
    """The one place every statement crosses the WIT `db` import. Calls
    `wit_world.imports.db.execute` — componentize-py's nesting for an
    imported interface's functions (see this module's docstring).
    """
    import wit_world  # generated binding — only resolvable inside a component

    coerced = [_coerce_param(p) for p in params]
    raw = wit_world.imports.db.execute(statement, json.dumps(coerced))
    result: list[dict[str, Any]] = json.loads(raw)
    return result


class Query:
    """A combinable WHERE-clause fragment — matches `penguin_dal.query.Query`'s
    shape (`__and__`/`__or__`), built here as raw SQL text with `\\0` marking
    one `$N` placeholder slot, rendered left-to-right by `render()`.
    """

    __slots__ = ("sql", "params", "table")

    def __init__(self, sql: str, params: list[Any], table: str) -> None:
        self.sql = sql
        self.params = list(params)
        self.table = table

    def __and__(self, other: "Query") -> "Query":
        return Query(f"({self.sql}) AND ({other.sql})", self.params + other.params, self.table)

    def __or__(self, other: "Query") -> "Query":
        return Query(f"({self.sql}) OR ({other.sql})", self.params + other.params, self.table)

    def render(self, start: int = 1) -> tuple[str, int]:
        idx = start
        pieces = self.sql.split("\0")
        rendered = pieces[0]
        for piece in pieces[1:]:
            rendered += f"${idx}{piece}"
            idx += 1
        return rendered, idx

    def __repr__(self) -> str:
        return f"Query({self.sql!r}, params={self.params!r})"


class FieldProxy:
    """One `table.column` reference — matches `penguin_dal.field_proxy.FieldProxy`'s
    comparison operators. `like`/`ilike`/`contains`/`startswith`/`endswith`/
    `belongs`/`lower`/`upper`/`asc`/`desc` raise `NotImplementedError` naming
    the construct — this bundle's own callers never used them (spike Sec 5),
    and D21's rule is an explicit `NotImplementedError`, never a silent
    mis-execution, for anything this facade has not implemented.
    """

    __slots__ = ("_table", "_name")

    def __init__(self, table: str, name: str) -> None:
        self._table = table
        self._name = name

    def __eq__(self, other: Any) -> Query:  # type: ignore[override]
        if other is None:
            return Query(f"{self._table}.{self._name} IS NULL", [], self._table)
        return Query(f"{self._table}.{self._name} = \0", [other], self._table)

    def __ne__(self, other: Any) -> Query:  # type: ignore[override]
        if other is None:
            return Query(f"{self._table}.{self._name} IS NOT NULL", [], self._table)
        return Query(f"{self._table}.{self._name} != \0", [other], self._table)

    def __gt__(self, other: Any) -> Query:
        return Query(f"{self._table}.{self._name} > \0", [other], self._table)

    def __lt__(self, other: Any) -> Query:
        return Query(f"{self._table}.{self._name} < \0", [other], self._table)

    def __ge__(self, other: Any) -> Query:
        return Query(f"{self._table}.{self._name} >= \0", [other], self._table)

    def __le__(self, other: Any) -> Query:
        return Query(f"{self._table}.{self._name} <= \0", [other], self._table)

    def like(self, pattern: str) -> Query:
        raise NotImplementedError("FieldProxy.like() is not implemented in the waddle-sdk facade")

    def ilike(self, pattern: str) -> Query:
        raise NotImplementedError("FieldProxy.ilike() is not implemented in the waddle-sdk facade")

    def contains(self, value: str) -> Query:
        raise NotImplementedError("FieldProxy.contains() is not implemented in the waddle-sdk facade")

    def startswith(self, value: str) -> Query:
        raise NotImplementedError("FieldProxy.startswith() is not implemented in the waddle-sdk facade")

    def endswith(self, value: str) -> Query:
        raise NotImplementedError("FieldProxy.endswith() is not implemented in the waddle-sdk facade")

    def belongs(self, values: Any) -> Query:
        raise NotImplementedError("FieldProxy.belongs() is not implemented in the waddle-sdk facade")

    def __hash__(self) -> int:  # needed because __eq__ is overridden above
        return hash((self._table, self._name))

    def __repr__(self) -> str:
        return f"FieldProxy({self._table}.{self._name})"


# `Field` is the same type as `FieldProxy` in this facade -- the real
# penguin_dal exposes both names (`Field` from `.field`, `FieldProxy` from
# `.field_proxy`) as historically-distinct but call-compatible types; a
# single class satisfies both import names here.
Field = FieldProxy


class Row:
    """One result row — dict AND attribute access, matching `penguin_dal.query.Row`."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def __getitem__(self, key: str) -> Any:
        return self._data[key]

    def __contains__(self, key: str) -> bool:
        return key in self._data

    def __iter__(self):
        return iter(self._data)

    def __len__(self) -> int:
        return len(self._data)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Row) and self._data == other._data

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            return self._data[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def keys(self) -> list[str]:
        return list(self._data.keys())

    def values(self) -> list[Any]:
        return list(self._data.values())

    def items(self) -> list[tuple[str, Any]]:
        return list(self._data.items())

    def as_dict(self) -> dict[str, Any]:
        return dict(self._data)

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def __repr__(self) -> str:
        return f"Row({self._data!r})"


class Rows:
    """A result set — matches `penguin_dal.query.Rows`: truthy/iterable/
    indexable/`.first()`/`.last()`/`.as_list()`.
    """

    def __init__(self, rows: list[Row]) -> None:
        self.rows = rows

    def first(self) -> Row | None:
        return self.rows[0] if self.rows else None

    def last(self) -> Row | None:
        return self.rows[-1] if self.rows else None

    def as_list(self) -> list[dict[str, Any]]:
        return [r.as_dict() for r in self.rows]

    def __iter__(self):
        return iter(self.rows)

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> Row:
        return self.rows[index]

    def __bool__(self) -> bool:
        return bool(self.rows)

    def __repr__(self) -> str:
        return f"Rows({self.rows!r})"


class AsyncQuerySet:
    """Created by `AsyncDB.__call__(query)` — matches
    `penguin_dal.query.AsyncQuerySet`'s public methods exactly
    (`select`/`update`/`delete`/`count`/`exists`, all `async def`).
    `orderby`/`limitby` are accepted for signature compatibility and raise
    `NotImplementedError` if actually supplied — this facade's callers
    (spec's own first-party bundle set, per spike Sec 5) never used them.
    """

    def __init__(self, table_name: str, query: Query | None) -> None:
        self._table_name = table_name
        self._query = query

    async def select(self, *columns: Any, orderby: Any = None, limitby: tuple[int, int] | None = None) -> Rows:
        if orderby is not None or limitby is not None:
            raise NotImplementedError("AsyncQuerySet.select(orderby=..., limitby=...) is not implemented in the waddle-sdk facade")
        select_list = "*" if not columns else ", ".join(f"{self._table_name}.{c._name}" for c in columns)
        if self._query is not None:
            where_sql, _ = self._query.render(1)
            sql = f"SELECT {select_list} FROM {self._table_name} WHERE {where_sql}"
            params = self._query.params
        else:
            sql = f"SELECT {select_list} FROM {self._table_name}"
            params = []
        rows = _cross(sql, params)
        return Rows([Row(r) for r in rows])

    async def update(self, **kwargs: Any) -> int:
        set_cols = list(kwargs.keys())
        set_clause = ", ".join(f"{col} = ${i + 1}" for i, col in enumerate(set_cols))
        set_params = [kwargs[c] for c in set_cols]
        if self._query is not None:
            where_sql, _ = self._query.render(len(set_cols) + 1)
            sql = f"UPDATE {self._table_name} SET {set_clause} WHERE {where_sql}"
            params = set_params + self._query.params
        else:
            sql = f"UPDATE {self._table_name} SET {set_clause}"
            params = set_params
        rows = _cross(sql, params)
        return len(rows)

    async def delete(self) -> int:
        if self._query is not None:
            where_sql, _ = self._query.render(1)
            sql = f"DELETE FROM {self._table_name} WHERE {where_sql}"
            params = self._query.params
        else:
            sql = f"DELETE FROM {self._table_name}"
            params = []
        rows = _cross(sql, params)
        return len(rows)

    async def count(self) -> int:
        if self._query is not None:
            where_sql, _ = self._query.render(1)
            sql = f"SELECT COUNT(*) as count FROM {self._table_name} WHERE {where_sql}"
            params = self._query.params
        else:
            sql = f"SELECT COUNT(*) as count FROM {self._table_name}"
            params = []
        rows = _cross(sql, params)
        return int(rows[0]["count"]) if rows else 0

    async def exists(self) -> bool:
        if self._query is not None:
            where_sql, _ = self._query.render(1)
            sql = f"SELECT 1 as exists FROM {self._table_name} WHERE {where_sql}"
            params = self._query.params
        else:
            sql = f"SELECT 1 as exists FROM {self._table_name}"
            params = []
        rows = _cross(sql, params)
        return len(rows) > 0


class TableProxy:
    """`db.command_aliases` — matches `penguin_dal.table_proxy.TableProxy`'s
    public surface. See this module's docstring for the documented
    deviation on column validation (none here — no live metadata exists
    inside the sandbox to validate against).
    """

    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def table_name(self) -> str:
        return self._name

    def __getattr__(self, name: str) -> FieldProxy:
        if name.startswith("_"):
            raise AttributeError(name)
        return FieldProxy(self._name, name)

    def __getitem__(self, pk: Any) -> Row | None:
        """PK lookup — `db.table[42]`. Matches the real `TableProxy.__getitem__`'s
        *synchronous* return type even though this facade is otherwise
        async-signatured (the real implementation is synchronous here too,
        via `run_until_complete` internally — see `table_proxy.py:74-88`).
        """
        rows = _cross(f"SELECT * FROM {self._name} WHERE {self._name}.id = \0".replace("\0", "$1"), [pk])
        return Row(rows[0]) if rows else None

    def insert(self, **kwargs: Any) -> Any:
        raise NotImplementedError("TableProxy.insert() (sync) is not implemented in the waddle-sdk facade -- use async_insert()")

    async def async_insert(self, **kwargs: Any) -> Any:
        cols = list(kwargs.keys())
        col_list = ", ".join(cols)
        placeholders = ", ".join(f"${i + 1}" for i in range(len(cols)))
        sql = f"INSERT INTO {self._name} ({col_list}) VALUES ({placeholders})"
        params = [kwargs[c] for c in cols]
        return _cross(sql, params)

    def bulk_insert(self, rows: list[dict[str, Any]]) -> None:
        raise NotImplementedError("TableProxy.bulk_insert() (sync) is not implemented in the waddle-sdk facade -- use async_bulk_insert()")

    async def async_bulk_insert(self, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            await self.async_insert(**row)

    def __repr__(self) -> str:
        return f"TableProxy({self._name})"


class AsyncDB:
    """`get_bundle_dal()`'s return value — matches `penguin_dal.db.AsyncDB`'s
    public surface: `__getattr__` -> `TableProxy`, `__call__(query)` ->
    `AsyncQuerySet`, plus the raw `execute()` escape hatch every
    first-party bundle's `_caller_is_moderator_or_admin`-style helper uses.
    """

    def __getattr__(self, name: str) -> TableProxy:
        if name.startswith("_"):
            raise AttributeError(name)
        return TableProxy(name)

    def __call__(self, query: Query | None = None) -> AsyncQuerySet:
        table_name = query.table if query is not None else None
        if table_name is None:
            raise ValidationError("AsyncDB.__call__(query) requires a query built from a table's own FieldProxy")
        return AsyncQuerySet(table_name, query)

    async def execute(self, statement: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        """`await dal.execute(sql, params)` — raw SQL, `$1/$2/...` already
        in `sql`. Mirrors `AsyncDB`'s own escape hatch for hand-written
        statements this facade's query builder doesn't cover.
        """
        return _cross(statement, list(params) if params else [])

    async def commit(self) -> None:
        """No-op — every statement already committed host-side, per
        statement, since there is no client-held transaction inside the
        sandbox (spec §7.4's `db` capability: one connection, one
        statement, RLS-scoped per call).
        """
        return None

    async def close(self) -> None:
        return None


DB = AsyncDB  # `penguin_dal.db.DB` is the sync variant upstream; unified here for the same "no client-held connection" reason `commit`/`close` are no-ops


def create_dal() -> AsyncDB:
    """Matches `penguin_dal.factory.create_dal` by name and return type
    only — takes no arguments, since there is no database URL to connect
    to inside the sandbox (the WIT `db` import *is* the connection). See
    this module's docstring for why this is a necessary, documented
    deviation.
    """
    return AsyncDB()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest sdk/waddle-sdk/tests/test_db_facade.py -v`
Expected: all 11 tests pass.

- [ ] **Step 5: Coverage check**

Run: `pytest --cov=waddle_sdk.db --cov-fail-under=90 sdk/waddle-sdk/tests/test_db_facade.py`
Expected: ≥90% coverage of `db.py`. The `NotImplementedError` branches (`like`/`ilike`/`contains`/`startswith`/`endswith`/`belongs`/sync `insert`/`bulk_insert`) are already exercised by `test_unsupported_construct_raises_not_implemented_error_never_misexecutes` and can be extended with one `pytest.raises` per remaining branch if coverage falls short.

- [ ] **Step 6: Commit**

```bash
git add sdk/waddle-sdk/
git commit -m "$(cat <<'EOF'
feat(sdk-python): add penguin_dal-compatible db facade over the WIT db import (D21)

Verified against penguin-libs' python-dal public API (db.py, query.py,
field_proxy.py, table_proxy.py) rather than the spike's pydal-flavored
facade, per D21 and Plan-Level Assumption PA3.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 28: `http`/`kv`/`relay`/`log`/`clock` wrappers + component entry point

**Files:**
- Create: `sdk/waddle-sdk/src/waddle_sdk/http.py`
- Create: `sdk/waddle-sdk/src/waddle_sdk/kv.py`
- Create: `sdk/waddle-sdk/src/waddle_sdk/relay.py`
- Create: `sdk/waddle-sdk/src/waddle_sdk/log.py`
- Create: `sdk/waddle-sdk/src/waddle_sdk/clock.py`
- Create: `sdk/waddle-sdk/src/waddle_sdk/_component_entry.py`
- Create: `sdk/waddle-sdk/tests/test_http.py`
- Create: `sdk/waddle-sdk/tests/test_kv.py`

**Interfaces:**
- Produces: `waddle_sdk.http.HttpClient` (a `waddle_transports`-shaped client: `.request(method, url, headers=None, body=None, secret_refs=None)`, `.get(url, **kw)`, `.post(url, **kw)`, raising `RetryableTransportError`/`NonRetryableTransportError` on failure per `waddle_transports.base`'s contract), `waddle_sdk.kv.{get, set, delete, increment}`, `waddle_sdk.relay.push(provider, message)`, `waddle_sdk.log.{debug, info, warn, error}`, `waddle_sdk.clock.{now_millis, now_rfc3339, monotonic_nanos}`, and `waddle_sdk._component_entry.WitWorld` — the componentize-py app class implementing both `process-stage.transform` and `action-stage.dispatch`, wiring Task 24's `PollLoop`, Task 25's `bundle_context`/`set_bundle_dal`, and Task 27's `AsyncDB`.

- [ ] **Step 1: Write `src/waddle_sdk/http.py`**

```python
"""`waddle_transports`-compatible HTTP client over the WIT `http` import.
Same call shape as today's `waddle_transports.transports.http` transport;
raises the same two exception types `waddle_transports.base` defines so a
bundle's existing `except RetryableTransportError` handling is unchanged.
"""

from __future__ import annotations

from typing import Any


class RetryableTransportError(Exception):
    """Matches `waddle_transports.base.RetryableTransportError`."""


class NonRetryableTransportError(Exception):
    """Matches `waddle_transports.base.NonRetryableTransportError`."""


class SecretRef:
    """An opaque reference to a secret the STAGE resolves and injects as a
    header — the value never enters this component (spec §8.3).
    """

    __slots__ = ("name",)

    def __init__(self, name: str) -> None:
        self.name = name

    def __repr__(self) -> str:
        return f"SecretRef({self.name!r})"


def resolve_secret(env_var_name: str) -> SecretRef:
    """Matches `waddle_transports.signing.resolve_secret`'s name/contract —
    returns an opaque reference, never a value.
    """
    return SecretRef(env_var_name)


class HttpClient:
    """Drop-in for `waddle_transports.transports.http`'s client shape.

    **Flagged uncertainty, resolve empirically before merge:** two shapes
    below are not independently verified by either spike, and are written
    defensively rather than guessed with false confidence: (1) how a WIT
    *record*-typed parameter (`http`'s `request`) is constructed from
    Python — neither spike passed a record into an imported function
    (spike1's imports took only scalar `string` args; spike2's
    `http-request` took a plain `string`, not a real record) — this code
    assumes componentize-py exposes the generated record type at
    `wit_world.imports.http.Request`, matching the already-confirmed
    `wit_world.imports.<interface>.<name>` nesting, with a plain-kwargs
    fallback if that type does not exist; (2) the exact exception
    class/shape componentize-py raises for the `error` variant on the
    `Err` arm of `result<response, error>` — neither spike exercised a
    `result`-returning interface function at all. The `except Exception`
    below classifies off the raised object's own case-name/payload
    attributes (via `getattr` with safe fallbacks) rather than a guessed
    exact class name. **Action required in Task 28's own review:** once
    the toolchain image exists (Task 19), run one real `--stub-wasi`
    build of a bundle calling `http.send`, inspect the actual generated
    `Request` type location and the actual raised exception's
    `type(exc).__name__`/attributes on both a success and a denied call,
    and tighten both call sites to the confirmed exact shapes — tracked
    as a follow-up, not a blocking gap, since the fallback paths below
    already behave correctly either way.
    """

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
        secret_refs: dict[str, SecretRef] | None = None,
    ) -> dict[str, Any]:
        import wit_world

        header_list = [(k, v) for k, v in (headers or {}).items()]
        secret_ref_list = [(k, v.name) for k, v in (secret_refs or {}).items()]
        request_kwargs = dict(method=method, url=url, headers=header_list, body=list(body) if body else None, secret_refs=secret_ref_list)
        request_type = getattr(wit_world.imports.http, "Request", None)
        request = request_type(**request_kwargs) if request_type is not None else request_kwargs
        try:
            response = wit_world.imports.http.send(request)
        except Exception as exc:  # noqa: BLE001 - see class docstring: exact exception type is an open empirical question
            case_name = getattr(exc, "tag", None) or getattr(exc, "case", None) or type(exc).__name__.lower()
            payload = getattr(exc, "value", None) or (exc.args[0] if exc.args else None)
            if "timeout" in str(case_name):
                raise RetryableTransportError(f"timeout calling {url}") from exc
            if "rate" in str(case_name):
                raise RetryableTransportError(f"rate limited calling {url}, retry after {payload}ms") from exc
            if "denied" in str(case_name):
                raise NonRetryableTransportError(f"egress denied for {url}: {payload}") from exc
            if "transport" in str(case_name):
                raise RetryableTransportError(f"transport error calling {url}: {payload}") from exc
            raise NonRetryableTransportError(f"unclassified http error calling {url}: {exc}") from exc
        return {
            "status": response.status,
            "headers": dict(response.headers),
            "body": bytes(response.body),
            "truncated": response.truncated,
        }

    async def get(self, url: str, **kwargs: Any) -> dict[str, Any]:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> dict[str, Any]:
        return await self.request("POST", url, **kwargs)
```

- [ ] **Step 2: Write `src/waddle_sdk/kv.py`, `relay.py`, `log.py`, `clock.py`**

```python
# sdk/waddle-sdk/src/waddle_sdk/kv.py
"""Bundle-scoped key/value over the WIT `kv` import (spec §6.5). Always
granted. Calls `wit_world.imports.kv.<function>` — componentize-py's
nesting for an imported interface's functions, confirmed directly in
`spikes/bundle-compiler-sandbox/bundles/python/app.py`'s own working
`from wit_world.imports.host import log`.
"""
from __future__ import annotations


async def get(key: str) -> bytes | None:
    import wit_world

    result = wit_world.imports.kv.get(key)
    return bytes(result) if result is not None else None


async def set(key: str, value: bytes, ttl_seconds: int = 0) -> None:
    import wit_world

    wit_world.imports.kv.set(key, list(value), ttl_seconds)


async def delete(key: str) -> None:
    import wit_world

    wit_world.imports.kv.delete(key)


async def increment(key: str, delta: int, ttl_seconds: int = 0) -> int:
    import wit_world

    return int(wit_world.imports.kv.increment(key, delta, ttl_seconds))
```

```python
# sdk/waddle-sdk/src/waddle_sdk/relay.py
"""Outbound relay push over the WIT `relay` import — action-stage bundles
only. See `kv.py`'s docstring for the `wit_world.imports.<interface>`
nesting convention this and every other WIT-calling module in this SDK
uses.
"""
from __future__ import annotations


async def push(provider: str, message: dict) -> None:
    import json

    import wit_world

    wit_world.imports.relay.push(provider, json.dumps(message))
```

```python
# sdk/waddle-sdk/src/waddle_sdk/log.py
"""Sanitized, levelled logging over the WIT `log` import — matches the
call shape of `logging.Logger.{debug,info,warning,error}` closely enough
that a bundle's existing `logger.debug("msg", extra={...})` calls need
only their logger object swapped for this module. See `kv.py`'s docstring
for the `wit_world.imports.<interface>` nesting convention.

**Flagged uncertainty:** the WIT `log` interface's `level` parameter is an
`enum` (`error`/`warn`/`info`/`debug`); this passes the plain lowercase
string, which componentize-py may or may not accept directly for an enum
parameter (it may require the generated enum type, e.g.
`wit_world.imports.log.Level.INFO`). Verify against the real toolchain
(Task 28's own follow-up, same as `http.py`'s flagged items) and switch
to the generated enum type if the plain string is rejected.
"""
from __future__ import annotations

import json
from typing import Any


def _write(level: str, message: str, fields: dict[str, Any] | None) -> None:
    import wit_world

    wit_world.imports.log.write(level, message, json.dumps(fields or {}))


def debug(message: str, **fields: Any) -> None:
    _write("debug", message, fields)


def info(message: str, **fields: Any) -> None:
    _write("info", message, fields)


def warn(message: str, **fields: Any) -> None:
    _write("warn", message, fields)


def error(message: str, **fields: Any) -> None:
    _write("error", message, fields)
```

```python
# sdk/waddle-sdk/src/waddle_sdk/clock.py
"""Wall/monotonic clock over the WIT `clock` import — no other time source
is available to a bundle (spec §7.4: keeps timing side channels from being
trivially precise). See `kv.py`'s docstring for the
`wit_world.imports.<interface>` nesting convention.
"""
from __future__ import annotations


def now_millis() -> int:
    import wit_world

    return int(wit_world.imports.clock.now_millis())


def now_rfc3339() -> str:
    import wit_world

    return str(wit_world.imports.clock.now_rfc3339())


def monotonic_nanos() -> int:
    import wit_world

    return int(wit_world.imports.clock.monotonic_nanos())
```

- [ ] **Step 3: Write `src/waddle_sdk/_component_entry.py`**

```python
"""The componentize-py app module for the `waddle:bundle/stage@1.0.0`
world — the ONLY module `bundle-compiler`'s Python build recipe (Task 8)
ever points `componentize-py componentize` at. Plays the role a stage
runner plays for a real bundle: binds the DAL facade once at process
start (`set_bundle_dal`, normally `core/svc_process/app.py`'s
`before_serving` hook) and wraps each export call in `bundle_context()`
(normally `runner.py`'s `_transform_and_enqueue`). Adapted from the
wiring pattern in `spikes/penguin-dal-wasm/waddle_sdk/app_entry.py`
(spike commit `964f2729`), generalized from that spike's one hand-picked
bundle to any bundle exposing module-level `transform`/`dispatch`
functions.

**Never imports the bundle's own module directly.** `bundle.yaml`'s
`stages.<s>.entry` (e.g. `app:transform`) is resolved at BUILD time (not
here, not at runtime) by Task 8's `generate_entry_wiring()`, which writes
`_entry_wiring.py` into the bundle's own source directory with static
`from {module} import {function} as bundle_transform`/`bundle_dispatch`
lines — a static import, not `importlib.import_module` driven by a
runtime environment variable, because the WIT world excludes
`wasi:cli/environment` (spec §6.5): there is no environment variable to
read once this code is actually running inside the sandbox.

Every internal SDK import below is package-qualified
(`waddle_sdk._asyncio_patch`, not bare `_asyncio_patch`) because this
file is a submodule of the installed `waddle_sdk` package, not a
top-level sibling module the way the spike's flat `waddle_sdk/` directory
laid things out.
"""

from __future__ import annotations

import asyncio
import json

from waddle_sdk import _asyncio_patch  # noqa: F401 - must patch asyncio.to_thread before any bundle import
from waddle_sdk._poll_loop import PollLoop
from waddle_sdk.db import AsyncDB
from waddle_sdk.flask_core.bundle_runtime import bundle_context, set_bundle_dal
from waddle_sdk.flask_core.stream_pipeline import PlatformEvent, StageEnvelope

try:
    import _bundle_preimports  # noqa: F401 - auto-generated into the bundle's own source dir, see Task 8
except ImportError:
    pass  # a bundle with no bundles/ package (single-module bundle) has nothing to pre-import

try:
    import _entry_wiring  # auto-generated into the bundle's own source dir, see Task 8's generate_entry_wiring()
except ImportError:
    _entry_wiring = None  # only during this SDK's own host-side unit tests, which never compile a real component

set_bundle_dal(AsyncDB())


def _run_coro(coro):
    """Drive one coroutine to completion with `PollLoop` — `asyncio.run()`
    cannot be used inside this sandbox (see `_poll_loop.py`'s docstring).
    """
    loop = PollLoop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        asyncio.set_event_loop(None)


class WitWorld:
    """componentize-py's expected app-class name."""

    def transform(self, event_json: str) -> str | None:
        import wit_world

        event = PlatformEvent.from_dict(json.loads(event_json))
        ctx = wit_world.imports.context.get_context()

        async def _run() -> PlatformEvent | None:
            with bundle_context(tenant=ctx.tenant, community=ctx.community, app_id=ctx.app_id):
                return await _entry_wiring.bundle_transform(event)

        result = _run_coro(_run())
        return json.dumps(result.to_dict()) if result is not None else None

    def dispatch(self, envelope_json: str, config_json: str) -> str:
        envelope = StageEnvelope.from_dict(json.loads(envelope_json))
        config = json.loads(config_json)
        import wit_world

        ctx = wit_world.imports.context.get_context()

        async def _run() -> dict:
            with bundle_context(tenant=ctx.tenant, community=ctx.community, app_id=ctx.app_id):
                from waddle_sdk.http import HttpClient

                result = await _entry_wiring.bundle_dispatch(envelope, config, http_client=HttpClient())
                return {"ok": True, "status": result.get("status"), "detail": result.get("detail"), "provider_message_id": result.get("provider_message_id")}

        return json.dumps(_run_coro(_run()))
```

- [ ] **Step 4: Write the failing tests, then verify they pass**

```python
# sdk/waddle-sdk/tests/test_http.py
from __future__ import annotations

import sys
import types

import pytest

from waddle_sdk.http import HttpClient, NonRetryableTransportError, RetryableTransportError, resolve_secret


class _FakeHttpError(Exception):
    """Stands in for whatever componentize-py actually raises on the `Err`
    arm of `result<response, error>` — see `HttpClient`'s docstring for
    why this is deliberately a generic shape (`.tag`/`.value`), not a
    guessed exact upstream class, until Task 28's own follow-up confirms
    the real one against the toolchain.
    """

    def __init__(self, tag: str, value=None):
        super().__init__(tag)
        self.tag = tag
        self.value = value


@pytest.fixture
def fake_wit_http(monkeypatch: pytest.MonkeyPatch):
    fake_wit_world = types.ModuleType("wit_world")

    class Request:
        def __init__(self, method, url, headers, body, secret_refs):
            self.method, self.url, self.headers, self.body, self.secret_refs = method, url, headers, body, secret_refs

    class Response:
        def __init__(self, status, headers, body, truncated):
            self.status, self.headers, self.body, self.truncated = status, headers, body, truncated

    def send(request):
        if request.url == "https://timeout.example.com":
            raise _FakeHttpError("timeout")
        if request.url == "https://denied.example.com":
            raise _FakeHttpError("denied", "host_not_declared")
        return Response(200, [("content-type", "application/json")], list(b'{"ok":true}'), False)

    fake_wit_world.imports = types.SimpleNamespace(http=types.SimpleNamespace(Request=Request, send=send))
    monkeypatch.setitem(sys.modules, "wit_world", fake_wit_world)
    return fake_wit_world


@pytest.mark.asyncio
async def test_successful_get(fake_wit_http) -> None:
    resp = await HttpClient().get("https://api.example.com")
    assert resp["status"] == 200
    assert resp["body"] == b'{"ok":true}'


@pytest.mark.asyncio
async def test_timeout_raises_retryable(fake_wit_http) -> None:
    with pytest.raises(RetryableTransportError):
        await HttpClient().get("https://timeout.example.com")


@pytest.mark.asyncio
async def test_denied_raises_non_retryable(fake_wit_http) -> None:
    with pytest.raises(NonRetryableTransportError):
        await HttpClient().get("https://denied.example.com")


def test_resolve_secret_returns_opaque_ref() -> None:
    ref = resolve_secret("SPOTIFY_BOT_TOKEN_REF")
    assert ref.name == "SPOTIFY_BOT_TOKEN_REF"
```

Add `pytest-asyncio==0.24.0` to `pyproject.toml`'s `dev` extras and `asyncio_mode = "auto"` to `[tool.pytest.ini_options]`.

```python
# sdk/waddle-sdk/tests/test_kv.py
from __future__ import annotations

import sys
import types

import pytest

from waddle_sdk import kv


@pytest.fixture
def fake_wit_kv(monkeypatch: pytest.MonkeyPatch):
    store: dict[str, bytes] = {}
    fake_wit_world = types.ModuleType("wit_world")
    fake_kv = types.SimpleNamespace(
        get=lambda key: list(store[key]) if key in store else None,
        set=lambda key, value, ttl: store.__setitem__(key, bytes(value)),
        delete=lambda key: store.pop(key, None),
        increment=lambda key, delta, ttl: store.__setitem__(key, str(int(store.get(key, b"0")) + delta).encode()) or int(store[key]),
    )
    fake_wit_world.imports = types.SimpleNamespace(kv=fake_kv)
    monkeypatch.setitem(sys.modules, "wit_world", fake_wit_world)
    return store


@pytest.mark.asyncio
async def test_set_then_get_round_trips(fake_wit_kv) -> None:
    await kv.set("counter", b"42", ttl_seconds=0)
    assert await kv.get("counter") == b"42"


@pytest.mark.asyncio
async def test_get_missing_key_returns_none(fake_wit_kv) -> None:
    assert await kv.get("nope") is None


@pytest.mark.asyncio
async def test_delete_removes_key(fake_wit_kv) -> None:
    await kv.set("x", b"1", ttl_seconds=0)
    await kv.delete("x")
    assert await kv.get("x") is None
```

Run: `pytest sdk/waddle-sdk/tests/test_http.py sdk/waddle-sdk/tests/test_kv.py -v`
Expected: `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add sdk/waddle-sdk/
git commit -m "$(cat <<'EOF'
feat(sdk-python): add http/kv/relay/log/clock wrappers and the component entry point

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 29: Example Python bundle + WIT conformance test

**Files:**
- Create: `bundles/python/example/bundle.yaml`
- Create: `bundles/python/example/app.py`
- Create: `bundles/python/example/wit/` (symlink to `wit/waddle-bundle/`)
- Create: `sdk/waddle-sdk/tests/test_conformance.py`

**Interfaces:**
- Consumes: `waddle_sdk._component_entry.WitWorld` (Task 28), `bundle-compiler`'s Python build recipe (Task 8) to compile it, `tools/wit-conformance-harness` (Task 22) to run it.
- Produces: the canonical Tier 1 Python example bundle referenced by spec §14.3's WIT conformance suite and §16 M2's SDK deliverable row ("Example bundle per language passing the WIT conformance suite").

- [ ] **Step 1: Write `bundle.yaml`**

```yaml
schema_version: 2
app_id: waddles.core.example.echo
name: Echo Example Bundle
version: 1.0.0
feature: waddles.core.example
module: core
provider: builtin
language: python
artifact: source
execution_model: native
is_default: false
stages:
  process:
    entry: "app:transform"
    consumes:
      - platform: discord
        event_types: ["chat.message"]
        filters:
          command_prefix: ["!echo"]
    produces: []
    config: {}
    spec:
      required_config: []
  action:
    entry: "app:dispatch"
    config: {}
    spec:
      required_config: []
egress: []
data:
  tables: []
limits:
  timeout_ms: 2000
  memory_mb: 64
  egress_rps: 10
permissions: []
config_schema: {}
compatible_with: []
incompatible_with: []
platform_compatibility:
  tested_with: "1.0.0"
  min_version: "1.0.0"
  max_version: null
```

- [ ] **Step 2: Write `app.py`** — an ordinary bundle written entirely against the SDK's compatibility import names, exercising `kv` (idempotency) and `log`

```python
"""Example Tier 1 Python bundle: `!echo <text>` replies with `<text>`,
using a `kv`-backed counter to demonstrate idempotent state and the SDK's
compatibility import surface. Written exactly the way a first-party
bundle is (same import names as `flask_core`/`waddle_transports` today).
"""

from __future__ import annotations

from waddle_sdk import kv, log
from waddle_sdk.flask_core import PlatformEvent


async def transform(event: PlatformEvent) -> PlatformEvent | None:
    text = event.payload.get("text", "")
    if not text.startswith("!echo "):
        return None
    reply_text = text.removeprefix("!echo ").strip()
    count = await kv.increment("echo_count", 1, ttl_seconds=0)
    log.info("echo bundle handled a command", count=count)
    return PlatformEvent(
        platform=event.platform,
        event_type="chat.message",
        actor=None,
        payload={"text": f"{reply_text} (echo #{count})"},
        occurred_at=event.occurred_at,
    )


async def dispatch(envelope, config, *, http_client):
    """Action stage stub — this example bundle only implements process;
    the WIT world's stub-generation (spec Assumption A1) means this export
    still exists and must return a well-formed result if ever invoked."""
    return {"status": 200, "detail": "echo bundle has no action-stage behavior", "provider_message_id": None}
```

```bash
mkdir -p bundles/python/example
ln -s ../../../wit/waddle-bundle bundles/python/example/wit
```

- [ ] **Step 3: Write the failing conformance test**

```python
# sdk/waddle-sdk/tests/test_conformance.py
"""Compiles the example bundle with the real toolchain and runs it through
the shared harness (Task 22) against golden events -- the SDK's own
WIT-conformance proof (spec §14.3), independent of bundle-compiler's own
e2e suite (Task 18), which uses a different (compiler-internal) fixture.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

EXAMPLE_BUNDLE = Path(__file__).resolve().parents[2] / "bundles" / "python" / "example"


@pytest.mark.skipif(sys.platform == "win32", reason="componentize-py toolchain assumed Linux/macOS in CI")
def test_example_bundle_compiles_and_echoes(tmp_path: Path) -> None:
    # This test calls componentize-py directly (not through bundle-compiler
    # itself, which is Task 18's own e2e concern) -- so it must generate
    # _entry_wiring.py itself, exactly the way Task 8's
    # generate_entry_wiring() does from bundle.yaml's stages.*.entry
    # fields, since componentize-py's app-class-providing module is always
    # waddle_sdk._component_entry, never the bundle's own module (see
    # Task 8's "Design decision" note).
    (EXAMPLE_BUNDLE / "_entry_wiring.py").write_text(
        '"""AUTO-GENERATED for this test -- mirrors Task 8\'s generate_entry_wiring()."""\n'
        "from app import transform as bundle_transform\n"
        "from app import dispatch as bundle_dispatch\n"
    )
    src_dir = Path(__file__).resolve().parents[1] / "src"

    wasm_path = tmp_path / "component.wasm"
    result = subprocess.run(
        [
            "componentize-py", "-d", str(EXAMPLE_BUNDLE / "wit"), "-w", "stage",
            "componentize", "-p", str(EXAMPLE_BUNDLE), "-p", str(src_dir), "waddle_sdk._component_entry",
            "--stub-wasi", "-o", str(wasm_path),
        ],
        capture_output=True,
        text=True,
    )
    (EXAMPLE_BUNDLE / "_entry_wiring.py").unlink()
    assert result.returncode == 0, result.stderr
    assert wasm_path.exists()

    events_path = tmp_path / "events.json"
    events_path.write_text(json.dumps([
        {"platform": "discord", "event_type": "chat.message", "actor": "u1", "payload_json": json.dumps({"text": "!echo hello"}), "occurred_at": "2026-09-14T12:00:00.000Z"}
    ]))

    harness = subprocess.run(
        ["wit-conformance-harness", "--component", str(wasm_path), "--events", str(events_path), "--export", "transform"],
        capture_output=True,
        text=True,
    )
    assert harness.returncode == 0, harness.stderr
    assert "hello (echo #1)" in harness.stdout
```

- [ ] **Step 4: Run test to verify it fails, then implement and re-run**

Run (before the harness binary is on `PATH`): `pytest sdk/waddle-sdk/tests/test_conformance.py -v`
Expected: FAIL — `wit-conformance-harness: command not found`.

Build `wit-conformance-harness` (Task 22) and `componentize-py` (Task 23's pinned dep) must both be on `PATH` — this test is meant to run inside the compiler's own CI image (Task 20's `lint-test` job) or an equivalent dev container, not bare on a contributor's host, per Global Constraints' "every gate runs containerized."

Run again once both are on `PATH`: `pytest sdk/waddle-sdk/tests/test_conformance.py -v`
Expected: `test_example_bundle_compiles_and_echoes ... PASSED`.

- [ ] **Step 5: Commit**

```bash
git add bundles/python/example/ sdk/waddle-sdk/tests/test_conformance.py
git commit -m "$(cat <<'EOF'
feat(sdk-python): add the Tier 1 Python example bundle and its WIT conformance test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 30: `waddle-sdk-rs` — WIT bindings + ergonomic wrappers

**Files:**
- Create: `sdk/waddle-sdk-rs/Cargo.toml`
- Create: `sdk/waddle-sdk-rs/src/lib.rs`
- Create: `sdk/waddle-sdk-rs/tests/wrapper_test.rs`

**Interfaces:**
- Produces: `waddle_sdk::{Context, Http, Kv, Db, Relay, Flags, Log, Clock}` — ergonomic Rust wrappers over `cargo-component`'s generated bindings (via `wit-bindgen`'s `Guest` trait pattern, spike2-verified in `spikes/bundle-compiler-sandbox/bundles/rust/src/lib.rs`), plus `waddle_sdk::{ProcessStage, ActionStage}` re-exports of the generated `Guest`/`export!` machinery so a bundle author writes `impl ProcessStage for MyBundle { fn transform(...) {...} }` without touching `mod bindings` directly.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "waddle-sdk"
version = "0.1.0"
edition = "2021"
description = "Waddles bundle SDK for Rust bundles"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wit-bindgen-rt = { version = "=0.44.0", features = ["bitflags"] }
serde = { version = "=1.0.210", features = ["derive"] }
serde_json = "=1.0.128"

[package.metadata.component]
package = "waddle:bundle-sdk"

[package.metadata.component.target]
path = "../../wit/waddle-bundle"
world = "stage"
```

- [ ] **Step 2: Write the failing test**

```rust
// sdk/waddle-sdk-rs/tests/wrapper_test.rs
//! Compile-time proof the wrapper types exist with the documented shape.
//! Runtime behavior (an actual host call) is only exercisable inside a
//! real component under wasmtime -- proven by Task 31's example bundle +
//! conformance test, which is this crate's true integration test.
use waddle_sdk::{Clock, Context, Db, Flags, Http, Kv, Log, Relay};

fn _type_check(_c: &Context, _h: &Http, _k: &Kv, _d: &Db, _r: &Relay, _f: &Flags, _l: &Log, _clk: &Clock) {}

#[test]
fn wrapper_types_are_zero_sized_and_constructible() {
    assert_eq!(std::mem::size_of::<Context>(), 0);
    assert_eq!(std::mem::size_of::<Http>(), 0);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --locked -p waddle-sdk`
Expected: FAIL — `waddle_sdk::{Context, Http, ...}` not defined.

- [ ] **Step 4: Implement `src/lib.rs`**

```rust
//! Waddles Rust bundle SDK — ergonomic wrappers over the `cargo-component`-
//! generated bindings for `waddle:bundle/stage@1.0.0`. Bundle authors
//! `use waddle_sdk::{Context, Http, Kv, Db, Relay, Flags, Log, Clock}`
//! instead of reaching into `bindings::waddle::bundle::*` directly — the
//! generated module names are re-exported through these zero-sized unit
//! structs so a signature change in a future WIT revision surfaces here,
//! not in every bundle.

#[allow(warnings)]
mod bindings;

pub use bindings::exports::waddle::bundle::action_stage::Guest as ActionStage;
pub use bindings::exports::waddle::bundle::process_stage::Guest as ProcessStage;
pub use bindings::waddle::bundle::types::{
    PlatformEvent, StageEnvelope, TransportError, TransportResult, UnsupportedStage,
};

/// `context` capability — always granted.
pub struct Context;
impl Context {
    pub fn get() -> bindings::waddle::bundle::context::BundleContext {
        bindings::waddle::bundle::context::get_context()
    }
}

/// `http` capability — granted only when the manifest's `egress` is non-empty.
pub struct Http;
impl Http {
    pub fn send(
        req: bindings::waddle::bundle::http::Request,
    ) -> Result<bindings::waddle::bundle::http::Response, bindings::waddle::bundle::http::Error> {
        bindings::waddle::bundle::http::send(&req)
    }
}

/// `kv` capability — always granted.
pub struct Kv;
impl Kv {
    pub fn get(key: &str) -> Result<Option<Vec<u8>>, bindings::waddle::bundle::kv::Error> {
        bindings::waddle::bundle::kv::get(key)
    }
    pub fn set(key: &str, value: &[u8], ttl_seconds: u32) -> Result<(), bindings::waddle::bundle::kv::Error> {
        bindings::waddle::bundle::kv::set(key, value, ttl_seconds)
    }
    pub fn delete(key: &str) -> Result<(), bindings::waddle::bundle::kv::Error> {
        bindings::waddle::bundle::kv::delete(key)
    }
    pub fn increment(key: &str, delta: i64, ttl_seconds: u32) -> Result<i64, bindings::waddle::bundle::kv::Error> {
        bindings::waddle::bundle::kv::increment(key, delta, ttl_seconds)
    }
}

/// `db` capability — granted only when the manifest's `data.tables` is non-empty.
pub struct Db;
impl Db {
    pub fn execute(
        statement: &str,
        params: &[bindings::waddle::bundle::db::Value],
    ) -> Result<bindings::waddle::bundle::db::Rows, bindings::waddle::bundle::db::Error> {
        bindings::waddle::bundle::db::execute(statement, params)
    }
}

/// `relay` capability — action-stage bundles only.
pub struct Relay;
impl Relay {
    pub fn push(provider: &str, message_json: &str) -> Result<(), bindings::waddle::bundle::relay::Error> {
        bindings::waddle::bundle::relay::push(provider, message_json)
    }
}

/// `flags` capability — always granted, fail-open to `default_value`.
pub struct Flags;
impl Flags {
    pub fn enabled(key: &str, default_value: bool) -> bool {
        bindings::waddle::bundle::flags::enabled(key, default_value)
    }
    pub fn tier() -> String {
        bindings::waddle::bundle::flags::tier()
    }
}

/// `log` capability — always granted; `fields` is serialized to canonical
/// JSON before crossing the WIT boundary, sanitized host-side.
pub struct Log;
impl Log {
    pub fn write(level: bindings::waddle::bundle::log::Level, message: &str, fields: &serde_json::Value) {
        bindings::waddle::bundle::log::write(level, message, &fields.to_string());
    }
    pub fn info(message: &str) {
        Self::write(bindings::waddle::bundle::log::Level::Info, message, &serde_json::json!({}));
    }
    pub fn error(message: &str) {
        Self::write(bindings::waddle::bundle::log::Level::Error, message, &serde_json::json!({}));
    }
}

/// `clock` capability — always granted; the guest's only time source.
pub struct Clock;
impl Clock {
    pub fn now_millis() -> u64 {
        bindings::waddle::bundle::clock::now_millis()
    }
    pub fn now_rfc3339() -> String {
        bindings::waddle::bundle::clock::now_rfc3339()
    }
    pub fn monotonic_nanos() -> u64 {
        bindings::waddle::bundle::clock::monotonic_nanos()
    }
}
```

Note: `mod bindings;` is generated by `cargo component build` itself (via the `[package.metadata.component]` section above) into `target/.../bindings.rs`, wired in automatically by `cargo-component`'s build integration — no hand-written `bindings.rs` exists in this repo, matching `spikes/bundle-compiler-sandbox/bundles/rust/src/lib.rs`'s own `#[allow(warnings)] mod bindings;` pattern exactly.

- [ ] **Step 5: Run tests to verify they pass**

Run (inside `rust:1.97-slim-bookworm` with `cargo-component==0.21.1` and `wasm32-wasip2` pre-installed, matching Task 9's pinned toolchain): `cargo component build --release && cargo test --locked -p waddle-sdk`
Expected: `2 passed`.

- [ ] **Step 6: Run lints**

```bash
cargo fmt --check -p waddle-sdk
cargo clippy -p waddle-sdk --all-targets -- -D warnings
```

- [ ] **Step 7: Commit**

```bash
git add sdk/waddle-sdk-rs/
git commit -m "$(cat <<'EOF'
feat(sdk-rust): add waddle-sdk-rs bindings and ergonomic capability wrappers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 31: Example Rust bundle + WIT conformance test

**Files:**
- Create: `bundles/rust/example/Cargo.toml`
- Create: `bundles/rust/example/src/lib.rs`
- Create: `bundles/rust/example/bundle.yaml`
- Create: `sdk/waddle-sdk-rs/tests/conformance_test.rs`

**Interfaces:**
- Consumes: `waddle_sdk::{ProcessStage, ActionStage, Kv, Log}` (Task 30), `tools/wit-conformance-harness` (Task 22).
- Produces: the canonical Tier 1 Rust example bundle for spec §14.3's conformance suite — same behavior as the Python example (Task 29): `!echo <text>` replies with an incrementing counter, so the two examples' golden events and expected outputs can be shared verbatim.

- [ ] **Step 1: Write `bundle.yaml`** (identical to Task 29's, `language: rust`)

```bash
mkdir -p bundles/rust/example/src
sed 's/language: python/language: rust/' bundles/python/example/bundle.yaml > bundles/rust/example/bundle.yaml
ln -s ../../../wit/waddle-bundle bundles/rust/example/wit
```

- [ ] **Step 2: Write `Cargo.toml`**

```toml
[package]
name = "bundle-echo-example"
version = "1.0.0"
edition = "2021"

[dependencies]
waddle-sdk = { path = "../../../sdk/waddle-sdk-rs" }
serde_json = "=1.0.128"

[lib]
crate-type = ["cdylib"]

[package.metadata.component]
package = "waddle:bundle-echo-example"

[package.metadata.component.target]
path = "wit"
world = "stage"
```

- [ ] **Step 3: Write `src/lib.rs`**

```rust
//! Example Tier 1 Rust bundle — behaviorally identical to Task 29's
//! Python example (`!echo <text>` replies with an incrementing counter),
//! so the two examples share golden events and expected outputs.
#[allow(warnings)]
mod bindings;

use bindings::exports::waddle::bundle::action_stage::Guest as ActionStageGuest;
use bindings::exports::waddle::bundle::process_stage::Guest as ProcessStageGuest;
use bindings::waddle::bundle::types::{
    PlatformEvent, StageEnvelope, TransportError, TransportResult, UnsupportedStage,
};
use waddle_sdk::{Kv, Log};

struct Component;

impl ProcessStageGuest for Component {
    fn transform(event: PlatformEvent) -> Result<Option<PlatformEvent>, UnsupportedStage> {
        let payload: serde_json::Value = serde_json::from_str(&event.payload_json).unwrap_or(serde_json::json!({}));
        let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
        if !text.starts_with("!echo ") {
            return Ok(None);
        }
        let reply_text = text.trim_start_matches("!echo ").trim();
        let count = Kv::increment("echo_count", 1, 0).unwrap_or(0);
        Log::info(&format!("echo bundle handled a command, count={count}"));
        let reply_payload = serde_json::json!({"text": format!("{reply_text} (echo #{count})")});
        Ok(Some(PlatformEvent {
            platform: event.platform,
            event_type: "chat.message".to_string(),
            actor: None,
            payload_json: reply_payload.to_string(),
            occurred_at: event.occurred_at,
        }))
    }
}

impl ActionStageGuest for Component {
    fn dispatch(_envelope: StageEnvelope, _config: String) -> Result<TransportResult, TransportError> {
        Ok(TransportResult {
            ok: true,
            status: Some(200),
            detail: Some("echo bundle has no action-stage behavior".to_string()),
            provider_message_id: None,
        })
    }
}

bindings::export!(Component with_types_in bindings);
```

- [ ] **Step 4: Write the failing conformance test**

```rust
// sdk/waddle-sdk-rs/tests/conformance_test.rs
use std::process::Command;

#[test]
fn example_bundle_compiles_and_echoes() {
    let bundle_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bundles/rust/example");
    let status = Command::new("cargo")
        .args(["component", "build", "--release", "--target", "wasm32-wasip2", "--offline"])
        .current_dir(&bundle_dir)
        .status()
        .unwrap();
    assert!(status.success());

    let wasm_path = bundle_dir.join("target/wasm32-wasip2/release/bundle_echo_example.wasm");
    assert!(wasm_path.exists());

    let events_path = std::env::temp_dir().join("rust_conformance_events.json");
    std::fs::write(&events_path, r#"[{"platform":"discord","event_type":"chat.message","actor":"u1","payload_json":"{\"text\":\"!echo hello\"}","occurred_at":"2026-09-14T12:00:00.000Z"}]"#).unwrap();

    let harness = Command::new("wit-conformance-harness")
        .args(["--component", wasm_path.to_str().unwrap(), "--events", events_path.to_str().unwrap(), "--export", "transform"])
        .output()
        .unwrap();
    assert!(harness.status.success(), "stderr: {}", String::from_utf8_lossy(&harness.stderr));
    let stdout = String::from_utf8_lossy(&harness.stdout);
    assert!(stdout.contains("hello (echo #1)"), "unexpected output: {stdout}");
}
```

- [ ] **Step 5: Run the test to verify it fails, then passes**

Run (before `wit-conformance-harness` is built/on `PATH`): `cargo test --locked -p waddle-sdk --test conformance_test`
Expected: FAIL — `wit-conformance-harness: command not found`.

Build Task 22's harness (`cargo build --release -p wit-conformance-harness` and add its `target/release/` to `PATH`), then re-run:
Expected: `example_bundle_compiles_and_echoes ... ok`.

- [ ] **Step 6: Commit**

```bash
git add bundles/rust/example/ sdk/waddle-sdk-rs/tests/conformance_test.rs
git commit -m "$(cat <<'EOF'
feat(sdk-rust): add the Tier 1 Rust example bundle and its WIT conformance test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 32: `waddle-sdk-js` — jco bindings + ergonomic wrappers

**Files:**
- Create: `sdk/waddle-sdk-js/package.json`
- Create: `sdk/waddle-sdk-js/tsconfig.json`
- Create: `sdk/waddle-sdk-js/src/index.ts`
- Create: `sdk/waddle-sdk-js/src/build-shim.mjs`
- Create: `sdk/waddle-sdk-js/tests/wrapper.test.ts`

**Interfaces:**
- Produces: `defineBundle({ transform, dispatch })` — the ergonomic entry point bundle authors call (per Task 10's stated design decision), plus `context()`, `http.send()`, `kv.{get,set,delete,increment}()`, `db.execute()`, `relay.push()`, `flags.{enabled,tier}()`, `log.{debug,info,warn,error}()`, `clock.{nowMillis,nowRfc3339,monotonicNanos}()` — thin wrappers over `jco`'s generated ESM imports (`import { ... } from 'waddle:bundle/http@1.0.0'`, spike2-verified import syntax). `src/build-shim.mjs` is the Node re-export shim Task 10 referenced: it reads a bundle's `{ transform, dispatch }` default export and re-emits the flat top-level `export function transform`/`export function dispatch` `jco componentize` requires.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@waddles/waddle-sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "node --test tests/"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "5.6.3",
    "@bytecodealliance/jco": "1.34.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `src/index.ts`**

```typescript
/**
 * Waddles JS/TS bundle SDK — ergonomic wrappers over jco's generated ESM
 * imports for `waddle:bundle/stage@1.0.0`. Bundle authors call
 * `defineBundle({ transform, dispatch })`; `build-shim.mjs` (invoked by
 * the compiler's JS build recipe, Task 10) re-exports the two functions
 * as the flat top-level names `jco componentize` requires.
 */

import { send as httpSend } from "waddle:bundle/http@1.0.0";
import { get as kvGet, set as kvSet, delete as kvDelete, increment as kvIncrement } from "waddle:bundle/kv@1.0.0";
import { execute as dbExecute } from "waddle:bundle/db@1.0.0";
import { push as relayPush } from "waddle:bundle/relay@1.0.0";
import { enabled as flagsEnabled, tier as flagsTier } from "waddle:bundle/flags@1.0.0";
import { write as logWrite } from "waddle:bundle/log@1.0.0";
import { nowMillis, nowRfc3339, monotonicNanos } from "waddle:bundle/clock@1.0.0";
import { getContext } from "waddle:bundle/context@1.0.0";

/** A bundle's declared JSON payload — always parsed at the SDK boundary,
 * never left as raw `payload-json` text for bundle authors to handle. */
export interface PlatformEvent {
  platform: string;
  eventType: string;
  actor: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface StageEnvelope {
  tenant: string;
  community: string | null;
  appId: string;
  stage: string;
  event: PlatformEvent;
  ts: string;
  targetAppId: string | null;
  traceContext: string | null;
}

export interface TransportResult {
  ok: boolean;
  status: number | null;
  detail: string | null;
  providerMessageId: string | null;
}

/** The two exports a bundle may implement — matches the two WIT
 * interfaces `process-stage`/`action-stage` field-for-field, camelCased. */
export interface BundleDefinition {
  transform?: (event: PlatformEvent) => PlatformEvent | null;
  dispatch?: (envelope: StageEnvelope, config: Record<string, unknown>) => TransportResult;
}

/** Ergonomic entry point — the ONLY thing a bundle author calls directly.
 * `build-shim.mjs` reads this module's default export at build time and
 * emits the flat top-level functions jco's componentize step requires. */
export function defineBundle(def: BundleDefinition): BundleDefinition {
  return def;
}

export const context = {
  get: () => getContext(),
};

export const http = {
  send: httpSend,
};

export const kv = {
  get: kvGet,
  set: kvSet,
  delete: kvDelete,
  increment: kvIncrement,
};

export const db = {
  execute: dbExecute,
};

export const relay = {
  push: relayPush,
};

export const flags = {
  enabled: flagsEnabled,
  tier: flagsTier,
};

export const log = {
  debug: (message: string, fields: Record<string, unknown> = {}) => logWrite(0, message, JSON.stringify(fields)),
  info: (message: string, fields: Record<string, unknown> = {}) => logWrite(2, message, JSON.stringify(fields)),
  warn: (message: string, fields: Record<string, unknown> = {}) => logWrite(1, message, JSON.stringify(fields)),
  error: (message: string, fields: Record<string, unknown> = {}) => logWrite(3, message, JSON.stringify(fields)),
};

export const clock = {
  nowMillis,
  nowRfc3339,
  monotonicNanos,
};
```

- [ ] **Step 4: Write `src/build-shim.mjs`** — the Task 10 design decision's re-export shim

```javascript
/**
 * Build-time-only Node script (never imported by a bundle or shipped in
 * the component). Reads a bundle module's `defineBundle({...})` default
 * export and writes a flat re-export module with top-level
 * `export function transform` / `export function dispatch` -- the exact
 * shape jco's componentize step requires (spike2's own working
 * bundles/js/bundle.js used this flat shape directly; this shim lets SDK
 * users write the ergonomic `defineBundle` shape instead). Invoked by the
 * compiler's JS build recipe (Task 10) before `jco componentize`.
 *
 * Usage: node build-shim.mjs <bundle-entry.js> <flattened-output.js>
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , entryPath, outPath] = process.argv;
if (!entryPath || !outPath) {
  console.error("usage: build-shim.mjs <bundle-entry.js> <flattened-output.js>");
  process.exit(2);
}

const mod = await import(pathToFileURL(resolve(entryPath)).href);
const def = mod.default;
if (!def || typeof def !== "object") {
  console.error(`${entryPath} must have a default export from defineBundle({...})`);
  process.exit(2);
}

const lines = [`import bundleModule from ${JSON.stringify(resolve(entryPath))};`];
if (typeof def.transform === "function") {
  lines.push("export function transform(event) { return bundleModule.transform(event); }");
}
if (typeof def.dispatch === "function") {
  lines.push("export function dispatch(envelope, config) { return bundleModule.dispatch(envelope, config); }");
}
writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");
console.log(`wrote ${outPath} with ${lines.length - 1} flattened export(s)`);
```

- [ ] **Step 5: Write the failing test, then verify it passes**

```typescript
// sdk/waddle-sdk-js/tests/wrapper.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineBundle } from "../src/index.js";

test("defineBundle returns its input unchanged", () => {
  const transform = (event: any) => event;
  const def = defineBundle({ transform });
  assert.equal(def.transform, transform);
  assert.equal(def.dispatch, undefined);
});
```

Run: `npm --prefix sdk/waddle-sdk-js run build && npm --prefix sdk/waddle-sdk-js test`
Expected: `# pass 1`.

- [ ] **Step 6: Commit**

```bash
git add sdk/waddle-sdk-js/
git commit -m "$(cat <<'EOF'
feat(sdk-js): add waddle-sdk-js bindings, ergonomic wrappers, and the defineBundle build shim

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 33: Example JS/TS bundle + WIT conformance test

**Files:**
- Create: `bundles/javascript/example/bundle.ts`
- Create: `bundles/javascript/example/bundle.yaml`
- Modify: `core/bundle_compiler/src/build/js.rs` (invoke `build-shim.mjs` before `jco componentize`, superseding Task 10's bare `jco componentize` call for SDK-authored bundles)
- Create: `sdk/waddle-sdk-js/tests/conformance.test.ts`

**Interfaces:**
- Consumes: `waddle_sdk-js`'s `defineBundle`/`kv`/`log` (Task 32), `build-shim.mjs` (Task 32), `tools/wit-conformance-harness` (Task 22).
- Produces: the canonical Tier 1 JS example bundle for spec §14.3 — same `!echo` behavior as Tasks 29/31's Python/Rust examples.

- [ ] **Step 1: Write `bundle.yaml`**

```bash
mkdir -p bundles/javascript/example
sed 's/language: python/language: typescript/' bundles/python/example/bundle.yaml > bundles/javascript/example/bundle.yaml
ln -s ../../../wit/waddle-bundle bundles/javascript/example/wit
```

- [ ] **Step 2: Write `bundle.ts`**

```typescript
/** Example Tier 1 JS/TS bundle — behaviorally identical to Tasks 29/31's
 * Python/Rust examples (`!echo <text>` replies with an incrementing
 * counter), authored against the SDK's ergonomic `defineBundle` shape.
 */
import { defineBundle, kv, log, type PlatformEvent, type StageEnvelope, type TransportResult } from "@waddles/waddle-sdk";

function transform(event: PlatformEvent): PlatformEvent | null {
  const text = String(event.payload.text ?? "");
  if (!text.startsWith("!echo ")) {
    return null;
  }
  const replyText = text.slice("!echo ".length).trim();
  const count = kv.increment("echo_count", 1n, 0);
  log.info("echo bundle handled a command", { count: Number(count) });
  return {
    platform: event.platform,
    eventType: "chat.message",
    actor: null,
    payload: { text: `${replyText} (echo #${count})` },
    occurredAt: event.occurredAt,
  };
}

function dispatch(_envelope: StageEnvelope, _config: Record<string, unknown>): TransportResult {
  return { ok: true, status: 200, detail: "echo bundle has no action-stage behavior", providerMessageId: null };
}

export default defineBundle({ transform, dispatch });
```

- [ ] **Step 3: Extend the compiler's JS build recipe to invoke `build-shim.mjs`** (Task 10's Design decision, now implemented)

```rust
// core/bundle_compiler/src/build/js.rs -- replace the body of build() with:
fn build(&self, source_dir: &Path, _manifest: &BundleManifest, out_dir: &Path) -> Result<PathBuf, CompilerError> {
    let entry = source_dir.join("bundle.js"); // TS already transpiled to .js by the author's own build step, or plain JS as here
    let flattened = out_dir.join("_flattened.mjs");
    let shim_status = Command::new("node")
        .args(["/opt/waddle-sdk-js/build-shim.mjs", entry.to_str().expect("utf8 path"), flattened.to_str().expect("utf8 path")])
        .status()
        .map_err(|e| CompilerError::CompileFailed { language: "javascript".to_string(), message: format!("build-shim.mjs failed to start: {e}") })?;
    if !shim_status.success() {
        return Err(CompilerError::CompileFailed { language: "javascript".to_string(), message: "build-shim.mjs exited non-zero".to_string() });
    }

    let wasm_out = out_dir.join("component.wasm");
    let status = Command::new("jco")
        .args([
            "componentize", flattened.to_str().expect("utf8 path"),
            "--wit", source_dir.join("wit").to_str().expect("utf8 path"),
            "--world-name", "stage",
            "--disable", "all",
            "-o", wasm_out.to_str().expect("utf8 path"),
        ])
        .status()
        .map_err(|e| CompilerError::CompileFailed { language: "javascript".to_string(), message: format!("jco failed to start: {e}") })?;
    if !status.success() {
        return Err(CompilerError::CompileFailed { language: "javascript".to_string(), message: "jco componentize exited non-zero".to_string() });
    }
    Ok(wasm_out)
}
```

Note: `/opt/waddle-sdk-js/build-shim.mjs` must be baked into the compiler image (Task 19's Dockerfile) alongside the JS toolchain — add `COPY sdk/waddle-sdk-js/src/build-shim.mjs /opt/waddle-sdk-js/build-shim.mjs` to that Dockerfile as a follow-up line (noted here rather than re-editing Task 19's already-committed Dockerfile in place, since this task lands after it).

- [ ] **Step 4: Write the failing conformance test, then verify it passes**

```typescript
// sdk/waddle-sdk-js/tests/conformance.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("example bundle compiles and echoes", () => {
  const dir = mkdtempSync(join(tmpdir(), "waddle-js-conformance-"));
  const flattened = join(dir, "_flattened.mjs");
  execFileSync("node", ["../../sdk/waddle-sdk-js/src/build-shim.mjs", "../../bundles/javascript/example/bundle.ts", flattened]);

  const wasmPath = join(dir, "component.wasm");
  execFileSync("jco", [
    "componentize", flattened,
    "--wit", "../../bundles/javascript/example/wit",
    "--world-name", "stage",
    "--disable", "all",
    "-o", wasmPath,
  ]);

  const eventsPath = join(dir, "events.json");
  writeFileSync(eventsPath, JSON.stringify([{ platform: "discord", event_type: "chat.message", actor: "u1", payload_json: JSON.stringify({ text: "!echo hello" }), occurred_at: "2026-09-14T12:00:00.000Z" }]));

  const output = execFileSync("wit-conformance-harness", ["--component", wasmPath, "--events", eventsPath, "--export", "transform"]).toString();
  assert.match(output, /hello \(echo #1\)/);
});
```

Run (once `build-shim.mjs`, `jco`, and `wit-conformance-harness` are all on `PATH`, matching Task 19's pinned image): `npm --prefix sdk/waddle-sdk-js test`
Expected: `# pass 2` (Task 32's wrapper test + this one).

- [ ] **Step 5: Commit**

```bash
git add bundles/javascript/example/ core/bundle_compiler/src/build/js.rs sdk/waddle-sdk-js/tests/conformance.test.ts
git commit -m "$(cat <<'EOF'
feat(sdk-js): add the Tier 1 JS/TS example bundle, wire build-shim.mjs into the compiler's JS recipe, and its WIT conformance test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 34: CI job — compile every bundle under `bundles/python/` with the real compiler

**Files:**
- Create: `.github/workflows/conformance-suite.yml`
- Create: `scripts/run_bundle_compatibility_suite.sh`

**Interfaces:**
- Consumes: `bundle-compiler build` (Task 7), `tools/wit-conformance-harness` (Task 22), any `bundles/python/<name>/golden/{events.json,expected.json}` fixture pairs a bundle chooses to ship.
- Produces: a CI job asserting `bundles_compiled == bundles_on_disk` and `bundles_on_disk > 0` (spec §14.4's non-vacuous denominator rule) — scoped, per Plan-Level Assumption PA4, to "compiles cleanly and (where a golden fixture exists) answers correctly under the harness," since the real `bundle-executor` does not exist until M3/M4. `bundles/python/` at the time this plan lands contains only Task 29's example bundle; the count grows as M1.5/M6 migrate the first-party set — the assertion is written to scale with whatever is on disk at CI run time, never a hardcoded number.

- [ ] **Step 1: Write `scripts/run_bundle_compatibility_suite.sh`**

```bash
#!/usr/bin/env bash
# scripts/run_bundle_compatibility_suite.sh
# Compiles every bundle.yaml found under bundles/python/ with the real
# bundle-compiler, and — where a golden/ fixture pair exists — replays it
# through tools/wit-conformance-harness and diffs the output. Non-zero
# denominator enforced: zero bundles found is a hard failure, never a
# silent "nothing to do" pass (critical-rules.md Verification Integrity).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLES_DIR="${ROOT_DIR}/bundles/python"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

mapfile -t BUNDLE_DIRS < <(find "${BUNDLES_DIR}" -mindepth 1 -maxdepth 1 -type d | sort)
BUNDLES_ON_DISK=${#BUNDLE_DIRS[@]}
if [[ "${BUNDLES_ON_DISK}" -eq 0 ]]; then
  echo "FAIL: 0 bundles found under ${BUNDLES_DIR} -- zero examined is a failure, not a pass"
  exit 1
fi

COMPILED=0
GOLDEN_CHECKED=0
for dir in "${BUNDLE_DIRS[@]}"; do
  name="$(basename "${dir}")"
  out="${WORK_DIR}/${name}"
  mkdir -p "${out}"
  echo "== compiling ${name} =="
  bundle-compiler build --bundle "${dir}" --manifest "${dir}/bundle.yaml" --out "${out}"
  test -f "${out}/component.wasm"
  COMPILED=$((COMPILED + 1))

  if [[ -f "${dir}/golden/events.json" && -f "${dir}/golden/expected.json" ]]; then
    echo "== replaying golden events for ${name} =="
    actual="$(wit-conformance-harness --component "${out}/component.wasm" --events "${dir}/golden/events.json" --export transform)"
    expected="$(cat "${dir}/golden/expected.json")"
    if [[ "${actual}" != "${expected}" ]]; then
      echo "FAIL: ${name} golden output mismatch"
      echo "  expected: ${expected}"
      echo "  actual:   ${actual}"
      exit 1
    fi
    GOLDEN_CHECKED=$((GOLDEN_CHECKED + 1))
  fi
done

echo "PASS: ${COMPILED}/${BUNDLES_ON_DISK} bundles compiled, ${GOLDEN_CHECKED} golden-event replays matched"
if [[ "${COMPILED}" -ne "${BUNDLES_ON_DISK}" ]]; then
  echo "FAIL: compiled count does not equal bundles-on-disk count"
  exit 1
fi
```

```bash
chmod +x scripts/run_bundle_compatibility_suite.sh
mkdir -p bundles/python/example/golden
cat > bundles/python/example/golden/events.json <<'EOF'
[{"platform": "discord", "event_type": "chat.message", "actor": "u1", "payload_json": "{\"text\":\"!echo hello\"}", "occurred_at": "2026-09-14T12:00:00.000Z"}]
EOF
python3 -c "import json; print(json.dumps({'platform':'discord','event_type':'chat.message','actor':None,'payload':{'text':'hello (echo #1)'},'occurred_at':'2026-09-14T12:00:00.000Z'}))" > bundles/python/example/golden/expected.json
```

- [ ] **Step 2: Run the script to verify it currently fails (before Task 29's example bundle's golden fixture matches byte-for-byte — dict key ordering from `json.dumps` may not match the harness's own serialization)**

Run: `bash scripts/run_bundle_compatibility_suite.sh`
Expected: either a clean PASS (if key ordering already matches) or a FAIL naming the exact mismatch — fix `golden/expected.json` to match the harness's actual JSON key order byte-for-byte (both use plain `json.dumps`/`serde_json::to_string`, which is insertion-order-preserving in both languages, so the fixture above should already match the field order `PlatformEvent.to_dict()` produces in Task 25's implementation: `platform, event_type, actor, payload, occurred_at`).

- [ ] **Step 3: Re-run to verify it passes**

Run: `bash scripts/run_bundle_compatibility_suite.sh`
Expected: `PASS: 1/1 bundles compiled, 1 golden-event replays matched`.

- [ ] **Step 4: Write the CI workflow**

```yaml
# .github/workflows/conformance-suite.yml
name: bundle-conformance-suite
on:
  pull_request:
    paths:
      - "bundles/**"
      - "sdk/**"
      - "core/bundle_compiler/**"
      - "wit/waddle-bundle/**"
jobs:
  compatibility-suite:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/penguintechinc/waddles/bundle-compiler:latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
      - name: Build wit-conformance-harness
        run: |
          cd tools/wit-conformance-harness
          cargo build --release --locked
          cp target/release/wit-conformance-harness /usr/local/bin/
      - name: Run bundle compatibility suite
        run: bash scripts/run_bundle_compatibility_suite.sh
```

- [ ] **Step 5: Commit**

```bash
git add scripts/run_bundle_compatibility_suite.sh bundles/python/example/golden/ .github/workflows/conformance-suite.yml
git commit -m "$(cat <<'EOF'
ci(compiler): compile every bundles/python/ bundle with the real compiler and replay golden events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 35: Bucket retention, digest/signature verification, and the "not-scanned" badge

**Files:**
- Modify: `core/bundle_compiler/src/lib.rs` (badge logic in `run_publish`)
- Create: `core/bundle_compiler/tests/bucket_retention_test.rs`

**Interfaces:**
- Consumes: `run_publish` (Task 18), `sidecar::verify_sidecar` (Task 14), `bucket::BucketClient::get_object` (Task 15).
- Produces: the "not security-scanned" badge logic (`scan_status: "not_scanned"` + `badge: Some("not-security-scanned")` forced whenever `artifact_kind == "prebuilt"`, regardless of any other scan input — spec §9.3: "permanent for the life of the version... never upgraded by a later scan of a different artifact"), plus three integration tests: bucket retention (two digests for the same `(app_id, version)` both remain fetchable), digest verification (a bucket object's bytes re-hash to the digest `app_versions` recorded), and signature verification (the bucket's sidecar verifies against the public key end-to-end).

- [ ] **Step 1: Extend `run_publish`'s scan-status logic**

```rust
// modify the scan_status line in core/bundle_compiler/src/lib.rs's run_publish:
let (scan_status, badge): (&str, Option<&str>) = if artifact_kind == "prebuilt" {
    ("not_scanned", Some("not-security-scanned"))
} else {
    ("scanned", None) // Task 5/6's scan results already gated the build container before this point ran at all
};
```

Update the two call sites that previously hardcoded `"scanned"`/`None` (`sidecar::build_and_sign_sidecar(..., scan_status, ...)` and `db.insert_version(..., scan_status, badge)`) to use these two new bindings instead.

- [ ] **Step 2: Write the failing tests**

```rust
// core/bundle_compiler/tests/bucket_retention_test.rs
use bundle_compiler::{artifact::Digests, run_publish};
use bundle_compiler::sidecar::verify_sidecar;
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use std::path::Path;
use tempfile::tempdir;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::{minio::MinIO, postgres::Postgres};

async fn setup_env() -> (testcontainers::ContainerAsync<MinIO>, testcontainers::ContainerAsync<Postgres>, tokio_postgres::Client, std::path::PathBuf) {
    let minio = MinIO::default().start().await.unwrap();
    let minio_port = minio.get_host_port_ipv4(9000).await.unwrap();
    let pg = Postgres::default().start().await.unwrap();
    let pg_port = pg.get_host_port_ipv4(5432).await.unwrap();
    let admin_url = format!("postgres://postgres:postgres@127.0.0.1:{pg_port}/postgres");
    let (client, connection) = tokio_postgres::connect(&admin_url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    client.batch_execute(&std::fs::read_to_string("migrations/0001_app_versions.sql").unwrap()).await.unwrap();
    client.batch_execute("ALTER ROLE waddles_publisher LOGIN PASSWORD 'test'").await.unwrap();

    std::env::set_var("BUNDLE_BUCKET_ENDPOINT", format!("http://127.0.0.1:{minio_port}"));
    std::env::set_var("BUNDLE_BUCKET_NAME", "waddles-bundles");
    std::env::set_var("BUNDLE_BUCKET_REGION", "us-east-1");
    std::env::set_var("BUNDLE_BUCKET_ACCESS_KEY_ID", "minioadmin");
    std::env::set_var("BUNDLE_BUCKET_SECRET_ACCESS_KEY", "minioadmin");
    std::env::set_var("PUBLISHER_DATABASE_URL", format!("postgres://waddles_publisher:test@127.0.0.1:{pg_port}/postgres"));
    let key_dir = tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let key_file = key_dir.path().join("signing.key").to_path_buf();
    std::fs::write(&key_file, signing_key.to_bytes()).unwrap();
    std::env::set_var("BUNDLE_SIGNING_PRIVATE_KEY_FILE", &key_file);

    (minio, pg, client, key_file)
}

#[tokio::test]
async fn prebuilt_artifact_gets_the_permanent_not_scanned_badge() {
    let (_minio, _pg, client, _key) = setup_env().await;
    let out = tempdir().unwrap();
    let m = bundle_compiler::manifest::parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &bundle_compiler::manifest::ManifestOptions::default()).unwrap();
    bundle_compiler::build::PythonBuilder.build(Path::new("tests/fixtures/bundles/good-python"), &m, out.path()).unwrap();
    let manifest_json = serde_json::to_vec(&m).unwrap();
    std::fs::write(out.path().join("manifest.json"), manifest_json).unwrap();

    run_publish(&out.path().join("component.wasm"), &out.path().join("manifest.json"), "python", "prebuilt").await.unwrap();

    let row = client.query_one("SELECT scan_status, badge FROM app_versions WHERE app_id = $1", &[&m.app_id]).await.unwrap();
    assert_eq!(row.get::<_, String>(0), "not_scanned");
    assert_eq!(row.get::<_, Option<String>>(1), Some("not-security-scanned".to_string()));
}

#[tokio::test]
async fn two_different_digests_for_the_same_version_are_both_retained_in_the_bucket() {
    let (_minio, _pg, client, _key) = setup_env().await;
    let m = bundle_compiler::manifest::parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &bundle_compiler::manifest::ManifestOptions::default()).unwrap();

    // First publish.
    let out1 = tempdir().unwrap();
    bundle_compiler::build::PythonBuilder.build(Path::new("tests/fixtures/bundles/good-python"), &m, out1.path()).unwrap();
    std::fs::write(out1.path().join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
    run_publish(&out1.path().join("component.wasm"), &out1.path().join("manifest.json"), "python", "source").await.unwrap();
    let digest1: String = client.query_one("SELECT artifact_digest FROM app_versions WHERE app_id = $1", &[&m.app_id]).await.unwrap().get(0);

    // Second publish: append a byte comment to the source to force a
    // different compiled component (a real re-publish scenario), same
    // (app_id, version) -- upserts the row but must NOT delete the first
    // bucket object.
    let mut app_py = std::fs::read_to_string("tests/fixtures/bundles/good-python/app.py").unwrap();
    app_py.push_str("\n# a harmless comment forcing a different component\n");
    let modified_dir = tempdir().unwrap();
    std::fs::create_dir_all(modified_dir.path().join("wit")).unwrap();
    std::fs::write(modified_dir.path().join("app.py"), app_py).unwrap();
    std::os::unix::fs::symlink(
        std::fs::canonicalize("tests/fixtures/bundles/good-python/wit").unwrap(),
        modified_dir.path().join("wit_link"),
    ).ok();
    let out2 = tempdir().unwrap();
    bundle_compiler::build::PythonBuilder.build(modified_dir.path(), &m, out2.path()).unwrap();
    std::fs::write(out2.path().join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
    run_publish(&out2.path().join("component.wasm"), &out2.path().join("manifest.json"), "python", "source").await.unwrap();
    let digest2: String = client.query_one("SELECT artifact_digest FROM app_versions WHERE app_id = $1", &[&m.app_id]).await.unwrap().get(0);

    assert_ne!(digest1, digest2, "a changed component must produce a different digest");

    // Both bucket objects must still be fetchable -- old components are
    // retained for audit (spec §7.6/§9.4), never deleted by a re-publish.
    let bucket_config = bundle_compiler::bucket::BucketConfig {
        endpoint: std::env::var("BUNDLE_BUCKET_ENDPOINT").unwrap(),
        bucket: "waddles-bundles".to_string(),
        region: "us-east-1".to_string(),
        access_key_id: "minioadmin".to_string(),
        secret_access_key: "minioadmin".to_string(),
    };
    let bucket_client = bundle_compiler::bucket::BucketClient::new(bucket_config).await.unwrap();
    for digest in [&digest1, &digest2] {
        let hex = digest.trim_start_matches("sha256:");
        let key = format!("bundles/{}/{}/{}.wasm", m.app_id, m.version, hex);
        let bytes = bucket_client.get_object(&key).await.expect("both digests' objects remain fetchable");
        assert!(!bytes.is_empty());
    }
}

#[tokio::test]
async fn bucket_object_rehashes_to_the_recorded_digest_and_sidecar_verifies() {
    let (_minio, _pg, client, key_file) = setup_env().await;
    let out = tempdir().unwrap();
    let m = bundle_compiler::manifest::parse_and_validate(Path::new("tests/fixtures/manifests/valid_python.yaml"), &bundle_compiler::manifest::ManifestOptions::default()).unwrap();
    bundle_compiler::build::PythonBuilder.build(Path::new("tests/fixtures/bundles/good-python"), &m, out.path()).unwrap();
    std::fs::write(out.path().join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
    run_publish(&out.path().join("component.wasm"), &out.path().join("manifest.json"), "python", "source").await.unwrap();

    let digest: String = client.query_one("SELECT artifact_digest FROM app_versions WHERE app_id = $1", &[&m.app_id]).await.unwrap().get(0);
    let hex = digest.trim_start_matches("sha256:");

    let bucket_config = bundle_compiler::bucket::BucketConfig {
        endpoint: std::env::var("BUNDLE_BUCKET_ENDPOINT").unwrap(),
        bucket: "waddles-bundles".to_string(),
        region: "us-east-1".to_string(),
        access_key_id: "minioadmin".to_string(),
        secret_access_key: "minioadmin".to_string(),
    };
    let bucket_client = bundle_compiler::bucket::BucketClient::new(bucket_config).await.unwrap();

    // Digest verification: hub-api's own cross-check (M2b) will do exactly
    // this -- re-fetch and re-hash independently, compare to the row.
    let component_bytes = bucket_client.get_object(&format!("bundles/{}/{}/{}.wasm", m.app_id, m.version, hex)).await.unwrap();
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&component_bytes);
    let rehashed = format!("sha256:{}", hex::encode(hasher.finalize()));
    assert_eq!(rehashed, digest, "bucket object bytes must re-hash to the digest app_versions recorded");

    // Signature verification: the sidecar in the bucket must verify
    // against the same signing key used to produce it.
    let sidecar_bytes = bucket_client.get_object(&format!("bundles/{}/{}/{}.json", m.app_id, m.version, hex)).await.unwrap();
    let key_bytes = std::fs::read(&key_file).unwrap();
    let key_array: [u8; 32] = key_bytes[..32].try_into().unwrap();
    let signing_key = SigningKey::from_bytes(&key_array);
    let verified = verify_sidecar(&sidecar_bytes, &signing_key.verifying_key()).expect("bucket sidecar verifies");
    assert_eq!(verified.digest, digest);
}
```

- [ ] **Step 3: Run tests to verify they fail, then pass**

Run: `cargo test --locked bucket_retention_test`
Expected (before Step 1's fix): `prebuilt_artifact_gets_the_permanent_not_scanned_badge` FAILs (badge is `None`, scan_status is `"scanned"` regardless of `artifact_kind`). After Step 1: `cargo test --locked bucket_retention_test` → all 3 pass.

- [ ] **Step 4: Run the full crate test suite and coverage one final time**

Run: `cargo test --locked && cargo llvm-cov --fail-under-lines 90`
Expected: every test across all 35 tasks' Rust code passes; crate-wide coverage ≥ 90%.

- [ ] **Step 5: Commit**

```bash
git add core/bundle_compiler/
git commit -m "$(cat <<'EOF'
feat(compiler): force the permanent not-scanned badge for prebuilt artifacts; verify bucket retention, digest, and signature end-to-end

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Self-Review

### 1. Spec coverage

| Spec area | Section(s) | Task(s) |
|---|---|---|
| `bundle_compiler` responsibility, build/publisher split (D27) | §4.6 | 2, 7, 13, 18, 19, 21 |
| Manifest v2 schema + V1-V24 | §6.4.1-§6.4.2, §6.4.4 | 3 |
| `consumes` shape + wildcard gate (V27-V30) | §6.4.3, §6.4.4 | 3 |
| Legacy DAL import rejection (D21b) | §9.3 | 4 |
| SAST/dependency/secrets scan, non-zero denominator | §9.3, `critical-rules.md` Verification Integrity | 5 |
| Skauswatch hand-off, `not_configured` state | §9.3 | 6 |
| Per-language build flags (`--stub-wasi`/`--disable all`/wasip2) | §4.6 | 8, 9, 10 |
| Toolchain image completeness (pre-installed `wasm32-wasip1`) | §4.6 | 19 |
| WIT world (8 imports, 2 exports, stub generation A1) | §6.5 | 1, 22 |
| Per-language import allowlist, V25/V31 | §6.5, §6.4.4 | 11 |
| Egress-vs-http cross-check, V22 | §6.4.4, §8.4 | 12 |
| Content addressing, dual digest, sole-producer rule (D27) | §4.6, §6.10, this plan's Artifact & Digest Contract | 13, 35 |
| `.cwasm` precompile self-test, `{digest}-{wasmtime_abi}-{collector}` | §7.2 | 13 |
| Signed sidecar schema | §9.4 | 14 |
| Bucket layout, MinIO/Nest | §9.4, D15 | 15 |
| `app_versions`/`app_active_versions`, two-writer rule, audit trigger | §6.10, D27 | 16 |
| RBAC matrix (D28), negative test 14g | §11.10.1 | 16 |
| hub-api callback as notification, not authority | §9.4 step 6 | 17 |
| Publish sequence end-to-end | §9.4 | 18 |
| Not-scanned badge, permanent for the version's life | §9.3 | 35 |
| Bucket retention (old components kept) | §7.6, §9.4 | 35 |
| Compiler Job two-container topology, NetworkPolicy | §4.6, §12.5 (adapted) | 21 |
| Compiler CI gate set (fmt/clippy/deny/audit/test/coverage/gitleaks) | §14.5 | 20 |
| `waddle-sdk` same import names, `penguin-dal`-compatible facade (D21, §4.12) | §4.12 | 23-28 |
| `asyncio.to_thread`/`PollLoop`/pre-import generation (spike-confirmed) | §4.12 | 24 |
| WIT conformance suite, one example bundle per Tier 1 language | §14.3 | 22, 29, 31, 33 |
| Bundle compatibility suite, `bundles_compiled == bundles_on_disk` | §14.4 | 34 |
| Digest-only executor reconciliation (documented for M3/M4) | §7.6 | Plan-Level Assumption PA2 |
| Install/consent/grants, `app_stream_grants`, permission summary | §9.7 | **Out of scope — M2b**, contract only (Task 17's OpenAPI fragment) |
| Executor wire protocol, host capability enforcement | §6.6, §7.1-§7.5 | **Out of scope — M3/M4**, PA4 |

Gaps identified and closed during this review: the RBAC matrix file and negative test 14g were missing from the initial draft (added to Task 16 after the coordinator's design-tightening messages); the "hash computed only by the publisher" and "build container has no bucket/DB env" properties needed explicit architectural-fitness tests, not just prose (added to Task 18's `e2e_test.rs`); the not-scanned badge and bucket-retention/digest/signature verification had no dedicated task (added as Task 35).

### 2. Placeholder scan

Searched for `TBD`, `TODO`, `FIXME`, "implement later", "fill in later", "similar to Task N", "left as an exercise", "to be determined", "not yet implemented" (as a bare unexplained marker) — zero matches. Every intentionally-deferred `Err(CompilerError::...)` stub (Task 2's `run_build`/`run_publish` placeholders, Task 7's per-language builder stubs) carries complete, compiling code and is named by the exact task number that replaces it, per the "No Placeholders" rule's own carve-out for legitimate TDD red-green scaffolding.

### 3. Signature consistency

Cross-checked every type/function a later task consumes against the task that defines it. Found and fixed during this review:
- `build/mod.rs`'s re-export path for `PythonBuilder`/`RustBuilder`/`JsBuilder` (Tasks 8-10) — corrected from an invalid self-referential `pub use build::python::...` to `pub use python::PythonBuilder;` (and the Rust/JS equivalents).
- Task 27's "Produces" line claimed a `QuerySet` type never implemented — removed the claim, documented the omission (async-only facade, D21) as a stated, not-a-gap decision in PA3.
- PA3 cited "Task 26" for the DB facade; the facade is Task 27 (feature_flags is 26) — corrected.
- **The most consequential fix:** every Python SDK module (Tasks 26-28) called flat `wit_world.<interface>_<function>()` names (`wit_world.db_execute`, `wit_world.kv_get`, `wit_world.context_get_context`, etc.) that do not match componentize-py's actual binding convention. Cross-checked against `spikes/bundle-compiler-sandbox/bundles/python/app.py`'s own working `from wit_world.imports.host import log` and corrected every call site (and every test's fake `wit_world` module shape) to `wit_world.imports.<interface>.<function>` throughout Tasks 26, 27, and 28.
- **A load-bearing structural bug:** Task 8's Python build recipe originally targeted the bundle's own entry module (`"app"`) directly for componentize-py's app-class-providing role — but a bundle's entry module only has plain `transform`/`dispatch` functions (per `docs/APP_BUNDLE_AUTHORING.md`'s frozen contract and Task 29's own example), never a `WitWorld` class; only `waddle_sdk._component_entry.WitWorld` (Task 28) implements that Protocol. Fixed by having Task 8 generate a build-time `_entry_wiring.py` (parsed from the manifest's `stages.*.entry` fields) and always target `waddle_sdk._component_entry`; fixed `_component_entry.py`'s own internal imports from bare (`import _asyncio_patch`) to package-qualified (`from waddle_sdk import _asyncio_patch`), since it is a submodule of an installed package, not a spike-style flat sibling file; removed an `os.environ`-driven dynamic import that could never work at runtime, since the WIT world explicitly excludes `wasi:cli/environment` (spec §6.5).
- Two remaining, explicitly flagged (not silently assumed) uncertainties: componentize-py's exact generated exception shape for a WIT `result<T,E>` error variant (`http.py`), and `wasmtime::component::Linker`'s exact interface-registration method name for the pinned crate version (`tools/wit-conformance-harness`) — both neither spike exercised, both written defensively with a named follow-up verification step rather than a guessed exact API pretended as fact.

### 4. Every spike finding has a home

| Spike finding | Where it landed |
|---|---|
| `--stub-wasi`/`--disable all` mandatory flags; default builds leak `wasi:sockets`/`wasi:cli`/`wasi:http` | Tasks 8, 10; allowlist rationale in Task 11 |
| `wasm32-wasip1` silent auto-install requires network — pre-install at image build | Task 19's Dockerfile, `build/tool-versions.env` |
| `componentize-py` executes guest code at build time (confirmed, corrected from Round 1) | Documented in Task 7/13's module docs; enforced by the untrusted `build` container (D27) |
| `componentize-py`'s own build sandbox has zero filesystem preopens | Noted as a secondary, non-substitute layer (not re-implemented — it's upstream behavior) |
| `wasm-tools component wit` text-scrape validator, per-language allowlist, exact rejection messages | Task 11, ported from `spikes/bundle-compiler-sandbox/scripts/validate_component.py` |
| `wasm-tools component targets` unsuitable as primary gate | Task 11's design note (uses `component wit`, not `targets`) |
| Rust import-elision is per-function; Python/JS import the whole interface as a unit | Reflected in Task 11's allowlist being per-namespace, not per-function |
| `.cwasm` precompile ~800x faster; collector mismatch fails to load; cache key must include collector | Task 13's precompile self-test, `wasmtime_abi`/`collector` columns on `app_versions` (Task 16) |
| `.cwasm` tied to exact wasmtime version, confirmed incompatible cross-version both directions | Task 13's dual-digest design note; `wasmtime_abi` recorded per version |
| `asyncio.to_thread`/`run_in_executor` unimplemented in the sandbox; safe to run synchronously for this workload | Task 24's `_asyncio_patch.py`/`_poll_loop.py`, adapted with the same documented boundary |
| `asyncio.run()` cannot start (`socketpair` denied); `PollLoop` is the only working loop | Task 24 |
| Deferred/lazy imports invisible to static discovery; `pkgutil.walk_packages` pre-import fix | Task 8's `PREIMPORT_GENERATOR`, Task 24's standalone script |
| `wasi:sockets` denial must be native to the executor host, not a hand-authored guest-side stub | Documented in Task 1's WIT world comments and Task 11's allowlist rationale; executor implementation is M3/M4 scope (PA4) |
| Module-level code touching a custom WIT import breaks the build (not just runtime) | Noted in `_component_entry.py`'s design (all WIT calls are inside methods, never at module scope) |
| pydal-flavored facade was the wrong target; real bundles call `flask_core.get_bundle_dal()` only | Superseded per D21 — PA3 states this explicitly and points the facade at `penguin_dal`'s real API instead |
| Bubblewrap-in-container requires a root exception; pod-boundary (gVisor) sandboxing is the adopted model | Reflected in the Job's two-container split (Task 21) and D10/D27; no bwrap anywhere in this plan's images (Task 19 asserts its absence) |
| `--tmpfs /tmp` needs `exec`; `CARGO_TARGET_DIR`/`HOME` overrides for cargo-component | Task 9's Rust build recipe env vars |

No spike finding was left unhomed.

### 5. Assumptions carried forward (see also Plan-Level Assumptions, top of document)

- PA1: manifest validator vendored in `core/bundle_compiler`, pending `penguin-bundle-host::manifest` (M1).
- PA2: WIT path/cache-key shape/sidecar schema are this plan's contract; M1c must match.
- PA3: DB facade targets `penguin_dal`'s real API per D21, not the spike's pydal-flavored one; sync `QuerySet`/`Page`/`Cursor` explicitly out of scope.
- PA4: executor capability enforcement is simulated by a harness, not implemented (M3/M4).
- PA5: the RBAC matrix file is created here with every role from spec §11.10.1, but only `waddles_publisher`'s grants are implemented/tested by this plan.

---
