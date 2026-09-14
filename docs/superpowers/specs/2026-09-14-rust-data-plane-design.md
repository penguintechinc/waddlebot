# WaddleBot Rust Data Plane + Sandboxed WASM App Bundles — Design Specification

**Date:** 2026-09-14
**Status:** Approved design — pending user review of written spec
**Scope:** `core/svc_ingest`, `core/svc_process`, `core/svc_action`, `core/svc_streaming`, two new binaries (`bundle-executor`, `bundle-compiler`), five shared crates in `penguin-libs`, one Python SDK (`waddle-sdk`), the Helm chart, and the bundle authoring contract.
**Ships:** before the v3.0 MVP, as a single clean cut-over. No Python fallback path is built.

---

## 0. Document map and sources

### 0.1 Grounding research (git-ignored working files)

Two read-only inventories were produced for this design. They are **git-ignored working files** under the `gazer-mobile-v2` worktree's `.superpowers/` directory, not part of repository history, and are cited here for provenance only:

| Working file (git-ignored, not in the repo) | What it grounds |
|---|---|
| `.superpowers/research/core-services-inventory.md` | The current four services, spine keys and cadence, envelope dataclasses, bundle contract, manifest schema, Module→Feature→App model, ingest intake surface, connectors, sizing. Sections 2–5 are the load-bearing ones for this spec. |
| `.superpowers/research/penguin-libs-inventory.md` | Existing `penguin-libs` Rust crates (`penguin-licensing`, `penguin-rpc`, `penguin-h3-tower`), publishing/branching conventions, per-crate lint and CI conventions, `penguin-dal`'s surface, proposed crate placement. |

Because both are git-ignored, every claim this spec takes from them is additionally traceable to a committed path, cited inline below.

### 0.2 Documents this spec supersedes or amends

| Document | Relationship |
|---|---|
| `docs/APP_BUNDLE_AUTHORING.md` (header: **FROZEN**, v1) | **Superseded.** Rewritten as v2 in milestone M6. v1's entrypoint contract survives semantically for `process`/`action`; the `ingest` stage stops being bundle-pluggable, and `importlib` in-process loading is replaced by WASM components. |
| `docs/plans/2026-08-31-app-bundle-sdk-design.md`, line 612 — *"Native-script sandboxing model — subprocess, WASM, or a separate pod per activation … needs an explicit call"* | **Resolved by this spec.** The explicit call is: WASM components inside a credential-less executor that runs as its own gVisor-sandboxed Deployment per stage (topology A, §11.2). |
| `docs/plans/2026-08-31-v3-sccebm-program-plan.md` open item #9, lines 407-408 — *"native = first-party only; community-native deferred until real sandbox"* | **Closed by this spec.** Community-authored native bundles become possible because the sandbox now exists. |
| `docs/plans/2026-08-26-v3-scbm-apps-design.md` | **Retained.** The Module → Feature → App model, the binding/resolution ladder and the third-party (`webhook_push`/`rest_pull`) trust boundary are unchanged. |
| `docs/plans/2026-08-31-svc-streaming-design.md` | **Retained.** `core/svc_streaming`'s Rust build is the reference implementation the other three services imitate; only the Python alpha is deleted. |

### 0.3 Committed sources of truth cited by this spec

- `libs/flask_core/flask_core/stream_pipeline.py` — envelope dataclasses, key builders, `BUNDLE_STAGES`, `PROCESS_TARGET_APP_ID_KEY`.
- `libs/flask_core/flask_core/app_manifest.py` — v1 manifest schema, `KNOWN_MODULES`, `KNOWN_SURFACES`, id/SemVer regexes, reason codes.
- `libs/flask_core/flask_core/stage_runner.py` — `BundlePoller`, `load_entrypoint`.
- `libs/flask_core/flask_core/bundle_runtime.py` — `get_bundle_dal()` / `get_bundle_context()`, the only sanctioned bundle side channel.
- `libs/flask_core/flask_core/feature_contract.py`, `.../entitlement.py`, `.../feature_flags.py` — the two-gate flag/license model and the `waddles.{module}.{feature}` flag-key rule.
- `core/svc_ingest/{app,runner,fanout,eventsub,outbound_drain,socket_lease,supervisor}.py`, `core/svc_ingest/receivers/*.py` — intake surface and connector behaviour to port.
- `core/svc_process/runner.py`, `core/svc_action/runner.py` — stage loops, hardcoded hooks, retry/backoff and audit semantics.
- `core/svc_streaming/{Cargo.toml,deny.toml,Dockerfile.rust,README.md}`, `core/svc_streaming/src/telemetry.rs` — the Rust service template (stack, pins, lints, OTel wiring, container shape).
- `hub_api/services/distribution_service.py`, `hub_api/blueprints/v1/distribution.py` — the distribution API this spec extends.
- `k8s/helm/waddlebot/values.yaml`, `k8s/helm/waddlebot/templates/svc-{ingest,process,action,streaming}.yaml` — chart shape and values keys.
- `.github/workflows/rust-svc-streaming.yml` — the per-service Rust CI gate set to replicate.
- `docs/APP_BUNDLE_AUTHORING.md` §5 — the bundle-facing DAL surface as it exists today (`await dal.execute(sql, params)`, `get_bundle_context()`), superseded by `penguin-dal` per D21a.
- `/home/penguin/code/penguin-libs/packages/python-dal/src/penguin_dal/__init__.py` — the `penguin-dal` public API the bundles migrate to and the SDK facade reproduces.

---

## 1. Goals & non-goals

### 1.1 Goals

| # | Goal | Verified by |
|---|---|---|
| G1 | The four data-plane services are Rust, on the `core/svc_streaming` Axum/tokio/SeaORM/OTel template. | `find core -name Cargo.toml` returns exactly four crates; zero `.py` files remain under `core/svc_{ingest,process,action,streaming}/`. |
| G2 | Every app bundle runs as a WASI 0.2 WebAssembly component inside a credential-less executor Deployment running under a gVisor `RuntimeClass`. | Negative sandbox tests (§14.6): the pod is verified to be under gVisor at startup, arbitrary outbound connections are refused by the NetworkPolicy, the executor holds no stage credentials, and undeclared egress is denied and counted. |
| G3 | Existing Python bundles keep running unchanged apart from their database-access lines, which move to the `penguin-dal` API first (D21a). | The DAL migration lands and every bundle's pytest suite passes **natively** before compilation work starts; then CI compiles every file under `bundles/python/` with the real compiler and replays golden events through the executor, with the same suites still passing. |
| G4 | Bundles are pluggable at `process` and `action`. `ingest` is fixed code. | `bundle.yaml` v2 rejects `stages.ingest` with reason code `ingest_not_pluggable`; svc-ingest links no executor. |
| G5 | Ingest accepts platform-specific inputs **and** a generic signed webhook + authenticated REST intake. | §10's endpoint table is covered by integration tests including auth failure, replay, oversize body and rate-limit paths. |
| G6 | The spine is at-least-once with a DLQ and bounded queues, on the existing Valkey key scheme and envelope JSON. | Golden fixtures (§14.1) asserted identical by both `flask_core` (Python) and `penguin-spine` (Rust); a crash-mid-processing test re-delivers. |
| G7 | Multi-language bundles: Python, Rust, JavaScript/TypeScript ship with SDK + compiler recipe + example (Tier 1); any WASI 0.2 component implementing the WIT world is accepted prebuilt (Tier 2). | One example bundle per Tier 1 language passes the WIT conformance suite; a hand-built Tier 2 component uploads, validates, loads and runs. |
| G8 | Bundle artifacts are content-addressed, signed, verified before load, and hot-swapped without a restart. | Digest-mismatch test refuses the load, keeps the previous version serving, increments `waddles_bundle_digest_mismatch_total`. |
| G9 | Postgres and Valkey are authenticated and TLS-encrypted by default, in every environment. | Startup refuses a plaintext/unauthenticated URL while `security.transport.tls`/`.auth` are true; flipping either to false emits the warning, sets `waddles_insecure_transport{component}` to 1, and reports `transport: insecure` on `/health`. |
| G10 | Logs, metrics **and** traces are emitted from all four services to an env-configurable OTLP endpoint, plus penguin logging. | Smoke-test telemetry gate (§14.7) asserts ≥1 log record, ≥1 metric data point, ≥1 histogram, ≥1 span, and prints the counts. |
| G11 | End-to-end latency stays within 3 s (text) / 5 s (A/V) from input to response. | `waddles_stage_latency_seconds` plus an end-to-end histogram asserted against the SLA in the alpha e2e run. |

### 1.2 Non-goals

| # | Non-goal | Why |
|---|---|---|
| N1 | Rewriting the control plane. `hub_api` stays Python 3.13 + Quart. | Not in-line of traffic (`critical-rules.md` Data Plane boundary table). |
| N2 | Rewriting `core/svc_presentation` or its `presentation` surface. | Outside the four-service scope; `presentation` stays a non-script, client-side surface. |
| N3 | Keeping a Python execution path as a fallback. | Decision D3: clean cut, v3 is a major-version jump. |
| N4 | Changing the Valkey key scheme, envelope JSON field names, the Module→Feature→App model, or the chart's service/value names. | Keeps the cut-over an implementation change, not a data or topology migration. |
| N5 | Changing the third-party (`webhook_push`/`rest_pull`) execution model. | Already out-of-process across a network hop. |
| N6 | Per-`(tenant, stage)` Valkey ACL users. | Per-**service** ACL users are in scope (§11.6); the per-tenant scheme in `stream_pipeline.py`'s docstring remains design-doc-only. |
| N7 | Replacing the 5 s distribution poll with a push mechanism. | Unchanged; it governs bundle-set refresh only, not event latency. |
| N8 | A marketplace billing/review redesign. | `hub_api/services/marketplace_*` is untouched except for the install hooks in §9. |

---

## 2. Decisions

Every row was decided by the human product owner during the 2026-09-14 design session and is authoritative.

| # | Decision | Rationale | Decided by / when |
|---|---|---|---|
| D1 | Convert `svc_ingest`, `svc_process`, `svc_action`, `svc_streaming` to Rust. | All four sit in-line of traffic; `critical-rules.md` Data Plane makes tier, not volume, the test. | Human, 2026-09-14 |
| D2 | Ship before the v3.0 MVP. | Doing it after means rewriting a shipped surface and migrating live tenants. | Human, 2026-09-14 |
| D3 | Cut over all four at once — clean cut, no Python fallback. | v3 is a major-version jump; a dual-path period doubles the test matrix and hides drift. | Human, 2026-09-14 |
| D4 | Keep the Module → Feature → App bundle architecture; implement Apps as WASM. | The logical model is sound and already enforced in `flask_core`; only the execution mechanism was unsafe. | Human, 2026-09-14 |
| D5 | Bundles allowed at every stage **except** ingest. | Ingest holds platform credentials and long-lived sockets — exactly the surface that must not run foreign code. | Human, 2026-09-14 |
| D6 | Ingest exposes a generic webhook + REST intake alongside Twitch EventSub webhook and EventSub websocket input. | Removing ingest bundles removes the only extension point; a signed generic intake restores it without executing foreign code. | Human, 2026-09-14 |
| D7 | Existing Python bundles stay byte-for-byte unchanged — **except their database-access lines** (D21a) — and are compiled with `componentize-py` plus a same-API `waddle-sdk` shim. | Bundle authors and their test suites must not be disturbed by a host rewrite; the one carve-out is a correction those bundles already owed. | Human, 2026-09-14 (amended) |
| D8 | **All** bundles run as WASM components — first-party and third-party alike. | One execution path; no privileged tier that skips the sandbox. | Human, 2026-09-14 |
| D9 | Sandbox topology A: a per-stage, credential-less `bundle-executor` running as **its own Deployment** (`svc-process-executor`, `svc-action-executor`) under a gVisor `RuntimeClass` (`runsc`) — rootless, `allowPrivilegeEscalation: false`, all capabilities dropped, read-only rootfs, `RuntimeDefault` seccomp — with a default-deny `CiliumNetworkPolicy` allowing only executor→stage on one mTLS port and executor→bucket egress; all host calls capability-scoped. | Defence in depth: a WASM escape lands in a workload holding nothing worth stealing and able to reach nothing but the mTLS host-API port and the artifact bucket. gVisor intercepts syscalls in user space, so no host-kernel capability or user namespace is needed — which a feasibility spike proved is unavailable in our containers (§18, R3). | Human, 2026-09-14 (revised after the sandbox spike) |
| D10 | The compiler Job runs under the same gVisor `RuntimeClass`, with no network except the bucket and the hub-api callback. | `componentize-py` executes bundle top-level code at build time, so compilation is itself untrusted-code execution. | Human, 2026-09-14 (revised after the sandbox spike) |
| D11 | Tier 1 languages (SDK + compiler recipe + example): Python, Rust, JavaScript/TypeScript. Tier 2: any language producing a WASI 0.2 component implementing the WIT world, uploaded prebuilt. | Covers the realistic author population without committing to maintain every toolchain. | Human, 2026-09-14 |
| D12 | Source uploads preferred and scanned (SAST, dependency audit, secrets, Skauswatch when configured). Prebuilt components accepted with a permanent "not security-scanned" warning/badge, governed by global-admin setting `bundles.allow_prebuilt` (default on). | Scannability is a real security property; refusing prebuilt entirely would exclude Tier 2 languages. | Human, 2026-09-14 |
| D13 | Manifest gains an `egress` section (FQDN or wildcard host, optional method list), enforced by the host with SSRF rules on top, plus a tenant-level global denylist. | Network reach must be declared and reviewable at install time, not discovered at runtime. | Human, 2026-09-14 |
| D14 | Compiled components are content-addressed by SHA-256; the digest is stored on the `app_catalog` version row; pods verify the digest **and** a deploy-key signature on the bucket sidecar before loading, refusing on mismatch. | The bucket is not a trust root; hub-api's DB plus a signature is. | Human, 2026-09-14 |
| D15 | Artifacts live in an S3-compatible bucket: MinIO by default, Nest when configured. | Already the pattern `svc_streaming` uses (`object_store` crate) for recordings. | Human, 2026-09-14 |
| D16 | Pods poll the bucket roughly every minute and hot-swap. | Simple, outage-tolerant, and no inbound control channel into a data-plane pod. | Human, 2026-09-14 |
| D17 | DRY via shared crates in `penguin-libs`: `penguin-spine`, `penguin-bundle-host`, `penguin-logging`, `penguin-connectors` (one crate per platform); `penguin-licensing` gains CI + publish jobs. | Four services need the same spine, host API, logging and connectors; duplicating them is how they drift. | Human, 2026-09-14 |
| D18 | Valkey naming throughout (not Redis), except where naming the wire protocol itself. | House naming; the product deploys Valkey. | Human, 2026-09-14 |
| D19 | Authentication **and** TLS required by default for Postgres and Valkey. | Credentials and event bodies cross the cluster network; default-off encryption is how it stays off. | Human, 2026-09-14 |
| D20 | The TLS/auth opt-out is a normal chart/values setting in **every** environment (`security.transport.tls`, `security.transport.auth`, both default `true`). When either is false: a loud warning at every startup, `waddles_insecure_transport{component}` = 1, `/health` reports `transport: insecure`. No environment's values file rejects it. | Operators must be able to run without TLS (bare-metal labs, constrained edge) without editing code; visibility, not prohibition, is the control. | Human, 2026-09-14 (amendment) |
| D21 | The `waddle-sdk` ships **one** database facade: the `penguin-dal` public API, implemented over the WIT `db` import. No `flask_core.database.AsyncDAL` facade and no pydal facade exist. | WaddleBot's DAL is `penguin-dal`; shipping two surfaces would institutionalize the legacy one. | Human, 2026-09-14 (correction) |
| D21a | Every existing Python bundle that imports `flask_core.database.AsyncDAL` or reaches a DAL through `get_bundle_dal()` is **migrated to the `penguin-dal` API first**, in Python, with its own pytest suite updated and passing natively, before any WASM compilation work. Bundle logic and entrypoint signatures are otherwise untouched. | Those bundles should already have been on `penguin-dal`; migrating them is a correction, not new scope, and it removes the need for a compatibility facade entirely. | Human, 2026-09-14 (supersedes "byte-identical" for DB-access lines only) |
| D21b | The compiler **rejects** any bundle that still imports `flask_core.database` or `pydal`, with a message naming the module and pointing at the `penguin-dal` equivalent. | A gate that cannot be bypassed is what stops the legacy surface from creeping back in through a new bundle. | Human, 2026-09-14 |

---

## 3. Architecture

### 3.1 System diagram

```
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │                       CONTROL PLANE — Python 3.13 / Quart                     │
  │  hub-api                                                                      │
  │    registries: app_catalog · app_activations · app_tenant_availability        │
  │    GET  /api/v1/distribution/bundles?stage=…     (5 s poll, unchanged cadence)│
  │    POST /api/v1/apps/{app_id}/versions           (install: source | prebuilt) │
  │    marketplace install/review · global setting bundles.allow_prebuilt         │
  └───┬───────────────────────────────┬───────────────────────────────┬──────────┘
      │ creates K8s Job               │ serves bundle set + digests   │ records
      │ (one per uploaded version)    │ (5 s poll from each stage)    │ digest on
      v                               │                               │ version row
  ┌───────────────────────────────┐   │                               │
  │ bundle-compiler   (K8s Job)   │   │                               │
  │  ┌─────────────────────────┐  │   │                               │
  │  │ RuntimeClass: runsc     │  │   │                               │
  │  │ (gVisor) · egress:      │  │   │                               │
  │  │  bucket + hub-api only  │  │   │                               │
  │  │  scan → compile →       │  │   │                               │
  │  │  validate → digest      │  │   │                               │
  │  └─────────────────────────┘  │   │                               │
  └───────────┬───────────────────┘   │                               │
              │ PUT component + signed sidecar                        │
              v                                                       │
  ┌──────────────────────────────────────────────────┐                │
  │ S3-compatible bucket  (MinIO default / Nest)     │<───────────────┘
  │   bundles/{app_id}/{version}/{sha256}.wasm       │
  │   bundles/{app_id}/{version}/{sha256}.json (sig) │
  └───────┬──────────────────────────┬───────────────┘
          │ ~60 s poll, fetch changed digests only
          │                          │
══════════╪══════════════════════════╪═══════════════════════════════════════════
          │        DATA PLANE — Rust (Axum · tokio · SeaORM · OTel)
 platforms│                          │
 ─────────┼──────────────┐           │
 Twitch EventSub (webhook│/websocket)│
 Twitch IRC · Discord GW │           │
 Slack Socket Mode       │           │
 YouTube poll · Kick     │           │
 POST /intake/webhook/…  │           │
 POST /intake/events     │           │
          ┌──────────────v────────────────┐
          │ svc-ingest        :8200        │   NO executor, NO bundles
          │  fixed per-platform normalizers│   holds every platform credential
          │  generic intake + rate limits  │
          │  socket leases · supervisor    │
          │  Twitch outbound relay (BLMOVE)│<───────────────┐ outbound relay
          └──────────────┬─────────────────┘                │ (dedicated conn)
                         │ LPUSH activated process keys     │
                         v                                  │
          ╔═══════════════════════════════════════╗         │
          ║ Valkey  (TLS + ACL, per-service user)  ║         │
          ║  waddles:t:{tenant}:c:{community}      ║         │
          ║          :app:{app_id}:{stage}         ║         │
          ║  …:{stage}:proc:{consumer}   (leases)  ║         │
          ║  waddles:dlq:{stage}                   ║         │
          ╚═══════════════════════════════════════╝         │
                         │ LMOVE (at-least-once)            │
                         v                                  │
          ┌────────────────────────────────┐                │
          │ svc-process       :8201        │                │
          │  built-ins: moderation gate,   │                │
          │   enforcement routing,         │                │
          │   cross-app routing            │                │
          │  host API listener      :8301  │                │
          │   (mTLS, capability-scoped)    │                │
          └───────────────▲────────────────┘                │
                          │ length-prefixed frames over TLS │
                          │ (NetworkPolicy: this port only) │
            ┌─────────────┴──────────────────────────┐      │
            │ Deployment: svc-process-executor       │      │
            │ RuntimeClass runsc (gVisor)            │      │
            │ credential-less · ro rootfs · caps ALL │      │
            │ dropped · RuntimeDefault seccomp       │      │
            │ egress: stage :8301 + bucket ONLY      │      │
            │   wasmtime instance pool               │      │
            │   ┌──────────┐ ┌──────────┐            │      │
            │   │ bundle A │ │ bundle B │  … WASM    │      │
            │   └──────────┘ └──────────┘            │      │
            └──────────────────┬─────────────────────┘      │
                               │ fetch components by digest │
                               └──▶ S3 bucket (read-only)   │
                          host calls (context/http/kv/db/   │
                          relay/flags/log/clock) are         │
                          answered by the stage on :8301     │
                       Valkey                               │
                          │                                 │
                          v                                 │
          ┌────────────────────────────────┐                │
          │ svc-action        :8202        │                │
          │  built-in platform senders     │──── Twitch ────┘
          │  retry_with_backoff · audit log│──── Discord/Slack/YouTube/Kick ──▶
          │  host API listener      :8302  │
          └───────────────▲────────────────┘
                          │  ┌──────────────────────────────┐
                          └──┤ Deployment: svc-action-      │
                             │ executor (runsc, same shape) │
                             └──────────────────────────────┘

          ┌────────────────────────────────┐
          │ svc-streaming     :8208        │  unchanged Rust service
          │  RTMP/SRT/WHIP in              │  Python alpha deleted
          │  HLS/WHEP/relay/record out     │  no bundles, no executor
          └────────────────────────────────┘
```

### 3.2 Trust zones

| Zone | Holds | Reachable from |
|---|---|---|
| **Control plane** (hub-api) | Registries, install approvals, bundle digests, per-source intake secrets, global settings. | Operators, webui, stage runners (read-only distribution API with a `distribution:read`-scoped JWT). |
| **Stage runner** (svc-ingest / svc-process / svc-action / svc-streaming) | Platform credentials, Postgres roles, Valkey ACL credentials, the egress HTTP client, secret resolution. | Cluster network; its own executor Deployment, over one mTLS host-API port. |
| **Executor** (`svc-process-executor` / `svc-action-executor` Deployments, gVisor `runsc`) | Nothing. No stage credentials, no Valkey or Postgres access, no writable filesystem beyond a private scratch `emptyDir`, read-only rootfs. Holds only its client certificate for the host-API port and read-only bucket credentials. | Nothing inbound — the NetworkPolicy allows no ingress to the executor at all; it only initiates to the stage's host-API port and to the bucket. |
| **Bundle** (WASM component) | Only what the WIT imports grant, scoped by its manifest. | The executor's wasmtime store. |
| **Compiler** (bundle-compiler Job, gVisor `runsc`) | Bucket write credentials, injected only for the upload phase. | hub-api, which creates the Job; egress limited to the bucket and the hub-api callback. |

### 3.3 What deliberately does not change

- The Valkey key scheme (`bundle_stream_key`/`bundle_config_key`/`bundle_state_key`, `libs/flask_core/flask_core/stream_pipeline.py:80-112`).
- The envelope JSON shape (`PlatformEvent` / `StageEnvelope`), including the `event`-not-`payload` naming and the `_target_app_id` reserved payload key.
- The 5 s distribution-poll cadence and its graceful-degrade-to-last-known-good behaviour.
- Helm chart structure: service names, values keys, ports 8200/8201/8202/8208, metrics 9090.
- `app_catalog` / `app_activations` / `app_tenant_availability` resolution semantics and 3-tier config precedence.
- Python bundle sources — moved from `core/svc_{process,action}/bundles/*.py` to `bundles/python/` with only their database-access lines rewritten against `penguin-dal` (D21a); logic and entrypoint signatures untouched.

---

## 4. Components

### 4.0 Repository layout after the cut-over

```
waddlebot/
  core/
    svc_ingest/        Cargo.toml  src/  tests/  Dockerfile  deny.toml  README.md
    svc_process/       Cargo.toml  src/  tests/  Dockerfile  deny.toml  README.md
    svc_action/        Cargo.toml  src/  tests/  Dockerfile  deny.toml  README.md
    svc_streaming/     Cargo.toml  src/  tests/  Dockerfile  deny.toml  README.md   (Python alpha deleted)
    bundle_executor/   Cargo.toml  src/  tests/  Dockerfile  deny.toml  README.md     (its own image and
                                                                                      Deployment per stage)
    bundle_compiler/   Cargo.toml  src/  tests/  Dockerfile  deny.toml  README.md
  bundles/
    python/            every existing *_process.py / *_send_action.py, moved (DB lines on penguin-dal)
                       + one bundle.yaml per bundle (new file, no source edits)
    rust/              example bundle + template
    javascript/        example bundle + template
  sdk/
    waddle-sdk/        Python package: same import names as flask_core/waddle_transports
                       bundle-facing API, implemented over WIT imports
    waddle-sdk-rs/     Rust crate for Tier 1 Rust bundles
    waddle-sdk-js/     npm package for Tier 1 JavaScript/TypeScript bundles
  wit/
    waddle-bundle/     stage.wit — the single normative copy of the WIT world
  hub_api/             unchanged Python, plus the install/version endpoints of §9
  k8s/helm/waddlebot/  same chart, new values keys (§12.3)
  docs/
    APP_BUNDLE_AUTHORING.md      rewritten as v2 in M6
    superpowers/specs/2026-09-14-rust-data-plane-design.md   (this file)
```

`penguin-libs` (separate repo, `~/code/penguin-libs`) gains:

```
penguin-libs/packages/
  rust-spine/          crate penguin-spine
  rust-bundle-host/    crate penguin-bundle-host
  rust-logging/        crate penguin-logging
  rust-connectors/     workspace: penguin-connector-{twitch,discord,slack,youtube,kick}
  rust-licensing/      existing crate penguin-licensing — gains CI + publish jobs
```

### 4.1 `core/svc_ingest` (Rust, rewrite)

**Responsibility.** Own every inbound platform connection and every inbound HTTP intake surface; normalize raw platform payloads into `PlatformEvent` with fixed, non-pluggable code; resolve which process-stage bundles are activated for the event's `(tenant, community)`; write finished `StageEnvelope`s directly onto those bundles' `:process` keys. Additionally run the Twitch outbound relay drain. **Holds every platform credential. Runs no bundle and links no executor.**

**Interfaces.**

| Direction | Interface |
|---|---|
| Inbound HTTP | `:8200` — the endpoint table in §10.1. |
| Inbound sockets | Twitch IRC (per channel), Twitch EventSub websocket (per tenant, when selected), Discord gateway, Slack Socket Mode, Kick Pusher; YouTube live poll. |
| Outbound | Valkey `LPUSH` onto activated `:process` keys; Twitch IRC sends drained from the outbound relay key. |
| Control | `GET {HUB_API_URL}/api/v1/distribution/bundles?stage=process` every `POLL_INTERVAL_S`, with a `distribution:read`-scoped HS256 service JWT minted from `SECRET_KEY` (unchanged mechanism). |

**Normalizers absorbed as code.** The six `core/svc_ingest/bundles/*_ingest.py` `normalize()` functions become Rust functions in `src/normalize/{twitch,twitch_eventsub,discord,slack,youtube,kick,generic}.rs`. Their behaviour is preserved exactly; the ported tests are the acceptance criterion (§14.4).

**Activation-resolution fix.** `core/svc_ingest/fanout.py`'s `NULL_INSTALLATIONS` lookup always returned zero rows, so the gateway fan-out path always fell through to each Feature's shipped default App and ignored real per-community activation. The Rust ingest resolves the target bundle set **only** through the distribution API (the same path `BundlePoller` already used correctly), so per-community activation is honoured on every path. This is a behaviour change and is called out in §15.3.

**Dependencies.** `penguin-spine`, `penguin-logging`, `penguin-connectors` (all five platform crates), `penguin-licensing`; `axum`, `tokio`, `tower-http`, `reqwest` (rustls), `serde`/`serde_json`, `hmac`, `sha2`, `subtle` (constant-time compare), `jsonwebtoken` (`aws_lc_rs` backend, never `rust_crypto` — see `core/svc_streaming/Cargo.toml`'s RUSTSEC-2023-0071 note), `governor` (token-bucket rate limiting), `redis`/`deadpool-redis` via `penguin-spine`. No SeaORM: ingest has no database, matching today.

**Configuration.**

| Var | Default | Notes |
|---|---|---|
| `MODULE_PORT` | `8200` | Matches `pipeline.svcIngest.port`. Read at runtime — fixes the current Dockerfile's hardcoded 8210 vs chart 8200 conflict. |
| `METRICS_PORT` | `9090` | Separate Prometheus listener. |
| `BIND_ADDR` | `0.0.0.0` | |
| `RUNNER_TENANT_SLUG` | `global` | Fixed tenant slug per deployment, unchanged semantics. |
| `TWITCH_EVENTSUB_MODE` | `webhook` | `webhook` or `websocket`; per-tenant, mutually exclusive (§10.2). |
| `TWITCH_EVENTSUB_SECRET` | *(unset)* | Unset ⇒ the webhook route is **not registered at all**, matching today. |
| `KICK_WEBHOOK_SECRET` | *(unset)* | Unset ⇒ route mounted but returns `503`, matching today. |
| `INTAKE_MAX_BODY_BYTES` | `262144` | 256 KiB cap on every intake route. |
| `INTAKE_REPLAY_WINDOW_S` | `300` | Signature timestamp skew window. |
| `INTAKE_RATE_LIMIT_SOURCE_RPS` / `_BURST` | `20` / `40` | Per-source token bucket. |
| `INTAKE_RATE_LIMIT_TENANT_RPS` / `_BURST` | `100` / `200` | Per-tenant token bucket. |
| `DRAIN_SOCKET_TIMEOUT_S` | `65` | Outbound-relay connection read timeout; must exceed the blocking-pop block time (§5.5). |
| `RELAY_BLOCK_TIMEOUT_S` | `30` | Blocking-pop block time for the outbound relay. |

### 4.2 `core/svc_process` (Rust, rewrite)

**Responsibility.** Drain each activated bundle's `:process` key, run the stage's built-ins around each bundle call, invoke the bundle's `transform` through the executor, and enqueue the result onto the right `:action` key.

**Built-ins vs bundles.** The Python runner's always-on hooks are re-homed with **no third path** — each is either a Rust built-in of the stage or an always-installed bundle:

| Current hook (`core/svc_process/runner.py`) | Becomes |
|---|---|
| Content-moderation gate (`services/moderation_gate.py`), which no community may opt out of | **Rust built-in**, runs before the bundle call |
| Moderation-enforcement routing (stamp + synthetic enqueue to `waddles.community.moderation.default`'s `:action`) | **Rust built-in**, runs after the gate |
| Cross-app routing via `PROCESS_TARGET_APP_ID_KEY` (`_target_app_id`) | **Rust built-in** of the enqueue step — the reserved key is popped off the payload before enqueue, exactly as today |
| `bot_process` command dispatch | **Bundle** (`waddles.bot.commands.default`) |
| Raid auto-shoutout (`_maybe_shoutout_raid`, flag `waddles.bot.shoutout`) | **Bundle** |
| Live ON/OFF status recording (`_maybe_live_status`, flag `waddles.streaming.live_status`) | **Bundle** |
| Activity-feed emission (`live_activity_events`) | **Bundle** |
| Reputation accrual (`reputation_gate_client.py`) | **Bundle** |

Rationale for the split: a hook that must run for every event regardless of activation, or that manipulates the routing of the envelope itself, is stage behaviour; everything flag-gated and per-feature is an App. This assignment is an Assumption (§20, A5) — the approved text fixed the rule ("bundles or built-ins, no third path") but not each hook.

**Interfaces.** Valkey drain/enqueue via `penguin-spine`; the capability-scoped host API on `:8301` (mTLS, executor-facing only); Postgres via SeaORM for the built-ins' own tables and for serving bundles' `db` host calls; `GET /api/v1/distribution/bundles?stage=process` poll; `/health`, `/healthz`, `/metrics` on `:8201` / `:9090`.

**Dependencies.** `penguin-spine`, `penguin-bundle-host`, `penguin-logging`, `penguin-licensing`; `axum`, `tokio`, `sea-orm` (`sqlx-postgres`, `runtime-tokio-rustls`), `serde`, `reqwest` (rustls, for bundle `http` host calls), `governor`.

### 4.3 `core/svc_action` (Rust, rewrite)

**Responsibility.** Terminal stage. Drain each activated bundle's `:action` key, invoke `dispatch` through the executor, classify the returned `transport-error.retryable`, apply retry-with-backoff, and write the outcome to `action_dispatch_log`. Platform senders become **Rust built-ins** the bundles reach through the host API (`relay` for Twitch, `http` with guarded egress for REST platforms) — a bundle never holds a platform credential.

**Retry semantics (preserved from `core/svc_action/runner.py`).** The runner owns all backoff timing; a bundle never sleeps. `transport-error.retryable = true` ⇒ retry; `false` ⇒ terminal failure recorded to `action_dispatch_log`. Defaults: `ACTION_MAX_RETRIES=3`, `ACTION_BASE_BACKOFF_MS=250`, `ACTION_MAX_BACKOFF_MS=8000`, full jitter. A `retry-after-ms` returned by the bundle (or by a built-in sender parsing a `Retry-After` header) overrides the computed backoff when larger, capped at `ACTION_MAX_BACKOFF_MS`.

**Interfaces.** Same shape as svc-process, on `:8202` / `:9090`, plus outbound platform REST calls and the Twitch outbound relay `LPUSH`.

### 4.4 `core/svc_streaming` (Rust, kept)

**Change set is deletion and alignment only:**

1. Delete the Python alpha: `app.py`, `blueprints/`, `services/`, `openapi/`, its `Dockerfile`, and its pytest tree.
2. Rename `Dockerfile.rust` → `Dockerfile`; point `build-svc-streaming.yml` at it.
3. Adopt `penguin-logging` in place of the hand-rolled `src/telemetry.rs` wiring, keeping the same env-var contract.
4. Adopt `penguin-licensing` for flag/entitlement checks.
5. No spine, no executor, no bundles — media stays fully isolated from the chat pipeline, as today.

### 4.5 `core/bundle_executor` — binary `bundle-executor`

**Responsibility.** Hold a wasmtime engine and an instance pool, accept `Invoke` frames from its stage over one mTLS connection, run the bundle's exported function under a per-call epoch deadline and memory cap, and issue host-call frames back to the stage for every capability the bundle imports. **Holds no stage credentials, no Valkey or Postgres access, and can reach exactly two network destinations: its stage's host-API port and the artifact bucket.**

**Deployed as its own Deployment per stage** — `svc-process-executor` and `svc-action-executor` — under the gVisor `RuntimeClass` (§11.2, §12.2). It dials out to the stage's host-API port (`:8301` for process, `:8302` for action) and maintains a connection pool of `EXECUTOR_STAGE_CONNECTIONS` (default `4`). Replica count tracks the stage's (`pipeline.executor.replicas`, default `2`). A stage whose executor connections are all down drains nothing and fails readiness after `EXECUTOR_UNAVAILABLE_READY_S=15`; the executor reconnects with exponential backoff (`1 s` base, `30 s` cap).

**Interfaces.** The wire protocol in §6.6 over mTLS, plus read-only bucket `GET`s for component fetches — the only two interfaces it has.

**Dependencies.** `wasmtime` (component model + WASI 0.2, exact pinned version), `tokio` (`net`, `rt-multi-thread`, `io-util`), `rustls` + `tokio-rustls` (mTLS client), `object_store` (bucket reads), `serde`/`serde_json`, `penguin-bundle-host` (shared frame types), `penguin-logging` (log frames are forwarded to the stage, never written directly). No `redis`, no `sea-orm`, no `sqlx` — the dependency set is itself part of the security argument and is asserted by a test (§14.6).

### 4.6 `core/bundle_compiler` — binary `bundle-compiler`

**Responsibility.** One gVisor-sandboxed run per uploaded bundle version: validate the manifest, scan the source, compile it to a WASI 0.2 component (or validate an uploaded prebuilt one), content-address it, and write the component plus a signed metadata sidecar to the bucket. Exits non-zero with a machine-readable reason on any failure.

**Run as** a Kubernetes Job created by hub-api, one Job per version, under the same `RuntimeClass` as the executors (`sandbox.runtimeClassName`, default `runsc`), `backoffLimit: 0`, `activeDeadlineSeconds: 900`, `ttlSecondsAfterFinished: 86400`. Its `CiliumNetworkPolicy` allows egress to the bucket and to hub-api's callback endpoint only — nothing else, in any phase.

**Phases (sequential, in one Job):**

| Phase | Network reachable | Writable | Credentials in the process environment |
|---|---|---|---|
| 1. Manifest validation | none | none | none |
| 2. Source security scan | none | scratch `emptyDir` | none |
| 3. Compile / component validation | none | scratch `emptyDir` | none |
| 4. Digest + sign + upload | bucket, then the hub-api callback | none | bucket write key and signing key, read from their mounted files in this phase only |

The Job's network identity is shared across phases, so the NetworkPolicy's two allowed destinations apply throughout; what changes per phase is the credential. Phases 1–3 run before the bucket and signing keys are read from their mounted files, and the handles are dropped once phase 4 completes.

**`componentize-py` does execute guest code at build time** — round 2 of the spike confirmed it: componentization performs a sandboxed dry-run of the bundle with the WIT imports trapped, and the compiler's own `pkgutil.walk_packages` pre-import (§4.12) deliberately widens that execution to every module in the package. Phase 3 is therefore genuinely untrusted-code execution, which is exactly why the compiler Job keeps the gVisor `RuntimeClass` requirement (D10) rather than treating compilation as a build step. Untrusted code never coexists with a credential in memory, and the only two destinations it could reach both require one.

**Dependencies.** `wasmtime` (validation only), the pinned Tier 1 toolchains (`componentize-py`, `cargo`+`wasm32-wasip2`, `jco`/`componentize-js`), `object_store` (S3), `ed25519-dalek` (sidecar signing), `sha2`, `serde`, `penguin-logging`.

### 4.7 `penguin-spine` (new crate, `penguin-libs/packages/rust-spine`)

**Responsibility.** The Valkey list spine: key builders, envelope types, the at-least-once drain loop, the lease reaper, the DLQ, and queue bounding.

**Public surface.**

```rust
pub struct BundleIsolationKeys { pub tenant: String, pub community: Option<String>, pub app_id: String }
impl BundleIsolationKeys {
    pub fn stream_key(&self, stage: Stage) -> String;      // …:{stage}
    pub fn processing_key(&self, stage: Stage, consumer_id: &str) -> String;  // …:{stage}:proc:{consumer}
    pub fn config_key(&self) -> String;                    // …:cfg
    pub fn state_key(&self) -> String;                     // …:state
}
pub enum Stage { Ingest, Process, Action }
pub struct PlatformEvent { /* §6.1 */ }
pub struct StageEnvelope { /* §6.1 */ }
pub struct SpineClient { /* pooled, TLS-aware, ACL-aware */ }
impl SpineClient {
    pub async fn enqueue(&self, key: &str, env: &StageEnvelope) -> Result<EnqueueOutcome, SpineError>;
    pub async fn take(&self, keys: &[String]) -> Result<Vec<Leased>, SpineError>;
    pub async fn ack(&self, leased: &Leased) -> Result<(), SpineError>;
    pub async fn dead_letter(&self, leased: &Leased, err: &DlqError) -> Result<(), SpineError>;
    pub async fn heartbeat(&self) -> Result<(), SpineError>;
    pub async fn reap(&self, stage: Stage) -> Result<ReapReport, SpineError>;
}
pub struct BlockingPopClient { /* dedicated connection, own socket timeout — §5.5 */ }
```

**Invariants the crate enforces (each has a test):** strict serde on every envelope read; a stage value outside `{ingest, process, action}` is an error, never a silently-wrong key; `community: None` always renders as the literal `_tenant` segment; lease/heartbeat traffic never shares a connection with an in-flight blocking pop.

### 4.8 `penguin-bundle-host` (new crate, `penguin-libs/packages/rust-bundle-host`)

**Responsibility.** Everything both sides of the executor socket must agree on, plus the stage-side implementation of the host capabilities.

| Module | Contents |
|---|---|
| `wire` | Frame codec (§6.6), message enums, correlation-id mux. Depended on by both the executor and the stages. |
| `manifest` | `bundle.yaml` v2 parse + the 22 numbered validation rules (§6.4). |
| `host::http` | Guarded egress client: manifest allowlist, SSRF rules, tenant denylist, rate limiter, timeouts, response cap, secret-ref header injection. |
| `host::kv` | Bundle-scoped key/value over `bundle_state_key`, TTL-bounded. |
| `host::db` | Parameterized statement execution under the per-bundle Postgres role, table allowlist pre-check, RLS scoping. |
| `host::relay` | Outbound relay push (Twitch). |
| `host::flags` | `penguin-licensing` two-gate resolution. |
| `host::log` | Sanitized, levelled forwarding into the stage's OTel pipeline. |
| `host::clock` | Monotonic + wall clock. |
| `loader` | Bucket poller, digest + signature verification, precompilation, hot-swap, trip accounting. |

### 4.9 `penguin-logging` (new crate, `penguin-libs/packages/rust-logging`)

Closes the gap recorded verbatim in `backend-rust.md` (*"No Rust penguin logging crate exists yet — KNOWN GAP pending `rust-logging` package in penguin-libs"*).

- Ports the `SENSITIVE_KEYS` sanitization contract from `penguin-libs/packages/python-utils/.../logging.py` **verbatim**: the same key set, matched by exact key **or** substring, replaced with the literal `[REDACTED]`; email-shaped string values replaced with `[email]@{domain}`; recursion into nested maps and lists.
- Wires `tracing` + `tracing-subscriber` + `tracing-opentelemetry` + `opentelemetry-otlp` + a `prometheus` registry, configured only from the standard OTLP env vars; an unset `OTEL_EXPORTER_OTLP_ENDPOINT` means tracing-only with no OTLP attempt (same behaviour as `core/svc_streaming/src/telemetry.rs` today).
- Exposes the shared health/metrics surface: `/health`, `/healthz`, `/metrics`, and the `transport:` field of §11.6.
- A dead exporter never fails a request: bounded buffer, drop-oldest, a counter for drops.

### 4.10 `penguin-connectors` (new workspace, `penguin-libs/packages/rust-connectors`)

One crate per platform, so a service pulls only the transitive dependencies of the platforms it actually uses.

| Crate | Covers |
|---|---|
| `penguin-connector-twitch` | IRC client (port of `libs/waddle_transports/.../transports/irc.py`), EventSub webhook verification, EventSub websocket client, Helix REST, the outbound relay queue contract. |
| `penguin-connector-discord` | Gateway client, REST message send. |
| `penguin-connector-slack` | Socket Mode client, `chat.postMessage`. |
| `penguin-connector-youtube` | Live-chat poll with the existing backoff/quota behaviour, `liveChatMessages.insert`. |
| `penguin-connector-kick` | Pusher chat client, webhook verification, REST send. |

Every crate exposes the same shape: a `Receiver` producing raw platform payloads, a `Sender` performing outbound calls, and a `verify_signature` function where the platform has one. None of them touch Valkey or Postgres.

### 4.11 `penguin-licensing` (existing crate, operational work only)

Already behaviourally complete (`LicenseClient`, two-gate flag + entitlement, 5-minute cache, exponential backoff, 72 h offline grace, hardcoded domain bypass). The work here is process, not code:

1. Add a `build-rust-licensing` job to `penguin-libs/.github/workflows/ci.yml`, mirroring `build-rust-rpc` (`cargo fmt --check`, `clippy -D warnings`, `cargo test`, `cargo deny check`).
2. Add a `publish-rust-licensing` job to `publish.yml`, tag `rust-licensing-v*`, trusted publishing, mirroring `publish-rust-rpc`.
3. Cut `release/rust-licensing/v0.1.x` and publish `0.1.0` to crates.io so the four services can pin it by exact version.

### 4.12 `waddle-sdk` (new Python package)

The shim that makes D7 true. It exposes **the same import names and the same public API** the bundles use after the M1.5 DAL migration, implemented over the WIT imports instead of over the Python host:

| Bundle-facing name today | `waddle-sdk` implementation |
|---|---|
| `from flask_core import get_bundle_context` | Reads the `context` import. |
| `from flask_core import get_bundle_dal` | Returns the `penguin-dal` facade's `AsyncDB` (below). |
| `flask_core.stream_pipeline.PlatformEvent` / `StageEnvelope` | Dataclasses with identical fields and `to_dict`/`from_dict`, constructed from the WIT records. |
| `flask_core.feature_flags.feature_enabled` | Reads the `flags` import. |
| `waddle_transports.signing.resolve_secret` | Returns an opaque `SecretRef`; the value never enters the WASM module — the stage injects it (§8.3). |
| `waddle_transports.base.RetryableTransportError` / `NonRetryableTransportError` | Raised as usual; the SDK maps them onto `transport-error.retryable`. |
| `httpx.AsyncClient` passed to action entrypoints | A drop-in client object whose `request`/`get`/`post` route to the `http` import. |
| `logging` / `flask_core.logging_config` | Routed to the `log` import. |

**The database facade (D21).** `waddle-sdk` ships exactly **one** database surface: the `penguin-dal` public API, implemented over the WIT `db` import. There is no `flask_core.database.AsyncDAL` facade and no pydal facade — the bundles that used those are migrated to `penguin-dal` first (D21a, milestone M1.5).

The surface to reproduce is `penguin_dal`'s package exports (`/home/penguin/code/penguin-libs/packages/python-dal/src/penguin_dal/__init__.py`, summarized in the penguin-libs inventory):

| Module | Names the facade implements |
|---|---|
| `penguin_dal.db` | `DB`, `AsyncDB`, `DatabaseManager` |
| `penguin_dal.query` | `Query`, `QuerySet`, `AsyncQuerySet`, `Row`, `Rows` |
| `penguin_dal.field` / `.field_proxy` / `.table_proxy` | `Field`, `FieldProxy`, `TableProxy` |
| `penguin_dal.pagination` | `Page`, `Cursor` |
| `penguin_dal.exceptions` | `DALError`, `TableNotFoundError`, `ValidationError` |
| `penguin_dal.factory` | `create_dal` |

`get_bundle_dal()` returns the facade's `AsyncDB`. Every query the builder composes is lowered to a parameterized statement sent over the WIT `db` import and executed **by the stage**, under the bundle's own Postgres role with row-level security.

**The facade is single-threaded and synchronous underneath, with async-compatible signatures.** WASI gives the guest no thread pool — the spike found `asyncio.to_thread` simply unavailable — so `await`ing a facade call runs the work inline on the `PollLoop` and returns an already-completed awaitable. Bundle code that says `await db(...).select()` is unchanged; nothing runs concurrently inside a bundle, by construction. Any `penguin-dal` construct the facade cannot lower raises an explicit `NotImplementedError` naming the construct — never a silent mis-execution. Fidelity here remains the riskiest SDK component and keeps its spike (§18, R1).

**The SDK runtime shims.** Three WASI realities mean `waddle-sdk` is not only an API surface; it also carries a small runtime layer, installed at `sitecustomize` level so bundle sources stay untouched. All three are **CONFIRMED working** by round 2 of the spike (`spikes/penguin-dal-wasm/REPORT.md`, branch `spike/penguin-dal-wasm`, commits `f45e6578`, `964f2729`), not assumed:

| Shim | Why | Behaviour | Spike status |
|---|---|---|---|
| `asyncio.to_thread` and `loop.run_in_executor` | The bundles wrap their DB reads and writes in `asyncio.to_thread(...)`, and WASI has no thread pool, so the real implementations cannot run. | Execute the callable **synchronously** and return an already-completed awaitable. Semantics for a single-threaded guest are equivalent: the call was always awaited immediately afterwards. | **CONFIRMED** — the unchanged alias bundle's full `!alias add` write path ran end to end through the shim: 4 `db-execute` round trips, 9–18 ms total; the read-only `!alias foo` path returned in 0.7–1.0 ms with no DB call. |
| Component entry point | `asyncio.run()` cannot start under WASI — it creates a `socketpair`. | The generated component entry drives `componentize-py`'s `PollLoop` instead, and the bundle's coroutine is scheduled on it. | **CONFIRMED** — the same end-to-end run is driven by `PollLoop`. |
| Module pre-import | `componentize-py`'s static import discovery misses lazily imported modules, which then fail at call time inside the guest. | The **compiler** walks the bundle package with `pkgutil.walk_packages` and pre-imports every module before componentization, so discovery sees them all. | **CONFIRMED** — build-time pre-import generation resolved every lazy import in the spike's bundle set. |

The synchronous `to_thread` replacement is the piece most likely to surprise an author, so it is called out in `APP_BUNDLE_AUTHORING.md` v2: inside a bundle, `to_thread` does not parallelize — it runs inline.

`waddle-sdk-rs` and `waddle-sdk-js` are thinner: they expose idiomatic bindings over the same WIT world with no compatibility obligation to a prior API.

---

## 5. Spine and envelopes

### 5.1 Transport

Valkey **lists** on the existing keys. Producers `LPUSH` at the head; consumers take from the tail — FIFO per key, unchanged. `penguin-spine` owns the key builders, the envelope types and the drain loop; no service builds a key by string concatenation.

### 5.2 At-least-once delivery

Today a message is implicitly acked the instant it is popped, and a crash between the pop and the downstream push loses the event. The Rust spine replaces the bare pop with a lease:

```
take:      LMOVE  {stage_key}  {proc_key}  RIGHT LEFT      -- atomic; oldest first
           SADD   waddles:proc:idx:{stage}:{consumer_id}  {proc_key}
           ZADD   waddles:consumers:{stage}  {now_ms}  {consumer_id}
ack:       LREM   {proc_key}  1  {raw_json}                -- delete on success
requeue:   LMOVE  {proc_key}  {stage_key}  LEFT RIGHT      -- back to the tail; next to be taken
```

- `{proc_key}` = `waddles:t:{tenant}:c:{community|_tenant}:app:{app_id}:{stage}:proc:{consumer_id}`.
- `{consumer_id}` = `SPINE_CONSUMER_ID`, defaulting to the pod name (downward API) and falling back to `{hostname}-{uuid-v4}`.
- Heartbeat: `ZADD waddles:consumers:{stage} {now_ms} {consumer_id}` every `SPINE_LEASE_HEARTBEAT_MS` (default `5000`).
- Lease TTL: `SPINE_LEASE_TTL_MS`, default `30000`.

**Reaper.** On startup, and every `SPINE_REAPER_INTERVAL_MS` (default `15000`), each replica runs:

```
ZRANGEBYSCORE waddles:consumers:{stage}  -inf  {now_ms - SPINE_LEASE_TTL_MS}
  for each dead consumer_id:
      SMEMBERS waddles:proc:idx:{stage}:{consumer_id}
        for each proc_key:  LMOVE proc_key -> stage_key (LEFT RIGHT) until empty
      DEL       waddles:proc:idx:{stage}:{consumer_id}
      ZREM      waddles:consumers:{stage} {consumer_id}
```

The reaper is idempotent and safe to run concurrently on every replica: each `LMOVE` is atomic, and a re-queue that races another reaper simply moves nothing.

**Redelivery cap.** Each envelope carries a `deliveries` counter incremented by the taking consumer (stored in the DLQ record, not in the envelope JSON — the envelope shape is frozen; the counter lives in a Valkey hash `waddles:deliv:{stage}` field `{sha256(raw_json)}` with a `SPINE_DELIVERY_TTL_S=3600` expiry). At `SPINE_MAX_DELIVERIES` (default `5`) the envelope goes to the DLQ with `error.kind = "max_deliveries"` instead of being re-queued.

### 5.3 Dead-letter queue

- Key: `waddles:dlq:{stage}` — one list per stage, not per bundle, so an operator has three places to look.
- Write: `LPUSH` the DLQ record of §6.3, then `LTRIM waddles:dlq:{stage} 0 {SPINE_DLQ_MAXLEN - 1}` (default `10000`, matching the existing `DEFAULT_DLQ_MAXLEN`).
- Written on: envelope deserialization failure, bundle trap or error return, executor call timeout, `max_deliveries` exhaustion, queue overflow, and a disabled-by-trip bundle's events.
- `waddles_spine_dlq_total{stage,reason}` is incremented on every write, with `reason` equal to the record's `error.kind`.

### 5.4 Bounded queues and backpressure

Stage keys are bounded at `SPINE_STAGE_MAXLEN` (default `10000`). On `enqueue`:

1. `LPUSH` the envelope.
2. `LLEN`; if greater than `SPINE_STAGE_MAXLEN`, `RPOP` the excess (the **oldest** entries — drop-oldest).
3. Every dropped entry is written to the DLQ with `error.kind = "queue_overflow"` and increments `waddles_spine_dropped_total{stage}`.
4. `waddles_spine_queue_depth{stage}` observes the post-trim length.

Steps 1–2 run as a single Lua `EVAL` so the length check and the trim cannot race another producer.

### 5.5 Client rules carried over verbatim

Two gotchas documented in `core/svc_ingest/outbound_drain.py` are properties of the protocol, not of `redis-py`, and apply identically to `redis-rs`/`deadpool-redis`. `penguin-spine` encodes both:

1. **A blocking pop runs on its own dedicated connection with its own socket timeout.** The block timeout is a *server-side command argument*, not the client socket's read timeout. `RELAY_BLOCK_TIMEOUT_S` (default `30`) must be strictly less than `DRAIN_SOCKET_TIMEOUT_S` (default `65`); `penguin-spine` refuses to construct a `BlockingPopClient` where that does not hold, with a startup error naming both values.
2. **Lease/heartbeat traffic (`SET`, `EVAL`, `ZADD`) never shares a connection with an in-flight blocking pop.** Cancelling the future does not tell the Valkey server to abandon the command, so a pooled connection can hand the next caller a socket with a stale pending reply. `BlockingPopClient` owns a single connection that is never returned to the shared pool, and the shared pool refuses `BLMOVE`/`BRPOP`/`BLMPOP` commands outright.

Both rules have dedicated tests (§14.2).

### 5.6 Drain cadence and the latency SLA

| Timer | Value | Governs |
|---|---|---|
| `POLL_INTERVAL_S` | `5.0` | **Bundle-set refresh only** — how soon a newly activated bundle is noticed. Unchanged from `core/svc_ingest/config.py:47`. |
| `SPINE_DRAIN_IDLE_SLEEP_MS` | `100` | How long a stage sleeps after a drain pass that moved zero messages. A pass that moved at least one message immediately runs again with no sleep. |
| `RELAY_BLOCK_TIMEOUT_S` | `30` | The Twitch outbound relay's genuine blocking pop. |

Worst-case queueing delay added by a stage is therefore one `SPINE_DRAIN_IDLE_SLEEP_MS` (100 ms), not one poll interval. Two hops (process, action) plus ingest gives a worst case of 300 ms of scheduling latency, leaving the rest of the 3 s text budget to platform round-trips and bundle work. The end-to-end budget is asserted in the alpha e2e run (§14.8).

### 5.7 Ingest → process routing

Ingest writes finished `PlatformEvent`s (wrapped in a `StageEnvelope` with `stage = "process"`) **directly onto the `:process` key of every activated process-stage bundle** for the event's `(tenant, community)`, resolved through the distribution API. There is no `:ingest` key in the new design: nothing consumes one, because ingest bundles no longer exist. The key builder still accepts `Stage::Ingest` so historical keys remain parseable by tooling, and `penguin-spine` refuses to *enqueue* onto an `:ingest` key with error `IngestStageNotWritable`.

### 5.8 Ordering, scope and tenancy

- **Ordering:** per-bundle FIFO within a stage. No ordering guarantee across bundles, communities, or the process→action hop — unchanged from today.
- **Tenant** is the deployment's `RUNNER_TENANT_SLUG`; **community** is `Option<String>` where `None` renders `_tenant`.
- Tenant and community are sourced **exclusively** from the Valkey key the envelope was taken from, never from event payload. The `_target_app_id` escape hatch changes only the destination key's `app_id` segment, never its tenant or community segments — the invariant `stream_pipeline.py` documents at lines 251-286 is preserved bit for bit.

---

## 6. Data contracts

Everything in this section is normative. Where a value is a default, the environment variable that overrides it is named.

### 6.1 Envelope JSON

The queue-crossing shape is unchanged from `libs/flask_core/flask_core/stream_pipeline.py:204-328`, plus one new optional field (`trace_context`).

#### 6.1.1 `PlatformEvent`

```json
{
  "platform": "twitch",
  "event_type": "chat.message",
  "actor": "some_user",
  "payload": {"text": "!songrequest foo", "channel_id": "12345", "message_id": "abc"},
  "occurred_at": "2026-09-14T12:00:00.000Z"
}
```

| Field | JSON type | Required | Constraint | Violation |
|---|---|---|---|---|
| `platform` | string | yes | non-empty | `EnvelopeError` / `SpineError::Envelope`, DLQ `error.kind = "envelope_invalid"` |
| `event_type` | string | yes | non-empty | same |
| `actor` | string \| null | yes (may be null) | string when present | same |
| `payload` | object | yes | JSON object; may be empty `{}`; never a scalar or array | same |
| `occurred_at` | string | yes | non-empty; RFC 3339 UTC with millisecond precision, `Z` suffix | same |

#### 6.1.2 `StageEnvelope`

```json
{
  "tenant": "global",
  "community": null,
  "app_id": "waddles.bot.commands.default",
  "stage": "process",
  "event": { "...PlatformEvent..." },
  "ts": "2026-09-14T12:00:00.123Z",
  "target_app_id": null,
  "trace_context": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
}
```

| Field | JSON type | Required | Constraint |
|---|---|---|---|
| `tenant` | string | yes | non-empty; equals the `t:` segment of the key it was taken from |
| `community` | string \| null | yes (may be null) | `null` ⇔ the key's `c:` segment is the literal `_tenant` |
| `app_id` | string | yes | matches `^waddles\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$` |
| `stage` | string | yes | one of `ingest`, `process`, `action` |
| `event` | object | yes | a `PlatformEvent` object; a message without an `event` key is refused, never coerced |
| `ts` | string | yes | non-empty; RFC 3339 UTC, millisecond precision |
| `target_app_id` | string \| null | no | absent or `null` ⇒ `None`; when set, changes only the destination key's `app_id` segment |
| `trace_context` | string \| null | no | W3C `traceparent` (`00-<32 hex>-<16 hex>-<2 hex>`); absent or `null` ⇒ no parent span |

**Strictness.** Both implementations use strict deserialization: a missing required field, a wrong-typed field, an unknown top-level field, or a `stage` outside the fixed set is an error. No coercion, ever. `flask_core.stream_pipeline`'s `from_dict` is tightened to reject unknown keys and to carry `trace_context` in M1, so the Python (hub-api, tests) and Rust (data plane) readers agree byte for byte.

**Reserved payload key.** `_target_app_id` (`PROCESS_TARGET_APP_ID_KEY`) may be set by a process bundle inside `event.payload`; the stage pops it back out before enqueuing, so it never reaches an action bundle or a chat reply. Unchanged.

### 6.2 Key scheme

Base: `waddles:t:{tenant}:c:{community|_tenant}:app:{app_id}`.

| Purpose | Key | Valkey type | Written by | Read by |
|---|---|---|---|---|
| Stage queue | `{base}:{stage}` where `{stage}` ∈ `process`, `action` | list | ingest (process keys), process (action keys) | the owning stage |
| Legacy ingest queue | `{base}:ingest` | list | nothing (writes refused: `IngestStageNotWritable`) | nothing; the builder still parses it for tooling |
| In-flight lease | `{base}:{stage}:proc:{consumer_id}` | list | the taking consumer | its own consumer; the reaper |
| Consumer index | `waddles:proc:idx:{stage}:{consumer_id}` | set | the taking consumer | the reaper |
| Consumer heartbeats | `waddles:consumers:{stage}` | sorted set (score = epoch ms) | every consumer | the reaper |
| Delivery counter | `waddles:deliv:{stage}` field `{sha256(raw_json)}` | hash, `SPINE_DELIVERY_TTL_S=3600` | the taking consumer | the taking consumer |
| Bundle config | `{base}:cfg` | string (JSON) | the stage, on distribution refresh | the stage (host `context`) |
| Bundle state | `{base}:state` | hash | host `kv` calls | host `kv` calls |
| Dead letter | `waddles:dlq:{stage}` | list, `LTRIM`-capped | any stage | operators, replay tooling |
| Twitch outbound relay | the provider-scoped key from `waddle_transports.transports.irc_relay.outbound_queue_key("twitch")` | list | svc-action's `relay` host call | svc-ingest's outbound drain |

`{community}` is the community slug, or the literal `_tenant` when the activation is tenant-wide — never omitted, so splitting a key on `:` always yields the same field count.

### 6.3 DLQ record

One JSON object per `LPUSH` onto `waddles:dlq:{stage}`:

```json
{
  "schema_version": 1,
  "stage": "process",
  "key": "waddles:t:global:c:_tenant:app:waddles.bot.commands.default:process",
  "tenant": "global",
  "community": null,
  "app_id": "waddles.bot.commands.default",
  "artifact_digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "consumer_id": "svc-process-7d9c4f",
  "deliveries": 5,
  "failed_at": "2026-09-14T12:00:01.500Z",
  "error": {
    "kind": "call_timeout",
    "code": "EXECUTOR_DEADLINE",
    "message": "bundle call exceeded 2000 ms",
    "detail": null
  },
  "trace_context": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "raw": "{\"tenant\":\"global\",\"community\":null,...}"
}
```

| Field | Notes |
|---|---|
| `schema_version` | Always `1` for this spec. |
| `raw` | The original envelope JSON **as a string, verbatim**, so a malformed envelope is still replayable/inspectable. |
| `artifact_digest` | `null` when the failure happened before a bundle was selected (e.g. `envelope_invalid`). |
| `error.kind` | One of the ten values below; equals the `reason` label on `waddles_spine_dlq_total`. |

| `error.kind` | Raised when |
|---|---|
| `envelope_invalid` | Strict deserialization failed. |
| `bundle_trap` | The WASM component trapped (panic, unreachable, OOM inside the guest). |
| `bundle_error` | The component returned an error the stage classifies as terminal (`retryable = false`, or a process bundle raising). |
| `call_timeout` | The per-call epoch deadline fired. |
| `memory_limit` | The instance exceeded its memory cap. |
| `host_call_denied` | A capability check refused the call (undeclared egress host, table outside `data.tables`, missing capability). |
| `max_deliveries` | `deliveries` reached `SPINE_MAX_DELIVERIES`. |
| `queue_overflow` | Drop-oldest trimming evicted the entry (§5.4). |
| `bundle_disabled` | The bundle is disabled after three sandbox trips (§7.5). |
| `executor_unavailable` | The executor was down past `EXECUTOR_UNAVAILABLE_READY_S` and the event could not be attempted. |

### 6.4 `bundle.yaml` v2

One file per bundle, at the root of the source tarball (Tier 1) or uploaded alongside the component (Tier 2). This is the **first time bundles carry an on-disk manifest** — today first-party registration is a Postgres migration row in `app_catalog.stages` (`docs/APP_BUNDLE_AUTHORING.md` §3). `bundle.yaml` becomes the source of truth for a bundle's identity, capability requests and limits; the `app_catalog` row is generated from it at install time.

#### 6.4.1 Complete example

```yaml
schema_version: 2
app_id: waddles.socials.music.default
name: Music Station Song Request
version: 3.0.0
feature: waddles.socials.music
module: socials
provider: builtin
language: python
artifact: source
execution_model: native
is_default: true

stages:
  process:
    entry: "bundles.social_music_process:transform"
    consumes: ["twitch.chat.message", "discord.message"]
    produces: ["waddles.music.request"]
    config:
      command_prefix: "!"
    spec:
      required_config: []
  action:
    entry: "bundles.social_music_action:send_request"
    config:
      api_base: "https://hub-api.waddlebot.svc.cluster.local:8204"
    spec:
      required_config: ["music_station_token_ref"]

egress:
  - host: "api.spotify.com"
    methods: ["GET", "POST"]
  - host: "*.googleapis.com"

data:
  tables:
    - music_queue
    - music_history

limits:
  timeout_ms: 2000
  memory_mb: 64
  egress_rps: 10

permissions:
  - "music:read"
  - "music:write"

config_schema:
  command_prefix:
    type: string
    default: "!"

compatible_with: []
incompatible_with: ["waddles.socials.music.legacy"]

platform_compatibility:
  tested_with: "3.0.0"
  min_version: "3.0.0"
  max_version: null
```

#### 6.4.2 Field reference

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `schema_version` | integer | yes | — | Must be exactly `2`. A `1` or absent value is a v1 manifest and is rejected with an upgrade message. |
| `app_id` | string | yes | — | `waddles.<module>.<feature>.<app>`, exactly four dot-separated segments matching `[a-z0-9][a-z0-9_-]*`. |
| `name` | string | yes | — | 1–120 characters, human-readable. |
| `version` | string | yes | — | SemVer 2.0.0 (core, optional pre-release, optional build metadata). |
| `feature` | string | yes | — | `waddles.<module>.<feature>`; must equal `app_id` minus its last segment. |
| `module` | string | yes | — | Member of `KNOWN_MODULES` (`libs/flask_core/flask_core/app_manifest.py:62-83`); must equal `feature`'s second segment. |
| `provider` | string | yes | — | `builtin` or `thirdparty`. |
| `language` | string | yes | — | `python`, `rust`, `javascript`, `typescript`, or `other`. `other` is only legal with `artifact: prebuilt`. |
| `artifact` | string | yes | — | `source` or `prebuilt`. |
| `execution_model` | string | no | `native` | `native` (WASM component) or `thirdparty` (out-of-process webhook/REST, unchanged from v1 and never compiled). |
| `is_default` | boolean | no | `false` | At most one `true` per Feature, enforced at registration. |
| `stages` | map | yes | — | Keys from `{process, action, presentation}`. **`ingest` is rejected.** At least one key required. |
| `stages.<s>.entry` | string | yes for `process`/`action` when `artifact: source` | — | Language-specific entry reference, recorded for provenance and shown in the UI. Dispatch itself is by WIT export, not by this string. |
| `stages.<s>.consumes` | list of string | no | `[]` | Event tags this stage consumes; informational, mirrors v1. |
| `stages.<s>.produces` | list of string | no | `[]` | Event tags this stage produces; informational. |
| `stages.<s>.config` | map | no | `{}` | The bundle's own **non-secret** shipped defaults. Never per-activation values, never secrets. |
| `stages.<s>.spec.required_config` | list of string | no | `[]` | Config keys an activation must supply; surfaced at install/activation time. |
| `stages.presentation.*` | — | — | — | `html_entrypoint`, `assets`, `browser_source_path` as in v1; never compiled to WASM, served by `svc_presentation`. |
| `egress` | list | no | `[]` | Each item `{host: string, methods?: list of string}`. |
| `egress[].host` | string | yes within an item | — | A lowercase FQDN, or a single-label wildcard prefix `*.example.com`. No scheme, no path, no port, no bare `*`, no IP literal. |
| `egress[].methods` | list of string | no | all of `GET,HEAD,POST,PUT,PATCH,DELETE` | Uppercase HTTP methods. |
| `data.tables` | list of string | no | `[]` | Postgres table names (unqualified, `[a-z][a-z0-9_]{0,62}`) the bundle may read/write through the `db` capability. |
| `limits.timeout_ms` | integer | no | `2000` | Per-call wall-clock deadline; must be ≥ `50` and ≤ `EXECUTOR_MAX_CALL_TIMEOUT_MS` (`10000`). |
| `limits.memory_mb` | integer | no | `64` | Per-instance linear-memory cap; must be ≥ `8` and ≤ `EXECUTOR_MAX_MEMORY_LIMIT_MB` (`256`). |
| `limits.egress_rps` | integer | no | `10` | Per-bundle egress rate; must be ≥ `1` and ≤ `EGRESS_RATE_LIMIT_RPS` (`10`) unless the operator raised the ceiling. |
| `permissions` | list of string | no | `[]` | OIDC scopes (`resource:action`) the bundle's Feature requires; mirrors v1's `permissions`/`requires_scopes`. |
| `config_schema` | map | no | `{}` | Per-key `{type, default}` documentation used by the activation UI. |
| `compatible_with` | list of string | no | `[]` | Other `app_id`s. |
| `incompatible_with` | list of string | no | `[]` | Other `app_id`s; checked pairwise before activation (`detect_conflict`). |
| `platform_compatibility` | map | no | `{tested_with: "", min_version: null, max_version: null}` | SemVer strings, parsed not enforced, exactly as v1. |

#### 6.4.3 Validation rules

Every rule below fails the install with a machine-readable `reason` code. Rules run in order; the first failure is reported. V1–V13 reproduce `parse_manifest()`'s existing ordered rules; V14–V24 are new.

| # | Rule | `reason` code |
|---|---|---|
| V1 | Every required field present | `missing_field` |
| V2 | `version` is valid SemVer 2.0.0 | `bad_semver` |
| V3 | `app_id` matches the four-segment pattern | `not_namespaced` |
| V4 | `feature` matches the three-segment pattern | `not_namespaced` |
| V5 | `module` ∈ `KNOWN_MODULES` | `unknown_module` |
| V6 | `feature` == `app_id` minus its last segment, and `module` == `feature`'s second segment | `feature_prefix_mismatch` |
| V7 | `provider` ∈ `{builtin, thirdparty}` | `invalid_provider` |
| V8 | Every `stages` key ∈ `{process, action, presentation}` | `unknown_surface` |
| V9 | `execution_model` ∈ `{native, thirdparty}` | `invalid_execution_model` |
| V10 | `platform_compatibility` version strings are valid SemVer or null | `bad_platform_compat_semver` |
| V11 | Every `compatible_with`/`incompatible_with` entry is a valid `app_id` | `invalid_compat_app_id` |
| V12 | A `presentation` stage declares `html_entrypoint` and no script entry | `presentation_missing_html_entrypoint` / `presentation_has_script_entrypoint` |
| V13 | A `process`/`action` stage declares no `html_entrypoint` | `script_stage_has_html_entrypoint` |
| V14 | `schema_version` == `2` | `unsupported_schema_version` |
| V15 | `stages` contains no `ingest` key | `ingest_not_pluggable` |
| V16 | `stages` is non-empty | `no_stages_declared` |
| V17 | `language` ∈ the five allowed values; `other` only with `artifact: prebuilt` | `unsupported_language` |
| V18 | `artifact` ∈ `{source, prebuilt}`; `prebuilt` is refused when the global setting `bundles.allow_prebuilt` is false | `prebuilt_not_allowed` |
| V19 | Every `egress[].host` is a lowercase FQDN or a single-label `*.` wildcard: no scheme, path, port, credentials, bare `*`, IPv4/IPv6 literal, or `localhost` | `invalid_egress_host` |
| V20 | Every `egress[].methods` entry is one of the six allowed uppercase methods | `invalid_egress_method` |
| V21 | No `egress[].host` matches the tenant-level global denylist | `egress_host_denylisted` |
| V22 | `egress` is non-empty when the compiled component imports `waddle:bundle/http` | `http_import_without_egress` |
| V23 | Every `data.tables` entry matches `^[a-z][a-z0-9_]{0,62}$` and is not a reserved WaddleBot identity table (`users`, `tenants`, `communities`, `app_catalog`, `app_activations`, `app_tenant_availability`) | `invalid_data_table` / `reserved_data_table` |
| V24 | Each `limits.*` value is within its allowed range (§6.4.2) | `limit_out_of_range` |

Two further checks run against the **compiled artifact**, not the YAML, and use the same reason vocabulary:

| # | Rule | `reason` code |
|---|---|---|
| V25 | The component's exports satisfy the WIT world for every declared script stage | `wit_export_missing` |
| V26 | The component imports nothing outside the WIT world's import list **plus the denying `wasi:sockets` stub set** (§6.5): no other `wasi:*` interface, and no `wasi:filesystem` beyond the read-only scratch preopen. A component importing `wasi:sockets/*` must instantiate cleanly against the stubs — Python-built components always do; a Tier 2 upload that does not is rejected | `forbidden_host_import` |

### 6.5 The WIT world

Normative copy: `wit/waddle-bundle/stage.wit`. Version `waddle:bundle/stage@1.0.0`.

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

**Both stage interfaces are always exported.** A bundle that implements only one stage exports a stub for the other: `process-stage.transform` returns `err(unsupported-stage)` and `action-stage.dispatch` returns a `transport-error` with `code = "UNSUPPORTED_STAGE"`, `retryable = false`. Tier 1 SDKs generate the stub automatically. The manifest's `stages` map is authoritative about which export a stage actually calls; calling an unimplemented export is a manifest/registration bug and is DLQ'd with `error.kind = "bundle_error"`.

**Explicitly absent from the world:** `wasi:sockets` (no network from inside the guest — all egress goes through the guarded `http` import), `wasi:filesystem` beyond a single read-only preopen at `/scratch` (empty at load), `wasi:cli/environment` (no environment variables). `wasi:random/random@0.2.x` **is** permitted, because deterministic-only randomness breaks legitimate bundles (shuffles, giveaways).

**The `wasi:sockets` stub rule.** `componentize-py`'s runtime links the full WASI Preview 2 import set — including `wasi:sockets/*` — regardless of the world we declare, so a Python-built component will not instantiate unless those imports are satisfiable. The executor therefore provides **denying implementations** for every `wasi:sockets` import: instantiation succeeds, and any actual socket call returns an error immediately (`wasi:sockets` `error-code::access-denied`, surfacing in guest Python as `PermissionError`), is logged at DEBUG, and counts as a `denied` host call toward the trip threshold. The spike confirmed the behaviour end to end: guest socket use fails cleanly with `PermissionError` and **the component keeps running** — it does not trap, and the invocation completes normally.

**The denying interfaces must be implemented natively in the Rust executor.** Round 2 established that hand-authored stub components are impractical (they were tried against the Python `wasmtime` host and did not hold up); `bundle-executor` links its own implementations of the `wasi:sockets` interfaces that refuse every operation. This is an executor requirement, not a build-time trick, and it is covered by §14.6 test 1.

The rule for validation (V26) is then precise rather than absolute:

- a component built by the **Python** Tier 1 toolchain may import `wasi:sockets/*`, because it is linked against the stubs and cannot use them;
- a **prebuilt (Tier 2)** upload may import `wasi:sockets/*` only under the same condition — it is instantiated against the same denying stubs — and the validator records the fact on the version row; any Tier 2 component that both imports `wasi:sockets` **and** fails the stubbed-instantiation check is rejected with `forbidden_host_import`;
- any import outside the world's list plus the `wasi:sockets` stub set is rejected outright, for every tier.

The guarantee the rule preserves is unchanged: no bundle of any language opens a socket. What changed is that the enforcement point is the stub, not the absence of the import.

**Capability scoping.** Grants are computed once per bundle load from the manifest and are enforced on the **stage** side, not by trusting the component's import list:

| Capability | Granted when |
|---|---|
| `context`, `kv`, `flags`, `log`, `clock` | Always. |
| `http` | `egress` is non-empty; each call additionally matched against the host/method allowlist. |
| `db` | `data.tables` is non-empty; each statement additionally matched against the table allowlist. |
| `relay` | The bundle declares an `action` stage. |

A call to an ungranted capability returns `denied(...)` and increments `waddles_host_call_denied_total{app_id,capability}`; three denials within `EXECUTOR_TRIP_WINDOW_S` count as a sandbox trip (§7.5).

### 6.6 Executor wire protocol

A single TCP listener per stage, carrying mutual TLS: `:8301` on svc-process, `:8302` on svc-action (`HOST_API_PORT`). The **executor dials the stage**; the stage never dials the executor and exposes this port to nothing else. Both peers present certificates:

- **SPIFFE-ready:** where SPIRE is live, the peers use X.509-SVIDs and each verifies the other's SPIFFE ID (`spiffe://penguintech.io/<env>/svc-process` and `…/svc-process-executor`).
- **Otherwise:** chart-provisioned certificates from the same CA as §11.6.3, with the peer's Common Name pinned by configuration.

TLS 1.3 preferred, 1.2 minimum. A connection whose peer certificate does not verify, or whose identity is not the expected counterpart, is closed before a single frame is read, and increments `waddles_host_api_rejected_total{reason}`.

**Framing.** Every message is a 4-byte big-endian unsigned length followed by that many bytes of UTF-8 JSON, sent inside the TLS stream. A length greater than `EXECUTOR_MAX_FRAME_BYTES` (default `1048576`) is a fatal protocol error: the stage logs it and closes the connection, which the executor re-establishes. Frames are multiplexed by `id`; both sides may have many in flight. The executor holds `EXECUTOR_STAGE_CONNECTIONS` (default `4`) connections and spreads invocations across them.

**Common envelope.**

```json
{"v": 1, "id": 42, "kind": "<message kind>", "...": "..."}
```

`v` is always `1`. `id` is a monotonically increasing `u64` allocated by the sender of the initiating message; every reply reuses it.

**Executor → stage** (the executor dials, so it speaks first)

| `kind` | Fields | Reply |
|---|---|---|
| `hello` | `protocol_version` (int, `1`), `executor_version`, `wasmtime_version`, `wasmtime_abi`, `collector` (e.g. `drc`), `sandbox` (`{runtime: "gvisor"\|"runc", verified: bool}`) | `hello-ok` or `error` |
| `loaded` | `app_id`, `digest`, `precompile_ms`, `exports` (list of export names actually present) | none |
| `unloaded` | `app_id`, `digest` | none |
| `result` | `payload` (the export's return value as JSON), `duration_ms`, `fuel_used` (integer, `0` when fuel metering is off) | none |
| `host-call` | `app_id`, `capability` (`http`\|`kv`\|`db`\|`relay`\|`flags`\|`log`\|`clock`\|`context`), `op`, `args` (capability-specific JSON), `call_id` (the originating `invoke` id) | `host-result` |
| `error` | `code`, `message`, `detail` (nullable) | none |
| `pong` | — | none |

**Stage → executor**

| `kind` | Fields | Reply |
|---|---|---|
| `hello-ok` | `stage`, `protocol_version`, `limits` (`{call_timeout_ms, memory_mb, max_concurrent_calls}`) | none |
| `load` | `app_id`, `version`, `digest` (`sha256:<64 hex>`), `component_key` and `sidecar_key` (bucket object keys), `capabilities` (list), `limits` (`{timeout_ms, memory_mb}`) | `loaded` or `error` |
| `unload` | `app_id`, `digest` | `unloaded` or `error` |
| `invoke` | `app_id`, `digest`, `export` (`transform` \| `dispatch`), `payload` (the export's arguments as JSON), `deadline_ms`, `trace_context` | `result` or `error` |
| `host-result` | `result` (capability-specific JSON) or `error` (`{code, message}`) — replies to a `host-call` | none |
| `ping` | — | `pong` |
| `shutdown` | `grace_ms` | connection closed after in-flight calls drain or `grace_ms` elapses |

A `hello` reporting `runtime: "runc"` is refused with `error.code = "UNSANDBOXED_EXECUTOR"` unless the stage's own `WADDLES_SANDBOX_GVISOR` is also `false`; the two sides must agree on the posture, so a stage expecting gVisor never serves host calls to an executor that is not under it (§12.2).

**Error codes** (`error.code`, stable strings): `PROTOCOL_VERSION`, `FRAME_TOO_LARGE`, `MALFORMED_FRAME`, `UNKNOWN_BUNDLE`, `DIGEST_MISMATCH`, `LOAD_FAILED`, `EXPORT_MISSING`, `EXECUTOR_DEADLINE`, `MEMORY_LIMIT`, `WASM_TRAP`, `HOST_CALL_DENIED`, `HOST_CALL_FAILED`, `UNSANDBOXED_EXECUTOR`, `SHUTTING_DOWN`.

**Deadline ownership.** The stage sets `deadline_ms` on every `invoke` and also arms its own timer at `deadline_ms + 250 ms`. If the executor has not replied by then, the stage treats that connection as wedged, closes it (the executor reconnects and the wedged instance's in-flight work is abandoned), and DLQ's the event with `error.kind = "call_timeout"`. The executor's own epoch interruption is the first line; the stage's timer is the backstop, because a wedged executor cannot report its own deadline. A connection that wedges `EXECUTOR_WEDGE_THRESHOLD` (default `3`) times within `EXECUTOR_TRIP_WINDOW_S` causes the stage to stop scheduling onto that executor replica and to report it unready, which the Deployment's own liveness probe then restarts.

**Host-call deadlines.** A `host-call` does not extend the bundle's deadline. Time spent waiting for the stage counts against `deadline_ms`, so a bundle that makes a slow HTTP call runs out of budget rather than blocking an executor slot indefinitely.

### 6.7 Distribution API additions

`GET /api/v1/distribution/bundles?stage={process|action}` keeps its current response shape and adds six fields per row. Existing fields (`appId`, `communityId`, `entrypoint`, `spec`, `config`) are unchanged so the transition needs no versioning of the endpoint.

```json
{
  "bundles": [
    {
      "appId": "waddles.socials.music.default",
      "communityId": 42,
      "entrypoint": "bundles.social_music_process:transform",
      "spec": {"required_config": []},
      "config": {"command_prefix": "!"},

      "artifactVersion": "3.0.0",
      "artifactDigest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "artifactKind": "source",
      "language": "python",
      "scanStatus": "scanned",
      "manifest": {
        "egress": [{"host": "api.spotify.com", "methods": ["GET", "POST"]}],
        "data": {"tables": ["music_queue", "music_history"]},
        "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10}
      }
    }
  ]
}
```

| New field | Type | Values / constraint |
|---|---|---|
| `artifactVersion` | string | The manifest `version` of the active artifact. |
| `artifactDigest` | string | `sha256:` + 64 lowercase hex. The stage loads only this digest. |
| `artifactKind` | string | `source` or `prebuilt`. |
| `language` | string | `python`, `rust`, `javascript`, `typescript`, `other`. |
| `scanStatus` | string | `scanned` (all configured scanners ran clean), `scanned_with_findings` (ran, non-blocking findings recorded), `not_scanned` (prebuilt upload — the permanent badge), `scan_failed` (a scanner errored; the version is never activated). |
| `manifest` | object | The capability-bearing subset of `bundle.yaml` the stage must enforce: `egress`, `data.tables`, `limits`. The stage never fetches the full manifest separately. |

`entrypoint` is retained verbatim for provenance and for the admin UI; the Rust stages **do not** dispatch on it — dispatch is by WIT export. A row whose `artifactDigest` is `null` (a registration without a compiled artifact) is skipped by the stage and counted in `waddles_bundle_skipped_total{reason="no_artifact"}`.

**Polling behaviour is unchanged:** every `POLL_INTERVAL_S` (5.0 s), exponential backoff on failure (base 1.0 s, cap 60.0 s), and a hub-api outage degrades gracefully to the last-known-good bundle set rather than raising.

---

## 7. Host interface and executor

### 7.1 Deployment model

```
 Deployment: svc-process                  Deployment: svc-process-executor
 RuntimeClass: (cluster default)          RuntimeClass: runsc  (gVisor)
 ┌──────────────────────────────────┐     ┌──────────────────────────────────┐
 │ svc-process                      │     │ bundle-executor                  │
 │  holds: Valkey ACL creds,        │     │  holds: its client certificate,  │
 │    Postgres role creds, platform │     │    read-only bucket credentials  │
 │    creds, egress HTTP client,    │     │  holds NOTHING of the stage's    │
 │    secret resolution, OTel       │     │                                  │
 │  listens :8201 (service HTTP)    │     │  rootfs read-only                │
 │          :9090 (metrics)         │     │  emptyDir /scratch  (16 Mi)      │
 │          :8301 (host API, mTLS)  │◀────┤  emptyDir /var/cache/waddles/wasm│
 │                                  │mTLS │  caps: drop ALL                  │
 └──────────────────────────────────┘     │  allowPrivilegeEscalation: false │
                                          │  runAsNonRoot, uid 10001         │
   CiliumNetworkPolicy                    │  seccompProfile: RuntimeDefault  │
     executor ─▶ stage :8301   ALLOW      │  egress ─▶ bucket (GET only)     │
     executor ─▶ bucket        ALLOW      └──────────────────────────────────┘
     executor ─▶ anything else DENY
     anything  ─▶ executor     DENY (no ingress at all)
```

The executor is a **separate workload**, not a child process. gVisor (`runsc`) gives it a user-space kernel: every syscall the escaped native code makes is serviced by the sandbox, not the host kernel, so no host capability, user namespace or privileged mount is required — which matters because a feasibility spike proved bubblewrap cannot create namespaces inside our containers at all (§18, R3).

Three independent mechanisms make the executor credential-less in practice:

1. **Separate Deployment** — the stage's Secrets, ServiceAccount token and env are simply not mounted into the executor's pod. There is nothing to read.
2. **gVisor** — a native-code escape out of wasmtime lands in a user-space kernel, not on the node.
3. **Default-deny `CiliumNetworkPolicy`** — the only egress allowed is the stage's host-API port and the bucket; there is no ingress at all, so nothing in the cluster can reach the executor either.

The stage's `:8301`/`:8302` host-API listener is reachable only from the executor's pod selector; the same policy denies it to every other workload, so the capability-scoped API is not an internal side door.

### 7.2 Instance pool and concurrency

- One wasmtime `Engine` per executor process, configured with the component model, WASI 0.2, epoch interruption, and the pooling allocator.
- Per loaded bundle: `EXECUTOR_INSTANCES_PER_BUNDLE` (default `4`) pre-instantiated stores, checked out per call and reset afterwards. A call that finds the pool empty waits up to `EXECUTOR_POOL_WAIT_MS` (default `500`) and then fails with `HOST_CALL_FAILED`/`pool_exhausted`, which the stage treats as retryable and re-queues.
- Global ceiling: `EXECUTOR_MAX_CONCURRENT_CALLS` (default `32`) across all bundles.
- Every instance is **fresh per call** with respect to guest linear memory: no state survives between invocations. A bundle that needs state uses the `kv` or `db` capability. This is asserted by a test that sets a module-level counter in a guest and observes it reset.
- **Instances stay resident, and the precompiled artifact is what makes that affordable.** A Python component is large — the spike measured 21.6 MB — and round 2 measured the difference directly: **~4.5–5.4 ms to load a precompiled `.cwasm`, against 3.3–4.5 s uncached**, roughly three orders of magnitude. The executor therefore never instantiates from cold in the request path: it loads the `.cwasm` produced at `load` time and keeps `EXECUTOR_INSTANCES_PER_BUNDLE` stores warm. Warm call cost was 2–4 ms per `db` round trip through the WIT import, and the alias bundle's full write path (4 round trips) completed in 9–18 ms.
- **The precompile must use the same GC collector configuration as the runtime engine.** Round 2 found that a precompiled artifact produced under a different collector **fails to load** outright. `-C collector=drc` matched `componentize-py`'s output and is the pinned setting; the collector is part of the artifact's compatibility identity alongside the wasmtime version, so the cache key is `{digest}-{wasmtime_abi}-{collector}` and a mismatch on any component is discarded and recompiled rather than attempted. The executor asserts its own configuration at startup, alongside the sandbox check of §12.2: it reports `collector` in the `hello` frame, and a stage whose configured collector differs from the executor's refuses the connection with `PROTOCOL_VERSION` and an explicit message naming both values — a silently mismatched collector would otherwise surface as an unexplained load failure per bundle.

### 7.3 Limits

| Limit | Default | Per-bundle override | Hard ceiling | On breach |
|---|---|---|---|---|
| Wall-clock per call | `EXECUTOR_CALL_TIMEOUT_MS` = `2000` | `limits.timeout_ms` | `EXECUTOR_MAX_CALL_TIMEOUT_MS` = `10000` | epoch interrupt → `EXECUTOR_DEADLINE`, DLQ `call_timeout`, one trip |
| Linear memory | `EXECUTOR_MEMORY_LIMIT_MB` = `64` | `limits.memory_mb` | `EXECUTOR_MAX_MEMORY_LIMIT_MB` = `256` | allocation refused → guest trap, `MEMORY_LIMIT`, DLQ `memory_limit`, one trip |
| Egress rate | `EGRESS_RATE_LIMIT_RPS` = `10`, burst `20` | `limits.egress_rps` | `EGRESS_RATE_LIMIT_RPS` | `rate-limited(retry_after_ms)` returned to the guest, counter incremented; not a trip |
| Concurrent calls | `EXECUTOR_MAX_CONCURRENT_CALLS` = `32` | none | — | queued up to `EXECUTOR_POOL_WAIT_MS`, then retryable failure |
| Frame size | `EXECUTOR_MAX_FRAME_BYTES` = `1048576` | none | — | fatal protocol error; executor restarted |
| KV value size | `KV_MAX_VALUE_BYTES` = `65536` | none | — | `too-large` returned to the guest |
| KV TTL | `KV_MAX_TTL_S` = `2592000` (30 days) | none | — | clamped, logged at DEBUG |

A manifest value outside its hard ceiling fails validation V24 at install time — it is never silently clamped.

### 7.4 Host capability implementations (stage side)

| Capability | Implementation notes |
|---|---|
| `context` | Built once per `invoke` from the envelope the stage took off the key plus the 3-tier resolved config. Tenant and community come from the key, never from payload. |
| `http` | §8. |
| `kv` | Hash operations on `bundle_state_key(tenant, community, app_id)`; the guest's key is namespaced as `b:{key}` so a bundle cannot reach the stage's own fields. TTL applies to the whole hash via `HEXPIRE`-equivalent per-field expiry; where the deployed Valkey lacks per-field TTL the stage stores `{value, expires_at}` and filters on read. |
| `db` | The statement is parsed with a SQL parser (`sqlparser` crate) before execution; every referenced table must appear in `data.tables`, and any statement containing more than one top-level statement, a `COPY`, a `DO`, a `SET ROLE`, a `GRANT`, or a `CREATE`/`DROP`/`ALTER` is refused with `denied`. Execution then happens on a connection whose role is the bundle's own (`bundle_<app_id with dots and dashes replaced by underscores>`), with `SET LOCAL waddles.tenant`/`waddles.community` driving row-level-security policies on the bundle's tables. Two independent layers, deliberately: the parser catches mistakes, the role and RLS catch the parser being wrong. |
| `relay` | Validates `provider` against the compiled-in provider list (`twitch` today), then `LPUSH`es onto the provider-scoped relay key. Action-stage bundles only. |
| `flags` | `penguin-licensing`'s two-gate check with the bundle's Feature as the flag key. Fail-open to the supplied `default-value` on a flag-server outage, never an exception. |
| `log` | `fields-json` is sanitized with the `penguin-logging` `SENSITIVE_KEYS` rule before anything is emitted, then written at the requested level with `app_id`, `tenant`, `community` attached. A bundle cannot raise its own log level above the stage's configured `LOG_LEVEL`. |
| `clock` | Wall clock from the stage; monotonic from the stage's own `Instant`. The guest gets no other time source, which keeps timing side channels from being trivially precise. |

### 7.5 Sandbox trips and disabling

A **trip** is any of: a call deadline breach, a memory-limit breach, a guest trap, or the third `denied` host call within the window.

```
trips within EXECUTOR_TRIP_WINDOW_S (300 s), counted per (app_id, digest):
  1st  → WARN log, waddles_sandbox_trip_total{app_id,limit} +1, event to DLQ
  2nd  → WARN log, counter, event to DLQ
  3rd  → ERROR log, counter, event to DLQ,
         bundle marked DISABLED in this process,
         waddles_bundle_disabled{app_id} gauge = 1,
         every subsequent event for it goes straight to DLQ with
         error.kind = "bundle_disabled" (never silently dropped)
```

A disabled bundle is re-enabled when the pod observes a **new `artifactDigest`** for it from the distribution API, or when the pod restarts. There is no runtime re-enable switch (§19, Q1). Disabling is per-pod, not cluster-wide: one bad node does not take a bundle down everywhere, and the gauge makes partial disabling visible.

### 7.6 Bucket poller and hot-swap

The **stage** decides what should be loaded; the **executor** fetches and verifies it. The executor is the only one of the two with bucket access, and it is read-only.

Every `BUNDLE_POLL_INTERVAL_S` (default `60`), the stage:

1. Reads the current bundle set from the last distribution poll: a list of `(app_id, artifactVersion, artifactDigest, manifest)`.
2. For each digest not already reported `loaded` by an executor connection, sends `load` with the expected `digest`, `component_key` and `sidecar_key`.

On `load`, the executor:

3. `GET`s `bundles/{app_id}/{version}/{sha256}.json` (the sidecar) and `bundles/{app_id}/{version}/{sha256}.wasm`.
4. Verifies: the Ed25519 signature on the sidecar against `BUNDLE_SIGNING_PUBLIC_KEY`; the sidecar's `digest` equals the `digest` the stage sent (which is hub-api's recorded value); the SHA-256 of the fetched component bytes equals both. Any mismatch → `error.code = "DIGEST_MISMATCH"`, the previous version keeps serving, `waddles_bundle_digest_mismatch_total{app_id}` +1, ERROR log on both sides naming all three values (truncated to 12 hex characters in the message; the full values go to the log fields).
5. Precompiles with its pinned wasmtime into `EXECUTOR_PRECOMPILE_DIR` (`/var/cache/waddles/wasm`, an `emptyDir`), keyed by `{digest}-{wasmtime_abi}-{collector}` and produced with **the same GC collector configuration the runtime engine uses** (`-C collector=drc`, matching `componentize-py`'s output — a mismatch makes the artifact unloadable, §7.2). An artifact whose `wasmtime_abi` or `collector` does not match the running engine is discarded and recompiled, never loaded.
6. Replies `loaded`, at which point the stage atomically swaps the routing entry and then sends `unload` for the old digest **after** its in-flight calls have drained (bounded by `EXECUTOR_DRAIN_MS`, default `5000`).
7. Old components are retained in the bucket for audit; each executor keeps at most `BUNDLE_CACHE_VERSIONS` (default `3`) precompiled versions per `app_id` and evicts the oldest.

Passing the expected digest in `load` is load-bearing: the executor can reach the bucket, so the bucket alone must never decide what runs. The stage's digest comes from hub-api's DB, and the executor refuses anything else.

**Bucket outage.** Fetch failures never stop the pipeline: executors keep serving the digests they already hold, log at WARN, and the stage advances `waddles_bundle_stale_age_seconds{app_id}` — the age of the newest digest an executor has *successfully verified* versus the digest the distribution API is currently advertising. An operator alert fires at `> 900` seconds.

**Rollback** is a control-plane action only: hub-api flips the active digest on the `app_catalog` version row back to a prior version, and pods converge within one distribution poll plus one bucket poll (≤ 65 s).

---

## 8. Egress model

### 8.1 Declaration

```yaml
egress:
  - host: "api.spotify.com"
    methods: ["GET", "POST"]
  - host: "*.googleapis.com"          # methods omitted ⇒ all six
```

- `host` is a lowercase FQDN or a single-label wildcard (`*.example.com` matches `a.example.com`, not `a.b.example.com` and not `example.com` itself).
- `methods` defaults to `GET, HEAD, POST, PUT, PATCH, DELETE`.
- The list is exhaustive: a request to any other host is denied.

### 8.2 Enforcement order

Every `http.send` runs this sequence on the **stage** side. Each step that rejects returns `denied(reason)` or `rate-limited(ms)` to the guest and increments `waddles_egress_denied_total{app_id,reason}`.

| # | Check | Denial reason |
|---|---|---|
| 1 | Scheme is `https` | `scheme_not_https` |
| 2 | URL has no embedded credentials, no fragment-only target, and parses cleanly | `malformed_url` |
| 3 | Host matches an `egress[].host` entry | `host_not_declared` |
| 4 | Method is in that entry's `methods` | `method_not_declared` |
| 5 | Host is not on the tenant-level global denylist (refreshed from hub-api every `EGRESS_DENYLIST_REFRESH_S` = `60`; last-known-good on outage) | `host_denylisted` |
| 6 | DNS resolution yields no address in a forbidden range: loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`), unspecified, multicast, or the cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`) | `ssrf_blocked_address` |
| 7 | The connection is pinned to the resolved, checked address (no second resolution between check and connect) | `dns_rebind_blocked` |
| 8 | Per-bundle token bucket (`limits.egress_rps`, burst `EGRESS_RATE_LIMIT_BURST` = `20`) admits the call | *(returns `rate-limited`, not `denied`)* |
| 9 | TLS handshake completes at TLS 1.2 or better with a verified chain | `tls_verification_failed` |
| 10 | Redirects: at most `EGRESS_MAX_REDIRECTS` = `3`, and every hop re-runs steps 1–7 against the redirect target | `redirect_off_allowlist` |
| 11 | Response body within `EGRESS_MAX_RESPONSE_BYTES` = `1048576`; larger bodies are truncated and returned with `truncated: true` | *(not a denial)* |
| 12 | Total call within `EGRESS_TIMEOUT_MS` = `5000` | *(returns `timeout`)* |

### 8.3 Secrets by reference

A bundle never holds a secret value. It names one:

```python
headers = {}
secret_refs = {"Authorization": "SPOTIFY_BOT_TOKEN_REF"}
```

The `request.secret_refs` list maps a header name to a **secret reference name**. The stage resolves the reference the same way `waddle_transports.signing.resolve_secret` does today (an environment-variable *name* held in the activation config, resolved at call time), and injects the header immediately before sending. The resolved value:

- never crosses the WIT boundary,
- never appears in a log, span attribute or metric label (the sanitizer redacts it even if a bundle echoes it back),
- is dropped from the response the guest sees if the server reflects it.

An unresolvable reference returns `denied("secret_unresolved")` and is classified non-retryable.

### 8.4 Compiler and install-time checks

- The compiler rejects a manifest with an empty `egress` when the compiled component imports `waddle:bundle/http` (rule V22). The check is on the **component's actual import list**, not on the source text, so an undeclared import cannot slip through a dynamic call.
- The install UI shows the full `egress` list and the `data.tables` list on the approval screen; approving an install is approving those two lists.
- Changing `egress` or `data.tables` in a new version re-triggers approval; a version whose capability request is a strict subset of the approved one auto-approves.

---

## 9. Bundle lifecycle

### 9.1 State machine

```
                     ┌──────────────┐
   POST /versions    │              │
   (source tarball   │   UPLOADED   │
    or prebuilt) ───▶│              │
                     └──────┬───────┘
                            │ hub-api creates the compiler Job
                            v
                     ┌──────────────┐   manifest invalid (V1–V24)
                     │  VALIDATING  │──────────────────────────────▶ REJECTED
                     └──────┬───────┘                                (reason code,
                            │ manifest OK                             terminal)
                            v
        artifact=source     │      artifact=prebuilt
        ┌───────────────────┴───────────────────┐
        v                                       v
 ┌──────────────┐  blocking finding      ┌──────────────┐  WIT/import/size
 │   SCANNING   │───────────────────────▶│  INSPECTING  │  check fails
 │ SAST · deps  │        REJECTED        │ WIT conform. │───────────────▶ REJECTED
 │ secrets ·    │                        │ import list  │
 │ Skauswatch   │                        │ manifest·size│
 └──────┬───────┘                        └──────┬───────┘
        │ clean or non-blocking findings        │ ok
        v                                       │
 ┌──────────────┐  compile fails                │
 │  COMPILING   │──────────────────▶ REJECTED   │
 │ componentize │                               │
 └──────┬───────┘                               │
        │ component produced                    │
        └───────────────┬───────────────────────┘
                        v
                 ┌──────────────┐
                 │  ADDRESSING  │  sha256 over the component bytes
                 └──────┬───────┘
                        v
                 ┌──────────────┐  upload or signing fails
                 │  PUBLISHING  │──────────────────────────▶ REJECTED
                 │ bucket PUT + │
                 │ Ed25519 sign │
                 └──────┬───────┘
                        │ digest recorded on the app_catalog version row
                        v
                 ┌──────────────┐
                 │  PUBLISHED   │  visible in the catalog, not yet running
                 └──────┬───────┘
                        │ activation (app_activations / app_tenant_availability)
                        v
                 ┌──────────────┐  new version published for the same app_id
                 │    ACTIVE    │──────────────────────────────▶ SUPERSEDED
                 │ served by the│                                (artifact retained
                 │ distribution │                                 for audit)
                 │ API, loaded  │
                 │ by pods      │
                 └──┬────────┬──┘
                    │        │ three sandbox trips in EXECUTOR_TRIP_WINDOW_S
                    │        └────────────────────────▶ DISABLED (per pod)
                    │                                    events → DLQ
                    │ activation removed / disabled          │
                    v                                        │ new digest
              ┌──────────────┐                               │ or pod restart
              │ DEACTIVATED  │◀──────────────────────────────┘
              │ artifact kept│
              └──────────────┘
```

### 9.2 Install (hub-api)

`POST /api/v1/apps/{app_id}/versions`, multipart:

| Part | Content | Required |
|---|---|---|
| `manifest` | `bundle.yaml` (v2) | yes |
| `source` | `.tar.zst` source tarball, ≤ `BUNDLE_MAX_SOURCE_BYTES` = `16777216` (16 MiB) | when `artifact: source` |
| `component` | `.wasm` component, ≤ `BUNDLE_MAX_COMPONENT_BYTES` = `33554432` (32 MiB) | when `artifact: prebuilt` |

Responses: `202 Accepted` with a `versionId` and the compiler Job name; `400` with a `reason` code for a manifest that fails a pure-YAML rule; `403 prebuilt_not_allowed` when `artifact: prebuilt` and the global setting `bundles.allow_prebuilt` is false; `409` when `(app_id, version)` already exists; `413` on an oversize part.

`GET /api/v1/apps/{app_id}/versions/{version}` returns the state-machine state, the reason code on rejection, `scanStatus`, the scanner findings summary, and — once published — the digest.

### 9.3 Security check detail

**Source uploads (`artifact: source`)**, in the compiler's sandboxed phase 2:

| Check | Tool | Gate |
|---|---|---|
| Static analysis | `semgrep` with the WaddleBot ruleset | Any `ERROR`-severity finding blocks. |
| Dependency audit | `pip-audit` (Python), `cargo audit` (Rust), `npm audit` (JS/TS) | Any `high`/`critical` advisory blocks. |
| Secrets | `gitleaks detect` over the extracted tarball | Any finding blocks. |
| Malware / composite | Skauswatch, **when configured** (`SKAUSWATCH_URL` set) | A `fail` verdict blocks; `warn` records a finding. |
| Manifest ↔ source agreement | compiler | A declared `stages.<s>.entry` that does not resolve blocks. |
| Module pre-import (Python) | compiler | `pkgutil.walk_packages` over the bundle package, pre-importing every module so `componentize-py`'s static discovery does not miss a lazy import. A module that fails to import blocks, naming the module. |
| Legacy DAL imports (Python) | compiler | Any import of `flask_core.database` or `pydal`, anywhere in the bundle source, **blocks** with `reason: legacy_dal_import` and a message naming the module, the file and line, and the `penguin-dal` equivalent (D21b). |

Every scanner run reports **how many items it examined** (files scanned, dependencies audited, rules evaluated). A scanner that examined zero items is a **failure**, not a pass — the version is rejected with `reason: scan_empty_denominator`. No scanner invocation is wrapped in `|| true`.

**Prebuilt uploads (`artifact: prebuilt`)**, in phase 3:

| Check | Gate |
|---|---|
| Valid WASI 0.2 component, parses under the pinned wasmtime | blocks |
| Exports satisfy the WIT world for every declared script stage (V25) | blocks |
| Imports are a subset of the WIT world's imports plus the denying `wasi:sockets` stub set (V26), and the component instantiates against those stubs | blocks |
| Manifest checks V1–V24 | blocks |
| Size ≤ `BUNDLE_MAX_COMPONENT_BYTES` | blocks |
| Digest computed and recorded | — |

Result: `scanStatus: "not_scanned"`. That value is **permanent for the life of the version** and drives a "not security-scanned" badge everywhere the bundle is listed (marketplace, install screen, activation screen, admin bundle list). It is never upgraded by a later scan of a different artifact.

### 9.4 Publish

1. Compute `sha256` over the component bytes.
2. `PUT bundles/{app_id}/{version}/{sha256}.wasm`.
3. Build the sidecar and sign it with the deploy key (Ed25519, private half held only by the compiler Job's secret):

```json
{
  "schema_version": 1,
  "app_id": "waddles.socials.music.default",
  "version": "3.0.0",
  "digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "size_bytes": 2148231,
  "language": "python",
  "artifact_kind": "source",
  "scan_status": "scanned",
  "wit_world": "waddle:bundle/stage@1.0.0",
  "built_at": "2026-09-14T12:00:00.000Z",
  "builder": "bundle-compiler@1.0.0",
  "signature": "base64(ed25519 over the canonical JSON of every field above)"
}
```

4. `PUT bundles/{app_id}/{version}/{sha256}.json`.
5. `PATCH` the `app_catalog` version row with the digest, `scanStatus`, `language`, `artifactKind` — the DB write is the commit point. A bucket object with no DB row is unreferenced and is garbage-collected by a weekly hub-api job after `BUNDLE_ORPHAN_GRACE_H = 168`.

### 9.5 Activation and rollout

Activation is unchanged: a row in `app_activations` (community-scoped) or `app_tenant_availability` (tenant-wide), with the same 3-tier config precedence. What changes is that the distribution API now also hands the pod the digest and the capability-bearing manifest subset, so a pod can go from "this bundle is activated" to "this exact artifact is loaded" without a second lookup.

Convergence bound after an activation or a rollback: one distribution poll (≤ 5 s) + one bucket poll (≤ 60 s) = **≤ 65 seconds**.

---

## 10. Ingest intake

### 10.1 Endpoint table

All routes are on `:8200`. `INTAKE_MAX_BODY_BYTES` = `262144` (256 KiB) applies to every POST. Every rejection increments `waddles_intake_rejected_total{source,reason}`.

| Method + path | Auth | Required headers | Limits | Success | Error codes |
|---|---|---|---|---|---|
| `POST /eventsub/twitch/webhook` | HMAC-SHA256 hex over `id + timestamp + body`, prefixed `sha256=`, constant-time compare | `Twitch-Eventsub-Message-Signature`, `-Timestamp`, `-Id`, `-Type` | 256 KiB body; 600 s timestamp window (Twitch's own); per-source bucket 20/40 | `200` — and for `webhook_callback_verification`, the bare `challenge` string echoed as `text/plain`, not JSON | `400 malformed_body`, `401 bad_signature`, `403 replay_window`, `409 duplicate_message_id`, `413 body_too_large`, `429 rate_limited` (+ `Retry-After: 1`), `503 secret_unset`. Route is **not registered at all** when `TWITCH_EVENTSUB_SECRET` is unset. |
| `POST /webhook/kick` | HMAC-SHA256 hex over the raw body; fail-closed on a missing or empty signature | `X-Kick-Signature` | 256 KiB; per-source bucket 20/40 | `200` | `400`, `401 bad_signature`, `413`, `429`, `503 secret_unset` (route always mounted) |
| `POST /intake/webhook/{tenant}/{source}` | Per-source HMAC-SHA256 hex over `{timestamp}.{raw_body}`, secret fetched from hub-api and cached 60 s | `X-Waddles-Signature: sha256=<hex>`, `X-Waddles-Timestamp: <unix seconds>`; optional `X-Waddles-Delivery-Id` | 256 KiB; `INTAKE_REPLAY_WINDOW_S` = 300 s; per-source bucket 20/40; per-tenant bucket 100/200 | `202 Accepted` with `{"accepted": true, "events": <n>}` | `400 malformed_body`, `401 bad_signature`, `403 replay_window`, `404 unknown_source`, `409 duplicate_delivery_id`, `413`, `422 mapping_failed`, `429`, `503 source_disabled` |
| `POST /intake/events` | hub-api-issued JWT, `Authorization: Bearer <jwt>`, scope `intake:write`, mandatory `tenant` claim | `Authorization`, `Content-Type: application/json` | 256 KiB; per-tenant bucket 100/200 | `202 Accepted` with `{"accepted": true, "events": 1}` | `400 malformed_body`, `401 invalid_token`, `403 missing_scope` / `tenant_mismatch` / `platform_not_registered`, `413`, `422 envelope_invalid`, `429` |
| `GET /health` | none | — | — | `200` with the body of §11.6.4 | `503` when not ready |
| `GET /healthz` | none | — | — | `200 ok` | — |
| `GET /metrics` | none (cluster-internal, `:9090`) | — | — | `200` Prometheus text | — |

`Retry-After: 1` accompanies every `429`. Duplicate-suppression (`409`) uses a Valkey set `waddles:intake:seen:{source}` with a `INTAKE_DEDUPE_TTL_S = 900` expiry, keyed by the platform's own message id or `X-Waddles-Delivery-Id`.

### 10.2 Fixed platform inputs

Ported with today's exact authentication and lifecycle behaviour (`core/svc_ingest/receivers/*.py`, `eventsub.py`, `bundles/kick_ingest.py`):

| Input | Mechanism | Credential | Lease |
|---|---|---|---|
| Twitch EventSub **webhook** | Inbound HTTP, HMAC as above | `TWITCH_EVENTSUB_SECRET` | n/a |
| Twitch EventSub **websocket** | Outbound WS to Twitch, per tenant; **alternative to the webhook, mutually exclusive** — selected by `TWITCH_EVENTSUB_MODE` | `TWITCH_BOT_TOKEN_REF` | single-owner |
| Twitch IRC | One TCP/TLS connection per channel | `TWITCH_BOT_TOKEN_REF` | single-owner, per `(provider, community)` |
| Discord gateway | One gateway connection | `DISCORD_BOT_TOKEN` | single-owner, `PLATFORM_COMMUNITY` |
| Slack Socket Mode | One WS | `SLACK_APP_TOKEN` (`xapp-`) + `SLACK_BOT_TOKEN` (`xoxb-`) | single-owner |
| YouTube Live | Data API v3 poll per channel, with the existing no-broadcast and quota backoff | API key or OAuth2 refresh trio | single-owner |
| Kick Pusher | One WS per channel slug | public Pusher app key | single-owner |
| Kick webhook | Inbound HTTP, HMAC, fail-closed | `KICK_WEBHOOK_SECRET` | n/a |
| Twitch outbound relay | Blocking pop on a dedicated connection (§5.5) | `TWITCH_BOT_TOKEN_REF` | single-owner, `PLATFORM_COMMUNITY` |

**Leases.** The single-owner lease is the existing `SET NX PX` mechanism from `core/svc_ingest/socket_lease.py`, ported to `penguin-spine`: key `waddles:lease:{provider}:{community}`, TTL `SOCKET_LEASE_TTL_MS` = `30000`, renewed every `SOCKET_LEASE_RENEW_MS` = `10000`, released on graceful shutdown. Losing the lease stops the receiver within one renewal interval. The supervisor restarts an exited receiver with exponential backoff (base 1 s, cap 60 s), unchanged.

### 10.3 Generic webhook intake and its mapping

A **source** is a per-tenant record held by hub-api: `{tenant, source, platform, secret_ref, community, mapping, enabled}`. `platform` must be one of the tenant's registered custom platforms (see §10.4). The mapping is declarative JSON — no expressions, no code:

```json
{
  "event_type": {"pointer": "/type", "default": "custom.event"},
  "actor":      {"pointer": "/user/id"},
  "occurred_at": {"pointer": "/created_at", "default": "$now"},
  "community":  {"pointer": "/channel/id"},
  "payload": {
    "text":       {"pointer": "/message/text"},
    "channel_id": {"pointer": "/channel/id"},
    "message_id": {"pointer": "/id"}
  }
}
```

| Rule | Behaviour |
|---|---|
| `pointer` | RFC 6901 JSON Pointer against the request body. |
| Missing pointer target | Use `default` if present; otherwise `422 mapping_failed` with the failing field named. |
| `"$now"` | The only allowed magic default; resolves to the stage's current RFC 3339 UTC millisecond timestamp. |
| Scalar to string | JSON numbers and booleans targeting a string field are rendered in their JSON text form. Objects and arrays targeting a string field are a `422`. |
| `payload.*` | Values keep their JSON type; the assembled `payload` is always a JSON object. |
| `community` | Resolves the envelope's community. Absent ⇒ the source's configured `community`; that absent too ⇒ tenant-wide (`None`). |
| `platform` | Never taken from the body — always the source record's `platform`. |

The resulting `PlatformEvent` is validated against §6.1 before anything is enqueued; a mapping that produces an invalid event is a `422`, never a DLQ entry.

### 10.4 Generic REST intake

`POST /intake/events` takes a **strict `PlatformEvent`** as its body — the exact shape of §6.1.1, no mapping layer. The caller's JWT is issued by hub-api, carries scope `intake:write` and a mandatory `tenant` claim, and is verified for `iss`, `aud`, `exp` and `scope`. A token without a `tenant` claim is rejected, never defaulted.

`platform` is restricted to the platforms registered for that tenant (`custom_platforms` rows in hub-api). A caller attempting `platform: "twitch"` through this route gets `403 platform_not_registered` — the built-in platforms are reachable only through their own authenticated connectors, so a REST caller cannot forge a Twitch event.

Optional query parameter `community=<slug>` sets the envelope community; absent ⇒ tenant-wide.

### 10.5 Common intake behaviour

- **Rate limiting** is a token bucket at two levels, per source and per tenant, with the defaults in §4.1. Exhaustion returns `429` with `Retry-After: 1` and increments `waddles_intake_rejected_total{source,reason="rate_limited"}`. Signature verification happens **after** the rate-limit check, so an unauthenticated caller cannot make the pod hash unbounded bodies.
- **Body caps** are enforced while reading, streaming-wise: the reader aborts at `INTAKE_MAX_BODY_BYTES + 1` bytes rather than buffering the whole oversize body.
- **Constant-time comparison** (`subtle::ConstantTimeEq`) for every signature check; a length mismatch still performs the comparison.
- **Activation resolution** is via the distribution API for every route, so per-community activation is honoured uniformly (§15.3).
- **Rejection metrics** carry `reason` values drawn from the error-code column of §10.1, so a dashboard can distinguish a misconfigured sender from an attack.

---

## 11. Security model

### 11.1 Threat model

**Primary adversary:** a malicious or merely buggy app bundle. Bundles may be written by anyone — first-party, marketplace vendor, or a community member — and after this design there is no execution tier that skips the sandbox (D8).

**The governing assumption:** *the WASM sandbox will eventually be escaped.* wasmtime is well engineered, but a single CVE in the runtime, or a logic bug in a host implementation, is enough. The design is therefore built so that **an escape from WASM reaches nothing but the mTLS host-API port and the artifact bucket**: the executor workload holds none of the stage's credentials, runs on a user-space kernel (gVisor), and is confined by a default-deny network policy whose only two allowed destinations are the stage's capability-scoped host API — which authorizes every request against the escaped bundle's own manifest — and read-only bucket `GET`s.

| Threat | Mitigation | Residual risk |
|---|---|---|
| Bundle reads another tenant's data | `db` statements run under the bundle's own Postgres role with RLS bound to the envelope's tenant/community, which come only from the Valkey key. Table allowlist checked twice (parser + role grants). | A bug in the RLS policy for a bundle-owned table. Mitigated by the policy being generated, not hand-written, and by a test per table. |
| Bundle exfiltrates data to an attacker host | Declared-egress allowlist + SSRF rules + tenant denylist + install-time approval of the list. | A bundle exfiltrating through an approved host (e.g. posting to its own legitimate API). Accepted: approving an egress host is approving that reach. |
| Bundle steals a platform token | Tokens never cross the WIT boundary; the stage injects them by reference after the guest's request is authorized. | A bundle inducing the stage to send a token to an approved-but-hostile host. Same accepted risk as above. |
| Bundle escapes WASM | The executor is a separate, credential-less Deployment under gVisor (`runsc`), rootless, all capabilities dropped, read-only rootfs, `RuntimeDefault` seccomp, default-deny NetworkPolicy with two allowed destinations and no ingress. | A gVisor sentry escape (a smaller and better-audited surface than the host kernel's full syscall table, but not zero). Mitigated further by dropped capabilities, non-root, and the network policy; not eliminated. |
| Bundle exhausts the pod | Per-call epoch deadline, memory cap, instance-pool ceiling, three-strike disable. | A bundle that is slow but under the deadline on every call. Visible in `waddles_executor_call_seconds`. |
| Malicious bundle **at build time** (`componentize-py` executes module-level code) | The compiler Job runs under the same gVisor `RuntimeClass`, with a network policy allowing only the bucket and the hub-api callback, and with the bucket/signing credentials unread until the phase that no longer runs bundle code. | A compiler-toolchain vulnerability. Mitigated by pinned toolchains with checksums. |
| Supply-chain: a hostile artifact swapped in the bucket | Content addressing + Ed25519 sidecar signature + digest cross-check against hub-api's DB; refuse on mismatch, keep the old version. | Compromise of both the DB and the signing key. |
| Forged inbound events | Per-platform signature verification, per-source HMAC with a replay window, JWT with a mandatory tenant claim, built-in platforms unreachable through the generic REST route. | A leaked per-source secret. Mitigated by rotation and by the secret never leaving hub-api's store. |
| Prompt/config injection through event payload | Tenant and community are never read from payload; `_target_app_id` changes only the destination key's `app_id` segment. | None structural; enforced by test. |

### 11.2 Sandbox layers

Defence in depth, outermost first. Every layer is independently testable and each has a negative test in §14.6.

| # | Layer | What it stops |
|---|---|---|
| 1 | **Workload separation** — the executor is its own Deployment, so the stage's Secrets, ServiceAccount token and environment are never mounted anywhere the bundle runs | Reading the stage's credentials at all, by any means |
| 2 | **Kubernetes pod security** — `runAsNonRoot: true`, `runAsUser: 10001`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, read-only root filesystem, Pod Security Admission `restricted` | Privilege escalation toward the node |
| 3 | **gVisor `RuntimeClass` (`runsc`)** — syscalls are serviced by a user-space kernel, verified at startup (§12.2). **The one layer an operator may switch off** (`sandbox.gvisor.enabled: false`), visibly and deliberately, trading it for per-call latency | A native-code escape reaching the host kernel's syscall surface |
| 4 | **Default-deny `CiliumNetworkPolicy`** — egress only to the stage's host-API port and the bucket; **no ingress at all** | An escape reaching Valkey, Postgres, the platform APIs, the cluster, or the internet; and anything in the cluster reaching the executor |
| 5 | **mTLS on the host API** — SPIFFE X.509-SVIDs where SPIRE is live, chart-provisioned certificates otherwise, peer identity pinned | An unauthenticated or impersonating client using the capability API |
| 6 | **WASM component isolation** — wasmtime, component model, no `wasi:sockets`, no `wasi:filesystem` beyond a read-only empty `/scratch`, no `wasi:cli/environment` | The guest reaching anything the host did not hand it |
| 7 | **Capability scoping** — grants computed from the manifest, enforced on the stage side | A guest calling a capability its manifest never requested |
| 8 | **Per-call resource limits** — epoch deadline, memory cap, pool ceiling | Denial of service against the pipeline |
| 9 | **Three-strike disable** — trips counted per `(app_id, digest)` over a 300 s window | A bundle repeatedly tripping limits and degrading the stage |

### 11.3 What an escape can and cannot reach

| Reachable from a fully escaped executor | Not reachable |
|---|---|
| The executor's own memory (the bundle's own data) | The stage's environment, Secrets or ServiceAccount token — none are mounted in this pod |
| Its own read-only rootfs, its 16 Mi `/scratch` `emptyDir`, and the precompiled component cache | Valkey, Postgres, the platform APIs, the internet — the NetworkPolicy denies every destination but two |
| The stage's mTLS host-API port, where every request is authorized against the escaped bundle's own manifest | Platform tokens, DB passwords, Valkey ACL credentials, the bucket **write** key — none are in this pod |
| Read-only `GET`s against the artifact bucket | Another bundle's manifest, config, KV namespace or tables — the stage authorizes per `app_id` |
| The gVisor sentry's user-space syscall surface | The host kernel's syscall surface, the node filesystem, other pods, the kubelet |

The worst outcome of a full escape is therefore: the attacker can issue exactly the host calls the escaped bundle was already entitled to issue, at the rate limits that bundle already had, plus read the artifact bucket's already-public-to-the-cluster components. That is the design's central claim, and §14.6's tests assert each half of it.

**With `sandbox.gvisor.enabled: false`,** the last row of that table changes: an escape faces the host kernel's syscall surface, filtered by `RuntimeDefault` seccomp and with all capabilities dropped, instead of the sentry's. Every other row is unchanged — the credential absence and the network policy, which carry most of the claim, do not depend on gVisor.

### 11.4 Egress

See §8. Summarized as a security property: no bundle reaches the network except through a stage-side client that checks scheme, declared host, declared method, tenant denylist, resolved-address SSRF rules, DNS-rebind pinning, rate limit, TLS 1.2+ with verification, redirect re-checking, response size and total timeout — in that order, with a metric on every denial.

### 11.5 Secrets

- **Never in a distributed artifact.** No bundle component, no image layer, no chart default contains a secret value.
- **Env-var-name indirection**, unchanged from `waddle_transports.signing.resolve_secret`: activation config carries `*_token_ref`, naming an environment variable the **stage** reads at call time.
- **Never on a CLI flag.** Every service reads secrets from environment variables or files only (`clap` config mirrors `core/svc_streaming/src/config.rs`).
- **Never logged.** `penguin-logging` sanitizes the `SENSITIVE_KEYS` set by exact key and substring at every level, DEBUG included; a token that somehow reaches a log field is rendered `[REDACTED]`.
- **Never in a span attribute, metric label or DLQ record.** DLQ records carry the raw envelope, which by contract contains no secrets; the sanitizer runs over the record before it is written.
- **The signing key's private half** exists only in the compiler Job's mounted secret; the data-plane pods hold only `BUNDLE_SIGNING_PUBLIC_KEY`.
- **The executor holds no stage secret at all** — only its own mTLS client certificate and a read-only bucket credential. Secret resolution happens exclusively on the stage side of the host API.

### 11.6 Transport security

**Default on, everywhere. The opt-out is a normal chart value in every environment, and it is loud.**

#### 11.6.1 Valkey

| Property | Requirement |
|---|---|
| Scheme | `rediss://` (the wire protocol's own scheme name) with TLS 1.2 minimum, 1.3 preferred |
| Certificate verification | Full chain verification against `VALKEY_CA_FILE`; hostname verified |
| Authentication | One ACL user per service — `svc-ingest`, `svc-process`, `svc-action`, `svc-streaming`, `hub-api` — each limited to the commands it uses and to key patterns it owns |
| Password | From a Kubernetes Secret via `VALKEY_PASSWORD` / `VALKEY_PASSWORD_FILE`; never a CLI flag, never in the URL that gets logged |
| Executor | **No Valkey access at all** — no URL, no credential, and the NetworkPolicy denies the route |
| Startup | With `security.transport.tls` true, a `redis://` URL is refused at startup with a named error; with `security.transport.auth` true, a URL without a username or password is refused |

ACL sketch (rendered by the chart into the Valkey ACL file):

```
user svc-ingest   on >$(PASS_INGEST)   ~waddles:t:*  ~waddles:proc:idx:*  ~waddles:consumers:*  ~waddles:deliv:*  ~waddles:dlq:*  ~waddles:lease:*  ~waddles:intake:*  +@read +@write +@list +@set +@sortedset +@hash +@string +eval +evalsha -@admin -@dangerous
user svc-process  on >$(PASS_PROCESS)  (same patterns)  (same commands)
user svc-action   on >$(PASS_ACTION)   (same patterns)  (same commands)
user svc-streaming on >$(PASS_STREAM)  ~waddles:streaming:*  +@read +@write +@string +@hash -@admin -@dangerous
```

#### 11.6.2 Postgres

| Property | Requirement |
|---|---|
| TLS | `sslmode=verify-full` against a chart-provisioned CA (`DB_SSLROOTCERT`) |
| Roles | One role per service (`svc_ingest` has none — ingest has no DB; `svc_process`, `svc_action`, `svc_streaming`, `hub_api`), plus one role per bundle (`bundle_<app_id_underscored>`) granted only its `data.tables` |
| Auth | Password from a Secret, or client-certificate auth where the chart provisions per-service certificates |
| Startup | With `security.transport.tls` true, `sslmode` below `verify-full` is refused; with `security.transport.auth` true, a DSN with no password and no client certificate is refused |

Per-bundle roles are created and their grants updated by hub-api at version approval time, over a privileged migration connection; the role is dropped when the last activation of the `app_id` is removed and a `BUNDLE_ROLE_GRACE_H = 168` grace has elapsed.

#### 11.6.3 CA and certificate provisioning

The chart provisions everything needed for the defaults to work out of the box:

- cert-manager `Certificate` resources when cert-manager is present in the cluster (`security.transport.certManager: true`, auto-detected and overridable);
- otherwise a chart-managed CA: a self-signed CA Secret created on first install and reused on upgrade, issuing server certificates for Valkey and Postgres and client certificates where used;
- the CA bundle is mounted into every service, including hub-api, which receives the same URLs and CA path as the Rust services.

#### 11.6.4 The opt-out (D20)

```yaml
security:
  transport:
    tls: true      # default
    auth: true     # default
```

Both are ordinary values, settable in `alpha.yml`, `beta.yml`, `gamma.yml` and `production.yml` alike. **No environment's values file rejects a `false`.** When either is `false`, every affected service, on **every** startup:

1. Logs at WARN, as its first log line after telemetry init:
   `TRANSPORT SECURITY DISABLED — security.transport.tls=false: Valkey and Postgres traffic is unencrypted and readable on the network. This is an explicit, visible opt-out.` (and the matching `auth=false` wording for authentication).
2. Sets the gauge `waddles_insecure_transport{component="valkey"|"postgres",aspect="tls"|"auth"}` to `1`. The gauge is `0` for every component/aspect that is secured, so "no series" and "secure" are distinguishable.
3. Reports it on `/health`:

```json
{
  "status": "ok",
  "service": "svc-process",
  "version": "3.0.0",
  "transport": "insecure",
  "transport_detail": {"valkey": {"tls": false, "auth": true},
                       "postgres": {"tls": true, "auth": true}},
  "sandbox": "gvisor",
  "executor": {"state": "running", "connections": 4, "bundles_loaded": 7},
  "spine": {"stage": "process", "consumer_id": "svc-process-7d9c4f"}
}
```

`transport` is `"secure"` only when every component/aspect is on; otherwise `"insecure"`. The README-facing wording is fixed: **enabled by default; the opt-out is explicit and visible.**

### 11.7 Digest and signature verification

Three values must agree before a component is loaded: the digest hub-api recorded on the `app_catalog` version row (served as `artifactDigest`), the `digest` field of the signed bucket sidecar, and the SHA-256 the pod computes over the fetched component bytes. The sidecar's signature is verified with `BUNDLE_SIGNING_PUBLIC_KEY` before its `digest` field is trusted. Any disagreement:

- refuses the load (the pod keeps serving the previously verified digest),
- increments `waddles_bundle_digest_mismatch_total{app_id}`,
- logs at ERROR with all three values in structured fields,
- never falls back to "load it anyway".

### 11.8 Tenant isolation and PII

- Every envelope's tenant and community come from the Valkey key it was taken from, never from its payload. The `_target_app_id` escape hatch changes only the `app_id` segment of the destination key.
- Bundle `db` access is RLS-scoped to the envelope's tenant and community; a statement touching a table outside `data.tables` is refused before it reaches Postgres.
- PII tokenization is unchanged: the single `users` identity table is never in any bundle's `data.tables` (rule V23 makes it a reserved name), and bundle-owned tables reference platform-opaque identifiers, exactly as `docs/APP_BUNDLE_AUTHORING.md` §5's worked example already requires.
- Intake routes never accept a tenant from the body: the webhook route takes it from the path and validates it against the source record; the REST route takes it from the JWT claim.

### 11.9 Service identity

Every service reserves and accepts a SPIFFE identity under `spiffe://penguintech.io/<env>/<service>` — `svc-ingest`, `svc-process`, `svc-action`, `svc-streaming`, `bundle-compiler` — and is built SPIFFE-ready (accepts an mTLS X.509-SVID as a first-class identity) whether or not SPIRE is deployed in a given environment. Where SPIRE is not live, inter-service calls use short-lived (≤ 1 h) signed OIDC machine JWTs, including the stage→hub-api distribution poll, which continues to use the existing `distribution:read`-scoped service JWT.

---

## 12. Deployment

### 12.1 Images

One rootless image per service, all multi-stage, all digest-pinned bases, all non-root at `uid 10001`.

| Image | Build | Runtime contents |
|---|---|---|
| `ghcr.io/penguintechinc/waddlebot/svc-ingest` | `rust:1.97-slim-bookworm` builder → `debian:bookworm-slim` runtime | `svc-ingest` binary, CA bundle |
| `ghcr.io/penguintechinc/waddlebot/svc-process` | same | `svc-process` binary, CA bundle |
| `ghcr.io/penguintechinc/waddlebot/svc-action` | same | `svc-action` binary, CA bundle |
| `ghcr.io/penguintechinc/waddlebot/bundle-executor` | same | `bundle-executor` binary, CA bundle — its own image, deployed once per stage |
| `ghcr.io/penguintechinc/waddlebot/svc-streaming` | same (`Dockerfile`, renamed from `Dockerfile.rust`) | `svc-streaming` binary, `ffmpeg` |
| `ghcr.io/penguintechinc/waddlebot/bundle-compiler` | same builder, plus the Tier 1 toolchains | `bundle-compiler`, `componentize-py`, `cargo`+`wasm32-wasip2`, `componentize-js` |

**Vendored tool pinning.** `wasmtime` and the Tier 1 toolchains are fetched at exact versions with SHA-256 verification in the builder stage, never from a distribution's rolling package. The versions live in one place, `build/tool-versions.env`, and are asserted by a container structure test (`bundle-executor --print-wasmtime-version`). No image contains `bwrap`: sandboxing is the node runtime's job now, not a binary we ship.

**Health checks** are binary sub-commands, never `curl`: `svc-process --healthcheck` exits `0` when `/health` would return `200`; `bundle-executor --healthcheck` exits `0` when it holds at least one live stage connection. Matches `core/svc_streaming/Dockerfile.rust`.

### 12.2 Sandbox runtime requirement

The executor and compiler pods run under a gVisor `RuntimeClass` **by default**, and gVisor is a first-class, documented opt-out for operators who would rather have the latency back.

```yaml
sandbox:
  gvisor:
    enabled: true              # default; mirrored by WADDLES_SANDBOX_GVISOR
  runtimeClassName: runsc      # gvisor on GKE Sandbox
```

`sandbox.gvisor.enabled` is mirrored into the executor and compiler containers as `WADDLES_SANDBOX_GVISOR` (`true`/`false`, default `true`), which both binaries read at startup, before accepting or issuing a single frame.

**`WADDLES_SANDBOX_GVISOR=true` (default).** The pod carries `runtimeClassName`, and the binary verifies it really is inside gVisor:

- read `/proc/version`, which under gVisor reports a gVisor kernel string rather than the node's kernel;
- corroborate with the gVisor-specific markers in `/proc/self/status` (gVisor omits several fields a Linux kernel always emits; the sentry's set is stable per pinned `runsc` version);
- both agree → proceed, set `waddles_sandbox_gvisor{enabled="true"}` to `1`, report `sandbox: "gvisor"` on `/health` and `sandbox: {runtime: "gvisor", verified: true}` in the `hello` frame;
- either check fails → log at ERROR naming the expected `RuntimeClass` and what `/proc/version` actually reported, then **exit 78** (`EX_CONFIG`). The pod crash-loops rather than pretending, and the stage independently refuses the connection with `UNSANDBOXED_EXECUTOR`.

**`WADDLES_SANDBOX_GVISOR=false` (explicit opt-out).** The chart omits `runtimeClassName`, so the pods run under the cluster's default runtime. Everything else is unchanged: still its own pod, still rootless at `uid 10001`, still `allowPrivilegeEscalation: false`, all capabilities dropped, read-only rootfs, `RuntimeDefault` seccomp, `automountServiceAccountToken: false`, still the same default-deny `CiliumNetworkPolicy` with two egress destinations and no ingress, and the WASM sandbox itself is untouched. The binary then:

- logs a loud WARN at **every** startup: `GVISOR SANDBOX DISABLED — WADDLES_SANDBOX_GVISOR=false: bundle code runs on the host kernel's syscall surface. One defence-in-depth layer is removed in exchange for lower per-call latency. This is an explicit, visible opt-out.`
- sets `waddles_sandbox_gvisor{enabled="false"}` to `1` (and the `enabled="true"` series to `0`, so "off" and "not reporting" are distinguishable);
- reports `sandbox: "runc"` on `/health` and `sandbox: {runtime: "runc", verified: false}` in the `hello` frame;
- proceeds. The stage accepts the connection because the same value is set on its side; a mismatch between the two (executor says `runc`, stage expects `gvisor`) is still refused with `UNSANDBOXED_EXECUTOR`.

**The trade-off, stated once for the README and `values.yaml`:** running without gVisor removes one defence-in-depth layer — a native-code escape from wasmtime then faces the host kernel instead of a user-space one — in exchange for lower per-call executor latency; the measured figure for our workload comes from the M2 benchmark (§16, §18 R8), not from a vendor number.

**No silent change of posture is possible:** whichever way the value is set, it is visible in a startup log line, a gauge, a `/health` field and every `hello` frame — and with gVisor requested but absent, the pod fails closed.

#### 12.2.1 Distribution support matrix

The sandbox must work on most Kubernetes distributions, not only ours.

| Distribution | How gVisor is obtained | Notes |
|---|---|---|
| **MicroK8s** (alpha) | `microk8s enable gvisor` | Registers the `runsc` handler and a `RuntimeClass`; the chart's default `runtimeClassName` matches. |
| **k3s** | Install `runsc` + `containerd-shim-runsc-v1` on each node, add a containerd config **template** (`/var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl`) registering the handler, restart k3s, then create the `RuntimeClass`. | k3s regenerates `config.toml` on restart, so the template — not the generated file — is what must be edited. |
| **minikube** | `minikube start --container-runtime=containerd` then `minikube addons enable gvisor` | Requires the containerd runtime; the Docker runtime is unsupported. |
| **kubeadm / upstream CNCF** | Install `runsc` on nodes, register the containerd handler, create the `RuntimeClass` — or enable `sandbox.installer` below. | The general case the installer exists for. |
| **GKE** | GKE Sandbox (node pool with `--sandbox type=gvisor`); `RuntimeClass` is `gvisor`. | Set `sandbox.runtimeClassName: gvisor`. Native support, no installer. |
| **DOKS / EKS / AKS** | No native offering; use `sandbox.installer.enabled: true`, or a pre-baked node image. | DigitalOcean node compatibility is an explicit early verification task (§16 M1, §18 R3). |
| **Docker Desktop Kubernetes** | Unsupported — no `runsc` handler is installable. | Set `sandbox.gvisor.enabled: false` (§12.2); every other sandbox layer stays on. |

#### 12.2.2 Optional installer DaemonSet

`sandbox.installer.enabled` (default `false`) deploys a node installer for clusters with no native offering:

1. Downloads a **pinned** `runsc` and `containerd-shim-runsc-v1` (exact version plus SHA-256, from the official gVisor release bucket) and verifies both checksums before installing.
2. Installs them into `/usr/local/bin` on the node.
3. Patches the node's containerd configuration to register the `runsc` handler, idempotently (a re-run over an already-patched node changes nothing).
4. Restarts containerd.
5. Labels the node `waddles.io/gvisor=ready`.

When the installer is enabled, the executor and compiler workloads carry `nodeSelector: {waddles.io/gvisor: "ready"}`, so they schedule only where the handler actually exists.

```yaml
# ROOT EXCEPTION (approved) — sandbox installer only.
# Installing a container-runtime handler requires writing to the node
# filesystem and restarting containerd, which is not achievable rootless.
# Scope: this DaemonSet alone, default DISABLED (sandbox.installer.enabled:
# false). No other WaddleBot workload runs privileged or as root; the
# executor it installs support for is itself rootless with all capabilities
# dropped. Approved by the human product owner, 2026-09-14.
sandbox:
  installer:
    enabled: false
    runscVersion: ""      # gVisor release id, from build/tool-versions.env
    runscSha256: ""       # SHA-256 of the runsc binary
    shimSha256: ""        # SHA-256 of containerd-shim-runsc-v1
    nodeLabel: "waddles.io/gvisor=ready"
```

The version and both digests are set from `build/tool-versions.env` at chart-render time, alongside the wasmtime pin. **An empty or mismatching digest is a hard failure**: the installer exits non-zero and the node is never labelled, rather than fetching whatever is current. A `helm template` test asserts that enabling the installer with empty pins fails rendering.

### 12.3 Chart values

Existing keys keep their names and defaults. New keys:

| Key | Default | Meaning |
|---|---|---|
| `pipeline.svcIngest.image` / `.svcProcess.image` / `.svcAction.image` / `.svcStreaming.image` | `ghcr.io/penguintechinc/waddlebot/<service>:<tag>` | Replaces the `pipeline.pythonBaseImage` placeholder the three stage templates use today. |
| `pipeline.executor.callTimeoutMs` | `2000` | `EXECUTOR_CALL_TIMEOUT_MS` |
| `pipeline.executor.memoryLimitMb` | `64` | `EXECUTOR_MEMORY_LIMIT_MB` |
| `pipeline.executor.maxCallTimeoutMs` | `10000` | Hard ceiling a manifest may request |
| `pipeline.executor.maxMemoryLimitMb` | `256` | Hard ceiling a manifest may request |
| `pipeline.executor.instancesPerBundle` | `4` | Pool size per loaded bundle |
| `pipeline.executor.maxConcurrentCalls` | `32` | Global ceiling per pod |
| `pipeline.executor.tripThreshold` | `3` | Trips before disable |
| `pipeline.executor.tripWindowSeconds` | `300` | Trip window |
| `pipeline.executor.image` | `ghcr.io/penguintechinc/waddlebot/bundle-executor:<tag>` | Executor Deployment image |
| `pipeline.executor.replicas` | `2` | Replicas of each executor Deployment |
| `pipeline.executor.stageConnections` | `4` | `EXECUTOR_STAGE_CONNECTIONS` |
| `pipeline.executor.hostApiPort.process` / `.action` | `8301` / `8302` | The stages' mTLS host-API listeners |
| `pipeline.executor.resources` | requests `{cpu: "250m", memory: "256Mi"}`, limits `{cpu: "1000m", memory: "512Mi"}` | Executor Deployment resources |
| `sandbox.runtimeClassName` | `runsc` | `RuntimeClass` for the executor Deployments and the compiler Job (`gvisor` on GKE) |
| `sandbox.gvisor.enabled` | `true` | First-class opt-out; sets `WADDLES_SANDBOX_GVISOR` and controls whether `runtimeClassName` is rendered at all; §12.2 |
| `sandbox.installer.enabled` | `false` | Optional node installer DaemonSet; §12.2.2 |
| `sandbox.installer.runscVersion` / `.runscSha256` / `.shimSha256` | empty | Pinned from `build/tool-versions.env`; empty fails rendering when the installer is enabled |
| `sandbox.installer.nodeLabel` | `waddles.io/gvisor=ready` | Applied by the installer; used as the executor/compiler `nodeSelector` when the installer is enabled |
| `pipeline.spine.drainIdleSleepMs` | `100` | Idle sleep between empty drain passes |
| `pipeline.spine.leaseTtlMs` | `30000` | Lease TTL |
| `pipeline.spine.stageMaxLen` | `10000` | Queue bound |
| `pipeline.spine.dlqMaxLen` | `10000` | DLQ bound |
| `pipeline.spine.maxDeliveries` | `5` | Redelivery cap |
| `bundles.allowPrebuilt` | `true` | Seeds hub-api's global-admin setting `bundles.allow_prebuilt`; the DB setting is authoritative at runtime |
| `bundles.bucket.provider` | `minio` | `minio` or `nest` |
| `bundles.bucket.endpoint` | `http://minio.waddlebot.svc.cluster.local:9000` | S3 endpoint |
| `bundles.bucket.name` | `waddles-bundles` | Bucket name |
| `bundles.bucket.region` | `us-east-1` | Region |
| `bundles.bucket.existingSecret` | `waddlebot-bundle-bucket` | Holds `accessKeyId`, `secretAccessKey` |
| `bundles.pollIntervalSeconds` | `60` | Bucket poll cadence |
| `bundles.signingPublicKeySecret` | `waddlebot-bundle-signing` | Holds `publicKey` (pods) and `privateKey` (compiler Job only) |
| `bundles.compiler.image` | `ghcr.io/penguintechinc/waddlebot/bundle-compiler:<tag>` | Job image |
| `bundles.compiler.activeDeadlineSeconds` | `900` | Job deadline |
| `bundles.compiler.resources.limits` | `{cpu: "2000m", memory: "4Gi"}` | Compilation is memory-hungry |
| `security.transport.tls` | `true` | §11.6.4 |
| `security.transport.auth` | `true` | §11.6.4 |
| `security.transport.certManager` | auto-detected | Use cert-manager when present, chart-managed CA otherwise |

**Unchanged:** `pipeline.svcIngest.port` = 8200, `.svcProcess.port` = 8201, `.svcAction.port` = 8202, replicas 2/2/2, and the existing per-service `resources` blocks (requests `500m`/`512Mi`, limits `2000m`/`2Gi`). The `pipeline.pythonBaseImage` value is removed once no template references it.

### 12.4 Pod shape

**Stage Deployment** (`svc-process`, `svc-action`) — cluster-default `RuntimeClass`:

```yaml
securityContext:                 # pod
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile: {type: RuntimeDefault}
containers:
  - name: svc-process
    ports:
      - {name: http,    containerPort: 8201}
      - {name: metrics, containerPort: 9090}
      - {name: host-api, containerPort: 8301}   # executor-facing, mTLS
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities: {drop: ["ALL"]}
    volumeMounts:
      - {name: ca,       mountPath: /etc/waddles/ca, readOnly: true}
      - {name: host-api-tls, mountPath: /etc/waddles/host-api, readOnly: true}
```

**Executor Deployment** (`svc-process-executor`, `svc-action-executor`):

```yaml
runtimeClassName: runsc          # {{ .Values.sandbox.runtimeClassName }}
# nodeSelector applied only when sandbox.installer.enabled:
# nodeSelector: {waddles.io/gvisor: "ready"}
automountServiceAccountToken: false
securityContext:                 # pod
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile: {type: RuntimeDefault}
containers:
  - name: bundle-executor
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities: {drop: ["ALL"]}
    env:                         # nothing from the stage's Secrets
      - {name: STAGE_HOST_API_ADDR, value: "svc-process:8301"}
    volumeMounts:
      - {name: scratch,    mountPath: /scratch}                   # emptyDir, 16Mi
      - {name: wasm-cache, mountPath: /var/cache/waddles/wasm}    # emptyDir
      - {name: client-tls, mountPath: /etc/waddles/host-api, readOnly: true}
      - {name: bucket,     mountPath: /etc/waddles/bucket, readOnly: true}  # read-only creds
```

`automountServiceAccountToken: false` is deliberate: the executor has no reason to talk to the API server, and a mounted token would be the one credential an escape could still find.

### 12.5 Network policy

`CiliumNetworkPolicy`, default deny in the `waddlebot` namespace, with explicit allows:

| Workload | Ingress | Egress |
|---|---|---|
| svc-ingest | Ingress/Gateway → `:8200`; Prometheus → `:9090` | Valkey, hub-api, the five platform APIs (by FQDN), DNS |
| svc-process | Prometheus → `:9090`; **`svc-process-executor` → `:8301` only** | Valkey, Postgres, hub-api, DNS, plus the union of activated bundles' `egress` hosts |
| svc-action | Prometheus → `:9090`; **`svc-action-executor` → `:8302` only** | Valkey, Postgres, hub-api, platform APIs, DNS, plus activated bundles' `egress` hosts |
| **svc-process-executor** | **none** | `svc-process:8301`, the bucket, DNS — nothing else |
| **svc-action-executor** | **none** | `svc-action:8302`, the bucket, DNS — nothing else |
| svc-streaming | Ingress → `:8208`, RTMP `:1935`, SRT `:9000`, WHIP/WHEP UDP range | Postgres, Valkey, the bucket, DNS |
| bundle-compiler Job | none | the bucket, hub-api's callback endpoint, DNS — nothing else |

The two executor rows are the load-bearing ones: with no ingress and two egress destinations, an escaped executor has no route to Valkey, Postgres, the platform APIs, the API server, or the internet. `waddles_egress_denied_total` counts what the stage refuses; the NetworkPolicy is what stops anything that never reaches the stage at all.

No `NodePort`, `HostPort`, `externalIPs` or `hostNetwork` in beta or production; alpha keeps its existing NodePort exemption. External ingress reaches only each pod's declared serving port.

---

### 12.6 Environment variables (consolidated)

Defaults are the values a service uses when the variable is unset. Every secret-bearing variable is read from the environment or a file, never from a CLI flag.

**Common to all four services**

| Var | Default | Notes |
|---|---|---|
| `MODULE_NAME` | the service name | Identity in logs |
| `MODULE_PORT` | 8200 / 8201 / 8202 / 8208 | HTTP listener; read at runtime, never hardcoded in the Dockerfile |
| `METRICS_PORT` | `9090` | Prometheus listener |
| `BIND_ADDR` | `0.0.0.0` | |
| `LOG_LEVEL` | `info` | `error`\|`warn`\|`info`\|`debug` |
| `RUNNER_TENANT_SLUG` | `global` | Fixed tenant slug per deployment |
| `HUB_API_URL` | `http://hub-api.waddlebot.svc.cluster.local:8204` | Distribution API base |
| `SECRET_KEY` | *(required)* | Mints the `distribution:read` service JWT |
| `POLL_INTERVAL_S` | `5.0` | Bundle-set refresh |
| `BASE_BACKOFF_S` / `MAX_BACKOFF_S` | `1.0` / `60.0` | Distribution-poll backoff |
| `VALKEY_URL` | *(required)* | `rediss://…` when TLS is on; falls back to `REDIS_URL` for compatibility |
| `VALKEY_USERNAME` | the service's ACL user | |
| `VALKEY_PASSWORD` / `VALKEY_PASSWORD_FILE` | *(required when auth is on)* | Env or file only |
| `VALKEY_CA_FILE` | `/etc/waddles/ca/valkey-ca.crt` | |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` | `postgres` / `5432` / `waddlebot` / the service role | svc-ingest has no DB |
| `DB_PASSWORD` | *(required when auth is on)* | Env only |
| `DB_SSLMODE` | `verify-full` | |
| `DB_SSLROOTCERT` | `/etc/waddles/ca/postgres-ca.crt` | |
| `SECURITY_TRANSPORT_TLS` | `true` | From `security.transport.tls` |
| `SECURITY_TRANSPORT_AUTH` | `true` | From `security.transport.auth` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `_PROTOCOL` / `_HEADERS` | unset / `grpc` / unset | Unset endpoint ⇒ tracing only |
| `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` | the service name / `deployment.environment=<env>` | Never PII |
| `LICENSE_KEY` / `LICENSE_SERVER_URL` / `POSTHOG_HOST` / `POSTHOG_KEY` | unset / `https://license.penguintech.io` / unset / unset | `penguin-licensing` |

**Spine** (all four services)

| Var | Default |
|---|---|
| `SPINE_CONSUMER_ID` | pod name, else `{hostname}-{uuid-v4}` |
| `SPINE_DRAIN_IDLE_SLEEP_MS` | `100` |
| `SPINE_LEASE_TTL_MS` | `30000` |
| `SPINE_LEASE_HEARTBEAT_MS` | `5000` |
| `SPINE_REAPER_INTERVAL_MS` | `15000` |
| `SPINE_STAGE_MAXLEN` | `10000` |
| `SPINE_DLQ_MAXLEN` | `10000` |
| `SPINE_MAX_DELIVERIES` | `5` |
| `SPINE_DELIVERY_TTL_S` | `3600` |
| `SOCKET_LEASE_TTL_MS` / `SOCKET_LEASE_RENEW_MS` | `30000` / `10000` |

**Executor and bundles** (svc-process, svc-action)

| Var | Default |
|---|---|
| `HOST_API_PORT` | `8301` (svc-process) / `8302` (svc-action) |
| `HOST_API_TLS_CERT_FILE` / `_KEY_FILE` / `_CA_FILE` | `/etc/waddles/host-api/{tls.crt,tls.key,ca.crt}` |
| `HOST_API_PEER_IDENTITY` | `spiffe://penguintech.io/<env>/svc-process-executor`, else the pinned certificate CN |
| `STAGE_HOST_API_ADDR` *(executor)* | `svc-process:8301` / `svc-action:8302` |
| `EXECUTOR_STAGE_CONNECTIONS` *(executor)* | `4` |
| `SANDBOX_RUNTIME_EXPECTED` | `gvisor` |
| `WADDLES_SANDBOX_GVISOR` | `true` |
| `EXECUTOR_WEDGE_THRESHOLD` | `3` |
| `EXECUTOR_CALL_TIMEOUT_MS` | `2000` |
| `EXECUTOR_MAX_CALL_TIMEOUT_MS` | `10000` |
| `EXECUTOR_MEMORY_LIMIT_MB` | `64` |
| `EXECUTOR_MAX_MEMORY_LIMIT_MB` | `256` |
| `EXECUTOR_INSTANCES_PER_BUNDLE` | `4` |
| `EXECUTOR_MAX_CONCURRENT_CALLS` | `32` |
| `EXECUTOR_POOL_WAIT_MS` | `500` |
| `EXECUTOR_MAX_FRAME_BYTES` | `1048576` |
| `EXECUTOR_TRIP_THRESHOLD` / `EXECUTOR_TRIP_WINDOW_S` | `3` / `300` |
| `EXECUTOR_DRAIN_MS` | `5000` |
| `EXECUTOR_UNAVAILABLE_READY_S` | `15` |
| `EXECUTOR_PRECOMPILE_DIR` | `/var/cache/waddles/wasm` |
| `EXECUTOR_WASM_COLLECTOR` | `drc` — must match between precompile and runtime engine (§7.2) |
| `KV_MAX_VALUE_BYTES` / `KV_MAX_TTL_S` | `65536` / `2592000` |
| `BUNDLE_BUCKET_ENDPOINT` / `_NAME` / `_REGION` | `http://minio.waddlebot.svc.cluster.local:9000` / `waddles-bundles` / `us-east-1` |
| `BUNDLE_BUCKET_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | *(required)*, env only |
| `BUNDLE_POLL_INTERVAL_S` | `60` |
| `BUNDLE_FETCH_TIMEOUT_S` | `30` |
| `BUNDLE_MAX_COMPONENT_BYTES` | `33554432` |
| `BUNDLE_CACHE_VERSIONS` | `3` |
| `BUNDLE_SIGNING_PUBLIC_KEY` | *(required)*, Ed25519, base64 |
| `EGRESS_TIMEOUT_MS` | `5000` |
| `EGRESS_MAX_RESPONSE_BYTES` | `1048576` |
| `EGRESS_RATE_LIMIT_RPS` / `_BURST` | `10` / `20` |
| `EGRESS_MAX_REDIRECTS` | `3` |
| `EGRESS_DENYLIST_REFRESH_S` | `60` |

**svc-action only**

| Var | Default |
|---|---|
| `ACTION_MAX_RETRIES` | `3` |
| `ACTION_BASE_BACKOFF_MS` / `ACTION_MAX_BACKOFF_MS` | `250` / `8000` |

**svc-ingest only:** the table in §4.1, plus the platform credentials of §10.2 and `INTAKE_DEDUPE_TTL_S` (`900`).

**bundle-compiler only**

| Var | Default |
|---|---|
| `BUNDLE_MAX_SOURCE_BYTES` | `16777216` |
| `BUNDLE_SIGNING_PRIVATE_KEY_FILE` | `/etc/waddles/signing/privateKey`, mounted only in the Job |
| `SKAUSWATCH_URL` | unset ⇒ the Skauswatch verdict step is reported as `not_configured`, never as a pass |
| `BUNDLE_ORPHAN_GRACE_H` | `168` |
| `BUNDLE_ROLE_GRACE_H` | `168` |

---

## 13. Observability

All four services emit OTel **logs, metrics and traces** through `penguin-logging`, configured only from the standard OTLP environment variables (`OTEL_EXPORTER_OTLP_ENDPOINT`, `_PROTOCOL`, `_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`). No vendor SDK, no hardcoded destination. Prometheus `/metrics` on `:9090` remains a secondary scrape surface, not a replacement. A dead exporter buffers, drops oldest and keeps serving; it never fails a request.

### 13.1 Metrics

Histograms first — load and latency are the signals most often missing.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `waddles_stage_latency_seconds` | histogram | `stage`, `app_id`, `result` | Take-to-enqueue (or take-to-dispatch) time for one envelope |
| `waddles_e2e_latency_seconds` | histogram | `platform`, `kind` (`text`\|`av`) | Platform event timestamp to outbound send; the SLA signal |
| `waddles_host_call_latency_seconds` | histogram | `stage`, `capability`, `op`, `result` | One host call, stage side |
| `waddles_executor_call_seconds` | histogram | `stage`, `app_id`, `export` | One `invoke`, measured by the stage |
| `waddles_spine_queue_depth` | histogram | `stage` | Observed length of a stage key, sampled once per drain pass |
| `waddles_bundle_load_seconds` | histogram | `app_id`, `phase` (`fetch`\|`verify`\|`precompile`\|`load`) | Hot-swap cost |
| `waddles_intake_request_seconds` | histogram | `route`, `status` | Intake handler latency |
| `waddles_egress_request_seconds` | histogram | `app_id`, `host`, `status` | Guarded egress call duration |
| `waddles_spine_dlq_total` | counter | `stage`, `reason` | DLQ writes; `reason` = the record's `error.kind` |
| `waddles_spine_dropped_total` | counter | `stage` | Drop-oldest evictions (queue overflow) |
| `waddles_spine_requeued_total` | counter | `stage`, `cause` (`reaper`\|`retry`) | Lease re-queues |
| `waddles_egress_denied_total` | counter | `app_id`, `reason` | One per §8.2 denial reason |
| `waddles_host_call_denied_total` | counter | `app_id`, `capability` | Ungranted or out-of-allowlist host call |
| `waddles_bundle_digest_mismatch_total` | counter | `app_id` | Refused load on digest/signature disagreement |
| `waddles_sandbox_trip_total` | counter | `app_id`, `limit` (`timeout`\|`memory`\|`trap`\|`denied`) | Sandbox trips |
| `waddles_bundle_skipped_total` | counter | `reason` | Distribution rows the stage could not use (e.g. `no_artifact`) |
| `waddles_intake_rejected_total` | counter | `source`, `reason` | Every intake rejection, reason from §10.1 |
| `waddles_executor_restarts_total` | counter | `stage`, `cause` | Executor restarts |
| `waddles_bundles_loaded` | gauge | `stage` | Components currently resident |
| `waddles_bundle_disabled` | gauge | `app_id` | `1` while disabled by trips |
| `waddles_bundle_stale_age_seconds` | gauge | `app_id` | Age of the newest verified digest versus the advertised one |
| `waddles_insecure_transport` | gauge | `component`, `aspect` | `1` when that component/aspect is running without TLS or auth |
| `waddles_sandbox_gvisor` | gauge | `stage`, `enabled` | `1` on the series matching the active posture, `0` on the other — so "gVisor off" and "not reporting" are distinguishable (§12.2) |
| `waddles_host_api_rejected_total` | counter | `stage`, `reason` | Host-API connections refused (bad certificate, wrong peer identity, `UNSANDBOXED_EXECUTOR`) |
| `waddles_host_api_connections` | gauge | `stage` | Live executor connections per stage |
| `waddles_socket_lease_held` | gauge | `provider`, `community` | `1` on the replica holding the single-owner lease |

### 13.2 Traces

`trace_context` is added to `StageEnvelope` (§6.1.2) precisely so a chat message's journey is one trace across three services.

| Span | Parent | Attributes |
|---|---|---|
| `intake.request` | incoming `traceparent` if present, else root | `route`, `source`, `platform`, `tenant`, `http.status_code` |
| `ingest.normalize` | `intake.request` or the receiver's root span | `platform`, `event_type` |
| `spine.enqueue` / `spine.take` | the stage's current span | `stage`, `app_id`, `key` |
| `bundle.invoke` | `spine.take` | `app_id`, `digest` (12 hex), `export`, `duration_ms`, `result` |
| `host.http` / `host.db` / `host.kv` / `host.relay` | `bundle.invoke` | `capability`, `op`, `host` or `table`, `result` |
| `action.dispatch` | `spine.take` | `app_id`, `platform`, `attempt`, `retryable` |
| `bundle.load` | root (the poller's span) | `app_id`, `phase`, `digest` |

Context propagates on the envelope between stages and on outbound HTTP via W3C `traceparent`. The executor never creates spans itself: it returns durations, and the stage records them, so the guest cannot forge trace data.

### 13.3 Logs

- `penguin-logging` for every line; no `println!` in service code (the check scopes to service source, not CLI output paths).
- Levels are chosen per line: ERROR for actionable failure, WARN for degraded-but-serving (bucket unreachable, trip 1 and 2, insecure transport), INFO for lifecycle and state change (bundle loaded/swapped/disabled, lease acquired/lost, executor started/restarted), DEBUG for per-event decision points — generous by design and off by default.
- Sanitization applies at every level, DEBUG included.
- Structured fields carried on every pipeline log line: `stage`, `app_id`, `tenant`, `community`, `digest` (12 hex), `trace_id`.

### 13.4 Health endpoints

`/health` (rich, §11.6.4), `/healthz` (bare `ok`, for the Kubernetes probes), `/metrics` on `:9090`. Readiness is false while: the distribution poll has never succeeded, the executor has been unavailable longer than `EXECUTOR_UNAVAILABLE_READY_S` (15 s), or Valkey is unreachable.

### 13.5 Feature flags

Every new capability sits behind a PostHog flag, defaulted OFF until validated, resolved through `penguin-licensing`'s two-gate check with last-known-cached fallback. Flag keys follow `{product}.{feature}` and the `FeatureContract` rule that a Feature's flag equals `waddles.{module}.{feature}`; all of these live in the always-on `core` module and are `min_tier: free` (core product, no entitlement gate):

| Flag key | Gates |
|---|---|
| `waddles.core.rust-data-plane` | The Rust stage runners' drain loops. OFF ⇒ the stage serves health and metrics and drains nothing, which is the safe state during rollout. |
| `waddles.core.wasm-bundles` | Loading and invoking WASM components at all. |
| `waddles.core.generic-intake` | `POST /intake/webhook/{tenant}/{source}` and `POST /intake/events`. |
| `waddles.core.prebuilt-bundles` | Accepting `artifact: prebuilt` uploads, in addition to the `bundles.allow_prebuilt` admin setting. Both must permit it. |
| `waddles.core.bundle-egress` | The `http` capability. OFF ⇒ every egress call returns `denied("feature_disabled")`. |
| `waddles.core.spine-at-least-once` | Lease-based take/ack and the reaper. OFF ⇒ plain take without a lease, for an emergency rollback of just this mechanism. |

The `--dev` flag convention applies unchanged: an undocumented flag unlocking Professional/Enterprise features for single-user evaluation, gated by the three fail-closed conditions (PenguinTech-controlled domain, ≤ 1 user in the identity table, user creation capped at 1 while active), with the mandatory stderr banner. It grants nothing in this subsystem, since every flag here is `free`-tier, but the services still implement it identically to the rest of the platform.

---

## 14. Testing strategy

### 14.1 Shared golden fixtures

A single committed fixture set is the contract between the Python and Rust implementations. Location: `tests/golden/` at the repo root, read by both `libs/flask_core`'s pytest suite and `penguin-spine`'s Rust tests.

| Fixture family | Contents | Asserted by |
|---|---|---|
| `envelopes/valid/*.json` | ≥ 20 `StageEnvelope` documents covering: tenant-wide (`community: null`), community-scoped, `target_app_id` set, `trace_context` set and absent, empty `payload`, unicode payload, maximum-length `app_id` | Both: deserialize → re-serialize → byte-identical |
| `envelopes/invalid/*.json` | ≥ 25 documents, one per rejection reason: missing field, wrong type, unknown top-level key, bad stage, legacy pre-`event` shape, non-object payload, empty `platform` | Both: deserialization **fails**, with the same reason classification |
| `keys/*.json` | `{tenant, community, app_id, stage} → expected key string`, including the `_tenant` rendering and every stage | Both: key builders produce the exact string |
| `dlq/*.json` | One record per `error.kind` | Both: serialize/deserialize round-trip, field-for-field |
| `manifests/*.yaml` | One valid `bundle.yaml` v2 per language, plus one per rejection rule V1–V26 with its expected `reason` code | `penguin-bundle-host::manifest` and hub-api's install path |

CI fails if either side skips a fixture: each suite asserts `fixtures_examined == fixtures_on_disk`, a non-zero denominator, and prints the count.

### 14.2 `penguin-spine`

- At-least-once: take → kill the process before ack → reaper re-queues → the event is delivered again exactly once more.
- Reaper concurrency: three simulated replicas reaping the same dead consumer re-queue each entry exactly once.
- Redelivery cap: the sixth take of the same envelope goes to the DLQ with `max_deliveries`, not back onto the queue.
- Queue bounding: pushing `SPINE_STAGE_MAXLEN + 50` envelopes leaves exactly `SPINE_STAGE_MAXLEN` on the key, writes 50 DLQ records with `queue_overflow`, and advances `waddles_spine_dropped_total` by 50.
- DLQ capping: `LTRIM` keeps exactly `SPINE_DLQ_MAXLEN`.
- **Client rule 1:** constructing a `BlockingPopClient` with `RELAY_BLOCK_TIMEOUT_S >= DRAIN_SOCKET_TIMEOUT_S` fails at startup with an error naming both values.
- **Client rule 2:** issuing `BLMOVE`/`BRPOP`/`BLMPOP` on the shared pool is refused; and a test drives a cancelled blocking pop followed by a lease `SET` on the *same* logical client to prove the dedicated connection prevents the stale-reply hand-off.
- `Stage::Ingest` enqueue is refused with `IngestStageNotWritable`.

Backends: `redis-rs` against a real Valkey container for integration tests; no mock-only coverage of the command semantics.

### 14.3 WIT conformance suite

One example bundle per Tier 1 language (`bundles/rust/example`, `bundles/javascript/example`, `bundles/python/example`) plus one hand-built Tier 2 component. The suite asserts, for each:

1. The component compiles/validates under the pinned wasmtime.
2. Its exports satisfy `waddle:bundle/stage@1.0.0` (V25).
3. Its imports are a subset of the world's plus the denying `wasi:sockets` stub set (V26), and a socket call through a stub fails cleanly rather than trapping or connecting.
4. `transform` on a golden event returns the expected event, and `none` for a no-reply input.
5. `dispatch` returns `transport-result` on success and a `transport-error` with the expected `retryable` value on each failure class.
6. The unimplemented stage's stub returns `unsupported-stage` / `UNSUPPORTED_STAGE` rather than trapping.
7. Every host capability is exercised at least once and the denial path is exercised at least once.

### 14.4 Bundle compatibility suite

- **Every** file under `bundles/python/` is compiled by the **real** `bundle-compiler` in CI (not a stub), and each is invoked through a real `bundle-executor` with golden events for its stage. The suite asserts `bundles_compiled == bundles_on_disk` and prints both numbers.
- The bundles' pytest suites — already green natively after the M1.5 DAL migration — keep running unchanged against the `waddle-sdk` shim; their assertions are the compatibility oracle for D7.
- A repo-wide check asserts zero `flask_core.database` and zero `pydal` imports under `bundles/python/`, printing the number of files scanned; the compiler's own `legacy_dal_import` rejection is exercised by a fixture bundle that still has one.
- The six ported ingest normalizers are covered by translating `core/svc_ingest/bundles/test_*_ingest.py`'s cases into Rust table tests, one case per original assertion; the suite asserts the case count matches.
- Retry classification parity: the action-stage cases from `core/svc_action/tests/` are replayed against the Rust runner and must produce the same retry/no-retry decision for every input.

### 14.5 Per-service and per-crate gates

Identical to `.github/workflows/rust-svc-streaming.yml`, applied to all four services, both new binaries, and every new `penguin-libs` crate:

```
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo deny check                     # advisories + licenses + bans + sources
cargo audit
cargo test
cargo llvm-cov --fail-under-lines 90
semgrep --error                      # with the WaddleBot ruleset
gitleaks detect --no-git
trivy image --exit-code 1 --severity HIGH,CRITICAL
```

`penguin-libs` crates run the same gates in that repo, on their own `release/{lib}/v{X}.{Y}.x` branches, and publish to crates.io through trusted publishing.

No step is wrapped in `|| true`. Where a tool is run twice (a JSON report followed by a gating run), the gating run is on the same inputs in the same job.

### 14.6 Negative sandbox tests

Each is a dedicated test whose **pass condition is the failure of the attack**, written against a purpose-built hostile bundle in `bundles/test/hostile/`:

| # | Attack | Expected |
|---|---|---|
| 1 | Guest calls `wasi:sockets` through the executor's native denying implementations | Every call returns `access-denied` immediately (guest Python sees `PermissionError`), no connection is attempted, **the component keeps running and the invocation completes**, the call is counted as `denied`, and three such calls in the window trip the bundle. A Tier 2 component importing a `wasi:*` interface outside the world plus the stub set is rejected at validation with `forbidden_host_import` |
| 2 | Escaped executor attempts to reach Valkey, Postgres, the API server or the internet (simulated by a probe container in the executor's pod) | Every connection fails — the NetworkPolicy allows only the stage's host-API port and the bucket; the probe records each failure and the test asserts all of them |
| 3 | Guest calls `http.send` to a host not in `egress` | `denied("host_not_declared")`, `waddles_egress_denied_total` +1 |
| 4 | Guest calls `http.send` to `169.254.169.254` via a DNS name that resolves there | `denied("ssrf_blocked_address")` |
| 5 | Guest follows a redirect to an undeclared host | `denied("redirect_off_allowlist")` |
| 6 | Guest issues SQL against a table outside `data.tables` | `denied(...)` before Postgres is touched; a second test bypasses the parser check and asserts the Postgres role also refuses |
| 7 | Bucket serves a component whose bytes do not match the recorded digest | Load refused, previous version still serving, `waddles_bundle_digest_mismatch_total` +1 |
| 8 | Sidecar signature invalid | Load refused, same assertions |
| 9 | Guest spins forever | Epoch deadline fires at `limits.timeout_ms`, DLQ `call_timeout`, trip recorded |
| 10 | Guest allocates past its memory cap | Trap, DLQ `memory_limit`, trip recorded |
| 11 | Three trips within the window | Bundle DISABLED, `waddles_bundle_disabled{app_id}` = 1, subsequent events DLQ'd with `bundle_disabled` (never silently dropped) |
| 12 | Executor attempts to read the stage's environment, Secrets or ServiceAccount token | None are mounted in the executor's pod and `automountServiceAccountToken: false`; the probe's failure is asserted |
| 12a | `WADDLES_SANDBOX_GVISOR=true` but the pod is scheduled without the gVisor `RuntimeClass` | Startup verification fails, the pod exits `78` and crash-loops |
| 12b | `WADDLES_SANDBOX_GVISOR=false` | Loud WARN logged, `waddles_sandbox_gvisor{enabled="false"}` = `1` and `{enabled="true"}` = `0`, `/health` reports `sandbox: "runc"`, and every other sandbox layer (own pod, rootless, caps dropped, read-only rootfs, NetworkPolicy, WASM isolation) is asserted still in force |
| 12c | Executor reports `runc` to a stage whose `WADDLES_SANDBOX_GVISOR` is `true` | Connection refused with `UNSANDBOXED_EXECUTOR`, `waddles_host_api_rejected_total` +1 |
| 12d | A workload other than the executor dials the stage's host-API port | Denied by the NetworkPolicy; a connection presenting a wrong or unsigned certificate is additionally refused at the TLS layer and counted |
| 13 | Guest sets a module-level variable and is invoked again | The variable is reset — no state survives a call |
| 14 | Bundle A attempts to read bundle B's KV namespace or config | Keys are namespaced per `app_id`; the read returns none and is counted |
| 15 | Executor sends a frame larger than `EXECUTOR_MAX_FRAME_BYTES` | Stage kills and restarts the executor, `waddles_executor_restarts_total` +1 |
| 16 | The executor binary links a networking or database crate | `cargo tree -p bundle-executor` contains no `reqwest`, `redis`, `deadpool-redis`, `sea-orm` or `sqlx`; the CI check fails the build if any appears, and reports the number of crates examined |

### 14.7 Telemetry validation (blocking, every commit)

Every service's smoke test runs against a local OTLP sink and asserts, printing every count:

| Assertion | Threshold | On zero |
|---|---|---|
| Log records received | ≥ 1 | FAIL |
| Metric data points received | ≥ 1 | FAIL |
| Histogram metrics received | ≥ 1 | FAIL |
| Spans received | ≥ 1 | FAIL (all four services make inter-service or DB calls) |
| `penguin-logging` in use (no hand-rolled `println!`/`eprintln!` in service source) | 0 violations across ≥ 1 scanned file | FAIL |

A sink that fails to start is a FAIL, never a skip. Zero files scanned is a FAIL.

### 14.8 End-to-end alpha stack

Against a freshly destroyed and rebuilt alpha cluster, with seeded mock data (3–4 items per feature):

1. Real Twitch and Discord traffic through the echo, music, alias, reputation and overlay bundles.
2. Assertions: the expected outbound message arrives on each platform; `action_dispatch_log` rows match; no DLQ entries beyond the ones a deliberate failure test creates.
3. OTel sink counts asserted, with the numbers printed.
4. `waddles_e2e_latency_seconds` p95 asserted under **3 s** for text and under **5 s** for A/V paths. A run whose histogram has zero observations is a FAIL, not a pass.
5. A hot-swap is exercised live: publish a new version, assert convergence within 65 s, assert zero dropped events across the swap.
6. A bucket outage is simulated: pods keep serving, `waddles_bundle_stale_age_seconds` grows, no event is lost.

### 14.9 Verification integrity

Applied to every gate in this section: no `|| true` on a linter, scanner or test; `set -euo pipefail` in every script and hook; `${PIPESTATUS[0]}` rather than `$?` after a pipeline; every "clean" result reported with the number of items examined; a zero denominator is a failure. Each new gate is made to fail on purpose once, before it is trusted.

---

## 15. Migration & cut-over

### 15.1 Shape

One feature branch off `release/v3.0.X` carries the entire change:

- the four Rust services,
- `bundle-executor` and `bundle-compiler`,
- the `bundles/python/` tree (sources moved, DB lines migrated to penguin-dal per D21a, plus one new `bundle.yaml` per bundle),
- `sdk/waddle-sdk{,-rs,-js}`,
- `wit/waddle-bundle/stage.wit`,
- chart changes (§12.3),
- the docs rewrite,
- deletion of the Python service directories.

It merges only when every gate in §14 is green **and** the alpha end-to-end run passes. There is no fallback by design (D3).

### 15.2 Deletions

| Deleted | Replaced by |
|---|---|
| `core/svc_ingest/**/*.py` (app, runner, receivers, fanout, eventsub, supervisor, socket_lease, outbound_drain, bundles, tests) | `core/svc_ingest/src/**`, `penguin-connectors` |
| `core/svc_process/**/*.py` | `core/svc_process/src/**` |
| `core/svc_action/**/*.py` | `core/svc_action/src/**` |
| `core/svc_streaming/{app.py,blueprints,services,openapi,Dockerfile}` and its pytest tree | the existing Rust build; `Dockerfile.rust` renamed to `Dockerfile` |
| `flask_core.stage_runner.load_entrypoint` and the `importlib` loading path | the executor |
| `KNOWN_SURFACES`' `ingest` as a *bundle-pluggable* surface | fixed normalizers in svc-ingest (the string stays in the manifest vocabulary only to reject it, rule V15) |

`libs/flask_core` itself **stays** — hub-api and the tests use it. It gains: the envelope strictness tightening, the `trace_context` field, and the removal of the bundle-loading machinery.

### 15.3 Behaviour changes to announce

Three user-visible changes are not pure ports:

1. **Ingest is no longer bundle-pluggable.** Six `*_ingest.py` bundles become fixed code. Their `app_catalog.stages.ingest` rows are removed by a migration; any third-party ingest bundle (none exist today) would need to move to the generic intake.
2. **Per-community activation is now honoured on the ingest fan-out path.** `fanout.py` previously always fell through to each Feature's shipped default App. Communities that had activated a non-default App for an ingest-fed Feature will now actually get it. The migration notes list the affected `(community, feature)` pairs so operators can confirm intent before the cut-over.
3. **Bundle database access moves to `penguin-dal`.** Every bundle's DB-access lines are rewritten (M1.5); `flask_core.database` and `pydal` stop being importable from a bundle at all, enforced by the compiler (D21b). Authors of out-of-tree bundles must migrate before their next upload, and the rejection message names the module and the equivalent.
4. **Events are no longer silently lost on a crash, and are no longer silently dropped on failure.** At-least-once delivery means a bundle can see the same event twice after a crash; bundles that were accidentally relying on at-most-once must be idempotent. Every existing first-party bundle was reviewed for this and is idempotent or made so; the review is part of M2's deliverables.

### 15.4 Data migration

None for the spine: the key scheme and envelope JSON are unchanged, so in-flight events survive the cut-over. Database migrations are additive:

| Migration | Adds |
|---|---|
| `app_catalog` version columns | `artifact_digest`, `artifact_kind`, `language`, `scan_status`, `manifest_json` |
| `custom_platforms` | per-tenant registered platform names for the REST intake |
| `intake_sources` | `{tenant, source, platform, secret_ref, community, mapping, enabled}` |
| `bundle_scan_findings` | per-version scanner findings summary |
| `global_settings` seed | `bundles.allow_prebuilt = true` |
| Per-bundle role bootstrap | the RLS policies on bundle-owned tables |
| Ingest-stage cleanup | removes `stages.ingest` from the six affected `app_catalog` rows |

### 15.5 Rollback posture

There is no rollback to Python. The rollback units are smaller and each is real:

- a bad bundle version → flip the active digest (≤ 65 s convergence);
- a bad capability → turn off its PostHog flag (§13.5);
- a bad service build → Helm rollback to the previous image tag, which is still a Rust build.

---

## 16. Milestones

```
M1 ──┬──────────────▶ M2 ──┬──▶ M3 (svc_action) ──┐
     └─▶ M1.5 ─────────┘   ├──▶ M4 (svc_process) ─┼──▶ M6
        (Bundle DAL         └──▶ M5 (svc_ingest) ──┘
         migration, Python-only — gates M2's compiler work)
```

M1.5 runs alongside M1 and must finish before M2's compiler work begins — the compiler rejects the legacy DAL imports it removes (D21b), so compiling an unmigrated bundle is not possible by design. M3, M4 and M5 run in parallel once M1, M1.5 and M2 are complete. M6 requires all three.

### M1 — `penguin-libs` crates

| Deliverable | Done when |
|---|---|
| `penguin-spine` | Key builders, envelope types, take/ack/requeue, reaper, DLQ, bounding, `BlockingPopClient` — all §14.1/§14.2 tests green, coverage ≥ 90 % |
| `penguin-bundle-host::wire` + `::manifest` | Frame codec and the 26 manifest rules, golden manifests green |
| `penguin-logging` | Sanitization ported verbatim, OTel logs/metrics/traces wired, health/metrics surface, `transport:` reporting |
| `penguin-connectors` (5 crates) | Receivers, senders and signature verification per platform, against recorded fixtures |
| `penguin-licensing` | `build-rust-licensing` + `publish-rust-licensing` jobs, `0.1.0` on crates.io |
| `flask_core` alignment | Strict envelope deserialization + `trace_context`, golden fixtures shared with Rust |

### M1.5 — Bundle DAL migration (Python only, parallel with M1)

Pure Python work, no WASM involved, completed and merged before M2's compiler work starts.

| Deliverable | Done when |
|---|---|
| Inventory | Every bundle under `bundles/python/` that imports `flask_core.database.AsyncDAL` or reaches a DAL through `get_bundle_dal()` is listed, with the count reported — a zero count is a failure of the inventory, not a pass |
| Migration | Each listed bundle's DB-access lines are rewritten against the `penguin-dal` public API (`/home/penguin/code/penguin-libs/packages/python-dal/src/penguin_dal/__init__.py`); bundle logic and entrypoint signatures are otherwise untouched |
| Tests | Each bundle's existing pytest suite is updated to the new DAL and passes **natively** (no WASM), with coverage unchanged or better |
| Gate | A repo-wide check reports zero occurrences of `flask_core.database` and `pydal` under `bundles/python/`, printing the number of files scanned |

### M1 verification task (blocking M3–M5)

Verify `runsc` availability on the alpha MicroK8s node and on the DigitalOcean node image used for gamma and production (§18, R3). A negative result changes the default posture decision, so it runs early rather than at M6.

### M2 — Compiler, SDKs, bucket flow, hub-api hooks

| Deliverable | Done when |
|---|---|
| `bundle-compiler` | Four-phase sandboxed run under the `RuntimeClass`, all scanners with non-zero denominators, content addressing, Ed25519 sidecar, bucket upload |
| `waddle-sdk` (Python) | Same import names, the single `penguin-dal` facade over the WIT `db` import, the `sitecustomize` runtime shims (`to_thread`/`run_in_executor`, `PollLoop` entry), every migrated bundle's pytest suite passing |
| gVisor benchmark | `waddles_executor_call_seconds` and `waddles_e2e_latency_seconds` measured with `sandbox.gvisor.enabled` true and false on the same hardware and bundle set; both distributions published in the chart docs, and the §12.2 trade-off sentence cites our own number (§18, R8) |
| `waddle-sdk-rs`, `waddle-sdk-js` | Example bundle per language passing the WIT conformance suite |
| Bucket flow | MinIO in alpha, Nest configurable; poller, verification, precompilation, hot-swap proven in a harness |
| hub-api install hooks | `POST /api/v1/apps/{app_id}/versions`, the version state machine, `bundles.allow_prebuilt`, the distribution API's six new fields |
| Idempotency review | Every first-party bundle reviewed and, where needed, made idempotent under at-least-once (§15.3 item 3) |

### M3 — `svc_action` (parallel)

| Deliverable | Done when |
|---|---|
| Rust service on the `svc_streaming` template | `/health`, `/healthz`, `/metrics`, OTel, config, Dockerfile, CI workflow |
| Executor integration | Load/invoke/hot-swap, all §14.6 negative tests green |
| Built-in senders | Discord, Slack, YouTube, Kick REST; Twitch via the relay |
| Retry + audit parity | `action_dispatch_log` rows and retry decisions match the Python suite's expectations for every replayed case |

### M4 — `svc_process` (parallel)

| Deliverable | Done when |
|---|---|
| Rust service + executor integration | As M3 |
| Built-ins | Moderation gate, enforcement routing, cross-app `_target_app_id` routing |
| Bundles | `bot_process`, shoutout, live status, activity feed, reputation accrual running as WASM bundles |
| DB host capability | Parser allowlist + per-bundle role + RLS, with the negative tests green |

### M5 — `svc_ingest` + generic intake (parallel)

| Deliverable | Done when |
|---|---|
| Rust service | Fixed normalizers for all six platforms, ported test cases counted and green |
| Connectors live | Twitch IRC + EventSub webhook and websocket, Discord gateway, Slack Socket Mode, YouTube poll, Kick Pusher + webhook, all lease-guarded |
| Outbound relay | Dedicated-connection blocking pop, both client rules tested |
| Generic intake | `POST /intake/webhook/{tenant}/{source}` and `POST /intake/events` with auth, replay, dedupe, mapping, rate limits, every error code covered |
| Activation fix | Distribution-API resolution on every path, affected `(community, feature)` pairs listed |

### M6 — Streaming retirement, charts, cut-over, docs

| Deliverable | Done when |
|---|---|
| Streaming | Python alpha deleted, `Dockerfile` renamed, `penguin-logging` and `penguin-licensing` adopted, CI building the Rust image |
| Charts | All values of §12.3, CA/cert provisioning, Valkey ACL file, required Secrets, `sandbox.*` values, the optional installer DaemonSet, and the gVisor startup assertion wired |
| Docs | `docs/APP_BUNDLE_AUTHORING.md` v2 (WASM, `bundle.yaml` v2, the WIT world, capabilities, egress, limits, `ingest` removed from the pluggable surfaces), per-service READMEs, migration notes |
| Cut-over | Python service directories deleted; every §14 gate green; alpha e2e green including latency, hot-swap and bucket-outage scenarios |

### Follow-on work (not in this spec's milestones)

Once M2 lands (compiler plus the Tier 1 SDKs), a bundle backlog of ten bundles inspired by PenguinTwitchBot (MIT; **ideas and design only, no code copied**; the creator's permission has been granted) is written against the Tier 1 SDKs, S-sized first — `stream-counters`, `weather-command`, `auto-timers`, `top-lists`, `custom-command cooldown/limits` — then `channel-points-bridge`, `go-live-announcer`, `tts-announcer`, `prize-wheel`, `clip-auto-download`; each is a process- or action-stage bundle, and collectively they double as real-world SDK validation. Reading source is the local clone at `~/external-code`. The permission carries a hard condition, which is a requirement on this work rather than a courtesy: **before the first derived bundle merges**, `SuperPenguinTV` (GitHub `Psychoboy`, PenguinTwitchBot) must be added to the repository's contributors file and to a README "Acknowledgements" section, and every derived bundle's manifest and README must carry the line "inspired by PenguinTwitchBot by SuperPenguinTV (with permission)".

---

## 17. Standards

The constraints below bind this design. They are summarized, not restated in full; the named rule file is authoritative.

| Area | Constraint | Where it lands in this spec |
|---|---|---|
| Language by tier | Everything in-line of traffic is Rust — tier, not volume, decides. Agents and CLIs are Rust regardless. Security-sensitive work is Rust or Python, never Go. | D1; all four services and both binaries are Rust |
| Rust stack | Axum + tokio + SeaORM + `tracing`; `rustls` never native TLS; `jsonwebtoken` with the `aws_lc_rs` backend | §4.1–§4.6 |
| Rust lints | `unsafe_code = "deny"`, `missing_docs = "deny"`, `clippy::unwrap_used = "deny"`, `cargo clippy -D warnings` | §14.5; every new crate |
| Supply chain | `cargo deny` + `cargo audit` in CI; exact `=x.y.z` pins, `Cargo.lock` committed; no PRC-origin or sanctioned-entity crates (the `xiu` ban in `core/svc_streaming/deny.toml` is the precedent); build tools fetched at pinned versions with SHA-256 verification | §12.1, §14.5 |
| Coverage | 90 % minimum, lines/branches/functions/statements; builds fail below | §14.5 (`cargo llvm-cov --fail-under-lines 90`) |
| Containers | Rootless at both layers: rootless runtime and `USER appuser` / `runAsNonRoot: true`. No root exception is requested by this design | §12.1, §12.4 |
| Observability | OTel logs **and** metrics **and** traces, destination configurable only through the standard OTLP env vars, no vendor SDK; penguin logging used alongside, never instead; histograms for load and latency first; a dead exporter never fails a request | §13 |
| Telemetry gate | Blocking smoke-test validation with printed counts every commit | §14.7 |
| Transport security | TLS 1.2+ everywhere, mTLS certificate validation, at-rest encryption on every store | §11.6 |
| Secrets | Never in a distributed build, never on a CLI flag, never in logs or stdout, env/file only, masked in CI | §11.5 |
| Verification integrity | No `|| true` on a gate; `set -euo pipefail`; `${PIPESTATUS[0]}`; every clean result reported with a non-zero denominator | §14.9, §9.3 |
| Feature flags | Every feature behind a PostHog flag keyed `{product}.{feature}`, defaulted OFF, two-gate with license entitlement, graceful degradation to the last cached value | §13.5 |
| Licensing model | Node/seat metering unchanged by this design; bundles are not a metered object | — |
| PII tokenization | Single `users` identity table; everything else references by UUID; no PII in logs, spans or metric labels | §11.8, rule V23 |
| Tenant isolation | Tenant from the validated key/claim, never from a request body; tenant middleware before scope checks | §11.8, §10.4 |
| OIDC scopes | Permission checks on scopes, never role names; `intake:write` and `distribution:read` are the two this design adds/uses | §10.1, §11.9 |
| SPIFFE | Every service reserves `spiffe://penguintech.io/<env>/<service>` and is SPIFFE-ready | §11.9 |
| Kubernetes | Default-deny `CiliumNetworkPolicy`, no NodePort/HostPort/hostNetwork in beta/prod, Pod Security Admission `restricted`, Helm only | §12.4, §12.5 |
| Shared libraries | Reusable code lives in `penguin-libs` (`~/code/penguin-libs`), one concern per crate directory, per-crate release branches and independent SemVer | D17, §4.7–§4.11 |
| Dependency pinning | Exact versions in `Cargo.toml`, `Cargo.lock` committed, SHA-256 digests for images and fetched tools, full commit SHAs for GitHub Actions | §12.1, §14.5 |
| Branching | Work off `release/v3.0.X` in feature branches inside worktrees; PR for every merge; release → main is user-gated | §15.1 |
| Docs | Every class and function gets a 2–3 line doc comment; no ASCII-art section dividers | applies to all new code |

---

## 18. Risks & spikes

| # | Risk | Impact | Mitigation | Spike |
|---|---|---|---|---|
| R1 | **`penguin-dal` facade in WASM.** The `waddle-sdk` facade must reproduce the `penguin-dal` public API faithfully — query composition, field/table proxies, pagination, row shape — while lowering every call to a parameterized statement over the WIT `db` import, single-threaded and synchronous underneath. A semantic gap breaks migrated bundles. | High: it is the single component that can falsify "bundles otherwise unchanged". | The bundles' own pytest suites, already green natively after M1.5, are the oracle (§14.4): the same suites must pass through the facade. Any construct the facade cannot lower raises an explicit `NotImplementedError` naming the construct, never silently mis-executes. | **Rounds 1 and 2 complete** — report `spikes/penguin-dal-wasm/REPORT.md`, branch `spike/penguin-dal-wasm`, commits `f45e6578` and `964f2729` (`componentize-py` 0.25.1, `wasmtime` 48.0.x, `wasm-tools` 1.259.0). Round 1: an **unchanged** bundle compiled in 3.4–3.9 s to a 21.6 MB component and the query builder round-tripped correctly at 2–4 ms warm per call; four blockers found. Round 2 **confirmed all three runtime mitigations**: the synchronous `to_thread`/`run_in_executor` shim carried the alias bundle's full `!alias add` write path end to end (4 `db-execute` round trips, 9–18 ms; read-only `!alias foo` 0.7–1.0 ms, no DB call); build-time `pkgutil.walk_packages` pre-import generation resolved the lazy imports; guest `wasi:sockets` use fails cleanly with `PermissionError` while the component keeps running. Round 2 also produced two hard requirements now in the spec: the denying socket interfaces must be **native to the Rust executor** (hand-authored stub components proved impractical), and precompilation must use the **same GC collector** as the runtime engine (`-C collector=drc`; a mismatch fails to load) — precompiled `.cwasm` loads in 4.5–5.4 ms versus 3.3–4.5 s uncached. |
| R2 | **`componentize-py` executes bundle guest code at build time** — **confirmed** in round 2: componentization performs a sandboxed dry-run with the WIT imports trapped, and the compiler's `pkgutil.walk_packages` pre-import deliberately widens that execution to every module in the package. | High for security, medium for compatibility. | The compiler Job keeps the gVisor `RuntimeClass` (D10) with a two-destination network policy and credentials unread until the upload phase — compilation is treated as untrusted-code execution, not as a build step. Bundles whose import-time code needs I/O fail compilation with a clear diagnostic rather than being silently compiled with partial state. | Compile all existing bundles in the sandboxed Job and record which, if any, need an import-time behaviour change. |
| R3 | **gVisor availability across Kubernetes distributions.** The original bubblewrap design is dead: a feasibility spike (`/tmp/claude-1000/-home-penguin-code-waddlebot/2142d121-d93d-453f-80fa-5e8160d63371/scratchpad/spike-bwrap/REPORT.md`, 2026-09-14, MicroK8s + containerd 2.1.6) found **11 of 11 test configurations failed**: `bwrap` could not create a namespace inside a rootless container even with `hostUsers: false`, as root, or with `SYS_ADMIN` — the kernel sysctls were correct (`unprivileged_userns_clone=1`, unlimited `max_user_namespaces`) but the runtime refuses `unshare(CLONE_NEW*)` inside containers. gVisor replaces it, which moves the risk to "is `runsc` installable on each cluster". | High: no `runsc`, no default-posture sandbox. | The support matrix (§12.2.1) covers MicroK8s, k3s, minikube, kubeadm, GKE Sandbox, and the managed clouds; the optional installer DaemonSet (§12.2.2) covers the rest with pinned, checksum-verified binaries; `sandbox.gvisor.enabled: false` is a documented, visible fallback that keeps every other layer. Startup fails closed when gVisor is requested but absent. | **M1 task:** verify `runsc` on the alpha MicroK8s node and on the DigitalOcean node image used for gamma and production, before M3–M5 start. |
| R8 | **gVisor performance overhead on wasmtime.** Syscall-heavy work under a user-space kernel costs latency; the operator-facing figure must be ours, not a vendor's. | Medium: the 3 s text SLA has headroom, but the number drives the opt-out advice. | The opt-out exists precisely because some operators will want the latency back; the documented trade-off sentence (§12.2) cites our own measurement. | **M2 task:** benchmark `waddles_executor_call_seconds` and `waddles_e2e_latency_seconds` with `sandbox.gvisor.enabled` true and false, same hardware, same bundle set, and publish both distributions in the chart docs. |
| R9 | **gVisor version pin versus node kernel updates.** A pinned `runsc` can lag a node kernel update, and the startup `/proc/self/status` marker check is tied to the pinned sentry's field set. | Medium: a node upgrade could make pods fail closed on a working cluster. | The marker check treats an unrecognized-but-clearly-gVisor `/proc/version` as verified and logs at WARN rather than failing, so only a genuinely absent sandbox fails closed; `runsc` upgrades are a chart value change with the same pinned-digest discipline as every other tool. | Re-verify the marker set whenever the `runsc` pin moves; the check has a test per pinned version. |
| R4 | **wasmtime version pinning versus precompiled artifacts.** A precompiled component is only loadable by the exact engine that produced it; a chart upgrade that changes the engine invalidates every cached artifact at once. | Medium: a slow, thundering-herd recompilation window after an upgrade. | Cache keyed `{digest}-{wasmtime_abi}`; a mismatched artifact is discarded and recompiled, never loaded. Precompilation is measured (`waddles_bundle_load_seconds{phase="precompile"}`), and a rolling upgrade recompiles pod by pod rather than all at once. | Measure cold-start recompilation for the full first-party bundle set and size `EXECUTOR_PRECOMPILE_DIR` accordingly. |
| R5 | **Valkey TLS + ACL rollout.** The live ACL scheme today is a flat set of legacy per-module users with no `svc-*` entries, and the chart's Secret defines only `REDIS_URL`. Turning on TLS and per-service ACL users touches every service at once, hub-api included. | Medium: a misconfigured ACL is an outage, not a degradation. | The chart provisions the ACL file, the CA and both `VALKEY_URL` and `REDIS_URL`; startup refuses a plaintext or unauthenticated URL loudly rather than connecting insecurely by accident; `security.transport.*` gives operators a documented, visible opt-out (D20). | Bring the alpha stack up with TLS + per-service ACLs before M3 starts, so the three parallel services develop against the final configuration. |
| R6 | **Schedule versus the v3.0 MVP.** This lands before the MVP (D2) and is a four-service rewrite plus a new sandbox runtime. | High: it is on the critical path. | M3/M4/M5 are parallel and disjoint by service, so the long pole is `max(M3, M4, M5)` rather than their sum. M1 and M2 are deliberately front-loaded because everything else depends on them. Any slip is visible early: M2's completion criterion (every existing bundle compiling and passing its own tests) is the real schedule signal. | Track M2's bundle-compilation count as the weekly schedule metric. |
| R7 | **At-least-once changes bundle assumptions.** A bundle that was accidentally relying on at-most-once can now double-apply an effect. | Medium. | Idempotency review of every first-party bundle is an M2 deliverable; `waddles_spine_requeued_total` makes redelivery visible; `SPINE_MAX_DELIVERIES` bounds the blast radius. | Covered by the M2 review. |

---

## 19. Open questions

Only items genuinely undecidable from the approved design are listed. Each names who can decide it and what the spec does in the meantime.

| # | Question | Interim behaviour in this spec |
|---|---|---|
| Q1 | **Operator re-enable for a trip-disabled bundle.** The approved text fixes the three-strike disable but not how an operator clears it without waiting for a new version or a pod restart. Should hub-api expose an explicit re-enable action, and at what scope (pod, deployment, cluster)? | A disabled bundle re-enables only on a new `artifactDigest` or a pod restart (§7.5). No runtime switch exists. |
| Q2 | **The `presentation` surface's long-term home.** `bundle.yaml` v2 still accepts `presentation`, served client-side by `svc_presentation`, which is outside this rewrite. Does it eventually become a WASM stage, stay a static asset surface, or move entirely into the webui? | Accepted in the manifest, never compiled to WASM, unchanged behaviour. |
| Q3 | **Per-bundle Postgres role lifecycle at scale.** Roles are created at approval and dropped a week after the last activation, but the ceiling on concurrent roles, the password-rotation cadence, and the cleanup job's ownership are not settled. | Create at approval, drop after `BUNDLE_ROLE_GRACE_H = 168`; rotation is manual. |
| Q4 | **`waddle-sdk` distribution.** Public PyPI (so third-party authors can `pip install waddle-sdk` and test locally) or an internal index only? Public publication also publishes the WIT world's shape. | Built and versioned in-repo; publication target deferred. Tier 1 authors use the in-repo package and the compiler recipe. |
| Q5 | **Gamma/production bucket provider.** MinIO is the alpha default and Nest is "when configured", but which backs gamma and production on DigitalOcean — and whether that is Nest, DigitalOcean Spaces, or MinIO in-cluster — is not settled. | `bundles.bucket.provider` accepts `minio` or `nest`; alpha and beta use MinIO. |

---

## 20. Assumptions

Where the approved design left a detail open, the option most consistent with the approved text was chosen. Each is listed here so a reviewer can overturn it cheaply.

| # | Assumption | Why this option |
|---|---|---|
| A1 | **One WIT world (`stage`) exporting both stage interfaces**, with an auto-generated stub returning `unsupported-stage` for the stage a bundle does not implement. | The approved text names a single world, `waddle:bundle/stage@1.0.0`, with both exports. WIT worlds require all exports to be present, so a stub is the only way to have one world and single-stage bundles. |
| A2 | **Open-ended JSON crosses the WIT boundary as canonical JSON text** (`payload-json`, `config-json`, `message-json`, `fields-json`). | WIT has no dynamic value type; the alternative (a hand-rolled variant tree) would change the shape bundles see, violating D7. |
| A3 | **Executor frames are `u32` big-endian length + UTF-8 JSON, bidirectional with correlation ids**, carried over one mTLS connection per stage; the executor dials, and host calls flow executor→stage on the same connection. | The approved text fixes a length-prefixed message protocol and a credential-less executor; moving the executor to its own Deployment replaced the Unix socket with an mTLS port, and the host capabilities remain stage-side, which makes the connection bidirectional. JSON keeps golden fixtures trivial at chat volumes. |
| A4 | **Queue-overflow evictions are written to the DLQ** with `error.kind = "queue_overflow"`. | The approved text pairs "drop-oldest + metric" with a DLQ; silently discarding an envelope that was successfully accepted would contradict "never silently fail". |
| A5 | **Hook assignment** (§4.2): the moderation gate, moderation-enforcement routing and cross-app `_target_app_id` routing become Rust built-ins; `bot_process`, raid shoutout, live status, activity feed and reputation accrual become bundles. | The approved text fixes the rule ("bundles or Rust built-ins, no third path") but not each hook. Hooks that must run for every event regardless of activation, or that manipulate envelope routing, are stage behaviour; flag-gated per-feature behaviour is an App. |
| A6 | **The generic-intake mapping uses RFC 6901 JSON Pointers**, with `$now` as the only magic default. | "Declarative JSON→`PlatformEvent` mapping" rules out expressions; JSON Pointer is the smallest standard that addresses nested bodies. |
| A7 | **A trip-disabled bundle re-enables on a new digest or a pod restart only.** | The approved text specifies disable + DLQ + alert and no re-enable mechanism; adding an API would be a new feature (recorded as Q1 instead). |
| A8 | **Twitch EventSub webhook and websocket are mutually exclusive per tenant**, selected by `TWITCH_EVENTSUB_MODE`. | The approved text calls the websocket "a per-tenant alternative to the webhook"; running both would double-deliver every event. |
| A9 | **Drain cadence is a 100 ms idle sleep with immediate re-run while messages flow.** | The approved text fixes only the 5 s bundle-set refresh and the 3 s/5 s SLA; a value was needed to make the SLA arithmetic checkable. 100 ms leaves ≥ 90 % of the text budget for real work. |
| A10 | **Flag keys live in the always-on `core` module** (`waddles.core.rust-data-plane`, etc.) at `min_tier: free`. | `{product}.{feature}` plus the `FeatureContract` rule that a flag equals `waddles.{module}.{feature}`; `core` is the existing always-deployed namespace and these are core-product capabilities, not licensed ones. |
| A11 | **`trace_context` is an optional envelope field**, absent or null deserializing to none, exactly like `target_app_id`. | The approved text adds the field for cross-stage spans; making it optional keeps every existing envelope valid. |
| A12 | **Artifact layout** `bundles/{app_id}/{version}/{sha256}.wasm` plus a `{sha256}.json` Ed25519-signed sidecar. | The approved text fixes content addressing, a signed bucket sidecar and a deploy key; the path shape is the smallest scheme that is both content-addressed and human-navigable. |
| A13 | **Per-bundle Postgres role naming** `bundle_<app_id with dots and dashes replaced by underscores>`. | The approved text fixes "a per-bundle Postgres role limited to manifest `data.tables`" but not the name; a deterministic derivation avoids a lookup table. |
| A14 | **`db` statements are parsed and table-checked before execution, in addition to the role and RLS.** | The approved text fixes "parameterized SQL executed by the stage under a per-bundle role limited to manifest `data.tables`"; a parser check is how the stage enforces the table list itself rather than relying solely on grants. |
| A15 | **`wasi:random` is permitted** inside the guest; every other WASI interface beyond the read-only `/scratch` preopen is excluded. | The approved text excludes `wasi:sockets`, `wasi:filesystem` beyond a read-only scratch, and environment access, and is silent on randomness; excluding randomness would break ordinary bundles (shuffles, giveaways) for no stated security gain. |
| A16 | **Executor-side deadline plus a stage-side backstop timer** at `deadline_ms + 250 ms`. | The approved text fixes a per-call epoch deadline; a wedged executor cannot enforce its own, so the stage needs a backstop for the deadline to be a real guarantee. |
| A17 | **Intake delivery-id de-duplication** (`409`, a 900 s seen-set) alongside the replay window. | The approved text fixes a replay window but not duplicate suppression; platforms retry webhooks routinely, and at-least-once downstream makes a duplicate at the edge avoidable rather than unavoidable. Removing it costs only the `409` row in §10.1. |
| A18 | **M1.5 (the bundle DAL migration) runs parallel with M1 and gates M2's compiler work**, rather than sitting inside M2. | The approved text offered "in M2 before the compiler work, or as M1.5 — your call". A separate milestone makes the dependency explicit and lets pure-Python work proceed while the Rust crates are being built; it is also the honest schedule signal, since nothing can compile until it lands. |
| A19 | **Denying `wasi:sockets` implementations are part of the host, and V26 allows the imports when the executor supplies them.** | The spike showed `componentize-py`'s runtime will not instantiate without the full WASI P2 import set, so a blanket ban would exclude the Python tier entirely. Round 2 further showed hand-authored stub components impractical, so the Rust executor implements the refusing interfaces itself. Either way the actual guarantee holds — no bundle opens a socket — while the toolchain still links. **No longer an assumption: verified in round 2.** |
| A20 | **`asyncio.to_thread` and `loop.run_in_executor` are replaced with synchronous, already-completed-awaitable shims** rather than a real executor. | WASI has no thread pool; the bundles' uses are all immediately awaited, so inline execution is semantically equivalent for them. A bundle that genuinely needed background concurrency would behave differently, which is why the change is documented in the authoring guide rather than hidden. **No longer an assumption: round 2 ran the alias bundle's full write path through the shim unchanged.** |
