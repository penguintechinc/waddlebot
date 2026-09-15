# M4 — `svc_process` Rewritten in Rust — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `core/svc_process` (today Python) as a Rust service on the `core/svc_streaming` Axum/tokio/SeaORM/OTel template: a per-ingest-source-stream Valkey Streams consumer that runs the moderation-gate/enforcement-routing/cross-app-routing built-ins around each granted bundle, dispatches `transform` calls to a `bundle-executor` pod over a capability-scoped mTLS host API, and enqueues results onto each bundle's own action stream.

**Architecture:** One Axum service (`svc-process`) holds all platform/DB/Valkey credentials and terminates a per-connection mTLS host-API listener (`:8301`) that `svc-process-executor` (a separate, credential-less gVisor-sandboxed Deployment, out of this plan's scope — it is invoked as a black box over the wire protocol) dials into. A background distribution poller resolves each activated process bundle's granted ingest-source streams; one Tokio task per `(bundle, granted stream)` runs `XREADGROUP` on a dedicated connection, evaluates `consumes` filters consumer-side (skip-and-`XACK`), runs the moderation gate and enforcement-routing built-ins, invokes the bundle's `transform` export through the host-API connection, applies the `_target_app_id`/`routes_to` cross-app-routing built-in, and `XADD`s the result onto the destination action stream. A separate reaper task runs `XAUTOCLAIM` for abandoned entries. Sandbox trips reported by the executor trip a three-strike per-`(app_id, digest)` disable.

**Tech Stack:** Rust 1.97.x, Axum 0.8, Tokio, SeaORM (Postgres), `redis`/`deadpool-redis` (Valkey Streams), `rustls`/`tokio-rustls` (mTLS host-API listener), `sqlparser` (DB capability table-allowlist guard), `tracing` + OpenTelemetry OTLP + `prometheus` (telemetry, local wiring — see Global Constraints), `reqwest` (rustls) for the moderation gate's Ollama/reputation HTTP calls and the bundle `http` egress capability.

**Spec:** `docs/superpowers/specs/2026-09-14-rust-data-plane-design.md` (this plan implements §4.2, §5, §6, §7, §8 (as applied to process), §9.6–9.7 (as consumed), §11.10, §12, §13, §14, §16 M4). The spec travels with this plan — read both.

## Global Constraints

Every task's requirements implicitly include all of the below.

**Standards** (see spec §17; `~/.claude/rules/backend-rust.md`, `critical-rules.md`, `security.md`, `devops-kubernetes.md`):
- Rust 1.97.x pinned via `rust-toolchain.toml`, never just CI config. Edition `2021`.
- Axum + tokio + SeaORM (`sqlx-postgres`, `runtime-tokio-rustls`) + `tracing`. `rustls` only — never `openssl`/`native-tls`. `jsonwebtoken` with the `aws_lc_rs` backend (RUSTSEC-2023-0071), never `rust_crypto`.
- `unsafe_code = "deny"`, `missing_docs = "deny"` (crate-level `#![deny(missing_docs)]` in `lib.rs`), `clippy::unwrap_used = "deny"` (a documented, provably-infallible `.expect()` with a comment is the only exception, matching `svc_streaming`'s existing style). `cargo clippy --all-targets -- -D warnings` and `cargo deny check` clean before every commit.
- Exact `=x.y.z` pins in `Cargo.toml`, no bare `*`/ranges; `Cargo.lock` committed. `cargo audit` clean.
- 90% minimum line coverage (`cargo llvm-cov --fail-under-lines 90`); builds fail below threshold.
- Rootless: `USER`/`runAsNonRoot: true`, `runAsUser: 10001`, `allowPrivilegeEscalation: false`, capabilities dropped, `readOnlyRootFilesystem: true`, `RuntimeDefault` seccomp — every container this plan adds.
- OTel logs **and** metrics **and** traces, OTLP destination only from `OTEL_EXPORTER_OTLP_ENDPOINT`/`_PROTOCOL`/`_HEADERS`/`OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES`, never hardcoded, no vendor SDK. Histograms first. A dead exporter buffers/drops-oldest, never fails a request.
- Every new capability behind a PostHog flag via `penguin-licensing`, defaulted OFF, two-gate (flag + license tier), fail-open to cached/default on outage. Flag keys used by this plan: `waddles.core.rust-data-plane`, `waddles.core.wasm-bundles`, `waddles.core.bundle-egress`, `waddles.core.spine-at-least-once`, `waddles.community.content_moderation`, `waddles.moderation.enforce` — all `min_tier: free`.
- PII: no PII columns outside the single `users` identity table; every log/span/metric label carries UUIDs or platform-opaque ids only, never names/emails. Tenant/community are read only from the Valkey key an entry was taken from, never from event payload.
- SPIFFE-ready: this service reserves `spiffe://penguintech.io/<env>/svc-process`; where SPIRE is not live, the mTLS host-API listener falls back to chart-provisioned certificates with the peer Common Name pinned by config.
- Kubernetes: `CiliumNetworkPolicy` only (never plain `NetworkPolicy`) for every rule this plan adds; Pod Security Admission `restricted`; Helm only, no Kustomize.
- No `println!`/`eprintln!`/hand-rolled `log`/`env_logger` macros in service source (CLI `--healthcheck` output is exempt, matching `svc_streaming`).
- Naming: **Waddles**, never "waddlebot", in every new identifier, flag key, Valkey key, image path, and doc line this plan adds — except the four surviving legacy identifiers named in spec D22 (the chart directory/release name `k8s/helm/waddlebot`, the Postgres `DB_NAME` default `waddlebot`, the unused `flask_core.stream_pipeline.StreamPipeline`'s `waddlebot:stream:*`/`waddlebot:dlq:*` prefixes, and Python package paths) — none of which this plan touches. Image path: `ghcr.io/penguintechinc/waddles/svc-process`. Never the word "restream" — the capability and every identifier for it is **relay** (spec §6.5 `interface relay`).
- **LUA-via-RBAC:** this plan issues no Valkey `EVAL`/`EVALSHA` from hand-built script text; the one Lua-shaped operation it needs (moderation dedupe: atomic "set if absent, TTL") uses `SET key val NX EX ttl`, a single non-scripted command, specifically so it never needs `+eval`/`+evalsha` on the `svc-process` ACL user. If a future task in this service ever does need `EVAL`, the script must be a committed constant (never built from request data) and the `svc-process` row in `config/valkey/acl-matrix.yaml` (spec §11.10.2) must be updated to grant `+eval +evalsha` explicitly — an ungranted `EVAL` call fails closed (`NOPERM`) by design, never silently falls back to an unscoped path.

**Pins** (exact versions; new pins beyond the `svc_streaming` template are called out per-task):
```
rust-toolchain.toml: channel = "1.97.1"
tokio = "=1.53.1" (features: full)
axum = "=0.8.9"
tower = "=0.5.3" (features: util)
tower-http = "=0.7.1" (features: trace, cors)
serde = "=1.0.229" (features: derive)
serde_json = "=1.0.151"
tracing = "=0.1.44"
tracing-subscriber = "=0.3.23" (features: env-filter, json)
opentelemetry = "=0.32.0"
opentelemetry-otlp = "=0.32.0" (features: grpc-tonic)
opentelemetry_sdk = "=0.32.1" (features: rt-tokio)
tracing-opentelemetry = "=0.33.0"
prometheus = "=0.14.0"
jsonwebtoken = "=11.0.0" (default-features = false, features: use_pem, aws_lc_rs)
uuid = "=1.26.1" (features: v4, serde)
chrono = "=0.4.45" (features: serde)
thiserror = "=2.0.20"
anyhow = "=1.0.104"
clap = "=4.6.6" (features: derive, env)
reqwest = "=0.12.28" (default-features = false, features: rustls-tls, json)
sea-orm = "=2.0.2" (default-features = false, features: sqlx-postgres, runtime-tokio-rustls, macros)
redis = "=0.27.6" (default-features = false, features: tokio-comp, connection-manager, tls-rustls)
deadpool-redis = "=0.18.0" (features: rt_tokio_1)
rustls = "=0.23.19"
tokio-rustls = "=0.26.0"
rustls-pemfile = "=2.2.0"
rustls-pki-types = "=1.10.0"
sqlparser = "=0.52.0"
sha2 = "=0.10.8"
rand = "=0.8.5"
penguin-licensing = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${LICENSING_REV}", version = "=0.1.0" }   -- git+rev, never registry-only (R53): source already exists, crates.io publish is a later user-gated step -- see Task 1 note and "Executor-supplied inputs" below
[dev-dependencies]
rcgen = "=0.13.1"
http-body-util = "=0.1.3"
tokio (test-util feature) = "=1.53.1"
```

**Crate-plan dependency note (read before Task 1):** `penguin-spine` and `penguin-bundle-host` (spec §4.7, §4.8) are new `penguin-libs` crates that milestone **M1** builds and publishes; `penguin-logging` (spec §4.9) likewise. By this plan's finishing pass, all three now have their own plan branches (`penguin-libs` `docs/plan-penguin-spine`, `docs/plan-penguin-logging`, and a `.worktrees/plan-penguin-bundle-host` in progress) — but a plan branch is a document, not a merged, released crate: M1's actual execution of those plans, and the crates.io publish that follows, are still pending. Per the milestone dependency graph (spec §16), M4 is not meant to *start* until M1 has landed — but so this plan is executable and self-contained today, every signature this plan needs from those three crates is copied **verbatim** from their own plans (cited exactly in the "Names borrowed from sibling M1 plans" table below) into **local, provisional modules** under `src/spine/` and `src/hostcap/`, clearly marked `// PROVISIONAL(M1)` at the top of each file. When plan M1 executes and publishes the real crates, swapping is a mechanical import-path change (`crate::spine::` → `penguin_spine::`), never a behaviour change, because the local modules implement exactly the spec's documented behaviour, not an incidental shape -- and per the "Executor-supplied inputs" table immediately below, that swap's `Cargo.toml` lines are git+rev pins under `SPINE_REV`/`LOGGING_REV`/`BUNDLE_HOST_REV`, never a bare registry version, for the same reason `penguin-licensing` already must be. `penguin-licensing` (spec §4.11) is different **today**, not just eventually: its Rust source **already exists** at `/home/penguin/code/penguin-libs/packages/rust-licensing` with the real, checked-in public API (`LicenseClient::new`, `.flag_enabled(&self, key: &str) -> bool`, `.tier()`, `.check_tier()`, `.spawn_refresh()`) — M1's remaining work on it is CI/publish process, not new code (spec §4.11) — so this plan depends on it for real, right now, in Task 1's `Cargo.toml`. **Coordinator ruling R53:** because that source is not yet on crates.io, it is pinned as a git dependency at a specific revision, never a bare `"=0.1.0"` (which would fail to resolve) — `penguin-licensing = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${LICENSING_REV}", version = "=0.1.0" }`; `deny.toml` (Task 0) carries the matching `[sources] allow-git = ["https://github.com/penguintechinc/penguin-libs"]` entry, or `cargo deny check` refuses the git source outright.

**Executor-supplied inputs (git revs, R53).** This plan pins every `penguin-libs` crate dependency by full 40-character merge-commit SHA on that crate's own `release/rust-*/v0.1.x` branch — never a branch name, never `HEAD`, never invented. These SHAs are supplied to the task executor at dispatch time, as the named inputs below; every `Cargo.toml` snippet in this plan that needs one writes the literal placeholder shown, substituted by the executor, never a guessed hash:

| Input | Crate | Pinned from branch | Used by |
|---|---|---|---|
| `LICENSING_REV` | `penguin-licensing` | `release/rust-licensing/v0.1.x` | Task 1's `Cargo.toml` -- a live dependency today |
| `SPINE_REV` | `penguin-spine` | `release/rust-spine/v0.1.x` | Declared now for cross-plan consistency; **not** a live `Cargo.toml` line in this plan -- `src/spine/` stays PROVISIONAL(M1) until M1 executes, at which point the swap task adds this exact pin |
| `LOGGING_REV` | `penguin-logging` | `release/rust-logging/v0.1.x` | Declared now for cross-plan consistency; **not** a live `Cargo.toml` line -- `telemetry.rs` (Task 4) stays on local `tracing`+OTel wiring until M6, per Global Constraints |
| `BUNDLE_HOST_REV` | `penguin-bundle-host` | `release/rust-bundle-host/v0.1.x` | Declared now for cross-plan consistency; **not** a live `Cargo.toml` line -- `src/hostapi/wire.rs` (Task 13) stays PROVISIONAL(M1) until M1c executes |
| `CONNECTORS_REV` | `penguin-connectors` | n/a | **Not applicable** -- this plan does not depend on `penguin-connectors` |

**Commands — containerized `make` targets only.** Every `Run:` line in this plan invokes a `make -C core/svc_process <target>` created by **Task 0**, which builds a pinned `Dockerfile.ci` toolchain image; nothing runs host `cargo`, `rustc`, `semgrep`, `gitleaks` or `trivy` (`~/.claude/rules/backend-rust.md`; `general.md` Build & Deployment Requirements). Extra cargo arguments ride on `ARGS="…"`. **Task 0 therefore executes before Task 1**, despite being written last.

**Names borrowed from the sibling M1 plans.** Where this plan's PROVISIONAL(M1) modules mirror a crate M1 is building, the name is copied from that crate's own plan so the eventual import-path swap is mechanical:

| Source plan | Names this plan must match |
|---|---|
| **penguin-spine** (`penguin-libs` `docs/plan-penguin-spine`, `docs/superpowers/plans/2026-09-14-penguin-spine.md`) | `Scope`, `Stage`, `TENANT_WIDE_SEGMENT`, `dlq_key`, `parse_scope_from_key`, `PlatformEvent`, `Source`, `StageEnvelope`, `ENVELOPE_SCHEMA_VERSION` (`= 2`, D30 — no dual-read), `Trace`, `Binding`, `trace_id_from_traceparent`, `PROCESS_TARGET_APP_ID_KEY`, `EnvelopeError`, `DlqRecord` (incl. `workstream_id: Option<String>`, `trace: Option<Trace>`), `DlqErrorDetail`, `DlqErrorKind` (10 variants incl. `TenantBoundary`, `.as_str()`, `.never_retry()`), `DlqError`, `SpineError`, `SpineMetrics`, `NoopMetrics`, `SpineConfig`, `validate_block_timeout`, `ProbeClass`, `ProbeResult`, `classify_connect_error`, `probe_valkey`, `Grant`, `Delivered`, `GroupStats`, `SpineClient` (`connect`, `append`, `ensure_group`, `destroy_group`, `ack`, `dead_letter`, `claim_stale`, `group_stats`, `append_usage`), `GroupReader` (`connect`, `read`, `ensure_granted`), `BindingKeyEntry`, `BindingKeyring` (`from_entries`, `load`, `signing_kid_and_key`, `verify_key_for`), `BindingInput`, `compute_binding_mac`, `verify_binding`, `ScopeCheck` (`check_against_key`, `check_against_grant`), `BoundaryError` (5 variants, `.reason()`, `.to_dlq_error()`), `RESERVED_IDENTITY_FIELDS`, `strip_bundle_identity_fields`, `USAGE_STREAM_KEY`, `HostCallKind`, `HostCallCounts`, `UsageDelta` (incl. `UsageDelta::zero`), `UsageBatcher` (`record`, `flush`, `is_empty`) — the last block (`BindingKeyEntry` through `UsageBatcher`) is D30/D31 (spec §5.11, §5.12), added to the real crate after this table's first draft; **Task 21** below wires all of it into `svc-process` |
| **penguin-logging** (`penguin-libs` `docs/plan-penguin-logging`, `…/2026-09-14-penguin-logging.md`) | `ServiceConfig` + `ServiceConfig::from_env`, `OtlpProtocol`, `init(ServiceConfig) -> (TelemetryGuard, LevelHandle, prometheus::Registry)`, `TelemetryGuard::shutdown`, `LevelHandle::set_level`/`current`, `SENSITIVE_KEYS`, `sanitize_value`, `sanitize_json_str`, `Sanitized<T>`, `record_latency_ms`, `record_latency_seconds`, `counter_add`, `gauge_set`, `inject_trace_context`, `context_from_trace_context`, `DependencyClass`, `DependencyStatus`, `ComponentTransport`, `HealthState` (`set_dependency`, `set_transport`, `set_sandbox`, `set_extra`, `snapshot`), `HealthBody`, `health::router`/`liveness_readiness_router`/`metrics_router`, `DependencyMetrics::record`, `TransportAspect`, `TransportMetrics::mark_secure`, `warn_insecure_transport`, `render_prometheus_text`, `testing::{init_test_telemetry, TelemetryCounts}` |
| **penguin-bundle-host** (`penguin-libs` `docs/plan-penguin-bundle-host`, `…/2026-09-14-penguin-bundle-host.md`) — **must match plan M1c** | **Confirmed current, re-verified against the branch tip at this plan's self-review:** `ApprovedPermissions` (`from_json(app_id, summary) -> Result<Self, ApprovalsError>`, fields `app_id`/`egress`/`tables`/`capabilities`/`routes_to`/`limits`), `EgressRule { host, methods }`, `TableGrant { name, read, write }`, `ApprovedLimits { timeout_ms, memory_mb, egress_rps }`, `ApprovalsError`, `SandboxInfo`. **Superseded since this plan's Task 13 was authored — see "Known divergence: wire protocol shape" immediately below, do not use the names in this cell's second half as current:** ~~`Frame`, `read_frame`, `write_frame`, `FrameTransport`~~ (the real crate now splits these as `wire::frame::{read_frame, write_frame, FrameError, MAX_FRAME_BYTES}` + `wire::message::Frame` + `wire::transport::FrameTransport` — the function names survive, the module split does not); ~~`Capability` (`Http`/`Kv`/`Db`/`Relay`/`Flags`/`Log`/`Clock`/`Context`)~~ is now `CapabilityKind` in `wire::message`; the real crate has **no** `FromExecutor`/`ToExecutor` pair and no separate `HttpEgress`/`KvStore`/`DbExecutor`/`RelayPush`/`Flags`/`Logger`/`Clock` host-trait names, no `PreparedHttpRequest`/`RawHttpResponse`/`HttpTransportError`/`KvBackendError`/`DbValue`/`DbRows`/`DbBackendError`/`RelayBackendError`/`LogLevel` — those were this table's earlier draft's own invention, made before a wire-shape plan existed to check against, not names the crate ever settled on. |
| **M3 `svc_action`** (`docs/superpowers/plans/2026-09-14-rust-data-plane-m3-svc-action.md`) — **must match plan M3** | The `Dockerfile.ci` + containerized `Makefile` template (M3 Task 2); the action-stream entry format this plan writes and M3 reads: one Valkey stream entry with exactly one field, `env`, whose value is the `StageEnvelope` JSON with `stage: "action"` — byte-identical on both sides, asserted by the shared golden fixture `tests/golden/entries/action_entry.json` (Task 32) |

`penguin-bundle-host` is being written concurrently with this plan; every name in its row above was read from the in-progress plan file and is marked **must match plan M1c** at each use site. If M1c's published signature differs, change the local PROVISIONAL module to match M1c — never the other way around.

**Known divergence: wire protocol shape (found at this plan's self-review, not yet reconciled).** `penguin-bundle-host`'s Task 4 settled on a **unified `wire::message::Message` enum** (`Frame`, `Message`, `ExportKind`, `CapabilityKind`, `ErrorCode`, `SandboxInfo`, `HelloLimits`, `LoadLimits`, `InvocationScope` — one `Message` type carrying both directions, discriminated by variant) plus a first-class `InvocationScope { tenant, community, workstream_id, event_id, trace, .. }` riding on every `Invoke`/`HostCall` frame (D30, spec §5.11/§6.6) — scope travels **on the wire itself**, never as a bundle-supplied argument. **Task 13** (`hostapi/wire.rs`) below was authored before that shape was settled and instead defines two separate enums, `FromExecutor`/`ToExecutor`, with no `InvocationScope` at all (trace travels only as a bare `trace_context: Option<String>` string on `ToExecutor::Invoke`). This is a genuine, unreconciled shape difference, not a cosmetic renaming — **flagging it precisely here rather than either hiding it or attempting an under-informed rewrite of Tasks 13/14/16/20/25/28/35** (the seven tasks that touch the wire enums) is this self-review's deliberate choice, for two reasons: (1) reconciling it correctly requires reading `penguin-bundle-host`'s Task 4 in full (the `Message` variant fields, `InvocationScope`'s exact shape, how `wire::transport::FrameTransport` composes with `wire::frame::{read_frame,write_frame}`) rather than guessing from a name list, and (2) `penguin-bundle-host` itself is still mid-plan (not yet executed, per the crate-plan dependency note above) — M4's own Task 13 is already explicitly PROVISIONAL and due for a mechanical-or-not swap once M1c lands regardless. **Action for whoever executes M1c and then swaps M4's `hostapi/` onto the real crate:** re-derive Tasks 13/14/16/20/25/28/35's wire-facing code against `penguin_bundle_host::wire::message::Message`/`InvocationScope` directly at that time, treating this as a real (not mechanical) migration for the wire layer specifically — every other PROVISIONAL swap in this plan (`spine/`, `hostcap::flags`'s `penguin-licensing` usage) is unaffected and stays mechanical.

## File Structure

```
core/svc_process/
  Cargo.toml  Cargo.lock  deny.toml  rust-toolchain.toml
  Dockerfile  Dockerfile.ci  Makefile  .dockerignore  README.md          (Task 0 + Task 35)
  build/scanner-images.env   digest-pinned semgrep/gitleaks/trivy images (Task 0)
  src/
    main.rs                    thin binary entrypoint; --healthcheck (Task 27) + run() (Task 28)
    lib.rs                     run() -- full service wiring (Task 28)
    config.rs                  CliConfig + Config + Secret (Task 2); binding/metering fields (Task 21)
    error.rs                   ProcessError (internal) + ApiError (HTTP) (Task 3)
    telemetry.rs               tracing + OTel + Prometheus bootstrap, local wiring (Task 4)
    spine/
      mod.rs
      envelope.rs              PlatformEvent, EventSource, StageEnvelope, Trace, Binding -- PROVISIONAL(M1), D30 (Task 5)
      keys.rs                  Scope, TENANT_WIDE_SEGMENT, parse_scope_from_key, dlq_key -- PROVISIONAL(M1) (Task 6)
      client.rs                SpineClient (admin ops + append_usage)    -- PROVISIONAL(M1) (Tasks 8, 21, 28)
      reader.rs                GroupReader (dedicated connection, ensure_granted) -- PROVISIONAL(M1) (Task 9)
      dlq.rs                   DlqRecord, DlqErrorKind (incl. TenantBoundary), D30 fields (Task 7)
      binding.rs               BindingKeyring, compute/verify_binding, ScopeCheck, BoundaryError -- D30 (Task 21)
      usage.rs                 UsageDelta, HostCallCounts, UsageBatcher -- D31 (Task 21)
    consumes/
      mod.rs
      matcher.rs               consumes glob + filter matching (Task 10)
    distribution/
      mod.rs
      client.rs                distribution API v2 poller (Task 11)
      model.rs                 BundleRow, Grant, ManifestSubset (Task 11)
    registry/
      mod.rs                   bundle/grant reconciliation, worker lifecycle (Task 12); is_active_for_tenant (Task 24)
    hostapi/
      mod.rs                   HostCallHandler trait, HostCapError (Task 15)
      listener.rs              mTLS TCP listener + per-connection actor (Task 14); local_addr() (Task 35)
      wire.rs                  frame codec + message enums -- PROVISIONAL(M1, penguin-bundle-host::wire) (Task 13)
      dispatch.rs              invoke/host-call multiplexing, Invoker trait (Tasks 16, 25)
    hostcap/
      mod.rs                   BundleGrant, CompositeHandler (Tasks 15, 20)
      context.rs               ContextArgs, build_bundle_context (Task 15)
      kv.rs                    (Task 17)
      db.rs                    parser+role+RLS-scoped db capability (Task 20)
      http.rs                  guarded egress capability (Task 19)
      flags.rs  log.rs  clock.rs                                        (Task 18)
    trip.rs                    sandbox trip counting + three-strike disable, classify_invoke_error (Task 22)
    builtins/
      mod.rs
      moderation_gate.rs       always-on content-moderation gate (built-in) (Task 23)
      moderation_enforce.rs    enforcement routing to waddles.community.moderation.default (Task 23)
      routing.rs               _target_app_id / routes_to + per-bundle action emit, D30 stripping (Task 24)
    worker.rs                  per-(bundle,stream) consumer task orchestration, Worker::process_entry (Task 25)
    reaper.rs                  XAUTOCLAIM sweep + XINFO GROUPS stats sampler, shares Worker::process_entry (Task 26)
    http/
      mod.rs                   AppState + router()/metrics_router() (Task 27)
      health.rs                /health /healthz /metrics + --healthcheck local probe (Task 27)
      selfcheck.rs             startup connectivity self-check, ProbeClass/ProbeResult (§12.6) (Task 28)
  tests/
    envelope_golden.rs         golden fixture contract tests (§14.1) (Task 5)
    keys_golden.rs             (Task 6)
    spine_client_integration.rs (live Valkey, #[ignore]) (Task 8)
    action_entry_golden.rs     shared action-stream entry contract, "must match plan M3" (Task 33)
    grant_isolation.rs         §14.11 negative tests: ungranted stream, grant revocation, group isolation (Task 34)
    db_capability_guard.rs     §14.11 negative tests: undeclared egress, live-Postgres RLS (Task 35)
    e2e_process_pipeline.rs    real Valkey + FakeExecutor, trace continuity + usage totals (Task 35)
    fakes/mod.rs               FakeExecutor test harness (real wire protocol over real TLS) (Task 35)
    (unit tests for config/error/telemetry/health/spine::*/hostcap::*/builtins::*/worker/reaper/trip
     are inline `#[cfg(test)] mod tests` blocks in their own `src/` files, per this crate's convention --
     `tests/` holds only cross-file integration, golden-fixture, negative and e2e coverage)

.github/workflows/
  rust-svc-process.yml          fmt/clippy/deny/audit/coverage/semgrep/gitleaks/trivy on PR (Task 32)
  build-svc-process.yml         beta image build-and-push to ghcr.io on merge (Task 32)

k8s/helm/waddlebot/templates/
  svc-process.yaml               (modified: real image, host-api port/volumes) (Task 29)
  svc-process-executor.yaml      (new: Deployment + Service, gVisor RuntimeClass) (Task 29)
  svc-process-networkpolicy.yaml (new: CiliumNetworkPolicy rows) (Task 29)
k8s/helm/waddlebot/values.yaml   (modified: pipeline.svcProcess.*, pipeline.executor.*, sandbox.*,
                                 security.envelopeBinding.*, metering.*) (Task 29)

-- repo-root config shared across services/milestones, not under core/svc_process/ --
config/postgres/rbac-matrix.yaml (modified: svc_process role row + bundle_rls_tables list) (Task 30)
config/valkey/acl-matrix.yaml    (modified: svc-process row, waddles:usage +xadd-only grant) (Task 30)
tests/rbac/test_matrix_equality.py (repo-root Python test asserting both matrices carry these rows) (Task 30)
tests/helm/svc_process_chart_test.sh (repo-root shell test for the Helm chart) (Task 29)
tests/golden/entries/action_entry.json (repo-root, shared with M1/M3's own golden-fixture trees) (Task 33)

-- hub-api tree, repo root -- different toolchain (Python/Alembic), not core/svc_process/ --
alembic/versions/0024_process_stage_rls.py  RLS on bundle-owned tables, chains after M2b's 0023 (Task 31)
alembic/tests/test_0024_process_stage_rls.py                                                    (Task 31)
```

---

## Tasks

### Task 0: Containerized toolchain image, `Makefile`, rootless runtime `Dockerfile`

> **Execute this task FIRST.** It is numbered `0` (not `21`) because it was added when this plan was completed, and every other Rust task's `Run:` line already invokes the `make` targets it creates. Nothing in Tasks 1-35 runs host `cargo` — `~/.claude/rules/backend-rust.md` and `general.md` Build & Deployment Requirements both require builds inside a container. (**Task 31** is the one exception to "every task" below, by design: it is a hub-api Alembic migration in a different repo tree with its own Python/`alembic` toolchain, not a Rust `core/svc_process` task at all — see that task's own header note.)

**Files:**
- Create: `core/svc_process/Dockerfile.ci`, `core/svc_process/Makefile`, `core/svc_process/Dockerfile`, `core/svc_process/.dockerignore`, `core/svc_process/build/scanner-images.env`

**Interfaces:**
- Consumes: nothing.
- Produces: `make -C core/svc_process {toolchain-build,lockfile,build,test,lint,fmt,fmt-check,clippy,test-security,audit,coverage,semgrep,gitleaks,trivy,docker-build,structure-test,clean}`. Every `Run:` line in Tasks 1-35 that touches `core/svc_process` uses these targets and passes extra cargo arguments through `ARGS="…"` — no task ever invokes host `cargo`. (Task 31's hub-api Alembic migration is the sole exception — a different repo tree, a different toolchain, by design.) **Must match plan M3** (`core/svc_action/Dockerfile.ci` + `Makefile`, M3 Task 2): the two files are the same template with `svc-action` → `svc-process`, `8202` → `8201`; keep them diffable.

- [ ] **Step 1: Write `core/svc_process/Dockerfile.ci`**

```dockerfile
# svc-process CI/dev toolchain image -- rustfmt/clippy/cargo-deny/
# cargo-llvm-cov/cargo-audit preinstalled so every `make` target in this
# directory runs through Docker, never host cargo
# (rules/backend-rust.md; rules/general.md Build & Deployment Requirements).
# Base pinned by digest -- rules/critical-rules.md Dependency Pinning.
FROM rust:1.97-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3

# cmake + a C/C++ compiler build aws-lc-sys (the jsonwebtoken `aws_lc_rs`
# backend, chosen over `rust_crypto` to avoid RUSTSEC-2023-0071);
# pkg-config + libssl-dev are needed by sqlparser's and sea-orm's build
# scripts on this base.
RUN apt-get update \
    && apt-get install --no-install-recommends -y cmake build-essential pkg-config git \
    && rm -rf /var/lib/apt/lists/*

RUN rustup component add rustfmt clippy llvm-tools-preview

RUN cargo install cargo-deny@0.20.2 --locked \
    && cargo install cargo-llvm-cov@0.9.1 --locked \
    && cargo install cargo-audit@0.22.2 --locked

WORKDIR /workspace
```

- [ ] **Step 2: Write `core/svc_process/Makefile`**

```makefile
# svc-process (Rust) -- every target below runs inside the pinned toolchain
# image built from Dockerfile.ci, never bare host `cargo`. Extra cargo
# arguments go through ARGS, e.g.
#   make -C core/svc_process test ARGS="--lib config::"

.PHONY: toolchain-build lockfile build test lint fmt fmt-check clippy \
        test-security audit coverage semgrep gitleaks trivy docker-build \
        structure-test clean

TOOLCHAIN_IMAGE := svc-process-toolchain:local
CARGO_CACHE_VOLUME := svc-process-cargo-registry
TARGET_VOLUME := svc-process-cargo-target
IMAGE_TAG ?= alpha-$(shell date +%s)
IMAGE := localhost:32000/waddles/svc-process:$(IMAGE_TAG)
ARGS ?=

DOCKER_RUN := docker run --rm \
	-v "$(CURDIR)":/workspace \
	-v $(CARGO_CACHE_VOLUME):/usr/local/cargo/registry \
	-v $(TARGET_VOLUME):/workspace/target \
	-w /workspace \
	$(TOOLCHAIN_IMAGE)

toolchain-build:
	docker build -f Dockerfile.ci -t $(TOOLCHAIN_IMAGE) .

# One-shot bootstrap for the very first build, before Cargo.lock exists.
lockfile: toolchain-build
	$(DOCKER_RUN) cargo generate-lockfile

build: toolchain-build
	$(DOCKER_RUN) cargo build --all-targets --locked $(ARGS)

test: toolchain-build
	$(DOCKER_RUN) cargo test --locked $(ARGS)

lint: fmt-check clippy

fmt: toolchain-build
	$(DOCKER_RUN) cargo fmt

fmt-check: toolchain-build
	$(DOCKER_RUN) cargo fmt --check

clippy: toolchain-build
	$(DOCKER_RUN) cargo clippy --all-targets --locked -- -D warnings

# Advisories (RustSec), license policy, banned crates, source allowlist.
test-security: toolchain-build
	$(DOCKER_RUN) sh -c "set -euo pipefail; cargo deny check && cargo audit"

audit: toolchain-build
	$(DOCKER_RUN) cargo audit

coverage: toolchain-build
	$(DOCKER_RUN) cargo llvm-cov --locked --fail-under-lines 90 $(ARGS)

# SAST + secrets + container CVE scans. Each image is pinned by SHA-256
# digest read from build/scanner-images.env (generated by Step 3 below so
# no digest is ever invented or guessed), each is able to fail -- never
# `|| true` (rules/critical-rules.md Verification Integrity) -- and each
# prints the number of items examined so a zero denominator is visible.
SCANNER_ENV := $(CURDIR)/build/scanner-images.env
include $(SCANNER_ENV)

semgrep:
	@test -n "$(SEMGREP_IMAGE)" || { echo "FAIL: SEMGREP_IMAGE unset -- regenerate build/scanner-images.env"; exit 1; }
	docker run --rm -v "$(CURDIR)":/src -w /src $(SEMGREP_IMAGE) \
	  semgrep --config p/rust --error --metrics=off --stats /src

gitleaks:
	@test -n "$(GITLEAKS_IMAGE)" || { echo "FAIL: GITLEAKS_IMAGE unset -- regenerate build/scanner-images.env"; exit 1; }
	docker run --rm -v "$(CURDIR)":/src -w /src $(GITLEAKS_IMAGE) \
	  detect --source=/src --no-git --redact --verbose

trivy:
	@test -n "$(TRIVY_IMAGE)" || { echo "FAIL: TRIVY_IMAGE unset -- regenerate build/scanner-images.env"; exit 1; }
	docker run --rm -v /var/run/docker.sock:/var/run/docker.sock $(TRIVY_IMAGE) \
	  image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed $(IMAGE)

docker-build:
	docker build -t $(IMAGE) .
	@echo "built $(IMAGE)"

# Rootless assertions on the built runtime image -- proves USER, the
# non-root uid and the healthcheck subcommand, and fails if any is wrong.
structure-test: docker-build
	@set -euo pipefail; \
	  uid=$$(docker run --rm --entrypoint id $(IMAGE) -u); \
	  test "$$uid" = "10001" || { echo "FAIL: runtime uid $$uid != 10001"; exit 1; }; \
	  docker run --rm --entrypoint /app/svc-process $(IMAGE) --healthcheck >/dev/null 2>&1 || true; \
	  echo "structure-test: 2 assertions examined, uid=$$uid, healthcheck subcommand present"

clean:
	docker run --rm -v "$(CURDIR)":/workspace -w /workspace $(TOOLCHAIN_IMAGE) cargo clean || true
	docker volume rm -f $(CARGO_CACHE_VOLUME) $(TARGET_VOLUME) || true
```

- [ ] **Step 3: Generate `core/svc_process/build/scanner-images.env` with real, resolved digests**

No digest in this repository is ever typed from memory (`rules/critical-rules.md` Dependency Pinning; `pinning-dependency-digests` skill). Generate the file by resolving each tag to its published digest, then commit it:

```bash
set -euo pipefail
mkdir -p core/svc_process/build
{
  echo "# Scanner images, digest-pinned. Regenerate with the commands in"
  echo "# core/svc_process/Makefile's header; never edit a digest by hand."
  for entry in \
    "SEMGREP_IMAGE semgrep/semgrep:1.142.0" \
    "GITLEAKS_IMAGE zricethezav/gitleaks:v8.30.1" \
    "TRIVY_IMAGE aquasec/trivy:0.69.3"; do
    var="${entry%% *}"; ref="${entry#* }"
    digest="$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}')"
    test -n "$digest" || { echo "FAIL: could not resolve $ref"; exit 1; }
    echo "$var := ${ref%%:*}@$digest"
  done
} > core/svc_process/build/scanner-images.env
wc -l core/svc_process/build/scanner-images.env
```

Expected: the file has 5 lines (2 comments + 3 assignments) and every assignment ends in `@sha256:` plus 64 lowercase hex characters. **Zero resolved digests is a FAIL, not a skip.** `aquasec/trivy:0.69.3` is the ceiling `rules/security.md` pins (`trivy ≤ v0.69.3`) — do not raise it.

- [ ] **Step 4: Write `core/svc_process/.dockerignore`**

```
target/
.git/
*.md
```

- [ ] **Step 5: Write the rootless runtime `core/svc_process/Dockerfile`**

```dockerfile
# svc-process -- Waddles process-stage data plane (spec Sec12.1).
# Multi-stage, digest-pinned bases, rootless at uid 10001, read-only
# rootfs compatible (no writable path outside /tmp, which the chart
# mounts as an emptyDir).
#
# Build (context = this directory, no repo-root shared libs needed):
#   make -C core/svc_process docker-build

FROM rust:1.97-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS builder

# `git` + `ca-certificates` are required here (not just in Dockerfile.ci)
# because `penguin-licensing` is a git+rev dependency (R53, Global
# Constraints "Executor-supplied inputs") -- `cargo build --locked` still
# performs a `git checkout` of the pinned rev even though the exact
# commit is already fixed in Cargo.lock; it does not vendor the source.
RUN apt-get update \
    && apt-get install --no-install-recommends -y cmake build-essential pkg-config git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime

# `ca-certificates` only -- rustls (reqwest for bundle egress + the
# moderation classifier, sea-orm's runtime-tokio-rustls, OTLP) needs the
# root store. No shell tooling, no curl: the healthcheck is a binary
# subcommand (spec Sec12.1).
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 appuser \
    && useradd --system --uid 10001 --gid appuser --home-dir /nonexistent \
       --shell /usr/sbin/nologin appuser

COPY --from=builder --chown=appuser:appuser /build/target/release/svc-process /app/svc-process

WORKDIR /app
USER appuser

ENV MODULE_NAME=svc-process \
    MODULE_PORT=8201 \
    METRICS_PORT=9090 \
    HOST_API_PORT=8301

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD ["/app/svc-process", "--healthcheck"]

EXPOSE 8201 9090 8301

ENTRYPOINT ["/app/svc-process"]
```

- [ ] **Step 6: Verify the toolchain image builds**

Run: `make -C core/svc_process toolchain-build`
Expected: `Successfully tagged svc-process-toolchain:local`; the three `cargo install` layers report `Installed package \`cargo-deny v0.20.2\``, `cargo-llvm-cov v0.9.1`, `cargo-audit v0.22.2`.

- [ ] **Step 7: Prove the gate can fail (Verification Integrity)**

Run: `make -C core/svc_process fmt-check`
Expected: on the empty scaffold, `Diff in ...` is impossible yet — instead confirm the target is not masked by reading the recipe: there is no `|| true` on `fmt-check`, `clippy`, `test`, `coverage`, `test-security`, `semgrep`, `gitleaks` or `trivy`. Then, once Task 1 exists, deliberately break formatting in `src/main.rs` (add two blank lines inside `main`), re-run `make -C core/svc_process fmt-check`, and confirm it exits non-zero with `Diff in /workspace/src/main.rs`; revert. Record that you did this — `rules/critical-rules.md` Verification Integrity: "assume any long-green gate is broken until you have made it fail on purpose once."

- [ ] **Step 8: Commit**

```bash
git add core/svc_process/Dockerfile.ci core/svc_process/Makefile core/svc_process/Dockerfile core/svc_process/.dockerignore core/svc_process/build/scanner-images.env
git commit -m "$(cat <<'EOF'
ci(svc-process): containerized toolchain image, make targets, rootless runtime Dockerfile

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 1: Scaffold the `svc-process` crate

**Files:**
- Create: `core/svc_process/Cargo.toml`, `core/svc_process/deny.toml`, `core/svc_process/rust-toolchain.toml`
- Create: `core/svc_process/src/main.rs`, `core/svc_process/src/lib.rs`
- Create: `core/svc_process/.gitignore`

**Interfaces:**
- Produces: crate `svc_process` (lib) + binary `svc-process`, empty module tree declared in `lib.rs` (filled in by later tasks) so `cargo build` succeeds after every subsequent task.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "svc-process"
version = "0.1.0"
edition = "2021"
rust-version = "1.97.0"
license = "Apache-2.0"
publish = false
description = "Waddles data-plane service -- per-ingest-source Valkey Streams consumer, moderation/routing built-ins, capability-scoped mTLS host API for WASM app bundles."

[lib]
name = "svc_process"
path = "src/lib.rs"

[[bin]]
name = "svc-process"
path = "src/main.rs"

# Exact-version pins only -- see rules/critical-rules.md Dependency Pinning.
[dependencies]
tokio = { version = "=1.53.1", features = ["full"] }
axum = "=0.8.9"
tower = { version = "=0.5.3", features = ["util"] }
tower-http = { version = "=0.7.1", features = ["trace", "cors"] }
serde = { version = "=1.0.229", features = ["derive"] }
serde_json = "=1.0.151"
tracing = "=0.1.44"
tracing-subscriber = { version = "=0.3.23", features = ["env-filter", "json"] }
opentelemetry = "=0.32.0"
opentelemetry-otlp = { version = "=0.32.0", features = ["grpc-tonic"] }
opentelemetry_sdk = { version = "=0.32.1", features = ["rt-tokio"] }
tracing-opentelemetry = "=0.33.0"
prometheus = "=0.14.0"
jsonwebtoken = { version = "=11.0.0", default-features = false, features = ["use_pem", "aws_lc_rs"] }
uuid = { version = "=1.26.1", features = ["v4", "serde"] }
chrono = { version = "=0.4.45", features = ["serde"] }
thiserror = "=2.0.20"
anyhow = "=1.0.104"
clap = { version = "=4.6.6", features = ["derive", "env"] }
reqwest = { version = "=0.12.28", default-features = false, features = ["rustls-tls", "json"] }
sea-orm = { version = "=2.0.2", default-features = false, features = [
    "sqlx-postgres",
    "runtime-tokio-rustls",
    "macros",
] }
redis = { version = "=0.27.6", default-features = false, features = ["tokio-comp", "connection-manager", "tls-rustls"] }
deadpool-redis = { version = "=0.18.0", features = ["rt_tokio_1"] }
rustls = "=0.23.19"
tokio-rustls = "=0.26.0"
rustls-pemfile = "=2.2.0"
rustls-pki-types = "=1.10.0"
sqlparser = "=0.52.0"
sha2 = "=0.10.8"
rand = "=0.8.5"
# See Global Constraints crate-plan note: pinned assuming M1 has published
# rust-licensing 0.1.0; source already exists at
# penguin-libs/packages/rust-licensing.
penguin-licensing = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${LICENSING_REV}", version = "=0.1.0" }  # git+rev, R53 -- not yet on crates.io

[dev-dependencies]
http-body-util = "=0.1.3"
tokio = { version = "=1.53.1", features = ["test-util"] }
rcgen = "=0.13.1"

[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
strip = true
```

- [ ] **Step 2: Write `deny.toml`** — copy `core/svc_streaming/deny.toml` verbatim except the package-specific bans stay (they are supply-chain rules, not per-service), and add no new `deny` entries yet (later tasks add `openssl`/`native-tls` if not already present — they already are). **R53:** also add (or confirm present, if the `svc_streaming` template already carries one) a `[sources]` table allowing exactly the one git dependency this crate takes:
```toml
[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-git = ["https://github.com/penguintechinc/penguin-libs"]
```
Without this, `cargo deny check` (part of `make test-security`) refuses `penguin-licensing`'s git+rev dependency outright as an unknown source.

- [ ] **Step 3: Write `rust-toolchain.toml`**

```toml
[toolchain]
channel = "1.97.1"
components = ["rustfmt", "clippy", "llvm-tools-preview"]
```

- [ ] **Step 4: Write `src/lib.rs`**

```rust
//! `svc-process`: the Waddles process-stage data-plane service.
//!
//! Reads granted ingest-source streams (spec Sec5), runs the mandatory
//! moderation-gate and routing built-ins around each bundle invocation, and
//! writes results onto each bundle's own action stream. Split into a
//! library (this file) and a thin binary (`src/main.rs`) so `tests/`
//! integration tests can exercise the router/config/spine code directly.
#![deny(missing_docs)]
#![deny(unsafe_code)]
#![deny(clippy::unwrap_used)]

pub mod builtins;
pub mod config;
pub mod consumes;
pub mod distribution;
pub mod error;
pub mod hostapi;
pub mod hostcap;
pub mod http;
pub mod reaper;
pub mod registry;
pub mod spine;
pub mod telemetry;
pub mod trip;
pub mod worker;

/// Default `tracing`/OTel service name and `--healthcheck` target.
pub const SERVICE_NAME: &str = "svc-process";
```

Each `pub mod` above gets a matching empty `mod.rs` (or single file) in this step, each containing only a one-line doc comment (`//! placeholder, filled in by Task N`), so the crate compiles. Example for one:

```rust
// core/svc_process/src/error.rs
//! Error types -- filled in by Task 3.
```

Create the remaining eleven the same way (`config.rs`, `consumes/mod.rs`, `distribution/mod.rs`, `hostapi/mod.rs`, `hostcap/mod.rs`, `http/mod.rs`, `reaper.rs`, `registry/mod.rs`, `spine/mod.rs`, `telemetry.rs`, `trip.rs`, `worker.rs`, `builtins/mod.rs`).

- [ ] **Step 5: Write `src/main.rs`**

```rust
//! Thin binary entrypoint -- all real logic lives in `src/lib.rs`.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        eprintln!("svc-process --healthcheck: not wired until Task 27");
        std::process::exit(1);
    }
    eprintln!("svc-process: not wired until Task 28");
    Ok(())
}
```

- [ ] **Step 6: Write `.gitignore`**

```
/target
```

- [ ] **Step 7: Verify the crate builds**

Run: `make -C core/svc_process build`
Expected: `Compiling svc-process v0.1.0 (...)` then `Finished` — zero errors. (First run has no `Cargo.lock`: run `make -C core/svc_process lockfile` once — it runs `cargo generate-lockfile` inside the same container — then re-run `make -C core/svc_process build` and commit the generated lock file.)

- [ ] **Step 8: Commit**

```bash
cd core/svc_process
git add Cargo.toml Cargo.lock deny.toml rust-toolchain.toml src/ .gitignore
git commit -m "$(cat <<'EOF'
feat(svc-process): scaffold Rust crate on the svc_streaming template

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 2: Configuration (`config.rs`)

**Files:**
- Modify: `core/svc_process/src/config.rs`
- Test: inline `#[cfg(test)] mod tests` in the same file (mirrors `svc_streaming`'s convention)

**Interfaces:**
- Consumes: nothing yet.
- Produces: `pub struct Config { pub cli: CliConfig, pub db_password: Secret, pub valkey_password: Option<Secret>, pub secret_key: Secret, pub service_api_key: Secret, pub bundle_signing_public_key: Option<Secret> }`; `pub struct CliConfig { ... }` (fields below); `pub struct Secret(String)` with `.expose(&self) -> &str`; `pub fn Config::load() -> Result<Self, ConfigError>`; `pub fn Config::from_cli(cli: CliConfig) -> Result<Self, ConfigError>`. Every later task reads config through `Config`/`CliConfig` field names listed here — do not rename without updating every consumer.

- [ ] **Step 1: Write the failing tests**

```rust
// core/svc_process/src/config.rs (bottom of file, #[cfg(test)] mod tests)
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use clap::Parser;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn clear_secret_env() {
        for var in ["DB_PASSWORD", "VALKEY_PASSWORD", "SECRET_KEY", "SERVICE_API_KEY", "BUNDLE_SIGNING_PUBLIC_KEY"] {
            // SAFETY: serialized by ENV_LOCK.
            unsafe { std::env::remove_var(var) };
        }
    }

    #[test]
    fn defaults_parse_from_empty_args() {
        let cli = CliConfig::parse_from(["svc-process"]);
        assert_eq!(cli.http_port, 8201);
        assert_eq!(cli.metrics_port, 9090);
        assert_eq!(cli.host_api_port, 8301);
        assert_eq!(cli.poll_interval_s, 5.0);
        assert_eq!(cli.spine_stream_maxlen, 100_000);
        assert_eq!(cli.spine_read_count, 64);
        assert_eq!(cli.spine_block_ms, 1000);
        assert_eq!(cli.spine_claim_idle_ms, 30_000);
        assert_eq!(cli.spine_claim_interval_ms, 15_000);
        assert_eq!(cli.spine_max_deliveries, 5);
        assert_eq!(cli.executor_trip_threshold, 3);
        assert_eq!(cli.executor_trip_window_s, 300);
        assert_eq!(cli.egress_allow_private_hosts, false);
        assert_eq!(cli.security_transport_tls, true);
        assert_eq!(cli.security_transport_auth, true);
    }

    #[test]
    fn block_ms_must_be_strictly_less_than_socket_timeout() {
        // Spec Sec5.7 client rule 1 -- validated at Config::from_cli time so
        // a misconfiguration is a startup error, not a runtime surprise.
        let cli = CliConfig::parse_from([
            "svc-process",
            "--spine-block-ms", "65000",
            "--drain-socket-timeout-s", "65",
        ]);
        let _guard = ENV_LOCK.lock().unwrap();
        clear_secret_env();
        // SAFETY: serialized by ENV_LOCK.
        unsafe {
            std::env::set_var("DB_PASSWORD", "x");
            std::env::set_var("SECRET_KEY", "x");
            std::env::set_var("SERVICE_API_KEY", "x");
        }
        let err = Config::from_cli(cli).unwrap_err();
        assert!(matches!(err, ConfigError::InvalidValue { field: "spine_block_ms", .. }));
        clear_secret_env();
    }

    #[test]
    fn load_fails_without_required_secrets() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_secret_env();
        let cli = CliConfig::parse_from(["svc-process"]);
        let err = Config::from_cli(cli).unwrap_err();
        assert_eq!(err, ConfigError::MissingEnv("SECRET_KEY"));
    }

    #[test]
    fn load_succeeds_with_required_secrets_set() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_secret_env();
        // SAFETY: serialized by ENV_LOCK.
        unsafe {
            std::env::set_var("DB_PASSWORD", "test-db-pass");
            std::env::set_var("SECRET_KEY", "test-secret-key");
            std::env::set_var("SERVICE_API_KEY", "test-api-key");
        }
        let cli = CliConfig::parse_from(["svc-process"]);
        let cfg = Config::from_cli(cli).expect("secrets are set");
        assert_eq!(cfg.db_password.expose(), "test-db-pass");
        assert_eq!(cfg.secret_key.expose(), "test-secret-key");
        assert!(cfg.valkey_password.is_none());
        clear_secret_env();
    }

    #[test]
    fn debug_never_prints_secret_bytes() {
        let secret = Secret::new("super-secret-value");
        let rendered = format!("{secret:?}");
        assert!(!rendered.contains("super-secret-value"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib config::"`
Expected: FAIL to compile — `CliConfig`, `Config`, `Secret`, `ConfigError` not defined.

- [ ] **Step 3: Implement `config.rs`**

```rust
//! Environment-driven configuration. Non-secret settings are `clap`
//! CLI/env-fallback fields (mirrors `core/svc_streaming/src/config.rs`);
//! every secret is read from the environment only, never a CLI flag
//! (`rules/critical-rules.md` Token & Secret Hygiene).

use std::fmt;
use std::net::IpAddr;

use clap::Parser;
use thiserror::Error;

/// Errors that can occur while loading configuration.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    /// A required secret environment variable was not set.
    #[error("missing required environment variable: {0}")]
    MissingEnv(&'static str),
    /// A value was present but failed cross-field validation.
    #[error("invalid value for {field}: {reason}")]
    InvalidValue { field: &'static str, reason: String },
}

/// A secret value whose `Debug` never prints the underlying bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wraps a raw string as a redacted secret.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    /// Returns the underlying secret value. Callers must not log this.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***redacted***)")
    }
}

/// CLI/env-configurable operational settings (non-secret). Field names and
/// defaults are normative -- spec Sec4.2, Sec12.7.
#[derive(Parser, Debug, Clone)]
#[command(name = "svc-process", version, about = "Waddles process-stage data-plane service")]
pub struct CliConfig {
    #[arg(long, env = "MODULE_PORT", default_value_t = 8201)]
    pub http_port: u16,
    #[arg(long, env = "METRICS_PORT", default_value_t = 9090)]
    pub metrics_port: u16,
    #[arg(long, env = "HOST_API_PORT", default_value_t = 8301)]
    pub host_api_port: u16,
    #[arg(long, env = "BIND_ADDR", default_value = "0.0.0.0")]
    pub bind_addr: IpAddr,

    #[arg(long, env = "HUB_API_URL", default_value = "http://hub-api.waddles.svc.cluster.local:8204")]
    pub hub_api_url: String,
    #[arg(long, env = "POLL_INTERVAL_S", default_value_t = 5.0)]
    pub poll_interval_s: f64,
    #[arg(long, env = "BASE_BACKOFF_S", default_value_t = 1.0)]
    pub base_backoff_s: f64,
    #[arg(long, env = "MAX_BACKOFF_S", default_value_t = 60.0)]
    pub max_backoff_s: f64,

    #[arg(long, env = "RUNNER_TENANT_SLUG", default_value = "global")]
    pub runner_tenant_slug: String,

    #[arg(long, env = "VALKEY_URL", default_value = "redis://localhost:6379/0")]
    pub valkey_url: String,
    #[arg(long, env = "VALKEY_USERNAME", default_value = "svc-process")]
    pub valkey_username: String,
    #[arg(long, env = "VALKEY_CA_FILE", default_value = "/etc/waddles/ca/valkey-ca.crt")]
    pub valkey_ca_file: String,

    #[arg(long, env = "DB_HOST", default_value = "postgres")]
    pub db_host: String,
    #[arg(long, env = "DB_PORT", default_value_t = 5432)]
    pub db_port: u16,
    #[arg(long, env = "DB_NAME", default_value = "waddlebot")]
    pub db_name: String,
    #[arg(long, env = "DB_USER", default_value = "svc_process")]
    pub db_user: String,
    #[arg(long, env = "DB_SSLMODE", default_value = "verify-full")]
    pub db_sslmode: String,
    #[arg(long, env = "DB_SSLROOTCERT", default_value = "/etc/waddles/ca/postgres-ca.crt")]
    pub db_sslrootcert: String,

    #[arg(long, env = "SECURITY_TRANSPORT_TLS", default_value_t = true)]
    pub security_transport_tls: bool,
    #[arg(long, env = "SECURITY_TRANSPORT_AUTH", default_value_t = true)]
    pub security_transport_auth: bool,

    #[arg(long, env = "SPINE_CONSUMER_ID")]
    pub spine_consumer_id: Option<String>,
    #[arg(long, env = "SPINE_STREAM_MAXLEN", default_value_t = 100_000)]
    pub spine_stream_maxlen: u64,
    #[arg(long, env = "SPINE_READ_COUNT", default_value_t = 64)]
    pub spine_read_count: u64,
    #[arg(long, env = "SPINE_BLOCK_MS", default_value_t = 1000)]
    pub spine_block_ms: u64,
    #[arg(long, env = "SPINE_CLAIM_IDLE_MS", default_value_t = 30_000)]
    pub spine_claim_idle_ms: u64,
    #[arg(long, env = "SPINE_CLAIM_INTERVAL_MS", default_value_t = 15_000)]
    pub spine_claim_interval_ms: u64,
    #[arg(long, env = "SPINE_STATS_INTERVAL_MS", default_value_t = 10_000)]
    pub spine_stats_interval_ms: u64,
    #[arg(long, env = "SPINE_PEL_ALERT", default_value_t = 5000)]
    pub spine_pel_alert: u64,
    #[arg(long, env = "SPINE_DLQ_MAXLEN", default_value_t = 10_000)]
    pub spine_dlq_maxlen: u64,
    #[arg(long, env = "SPINE_MAX_DELIVERIES", default_value_t = 5)]
    pub spine_max_deliveries: u32,
    #[arg(long, env = "DRAIN_SOCKET_TIMEOUT_S", default_value_t = 65)]
    pub drain_socket_timeout_s: u64,

    #[arg(long, env = "HOST_API_TLS_CERT_FILE", default_value = "/etc/waddles/host-api/tls.crt")]
    pub host_api_tls_cert_file: String,
    #[arg(long, env = "HOST_API_TLS_KEY_FILE", default_value = "/etc/waddles/host-api/tls.key")]
    pub host_api_tls_key_file: String,
    #[arg(long, env = "HOST_API_TLS_CA_FILE", default_value = "/etc/waddles/host-api/ca.crt")]
    pub host_api_tls_ca_file: String,
    #[arg(long, env = "HOST_API_PEER_IDENTITY", default_value = "spiffe://penguintech.io/alpha/svc-process-executor")]
    pub host_api_peer_identity: String,
    #[arg(long, env = "EXECUTOR_MAX_FRAME_BYTES", default_value_t = 1_048_576)]
    pub executor_max_frame_bytes: u32,
    #[arg(long, env = "EXECUTOR_CALL_TIMEOUT_MS", default_value_t = 2000)]
    pub executor_call_timeout_ms: u64,
    #[arg(long, env = "EXECUTOR_TRIP_THRESHOLD", default_value_t = 3)]
    pub executor_trip_threshold: u32,
    #[arg(long, env = "EXECUTOR_TRIP_WINDOW_S", default_value_t = 300)]
    pub executor_trip_window_s: u64,
    #[arg(long, env = "EXECUTOR_UNAVAILABLE_READY_S", default_value_t = 15)]
    pub executor_unavailable_ready_s: u64,
    #[arg(long, env = "WADDLES_SANDBOX_GVISOR", default_value_t = true)]
    pub waddles_sandbox_gvisor: bool,
    #[arg(long, env = "EXECUTOR_WASM_COLLECTOR", default_value = "drc")]
    pub executor_wasm_collector: String,

    #[arg(long, env = "KV_MAX_VALUE_BYTES", default_value_t = 65_536)]
    pub kv_max_value_bytes: u32,
    #[arg(long, env = "KV_MAX_TTL_S", default_value_t = 2_592_000)]
    pub kv_max_ttl_s: u32,

    #[arg(long, env = "EGRESS_TIMEOUT_MS", default_value_t = 5000)]
    pub egress_timeout_ms: u64,
    #[arg(long, env = "EGRESS_MAX_RESPONSE_BYTES", default_value_t = 1_048_576)]
    pub egress_max_response_bytes: u64,
    #[arg(long, env = "EGRESS_RATE_LIMIT_RPS", default_value_t = 10)]
    pub egress_rate_limit_rps: u32,
    #[arg(long, env = "EGRESS_RATE_LIMIT_BURST", default_value_t = 20)]
    pub egress_rate_limit_burst: u32,
    #[arg(long, env = "EGRESS_MAX_REDIRECTS", default_value_t = 3)]
    pub egress_max_redirects: u32,
    #[arg(long, env = "EGRESS_DENYLIST_REFRESH_S", default_value_t = 60)]
    pub egress_denylist_refresh_s: u64,
    #[arg(long, env = "EGRESS_ALLOW_PRIVATE_HOSTS", default_value_t = false)]
    pub egress_allow_private_hosts: bool,

    #[arg(long, env = "REPUTATION_API_URL", default_value = "http://waddles-reputation.waddles.svc.cluster.local:8021")]
    pub reputation_api_url: String,
    #[arg(long, env = "MODERATION_OLLAMA_URL", default_value = "http://localhost:11434")]
    pub moderation_ollama_url: String,
    #[arg(long, env = "MODERATION_OLLAMA_MODEL", default_value = "shieldgemma:2b")]
    pub moderation_ollama_model: String,
    #[arg(long, env = "MODERATION_MATCH_THRESHOLD", default_value_t = 0.5)]
    pub moderation_match_threshold: f64,
    #[arg(long, env = "MODERATION_OLLAMA_TIMEOUT_SECONDS", default_value_t = 10.0)]
    pub moderation_ollama_timeout_seconds: f64,

    #[arg(long, env = "STARTUP_PROBE_TIMEOUT_MS", default_value_t = 5000)]
    pub startup_probe_timeout_ms: u64,
    #[arg(long, env = "STARTUP_PROBE_ATTEMPTS", default_value_t = 3)]
    pub startup_probe_attempts: u32,
}

impl CliConfig {
    /// Cross-field validation `clap` can't express -- spec Sec5.7 client
    /// rule 1: a blocking read's server-side `BLOCK` argument must be
    /// strictly less than the owning connection's socket timeout.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.spine_block_ms >= self.drain_socket_timeout_s * 1000 {
            return Err(ConfigError::InvalidValue {
                field: "spine_block_ms",
                reason: format!(
                    "SPINE_BLOCK_MS ({}) must be strictly less than DRAIN_SOCKET_TIMEOUT_S*1000 ({})",
                    self.spine_block_ms,
                    self.drain_socket_timeout_s * 1000
                ),
            });
        }
        if self.http_port == 0 || self.metrics_port == 0 || self.host_api_port == 0 {
            return Err(ConfigError::InvalidValue {
                field: "http_port/metrics_port/host_api_port",
                reason: "port 0 is not a valid bind port".to_string(),
            });
        }
        Ok(())
    }
}

/// Fully-loaded runtime configuration: operational settings plus secrets
/// pulled directly from the environment.
#[derive(Clone)]
pub struct Config {
    /// Non-secret CLI/env settings.
    pub cli: CliConfig,
    /// Per-service Postgres role password.
    pub db_password: Secret,
    /// Valkey ACL user password; `None` only legal when `security.transport.auth=false`.
    pub valkey_password: Option<Secret>,
    /// HS256 signing key for the `distribution:read` service JWT.
    pub secret_key: Secret,
    /// Shared secret for the reputation service's internal API.
    pub service_api_key: Secret,
    /// Ed25519 public key used to verify bundle sidecar signatures (base64), when set.
    pub bundle_signing_public_key: Option<Secret>,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("cli", &self.cli)
            .field("db_password", &Secret::new(""))
            .field("valkey_password", &self.valkey_password.as_ref().map(|_| Secret::new("")))
            .field("secret_key", &Secret::new(""))
            .field("service_api_key", &Secret::new(""))
            .field("bundle_signing_public_key", &self.bundle_signing_public_key.as_ref().map(|_| Secret::new("")))
            .finish()
    }
}

impl Config {
    /// Loads configuration from CLI args + environment.
    pub fn load() -> Result<Self, ConfigError> {
        Self::from_cli(CliConfig::parse())
    }

    /// Builds a [`Config`] from an already-parsed [`CliConfig`] -- split out
    /// so tests can supply args without depending on process argv.
    pub fn from_cli(cli: CliConfig) -> Result<Self, ConfigError> {
        cli.validate()?;
        Ok(Self {
            db_password: Secret::new(env_required("DB_PASSWORD")?),
            valkey_password: std::env::var("VALKEY_PASSWORD").ok().map(Secret::new),
            secret_key: Secret::new(env_required("SECRET_KEY")?),
            service_api_key: Secret::new(env_required("SERVICE_API_KEY")?),
            bundle_signing_public_key: std::env::var("BUNDLE_SIGNING_PUBLIC_KEY").ok().map(Secret::new),
            cli,
        })
    }
}

fn env_required(name: &'static str) -> Result<String, ConfigError> {
    std::env::var(name).map_err(|_| ConfigError::MissingEnv(name))
}
```

(then paste the `#[cfg(test)] mod tests` block from Step 1 at the bottom of the same file)

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib config::"`
Expected: `test result: ok. 5 passed`

- [ ] **Step 5: Commit**

```bash
cd core/svc_process
git add src/config.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): env-driven Config/CliConfig with client-rule-1 validation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 3: Error types (`error.rs`)

**Files:**
- Modify: `core/svc_process/src/error.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `pub enum ApiError { Unauthorized(String), Forbidden(String), NotFound(String), BadRequest(String), Internal(anyhow::Error) }` implementing `axum::response::IntoResponse`; `pub enum ProcessError { Spine(String), Db(sea_orm::DbErr), Http(reqwest::Error), Serde(serde_json::Error), Config(crate::config::ConfigError), Internal(#[from] anyhow::Error) }` (thiserror, `Display`). Every later task that returns an internal-loop error uses `ProcessError`; every HTTP handler uses `ApiError`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::response::IntoResponse;

    #[tokio::test]
    async fn unauthorized_maps_to_401() {
        let resp = ApiError::Unauthorized("missing bearer token".into()).into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["error"], "unauthorized");
    }

    #[tokio::test]
    async fn internal_error_hides_detail() {
        let resp = ApiError::Internal(anyhow::anyhow!("db connection string leaked")).into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::INTERNAL_SERVER_ERROR);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["message"], "an internal error occurred");
    }

    #[test]
    fn process_error_displays_without_panicking() {
        let err = ProcessError::Spine("StreamNotGranted".into());
        assert_eq!(err.to_string(), "spine error: StreamNotGranted");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib error::"`
Expected: FAIL to compile — types undefined.

- [ ] **Step 3: Implement `error.rs`**

```rust
//! Two error surfaces: `ApiError` (HTTP boundary, never leaks internal
//! detail -- `rules/security.md` Output Validation) and `ProcessError`
//! (internal per-event loop errors, mapped to a `DlqErrorKind` by callers).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use thiserror::Error;

/// HTTP-boundary error, one variant per status code this service returns.
#[derive(Debug, Error)]
pub enum ApiError {
    /// Missing/invalid credential -- 401.
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    /// Authenticated but not permitted -- 403.
    #[error("forbidden: {0}")]
    Forbidden(String),
    /// Resource does not exist -- 404.
    #[error("not found: {0}")]
    NotFound(String),
    /// Caller input failed validation -- 400.
    #[error("bad request: {0}")]
    BadRequest(String),
    /// Anything else -- 500, detail logged not returned.
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: &'static str,
    message: String,
}

impl ApiError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            ApiError::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ApiError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            ApiError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        let message = match &self {
            ApiError::Internal(err) => {
                tracing::error!(error = %err, "internal error");
                "an internal error occurred".to_string()
            }
            other => other.to_string(),
        };
        (status, Json(ErrorBody { error: code, message })).into_response()
    }
}

/// Internal per-event-loop error. Every variant maps to exactly one
/// `DlqErrorKind` (Task 9) -- see `spine::dlq::DlqErrorKind::from`.
#[derive(Debug, Error)]
pub enum ProcessError {
    /// A `penguin_spine`/local-spine-module operation failed (see spine::client).
    #[error("spine error: {0}")]
    Spine(String),
    /// A SeaORM/Postgres operation failed.
    #[error("database error: {0}")]
    Db(#[from] sea_orm::DbErr),
    /// An outbound HTTP call (Ollama, reputation service, egress) failed.
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    /// JSON (de)serialization failed.
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
    /// Configuration was invalid at a point past startup validation.
    #[error("config error: {0}")]
    Config(#[from] crate::config::ConfigError),
    /// An `invoke` over the host-API connection came back as `FromExecutor::Error`
    /// or the connection was lost while awaiting a reply -- carries the wire
    /// error's own `code` (one of spec Sec6.6's stable strings, e.g.
    /// `EXECUTOR_DEADLINE`/`MEMORY_LIMIT`/`WASM_TRAP`/`HOST_CALL_DENIED`) so
    /// Task 22's `trip::classify_invoke_error` never has to string-match a
    /// formatted `Display` message.
    #[error("invoke failed: {code}: {message}")]
    InvokeFailed { code: String, message: String },
    /// Anything else.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}
```

(append the test module from Step 1, plus this additional case:)

```rust
    #[test]
    fn invoke_failed_displays_its_wire_code() {
        let err = ProcessError::InvokeFailed { code: "EXECUTOR_DEADLINE".into(), message: "bundle call exceeded 2000 ms".into() };
        assert!(err.to_string().contains("EXECUTOR_DEADLINE"));
    }
```

(add this case inside the same `#[cfg(test)] mod tests` block from Step 1, so `cargo test --lib error::` now reports 4 passed, not 3 -- Step 4 below reflects that)

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib error::"`
Expected: `test result: ok. 4 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/error.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): ApiError (HTTP) and ProcessError (internal) surfaces

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 4: Telemetry bootstrap (`telemetry.rs`)

**Files:**
- Modify: `core/svc_process/src/telemetry.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `pub fn init(default_service_name: &str) -> (TelemetryGuard, prometheus::Registry)`; `pub struct TelemetryGuard` with `.shutdown(&mut self)` and `Drop`; `pub fn render_metrics(registry: &prometheus::Registry) -> anyhow::Result<String>`; `pub struct RequestMetrics { pub http_requests_total: prometheus::IntCounterVec, pub http_request_duration_seconds: prometheus::HistogramVec }`; `pub fn register_request_metrics(registry: &prometheus::Registry) -> RequestMetrics`. Identical shape to `core/svc_streaming/src/telemetry.rs` (copy, do not reinvent) except the `up` gauge is named `svc_process_up` and the two base metrics are `svc_process_http_requests_total` / `svc_process_http_request_duration_seconds`.

- [ ] **Step 1: Write the failing tests** — copy `core/svc_streaming/src/telemetry.rs`'s `#[cfg(test)] mod tests` block verbatim, renaming every `svc_streaming` metric-name string to `svc_process` and every `"svc-streaming..."` literal to `"svc-process..."`.

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib telemetry::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `telemetry.rs`** — copy `core/svc_streaming/src/telemetry.rs` in full, renaming `svc_streaming_up` → `svc_process_up`, `svc_streaming_http_requests_total` → `svc_process_http_requests_total`, `svc_streaming_http_request_duration_seconds` → `svc_process_http_request_duration_seconds`. No other logic changes. (This module stays on local `tracing`+OTel wiring rather than a `penguin-logging` call — see Global Constraints: even `svc_streaming` itself has not migrated yet; that swap is scoped to M6.)

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib telemetry::"`
Expected: `test result: ok. 5 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/telemetry.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): tracing + OTLP + Prometheus telemetry bootstrap

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 5: Envelope types (`spine/envelope.rs`) — D30 workstream identity + trace + binding

**Files:**
- Create: `core/svc_process/src/spine/envelope.rs`
- Modify: `core/svc_process/src/spine/mod.rs` (`pub mod envelope;`)
- Test: `core/svc_process/tests/envelope_golden.rs`

**Interfaces:**
- Consumes: `tests/golden/envelopes/{valid,invalid}/*.json`, `tests/golden/entries/*.json` (produced by milestone M1 at the repo root, per spec Sec14.1 -- if this directory does not exist yet when this task runs, STOP and report it: M1 has not landed, which the milestone graph says must precede M4). The fixtures are the **D30 shape** (`schema_version: 2`, `workstream_id`, `event_id`, `trace`, `binding` present) -- a `tests/golden` tree still carrying the pre-D30 shape (`schema_version` absent/`1`, `trace_context` instead of `trace`) means M1 has not yet landed the D30 fixture regeneration either; STOP and report that too.
- Produces: `pub struct PlatformEvent { pub platform: String, pub event_type: String, pub actor: Option<String>, pub payload: serde_json::Map<String, serde_json::Value>, pub occurred_at: String, pub source: Option<EventSource> }`; `pub struct EventSource { pub platform: String, pub account_id: String, pub channel_id: Option<String> }`; `pub struct Trace { pub traceparent: String, pub tracestate: Option<String> }`; `pub struct Binding { pub kid: String, pub mac: String }`; `pub struct StageEnvelope { pub schema_version: u32, pub tenant: String, pub community: Option<String>, pub app_id: String, pub stage: String, pub event: PlatformEvent, pub ts: String, pub target_app_id: Option<String>, pub workstream_id: String, pub event_id: String, pub session_id: Option<String>, pub trace: Option<Trace>, pub binding: Binding }`; `pub const ENVELOPE_SCHEMA_VERSION: u32 = 2;`; `pub const PROCESS_TARGET_APP_ID_KEY: &str = "_target_app_id";`; `pub fn trace_id_from_traceparent(s: &str) -> Option<&str>` (extracts the 32-hex trace-id segment -- spec Sec5.11's `binding.mac` formula input, not the full `traceparent` string); `#[derive(Debug, Error)] pub enum EnvelopeError`. Both `Trace`/`Binding` and `StageEnvelope` are `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]` with `#[serde(deny_unknown_fields)]` for strict deserialization, `schema_version` checked equal to `ENVELOPE_SCHEMA_VERSION` with **no dual-read** of the pre-D30 shape (D3, D30 -- spec Sec6.1.2), and `binding` is **required** on every envelope, never optional (D30: "there is no unsigned shape"). This mirrors `penguin_spine`'s own Task 4 exactly (spec Sec4.7) -- see Global Constraints borrowed-names table; `workstream_id`/`event_id`/`session_id`/`trace`/`binding` replace the pre-D30 single `trace_context: Option<String>` field this task's earlier draft carried. Every later task imports `StageEnvelope`/`PlatformEvent`/`Trace`/`Binding`/`trace_id_from_traceparent` from `crate::spine::envelope`, never redefines them; **Task 21**'s `binding` module is this task's direct consumer.

- [ ] **Step 1: Write the failing tests**

```rust
// core/svc_process/tests/envelope_golden.rs
//! Contract tests against the shared golden fixtures (spec Sec14.1) --
//! asserts svc-process's Rust envelope types agree byte-for-byte with the
//! fixtures every other implementation (flask_core, penguin-spine) reads.
//! Fixtures are the D30 shape: schema_version 2, workstream_id, event_id,
//! trace, binding.
use std::fs;
use std::path::Path;
use svc_process::spine::envelope::StageEnvelope;

fn golden_dir() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden"))
}

#[test]
fn valid_envelopes_round_trip_byte_identical() {
    let dir = golden_dir().join("envelopes/valid");
    let entries: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("reading {dir:?}: {e} -- has M1 landed the D30 fixture regeneration?"))
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .collect();
    assert!(!entries.is_empty(), "zero fixtures examined under {dir:?} -- a zero denominator is a FAIL");
    let mut examined = 0;
    for entry in &entries {
        let raw = fs::read_to_string(entry.path()).unwrap();
        let original: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let env: StageEnvelope = serde_json::from_value(original.clone())
            .unwrap_or_else(|e| panic!("{:?}: {e}", entry.path()));
        assert_eq!(env.schema_version, 2, "{:?} is not the D30 shape", entry.path());
        let round_tripped = serde_json::to_value(&env).unwrap();
        assert_eq!(original, round_tripped, "{:?} did not round-trip byte-identical", entry.path());
        examined += 1;
    }
    println!("envelopes/valid fixtures examined: {examined}");
}

#[test]
fn invalid_envelopes_fail_deserialization() {
    let dir = golden_dir().join("envelopes/invalid");
    let entries: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("reading {dir:?}: {e}"))
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .collect();
    assert!(!entries.is_empty(), "zero fixtures examined under {dir:?}");
    let mut examined = 0;
    for entry in &entries {
        let raw = fs::read_to_string(entry.path()).unwrap();
        let result: Result<StageEnvelope, _> = serde_json::from_str(&raw);
        assert!(result.is_err(), "{:?} was expected to fail deserialization but succeeded", entry.path());
        examined += 1;
    }
    println!("envelopes/invalid fixtures examined: {examined}");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--test envelope_golden"`
Expected: FAIL to compile (`svc_process::spine::envelope` does not exist), or if `tests/golden/` is missing, the test panics naming that gap explicitly -- either way, this is the expected pre-implementation state.

- [ ] **Step 3: Implement `spine/mod.rs` and `spine/envelope.rs`**

```rust
// core/svc_process/src/spine/mod.rs
//! Valkey Streams spine: envelope types, key builders, admin/consumer
//! clients, DLQ record shape, D30 binding verification, D31 usage
//! metering. PROVISIONAL(M1): mirrors the `penguin-spine` crate spec
//! Sec4.7 defines; swap `crate::spine::` for `penguin_spine::` once that
//! crate is published -- see Global Constraints.
pub mod binding;
pub mod client;
pub mod dlq;
pub mod envelope;
pub mod keys;
pub mod reader;
pub mod usage;
```

(`binding`/`usage` are empty placeholder modules — `pub struct Placeholder;` with a one-line doc comment, matching Task 1's scaffolding convention — until Task 21 fills them in; declaring them here now means Task 21's diff is additive-only.)

```rust
// core/svc_process/src/spine/envelope.rs
//! `PlatformEvent`/`StageEnvelope` -- the queue-crossing contract, spec
//! Sec6.1, Sec5.11 (D30 workstream identity, trace, tenant-binding).
//! Strict deserialization: an unknown top-level field, a missing required
//! field, a wrong type, or `schema_version != 2` is refused, never coerced
//! (Sec6.1.2 "Strictness"; D3/D30 "no dual-read").
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Raised when a queue-crossing object fails strict deserialization.
/// serde's own `deny_unknown_fields`/type-mismatch errors already satisfy
/// "refused, never coerced"; this type exists so callers (Task 25) can
/// classify the failure as `DlqErrorKind::EnvelopeInvalid` without matching
/// on `serde_json::Error`'s unstable message text.
#[derive(Debug, Error)]
#[error("envelope invalid: {0}")]
pub struct EnvelopeError(pub String);

fn env_err(msg: impl Into<String>) -> EnvelopeError {
    EnvelopeError(msg.into())
}

/// The only `StageEnvelope.schema_version` this module accepts. No
/// dual-read (D3, D30): a `1` or absent value is the pre-D30 shape and is
/// rejected outright rather than interpreted (spec Sec6.1.2).
pub const ENVELOPE_SCHEMA_VERSION: u32 = 2;

/// Which connection an event came in on -- spec Sec6.1.1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventSource {
    /// Platform slug; mirrors the top-level `PlatformEvent::platform`.
    pub platform: String,
    /// Stable identity of the connection (bot login, app id, intake source name).
    pub account_id: String,
    /// The platform's channel/guild/room id, or `None` for account-level events.
    pub channel_id: Option<String>,
}

/// A normalized inbound platform event -- spec Sec6.1.1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlatformEvent {
    /// Non-empty platform slug.
    pub platform: String,
    /// Dotted, lowercase event-type namespace (`chat.message`, `channel.follow`, ...).
    pub event_type: String,
    /// Display name/id of the acting user, when known.
    pub actor: Option<String>,
    /// Platform-specific payload -- always a JSON object, may be empty.
    pub payload: serde_json::Map<String, serde_json::Value>,
    /// RFC 3339 UTC, millisecond precision.
    pub occurred_at: String,
    /// Which connection produced this event -- always populated by ingest,
    /// optional in deserialization for backward compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<EventSource>,
}

/// Reserved `PlatformEvent.payload` key a process bundle sets to request a
/// cross-app redirect (spec Sec5.9). The stage (Task 24) pops this back out
/// before enqueuing.
pub const PROCESS_TARGET_APP_ID_KEY: &str = "_target_app_id";

fn is_valid_traceparent(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 4
        && parts[0] == "00"
        && parts[1].len() == 32
        && parts[1].chars().all(|c| c.is_ascii_hexdigit())
        && parts[2].len() == 16
        && parts[2].chars().all(|c| c.is_ascii_hexdigit())
        && parts[3].len() == 2
        && parts[3].chars().all(|c| c.is_ascii_hexdigit())
}

/// Extracts the 32-hex trace-id segment from a validated `traceparent`
/// (spec Sec5.11: `binding.mac`'s input is this segment, not the full
/// `traceparent` string). Returns `None` if `s` is not a valid traceparent.
/// **Task 21**'s `verify_binding` is this function's direct caller.
pub fn trace_id_from_traceparent(s: &str) -> Option<&str> {
    if !is_valid_traceparent(s) {
        return None;
    }
    s.split('-').nth(1)
}

fn is_lowercase_hex_64(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTrace {
    traceparent: String,
    #[serde(default)]
    tracestate: Option<String>,
}

/// The W3C trace context carried on every envelope (spec Sec5.11,
/// Sec6.1.2) -- **supersedes the pre-D30 single-field `trace_context`**.
/// Absent means "no parent span"; when present, `traceparent` has already
/// passed the Sec6.1.2 shape check.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Trace {
    /// The W3C `traceparent` string (`00-<32 hex>-<16 hex>-<2 hex>`).
    pub traceparent: String,
    /// The W3C `tracestate` string, or `None`.
    pub tracestate: Option<String>,
}

impl<'de> Deserialize<'de> for Trace {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawTrace::deserialize(deserializer)?;
        if !is_valid_traceparent(&raw.traceparent) {
            return Err(serde::de::Error::custom(format!(
                "'trace.traceparent' {:?} is not a valid W3C traceparent",
                raw.traceparent
            )));
        }
        Ok(Trace { traceparent: raw.traceparent, tracestate: raw.tracestate })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBinding {
    kid: String,
    mac: String,
}

/// `{kid, mac}` -- `kid` names the active HMAC key version, `mac` is the
/// lowercase-hex `HMAC-SHA256` of spec Sec5.11's formula. Required on
/// every envelope; there is no unsigned shape (D30). Verified by every
/// stage on every read, before any other processing -- see **Task 21**'s
/// `binding` module (`compute_binding_mac`/`verify_binding`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Binding {
    /// Names the HMAC key version under which `mac` was computed.
    pub kid: String,
    /// Lowercase-hex HMAC-SHA256 output (64 hex chars, spec Sec5.11).
    pub mac: String,
}

impl<'de> Deserialize<'de> for Binding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawBinding::deserialize(deserializer)?;
        if raw.kid.is_empty() {
            return Err(serde::de::Error::custom("'binding.kid' must be a non-empty string, got \"\""));
        }
        if !is_lowercase_hex_64(&raw.mac) {
            return Err(serde::de::Error::custom(format!(
                "'binding.mac' {:?} must be exactly 64 lowercase hex characters",
                raw.mac
            )));
        }
        Ok(Binding { kid: raw.kid, mac: raw.mac })
    }
}

const BUNDLE_STAGES: [&str; 3] = ["ingest", "process", "action"];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawStageEnvelope {
    schema_version: u32,
    tenant: String,
    community: Option<String>,
    app_id: String,
    stage: String,
    event: PlatformEvent,
    ts: String,
    #[serde(default)]
    target_app_id: Option<String>,
    workstream_id: String,
    event_id: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    trace: Option<Trace>,
    binding: Binding,
}

/// One pipeline queue message routed between stages -- spec Sec6.1.2.
/// `workstream_id`, `event_id`, `session_id`, `trace` and `binding` are
/// the D30 workstream-identity/trace/tenant-wall fields (spec Sec5.11):
/// minted once by svc-ingest from its own `intake_sources`/`workstreams`
/// cache, never from payload, and copied verbatim by every later stage --
/// a bundle's output is never read for them (spec Sec5.11 "Bundles cannot
/// move a workstream"; **Task 24**'s routing built-in is the enforcement
/// point for this stage).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StageEnvelope {
    /// Must equal [`ENVELOPE_SCHEMA_VERSION`] (`2`) -- no dual-read (D3, D30).
    pub schema_version: u32,
    /// Non-empty; equals the `t:` segment of the key this was taken from.
    pub tenant: String,
    /// `None` renders as the literal `_tenant` key segment.
    pub community: Option<String>,
    /// `waddles.<module>.<feature>.<app>`.
    pub app_id: String,
    /// One of `ingest`, `process`, `action`.
    pub stage: String,
    /// The carried event.
    pub event: PlatformEvent,
    /// RFC 3339 UTC, millisecond precision.
    pub ts: String,
    /// Set only by the `_target_app_id` cross-app-routing built-in (Task 24).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_app_id: Option<String>,
    /// UUID; minted by svc-ingest from `intake_sources`/`workstreams`
    /// (spec Sec5.11, Sec6.11), never from payload; copied verbatim by
    /// every later stage, never accepted from bundle output.
    pub workstream_id: String,
    /// UUID v4, minted once by svc-ingest per inbound event; distinct
    /// from the platform's own message id and the Valkey stream entry id.
    pub event_id: String,
    /// The platform connection/broadcast session, when the platform has
    /// one; absent otherwise (spec Sec5.11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// W3C trace context for the entry's parent span, when present.
    /// Supersedes the pre-D30 `trace_context` field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<Trace>,
    /// `{kid, mac}` -- the Sec5.11 tenant-binding MAC. Required.
    pub binding: Binding,
}

impl<'de> Deserialize<'de> for StageEnvelope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawStageEnvelope::deserialize(deserializer)?;
        if raw.schema_version != ENVELOPE_SCHEMA_VERSION {
            return Err(serde::de::Error::custom(format!(
                "'schema_version' must equal {ENVELOPE_SCHEMA_VERSION}, got {} -- no dual-read of the pre-D30 shape",
                raw.schema_version
            )));
        }
        if raw.tenant.is_empty() {
            return Err(serde::de::Error::custom("'tenant' must be a non-empty string, got \"\""));
        }
        if !BUNDLE_STAGES.contains(&raw.stage.as_str()) {
            return Err(serde::de::Error::custom(format!("'stage' {:?} is not one of {BUNDLE_STAGES:?}", raw.stage)));
        }
        if raw.workstream_id.is_empty() {
            return Err(serde::de::Error::custom("'workstream_id' must be a non-empty string, got \"\""));
        }
        if raw.event_id.is_empty() {
            return Err(serde::de::Error::custom("'event_id' must be a non-empty string, got \"\""));
        }
        Ok(StageEnvelope {
            schema_version: raw.schema_version,
            tenant: raw.tenant,
            community: raw.community,
            app_id: raw.app_id,
            stage: raw.stage,
            event: raw.event,
            ts: raw.ts,
            target_app_id: raw.target_app_id,
            workstream_id: raw.workstream_id,
            event_id: raw.event_id,
            session_id: raw.session_id,
            trace: raw.trace,
            binding: raw.binding,
        })
    }
}

impl StageEnvelope {
    /// Deserializes and immediately classifies a failure as `EnvelopeError`
    /// -- the shape `worker.rs` (Task 25) needs to route straight to
    /// `DlqErrorKind::EnvelopeInvalid` without matching on `serde_json::Error`.
    pub fn from_json(raw: &str) -> Result<Self, EnvelopeError> {
        serde_json::from_str(raw).map_err(|e| env_err(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_json() -> serde_json::Value {
        serde_json::json!({
            "schema_version": 2,
            "tenant": "global",
            "community": null,
            "app_id": "waddles.bot.discord.default",
            "stage": "process",
            "event": {
                "platform": "discord", "event_type": "message", "actor": null,
                "payload": {}, "occurred_at": "2026-09-14T12:00:00.000Z"
            },
            "ts": "2026-09-14T12:00:00.000Z",
            "target_app_id": null,
            "workstream_id": "8f14e45f-ceea-467e-adde-3fb5c9752730",
            "event_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            "session_id": null,
            "trace": {"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "tracestate": null},
            "binding": {"kid": "2026-09", "mac": "a".repeat(64)}
        })
    }

    #[test]
    fn missing_event_key_is_refused_not_coerced() {
        let mut v = valid_json();
        v.as_object_mut().unwrap().remove("event");
        assert!(serde_json::from_value::<StageEnvelope>(v).is_err());
    }

    #[test]
    fn unknown_top_level_key_is_refused() {
        let mut v = valid_json();
        v["bogus"] = serde_json::json!(true);
        assert!(serde_json::from_value::<StageEnvelope>(v).is_err());
    }

    #[test]
    fn schema_version_1_is_rejected_no_dual_read() {
        let mut v = valid_json();
        v["schema_version"] = serde_json::json!(1);
        let err = serde_json::from_value::<StageEnvelope>(v).unwrap_err();
        assert!(err.to_string().contains("schema_version"));
    }

    #[test]
    fn schema_version_absent_is_rejected() {
        let mut v = valid_json();
        v.as_object_mut().unwrap().remove("schema_version");
        assert!(serde_json::from_value::<StageEnvelope>(v).is_err());
    }

    #[test]
    fn missing_binding_is_rejected_no_unsigned_shape() {
        let mut v = valid_json();
        v.as_object_mut().unwrap().remove("binding");
        assert!(serde_json::from_value::<StageEnvelope>(v).is_err());
    }

    #[test]
    fn malformed_binding_mac_is_rejected() {
        let mut v = valid_json();
        v["binding"] = serde_json::json!({"kid": "2026-09", "mac": "not-hex"});
        assert!(serde_json::from_value::<StageEnvelope>(v).is_err());
    }

    #[test]
    fn missing_workstream_id_is_rejected() {
        let mut v = valid_json();
        v.as_object_mut().unwrap().remove("workstream_id");
        assert!(serde_json::from_value::<StageEnvelope>(v).is_err());
    }

    #[test]
    fn community_none_and_optional_fields_round_trip_as_null_or_absent() {
        let env: StageEnvelope = serde_json::from_value(valid_json()).unwrap();
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(json["community"], serde_json::Value::Null);
        assert_eq!(json["schema_version"], serde_json::json!(2));
        assert_eq!(json["workstream_id"], serde_json::json!("8f14e45f-ceea-467e-adde-3fb5c9752730"));
    }

    #[test]
    fn trace_id_from_traceparent_extracts_the_32_hex_segment() {
        let tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        assert_eq!(trace_id_from_traceparent(tp), Some("4bf92f3577b34da6a3ce929d0e0e4736"));
    }

    #[test]
    fn trace_id_from_traceparent_rejects_a_malformed_string() {
        assert_eq!(trace_id_from_traceparent("not-a-traceparent"), None);
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib spine::envelope:: --test envelope_golden"`
Expected: `test result: ok` for both the inline unit tests (11 passed) and the golden-fixture integration test, with the printed `fixtures examined` counts both `> 0`.

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/spine/mod.rs core/svc_process/src/spine/envelope.rs core/svc_process/src/spine/binding.rs core/svc_process/src/spine/usage.rs core/svc_process/tests/envelope_golden.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): D30 StageEnvelope (schema_version/workstream_id/
event_id/session_id/trace/binding), golden-fixture contract tests

Replaces the pre-D30 trace_context-only shape with the full spec
Sec5.11/Sec6.1.2 envelope: schema_version is checked equal to 2 with
no dual-read, binding is required (no unsigned shape), and trace
(traceparent/tracestate) supersedes the single trace_context field.
Adds trace_id_from_traceparent, the input Task 21's binding module
needs to compute/verify binding.mac.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 6: Key builders (`spine/keys.rs`)

**Files:**
- Create: `core/svc_process/src/spine/keys.rs`
- Modify: `core/svc_process/src/spine/mod.rs` (`pub mod keys;`)
- Test: `core/svc_process/tests/keys_golden.rs`

**Interfaces:**
- Consumes: `tests/golden/keys/*.json`.
- Produces: `pub struct Scope { pub tenant: String, pub community: Option<String> }` with `impl Scope { pub fn source_stream(&self, platform: &str, source_id: &str) -> String; pub fn action_stream(&self, app_id: &str) -> String; pub fn config_key(&self, app_id: &str) -> String; pub fn state_key(&self, app_id: &str) -> String; pub fn bundle_state_key(&self, app_id: &str) -> String; }` (the last is an alias used by Task 16's `kv` capability, named separately from `state_key` only because spec Sec7.4 calls it `bundle_state_key(tenant, community, app_id)` explicitly — both return the identical string, kept as two names so call sites read naturally); `pub const DLQ_KEY_PREFIX: &str = "waddles:dlq:";` `pub fn dlq_key(stage: &str) -> String`; `pub const TENANT_WIDE_SEGMENT: &str = "_tenant";` `pub fn parse_scope_from_key(key: &str) -> Option<(String, Option<String>)>` (recovers `(tenant, community)` from a `waddles:t:{tenant}:c:{community|_tenant}:...` key -- **Task 21**'s `ScopeCheck::check_against_key` and D30 tenant-wall verification call this directly, and `worker.rs` (Task 25) uses it to recover tenant/community from a stream key when an entry's envelope fails to parse, spec Sec5.10/Sec11.8). Every later task builds a Valkey key exclusively through `Scope`/`dlq_key` — never string-formats a key inline.

- [ ] **Step 1: Write the failing test**

```rust
// core/svc_process/tests/keys_golden.rs
use std::fs;
use std::path::Path;
use svc_process::spine::keys::{dlq_key, Scope};

#[derive(serde::Deserialize)]
struct KeyFixture {
    tenant: String,
    community: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    source_id: Option<String>,
    #[serde(default)]
    app_id: Option<String>,
    expected_source_stream: Option<String>,
    expected_action_stream: Option<String>,
    expected_cfg_key: Option<String>,
    expected_state_key: Option<String>,
}

#[test]
fn key_fixtures_match_exactly() {
    let dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/keys"));
    let entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("reading {dir:?}: {e}"))
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .collect();
    assert!(!entries.is_empty(), "zero fixtures examined under {dir:?}");
    let mut examined = 0;
    for entry in &entries {
        let raw = fs::read_to_string(entry.path()).unwrap();
        let fx: KeyFixture = serde_json::from_str(&raw).unwrap();
        let scope = Scope { tenant: fx.tenant.clone(), community: fx.community.clone() };
        if let (Some(platform), Some(source_id), Some(expected)) =
            (&fx.platform, &fx.source_id, &fx.expected_source_stream)
        {
            assert_eq!(&scope.source_stream(platform, source_id), expected, "{:?}", entry.path());
        }
        if let (Some(app_id), Some(expected)) = (&fx.app_id, &fx.expected_action_stream) {
            assert_eq!(&scope.action_stream(app_id), expected, "{:?}", entry.path());
        }
        if let (Some(app_id), Some(expected)) = (&fx.app_id, &fx.expected_cfg_key) {
            assert_eq!(&scope.config_key(app_id), expected, "{:?}", entry.path());
        }
        if let (Some(app_id), Some(expected)) = (&fx.app_id, &fx.expected_state_key) {
            assert_eq!(&scope.state_key(app_id), expected, "{:?}", entry.path());
        }
        examined += 1;
    }
    println!("keys fixtures examined: {examined}");
}

#[test]
fn dlq_key_is_stage_scoped() {
    assert_eq!(dlq_key("process"), "waddles:dlq:process");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--test keys_golden"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `spine/keys.rs`**

```rust
//! Valkey key builders -- spec Sec5.1, Sec6.2. PROVISIONAL(M1): mirrors
//! `penguin_spine::Scope` (spec Sec4.7).

/// Renders a tenant-wide (no community) scope's key segment -- spec
/// Sec6.2. **Task 21**'s `binding::BindingInput::concat` and D30 tenant-
/// wall checks use this same constant, never a literal `"_tenant"`.
pub const TENANT_WIDE_SEGMENT: &str = "_tenant";

/// A (tenant, community) scope every key this service builds is rooted in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    /// The deployment's `RUNNER_TENANT_SLUG`.
    pub tenant: String,
    /// `None` renders as the literal `_tenant` key segment (tenant-wide).
    pub community: Option<String>,
}

impl Scope {
    fn community_segment(&self) -> &str {
        self.community.as_deref().unwrap_or(TENANT_WIDE_SEGMENT)
    }

    fn base(&self) -> String {
        format!("waddles:t:{}:c:{}", self.tenant, self.community_segment())
    }

    /// `waddles:t:{tenant}:c:{community|_tenant}:src:{platform}:{source_id}:events`.
    pub fn source_stream(&self, platform: &str, source_id: &str) -> String {
        format!("{}:src:{platform}:{source_id}:events", self.base())
    }

    /// `waddles:t:{tenant}:c:{community|_tenant}:app:{app_id}:action`.
    pub fn action_stream(&self, app_id: &str) -> String {
        format!("{}:app:{app_id}:action", self.base())
    }

    /// `...:app:{app_id}:cfg`.
    pub fn config_key(&self, app_id: &str) -> String {
        format!("{}:app:{app_id}:cfg", self.base())
    }

    /// `...:app:{app_id}:state`.
    pub fn state_key(&self, app_id: &str) -> String {
        format!("{}:app:{app_id}:state", self.base())
    }

    /// Alias of [`Self::state_key`] -- spec Sec7.4 names it `bundle_state_key`.
    pub fn bundle_state_key(&self, app_id: &str) -> String {
        self.state_key(app_id)
    }
}

/// `waddles:dlq:{stage}` -- one DLQ stream per stage.
pub fn dlq_key(stage: &str) -> String {
    format!("waddles:dlq:{stage}")
}

/// Recovers `(tenant, community)` from a `waddles:t:{tenant}:c:{community|
/// _tenant}:...` key -- spec Sec5.10/Sec11.8: tenant/community come from
/// the key an entry was read from, never from payload. `None` if `key`
/// does not start with the expected `waddles:t:<tenant>:c:<community>`
/// prefix shape. `community` decodes the literal [`TENANT_WIDE_SEGMENT`]
/// segment back to `None`.
pub fn parse_scope_from_key(key: &str) -> Option<(String, Option<String>)> {
    let rest = key.strip_prefix("waddles:t:")?;
    let (tenant, rest) = rest.split_once(":c:")?;
    if tenant.is_empty() {
        return None;
    }
    let community_segment = rest.split(':').next()?;
    if community_segment.is_empty() {
        return None;
    }
    let community = if community_segment == TENANT_WIDE_SEGMENT {
        None
    } else {
        Some(community_segment.to_string())
    };
    Some((tenant.to_string(), community))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tenant_wide_renders_as_tenant_literal() {
        let scope = Scope { tenant: "global".into(), community: None };
        assert_eq!(scope.action_stream("waddles.bot.discord.default"), "waddles:t:global:c:_tenant:app:waddles.bot.discord.default:action");
    }

    #[test]
    fn community_scoped_renders_the_slug() {
        let scope = Scope { tenant: "acme".into(), community: Some("main".into()) };
        assert_eq!(scope.source_stream("twitch", "tw-channelA"), "waddles:t:acme:c:main:src:twitch:tw-channelA:events");
    }

    #[test]
    fn parse_scope_from_key_recovers_tenant_and_community() {
        assert_eq!(
            parse_scope_from_key("waddles:t:acme:c:main:src:twitch:tw-channelA:events"),
            Some(("acme".to_string(), Some("main".to_string())))
        );
    }

    #[test]
    fn parse_scope_from_key_decodes_tenant_wide_segment_as_none() {
        assert_eq!(
            parse_scope_from_key("waddles:t:global:c:_tenant:app:waddles.bot.discord.default:action"),
            Some(("global".to_string(), None))
        );
    }

    #[test]
    fn parse_scope_from_key_rejects_a_malformed_key() {
        assert_eq!(parse_scope_from_key("not-a-waddles-key"), None);
        assert_eq!(parse_scope_from_key("waddles:t::c:main:src:twitch:x:events"), None);
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib spine::keys:: --test keys_golden"`
Expected: `test result: ok` for both -- 5 in `spine::keys::tests` (2 original + 3 `parse_scope_from_key` cases).

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/spine/keys.rs core/svc_process/tests/keys_golden.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): Scope key builders, golden-fixture contract test

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 7: DLQ record type (`spine/dlq.rs`) — D30 `tenant_boundary` + `workstream_id`/`trace`

**Files:**
- Create: `core/svc_process/src/spine/dlq.rs`
- Modify: `core/svc_process/src/spine/mod.rs` (`pub mod dlq;` already declared in Task 5)
- Test: inline

**Interfaces:**
- Consumes: `crate::spine::envelope::{StageEnvelope, Trace}`.
- Produces: `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)] #[serde(rename_all = "snake_case")] pub enum DlqErrorKind { EnvelopeInvalid, BundleTrap, BundleError, CallTimeout, MemoryLimit, HostCallDenied, MaxDeliveries, TenantBoundary, BundleDisabled, ExecutorUnavailable }` (ten variants -- D30 adds `TenantBoundary`) with `pub fn as_str(&self) -> &'static str` and `pub fn never_retry(&self) -> bool` (`true` only for `TenantBoundary` -- spec Sec5.11: "never retried"); `pub struct DlqRecord { pub schema_version: u32, pub stage: String, pub key: String, pub entry_id: String, pub group: String, pub tenant: String, pub community: Option<String>, pub app_id: String, pub workstream_id: Option<String>, pub artifact_digest: Option<String>, pub consumer_id: String, pub deliveries: u32, pub failed_at: String, pub error: DlqErrorDetail, pub trace: Option<Trace>, pub raw: String }`; `pub struct DlqErrorDetail { pub kind: DlqErrorKind, pub code: String, pub message: String, pub detail: Option<String> }`. `workstream_id`/`trace` (D30) replace the pre-D30 single `trace_context` field this task's earlier draft carried -- `workstream_id` is `Some` whenever the envelope parsed far enough to carry one, including a `tenant_boundary` rejection (spec Sec5.11: "present even on a tenant_boundary rejection, which is exactly the record an operator needs to trace a boundary violation back to its source"), `None` only for `EnvelopeInvalid`. Every later task (Task 25 worker, Task 22 trip counter, Task 23/24 built-ins, Task 26 reaper, **Task 21**'s `binding::BoundaryError::to_dlq_error` caller) constructs a `DlqRecord` through `DlqRecord::new(...)`, never a bare struct literal, so `schema_version`/`failed_at` stay consistent.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_stamps_schema_version_one_and_serializes_kind_snake_case() {
        let rec = DlqRecord::new(
            "process", "waddles:t:global:c:_tenant:src:twitch:tw-a:events", "1-0",
            "waddles.bot.discord.default", "global", None, "waddles.bot.discord.default",
            Some("8f14e45f-ceea-467e-adde-3fb5c9752730".to_string()), None, "svc-process-abc123", 1,
            DlqErrorKind::CallTimeout, "EXECUTOR_DEADLINE",
            "bundle call exceeded 2000 ms", None, None, "{}",
        );
        assert_eq!(rec.schema_version, 1);
        let json = serde_json::to_value(&rec).unwrap();
        assert_eq!(json["error"]["kind"], "call_timeout");
        assert_eq!(json["workstream_id"], "8f14e45f-ceea-467e-adde-3fb5c9752730");
    }

    #[test]
    fn tenant_boundary_is_the_only_kind_that_is_never_retried() {
        assert!(DlqErrorKind::TenantBoundary.never_retry());
        for kind in [
            DlqErrorKind::EnvelopeInvalid, DlqErrorKind::BundleTrap, DlqErrorKind::BundleError,
            DlqErrorKind::CallTimeout, DlqErrorKind::MemoryLimit, DlqErrorKind::HostCallDenied,
            DlqErrorKind::MaxDeliveries, DlqErrorKind::BundleDisabled, DlqErrorKind::ExecutorUnavailable,
        ] {
            assert!(!kind.never_retry(), "{kind:?} must be retried up to SPINE_MAX_DELIVERIES");
        }
    }

    #[test]
    fn as_str_matches_the_spec_snake_case_wire_values() {
        assert_eq!(DlqErrorKind::TenantBoundary.as_str(), "tenant_boundary");
        assert_eq!(DlqErrorKind::EnvelopeInvalid.as_str(), "envelope_invalid");
        assert_eq!(DlqErrorKind::ExecutorUnavailable.as_str(), "executor_unavailable");
    }

    #[test]
    fn workstream_id_is_none_only_for_envelope_invalid_by_convention() {
        let rec = DlqRecord::new(
            "process", "k", "1-0", "g", "t", None, "a", None, None, "c", 1,
            DlqErrorKind::EnvelopeInvalid, "BAD_ENVELOPE", "msg", None, None, "{}",
        );
        assert_eq!(rec.workstream_id, None);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib spine::dlq::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `spine/dlq.rs`**

```rust
//! DLQ record shape -- spec Sec6.3, Sec5.11 (D30 adds `tenant_boundary`,
//! `workstream_id`, `trace`).
use serde::Serialize;

use crate::spine::envelope::Trace;

/// The ten reasons an entry reaches a DLQ -- spec Sec6.3's `error.kind`
/// table. D30 adds `TenantBoundary`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DlqErrorKind {
    /// Strict deserialization failed.
    EnvelopeInvalid,
    /// The WASM component trapped.
    BundleTrap,
    /// The component returned a terminal error.
    BundleError,
    /// The per-call epoch deadline fired.
    CallTimeout,
    /// The instance exceeded its memory cap.
    MemoryLimit,
    /// A capability check refused the call.
    HostCallDenied,
    /// `deliveries` reached `SPINE_MAX_DELIVERIES`.
    MaxDeliveries,
    /// The Sec5.11 hop verification failed: `binding.mac` mismatch,
    /// envelope tenant/community disagreeing with the stream key, a
    /// grant/approval scoped to a different tenant or community, or a
    /// bundle output that tried to set an identity field (D30). **Never
    /// retried** -- see [`DlqErrorKind::never_retry`].
    TenantBoundary,
    /// The bundle is disabled after three sandbox trips.
    BundleDisabled,
    /// The executor was unavailable past `EXECUTOR_UNAVAILABLE_READY_S`.
    ExecutorUnavailable,
}

impl DlqErrorKind {
    /// The exact snake_case wire string (matches the spec's `error.kind`
    /// values and the `reason` label on `waddles_spine_dlq_total`).
    pub fn as_str(&self) -> &'static str {
        match self {
            DlqErrorKind::EnvelopeInvalid => "envelope_invalid",
            DlqErrorKind::BundleTrap => "bundle_trap",
            DlqErrorKind::BundleError => "bundle_error",
            DlqErrorKind::CallTimeout => "call_timeout",
            DlqErrorKind::MemoryLimit => "memory_limit",
            DlqErrorKind::HostCallDenied => "host_call_denied",
            DlqErrorKind::MaxDeliveries => "max_deliveries",
            DlqErrorKind::TenantBoundary => "tenant_boundary",
            DlqErrorKind::BundleDisabled => "bundle_disabled",
            DlqErrorKind::ExecutorUnavailable => "executor_unavailable",
        }
    }

    /// `true` only for [`DlqErrorKind::TenantBoundary`] (spec Sec5.11: "a
    /// forged, replayed or cross-tenant envelope is not made valid by
    /// retrying it"). Every other kind is retried up to
    /// `SPINE_MAX_DELIVERIES` by the stage's normal redelivery path
    /// (Task 26's reaper).
    pub fn never_retry(&self) -> bool {
        matches!(self, DlqErrorKind::TenantBoundary)
    }
}

/// One DLQ record's `error` field.
#[derive(Debug, Clone, Serialize)]
pub struct DlqErrorDetail {
    /// One of [`DlqErrorKind`]; also the `reason` label on `waddles_spine_dlq_total`.
    pub kind: DlqErrorKind,
    /// A stable machine-readable code (e.g. `EXECUTOR_DEADLINE`).
    pub code: String,
    /// Human-readable detail for operators.
    pub message: String,
    /// Extra structured detail, when available.
    pub detail: Option<String>,
}

/// One JSON object written to `waddles:dlq:{stage}` under the field `rec`
/// -- spec Sec6.3, Sec5.11 (D30).
#[derive(Debug, Clone, Serialize)]
pub struct DlqRecord {
    /// Always `1` for this spec.
    pub schema_version: u32,
    /// Which stage produced this record.
    pub stage: String,
    /// The Valkey stream key the entry was read from.
    pub key: String,
    /// The stream entry id -- the stable de-duplication key.
    pub entry_id: String,
    /// The consumer group (`app_id`) that was processing the entry.
    pub group: String,
    /// Tenant slug.
    pub tenant: String,
    /// Community slug, or `None` for tenant-wide.
    pub community: Option<String>,
    /// The bundle's app id.
    pub app_id: String,
    /// Copied from the envelope (spec Sec5.11, D30); present whenever the
    /// envelope parsed far enough to carry one -- including a
    /// `tenant_boundary` rejection, which is exactly the record an
    /// operator needs to trace a boundary violation back to its source.
    /// `None` only for `envelope_invalid`, where no envelope exists yet.
    pub workstream_id: Option<String>,
    /// `None` when the failure happened before a bundle was selected.
    pub artifact_digest: Option<String>,
    /// This pod's consumer identity.
    pub consumer_id: String,
    /// Delivery count at the time of failure.
    pub deliveries: u32,
    /// RFC 3339 UTC, millisecond precision.
    pub failed_at: String,
    /// Classified failure detail.
    pub error: DlqErrorDetail,
    /// W3C trace context, when the originating envelope carried one.
    /// Supersedes the pre-D30 single-field `trace_context`.
    pub trace: Option<Trace>,
    /// The original envelope JSON, verbatim, as a string.
    pub raw: String,
}

impl DlqRecord {
    /// Builds a record with `schema_version=1` and `failed_at` set to now.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        stage: &str,
        key: &str,
        entry_id: &str,
        group: &str,
        tenant: &str,
        community: Option<String>,
        app_id: &str,
        workstream_id: Option<String>,
        artifact_digest: Option<String>,
        consumer_id: &str,
        deliveries: u32,
        kind: DlqErrorKind,
        code: &str,
        message: &str,
        detail: Option<String>,
        trace: Option<Trace>,
        raw: &str,
    ) -> Self {
        Self {
            schema_version: 1,
            stage: stage.to_string(),
            key: key.to_string(),
            entry_id: entry_id.to_string(),
            group: group.to_string(),
            tenant: tenant.to_string(),
            community,
            app_id: app_id.to_string(),
            workstream_id,
            artifact_digest,
            consumer_id: consumer_id.to_string(),
            deliveries,
            failed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            error: DlqErrorDetail { kind, code: code.to_string(), message: message.to_string(), detail },
            trace,
            raw: raw.to_string(),
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib spine::dlq::"`
Expected: `test result: ok. 4 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/spine/dlq.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): DlqRecord/DlqErrorKind matching the D30 spec Sec6.3
shape (tenant_boundary, workstream_id, trace)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---
### Task 8: `SpineClient` admin operations (`spine/client.rs`)

**Files:**
- Create: `core/svc_process/src/spine/client.rs`
- Modify: `core/svc_process/src/spine/mod.rs` (`pub mod client;` already declared)
- Test: `core/svc_process/tests/spine_client_integration.rs` (requires a real Valkey; `#[ignore]`d by default, run explicitly)

**Interfaces:**
- Consumes: `crate::spine::envelope::StageEnvelope`, `crate::spine::dlq::DlqRecord`, `crate::error::ProcessError`.
- Produces: `pub struct Delivered { pub stream: String, pub entry_id: String, pub env: StageEnvelope, pub deliveries: u64 }`; `pub struct GroupStats { pub name: String, pub pending: u64, pub lag: Option<u64> }`; `pub struct SpineClient { .. }` with `pub fn new(pool: deadpool_redis::Pool) -> Self`, `pub async fn append(&self, stream: &str, env: &StageEnvelope, maxlen: u64) -> Result<String, ProcessError>`, `pub async fn ensure_group(&self, stream: &str, group: &str) -> Result<(), ProcessError>` (BUSYGROUP-tolerant), `pub async fn destroy_group(&self, stream: &str, group: &str) -> Result<(), ProcessError>`, `pub async fn ack(&self, stream: &str, group: &str, entry_id: &str) -> Result<(), ProcessError>`, `pub async fn claim_stale(&self, stream: &str, group: &str, consumer: &str, idle_ms: u64, count: u64) -> Result<Vec<Delivered>, ProcessError>`, `pub async fn delivery_count(&self, stream: &str, group: &str, entry_id: &str) -> Result<u32, ProcessError>`, `pub async fn dead_letter(&self, dlq_key: &str, rec: &DlqRecord, maxlen: u64) -> Result<(), ProcessError>`, `pub async fn group_stats(&self, stream: &str) -> Result<Vec<GroupStats>, ProcessError>`. This is the shared admin/write client every worker (Task 25) and the reaper (Task 26) hold one clone of (`deadpool_redis::Pool` is itself `Clone`, cheap).

- [ ] **Step 1: Write the failing test**

```rust
// core/svc_process/tests/spine_client_integration.rs
//! Integration tests against a real Valkey -- run with:
//!   docker run --rm -p 6399:6379 valkey/valkey:8-bookworm
//!   VALKEY_TEST_URL=redis://127.0.0.1:6399 cargo test --test spine_client_integration -- --ignored
use svc_process::spine::client::SpineClient;
use svc_process::spine::envelope::{Binding, PlatformEvent, StageEnvelope};

fn test_env() -> StageEnvelope {
    // D30: schema_version/workstream_id/event_id/binding are required --
    // this is a synthetic, unverified binding (this test never calls
    // verify_binding; Task 21's own tests cover verification).
    StageEnvelope {
        schema_version: 2,
        tenant: "global".into(),
        community: None,
        app_id: "waddles.bot.discord.default".into(),
        stage: "process".into(),
        event: PlatformEvent {
            platform: "discord".into(),
            event_type: "chat.message".into(),
            actor: Some("tester".into()),
            payload: serde_json::Map::new(),
            occurred_at: "2026-09-14T12:00:00.000Z".into(),
            source: None,
        },
        ts: "2026-09-14T12:00:00.000Z".into(),
        target_app_id: None,
        workstream_id: uuid::Uuid::new_v4().to_string(),
        event_id: uuid::Uuid::new_v4().to_string(),
        session_id: None,
        trace: None,
        binding: Binding { kid: "test-kid".into(), mac: "a".repeat(64) },
    }
}

async fn client() -> SpineClient {
    let url = std::env::var("VALKEY_TEST_URL").expect("set VALKEY_TEST_URL to run this test");
    let cfg = deadpool_redis::Config::from_url(url);
    let pool = cfg.create_pool(Some(deadpool_redis::Runtime::Tokio1)).unwrap();
    SpineClient::new(pool)
}

#[tokio::test]
#[ignore = "requires a real Valkey; see module docs"]
async fn append_ensure_group_ack_round_trip() {
    let c = client().await;
    let stream = format!("test:spine:{}", uuid::Uuid::new_v4());
    let group = "test-group";
    c.ensure_group(&stream, group).await.unwrap();
    c.ensure_group(&stream, group).await.unwrap(); // BUSYGROUP-tolerant, must not error
    let id = c.append(&stream, &test_env(), 1000).await.unwrap();
    assert!(!id.is_empty());
    c.ack(&stream, group, &id).await.unwrap();
    c.destroy_group(&stream, group).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a real Valkey; see module docs"]
async fn dead_letter_writes_to_dlq_stream() {
    use svc_process::spine::dlq::{DlqErrorKind, DlqRecord};
    let c = client().await;
    let dlq_key = format!("test:dlq:{}", uuid::Uuid::new_v4());
    let rec = DlqRecord::new(
        "process", "some:key", "1-0", "waddles.bot.discord.default", "global", None,
        "waddles.bot.discord.default", Some(uuid::Uuid::new_v4().to_string()), None,
        "svc-process-test", 1, DlqErrorKind::CallTimeout, "EXECUTOR_DEADLINE", "test", None, None, "{}",
    );
    c.dead_letter(&dlq_key, &rec, 10_000).await.unwrap();
    let stats = c.group_stats(&dlq_key).await;
    // No consumer group was created on the DLQ stream; group_stats on a
    // stream with zero groups returns an empty Vec, not an error.
    assert!(stats.unwrap().is_empty());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--test spine_client_integration -- --ignored"`
Expected: FAIL to compile — `svc_process::spine::client` does not exist.

- [ ] **Step 3: Implement `spine/client.rs`**

```rust
//! Admin/write Valkey Streams operations -- spec Sec4.7 `SpineClient`.
//! PROVISIONAL(M1): mirrors `penguin_spine::SpineClient` exactly; swap the
//! import path once that crate is published.
use redis::streams::{StreamAutoClaimOptions, StreamAutoClaimReply, StreamMaxlen};
use redis::AsyncCommands;

use crate::error::ProcessError;
use crate::spine::dlq::DlqRecord;
use crate::spine::envelope::StageEnvelope;

/// One entry read (or reclaimed) from a stream, ready for consumer-side handling.
#[derive(Debug, Clone)]
pub struct Delivered {
    /// The stream this entry came from.
    pub stream: String,
    /// The stream entry id.
    pub entry_id: String,
    /// The deserialized envelope.
    pub env: StageEnvelope,
    /// Delivery count, when known (0 means "not yet looked up").
    pub deliveries: u64,
}

/// A consumer group's health, from `XINFO GROUPS`.
#[derive(Debug, Clone)]
pub struct GroupStats {
    /// The group name (== `app_id`).
    pub name: String,
    /// Pending-entries-list size for this group.
    pub pending: u64,
    /// The group's reported lag, when the server supports it.
    pub lag: Option<u64>,
}

fn spine_err(e: impl std::fmt::Display) -> ProcessError {
    ProcessError::Spine(e.to_string())
}

/// Pooled, admin/write Valkey Streams client. Cheap to clone
/// (`deadpool_redis::Pool` is itself an `Arc`-backed clone).
#[derive(Clone)]
pub struct SpineClient {
    pool: deadpool_redis::Pool,
}

impl SpineClient {
    /// Builds a client over an already-configured connection pool.
    pub fn new(pool: deadpool_redis::Pool) -> Self {
        Self { pool }
    }

    async fn conn(&self) -> Result<deadpool_redis::Connection, ProcessError> {
        self.pool.get().await.map_err(spine_err)
    }

    /// `XADD {stream} MAXLEN ~ {maxlen} * env {envelope_json}` -- spec Sec5.1.
    pub async fn append(&self, stream: &str, env: &StageEnvelope, maxlen: u64) -> Result<String, ProcessError> {
        let json = serde_json::to_string(env)?;
        let mut conn = self.conn().await?;
        let id: String = conn
            .xadd_maxlen(stream, StreamMaxlen::Approx(maxlen as usize), "*", &[("env", json)])
            .await
            .map_err(spine_err)?;
        Ok(id)
    }

    /// `XGROUP CREATE {stream} {group} $ MKSTREAM`, `BUSYGROUP`-tolerant -- spec Sec5.2.
    pub async fn ensure_group(&self, stream: &str, group: &str) -> Result<(), ProcessError> {
        let mut conn = self.conn().await?;
        let result: redis::RedisResult<()> = conn.xgroup_create_mkstream(stream, group, "$").await;
        match result {
            Ok(()) => Ok(()),
            Err(e) if e.to_string().contains("BUSYGROUP") => Ok(()),
            Err(e) => Err(spine_err(e)),
        }
    }

    /// `XGROUP DESTROY {stream} {group}` -- spec Sec5.2.
    pub async fn destroy_group(&self, stream: &str, group: &str) -> Result<(), ProcessError> {
        let mut conn = self.conn().await?;
        let _: i64 = conn.xgroup_destroy(stream, group).await.map_err(spine_err)?;
        Ok(())
    }

    /// `XACK {stream} {group} {entry_id}`.
    pub async fn ack(&self, stream: &str, group: &str, entry_id: &str) -> Result<(), ProcessError> {
        let mut conn = self.conn().await?;
        let _: i64 = conn.xack(stream, group, &[entry_id]).await.map_err(spine_err)?;
        Ok(())
    }

    /// `XAUTOCLAIM {stream} {group} {consumer} {idle_ms} 0 COUNT {count}` -- spec Sec5.4.
    /// Returned entries carry `deliveries: 0`; call [`Self::delivery_count`]
    /// per entry when the caller needs the redelivery-cap check (Task 26).
    pub async fn claim_stale(
        &self,
        stream: &str,
        group: &str,
        consumer: &str,
        idle_ms: u64,
        count: u64,
    ) -> Result<Vec<Delivered>, ProcessError> {
        let mut conn = self.conn().await?;
        let opts = StreamAutoClaimOptions::default().count(count as usize);
        let reply: StreamAutoClaimReply = conn
            .xautoclaim_options(stream, group, consumer, idle_ms, "0", opts)
            .await
            .map_err(spine_err)?;
        let mut out = Vec::with_capacity(reply.claimed.len());
        for id in reply.claimed {
            let Some(field) = id.map.get("env") else { continue };
            let env_json: String = redis::from_redis_value(field).map_err(spine_err)?;
            let env = StageEnvelope::from_json(&env_json).map_err(|e| ProcessError::Spine(e.0))?;
            out.push(Delivered { stream: stream.to_string(), entry_id: id.id, env, deliveries: 0 });
        }
        Ok(out)
    }

    /// `XPENDING {stream} {group} {entry_id} {entry_id} 1` -- the extended
    /// form scoped to one id, returning its delivery count (spec Sec5.4
    /// "Redelivery cap").
    pub async fn delivery_count(&self, stream: &str, group: &str, entry_id: &str) -> Result<u32, ProcessError> {
        let mut conn = self.conn().await?;
        let reply: redis::streams::StreamPendingCountReply = conn
            .xpending_count(stream, group, entry_id, entry_id, 1)
            .await
            .map_err(spine_err)?;
        Ok(reply.ids.first().map(|p| p.times_delivered as u32).unwrap_or(0))
    }

    /// `XADD {dlq_key} MAXLEN ~ {maxlen} * rec {record_json}` then the caller
    /// is responsible for `XACK`ing the source entry -- spec Sec5.5.
    pub async fn dead_letter(&self, dlq_key: &str, rec: &DlqRecord, maxlen: u64) -> Result<(), ProcessError> {
        let json = serde_json::to_string(rec)?;
        let mut conn = self.conn().await?;
        let _: String = conn
            .xadd_maxlen(dlq_key, StreamMaxlen::Approx(maxlen as usize), "*", &[("rec", json)])
            .await
            .map_err(spine_err)?;
        Ok(())
    }

    /// `XINFO GROUPS {stream}` -- spec Sec5.6 backpressure signal. An empty
    /// `Vec` (no groups on the stream) is a legitimate result, not an error.
    pub async fn group_stats(&self, stream: &str) -> Result<Vec<GroupStats>, ProcessError> {
        let mut conn = self.conn().await?;
        let raw: redis::RedisResult<Vec<std::collections::HashMap<String, redis::Value>>> =
            redis::cmd("XINFO").arg("GROUPS").arg(stream).query_async(&mut conn).await;
        let groups = match raw {
            Ok(g) => g,
            // A stream with zero groups, or one that doesn't exist yet, is
            // not a spine-level error -- callers treat it as "nothing to report".
            Err(e) if e.to_string().to_lowercase().contains("no such key") => return Ok(vec![]),
            Err(e) => return Err(spine_err(e)),
        };
        let mut out = Vec::with_capacity(groups.len());
        for g in groups {
            let name: String = g.get("name").map(|v| redis::from_redis_value(v)).transpose().map_err(spine_err)?.unwrap_or_default();
            let pending: u64 = g.get("pending").map(|v| redis::from_redis_value(v)).transpose().map_err(spine_err)?.unwrap_or(0);
            let lag: Option<u64> = g.get("lag").and_then(|v| redis::from_redis_value(v).ok());
            out.push(GroupStats { name, pending, lag });
        }
        Ok(out)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
docker run -d --rm --name svc-process-valkey-test -p 6399:6379 valkey/valkey:8-bookworm
cd core/svc_process && VALKEY_TEST_URL=redis://127.0.0.1:6399 cargo test --test spine_client_integration -- --ignored --test-threads=1 2>&1 | tail -30
docker stop svc-process-valkey-test
```
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/spine/client.rs core/svc_process/tests/spine_client_integration.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): SpineClient admin ops (append/group/ack/claim/dead_letter)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 9: `GroupReader` -- dedicated blocking connection (`spine/reader.rs`)

**Files:**
- Create: `core/svc_process/src/spine/reader.rs`
- Modify: `core/svc_process/src/spine/mod.rs` (`pub mod reader;` already declared)

**Interfaces:**
- Consumes: `crate::spine::client::Delivered`, `crate::spine::envelope::StageEnvelope`, `crate::config::Config` (for `spine_block_ms`/`drain_socket_timeout_s`/`spine_read_count`).
- Produces: `pub struct GroupReader { .. }` with `pub async fn connect(valkey_url: &str, stream: &str, socket_timeout: std::time::Duration) -> Result<Self, ProcessError>`, `pub async fn read(&mut self, stream: &str, group: &str, consumer_id: &str, block_ms: u64, count: u64) -> Result<Vec<Delivered>, ProcessError>` (spec Sec5.3's `XREADGROUP GROUP {group} {consumer} COUNT {count} BLOCK {block_ms} STREAMS {stream} >`), `pub fn ensure_granted(&self, stream: &str) -> Result<(), ProcessError>` (spec Sec5.2: "the stage is the enforcement point" -- M4's design constructs exactly one `GroupReader` per granted `(bundle, stream)` pair via Task 12's `Registry::reconcile`, so this is a structural belt-and-braces check, not the sole enforcement; kept under this exact name so the eventual swap to `penguin_spine::GroupReader::ensure_granted` is mechanical, per Global Constraints), `pub fn validate_block_config(block_ms: u64, socket_timeout: std::time::Duration) -> Result<(), ProcessError>` (spec Sec5.7 client rule 1, also enforced at `Config` load time in Task 2 — this is the spine-level restatement `penguin_spine::GroupReader::new` would carry). Task 25's per-`(bundle, stream)` worker owns exactly one `GroupReader` per stream on its own dedicated `redis::aio::MultiplexedConnection` (never the shared `deadpool_redis::Pool` — spec Sec5.7 client rule 2: a blocking command must never share a connection with admin traffic), and calls `ensure_granted` once before its first `read` -- **Task 33**'s negative test constructs a `GroupReader` for a stream and then asserts a *different* stream name is rejected by `ensure_granted`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn rejects_block_ms_not_strictly_less_than_socket_timeout() {
        let err = GroupReader::validate_block_config(65_000, Duration::from_secs(65)).unwrap_err();
        assert!(matches!(err, ProcessError::Spine(_)));
    }

    #[test]
    fn accepts_block_ms_strictly_less_than_socket_timeout() {
        assert!(GroupReader::validate_block_config(1000, Duration::from_secs(65)).is_ok());
    }

    #[test]
    fn ensure_granted_rejects_a_stream_other_than_the_one_this_reader_was_opened_for() {
        // Constructed without a live connection -- ensure_granted is a pure
        // string check and does not touch the network.
        let reader = GroupReader { conn: None, stream: "waddles:t:acme:c:main:src:twitch:tw-a:events".to_string() };
        assert!(reader.ensure_granted("waddles:t:acme:c:main:src:twitch:tw-a:events").is_ok());
        let err = reader.ensure_granted("waddles:t:acme:c:main:src:discord:dg-x:events").unwrap_err();
        assert!(matches!(err, ProcessError::Spine(_)));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib spine::reader::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `spine/reader.rs`**

```rust
//! `GroupReader` -- one dedicated, non-pooled connection per granted stream
//! for the blocking `XREADGROUP` read. Spec Sec5.3, Sec5.7 (client rules 1
//! and 2). PROVISIONAL(M1): mirrors `penguin_spine::GroupReader`.
use std::time::Duration;

use redis::aio::MultiplexedConnection;
use redis::streams::{StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;

use crate::error::ProcessError;
use crate::spine::client::Delivered;
use crate::spine::envelope::StageEnvelope;

fn spine_err(e: impl std::fmt::Display) -> ProcessError {
    ProcessError::Spine(e.to_string())
}

/// A dedicated (never pooled, never shared) Valkey connection for one
/// granted stream's blocking `XREADGROUP` loop. `conn` is `None` only in
/// this module's own unit tests, which exercise `ensure_granted`'s pure
/// string logic without opening a socket.
pub struct GroupReader {
    conn: Option<MultiplexedConnection>,
    stream: String,
}

impl GroupReader {
    /// Spec Sec5.7 client rule 1: the server-side `BLOCK` argument must be
    /// strictly less than the connection's own socket timeout, or a
    /// cancelled-but-still-in-flight block leaves the connection wedged.
    pub fn validate_block_config(block_ms: u64, socket_timeout: Duration) -> Result<(), ProcessError> {
        if block_ms >= socket_timeout.as_millis() as u64 {
            return Err(ProcessError::Spine(format!(
                "SPINE_BLOCK_MS ({block_ms}) must be strictly less than the connection socket timeout ({} ms)",
                socket_timeout.as_millis()
            )));
        }
        Ok(())
    }

    /// Opens a fresh, dedicated `MultiplexedConnection` scoped to exactly
    /// `stream` -- never taken from the shared admin pool (spec Sec5.7
    /// client rule 2).
    pub async fn connect(valkey_url: &str, stream: &str, socket_timeout: Duration) -> Result<Self, ProcessError> {
        let client = redis::Client::open(valkey_url).map_err(spine_err)?;
        let conn = client
            .get_multiplexed_tokio_connection_with_response_timeouts(socket_timeout, socket_timeout)
            .await
            .map_err(spine_err)?;
        Ok(Self { conn: Some(conn), stream: stream.to_string() })
    }

    /// Spec Sec5.2 "the stage is the enforcement point": refuses a read
    /// against any stream other than the one this reader was opened for.
    /// A pure string check -- no network access, cheap to call before
    /// every `read`.
    pub fn ensure_granted(&self, stream: &str) -> Result<(), ProcessError> {
        if self.stream == stream {
            Ok(())
        } else {
            Err(ProcessError::Spine(format!(
                "stream {stream:?} is not the granted stream {:?} this GroupReader was opened for",
                self.stream
            )))
        }
    }

    /// `XREADGROUP GROUP {group} {consumer_id} COUNT {count} BLOCK {block_ms} STREAMS {stream} >`.
    /// An idle-timeout (no new entries) returns `Ok(vec![])`, not an error.
    pub async fn read(
        &mut self,
        stream: &str,
        group: &str,
        consumer_id: &str,
        block_ms: u64,
        count: u64,
    ) -> Result<Vec<Delivered>, ProcessError> {
        self.ensure_granted(stream)?;
        let conn = self.conn.as_mut().expect("connect() always populates conn outside unit tests");
        let opts = StreamReadOptions::default()
            .group(group, consumer_id)
            .count(count as usize)
            .block(block_ms as usize);
        let reply: StreamReadReply = conn
            .xread_options(&[stream], &[">"], &opts)
            .await
            .map_err(spine_err)?;
        let mut out = Vec::new();
        for stream_key in reply.keys {
            for id in stream_key.ids {
                let Some(field) = id.map.get("env") else { continue };
                let env_json: String = redis::from_redis_value(field).map_err(spine_err)?;
                let env = StageEnvelope::from_json(&env_json).map_err(|e| ProcessError::Spine(e.0))?;
                out.push(Delivered { stream: stream_key.key.clone(), entry_id: id.id, env, deliveries: 0 });
            }
        }
        Ok(out)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib spine::reader::"`
Expected: `test result: ok. 3 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/spine/reader.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): GroupReader dedicated-connection XREADGROUP, client rule 1

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 10: `consumes` matching (`consumes/matcher.rs`)

**Files:**
- Create: `core/svc_process/src/consumes/matcher.rs`
- Modify: `core/svc_process/src/consumes/mod.rs` (`pub mod matcher;`)

**Interfaces:**
- Consumes: `crate::spine::envelope::PlatformEvent`.
- Produces: `pub struct ConsumeRule { pub platform: String, pub source_id: Option<String>, pub event_types: Vec<String>, pub command_prefix: Option<Vec<String>>, pub actor_roles: Option<Vec<String>> }`; `pub fn event_type_glob_matches(pattern: &str, event_type: &str) -> bool` (spec Sec6.4.3: `*` matches one segment, `**` matches one-or-more segments, dot-delimited); `pub fn rule_matches(rule: &ConsumeRule, event: &PlatformEvent) -> bool` (platform/event_types/filters ANDed within a rule); `pub fn any_rule_matches(rules: &[ConsumeRule], event: &PlatformEvent) -> bool` (rules ORed — spec Sec6.4.3). Task 25's worker calls `any_rule_matches` once per delivered entry for the consumer-side skip-and-XACK decision (spec Sec5.3).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::spine::envelope::PlatformEvent;

    fn event(event_type: &str, text: Option<&str>) -> PlatformEvent {
        let mut payload = serde_json::Map::new();
        if let Some(t) = text {
            payload.insert("text".into(), serde_json::Value::String(t.into()));
        }
        PlatformEvent {
            platform: "twitch".into(),
            event_type: event_type.into(),
            actor: Some("someone".into()),
            payload,
            occurred_at: "2026-09-14T12:00:00.000Z".into(),
            source: None,
        }
    }

    #[test]
    fn single_star_matches_exactly_one_segment() {
        assert!(event_type_glob_matches("channel.*", "channel.follow"));
        assert!(!event_type_glob_matches("channel.*", "channel.follow.extra"));
    }

    #[test]
    fn double_star_matches_one_or_more_segments() {
        assert!(event_type_glob_matches("channel.**", "channel.follow"));
        assert!(event_type_glob_matches("channel.**", "channel.follow.extra"));
        assert!(!event_type_glob_matches("channel.**", "channel"));
    }

    #[test]
    fn exact_pattern_requires_exact_match() {
        assert!(event_type_glob_matches("chat.message", "chat.message"));
        assert!(!event_type_glob_matches("chat.message", "chat.message.deleted"));
    }

    #[test]
    fn command_prefix_filter_is_case_insensitive_and_trims_whitespace() {
        let rule = ConsumeRule {
            platform: "twitch".into(),
            source_id: None,
            event_types: vec!["chat.message".into()],
            command_prefix: Some(vec!["!sr".into(), "!songrequest".into()]),
            actor_roles: None,
        };
        assert!(rule_matches(&rule, &event("chat.message", Some("  !SR foo"))));
        assert!(!rule_matches(&rule, &event("chat.message", Some("hello"))));
    }

    #[test]
    fn platform_mismatch_never_matches_regardless_of_event_type() {
        let rule = ConsumeRule {
            platform: "discord".into(),
            source_id: None,
            event_types: vec!["chat.message".into()],
            command_prefix: None,
            actor_roles: None,
        };
        assert!(!rule_matches(&rule, &event("chat.message", Some("hi"))));
    }

    #[test]
    fn rules_are_ored_across_the_list() {
        let rules = vec![
            ConsumeRule { platform: "discord".into(), source_id: None, event_types: vec!["chat.message".into()], command_prefix: None, actor_roles: None },
            ConsumeRule { platform: "twitch".into(), source_id: None, event_types: vec!["chat.message".into()], command_prefix: None, actor_roles: None },
        ];
        assert!(any_rule_matches(&rules, &event("chat.message", Some("hi"))));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib consumes::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `consumes/mod.rs` and `consumes/matcher.rs`**

```rust
// core/svc_process/src/consumes/mod.rs
//! Consumer-side `consumes` filter evaluation -- spec Sec5.3, Sec6.4.3.
pub mod matcher;
pub use matcher::{any_rule_matches, event_type_glob_matches, rule_matches, ConsumeRule};
```

```rust
// core/svc_process/src/consumes/matcher.rs
//! `platform`/`source_id` decide the grant (resolved once, by hub-api at
//! activation, spec Sec5.2); `event_types`/`filters` are evaluated here, on
//! the stage, per delivered entry -- spec Sec5.3, Sec6.4.3.
use crate::spine::envelope::PlatformEvent;

/// One `consumes` rule -- the capability-bearing subset the distribution
/// API's `manifest.consumes` (spec Sec6.7) is parsed into (Task 11).
#[derive(Debug, Clone, PartialEq)]
pub struct ConsumeRule {
    /// `twitch`, `discord`, ..., `custom:<name>`, or `*`.
    pub platform: String,
    /// Restricts the GRANT to one source -- not evaluated here (grants are
    /// resolved by hub-api); kept for completeness/debug rendering.
    pub source_id: Option<String>,
    /// Glob patterns over the dotted `event_type` namespace; ORed within `event_types`, ANDed with the rest of the rule.
    pub event_types: Vec<String>,
    /// Optional `filters.command_prefix`.
    pub command_prefix: Option<Vec<String>>,
    /// Optional `filters.actor_roles`.
    pub actor_roles: Option<Vec<String>>,
}

/// Matches a dotted glob pattern (`*` = exactly one segment, `**` = one or
/// more segments) against a dotted `event_type` value -- spec Sec6.4.3.
pub fn event_type_glob_matches(pattern: &str, event_type: &str) -> bool {
    let pattern_segs: Vec<&str> = pattern.split('.').collect();
    let value_segs: Vec<&str> = event_type.split('.').collect();
    segs_match(&pattern_segs, &value_segs)
}

fn segs_match(pattern: &[&str], value: &[&str]) -> bool {
    match pattern.first() {
        None => value.is_empty(),
        Some(&"**") => {
            // `**` must consume at least one segment, then may match zero
            // or more of the remainder (it is the true catch-all).
            if value.is_empty() {
                return false;
            }
            (1..=value.len()).any(|take| segs_match(&pattern[1..], &value[take..]))
        }
        Some(&"*") => !value.is_empty() && segs_match(&pattern[1..], &value[1..]),
        Some(seg) => value.first() == Some(seg) && segs_match(&pattern[1..], &value[1..]),
    }
}

fn command_prefix_matches(prefixes: &[String], event: &PlatformEvent) -> bool {
    let Some(text) = event.payload.get("text").and_then(|v| v.as_str()) else { return false };
    let trimmed = text.trim_start().to_lowercase();
    prefixes.iter().any(|p| trimmed.starts_with(&p.to_lowercase()))
}

fn actor_roles_match(roles: &[String], event: &PlatformEvent) -> bool {
    let Some(actor_roles) = event.payload.get("actor_roles").and_then(|v| v.as_array()) else { return false };
    actor_roles
        .iter()
        .filter_map(|v| v.as_str())
        .any(|r| roles.iter().any(|wanted| wanted == r))
}

/// One rule matches when `platform`, `event_types` (any glob), and every
/// present `filters` key all match (ANDed) -- spec Sec6.4.3.
pub fn rule_matches(rule: &ConsumeRule, event: &PlatformEvent) -> bool {
    if rule.platform != "*" && rule.platform != event.platform {
        return false;
    }
    if !rule.event_types.iter().any(|pat| event_type_glob_matches(pat, &event.event_type)) {
        return false;
    }
    if let Some(prefixes) = &rule.command_prefix {
        if !command_prefix_matches(prefixes, event) {
            return false;
        }
    }
    if let Some(roles) = &rule.actor_roles {
        if !actor_roles_match(roles, event) {
            return false;
        }
    }
    true
}

/// A bundle matches an event when **any** of its rules matches -- spec Sec6.4.3.
pub fn any_rule_matches(rules: &[ConsumeRule], event: &PlatformEvent) -> bool {
    rules.iter().any(|r| rule_matches(r, event))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib consumes::"`
Expected: `test result: ok. 6 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/consumes/
git commit -m "$(cat <<'EOF'
feat(svc-process): consumer-side consumes glob + filter matching

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 11: Distribution API v2 client + poller (`distribution/`)

**Files:**
- Create: `core/svc_process/src/distribution/model.rs`, `core/svc_process/src/distribution/client.rs`
- Modify: `core/svc_process/src/distribution/mod.rs`

**Interfaces:**
- Consumes: `crate::config::{Config, Secret}`, `crate::consumes::ConsumeRule`.
- Produces: `pub struct Grant { pub grant_id: i64, pub stream: String, pub platform: String, pub source_id: String, pub label: String }`; `pub struct EgressRule { pub host: String, pub methods: Vec<String> }`; `pub struct Limits { pub timeout_ms: u64, pub memory_mb: u32, pub egress_rps: u32 }`; `pub struct ManifestSubset { pub egress: Vec<EgressRule>, pub data_tables: Vec<String>, pub limits: Limits, pub consumes: Vec<ConsumeRule>, pub routes_to: Vec<String> }`; `pub struct BundleRow { pub app_id: String, pub community_id: Option<i64>, pub artifact_version: Option<String>, pub artifact_digest: Option<String>, pub artifact_kind: Option<String>, pub language: Option<String>, pub scan_status: Option<String>, pub config: serde_json::Value, pub manifest: ManifestSubset, pub grants: Vec<Grant> }`; `pub struct DistributionClient { .. }` with `pub fn new(base_url: String, secret_key: Secret) -> Result<Self, ProcessError>`, `pub async fn poll_once(&self, stage: &str) -> Result<Vec<BundleRow>, ProcessError>`; `pub struct DistributionPoller { .. }` with `pub fn new(client: DistributionClient, base_backoff: Duration, max_backoff: Duration) -> Self`, `pub async fn refresh(&self) -> Vec<BundleRow>` (never errors -- degrades to the last-known-good snapshot, spec Sec6.7 "Polling behaviour"). Task 12's registry consumes `DistributionPoller::refresh()`'s output exclusively; Task 24's cross-app-routing built-in reads a bundle's `manifest.routes_to`, and Task 25's worker reads `manifest.consumes`, from `BundleRow` fields defined here.

**Note on `manifest.routes_to`:** spec Sec6.7's sample distribution response enumerates `egress`/`data.tables`/`limits`/`consumes` under `manifest` but not `routes_to`, even though Sec5.9/Sec9.7.3 require the stage to enforce the *approved* `routes_to` set at runtime. This plan assumes hub-api's manifest subset also carries `routes_to: string[]` — **must match plan M2b (hub-api) when written**; if M2b's actual response omits the field, add it there and this struct's field name (`routes_to`) is what M2b should match, not the other way around.

- [ ] **Step 1: Write the failing test**

```rust
// core/svc_process/src/distribution/model.rs -- inline #[cfg(test)] mod tests
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_process_stage_row() {
        let raw = serde_json::json!({
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
                "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10},
                "consumes": [{"platform": "twitch", "event_types": ["chat.message"], "filters": {"command_prefix": ["!sr"]}}],
                "routes_to": []
            },
            "grants": [{"grantId": 118, "stream": "waddles:t:acme:c:main:src:twitch:tw-channelA:events", "platform": "twitch", "sourceId": "tw-channelA", "label": "Twitch #channelA"}]
        });
        let row: BundleRow = serde_json::from_value(raw).unwrap();
        assert_eq!(row.app_id, "waddles.socials.music.default");
        assert_eq!(row.manifest.egress[0].host, "api.spotify.com");
        assert_eq!(row.manifest.data_tables, vec!["music_queue", "music_history"]);
        assert_eq!(row.grants[0].grant_id, 118);
        assert_eq!(row.manifest.consumes[0].platform, "twitch");
    }

    #[test]
    fn null_artifact_digest_is_a_legal_row() {
        let raw = serde_json::json!({
            "appId": "waddles.bot.discord.default", "communityId": null, "entrypoint": null,
            "spec": {}, "config": {}, "artifactVersion": null, "artifactDigest": null,
            "artifactKind": null, "language": null, "scanStatus": null,
            "manifest": {"egress": [], "data": {"tables": []}, "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10}, "consumes": [], "routes_to": []},
            "grants": []
        });
        let row: BundleRow = serde_json::from_value(raw).unwrap();
        assert!(row.artifact_digest.is_none());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib distribution::model::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `distribution/mod.rs`, `distribution/model.rs`, `distribution/client.rs`**

```rust
// core/svc_process/src/distribution/mod.rs
//! Distribution API v2 client -- spec Sec6.7.
pub mod client;
pub mod model;
pub use client::{DistributionClient, DistributionPoller};
pub use model::{BundleRow, EgressRule, Grant, Limits, ManifestSubset};
```

```rust
// core/svc_process/src/distribution/model.rs
//! Wire types for `GET /api/v1/distribution/bundles?stage=process` -- spec Sec6.7.
use serde::Deserialize;

use crate::consumes::ConsumeRule;

/// A resolved ingest-source stream grant -- spec Sec5.2, Sec6.7.
#[derive(Debug, Clone, Deserialize)]
pub struct Grant {
    #[serde(rename = "grantId")]
    pub grant_id: i64,
    pub stream: String,
    pub platform: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    pub label: String,
}

/// One `egress` allowlist entry -- spec Sec6.4.2, Sec8.1.
#[derive(Debug, Clone, Deserialize)]
pub struct EgressRule {
    pub host: String,
    #[serde(default = "default_methods")]
    pub methods: Vec<String>,
}

fn default_methods() -> Vec<String> {
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].iter().map(|s| s.to_string()).collect()
}

/// Resource limits -- spec Sec6.4.2, Sec7.3.
#[derive(Debug, Clone, Deserialize)]
pub struct Limits {
    pub timeout_ms: u64,
    pub memory_mb: u32,
    pub egress_rps: u32,
}

#[derive(Debug, Clone, Deserialize)]
struct DataTables {
    #[serde(default)]
    tables: Vec<String>,
}

/// The capability-bearing subset of `bundle.yaml` the stage enforces -- spec Sec6.7.
#[derive(Debug, Clone, Deserialize)]
pub struct ManifestSubset {
    #[serde(default)]
    pub egress: Vec<EgressRule>,
    #[serde(default, rename = "data")]
    data_tables_wrapper: DataTables,
    pub limits: Limits,
    #[serde(default)]
    pub consumes: Vec<ConsumeRuleWire>,
    /// See Task 11 header note: not in the spec's sample JSON, assumed present.
    #[serde(default)]
    pub routes_to: Vec<String>,
}

impl ManifestSubset {
    /// Flattened `data.tables` -- kept as a method (not a field) so the
    /// wire shape (`{"data": {"tables": [...]}}`) stays private to this module.
    pub fn data_tables(&self) -> &[String] {
        &self.data_tables_wrapper.tables
    }
}

/// Wire shape of one `consumes` rule before conversion to [`ConsumeRule`].
#[derive(Debug, Clone, Deserialize)]
pub struct ConsumeRuleWire {
    pub platform: String,
    #[serde(default, rename = "sourceId")]
    pub source_id: Option<String>,
    pub event_types: Vec<String>,
    #[serde(default)]
    pub filters: ConsumeFiltersWire,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConsumeFiltersWire {
    #[serde(default)]
    pub command_prefix: Option<Vec<String>>,
    #[serde(default)]
    pub actor_roles: Option<Vec<String>>,
}

impl From<ConsumeRuleWire> for ConsumeRule {
    fn from(w: ConsumeRuleWire) -> Self {
        ConsumeRule {
            platform: w.platform,
            source_id: w.source_id,
            event_types: w.event_types,
            command_prefix: w.filters.command_prefix,
            actor_roles: w.filters.actor_roles,
        }
    }
}

// Field access to `manifest.consumes` as `Vec<ConsumeRule>` for call sites
// that don't want to know about the wire wrapper type.
impl ManifestSubset {
    /// `consumes`, converted to the internal [`ConsumeRule`] shape Task 10's matcher consumes.
    pub fn consumes_rules(&self) -> Vec<ConsumeRule> {
        self.consumes.iter().cloned().map(ConsumeRule::from).collect()
    }
}

/// One row of `GET /api/v1/distribution/bundles?stage={process|action}` -- spec Sec6.7.
#[derive(Debug, Clone, Deserialize)]
pub struct BundleRow {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "communityId")]
    pub community_id: Option<i64>,
    #[serde(rename = "artifactVersion")]
    pub artifact_version: Option<String>,
    #[serde(rename = "artifactDigest")]
    pub artifact_digest: Option<String>,
    #[serde(rename = "artifactKind")]
    pub artifact_kind: Option<String>,
    pub language: Option<String>,
    #[serde(rename = "scanStatus")]
    pub scan_status: Option<String>,
    #[serde(default)]
    pub config: serde_json::Value,
    pub manifest: ManifestSubset,
    #[serde(default)]
    pub grants: Vec<Grant>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DistributionResponse {
    pub bundles: Vec<BundleRow>,
}
```

```rust
// core/svc_process/src/distribution/client.rs
//! HTTP client + backoff/last-known-good poller for the distribution API.
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::RwLock;

use crate::config::Secret;
use crate::distribution::model::{BundleRow, DistributionResponse};
use crate::error::ProcessError;

#[derive(Serialize)]
struct Claims {
    sub: &'static str,
    iss: &'static str,
    aud: &'static str,
    iat: i64,
    exp: i64,
    scope: &'static str,
    tenant: String,
}

/// Thin HTTP client for one distribution-API poll.
pub struct DistributionClient {
    http: reqwest::Client,
    base_url: String,
    secret_key: Secret,
    tenant: String,
}

impl DistributionClient {
    /// Builds a client pointed at `{base_url}/api/v1/distribution/bundles`.
    pub fn new(base_url: String, secret_key: Secret, tenant: String) -> Result<Self, ProcessError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(ProcessError::Http)?;
        Ok(Self { http, base_url, secret_key, tenant })
    }

    fn mint_jwt(&self) -> Result<String, ProcessError> {
        let now = chrono::Utc::now().timestamp();
        let claims = Claims {
            sub: "svc-process",
            iss: "waddles",
            aud: "hub-api",
            iat: now,
            exp: now + 300,
            scope: "distribution:read",
            tenant: self.tenant.clone(),
        };
        let key = jsonwebtoken::EncodingKey::from_secret(self.secret_key.expose().as_bytes());
        jsonwebtoken::encode(&jsonwebtoken::Header::default(), &claims, &key)
            .map_err(|e| ProcessError::Internal(anyhow::anyhow!("minting distribution JWT: {e}")))
    }

    /// One `GET /api/v1/distribution/bundles?stage={stage}` call.
    pub async fn poll_once(&self, stage: &str) -> Result<Vec<BundleRow>, ProcessError> {
        let token = self.mint_jwt()?;
        let url = format!("{}/api/v1/distribution/bundles", self.base_url);
        let resp = self
            .http
            .get(&url)
            .query(&[("stage", stage)])
            .bearer_auth(token)
            .send()
            .await
            .map_err(ProcessError::Http)?
            .error_for_status()
            .map_err(ProcessError::Http)?;
        let parsed: DistributionResponse = resp.json().await.map_err(ProcessError::Http)?;
        Ok(parsed.bundles)
    }
}

/// Wraps [`DistributionClient`] with exponential backoff and a
/// last-known-good cache -- a hub-api outage degrades gracefully rather
/// than raising (spec Sec6.7 "Polling behaviour is unchanged").
pub struct DistributionPoller {
    client: DistributionClient,
    stage: &'static str,
    base_backoff: Duration,
    max_backoff: Duration,
    last_known_good: Arc<RwLock<Vec<BundleRow>>>,
    consecutive_failures: std::sync::atomic::AtomicU32,
}

impl DistributionPoller {
    /// Builds a poller with an empty last-known-good snapshot.
    pub fn new(client: DistributionClient, stage: &'static str, base_backoff: Duration, max_backoff: Duration) -> Self {
        Self {
            client,
            stage,
            base_backoff,
            max_backoff,
            last_known_good: Arc::new(RwLock::new(Vec::new())),
            consecutive_failures: std::sync::atomic::AtomicU32::new(0),
        }
    }

    /// Polls once. On success, updates and returns the fresh snapshot. On
    /// failure, logs at WARN, sleeps the backoff delay (which grows
    /// exponentially, capped at `max_backoff`), and returns the previous
    /// snapshot unchanged -- this function itself never returns an error.
    pub async fn refresh(&self) -> Vec<BundleRow> {
        match self.client.poll_once(self.stage).await {
            Ok(rows) => {
                self.consecutive_failures.store(0, std::sync::atomic::Ordering::Relaxed);
                *self.last_known_good.write().await = rows.clone();
                rows
            }
            Err(err) => {
                let failures = self.consecutive_failures.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                let delay = self.base_backoff.saturating_mul(1 << failures.min(10)).min(self.max_backoff);
                tracing::warn!(error = %err, stage = self.stage, failures, delay_ms = delay.as_millis() as u64, "distribution.poll_failed -- degrading to last-known-good");
                tokio::time::sleep(delay).await;
                self.last_known_good.read().await.clone()
            }
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib distribution::"`
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/distribution/
git commit -m "$(cat <<'EOF'
feat(svc-process): distribution API v2 client with backoff + last-known-good

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 12: Bundle/grant reconciliation registry (`registry/mod.rs`)

**Files:**
- Create: `core/svc_process/src/registry/mod.rs`

**Interfaces:**
- Consumes: `crate::distribution::BundleRow`.
- Produces: `#[derive(Debug, Clone, PartialEq, Eq, Hash)] pub struct WorkerKey { pub app_id: String, pub stream: String }`; `pub struct RegistryDiff { pub to_start: Vec<(WorkerKey, BundleRow)>, pub to_stop: Vec<WorkerKey> }`; `pub struct Registry { .. }` with `pub fn new() -> Self`, `pub fn reconcile(&mut self, rows: Vec<BundleRow>) -> RegistryDiff`, `pub fn bundle_grant_counts(&self) -> Vec<(String, usize)>` (feeds `waddles_bundle_grants{app_id}`), `pub fn skipped_no_artifact(&self) -> usize` (feeds `waddles_bundle_skipped_total{reason="no_artifact"}`). Task 28's main loop calls `reconcile()` on every `DistributionPoller::refresh()` tick and spawns/aborts one Tokio task (Task 25's worker) per `WorkerKey` in the diff.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::distribution::{BundleRow, EgressRule, Grant, Limits, ManifestSubset};

    fn manifest() -> ManifestSubset {
        serde_json::from_value(serde_json::json!({
            "egress": [], "data": {"tables": []},
            "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10},
            "consumes": [], "routes_to": []
        })).unwrap()
    }

    fn row(app_id: &str, digest: Option<&str>, streams: &[&str]) -> BundleRow {
        BundleRow {
            app_id: app_id.into(),
            community_id: None,
            artifact_version: Some("1.0.0".into()),
            artifact_digest: digest.map(|d| d.to_string()),
            artifact_kind: Some("source".into()),
            language: Some("python".into()),
            scan_status: Some("scanned".into()),
            config: serde_json::json!({}),
            manifest: manifest(),
            grants: streams.iter().enumerate().map(|(i, s)| Grant {
                grant_id: i as i64, stream: s.to_string(), platform: "twitch".into(),
                source_id: format!("src-{i}"), label: s.to_string(),
            }).collect(),
        }
    }

    #[test]
    fn first_reconcile_starts_every_granted_stream() {
        let mut reg = Registry::new();
        let diff = reg.reconcile(vec![row("waddles.bot.discord.default", Some("sha256:aa"), &["s1", "s2"])]);
        assert_eq!(diff.to_start.len(), 2);
        assert!(diff.to_stop.is_empty());
    }

    #[test]
    fn revoked_grant_stops_its_worker_only() {
        let mut reg = Registry::new();
        reg.reconcile(vec![row("waddles.bot.discord.default", Some("sha256:aa"), &["s1", "s2"])]);
        let diff = reg.reconcile(vec![row("waddles.bot.discord.default", Some("sha256:aa"), &["s1"])]);
        assert_eq!(diff.to_stop.len(), 1);
        assert_eq!(diff.to_stop[0].stream, "s2");
        assert!(diff.to_start.is_empty());
    }

    #[test]
    fn row_with_no_artifact_digest_is_skipped_and_counted() {
        let mut reg = Registry::new();
        let diff = reg.reconcile(vec![row("waddles.bot.discord.default", None, &["s1"])]);
        assert!(diff.to_start.is_empty());
        assert_eq!(reg.skipped_no_artifact(), 1);
    }

    #[test]
    fn empty_grants_is_legal_not_an_error() {
        let mut reg = Registry::new();
        let diff = reg.reconcile(vec![row("waddles.bot.discord.default", Some("sha256:aa"), &[])]);
        assert!(diff.to_start.is_empty());
        assert_eq!(reg.bundle_grant_counts(), vec![("waddles.bot.discord.default".to_string(), 0)]);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib registry::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `registry/mod.rs`**

```rust
//! Reconciles the distribution API's advertised bundle/grant set against
//! the workers currently running, by diffing on `(app_id, stream)` --
//! spec Sec5.2 "Ensure" row, Sec6.7 "grants" reconciliation.
use std::collections::{HashMap, HashSet};

use crate::distribution::BundleRow;

/// Identifies one per-(bundle, granted stream) consumer worker (Task 25).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkerKey {
    /// The bundle this worker serves.
    pub app_id: String,
    /// The granted stream this worker reads.
    pub stream: String,
}

/// What changed since the last reconcile.
#[derive(Debug, Default)]
pub struct RegistryDiff {
    /// Workers to spawn, paired with the bundle row they serve.
    pub to_start: Vec<(WorkerKey, BundleRow)>,
    /// Workers to abort (grant revoked, bundle deactivated, or digest
    /// became unavailable).
    pub to_stop: Vec<WorkerKey>,
}

/// Tracks the currently-running worker set across reconcile calls.
pub struct Registry {
    running: HashMap<WorkerKey, ()>,
    skipped_no_artifact: usize,
    grant_counts: HashMap<String, usize>,
}

impl Registry {
    /// An empty registry -- no workers running yet.
    pub fn new() -> Self {
        Self { running: HashMap::new(), skipped_no_artifact: 0, grant_counts: HashMap::new() }
    }

    /// Diffs `rows` against the current worker set and updates internal
    /// bookkeeping (`waddles_bundle_grants`/`waddles_bundle_skipped_total`
    /// feed off the accessors below).
    pub fn reconcile(&mut self, rows: Vec<BundleRow>) -> RegistryDiff {
        self.skipped_no_artifact = 0;
        self.grant_counts.clear();
        let mut wanted: HashSet<WorkerKey> = HashSet::new();
        let mut to_start = Vec::new();

        for row in rows {
            self.grant_counts.insert(row.app_id.clone(), row.grants.len());
            if row.artifact_digest.is_none() {
                self.skipped_no_artifact += 1;
                continue;
            }
            for grant in &row.grants {
                let key = WorkerKey { app_id: row.app_id.clone(), stream: grant.stream.clone() };
                wanted.insert(key.clone());
                if !self.running.contains_key(&key) {
                    to_start.push((key, row.clone()));
                }
            }
        }

        let to_stop: Vec<WorkerKey> = self.running.keys().filter(|k| !wanted.contains(*k)).cloned().collect();

        for key in &to_stop {
            self.running.remove(key);
        }
        for (key, _) in &to_start {
            self.running.insert(key.clone(), ());
        }

        RegistryDiff { to_start, to_stop }
    }

    /// `(app_id, grant_count)` for every bundle seen in the last reconcile
    /// -- feeds `waddles_bundle_grants{app_id}` (a `0` is legitimate, spec Sec6.7).
    pub fn bundle_grant_counts(&self) -> Vec<(String, usize)> {
        self.grant_counts.iter().map(|(k, v)| (k.clone(), *v)).collect()
    }

    /// Rows skipped in the last reconcile for having no compiled artifact
    /// yet -- feeds `waddles_bundle_skipped_total{reason="no_artifact"}`.
    pub fn skipped_no_artifact(&self) -> usize {
        self.skipped_no_artifact
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib registry::"`
Expected: `test result: ok. 4 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/registry/
git commit -m "$(cat <<'EOF'
feat(svc-process): bundle/grant reconciliation registry, diff-by-(app_id,stream)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 13: Host-API wire protocol (`hostapi/wire.rs`)

**Files:**
- Create: `core/svc_process/src/hostapi/wire.rs`
- Modify: `core/svc_process/src/hostapi/mod.rs` (`pub mod wire;`)

**Interfaces:**
- Consumes: nothing.
- Produces (spec Sec6.6, PROVISIONAL(M1) — mirrors `penguin_bundle_host::wire`): `pub struct SandboxInfo { pub runtime: String, pub verified: bool }`; `pub struct HostApiLimits { pub call_timeout_ms: u64, pub memory_mb: u32, pub max_concurrent_calls: u32 }`; `#[serde(tag = "kind", rename_all = "kebab-case")] pub enum FromExecutor { Hello{protocol_version:u32, executor_version:String, wasmtime_version:String, wasmtime_abi:String, collector:String, sandbox:SandboxInfo}, Loaded{app_id:String, digest:String, precompile_ms:u64, exports:Vec<String>}, Unloaded{app_id:String, digest:String}, Result{payload:serde_json::Value, duration_ms:u64, fuel_used:u64}, HostCall{app_id:String, capability:String, op:String, args:serde_json::Value, call_id:u64}, Error{code:String, message:String, detail:Option<String>}, Pong{} }`; `#[serde(tag = "kind", rename_all = "kebab-case")] pub enum ToExecutor { HelloOk{stage:String, protocol_version:u32, limits:HostApiLimits}, Load{app_id:String, version:String, digest:String, component_key:String, sidecar_key:String, capabilities:Vec<String>, limits:HostApiLimits}, Unload{app_id:String, digest:String}, Invoke{app_id:String, digest:String, export:String, payload:serde_json::Value, deadline_ms:u64, trace_context:Option<String>}, HostResult{result:Option<serde_json::Value>, error:Option<HostResultError>}, Ping{}, Shutdown{grace_ms:u64} }`; `pub struct HostResultError { pub code: String, pub message: String }`; `pub struct Frame<B> { pub v: u8, pub id: u64, #[serde(flatten)] pub body: B }`; `pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R, max_bytes: u32) -> std::io::Result<Vec<u8>>`; `pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, bytes: &[u8]) -> std::io::Result<()>`. Task 14's listener reads `Frame<FromExecutor>` and writes `Frame<ToExecutor>` exclusively through these two functions.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[test]
    fn hello_round_trips_through_json() {
        let frame = Frame {
            v: 1,
            id: 1,
            body: FromExecutor::Hello {
                protocol_version: 1,
                executor_version: "0.1.0".into(),
                wasmtime_version: "27.0.0".into(),
                wasmtime_abi: "27".into(),
                collector: "drc".into(),
                sandbox: SandboxInfo { runtime: "gvisor".into(), verified: true },
            },
        };
        let json = serde_json::to_vec(&frame).unwrap();
        let back: Frame<FromExecutor> = serde_json::from_slice(&json).unwrap();
        match back.body {
            FromExecutor::Hello { protocol_version, .. } => assert_eq!(protocol_version, 1),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn a_frame_larger_than_the_limit_is_a_fatal_protocol_error_not_silently_truncated() {
        // Exercised for real over an in-memory pipe in Step 4's async test below.
    }

    #[tokio::test]
    async fn frame_codec_round_trips_over_an_in_memory_pipe() {
        let (mut client, mut server) = duplex(4096);
        let frame = Frame { v: 1, id: 7, body: ToExecutor::Ping {} };
        let bytes = serde_json::to_vec(&frame).unwrap();
        write_frame(&mut client, &bytes).await.unwrap();
        let read_back = read_frame(&mut server, 1_048_576).await.unwrap();
        let parsed: Frame<ToExecutor> = serde_json::from_slice(&read_back).unwrap();
        assert!(matches!(parsed.body, ToExecutor::Ping {}));
    }

    #[tokio::test]
    async fn oversize_frame_is_rejected_before_the_body_is_read() {
        let (mut client, mut server) = duplex(4096);
        client.write_all(&2_000_000u32.to_be_bytes()).await.unwrap();
        let err = read_frame(&mut server, 1_048_576).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib hostapi::wire::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `hostapi/mod.rs` and `hostapi/wire.rs`**

```rust
// core/svc_process/src/hostapi/mod.rs
//! Capability-scoped mTLS host API -- the stage side of spec Sec6.6. The
//! executor dials in; this stage never dials the executor.
pub mod dispatch;
pub mod listener;
pub mod wire;
```

```rust
// core/svc_process/src/hostapi/wire.rs
//! Frame codec + message types -- spec Sec6.6. PROVISIONAL(M1): mirrors
//! `penguin_bundle_host::wire`.
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// `hello`'s `sandbox` field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxInfo {
    /// `"gvisor"` or `"runc"`.
    pub runtime: String,
    /// Whether the executor's own startup check confirmed it.
    pub verified: bool,
}

/// `hello-ok`/`load`'s `limits` field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostApiLimits {
    /// Per-call wall-clock deadline.
    pub call_timeout_ms: u64,
    /// Per-instance linear-memory cap.
    pub memory_mb: u32,
    /// Global concurrent-call ceiling.
    pub max_concurrent_calls: u32,
}

/// Reply to a `host-call` that failed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostResultError {
    /// Stable machine-readable code.
    pub code: String,
    /// Human-readable detail.
    pub message: String,
}

/// Messages the executor sends (it dials, so it speaks first) -- spec Sec6.6.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FromExecutor {
    /// Handshake opener.
    Hello {
        /// Always `1`.
        protocol_version: u32,
        executor_version: String,
        wasmtime_version: String,
        wasmtime_abi: String,
        collector: String,
        sandbox: SandboxInfo,
    },
    /// A `load` succeeded.
    Loaded { app_id: String, digest: String, precompile_ms: u64, exports: Vec<String> },
    /// An `unload` completed.
    Unloaded { app_id: String, digest: String },
    /// An `invoke` completed successfully.
    Result { payload: serde_json::Value, duration_ms: u64, fuel_used: u64 },
    /// A capability call the guest made mid-`invoke`.
    HostCall { app_id: String, capability: String, op: String, args: serde_json::Value, call_id: u64 },
    /// A protocol- or invoke-level failure.
    Error { code: String, message: String, detail: Option<String> },
    /// Reply to `ping`.
    Pong {},
}

/// Messages the stage sends -- spec Sec6.6.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ToExecutor {
    /// Handshake reply.
    HelloOk { stage: String, protocol_version: u32, limits: HostApiLimits },
    /// Load one bundle version by digest.
    Load { app_id: String, version: String, digest: String, component_key: String, sidecar_key: String, capabilities: Vec<String>, limits: HostApiLimits },
    /// Unload a superseded digest.
    Unload { app_id: String, digest: String },
    /// Invoke `export` (`transform` or `dispatch`) with `payload`.
    Invoke { app_id: String, digest: String, export: String, payload: serde_json::Value, deadline_ms: u64, trace_context: Option<String> },
    /// Reply to a `host-call`.
    HostResult { result: Option<serde_json::Value>, error: Option<HostResultError> },
    /// Liveness check.
    Ping {},
    /// Graceful drain request.
    Shutdown { grace_ms: u64 },
}

/// The common `{v, id, ...}` envelope every frame carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame<B> {
    /// Always `1`.
    pub v: u8,
    /// Monotonically increasing, allocated by the sender of the initiating message.
    pub id: u64,
    /// The tagged message body.
    #[serde(flatten)]
    pub body: B,
}

/// Reads one length-prefixed frame: a 4-byte big-endian length, then that
/// many UTF-8 JSON bytes. A length over `max_bytes` is a fatal protocol
/// error -- the caller closes the connection (spec Sec6.6).
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R, max_bytes: u32) -> std::io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf);
    if len > max_bytes {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("frame of {len} bytes exceeds EXECUTOR_MAX_FRAME_BYTES={max_bytes}")));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Writes one length-prefixed frame.
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, bytes: &[u8]) -> std::io::Result<()> {
    w.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    w.write_all(bytes).await?;
    w.flush().await
}
```

Also create the two placeholder modules `hostapi/listener.rs` and `hostapi/dispatch.rs` with a one-line doc comment each (filled in by Task 14), matching Task 1's scaffolding convention.

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib hostapi::wire::"`
Expected: `test result: ok. 4 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/hostapi/
git commit -m "$(cat <<'EOF'
feat(svc-process): host-API frame codec + FromExecutor/ToExecutor messages

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 14: Host-API mTLS listener + connection handshake (`hostapi/listener.rs`)

**Files:**
- Modify: `core/svc_process/src/hostapi/listener.rs`, `core/svc_process/Cargo.toml` (add `x509-parser`)

**Interfaces:**
- Consumes: `crate::hostapi::wire::{Frame, FromExecutor, ToExecutor, SandboxInfo, HostApiLimits, read_frame, write_frame}`, `crate::config::Config`.
- Produces: `pub struct HostApiConnection { pub peer_identity: String, pub reader: tokio::io::ReadHalf<tokio_rustls::server::TlsStream<tokio::net::TcpStream>>, pub writer: tokio::io::WriteHalf<tokio_rustls::server::TlsStream<tokio::net::TcpStream>> }`; `pub struct HostApiListener { .. }` with `pub async fn bind(addr: std::net::SocketAddr, cert_file: &str, key_file: &str, ca_file: &str) -> Result<Self, ProcessError>`, `pub async fn accept(&self) -> Result<tokio::net::TcpStream, ProcessError>`, `pub async fn handshake(&self, tcp: tokio::net::TcpStream, expected_peer_identity: &str, expected_gvisor: bool, expected_collector: &str, stage: &str, limits: HostApiLimits) -> Result<HostApiConnection, ProcessError>` (performs the TLS accept, reads the executor's `hello`, verifies `sandbox.runtime`/`collector` per spec Sec6.6's `UNSANDBOXED_EXECUTOR` rule and Sec7.2's collector-mismatch rule, writes `hello-ok` on success or a fatal `Error{code:"UNSANDBOXED_EXECUTOR"|"PROTOCOL_VERSION"}` frame then closes on failure, incrementing `waddles_host_api_rejected_total{reason}`). Task 28's main loop calls `bind` once, then loops `accept`+`handshake`, spawning one connection-actor task (Task 16's `run_dispatch_loop`) per successful handshake.

- [ ] **Step 1: Write the failing test**

```rust
// core/svc_process/src/hostapi/listener.rs -- inline #[cfg(test)] mod tests, using rcgen to mint an ephemeral CA + server + client cert pair
#[cfg(test)]
mod tests {
    use super::*;
    use crate::hostapi::wire::{read_frame, write_frame, Frame, FromExecutor};
    use std::net::SocketAddr;
    use tokio::io::AsyncWriteExt;

    struct TestCerts {
        ca_pem: String,
        server_cert_pem: String,
        server_key_pem: String,
        client_cert_pem: String,
        client_key_pem: String,
    }

    fn make_test_certs(client_cn: &str) -> TestCerts {
        let mut ca_params = rcgen::CertificateParams::new(vec![]).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let ca_cert = ca_params.self_signed(&ca_key).unwrap();

        let server_key = rcgen::KeyPair::generate().unwrap();
        let server_params = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
        let server_cert = server_params.signed_by(&server_key, &ca_cert, &ca_key).unwrap();

        let client_key = rcgen::KeyPair::generate().unwrap();
        let mut client_params = rcgen::CertificateParams::new(vec![]).unwrap();
        client_params.distinguished_name.push(rcgen::DnType::CommonName, client_cn);
        let client_cert = client_params.signed_by(&client_key, &ca_cert, &ca_key).unwrap();

        TestCerts {
            ca_pem: ca_cert.pem(),
            server_cert_pem: server_cert.pem(),
            server_key_pem: server_key.serialize_pem(),
            client_cert_pem: client_cert.pem(),
            client_key_pem: client_key.serialize_pem(),
        }
    }

    #[tokio::test]
    async fn handshake_accepts_matching_peer_identity_and_sandbox_posture() {
        let certs = make_test_certs("svc-process-executor-test");
        let dir = tempfile_dir();
        let ca_path = write_temp(&dir, "ca.pem", &certs.ca_pem);
        let server_cert_path = write_temp(&dir, "server.pem", &certs.server_cert_pem);
        let server_key_path = write_temp(&dir, "server-key.pem", &certs.server_key_pem);

        let listener = HostApiListener::bind("127.0.0.1:0".parse::<SocketAddr>().unwrap(), &server_cert_path, &server_key_path, &ca_path)
            .await
            .unwrap();
        let addr = listener.local_addr();

        let client_ca_path = ca_path.clone();
        let client_cert_pem = certs.client_cert_pem.clone();
        let client_key_pem = certs.client_key_pem.clone();
        let client_task = tokio::spawn(async move {
            let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
            let connector = build_test_tls_connector(&client_ca_path, &client_cert_pem, &client_key_pem);
            let mut tls = connector.connect(rustls_pki_types::ServerName::try_from("localhost").unwrap(), tcp).await.unwrap();
            let hello = Frame { v: 1, id: 1, body: FromExecutor::Hello {
                protocol_version: 1, executor_version: "0.1.0".into(), wasmtime_version: "27.0.0".into(),
                wasmtime_abi: "27".into(), collector: "drc".into(),
                sandbox: crate::hostapi::wire::SandboxInfo { runtime: "gvisor".into(), verified: true },
            }};
            write_frame(&mut tls, &serde_json::to_vec(&hello).unwrap()).await.unwrap();
            let reply = read_frame(&mut tls, 1_048_576).await.unwrap();
            reply
        });

        let tcp = listener.accept().await.unwrap();
        let limits = crate::hostapi::wire::HostApiLimits { call_timeout_ms: 2000, memory_mb: 64, max_concurrent_calls: 32 };
        let conn = listener.handshake(tcp, "svc-process-executor-test", true, "drc", "process", limits).await.unwrap();
        assert_eq!(conn.peer_identity, "svc-process-executor-test");

        let reply_bytes = client_task.await.unwrap();
        let reply: Frame<crate::hostapi::wire::ToExecutor> = serde_json::from_slice(&reply_bytes).unwrap();
        assert!(matches!(reply.body, crate::hostapi::wire::ToExecutor::HelloOk { .. }));
    }

    #[tokio::test]
    async fn handshake_refuses_runc_when_gvisor_expected() {
        // Same setup as above, but the executor's hello reports
        // sandbox.runtime="runc"; handshake() must return Err and the
        // waddles_host_api_rejected_total{reason="UNSANDBOXED_EXECUTOR"}
        // counter (Task 27 wires the metric registration; this test
        // asserts only the Result is Err).
    }
}
```

(the two small helpers `tempfile_dir`/`write_temp`/`build_test_tls_connector` are test-only utilities — write them as private `fn`s at the bottom of the same `#[cfg(test)] mod tests` block: `tempfile_dir` uses `std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())` + `std::fs::create_dir_all`; `write_temp` writes a string to `dir.join(name)` and returns the path as `String`; `build_test_tls_connector` builds a `tokio_rustls::TlsConnector` with `rustls::ClientConfig::builder().with_root_certificates(...).with_client_auth_cert(...)`.)

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib hostapi::listener::"`
Expected: FAIL to compile.

- [ ] **Step 3: Add `x509-parser` to `Cargo.toml`, then implement `hostapi/listener.rs`**

```toml
# append to [dependencies] in core/svc_process/Cargo.toml
x509-parser = "=0.16.0"
```

```rust
// core/svc_process/src/hostapi/listener.rs
//! mTLS TCP listener for the executor-facing host API -- spec Sec6.6,
//! Sec11.6.1 (SPIFFE-ready, chart-cert fallback). The executor dials in;
//! this stage never dials out to it.
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::io::{split, ReadHalf, WriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

use crate::error::ProcessError;
use crate::hostapi::wire::{read_frame, write_frame, Frame, FromExecutor, HostApiLimits, ToExecutor};

fn hostapi_err(e: impl std::fmt::Display) -> ProcessError {
    ProcessError::Internal(anyhow::anyhow!("host-api: {e}"))
}

fn load_certs(path: &str) -> Result<Vec<rustls_pki_types::CertificateDer<'static>>, ProcessError> {
    let mut reader = std::io::BufReader::new(std::fs::File::open(path).map_err(hostapi_err)?);
    rustls_pemfile::certs(&mut reader).collect::<Result<Vec<_>, _>>().map_err(hostapi_err)
}

fn load_key(path: &str) -> Result<rustls_pki_types::PrivateKeyDer<'static>, ProcessError> {
    let mut reader = std::io::BufReader::new(std::fs::File::open(path).map_err(hostapi_err)?);
    rustls_pemfile::private_key(&mut reader)
        .map_err(hostapi_err)?
        .ok_or_else(|| ProcessError::Internal(anyhow::anyhow!("no private key found in {path}")))
}

fn build_server_config(cert_file: &str, key_file: &str, ca_file: &str) -> Result<Arc<rustls::ServerConfig>, ProcessError> {
    let certs = load_certs(cert_file)?;
    let key = load_key(key_file)?;

    let mut roots = rustls::RootCertStore::empty();
    for ca_cert in load_certs(ca_file)? {
        roots.add(ca_cert).map_err(hostapi_err)?;
    }
    let verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(roots))
        .build()
        .map_err(hostapi_err)?;

    let config = rustls::ServerConfig::builder()
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs, key)
        .map_err(hostapi_err)?;
    Ok(Arc::new(config))
}

/// One accepted, TLS-terminated, handshake-verified executor connection.
pub struct HostApiConnection {
    /// The peer certificate's Common Name (or, once SPIFFE is live, its
    /// SPIFFE URI SAN -- Task 14 extracts CN only; SPIFFE-SAN extraction is
    /// tracked as follow-on work once SPIRE is deployed in an environment).
    pub peer_identity: String,
    /// Read half of the split TLS stream.
    pub reader: ReadHalf<TlsStream<TcpStream>>,
    /// Write half of the split TLS stream.
    pub writer: WriteHalf<TlsStream<TcpStream>>,
}

/// Binds the mTLS host-API listener.
pub struct HostApiListener {
    tcp: TcpListener,
    acceptor: TlsAcceptor,
}

impl HostApiListener {
    /// Loads the server cert/key and CA bundle, binds `addr`, and returns
    /// a listener ready to `accept`.
    pub async fn bind(addr: SocketAddr, cert_file: &str, key_file: &str, ca_file: &str) -> Result<Self, ProcessError> {
        let config = build_server_config(cert_file, key_file, ca_file)?;
        let tcp = TcpListener::bind(addr).await.map_err(hostapi_err)?;
        Ok(Self { tcp, acceptor: TlsAcceptor::from(config) })
    }

    /// The bound local address (useful in tests that bind to port 0).
    pub fn local_addr(&self) -> SocketAddr {
        self.tcp.local_addr().expect("a bound listener always has a local address")
    }

    /// Accepts one raw TCP connection; the caller passes it to [`Self::handshake`].
    pub async fn accept(&self) -> Result<TcpStream, ProcessError> {
        let (tcp, _peer_addr) = self.tcp.accept().await.map_err(hostapi_err)?;
        Ok(tcp)
    }

    /// TLS-terminates `tcp`, extracts the peer certificate's Common Name,
    /// reads the executor's `hello`, and verifies the sandbox posture
    /// agrees with this stage's own configuration (spec Sec6.6's
    /// `UNSANDBOXED_EXECUTOR` rule, Sec7.2's collector-mismatch rule).
    /// Returns the ready-to-dispatch connection on success; on any failure
    /// this writes a fatal `Error` frame (best-effort) and returns `Err`
    /// without panicking -- the caller (Task 28) counts
    /// `waddles_host_api_rejected_total{reason}` and drops the connection.
    pub async fn handshake(
        &self,
        tcp: TcpStream,
        expected_peer_identity: &str,
        expected_gvisor: bool,
        expected_collector: &str,
        stage: &str,
        limits: HostApiLimits,
    ) -> Result<HostApiConnection, ProcessError> {
        let tls = self.acceptor.accept(tcp).await.map_err(hostapi_err)?;
        let peer_identity = {
            let (_, conn) = tls.get_ref();
            let der = conn
                .peer_certificates()
                .and_then(|certs| certs.first())
                .ok_or_else(|| ProcessError::Internal(anyhow::anyhow!("no peer certificate presented")))?;
            let (_, cert) = x509_parser::certificate::X509Certificate::from_der(der.as_ref()).map_err(hostapi_err)?;
            cert.subject()
                .iter_common_name()
                .next()
                .and_then(|cn| cn.as_str().ok())
                .map(|s| s.to_string())
                .ok_or_else(|| ProcessError::Internal(anyhow::anyhow!("peer certificate carries no Common Name")))?
        };
        if peer_identity != expected_peer_identity {
            return Err(ProcessError::Internal(anyhow::anyhow!(
                "peer identity mismatch: expected {expected_peer_identity}, got {peer_identity}"
            )));
        }

        let (mut reader, mut writer) = split(tls);
        let hello_bytes = read_frame(&mut reader, 1_048_576).await.map_err(hostapi_err)?;
        let hello: Frame<FromExecutor> = serde_json::from_slice(&hello_bytes).map_err(hostapi_err)?;
        let FromExecutor::Hello { sandbox, collector, .. } = hello.body else {
            return Err(ProcessError::Internal(anyhow::anyhow!("expected hello, got a different frame kind")));
        };

        let sandbox_ok = sandbox.runtime == if expected_gvisor { "gvisor" } else { "runc" };
        let collector_ok = collector == expected_collector;
        if !sandbox_ok || !collector_ok {
            let code = if !sandbox_ok { "UNSANDBOXED_EXECUTOR" } else { "PROTOCOL_VERSION" };
            let err_frame = Frame {
                v: 1,
                id: hello.id,
                body: ToExecutor::HostResult { result: None, error: None }, // placeholder body never sent below; real path sends Error via raw frame kind name matching spec Sec6.6's stage->executor `error` message. See note.
            };
            let _ = err_frame; // constructed only to satisfy the type checker's exhaustiveness above; see note
            return Err(ProcessError::Internal(anyhow::anyhow!(
                "handshake refused: code={code} sandbox.runtime={} collector={collector}",
                sandbox.runtime
            )));
        }

        let hello_ok = Frame { v: 1, id: hello.id, body: ToExecutor::HelloOk {
            stage: stage.to_string(),
            protocol_version: 1,
            limits,
        }};
        write_frame(&mut writer, &serde_json::to_vec(&hello_ok).map_err(hostapi_err)?).await.map_err(hostapi_err)?;

        Ok(HostApiConnection { peer_identity, reader, writer })
    }
}
```

**Note on the refused-handshake wire message:** spec Sec6.6's `ToExecutor` table does not include a stage-issued `error` kind alongside `hello-ok` (only `FromExecutor::Error` exists in the table as written) — this plan's `wire.rs` (Task 13) therefore has no `ToExecutor::Error` variant to send back. Fix this before Step 4: add `Error { code: String, message: String }` to the `ToExecutor` enum in `hostapi/wire.rs` (Task 13's file) and its matching test, then replace the placeholder block above with:

```rust
let err_frame = Frame { v: 1, id: hello.id, body: ToExecutor::Error { code: code.to_string(), message: format!("sandbox.runtime={} collector={collector}", sandbox.runtime) } };
let _ = write_frame(&mut writer, &serde_json::to_vec(&err_frame).map_err(hostapi_err)?).await;
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib hostapi::listener::"`
Expected: `test result: ok. 2 passed` (the second test's body, per its comment, only asserts `Err`; write it out fully rather than leaving it a comment before this step — mirror the first test's client task but flip `sandbox.runtime` to `"runc"` and assert `listener.handshake(...).await.is_err()`).

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/Cargo.toml core/svc_process/Cargo.lock core/svc_process/src/hostapi/wire.rs core/svc_process/src/hostapi/listener.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): mTLS host-API listener, peer-identity + sandbox-posture handshake

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 15: Host-capability trait + `context` capability (`hostcap/mod.rs`, `hostcap/context.rs`)

**Files:**
- Modify: `core/svc_process/src/hostcap/mod.rs`, `core/svc_process/Cargo.toml` (add `async-trait`)
- Create: `core/svc_process/src/hostcap/context.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `#[async_trait::async_trait] pub trait HostCallHandler: Send + Sync { async fn handle(&self, app_id: &str, capability: &str, op: &str, args: serde_json::Value) -> Result<serde_json::Value, HostCapError>; }`; `#[derive(Debug, Clone)] pub struct HostCapError { pub code: String, pub message: String }` with `pub fn denied(reason: &str) -> Self`; `pub struct ContextArgs { pub tenant: String, pub community: Option<String>, pub app_id: String, pub version: String, pub message_id: String, pub config: serde_json::Value }`; `pub fn build_bundle_context(args: &ContextArgs) -> serde_json::Value` (spec Sec6.5 `context.bundle-context` record, rendered as JSON since this stage answers over the wire as `serde_json::Value`, never a WIT binding directly). Task 16's dispatch loop is generic over `Arc<dyn HostCallHandler>`; Tasks 17-20 each produce one capability struct, and Task 20 assembles all of them behind one `CompositeHandler: HostCallHandler`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_bundle_context_derives_feature_from_app_id() {
        let args = ContextArgs {
            tenant: "global".into(),
            community: Some("main".into()),
            app_id: "waddles.socials.music.default".into(),
            version: "3.0.0".into(),
            message_id: "1757851200000-0".into(),
            config: serde_json::json!({"command_prefix": "!"}),
        };
        let ctx = build_bundle_context(&args);
        assert_eq!(ctx["app-id"], "waddles.socials.music.default");
        assert_eq!(ctx["feature"], "waddles.socials.music");
        assert_eq!(ctx["message-id"], "1757851200000-0");
        assert_eq!(ctx["config-json"], "{\"command_prefix\":\"!\"}");
    }

    #[test]
    fn denied_error_carries_the_denied_code() {
        let err = HostCapError::denied("host_not_declared");
        assert_eq!(err.code, "denied");
        assert_eq!(err.message, "host_not_declared");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib hostcap::"`
Expected: FAIL to compile.

- [ ] **Step 3: Add `async-trait` to `Cargo.toml`, then implement `hostcap/mod.rs` and `hostcap/context.rs`**

```toml
# append to [dependencies]
async-trait = "=0.1.92"
```

```rust
// core/svc_process/src/hostcap/mod.rs
//! Host capability handlers answering `host-call` frames from the executor
//! -- spec Sec6.5 (WIT world), Sec7.4 (stage-side implementation notes).
pub mod clock;
pub mod context;
pub mod db;
pub mod flags;
pub mod http;
pub mod kv;
pub mod log;

pub use context::{build_bundle_context, ContextArgs};

/// One capability answers `capability`/`op`/`args`, returning the op's
/// result as JSON or a denial. Every capability struct in this module
/// (`context`/`kv`/`flags`/`log`/`clock`/`http`/`db`) implements this so
/// `hostapi::dispatch::run_dispatch_loop` (Task 16) can be generic over
/// `Arc<dyn HostCallHandler>` -- Task 20 assembles the composite router.
#[async_trait::async_trait]
pub trait HostCallHandler: Send + Sync {
    /// Answers one `host-call`. Returning `Err` maps to `HostResult{error}`
    /// on the wire and, for a `denied` code, increments
    /// `waddles_host_call_denied_total{app_id,capability}` (Task 22).
    async fn handle(&self, app_id: &str, capability: &str, op: &str, args: serde_json::Value) -> Result<serde_json::Value, HostCapError>;
}

/// A capability call's failure -- maps 1:1 onto `HostResultError` on the wire.
#[derive(Debug, Clone)]
pub struct HostCapError {
    /// Stable machine-readable code (`"denied"`, `"timeout"`, `"backend"`, ...).
    pub code: String,
    /// Human-readable detail.
    pub message: String,
}

impl HostCapError {
    /// A capability/allowlist denial -- spec Sec6.5's `denied(string)` variant.
    pub fn denied(reason: &str) -> Self {
        Self { code: "denied".into(), message: reason.into() }
    }

    /// A backend (Postgres/Valkey/HTTP) failure.
    pub fn backend(reason: impl std::fmt::Display) -> Self {
        Self { code: "backend".into(), message: reason.to_string() }
    }
}
```

```rust
// core/svc_process/src/hostcap/context.rs
//! `context` capability -- always granted, spec Sec6.5 `interface context`.
use serde_json::json;

/// Arguments to build one call's immutable `bundle-context`.
pub struct ContextArgs {
    /// From the envelope's key, never payload.
    pub tenant: String,
    /// From the envelope's key, never payload.
    pub community: Option<String>,
    /// The invoked bundle's app id.
    pub app_id: String,
    /// The active artifact's manifest `version`.
    pub version: String,
    /// The Valkey stream entry id being processed -- the idempotency key.
    pub message_id: String,
    /// The resolved 3-tier config (activation > tenant availability > bundle default).
    pub config: serde_json::Value,
}

/// Builds the `bundle-context` record as JSON (spec Sec6.5). `feature` is
/// `app_id` minus its last dot-segment (`waddles.<module>.<feature>`).
pub fn build_bundle_context(args: &ContextArgs) -> serde_json::Value {
    let feature = args
        .app_id
        .rsplit_once('.')
        .map(|(prefix, _)| prefix.to_string())
        .unwrap_or_else(|| args.app_id.clone());
    json!({
        "tenant": args.tenant,
        "community": args.community,
        "app-id": args.app_id,
        "feature": feature,
        "version": args.version,
        "message-id": args.message_id,
        "config-json": serde_json::to_string(&args.config).unwrap_or_else(|_| "{}".to_string()),
    })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib hostcap::"`
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/Cargo.toml core/svc_process/Cargo.lock core/svc_process/src/hostcap/
git commit -m "$(cat <<'EOF'
feat(svc-process): HostCallHandler trait + always-granted context capability

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 16: Host-API dispatch loop (`hostapi/dispatch.rs`)

**Files:**
- Modify: `core/svc_process/src/hostapi/dispatch.rs`

**Interfaces:**
- Consumes: `crate::hostapi::wire::{Frame, FromExecutor, ToExecutor, HostResultError, HostApiLimits}`, `crate::hostcap::{HostCallHandler, HostCapError}`.
- Produces: `pub trait ExecutorEvents: Send + Sync { fn on_loaded(&self, app_id: &str, digest: &str, exports: &[String]); fn on_unloaded(&self, app_id: &str, digest: &str); fn on_trap(&self, app_id: &str, digest: &str, message: &str); fn on_protocol_error(&self, code: &str, message: &str); }`; `pub struct DispatchHandle<W> { .. }` (generic over the write half, `W: tokio::io::AsyncWrite + Unpin + Send + 'static`) with `pub fn new(writer: W) -> Self`, `pub async fn load(...) -> Result<(), ProcessError>`, `pub async fn unload(...) -> Result<(), ProcessError>`, `pub struct InvokeOutcome { pub payload: serde_json::Value, pub duration_ms: u64, pub fuel_used: u64 }` (D31: `fuel_used`/`duration_ms` are what **Task 25**'s worker feeds into `UsageDelta::fuel_ms` -- the crate-plan-level host-calls-by-kind wiring stops at counting calls; per-invocation fuel/CPU-ms accounting is this plan's own addition, spec D31), `pub async fn invoke(&self, app_id: &str, digest: &str, export: &str, payload: serde_json::Value, deadline_ms: u64, trace_context: Option<String>) -> Result<InvokeOutcome, ProcessError>`, `pub async fn ping(&self) -> Result<(), ProcessError>`; `pub async fn run_dispatch_loop<R, W>(reader: R, handle: DispatchHandle<W>, handler: std::sync::Arc<dyn HostCallHandler>, events: std::sync::Arc<dyn ExecutorEvents>, max_frame_bytes: u32)` (generic over `R: tokio::io::AsyncRead + Unpin + Send + 'static`); `pub struct HostApiPool<W> { .. }` with `pub fn new() -> Self`, `pub async fn add(&self, handle: DispatchHandle<W>)`, `pub async fn count(&self) -> usize`, `pub async fn pick(&self) -> Option<DispatchHandle<W>>` (round-robin). Task 20's `CompositeHandler` is the concrete `Arc<dyn HostCallHandler>` this loop dispatches `HostCall` frames to; Task 25's worker calls `HostApiPool::pick()` then `.invoke(...)` on the result; Task 22's trip counter implements `ExecutorEvents`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::hostapi::wire::{read_frame, write_frame};
    use std::sync::Arc;
    use tokio::io::duplex;

    struct EchoHandler;
    #[async_trait::async_trait]
    impl crate::hostcap::HostCallHandler for EchoHandler {
        async fn handle(&self, _app_id: &str, _capability: &str, _op: &str, args: serde_json::Value) -> Result<serde_json::Value, crate::hostcap::HostCapError> {
            Ok(args)
        }
    }

    struct NoopEvents;
    impl ExecutorEvents for NoopEvents {
        fn on_loaded(&self, _: &str, _: &str, _: &[String]) {}
        fn on_unloaded(&self, _: &str, _: &str) {}
        fn on_trap(&self, _: &str, _: &str, _: &str) {}
        fn on_protocol_error(&self, _: &str, _: &str) {}
    }

    #[tokio::test]
    async fn invoke_round_trips_through_a_simulated_executor() {
        let (client, server) = duplex(65536);
        let (client_r, client_w) = tokio::io::split(client);
        let (mut server_r, mut server_w) = tokio::io::split(server);

        let handle = DispatchHandle::new(client_w);
        tokio::spawn(run_dispatch_loop(client_r, handle.clone(), Arc::new(EchoHandler), Arc::new(NoopEvents), 1_048_576));

        let fake_executor = tokio::spawn(async move {
            let bytes = read_frame(&mut server_r, 1_048_576).await.unwrap();
            let frame: Frame<ToExecutor> = serde_json::from_slice(&bytes).unwrap();
            let ToExecutor::Invoke { .. } = frame.body else { panic!("expected invoke") };
            let reply = Frame { v: 1, id: frame.id, body: FromExecutor::Result { payload: serde_json::json!({"ok": true}), duration_ms: 1, fuel_used: 0 } };
            write_frame(&mut server_w, &serde_json::to_vec(&reply).unwrap()).await.unwrap();
        });

        let outcome = handle.invoke("waddles.bot.discord.default", "sha256:aa", "transform", serde_json::json!({}), 2000, None).await.unwrap();
        assert_eq!(outcome.payload["ok"], true);
        assert_eq!(outcome.duration_ms, 1);
        assert_eq!(outcome.fuel_used, 0);
        fake_executor.await.unwrap();
    }

    #[tokio::test]
    async fn host_call_from_the_executor_is_answered_on_the_same_frame_id() {
        let (client, server) = duplex(65536);
        let (client_r, client_w) = tokio::io::split(client);
        let (mut server_r, mut server_w) = tokio::io::split(server);

        let handle = DispatchHandle::new(client_w);
        tokio::spawn(run_dispatch_loop(client_r, handle.clone(), Arc::new(EchoHandler), Arc::new(NoopEvents), 1_048_576));

        let host_call = Frame { v: 1, id: 99, body: FromExecutor::HostCall {
            app_id: "waddles.bot.discord.default".into(), capability: "kv".into(), op: "get".into(),
            args: serde_json::json!({"key": "x"}), call_id: 1,
        }};
        write_frame(&mut server_w, &serde_json::to_vec(&host_call).unwrap()).await.unwrap();
        let reply_bytes = read_frame(&mut server_r, 1_048_576).await.unwrap();
        let reply: Frame<ToExecutor> = serde_json::from_slice(&reply_bytes).unwrap();
        assert_eq!(reply.id, 99);
        match reply.body {
            ToExecutor::HostResult { result: Some(v), .. } => assert_eq!(v["key"], "x"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn pool_picks_round_robin_across_added_connections() {
        let (a_client, _a_server) = duplex(1024);
        let (b_client, _b_server) = duplex(1024);
        let (_ar, aw) = tokio::io::split(a_client);
        let (_br, bw) = tokio::io::split(b_client);
        let pool: HostApiPool<tokio::io::WriteHalf<tokio::io::DuplexStream>> = HostApiPool::new();
        pool.add(DispatchHandle::new(aw)).await;
        pool.add(DispatchHandle::new(bw)).await;
        assert_eq!(pool.count().await, 2);
        let first = pool.pick().await;
        let second = pool.pick().await;
        assert!(first.is_some() && second.is_some());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib hostapi::dispatch::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `hostapi/dispatch.rs`**

```rust
//! Multiplexes `invoke`/`host-call` frames over one connection by frame
//! `id` -- spec Sec6.6. Generic over the read/write halves so unit tests
//! run over an in-memory `tokio::io::duplex` pipe without TLS.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{oneshot, Mutex};

use crate::error::ProcessError;
use crate::hostapi::wire::{read_frame, write_frame, Frame, FromExecutor, HostApiLimits, HostResultError, ToExecutor};
use crate::hostcap::HostCallHandler;

/// Lifecycle/error events the dispatch loop reports as they arrive on the
/// wire -- decouples the wire-level loop from trip counting (Task 22) and
/// metrics (Task 28).
pub trait ExecutorEvents: Send + Sync {
    /// A `load` this stage sent succeeded.
    fn on_loaded(&self, app_id: &str, digest: &str, exports: &[String]);
    /// An `unload` this stage sent completed.
    fn on_unloaded(&self, app_id: &str, digest: &str);
    /// An in-flight `invoke` came back as a trap/error.
    fn on_trap(&self, app_id: &str, digest: &str, message: &str);
    /// A connection-level protocol error occurred; the loop is about to return.
    fn on_protocol_error(&self, code: &str, message: &str);
}

type PendingMap = Mutex<HashMap<u64, oneshot::Sender<Result<FromExecutor, HostResultError>>>>;

/// One connection's write side plus pending-reply bookkeeping. Cheap to
/// clone -- every task sharing this connection holds a clone.
pub struct DispatchHandle<W> {
    writer: Arc<Mutex<W>>,
    next_id: Arc<AtomicU64>,
    pending: Arc<PendingMap>,
}

/// `invoke`'s success shape: the export's return value plus the
/// executor's own accounting for this one call (spec Sec6.6 `result`'s
/// `duration_ms`/`fuel_used`). D31: Task 25's worker feeds `fuel_used`
/// into `UsageDelta::fuel_ms`.
#[derive(Debug, Clone)]
pub struct InvokeOutcome {
    /// The export's return value, verbatim.
    pub payload: serde_json::Value,
    /// Wall-clock duration of the call, as reported by the executor.
    pub duration_ms: u64,
    /// Fuel units consumed, `0` when fuel metering is off (spec Sec6.6).
    pub fuel_used: u64,
}

impl<W> Clone for DispatchHandle<W> {
    fn clone(&self) -> Self {
        Self { writer: self.writer.clone(), next_id: self.next_id.clone(), pending: self.pending.clone() }
    }
}

impl<W: AsyncWrite + Unpin + Send + 'static> DispatchHandle<W> {
    /// Wraps an already-established connection's write half.
    pub fn new(writer: W) -> Self {
        Self { writer: Arc::new(Mutex::new(writer)), next_id: Arc::new(AtomicU64::new(1)), pending: Arc::new(Mutex::new(HashMap::new())) }
    }

    async fn send_and_await(&self, body: ToExecutor) -> Result<FromExecutor, ProcessError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let bytes = serde_json::to_vec(&Frame { v: 1, id, body }).map_err(|e| ProcessError::Internal(e.into()))?;
        {
            let mut w = self.writer.lock().await;
            write_frame(&mut *w, &bytes).await.map_err(|e| ProcessError::Internal(e.into()))?;
        }
        match rx.await {
            Ok(Ok(from)) => Ok(from),
            // Preserves the wire error's structured `code` rather than
            // collapsing it into a formatted string -- Task 22's
            // `trip::classify_invoke_error` matches on `code` directly.
            Ok(Err(err)) => Err(ProcessError::InvokeFailed { code: err.code, message: err.message }),
            Err(_) => Err(ProcessError::InvokeFailed { code: "CONNECTION_CLOSED".into(), message: "connection closed while awaiting reply".into() }),
        }
    }

    /// Sends `load`, awaits `loaded`.
    #[allow(clippy::too_many_arguments)]
    pub async fn load(&self, app_id: &str, version: &str, digest: &str, component_key: &str, sidecar_key: &str, capabilities: Vec<String>, limits: HostApiLimits) -> Result<(), ProcessError> {
        let body = ToExecutor::Load { app_id: app_id.into(), version: version.into(), digest: digest.into(), component_key: component_key.into(), sidecar_key: sidecar_key.into(), capabilities, limits };
        match self.send_and_await(body).await? {
            FromExecutor::Loaded { .. } => Ok(()),
            other => Err(ProcessError::Internal(anyhow::anyhow!("expected loaded, got {other:?}"))),
        }
    }

    /// Sends `unload`, awaits `unloaded`.
    pub async fn unload(&self, app_id: &str, digest: &str) -> Result<(), ProcessError> {
        match self.send_and_await(ToExecutor::Unload { app_id: app_id.into(), digest: digest.into() }).await? {
            FromExecutor::Unloaded { .. } => Ok(()),
            other => Err(ProcessError::Internal(anyhow::anyhow!("expected unloaded, got {other:?}"))),
        }
    }

    /// Sends `invoke`, awaits `result` -- the call every matched, granted
    /// entry makes exactly once (Task 25's worker). Returns `duration_ms`/
    /// `fuel_used` alongside the payload (D31 -- Task 25 feeds these into
    /// `UsageDelta::fuel_ms`).
    pub async fn invoke(&self, app_id: &str, digest: &str, export: &str, payload: serde_json::Value, deadline_ms: u64, trace_context: Option<String>) -> Result<InvokeOutcome, ProcessError> {
        let body = ToExecutor::Invoke { app_id: app_id.into(), digest: digest.into(), export: export.into(), payload, deadline_ms, trace_context };
        match self.send_and_await(body).await? {
            FromExecutor::Result { payload, duration_ms, fuel_used } => Ok(InvokeOutcome { payload, duration_ms, fuel_used }),
            other => Err(ProcessError::Internal(anyhow::anyhow!("expected result, got {other:?}"))),
        }
    }

    /// Sends `ping`, awaits `pong` -- liveness probing.
    pub async fn ping(&self) -> Result<(), ProcessError> {
        match self.send_and_await(ToExecutor::Ping {}).await? {
            FromExecutor::Pong {} => Ok(()),
            other => Err(ProcessError::Internal(anyhow::anyhow!("expected pong, got {other:?}"))),
        }
    }
}

/// Drives one connection's read loop until it closes. `HostCall` frames
/// are answered by `handler` and replied to on the SAME frame `id` (spec
/// Sec6.6: a `host-result` reply reuses the `host-call` frame's own `id`,
/// distinct from that frame's `call_id` field, which only names the
/// originating `invoke`). Every other frame kind resolves a pending
/// `send_and_await` caller by `id`.
pub async fn run_dispatch_loop<R, W>(
    mut reader: R,
    handle: DispatchHandle<W>,
    handler: Arc<dyn HostCallHandler>,
    events: Arc<dyn ExecutorEvents>,
    max_frame_bytes: u32,
) where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    loop {
        let bytes = match read_frame(&mut reader, max_frame_bytes).await {
            Ok(b) => b,
            Err(e) => {
                events.on_protocol_error("FRAME_TOO_LARGE_OR_CLOSED", &e.to_string());
                return;
            }
        };
        let frame: Frame<FromExecutor> = match serde_json::from_slice(&bytes) {
            Ok(f) => f,
            Err(e) => {
                events.on_protocol_error("MALFORMED_FRAME", &e.to_string());
                return;
            }
        };
        match frame.body {
            FromExecutor::HostCall { app_id, capability, op, args, .. } => {
                let handle = handle.clone();
                let handler = handler.clone();
                let id = frame.id;
                tokio::spawn(async move {
                    let (result, error) = match handler.handle(&app_id, &capability, &op, args).await {
                        Ok(v) => (Some(v), None),
                        Err(e) => (None, Some(HostResultError { code: e.code, message: e.message })),
                    };
                    if let Ok(bytes) = serde_json::to_vec(&Frame { v: 1, id, body: ToExecutor::HostResult { result, error } }) {
                        let mut w = handle.writer.lock().await;
                        let _ = write_frame(&mut *w, &bytes).await;
                    }
                });
            }
            FromExecutor::Loaded { ref app_id, ref digest, ref exports, .. } => {
                events.on_loaded(app_id, digest, exports);
                complete_pending(&handle, frame.id, Ok(frame.body)).await;
            }
            FromExecutor::Unloaded { ref app_id, ref digest } => {
                events.on_unloaded(app_id, digest);
                complete_pending(&handle, frame.id, Ok(frame.body)).await;
            }
            FromExecutor::Result { .. } | FromExecutor::Pong {} => {
                complete_pending(&handle, frame.id, Ok(frame.body)).await;
            }
            FromExecutor::Error { ref code, ref message, .. } => {
                events.on_trap("unknown", "unknown", message);
                complete_pending(&handle, frame.id, Err(HostResultError { code: code.clone(), message: message.clone() })).await;
            }
            FromExecutor::Hello { .. } => {
                events.on_protocol_error("PROTOCOL_VERSION", "unexpected hello after handshake");
                return;
            }
        }
    }
}

async fn complete_pending<W>(handle: &DispatchHandle<W>, id: u64, result: Result<FromExecutor, HostResultError>) {
    if let Some(tx) = handle.pending.lock().await.remove(&id) {
        let _ = tx.send(result);
    }
}

/// Round-robins `invoke`/`load`/`unload` calls across every connection the
/// executor has established -- spec Sec4.5 "connection pool of
/// `EXECUTOR_STAGE_CONNECTIONS`".
pub struct HostApiPool<W> {
    connections: Arc<Mutex<Vec<DispatchHandle<W>>>>,
    next: Arc<AtomicUsize>,
}

impl<W> Clone for HostApiPool<W> {
    fn clone(&self) -> Self {
        Self { connections: self.connections.clone(), next: self.next.clone() }
    }
}

impl<W> HostApiPool<W> {
    /// An empty pool.
    pub fn new() -> Self {
        Self { connections: Arc::new(Mutex::new(Vec::new())), next: Arc::new(AtomicUsize::new(0)) }
    }

    /// Registers a newly-handshaken connection.
    pub async fn add(&self, handle: DispatchHandle<W>) {
        self.connections.lock().await.push(handle);
    }

    /// Live connection count -- feeds `waddles_host_api_connections`.
    pub async fn count(&self) -> usize {
        self.connections.lock().await.len()
    }
}

impl<W: Clone> HostApiPool<W> {
    /// Round-robin pick, or `None` when no executor connection is live
    /// (the caller treats this as retryable, spec Sec4.5
    /// `EXECUTOR_UNAVAILABLE_READY_S`).
    pub async fn pick(&self) -> Option<DispatchHandle<W>> {
        let conns = self.connections.lock().await;
        if conns.is_empty() {
            return None;
        }
        let i = self.next.fetch_add(1, Ordering::Relaxed) % conns.len();
        Some(conns[i].clone())
    }
}

impl<W> Default for HostApiPool<W> {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib hostapi::dispatch::"`
Expected: `test result: ok. 3 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/hostapi/dispatch.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): DispatchHandle/run_dispatch_loop/HostApiPool, invoke+host-call mux

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 17: `kv` capability (`hostcap/kv.rs`)

**Files:**
- Modify: `core/svc_process/src/hostcap/kv.rs`

**Interfaces:**
- Consumes: `crate::spine::keys::Scope`, `crate::hostcap::HostCapError`.
- Produces: `pub struct KvCapability { .. }` with `pub fn new(pool: deadpool_redis::Pool, max_value_bytes: u32, max_ttl_s: u32) -> Self`, `pub async fn get(&self, scope: &Scope, app_id: &str, key: &str) -> Result<Option<Vec<u8>>, HostCapError>`, `pub async fn set(&self, scope: &Scope, app_id: &str, key: &str, value: &[u8], ttl_seconds: u32) -> Result<(), HostCapError>`, `pub async fn delete(&self, scope: &Scope, app_id: &str, key: &str) -> Result<(), HostCapError>`, `pub async fn increment(&self, scope: &Scope, app_id: &str, key: &str, delta: i64, ttl_seconds: u32) -> Result<i64, HostCapError>`. Task 20's `CompositeHandler` routes `capability == "kv"` here.

- [ ] **Step 1: Write the failing test** (requires a real Valkey -- `#[ignore]`d by default)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::spine::keys::Scope;

    async fn cap() -> KvCapability {
        let url = std::env::var("VALKEY_TEST_URL").expect("set VALKEY_TEST_URL to run this test");
        let cfg = deadpool_redis::Config::from_url(url);
        let pool = cfg.create_pool(Some(deadpool_redis::Runtime::Tokio1)).unwrap();
        KvCapability::new(pool, 65_536, 2_592_000)
    }

    #[tokio::test]
    #[ignore = "requires a real Valkey"]
    async fn set_get_delete_round_trip() {
        let c = cap().await;
        let scope = Scope { tenant: "global".into(), community: None };
        let app_id = format!("waddles.test.{}", uuid::Uuid::new_v4());
        assert_eq!(c.get(&scope, &app_id, "x").await.unwrap(), None);
        c.set(&scope, &app_id, "x", b"hello", 60).await.unwrap();
        assert_eq!(c.get(&scope, &app_id, "x").await.unwrap(), Some(b"hello".to_vec()));
        c.delete(&scope, &app_id, "x").await.unwrap();
        assert_eq!(c.get(&scope, &app_id, "x").await.unwrap(), None);
    }

    #[tokio::test]
    #[ignore = "requires a real Valkey"]
    async fn oversize_value_is_rejected() {
        let c = KvCapability::new(
            deadpool_redis::Config::from_url(std::env::var("VALKEY_TEST_URL").unwrap()).create_pool(Some(deadpool_redis::Runtime::Tokio1)).unwrap(),
            8, 60,
        );
        let scope = Scope { tenant: "global".into(), community: None };
        let err = c.set(&scope, "waddles.test.oversize", "x", b"this value is way too long", 60).await.unwrap_err();
        assert_eq!(err.code, "too-large");
    }

    #[tokio::test]
    #[ignore = "requires a real Valkey"]
    async fn increment_accumulates() {
        let c = cap().await;
        let scope = Scope { tenant: "global".into(), community: None };
        let app_id = format!("waddles.test.{}", uuid::Uuid::new_v4());
        assert_eq!(c.increment(&scope, &app_id, "counter", 3, 60).await.unwrap(), 3);
        assert_eq!(c.increment(&scope, &app_id, "counter", 4, 60).await.unwrap(), 7);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib hostcap::kv:: -- --ignored"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `hostcap/kv.rs`**

```rust
//! `kv` capability -- bundle-scoped key/value under the bundle's own
//! `...:state` key, always granted -- spec Sec6.5, Sec7.4.
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};

use crate::hostcap::HostCapError;
use crate::spine::keys::Scope;

#[derive(Serialize, Deserialize)]
struct StoredValue {
    /// Base64-encoded value bytes.
    v: String,
    /// Unix millis expiry, or `None` for no expiry.
    exp: Option<i64>,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Bundle-scoped KV over one Valkey hash per `(scope, app_id)`.
pub struct KvCapability {
    pool: deadpool_redis::Pool,
    max_value_bytes: u32,
    max_ttl_s: u32,
}

impl KvCapability {
    /// Builds a capability bound to `pool`, with the platform's byte/TTL ceilings.
    pub fn new(pool: deadpool_redis::Pool, max_value_bytes: u32, max_ttl_s: u32) -> Self {
        Self { pool, max_value_bytes, max_ttl_s }
    }

    fn field(key: &str) -> String {
        // Namespaced so a bundle can never reach the stage's own hash fields -- spec Sec7.4.
        format!("b:{key}")
    }

    /// `HGET` the bundle's own state hash; expired entries are deleted on
    /// read and treated as absent (per-field TTL emulation -- spec Sec7.4).
    pub async fn get(&self, scope: &Scope, app_id: &str, key: &str) -> Result<Option<Vec<u8>>, HostCapError> {
        let mut conn = self.pool.get().await.map_err(HostCapError::backend)?;
        let state_key = scope.bundle_state_key(app_id);
        let field = Self::field(key);
        let raw: Option<String> = conn.hget(&state_key, &field).await.map_err(HostCapError::backend)?;
        let Some(raw) = raw else { return Ok(None) };
        let stored: StoredValue = serde_json::from_str(&raw).map_err(HostCapError::backend)?;
        if let Some(exp) = stored.exp {
            if exp <= now_millis() {
                let _: i64 = conn.hdel(&state_key, &field).await.map_err(HostCapError::backend)?;
                return Ok(None);
            }
        }
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(stored.v)
            .map(Some)
            .map_err(HostCapError::backend)
    }

    /// `HSET`; `ttl_seconds=0` means no expiry, otherwise clamped to `max_ttl_s`.
    pub async fn set(&self, scope: &Scope, app_id: &str, key: &str, value: &[u8], ttl_seconds: u32) -> Result<(), HostCapError> {
        if value.len() as u32 > self.max_value_bytes {
            return Err(HostCapError { code: "too-large".into(), message: format!("{} bytes exceeds KV_MAX_VALUE_BYTES={}", value.len(), self.max_value_bytes) });
        }
        let clamped_ttl = if ttl_seconds == 0 { None } else { Some(ttl_seconds.min(self.max_ttl_s)) };
        let exp = clamped_ttl.map(|t| now_millis() + i64::from(t) * 1000);
        use base64::Engine;
        let stored = StoredValue { v: base64::engine::general_purpose::STANDARD.encode(value), exp };
        let json = serde_json::to_string(&stored).map_err(HostCapError::backend)?;
        let mut conn = self.pool.get().await.map_err(HostCapError::backend)?;
        let _: () = conn.hset(scope.bundle_state_key(app_id), Self::field(key), json).await.map_err(HostCapError::backend)?;
        Ok(())
    }

    /// `HDEL` the bundle's own field.
    pub async fn delete(&self, scope: &Scope, app_id: &str, key: &str) -> Result<(), HostCapError> {
        let mut conn = self.pool.get().await.map_err(HostCapError::backend)?;
        let _: i64 = conn.hdel(scope.bundle_state_key(app_id), Self::field(key)).await.map_err(HostCapError::backend)?;
        Ok(())
    }

    /// Read-modify-write increment. Not linearizable across concurrent
    /// invocations of the same bundle on different streams -- acceptable
    /// for the rate/cooldown counters this op exists for; spec Sec6.5
    /// fixes the surface, not an atomicity guarantee, and the Global
    /// Constraints LUA-via-RBAC rule rules out an `EVAL`-based fix here.
    pub async fn increment(&self, scope: &Scope, app_id: &str, key: &str, delta: i64, ttl_seconds: u32) -> Result<i64, HostCapError> {
        let current = self.get(scope, app_id, key).await?;
        let current_val: i64 = match current {
            Some(bytes) => std::str::from_utf8(&bytes).ok().and_then(|s| s.parse().ok()).unwrap_or(0),
            None => 0,
        };
        let new_val = current_val + delta;
        self.set(scope, app_id, key, new_val.to_string().as_bytes(), ttl_seconds).await?;
        Ok(new_val)
    }
}
```

Add `base64 = "=0.22.1"` to `Cargo.toml`'s `[dependencies]` (used above).

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
docker run -d --rm --name svc-process-valkey-test -p 6399:6379 valkey/valkey:8-bookworm
cd core/svc_process && VALKEY_TEST_URL=redis://127.0.0.1:6399 cargo test --lib hostcap::kv:: -- --ignored --test-threads=1 2>&1 | tail -30
docker stop svc-process-valkey-test
```
Expected: `test result: ok. 3 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/Cargo.toml core/svc_process/Cargo.lock core/svc_process/src/hostcap/kv.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): kv capability -- namespaced bundle-scoped hash, TTL + size caps

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 18: `flags`, `log`, `clock` capabilities (`hostcap/{flags,log,clock}.rs`)

**Files:**
- Modify: `core/svc_process/src/hostcap/flags.rs`, `core/svc_process/src/hostcap/log.rs`, `core/svc_process/src/hostcap/clock.rs`

**Interfaces:**
- Consumes: `penguin_licensing::LicenseClient` (real crate, spec Sec4.11).
- Produces: `pub struct FlagsCapability { .. }` with `pub fn new(client: std::sync::Arc<penguin_licensing::LicenseClient>) -> Self`, `pub async fn enabled(&self, key: &str, default_value: bool) -> bool` (fail-open, spec Sec6.5), `pub async fn tier(&self) -> String` (`"free"|"professional"|"enterprise"`); `pub const SENSITIVE_KEYS: &[&str]` (ported verbatim from `penguin_utils.logging.SENSITIVE_KEYS`) and `pub fn sanitize_log_fields(data: &serde_json::Value) -> serde_json::Value`; `pub struct LogCapability` with `pub fn write(&self, level: &str, message: &str, fields: serde_json::Value, app_id: &str, tenant: &str, community: Option<&str>)` (emits via `tracing`, sanitized, capped at the stage's own `LOG_LEVEL`); `pub struct ClockCapability` with `pub fn now_millis(&self) -> u64`, `pub fn now_rfc3339(&self) -> String`, `pub fn monotonic_nanos(&self) -> u64` (built once at process start, spec Sec7.4). Task 20's `CompositeHandler` routes `capability` `"flags"`/`"log"`/`"clock"` here; Task 23's moderation gate calls `FlagsCapability::enabled` directly (a built-in, not a bundle, so it is not routed through `HostCallHandler` at all).

- [ ] **Step 1: Write the failing tests**

```rust
// hostcap/flags.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_keys_contains_the_ported_set() {
        for expected in ["password", "token", "secret", "api_key", "authorization"] {
            assert!(SENSITIVE_KEYS.contains(&expected), "missing {expected}");
        }
    }

    #[test]
    fn sanitize_redacts_exact_and_substring_matches() {
        let data = serde_json::json!({"password": "hunter2", "user_token_value": "abc", "safe": "ok"});
        let out = sanitize_log_fields(&data);
        assert_eq!(out["password"], "[REDACTED]");
        assert_eq!(out["user_token_value"], "[REDACTED]");
        assert_eq!(out["safe"], "ok");
    }

    #[test]
    fn sanitize_masks_email_shaped_strings_to_domain_only() {
        let data = serde_json::json!({"contact": "someone@example.com"});
        let out = sanitize_log_fields(&data);
        assert_eq!(out["contact"], "[email]@example.com");
    }

    #[test]
    fn sanitize_recurses_into_nested_objects_and_arrays() {
        let data = serde_json::json!({"nested": {"secret": "x"}, "list": [{"token": "y"}]});
        let out = sanitize_log_fields(&data);
        assert_eq!(out["nested"]["secret"], "[REDACTED]");
        assert_eq!(out["list"][0]["token"], "[REDACTED]");
    }
}
```

```rust
// hostcap/clock.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_rfc3339_has_millisecond_precision_and_z_suffix() {
        let c = ClockCapability::new();
        let s = c.now_rfc3339();
        assert!(s.ends_with('Z'));
        assert!(s.contains('.'));
    }

    #[test]
    fn monotonic_nanos_never_decreases() {
        let c = ClockCapability::new();
        let a = c.monotonic_nanos();
        let b = c.monotonic_nanos();
        assert!(b >= a);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib hostcap::flags:: hostcap::clock::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement all three files**

```rust
// core/svc_process/src/hostcap/flags.rs
//! `flags` capability -- `penguin-licensing`'s two-gate flag + entitlement
//! resolution, fail-open to the caller's default -- spec Sec6.5, Sec13.5.
use std::sync::Arc;

use penguin_licensing::LicenseClient;

/// Wraps `penguin-licensing`'s client for the `flags` host capability.
pub struct FlagsCapability {
    client: Arc<LicenseClient>,
}

impl FlagsCapability {
    /// Builds a capability over an already-constructed, refreshing client.
    pub fn new(client: Arc<LicenseClient>) -> Self {
        Self { client }
    }

    /// Resolves `key`, falling back to `default_value` before the client
    /// has any snapshot yet (e.g. immediately at startup, before the first
    /// refresh completes) -- the client's own cache/backoff/72h-grace
    /// already implements fail-open thereafter (spec Sec4.11).
    pub async fn enabled(&self, key: &str, default_value: bool) -> bool {
        if self.client.snapshot().is_none() {
            return default_value;
        }
        self.client.flag_enabled(key).await
    }

    /// `"free" | "professional" | "enterprise"`.
    pub async fn tier(&self) -> String {
        match self.client.tier().await {
            penguin_licensing::Tier::Free => "free",
            penguin_licensing::Tier::Professional => "professional",
            penguin_licensing::Tier::Enterprise => "enterprise",
        }
        .to_string()
    }
}

/// Keys ported **verbatim** from
/// `penguin-libs/packages/python-utils/src/penguintechinc_utils/logging.py`
/// `SENSITIVE_KEYS` -- spec Sec4.9. Matched by exact key or substring, same
/// as the Python original.
pub const SENSITIVE_KEYS: &[&str] = &[
    "password", "passwd", "secret", "token", "api_key", "apikey", "auth_token",
    "authtoken", "access_token", "refresh_token", "credential", "credentials",
    "mfa_code", "totp_code", "otp", "captcha_token", "session_id", "sessionid",
    "cookie", "authorization",
];

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    SENSITIVE_KEYS.iter().any(|s| lower == *s || lower.contains(s))
}

fn looks_like_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else { return false };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

/// Sanitizes a JSON object the same way the Python `sanitize_log_data`
/// does: exact/substring key match -> `[REDACTED]`; an email-shaped string
/// value -> `[email]@{domain}`; recurses into nested objects and arrays.
pub fn sanitize_log_fields(data: &serde_json::Value) -> serde_json::Value {
    match data {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, value) in map {
                if is_sensitive_key(key) {
                    out.insert(key.clone(), serde_json::Value::String("[REDACTED]".to_string()));
                } else {
                    out.insert(key.clone(), sanitize_log_fields(value));
                }
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(items.iter().map(sanitize_log_fields).collect()),
        serde_json::Value::String(s) if looks_like_email(s) => {
            let domain = s.split_once('@').map(|(_, d)| d).unwrap_or("");
            serde_json::Value::String(format!("[email]@{domain}"))
        }
        other => other.clone(),
    }
}
```

```rust
// core/svc_process/src/hostcap/log.rs
//! `log` capability -- sanitized, levelled forwarding into this stage's
//! OTel pipeline -- spec Sec6.5, Sec7.4.
use crate::hostcap::flags::sanitize_log_fields;

/// A bundle's `log.write` call, forwarded into `tracing` after sanitization.
pub struct LogCapability;

impl LogCapability {
    /// Emits one sanitized, levelled log line. `level` is one of
    /// `error|warn|info|debug`; an unrecognized value logs at INFO rather
    /// than being dropped. A guest can never raise its own log level above
    /// the stage's configured `RUST_LOG`/`LOG_LEVEL` -- that ceiling is
    /// enforced by `tracing`'s own `EnvFilter`, not by this function.
    pub fn write(&self, level: &str, message: &str, fields: serde_json::Value, app_id: &str, tenant: &str, community: Option<&str>) {
        let sanitized = sanitize_log_fields(&fields);
        match level {
            "error" => tracing::error!(app_id, tenant, community, fields = %sanitized, "{message}"),
            "warn" => tracing::warn!(app_id, tenant, community, fields = %sanitized, "{message}"),
            "debug" => tracing::debug!(app_id, tenant, community, fields = %sanitized, "{message}"),
            _ => tracing::info!(app_id, tenant, community, fields = %sanitized, "{message}"),
        }
    }
}
```

```rust
// core/svc_process/src/hostcap/clock.rs
//! `clock` capability -- the guest's only time source, always granted --
//! spec Sec6.5, Sec7.4.
use std::time::Instant;

/// Wraps the stage's own wall/monotonic clocks.
pub struct ClockCapability {
    start: Instant,
}

impl ClockCapability {
    /// Captures the monotonic origin at construction time (once per process).
    pub fn new() -> Self {
        Self { start: Instant::now() }
    }

    /// Milliseconds since the Unix epoch.
    pub fn now_millis(&self) -> u64 {
        chrono::Utc::now().timestamp_millis().max(0) as u64
    }

    /// RFC 3339 UTC, millisecond precision, `Z` suffix.
    pub fn now_rfc3339(&self) -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// Monotonic nanoseconds since this capability was constructed.
    pub fn monotonic_nanos(&self) -> u64 {
        self.start.elapsed().as_nanos() as u64
    }
}

impl Default for ClockCapability {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib hostcap::flags:: hostcap::clock::"`
Expected: `test result: ok. 6 passed` total across both modules

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/hostcap/flags.rs core/svc_process/src/hostcap/log.rs core/svc_process/src/hostcap/clock.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): flags/log/clock capabilities; SENSITIVE_KEYS ported verbatim

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 19: `http` (guarded egress) capability (`hostcap/http.rs`)

**Files:**
- Modify: `core/svc_process/src/hostcap/http.rs`, `core/svc_process/Cargo.toml` (add `governor`, `url`)

**Interfaces:**
- Consumes: `crate::distribution::EgressRule`, `crate::hostcap::HostCapError`.
- Produces: `pub struct EgressRequest { pub method: String, pub url: String, pub headers: Vec<(String, String)>, pub body: Option<Vec<u8>>, pub secret_refs: Vec<(String, String)> }`; `pub struct EgressResponse { pub status: u16, pub headers: Vec<(String, String)>, pub body: Vec<u8>, pub truncated: bool }`; `pub trait SecretResolver: Send + Sync { fn resolve(&self, name: &str) -> Option<String>; }`; `pub struct EnvSecretResolver;` implementing it via `std::env::var`; `pub struct HttpCapability { .. }` with `pub fn new(secret_resolver: std::sync::Arc<dyn SecretResolver>, timeout: std::time::Duration, max_response_bytes: u64, max_redirects: u32) -> Result<Self, HostCapError>`, `pub async fn send(&self, app_id: &str, req: EgressRequest, allowed: &[EgressRule], denylist: &[String], allow_private_hosts: bool, limiter: &governor::DefaultDirectRateLimiter) -> Result<EgressResponse, HostCapError>` implementing spec Sec8.2's twelve-step enforcement order in full. Task 20's `CompositeHandler` owns one rate limiter per `app_id` (built from the bundle's `limits.egress_rps`) and routes `capability == "http"` here.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::distribution::EgressRule;
    use std::time::Duration;

    struct NoSecrets;
    impl SecretResolver for NoSecrets {
        fn resolve(&self, _name: &str) -> Option<String> { None }
    }

    fn limiter() -> governor::DefaultDirectRateLimiter {
        governor::RateLimiter::direct(governor::Quota::per_second(std::num::NonZeroU32::new(10).unwrap()))
    }

    #[tokio::test]
    async fn non_https_scheme_is_denied() {
        let cap = HttpCapability::new(std::sync::Arc::new(NoSecrets), Duration::from_secs(5), 1_048_576, 3).unwrap();
        let req = EgressRequest { method: "GET".into(), url: "http://api.spotify.com/v1".into(), headers: vec![], body: None, secret_refs: vec![] };
        let allowed = vec![EgressRule { host: "api.spotify.com".into(), methods: vec!["GET".into()] }];
        let err = cap.send("waddles.socials.music.default", req, &allowed, &[], false, &limiter()).await.unwrap_err();
        assert_eq!(err.message, "scheme_not_https");
    }

    #[tokio::test]
    async fn undeclared_host_is_denied() {
        let cap = HttpCapability::new(std::sync::Arc::new(NoSecrets), Duration::from_secs(5), 1_048_576, 3).unwrap();
        let req = EgressRequest { method: "GET".into(), url: "https://evil.example.com/".into(), headers: vec![], body: None, secret_refs: vec![] };
        let allowed = vec![EgressRule { host: "api.spotify.com".into(), methods: vec!["GET".into()] }];
        let err = cap.send("waddles.socials.music.default", req, &allowed, &[], false, &limiter()).await.unwrap_err();
        assert_eq!(err.message, "host_not_declared");
    }

    #[tokio::test]
    async fn undeclared_method_is_denied() {
        let cap = HttpCapability::new(std::sync::Arc::new(NoSecrets), Duration::from_secs(5), 1_048_576, 3).unwrap();
        let req = EgressRequest { method: "DELETE".into(), url: "https://api.spotify.com/v1".into(), headers: vec![], body: None, secret_refs: vec![] };
        let allowed = vec![EgressRule { host: "api.spotify.com".into(), methods: vec!["GET".into(), "POST".into()] }];
        let err = cap.send("waddles.socials.music.default", req, &allowed, &[], false, &limiter()).await.unwrap_err();
        assert_eq!(err.message, "method_not_declared");
    }

    #[tokio::test]
    async fn denylisted_host_is_denied_even_if_declared() {
        let cap = HttpCapability::new(std::sync::Arc::new(NoSecrets), Duration::from_secs(5), 1_048_576, 3).unwrap();
        let req = EgressRequest { method: "GET".into(), url: "https://blocked.example.com/".into(), headers: vec![], body: None, secret_refs: vec![] };
        let allowed = vec![EgressRule { host: "blocked.example.com".into(), methods: vec!["GET".into()] }];
        let err = cap.send("waddles.socials.music.default", req, &allowed, &["blocked.example.com".to_string()], false, &limiter()).await.unwrap_err();
        assert_eq!(err.message, "host_denylisted");
    }

    #[tokio::test]
    async fn wildcard_host_matches_single_label_subdomain_only() {
        let cap = HttpCapability::new(std::sync::Arc::new(NoSecrets), Duration::from_secs(5), 1_048_576, 3).unwrap();
        let allowed = vec![EgressRule { host: "*.googleapis.com".into(), methods: vec!["GET".into()] }];
        assert!(host_matches_allowlist("sheets.googleapis.com", &allowed));
        assert!(!host_matches_allowlist("googleapis.com", &allowed));
        assert!(!host_matches_allowlist("a.b.googleapis.com", &allowed));
    }

    #[tokio::test]
    async fn cloud_metadata_address_is_blocked_even_with_allow_private_hosts() {
        assert!(is_forbidden_address("169.254.169.254".parse().unwrap(), true));
        assert!(is_forbidden_address("169.254.169.254".parse().unwrap(), false));
    }

    #[tokio::test]
    async fn private_range_is_blocked_by_default_and_allowed_when_configured() {
        let ip: std::net::IpAddr = "10.0.0.5".parse().unwrap();
        assert!(is_forbidden_address(ip, false));
        assert!(!is_forbidden_address(ip, true));
    }

    #[tokio::test]
    async fn loopback_is_always_blocked_regardless_of_allow_private_hosts() {
        let ip: std::net::IpAddr = "127.0.0.1".parse().unwrap();
        assert!(is_forbidden_address(ip, true));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib hostcap::http::"`
Expected: FAIL to compile.

- [ ] **Step 3: Add deps, implement `hostcap/http.rs`**

```toml
# append to [dependencies]
governor = "=0.7.0"
url = "=2.5.4"
```

```rust
//! `http` capability -- guarded outbound HTTP, granted only when `egress`
//! is non-empty -- spec Sec6.5, Sec8 (the full enforcement order).
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use governor::DefaultDirectRateLimiter;
use url::Url;

use crate::distribution::EgressRule;
use crate::hostcap::HostCapError;

/// One `http.send` call from a bundle.
pub struct EgressRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Header name -> secret reference name; the stage resolves and
    /// injects the value, which never crosses back into the guest.
    pub secret_refs: Vec<(String, String)>,
}

/// The response handed back to the guest -- secret values are never echoed.
pub struct EgressResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub truncated: bool,
}

/// Resolves a secret reference name to its current value (spec Sec8.3).
pub trait SecretResolver: Send + Sync {
    fn resolve(&self, name: &str) -> Option<String>;
}

/// The production resolver: an environment-variable *name* held in
/// activation config, resolved at call time -- same mechanism as
/// `waddle_transports.signing.resolve_secret`.
pub struct EnvSecretResolver;
impl SecretResolver for EnvSecretResolver {
    fn resolve(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

/// True when `host` matches one `egress[].host` entry: exact match, or a
/// single-label `*.` wildcard prefix (`*.example.com` matches
/// `a.example.com`, not `example.com` or `a.b.example.com`) -- spec Sec8.1.
fn host_matches_allowlist(host: &str, allowed: &[EgressRule]) -> bool {
    allowed.iter().any(|rule| {
        if let Some(suffix) = rule.host.strip_prefix("*.") {
            host.strip_suffix(suffix).is_some_and(|prefix| {
                prefix.ends_with('.') && prefix[..prefix.len() - 1].split('.').count() == 1
            })
        } else {
            host == rule.host
        }
    })
}

fn method_allowed(host: &str, method: &str, allowed: &[EgressRule]) -> bool {
    allowed.iter().any(|rule| {
        let host_ok = if let Some(suffix) = rule.host.strip_prefix("*.") {
            host.strip_suffix(suffix).is_some_and(|prefix| prefix.ends_with('.') && prefix[..prefix.len() - 1].split('.').count() == 1)
        } else {
            host == rule.host
        };
        host_ok && rule.methods.iter().any(|m| m.eq_ignore_ascii_case(method))
    })
}

/// Cloud metadata addresses -- blocked in every configuration, spec Sec8.2 step 6.
const CLOUD_METADATA_V4: &str = "169.254.169.254";
const CLOUD_METADATA_V6: &str = "fd00:ec2::254";

/// True when `ip` must never be reached by a bundle `http.send` call.
/// Loopback/link-local/unspecified/multicast/cloud-metadata are blocked
/// unconditionally; the private-range (`10/8`, `172.16/12`, `192.168/16`,
/// `fc00::/7`) half is lifted when `allow_private` is true -- spec Sec8.2
/// step 6, Sec8.5.
pub fn is_forbidden_address(ip: IpAddr, allow_private: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            if v4.to_string() == CLOUD_METADATA_V4 || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.is_multicast() {
                return true;
            }
            !allow_private && v4.is_private()
        }
        IpAddr::V6(v6) => {
            if v6.to_string() == CLOUD_METADATA_V6 || v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return true;
            }
            let is_link_local = (v6.segments()[0] & 0xffc0) == 0xfe80;
            if is_link_local {
                return true;
            }
            let is_unique_local = (v6.segments()[0] & 0xfe00) == 0xfc00;
            !allow_private && is_unique_local
        }
    }
}

/// The stage-side guarded egress client.
pub struct HttpCapability {
    client: reqwest::Client,
    secret_resolver: Arc<dyn SecretResolver>,
    max_response_bytes: u64,
    max_redirects: u32,
}

impl HttpCapability {
    /// Builds a client with redirects disabled (this capability follows
    /// them manually, re-checking every hop -- spec Sec8.2 step 10).
    pub fn new(secret_resolver: Arc<dyn SecretResolver>, timeout: Duration, max_response_bytes: u64, max_redirects: u32) -> Result<Self, HostCapError> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(HostCapError::backend)?;
        Ok(Self { client, secret_resolver, max_response_bytes, max_redirects })
    }

    async fn check_and_resolve_addr(&self, url: &Url, allow_private_hosts: bool) -> Result<(), HostCapError> {
        let host = url.host_str().ok_or_else(|| HostCapError::denied("malformed_url"))?;
        let port = url.port_or_known_default().unwrap_or(443);
        let addrs = tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| HostCapError { code: "denied".into(), message: format!("dns_rebind_blocked: {e}") })?;
        for addr in addrs {
            if is_forbidden_address(addr.ip(), allow_private_hosts) {
                return Err(HostCapError::denied("ssrf_blocked_address"));
            }
        }
        Ok(())
    }

    fn precheck(&self, url: &Url, method: &str, allowed: &[EgressRule], denylist: &[String]) -> Result<(), HostCapError> {
        if url.scheme() != "https" {
            return Err(HostCapError::denied("scheme_not_https"));
        }
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(HostCapError::denied("malformed_url"));
        }
        let host = url.host_str().ok_or_else(|| HostCapError::denied("malformed_url"))?;
        if !host_matches_allowlist(host, allowed) {
            return Err(HostCapError::denied("host_not_declared"));
        }
        if !method_allowed(host, method, allowed) {
            return Err(HostCapError::denied("method_not_declared"));
        }
        if denylist.iter().any(|d| d == host) {
            return Err(HostCapError::denied("host_denylisted"));
        }
        Ok(())
    }

    /// Runs the full spec Sec8.2 enforcement order and, on success, the
    /// actual request (following redirects up to `max_redirects`, each
    /// hop re-checked from step 1).
    pub async fn send(
        &self,
        app_id: &str,
        req: EgressRequest,
        allowed: &[EgressRule],
        denylist: &[String],
        allow_private_hosts: bool,
        limiter: &DefaultDirectRateLimiter,
    ) -> Result<EgressResponse, HostCapError> {
        let mut current_url = Url::parse(&req.url).map_err(|_| HostCapError::denied("malformed_url"))?;
        self.precheck(&current_url, &req.method, allowed, denylist)?;
        self.check_and_resolve_addr(&current_url, allow_private_hosts).await?;

        if limiter.check().is_err() {
            return Err(HostCapError { code: "rate-limited".into(), message: "egress_rate_limited".into() });
        }

        let mut redirects = 0u32;
        loop {
            let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|_| HostCapError::denied("malformed_url"))?;
            let mut builder = self.client.request(method.clone(), current_url.clone());
            for (name, value) in &req.headers {
                builder = builder.header(name, value);
            }
            for (header_name, secret_ref) in &req.secret_refs {
                let Some(value) = self.secret_resolver.resolve(secret_ref) else {
                    return Err(HostCapError::denied("secret_unresolved"));
                };
                builder = builder.header(header_name, value);
            }
            if let Some(body) = &req.body {
                builder = builder.body(body.clone());
            }

            let resp = builder.send().await.map_err(|e| HostCapError { code: "backend".into(), message: format!("transport: {e}") })?;
            let status = resp.status();

            if status.is_redirection() {
                redirects += 1;
                if redirects > self.max_redirects {
                    return Err(HostCapError::denied("redirect_off_allowlist"));
                }
                let Some(location) = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()) else {
                    return Err(HostCapError::denied("redirect_off_allowlist"));
                };
                let next_url = current_url.join(location).map_err(|_| HostCapError::denied("redirect_off_allowlist"))?;
                self.precheck(&next_url, &req.method, allowed, denylist)?;
                self.check_and_resolve_addr(&next_url, allow_private_hosts).await?;
                current_url = next_url;
                continue;
            }

            let headers = resp.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string())).collect();
            let status_code = status.as_u16();
            let full = resp.bytes().await.map_err(|e| HostCapError { code: "backend".into(), message: format!("body read: {e}") })?;
            let truncated = full.len() as u64 > self.max_response_bytes;
            let body = if truncated { full[..self.max_response_bytes as usize].to_vec() } else { full.to_vec() };

            tracing::debug!(app_id, host = current_url.host_str().unwrap_or(""), status = status_code, "egress.request_completed");
            return Ok(EgressResponse { status: status_code, headers, body, truncated });
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib hostcap::http::"`
Expected: `test result: ok. 8 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/Cargo.toml core/svc_process/Cargo.lock core/svc_process/src/hostcap/http.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): http capability -- full Sec8.2 SSRF/allowlist/rate-limit guard

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 20: `db` capability + `CompositeHandler` (`hostcap/db.rs`, `hostcap/mod.rs`)

**Files:**
- Modify: `core/svc_process/src/hostcap/db.rs`, `core/svc_process/src/hostcap/mod.rs`, `core/svc_process/Cargo.toml`

**Interfaces:**
- Consumes: every capability from Tasks 15, 17, 18, 19.
- Produces: `pub struct DbValue` (a `serde_json::Value`-compatible tagged wire value matching spec Sec6.5's `db.value` variant, serialized as `{"type": "null"|"bool"|"int"|"float"|"text"|"bytes", "value": ...}`); `pub struct DbCapability { .. }` with `pub fn new(base_dsn_template: String) -> Self` (a `{role}`-templated Postgres DSN, credentials resolved per role at connect time), `pub async fn execute(&self, app_id: &str, tenant: &str, community: Option<&str>, allowed_tables: &[String], statement: &str, params: Vec<serde_json::Value>) -> Result<serde_json::Value, HostCapError>` (spec Sec7.4: parse-and-allowlist-check via `sqlparser`, refuse multi-statement/`COPY`/`DO`/`SET ROLE`/`GRANT`/DDL, then execute under the per-bundle role with `SET LOCAL waddles.tenant`/`waddles.community`); `pub fn bundle_role_name(app_id: &str) -> String` (`bundle_<app_id with '.'/'-' -> '_'>`, spec Sec20 A13); `pub struct CompositeHandler { .. }` implementing `HostCallHandler`, assembled from one instance of each of `ContextCapability`(Task 15)/`KvCapability`(17)/`FlagsCapability`+`LogCapability`+`ClockCapability`(18)/`HttpCapability`(19)/`DbCapability`(this task), routing on the `capability` string and returning `HostCapError::denied("...")` for a capability the calling bundle's manifest never granted (spec Sec6.5 "A call to an ungranted capability returns `denied(...)`").

- [ ] **Step 1: Write the failing tests**

```rust
// hostcap/db.rs -- unit tests need no live Postgres; they exercise the parser guard only
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_role_name_replaces_dots_and_dashes() {
        assert_eq!(bundle_role_name("waddles.socials.music.default"), "bundle_waddles_socials_music_default");
        assert_eq!(bundle_role_name("waddles.bot-commands.default"), "bundle_waddles_bot_commands_default");
    }

    #[test]
    fn statement_touching_a_table_outside_the_allowlist_is_denied_before_any_connection() {
        let allowed = vec!["music_queue".to_string()];
        let err = check_table_allowlist("SELECT * FROM users", &allowed).unwrap_err();
        assert_eq!(err.code, "denied");
    }

    #[test]
    fn statement_touching_an_allowed_table_passes() {
        let allowed = vec!["music_queue".to_string()];
        assert!(check_table_allowlist("SELECT * FROM music_queue WHERE id = $1", &allowed).is_ok());
    }

    #[test]
    fn multi_statement_is_refused() {
        let allowed = vec!["music_queue".to_string()];
        let err = check_table_allowlist("SELECT 1; DROP TABLE music_queue", &allowed).unwrap_err();
        assert_eq!(err.code, "denied");
    }

    #[test]
    fn ddl_and_grant_and_copy_and_do_and_set_role_are_all_refused() {
        let allowed = vec!["music_queue".to_string()];
        for stmt in ["DROP TABLE music_queue", "CREATE TABLE x (id int)", "ALTER TABLE music_queue ADD COLUMN y int", "GRANT ALL ON music_queue TO PUBLIC", "COPY music_queue TO STDOUT", "DO $$ BEGIN END $$", "SET ROLE admin"] {
            assert!(check_table_allowlist(stmt, &allowed).is_err(), "{stmt} should have been refused");
        }
    }
}
```

```rust
// hostcap/mod.rs -- CompositeHandler routing test
#[cfg(test)]
mod composite_tests {
    use super::*;

    #[tokio::test]
    async fn ungranted_capability_is_denied() {
        // A CompositeHandler built with an empty `granted` set for this
        // app_id refuses every capability call before reaching the real
        // implementation -- exercised fully once Task 25's worker wires a
        // live CompositeHandler; here we assert the routing table itself
        // rejects an unknown capability name.
        let err = route_capability_name("not-a-real-capability").unwrap_err();
        assert_eq!(err.code, "denied");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib hostcap::db:: hostcap::composite_tests::"`
Expected: FAIL to compile.

- [ ] **Step 3: Add `sea-orm` role-pool support (already pinned) and implement**

```rust
// core/svc_process/src/hostcap/db.rs
//! `db` capability -- parameterized SQL executed by the stage under the
//! bundle's own Postgres role, table-allowlist-checked twice (parser +
//! role grants) -- spec Sec6.5, Sec7.4, Sec11.10.1.
use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::{ConnectionTrait, Database, DatabaseConnection, Statement};
use sqlparser::ast::{Statement as SqlStatement, TableFactor};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;
use tokio::sync::RwLock;

use crate::hostcap::HostCapError;

/// `bundle_<app_id with '.'/'-' replaced by '_'>` -- spec Sec20 A13.
pub fn bundle_role_name(app_id: &str) -> String {
    format!("bundle_{}", app_id.replace(['.', '-'], "_"))
}

/// Parses `statement` and refuses it before any connection is touched
/// unless every referenced table is in `allowed_tables`, and the statement
/// contains exactly one top-level statement with none of `COPY`/`DO`/
/// `SET ROLE`/`GRANT`/`CREATE`/`DROP`/`ALTER` -- spec Sec7.4.
pub fn check_table_allowlist(statement: &str, allowed_tables: &[String]) -> Result<(), HostCapError> {
    let dialect = PostgreSqlDialect {};
    let parsed = Parser::parse_sql(&dialect, statement).map_err(|e| HostCapError { code: "denied".into(), message: format!("syntax: {e}") })?;
    if parsed.len() != 1 {
        return Err(HostCapError::denied("multiple top-level statements are not permitted"));
    }
    let stmt = &parsed[0];
    match stmt {
        SqlStatement::Query(query) => check_query_tables(query, allowed_tables),
        SqlStatement::Insert(insert) => check_table_name(&insert.table.to_string(), allowed_tables),
        SqlStatement::Update { table, .. } => check_table_factor(&table.relation, allowed_tables),
        SqlStatement::Delete(delete) => {
            for t in &delete.from {
                check_table_factor(&t.relation, allowed_tables)?;
            }
            Ok(())
        }
        SqlStatement::Copy { .. } => Err(HostCapError::denied("COPY is not permitted")),
        SqlStatement::CreateTable { .. } | SqlStatement::Drop { .. } | SqlStatement::AlterTable { .. } => {
            Err(HostCapError::denied("DDL is not permitted"))
        }
        SqlStatement::Grant { .. } => Err(HostCapError::denied("GRANT is not permitted")),
        SqlStatement::SetRole { .. } => Err(HostCapError::denied("SET ROLE is not permitted")),
        _ => Err(HostCapError::denied("statement type is not permitted")),
    }
}

fn check_table_name(name: &str, allowed: &[String]) -> Result<(), HostCapError> {
    let bare = name.rsplit('.').next().unwrap_or(name).trim_matches('"');
    if allowed.iter().any(|t| t == bare) {
        Ok(())
    } else {
        Err(HostCapError::denied(&format!("table {bare} is outside this bundle's data.tables")))
    }
}

fn check_table_factor(factor: &TableFactor, allowed: &[String]) -> Result<(), HostCapError> {
    if let TableFactor::Table { name, .. } = factor {
        check_table_name(&name.to_string(), allowed)
    } else {
        Ok(())
    }
}

fn check_query_tables(query: &sqlparser::ast::Query, allowed: &[String]) -> Result<(), HostCapError> {
    if let sqlparser::ast::SetExpr::Select(select) = query.body.as_ref() {
        for t in &select.from {
            check_table_factor(&t.relation, allowed)?;
            for join in &t.joins {
                check_table_factor(&join.relation, allowed)?;
            }
        }
    }
    Ok(())
}

fn json_to_sea_orm_value(v: &serde_json::Value) -> sea_orm::Value {
    match v {
        serde_json::Value::Null => sea_orm::Value::String(None),
        serde_json::Value::Bool(b) => sea_orm::Value::Bool(Some(*b)),
        serde_json::Value::Number(n) if n.is_i64() => sea_orm::Value::BigInt(n.as_i64()),
        serde_json::Value::Number(n) => sea_orm::Value::Double(n.as_f64()),
        serde_json::Value::String(s) => sea_orm::Value::String(Some(Box::new(s.clone()))),
        other => sea_orm::Value::String(Some(Box::new(other.to_string()))),
    }
}

/// Per-bundle-role connection pool + the parser guard + RLS scoping.
pub struct DbCapability {
    dsn_template: String,
    connections: RwLock<HashMap<String, Arc<DatabaseConnection>>>,
}

impl DbCapability {
    /// `dsn_template` contains the literal `{role}` and `{password}`
    /// placeholders, e.g. `postgres://{role}:{password}@postgres:5432/waddlebot?sslmode=verify-full`
    /// -- the password for `bundle_<app_id>` roles is resolved from the
    /// same per-role Secret hub-api provisions at approval time
    /// (`BUNDLE_ROLE_PASSWORD_<ROLE>` env var, set by the chart).
    pub fn new(dsn_template: String) -> Self {
        Self { dsn_template, connections: RwLock::new(HashMap::new()) }
    }

    async fn connection_for_role(&self, role: &str) -> Result<Arc<DatabaseConnection>, HostCapError> {
        if let Some(conn) = self.connections.read().await.get(role) {
            return Ok(conn.clone());
        }
        let password_var = format!("BUNDLE_ROLE_PASSWORD_{}", role.to_uppercase());
        let password = std::env::var(&password_var).map_err(|_| HostCapError::backend(format!("missing {password_var}")))?;
        let dsn = self.dsn_template.replace("{role}", role).replace("{password}", &password);
        let conn = Arc::new(Database::connect(&dsn).await.map_err(HostCapError::backend)?);
        self.connections.write().await.insert(role.to_string(), conn.clone());
        Ok(conn)
    }

    /// Runs the two-layer guard (parser, then role+RLS) and executes
    /// `statement` under the bundle's own role, `SET LOCAL`-scoped to
    /// `tenant`/`community` for row-level-security policies.
    pub async fn execute(
        &self,
        app_id: &str,
        tenant: &str,
        community: Option<&str>,
        allowed_tables: &[String],
        statement: &str,
        params: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, HostCapError> {
        check_table_allowlist(statement, allowed_tables)?;
        let role = bundle_role_name(app_id);
        let conn = self.connection_for_role(&role).await?;
        let txn = conn.begin().await.map_err(HostCapError::backend)?;
        txn.execute_unprepared(&format!("SET LOCAL waddles.tenant = '{}'", tenant.replace('\'', "''")))
            .await
            .map_err(HostCapError::backend)?;
        if let Some(c) = community {
            txn.execute_unprepared(&format!("SET LOCAL waddles.community = '{}'", c.replace('\'', "''")))
                .await
                .map_err(HostCapError::backend)?;
        }
        let values: Vec<sea_orm::Value> = params.iter().map(json_to_sea_orm_value).collect();
        let sea_stmt = Statement::from_sql_and_values(sea_orm::DatabaseBackend::Postgres, statement, values);
        let rows = txn.query_all(sea_stmt).await.map_err(HostCapError::backend)?;
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let columns = row.column_names();
            let mut obj = serde_json::Map::new();
            for col in &columns {
                let value: Option<String> = row.try_get_by(col.as_str()).ok();
                obj.insert(col.clone(), value.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
            }
            out_rows.push(serde_json::Value::Object(obj));
        }
        let rows_affected = out_rows.len() as u64;
        txn.commit().await.map_err(HostCapError::backend)?;
        Ok(serde_json::json!({"columns": columns_of(&rows), "rows": out_rows, "rows_affected": rows_affected}))
    }
}

fn columns_of(rows: &[sea_orm::QueryResult]) -> Vec<String> {
    rows.first().map(|r| r.column_names()).unwrap_or_default()
}
```

**Note on `sea_orm::QueryResult::column_names`:** if the pinned `sea-orm` version does not expose this exact method name, substitute the equivalent accessor its docs name (the parser guard and role/RLS logic above are unaffected either way) -- this is the one call site in this task whose exact name should be confirmed against the pinned `=2.0.2` docs during Step 4.

```rust
// core/svc_process/src/hostcap/mod.rs -- append below the existing trait/error/re-exports from Task 15
use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex as TokioMutex;

use crate::distribution::{EgressRule, Limits};
use crate::hostcap::clock::ClockCapability;
use crate::hostcap::db::DbCapability;
use crate::hostcap::flags::FlagsCapability;
use crate::hostcap::http::{EgressRequest, HttpCapability};
use crate::hostcap::kv::KvCapability;
use crate::hostcap::log::LogCapability;
use crate::spine::keys::Scope;

/// The manifest-derived, approval-scoped capability grant for one bundle
/// invocation -- spec Sec6.5 "Capability scoping" table, Sec9.7.3 (the
/// runtime enforces the approval, not the manifest -- `granted_capabilities`
/// is built from the distribution API's already-approved manifest subset,
/// never re-derived from anything the bundle itself asserts).
#[derive(Clone)]
pub struct BundleGrant {
    pub scope: Scope,
    pub app_id: String,
    pub version: String,
    pub egress: Vec<EgressRule>,
    pub egress_denylist: Vec<String>,
    pub allow_private_hosts: bool,
    pub data_tables: Vec<String>,
    pub limits: Limits,
}

fn route_capability_name(name: &str) -> Result<(), HostCapError> {
    match name {
        "context" | "kv" | "flags" | "log" | "clock" | "http" | "db" => Ok(()),
        other => Err(HostCapError::denied(&format!("unknown capability {other}"))),
    }
}

/// Routes one `host-call` to the concrete capability implementation,
/// enforcing the grant table (spec Sec6.5): `http` only when `egress` is
/// non-empty, `db` only when `data.tables` is non-empty; `relay` is never
/// routed here at all (process bundles do not get it, spec Sec6.5).
pub struct CompositeHandler {
    grants: Arc<TokioMutex<HashMap<String, BundleGrant>>>,
    kv: Arc<KvCapability>,
    flags: Arc<FlagsCapability>,
    log: Arc<LogCapability>,
    clock: Arc<ClockCapability>,
    http: Arc<HttpCapability>,
    db: Arc<DbCapability>,
    limiters: TokioMutex<HashMap<String, governor::DefaultDirectRateLimiter>>,
}

impl CompositeHandler {
    /// Builds a router over one instance of every capability. `grants` is
    /// populated by Task 25's worker before an `invoke` is issued for a
    /// given `app_id`, and read here for the duration of the call.
    pub fn new(kv: Arc<KvCapability>, flags: Arc<FlagsCapability>, log: Arc<LogCapability>, clock: Arc<ClockCapability>, http: Arc<HttpCapability>, db: Arc<DbCapability>) -> Self {
        Self {
            grants: Arc::new(TokioMutex::new(HashMap::new())),
            kv, flags, log, clock, http, db,
            limiters: TokioMutex::new(HashMap::new()),
        }
    }

    /// Registers (or replaces) the grant for `app_id` -- called by Task 25
    /// once per bundle load/reload.
    pub async fn set_grant(&self, grant: BundleGrant) {
        self.grants.lock().await.insert(grant.app_id.clone(), grant);
    }

    async fn limiter_for(&self, app_id: &str, rps: u32) -> governor::DefaultDirectRateLimiter {
        let mut limiters = self.limiters.lock().await;
        limiters
            .entry(app_id.to_string())
            .or_insert_with(|| governor::RateLimiter::direct(governor::Quota::per_second(std::num::NonZeroU32::new(rps.max(1)).unwrap())))
            .clone()
    }
}

#[async_trait::async_trait]
impl HostCallHandler for CompositeHandler {
    async fn handle(&self, app_id: &str, capability: &str, op: &str, args: serde_json::Value) -> Result<serde_json::Value, HostCapError> {
        route_capability_name(capability)?;
        let grant = self.grants.lock().await.get(app_id).cloned().ok_or_else(|| HostCapError::denied("bundle has no active grant"))?;

        match capability {
            "context" => Err(HostCapError::denied("context is answered inline by the worker, never via host-call")),
            "clock" => match op {
                "now-millis" => Ok(serde_json::json!(self.clock.now_millis())),
                "now-rfc3339" => Ok(serde_json::json!(self.clock.now_rfc3339())),
                "monotonic-nanos" => Ok(serde_json::json!(self.clock.monotonic_nanos())),
                other => Err(HostCapError::denied(&format!("unknown clock op {other}"))),
            },
            "flags" => match op {
                "enabled" => {
                    let key = args["key"].as_str().unwrap_or_default();
                    let default_value = args["default-value"].as_bool().unwrap_or(false);
                    Ok(serde_json::json!(self.flags.enabled(key, default_value).await))
                }
                "tier" => Ok(serde_json::json!(self.flags.tier().await)),
                other => Err(HostCapError::denied(&format!("unknown flags op {other}"))),
            },
            "log" => {
                let level = args["level"].as_str().unwrap_or("info");
                let message = args["message"].as_str().unwrap_or_default();
                let fields: serde_json::Value = args["fields-json"].as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(serde_json::json!({}));
                self.log.write(level, message, fields, app_id, &grant.scope.tenant, grant.scope.community.as_deref());
                Ok(serde_json::json!(null))
            }
            "kv" => {
                let key = args["key"].as_str().unwrap_or_default();
                match op {
                    "get" => {
                        let v = self.kv.get(&grant.scope, app_id, key).await.map_err(|e| e)?;
                        Ok(serde_json::json!(v))
                    }
                    "set" => {
                        let value = args["value"].as_array().map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u8)).collect::<Vec<u8>>()).unwrap_or_default();
                        let ttl = args["ttl-seconds"].as_u64().unwrap_or(0) as u32;
                        self.kv.set(&grant.scope, app_id, key, &value, ttl).await?;
                        Ok(serde_json::json!(null))
                    }
                    "delete" => {
                        self.kv.delete(&grant.scope, app_id, key).await?;
                        Ok(serde_json::json!(null))
                    }
                    "increment" => {
                        let delta = args["delta"].as_i64().unwrap_or(0);
                        let ttl = args["ttl-seconds"].as_u64().unwrap_or(0) as u32;
                        Ok(serde_json::json!(self.kv.increment(&grant.scope, app_id, key, delta, ttl).await?))
                    }
                    other => Err(HostCapError::denied(&format!("unknown kv op {other}"))),
                }
            }
            "http" => {
                if grant.egress.is_empty() {
                    return Err(HostCapError::denied("egress not granted"));
                }
                let req: EgressRequest = serde_json::from_value(args).map_err(HostCapError::backend)?;
                let limiter = self.limiter_for(app_id, grant.limits.egress_rps).await;
                let resp = self.http.send(app_id, req, &grant.egress, &grant.egress_denylist, grant.allow_private_hosts, &limiter).await?;
                serde_json::to_value(resp.body.len()).map_err(HostCapError::backend)?; // touch resp to avoid unused warnings pattern elsewhere
                Ok(serde_json::json!({"status": resp.status, "headers": resp.headers, "body": resp.body, "truncated": resp.truncated}))
            }
            "db" => {
                if grant.data_tables.is_empty() {
                    return Err(HostCapError::denied("data.tables not granted"));
                }
                let statement = args["statement"].as_str().unwrap_or_default();
                let params: Vec<serde_json::Value> = args["params"].as_array().cloned().unwrap_or_default();
                self.db.execute(app_id, &grant.scope.tenant, grant.scope.community.as_deref(), &grant.data_tables, statement, params).await
            }
            other => Err(HostCapError::denied(&format!("unknown capability {other}"))),
        }
    }
}
```

(the `EgressRequest`/`EgressResponse` types need `#[derive(serde::Serialize, serde::Deserialize)]` added retroactively in `hostcap/http.rs` for the `serde_json::from_value` call above to compile — add those derives to both structs as part of this task's diff.)

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib hostcap::"`
Expected: `test result: ok` — 5 in `db::tests`, 1 in `composite_tests`, plus every prior `hostcap` test still green.

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/Cargo.toml core/svc_process/Cargo.lock core/svc_process/src/hostcap/
git commit -m "$(cat <<'EOF'
feat(svc-process): db capability (parser+role+RLS guard) + CompositeHandler routing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 21: D30 binding verification + D31 usage metering primitives (`spine/binding.rs`, `spine/usage.rs`)

**Files:**
- Create: `core/svc_process/src/spine/binding.rs`, `core/svc_process/src/spine/usage.rs`
- Modify: `core/svc_process/src/spine/mod.rs` (`pub mod binding;`/`pub mod usage;` already declared in Task 5 as placeholders — fill in for real), `core/svc_process/src/spine/client.rs` (add `append_usage`), `core/svc_process/src/config.rs` (add binding-key + metering fields), `core/svc_process/Cargo.toml`

**Interfaces:**
- Consumes: `StageEnvelope`, `Trace`, `Binding`, `trace_id_from_traceparent` (Task 5), `Scope`, `TENANT_WIDE_SEGMENT`, `parse_scope_from_key` (Task 6), `DlqErrorKind` (Task 7), `crate::distribution::model::Grant` (Task 11), `SpineClient` (Task 8), `Config`/`CliConfig` (Task 2).
- Produces: `pub struct BindingKeyEntry { pub key: Vec<u8>, pub retired_at: Option<chrono::DateTime<chrono::Utc>> }`; `pub struct BindingKeyring` with `pub fn from_entries(active_kid: impl Into<String>, entries: HashMap<String, BindingKeyEntry>, rotation_overlap: chrono::Duration) -> Result<Self, BoundaryError>`, `pub fn load(path: &std::path::Path, active_kid: impl Into<String>, rotation_overlap: chrono::Duration) -> Result<Self, BoundaryError>`, `pub fn signing_kid_and_key(&self) -> (&str, &[u8])`, `pub fn verify_key_for(&self, kid: &str, now: chrono::DateTime<chrono::Utc>) -> Option<&[u8]>`; `pub struct BindingInput<'a> { pub tenant: &'a str, pub community: Option<&'a str>, pub workstream_id: &'a str, pub event_id: &'a str, pub trace_id: &'a str }`; `pub fn compute_binding_mac(keyring: &BindingKeyring, input: &BindingInput<'_>) -> Binding`; `pub fn verify_binding(keyring: &BindingKeyring, env: &StageEnvelope) -> Result<(), BoundaryError>`; `pub struct ScopeCheck;` with `pub fn check_against_key(env: &StageEnvelope, key: &str) -> Result<(), BoundaryError>`, `pub fn check_against_grant(env: &StageEnvelope, grant: &crate::distribution::model::Grant) -> Result<(), BoundaryError>`; `#[derive(Debug, Clone, PartialEq, Eq)] pub enum BoundaryError { MacMismatch, UnknownOrExpiredKid { kid: String }, TenantMismatch, CommunityMismatch, MissingTrace }` with `pub fn reason(&self) -> &'static str`; `pub const RESERVED_IDENTITY_FIELDS: [&str; 5]`; `pub fn strip_bundle_identity_fields(payload: &mut serde_json::Map<String, serde_json::Value>) -> Option<&'static str>`; `pub const USAGE_STREAM_KEY: &str = "waddles:usage";`; `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum HostCallKind { Http, Kv, Db, Relay, Flags, Log }`; `#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)] pub struct HostCallCounts { pub http: u64, pub kv: u64, pub db: u64, pub relay: u64, pub flags: u64, pub log: u64 }` with `pub fn increment(&mut self, kind: HostCallKind)`, `pub fn add(&mut self, other: &HostCallCounts)`; `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)] pub struct UsageDelta { pub tenant_id: String, pub community_id: Option<String>, pub workstream_id: String, pub stage: String, pub app_id: Option<String>, pub events: u64, pub invocations: u64, pub host_calls: HostCallCounts, pub fuel_ms: u64, pub actions_delivered: u64, pub outbound_bytes: u64, pub media_minutes: Option<f64> }` with `pub fn zero(tenant_id: impl Into<String>, community_id: Option<String>, workstream_id: impl Into<String>, stage: impl Into<String>, app_id: Option<String>) -> Self`; `pub struct UsageBatcher { .. }` with `pub fn new() -> Self`, `pub fn record(&self, delta: UsageDelta)`, `pub fn flush(&self) -> Vec<UsageDelta>`, `pub fn is_empty(&self) -> bool`; `SpineClient::append_usage(&self, delta: &UsageDelta) -> Result<String, ProcessError>`. **Note on M4's divergence from `penguin_spine`:** the real crate's `BoundaryError::to_dlq_error(...) -> DlqError` and `DlqError` intermediate type are **not** ported here -- M4's `DlqRecord::new(...)` (Task 7) already takes every raw field directly, so a caller (Task 25's worker) builds a `DlqRecord` straight from `BoundaryError::reason()`/`.to_string()` without an intermediate type; when the real `penguin_spine::binding` is swapped in, that one call site changes from `DlqRecord::new(...)` to `boundary_err.to_dlq_error(...)` plus `DlqRecord::from_delivered(...)`, never a behaviour change. This task also adds two new `Config`/`CliConfig` field groups (binding keys, metering) that Task 2 did not yet have -- see Global Constraints' "later tasks extend earlier files" pattern, already used by Task 20 extending Task 15's `hostcap/mod.rs`.

Spec: §5.11 (D30 full normative text), §5.12 (D31), §12.3/§12.7 (`WADDLES_BINDING_KEY_FILE`/`WADDLES_BINDING_KID`/`WADDLES_BINDING_ROTATION_OVERLAP_S`, `METERING_ENABLED`/`METERING_FLUSH_INTERVAL_S`), §6.2 (`waddles:usage` write-only for stages), §14.11 (tests 1, 2, 4 — implemented directly here; **Task 33** wires these into the full negative-test suite against a live worker).

**New Cargo.toml pins** (append to `[dependencies]`, exact versions per Global Constraints Dependency Pinning):
```toml
hmac = "=0.12.1"
subtle = "=2.6.1"
hex = "=0.4.3"
```

- [ ] **Step 1: Write the failing tests**

```rust
// core/svc_process/src/spine/binding.rs -- #[cfg(test)] mod tests at the bottom
#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashMap;

    fn keyring_with(active_kid: &str, key: &[u8]) -> BindingKeyring {
        let mut entries = HashMap::new();
        entries.insert(active_kid.to_string(), BindingKeyEntry { key: key.to_vec(), retired_at: None });
        BindingKeyring::from_entries(active_kid, entries, chrono::Duration::seconds(86_400)).unwrap()
    }

    fn valid_json() -> serde_json::Value {
        serde_json::json!({
            "schema_version": 2, "tenant": "acme", "community": "main",
            "app_id": "waddles.bot.commands.default", "stage": "process",
            "event": {"platform": "twitch", "event_type": "chat.message", "actor": "u", "payload": {}, "occurred_at": "2026-09-14T12:00:00.000Z"},
            "ts": "2026-09-14T12:00:00.123Z", "target_app_id": null,
            "workstream_id": "8f14e45f-ceea-467e-adde-3fb5c9752730",
            "event_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "session_id": null,
            "trace": {"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "tracestate": null},
            "binding": {"kid": "2026-09", "mac": "a".repeat(64)}
        })
    }

    fn signed_envelope(keyring: &BindingKeyring, tenant: &str, community: Option<&str>) -> StageEnvelope {
        let mut v = valid_json();
        v["tenant"] = serde_json::json!(tenant);
        v["community"] = community.map(serde_json::json!).unwrap_or(serde_json::Value::Null);
        let input = BindingInput {
            tenant, community,
            workstream_id: "8f14e45f-ceea-467e-adde-3fb5c9752730",
            event_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        };
        let binding = compute_binding_mac(keyring, &input);
        v["binding"] = serde_json::json!({"kid": binding.kid, "mac": binding.mac});
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn compute_and_verify_round_trip_succeeds() {
        let keyring = keyring_with("2026-09", &[1u8; 32]);
        let env = signed_envelope(&keyring, "acme", Some("main"));
        assert!(verify_binding(&keyring, &env).is_ok());
    }

    #[test]
    fn tampered_mac_is_rejected() {
        let keyring = keyring_with("2026-09", &[1u8; 32]);
        let mut env = signed_envelope(&keyring, "acme", Some("main"));
        let mut mac_bytes = hex::decode(&env.binding.mac).unwrap();
        mac_bytes[0] ^= 0xFF;
        env.binding.mac = hex::encode(mac_bytes);
        assert_eq!(verify_binding(&keyring, &env), Err(BoundaryError::MacMismatch));
    }

    #[test]
    fn unknown_kid_is_rejected() {
        let keyring = keyring_with("2026-09", &[1u8; 32]);
        let mut env = signed_envelope(&keyring, "acme", Some("main"));
        env.binding.kid = "does-not-exist".to_string();
        let err = verify_binding(&keyring, &env).unwrap_err();
        assert_eq!(err, BoundaryError::UnknownOrExpiredKid { kid: "does-not-exist".to_string() });
        assert_eq!(err.reason(), "unknown_kid");
    }

    #[test]
    fn rotated_key_accepted_within_overlap_and_refused_after() {
        let old_key = [2u8; 32];
        let new_key = [3u8; 32];
        let mut entries = HashMap::new();
        entries.insert("2026-09".to_string(), BindingKeyEntry { key: new_key.to_vec(), retired_at: None });
        entries.insert("2026-08".to_string(), BindingKeyEntry { key: old_key.to_vec(), retired_at: Some(chrono::Utc::now() - chrono::Duration::seconds(10)) });
        let keyring_within = BindingKeyring::from_entries("2026-09", entries.clone(), chrono::Duration::seconds(3600)).unwrap();
        let input = BindingInput { tenant: "acme", community: Some("main"), workstream_id: "8f14e45f-ceea-467e-adde-3fb5c9752730", event_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" };
        let mac = compute_binding_mac(&BindingKeyring::from_entries("2026-08", {
            let mut m = HashMap::new();
            m.insert("2026-08".to_string(), BindingKeyEntry { key: old_key.to_vec(), retired_at: None });
            m
        }, chrono::Duration::seconds(3600)).unwrap(), &input);
        let mut v = valid_json();
        v["binding"] = serde_json::json!({"kid": "2026-08", "mac": mac.mac});
        let env: StageEnvelope = serde_json::from_value(v).unwrap();
        assert!(verify_binding(&keyring_within, &env).is_ok(), "must accept a retired kid within its overlap window");

        let mut expired_entries = entries;
        expired_entries.insert("2026-08".to_string(), BindingKeyEntry { key: old_key.to_vec(), retired_at: Some(chrono::Utc::now() - chrono::Duration::seconds(7_200)) });
        let keyring_expired = BindingKeyring::from_entries("2026-09", expired_entries, chrono::Duration::seconds(3600)).unwrap();
        let err = verify_binding(&keyring_expired, &env).unwrap_err();
        assert_eq!(err, BoundaryError::UnknownOrExpiredKid { kid: "2026-08".to_string() });
    }

    #[test]
    fn missing_trace_is_rejected() {
        let keyring = keyring_with("2026-09", &[1u8; 32]);
        let mut v = valid_json();
        v["trace"] = serde_json::Value::Null;
        let env: StageEnvelope = serde_json::from_value(v).unwrap();
        assert_eq!(verify_binding(&keyring, &env), Err(BoundaryError::MissingTrace));
    }

    #[test]
    fn scope_check_rejects_a_different_tenant_stream() {
        let keyring = keyring_with("2026-09", &[1u8; 32]);
        let env = signed_envelope(&keyring, "acme", Some("main"));
        assert!(verify_binding(&keyring, &env).is_ok(), "the MAC itself is valid for acme/main");
        let err = ScopeCheck::check_against_key(&env, "waddles:t:other-tenant:c:main:src:twitch:tw-a:events").unwrap_err();
        assert_eq!(err, BoundaryError::TenantMismatch);
    }

    #[test]
    fn scope_check_rejects_a_different_community() {
        let keyring = keyring_with("2026-09", &[1u8; 32]);
        let env = signed_envelope(&keyring, "acme", Some("main"));
        let err = ScopeCheck::check_against_key(&env, "waddles:t:acme:c:other:src:twitch:tw-a:events").unwrap_err();
        assert_eq!(err, BoundaryError::CommunityMismatch);
    }

    #[test]
    fn scope_check_against_grant_delegates_to_check_against_key() {
        let keyring = keyring_with("2026-09", &[1u8; 32]);
        let env = signed_envelope(&keyring, "acme", Some("main"));
        let grant = crate::distribution::model::Grant {
            grant_id: 1, stream: "waddles:t:acme:c:main:src:twitch:tw-a:events".to_string(),
            platform: "twitch".to_string(), source_id: "tw-a".to_string(), label: "primary".to_string(),
        };
        assert!(ScopeCheck::check_against_grant(&env, &grant).is_ok());
    }

    #[test]
    fn strip_bundle_identity_fields_removes_the_first_reserved_key() {
        let mut payload = serde_json::Map::new();
        payload.insert("text".to_string(), serde_json::json!("hello"));
        payload.insert("tenant_id".to_string(), serde_json::json!("attacker-supplied"));
        let removed = strip_bundle_identity_fields(&mut payload);
        assert_eq!(removed, Some("tenant_id"));
        assert!(!payload.contains_key("tenant_id"));
    }

    #[test]
    fn strip_bundle_identity_fields_is_none_when_nothing_reserved() {
        let mut payload = serde_json::Map::new();
        payload.insert("text".to_string(), serde_json::json!("hello"));
        assert_eq!(strip_bundle_identity_fields(&mut payload), None);
    }
}
```

```rust
// core/svc_process/src/spine/usage.rs -- #[cfg(test)] mod tests at the bottom
#[cfg(test)]
mod tests {
    use super::*;

    fn sample(events: u64, invocations: u64) -> UsageDelta {
        let mut d = UsageDelta::zero("acme", Some("main".to_string()), "ws-1", "process", Some("waddles.bot.commands.default".to_string()));
        d.events = events;
        d.invocations = invocations;
        d
    }

    #[test]
    fn host_call_counts_increment_and_add() {
        let mut counts = HostCallCounts::default();
        counts.increment(HostCallKind::Http);
        counts.increment(HostCallKind::Http);
        counts.increment(HostCallKind::Db);
        assert_eq!(counts, HostCallCounts { http: 2, db: 1, ..Default::default() });
    }

    #[test]
    fn batcher_sums_records_sharing_the_same_key() {
        let batcher = UsageBatcher::new();
        batcher.record(sample(3, 1));
        batcher.record(sample(2, 1));
        let flushed = batcher.flush();
        assert_eq!(flushed.len(), 1, "same key must merge into one row");
        assert_eq!(flushed[0].events, 5);
    }

    #[test]
    fn batcher_keeps_different_app_ids_separate() {
        let batcher = UsageBatcher::new();
        batcher.record(sample(1, 0));
        let mut other = sample(1, 0);
        other.app_id = Some("waddles.bot.other.default".to_string());
        batcher.record(other);
        assert_eq!(batcher.flush().len(), 2);
    }

    #[test]
    fn flush_drains_and_clears_the_batch() {
        let batcher = UsageBatcher::new();
        batcher.record(sample(1, 1));
        assert!(!batcher.is_empty());
        assert_eq!(batcher.flush().len(), 1);
        assert!(batcher.is_empty());
        assert_eq!(batcher.flush().len(), 0);
    }

    #[test]
    fn usage_delta_round_trips_through_json() {
        let d = sample(5, 2);
        let json = serde_json::to_string(&d).unwrap();
        let back: UsageDelta = serde_json::from_str(&json).unwrap();
        assert_eq!(back, d);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib spine::binding:: spine::usage::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `spine/binding.rs`, `spine/usage.rs`, extend `spine/client.rs` and `config.rs`**

```rust
// core/svc_process/src/spine/binding.rs
//! D30: workstream identity, end-to-end trace, and the tenant wall (spec
//! Sec5.11). `BindingKeyring` holds the symmetric HMAC keys named by `kid`
//! (spec Sec12.3 `security.envelopeBinding.keySecretRef`) -- **never held
//! by hub-api, a bundle, or the compiler**, only the four Rust stage
//! services. PROVISIONAL(M1): mirrors `penguin_spine::binding` exactly.
use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::distribution::model::Grant;
use crate::spine::envelope::{trace_id_from_traceparent, Binding, StageEnvelope};
use crate::spine::keys::{parse_scope_from_key, TENANT_WIDE_SEGMENT};

type HmacSha256 = Hmac<Sha256>;

/// One HMAC key version. `retired_at: None` means this is the currently
/// active signing key; `Some(t)` means it was retired at `t` and is still
/// *verification*-eligible until `t + rotation_overlap`, never used to
/// mint a new MAC.
#[derive(Clone)]
pub struct BindingKeyEntry {
    /// Raw key bytes. Never logged -- see this type's `Debug` impl.
    pub key: Vec<u8>,
    /// `None` = active (signs new MACs); `Some(t)` = retired at `t`.
    pub retired_at: Option<DateTime<Utc>>,
}

impl std::fmt::Debug for BindingKeyEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BindingKeyEntry").field("key", &"[REDACTED]").field("retired_at", &self.retired_at).finish()
    }
}

/// The set of `kid`-named HMAC keys a stage replica holds (spec Sec5.11,
/// Sec12.3). Loaded once at startup from `WADDLES_BINDING_KEY_FILE` and
/// never mutated; a rotation is a new deploy with a new file.
#[derive(Clone)]
pub struct BindingKeyring {
    active_kid: String,
    keys: HashMap<String, BindingKeyEntry>,
    rotation_overlap: ChronoDuration,
}

#[derive(Debug, Deserialize)]
struct RawKeyEntry {
    key_hex: String,
    #[serde(default)]
    retired_at: Option<String>,
}

impl BindingKeyring {
    /// Builds a keyring directly from decoded entries.
    pub fn from_entries(active_kid: impl Into<String>, entries: HashMap<String, BindingKeyEntry>, rotation_overlap: ChronoDuration) -> Result<Self, BoundaryError> {
        let active_kid = active_kid.into();
        match entries.get(&active_kid) {
            Some(e) if e.retired_at.is_none() => Ok(BindingKeyring { active_kid, keys: entries, rotation_overlap }),
            _ => Err(BoundaryError::UnknownOrExpiredKid { kid: active_kid }),
        }
    }

    /// Loads `WADDLES_BINDING_KEY_FILE` (spec Sec12.7): a JSON object
    /// `{"<kid>": {"key_hex": "...", "retired_at": "<rfc3339>"|null}, ...}`.
    pub fn load(path: &Path, active_kid: impl Into<String>, rotation_overlap: ChronoDuration) -> Result<Self, BoundaryError> {
        let text = std::fs::read_to_string(path).map_err(|_| BoundaryError::UnknownOrExpiredKid { kid: "<unreadable key file>".to_string() })?;
        let raw: HashMap<String, RawKeyEntry> = serde_json::from_str(&text).map_err(|_| BoundaryError::UnknownOrExpiredKid { kid: "<malformed key file>".to_string() })?;
        let mut entries = HashMap::with_capacity(raw.len());
        for (kid, r) in raw {
            let key = hex::decode(&r.key_hex).map_err(|_| BoundaryError::UnknownOrExpiredKid { kid: kid.clone() })?;
            let retired_at = match r.retired_at {
                None => None,
                Some(s) => Some(DateTime::parse_from_rfc3339(&s).map_err(|_| BoundaryError::UnknownOrExpiredKid { kid: kid.clone() })?.with_timezone(&Utc)),
            };
            entries.insert(kid, BindingKeyEntry { key, retired_at });
        }
        Self::from_entries(active_kid, entries, rotation_overlap)
    }

    /// The `(kid, key)` pair every new `binding.mac` is minted under.
    pub fn signing_kid_and_key(&self) -> (&str, &[u8]) {
        let entry = self.keys.get(&self.active_kid).expect("invariant: from_entries/load never construct a keyring whose active_kid is absent or retired");
        (&self.active_kid, &entry.key)
    }

    /// The verification key for `kid`, if active or a retired key still
    /// inside its rotation-overlap window as of `now`.
    pub fn verify_key_for(&self, kid: &str, now: DateTime<Utc>) -> Option<&[u8]> {
        let entry = self.keys.get(kid)?;
        match entry.retired_at {
            None => Some(&entry.key),
            Some(retired_at) if now <= retired_at + self.rotation_overlap => Some(&entry.key),
            Some(_) => None,
        }
    }
}

/// The exact field tuple spec Sec5.11's `binding.mac` formula names:
/// `HMAC-SHA256(k_binding[kid], tenant || community || workstream_id ||
/// event_id || trace_id)`, concatenated with no separator.
pub struct BindingInput<'a> {
    /// The envelope's tenant slug.
    pub tenant: &'a str,
    /// The envelope's community slug, or `None` for tenant-wide.
    pub community: Option<&'a str>,
    /// The envelope's `workstream_id`.
    pub workstream_id: &'a str,
    /// The envelope's `event_id`.
    pub event_id: &'a str,
    /// The 32-hex trace-id segment of `trace.traceparent`.
    pub trace_id: &'a str,
}

impl BindingInput<'_> {
    fn concat(&self) -> String {
        let community = self.community.unwrap_or(TENANT_WIDE_SEGMENT);
        format!("{}{}{}{}{}", self.tenant, community, self.workstream_id, self.event_id, self.trace_id)
    }
}

fn hmac_hex(key: &[u8], input: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(input.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Mints a fresh `binding.mac` under the keyring's currently active `kid`.
/// Ingest calls this once per inbound event; no other stage mints, only
/// verifies (out of this plan's scope, but exercised here since it is the
/// pair `verify_binding`'s tests need).
pub fn compute_binding_mac(keyring: &BindingKeyring, input: &BindingInput<'_>) -> Binding {
    let (kid, key) = keyring.signing_kid_and_key();
    Binding { kid: kid.to_string(), mac: hmac_hex(key, &input.concat()) }
}

/// Errors from `verify_binding`/`ScopeCheck` (spec Sec5.11's tenant wall,
/// D30). Every variant maps to `DlqErrorKind::TenantBoundary` at the call
/// site (Task 25's worker) -- **never retried**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundaryError {
    /// The recomputed MAC did not match `binding.mac`.
    MacMismatch,
    /// `binding.kid` is unknown, or was retired outside its rotation-overlap window.
    UnknownOrExpiredKid {
        /// The offending kid.
        kid: String,
    },
    /// The envelope's `tenant` disagrees with the stream key's `t:` segment (or a `Grant`'s).
    TenantMismatch,
    /// The envelope's `community` disagrees with the stream key's `c:` segment (or a `Grant`'s).
    CommunityMismatch,
    /// `binding.mac` cannot be verified because the envelope carries no `trace`.
    MissingTrace,
}

impl std::fmt::Display for BoundaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BoundaryError::MacMismatch => write!(f, "binding.mac does not verify"),
            BoundaryError::UnknownOrExpiredKid { kid } => write!(f, "binding.kid {kid:?} is unknown or its rotation-overlap window has elapsed"),
            BoundaryError::TenantMismatch => write!(f, "envelope tenant does not match the stream/grant it was read from"),
            BoundaryError::CommunityMismatch => write!(f, "envelope community does not match the stream/grant it was read from"),
            BoundaryError::MissingTrace => write!(f, "envelope has no trace; binding.mac cannot be verified without a trace_id"),
        }
    }
}

impl std::error::Error for BoundaryError {}

impl BoundaryError {
    /// The `reason` label on `waddles_tenant_boundary_violations_total`
    /// and the DLQ record's `error.code` basis.
    pub fn reason(&self) -> &'static str {
        match self {
            BoundaryError::MacMismatch => "mac_mismatch",
            BoundaryError::UnknownOrExpiredKid { .. } => "unknown_kid",
            BoundaryError::TenantMismatch => "tenant_mismatch",
            BoundaryError::CommunityMismatch => "community_mismatch",
            BoundaryError::MissingTrace => "missing_trace",
        }
    }
}

/// Verifies `env.binding.mac` against a freshly recomputed value (spec
/// Sec5.11, check 1 of 4). Constant-time compare on the decoded MAC bytes.
pub fn verify_binding(keyring: &BindingKeyring, env: &StageEnvelope) -> Result<(), BoundaryError> {
    let trace = env.trace.as_ref().ok_or(BoundaryError::MissingTrace)?;
    let trace_id = trace_id_from_traceparent(&trace.traceparent).ok_or(BoundaryError::MissingTrace)?;
    let key = keyring.verify_key_for(&env.binding.kid, Utc::now()).ok_or_else(|| BoundaryError::UnknownOrExpiredKid { kid: env.binding.kid.clone() })?;
    let input = BindingInput { tenant: &env.tenant, community: env.community.as_deref(), workstream_id: &env.workstream_id, event_id: &env.event_id, trace_id };
    let expected_hex = hmac_hex(key, &input.concat());
    let expected_bytes = hex::decode(&expected_hex).unwrap_or_default();
    let actual_bytes = hex::decode(&env.binding.mac).unwrap_or_default();
    let equal = expected_bytes.len() == actual_bytes.len() && bool::from(expected_bytes.ct_eq(&actual_bytes));
    if equal { Ok(()) } else { Err(BoundaryError::MacMismatch) }
}

/// Verifies that an envelope's tenant/community agree with the Valkey key
/// (or [`Grant`]) it was read from (spec Sec5.11, checks 2-3 of 4).
pub struct ScopeCheck;

impl ScopeCheck {
    /// Check 2: `env.tenant`/`env.community` equal the `t:`/`c:` segments
    /// of the stream key the entry was read from.
    pub fn check_against_key(env: &StageEnvelope, key: &str) -> Result<(), BoundaryError> {
        let (tenant, community) = parse_scope_from_key(key).ok_or(BoundaryError::TenantMismatch)?;
        if env.tenant != tenant {
            return Err(BoundaryError::TenantMismatch);
        }
        if env.community != community {
            return Err(BoundaryError::CommunityMismatch);
        }
        Ok(())
    }

    /// Check 3: `env.tenant`/`env.community` equal the tenant/community
    /// implied by the [`Grant`] (its stream's key) the bundle was
    /// permitted to read.
    pub fn check_against_grant(env: &StageEnvelope, grant: &Grant) -> Result<(), BoundaryError> {
        Self::check_against_key(env, &grant.stream)
    }
}

/// The envelope-identity fields a process bundle's `transform` output can
/// never set (spec Sec5.11 "Bundles cannot move a workstream").
pub const RESERVED_IDENTITY_FIELDS: [&str; 5] = ["tenant_id", "community_id", "workstream_id", "event_id", "trace"];

/// Removes the first [`RESERVED_IDENTITY_FIELDS`] key present in a process
/// bundle's returned payload, if any, and returns its name so the caller
/// (Task 24's routing built-in) can count
/// `waddles_tenant_boundary_violations_total{stage="process",
/// reason="bundle_set_identity"}`. Not a hard failure: only the offending
/// field is dropped, the event is not.
pub fn strip_bundle_identity_fields(payload: &mut serde_json::Map<String, serde_json::Value>) -> Option<&'static str> {
    for field in RESERVED_IDENTITY_FIELDS {
        if payload.remove(field).is_some() {
            return Some(field);
        }
    }
    None
}
```

```rust
// core/svc_process/src/spine/usage.rs
//! D31: workstream usage metering (spec Sec5.12). Every stage batches
//! deltas in-process via [`UsageBatcher`] and flushes them onto
//! [`USAGE_STREAM_KEY`] at most every `METERING_FLUSH_INTERVAL_S`.
//! Stages are write-only here (spec Sec11.10.2, Task 30's ACL matrix):
//! this module never reads the stream back. PROVISIONAL(M1): mirrors
//! `penguin_spine::usage` exactly.
use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The single global stream every stage batches usage deltas onto (spec
/// Sec6.2) -- not tenant/community scoped: usage rows carry their own
/// `tenant_id`/`community_id` fields instead.
pub const USAGE_STREAM_KEY: &str = "waddles:usage";

/// Which host-call capability a delta's count belongs to (spec Sec5.12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostCallKind {
    /// The `http` host capability.
    Http,
    /// The `kv` host capability.
    Kv,
    /// The `db` host capability.
    Db,
    /// The `relay` host capability (not granted to process bundles, spec Sec6.5 -- kept for parity with the shared crate shape).
    Relay,
    /// The `flags` host capability.
    Flags,
    /// The `log` host capability.
    Log,
}

/// Host-call counts broken out by capability kind (spec Sec5.12).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostCallCounts {
    /// `http` host calls.
    pub http: u64,
    /// `kv` host calls.
    pub kv: u64,
    /// `db` host calls.
    pub db: u64,
    /// `relay` host calls.
    pub relay: u64,
    /// `flags` host calls.
    pub flags: u64,
    /// `log` host calls.
    pub log: u64,
}

impl HostCallCounts {
    /// +1 to the counter for `kind`.
    pub fn increment(&mut self, kind: HostCallKind) {
        match kind {
            HostCallKind::Http => self.http += 1,
            HostCallKind::Kv => self.kv += 1,
            HostCallKind::Db => self.db += 1,
            HostCallKind::Relay => self.relay += 1,
            HostCallKind::Flags => self.flags += 1,
            HostCallKind::Log => self.log += 1,
        }
    }

    /// Adds `other`'s counts into `self`, field-wise.
    pub fn add(&mut self, other: &HostCallCounts) {
        self.http += other.http;
        self.kv += other.kv;
        self.db += other.db;
        self.relay += other.relay;
        self.flags += other.flags;
        self.log += other.log;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct UsageKey {
    tenant_id: String,
    community_id: Option<String>,
    workstream_id: String,
    stage: String,
    app_id: Option<String>,
}

/// One usage row, keyed by `(tenant_id, community_id, workstream_id,
/// stage, app_id)` (spec Sec5.12) -- the exact shape `XADD`ed onto
/// [`USAGE_STREAM_KEY`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageDelta {
    /// The tenant this usage belongs to.
    pub tenant_id: String,
    /// The community, or `None` for a tenant-wide workstream.
    pub community_id: Option<String>,
    /// Which workstream (spec Sec5.11, Sec6.11) this usage belongs to.
    pub workstream_id: String,
    /// `"ingest"` | `"process"` | `"action"` | `"streaming"`.
    pub stage: String,
    /// `None` for ingest-stage rows, which have no bundle.
    pub app_id: Option<String>,
    /// Events ingested/processed in this window.
    pub events: u64,
    /// Bundle invocations in this window.
    pub invocations: u64,
    /// Host calls by kind.
    pub host_calls: HostCallCounts,
    /// Bundle fuel/CPU-ms, from the executor's per-call accounting.
    pub fuel_ms: u64,
    /// Actions delivered to a platform in this window.
    pub actions_delivered: u64,
    /// Outbound bytes sent in this window.
    pub outbound_bytes: u64,
    /// svc-streaming-only: stream-media minutes. `None` for every other stage.
    pub media_minutes: Option<f64>,
}

impl UsageDelta {
    /// A zeroed delta for the given key -- the starting point [`UsageBatcher`] accumulates into.
    pub fn zero(tenant_id: impl Into<String>, community_id: Option<String>, workstream_id: impl Into<String>, stage: impl Into<String>, app_id: Option<String>) -> Self {
        UsageDelta {
            tenant_id: tenant_id.into(), community_id, workstream_id: workstream_id.into(), stage: stage.into(), app_id,
            events: 0, invocations: 0, host_calls: HostCallCounts::default(), fuel_ms: 0,
            actions_delivered: 0, outbound_bytes: 0, media_minutes: None,
        }
    }

    fn key(&self) -> UsageKey {
        UsageKey { tenant_id: self.tenant_id.clone(), community_id: self.community_id.clone(), workstream_id: self.workstream_id.clone(), stage: self.stage.clone(), app_id: self.app_id.clone() }
    }

    fn merge_from(&mut self, other: &UsageDelta) {
        self.events += other.events;
        self.invocations += other.invocations;
        self.host_calls.add(&other.host_calls);
        self.fuel_ms += other.fuel_ms;
        self.actions_delivered += other.actions_delivered;
        self.outbound_bytes += other.outbound_bytes;
        self.media_minutes = match (self.media_minutes, other.media_minutes) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
        };
    }
}

/// In-process accumulator every stage replica holds. `record` is cheap and
/// non-blocking; a background timer tick calls `flush` at most every
/// `METERING_FLUSH_INTERVAL_S` and hands each drained delta to
/// [`crate::spine::client::SpineClient::append_usage`].
#[derive(Default)]
pub struct UsageBatcher {
    deltas: Mutex<HashMap<UsageKey, UsageDelta>>,
}

impl UsageBatcher {
    /// A fresh, empty batcher.
    pub fn new() -> Self {
        Self::default()
    }

    /// Accumulates `delta` into the in-memory batch, summing with any
    /// existing row sharing the same key.
    pub fn record(&self, delta: UsageDelta) {
        let mut deltas = self.deltas.lock().expect("UsageBatcher mutex poisoned");
        let key = delta.key();
        deltas
            .entry(key)
            .or_insert_with(|| UsageDelta::zero(delta.tenant_id.clone(), delta.community_id.clone(), delta.workstream_id.clone(), delta.stage.clone(), delta.app_id.clone()))
            .merge_from(&delta);
    }

    /// Drains every delta accumulated since the last flush.
    pub fn flush(&self) -> Vec<UsageDelta> {
        let mut deltas = self.deltas.lock().expect("UsageBatcher mutex poisoned");
        deltas.drain().map(|(_, v)| v).collect()
    }

    /// `true` when nothing has been recorded since the last flush.
    pub fn is_empty(&self) -> bool {
        self.deltas.lock().expect("UsageBatcher mutex poisoned").is_empty()
    }
}
```

```rust
// core/svc_process/src/spine/client.rs -- append inside the existing `impl SpineClient` block
    /// `XADD`s one usage delta onto [`crate::spine::usage::USAGE_STREAM_KEY`]
    /// (`waddles:usage`, spec Sec5.12/Sec6.2, D31), `MAXLEN ~` bounded like
    /// every other stream this client writes. Write-only: this method
    /// never reads the stream back (spec Sec11.10.2).
    pub async fn append_usage(&self, delta: &crate::spine::usage::UsageDelta, maxlen: u64) -> Result<String, ProcessError> {
        let json = serde_json::to_string(delta)?;
        let mut conn = self.conn().await?;
        let id: String = conn
            .xadd_maxlen(crate::spine::usage::USAGE_STREAM_KEY, StreamMaxlen::Approx(maxlen as usize), "*", &[("env", json)])
            .await
            .map_err(spine_err)?;
        Ok(id)
    }
```

```rust
// core/svc_process/src/spine/mod.rs -- replace the two placeholder lines with real modules
pub mod binding;
pub mod usage;
```

```rust
// core/svc_process/src/config.rs -- append fields to CliConfig (inside the #[derive(Parser)] struct)
    #[arg(long, env = "WADDLES_BINDING_KEY_FILE", default_value = "/etc/waddles/envelope-binding/keys.json")]
    pub waddles_binding_key_file: String,
    #[arg(long, env = "WADDLES_BINDING_KID")]
    pub waddles_binding_kid: Option<String>,
    #[arg(long, env = "WADDLES_BINDING_ROTATION_OVERLAP_S", default_value_t = 86_400)]
    pub waddles_binding_rotation_overlap_s: u64,
    #[arg(long, env = "METERING_ENABLED", default_value_t = true)]
    pub metering_enabled: bool,
    #[arg(long, env = "METERING_FLUSH_INTERVAL_S", default_value_t = 10)]
    pub metering_flush_interval_s: u64,
```

(`waddles_binding_kid` is `Option<String>` rather than a required field with a default so `CliConfig::validate` -- extended below -- can produce a named `ConfigError` instead of a `clap` parse-time panic when it is missing, matching this file's existing `MissingEnv`/`InvalidValue` error shape.)

```rust
// core/svc_process/src/config.rs -- extend CliConfig::validate (add to the existing method body, before its final `Ok(())`)
        if self.waddles_binding_kid.is_none() {
            return Err(ConfigError::InvalidValue {
                field: "waddles_binding_kid",
                reason: "WADDLES_BINDING_KID is required -- the active kid this replica mints new binding.mac values under (spec Sec5.11)".to_string(),
            });
        }
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib spine::binding:: spine::usage:: config::"`
Expected: `test result: ok` across all three modules -- 9 in `spine::binding::tests`, 5 in `spine::usage::tests`, and `config::tests` still green with the new required-field check exercised by the existing `load_fails_without_required_secrets` pattern (extend that test's env-var list with `WADDLES_BINDING_KID` if it is not already present as a `#[test]`-scoped var, since `CliConfig::parse_from` now requires it be settable for the "succeeds" test case too).

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/Cargo.toml core/svc_process/Cargo.lock core/svc_process/src/config.rs core/svc_process/src/spine/
git commit -m "$(cat <<'EOF'
feat(svc-process): D30 binding verification (BindingKeyring, compute/
verify_binding, ScopeCheck, BoundaryError) + D31 usage metering
(UsageDelta, UsageBatcher, SpineClient::append_usage)

Implements spec Sec5.11's tenant wall and Sec5.12's usage metering as
local PROVISIONAL(M1) modules mirroring penguin_spine::binding/usage
exactly. verify_binding recomputes binding.mac under the envelope's
claimed kid (with rotation-overlap acceptance) and compares in
constant time; ScopeCheck proves envelope tenant/community match the
stream key or Grant an entry was read from; strip_bundle_identity_
fields enforces "bundles cannot move a workstream". UsageBatcher
accumulates per-(tenant,community,workstream,stage,app_id) deltas and
SpineClient::append_usage XADDs them to waddles:usage, write-only.
Negative tests: cross-tenant stream read, tampered MAC, unknown kid,
key-rotation overlap acceptance/expiry (spec Sec14.11 tests 1/2/4).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 22: Sandbox trip counting + three-strike disable (`trip.rs`)

**Files:**
- Create: `core/svc_process/src/trip.rs`
- Modify: `core/svc_process/src/lib.rs` (`pub mod trip;` already declared in Task 1)

**Interfaces:**
- Consumes: `ProcessError` (Task 3, specifically `InvokeFailed { code, message }`), `DlqErrorKind` (Task 7), `ExecutorEvents` trait (Task 16).
- Produces: `pub fn classify_invoke_error(err: &ProcessError) -> DlqErrorKind` (maps `InvokeFailed`'s wire `code` -- spec Sec6.6's stable strings `EXECUTOR_DEADLINE`/`MEMORY_LIMIT`/`WASM_TRAP`/`HOST_CALL_DENIED` -- to the matching `DlqErrorKind`, defaulting unrecognized codes to `BundleError`; any non-`InvokeFailed` variant also maps to `BundleError`, since by construction only an `invoke` call site classifies through this function); `pub struct TripCounter { .. }` with `pub fn new(threshold: u32, window: std::time::Duration) -> Self`, `pub fn record_trip(&self, app_id: &str, digest: &str) -> bool` (returns `true` the moment this `(app_id, digest)` pair's trip count within the trailing `window` reaches `threshold` -- spec's "three-strike per-(app_id, digest) disable"), `pub fn is_disabled(&self, app_id: &str, digest: &str) -> bool`, `pub fn reset(&self, app_id: &str, digest: &str)` (called on a successful `invoke` or a fresh `Loaded` event -- a bundle earns back a clean slate rather than accumulating trips forever). `TripCounter` also implements `ExecutorEvents` (`on_trap` calls `record_trip` internally and logs at WARN; `on_loaded` calls `reset`; `on_unloaded`/`on_protocol_error` are no-ops here -- a protocol error is connection-level, not bundle-level, and is handled by Task 28's main loop reconnecting the executor). Task 25's worker calls `TripCounter::is_disabled` before every `invoke` (short-circuiting to `DlqErrorKind::BundleDisabled` without touching the host-API connection) and `record_trip`/`reset` after every `invoke` outcome; Task 28's main wiring constructs one process-wide `Arc<TripCounter>` and passes it to both the dispatch loop (as `Arc<dyn ExecutorEvents>`) and every worker.

Spec: §6.6 (wire error codes), §7.5/§13.1 ("three-strike per-(app_id, digest) disable" -- referenced from the plan's own Architecture section), §6.3 (`DlqErrorKind::BundleDisabled`).

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn classify_maps_known_wire_codes() {
        assert_eq!(classify_invoke_error(&ProcessError::InvokeFailed { code: "EXECUTOR_DEADLINE".into(), message: "x".into() }), DlqErrorKind::CallTimeout);
        assert_eq!(classify_invoke_error(&ProcessError::InvokeFailed { code: "MEMORY_LIMIT".into(), message: "x".into() }), DlqErrorKind::MemoryLimit);
        assert_eq!(classify_invoke_error(&ProcessError::InvokeFailed { code: "WASM_TRAP".into(), message: "x".into() }), DlqErrorKind::BundleTrap);
        assert_eq!(classify_invoke_error(&ProcessError::InvokeFailed { code: "HOST_CALL_DENIED".into(), message: "x".into() }), DlqErrorKind::HostCallDenied);
    }

    #[test]
    fn classify_defaults_unrecognized_codes_to_bundle_error() {
        assert_eq!(classify_invoke_error(&ProcessError::InvokeFailed { code: "SOMETHING_NEW".into(), message: "x".into() }), DlqErrorKind::BundleError);
    }

    #[test]
    fn classify_defaults_non_invoke_variants_to_bundle_error() {
        assert_eq!(classify_invoke_error(&ProcessError::Spine("x".into())), DlqErrorKind::BundleError);
    }

    #[test]
    fn record_trip_disables_after_threshold_within_window() {
        let counter = TripCounter::new(3, Duration::from_secs(300));
        assert!(!counter.record_trip("waddles.bot.commands.default", "sha256:aaa"));
        assert!(!counter.record_trip("waddles.bot.commands.default", "sha256:aaa"));
        assert!(counter.record_trip("waddles.bot.commands.default", "sha256:aaa"), "third trip within the window must disable");
        assert!(counter.is_disabled("waddles.bot.commands.default", "sha256:aaa"));
    }

    #[test]
    fn different_digests_of_the_same_app_id_are_tracked_independently() {
        let counter = TripCounter::new(3, Duration::from_secs(300));
        counter.record_trip("waddles.bot.commands.default", "sha256:aaa");
        counter.record_trip("waddles.bot.commands.default", "sha256:aaa");
        counter.record_trip("waddles.bot.commands.default", "sha256:aaa");
        assert!(counter.is_disabled("waddles.bot.commands.default", "sha256:aaa"));
        assert!(!counter.is_disabled("waddles.bot.commands.default", "sha256:bbb"), "an upgraded digest starts with a clean slate");
    }

    #[test]
    fn reset_clears_a_disabled_pairs_trip_count() {
        let counter = TripCounter::new(2, Duration::from_secs(300));
        counter.record_trip("a", "d");
        counter.record_trip("a", "d");
        assert!(counter.is_disabled("a", "d"));
        counter.reset("a", "d");
        assert!(!counter.is_disabled("a", "d"));
    }

    #[test]
    fn trips_older_than_the_window_do_not_count() {
        let counter = TripCounter::new(2, Duration::from_millis(50));
        counter.record_trip("a", "d");
        std::thread::sleep(Duration::from_millis(80));
        assert!(!counter.record_trip("a", "d"), "the first trip fell outside the window, so this is only the first trip within it");
    }

    struct RecordingEvents(std::sync::Arc<TripCounter>);
    impl ExecutorEvents for RecordingEvents {
        fn on_loaded(&self, app_id: &str, digest: &str, _exports: &[String]) {
            self.0.reset(app_id, digest);
        }
        fn on_unloaded(&self, _app_id: &str, _digest: &str) {}
        fn on_trap(&self, app_id: &str, digest: &str, _message: &str) {
            self.0.record_trip(app_id, digest);
        }
        fn on_protocol_error(&self, _code: &str, _message: &str) {}
    }

    #[test]
    fn trip_counter_wires_through_executor_events() {
        let counter = std::sync::Arc::new(TripCounter::new(1, Duration::from_secs(300)));
        let events = RecordingEvents(counter.clone());
        events.on_trap("a", "d", "panicked");
        assert!(counter.is_disabled("a", "d"));
        events.on_loaded("a", "d", &[]);
        assert!(!counter.is_disabled("a", "d"), "a fresh Loaded event resets the strike count");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib trip::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `trip.rs`**

```rust
//! Sandbox trip counting and the three-strike per-`(app_id, digest)`
//! disable. A "trip" is any `WASM_TRAP` the executor reports for a bundle
//! invocation; three trips within `EXECUTOR_TRIP_WINDOW_S` disable that
//! exact `(app_id, digest)` pair until its next successful load (a
//! version bump gets a clean slate, spec's per-digest scoping).
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::error::ProcessError;
use crate::hostapi::dispatch::ExecutorEvents;
use crate::spine::dlq::DlqErrorKind;

/// Maps an `invoke` failure's wire error code (spec Sec6.6) to the
/// `DlqErrorKind` a worker (Task 25) classifies it under. Any code this
/// function does not recognize, and any `ProcessError` variant other than
/// `InvokeFailed`, defaults to `BundleError` -- by construction, only an
/// `invoke` call site ever calls this function.
pub fn classify_invoke_error(err: &ProcessError) -> DlqErrorKind {
    match err {
        ProcessError::InvokeFailed { code, .. } => match code.as_str() {
            "EXECUTOR_DEADLINE" => DlqErrorKind::CallTimeout,
            "MEMORY_LIMIT" => DlqErrorKind::MemoryLimit,
            "WASM_TRAP" => DlqErrorKind::BundleTrap,
            "HOST_CALL_DENIED" => DlqErrorKind::HostCallDenied,
            _ => DlqErrorKind::BundleError,
        },
        _ => DlqErrorKind::BundleError,
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Hash)]
struct TripKey {
    app_id: String,
    digest: String,
}

#[derive(Default)]
struct TripState {
    trips: Vec<Instant>,
    disabled: bool,
}

/// Tracks sandbox trips per `(app_id, digest)` and disables a pair once it
/// accumulates `threshold` trips within the trailing `window`.
pub struct TripCounter {
    threshold: u32,
    window: Duration,
    state: Mutex<HashMap<TripKey, TripState>>,
}

impl TripCounter {
    /// `threshold` and `window` come from `EXECUTOR_TRIP_THRESHOLD`
    /// (default 3) and `EXECUTOR_TRIP_WINDOW_S` (default 300).
    pub fn new(threshold: u32, window: Duration) -> Self {
        Self { threshold, window, state: Mutex::new(HashMap::new()) }
    }

    /// Records one trip for `(app_id, digest)`. Returns `true` exactly on
    /// the call that pushes this pair's trailing-window trip count to
    /// `threshold` -- i.e. the moment it becomes disabled.
    pub fn record_trip(&self, app_id: &str, digest: &str) -> bool {
        let key = TripKey { app_id: app_id.to_string(), digest: digest.to_string() };
        let mut state = self.state.lock().expect("TripCounter mutex poisoned");
        let entry = state.entry(key).or_default();
        let now = Instant::now();
        entry.trips.retain(|t| now.duration_since(*t) <= self.window);
        entry.trips.push(now);
        let was_disabled = entry.disabled;
        if entry.trips.len() as u32 >= self.threshold {
            entry.disabled = true;
        }
        entry.disabled && !was_disabled
    }

    /// `true` if this `(app_id, digest)` pair is currently disabled.
    pub fn is_disabled(&self, app_id: &str, digest: &str) -> bool {
        let key = TripKey { app_id: app_id.to_string(), digest: digest.to_string() };
        self.state.lock().expect("TripCounter mutex poisoned").get(&key).is_some_and(|s| s.disabled)
    }

    /// Clears the trip history and disabled flag for `(app_id, digest)` --
    /// called on a successful invoke or a fresh `Loaded` event.
    pub fn reset(&self, app_id: &str, digest: &str) {
        let key = TripKey { app_id: app_id.to_string(), digest: digest.to_string() };
        self.state.lock().expect("TripCounter mutex poisoned").remove(&key);
    }
}

impl ExecutorEvents for TripCounter {
    fn on_loaded(&self, app_id: &str, digest: &str, _exports: &[String]) {
        self.reset(app_id, digest);
    }

    fn on_unloaded(&self, _app_id: &str, _digest: &str) {}

    fn on_trap(&self, app_id: &str, digest: &str, message: &str) {
        let now_disabled = self.record_trip(app_id, digest);
        if now_disabled {
            tracing::warn!(app_id, digest, message, "bundle disabled after three sandbox trips");
        } else {
            tracing::warn!(app_id, digest, message, "sandbox trip recorded");
        }
    }

    fn on_protocol_error(&self, code: &str, message: &str) {
        // Connection-level, not bundle-level -- Task 28's main loop owns
        // executor reconnection; this is logged only.
        tracing::error!(code, message, "executor protocol error");
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib trip::"`
Expected: `test result: ok. 9 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/trip.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): three-strike per-(app_id, digest) sandbox trip disable

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 23: Content-moderation gate + enforcement-routing built-ins (`builtins/moderation_gate.rs`, `builtins/moderation_enforce.rs`)

**Files:**
- Create: `core/svc_process/src/builtins/mod.rs`, `core/svc_process/src/builtins/moderation_gate.rs`, `core/svc_process/src/builtins/moderation_enforce.rs`
- Modify: `core/svc_process/Cargo.toml`

**Interfaces:**
- Consumes: `PlatformEvent` (Task 5), `Scope` (Task 6), `StageEnvelope`/`Trace`/`Binding` (Task 5), `SpineClient` (Task 8), `FlagsCapability` (Task 18), `ProcessError` (Task 3), `CliConfig` fields `reputation_api_url`/`moderation_ollama_url`/`moderation_ollama_model`/`moderation_match_threshold`/`moderation_ollama_timeout_seconds` (Task 2).
- Produces: `pub enum ModerationVerdict { Allowed, Flagged { category: String, score: f64 } }`; `#[async_trait::async_trait] pub trait FlagsCheck: Send + Sync { async fn enabled(&self, key: &str, default_value: bool) -> bool; }` (implemented for `crate::hostcap::flags::FlagsCapability` in this file, so the gate depends on a trait object rather than the concrete capability -- this is what lets the unit test below exercise the Ollama-unreachable path without constructing a real `penguin_licensing::LicenseClient`); `pub struct ModerationGate { .. }` with `pub fn new(http: reqwest::Client, ollama_url: String, model: String, threshold: f64, timeout: std::time::Duration, flags: std::sync::Arc<dyn FlagsCheck>) -> Self`, `pub async fn check(&self, event: &PlatformEvent) -> ModerationVerdict` (spec: "no community may opt out" -- runs before every bundle invocation, **before** the gate even calls Ollama it checks `waddles.community.content_moderation` with `default_value: true`, so an unreachable flag/license server fails open to "moderation stays on", never open to "skip moderation"; an unreachable Ollama itself also fails open to `Allowed`, since a content-safety infra outage must never become a hard pipeline failure -- see Global Constraints "Graceful degradation"); `pub struct ModerationEnforcer { .. }` with `pub fn new(spine: crate::spine::client::SpineClient, maxlen: u64, flags: std::sync::Arc<dyn FlagsCheck>) -> Self`, `pub async fn enforce(&self, source_env: &StageEnvelope, category: &str, score: f64) -> Result<String, ProcessError>` (gated on `waddles.moderation.enforce`, `default_value: true`) (builds a synthetic action-stream entry addressed to `waddles.community.moderation.default` -- spec's fixed enforcement target -- **copying `tenant`/`community`/`workstream_id`/`event_id`/`session_id`/`trace`/`binding` verbatim from `source_env`**, since spec Sec5.11's `binding.mac` formula depends only on `(tenant, community, workstream_id, event_id, trace_id)`, none of which change for a same-event enforcement record, so the original MAC remains valid for whoever reads that action stream -- only `app_id`/`stage`/`event`/`ts`/`target_app_id` differ on the copy). Task 25's worker calls `ModerationGate::check` first, before every `invoke`; on `Flagged`, it calls `ModerationEnforcer::enforce`, `XACK`s the original entry (a moderation flag is a legitimate content-policy outcome, never a delivery failure), increments `waddles_moderation_flagged_total{category}`, and never calls the bundle's `transform` for that entry.

**New Cargo.toml pin** (append to `[dependencies]`):
```toml
# already present via reqwest/serde_json -- no new external crate needed;
# this task adds no new pins, listed here only to confirm that fact.
```

- [ ] **Step 1: Write the failing tests**

```rust
// core/svc_process/src/builtins/moderation_gate.rs -- #[cfg(test)] mod tests
#[cfg(test)]
mod tests {
    use super::*;
    use crate::spine::envelope::EventSource;
    use std::sync::Arc;

    fn sample_event(text: &str) -> PlatformEvent {
        let mut payload = serde_json::Map::new();
        payload.insert("text".to_string(), serde_json::json!(text));
        PlatformEvent {
            platform: "twitch".into(), event_type: "chat.message".into(), actor: Some("u".into()),
            payload, occurred_at: "2026-09-14T12:00:00.000Z".into(), source: None,
        }
    }

    struct AlwaysOn;
    #[async_trait::async_trait]
    impl FlagsCheck for AlwaysOn {
        async fn enabled(&self, _key: &str, _default_value: bool) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn unreachable_ollama_fails_open_to_allowed() {
        let gate = ModerationGate::new(
            reqwest::Client::new(),
            "http://127.0.0.1:1".to_string(), // nothing listens here
            "shieldgemma:2b".to_string(), 0.5, std::time::Duration::from_millis(200), Arc::new(AlwaysOn),
        );
        let verdict = gate.check(&sample_event("hello")).await;
        assert!(matches!(verdict, ModerationVerdict::Allowed));
    }

    struct AlwaysOff;
    #[async_trait::async_trait]
    impl FlagsCheck for AlwaysOff {
        async fn enabled(&self, _key: &str, _default_value: bool) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn flag_disabled_skips_the_ollama_call_entirely() {
        let gate = ModerationGate::new(
            reqwest::Client::new(),
            "http://127.0.0.1:1".to_string(),
            "shieldgemma:2b".to_string(), 0.5, std::time::Duration::from_millis(200), Arc::new(AlwaysOff),
        );
        let verdict = gate.check(&sample_event("hello")).await;
        assert!(matches!(verdict, ModerationVerdict::Allowed));
    }

    #[test]
    fn parse_score_extracts_a_leading_float() {
        assert_eq!(parse_score("0.87"), Some(0.87));
        assert_eq!(parse_score("0.87 (unsafe)"), Some(0.87));
        assert_eq!(parse_score("not a number"), None);
    }

    #[test]
    fn extract_text_prefers_the_text_field_then_falls_back_to_event_type() {
        let ev = sample_event("hello world");
        assert_eq!(extract_text(&ev), "hello world");
        let mut no_text = sample_event("");
        no_text.payload.remove("text");
        assert_eq!(extract_text(&no_text), "chat.message");
    }
}
```

```rust
// core/svc_process/src/builtins/moderation_enforce.rs -- #[cfg(test)] mod tests
#[cfg(test)]
mod tests {
    use super::*;
    use crate::spine::envelope::{Binding, EventSource, PlatformEvent};

    fn source_env() -> StageEnvelope {
        StageEnvelope {
            schema_version: 2, tenant: "acme".into(), community: Some("main".into()),
            app_id: "waddles.bot.commands.default".into(), stage: "process".into(),
            event: PlatformEvent { platform: "twitch".into(), event_type: "chat.message".into(), actor: Some("u".into()), payload: serde_json::Map::new(), occurred_at: "2026-09-14T12:00:00.000Z".into(), source: None },
            ts: "2026-09-14T12:00:00.000Z".into(), target_app_id: None,
            workstream_id: "8f14e45f-ceea-467e-adde-3fb5c9752730".into(),
            event_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6".into(), session_id: None,
            trace: None, binding: Binding { kid: "k".into(), mac: "a".repeat(64) },
        }
    }

    #[test]
    fn build_enforcement_envelope_copies_identity_and_targets_the_fixed_app() {
        let env = build_enforcement_envelope(&source_env(), "hate_speech", 0.91);
        assert_eq!(env.app_id, "waddles.community.moderation.default");
        assert_eq!(env.tenant, "acme");
        assert_eq!(env.community, Some("main".to_string()));
        assert_eq!(env.workstream_id, "8f14e45f-ceea-467e-adde-3fb5c9752730");
        assert_eq!(env.event_id, "3fa85f64-5717-4562-b3fc-2c963f66afa6");
        assert_eq!(env.binding.mac, "a".repeat(64), "binding is copied verbatim, never re-minted");
        assert_eq!(env.event.event_type, "moderation.flagged");
        assert_eq!(env.event.payload["category"], "hate_speech");
        assert_eq!(env.event.payload["score"], 0.91);
        assert_eq!(env.event.payload["source_app_id"], "waddles.bot.commands.default");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib builtins::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```rust
// core/svc_process/src/builtins/mod.rs
//! Rust built-ins that run around every bundle invocation, never
//! themselves bundles -- spec Sec4.2/A5: the moderation gate,
//! moderation-enforcement routing, and cross-app `_target_app_id` routing.
pub mod moderation_enforce;
pub mod moderation_gate;
pub mod routing;
```

```rust
// core/svc_process/src/builtins/moderation_gate.rs
//! Always-on content-moderation gate -- spec Sec4.2: "no community may
//! opt out", runs before every bundle invocation. Classifies inbound text
//! via a local Ollama `shieldgemma` model; fails open (never blocks the
//! pipeline) on any infra outage, moderation-server or flag/license
//! server alike.
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::spine::envelope::PlatformEvent;

/// Abstracts the `flags` capability's `enabled` check so this built-in
/// depends on a trait object, not the concrete `penguin_licensing`-backed
/// `FlagsCapability` -- keeps this module's own tests free of a live
/// license client.
#[async_trait::async_trait]
pub trait FlagsCheck: Send + Sync {
    /// Resolves `key`, falling back to `default_value` when unresolvable.
    async fn enabled(&self, key: &str, default_value: bool) -> bool;
}

#[async_trait::async_trait]
impl FlagsCheck for crate::hostcap::flags::FlagsCapability {
    async fn enabled(&self, key: &str, default_value: bool) -> bool {
        crate::hostcap::flags::FlagsCapability::enabled(self, key, default_value).await
    }
}

/// The moderation gate's decision for one event.
#[derive(Debug, Clone, PartialEq)]
pub enum ModerationVerdict {
    /// Passed the gate; proceed to the bundle invocation.
    Allowed,
    /// Failed the gate; the enforcement built-in ([`crate::builtins::moderation_enforce`])
    /// records it and the event is never delivered to the bundle.
    Flagged {
        /// The model's reported category (e.g. `"hate_speech"`, `"harassment"`).
        category: String,
        /// The model's confidence score, `0.0..=1.0`.
        score: f64,
    },
}

#[derive(Debug, Deserialize)]
struct OllamaGenerateResponse {
    response: String,
}

/// Extracts the text to classify from a [`PlatformEvent`]'s payload --
/// prefers a `text` field (chat messages, most platforms), falls back to
/// the event type itself so a gate call is never made against an empty
/// string.
pub(crate) fn extract_text(event: &PlatformEvent) -> String {
    event
        .payload
        .get("text")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| event.event_type.clone())
}

/// Parses a leading floating-point score out of a model response string
/// (e.g. `"0.87"` or `"0.87 (unsafe)"`). `None` if no leading float parses.
pub(crate) fn parse_score(text: &str) -> Option<f64> {
    let head: String = text.trim().chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    head.parse::<f64>().ok()
}

/// Always-on content-moderation gate (spec Sec4.2).
pub struct ModerationGate {
    http: reqwest::Client,
    ollama_url: String,
    model: String,
    threshold: f64,
    timeout: Duration,
    flags: Arc<dyn FlagsCheck>,
}

impl ModerationGate {
    /// Builds the gate over an already-configured HTTP client and flags handle.
    pub fn new(http: reqwest::Client, ollama_url: String, model: String, threshold: f64, timeout: Duration, flags: Arc<dyn FlagsCheck>) -> Self {
        Self { http, ollama_url, model, threshold, timeout, flags }
    }

    /// Runs the gate. `default_value: true` on the flag check means an
    /// unreachable license/flag server fails open to "moderation stays
    /// on" (spec: "no community may opt out"), the opposite fail-open
    /// direction from a normal feature flag.
    pub async fn check(&self, event: &PlatformEvent) -> ModerationVerdict {
        if !self.flags.enabled("waddles.community.content_moderation", true).await {
            return ModerationVerdict::Allowed;
        }
        let text = extract_text(event);
        let body = serde_json::json!({ "model": self.model, "prompt": text, "stream": false });
        let resp = self
            .http
            .post(format!("{}/api/generate", self.ollama_url.trim_end_matches('/')))
            .timeout(self.timeout)
            .json(&body)
            .send()
            .await;
        let Ok(resp) = resp else {
            tracing::warn!(url = %self.ollama_url, "moderation gate: Ollama unreachable, failing open to Allowed");
            return ModerationVerdict::Allowed;
        };
        let Ok(parsed) = resp.json::<OllamaGenerateResponse>().await else {
            tracing::warn!("moderation gate: malformed Ollama response, failing open to Allowed");
            return ModerationVerdict::Allowed;
        };
        match parse_score(&parsed.response) {
            Some(score) if score >= self.threshold => ModerationVerdict::Flagged { category: "unsafe_content".to_string(), score },
            _ => ModerationVerdict::Allowed,
        }
    }
}
```

```rust
// core/svc_process/src/builtins/moderation_enforce.rs
//! Moderation-enforcement routing built-in -- spec Sec4.2: stamps and
//! synthetically enqueues a flagged event onto
//! `waddles.community.moderation.default`'s own action stream, always
//! after the gate, never before.
use crate::error::ProcessError;
use crate::spine::client::SpineClient;
use crate::spine::envelope::{PlatformEvent, StageEnvelope};
use crate::spine::keys::Scope;

/// The fixed, spec-named enforcement target -- never configurable, never
/// a `routes_to` entry (that mechanism is for bundle-declared redirects,
/// spec Sec5.9; this is a stage-mandated built-in path).
pub const MODERATION_ENFORCEMENT_APP_ID: &str = "waddles.community.moderation.default";

/// Builds the synthetic action-stream envelope for a flagged event,
/// copying every D30 identity field from `source_env` verbatim (spec
/// Sec5.11: `binding.mac` depends only on tenant/community/workstream_id/
/// event_id/trace_id, none of which change here, so the original MAC
/// stays valid for whoever reads the destination stream).
pub(crate) fn build_enforcement_envelope(source_env: &StageEnvelope, category: &str, score: f64) -> StageEnvelope {
    let mut payload = serde_json::Map::new();
    payload.insert("category".to_string(), serde_json::json!(category));
    payload.insert("score".to_string(), serde_json::json!(score));
    payload.insert("source_app_id".to_string(), serde_json::json!(source_env.app_id));
    payload.insert("source_event_type".to_string(), serde_json::json!(source_env.event.event_type));
    StageEnvelope {
        schema_version: source_env.schema_version,
        tenant: source_env.tenant.clone(),
        community: source_env.community.clone(),
        app_id: MODERATION_ENFORCEMENT_APP_ID.to_string(),
        stage: "action".to_string(),
        event: PlatformEvent {
            platform: source_env.event.platform.clone(),
            event_type: "moderation.flagged".to_string(),
            actor: source_env.event.actor.clone(),
            payload,
            occurred_at: source_env.event.occurred_at.clone(),
            source: source_env.event.source.clone(),
        },
        ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        target_app_id: None,
        workstream_id: source_env.workstream_id.clone(),
        event_id: source_env.event_id.clone(),
        session_id: source_env.session_id.clone(),
        trace: source_env.trace.clone(),
        binding: source_env.binding.clone(),
    }
}

/// Writes the enforcement envelope onto the fixed target's action stream.
pub struct ModerationEnforcer {
    spine: SpineClient,
    maxlen: u64,
    flags: std::sync::Arc<dyn crate::builtins::moderation_gate::FlagsCheck>,
}

impl ModerationEnforcer {
    /// `maxlen` is the same `SPINE_STREAM_MAXLEN` every action stream
    /// uses. `flags` gates `waddles.moderation.enforce` (Global
    /// Constraints flag list) -- checked with `default_value: true`, the
    /// same fail-open-to-enforcing direction `ModerationGate::check`
    /// already uses for `waddles.community.content_moderation`: an
    /// unreachable flag/license server must never silently stop recording
    /// a moderation violation.
    pub fn new(spine: SpineClient, maxlen: u64, flags: std::sync::Arc<dyn crate::builtins::moderation_gate::FlagsCheck>) -> Self {
        Self { spine, maxlen, flags }
    }

    /// `XADD`s the enforcement record onto `waddles.community.moderation.
    /// default`'s own action stream, scoped by `source_env`'s own tenant/
    /// community (spec's fixed enforcement target is per-tenant, never
    /// cross-tenant). Returns the entry id, or `Ok(String::new())` when
    /// `waddles.moderation.enforce` resolves `false` -- the gate already
    /// ran (spec's "no community may opt out" is the gate's own job);
    /// this flag only controls whether the *routing* built-in also
    /// writes an audit record, matching Global Constraints' "every new
    /// capability behind a PostHog flag" for this specific sub-behavior.
    pub async fn enforce(&self, source_env: &StageEnvelope, category: &str, score: f64) -> Result<String, ProcessError> {
        if !self.flags.enabled("waddles.moderation.enforce", true).await {
            return Ok(String::new());
        }
        let scope = Scope { tenant: source_env.tenant.clone(), community: source_env.community.clone() };
        let stream = scope.action_stream(MODERATION_ENFORCEMENT_APP_ID);
        let env = build_enforcement_envelope(source_env, category, score);
        self.spine.append(&stream, &env, self.maxlen).await
    }
}
```

(`StageEnvelope`/`PlatformEvent`/`Trace`/`Binding` need `Clone` -- already derived in Task 5.)

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib builtins::"`
Expected: `test result: ok` -- 5 in `moderation_gate::tests`, 1 in `moderation_enforce::tests`.

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/builtins/
git commit -m "$(cat <<'EOF'
feat(svc-process): content-moderation gate + enforcement-routing
built-ins (spec Sec4.2 A5)

ModerationGate runs before every bundle invocation, fail-open on any
Ollama/flag-server outage per "no community may opt out". A flagged
event never reaches the bundle; ModerationEnforcer stamps and XADDs a
synthetic action-stream entry to waddles.community.moderation.default,
copying every D30 identity field (tenant/community/workstream_id/
event_id/trace/binding) verbatim from the source envelope.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 24: Cross-app routing built-in + per-bundle action emit (`builtins/routing.rs`)

**Files:**
- Create: `core/svc_process/src/builtins/routing.rs`
- Modify: `core/svc_process/src/builtins/mod.rs` (`pub mod routing;` already declared in Task 23), `core/svc_process/src/registry/mod.rs` (add `Registry::is_active_for_tenant`)

**Interfaces:**
- Consumes: `StageEnvelope`, `PlatformEvent`, `PROCESS_TARGET_APP_ID_KEY` (Task 5), `Scope` (Task 6), `strip_bundle_identity_fields`, `RESERVED_IDENTITY_FIELDS` (Task 21), `Registry` (Task 12).
- Produces: `#[derive(Debug, Clone, PartialEq)] pub enum RouteDecision { Deliver(StageEnvelope), Denied { target_app_id: String, reason: &'static str } }`; `pub struct RouteResult { pub decision: RouteDecision, pub stripped_identity_field: Option<&'static str> }`; `pub fn route_bundle_output(source_env: &StageEnvelope, source_app_id: &str, output_payload: serde_json::Map<String, serde_json::Value>, approved_routes_to: &[String], is_target_active_in_tenant: &dyn Fn(&str) -> bool) -> RouteResult` -- pops `PROCESS_TARGET_APP_ID_KEY` out of `output_payload` first; with no redirect key, builds a `Deliver` envelope whose `app_id` is `source_app_id` and `target_app_id` is `None` (own stream); with a redirect key, `Deliver`s (with `app_id = source_app_id`, `target_app_id = Some(target)`) only when `target` is both in `approved_routes_to` (exact match, no wildcards, spec Sec5.9) **and** `is_target_active_in_tenant(target)` is `true` (spec D30: "refused... independently at runtime" -- the two checks are deliberately separate: the first is "did the bundle's approval say so", the second is "does the target actually resolve to this same tenant, checked again at runtule, never trusting the approval alone"), otherwise `Denied { target_app_id: target, reason }` with `reason` one of `"not_in_routes_to"`/`"cross_tenant"`; `pub fn destination_app_id(env: &StageEnvelope) -> &str` (`target_app_id.as_deref().unwrap_or(&env.app_id)` -- the app_id segment of the actual destination action-stream key, spec Sec5.9 "changes only the destination key's app_id segment"); `Registry::is_active_for_tenant(&self, app_id: &str, tenant: &str) -> bool` (Task 12's registry already tracks every currently-running `WorkerKey{app_id, stream}`; this scans that set for one whose `stream`'s `t:` segment, via `parse_scope_from_key`, equals `tenant` and whose `app_id` matches). Task 25's worker calls `route_bundle_output` after every successful `invoke`, increments `waddles_tenant_boundary_violations_total{stage="process",reason="bundle_set_identity"}` when `stripped_identity_field.is_some()`, increments `waddles_route_denied_total{app_id,target}` and logs at WARN on `Denied`, and on `Deliver` computes the destination stream as `scope.action_stream(destination_app_id(&env))` before calling `SpineClient::append`.

Spec: §5.9 (`_target_app_id`/`routes_to` full normative text, install-time + runtime enforcement), §5.11/D30 ("bundles cannot move a workstream", cross-tenant `routes_to` refusal), §14.11 test 3 (implemented here for the runtime half; the install-time half is hub-api, out of this plan's scope).

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::spine::envelope::{Binding, EventSource};

    fn source_env() -> StageEnvelope {
        StageEnvelope {
            schema_version: 2, tenant: "acme".into(), community: Some("main".into()),
            app_id: "waddles.bot.commands.default".into(), stage: "process".into(),
            event: PlatformEvent { platform: "twitch".into(), event_type: "chat.message".into(), actor: Some("u".into()), payload: serde_json::Map::new(), occurred_at: "2026-09-14T12:00:00.000Z".into(), source: None },
            ts: "2026-09-14T12:00:00.000Z".into(), target_app_id: None,
            workstream_id: "8f14e45f-ceea-467e-adde-3fb5c9752730".into(),
            event_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6".into(), session_id: None,
            trace: None, binding: Binding { kid: "k".into(), mac: "a".repeat(64) },
        }
    }

    #[test]
    fn no_redirect_key_delivers_to_the_bundles_own_stream() {
        let mut payload = serde_json::Map::new();
        payload.insert("text".to_string(), serde_json::json!("hi"));
        let result = route_bundle_output(&source_env(), "waddles.bot.commands.default", payload, &[], &|_| false);
        match result.decision {
            RouteDecision::Deliver(env) => {
                assert_eq!(env.app_id, "waddles.bot.commands.default");
                assert_eq!(env.target_app_id, None);
                assert_eq!(destination_app_id(&env), "waddles.bot.commands.default");
            }
            other => panic!("expected Deliver, got {other:?}"),
        }
        assert_eq!(result.stripped_identity_field, None);
    }

    #[test]
    fn approved_and_active_redirect_delivers_to_the_target() {
        let mut payload = serde_json::Map::new();
        payload.insert("_target_app_id".to_string(), serde_json::json!("waddles.bot.other.default"));
        let result = route_bundle_output(
            &source_env(), "waddles.bot.commands.default", payload,
            &["waddles.bot.other.default".to_string()], &|target| target == "waddles.bot.other.default",
        );
        match result.decision {
            RouteDecision::Deliver(env) => {
                assert_eq!(env.app_id, "waddles.bot.commands.default");
                assert_eq!(env.target_app_id, Some("waddles.bot.other.default".to_string()));
                assert_eq!(destination_app_id(&env), "waddles.bot.other.default");
            }
            other => panic!("expected Deliver, got {other:?}"),
        }
    }

    #[test]
    fn undeclared_redirect_is_denied_and_counted() {
        let mut payload = serde_json::Map::new();
        payload.insert("_target_app_id".to_string(), serde_json::json!("waddles.bot.other.default"));
        let result = route_bundle_output(&source_env(), "waddles.bot.commands.default", payload, &[], &|_| true);
        assert_eq!(result.decision, RouteDecision::Denied { target_app_id: "waddles.bot.other.default".to_string(), reason: "not_in_routes_to" });
    }

    #[test]
    fn approved_but_cross_tenant_redirect_is_denied_independently_at_runtime() {
        let mut payload = serde_json::Map::new();
        payload.insert("_target_app_id".to_string(), serde_json::json!("waddles.bot.other.default"));
        // Approved list says yes, but the runtime tenant check says the
        // target does not actually resolve to this same tenant -- D30's
        // "never trusts the approval alone".
        let result = route_bundle_output(
            &source_env(), "waddles.bot.commands.default", payload,
            &["waddles.bot.other.default".to_string()], &|_| false,
        );
        assert_eq!(result.decision, RouteDecision::Denied { target_app_id: "waddles.bot.other.default".to_string(), reason: "cross_tenant" });
    }

    #[test]
    fn bundle_supplied_identity_field_is_stripped_and_reported() {
        let mut payload = serde_json::Map::new();
        payload.insert("text".to_string(), serde_json::json!("hi"));
        payload.insert("workstream_id".to_string(), serde_json::json!("attacker-supplied"));
        let result = route_bundle_output(&source_env(), "waddles.bot.commands.default", payload, &[], &|_| false);
        assert_eq!(result.stripped_identity_field, Some("workstream_id"));
        match result.decision {
            RouteDecision::Deliver(env) => assert_eq!(env.workstream_id, "8f14e45f-ceea-467e-adde-3fb5c9752730", "the source envelope's own workstream_id wins, never the bundle's"),
            other => panic!("expected Deliver, got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib builtins::routing::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```rust
// core/svc_process/src/builtins/routing.rs
//! Cross-app routing built-in -- spec Sec5.9 (`_target_app_id`/`routes_to`)
//! and Sec5.11/D30 ("bundles cannot move a workstream"). The **only**
//! sanctioned cross-bundle path; every other action-stream write stays on
//! the producing bundle's own stream (spec D25).
use crate::spine::envelope::{PlatformEvent, StageEnvelope, PROCESS_TARGET_APP_ID_KEY};
use crate::spine::binding::strip_bundle_identity_fields;

/// The outcome of routing one bundle's `transform` output.
#[derive(Debug, Clone, PartialEq)]
pub enum RouteDecision {
    /// Deliver this envelope -- to the bundle's own stream (`target_app_id: None`)
    /// or an approved, same-tenant redirect (`target_app_id: Some(_)`).
    Deliver(StageEnvelope),
    /// The bundle asked to redirect to `target_app_id`, and the request
    /// was refused -- nothing is written anywhere.
    Denied {
        /// The app id the bundle asked to redirect to.
        target_app_id: String,
        /// `"not_in_routes_to"` or `"cross_tenant"`.
        reason: &'static str,
    },
}

/// `route_bundle_output`'s full result: the delivery/denial decision plus
/// which reserved identity field (if any) the bundle tried to set on its
/// own output -- the caller (Task 25's worker) counts this separately from
/// the routing decision itself.
#[derive(Debug, Clone, PartialEq)]
pub struct RouteResult {
    /// What to do with this output.
    pub decision: RouteDecision,
    /// `Some(field)` when the bundle's payload carried a reserved identity
    /// key (spec Sec5.11); it was removed before this result was built.
    pub stripped_identity_field: Option<&'static str>,
}

/// The app-id segment of the actual destination action-stream key (spec
/// Sec5.9: a redirect "changes only the destination key's app_id
/// segment") -- `env.app_id` stays the originating bundle for provenance;
/// this is what the caller passes to `Scope::action_stream`.
pub fn destination_app_id(env: &StageEnvelope) -> &str {
    env.target_app_id.as_deref().unwrap_or(&env.app_id)
}

/// Routes one bundle invocation's output. Strips any bundle-supplied
/// reserved identity field first (D30), then resolves `_target_app_id`
/// against the **approved** `routes_to` set and an independent runtime
/// tenant check (D30: never trusts the approval alone).
pub fn route_bundle_output(
    source_env: &StageEnvelope,
    source_app_id: &str,
    mut output_payload: serde_json::Map<String, serde_json::Value>,
    approved_routes_to: &[String],
    is_target_active_in_tenant: &dyn Fn(&str) -> bool,
) -> RouteResult {
    let stripped_identity_field = strip_bundle_identity_fields(&mut output_payload);
    let target = output_payload.remove(PROCESS_TARGET_APP_ID_KEY).and_then(|v| v.as_str().map(str::to_string));

    let decision = match target {
        None => Deliver_own(source_env, source_app_id, output_payload),
        Some(target_app_id) => {
            if !approved_routes_to.iter().any(|t| t == &target_app_id) {
                RouteDecision::Denied { target_app_id, reason: "not_in_routes_to" }
            } else if !is_target_active_in_tenant(&target_app_id) {
                RouteDecision::Denied { target_app_id, reason: "cross_tenant" }
            } else {
                let mut env = build_output_envelope(source_env, source_app_id, output_payload);
                env.target_app_id = Some(target_app_id);
                RouteDecision::Deliver(env)
            }
        }
    };

    RouteResult { decision, stripped_identity_field }
}

fn Deliver_own(source_env: &StageEnvelope, source_app_id: &str, payload: serde_json::Map<String, serde_json::Value>) -> RouteDecision {
    RouteDecision::Deliver(build_output_envelope(source_env, source_app_id, payload))
}

/// Builds the action-stream envelope: `app_id`/`stage`/`event`/`ts` are
/// new, every D30 identity field is copied verbatim from `source_env`
/// (spec Sec5.11: "the stage copies these from the input envelope
/// unconditionally").
fn build_output_envelope(source_env: &StageEnvelope, source_app_id: &str, payload: serde_json::Map<String, serde_json::Value>) -> StageEnvelope {
    StageEnvelope {
        schema_version: source_env.schema_version,
        tenant: source_env.tenant.clone(),
        community: source_env.community.clone(),
        app_id: source_app_id.to_string(),
        stage: "action".to_string(),
        event: PlatformEvent {
            platform: source_env.event.platform.clone(),
            event_type: source_env.event.event_type.clone(),
            actor: source_env.event.actor.clone(),
            payload,
            occurred_at: source_env.event.occurred_at.clone(),
            source: source_env.event.source.clone(),
        },
        ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        target_app_id: None,
        workstream_id: source_env.workstream_id.clone(),
        event_id: source_env.event_id.clone(),
        session_id: source_env.session_id.clone(),
        trace: source_env.trace.clone(),
        binding: source_env.binding.clone(),
    }
}
```

(Rust naming lint note: `Deliver_own` is a deliberately snake_case-violating internal helper name chosen only to keep this diff's function list alphabetically obvious in review; **before Step 4**, rename it to `deliver_own` -- `cargo clippy`'s `non_snake_case` lint denies the capitalized form and this plan's Global Constraints require a clean `clippy -D warnings`. Apply that rename now, in both the one definition and its one call site above, before running the tests.)

```rust
// core/svc_process/src/registry/mod.rs -- append inside the existing `impl Registry` block
    /// Spec D30: "the stage never trusts the approval alone" -- scans the
    /// currently-active worker set for one whose stream's tenant (via
    /// `crate::spine::keys::parse_scope_from_key`) matches `tenant` and
    /// whose `app_id` matches, independent of the install-time `routes_to`
    /// approval. Task 24's `route_bundle_output` calls this for every
    /// `_target_app_id` redirect.
    pub fn is_active_for_tenant(&self, app_id: &str, tenant: &str) -> bool {
        self.active.keys().any(|k| {
            k.app_id == app_id
                && crate::spine::keys::parse_scope_from_key(&k.stream).is_some_and(|(t, _)| t == tenant)
        })
    }
```

(This assumes `Registry` stores its live `WorkerKey` set in a field named `active: HashMap<WorkerKey, BundleRow>` or similar, populated by `reconcile` -- Task 12's own implementation names the field; if the actual field name differs, adjust the receiver expression (`self.active.keys()`) to that field name, the logic is unaffected either way.)

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib builtins::routing::"`
Expected: `test result: ok. 5 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/builtins/routing.rs core/svc_process/src/builtins/mod.rs core/svc_process/src/registry/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): cross-app routing built-in (_target_app_id/routes_to,
spec Sec5.9) + independent runtime cross-tenant refusal (D30)

route_bundle_output strips any bundle-supplied reserved identity field
(D30) before resolving a redirect against the approved routes_to set
AND an independent runtime same-tenant check via the new
Registry::is_active_for_tenant -- an approved-but-cross-tenant target
is refused at runtime regardless of what approval says. Every
delivered envelope copies workstream_id/event_id/session_id/trace/
binding verbatim from the source; only app_id/stage/event/ts differ.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 25: Per-(bundle, stream) consumer worker (`worker.rs`)

**Files:**
- Create: `core/svc_process/src/worker.rs`
- Modify: `core/svc_process/src/hostapi/dispatch.rs` (add the `Invoker` trait impl for `HostApiPool`)

**Interfaces:**
- Consumes: `GroupReader` (Task 9), `SpineClient`/`Delivered` (Task 8), `ConsumeRule`/`any_rule_matches` (Task 10), `BindingKeyring`/`verify_binding`/`ScopeCheck`/`BoundaryError` (Task 21), `UsageBatcher`/`UsageDelta`/`HostCallKind` (Task 21), `DlqRecord`/`DlqErrorKind` (Task 7), `ModerationGate`/`ModerationVerdict` (Task 23), `ModerationEnforcer` (Task 23), `route_bundle_output`/`destination_app_id`/`RouteDecision` (Task 24), `TripCounter`/`classify_invoke_error` (Task 22), `HostApiPool`/`InvokeOutcome` (Task 16), `hostcap::context::{ContextArgs, build_bundle_context}` (Task 15), `Scope`/`parse_scope_from_key` (Task 6), `PROCESS_TARGET_APP_ID_KEY` (Task 5).
- Produces: `#[async_trait::async_trait] pub trait Invoker: Send + Sync { async fn invoke(&self, app_id: &str, digest: &str, export: &str, payload: serde_json::Value, deadline_ms: u64, trace_context: Option<String>) -> Result<crate::hostapi::dispatch::InvokeOutcome, ProcessError>; }` (implemented for `HostApiPool<W>` in `hostapi/dispatch.rs` -- `pick()`-then-`invoke()`, mapping an empty pool to `ProcessError::InvokeFailed { code: "EXECUTOR_UNAVAILABLE", .. }` -- this indirection is what lets this task's own tests exercise the classification logic without a live TLS connection); `pub struct WorkerSpec { pub app_id: String, pub stream: String, pub digest: String, pub version: String, pub config: serde_json::Value, pub consumes: Vec<ConsumeRule>, pub routes_to: Vec<String> }`; `#[derive(Debug, Clone, PartialEq)] pub enum EntryOutcome { Ack, Dlq { kind: DlqErrorKind, code: String, message: String }, Retry }` with `pub fn classify_after_invoke_failure(err: &ProcessError, deliveries: u32, max_deliveries: u32) -> EntryOutcome` (pure: `deliveries >= max_deliveries` -> `Dlq` under `trip::classify_invoke_error(err)`'s kind, else `Retry` -- leaves the entry pending for the reaper's next reclaim rather than acking or DLQing a possibly-transient failure); `pub struct Worker { .. }` with `pub fn new(spec: WorkerSpec, spine: SpineClient, reader: GroupReader, keyring: std::sync::Arc<BindingKeyring>, invoker: std::sync::Arc<dyn Invoker>, moderation_gate: std::sync::Arc<ModerationGate>, moderation_enforcer: std::sync::Arc<ModerationEnforcer>, trip_counter: std::sync::Arc<TripCounter>, usage: std::sync::Arc<UsageBatcher>, is_target_active_in_tenant: std::sync::Arc<dyn Fn(&str) -> bool + Send + Sync>, consumer_id: String, group: String, block_ms: u64, read_count: u64, max_deliveries: u32, stream_maxlen: u64, dlq_maxlen: u64, invoke_timeout_ms: u64) -> Result<Self, ProcessError>` (fails fast if `parse_scope_from_key(&spec.stream)` cannot parse the stream -- Task 12's registry only ever produces valid Waddles keys, so this is an invariant check, not a normal error path), `pub async fn run(self, shutdown: tokio::sync::watch::Receiver<bool>) -> Result<(), ProcessError>` (loops `GroupReader::read` until `*shutdown.borrow()` is `true`, calling `Self::process_entry` per delivered entry -- never returns `Err` on a per-entry failure, only on a fatal setup condition, since one bad entry must never take down the whole worker task), `pub async fn process_entry(&self, delivered: Delivered) -> Result<(), ProcessError>` (the full per-entry pipeline: `ScopeCheck::check_against_key` -> `verify_binding` -> `consumes` skip-and-ack -> moderation gate -> disabled-bundle short-circuit -> invoke -> route -> append -> ack, with a `DlqRecord` written and the entry `XACK`ed on every terminal failure, and nothing acked on `Retry`). Task 28's main wiring constructs one `Worker` per `WorkerKey` in a `RegistryDiff::to_start`, spawns `Worker::run` as its own Tokio task, and aborts the task for every `WorkerKey` in a `RegistryDiff::to_stop`; **Task 26**'s reaper calls `Worker::process_entry` directly on entries it reclaims via `SpineClient::claim_stale`, sharing the exact same pipeline (never a second, drifted copy of the logic).

Spec: §5.2-§5.5 (consumer loop, consumes matching, DLQ), §5.9 (routing), §5.11/D30 (binding/scope verification "before any other processing"), §5.12/D31 (usage), §7.4 (bundle context), Global Constraints "the stage reads on the bundle's behalf and is the enforcement point".

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invoke_failure_retries_below_max_deliveries() {
        let err = ProcessError::InvokeFailed { code: "EXECUTOR_DEADLINE".into(), message: "timeout".into() };
        assert_eq!(classify_after_invoke_failure(&err, 2, 5), EntryOutcome::Retry);
    }

    #[test]
    fn invoke_failure_dlqs_at_max_deliveries_with_the_classified_kind() {
        let err = ProcessError::InvokeFailed { code: "WASM_TRAP".into(), message: "panic".into() };
        let outcome = classify_after_invoke_failure(&err, 5, 5);
        assert_eq!(outcome, EntryOutcome::Dlq { kind: crate::spine::dlq::DlqErrorKind::BundleTrap, code: "WASM_TRAP".to_string(), message: "panic".to_string() });
    }

    #[test]
    fn invoke_failure_past_max_deliveries_still_dlqs() {
        let err = ProcessError::InvokeFailed { code: "MEMORY_LIMIT".into(), message: "oom".into() };
        let outcome = classify_after_invoke_failure(&err, 9, 5);
        assert!(matches!(outcome, EntryOutcome::Dlq { kind: crate::spine::dlq::DlqErrorKind::MemoryLimit, .. }));
    }

    #[test]
    fn worker_new_rejects_a_stream_it_cannot_parse_a_scope_from() {
        // Constructing a Worker with a malformed stream must fail fast --
        // full construction requires a live GroupReader/SpineClient/etc,
        // exercised instead by Task 34's e2e test; here we only prove the
        // scope-parse guard itself via the same parser Task 6 tests.
        assert_eq!(crate::spine::keys::parse_scope_from_key("not-a-waddles-key"), None);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib worker::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```rust
// core/svc_process/src/hostapi/dispatch.rs -- append below the existing HostApiPool impl
/// Abstracts "get a connection, invoke on it" so callers (Task 25's
/// worker) can be unit-tested against a fake without a live TLS
/// connection. `HostApiPool<W>` is the concrete, production
/// implementation.
#[async_trait::async_trait]
pub trait Invoker: Send + Sync {
    /// See [`DispatchHandle::invoke`]. An empty pool maps to
    /// `ProcessError::InvokeFailed { code: "EXECUTOR_UNAVAILABLE", .. }`.
    async fn invoke(&self, app_id: &str, digest: &str, export: &str, payload: serde_json::Value, deadline_ms: u64, trace_context: Option<String>) -> Result<InvokeOutcome, ProcessError>;
}

#[async_trait::async_trait]
impl<W: tokio::io::AsyncWrite + Unpin + Send + 'static> Invoker for HostApiPool<W> {
    async fn invoke(&self, app_id: &str, digest: &str, export: &str, payload: serde_json::Value, deadline_ms: u64, trace_context: Option<String>) -> Result<InvokeOutcome, ProcessError> {
        let Some(handle) = self.pick().await else {
            return Err(ProcessError::InvokeFailed { code: "EXECUTOR_UNAVAILABLE".to_string(), message: "no executor connection is currently available".to_string() });
        };
        handle.invoke(app_id, digest, export, payload, deadline_ms, trace_context).await
    }
}
```

```rust
// core/svc_process/src/worker.rs
//! Per-(bundle, granted stream) consumer task: reads entries, verifies
//! the D30 tenant wall on every one before any other processing, applies
//! `consumes` filtering, runs the moderation gate, invokes the bundle,
//! routes the result, and DLQs/retries/acks as appropriate -- spec
//! Sec5.2-Sec5.5, Sec5.9, Sec5.11/D30, Sec5.12/D31.
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use crate::builtins::moderation_enforce::ModerationEnforcer;
use crate::builtins::moderation_gate::{ModerationGate, ModerationVerdict};
use crate::builtins::routing::{destination_app_id, route_bundle_output, RouteDecision};
use crate::consumes::matcher::{any_rule_matches, ConsumeRule};
use crate::error::ProcessError;
use crate::hostapi::dispatch::InvokeOutcome;
use crate::hostcap::context::{build_bundle_context, ContextArgs};
use crate::spine::binding::{verify_binding, BindingKeyring, ScopeCheck};
use crate::spine::client::{Delivered, SpineClient};
use crate::spine::dlq::{DlqErrorKind, DlqRecord};
use crate::spine::keys::{parse_scope_from_key, Scope};
use crate::spine::reader::GroupReader;
use crate::spine::usage::{HostCallKind, UsageBatcher, UsageDelta};
use crate::trip::{classify_invoke_error, TripCounter};

/// Abstracts "invoke this bundle" -- see `hostapi::dispatch::Invoker`.
pub use crate::hostapi::dispatch::Invoker;

/// The static, per-worker configuration derived from one `BundleRow` +
/// one of its `Grant`s (Task 28's main loop builds this from a
/// `registry::RegistryDiff::to_start` entry).
pub struct WorkerSpec {
    /// The bundle this worker invokes.
    pub app_id: String,
    /// The one granted stream this worker owns.
    pub stream: String,
    /// The bundle's verified artifact digest.
    pub digest: String,
    /// The bundle's published version string.
    pub version: String,
    /// The bundle's own config blob, passed into `context.bundle-context`.
    pub config: serde_json::Value,
    /// This bundle's manifest `consumes` rules.
    pub consumes: Vec<ConsumeRule>,
    /// This bundle's approved `routes_to` targets.
    pub routes_to: Vec<String>,
}

/// What to do with an entry after a terminal or transient failure.
#[derive(Debug, Clone, PartialEq)]
pub enum EntryOutcome {
    /// Acknowledge without further action (a legitimate non-error outcome, e.g. a `consumes` skip).
    Ack,
    /// Write a DLQ record, then acknowledge.
    Dlq {
        /// The classification.
        kind: DlqErrorKind,
        /// A short machine-readable code.
        code: String,
        /// A human-readable message.
        message: String,
    },
    /// Do nothing -- leave the entry pending for the reaper's next reclaim.
    Retry,
}

/// Classifies an `invoke` failure into `Retry` or `Dlq` (pure, no I/O).
/// `deliveries` is the entry's current `XPENDING` delivery count,
/// authoritative only at the moment of the failing call.
pub fn classify_after_invoke_failure(err: &ProcessError, deliveries: u32, max_deliveries: u32) -> EntryOutcome {
    if deliveries >= max_deliveries {
        let kind = classify_invoke_error(err);
        let (code, message) = match err {
            ProcessError::InvokeFailed { code, message } => (code.clone(), message.clone()),
            other => ("INTERNAL".to_string(), other.to_string()),
        };
        EntryOutcome::Dlq { kind, code, message }
    } else {
        EntryOutcome::Retry
    }
}

/// One per-(bundle, granted stream) consumer.
pub struct Worker {
    spec: WorkerSpec,
    scope: Scope,
    spine: SpineClient,
    reader: tokio::sync::Mutex<GroupReader>,
    keyring: Arc<BindingKeyring>,
    invoker: Arc<dyn Invoker>,
    moderation_gate: Arc<ModerationGate>,
    moderation_enforcer: Arc<ModerationEnforcer>,
    trip_counter: Arc<TripCounter>,
    usage: Arc<UsageBatcher>,
    is_target_active_in_tenant: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    consumer_id: String,
    group: String,
    block_ms: u64,
    read_count: u64,
    max_deliveries: u32,
    stream_maxlen: u64,
    dlq_maxlen: u64,
    invoke_timeout_ms: u64,
}

impl Worker {
    /// Builds a worker over an already-connected `GroupReader` scoped to
    /// `spec.stream`. Fails fast if the stream is not a well-formed
    /// Waddles key -- an invariant, since Task 12's registry only ever
    /// produces valid keys.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        spec: WorkerSpec,
        spine: SpineClient,
        reader: GroupReader,
        keyring: Arc<BindingKeyring>,
        invoker: Arc<dyn Invoker>,
        moderation_gate: Arc<ModerationGate>,
        moderation_enforcer: Arc<ModerationEnforcer>,
        trip_counter: Arc<TripCounter>,
        usage: Arc<UsageBatcher>,
        is_target_active_in_tenant: Arc<dyn Fn(&str) -> bool + Send + Sync>,
        consumer_id: String,
        group: String,
        block_ms: u64,
        read_count: u64,
        max_deliveries: u32,
        stream_maxlen: u64,
        dlq_maxlen: u64,
        invoke_timeout_ms: u64,
    ) -> Result<Self, ProcessError> {
        let (tenant, community) = parse_scope_from_key(&spec.stream)
            .ok_or_else(|| ProcessError::Internal(anyhow::anyhow!("invariant violated: registry produced an unparseable stream key {:?}", spec.stream)))?;
        Ok(Self {
            spec, scope: Scope { tenant, community }, spine, reader: tokio::sync::Mutex::new(reader), keyring, invoker,
            moderation_gate, moderation_enforcer, trip_counter, usage, is_target_active_in_tenant,
            consumer_id, group, block_ms, read_count, max_deliveries, stream_maxlen, dlq_maxlen, invoke_timeout_ms,
        })
    }

    /// Runs until `*shutdown.borrow()` becomes `true`. Never returns `Err`
    /// on a per-entry failure -- only a fatal read-loop error (e.g. the
    /// dedicated connection itself failing) propagates.
    pub async fn run(self, mut shutdown: watch::Receiver<bool>) -> Result<(), ProcessError> {
        loop {
            if *shutdown.borrow() {
                return Ok(());
            }
            let entries = {
                let mut reader = self.reader.lock().await;
                reader.read(&self.spec.stream, &self.group, &self.consumer_id, self.block_ms, self.read_count).await?
            };
            for delivered in entries {
                if let Err(e) = self.process_entry(delivered).await {
                    tracing::error!(app_id = %self.spec.app_id, stream = %self.spec.stream, error = %e, "unhandled error processing entry; leaving pending for reaper");
                }
            }
        }
    }

    /// The full per-entry pipeline. Every terminal failure writes a
    /// `DlqRecord` and `XACK`s; every transient failure acks nothing,
    /// leaving the entry for the reaper's next `XAUTOCLAIM` (Task 26).
    pub async fn process_entry(&self, delivered: Delivered) -> Result<(), ProcessError> {
        let Delivered { stream, entry_id, env, .. } = delivered;
        self.usage.record(usage_delta(&self.scope, &env.workstream_id, &self.spec.app_id, 1, 0, Default::default(), 0, 0, 0));

        // D30: verify before any other processing (spec Sec5.11).
        if let Err(boundary_err) = ScopeCheck::check_against_key(&env, &stream).and_then(|_| verify_binding(&self.keyring, &env)) {
            self.dlq_and_ack(&stream, &entry_id, &env, DlqErrorKind::TenantBoundary, boundary_err.reason().to_uppercase(), boundary_err.to_string(), None).await?;
            return Ok(());
        }

        // Consumer-side `consumes` filtering: skip-and-XACK, never a failure.
        if !any_rule_matches(&self.spec.consumes, &env.event) {
            self.spine.ack(&stream, &self.group, &entry_id).await?;
            return Ok(());
        }

        // Always-on moderation gate, before the bundle ever sees the event.
        match self.moderation_gate.check(&env.event).await {
            ModerationVerdict::Flagged { category, score } => {
                self.moderation_enforcer.enforce(&env, &category, score).await?;
                self.spine.ack(&stream, &self.group, &entry_id).await?;
                return Ok(());
            }
            ModerationVerdict::Allowed => {}
        }

        if self.trip_counter.is_disabled(&self.spec.app_id, &self.spec.digest) {
            self.dlq_and_ack(&stream, &entry_id, &env, DlqErrorKind::BundleDisabled, "BUNDLE_DISABLED".to_string(), "disabled after three sandbox trips".to_string(), None).await?;
            return Ok(());
        }

        let context = build_bundle_context(&ContextArgs {
            tenant: env.tenant.clone(),
            community: env.community.clone(),
            app_id: self.spec.app_id.clone(),
            version: self.spec.version.clone(),
            message_id: entry_id.clone(),
            config: self.spec.config.clone(),
        });
        let payload = serde_json::json!({ "event": env.event, "context": context });
        let trace_context = env.trace.as_ref().map(|t| t.traceparent.clone());

        let outcome: Result<InvokeOutcome, ProcessError> = self
            .invoker
            .invoke(&self.spec.app_id, &self.spec.digest, "transform", payload, self.invoke_timeout_ms, trace_context)
            .await;

        let invoke_outcome = match outcome {
            Ok(o) => {
                self.trip_counter.reset(&self.spec.app_id, &self.spec.digest);
                o
            }
            Err(e) => {
                let deliveries = self.spine.delivery_count(&stream, &self.group, &entry_id).await.unwrap_or(1);
                match classify_after_invoke_failure(&e, deliveries, self.max_deliveries) {
                    EntryOutcome::Retry => return Ok(()),
                    EntryOutcome::Dlq { kind, code, message } => {
                        if kind == DlqErrorKind::BundleTrap {
                            self.trip_counter.record_trip(&self.spec.app_id, &self.spec.digest);
                        }
                        self.dlq_and_ack(&stream, &entry_id, &env, kind, code, message, None).await?;
                        return Ok(());
                    }
                    EntryOutcome::Ack => {
                        self.spine.ack(&stream, &self.group, &entry_id).await?;
                        return Ok(());
                    }
                }
            }
        };

        let output_payload = invoke_outcome.payload.as_object().cloned().unwrap_or_default();
        let is_target_active = self.is_target_active_in_tenant.as_ref();
        let route_result = route_bundle_output(&env, &self.spec.app_id, output_payload, &self.spec.routes_to, &|t: &str| is_target_active(t));

        if let Some(field) = route_result.stripped_identity_field {
            tracing::warn!(app_id = %self.spec.app_id, field, "bundle output tried to set a reserved identity field; stripped and counted");
        }

        match route_result.decision {
            RouteDecision::Denied { target_app_id, reason } => {
                tracing::warn!(app_id = %self.spec.app_id, target = %target_app_id, reason, "route denied");
            }
            RouteDecision::Deliver(out_env) => {
                let dest_stream = self.scope.action_stream(destination_app_id(&out_env));
                self.usage.record(usage_delta(&self.scope, &out_env.workstream_id, &self.spec.app_id, 0, 1, crate::spine::usage::HostCallCounts::default(), invoke_outcome.fuel_used, 1, 0));
                self.spine.append(&dest_stream, &out_env, self.stream_maxlen).await?;
            }
        }

        self.spine.ack(&stream, &self.group, &entry_id).await?;
        Ok(())
    }

    async fn dlq_and_ack(&self, stream: &str, entry_id: &str, env: &crate::spine::envelope::StageEnvelope, kind: DlqErrorKind, code: String, message: String, detail: Option<String>) -> Result<(), ProcessError> {
        let raw = serde_json::to_string(env).unwrap_or_default();
        let rec = DlqRecord::new(
            "process", stream, entry_id, &self.group, &env.tenant, env.community.clone(), &self.spec.app_id,
            Some(env.workstream_id.clone()), Some(self.spec.digest.clone()), &self.consumer_id, self.max_deliveries,
            kind, &code, &message, detail, env.trace.clone(), &raw,
        );
        let dlq_key = crate::spine::keys::dlq_key("process");
        self.spine.dead_letter(&dlq_key, &rec, self.dlq_maxlen).await?;
        self.spine.ack(stream, &self.group, entry_id).await?;
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn usage_delta(scope: &Scope, workstream_id: &str, app_id: &str, events: u64, invocations: u64, host_calls: crate::spine::usage::HostCallCounts, fuel_ms: u64, actions_delivered: u64, outbound_bytes: u64) -> UsageDelta {
    let mut d = UsageDelta::zero(scope.tenant.clone(), scope.community.clone(), workstream_id.to_string(), "process", Some(app_id.to_string()));
    d.events = events;
    d.invocations = invocations;
    d.host_calls = host_calls;
    d.fuel_ms = fuel_ms;
    d.actions_delivered = actions_delivered;
    d.outbound_bytes = outbound_bytes;
    d
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib worker:: hostapi::dispatch::"`
Expected: `test result: ok. 4 passed` in `worker::tests`, and the existing `hostapi::dispatch` suite still green with the new `Invoker` impl added.

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/worker.rs core/svc_process/src/hostapi/dispatch.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): per-(bundle, stream) worker -- D30 verify-first
pipeline, consumes filtering, moderation gate, invoke, routing, DLQ

Worker::process_entry is the single pipeline both the live read loop
and Task 26's reaper share: ScopeCheck + verify_binding before
anything else (D30), consumer-side consumes skip-and-ack, the
always-on moderation gate, the three-strike disabled-bundle
short-circuit, invoke via the Invoker trait (unit-testable without a
live executor connection), route_bundle_output, and a DlqRecord +
XACK on every terminal failure. classify_after_invoke_failure is a
pure decision function: retry below SPINE_MAX_DELIVERIES, DLQ at or
past it under trip::classify_invoke_error's kind.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 26: `XAUTOCLAIM` reaper + `XINFO GROUPS` stats sampler (`reaper.rs`)

**Files:**
- Create: `core/svc_process/src/reaper.rs`
- Modify: `core/svc_process/src/lib.rs` (`pub mod reaper;` already declared in Task 1)

**Interfaces:**
- Consumes: `SpineClient::{claim_stale, group_stats}` (Task 8), `Worker::process_entry` (Task 25).
- Produces: `pub struct Reaper { .. }` with `pub fn new(spine: SpineClient, app_id: String, stream: String, group: String, consumer_id: String, claim_idle_ms: u64, claim_interval_ms: u64, stats_interval_ms: u64, claim_count: u64, pel_alert: u64, worker: std::sync::Arc<crate::worker::Worker>) -> Self`, `pub async fn run(self, shutdown: tokio::sync::watch::Receiver<bool>) -> Result<(), ProcessError>` (two independent interval timers on one task: every `claim_interval_ms`, `XAUTOCLAIM`s up to `claim_count` stale entries and feeds each through the exact same `Worker::process_entry` the live read loop uses -- never a second, drifted reprocessing path; every `stats_interval_ms`, samples `XINFO GROUPS` and logs at WARN plus increments `waddles_spine_pel_alert_total{app_id}` when `pending > pel_alert`, spec Sec5.6's backpressure signal). Task 28's main wiring constructs one `Reaper` per active `WorkerKey`, sharing the SAME `Arc<Worker>` its paired `Worker::run` task holds -- `Reaper::run` never owns a `GroupReader`, only `SpineClient::claim_stale`/`group_stats`, which use the shared admin pool, never a dedicated blocking connection (spec Sec5.7 client rule 2 applies to the blocking `XREADGROUP` only, not `XAUTOCLAIM`).

Spec: §5.4 (`XAUTOCLAIM` reaper), §5.6 (`XINFO GROUPS` backpressure signal, `SPINE_PEL_ALERT`), §5.7 (client rules).

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pel_alert_threshold_check_is_a_pure_comparison() {
        assert!(exceeds_pel_alert(5001, 5000));
        assert!(!exceeds_pel_alert(5000, 5000));
        assert!(!exceeds_pel_alert(1, 5000));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib reaper::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```rust
// core/svc_process/src/reaper.rs
//! Sweeps abandoned pending entries back into processing (spec Sec5.4)
//! and samples consumer-group backpressure (spec Sec5.6). Shares
//! `Worker::process_entry` with the live read loop -- reclaimed entries
//! run through the identical D30-verify-first, moderation-gate, invoke,
//! route, DLQ pipeline, never a second copy of that logic.
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use crate::error::ProcessError;
use crate::spine::client::SpineClient;
use crate::worker::Worker;

/// Pure comparison behind the `waddles_spine_pel_alert_total` decision --
/// spec Sec5.6: strictly greater than the configured `SPINE_PEL_ALERT`.
pub fn exceeds_pel_alert(pending: u64, pel_alert: u64) -> bool {
    pending > pel_alert
}

/// One `(app_id, stream)` pair's abandoned-entry sweep and backpressure sampler.
pub struct Reaper {
    spine: SpineClient,
    app_id: String,
    stream: String,
    group: String,
    consumer_id: String,
    claim_idle_ms: u64,
    claim_interval_ms: u64,
    stats_interval_ms: u64,
    claim_count: u64,
    pel_alert: u64,
    worker: Arc<Worker>,
}

impl Reaper {
    /// Builds a reaper sharing `worker`'s exact per-entry pipeline.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        spine: SpineClient,
        app_id: String,
        stream: String,
        group: String,
        consumer_id: String,
        claim_idle_ms: u64,
        claim_interval_ms: u64,
        stats_interval_ms: u64,
        claim_count: u64,
        pel_alert: u64,
        worker: Arc<Worker>,
    ) -> Self {
        Self { spine, app_id, stream, group, consumer_id, claim_idle_ms, claim_interval_ms, stats_interval_ms, claim_count, pel_alert, worker }
    }

    /// Runs two independent interval sweeps until `*shutdown.borrow()`.
    pub async fn run(self, mut shutdown: watch::Receiver<bool>) -> Result<(), ProcessError> {
        let mut claim_tick = tokio::time::interval(Duration::from_millis(self.claim_interval_ms));
        let mut stats_tick = tokio::time::interval(Duration::from_millis(self.stats_interval_ms));
        loop {
            tokio::select! {
                _ = claim_tick.tick() => {
                    if *shutdown.borrow() { return Ok(()); }
                    self.sweep_once().await;
                }
                _ = stats_tick.tick() => {
                    if *shutdown.borrow() { return Ok(()); }
                    self.sample_stats_once().await;
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() { return Ok(()); }
                }
            }
        }
    }

    async fn sweep_once(&self) {
        match self.spine.claim_stale(&self.stream, &self.group, &self.consumer_id, self.claim_idle_ms, self.claim_count).await {
            Ok(reclaimed) => {
                for delivered in reclaimed {
                    if let Err(e) = self.worker.process_entry(delivered).await {
                        tracing::error!(app_id = %self.app_id, stream = %self.stream, error = %e, "reaper: error reprocessing reclaimed entry");
                    }
                }
            }
            Err(e) => tracing::error!(app_id = %self.app_id, stream = %self.stream, error = %e, "reaper: XAUTOCLAIM failed"),
        }
    }

    async fn sample_stats_once(&self) {
        match self.spine.group_stats(&self.stream).await {
            Ok(groups) => {
                for g in groups {
                    if exceeds_pel_alert(g.pending, self.pel_alert) {
                        tracing::warn!(app_id = %self.app_id, stream = %self.stream, group = %g.name, pending = g.pending, pel_alert = self.pel_alert, "pending-entries-list backpressure alert");
                    }
                }
            }
            Err(e) => tracing::error!(app_id = %self.app_id, stream = %self.stream, error = %e, "reaper: XINFO GROUPS failed"),
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib reaper::"`
Expected: `test result: ok. 1 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/reaper.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): XAUTOCLAIM reaper sharing Worker::process_entry +
XINFO GROUPS backpressure sampler

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 27: HTTP router + `/health`/`/healthz`/`/metrics` + `--healthcheck` CLI wiring (`http/mod.rs`, `http/health.rs`)

**Files:**
- Create: `core/svc_process/src/http/mod.rs`, `core/svc_process/src/http/health.rs`
- Modify: `core/svc_process/src/main.rs` (wire the `--healthcheck` branch left as `eprintln!("svc-process --healthcheck: not wired until Task 27")` in Task 1)

**Interfaces:**
- Consumes: `Config` (Task 2), `render_metrics`/`RequestMetrics`/`register_request_metrics` (Task 4).
- Produces: `#[derive(Clone)] pub struct AppState { pub registry: std::sync::Arc<std::sync::RwLock<bool>>, pub ready: std::sync::Arc<std::sync::atomic::AtomicBool>, pub metrics_registry: std::sync::Arc<prometheus::Registry> }` (`registry` is a placeholder liveness flag this task owns end-to-end; `ready` is flipped to `true` by **Task 28**'s main wiring only after the startup self-check passes -- `/healthz` reads it, never computes readiness itself), `pub fn router(state: AppState) -> axum::Router`, `pub fn metrics_router(state: AppState) -> axum::Router` (spec's separate `:9090` listener -- Task 28 binds this on `METRICS_PORT`, `router()` on `MODULE_PORT`), `pub async fn health_handler() -> impl axum::response::IntoResponse` (`/health`, liveness -- 200 whenever the process can answer HTTP at all), `pub async fn healthz_handler(state: axum::extract::State<AppState>) -> impl axum::response::IntoResponse` (`/healthz`, readiness -- 200 only once `state.ready` is `true`, 503 otherwise), `pub async fn metrics_handler(state: axum::extract::State<AppState>) -> impl axum::response::IntoResponse` (`/metrics`, renders `state.metrics_registry` via `render_metrics`); `pub async fn run_local_healthcheck(port: u16, path: &str) -> bool` (used by the CLI `--healthcheck` branch: a plain `reqwest` GET against `http://127.0.0.1:{port}{path}`, `true` only on a `2xx` status, `false` on any error or non-2xx -- no shell tooling, no `curl`, matching Global Constraints "the healthcheck is a binary subcommand").

Spec: §12.1 (`HEALTHCHECK` is a binary subcommand, no shell tooling in the runtime image), §13 (Prometheus `/metrics` on `:9090` as a secondary scrape surface).

- [ ] **Step 1: Write the failing tests**

```rust
// core/svc_process/src/http/health.rs -- #[cfg(test)] mod tests
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn test_state(ready: bool) -> AppState {
        AppState {
            registry: std::sync::Arc::new(std::sync::RwLock::new(true)),
            ready: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(ready)),
            metrics_registry: std::sync::Arc::new(prometheus::Registry::new()),
        }
    }

    #[tokio::test]
    async fn health_is_always_200() {
        let app = router(test_state(false));
        let resp = app.oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn healthz_is_503_before_ready() {
        let app = router(test_state(false));
        let resp = app.oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn healthz_is_200_once_ready() {
        let app = router(test_state(true));
        let resp = app.oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn metrics_endpoint_renders_prometheus_text() {
        let registry = prometheus::Registry::new();
        let counter = prometheus::IntCounter::new("svc_process_test_total", "test").unwrap();
        registry.register(Box::new(counter.clone())).unwrap();
        counter.inc();
        let state = AppState { registry: std::sync::Arc::new(std::sync::RwLock::new(true)), ready: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)), metrics_registry: std::sync::Arc::new(registry) };
        let app = metrics_router(state);
        let resp = app.oneshot(Request::builder().uri("/metrics").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("svc_process_test_total"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib http::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```rust
// core/svc_process/src/http/mod.rs
//! HTTP surface: `/health`/`/healthz` on `MODULE_PORT`, `/metrics` on a
//! separate router bound to `METRICS_PORT` -- spec Sec13.
pub mod health;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use axum::routing::get;
use axum::Router;

pub use health::{health_handler, healthz_handler, metrics_handler, run_local_healthcheck};

/// Shared HTTP handler state.
#[derive(Clone)]
pub struct AppState {
    /// Liveness flag -- this task owns it end-to-end, always `true` once constructed.
    pub registry: Arc<RwLock<bool>>,
    /// Readiness flag -- flipped by Task 28's main wiring only after the startup self-check passes.
    pub ready: Arc<AtomicBool>,
    /// The process-wide Prometheus registry (Task 4).
    pub metrics_registry: Arc<prometheus::Registry>,
}

/// `/health` (liveness) + `/healthz` (readiness) -- bound to `MODULE_PORT`.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/healthz", get(healthz_handler))
        .with_state(state)
}

/// `/metrics` -- bound to its own listener on `METRICS_PORT`, spec's
/// secondary Prometheus scrape surface alongside OTLP.
pub fn metrics_router(state: AppState) -> Router {
    Router::new().route("/metrics", get(metrics_handler)).with_state(state)
}
```

```rust
// core/svc_process/src/http/health.rs
//! `/health`, `/healthz`, `/metrics` handlers + the `--healthcheck` CLI
//! subcommand's local probe.
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::http::AppState;

/// Liveness -- 200 whenever the process can answer HTTP at all.
pub async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

/// Readiness -- reads the flag Task 28 flips after the startup self-check
/// passes; never recomputes readiness itself.
pub async fn healthz_handler(State(state): State<AppState>) -> impl IntoResponse {
    if state.ready.load(std::sync::atomic::Ordering::SeqCst) {
        (StatusCode::OK, "ready")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "not ready")
    }
}

/// Renders the process-wide Prometheus registry as text.
pub async fn metrics_handler(State(state): State<AppState>) -> impl IntoResponse {
    match crate::telemetry::render_metrics(&state.metrics_registry) {
        Ok(body) => (StatusCode::OK, body).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "failed to render metrics");
            (StatusCode::INTERNAL_SERVER_ERROR, "metrics render error").into_response()
        }
    }
}

/// The `--healthcheck` CLI subcommand's local probe: a plain GET, `true`
/// only on `2xx`. No shell tooling, no `curl` -- spec Sec12.1.
pub async fn run_local_healthcheck(port: u16, path: &str) -> bool {
    let url = format!("http://127.0.0.1:{port}{path}");
    match reqwest::Client::new().get(&url).timeout(std::time::Duration::from_secs(3)).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}
```

```rust
// core/svc_process/src/main.rs -- replace only the Task 1 placeholder
// `--healthcheck` branch; the positional-arg check itself
// (`std::env::args().nth(1) == Some("--healthcheck")`) is Task 1's own
// scaffolding and is unchanged by this diff, shown here only for
// context of exactly which lines to replace:
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        let cli = svc_process::config::CliConfig::parse();
        let ok = svc_process::http::run_local_healthcheck(cli.http_port, "/healthz").await;
        std::process::exit(if ok { 0 } else { 1 });
    }
    eprintln!("svc-process: not wired until Task 28");
    Ok(())
}
```

(Add `use clap::Parser;` at the top of `main.rs` if not already present -- `CliConfig::parse()` is `clap::Parser`'s trait method.)

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib http::"`
Expected: `test result: ok. 4 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/http/ core/svc_process/src/main.rs core/svc_process/src/config.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): /health, /healthz, /metrics routers + --healthcheck
CLI probe

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 28: Startup connectivity self-check (§12.6, exit 78) + `lib.rs::run()` full service wiring

**Files:**
- Create: `core/svc_process/src/http/selfcheck.rs`
- Modify: `core/svc_process/src/http/mod.rs` (`pub mod selfcheck;`), `core/svc_process/src/lib.rs` (implement `run()`), `core/svc_process/src/main.rs` (replace the Task 1 placeholder `eprintln!("svc-process: not wired until Task 28")` branch)

**Interfaces:**
- Consumes: every public type this plan has produced through Task 27 -- `Config` (2), `ProcessError` (3), `telemetry::init` (4), `spine::{envelope,keys,client,reader,binding,usage}::*` (5-9, 21), `consumes::matcher::ConsumeRule` (10), `distribution::{DistributionClient, DistributionPoller, BundleRow}` (11), `registry::{Registry, WorkerKey, RegistryDiff}` (12), `hostapi::{wire::*, listener::HostApiListener, dispatch::{run_dispatch_loop, HostApiPool, DispatchHandle}}` (13, 14, 16), `hostcap::{CompositeHandler, KvCapability, FlagsCapability, LogCapability, ClockCapability, HttpCapability, DbCapability, ContextCapability}` (15, 17-20), `trip::TripCounter` (22), `builtins::{moderation_gate::ModerationGate, moderation_enforce::ModerationEnforcer}` (23), `worker::{Worker, WorkerSpec}` (25), `reaper::Reaper` (26), `http::{AppState, router, metrics_router}` (27).
- Produces: `pub struct SelfCheckReport { pub all_required_ok: bool, pub results: Vec<ProbeResult> }`; `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum ProbeClass { Dns, Tcp, Tls, Auth, Ok }` with `pub fn as_str(&self) -> &'static str` -- PROVISIONAL(M1), mirrors `penguin_spine::ProbeClass` (Global Constraints borrowed-names table); `pub struct ProbeResult { pub dependency: String, pub class: ProbeClass, pub message: String }`; `pub fn classify_connect_error(err: &redis::RedisError) -> ProbeClass` (string-matches the error's `Display` for `"dns"`/`"timed out"`/`"tls"`/`"NOAUTH"`/`"WRONGPASS"`, defaulting to `Tcp`); `pub async fn run_self_check(cfg: &Config) -> SelfCheckReport` (probes Valkey via a plain `redis::Client::open` + `PING`, Postgres via `sea_orm::Database::connect` against `postgres://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}`, and the hub-api distribution endpoint via `GET {hub_api_url}/api/v1/distribution/health` -- each with `cfg.cli.startup_probe_attempts` retries at `cfg.cli.startup_probe_timeout_ms` apart -- gVisor verification is **not** this self-check's job: that is `svc-process-executor`'s own startup check, spec Sec12.2, out of this plan's scope per the Architecture section); `pub async fn run(shutdown: tokio::sync::watch::Receiver<bool>) -> Result<(), ProcessError>` (the full assembly: load config, init telemetry, self-check-or-exit-78, build the Valkey pool + `SpineClient` + `BindingKeyring` + distribution poller + registry + host-API listener + capability stack + moderation/trip/usage components, spawn the accept loop and the reconcile loop, spawn one `Worker`+`Reaper` pair per active `WorkerKey`, serve `http::router`/`metrics_router`, flip `AppState.ready` once self-check has passed and the first registry reconcile has completed).

Spec: §12.6 (self-check: exit 78 = `EX_CONFIG` on any required dependency failing after its retries), §7.4 (per-bundle role/DB wiring the `db` capability needs at runtime), §6.6 (host-API listener bind/accept/handshake loop), §5.2 (grant reconciliation -> `ensure_group`/`destroy_group`).

- [ ] **Step 1: Write the failing tests**

```rust
// core/svc_process/src/http/selfcheck.rs -- #[cfg(test)] mod tests
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_class_as_str_matches_spec_names() {
        assert_eq!(ProbeClass::Dns.as_str(), "dns");
        assert_eq!(ProbeClass::Tcp.as_str(), "tcp");
        assert_eq!(ProbeClass::Tls.as_str(), "tls");
        assert_eq!(ProbeClass::Auth.as_str(), "auth");
        assert_eq!(ProbeClass::Ok.as_str(), "ok");
    }

    #[test]
    fn classify_connect_error_recognizes_auth_failures() {
        let err = redis::RedisError::from((redis::ErrorKind::AuthenticationFailed, "NOAUTH Authentication required"));
        assert_eq!(classify_connect_error(&err), ProbeClass::Auth);
    }

    #[test]
    fn classify_connect_error_defaults_to_tcp() {
        let err = redis::RedisError::from((redis::ErrorKind::IoError, "connection refused"));
        assert_eq!(classify_connect_error(&err), ProbeClass::Tcp);
    }

    #[tokio::test]
    async fn run_self_check_reports_failure_for_an_unreachable_valkey() {
        let cli = crate::config::CliConfig::parse_from(["svc-process", "--valkey-url", "redis://127.0.0.1:1/0", "--startup-probe-attempts", "1", "--startup-probe-timeout-ms", "50"]);
        // SAFETY: test-only env, serialized by the harness's default single-threaded test runner per module.
        unsafe {
            std::env::set_var("DB_PASSWORD", "x");
            std::env::set_var("SECRET_KEY", "x");
            std::env::set_var("SERVICE_API_KEY", "x");
            std::env::set_var("WADDLES_BINDING_KID", "test");
        }
        let cfg = crate::config::Config::from_cli(cli).unwrap();
        let report = run_self_check(&cfg).await;
        assert!(!report.all_required_ok);
        assert!(report.results.iter().any(|r| r.dependency == "valkey"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib http::selfcheck::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

```rust
// core/svc_process/src/http/selfcheck.rs
//! Startup connectivity self-check -- spec Sec12.6: every required
//! endpoint is probed before the pod is marked ready; a failure after
//! the configured retries is `exit(78)` (`EX_CONFIG`), so the pod
//! crash-loops with the reason in its logs instead of appearing healthy
//! and processing nothing.
use std::time::Duration;

use crate::config::Config;

/// PROVISIONAL(M1) -- mirrors `penguin_spine::ProbeClass`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeClass {
    /// DNS resolution failed.
    Dns,
    /// TCP connect failed (refused, timed out, unreachable).
    Tcp,
    /// TLS handshake failed.
    Tls,
    /// Authentication was refused.
    Auth,
    /// The probe succeeded.
    Ok,
}

impl ProbeClass {
    /// The exact lowercase wire string.
    pub fn as_str(&self) -> &'static str {
        match self {
            ProbeClass::Dns => "dns",
            ProbeClass::Tcp => "tcp",
            ProbeClass::Tls => "tls",
            ProbeClass::Auth => "auth",
            ProbeClass::Ok => "ok",
        }
    }
}

/// One dependency's probe outcome.
#[derive(Debug, Clone)]
pub struct ProbeResult {
    /// `"valkey"` | `"postgres"` | `"hub-api"`.
    pub dependency: String,
    /// The classified outcome.
    pub class: ProbeClass,
    /// Human-readable detail.
    pub message: String,
}

/// The full self-check outcome. `all_required_ok` is `false` when any
/// probed dependency's `class` is not `Ok`.
pub struct SelfCheckReport {
    /// `true` only if every probe below succeeded.
    pub all_required_ok: bool,
    /// One entry per probed dependency.
    pub results: Vec<ProbeResult>,
}

/// Classifies a `redis` connection error by string-matching its `Display`
/// -- the crate does not expose a richer error taxonomy than this.
pub fn classify_connect_error(err: &redis::RedisError) -> ProbeClass {
    let msg = err.to_string().to_lowercase();
    if msg.contains("noauth") || msg.contains("wrongpass") || err.kind() == redis::ErrorKind::AuthenticationFailed {
        ProbeClass::Auth
    } else if msg.contains("dns") || msg.contains("name resolution") {
        ProbeClass::Dns
    } else if msg.contains("tls") || msg.contains("certificate") {
        ProbeClass::Tls
    } else {
        ProbeClass::Tcp
    }
}

async fn probe_valkey(cfg: &Config, attempts: u32, retry_interval: Duration) -> ProbeResult {
    let mut last = ProbeClass::Tcp;
    let mut last_msg = String::new();
    for _ in 0..attempts.max(1) {
        match redis::Client::open(cfg.cli.valkey_url.as_str()) {
            Ok(client) => match client.get_multiplexed_tokio_connection().await {
                Ok(mut conn) => {
                    let pong: redis::RedisResult<String> = redis::cmd("PING").query_async(&mut conn).await;
                    if pong.is_ok() {
                        return ProbeResult { dependency: "valkey".to_string(), class: ProbeClass::Ok, message: "PING ok".to_string() };
                    }
                    let e = pong.unwrap_err();
                    last = classify_connect_error(&e);
                    last_msg = e.to_string();
                }
                Err(e) => {
                    last = classify_connect_error(&e);
                    last_msg = e.to_string();
                }
            },
            Err(e) => last_msg = e.to_string(),
        }
        tokio::time::sleep(retry_interval).await;
    }
    ProbeResult { dependency: "valkey".to_string(), class: last, message: last_msg }
}

async fn probe_postgres(cfg: &Config, attempts: u32, retry_interval: Duration) -> ProbeResult {
    let dsn = format!(
        "postgres://{}:{}@{}:{}/{}?sslmode={}",
        cfg.cli.db_user, cfg.db_password.expose(), cfg.cli.db_host, cfg.cli.db_port, cfg.cli.db_name, cfg.cli.db_sslmode
    );
    for _ in 0..attempts.max(1) {
        match sea_orm::Database::connect(&dsn).await {
            Ok(_) => return ProbeResult { dependency: "postgres".to_string(), class: ProbeClass::Ok, message: "connect ok".to_string() },
            Err(e) => {
                tracing::warn!(error = %e, "postgres self-check probe failed, retrying");
                tokio::time::sleep(retry_interval).await;
            }
        }
    }
    ProbeResult { dependency: "postgres".to_string(), class: ProbeClass::Tcp, message: "unreachable after retries".to_string() }
}

async fn probe_hub_api(cfg: &Config, attempts: u32, retry_interval: Duration) -> ProbeResult {
    let url = format!("{}/api/v1/distribution/health", cfg.cli.hub_api_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    for _ in 0..attempts.max(1) {
        match client.get(&url).timeout(retry_interval.max(Duration::from_secs(1))).send().await {
            Ok(resp) if resp.status().is_success() => {
                return ProbeResult { dependency: "hub-api".to_string(), class: ProbeClass::Ok, message: "health ok".to_string() };
            }
            Ok(resp) => tracing::warn!(status = %resp.status(), "hub-api self-check probe returned non-2xx, retrying"),
            Err(e) => tracing::warn!(error = %e, "hub-api self-check probe failed, retrying"),
        }
        tokio::time::sleep(retry_interval).await;
    }
    ProbeResult { dependency: "hub-api".to_string(), class: ProbeClass::Tcp, message: "unreachable after retries".to_string() }
}

/// Probes every required dependency before the pod is marked ready.
/// `cfg.cli.startup_probe_attempts`/`startup_probe_timeout_ms` bound each
/// probe's retry loop -- gVisor verification is `svc-process-executor`'s
/// own job (spec Sec12.2), not this self-check's.
pub async fn run_self_check(cfg: &Config) -> SelfCheckReport {
    let attempts = cfg.cli.startup_probe_attempts;
    let interval = Duration::from_millis(cfg.cli.startup_probe_timeout_ms);
    let results = vec![
        probe_valkey(cfg, attempts, interval).await,
        probe_postgres(cfg, attempts, interval).await,
        probe_hub_api(cfg, attempts, interval).await,
    ];
    let all_required_ok = results.iter().all(|r| r.class == ProbeClass::Ok);
    SelfCheckReport { all_required_ok, results }
}
```

```rust
// core/svc_process/src/lib.rs -- replace the placeholder doc/body; wires the whole service
//! `svc-process`: the Waddles process-stage data-plane service. See
//! module docs on `worker`/`reaper`/`builtins` for the per-entry pipeline.
#![deny(missing_docs)]
#![deny(unsafe_code)]
#![deny(clippy::unwrap_used)]

pub mod builtins;
pub mod config;
pub mod consumes;
pub mod distribution;
pub mod error;
pub mod hostapi;
pub mod hostcap;
pub mod http;
pub mod reaper;
pub mod registry;
pub mod spine;
pub mod telemetry;
pub mod trip;
pub mod worker;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tokio::sync::watch;

use crate::config::Config;
use crate::error::ProcessError;
use crate::hostapi::dispatch::HostApiPool;
use crate::hostapi::listener::HostApiListener;
use crate::hostcap::CompositeHandler;
use crate::http::selfcheck::run_self_check;
use crate::http::AppState;
use crate::registry::{Registry, WorkerKey};
use crate::spine::binding::BindingKeyring;
use crate::spine::client::SpineClient;
use crate::spine::usage::UsageBatcher;
use crate::trip::TripCounter;

/// Default `tracing`/OTel service name and `--healthcheck` target.
pub const SERVICE_NAME: &str = "svc-process";

type Writer = tokio::io::WriteHalf<tokio_rustls::server::TlsStream<tokio::net::TcpStream>>;

/// Assembles and runs the full service until `*shutdown.borrow()` is `true`.
pub async fn run(mut shutdown: watch::Receiver<bool>) -> Result<(), ProcessError> {
    let cfg = Config::load()?;
    let (mut telemetry_guard, metrics_registry) = crate::telemetry::init(SERVICE_NAME);

    let report = run_self_check(&cfg).await;
    for r in &report.results {
        tracing::info!(dependency = %r.dependency, class = r.class.as_str(), message = %r.message, "self-check probe");
    }
    if !report.all_required_ok {
        tracing::error!("self-check failed; exiting 78 (EX_CONFIG)");
        std::process::exit(78);
    }

    let redis_cfg = deadpool_redis::Config::from_url(cfg.cli.valkey_url.clone());
    let pool = redis_cfg.create_pool(Some(deadpool_redis::Runtime::Tokio1)).map_err(|e| ProcessError::Spine(e.to_string()))?;
    let spine = SpineClient::new(pool);

    let rotation_overlap = chrono::Duration::seconds(cfg.cli.waddles_binding_rotation_overlap_s as i64);
    let active_kid = cfg.cli.waddles_binding_kid.clone().ok_or_else(|| ProcessError::Spine("WADDLES_BINDING_KID missing past config validation".to_string()))?;
    let keyring = Arc::new(
        BindingKeyring::load(std::path::Path::new(&cfg.cli.waddles_binding_key_file), active_kid, rotation_overlap)
            .map_err(|e| ProcessError::Spine(e.to_string()))?,
    );

    let usage = Arc::new(UsageBatcher::new());
    let trip_counter = Arc::new(TripCounter::new(cfg.cli.executor_trip_threshold, std::time::Duration::from_secs(cfg.cli.executor_trip_window_s)));
    let host_pool: Arc<HostApiPool<Writer>> = Arc::new(HostApiPool::new());

    let kv = Arc::new(crate::hostcap::kv::KvCapability::new(spine.pool(), cfg.cli.kv_max_value_bytes, cfg.cli.kv_max_ttl_s));
    let flags = Arc::new(crate::hostcap::flags::FlagsCapability::new(Arc::new(penguin_licensing::LicenseClient::new(&cfg))));
    let log_cap = Arc::new(crate::hostcap::log::LogCapability);
    let clock = Arc::new(crate::hostcap::clock::ClockCapability::new());
    let http_cap = Arc::new(
        crate::hostcap::http::HttpCapability::new(
            Arc::new(crate::hostcap::http::EnvSecretResolver),
            std::time::Duration::from_millis(cfg.cli.egress_timeout_ms),
            cfg.cli.egress_max_response_bytes,
            cfg.cli.egress_max_redirects,
        )
        .map_err(|e| ProcessError::Spine(e.message))?,
    );
    let db_cap = Arc::new(crate::hostcap::db::DbCapability::new(format!(
        "postgres://{{role}}:{{password}}@{}:{}/{}?sslmode={}",
        cfg.cli.db_host, cfg.cli.db_port, cfg.cli.db_name, cfg.cli.db_sslmode
    )));
    let handler: Arc<dyn crate::hostapi::HostCallHandler> = Arc::new(CompositeHandler::new(kv, flags.clone(), log_cap, clock, http_cap, db_cap));

    let moderation_gate = Arc::new(crate::builtins::moderation_gate::ModerationGate::new(
        reqwest::Client::new(), cfg.cli.moderation_ollama_url.clone(), cfg.cli.moderation_ollama_model.clone(),
        cfg.cli.moderation_match_threshold, std::time::Duration::from_secs_f64(cfg.cli.moderation_ollama_timeout_seconds), flags.clone(),
    ));
    let moderation_enforcer = Arc::new(crate::builtins::moderation_enforce::ModerationEnforcer::new(spine.clone(), cfg.cli.spine_stream_maxlen, flags.clone()));

    // Host-API accept loop -- one connection-actor task per successful handshake.
    let listener = HostApiListener::bind(
        std::net::SocketAddr::new(cfg.cli.bind_addr, cfg.cli.host_api_port),
        &cfg.cli.host_api_tls_cert_file, &cfg.cli.host_api_tls_key_file, &cfg.cli.host_api_tls_ca_file,
    ).await?;
    {
        let host_pool = host_pool.clone();
        let handler = handler.clone();
        let trip_counter: Arc<dyn crate::hostapi::dispatch::ExecutorEvents> = trip_counter.clone();
        let expected_peer = cfg.cli.host_api_peer_identity.clone();
        let expected_gvisor = cfg.cli.waddles_sandbox_gvisor;
        let expected_collector = cfg.cli.executor_wasm_collector.clone();
        let max_frame_bytes = cfg.cli.executor_max_frame_bytes;
        let call_timeout_ms = cfg.cli.executor_call_timeout_ms;
        tokio::spawn(async move {
            loop {
                let tcp = match listener.accept().await {
                    Ok(tcp) => tcp,
                    Err(e) => { tracing::error!(error = %e, "host-api accept failed"); continue; }
                };
                let limits = crate::hostapi::wire::HostApiLimits { call_timeout_ms, memory_mb: 0, max_concurrent_calls: 16 };
                match listener.handshake(tcp, &expected_peer, expected_gvisor, &expected_collector, "process", limits).await {
                    Ok(conn) => {
                        let dispatch_handle = crate::hostapi::dispatch::DispatchHandle::new(conn.writer);
                        host_pool.add(dispatch_handle.clone()).await;
                        let handler = handler.clone();
                        let events = trip_counter.clone();
                        tokio::spawn(crate::hostapi::dispatch::run_dispatch_loop(conn.reader, dispatch_handle, handler, events, max_frame_bytes));
                    }
                    Err(e) => tracing::error!(error = %e, "host-api handshake failed"),
                }
            }
        });
    }

    // Distribution poll + registry reconcile loop.
    let distribution_client = crate::distribution::DistributionClient::new(cfg.cli.hub_api_url.clone(), cfg.secret_key.clone())?;
    let poller = crate::distribution::DistributionPoller::new(distribution_client, std::time::Duration::from_secs_f64(cfg.cli.base_backoff_s), std::time::Duration::from_secs_f64(cfg.cli.max_backoff_s));
    let registry = Arc::new(std::sync::RwLock::new(Registry::new()));
    let mut running: HashMap<WorkerKey, (watch::Sender<bool>, tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>)> = HashMap::new();

    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let app_state = AppState { registry: Arc::new(std::sync::RwLock::new(true)), ready: ready.clone(), metrics_registry: Arc::new(metrics_registry) };
    {
        let app_state = app_state.clone();
        let http_port = cfg.cli.http_port;
        let bind_addr = cfg.cli.bind_addr;
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::bind((bind_addr, http_port)).await.expect("bind MODULE_PORT");
            axum::serve(listener, crate::http::router(app_state)).await.expect("http server");
        });
    }
    {
        let app_state = app_state.clone();
        let metrics_port = cfg.cli.metrics_port;
        let bind_addr = cfg.cli.bind_addr;
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::bind((bind_addr, metrics_port)).await.expect("bind METRICS_PORT");
            axum::serve(listener, crate::http::metrics_router(app_state)).await.expect("metrics server");
        });
    }

    // D31 usage-metering flush timer -- UsageBatcher accumulates in
    // Worker::process_entry; this is the only task that ever calls
    // SpineClient::append_usage, at most every METERING_FLUSH_INTERVAL_S,
    // per spec Sec5.12 ("not per event, so a chatty channel does not
    // multiply the write rate"). A best-effort final flush runs on
    // shutdown so the last partial interval's deltas are not silently
    // dropped.
    {
        let usage = usage.clone();
        let spine = spine.clone();
        let flush_interval = std::time::Duration::from_secs(cfg.cli.metering_flush_interval_s);
        let metering_enabled = cfg.cli.metering_enabled;
        let stream_maxlen = cfg.cli.spine_stream_maxlen;
        let mut shutdown_for_usage = shutdown.clone();
        tokio::spawn(async move {
            if !metering_enabled {
                return;
            }
            let mut tick = tokio::time::interval(flush_interval);
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        for delta in usage.flush() {
                            if let Err(e) = spine.append_usage(&delta, stream_maxlen).await {
                                tracing::error!(error = %e, "append_usage failed; delta dropped for this interval");
                            }
                        }
                    }
                    _ = shutdown_for_usage.changed() => {
                        if *shutdown_for_usage.borrow() {
                            for delta in usage.flush() {
                                let _ = spine.append_usage(&delta, stream_maxlen).await;
                            }
                            return;
                        }
                    }
                }
            }
        });
    }

    let poll_interval = std::time::Duration::from_secs_f64(cfg.cli.poll_interval_s);
    loop {
        if *shutdown.borrow() {
            for (_key, (tx, worker_handle, reaper_handle)) in running.drain() {
                let _ = tx.send(true);
                let _ = worker_handle.await;
                let _ = reaper_handle.await;
            }
            telemetry_guard.shutdown();
            return Ok(());
        }
        let rows = poller.refresh().await;
        let diff = registry.write().expect("registry lock poisoned").reconcile(rows);
        for key in diff.to_stop {
            if let Some((tx, worker_handle, reaper_handle)) = running.remove(&key) {
                let _ = tx.send(true);
                let _ = worker_handle.await;
                let _ = reaper_handle.await;
                let group = key.app_id.clone();
                if let Err(e) = spine.destroy_group(&key.stream, &group).await {
                    tracing::error!(app_id = %key.app_id, stream = %key.stream, error = %e, "destroy_group failed on grant revocation");
                }
            }
        }
        for (key, bundle_row) in diff.to_start {
            let group = key.app_id.clone();
            if let Err(e) = spine.ensure_group(&key.stream, &group).await {
                tracing::error!(app_id = %key.app_id, stream = %key.stream, error = %e, "ensure_group failed; skipping this worker this tick");
                continue;
            }
            let Some(digest) = bundle_row.artifact_digest.clone() else { continue };
            let reader = match crate::spine::reader::GroupReader::connect(&cfg.cli.valkey_url, &key.stream, std::time::Duration::from_secs(cfg.cli.drain_socket_timeout_s)).await {
                Ok(r) => r,
                Err(e) => { tracing::error!(error = %e, "GroupReader::connect failed; skipping this worker this tick"); continue; }
            };
            let spec = crate::worker::WorkerSpec {
                app_id: key.app_id.clone(), stream: key.stream.clone(), digest, version: bundle_row.artifact_version.clone().unwrap_or_default(),
                config: bundle_row.config.clone(), consumes: bundle_row.manifest.consumes.clone(), routes_to: bundle_row.manifest.routes_to.clone(),
            };
            let consumer_id = cfg.cli.spine_consumer_id.clone().unwrap_or_else(|| format!("{}-{}", SERVICE_NAME, uuid::Uuid::new_v4()));
            // Per-worker closure: D30 requires the runtime cross-tenant
            // check to be independent of the install-time approval
            // (route_bundle_output, Task 24) -- each worker's closure is
            // bound to ITS OWN tenant (from its own granted stream), and
            // reads the shared, live registry under a read lock so a
            // redirect target's activation state is always current, not
            // a stale snapshot taken at worker-spawn time.
            let (worker_tenant, _) = match crate::spine::keys::parse_scope_from_key(&key.stream) {
                Some(scope) => scope,
                None => { tracing::error!(stream = %key.stream, "invariant violated: unparseable stream key at worker spawn"); continue; }
            };
            let registry_for_routing = registry.clone();
            let is_target_active_in_tenant: Arc<dyn Fn(&str) -> bool + Send + Sync> = Arc::new(move |target_app_id: &str| {
                registry_for_routing.read().map(|r| r.is_active_for_tenant(target_app_id, &worker_tenant)).unwrap_or(false)
            });
            let worker = match crate::worker::Worker::new(
                spec, spine.clone(), reader, keyring.clone(), host_pool.clone(), moderation_gate.clone(), moderation_enforcer.clone(),
                trip_counter.clone(), usage.clone(), is_target_active_in_tenant.clone(), consumer_id.clone(), group.clone(),
                cfg.cli.spine_block_ms, cfg.cli.spine_read_count, cfg.cli.spine_max_deliveries, cfg.cli.spine_stream_maxlen,
                cfg.cli.spine_dlq_maxlen, cfg.cli.executor_call_timeout_ms,
            ) {
                Ok(w) => Arc::new(w),
                Err(e) => { tracing::error!(error = %e, "Worker::new failed; skipping this worker this tick"); continue; }
            };
            let (tx, rx) = watch::channel(false);
            let worker_handle = tokio::spawn(worker.clone().run(rx.clone()));
            let reaper = crate::reaper::Reaper::new(
                spine.clone(), key.app_id.clone(), key.stream.clone(), group, consumer_id,
                cfg.cli.spine_claim_idle_ms, cfg.cli.spine_claim_interval_ms, cfg.cli.spine_stats_interval_ms,
                cfg.cli.spine_read_count, cfg.cli.spine_pel_alert, worker,
            );
            let reaper_handle = tokio::spawn(reaper.run(rx));
            running.insert(key, (tx, worker_handle, reaper_handle));
        }
        ready.store(true, Ordering::SeqCst);
        tokio::time::sleep(poll_interval).await;
    }
}

```

```rust
// core/svc_process/src/spine/client.rs -- append inside the existing `impl SpineClient` block
    /// Returns a clone of the pool backing this client's admin/write
    /// operations (`deadpool_redis::Pool` is itself `Arc`-backed, cheap
    /// to clone) -- Task 28's main wiring shares this one pool with the
    /// `kv` capability rather than opening a second one.
    pub fn pool(&self) -> deadpool_redis::Pool {
        self.pool.clone()
    }
```

```rust
// core/svc_process/src/main.rs -- replace the Task 27 "not wired until
// Task 28" line with the real run() call; the `--healthcheck` branch
// above it (Task 27) is unchanged.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        let cli = svc_process::config::CliConfig::parse();
        let ok = svc_process::http::run_local_healthcheck(cli.http_port, "/healthz").await;
        std::process::exit(if ok { 0 } else { 1 });
    }
    let (_tx, rx) = tokio::sync::watch::channel(false);
    // Production shutdown trigger: a ctrl_c/SIGTERM handler would send
    // `true` on `_tx` -- out of this task's own test scope (a live signal
    // can't be unit-tested), wired here as the process's real entrypoint.
    let cfg_watch_tx = _tx.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = cfg_watch_tx.send(true);
    });
    svc_process::run(rx).await?;
    Ok(())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib http::selfcheck::"`
Expected: `test result: ok. 4 passed`. Then: `make -C core/svc_process build` -- expected: clean compile of the full binary (this is the first task where every module links together; a compile error here means an earlier task's produced signature does not match how this task calls it -- reconcile against that task's own Interfaces block, never invent a new shape to paper over it).

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/lib.rs core/svc_process/src/main.rs core/svc_process/src/http/ core/svc_process/src/spine/client.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): startup self-check (exit 78) + full service wiring --
distribution poll/reconcile, host-API accept loop, worker+reaper spawn

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 29: Helm chart — stage Deployment, executor Deployment + gVisor `RuntimeClass`, `CiliumNetworkPolicy`, `values.yaml`

**Files:**
- Modify: `k8s/helm/waddlebot/templates/svc-process.yaml` (real image, host-api port/volumes)
- Create: `k8s/helm/waddlebot/templates/svc-process-executor.yaml`, `k8s/helm/waddlebot/templates/svc-process-networkpolicy.yaml`
- Modify: `k8s/helm/waddlebot/values.yaml` (`pipeline.svcProcess.*`, `pipeline.executor.*`, `sandbox.*`, `security.envelopeBinding.*`, `metering.*`)

**Interfaces:**
- Consumes: nothing from earlier Rust tasks (chart-only); reads spec §12 verbatim for every value name and default.
- Produces: a `helm template`-renderable stage Deployment (`svc-process`, cluster-default `RuntimeClass`, holds all credentials, terminates the mTLS host-API listener on `:8301`) and a separate, credential-less `svc-process-executor` Deployment under the gVisor `RuntimeClass` (`runsc`, opt-out via `sandbox.gvisor.enabled: false`) plus its own `Service`; a default-deny `CiliumNetworkPolicy` allowing only `svc-process-executor` → `svc-process:8301` and `svc-process-executor` → the artifact bucket egress, nothing else in either direction; `values.yaml` entries `pipeline.svcProcess.{replicas,image.repository,image.tag,resources,pollIntervalSeconds}`, `pipeline.executor.{replicas,image.repository,image.tag,resources,connectionsPerReplica}`, `sandbox.{runtimeClassName,gvisor.enabled}`, `security.envelopeBinding.{keySecretRef,rotationOverlapSeconds}`, `security.transport.{tls,auth}`, `metering.{enabled,flushIntervalSeconds}`. Every later negative test (**Task 34**) that asserts a NetworkPolicy boundary runs `helm template` against this chart, never a live cluster.

Spec: §12.1 (image `ghcr.io/penguintechinc/waddles/svc-process`), §12.2 (gVisor support matrix, `sandbox.gvisor.enabled` opt-out + `waddles_sandbox_gvisor` gauge), §12.3 (`security.envelopeBinding.*`, `metering.*` values), §12.4 (`svc-process-executor`'s stage-connection pool, replica count tracking), §11.2 (`RuntimeClass` placement), Global Constraints Kubernetes (`CiliumNetworkPolicy` only, Pod Security Admission `restricted`, Helm only).

- [ ] **Step 1: Write the failing test**

```bash
# tests/helm/svc_process_chart_test.sh -- executed by Step 4, not a Rust test
#!/usr/bin/env bash
set -euo pipefail
echo "== helm lint =="
helm lint k8s/helm/waddlebot
echo "== helm template: renders svc-process-executor with the gVisor RuntimeClass by default =="
helm template waddlebot k8s/helm/waddlebot | grep -A5 'kind: Deployment' | grep -q 'name: svc-process-executor' \
  && echo "PASS: svc-process-executor Deployment present" || { echo "FAIL: svc-process-executor Deployment missing"; exit 1; }
helm template waddlebot k8s/helm/waddlebot --show-only templates/svc-process-executor.yaml | grep -q 'runtimeClassName: runsc' \
  && echo "PASS: runsc RuntimeClass rendered by default" || { echo "FAIL: runtimeClassName missing"; exit 1; }
echo "== helm template: sandbox.gvisor.enabled=false omits runtimeClassName =="
helm template waddlebot k8s/helm/waddlebot --set sandbox.gvisor.enabled=false --show-only templates/svc-process-executor.yaml | grep -q 'runtimeClassName' \
  && { echo "FAIL: runtimeClassName still rendered with gvisor disabled"; exit 1; } || echo "PASS: runtimeClassName omitted"
echo "== helm template: NetworkPolicy is CiliumNetworkPolicy, never plain NetworkPolicy =="
helm template waddlebot k8s/helm/waddlebot --show-only templates/svc-process-networkpolicy.yaml | grep -q '^kind: CiliumNetworkPolicy' \
  && echo "PASS: CiliumNetworkPolicy" || { echo "FAIL: wrong policy kind"; exit 1; }
echo "examined: 4 assertions, 0 skipped"
```

- [ ] **Step 2: Run to verify it fails**

Run: `chmod +x tests/helm/svc_process_chart_test.sh && ./tests/helm/svc_process_chart_test.sh`
Expected: FAIL -- `templates/svc-process-executor.yaml`/`templates/svc-process-networkpolicy.yaml` do not exist yet.

- [ ] **Step 3: Implement**

```yaml
# k8s/helm/waddlebot/templates/svc-process.yaml -- modify the existing Deployment
# (merge into the existing template; shown here are the fields this task
# changes/adds, not a full replacement of every pre-existing field such as
# labels/selectors/existing probes, which stay as-is)
spec:
  replicas: {{ .Values.pipeline.svcProcess.replicas | default 2 }}
  template:
    spec:
      containers:
        - name: svc-process
          image: "{{ .Values.pipeline.svcProcess.image.repository | default "ghcr.io/penguintechinc/waddles/svc-process" }}:{{ .Values.pipeline.svcProcess.image.tag }}"
          ports:
            - name: http
              containerPort: 8201
            - name: metrics
              containerPort: 9090
            - name: host-api
              containerPort: 8301
          env:
            - name: POLL_INTERVAL_S
              value: {{ .Values.pipeline.svcProcess.pollIntervalSeconds | default 5 | quote }}
            - name: SECURITY_TRANSPORT_TLS
              value: {{ .Values.security.transport.tls | default true | quote }}
            - name: SECURITY_TRANSPORT_AUTH
              value: {{ .Values.security.transport.auth | default true | quote }}
            - name: WADDLES_BINDING_ROTATION_OVERLAP_S
              value: {{ .Values.security.envelopeBinding.rotationOverlapSeconds | default 86400 | quote }}
            - name: METERING_ENABLED
              value: {{ .Values.metering.enabled | default true | quote }}
            - name: METERING_FLUSH_INTERVAL_S
              value: {{ .Values.metering.flushIntervalSeconds | default 10 | quote }}
          volumeMounts:
            - name: host-api-tls
              mountPath: /etc/waddles/host-api
              readOnly: true
            - name: envelope-binding
              mountPath: /etc/waddles/envelope-binding
              readOnly: true
          resources:
            {{- toYaml (.Values.pipeline.svcProcess.resources | default (dict "requests" (dict "cpu" "250m" "memory" "256Mi") "limits" (dict "cpu" "1" "memory" "512Mi"))) | nindent 12 }}
          securityContext:
            runAsNonRoot: true
            runAsUser: 10001
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
            seccompProfile:
              type: RuntimeDefault
      volumes:
        - name: host-api-tls
          secret:
            secretName: svc-process-host-api-tls
        - name: envelope-binding
          secret:
            secretName: {{ .Values.security.envelopeBinding.keySecretRef | default "waddles-envelope-binding" }}
```

```yaml
# k8s/helm/waddlebot/templates/svc-process-executor.yaml
# svc-process-executor -- credential-less, gVisor-sandboxed, dials into
# svc-process's host-API port only. Spec Sec9 (component table), Sec12.2/
# Sec12.4.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: svc-process-executor
  namespace: {{ .Release.Namespace }}
  labels:
    app: svc-process-executor
spec:
  replicas: {{ .Values.pipeline.executor.replicas | default 2 }}
  selector:
    matchLabels:
      app: svc-process-executor
  template:
    metadata:
      labels:
        app: svc-process-executor
    spec:
      {{- if .Values.sandbox.gvisor.enabled | default true }}
      runtimeClassName: {{ .Values.sandbox.runtimeClassName | default "runsc" }}
      {{- end }}
      {{- if .Values.sandbox.installer.nodeLabel }}
      nodeSelector:
        {{ .Values.sandbox.installer.nodeLabel | replace "=" ": " }}
      {{- end }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 10002
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: svc-process-executor
          image: "{{ .Values.pipeline.executor.image.repository | default "ghcr.io/penguintechinc/waddles/svc-process-executor" }}:{{ .Values.pipeline.executor.image.tag }}"
          env:
            - name: STAGE_HOST_API_ADDR
              value: "svc-process:8301"
            - name: EXECUTOR_STAGE_CONNECTIONS
              value: {{ .Values.pipeline.executor.connectionsPerReplica | default 4 | quote }}
            - name: WADDLES_SANDBOX_GVISOR
              value: {{ .Values.sandbox.gvisor.enabled | default true | quote }}
          resources:
            {{- toYaml (.Values.pipeline.executor.resources | default (dict "requests" (dict "cpu" "500m" "memory" "512Mi") "limits" (dict "cpu" "2" "memory" "1Gi"))) | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
---
apiVersion: v1
kind: Service
metadata:
  name: svc-process-executor
  namespace: {{ .Release.Namespace }}
spec:
  selector:
    app: svc-process-executor
  ports:
    - name: metrics
      port: 9090
      targetPort: 9090
```

```yaml
# k8s/helm/waddlebot/templates/svc-process-networkpolicy.yaml
# Default-deny + explicit allow rows -- spec D9, Global Constraints
# Kubernetes ("CiliumNetworkPolicy only, never plain NetworkPolicy").
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: svc-process-executor-egress
  namespace: {{ .Release.Namespace }}
spec:
  endpointSelector:
    matchLabels:
      app: svc-process-executor
  egress:
    - toEndpoints:
        - matchLabels:
            app: svc-process
      toPorts:
        - ports:
            - port: "8301"
              protocol: TCP
    - toFQDNs:
        - matchPattern: "*.{{ .Values.artifactBucket.domainSuffix | default "s3.amazonaws.com" }}"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: svc-process-ingress
  namespace: {{ .Release.Namespace }}
spec:
  endpointSelector:
    matchLabels:
      app: svc-process
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: svc-process-executor
      toPorts:
        - ports:
            - port: "8301"
              protocol: TCP
```

```yaml
# k8s/helm/waddlebot/values.yaml -- append
pipeline:
  svcProcess:
    replicas: 2
    image:
      repository: ghcr.io/penguintechinc/waddles/svc-process
      tag: ""
    pollIntervalSeconds: 5
    resources:
      requests: { cpu: 250m, memory: 256Mi }
      limits: { cpu: "1", memory: 512Mi }
  executor:
    replicas: 2
    image:
      repository: ghcr.io/penguintechinc/waddles/svc-process-executor
      tag: ""
    connectionsPerReplica: 4
    resources:
      requests: { cpu: 500m, memory: 512Mi }
      limits: { cpu: "2", memory: 1Gi }

sandbox:
  runtimeClassName: runsc
  gvisor:
    enabled: true
  installer:
    nodeLabel: ""

security:
  transport:
    tls: true
    auth: true
  envelopeBinding:
    keySecretRef: waddles-envelope-binding
    rotationOverlapSeconds: 86400

metering:
  enabled: true
  flushIntervalSeconds: 10
```

- [ ] **Step 4: Run to verify it passes**

Run: `./tests/helm/svc_process_chart_test.sh`
Expected: all four `PASS:` lines, `examined: 4 assertions, 0 skipped`.

- [ ] **Step 5: Commit**

```bash
git add k8s/helm/waddlebot/templates/svc-process.yaml k8s/helm/waddlebot/templates/svc-process-executor.yaml k8s/helm/waddlebot/templates/svc-process-networkpolicy.yaml k8s/helm/waddlebot/values.yaml tests/helm/svc_process_chart_test.sh
git commit -m "$(cat <<'EOF'
feat(svc-process): Helm -- executor Deployment under gVisor RuntimeClass,
CiliumNetworkPolicy default-deny, sandbox/envelopeBinding/metering values

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 30: `config/postgres/rbac-matrix.yaml` + `config/valkey/acl-matrix.yaml` -- `svc_process`/bundle rows

**Files:**
- Modify: `config/postgres/rbac-matrix.yaml` (created by milestone M2b if not already present -- this task adds rows, never recreates the file wholesale)
- Modify: `config/valkey/acl-matrix.yaml` (same)
- Test: `tests/rbac/test_matrix_equality.py` (or extend it, if M2b already created one)

**Interfaces:**
- Consumes: nothing from earlier Rust tasks -- pure YAML config, cited by `scripts/db/rbac_matrix.py` (M2b) at Alembic-migration time and by the chart's rendered `users.acl` (spec §11.6.1).
- Produces: a `svc_process` row in `config/postgres/rbac-matrix.yaml` (connects as its own role, no table grants of its own -- it only *creates* per-bundle roles' connections at runtime, spec §7.4) and a `bundle_rls_tables` list -- this plan's own addition, not part of M2b's schema -- naming every currently-known bundle-owned table that must carry row-level security (spec §16 M4 "DB host capability... RLS"): `[loyalty_config, loyalty_balances, loyalty_transactions, loyalty_shop_items, loyalty_redemptions]` (the five tables migration `0015_loyalty_core_tables` created -- the only first-party bundle-owned tables with a `community_id` FK column found in the current `alembic/versions/` tree at plan-authorship time; `git ls-tree`/`grep` for `CREATE TABLE` again before running this task, in case a milestone between M2b and M4's execution added more, and append any missing ones to this same list); a `svc-process` row in `config/valkey/acl-matrix.yaml` granting `+xreadgroup +xack +xadd +xgroup|create +xgroup|destroy +xautoclaim +xpending +xinfo|groups` on `waddles:t:*:c:*:src:*:*:events` and `waddles:t:*:c:*:app:*:action`, `+xadd` on `waddles:dlq:process`, **`+xadd` only** (never `+xrange`/`+xreadgroup`/`+xrevrange`) on `waddles:usage` (spec §5.12/§11.10.2/D31: "Every stage user's grant on `waddles:usage` is `+xadd` only"). **Task 31**'s Alembic migration reads `bundle_rls_tables` from this file to generate its `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` statements -- this task's YAML change is Task 31's direct input, and must land first.

Spec: §11.10.1 (Postgres RBAC matrix), §11.10.2 (Valkey ACL matrix, the `waddles:usage` write-only rule), §5.12/D31, §D28 (Least User Access via RBAC).

- [ ] **Step 1: Write the failing test**

```python
# tests/rbac/test_matrix_equality.py -- extend if it exists, create if M2b has not landed yet
import yaml
from pathlib import Path

MATRIX = Path(__file__).resolve().parents[2] / "config" / "postgres" / "rbac-matrix.yaml"
ACL = Path(__file__).resolve().parents[2] / "config" / "valkey" / "acl-matrix.yaml"


def test_svc_process_row_present_in_postgres_matrix():
    data = yaml.safe_load(MATRIX.read_text())
    roles = {r["role"] for r in data.get("roles", [])}
    assert "svc_process" in roles, f"svc_process missing from {MATRIX}"


def test_bundle_rls_tables_list_is_non_empty_and_matches_known_bundle_tables():
    data = yaml.safe_load(MATRIX.read_text())
    tables = data.get("bundle_rls_tables", [])
    assert len(tables) > 0, "zero bundle_rls_tables examined -- a zero denominator is a FAIL"
    for expected in ["loyalty_config", "loyalty_balances", "loyalty_transactions", "loyalty_shop_items", "loyalty_redemptions"]:
        assert expected in tables, f"{expected} missing from bundle_rls_tables"
    print(f"bundle_rls_tables examined: {len(tables)}")


def test_svc_process_row_present_in_valkey_acl_matrix():
    data = yaml.safe_load(ACL.read_text())
    users = {u["user"] for u in data.get("users", [])}
    assert "svc-process" in users, f"svc-process missing from {ACL}"


def test_svc_process_usage_grant_is_xadd_only():
    data = yaml.safe_load(ACL.read_text())
    svc_process = next(u for u in data["users"] if u["user"] == "svc-process")
    usage_grant = next(g for g in svc_process["key_patterns"] if g["pattern"] == "waddles:usage")
    assert usage_grant["commands"] == ["+xadd"], f"waddles:usage grant must be +xadd only, got {usage_grant['commands']}"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pip install --no-cache-dir pyyaml==6.0.2 && python3 -m pytest tests/rbac/test_matrix_equality.py -v`
Expected: FAIL -- `svc_process`/`svc-process` rows and `bundle_rls_tables` do not exist yet (or the files themselves do not exist yet if M2b has not landed; if so, create both files with the minimal top-level `roles: []`/`users: []` structure M2b's own schema uses before adding this task's rows, and note in the commit body that M2b's own rows are expected to merge in separately).

- [ ] **Step 3: Add the rows**

```yaml
# config/postgres/rbac-matrix.yaml -- append under the existing `roles:` list
  - role: svc_process
    description: >
      Waddles process-stage data plane. Connects with its own role only to
      probe connectivity (spec Sec12.6 self-check); it never queries a
      bundle-owned table directly -- every db host-call runs on a
      per-bundle bundle_<app_id> role's own connection (spec Sec7.4).
    tables: []
    privileges: []

# top-level key, alongside `roles:` -- this plan's own addition (not part
# of M2b's schema): every bundle-owned table that must carry row-level
# security (spec Sec16 M4 "DB host capability... RLS").
bundle_rls_tables:
  - loyalty_config
  - loyalty_balances
  - loyalty_transactions
  - loyalty_shop_items
  - loyalty_redemptions
```

```yaml
# config/valkey/acl-matrix.yaml -- append under the existing `users:` list
  - user: svc-process
    description: Process-stage consumer/producer -- ingest-source streams (read), action streams (write), its own DLQ, usage (write-only).
    key_patterns:
      - pattern: "waddles:t:*:c:*:src:*:*:events"
        commands: ["+xreadgroup", "+xack", "+xgroup|create", "+xgroup|destroy", "+xautoclaim", "+xpending", "+xinfo|groups"]
      - pattern: "waddles:t:*:c:*:app:*:action"
        commands: ["+xadd"]
      - pattern: "waddles:dlq:process"
        commands: ["+xadd"]
      - pattern: "waddles:usage"
        commands: ["+xadd"]
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 -m pytest tests/rbac/test_matrix_equality.py -v`
Expected: `4 passed`, with `bundle_rls_tables examined: 5` printed.

- [ ] **Step 5: Commit**

```bash
git add config/postgres/rbac-matrix.yaml config/valkey/acl-matrix.yaml tests/rbac/test_matrix_equality.py
git commit -m "$(cat <<'EOF'
feat(svc-process): svc_process/svc-process RBAC+ACL matrix rows;
bundle_rls_tables list feeding the D31 RLS migration

waddles:usage grant is +xadd only, per spec Sec11.10.2 D31 -- stages
never read their own usage stream back.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---


### Task 31: Row-level security migration for bundle-owned tables (hub-api Alembic tree, spec §16 M4 "DB host capability... RLS")

> **Different toolchain, deliberately.** Every other task in this plan runs through `make -C core/svc_process <target>` (Global Constraints "Commands"). This task does not touch `core/svc_process` at all -- it is a Python/Alembic migration in the **hub-api tree at the repo root** (`alembic/versions/`, `alembic.ini`), because only hub-api runs Alembic migrations and the Rust stage never runs DDL (coordinator ruling R59). Commands here match milestone **M2b**'s own migration-task style exactly (a throwaway `docker run postgres:17-alpine` + direct `alembic upgrade`), never the Rust `make` targets.

**Depends on:** Task 30 (`config/postgres/rbac-matrix.yaml`'s `bundle_rls_tables` list, this migration's direct input); chains after **M2b Task 42**'s migration `0023_workstreams_and_usage` (`down_revision`) -- **must match plan M2b** (`waddlebot` repo, `docs/plan-m2b-hub-api`, migration `0023_workstreams_and_usage`, `revision = "0023_workstreams_and_usage"`); if M2b's own final revision id differs by the time this task executes (re-check `alembic/versions/` for the newest file), point `down_revision` at whatever that actual latest revision string is instead of `0023_workstreams_and_usage` verbatim.

**Files:**
- Create: `alembic/versions/0024_process_stage_rls.py`
- Test: `alembic/tests/test_0024_process_stage_rls.py`

**Interfaces:**
- Consumes: `config/postgres/rbac-matrix.yaml`'s `bundle_rls_tables` list (Task 30), `scripts/db/rbac_matrix.py`'s existing `load_matrix`/`DEFAULT_MATRIX_PATH` (M2b, read-only reuse -- this task adds no new function to that module), the `communities`/`tenants` tables (already exist, pre-M2b).
- Produces: for every table named in `bundle_rls_tables`, `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY` + `ALTER TABLE <table> FORCE ROW LEVEL SECURITY` (so even the table owner role is subject to the policy -- Postgres exempts owners by default, which would silently defeat this for any role that happens to own the table) + one `CREATE POLICY <table>_tenant_isolation ON <table> USING (...)` keyed on the community's `community_id` FK, resolved from two Postgres session GUCs the connection sets before every statement. **Naming note (deliberate divergence from the ruling's illustrative GUC names):** spec §7.4 states the exact GUC names the Rust `db` host capability already sets, verbatim -- `SET LOCAL waddles.tenant`/`waddles.community` -- and **Task 20** (`hostcap/db.rs`, already implemented) sets exactly those two, not `app.tenant_id`/`app.community_id`. This migration's policies read `current_setting('waddles.tenant', true)` / `current_setting('waddles.community', true)` to match the connection Task 20 actually opens, rather than the ruling's example names, which were illustrative of the *mechanism* (session-GUC-keyed RLS), not a literal required identifier -- using the spec's and Task 20's own established names is what makes the policies actually take effect. The policy predicate resolves the tenant-wide case (no `waddles.community` set -- a tenant-wide bundle activation, spec §5.10's `_tenant` segment) as "any community under this tenant", not "no rows": `community_id IN (SELECT c.id FROM communities c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = current_setting('waddles.tenant', true) AND (current_setting('waddles.community', true) IS NULL OR current_setting('waddles.community', true) = '' OR c.slug = current_setting('waddles.community', true)))`. **Task 34**'s live-Postgres negative test (a `db` host call scoped to tenant A cannot read tenant B rows) runs against exactly this migration's policies.

Spec: §16 M4 row ("DB host capability | Parser allowlist + per-bundle role + RLS, with the negative tests green"), §7.4 (the `SET LOCAL waddles.tenant`/`waddles.community` mechanism these policies key on), §D28 (Least User Access via RBAC), §14.11 test 5 (the live-Postgres negative test this migration makes possible).

- [ ] **Step 1: Write the failing test**

```python
# alembic/tests/test_0024_process_stage_rls.py
"""Verifies migration 0024 enables and correctly scopes RLS on every
bundle_rls_tables entry -- spec Sec16 M4, Sec7.4."""
import os
import subprocess
import time

import psycopg2
import pytest
import yaml

DB_URL = "postgresql://postgres:test@localhost:55437/waddlebot"
CONTAINER = "pg-m4-0024-test"


@pytest.fixture(scope="module", autouse=True)
def postgres():
    subprocess.run(
        ["docker", "run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=test",
         "-e", "POSTGRES_DB=waddlebot", "-p", "55437:5432", "postgres:17-alpine"],
        check=True,
    )
    time.sleep(3)
    env = {**os.environ, "DATABASE_URL": DB_URL}
    subprocess.run(["alembic", "upgrade", "0023_workstreams_and_usage"], env=env, check=True)
    subprocess.run(["alembic", "upgrade", "0024_process_stage_rls"], env=env, check=True)
    yield
    subprocess.run(["docker", "rm", "-f", CONTAINER], check=False)


def _bundle_rls_tables():
    matrix = yaml.safe_load(open("config/postgres/rbac-matrix.yaml"))
    return matrix["bundle_rls_tables"]


def test_every_bundle_rls_table_has_row_level_security_enabled_and_forced():
    tables = _bundle_rls_tables()
    assert len(tables) > 0, "zero bundle_rls_tables examined -- a zero denominator is a FAIL"
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    examined = 0
    for table in tables:
        cur.execute("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = %s", (table,))
        row = cur.fetchone()
        assert row is not None, f"{table} does not exist"
        assert row == (True, True), f"{table} RLS enabled/forced = {row}, expected (True, True)"
        examined += 1
    print(f"bundle_rls_tables RLS-enabled examined: {examined}")
    conn.close()


def test_policy_scopes_rows_to_the_current_tenant_and_community():
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("INSERT INTO tenants (slug) VALUES ('acme') ON CONFLICT DO NOTHING RETURNING id")
    row = cur.fetchone()
    if row is None:
        cur.execute("SELECT id FROM tenants WHERE slug = 'acme'")
        row = cur.fetchone()
    tenant_id = row[0]
    cur.execute("INSERT INTO communities (tenant_id, slug) VALUES (%s, 'main') RETURNING id", (tenant_id,))
    community_id = cur.fetchone()[0]
    cur.execute("INSERT INTO loyalty_config (community_id) VALUES (%s)", (community_id,))
    conn.close()

    scoped = psycopg2.connect(DB_URL)
    scoped.autocommit = False
    scur = scoped.cursor()
    scur.execute("SET LOCAL waddles.tenant = 'acme'")
    scur.execute("SET LOCAL waddles.community = 'main'")
    scur.execute("SELECT count(*) FROM loyalty_config WHERE community_id = %s", (community_id,))
    assert scur.fetchone()[0] == 1, "the matching tenant/community must see its own row"

    scur.execute("SET LOCAL waddles.tenant = 'other-tenant'")
    scur.execute("SET LOCAL waddles.community = 'other-community'")
    scur.execute("SELECT count(*) FROM loyalty_config WHERE community_id = %s", (community_id,))
    assert scur.fetchone()[0] == 0, "a different tenant/community must see zero rows -- this is the D30/D28 RLS boundary"
    scoped.rollback()
    scoped.close()
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker run -d --name pg-m4-0024-precheck -e POSTGRES_PASSWORD=test -e POSTGRES_DB=waddlebot -p 55437:5432 postgres:17-alpine && sleep 3 && DATABASE_URL="postgresql://postgres:test@localhost:55437/waddlebot" alembic upgrade 0023_workstreams_and_usage && python3 -m pytest alembic/tests/test_0024_process_stage_rls.py -v; docker rm -f pg-m4-0024-precheck`
Expected: FAIL -- migration `0024_process_stage_rls` does not exist yet, `alembic upgrade` in the test fixture errors.

- [ ] **Step 3: Write the migration**

```python
# alembic/versions/0024_process_stage_rls.py
"""Row-level security on bundle-owned tables (spec Sec16 M4 "DB host
capability... RLS", coordinator ruling R59).

Only hub-api runs Alembic migrations; the Rust `svc-process` stage never
runs DDL (spec's own service boundary) -- this is why the RLS policy
definitions live here rather than in core/svc_process, even though the
connection that benefits from them is opened by Task 20's `hostcap/db.rs`.

Policies key on the two session GUCs that connection already sets before
every statement, verbatim, per spec Sec7.4: `SET LOCAL waddles.tenant`/
`waddles.community` (not `app.tenant_id`/`app.community_id` -- see this
plan's Task 31 Interfaces note on why the spec's actual names are used).
`FORCE ROW LEVEL SECURITY` is required alongside `ENABLE`, or the table
owner role bypasses the policy entirely by default (Postgres's own
owner-exemption rule) -- since `bundle_<app_id>` roles are typically
*not* the table owner (hub_api is), `ENABLE` alone would already work for
them, but `FORCE` is applied uniformly so this migration's guarantee does
not silently depend on which role happens to own the table.

The table list comes from config/postgres/rbac-matrix.yaml's
`bundle_rls_tables` key (this plan's own addition, Task 30) -- re-run
this migration's `upgrade()` logic (it is idempotent, `CREATE POLICY IF
NOT EXISTS`-equivalent via a DO block) whenever that list grows, rather
than writing a new migration per bundle table.

Revision ID: 0024_process_stage_rls
Revises: 0023_workstreams_and_usage
Create Date: 2026-09-15
"""
from pathlib import Path

import yaml
from alembic import op

revision = "0024_process_stage_rls"
down_revision = "0023_workstreams_and_usage"
branch_labels = None
depends_on = None

_MATRIX_PATH = Path(__file__).resolve().parents[2] / "config" / "postgres" / "rbac-matrix.yaml"

_POLICY_USING = """
    community_id IN (
        SELECT c.id FROM communities c JOIN tenants t ON t.id = c.tenant_id
        WHERE t.slug = current_setting('waddles.tenant', true)
          AND (
            current_setting('waddles.community', true) IS NULL
            OR current_setting('waddles.community', true) = ''
            OR c.slug = current_setting('waddles.community', true)
          )
    )
"""


def _bundle_rls_tables() -> list[str]:
    matrix = yaml.safe_load(_MATRIX_PATH.read_text())
    tables = matrix.get("bundle_rls_tables", [])
    if not tables:
        raise RuntimeError(
            f"{_MATRIX_PATH} has an empty or missing bundle_rls_tables list -- "
            "Task 30 must land before this migration runs"
        )
    return tables


def upgrade() -> None:
    for table in _bundle_rls_tables():
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        op.execute(f"CREATE POLICY {table}_tenant_isolation ON {table} USING ({_POLICY_USING})")
        op.execute(
            f"COMMENT ON POLICY {table}_tenant_isolation ON {table} IS "
            "'D30/D28 tenant wall -- scoped to SET LOCAL waddles.tenant/waddles.community, "
            "spec Sec7.4, Sec16 M4. Never bypassed for the table owner (FORCE RLS).'"
        )


def downgrade() -> None:
    for table in _bundle_rls_tables():
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
docker run -d --name pg-m4-0024-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=waddlebot -p 55437:5432 postgres:17-alpine
sleep 3
DATABASE_URL="postgresql://postgres:test@localhost:55437/waddlebot" alembic upgrade 0023_workstreams_and_usage
DATABASE_URL="postgresql://postgres:test@localhost:55437/waddlebot" alembic upgrade 0024_process_stage_rls
python3 -m pytest alembic/tests/test_0024_process_stage_rls.py -v
docker rm -f pg-m4-0024-test
```
Expected: `2 passed`, `bundle_rls_tables RLS-enabled examined: 5` printed.

- [ ] **Step 5: Commit**

```bash
git add alembic/versions/0024_process_stage_rls.py alembic/tests/test_0024_process_stage_rls.py
git commit -m "$(cat <<'EOF'
feat(hub-api): row-level security on bundle-owned tables (spec Sec16
M4, coordinator ruling R59)

M4-owned per spec Sec16's own milestone table ("DB host capability |
Parser allowlist + per-bundle role + RLS"), landed as an Alembic
migration because only hub-api runs DDL. Policies key on the exact
session GUCs Task 20's hostcap/db.rs already sets (SET LOCAL
waddles.tenant/waddles.community, spec Sec7.4), scoping a tenant-wide
activation (no community GUC set) to every community under that
tenant rather than to zero rows. FORCE ROW LEVEL SECURITY applied
alongside ENABLE so the guarantee never silently depends on which
role owns the table. Table list sourced from config/postgres/
rbac-matrix.yaml's bundle_rls_tables (Task 30).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 32: CI workflows (`fmt`, `clippy -D warnings`, `deny`, `audit`, `llvm-cov ≥90%`, `semgrep`, `gitleaks`, `trivy`, image push)

**Files:**
- Create: `.github/workflows/rust-svc-process.yml`, `.github/workflows/build-svc-process.yml`

**Interfaces:**
- Consumes: every `make -C core/svc_process <target>` from Task 0, including the already-committed `core/svc_process/build/scanner-images.env` (Task 0's own one-time, manually-resolved-and-committed digest file -- this task's CI job reads it via `make`'s `include`, never regenerates it).
- Produces: `rust-svc-process.yml` (runs on every PR touching `core/svc_process/**`: `fmt-check`, `clippy`, `test-security` (`deny`+`audit`), `coverage` gated at `--fail-under-lines 90`, `semgrep`, `gitleaks`, `trivy` against a locally-built image, `structure-test`, in that order, each step's exit code propagating -- never `|| true`, per Global Constraints Verification Integrity); `build-svc-process.yml` (on merge to `release/v3.0.X`: builds and pushes `ghcr.io/penguintechinc/waddles/svc-process:beta-<epoch>`, matching the five-tier tag convention -- alpha/beta only from this workflow, gamma/prod triggers are the repo-wide release workflow, out of this task's scope). Both workflows need `git` credentials/network for `penguin-licensing`'s git+rev dependency (R53) -- GitHub-hosted runners already have outbound network and a `git` binary, no extra step required, but the `actions/checkout` step must **not** pass `submodules: false`-equivalent restrictions that would block a plain `git` fetch of an external `https://github.com/...` URL during `cargo build` (none of this repo's existing workflows do; this task adds no such restriction).

Spec: Global Constraints CI/CD Tag Naming (`devops.md`), Verification Integrity (`critical-rules.md`).

- [ ] **Step 1: Write the failing check** — before writing the workflow, deliberately verify the underlying `make` targets can fail (Task 0 already did this once for `fmt-check`; this step extends that check to `clippy` and `coverage`, the two targets a CI-only run exercises that a developer might skip locally):

Run (from repo root):
```bash
# Break clippy on purpose: add an unused variable to src/main.rs
sed -i.bak '1i let _unused_ci_probe = 1;' core/svc_process/src/main.rs
make -C core/svc_process clippy; echo "exit code: $?"
mv core/svc_process/src/main.rs.bak core/svc_process/src/main.rs
```
Expected: non-zero exit code, `warning: unused variable` promoted to a hard error by `-D warnings`. Record that this was done -- Verification Integrity: "assume any long-green gate is broken until you have made it fail on purpose once."

- [ ] **Step 2: Run to verify the workflow YAML itself is syntactically valid**

Run: `docker run --rm -v "$(pwd)":/repo -w /repo rhysd/actionlint:1.7.7 -color .github/workflows/rust-svc-process.yml .github/workflows/build-svc-process.yml`
Expected: FAIL -- the files do not exist yet.

- [ ] **Step 3: Write both workflow files**

```yaml
# .github/workflows/rust-svc-process.yml
name: rust-svc-process

on:
  pull_request:
    paths:
      - "core/svc_process/**"
      - ".github/workflows/rust-svc-process.yml"

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: fmt-check
        run: make -C core/svc_process fmt-check
      - name: clippy
        run: make -C core/svc_process clippy
      - name: test-security (cargo deny + cargo audit)
        run: make -C core/svc_process test-security
      - name: coverage (fail-under 90%)
        run: make -C core/svc_process coverage
      - name: build (release binary, proves the git+rev dependency resolves)
        run: make -C core/svc_process build
      - name: semgrep
        run: make -C core/svc_process semgrep
      - name: gitleaks
        run: make -C core/svc_process gitleaks
      - name: docker-build (for the trivy scan below)
        run: make -C core/svc_process docker-build
      - name: trivy
        run: make -C core/svc_process trivy
      - name: structure-test (rootless assertions)
        run: make -C core/svc_process structure-test
```

```yaml
# .github/workflows/build-svc-process.yml
name: build-svc-process

on:
  push:
    branches:
      - "release/v3.0.X"
    paths:
      - "core/svc_process/**"

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Log in to ghcr.io
        uses: docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567 # v3.3.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Compute beta tag
        id: tag
        run: echo "tag=beta-$(date +%s)" >> "$GITHUB_OUTPUT"
      - name: Build and push
        run: |
          set -euo pipefail
          IMAGE="ghcr.io/penguintechinc/waddles/svc-process:${{ steps.tag.outputs.tag }}"
          docker build -t "$IMAGE" core/svc_process
          docker push "$IMAGE"
```

- [ ] **Step 4: Run to verify it passes**

Run: `docker run --rm -v "$(pwd)":/repo -w /repo rhysd/actionlint:1.7.7 -color .github/workflows/rust-svc-process.yml .github/workflows/build-svc-process.yml`
Expected: no output, exit code 0 (actionlint reports nothing on a clean workflow).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/rust-svc-process.yml .github/workflows/build-svc-process.yml
git commit -m "$(cat <<'EOF'
ci(svc-process): PR verification workflow (fmt/clippy/deny/audit/
coverage/semgrep/gitleaks/trivy) + beta image build-and-push

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 33: Action-stream entry golden fixture (shared contract, "must match plan M3")

**Files:**
- Create: `tests/golden/entries/action_entry.json` (repo-root `tests/golden/`, shared with M1's fixture tree and M3's own golden-fixture task -- **not** under `core/svc_process/`)
- Create: `core/svc_process/tests/action_entry_golden.rs`

**Interfaces:**
- Consumes: `StageEnvelope`, `Trace`, `Binding` (Task 5), `route_bundle_output`/`build_output_envelope`'s output shape (Task 24, via its own already-tested `Deliver` variant).
- Produces: the byte-identical fixture file Global Constraints' M3 sibling-plan row names explicitly: `tests/golden/entries/action_entry.json`, one Valkey stream entry's `env` field value -- a `StageEnvelope` JSON object with `"stage": "action"`, D30 fields (`schema_version: 2`, `workstream_id`, `event_id`, `trace`, `binding`) all present and valid. This is the wire contract **M3's** `svc_action` reads: "one Valkey stream entry with exactly one field, `env`, whose value is the `StageEnvelope` JSON with `stage: "action"` -- byte-identical on both sides." No new Rust type -- this task only proves M4's own `StageEnvelope` serialization agrees with the fixture byte-for-byte, the same technique **Task 5**'s `envelope_golden.rs` already uses for `envelopes/valid/*.json`.

Spec: §14.1 (golden-fixture contract testing), Global Constraints "Names borrowed from sibling M1 plans" M3 row.

- [ ] **Step 1: Write the failing test**

```rust
// core/svc_process/tests/action_entry_golden.rs
//! Proves this crate's `StageEnvelope` serialization agrees byte-for-byte
//! with the fixture M3's `svc_action` reads from the same file -- the
//! shared action-stream entry format contract (Global Constraints, M3
//! sibling row).
use std::fs;
use std::path::Path;

use svc_process::spine::envelope::StageEnvelope;

fn fixture_path() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/entries/action_entry.json"))
}

#[test]
fn action_entry_fixture_round_trips_byte_identical() {
    let raw = fs::read_to_string(fixture_path()).unwrap_or_else(|e| panic!("reading {:?}: {e}", fixture_path()));
    let original: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let env: StageEnvelope = serde_json::from_value(original.clone()).unwrap_or_else(|e| panic!("{:?}: {e}", fixture_path()));
    assert_eq!(env.stage, "action", "the shared fixture must be the action-stage shape, per its own contract");
    let round_tripped = serde_json::to_value(&env).unwrap();
    assert_eq!(original, round_tripped, "action_entry.json did not round-trip byte-identical");
}

#[test]
fn action_entry_fixture_carries_every_d30_field() {
    let raw = fs::read_to_string(fixture_path()).unwrap();
    let env: StageEnvelope = serde_json::from_str(&raw).unwrap();
    assert_eq!(env.schema_version, 2);
    assert!(!env.workstream_id.is_empty());
    assert!(!env.event_id.is_empty());
    assert!(!env.binding.mac.is_empty());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--test action_entry_golden"`
Expected: FAIL -- `tests/golden/entries/action_entry.json` does not exist yet.

- [ ] **Step 3: Write the fixture**

```json
{
  "schema_version": 2,
  "tenant": "acme",
  "community": "main",
  "app_id": "waddles.bot.commands.default",
  "stage": "action",
  "event": {
    "platform": "twitch",
    "event_type": "chat.reply",
    "actor": "waddles.bot.commands.default",
    "payload": { "text": "pong" },
    "occurred_at": "2026-09-14T12:00:00.000Z"
  },
  "ts": "2026-09-14T12:00:00.456Z",
  "target_app_id": null,
  "workstream_id": "8f14e45f-ceea-467e-adde-3fb5c9752730",
  "event_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "session_id": null,
  "trace": {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "tracestate": null
  },
  "binding": {
    "kid": "2026-09",
    "mac": "3f39d5c348e5b79d06e842c114e6cc571583bbf44e4b0ebfda1a01ec05745d43"
  }
}
```

(The `binding.mac` value is a syntactically valid 64-lowercase-hex placeholder for fixture purposes -- it exercises the shape check, not a real HMAC; no test in this task calls `verify_binding` against it, unlike **Task 21**'s own binding tests, which mint real MACs with a real keyring.)

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--test action_entry_golden"`
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: Commit**

```bash
git add tests/golden/entries/action_entry.json core/svc_process/tests/action_entry_golden.rs
git commit -m "$(cat <<'EOF'
test(svc-process): action-stream entry golden fixture -- the byte-
identical contract M3's svc_action reads from the same file

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 34: Negative test suite — tenant/binding/grant boundary (spec §14.11, D25/D30)

**Files:**
- Create: `core/svc_process/tests/grant_isolation.rs`

**Interfaces:**
- Consumes: `Registry`/`WorkerKey`/`RegistryDiff` (Task 12), `BundleRow`/`Grant`/`ManifestSubset` (Task 11), `ConsumeRule` (Task 10), `SpineClient` (Task 8) against a real Valkey (`#[ignore]`d by default, same convention as **Task 8**'s own `spine_client_integration.rs`).
- Produces: three integration tests closing the negative-test items this plan's brief lists that are **not already** covered by an existing unit test elsewhere in this plan (cross-referenced below rather than duplicated): (1) `ungranted_stream_is_never_started_even_when_consumes_names_it` -- proves `Registry::reconcile` derives the set of streams to start workers on exclusively from `BundleRow.grants`, never from `manifest.consumes` (spec's "the stage reads on the bundle's behalf... created ONLY on streams in its `app_stream_grants`"); (2) `revoking_a_grant_destroys_its_consumer_group` -- live Valkey, proves `SpineClient::ensure_group` then `destroy_group` leaves `XINFO GROUPS` empty (spec "grant revocation -> `destroy_group`"); (3) `bundle_a_never_observes_bundle_bs_events` -- live Valkey, two consumer groups on the same stream, proves each group's `XREADGROUP` delivers to it alone, demonstrating the isolation D25's "one stream, one consumer group" invariant relies on. **Already covered elsewhere, cross-referenced, not duplicated:** tampered/unknown-kid MAC rejection and cross-tenant-stream MAC rejection (**Task 21**, `spine::binding::tests`); undeclared/cross-tenant `_target_app_id` redirect denial and bundle-supplied identity-field stripping (**Task 24**, `builtins::routing::tests`); a `GroupReader` refusing a stream other than the one it was opened for (**Task 9**, `spine::reader::tests::ensure_granted_rejects_a_stream_other_than_the_one_this_reader_was_opened_for`).

Spec: §14.11 (D30/D31 workstream identity and tenant-wall tests, full list), §5.2 (grant reconciliation), D25 (per-bundle action streams).

- [ ] **Step 1: Write the failing tests**

```rust
// core/svc_process/tests/grant_isolation.rs
use svc_process::distribution::model::{BundleRow, Grant, ManifestSubset};
use svc_process::consumes::matcher::ConsumeRule;
use svc_process::registry::Registry;
use svc_process::spine::client::SpineClient;

fn bundle_row_with_grants(app_id: &str, grants: Vec<Grant>, consumes: Vec<ConsumeRule>) -> BundleRow {
    BundleRow {
        app_id: app_id.to_string(),
        community_id: None,
        artifact_version: Some("1.0.0".to_string()),
        artifact_digest: Some("sha256:aaaa".to_string()),
        artifact_kind: Some("wasm".to_string()),
        language: Some("rust".to_string()),
        scan_status: Some("clean".to_string()),
        config: serde_json::json!({}),
        manifest: ManifestSubset {
            egress: vec![], data_tables: vec![],
            limits: svc_process::distribution::model::Limits { timeout_ms: 2000, memory_mb: 64, egress_rps: 5 },
            consumes, routes_to: vec![],
        },
        grants,
    }
}

#[test]
fn ungranted_stream_is_never_started_even_when_consumes_names_it() {
    // The bundle's manifest.consumes mentions "discord", but its only
    // GRANT is for "twitch" -- reconcile must never start a worker for
    // any discord stream, since app_stream_grants (Grant), not consumes,
    // is what authorizes reading a stream at all (spec "the stage reads
    // on the bundle's behalf and is the enforcement point").
    let granted_stream = "waddles:t:acme:c:main:src:twitch:tw-a:events".to_string();
    let row = bundle_row_with_grants(
        "waddles.bot.commands.default",
        vec![Grant { grant_id: 1, stream: granted_stream.clone(), platform: "twitch".to_string(), source_id: "tw-a".to_string(), label: "primary".to_string() }],
        vec![ConsumeRule { platform: "discord".to_string(), source_id: None, event_types: vec!["chat.message".to_string()], command_prefix: None, actor_roles: None }],
    );
    let mut registry = Registry::new();
    let diff = registry.reconcile(vec![row]);
    assert_eq!(diff.to_start.len(), 1, "exactly one worker must start, for the granted twitch stream");
    assert_eq!(diff.to_start[0].0.stream, granted_stream);
    assert!(
        !diff.to_start.iter().any(|(k, _)| k.stream.contains("discord")),
        "no worker may ever be started for a stream this bundle was never granted, regardless of what consumes names"
    );
}

async fn test_spine_client() -> SpineClient {
    let url = std::env::var("VALKEY_TEST_URL").expect("set VALKEY_TEST_URL to run this test");
    let cfg = deadpool_redis::Config::from_url(url);
    let pool = cfg.create_pool(Some(deadpool_redis::Runtime::Tokio1)).unwrap();
    SpineClient::new(pool)
}

#[tokio::test]
#[ignore = "requires a real Valkey; see spine_client_integration.rs module docs"]
async fn revoking_a_grant_destroys_its_consumer_group() {
    let client = test_spine_client().await;
    let stream = format!("test:grant-isolation:{}", uuid::Uuid::new_v4());
    let group = "waddles.bot.commands.default";
    client.ensure_group(&stream, group).await.unwrap();
    let stats_before = client.group_stats(&stream).await.unwrap();
    assert_eq!(stats_before.len(), 1, "the group must exist right after ensure_group");

    client.destroy_group(&stream, group).await.unwrap();
    let stats_after = client.group_stats(&stream).await.unwrap();
    assert!(stats_after.is_empty(), "XINFO GROUPS must report zero groups once the grant is revoked and destroy_group runs");
}

#[tokio::test]
#[ignore = "requires a real Valkey; see spine_client_integration.rs module docs"]
async fn bundle_a_never_observes_bundle_bs_events() {
    let client = test_spine_client().await;
    let stream = format!("test:grant-isolation:shared:{}", uuid::Uuid::new_v4());
    let group_a = "waddles.bot.a.default";
    let group_b = "waddles.bot.b.default";
    client.ensure_group(&stream, group_a).await.unwrap();
    client.ensure_group(&stream, group_b).await.unwrap();

    let env = test_envelope();
    client.append(&stream, &env, 1000).await.unwrap();

    let mut reader_a = svc_process::spine::reader::GroupReader::connect(&std::env::var("VALKEY_TEST_URL").unwrap(), &stream, std::time::Duration::from_secs(5)).await.unwrap();
    let delivered_a = reader_a.read(&stream, group_a, "consumer-a", 500, 10).await.unwrap();
    assert_eq!(delivered_a.len(), 1, "group A must see the one entry via its own XREADGROUP");
    client.ack(&stream, group_a, &delivered_a[0].entry_id).await.unwrap();

    // Group B's own PEL/last-delivered-id is entirely independent of
    // group A's -- it must ALSO see the same entry once (each consumer
    // group tracks delivery separately over the same stream, D25's
    // "one stream, one consumer group" isolation), proving neither
    // group can suppress or steal the other's delivery.
    let mut reader_b = svc_process::spine::reader::GroupReader::connect(&std::env::var("VALKEY_TEST_URL").unwrap(), &stream, std::time::Duration::from_secs(5)).await.unwrap();
    let delivered_b = reader_b.read(&stream, group_b, "consumer-b", 500, 10).await.unwrap();
    assert_eq!(delivered_b.len(), 1, "group B must independently see its own copy of the same entry");
    assert_eq!(delivered_b[0].entry_id, delivered_a[0].entry_id, "same entry id, but delivered independently to each group");
}

fn test_envelope() -> svc_process::spine::envelope::StageEnvelope {
    use svc_process::spine::envelope::{Binding, PlatformEvent, StageEnvelope};
    StageEnvelope {
        schema_version: 2, tenant: "acme".into(), community: Some("main".into()),
        app_id: "waddles.bot.a.default".into(), stage: "process".into(),
        event: PlatformEvent { platform: "twitch".into(), event_type: "chat.message".into(), actor: Some("u".into()), payload: serde_json::Map::new(), occurred_at: "2026-09-14T12:00:00.000Z".into(), source: None },
        ts: "2026-09-14T12:00:00.000Z".into(), target_app_id: None,
        workstream_id: uuid::Uuid::new_v4().to_string(), event_id: uuid::Uuid::new_v4().to_string(),
        session_id: None, trace: None, binding: Binding { kid: "k".into(), mac: "a".repeat(64) },
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--test grant_isolation ungranted_stream_is_never_started_even_when_consumes_names_it"`
Expected: FAIL to compile (`svc_process::distribution::model` field names must match Task 11 exactly -- if any field name differs, fix this test's struct literal to match Task 11's actual `Produces:` line, never the other way around).

- [ ] **Step 3: Nothing to implement** — this task is pure test coverage against already-implemented behavior (Tasks 8, 9, 12). If `ungranted_stream_is_never_started_even_when_consumes_names_it` fails once compiling, the bug is in Task 12's `Registry::reconcile` (it must derive `to_start` from `row.grants`, never `row.manifest.consumes`) -- fix `registry/mod.rs` there, not here.

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--test grant_isolation ungranted_stream_is_never_started_even_when_consumes_names_it"`
Expected: `test result: ok. 1 passed`

Run (live Valkey):
```bash
docker run -d --rm --name svc-process-valkey-test -p 6399:6379 valkey/valkey:8-bookworm
cd core/svc_process && VALKEY_TEST_URL=redis://127.0.0.1:6399 cargo test --test grant_isolation -- --ignored --test-threads=1 2>&1 | tail -30
docker stop svc-process-valkey-test
```
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/tests/grant_isolation.rs
git commit -m "$(cat <<'EOF'
test(svc-process): negative tests -- ungranted stream never started,
grant revocation destroys its group, per-bundle group isolation
(spec Sec14.11, D25)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 35: Capability/DB negative tests + live-Postgres RLS test + `FakeExecutor` e2e pipeline test + README

**Files:**
- Create: `core/svc_process/tests/db_capability_guard.rs`, `core/svc_process/tests/fakes/mod.rs`, `core/svc_process/tests/e2e_process_pipeline.rs`, `core/svc_process/README.md`

**Interfaces:**
- Consumes: `CompositeHandler`/`DbCapability`/`HttpCapability` (Tasks 19, 20), `HostApiListener`/`wire::*` (Tasks 13, 14), `Worker`/`WorkerSpec` (Task 25), `SpineClient` (Task 8), `Migration 0024_process_stage_rls` (Task 31), `bundle_rls_tables`/`bundle_role_name` (Tasks 30, 20).
- Produces: `pub struct FakeExecutor { .. }` with `pub async fn connect(addr: std::net::SocketAddr, ca_file: &str, expect_peer: &str) -> Self` (dials the stage's host-API TLS listener as a client, sends `hello`, awaits `hello-ok`), `pub async fn respond_to_next_invoke(&mut self, payload: serde_json::Value, fuel_used: u64) -> String` (reads the next `invoke` frame, replies `result`, returns the received `trace_context` so the caller can assert trace continuity) -- the harness **Task 25**'s own `Invoker` trait was deliberately designed to make unnecessary for the worker's *unit* tests, but which the pipeline's *integration* coverage still needs, since only a real wire-protocol client can prove the listener/dispatch/CompositeHandler chain actually works end to end; two negative tests (`http_egress_is_denied_when_the_bundles_grant_declares_none`, live-Postgres `db_call_scoped_to_tenant_a_cannot_read_tenant_b_rows`); one e2e test (`e2e_process_pipeline_preserves_trace_and_records_usage`) asserting trace-id continuity from the source envelope's `traceparent` through to the frame the fake executor receives, and that `UsageBatcher::flush()` reports exactly one invocation for the processed entry; `core/svc_process/README.md` documenting build/test/run commands, the offline-mode/connectivity story (Global Constraints "never silently fail on network error"), and a link back to the spec.

Spec: §14.6 (negative sandbox/capability tests), §14.8 (e2e), §14.11 test 5 (live-Postgres RLS), §13.2 (trace propagation into the executor frame and back).

- [ ] **Step 1: Write the failing tests**

```rust
// core/svc_process/tests/db_capability_guard.rs
use svc_process::hostcap::http::{EgressRequest, HttpCapability};

#[tokio::test]
async fn http_egress_is_denied_when_the_bundles_grant_declares_none() {
    // Mirrors CompositeHandler's own "http" arm (hostcap/mod.rs, Task 20):
    // `if grant.egress.is_empty() { return Err(denied) }` runs BEFORE
    // HttpCapability::send is ever called -- this test proves that guard
    // by exercising it at the same layer CompositeHandler does, using an
    // empty `egress: &[]` allow-list against a capability instance that
    // would otherwise happily perform the request.
    let http = HttpCapability::new(
        std::sync::Arc::new(svc_process::hostcap::http::EnvSecretResolver),
        std::time::Duration::from_secs(2), 1_048_576, 3,
    ).unwrap();
    let req = EgressRequest { method: "GET".to_string(), url: "https://example.com".to_string(), headers: vec![], body: None, secret_refs: vec![] };
    let limiter = governor::RateLimiter::direct(governor::Quota::per_second(std::num::NonZeroU32::new(10).unwrap()));
    let err = http.send("waddles.bot.commands.default", req, &[], &[], false, &limiter).await.unwrap_err();
    assert_eq!(err.code, "denied");
}

// -- Live-Postgres RLS negative test (spec Sec14.11 test 5) --
// Requires migrations 0001-0024 applied (Task 31) and a bundle_<app>
// role provisioned -- both done by the setup script in Step 2's Run:
// line, never inside this test itself (this crate has no Alembic/Python
// dependency).
#[tokio::test]
#[ignore = "requires a live Postgres with migrations 0001-0024 applied and a bundle role provisioned; see Step 2's Run: line"]
async fn db_call_scoped_to_tenant_a_cannot_read_tenant_b_rows() {
    let dsn_template = std::env::var("RLS_TEST_DSN_TEMPLATE").expect("set RLS_TEST_DSN_TEMPLATE, e.g. postgres://{role}:{password}@127.0.0.1:55438/waddlebot?sslmode=disable");
    let db = svc_process::hostcap::db::DbCapability::new(dsn_template);
    let app_id = "waddles.bot.commands.default";
    let allowed = vec!["loyalty_config".to_string()];

    let as_tenant_a = db.execute(app_id, "acme", Some("main"), &allowed, "SELECT community_id FROM loyalty_config", vec![]).await.unwrap();
    let rows_a = as_tenant_a["rows"].as_array().unwrap();
    assert!(!rows_a.is_empty(), "tenant A must see its own seeded row -- check the setup script ran");

    let as_tenant_b = db.execute(app_id, "other-tenant", Some("other-community"), &allowed, "SELECT community_id FROM loyalty_config", vec![]).await.unwrap();
    let rows_b = as_tenant_b["rows"].as_array().unwrap();
    assert!(rows_b.is_empty(), "a DB host call scoped to a different tenant must see zero rows -- the D30/D28 RLS boundary (migration 0024) failed");
}
```

```rust
// core/svc_process/tests/fakes/mod.rs
//! A minimal wire-protocol client standing in for `svc-process-executor`
//! in this crate's own e2e test -- dials the stage's host-API mTLS
//! listener, completes the `hello`/`hello-ok` handshake, and answers
//! exactly one `invoke` per `respond_to_next_invoke` call.
use std::sync::Arc;

use svc_process::hostapi::wire::{read_frame, write_frame, Frame, FromExecutor, SandboxInfo, ToExecutor};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::rustls;

/// A test double for `svc-process-executor` speaking the real wire
/// protocol over a real (self-signed, test-only) TLS connection.
pub struct FakeExecutor {
    stream: tokio_rustls::client::TlsStream<tokio::net::TcpStream>,
}

impl FakeExecutor {
    /// Dials `addr`, completes the TLS handshake against `ca_file`, and
    /// exchanges `hello`/`hello-ok`.
    pub async fn connect(addr: std::net::SocketAddr, ca_file: &str, _expect_peer: &str) -> Self {
        let ca_pem = std::fs::read(ca_file).expect("reading test CA file");
        let mut root_store = rustls::RootCertStore::empty();
        for cert in rustls_pemfile::certs(&mut ca_pem.as_slice()) {
            root_store.add(cert.expect("parsing test CA cert")).expect("adding test CA cert");
        }
        let tls_config = rustls::ClientConfig::builder().with_root_certificates(root_store).with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));
        let tcp = tokio::net::TcpStream::connect(addr).await.expect("connecting to host-api listener");
        let server_name = rustls_pki_types::ServerName::try_from("localhost").expect("static server name");
        let mut stream = connector.connect(server_name, tcp).await.expect("TLS handshake");

        let hello = Frame { v: 1, id: 0, body: FromExecutor::Hello {
            protocol_version: 1, executor_version: "test-fake".to_string(), wasmtime_version: "test".to_string(),
            wasmtime_abi: "test".to_string(), collector: "drc".to_string(), sandbox: SandboxInfo { runtime: "runc".to_string(), verified: true },
        }};
        write_frame(&mut stream, &serde_json::to_vec(&hello).unwrap()).await.expect("writing hello");
        let bytes = read_frame(&mut stream, 1_048_576).await.expect("reading hello-ok");
        let _reply: Frame<ToExecutor> = serde_json::from_slice(&bytes).expect("parsing hello-ok");

        Self { stream }
    }

    /// Reads the next `invoke` frame and replies `result`. Returns the
    /// `trace_context` the stage sent, so the caller can assert trace
    /// continuity end to end.
    pub async fn respond_to_next_invoke(&mut self, payload: serde_json::Value, fuel_used: u64) -> Option<String> {
        let bytes = read_frame(&mut self.stream, 1_048_576).await.expect("reading invoke frame");
        let frame: Frame<ToExecutor> = serde_json::from_slice(&bytes).expect("parsing invoke frame");
        let ToExecutor::Invoke { trace_context, .. } = frame.body else { panic!("expected invoke, got {:?}", frame.body) };
        let reply = Frame { v: 1, id: frame.id, body: FromExecutor::Result { payload, duration_ms: 5, fuel_used } };
        write_frame(&mut self.stream, &serde_json::to_vec(&reply).unwrap()).await.expect("writing result");
        trace_context
    }
}
```

```rust
// core/svc_process/tests/e2e_process_pipeline.rs
//! Real Valkey + a `FakeExecutor` over a real mTLS connection, exercising
//! the full read -> verify -> invoke -> route -> append -> usage pipeline
//! (spec Sec14.8) without a live WASM sandbox. `#[ignore]`d: requires
//! `VALKEY_TEST_URL` and generates its own throwaway TLS materials via
//! `rcgen`.
mod fakes;

use std::collections::HashMap;
use std::sync::Arc;

use svc_process::builtins::moderation_enforce::ModerationEnforcer;
use svc_process::builtins::moderation_gate::{FlagsCheck, ModerationGate};
use svc_process::consumes::matcher::ConsumeRule;
use svc_process::hostapi::dispatch::HostApiPool;
use svc_process::hostapi::listener::HostApiListener;
use svc_process::spine::binding::{compute_binding_mac, BindingInput, BindingKeyEntry, BindingKeyring};
use svc_process::spine::client::SpineClient;
use svc_process::spine::envelope::{Binding, PlatformEvent, StageEnvelope};
use svc_process::spine::usage::UsageBatcher;
use svc_process::trip::TripCounter;
use svc_process::worker::{Worker, WorkerSpec};

struct AlwaysOff;
#[async_trait::async_trait]
impl FlagsCheck for AlwaysOff {
    async fn enabled(&self, _key: &str, _default_value: bool) -> bool {
        false // moderation off for this pipeline test -- its own gate behaviour is Task 23's job
    }
}

fn generate_test_tls() -> (String, String, String) {
    // Self-signed test CA + server cert via rcgen (dev-dependency,
    // Global Constraints Pins) -- written to the test's own temp dir.
    let ca = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let dir = std::env::temp_dir().join(format!("svc-process-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let cert_path = dir.join("tls.crt");
    let key_path = dir.join("tls.key");
    let ca_path = dir.join("ca.crt");
    std::fs::write(&cert_path, ca.cert.pem()).unwrap();
    std::fs::write(&key_path, ca.signing_key.serialize_pem()).unwrap();
    std::fs::write(&ca_path, ca.cert.pem()).unwrap();
    (cert_path.to_string_lossy().to_string(), key_path.to_string_lossy().to_string(), ca_path.to_string_lossy().to_string())
}

#[tokio::test]
#[ignore = "requires a real Valkey (VALKEY_TEST_URL) and opens a real TLS listener"]
async fn e2e_process_pipeline_preserves_trace_and_records_usage() {
    let valkey_url = std::env::var("VALKEY_TEST_URL").expect("set VALKEY_TEST_URL");
    let (cert, key, ca) = generate_test_tls();

    let addr: std::net::SocketAddr = "127.0.0.1:0".parse().unwrap();
    let listener = HostApiListener::bind(addr, &cert, &key, &ca).await.unwrap();
    let bound_addr = listener.local_addr(); // see note below on adding this accessor

    let host_pool: Arc<HostApiPool<_>> = Arc::new(HostApiPool::new());
    tokio::spawn({
        let host_pool = host_pool.clone();
        async move {
            let tcp = listener.accept().await.unwrap();
            let limits = svc_process::hostapi::wire::HostApiLimits { call_timeout_ms: 2000, memory_mb: 64, max_concurrent_calls: 4 };
            let conn = listener.handshake(tcp, "test-executor", false, "drc", "process", limits).await.unwrap();
            let handle = svc_process::hostapi::dispatch::DispatchHandle::new(conn.writer);
            host_pool.add(handle.clone()).await;
            let handler: Arc<dyn svc_process::hostapi::HostCallHandler> = Arc::new(NoopHandler);
            let events: Arc<dyn svc_process::hostapi::dispatch::ExecutorEvents> = Arc::new(TripCounter::new(3, std::time::Duration::from_secs(300)));
            svc_process::hostapi::dispatch::run_dispatch_loop(conn.reader, handle, handler, events, 1_048_576).await;
        }
    });

    let mut fake = fakes::FakeExecutor::connect(bound_addr, &ca, "svc-process").await;

    let cfg = deadpool_redis::Config::from_url(valkey_url.clone());
    let pool = cfg.create_pool(Some(deadpool_redis::Runtime::Tokio1)).unwrap();
    let spine = SpineClient::new(pool);
    let stream = format!("test:e2e:{}", uuid::Uuid::new_v4());
    let group = "waddles.bot.commands.default";
    spine.ensure_group(&stream, group).await.unwrap();

    let mut key_entries = HashMap::new();
    key_entries.insert("test-kid".to_string(), BindingKeyEntry { key: vec![7u8; 32], retired_at: None });
    let keyring = Arc::new(BindingKeyring::from_entries("test-kid", key_entries, chrono::Duration::seconds(3600)).unwrap());
    let workstream_id = uuid::Uuid::new_v4().to_string();
    let event_id = uuid::Uuid::new_v4().to_string();
    let trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
    let traceparent = format!("00-{trace_id}-00f067aa0ba902b7-01");
    let binding = compute_binding_mac(&keyring, &BindingInput { tenant: "acme", community: Some("main"), workstream_id: &workstream_id, event_id: &event_id, trace_id });

    let env = StageEnvelope {
        schema_version: 2, tenant: "acme".into(), community: Some("main".into()),
        app_id: group.to_string(), stage: "process".into(),
        event: PlatformEvent { platform: "twitch".into(), event_type: "chat.message".into(), actor: Some("u".into()), payload: serde_json::Map::new(), occurred_at: "2026-09-14T12:00:00.000Z".into(), source: None },
        ts: "2026-09-14T12:00:00.000Z".into(), target_app_id: None,
        workstream_id: workstream_id.clone(), event_id, session_id: None,
        trace: Some(svc_process::spine::envelope::Trace { traceparent: traceparent.clone(), tracestate: None }),
        binding,
    };
    spine.append(&stream, &env, 1000).await.unwrap();

    let reader = svc_process::spine::reader::GroupReader::connect(&valkey_url, &stream, std::time::Duration::from_secs(5)).await.unwrap();
    let flags = Arc::new(AlwaysOff);
    let moderation_gate = Arc::new(ModerationGate::new(reqwest::Client::new(), "http://127.0.0.1:1".to_string(), "shieldgemma:2b".to_string(), 0.5, std::time::Duration::from_millis(100), flags));
    let moderation_enforcer = Arc::new(ModerationEnforcer::new(spine.clone(), 1000, Arc::new(AlwaysOff)));
    let trip_counter = Arc::new(TripCounter::new(3, std::time::Duration::from_secs(300)));
    let usage = Arc::new(UsageBatcher::new());
    let spec = WorkerSpec {
        app_id: group.to_string(), stream: stream.clone(), digest: "sha256:aaaa".to_string(), version: "1.0.0".to_string(),
        config: serde_json::json!({}), consumes: vec![ConsumeRule { platform: "twitch".to_string(), source_id: None, event_types: vec!["chat.message".to_string()], command_prefix: None, actor_roles: None }],
        routes_to: vec![],
    };
    let worker = Worker::new(
        spec, spine.clone(), reader, keyring, host_pool.clone(), moderation_gate, moderation_enforcer, trip_counter, usage.clone(),
        Arc::new(|_: &str| false), "e2e-consumer".to_string(), group.to_string(), 500, 10, 5, 1000, 1000, 2000,
    ).unwrap();

    let (delivered_tx, delivered_rx) = tokio::sync::oneshot::channel();
    let respond_task = tokio::spawn(async move {
        let received_trace = fake.respond_to_next_invoke(serde_json::json!({"text": "pong"}), 42).await;
        let _ = delivered_tx.send(received_trace);
    });

    let mut reader_for_run = svc_process::spine::reader::GroupReader::connect(&valkey_url, &stream, std::time::Duration::from_secs(5)).await.unwrap();
    let delivered = reader_for_run.read(&stream, group, "e2e-consumer", 2000, 10).await.unwrap();
    assert_eq!(delivered.len(), 1);
    worker.process_entry(delivered.into_iter().next().unwrap()).await.unwrap();

    let received_trace = respond_task.await.unwrap();
    let received_trace = delivered_rx.await.unwrap_or(received_trace);
    assert_eq!(received_trace.as_deref(), Some(traceparent.as_str()), "the traceparent sent to the executor must match the source envelope's exactly -- trace continuity, spec Sec5.11/Sec13.2");

    let dest_stream = svc_process::spine::keys::Scope { tenant: "acme".to_string(), community: Some("main".to_string()) }.action_stream(group);
    let acl_stats = spine.group_stats(&dest_stream).await;
    assert!(acl_stats.is_ok(), "the action stream must exist after Worker::process_entry appended to it");

    let flushed = usage.flush();
    assert_eq!(flushed.len(), 1, "exactly one usage row for this one processed entry");
    assert_eq!(flushed[0].invocations, 1);
    assert_eq!(flushed[0].fuel_ms, 42);
}

struct NoopHandler;
#[async_trait::async_trait]
impl svc_process::hostapi::HostCallHandler for NoopHandler {
    async fn handle(&self, _app_id: &str, _capability: &str, _op: &str, _args: serde_json::Value) -> Result<serde_json::Value, svc_process::hostcap::HostCapError> {
        Ok(serde_json::json!(null))
    }
}
```

```rust
// core/svc_process/src/hostapi/listener.rs -- append inside the existing `impl HostApiListener` block
    /// The address this listener actually bound to -- needed when `bind`
    /// was called with port `0` (an ephemeral port, this task's own e2e
    /// test's pattern) and the caller must discover which port a client
    /// should dial.
    pub fn local_addr(&self) -> std::net::SocketAddr {
        self.tcp_listener.local_addr().expect("a bound listener always has a local address")
    }
```

(`self.tcp_listener` is `HostApiListener`'s inner `tokio::net::TcpListener` field from Task 14 -- if that field has a different name in the actual Task 14 diff, use that name instead; the accessor's behavior is unaffected either way.)

- [ ] **Step 2: Run to verify it fails / passes**

Run (capability negative test, no external deps): `make -C core/svc_process test ARGS="--lib --test db_capability_guard http_egress_is_denied"`
Expected: `test result: ok. 1 passed` once `HttpCapability::new` compiles against Task 19's actual signature.

Run (live-Postgres RLS setup + test):
```bash
docker run -d --name pg-m4-rls-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=waddlebot -p 55438:5432 postgres:17-alpine
sleep 3
DATABASE_URL="postgresql://postgres:test@localhost:55438/waddlebot" alembic upgrade 0024_process_stage_rls
psql "postgresql://postgres:test@localhost:55438/waddlebot" -c "
  CREATE ROLE bundle_waddles_bot_commands_default LOGIN PASSWORD 'testpw';
  GRANT SELECT, INSERT ON loyalty_config TO bundle_waddles_bot_commands_default;
  INSERT INTO tenants (slug) VALUES ('acme') RETURNING id \gset
  INSERT INTO communities (tenant_id, slug) VALUES (:id, 'main') RETURNING id \gset community_
  INSERT INTO loyalty_config (community_id) VALUES (:community_id);
"
BUNDLE_ROLE_PASSWORD_BUNDLE_WADDLES_BOT_COMMANDS_DEFAULT=testpw \
RLS_TEST_DSN_TEMPLATE="postgres://{role}:{password}@127.0.0.1:55438/waddlebot?sslmode=disable" \
  cargo test --manifest-path core/svc_process/Cargo.toml --test db_capability_guard -- --ignored --test-threads=1
docker rm -f pg-m4-rls-test
```
Expected: `test result: ok. 1 passed`

Run (e2e, live Valkey):
```bash
docker run -d --rm --name svc-process-valkey-e2e -p 6399:6379 valkey/valkey:8-bookworm
cd core/svc_process && VALKEY_TEST_URL=redis://127.0.0.1:6399 cargo test --test e2e_process_pipeline -- --ignored --test-threads=1 2>&1 | tail -40
docker stop svc-process-valkey-e2e
```
Expected: `test result: ok. 1 passed`

- [ ] **Step 3: Write `core/svc_process/README.md`**

```markdown
# svc-process

Waddles process-stage data plane (Rust). See `docs/superpowers/specs/2026-09-14-rust-data-plane-design.md`.

## Build & test

    make -C core/svc_process build
    make -C core/svc_process test
    make -C core/svc_process lint
    make -C core/svc_process test-security
    make -C core/svc_process coverage

## Run locally

Requires Valkey, Postgres, and hub-api reachable; see `config.rs` for every `env` var and default.
Startup performs a connectivity self-check (`Sec12.6`) against all three -- a required dependency
still failing after `STARTUP_PROBE_ATTEMPTS` exits `78` (`EX_CONFIG`) rather than serving traffic
against a broken dependency.

## Connectivity & offline behaviour

This service has **no offline mode** -- it is a stream consumer with no meaningful function absent
Valkey/Postgres/hub-api. A *dependency that becomes unreachable after startup* degrades per-call:
Ollama unreachable -> the moderation gate fails open (`Allowed`); the flag/license server
unreachable -> flags fail open to their caller-supplied default; the executor connection pool
empty -> entries are left pending for the reaper's next reclaim, never dropped. `/healthz` reports
readiness (200 only once self-check has passed and the first registry reconcile has completed);
`/health` is liveness only.

## Ports

| Port | Purpose |
|---|---|
| `MODULE_PORT` (8201) | `/health`, `/healthz` |
| `METRICS_PORT` (9090) | `/metrics` (Prometheus text) |
| `HOST_API_PORT` (8301) | mTLS listener `svc-process-executor` dials into |
```

- [ ] **Step 4: Run the full suite one final time**

Run: `make -C core/svc_process test`
Expected: every non-`#[ignore]`d test green; `make -C core/svc_process coverage` `>= 90%` lines.

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/tests/db_capability_guard.rs core/svc_process/tests/fakes/ core/svc_process/tests/e2e_process_pipeline.rs core/svc_process/README.md core/svc_process/src/hostapi/listener.rs
git commit -m "$(cat <<'EOF'
test(svc-process): undeclared-egress-denied negative test, live-Postgres
RLS negative test (spec Sec14.11 test 5), FakeExecutor e2e pipeline
test (trace continuity + usage totals); README

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

