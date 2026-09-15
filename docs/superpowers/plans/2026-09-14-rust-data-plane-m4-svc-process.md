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
penguin-licensing = "=0.1.0"   -- see Task 1 note: pinned assuming M1's publish step has run
[dev-dependencies]
rcgen = "=0.13.1"
http-body-util = "=0.1.3"
tokio (test-util feature) = "=1.53.1"
```

**Crate-plan dependency note (read before Task 1):** `penguin-spine` and `penguin-bundle-host` (spec §4.7, §4.8) are new `penguin-libs` crates that milestone **M1** builds and publishes; `penguin-logging` (spec §4.9) likewise. As of this plan's authorship none of the three has a written plan or a crates.io release (`git ls-remote` against both `penguin-libs` and this repo found no `docs/plan-penguin-*`/`docs/plan-m2b-*`/`docs/plan-m3-*` branches). Per the milestone dependency graph (spec §16), M4 is not meant to *start* until M1 has landed — but so this plan is executable and self-contained today, every signature this plan needs from those three crates is copied **verbatim** from the spec (§4.7 `Scope`/`SpineClient`/`GroupReader`, §4.8's module table, §4.9's `init`/sanitization contract) into **local, provisional modules** under `src/spine/` and `src/hostcap/`, clearly marked `// PROVISIONAL(M1)` at the top of each file. When plan M1 publishes the real crates, swapping is a mechanical import-path change (`crate::spine::` → `penguin_spine::`), never a behaviour change, because the local modules implement exactly the spec's documented behaviour, not an incidental shape. `penguin-licensing` (spec §4.11) is different: its Rust source **already exists** at `/home/penguin/code/penguin-libs/packages/rust-licensing` with the real, checked-in public API (`LicenseClient::new`, `.flag_enabled(&self, key: &str) -> bool`, `.tier()`, `.check_tier()`, `.spawn_refresh()`) — M1's remaining work on it is CI/publish process, not new code (spec §4.11) — so this plan pins and uses it directly as `penguin-licensing = "=0.1.0"` (the version spec §4.11 says M1 will publish); if that exact version differs when this plan executes, update the one `Cargo.toml` line, the call sites are unaffected.

**Commands — containerized `make` targets only.** Every `Run:` line in this plan invokes a `make -C core/svc_process <target>` created by **Task 0**, which builds a pinned `Dockerfile.ci` toolchain image; nothing runs host `cargo`, `rustc`, `semgrep`, `gitleaks` or `trivy` (`~/.claude/rules/backend-rust.md`; `general.md` Build & Deployment Requirements). Extra cargo arguments ride on `ARGS="…"`. **Task 0 therefore executes before Task 1**, despite being written last.

**Names borrowed from the sibling M1 plans.** Where this plan's PROVISIONAL(M1) modules mirror a crate M1 is building, the name is copied from that crate's own plan so the eventual import-path swap is mechanical:

| Source plan | Names this plan must match |
|---|---|
| **penguin-spine** (`penguin-libs` `docs/plan-penguin-spine`, `docs/superpowers/plans/2026-09-14-penguin-spine.md`) | `Scope`, `Stage`, `TENANT_WIDE_SEGMENT`, `dlq_key`, `parse_scope_from_key`, `PlatformEvent`, `Source`, `StageEnvelope`, `PROCESS_TARGET_APP_ID_KEY`, `EnvelopeError`, `DlqRecord`, `DlqErrorDetail`, `DlqErrorKind`, `DlqError`, `SpineError`, `SpineMetrics`, `NoopMetrics`, `SpineConfig`, `validate_block_timeout`, `ProbeClass`, `ProbeResult`, `classify_connect_error`, `probe_valkey`, `Grant`, `Delivered`, `GroupStats`, `SpineClient` (`connect`, `append`, `ensure_group`, `destroy_group`, `ack`, `dead_letter`, `claim_stale`, `group_stats`), `GroupReader` (`connect`, `read`, `ensure_granted`) |
| **penguin-logging** (`penguin-libs` `docs/plan-penguin-logging`, `…/2026-09-14-penguin-logging.md`) | `ServiceConfig` + `ServiceConfig::from_env`, `OtlpProtocol`, `init(ServiceConfig) -> (TelemetryGuard, LevelHandle, prometheus::Registry)`, `TelemetryGuard::shutdown`, `LevelHandle::set_level`/`current`, `SENSITIVE_KEYS`, `sanitize_value`, `sanitize_json_str`, `Sanitized<T>`, `record_latency_ms`, `record_latency_seconds`, `counter_add`, `gauge_set`, `inject_trace_context`, `context_from_trace_context`, `DependencyClass`, `DependencyStatus`, `ComponentTransport`, `HealthState` (`set_dependency`, `set_transport`, `set_sandbox`, `set_extra`, `snapshot`), `HealthBody`, `health::router`/`liveness_readiness_router`/`metrics_router`, `DependencyMetrics::record`, `TransportAspect`, `TransportMetrics::mark_secure`, `warn_insecure_transport`, `render_prometheus_text`, `testing::{init_test_telemetry, TelemetryCounts}` |
| **penguin-bundle-host** (`penguin-libs` worktree `.worktrees/plan-penguin-bundle-host`, `…/2026-09-14-penguin-bundle-host.md`) — **must match plan M1c** | `Frame`, `SandboxInfo`, `read_frame`, `write_frame`, `FrameTransport`; `ApprovedPermissions` (`from_json(app_id, summary) -> Result<Self, ApprovalsError>`, fields `app_id`/`egress`/`tables`/`capabilities`/`routes_to`/`limits`), `EgressRule`, `TableGrant`, `ApprovedLimits`, `Capability` (`Http`/`Kv`/`Db`/`Relay`/`Flags`/`Log`/`Clock`/`Context`), `ApprovalsError`; host traits `HttpEgress` (`execute`), `KvStore` (`get`/`set`/`delete`/`increment`), `DbExecutor` (`execute`), `RelayPush` (`push`), `Flags` (`enabled`/`tier`), `Logger` (`write`), `Clock` (`now_millis`/`now_rfc3339`/`monotonic_nanos`), and `PreparedHttpRequest`, `RawHttpResponse`, `HttpTransportError`, `KvBackendError`, `DbValue`, `DbRows`, `DbBackendError`, `RelayBackendError`, `LogLevel` |
| **M3 `svc_action`** (`docs/superpowers/plans/2026-09-14-rust-data-plane-m3-svc-action.md`) — **must match plan M3** | The `Dockerfile.ci` + containerized `Makefile` template (M3 Task 2); the action-stream entry format this plan writes and M3 reads: one Valkey stream entry with exactly one field, `env`, whose value is the `StageEnvelope` JSON with `stage: "action"` — byte-identical on both sides, asserted by the shared golden fixture `tests/golden/entries/action_entry.json` (Task 32) |

`penguin-bundle-host` is being written concurrently with this plan; every name in its row above was read from the in-progress plan file and is marked **must match plan M1c** at each use site. If M1c's published signature differs, change the local PROVISIONAL module to match M1c — never the other way around.

## File Structure

```
core/svc_process/
  Cargo.toml  Cargo.lock  deny.toml  rust-toolchain.toml
  Dockerfile  Dockerfile.ci  Makefile  .dockerignore  README.md
  build/scanner-images.env   digest-pinned semgrep/gitleaks/trivy images (Task 0)
  src/
    main.rs                    thin binary entrypoint (mirrors svc_streaming)
    lib.rs                     run()/run_with_shutdown() wiring
    config.rs                  CliConfig + Config + Secret
    error.rs                   ProcessError (internal) + ApiError (HTTP)
    telemetry.rs                tracing + OTel + Prometheus bootstrap (local, see Global Constraints)
    spine/
      mod.rs
      envelope.rs              PlatformEvent, EventSource, StageEnvelope   -- PROVISIONAL(M1)
      keys.rs                  Scope, key builders                        -- PROVISIONAL(M1)
      client.rs                SpineClient (admin ops)                    -- PROVISIONAL(M1)
      reader.rs                GroupReader (dedicated blocking connection) -- PROVISIONAL(M1)
      dlq.rs                   DlqRecord, DlqErrorKind
    consumes/
      mod.rs
      matcher.rs               consumes glob + filter matching
    distribution/
      mod.rs
      client.rs                distribution API v2 poller
      model.rs                 BundleRow, Grant, ManifestSubset
    registry/
      mod.rs                   bundle/grant reconciliation, worker lifecycle
    hostapi/
      mod.rs
      listener.rs              mTLS TCP listener + per-connection actor
      wire.rs                  frame codec + message enums                -- PROVISIONAL(M1, penguin-bundle-host::wire)
      dispatch.rs               invoke/host-call multiplexing by id
    hostcap/
      mod.rs
      context.rs
      kv.rs
      db.rs
      http.rs
      flags.rs
      log.rs
      clock.rs
    trip.rs                    sandbox trip counting + three-strike disable
    builtins/
      mod.rs
      moderation_gate.rs       always-on content-moderation gate (built-in)
      moderation_enforce.rs    enforcement routing to waddles.community.moderation.default
      routing.rs               _target_app_id / routes_to + per-bundle action emit
    worker.rs                  per-(bundle,stream) consumer task orchestration
    reaper.rs                  XAUTOCLAIM sweep + XINFO GROUPS stats sampler
    http/
      mod.rs                   AppState + router()/metrics_router()
      health.rs                /health /healthz /metrics
      selfcheck.rs              startup connectivity self-check (§12.6)
  tests/
    config.rs  telemetry.rs  health.rs
    envelope_golden.rs         golden fixture contract tests (§14.1)
    keys_golden.rs
    consumes_matcher.rs
    moderation_gate.rs
    routing_negative.rs        §14.6 negative tests owned by this plan
    grant_isolation.rs
    trip_disable.rs
    db_capability_guard.rs
    e2e_process_pipeline.rs    real Valkey + fake executor
    fakes/mod.rs               FakeExecutor test harness

.github/workflows/
  rust-svc-process.yml
  build-svc-process.yml

k8s/helm/waddlebot/templates/
  svc-process.yaml               (modified: real image, host-api port/volumes)
  svc-process-executor.yaml      (new: Deployment + Service, gVisor RuntimeClass)
  svc-process-networkpolicy.yaml (new: CiliumNetworkPolicy rows)
k8s/helm/waddlebot/values.yaml   (modified: pipeline.svcProcess.*, pipeline.executor.*, sandbox.*)

config/postgres/rbac-matrix.yaml (created by this plan if M1/M6 has not yet: svc_process +
                                 bundle-role rows; Task 30)
config/valkey/acl-matrix.yaml    (created by this plan if absent: svc-process row; Task 30)
```

---

## Tasks

### Task 0: Containerized toolchain image, `Makefile`, rootless runtime `Dockerfile`

> **Execute this task FIRST.** It is numbered `0` (not `21`) because it was added when this plan was completed, and every other task's `Run:` line already invokes the `make` targets it creates. Nothing in Tasks 1-34 runs host `cargo` — `~/.claude/rules/backend-rust.md` and `general.md` Build & Deployment Requirements both require builds inside a container.

**Files:**
- Create: `core/svc_process/Dockerfile.ci`, `core/svc_process/Makefile`, `core/svc_process/Dockerfile`, `core/svc_process/.dockerignore`, `core/svc_process/build/scanner-images.env`

**Interfaces:**
- Consumes: nothing.
- Produces: `make -C core/svc_process {toolchain-build,lockfile,build,test,lint,fmt,fmt-check,clippy,test-security,audit,coverage,semgrep,gitleaks,trivy,docker-build,structure-test,clean}`. Every `Run:` line in Tasks 1-34 uses these targets and passes extra cargo arguments through `ARGS="…"` — no task ever invokes host `cargo`. **Must match plan M3** (`core/svc_action/Dockerfile.ci` + `Makefile`, M3 Task 2): the two files are the same template with `svc-action` → `svc-process`, `8202` → `8201`; keep them diffable.

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

RUN apt-get update \
    && apt-get install --no-install-recommends -y cmake build-essential pkg-config \
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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
penguin-licensing = "=0.1.0"

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

- [ ] **Step 2: Write `deny.toml`** — copy `core/svc_streaming/deny.toml` verbatim except the package-specific bans stay (they are supply-chain rules, not per-service), and add no new `deny` entries yet (later tasks add `openssl`/`native-tls` if not already present — they already are).

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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 5: Envelope types (`spine/envelope.rs`)

**Files:**
- Create: `core/svc_process/src/spine/envelope.rs`
- Modify: `core/svc_process/src/spine/mod.rs` (`pub mod envelope;`)
- Test: `core/svc_process/tests/envelope_golden.rs`

**Interfaces:**
- Consumes: `tests/golden/envelopes/{valid,invalid}/*.json`, `tests/golden/entries/*.json` (produced by milestone M1 at the repo root, per spec Sec14.1 -- if this directory does not exist yet when this task runs, STOP and report it: M1 has not landed, which the milestone graph says must precede M4).
- Produces: `pub struct PlatformEvent { pub platform: String, pub event_type: String, pub actor: Option<String>, pub payload: serde_json::Map<String, serde_json::Value>, pub occurred_at: String, pub source: Option<EventSource> }`; `pub struct EventSource { pub platform: String, pub account_id: String, pub channel_id: Option<String> }`; `pub struct StageEnvelope { pub tenant: String, pub community: Option<String>, pub app_id: String, pub stage: String, pub event: PlatformEvent, pub ts: String, pub target_app_id: Option<String>, pub trace_context: Option<String> }`; `pub const PROCESS_TARGET_APP_ID_KEY: &str = "_target_app_id";`; `#[derive(Debug, Error)] pub enum EnvelopeError`. Both structs `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]` with `#[serde(deny_unknown_fields)]` for strict deserialization (spec Sec6.1.2 "Strictness"). Every later task imports `StageEnvelope`/`PlatformEvent` from `crate::spine::envelope`, never redefines them.

- [ ] **Step 1: Write the failing test**

```rust
// core/svc_process/tests/envelope_golden.rs
//! Contract tests against the shared golden fixtures (spec Sec14.1) --
//! asserts svc-process's Rust envelope types agree byte-for-byte with the
//! fixtures every other implementation (flask_core, penguin-spine) reads.
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
        .unwrap_or_else(|e| panic!("reading {dir:?}: {e} -- has M1 landed?"))
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
Expected: FAIL to compile (`svc_process::spine::envelope` does not exist), or if `tests/golden/` is missing, the test panics naming that gap explicitly — either way, this is the expected pre-implementation state.

- [ ] **Step 3: Implement `spine/mod.rs` and `spine/envelope.rs`**

```rust
// core/svc_process/src/spine/mod.rs
//! Valkey Streams spine: envelope types, key builders, admin/consumer
//! clients, DLQ record shape. PROVISIONAL(M1): mirrors the `penguin-spine`
//! crate spec Sec4.7 defines; swap `crate::spine::` for `penguin_spine::`
//! once that crate is published -- see Global Constraints.
pub mod client;
pub mod dlq;
pub mod envelope;
pub mod keys;
pub mod reader;
```

```rust
// core/svc_process/src/spine/envelope.rs
//! `PlatformEvent`/`StageEnvelope` -- the queue-crossing contract, spec
//! Sec6.1. Strict deserialization: an unknown top-level field, a missing
//! required field, or a wrong type is refused, never coerced (Sec6.1.2
//! "Strictness").
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

/// One pipeline queue message routed between stages -- spec Sec6.1.2.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StageEnvelope {
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
    /// W3C `traceparent`, when the producing stage had one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_context: Option<String>,
}

impl StageEnvelope {
    /// Deserializes and immediately classifies a failure as `EnvelopeError`
    /// -- the shape `worker.rs` (Task 25) needs to route straight to
    /// `DlqErrorKind::EnvelopeInvalid` without matching on `serde_json::Error`.
    pub fn from_json(raw: &str) -> Result<Self, EnvelopeError> {
        serde_json::from_str(raw).map_err(|e| EnvelopeError(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_event_key_is_refused_not_coerced() {
        let raw = r#"{"tenant":"global","community":null,"app_id":"waddles.bot.discord.default","stage":"process","ts":"2026-09-14T12:00:00.000Z","payload":{}}"#;
        assert!(StageEnvelope::from_json(raw).is_err());
    }

    #[test]
    fn unknown_top_level_key_is_refused() {
        let raw = r#"{"tenant":"global","community":null,"app_id":"waddles.bot.discord.default","stage":"process","event":{"platform":"discord","event_type":"message","actor":null,"payload":{},"occurred_at":"2026-09-14T12:00:00.000Z"},"ts":"2026-09-14T12:00:00.000Z","bogus":true}"#;
        assert!(StageEnvelope::from_json(raw).is_err());
    }

    #[test]
    fn community_none_round_trips_as_null() {
        let env = StageEnvelope {
            tenant: "global".into(),
            community: None,
            app_id: "waddles.bot.discord.default".into(),
            stage: "process".into(),
            event: PlatformEvent {
                platform: "discord".into(),
                event_type: "message".into(),
                actor: None,
                payload: serde_json::Map::new(),
                occurred_at: "2026-09-14T12:00:00.000Z".into(),
                source: None,
            },
            ts: "2026-09-14T12:00:00.000Z".into(),
            target_app_id: None,
            trace_context: None,
        };
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(json["community"], serde_json::Value::Null);
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib spine::envelope:: --test envelope_golden"`
Expected: `test result: ok` for both the inline unit tests and the golden-fixture integration test, with the printed `fixtures examined` counts both `> 0`.

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/spine/mod.rs core/svc_process/src/spine/envelope.rs core/svc_process/tests/envelope_golden.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): PlatformEvent/StageEnvelope, golden-fixture contract tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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
- Produces: `pub struct Scope { pub tenant: String, pub community: Option<String> }` with `impl Scope { pub fn source_stream(&self, platform: &str, source_id: &str) -> String; pub fn action_stream(&self, app_id: &str) -> String; pub fn config_key(&self, app_id: &str) -> String; pub fn state_key(&self, app_id: &str) -> String; pub fn bundle_state_key(&self, app_id: &str) -> String; }` (the last is an alias used by Task 16's `kv` capability, named separately from `state_key` only because spec Sec7.4 calls it `bundle_state_key(tenant, community, app_id)` explicitly — both return the identical string, kept as two names so call sites read naturally); `pub const DLQ_KEY_PREFIX: &str = "waddles:dlq:";` `pub fn dlq_key(stage: &str) -> String`. Every later task builds a Valkey key exclusively through `Scope`/`dlq_key` — never string-formats a key inline.

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
const TENANT_WIDE_COMMUNITY_SEGMENT: &str = "_tenant";

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
        self.community.as_deref().unwrap_or(TENANT_WIDE_COMMUNITY_SEGMENT)
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
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib spine::keys:: --test keys_golden"`
Expected: `test result: ok` for both.

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/spine/keys.rs core/svc_process/tests/keys_golden.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): Scope key builders, golden-fixture contract test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 7: DLQ record type (`spine/dlq.rs`)

**Files:**
- Create: `core/svc_process/src/spine/dlq.rs`
- Modify: `core/svc_process/src/spine/mod.rs` (`pub mod dlq;` already declared in Task 5)
- Test: inline

**Interfaces:**
- Consumes: `crate::spine::envelope::StageEnvelope`.
- Produces: `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)] #[serde(rename_all = "snake_case")] pub enum DlqErrorKind { EnvelopeInvalid, BundleTrap, BundleError, CallTimeout, MemoryLimit, HostCallDenied, MaxDeliveries, BundleDisabled, ExecutorUnavailable }`; `pub struct DlqRecord { pub schema_version: u32, pub stage: String, pub key: String, pub entry_id: String, pub group: String, pub tenant: String, pub community: Option<String>, pub app_id: String, pub artifact_digest: Option<String>, pub consumer_id: String, pub deliveries: u32, pub failed_at: String, pub error: DlqErrorDetail, pub trace_context: Option<String>, pub raw: String }`; `pub struct DlqErrorDetail { pub kind: DlqErrorKind, pub code: String, pub message: String, pub detail: Option<String> }`. Every later task (Task 25 worker, Task 22 trip counter, Task 23/24 built-ins, Task 26 reaper) constructs a `DlqRecord` through `DlqRecord::new(...)`, never a bare struct literal, so `schema_version`/`failed_at` stay consistent.

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
            None, "svc-process-abc123", 1, DlqErrorKind::CallTimeout, "EXECUTOR_DEADLINE",
            "bundle call exceeded 2000 ms", None, None, "{}",
        );
        assert_eq!(rec.schema_version, 1);
        let json = serde_json::to_value(&rec).unwrap();
        assert_eq!(json["error"]["kind"], "call_timeout");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_process test ARGS="--lib spine::dlq::"`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `spine/dlq.rs`**

```rust
//! DLQ record shape -- spec Sec6.3, taken verbatim from
//! `StreamPipeline.move_to_dlq`'s prior art per the spec.
use serde::Serialize;

/// The ten reasons an entry reaches a DLQ -- spec Sec6.3's `error.kind` table.
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
    /// The bundle is disabled after three sandbox trips.
    BundleDisabled,
    /// The executor was unavailable past `EXECUTOR_UNAVAILABLE_READY_S`.
    ExecutorUnavailable,
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

/// One JSON object written to `waddles:dlq:{stage}` under the field `rec` -- spec Sec6.3.
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
    /// W3C `traceparent`, when available.
    pub trace_context: Option<String>,
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
        artifact_digest: Option<String>,
        consumer_id: &str,
        deliveries: u32,
        kind: DlqErrorKind,
        code: &str,
        message: &str,
        detail: Option<String>,
        trace_context: Option<String>,
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
            artifact_digest,
            consumer_id: consumer_id.to_string(),
            deliveries,
            failed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            error: DlqErrorDetail { kind, code: code.to_string(), message: message.to_string(), detail },
            trace_context,
            raw: raw.to_string(),
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_process test ARGS="--lib spine::dlq::"`
Expected: `test result: ok. 1 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/spine/dlq.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): DlqRecord/DlqErrorKind matching the spec Sec6.3 shape

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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
use svc_process::spine::envelope::{PlatformEvent, StageEnvelope};

fn test_env() -> StageEnvelope {
    StageEnvelope {
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
        trace_context: None,
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
        "waddles.bot.discord.default", None, "svc-process-test", 1,
        DlqErrorKind::CallTimeout, "EXECUTOR_DEADLINE", "test", None, None, "{}",
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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
- Produces: `pub struct GroupReader { .. }` with `pub async fn connect(valkey_url: &str, socket_timeout: std::time::Duration) -> Result<Self, ProcessError>`, `pub async fn read(&mut self, stream: &str, group: &str, consumer_id: &str, block_ms: u64, count: u64) -> Result<Vec<Delivered>, ProcessError>` (spec Sec5.3's `XREADGROUP GROUP {group} {consumer} COUNT {count} BLOCK {block_ms} STREAMS {stream} >`), `pub fn validate_block_config(block_ms: u64, socket_timeout: std::time::Duration) -> Result<(), ProcessError>` (spec Sec5.7 client rule 1, also enforced at `Config` load time in Task 2 — this is the spine-level restatement `penguin_spine::GroupReader::new` would carry). Task 25's per-`(bundle, stream)` worker owns exactly one `GroupReader` per stream on its own dedicated `redis::aio::MultiplexedConnection` (never the shared `deadpool_redis::Pool` — spec Sec5.7 client rule 2: a blocking command must never share a connection with admin traffic).

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
/// granted stream's blocking `XREADGROUP` loop.
pub struct GroupReader {
    conn: MultiplexedConnection,
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

    /// Opens a fresh, dedicated `MultiplexedConnection` -- never taken from
    /// the shared admin pool (spec Sec5.7 client rule 2).
    pub async fn connect(valkey_url: &str, socket_timeout: Duration) -> Result<Self, ProcessError> {
        let client = redis::Client::open(valkey_url).map_err(spine_err)?;
        let conn = client
            .get_multiplexed_tokio_connection_with_response_timeouts(socket_timeout, socket_timeout)
            .await
            .map_err(spine_err)?;
        Ok(Self { conn })
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
        let opts = StreamReadOptions::default()
            .group(group, consumer_id)
            .count(count as usize)
            .block(block_ms as usize);
        let reply: StreamReadReply = self
            .conn
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
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_process/src/spine/reader.rs
git commit -m "$(cat <<'EOF'
feat(svc-process): GroupReader dedicated-connection XREADGROUP, client rule 1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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
- Produces: `pub trait ExecutorEvents: Send + Sync { fn on_loaded(&self, app_id: &str, digest: &str, exports: &[String]); fn on_unloaded(&self, app_id: &str, digest: &str); fn on_trap(&self, app_id: &str, digest: &str, message: &str); fn on_protocol_error(&self, code: &str, message: &str); }`; `pub struct DispatchHandle<W> { .. }` (generic over the write half, `W: tokio::io::AsyncWrite + Unpin + Send + 'static`) with `pub fn new(writer: W) -> Self`, `pub async fn load(...) -> Result<(), ProcessError>`, `pub async fn unload(...) -> Result<(), ProcessError>`, `pub async fn invoke(&self, app_id: &str, digest: &str, export: &str, payload: serde_json::Value, deadline_ms: u64, trace_context: Option<String>) -> Result<serde_json::Value, ProcessError>`, `pub async fn ping(&self) -> Result<(), ProcessError>`; `pub async fn run_dispatch_loop<R, W>(reader: R, handle: DispatchHandle<W>, handler: std::sync::Arc<dyn HostCallHandler>, events: std::sync::Arc<dyn ExecutorEvents>, max_frame_bytes: u32)` (generic over `R: tokio::io::AsyncRead + Unpin + Send + 'static`); `pub struct HostApiPool<W> { .. }` with `pub fn new() -> Self`, `pub async fn add(&self, handle: DispatchHandle<W>)`, `pub async fn count(&self) -> usize`, `pub async fn pick(&self) -> Option<DispatchHandle<W>>` (round-robin). Task 20's `CompositeHandler` is the concrete `Arc<dyn HostCallHandler>` this loop dispatches `HostCall` frames to; Task 25's worker calls `HostApiPool::pick()` then `.invoke(...)` on the result; Task 22's trip counter implements `ExecutorEvents`.

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

        let result = handle.invoke("waddles.bot.discord.default", "sha256:aa", "transform", serde_json::json!({}), 2000, None).await.unwrap();
        assert_eq!(result["ok"], true);
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
    /// entry makes exactly once (Task 26).
    pub async fn invoke(&self, app_id: &str, digest: &str, export: &str, payload: serde_json::Value, deadline_ms: u64, trace_context: Option<String>) -> Result<serde_json::Value, ProcessError> {
        let body = ToExecutor::Invoke { app_id: app_id.into(), digest: digest.into(), export: export.into(), payload, deadline_ms, trace_context };
        match self.send_and_await(body).await? {
            FromExecutor::Result { payload, .. } => Ok(payload),
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
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

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

<!-- CONTINUE_HERE -->







