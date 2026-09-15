# Milestone M3 — `svc_action` Rust Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `core/svc_action` (today: Python/Quart) as a Rust service on the `core/svc_streaming` Axum/tokio/SeaORM/OTel template — the terminal pipeline stage that reads each activated bundle's own `{scope}:app:{app_id}:action` Valkey stream through a dedicated consumer group, dispatches via a WASM executor over a capability-scoped mTLS host API (or a native built-in sender for the five first-party platform sends), classifies `transport-error.retryable`, applies retry-with-backoff, and records every outcome to `action_dispatch_log`.

**Architecture:** `svc-action` owns Valkey ACL/Postgres credentials, platform secrets and the egress HTTP client; it never runs bundle code itself. A per-bundle `penguin_spine::GroupReader` drains each bundle's action stream; a match is dispatched either to a native built-in sender (Twitch relay, Discord/Slack/YouTube/Kick REST — ported 1:1 from the current Python bundles, kept local to this crate rather than taking a hard dependency on the not-yet-committed `penguin-connectors` API) or, for every other bundle, across a length-prefixed mTLS wire protocol to a `bundle-executor` Deployment that holds no stage credential. Seven host capabilities (`context`, `http`, `kv`, `db`, `relay`, `flags`, `log`, `clock` — `clock` folded into `context`'s task) are implemented stage-side and are the only thing an executor's `host-call` frame can reach.

**Tech Stack:** Rust 1.97.x, Axum 0.8.9, tokio 1.53.1, SeaORM 2.0.2 (sqlx-postgres, runtime-tokio-rustls), `redis` 0.27.6, `rustls`/`tokio-rustls` for the host-API mTLS listener, `penguin-spine` 0.1.0 (Valkey Streams spine, spec §4.7), `penguin-bundle-host` 0.1.0's `wire` module only (frame codec + `FrameTransport`, spec §6.6), `tracing` + `opentelemetry-otlp` + `prometheus` (this plan's own telemetry module — see Global Constraints for why `penguin-logging` is not a hard dependency yet), `jsonwebtoken` (`aws_lc_rs` backend), `sqlparser` 0.52.0 for the `db` capability's statement guard.

**Spec:** `docs/superpowers/specs/2026-09-14-rust-data-plane-design.md` (commit `680a0a9b`, fetched from `origin/docs/rust-data-plane-spec`) — read this plan alongside it. Section anchors used throughout: §4.3 (`svc_action` component), §4.7 (`penguin-spine`), §4.8 (`penguin-bundle-host`), §5.9 (process→action, per-bundle action streams), §6.5 (WIT world), §6.6 (executor wire protocol), §6.7 (distribution API), §7 (host interface and executor), §8 (egress model), §11 (security model), §12 (deployment), §13 (observability), §14 (testing strategy, esp. §14.6 negative sandbox tests), §16 M3 (this milestone's own deliverable row).

## Global Constraints

Copied verbatim from the spec's Standards (§17) and Global Constraints, plus this plan's own scope decisions — every task's requirements implicitly include this section.

- **Language/tier:** Rust, no exception — `svc_action` sits in-line of traffic (`critical-rules.md` Data Plane).
- **Rust stack:** Axum + tokio + SeaORM + `tracing`; `rustls` never native TLS/OpenSSL; `jsonwebtoken` with the `aws_lc_rs` backend (never the `rust_crypto` feature — RUSTSEC-2023-0071).
- **Rust lints:** `[lints.rust] unsafe_code = "deny"`, `missing_docs = "deny"`; `[lints.clippy] unwrap_used = "deny"` — every `.unwrap()`/`.expect()` outside `#[cfg(test)]` must carry a `// SAFETY:`/invariant comment. `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` clean before every commit.
- **Dependency pinning:** exact `=x.y.z` in `Cargo.toml`, never `^`/`~`/bare `*`; `Cargo.lock` committed; `cargo deny check` clean (advisories, licenses, bans, sources — no PRC-origin/sanctioned crates). Exact patch versions in this plan were chosen at planning time; if a pin is unavailable when a task runs `cargo generate-lockfile`, the implementer updates the `Cargo.toml` pin to the nearest available exact version and notes the substitution in the commit message — never widen to a range.
- **Coverage:** ≥ 90% lines/branches/functions/statements, `cargo llvm-cov --fail-under-lines 90`.
- **Containers:** rootless at both layers — `runAsNonRoot: true`, `uid 10001`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, read-only rootfs, `RuntimeDefault` seccomp. No root exception needed by this plan.
- **Containerized toolchain, always:** every `cargo`/lint/security command in every task runs through a `make` target defined in `core/svc_action/Makefile`, which runs inside the pinned `rust:1.97-slim-bookworm` toolchain image (Task 2) — never bare host `cargo`. A step's "Run:" line is always a `make -C core/svc_action <target>` invocation.
- **Observability:** logs + metrics + traces, OTLP destination only via `OTEL_EXPORTER_OTLP_ENDPOINT`/`_PROTOCOL`/`_HEADERS`/`OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES`, never hardcoded, no vendor SDK. Histograms first. A dead exporter never fails a request.
- **Secrets:** env/file only, never a CLI flag; never logged, even at DEBUG (sanitized via the `SENSITIVE_KEYS` rule, Task 5); masked in CI.
- **Transport security default-on (D19/D20):** Valkey/Postgres TLS+auth default `true`; the opt-out is a normal `security.transport.{tls,auth}` value, loud at every startup when off (`waddles_insecure_transport` gauge, `/health` `transport: "insecure"`), never rejected by a values file.
- **Feature flags:** every new capability behind a PostHog flag, `{product}.{feature}` key, default OFF, two-gate with license entitlement, fail-open to cached/default on outage (spec §13.5's `waddles.core.*` flags — `waddles.core.rust-data-plane` gates this service's drain loop entirely: OFF ⇒ serve health/metrics, drain nothing).
- **Verification integrity:** no `|| true` on a lint/scan/test; `set -euo pipefail` in every script; every "clean" result reports the count of items examined; a zero denominator is a failure.
- **Naming:** the product is **Waddles**, never "restream"; `waddlebot` survives only in the specific legacy identifiers D22 lists (the chart directory `k8s/helm/waddlebot`, `DB_NAME=waddlebot`, the unused `waddlebot:stream:*`/`waddlebot:dlq:*` prefixes) — none of which change meaning in this plan, only get referenced as-is.
- **Docs:** every `pub` item gets a 2-3 line `///` doc comment. No ASCII-art section dividers.
- **Branching:** this plan's tasks are implemented on a `feature/svc-action-rust` branch off `release/v3.0.X`, inside its own worktree (`superpowers:using-git-worktrees`), never off `main`. PR into the release branch when every gate is green; auto-merge is pre-authorized only when fully green per `devops.md`.
- **Commits:** `feat(svc-action): ...` / `test(svc-action): ...` / `ci(svc-action): ...` / `chore(svc-action): ...` / `docs(svc-action): ...` as appropriate, each ending with:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  ```

### Scope decisions this plan makes where the spec/crate plans are silent or incomplete

These are this plan's own equivalent of the spec's §20 Assumptions — recorded so a reviewer can overturn any one cheaply.

| # | Decision | Why |
|---|---|---|
| P1 | **`penguin-spine` is a hard dependency, used verbatim per spec §4.7's public surface** (`Scope`, `Stage`, `PlatformEvent`, `StageEnvelope`, `Grant`, `Delivered`, `SpineClient`, `GroupReader`). | The spec itself gives exact struct/method signatures — the strongest available source of truth, independent of that crate's own plan's completion state. |
| P2 | **`penguin-bundle-host` is a hard dependency, but only its `wire` module** (`wire::message::{Frame, Message, ExportKind, CapabilityKind, ErrorCode, SandboxInfo, HelloLimits, LoadLimits}`, `wire::frame::{read_frame, write_frame, FrameError, MAX_FRAME_BYTES}`, `wire::transport::{FrameTransport, TransportError}`). | That crate's own plan (`docs/plan-penguin-bundle-host`, Tasks 1-8) has committed, tested code for exactly this module and no other — its `host::*`/`manifest`/`loader` modules are not yet planned. Depending only on the verified module avoids a guessed, possibly-wrong API surface. |
| P3 | **The seven host capabilities (`context`, `http`, `kv`, `db`, `relay`, `flags`, `log`; `clock` is folded into `context`'s task) are implemented locally**, in `svc_action::hostapi::capabilities`, not consumed from `penguin-bundle-host::host::*`. | That crate's plan has not reached those tasks. This plan's capability code is written so a later refactor (moving it into `penguin-bundle-host` once that crate's own plan catches up) is a mechanical extraction, not a rewrite — flagged as follow-on work in the self-review. |
| P4 | **The five built-in platform senders (Twitch relay, Discord, Slack, YouTube, Kick) are implemented locally**, in `svc_action::senders`, ported line-for-line from `core/svc_action/bundles/{twitch,discord,slack,youtube,kick}_send_action.py` and `core/svc_action/services/{youtube,kick}_oauth.py`, rather than depending on `penguin-connectors` (spec §4.10). | `penguin-connectors`'s plan does not exist yet at all (no branch content beyond scaffold files) — depending on it would mean guessing an entire crate's public API. The ported Python logic is fully read and verified (see Task 23-26); a future extraction to `penguin-connector-{discord,slack,youtube,kick,twitch}` is flagged as follow-on work, not a gap. |
| P5 | **`penguin-logging` is not a dependency of this plan.** Telemetry (Task 6), health (Task 8) and log sanitization (Task 5) are implemented locally, mirroring `core/svc_streaming/src/telemetry.rs` (read in full during planning; proven, compiling code) plus a verbatim port of the `SENSITIVE_KEYS` algorithm, which **is** normatively specified (`docs/plan-penguin-logging`'s Global Constraints give the exact key list and matching rules, even though that plan has no committed function signatures yet). | Depending on an unpublished crate whose only available artifact is a file-structure listing (no function signatures) is a real risk of non-compiling code for a cheap implementer. Local implementation is self-contained and correct today; swapping to the shared crate once M1 publishes it with a confirmed API is flagged as follow-on work. |
| P6 | **`flags` capability uses a small local `FlagsClient`**, not `penguin-licensing`'s Rust API directly (unread/unverified in this session), but faithful to the documented two-gate/fail-open/5-minute-cache/72h-offline-grace behavior contract (`critical-rules.md` Feature Flags & License Tiers). | Same reasoning as P5 — behavior is normatively documented, the crate's exact Rust signatures are not verified. |
| P7 | **YouTube's per-community OAuth-connected-account resolution (`get_access_token_for_community`'s `resolve_community_tokens` path, gh-320 / `platform_integrations` service) is out of scope.** This plan ports only the env-credential refresh-token flow (`refresh_token_ref`/`client_id_ref`/`client_secret_ref`). | The Connections/`platform_integrations` service is a separate feature stream not mentioned anywhere in the rust-data-plane spec; folding it in would be scope creep beyond what this spec authorizes. Flagged as explicit follow-on work. |
| P8 | **Built-in senders bypass the executor entirely** — the action consumer loop (Task 22) checks the polled bundle row's `app_id` against a fixed first-party set (`waddles.bot.twitch.default`, `waddles.bot.discord.default`, `waddles.bot.slack.default`, `waddles.bot.youtube.default`, `waddles.bot.kick.default`) before considering the executor path. | Matches the M3 milestone table's own wording ("Built-in senders" as an `svc_action` deliverable, parallel in structure to `svc_process`'s M4 "Built-ins" row) and avoids these OAuth-refresh-heavy, trusted, first-party sends going through the WASM sandbox, which has no ready-made token-refresh primitive. |

## File Structure

```
core/svc_action/                        Rust crate (replaces the Python service in place)
  Cargo.toml                            NEW — exact-pinned deps (Task 1)
  Cargo.lock                            NEW — committed (Task 1)
  rust-toolchain.toml                   NEW — pins 1.97.1 (Task 1)
  rustfmt.toml                          NEW (Task 1)
  deny.toml                             NEW — cargo-deny policy (Task 1)
  Dockerfile.ci                         NEW — toolchain image for containerized make targets (Task 2)
  Makefile                              NEW — all targets run through Dockerfile.ci (Task 2)
  Dockerfile                            NEW — runtime image, multi-stage rootless (Task 30)
  README.md                             REWRITE (Task 33)
  src/
    main.rs                             NEW (Task 1, wired Task 10)
    lib.rs                              NEW (Task 1, wired Task 10, 27)
    config.rs                           NEW (Task 3)
    error.rs                            NEW (Task 4)
    sanitize.rs                         NEW (Task 5)
    telemetry.rs                        NEW (Task 6)
    startup_check.rs                    NEW (Task 7)
    http/
      mod.rs                            NEW (Task 9)
      health.rs                         NEW (Task 8)
      openapi.rs                        NEW (Task 9)
    distribution/
      mod.rs                            NEW (Task 11)
      poller.rs                         NEW (Task 11)
    retry.rs                            NEW (Task 12)
    audit/
      mod.rs                            NEW (Task 13)
      entities.rs                       NEW (Task 13)
    hostapi/
      mod.rs                            NEW (Task 14)
      server.rs                         NEW (Task 14, extended Task 15, 21)
      registry.rs                       NEW (Task 15)
      capabilities/
        mod.rs                          NEW (Task 16)
        context.rs                      NEW (Task 16)
        flags.rs                        NEW (Task 16)
        kv.rs                           NEW (Task 17)
        relay.rs                        NEW (Task 18)
        db.rs                           NEW (Task 19)
        http_egress.rs                  NEW (Task 20)
    senders/
      mod.rs                            NEW (Task 18)
      twitch.rs                         NEW (Task 18)
      discord.rs                        NEW (Task 23)
      slack.rs                          NEW (Task 24)
      youtube_oauth.rs                  NEW (Task 25)
      youtube.rs                        NEW (Task 25)
      kick_oauth.rs                     NEW (Task 26)
      kick.rs                           NEW (Task 26)
    consumer/
      mod.rs                            NEW (Task 22)
      action_loop.rs                    NEW (Task 22)
    runner.rs                           NEW (Task 27)
  tests/
    config.rs                           NEW (Task 3)
    telemetry.rs                        NEW (Task 6)
    startup_check.rs                    NEW (Task 7)
    health.rs                           NEW (Task 8)
    distribution_poller.rs              NEW (Task 11)
    retry.rs                            NEW (Task 12)
    audit.rs                            NEW (Task 13)
    hostapi_handshake.rs                NEW (Task 14)
    hostapi_load_invoke.rs              NEW (Task 15)
    capabilities_context_flags.rs       NEW (Task 16)
    capabilities_kv.rs                  NEW (Task 17)
    capabilities_relay_twitch.rs        NEW (Task 18)
    capabilities_db.rs                  NEW (Task 19)
    capabilities_http_egress.rs         NEW (Task 20)
    hostapi_dispatch.rs                 NEW (Task 21)
    consumer_action_loop.rs             NEW (Task 22)
    senders_discord.rs                  NEW (Task 23)
    senders_slack.rs                    NEW (Task 24)
    senders_youtube.rs                  NEW (Task 25)
    senders_kick.rs                     NEW (Task 26)
    runner_integration.rs               NEW (Task 27)
    negative_sandbox.rs                 NEW (Task 28)
    e2e_valkey_fake_executor.rs         NEW (Task 29)
    support/
      mod.rs                            NEW (Task 14)
      test_certs.rs                     NEW (Task 14) — rcgen-based mTLS test CA/cert helper
      fake_executor.rs                  NEW (Task 15) — scripted wire-protocol executor double
  bundles/                              Python sources — UNCHANGED by this plan (M1.5/M2 own them)
.github/workflows/
  rust-svc-action.yml                   NEW (Task 31)
k8s/helm/waddlebot/
  templates/
    svc-action.yaml                     MODIFY (Task 32)
    svc-action-executor.yaml            NEW (Task 32)
    networkpolicy-svc-action.yaml       NEW (Task 32)
  values.yaml                           MODIFY (Task 32)
docs/
  ops/
    svc-action-notes.md                 NEW (Task 33)
```

---

### Task 1: Crate scaffold — `Cargo.toml`, toolchain pins, lints, empty binary

**Files:**
- Create: `core/svc_action/Cargo.toml`
- Create: `core/svc_action/rust-toolchain.toml`
- Create: `core/svc_action/rustfmt.toml`
- Create: `core/svc_action/deny.toml`
- Create: `core/svc_action/.gitignore`
- Create: `core/svc_action/src/main.rs`
- Create: `core/svc_action/src/lib.rs`
- Test: `core/svc_action/tests/smoke_scaffold.rs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the crate `svc_action` (lib) and binary `svc-action`; `pub const SERVICE_NAME: &str = "svc-action";` in `lib.rs` — every later task's `tracing`/OTel resource name and `--healthcheck` default port reference this constant.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "svc-action"
version = "0.1.0"
edition = "2021"
rust-version = "1.97.0"
license = "Apache-2.0"
publish = false
description = "Waddles action-stage data-plane service -- terminal pipeline stage, per-bundle action stream dispatch, executor host API, built-in platform senders."

[lib]
name = "svc_action"
path = "src/lib.rs"

[[bin]]
name = "svc-action"
path = "src/main.rs"

[lints.rust]
unsafe_code = "deny"
missing_docs = "deny"

[lints.clippy]
unwrap_used = "deny"

# Exact-version pins only (no ^ / * ranges) -- see rules/critical-rules.md
# Dependency Pinning. Cargo.lock is committed alongside this file. If any
# exact version below is unavailable when `cargo generate-lockfile` runs,
# update the pin to the nearest available exact version and note the
# substitution in the commit message -- never widen to a range.
[dependencies]
tokio = { version = "=1.53.1", features = ["full"] }
axum = "=0.8.9"
tower = { version = "=0.5.3", features = ["util"] }
tower-http = { version = "=0.7.1", features = ["trace", "cors"] }
hyper = { version = "=1.11.1", features = ["full"] }
serde = { version = "=1.0.229", features = ["derive"] }
serde_json = "=1.0.151"
tracing = "=0.1.44"
tracing-subscriber = { version = "=0.3.23", features = ["env-filter", "json"] }
opentelemetry = "=0.32.0"
opentelemetry-otlp = { version = "=0.32.0", features = ["grpc-tonic"] }
opentelemetry_sdk = { version = "=0.32.1", features = ["rt-tokio"] }
tracing-opentelemetry = "=0.33.0"
prometheus = "=0.14.0"
utoipa = { version = "=5.5.0", features = ["axum_extras", "uuid"] }
utoipa-swagger-ui = { version = "=9.0.2", features = ["axum"] }
# aws_lc_rs (not rust_crypto): the rust_crypto feature pulls the pure-Rust
# `rsa` crate, RUSTSEC-2023-0071 (Marvin Attack, no fix available) -- see
# core/svc_streaming/Cargo.toml's identical note.
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
redis = { version = "=0.27.6", default-features = false, features = ["tokio-comp", "connection-manager"] }
rustls = { version = "=0.23.19", default-features = false, features = ["std", "tls12", "aws_lc_rs"] }
tokio-rustls = { version = "=0.26.0", default-features = false, features = ["aws_lc_rs"] }
rustls-pemfile = "=2.2.0"
# SQL statement guard for the `db` host capability (spec Sec 7.4: "The
# statement is parsed with a SQL parser (`sqlparser` crate) before
# execution").
sqlparser = "=0.52.0"
rand = "=0.8.5"
regex = "=1.11.1"
async-trait = "=0.1.92"
# Sec 4.7 -- exact public surface given in the spec itself.
penguin-spine = "=0.1.0"
# Sec 6.6 -- only the `wire` module (frame codec + FrameTransport) is
# consumed; see this plan's Global Constraints P2.
penguin-bundle-host = "=0.1.0"

[dev-dependencies]
http-body-util = "=0.1.3"
tokio = { version = "=1.53.1", features = ["test-util"] }
rcgen = "=0.13.1"
wiremock = "=0.6.2"
testcontainers = "=0.23.1"
testcontainers-modules = { version = "=0.11.4", features = ["redis"] }
rstest = "=0.23.0"

[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
strip = true
```

- [ ] **Step 2: Write `rust-toolchain.toml`**

```toml
[toolchain]
channel = "1.97.1"
components = ["rustfmt", "clippy", "llvm-tools-preview"]
```

- [ ] **Step 3: Write `rustfmt.toml`** (default settings, explicit file so `cargo fmt` is deterministic)

```toml
edition = "2021"
```

- [ ] **Step 4: Write `deny.toml`**

```toml
# cargo-deny configuration for svc-action.
# Run: cargo deny check  (advisories + licenses + bans + sources)
# See rules/critical-rules.md Dependency Pinning + rules/general.md Supply
# Chain Security for the policy this enforces.

[graph]
all-features = false
no-default-features = false

[output]
feature-depth = 1

[advisories]
version = 2
ignore = []

[licenses]
version = 2
confidence-threshold = 0.8
allow = [
    "MIT",
    "Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "Zlib",
    "MPL-2.0",
    "Unicode-3.0",
    "CDLA-Permissive-2.0",
]
exceptions = []

[licenses.private]
ignore = false

[bans]
multiple-versions = "warn"
wildcards = "deny"
highlight = "all"
workspace-default-features = "allow"
external-default-features = "allow"
allow = []
allow-workspace = false
deny = [
    { crate = "xiu", reason = "PRC-origin RTMP/HLS server crate -- forbidden supply-chain source, see rules/general.md Supply Chain Security" },
    { crate = "openssl", reason = "rustls only -- no C OpenSSL dependency, no OpenSSL CVE exposure" },
    { crate = "openssl-sys", reason = "rustls only -- no C OpenSSL dependency, no OpenSSL CVE exposure" },
    { crate = "native-tls", reason = "rustls only" },
]
skip = []
skip-tree = []

[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
allow-git = []

[sources.allow-org]
github = []
gitlab = []
bitbucket = []
```

- [ ] **Step 5: Write `.gitignore`**

```
/target
```

- [ ] **Step 6: Write `src/lib.rs`**

```rust
//! `svc-action`: the Waddles action-stage data-plane service.
//!
//! Terminal pipeline stage -- reads each activated bundle's own action
//! stream, dispatches via a built-in sender or the WASM executor, and
//! records every outcome to `action_dispatch_log`. Split into a library
//! (this file) and a thin binary (`src/main.rs`) so `tests/` integration
//! tests can exercise it directly instead of spawning a subprocess.

/// Default `tracing`/OTel service name, the `--healthcheck` target's
/// default port lookup key, and the resource `service.name` when
/// `OTEL_SERVICE_NAME` is unset.
pub const SERVICE_NAME: &str = "svc-action";
```

- [ ] **Step 7: Write `src/main.rs`**

```rust
//! Thin binary entrypoint -- all real logic lives in `src/lib.rs` so
//! `tests/` integration tests can exercise it without subprocessing.

fn main() {
    println!("{} scaffold -- run() wiring lands in a later task", svc_action::SERVICE_NAME);
}
```

- [ ] **Step 8: Write the scaffold smoke test**

`tests/smoke_scaffold.rs`:

```rust
#[test]
fn service_name_is_svc_action() {
    assert_eq!(svc_action::SERVICE_NAME, "svc-action");
}
```

- [ ] **Step 9: Run the test to verify it passes (proves the crate compiles)**

Run (from `core/svc_action`): `cargo generate-lockfile`
Expected: `Cargo.lock` created with every dependency above resolved at its pinned exact version.

Run: `make -C core/svc_action test`
Expected: `test result: ok. 1 passed; 0 failed` for `smoke_scaffold`.

- [ ] **Step 10: Commit**

Stage `core/svc_action/Cargo.toml`, `core/svc_action/Cargo.lock`, `core/svc_action/rust-toolchain.toml`, `core/svc_action/rustfmt.toml`, `core/svc_action/deny.toml`, `core/svc_action/.gitignore`, `core/svc_action/src/main.rs`, `core/svc_action/src/lib.rs`, `core/svc_action/tests/smoke_scaffold.rs` and commit with message:

```
feat(svc-action): crate scaffold, pinned deps, lints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 2: `Dockerfile.ci` toolchain image + containerized `Makefile`

**Files:**
- Create: `core/svc_action/Dockerfile.ci`
- Create: `core/svc_action/Makefile`

**Interfaces:**
- Consumes: nothing new.
- Produces: `make -C core/svc_action {build,test,lint,fmt,fmt-check,clippy,test-security,coverage,toolchain-build,docker-build,clean}` — every subsequent task's "Run:" lines use these targets exclusively; no task ever invokes host `cargo` directly.

- [ ] **Step 1: Write `Dockerfile.ci`**

```dockerfile
# svc-action CI/dev toolchain image -- rustfmt/clippy/cargo-deny/cargo-
# llvm-cov preinstalled so every `make` target in this directory runs
# through Docker, never host cargo (rules/backend-rust.md "All builds in
# Docker"; this task's own brief: "every command inside the containerized
# toolchain via make targets, never host cargo").
FROM rust:1.97-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3

RUN apt-get update \
    && apt-get install --no-install-recommends -y cmake build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN rustup component add rustfmt clippy llvm-tools-preview

RUN cargo install cargo-deny@0.20.2 --locked \
    && cargo install cargo-llvm-cov@0.9.1 --locked \
    && cargo install cargo-audit@0.22.2 --locked

WORKDIR /workspace
```

- [ ] **Step 2: Write `Makefile`**

```makefile
# svc-action (Rust) -- every target below runs inside the pinned toolchain
# image built from Dockerfile.ci, never bare host `cargo` -- see this
# plan's Global Constraints "Containerized toolchain, always".

.PHONY: toolchain-build build test lint fmt fmt-check clippy test-security coverage docker-build clean

TOOLCHAIN_IMAGE := svc-action-toolchain:local
CARGO_CACHE_VOLUME := svc-action-cargo-registry
TARGET_VOLUME := svc-action-cargo-target

DOCKER_RUN := docker run --rm \
	-v "$(CURDIR)":/workspace \
	-v $(CARGO_CACHE_VOLUME):/usr/local/cargo/registry \
	-v $(TARGET_VOLUME):/workspace/target \
	-w /workspace \
	$(TOOLCHAIN_IMAGE)

toolchain-build:
	docker build -f Dockerfile.ci -t $(TOOLCHAIN_IMAGE) .

build: toolchain-build
	$(DOCKER_RUN) cargo build --all-targets --locked

test: toolchain-build
	$(DOCKER_RUN) cargo test --locked

lint: fmt-check clippy

fmt: toolchain-build
	$(DOCKER_RUN) cargo fmt

fmt-check: toolchain-build
	$(DOCKER_RUN) cargo fmt --check

clippy: toolchain-build
	$(DOCKER_RUN) cargo clippy --all-targets --locked -- -D warnings

test-security: toolchain-build
	$(DOCKER_RUN) sh -c "cargo deny check && cargo audit"

coverage: toolchain-build
	$(DOCKER_RUN) cargo llvm-cov --locked --fail-under-lines 90

docker-build:
	docker build -t localhost:32000/waddles/svc-action:alpha-$$(date +%s) .

clean:
	docker run --rm -v "$(CURDIR)":/workspace -w /workspace $(TOOLCHAIN_IMAGE) cargo clean || true
	docker volume rm -f $(CARGO_CACHE_VOLUME) $(TARGET_VOLUME) || true
```

- [ ] **Step 3: Run to verify the toolchain image builds and the scaffold test passes through it**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 1 passed; 0 failed` for `smoke_scaffold`, with no host `cargo`/`rustc` invoked (only `docker build`/`docker run`).

- [ ] **Step 4: Commit**

Stage `core/svc_action/Dockerfile.ci`, `core/svc_action/Makefile` and commit with message:

```
chore(svc-action): containerized toolchain image + make targets

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 3: Config module

**Files:**
- Create: `core/svc_action/src/config.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod config;`)
- Test: inline `#[cfg(test)] mod tests` in `config.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `config::{CliConfig, Config, Secret, ConfigError}` — `Config::load()`/`Config::from_cli(cli)`, `Config.cli.{module_port, metrics_port, bind_addr, host_api_port, hub_api_url, distribution_url(), poll_interval_s, base_backoff_s, max_backoff_s, runner_tenant_slug, runner_community_id, db_host, db_port, db_name, db_user, db_sslmode, db_sslrootcert, security_transport_tls, security_transport_auth, action_max_retries, action_base_backoff_ms, action_max_backoff_ms, spine_consumer_id, spine_stream_maxlen, spine_read_count, spine_block_ms, spine_claim_idle_ms, spine_claim_interval_ms, spine_dlq_maxlen, spine_max_deliveries, executor_max_frame_bytes, executor_call_timeout_ms, executor_max_call_timeout_ms, sandbox_runtime_expected, waddles_sandbox_gvisor, executor_wasm_collector, kv_max_value_bytes, kv_max_ttl_s, egress_timeout_ms, egress_max_response_bytes, egress_rate_limit_rps, egress_rate_limit_burst, egress_max_redirects, egress_allow_private_hosts, startup_probe_timeout_ms, startup_probe_attempts, host_api_port, host_api_tls_cert_file, host_api_tls_key_file, host_api_tls_ca_file, host_api_peer_identity}`, `Config.{db_password, valkey_url, valkey_password, secret_key, jwt_scope}` — every later task's config field references match these names exactly.

- [ ] **Step 1: Write the failing tests** (top of a new `src/config.rs`, `#[cfg(test)]` module at the bottom of the same file per Step 3)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn clear_secret_env() {
        for var in ["DB_PASSWORD", "VALKEY_PASSWORD", "SECRET_KEY"] {
            // SAFETY: serialized by ENV_LOCK, no concurrent readers/writers
            // of these specific variables within the test process.
            unsafe { std::env::remove_var(var) };
        }
    }

    #[test]
    fn defaults_parse_from_empty_args() {
        let cli = CliConfig::parse_from(["svc-action"]);
        assert_eq!(cli.module_port, 8202);
        assert_eq!(cli.metrics_port, 9090);
        assert_eq!(cli.host_api_port, 8302);
        assert_eq!(cli.runner_tenant_slug, "global");
        assert_eq!(cli.action_max_retries, 3);
        assert_eq!(cli.action_base_backoff_ms, 250);
        assert_eq!(cli.action_max_backoff_ms, 8000);
        assert!(cli.security_transport_tls);
        assert!(cli.security_transport_auth);
        cli.validate().expect("defaults must be valid");
    }

    #[test]
    fn zero_port_fails_validation() {
        let cli = CliConfig::parse_from(["svc-action", "--module-port", "0"]);
        assert!(cli.validate().is_err());
    }

    #[test]
    fn load_fails_without_required_secrets() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_secret_env();
        // SAFETY: serialized by ENV_LOCK.
        unsafe { std::env::set_var("VALKEY_URL", "rediss://valkey:6379/0") };
        let cli = CliConfig::parse_from(["svc-action"]);
        let err = Config::from_cli(cli).unwrap_err();
        assert_eq!(err, ConfigError::MissingEnv("DB_PASSWORD"));
        // SAFETY: serialized by ENV_LOCK.
        unsafe { std::env::remove_var("VALKEY_URL") };
    }

    #[test]
    fn load_succeeds_with_required_secrets_set() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_secret_env();
        // SAFETY: serialized by ENV_LOCK.
        unsafe {
            std::env::set_var("DB_PASSWORD", "test-db-pass");
            std::env::set_var("VALKEY_PASSWORD", "test-valkey-pass");
            std::env::set_var("SECRET_KEY", "test-secret-key");
            std::env::set_var("VALKEY_URL", "rediss://valkey:6379/0");
        }
        let cli = CliConfig::parse_from(["svc-action"]);
        let cfg = Config::from_cli(cli).expect("secrets are set");
        assert_eq!(cfg.db_password.expose(), "test-db-pass");
        assert_eq!(cfg.secret_key.expose(), "test-secret-key");
        assert_eq!(cfg.valkey_url, "rediss://valkey:6379/0");
        clear_secret_env();
        // SAFETY: serialized by ENV_LOCK.
        unsafe { std::env::remove_var("VALKEY_URL") };
    }

    #[test]
    fn debug_never_prints_secret_bytes() {
        let secret = Secret::new("super-secret-value");
        let rendered = format!("{secret:?}");
        assert!(!rendered.contains("super-secret-value"));
        assert!(rendered.contains("redacted"));
    }

    #[test]
    fn insecure_transport_opt_out_is_readable_from_env() {
        let cli = CliConfig::parse_from([
            "svc-action",
            "--security-transport-tls",
            "false",
            "--security-transport-auth",
            "false",
        ]);
        assert!(!cli.security_transport_tls);
        assert!(!cli.security_transport_auth);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL with `cannot find type CliConfig`/`Config` in this scope (module does not exist yet).

- [ ] **Step 3: Write `src/config.rs`** (the test module from Step 1 goes at the bottom of this same file)

```rust
//! Environment-driven configuration.
//!
//! Non-secret operational settings are parsed via `clap` (CLI flags with
//! an `env` fallback) for operability. Secrets (DB/Valkey passwords, the
//! service JWT signing key) are read directly from the environment only
//! and are never exposed as a CLI flag -- `rules/critical-rules.md` Token
//! & Secret Hygiene.

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
    /// A value was present but failed validation.
    #[error("invalid value for {field}: {reason}")]
    InvalidValue { field: &'static str, reason: String },
}

/// A secret value whose `Debug` implementation never prints the underlying
/// bytes -- guards against accidental exposure via `tracing::debug!(?cfg)`
/// or a panic message.
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

/// CLI/env-configurable operational settings (non-secret). Every field has
/// an `env` fallback so Helm/Docker deployments never need CLI args.
#[derive(Parser, Debug, Clone)]
#[command(name = "svc-action", version, about = "Waddles action-stage data-plane service")]
pub struct CliConfig {
    /// Control-plane HTTP port (`/health`, `/healthz`).
    #[arg(long, env = "MODULE_PORT", default_value_t = 8202)]
    pub module_port: u16,
    /// Prometheus `/metrics` exposition port.
    #[arg(long, env = "METRICS_PORT", default_value_t = 9090)]
    pub metrics_port: u16,
    /// Address the HTTP/metrics listeners bind to.
    #[arg(long, env = "BIND_ADDR", default_value = "0.0.0.0")]
    pub bind_addr: IpAddr,
    /// mTLS host-API port the `svc-action-executor` Deployment dials into.
    #[arg(long, env = "HOST_API_PORT", default_value_t = 8302)]
    pub host_api_port: u16,
    /// Path to the host-API server certificate (PEM).
    #[arg(long, env = "HOST_API_TLS_CERT_FILE", default_value = "/etc/waddles/host-api/tls.crt")]
    pub host_api_tls_cert_file: String,
    /// Path to the host-API server private key (PEM).
    #[arg(long, env = "HOST_API_TLS_KEY_FILE", default_value = "/etc/waddles/host-api/tls.key")]
    pub host_api_tls_key_file: String,
    /// Path to the CA bundle used to verify the executor's client certificate.
    #[arg(long, env = "HOST_API_TLS_CA_FILE", default_value = "/etc/waddles/host-api/ca.crt")]
    pub host_api_tls_ca_file: String,
    /// The executor's expected peer identity (SPIFFE ID or certificate CN).
    #[arg(
        long,
        env = "HOST_API_PEER_IDENTITY",
        default_value = "spiffe://penguintech.io/alpha/svc-action-executor"
    )]
    pub host_api_peer_identity: String,

    /// Distribution API base (hub-api).
    #[arg(long, env = "HUB_API_URL", default_value = "http://hub-api.waddles.svc.cluster.local:8204")]
    pub hub_api_url: String,
    /// Overrides the derived `{hub_api_url}/api/v1/distribution/bundles` URL.
    #[arg(long, env = "DISTRIBUTION_URL")]
    pub distribution_url: Option<String>,
    /// Bundle-set/grant refresh cadence.
    #[arg(long, env = "POLL_INTERVAL_S", default_value_t = 5.0)]
    pub poll_interval_s: f64,
    #[arg(long, env = "BASE_BACKOFF_S", default_value_t = 1.0)]
    pub base_backoff_s: f64,
    #[arg(long, env = "MAX_BACKOFF_S", default_value_t = 60.0)]
    pub max_backoff_s: f64,

    /// Fixed tenant slug per deployment.
    #[arg(long, env = "RUNNER_TENANT_SLUG", default_value = "global")]
    pub runner_tenant_slug: String,
    /// `None` = tenant-wide.
    #[arg(long, env = "RUNNER_COMMUNITY_ID")]
    pub runner_community_id: Option<i64>,

    /// Postgres host/port/name/user (svc_action's own per-service role).
    #[arg(long, env = "DB_HOST", default_value = "localhost")]
    pub db_host: String,
    #[arg(long, env = "DB_PORT", default_value_t = 5432)]
    pub db_port: u16,
    #[arg(long, env = "DB_NAME", default_value = "waddlebot")]
    pub db_name: String,
    #[arg(long, env = "DB_USER", default_value = "svc_action")]
    pub db_user: String,
    #[arg(long, env = "DB_SSLMODE", default_value = "verify-full")]
    pub db_sslmode: String,
    #[arg(long, env = "DB_SSLROOTCERT", default_value = "/etc/waddles/ca/postgres-ca.crt")]
    pub db_sslrootcert: String,

    /// D20: TLS/auth default on; a normal, visible opt-out.
    #[arg(long, env = "SECURITY_TRANSPORT_TLS", default_value_t = true)]
    pub security_transport_tls: bool,
    #[arg(long, env = "SECURITY_TRANSPORT_AUTH", default_value_t = true)]
    pub security_transport_auth: bool,

    /// Retry-with-backoff (spec Sec 4.3).
    #[arg(long, env = "ACTION_MAX_RETRIES", default_value_t = 3)]
    pub action_max_retries: u32,
    #[arg(long, env = "ACTION_BASE_BACKOFF_MS", default_value_t = 250)]
    pub action_base_backoff_ms: u64,
    #[arg(long, env = "ACTION_MAX_BACKOFF_MS", default_value_t = 8000)]
    pub action_max_backoff_ms: u64,

    /// Spine (spec Sec 12.7).
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
    #[arg(long, env = "SPINE_DLQ_MAXLEN", default_value_t = 10_000)]
    pub spine_dlq_maxlen: u64,
    #[arg(long, env = "SPINE_MAX_DELIVERIES", default_value_t = 5)]
    pub spine_max_deliveries: u32,

    /// Executor/host-API limits (spec Sec 7.3, Sec 12.7).
    #[arg(long, env = "EXECUTOR_MAX_FRAME_BYTES", default_value_t = 1_048_576)]
    pub executor_max_frame_bytes: usize,
    #[arg(long, env = "EXECUTOR_CALL_TIMEOUT_MS", default_value_t = 2000)]
    pub executor_call_timeout_ms: u64,
    #[arg(long, env = "EXECUTOR_MAX_CALL_TIMEOUT_MS", default_value_t = 10_000)]
    pub executor_max_call_timeout_ms: u64,
    #[arg(long, env = "SANDBOX_RUNTIME_EXPECTED", default_value = "gvisor")]
    pub sandbox_runtime_expected: String,
    #[arg(long, env = "WADDLES_SANDBOX_GVISOR", default_value_t = true)]
    pub waddles_sandbox_gvisor: bool,
    #[arg(long, env = "EXECUTOR_WASM_COLLECTOR", default_value = "drc")]
    pub executor_wasm_collector: String,

    /// `kv` capability limits.
    #[arg(long, env = "KV_MAX_VALUE_BYTES", default_value_t = 65_536)]
    pub kv_max_value_bytes: usize,
    #[arg(long, env = "KV_MAX_TTL_S", default_value_t = 2_592_000)]
    pub kv_max_ttl_s: u64,

    /// `http` capability egress limits (spec Sec 8.2, Sec 12.7).
    #[arg(long, env = "EGRESS_TIMEOUT_MS", default_value_t = 5000)]
    pub egress_timeout_ms: u64,
    #[arg(long, env = "EGRESS_MAX_RESPONSE_BYTES", default_value_t = 1_048_576)]
    pub egress_max_response_bytes: usize,
    #[arg(long, env = "EGRESS_RATE_LIMIT_RPS", default_value_t = 10)]
    pub egress_rate_limit_rps: u32,
    #[arg(long, env = "EGRESS_RATE_LIMIT_BURST", default_value_t = 20)]
    pub egress_rate_limit_burst: u32,
    #[arg(long, env = "EGRESS_MAX_REDIRECTS", default_value_t = 3)]
    pub egress_max_redirects: u8,
    #[arg(long, env = "EGRESS_ALLOW_PRIVATE_HOSTS", default_value_t = false)]
    pub egress_allow_private_hosts: bool,

    /// Startup connectivity self-check (spec Sec 12.6).
    #[arg(long, env = "STARTUP_PROBE_TIMEOUT_MS", default_value_t = 5000)]
    pub startup_probe_timeout_ms: u64,
    #[arg(long, env = "STARTUP_PROBE_ATTEMPTS", default_value_t = 3)]
    pub startup_probe_attempts: u32,
}

impl CliConfig {
    /// Validates cross-field invariants `clap`'s per-arg parsing can't
    /// express (non-zero ports, executor timeout ordering).
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.module_port == 0 || self.metrics_port == 0 || self.host_api_port == 0 {
            return Err(ConfigError::InvalidValue {
                field: "module_port/metrics_port/host_api_port",
                reason: "port 0 is not a valid bind port".to_string(),
            });
        }
        if self.executor_call_timeout_ms > self.executor_max_call_timeout_ms {
            return Err(ConfigError::InvalidValue {
                field: "executor_call_timeout_ms",
                reason: "must not exceed executor_max_call_timeout_ms".to_string(),
            });
        }
        Ok(())
    }

    /// `{hub_api_url}/api/v1/distribution/bundles`, unless overridden.
    pub fn distribution_url(&self) -> String {
        self.distribution_url
            .clone()
            .unwrap_or_else(|| format!("{}/api/v1/distribution/bundles", self.hub_api_url))
    }
}

/// Fully-loaded runtime configuration: operational settings plus secrets
/// pulled directly from the environment (never via CLI flag).
#[derive(Clone)]
pub struct Config {
    pub cli: CliConfig,
    pub db_password: Secret,
    pub valkey_url: String,
    pub valkey_password: Option<Secret>,
    pub secret_key: Secret,
    /// Fixed scope for the distribution-poll service JWT this runner mints
    /// for itself (unchanged mechanism from the Python service).
    pub jwt_scope: &'static str,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("cli", &self.cli)
            .field("db_password", &Secret::new(""))
            .field("valkey_url", &"[redacted-url]")
            .field("valkey_password", &self.valkey_password.as_ref().map(|_| Secret::new("")))
            .field("secret_key", &Secret::new(""))
            .finish()
    }
}

impl Config {
    /// Loads configuration from CLI args + environment.
    pub fn load() -> Result<Self, ConfigError> {
        let cli = CliConfig::parse();
        Self::from_cli(cli)
    }

    /// Builds a [`Config`] from an already-parsed [`CliConfig`], reading
    /// secrets from the environment. Split from [`Self::load`] so tests
    /// can supply CLI args explicitly.
    pub fn from_cli(cli: CliConfig) -> Result<Self, ConfigError> {
        cli.validate()?;
        let db_password = Secret::new(env_required("DB_PASSWORD")?);
        let valkey_url = std::env::var("VALKEY_URL")
            .or_else(|_| std::env::var("REDIS_URL"))
            .map_err(|_| ConfigError::MissingEnv("VALKEY_URL"))?;
        let valkey_password = std::env::var("VALKEY_PASSWORD").ok().map(Secret::new);
        let secret_key = Secret::new(env_required("SECRET_KEY")?);
        Ok(Self {
            cli,
            db_password,
            valkey_url,
            valkey_password,
            secret_key,
            jwt_scope: "distribution:read",
        })
    }
}

fn env_required(name: &'static str) -> Result<String, ConfigError> {
    std::env::var(name).map_err(|_| ConfigError::MissingEnv(name))
}
```

- [ ] **Step 4: Add the module to `src/lib.rs`**

```rust
pub mod config;
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 6 passed; 0 failed` for the `config::tests` module.

- [ ] **Step 6: Commit**

Stage `core/svc_action/src/config.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): environment/CLI configuration module

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 4: `error.rs` — typed API error surface

**Files:**
- Create: `core/svc_action/src/error.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod error;`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `error::ApiError` with variants `{BadRequest(String), NotFound(String), Unimplemented(String), Internal(anyhow::Error)}`, implementing `axum::response::IntoResponse` — every axum handler in later tasks returns `Result<T, ApiError>`.

- [ ] **Step 1: Write `src/error.rs`** (test module included at the bottom)

```rust
//! Typed API error surface for axum handlers. Every handler returns
//! `Result<T, ApiError>` so the HTTP boundary never leaks a bare
//! `anyhow::Error` -- `rules/security.md` Output Validation.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use thiserror::Error;

/// The single error type returned by every axum handler in this service.
/// Each variant maps to a specific HTTP status; internal error detail is
/// logged via `tracing` and never echoed back to the caller.
#[derive(Debug, Error)]
pub enum ApiError {
    /// Caller input failed validation -- maps to 400.
    #[error("bad request: {0}")]
    BadRequest(String),
    /// Resource does not exist -- maps to 404.
    #[error("not found: {0}")]
    NotFound(String),
    /// Route/feature exists but is not yet wired -- maps to 501.
    #[error("not yet implemented: {0}")]
    Unimplemented(String),
    /// Anything else -- maps to 500, detail is logged not returned.
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
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::Unimplemented(_) => (StatusCode::NOT_IMPLEMENTED, "not_implemented"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn bad_request_maps_to_400() {
        let resp = ApiError::BadRequest("missing field".into()).into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["error"], "bad_request");
    }

    #[tokio::test]
    async fn internal_error_hides_detail() {
        let resp = ApiError::Internal(anyhow::anyhow!("db connection string leaked")).into_response();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["message"], "an internal error occurred");
    }

    #[tokio::test]
    async fn unimplemented_maps_to_501() {
        let resp = ApiError::Unimplemented("feature".into()).into_response();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
```

- [ ] **Step 2: Add the module to `src/lib.rs`**

```rust
pub mod error;
```

- [ ] **Step 3: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 3 passed; 0 failed` for `error::tests`.

- [ ] **Step 4: Commit**

Stage `core/svc_action/src/error.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): typed ApiError HTTP surface

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 5: `sanitize.rs` — `SENSITIVE_KEYS` log sanitizer

**Files:**
- Create: `core/svc_action/src/sanitize.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod sanitize;`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sanitize::{sanitize_json_value, SENSITIVE_KEYS}` — Task 16's `log` host capability calls `sanitize_json_value` on every `fields-json` payload before emission; Task 6's telemetry module does not call this directly (it sanitizes only guest-supplied log fields, never `tracing`'s own structured fields, which this codebase never populates with secrets in the first place).

- [ ] **Step 1: Write the failing tests** (top of a new `src/sanitize.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_key_match_is_redacted() {
        let input = json!({"password": "hunter2", "user": "alice"});
        let out = sanitize_json_value(&input);
        assert_eq!(out["password"], "[REDACTED]");
        assert_eq!(out["user"], "alice");
    }

    #[test]
    fn substring_key_match_is_redacted() {
        let input = json!({"api_key_extra": "sk-live-abc", "note": "ok"});
        let out = sanitize_json_value(&input);
        assert_eq!(out["api_key_extra"], "[REDACTED]");
        assert_eq!(out["note"], "ok");
    }

    #[test]
    fn key_match_is_case_insensitive() {
        let input = json!({"Authorization": "Bearer xyz"});
        let out = sanitize_json_value(&input);
        assert_eq!(out["Authorization"], "[REDACTED]");
    }

    #[test]
    fn nested_objects_are_recursed_into() {
        let input = json!({"outer": {"token": "abc", "safe": 1}});
        let out = sanitize_json_value(&input);
        assert_eq!(out["outer"]["token"], "[REDACTED]");
        assert_eq!(out["outer"]["safe"], 1);
    }

    #[test]
    fn object_items_inside_arrays_are_sanitized() {
        let input = json!({"items": [{"secret": "x"}, {"safe": "y"}]});
        let out = sanitize_json_value(&input);
        assert_eq!(out["items"][0]["secret"], "[REDACTED]");
        assert_eq!(out["items"][1]["safe"], "y");
    }

    #[test]
    fn plain_array_items_pass_through_unchanged() {
        let input = json!({"tags": ["a", "b", "c"]});
        let out = sanitize_json_value(&input);
        assert_eq!(out["tags"], json!(["a", "b", "c"]));
    }

    #[test]
    fn email_shaped_string_value_is_partially_redacted() {
        let input = json!({"contact": "user@example.com"});
        let out = sanitize_json_value(&input);
        assert_eq!(out["contact"], "[email]@example.com");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL with `cannot find function sanitize_json_value` (module does not exist yet).

- [ ] **Step 3: Write `src/sanitize.rs`** (test module from Step 1 goes at the bottom)

```rust
//! Verbatim port of `penguin_libs.packages.python-utils`'s
//! `sanitize_log_data` sanitization contract (`docs/plan-penguin-logging`
//! Global Constraints, itself sourced from
//! `penguin-libs/packages/python-utils/src/penguintechinc_utils/logging.py`)
//! -- applied here to the `log` host capability's `fields-json` payload
//! before anything is emitted. See this plan's Global Constraints P5 for
//! why this is a local port rather than a `penguin-logging` dependency.

use serde_json::Value;

/// Keys redacted by exact match or case-insensitive substring match.
pub const SENSITIVE_KEYS: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "auth_token",
    "authtoken",
    "access_token",
    "refresh_token",
    "credential",
    "credentials",
    "mfa_code",
    "totp_code",
    "otp",
    "captcha_token",
    "session_id",
    "sessionid",
    "cookie",
    "authorization",
];

fn key_is_sensitive(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SENSITIVE_KEYS.iter().any(|s| lower == *s || lower.contains(s))
}

/// True when `value` is a bare string that looks like a single email
/// address (exactly one `@`), anchored at the start.
fn looks_like_single_email(value: &str) -> bool {
    let re = regex::Regex::new(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
        .expect("static regex is valid");
    re.is_match(value) && value.matches('@').count() == 1
}

fn sanitize_scalar(value: &str) -> String {
    if !looks_like_single_email(value) {
        return value.to_string();
    }
    match value.split_once('@') {
        Some((_, domain)) => format!("[email]@{domain}"),
        None => "[REDACTED_EMAIL]".to_string(),
    }
}

/// Recursively sanitizes `value`: object keys matching [`SENSITIVE_KEYS`]
/// (exact or substring, case-insensitive) become the literal
/// `"[REDACTED]"`; email-shaped string values are rewritten to
/// `"[email]@{domain}"`; nested objects recurse; array items are
/// sanitized only when they are themselves objects -- a plain
/// string/number array item passes through unchanged, matching the
/// ported Python behavior exactly.
pub fn sanitize_json_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                if key_is_sensitive(k) {
                    out.insert(k.clone(), Value::String("[REDACTED]".to_string()));
                } else {
                    out.insert(k.clone(), sanitize_json_value(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| if item.is_object() { sanitize_json_value(item) } else { item.clone() })
                .collect(),
        ),
        Value::String(s) => Value::String(sanitize_scalar(s)),
        other => other.clone(),
    }
}
```

- [ ] **Step 4: Add the module to `src/lib.rs`**

```rust
pub mod sanitize;
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 7 passed; 0 failed` for `sanitize::tests`.

- [ ] **Step 6: Commit**

Stage `core/svc_action/src/sanitize.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): SENSITIVE_KEYS log sanitizer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 6: `telemetry.rs` — OTel init + Prometheus registry

**Files:**
- Create: `core/svc_action/src/telemetry.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod telemetry;`)

**Interfaces:**
- Consumes: `SERVICE_NAME` (Task 1).
- Produces: `telemetry::{init, render_metrics, register_request_metrics, RequestMetrics, TelemetryGuard}` — `init(default_service_name) -> (TelemetryGuard, prometheus::Registry)`; `register_request_metrics(&registry) -> RequestMetrics` with fields `{http_requests_total, http_request_duration_seconds}` — Task 9's `AppState::new` and Task 8's `/metrics` handler consume these exact names.

- [ ] **Step 1: Write `src/telemetry.rs`** (ported verbatim from `core/svc_streaming/src/telemetry.rs`, service-name-agnostic; test module included at the bottom)

```rust
//! Telemetry bootstrap: `tracing` (structured logs, stdout JSON) +
//! OpenTelemetry OTLP traces/metrics + a Prometheus registry for the
//! secondary `/metrics` scrape surface.
//!
//! The OTLP destination is always env-configured
//! (`OTEL_EXPORTER_OTLP_ENDPOINT`/`_PROTOCOL`/`_HEADERS`,
//! `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`), never hardcoded --
//! `rules/critical-rules.md` Observability. Ported from
//! `core/svc_streaming/src/telemetry.rs` (this plan's Global Constraints
//! P5 explains why this is a local module rather than a `penguin-logging`
//! dependency).

use opentelemetry::global;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// Holds OTel provider handles that must be flushed/shut down at process
/// exit. Dropping this guard flushes any buffered spans/metrics.
pub struct TelemetryGuard {
    tracer_provider: Option<SdkTracerProvider>,
    meter_provider: Option<SdkMeterProvider>,
}

impl TelemetryGuard {
    /// Flushes and shuts down any active OTLP pipelines. Errors are
    /// logged, never propagated -- shutdown must not be able to fail.
    pub fn shutdown(&mut self) {
        if let Some(provider) = self.tracer_provider.take() {
            if let Err(err) = provider.shutdown() {
                eprintln!("otel tracer provider shutdown error: {err}");
            }
        }
        if let Some(provider) = self.meter_provider.take() {
            if let Err(err) = provider.shutdown() {
                eprintln!("otel meter provider shutdown error: {err}");
            }
        }
    }
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn otlp_protocol() -> Protocol {
    match std::env::var("OTEL_EXPORTER_OTLP_PROTOCOL").as_deref() {
        Ok("http/protobuf") => Protocol::HttpBinary,
        _ => Protocol::Grpc,
    }
}

fn resource(default_service_name: &str) -> Resource {
    let service_name =
        std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| default_service_name.to_string());
    Resource::builder().with_service_name(service_name).build()
}

fn build_tracer_provider(endpoint: &str, res: Resource) -> anyhow::Result<SdkTracerProvider> {
    let exporter = match otlp_protocol() {
        Protocol::Grpc => opentelemetry_otlp::SpanExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint)
            .build()?,
        _ => opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(endpoint)
            .build()?,
    };
    Ok(SdkTracerProvider::builder().with_batch_exporter(exporter).with_resource(res).build())
}

fn build_meter_provider(endpoint: &str, res: Resource) -> anyhow::Result<SdkMeterProvider> {
    let exporter = match otlp_protocol() {
        Protocol::Grpc => opentelemetry_otlp::MetricExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint)
            .build()?,
        _ => opentelemetry_otlp::MetricExporter::builder()
            .with_http()
            .with_endpoint(endpoint)
            .build()?,
    };
    Ok(SdkMeterProvider::builder().with_periodic_exporter(exporter).with_resource(res).build())
}

/// Initializes `tracing` (env-filtered, JSON to stdout) plus best-effort
/// OTLP trace/metric export, and returns a fresh Prometheus registry for
/// the `/metrics` HTTP surface. Call exactly once, before any other
/// `tracing` macro use.
pub fn init(default_service_name: &str) -> (TelemetryGuard, prometheus::Registry) {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok();

    let (tracer_provider, meter_provider) = match &endpoint {
        Some(endpoint) => {
            let res = resource(default_service_name);
            let tracer = build_tracer_provider(endpoint, res.clone())
                .inspect_err(|err| eprintln!("otel trace exporter init failed, continuing without traces: {err}"))
                .ok();
            let meter = build_meter_provider(endpoint, res)
                .inspect_err(|err| eprintln!("otel metric exporter init failed, continuing without OTLP metrics: {err}"))
                .ok();
            (tracer, meter)
        }
        None => (None, None),
    };

    if let Some(provider) = &meter_provider {
        global::set_meter_provider(provider.clone());
    }

    let fmt_layer = tracing_subscriber::fmt::layer().json();
    let registry = tracing_subscriber::registry().with(env_filter).with(fmt_layer);

    match &tracer_provider {
        Some(provider) => {
            let tracer = provider.tracer(default_service_name.to_string());
            registry.with(tracing_opentelemetry::layer().with_tracer(tracer)).init();
        }
        None => registry.init(),
    }

    (TelemetryGuard { tracer_provider, meter_provider }, prometheus::Registry::new())
}

/// Renders the Prometheus text-format exposition body for `/metrics`.
pub fn render_metrics(registry: &prometheus::Registry) -> anyhow::Result<String> {
    use prometheus::Encoder;
    let metric_families = registry.gather();
    let mut buf = Vec::new();
    prometheus::TextEncoder::new().encode(&metric_families, &mut buf)?;
    Ok(String::from_utf8(buf)?)
}

/// Base HTTP request metrics registered once against the Prometheus
/// registry. Histograms come first per `rules/critical-rules.md`
/// Observability -- a lone request counter is not instrumentation.
#[derive(Clone)]
pub struct RequestMetrics {
    pub http_requests_total: prometheus::IntCounterVec,
    pub http_request_duration_seconds: prometheus::HistogramVec,
}

/// Registers this service's base Prometheus metrics against `registry`.
/// Must be called exactly once per `registry`.
pub fn register_request_metrics(registry: &prometheus::Registry) -> RequestMetrics {
    let up = prometheus::IntGauge::new("svc_action_up", "1 if the process is running")
        .expect("valid metric definition");
    registry.register(Box::new(up.clone())).expect("register svc_action_up");
    up.set(1);

    let http_requests_total = prometheus::IntCounterVec::new(
        prometheus::Opts::new("svc_action_http_requests_total", "Total HTTP requests, labeled by method/path/status"),
        &["method", "path", "status"],
    )
    .expect("valid metric definition");
    registry.register(Box::new(http_requests_total.clone())).expect("register svc_action_http_requests_total");

    let http_request_duration_seconds = prometheus::HistogramVec::new(
        prometheus::HistogramOpts::new("svc_action_http_request_duration_seconds", "HTTP request duration in seconds"),
        &["method", "path"],
    )
    .expect("valid metric definition");
    registry
        .register(Box::new(http_request_duration_seconds.clone()))
        .expect("register svc_action_http_request_duration_seconds");

    RequestMetrics { http_requests_total, http_request_duration_seconds }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn register_request_metrics_produces_a_non_empty_exposition() {
        let registry = prometheus::Registry::new();
        let metrics = register_request_metrics(&registry);
        metrics.http_requests_total.with_label_values(&["GET", "/health", "200"]).inc();
        metrics.http_request_duration_seconds.with_label_values(&["GET", "/health"]).observe(0.001);
        let rendered = render_metrics(&registry).expect("registry with metrics must encode");
        assert!(rendered.contains("svc_action_up 1"));
        assert!(rendered.contains("svc_action_http_requests_total"));
        assert!(rendered.contains("svc_action_http_request_duration_seconds"));
    }

    #[test]
    fn otlp_protocol_defaults_to_grpc() {
        let _guard = ENV_LOCK.lock().unwrap();
        // SAFETY: serialized by ENV_LOCK.
        unsafe { std::env::remove_var("OTEL_EXPORTER_OTLP_PROTOCOL") };
        assert!(matches!(otlp_protocol(), Protocol::Grpc));
    }

    #[test]
    fn otlp_protocol_recognizes_http_protobuf() {
        let _guard = ENV_LOCK.lock().unwrap();
        // SAFETY: serialized by ENV_LOCK.
        unsafe { std::env::set_var("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf") };
        assert!(matches!(otlp_protocol(), Protocol::HttpBinary));
        // SAFETY: serialized by ENV_LOCK.
        unsafe { std::env::remove_var("OTEL_EXPORTER_OTLP_PROTOCOL") };
    }

    #[test]
    fn render_metrics_on_empty_registry_is_empty_string() {
        let registry = prometheus::Registry::new();
        let rendered = render_metrics(&registry).expect("empty registry still encodes");
        assert!(rendered.is_empty());
    }
}
```

- [ ] **Step 2: Add the module to `src/lib.rs`**

```rust
pub mod telemetry;
```

- [ ] **Step 3: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 4 passed; 0 failed` for `telemetry::tests`.

- [ ] **Step 4: Commit**

Stage `core/svc_action/src/telemetry.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): OTel + Prometheus telemetry bootstrap

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 7: Startup connectivity self-check (spec §12.6)

**Files:**
- Create: `core/svc_action/src/startup_check.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod startup_check;`)

**Interfaces:**
- Consumes: `config::Config` (Task 3).
- Produces: `startup_check::{ProbeClass, ProbeResult, SelfCheckReport, DependencyMetrics, run_self_check}` — `run_self_check(&Config, &prometheus::Registry) -> SelfCheckReport`, `SelfCheckReport.{results: Vec<ProbeResult>, all_required_ok: bool}`, `ProbeResult.{dependency: &'static str, class: ProbeClass, required: bool, detail: String}`, `ProbeClass::{Dns, Tcp, Tls, Auth, Ok}` — Task 8's `/health` handler renders `SelfCheckReport` under `dependencies`; Task 10's `run()` calls `std::process::exit(78)` when `!report.all_required_ok`.

- [ ] **Step 1: Write the failing tests** (top of a new `src/startup_check.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_failure_is_classified_dns() {
        let result = classify_tcp_error("dns error: failed to lookup address information: Name or service not known");
        assert_eq!(result, ProbeClass::Dns);
    }

    #[test]
    fn connection_refused_is_classified_tcp() {
        let result = classify_tcp_error("Connection refused (os error 111)");
        assert_eq!(result, ProbeClass::Tcp);
    }

    #[test]
    fn certificate_failure_is_classified_tls() {
        let result = classify_tcp_error("invalid peer certificate: UnknownIssuer");
        assert_eq!(result, ProbeClass::Tls);
    }

    #[test]
    fn auth_failure_is_classified_auth() {
        let result = classify_tcp_error("NOAUTH Authentication required");
        assert_eq!(result, ProbeClass::Auth);
    }

    #[test]
    fn unrecognized_error_falls_back_to_tcp() {
        let result = classify_tcp_error("some unexpected failure");
        assert_eq!(result, ProbeClass::Tcp);
    }

    #[tokio::test]
    async fn valkey_probe_against_an_unreachable_host_reports_a_non_ok_class() {
        let probe = probe_valkey("rediss://127.0.0.1:1/0", std::time::Duration::from_millis(200)).await;
        assert_ne!(probe.class, ProbeClass::Ok);
        assert_eq!(probe.dependency, "valkey");
    }

    #[tokio::test]
    async fn otlp_probe_is_never_required() {
        let probe = probe_otlp_tcp(None, std::time::Duration::from_millis(200)).await;
        assert!(!probe.required);
        assert_eq!(probe.class, ProbeClass::Ok);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL with `cannot find function classify_tcp_error`/`probe_valkey`/`probe_otlp_tcp` (module does not exist yet).

- [ ] **Step 3: Write `src/startup_check.rs`** (test module from Step 1 goes at the bottom)

```rust
//! Startup connectivity self-check (spec Sec 12.6): before draining
//! anything, probe every infrastructure endpoint this service is
//! configured with and report a classified result -- never a bare
//! "connection failed". A required endpoint still failing after
//! `STARTUP_PROBE_ATTEMPTS` is `exit(78)` (`EX_CONFIG`); the OTLP
//! collector is the one non-required probe.

use std::time::Duration;

use crate::config::Config;

/// The classified outcome of one connectivity probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeClass {
    /// The hostname did not resolve.
    Dns,
    /// Resolved, but the connection was refused/timed out/blocked.
    Tcp,
    /// Connected, but the TLS handshake or certificate verification failed.
    Tls,
    /// TLS succeeded, credentials were rejected.
    Auth,
    /// Reachable and authenticated.
    Ok,
}

impl ProbeClass {
    /// The label used on `waddles_dependency_check_total{class}`.
    pub fn label(self) -> &'static str {
        match self {
            ProbeClass::Dns => "dns",
            ProbeClass::Tcp => "tcp",
            ProbeClass::Tls => "tls",
            ProbeClass::Auth => "auth",
            ProbeClass::Ok => "ok",
        }
    }
}

/// One probe's outcome: which dependency, whether the pipeline can start
/// without it, its classified result, and a human-readable detail line.
#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub dependency: &'static str,
    pub required: bool,
    pub class: ProbeClass,
    pub detail: String,
}

/// The full self-check outcome. `all_required_ok` is `false` when any
/// `required` probe did not reach [`ProbeClass::Ok`].
pub struct SelfCheckReport {
    pub results: Vec<ProbeResult>,
    pub all_required_ok: bool,
}

/// `waddles_dependency_up{dependency}` and
/// `waddles_dependency_check_total{dependency,class}` (spec Sec 12.6).
#[derive(Clone)]
pub struct DependencyMetrics {
    pub dependency_up: prometheus::IntGaugeVec,
    pub dependency_check_total: prometheus::IntCounterVec,
}

/// Registers the dependency-probe metrics against `registry`. Called
/// exactly once per process, alongside [`crate::telemetry::register_request_metrics`].
pub fn register_dependency_metrics(registry: &prometheus::Registry) -> DependencyMetrics {
    let dependency_up = prometheus::IntGaugeVec::new(
        prometheus::Opts::new("waddles_dependency_up", "1/0 per configured infrastructure endpoint"),
        &["dependency"],
    )
    .expect("valid metric definition");
    registry.register(Box::new(dependency_up.clone())).expect("register waddles_dependency_up");

    let dependency_check_total = prometheus::IntCounterVec::new(
        prometheus::Opts::new("waddles_dependency_check_total", "Startup/periodic probe outcomes"),
        &["dependency", "class"],
    )
    .expect("valid metric definition");
    registry
        .register(Box::new(dependency_check_total.clone()))
        .expect("register waddles_dependency_check_total");

    DependencyMetrics { dependency_up, dependency_check_total }
}

/// Classifies a connect/handshake error string into a [`ProbeClass`].
/// String-matched rather than downcast on a concrete error type because
/// this same classifier is shared across `redis`, `sqlx`/Postgres and
/// `reqwest` error shapes, none of which share a common trait for this.
pub fn classify_tcp_error(message: &str) -> ProbeClass {
    let lower = message.to_ascii_lowercase();
    if lower.contains("dns") || lower.contains("name or service not known") || lower.contains("nodename") {
        ProbeClass::Dns
    } else if lower.contains("certificate") || lower.contains("tls") || lower.contains("ssl") {
        ProbeClass::Tls
    } else if lower.contains("noauth")
        || lower.contains("authentication")
        || lower.contains("password")
        || lower.contains("wrongpass")
        || lower.contains("unauthorized")
    {
        ProbeClass::Auth
    } else {
        ProbeClass::Tcp
    }
}

/// Probes Valkey with a `PING`, retried up to `attempts` times at 1s
/// intervals, each bounded by `timeout`.
pub async fn probe_valkey(valkey_url: &str, timeout: Duration) -> ProbeResult {
    match tokio::time::timeout(timeout, ping_valkey(valkey_url)).await {
        Ok(Ok(())) => ProbeResult { dependency: "valkey", required: true, class: ProbeClass::Ok, detail: "reachable and authenticated".to_string() },
        Ok(Err(err)) => {
            let detail = err.to_string();
            ProbeResult { dependency: "valkey", required: true, class: classify_tcp_error(&detail), detail }
        }
        Err(_) => ProbeResult {
            dependency: "valkey",
            required: true,
            class: ProbeClass::Tcp,
            detail: format!("timed out after {}ms", timeout.as_millis()),
        },
    }
}

async fn ping_valkey(url: &str) -> Result<(), redis::RedisError> {
    let client = redis::Client::open(url)?;
    let mut conn = client.get_multiplexed_tokio_connection().await?;
    let _: String = redis::cmd("PING").query_async(&mut conn).await?;
    Ok(())
}

/// Probes hub-api's `/healthz` with a plain GET.
pub async fn probe_hub_api(hub_api_url: &str, timeout: Duration) -> ProbeResult {
    let url = format!("{hub_api_url}/healthz");
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(err) => {
            return ProbeResult { dependency: "hub_api", required: true, class: ProbeClass::Tcp, detail: err.to_string() }
        }
    };
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            ProbeResult { dependency: "hub_api", required: true, class: ProbeClass::Ok, detail: "reachable".to_string() }
        }
        Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED || resp.status() == reqwest::StatusCode::FORBIDDEN => {
            ProbeResult { dependency: "hub_api", required: true, class: ProbeClass::Auth, detail: format!("HTTP {}", resp.status()) }
        }
        Ok(resp) => ProbeResult { dependency: "hub_api", required: true, class: ProbeClass::Tcp, detail: format!("HTTP {}", resp.status()) },
        Err(err) => {
            let detail = err.to_string();
            ProbeResult { dependency: "hub_api", required: true, class: classify_tcp_error(&detail), detail }
        }
    }
}

/// Probes the OTLP collector with a bare TCP connect -- **never
/// required**: an unreachable collector logs at WARN and the service
/// still starts (telemetry failure is never a request failure).
pub async fn probe_otlp_tcp(endpoint: Option<&str>, timeout: Duration) -> ProbeResult {
    let Some(endpoint) = endpoint else {
        return ProbeResult { dependency: "otlp", required: false, class: ProbeClass::Ok, detail: "not configured".to_string() };
    };
    let host_port = endpoint
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string();
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&host_port)).await {
        Ok(Ok(_)) => ProbeResult { dependency: "otlp", required: false, class: ProbeClass::Ok, detail: "reachable".to_string() },
        Ok(Err(err)) => {
            let detail = err.to_string();
            ProbeResult { dependency: "otlp", required: false, class: classify_tcp_error(&detail), detail }
        }
        Err(_) => ProbeResult { dependency: "otlp", required: false, class: ProbeClass::Tcp, detail: "timed out".to_string() },
    }
}

/// Runs every configured probe up to `STARTUP_PROBE_ATTEMPTS` times (1s
/// between attempts), logs each classified failure at ERROR, records
/// `waddles_dependency_up`/`waddles_dependency_check_total`, and returns
/// the aggregate report. Never panics, never retries silently.
pub async fn run_self_check(cfg: &Config, metrics: &DependencyMetrics) -> SelfCheckReport {
    let timeout = Duration::from_millis(cfg.cli.startup_probe_timeout_ms);
    let attempts = cfg.cli.startup_probe_attempts.max(1);

    let mut results = Vec::new();
    for (probe_fn, name) in [(0u8, "valkey"), (1, "hub_api"), (2, "otlp")] {
        let mut last = match probe_fn {
            0 => probe_valkey(&cfg.valkey_url, timeout).await,
            1 => probe_hub_api(&cfg.cli.hub_api_url, timeout).await,
            _ => probe_otlp_tcp(std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok().as_deref(), timeout).await,
        };
        let mut attempt = 1;
        while last.class != ProbeClass::Ok && attempt < attempts {
            tokio::time::sleep(Duration::from_secs(1)).await;
            last = match probe_fn {
                0 => probe_valkey(&cfg.valkey_url, timeout).await,
                1 => probe_hub_api(&cfg.cli.hub_api_url, timeout).await,
                _ => probe_otlp_tcp(std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok().as_deref(), timeout).await,
            };
            attempt += 1;
        }
        metrics.dependency_check_total.with_label_values(&[name, last.class.label()]).inc();
        metrics.dependency_up.with_label_values(&[name]).set(if last.class == ProbeClass::Ok { 1 } else { 0 });
        if last.class != ProbeClass::Ok {
            if last.required {
                tracing::error!(dependency = name, class = last.class.label(), detail = %last.detail, "required dependency unreachable after {attempts} attempts");
            } else {
                tracing::warn!(dependency = name, class = last.class.label(), detail = %last.detail, "optional dependency unreachable");
            }
        }
        results.push(last);
    }

    let all_required_ok = results.iter().all(|r| !r.required || r.class == ProbeClass::Ok);
    SelfCheckReport { results, all_required_ok }
}
```

- [ ] **Step 4: Add the module to `src/lib.rs`**

```rust
pub mod startup_check;
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 7 passed; 0 failed` for `startup_check::tests`.

- [ ] **Step 6: Commit**

Stage `core/svc_action/src/startup_check.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): startup connectivity self-check (spec Sec 12.6)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 8: `http/health.rs` — rich `/health`, `/healthz`, `/metrics`

**Files:**
- Create: `core/svc_action/src/http/mod.rs`
- Create: `core/svc_action/src/http/health.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod http;`)

**Interfaces:**
- Consumes: `error::ApiError` (Task 4), `telemetry::{render_metrics, RequestMetrics}` (Task 6), `startup_check::{SelfCheckReport, ProbeResult}` (Task 7).
- Produces: `http::health::{HealthBody, TransportDetail, ExecutorStatus, SpineStatus, liveness, readiness_health, metrics}`; `http::AppState.{config, metrics_registry, request_metrics, started_at, self_check, executor_status, spine_status}` — Task 9's router wires these three handlers; Task 15 updates `AppState.executor_status` via `Arc<Mutex<ExecutorStatus>>`; Task 22 updates `AppState.spine_status` the same way.

- [ ] **Step 1: Write the failing tests** (top of a new `src/http/health.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CliConfig, Config, Secret};
    use crate::startup_check::{ProbeClass, ProbeResult, SelfCheckReport};
    use axum::extract::State;
    use clap::Parser;

    fn test_state() -> AppState {
        let cli = CliConfig::parse_from(["svc-action"]);
        let config = Config {
            cli,
            db_password: Secret::new("x"),
            valkey_url: "rediss://valkey:6379/0".to_string(),
            valkey_password: None,
            secret_key: Secret::new("x"),
            jwt_scope: "distribution:read",
        };
        let report = SelfCheckReport {
            results: vec![
                ProbeResult { dependency: "valkey", required: true, class: ProbeClass::Ok, detail: "ok".into() },
                ProbeResult { dependency: "hub_api", required: true, class: ProbeClass::Ok, detail: "ok".into() },
            ],
            all_required_ok: true,
        };
        AppState::new(config, prometheus::Registry::new(), report)
    }

    #[tokio::test]
    async fn liveness_reports_ok() {
        let axum::Json(body) = liveness(State(test_state())).await;
        assert_eq!(body.status, "ok");
    }

    #[tokio::test]
    async fn readiness_reports_secure_transport_by_default() {
        let axum::Json(body) = readiness_health(State(test_state())).await;
        assert_eq!(body.status, "ok");
        assert_eq!(body.service, "svc-action");
        assert_eq!(body.transport, "secure");
        assert_eq!(body.dependencies.len(), 2);
    }

    #[tokio::test]
    async fn readiness_reports_insecure_when_tls_disabled() {
        let mut state = test_state();
        state.config = std::sync::Arc::new({
            let mut c = (*state.config).clone();
            c.cli.security_transport_tls = false;
            c
        });
        let axum::Json(body) = readiness_health(State(state)).await;
        assert_eq!(body.transport, "insecure");
        assert!(!body.transport_detail.valkey.tls);
    }

    #[tokio::test]
    async fn metrics_renders_base_metrics_without_error() {
        let body = metrics(State(test_state())).await.expect("must not error");
        assert!(body.contains("svc_action_up 1"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `http` module does not exist yet.

- [ ] **Step 3: Write `src/http/mod.rs`**

```rust
//! HTTP control-plane surface: `/health`, `/healthz`, `/metrics`, plus the
//! OpenAPI documents (`openapi.rs`, Task 9).

pub mod health;
pub mod openapi;

use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::config::Config;
use crate::startup_check::SelfCheckReport;
use crate::telemetry::RequestMetrics;

use self::health::{ExecutorStatus, SpineStatus};

/// Shared state handed to every axum handler via `Router::with_state`.
/// Cheap to clone: everything behind an `Arc`.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub metrics_registry: Arc<prometheus::Registry>,
    pub request_metrics: RequestMetrics,
    pub started_at: Instant,
    /// The most recent startup self-check outcome (Task 7); refreshed only
    /// at startup in this plan -- a periodic re-probe is follow-on work.
    pub self_check: Arc<SelfCheckReport>,
    /// Live executor host-API connection state, updated by Task 15's
    /// connection handler.
    pub executor_status: Arc<Mutex<ExecutorStatus>>,
    /// Live per-bundle consumer status, updated by Task 22's consumer loop.
    pub spine_status: Arc<Mutex<SpineStatus>>,
}

impl AppState {
    /// Builds the shared application state from a loaded [`Config`], the
    /// Prometheus registry created during telemetry init, and the startup
    /// self-check report.
    pub fn new(config: Config, metrics: prometheus::Registry, self_check: SelfCheckReport) -> Self {
        let request_metrics = crate::telemetry::register_request_metrics(&metrics);
        Self {
            config: Arc::new(config),
            metrics_registry: Arc::new(metrics),
            request_metrics,
            started_at: Instant::now(),
            self_check: Arc::new(self_check),
            executor_status: Arc::new(Mutex::new(ExecutorStatus::default())),
            spine_status: Arc::new(Mutex::new(SpineStatus::default())),
        }
    }
}
```

- [ ] **Step 4: Write `src/http/health.rs`** (test module from Step 1 goes at the bottom)

```rust
//! Liveness (`/health`, rich body per spec Sec 11.6.4) and readiness
//! (`/healthz`, bare) probes, plus the Prometheus `/metrics` handler.

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::error::ApiError;
use crate::http::AppState;
use crate::startup_check::ProbeClass;

/// Per-component TLS/auth posture (spec Sec 11.6.4).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct TransportAspect {
    pub tls: bool,
    pub auth: bool,
}

/// `transport_detail` block of the rich `/health` body.
#[derive(Debug, Clone, Serialize)]
pub struct TransportDetail {
    pub valkey: TransportAspect,
    pub postgres: TransportAspect,
}

/// One configured dependency's classified probe outcome, rendered for
/// `/health`.
#[derive(Debug, Clone, Serialize)]
pub struct DependencyStatus {
    pub name: &'static str,
    pub class: &'static str,
    pub detail: String,
}

/// Live executor host-API connection state (spec Sec 11.6.4 `executor` block).
#[derive(Debug, Clone, Serialize)]
pub struct ExecutorStatus {
    pub state: String,
    pub connections: u32,
    pub bundles_loaded: u32,
}

impl Default for ExecutorStatus {
    fn default() -> Self {
        Self { state: "not_started".to_string(), connections: 0, bundles_loaded: 0 }
    }
}

/// Live per-bundle consumer state (spec Sec 11.6.4 `spine` block).
#[derive(Debug, Clone, Serialize)]
pub struct SpineStatus {
    pub stage: &'static str,
    pub consumer_id: String,
}

impl Default for SpineStatus {
    fn default() -> Self {
        Self { stage: "action", consumer_id: "not_started".to_string() }
    }
}

/// Full `/health` response body (spec Sec 11.6.4).
#[derive(Debug, Clone, Serialize)]
pub struct HealthBody {
    pub status: &'static str,
    pub service: &'static str,
    pub version: &'static str,
    pub transport: &'static str,
    pub transport_detail: TransportDetail,
    pub sandbox: String,
    pub dependencies: Vec<DependencyStatus>,
    pub executor: ExecutorStatus,
    pub spine: SpineStatus,
}

/// `GET /health` -- liveness only: the process is up and answering HTTP.
/// Never checks external dependencies live; the startup self-check
/// (Task 7) already ran once and its cached report is rendered here.
pub async fn liveness(State(_state): State<AppState>) -> Json<LivenessBody> {
    Json(LivenessBody { status: "ok" })
}

/// Bare liveness body for `/healthz` (the Kubernetes probe target).
#[derive(Debug, Serialize)]
pub struct LivenessBody {
    pub status: &'static str,
}

/// `GET /health` (rich): dependency posture, transport security, sandbox
/// expectation, executor/spine live state.
pub async fn readiness_health(State(state): State<AppState>) -> Json<HealthBody> {
    let cli = &state.config.cli;
    let transport_detail = TransportDetail {
        valkey: TransportAspect { tls: cli.security_transport_tls, auth: cli.security_transport_auth },
        postgres: TransportAspect { tls: cli.security_transport_tls, auth: cli.security_transport_auth },
    };
    let transport = if cli.security_transport_tls && cli.security_transport_auth { "secure" } else { "insecure" };

    let dependencies = state
        .self_check
        .results
        .iter()
        .map(|r| DependencyStatus { name: r.dependency, class: r.class.label(), detail: r.detail.clone() })
        .collect();

    let sandbox = if cli.waddles_sandbox_gvisor { "gvisor".to_string() } else { "runc".to_string() };

    Json(HealthBody {
        status: if state.self_check.all_required_ok { "ok" } else { "degraded" },
        service: "svc-action",
        version: env!("CARGO_PKG_VERSION"),
        transport,
        transport_detail,
        sandbox,
        dependencies,
        executor: state.executor_status.lock().expect("executor_status mutex is never held across a panic point").clone(),
        spine: state.spine_status.lock().expect("spine_status mutex is never held across a panic point").clone(),
    })
}

/// `GET /metrics` (secondary router, `METRICS_PORT`) -- Prometheus text
/// exposition. A registry gather/encode failure returns 500, never panics.
pub async fn metrics(State(state): State<AppState>) -> Result<String, ApiError> {
    crate::telemetry::render_metrics(&state.metrics_registry).map_err(ApiError::Internal)
}

// Re-export so callers needing only the classification enum's label see
// it via this module without importing `startup_check` directly.
pub use ProbeClass as _ProbeClassReexportForDocsOnly;
```

- [ ] **Step 5: Add the module to `src/lib.rs`**

```rust
pub mod http;
```

- [ ] **Step 6: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 4 passed; 0 failed` for `http::health::tests`.

- [ ] **Step 7: Commit**

Stage `core/svc_action/src/http/mod.rs core/svc_action/src/http/health.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): rich /health, /healthz, /metrics endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 9: HTTP router + `openapi.rs`

**Files:**
- Create: `core/svc_action/src/http/openapi.rs`
- Modify: `core/svc_action/src/http/mod.rs` (add `router()`, `metrics_router()`, the request-metrics middleware)

**Interfaces:**
- Consumes: `http::{AppState, health::{liveness, readiness_health, metrics, HealthBody, LivenessBody, DependencyStatus}}` (Task 8).
- Produces: `http::{router(AppState) -> Router, metrics_router(AppState) -> Router}` — Task 10's `run()` binds these to `MODULE_PORT`/`METRICS_PORT`.

- [ ] **Step 1: Write `src/http/openapi.rs`**

```rust
//! Two-document OpenAPI split, matching `core/svc_streaming/src/http/openapi.rs`'s
//! pattern: an unauthenticated public document (`/health` only) and a full
//! document. `svc-action` has no authenticated `/api/v1/*` surface, so both
//! documents currently list the same two health routes; the split is kept
//! for parity with the house pattern and to leave room for a future
//! authenticated admin route without a breaking reshape.

use axum::Json;
use utoipa::OpenApi;

use crate::http::health;

/// Full OpenAPI document: every route this service exposes.
#[derive(OpenApi)]
#[openapi(
    paths(health::liveness, health::readiness_health),
    components(schemas(health::LivenessBody, health::HealthBody, health::DependencyStatus, health::TransportDetail, health::TransportAspect, health::ExecutorStatus, health::SpineStatus))
)]
pub struct FullApiDoc;

/// Public, minimal OpenAPI document: `/healthz` only.
#[derive(OpenApi)]
#[openapi(paths(health::liveness), components(schemas(health::LivenessBody)))]
pub struct PublicApiDoc;

/// `GET /api/v1/openapi/public.json`.
pub async fn public_spec() -> Json<utoipa::openapi::OpenApi> {
    Json(PublicApiDoc::openapi())
}

/// `GET /api/v1/openapi.json`.
pub async fn full_spec() -> Json<utoipa::openapi::OpenApi> {
    Json(FullApiDoc::openapi())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_doc_only_documents_healthz() {
        let doc = PublicApiDoc::openapi();
        let paths: Vec<&String> = doc.paths.paths.keys().collect();
        assert_eq!(paths, vec!["/healthz"]);
    }

    #[test]
    fn full_doc_documents_health_and_healthz() {
        let doc = FullApiDoc::openapi();
        let mut paths: Vec<&String> = doc.paths.paths.keys().collect();
        paths.sort();
        assert_eq!(paths, vec!["/health", "/healthz"]);
    }
}
```

Note: `#[utoipa::path(get, path = "/healthz", ...)]` must be added above `pub async fn liveness` and `#[utoipa::path(get, path = "/health", ...)]` above `pub async fn readiness_health` in `src/http/health.rs` (Task 8) for the `paths(...)` macro above to resolve — amend Task 8's `health.rs` with:

```rust
#[utoipa::path(get, path = "/healthz", responses((status = 200, description = "Process is alive", body = LivenessBody)))]
pub async fn liveness(...) -> Json<LivenessBody> { ... }

#[utoipa::path(get, path = "/health", responses((status = 200, description = "Rich dependency/transport/sandbox status", body = HealthBody)))]
pub async fn readiness_health(...) -> Json<HealthBody> { ... }
```

(mechanical addition to the existing function signatures from Task 8; also add `use utoipa::ToSchema;` and `#[derive(ToSchema)]` alongside every `#[derive(Serialize)]` in `health.rs`'s structs so `components(schemas(...))` above resolves.)

- [ ] **Step 2: Append the router + metrics_router to `src/http/mod.rs`**

```rust
use std::time::Instant as StdInstant;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use tower_http::trace::TraceLayer;

async fn record_http_metrics(axum::extract::State(state): axum::extract::State<AppState>, req: Request, next: Next) -> Response {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let start = StdInstant::now();
    let response = next.run(req).await;
    let status = response.status().as_u16().to_string();
    state.request_metrics.http_requests_total.with_label_values(&[&method, &path, &status]).inc();
    state
        .request_metrics
        .http_request_duration_seconds
        .with_label_values(&[&method, &path])
        .observe(start.elapsed().as_secs_f64());
    response
}

/// Builds the control-plane router: `/healthz`, `/health`, and the two
/// OpenAPI documents. No authenticated surface exists yet.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health::liveness))
        .route("/health", get(health::readiness_health))
        .route("/api/v1/openapi/public.json", get(openapi::public_spec))
        .route("/api/v1/openapi.json", get(openapi::full_spec))
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(state, record_http_metrics))
        .layer(TraceLayer::new_for_http())
}

/// Builds the secondary Prometheus metrics router, bound to `METRICS_PORT`.
pub fn metrics_router(state: AppState) -> Router {
    Router::new().route("/metrics", get(health::metrics)).with_state(state)
}
```

- [ ] **Step 3: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 2 passed; 0 failed` for `http::openapi::tests`, plus all prior suites still green.

- [ ] **Step 4: Commit**

Stage `core/svc_action/src/http/mod.rs core/svc_action/src/http/health.rs core/svc_action/src/http/openapi.rs` and commit with message:

```
feat(svc-action): HTTP router + OpenAPI documents

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 10: `lib.rs::run()`/`run_healthcheck()` + `main.rs` wiring

**Files:**
- Modify: `core/svc_action/src/lib.rs`
- Modify: `core/svc_action/src/main.rs`
- Test: `core/svc_action/tests/lib_run.rs`

**Interfaces:**
- Consumes: `config::Config`, `telemetry::init`, `startup_check::{run_self_check, register_dependency_metrics}`, `http::{AppState, router, metrics_router}` (Tasks 3, 6, 7, 8, 9).
- Produces: `svc_action::{run, run_with_shutdown, run_healthcheck}` — `run_with_shutdown(config, http_shutdown, metrics_shutdown) -> anyhow::Result<()>` is the extension point Task 27 modifies to additionally spawn the runner loop; its signature does not change then.

- [ ] **Step 1: Write the failing test**

`tests/lib_run.rs`:

```rust
use std::time::Duration;

#[tokio::test]
async fn run_with_shutdown_serves_health_then_exits_on_signal() {
    // SAFETY: this test owns its own process-wide env vars and does not
    // run concurrently with other env-mutating tests in this binary
    // (integration tests each get their own process).
    unsafe {
        std::env::set_var("DB_PASSWORD", "x");
        std::env::set_var("SECRET_KEY", "x");
        std::env::set_var("VALKEY_URL", "redis://127.0.0.1:1/0");
        std::env::set_var("MODULE_PORT", "0");
        std::env::set_var("METRICS_PORT", "0");
        std::env::set_var("STARTUP_PROBE_ATTEMPTS", "1");
        std::env::set_var("STARTUP_PROBE_TIMEOUT_MS", "200");
    }
    let cli = svc_action::config::CliConfig::parse_from(["svc-action"]);
    let config = svc_action::config::Config::from_cli(cli).expect("secrets set above");

    let result = tokio::time::timeout(
        Duration::from_secs(5),
        svc_action::run_with_shutdown(config, async { /* shut down immediately */ }, async {}),
    )
    .await;
    assert!(result.is_ok(), "run_with_shutdown must return once both shutdown futures resolve");
}
```

Add `use clap::Parser;` is not required here since `CliConfig::parse_from` is an associated function reached via the fully-qualified path already imported by `svc_action::config::CliConfig` re-exporting `clap::Parser`'s trait method — add `use clap::Parser;` at the top of this test file to bring the trait into scope:

```rust
use clap::Parser;
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL with `cannot find function run_with_shutdown` in crate `svc_action`.

- [ ] **Step 3: Write the implementation** (append to `src/lib.rs`, after the `pub mod` list)

```rust
use std::net::SocketAddr;

use tokio::signal;

/// Runs the service: loads config, bootstraps telemetry, runs the startup
/// self-check (exit 78 on a required-dependency failure), and serves HTTP
/// + metrics until SIGINT/SIGTERM.
pub async fn run() -> anyhow::Result<()> {
    let config = config::Config::load()?;
    run_with_shutdown(config, shutdown_signal(), shutdown_signal()).await
}

/// Same as [`run`], but takes an already-loaded [`config::Config`] and
/// caller-supplied shutdown futures -- what makes the bind/serve/telemetry
/// wiring testable. Task 27 extends this function to additionally spawn
/// the distribution-poll + per-bundle consumer runner; this signature does
/// not change then.
pub async fn run_with_shutdown<F1, F2>(
    config: config::Config,
    http_shutdown: F1,
    metrics_shutdown: F2,
) -> anyhow::Result<()>
where
    F1: std::future::Future<Output = ()> + Send + 'static,
    F2: std::future::Future<Output = ()> + Send + 'static,
{
    let (_telemetry_guard, prom_registry) = telemetry::init(SERVICE_NAME);

    tracing::info!(
        module_port = config.cli.module_port,
        metrics_port = config.cli.metrics_port,
        host_api_port = config.cli.host_api_port,
        "starting {SERVICE_NAME}"
    );

    let dependency_metrics = startup_check::register_dependency_metrics(&prom_registry);
    let self_check = startup_check::run_self_check(&config, &dependency_metrics).await;
    if !self_check.all_required_ok {
        tracing::error!("required dependency check failed at startup, exiting with EX_CONFIG (78)");
        std::process::exit(78);
    }

    let state = http::AppState::new(config.clone(), prom_registry, self_check);

    let http_addr = SocketAddr::new(config.cli.bind_addr, config.cli.module_port);
    let metrics_addr = SocketAddr::new(config.cli.bind_addr, config.cli.metrics_port);

    let http_listener = tokio::net::TcpListener::bind(http_addr).await?;
    let metrics_listener = tokio::net::TcpListener::bind(metrics_addr).await?;
    tracing::info!(%http_addr, %metrics_addr, "listening");

    let http_server = axum::serve(http_listener, http::router(state.clone())).with_graceful_shutdown(http_shutdown);
    let metrics_server = axum::serve(metrics_listener, http::metrics_router(state)).with_graceful_shutdown(metrics_shutdown);

    tokio::try_join!(
        async { http_server.await.map_err(anyhow::Error::from) },
        async { metrics_server.await.map_err(anyhow::Error::from) },
    )?;

    Ok(())
}

/// Waits for SIGINT or SIGTERM and returns, letting graceful shutdown
/// drain in-flight requests.
async fn shutdown_signal() {
    let ctrl_c = async { signal::ctrl_c().await.expect("failed to install SIGINT handler") };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}

/// `svc-action --healthcheck`: GETs `/healthz` on the locally-bound HTTP
/// port and exits 0/1 accordingly -- the container `HEALTHCHECK` invokes
/// this directly instead of relying on `curl`.
pub async fn run_healthcheck() -> anyhow::Result<()> {
    let port: u16 = std::env::var("MODULE_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8202);
    let url = format!("http://127.0.0.1:{port}/healthz");
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3)).build()?;
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => Ok(()),
        Ok(resp) => {
            eprintln!("healthcheck failed: {url} returned {}", resp.status());
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("healthcheck failed: {err}");
            std::process::exit(1);
        }
    }
}
```

- [ ] **Step 4: Rewrite `src/main.rs`**

```rust
//! Thin binary entrypoint -- all real logic lives in `src/lib.rs` so
//! `tests/` integration tests can exercise it without subprocessing.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        return svc_action::run_healthcheck().await;
    }
    svc_action::run().await
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 1 passed; 0 failed` for `lib_run`, plus all prior suites still green.

- [ ] **Step 6: Commit**

Stage `core/svc_action/src/lib.rs core/svc_action/src/main.rs core/svc_action/tests/lib_run.rs` and commit with message:

```
feat(svc-action): wire run()/run_healthcheck(), serve HTTP + metrics

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 11: Distribution poller (`GET .../distribution/bundles?stage=action`)

**Files:**
- Create: `core/svc_action/src/distribution/mod.rs`
- Create: `core/svc_action/src/distribution/poller.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod distribution;`)

**Interfaces:**
- Consumes: `config::{Config, Secret}` (Task 3).
- Produces: `distribution::poller::{DistributionPoller, ActionBundleRow, ActionManifest, EgressRule, Limits, mint_distribution_jwt}` — `DistributionPoller::new(http_client, distribution_url, secret_key, tenant_slug, community_id, poll_interval_s, base_backoff_s, max_backoff_s) -> Self`, `async fn poll_once(&self) -> Vec<ActionBundleRow>` (never errors — degrades to last-known-good) — Task 22's consumer loop and Task 27's runner call `poll_once()` on a `POLL_INTERVAL_S` cadence.

- [ ] **Step 1: Write the failing tests** (top of a new `src/distribution/poller.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn secret() -> crate::config::Secret {
        crate::config::Secret::new("test-secret-key")
    }

    #[test]
    fn mint_distribution_jwt_carries_expected_claims() {
        let token = mint_distribution_jwt(&secret(), "global", "distribution:read").expect("mint succeeds");
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
        validation.set_audience(&["hub-api"]);
        let decoded = jsonwebtoken::decode::<serde_json::Value>(
            &token,
            &jsonwebtoken::DecodingKey::from_secret(secret().expose().as_bytes()),
            &validation,
        )
        .expect("token verifies");
        assert_eq!(decoded.claims["scope"], "distribution:read");
        assert_eq!(decoded.claims["tenant"], "global");
    }

    #[tokio::test]
    async fn poll_once_parses_a_successful_response() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "bundles": [{
                "appId": "waddles.bot.discord.default",
                "communityId": 42,
                "entrypoint": "bundles.discord_send_action:send_message",
                "spec": {"required_config": []},
                "config": {"api_base": "https://discord.com/api/v10"},
                "artifactVersion": "3.0.0",
                "artifactDigest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                "artifactKind": "source",
                "language": "python",
                "scanStatus": "scanned",
                "manifest": {"egress": [{"host": "discord.com", "methods": ["POST"]}], "data": {"tables": []}, "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10}}
            }]
        });
        Mock::given(method("GET"))
            .and(path("/api/v1/distribution/bundles"))
            .and(query_param("stage", "action"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let poller = DistributionPoller::new(
            reqwest::Client::new(),
            format!("{}/api/v1/distribution/bundles", server.uri()),
            secret(),
            "global".to_string(),
            None,
            5.0,
            1.0,
            60.0,
        );
        let rows = poller.poll_once().await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].app_id, "waddles.bot.discord.default");
        assert_eq!(rows[0].artifact_digest.as_deref(), Some("sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"));
        assert_eq!(rows[0].manifest.egress.len(), 1);
    }

    #[tokio::test]
    async fn poll_once_degrades_to_last_known_good_on_outage() {
        let server = MockServer::start().await;
        let body = serde_json::json!({"bundles": [{
            "appId": "waddles.bot.slack.default", "communityId": null, "entrypoint": null,
            "spec": {}, "config": {}, "artifactVersion": null, "artifactDigest": null,
            "artifactKind": "source", "language": "python", "scanStatus": "scanned",
            "manifest": {"egress": [], "data": {"tables": []}, "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10}}
        }]});
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(200).set_body_json(body)).mount(&server).await;

        let poller = DistributionPoller::new(
            reqwest::Client::new(),
            format!("{}/api/v1/distribution/bundles", server.uri()),
            secret(),
            "global".to_string(),
            None,
            5.0,
            1.0,
            60.0,
        );
        let first = poller.poll_once().await;
        assert_eq!(first.len(), 1);

        server.reset().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(503)).mount(&server).await;
        let second = poller.poll_once().await;
        assert_eq!(second.len(), 1, "an outage must degrade to the prior successful set, not empty");
        assert_eq!(second[0].app_id, "waddles.bot.slack.default");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `distribution` module does not exist yet.

- [ ] **Step 3: Write `src/distribution/mod.rs`**

```rust
//! Distribution API client: polls hub-api for the `action` stage's
//! activated bundle set every `POLL_INTERVAL_S`, degrading to the
//! last-known-good set on an outage rather than raising (spec Sec 6.7).

pub mod poller;
```

- [ ] **Step 4: Write `src/distribution/poller.rs`** (test module from Step 1 goes at the bottom)

```rust
//! `GET {HUB_API_URL}/api/v1/distribution/bundles?stage=action` client.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::config::Secret;

/// One `egress` allowlist entry from the bundle's approved manifest subset.
#[derive(Debug, Clone, Deserialize)]
pub struct EgressRule {
    pub host: String,
    #[serde(default)]
    pub methods: Vec<String>,
}

/// The capability-bearing manifest subset the distribution API serves
/// (spec Sec 6.7) -- the stage never fetches the full manifest separately.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ActionManifest {
    #[serde(default)]
    pub egress: Vec<EgressRule>,
    #[serde(default, rename = "data")]
    pub data: DataTables,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DataTables {
    #[serde(default)]
    pub tables: Vec<String>,
}

/// Per-bundle resource limits (spec Sec 6.4.2 defaults).
#[derive(Debug, Clone, Deserialize)]
pub struct Limits {
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_memory_mb")]
    pub memory_mb: u32,
    #[serde(default = "default_egress_rps")]
    pub egress_rps: u32,
}

fn default_timeout_ms() -> u64 {
    2000
}
fn default_memory_mb() -> u32 {
    64
}
fn default_egress_rps() -> u32 {
    10
}

impl Default for Limits {
    fn default() -> Self {
        Self { timeout_ms: default_timeout_ms(), memory_mb: default_memory_mb(), egress_rps: default_egress_rps() }
    }
}

/// One activated `action`-stage bundle row from the distribution API.
#[derive(Debug, Clone, Deserialize)]
pub struct ActionBundleRow {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "communityId")]
    pub community_id: Option<i64>,
    pub entrypoint: Option<String>,
    #[serde(default)]
    pub config: serde_json::Value,
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
    pub manifest: ActionManifest,
}

#[derive(Debug, Deserialize)]
struct DistributionResponse {
    bundles: Vec<ActionBundleRow>,
}

/// Mints a 1h HS256 service JWT with the mandatory claims
/// (`sub`, `iss`, `aud`, `iat`, `exp`, `scope`, `tenant`) -- unchanged
/// mechanism from the Python service's `create_jwt_token`.
pub fn mint_distribution_jwt(secret_key: &Secret, tenant_slug: &str, scope: &str) -> anyhow::Result<String> {
    #[derive(serde::Serialize)]
    struct Claims<'a> {
        sub: &'a str,
        iss: &'a str,
        aud: &'a str,
        iat: u64,
        exp: u64,
        scope: &'a str,
        tenant: &'a str,
        teams: Vec<&'a str>,
        roles: Vec<&'a str>,
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let claims = Claims {
        sub: "svc-action",
        iss: "svc-action",
        aud: "hub-api",
        iat: now,
        exp: now + 3600,
        scope,
        tenant: tenant_slug,
        teams: vec![],
        roles: vec!["service"],
    };
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256);
    let key = jsonwebtoken::EncodingKey::from_secret(secret_key.expose().as_bytes());
    Ok(jsonwebtoken::encode(&header, &claims, &key)?)
}

/// Polls hub-api's distribution API for the `action` stage's bundle set,
/// with exponential backoff on failure and last-known-good degradation.
pub struct DistributionPoller {
    http: reqwest::Client,
    distribution_url: String,
    secret_key: Secret,
    tenant_slug: String,
    community_id: Option<i64>,
    #[allow(dead_code)]
    poll_interval: Duration,
    base_backoff: Duration,
    max_backoff: Duration,
    last_known_good: Mutex<Vec<ActionBundleRow>>,
    consecutive_failures: Mutex<u32>,
}

impl DistributionPoller {
    /// Builds a poller bound to one hub-api distribution endpoint and one
    /// tenant/community scope.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        http: reqwest::Client,
        distribution_url: String,
        secret_key: Secret,
        tenant_slug: String,
        community_id: Option<i64>,
        poll_interval_s: f64,
        base_backoff_s: f64,
        max_backoff_s: f64,
    ) -> Self {
        Self {
            http,
            distribution_url,
            secret_key,
            tenant_slug,
            community_id,
            poll_interval: Duration::from_secs_f64(poll_interval_s),
            base_backoff: Duration::from_secs_f64(base_backoff_s),
            max_backoff: Duration::from_secs_f64(max_backoff_s),
            last_known_good: Mutex::new(Vec::new()),
            consecutive_failures: Mutex::new(0),
        }
    }

    /// One poll attempt. Never errors: a failure logs at WARN, applies
    /// exponential backoff via a short sleep bounded by `max_backoff`, and
    /// returns the last successfully-fetched bundle set (empty on the
    /// very first failure).
    pub async fn poll_once(&self) -> Vec<ActionBundleRow> {
        let token = match mint_distribution_jwt(&self.secret_key, &self.tenant_slug, "distribution:read") {
            Ok(t) => t,
            Err(err) => {
                tracing::error!(error = %err, "failed to mint distribution JWT");
                return self.last_known_good.lock().expect("mutex not poisoned").clone();
            }
        };

        let mut request = self
            .http
            .get(&self.distribution_url)
            .bearer_auth(token)
            .query(&[("stage", "action")]);
        if let Some(community_id) = self.community_id {
            request = request.query(&[("communityId", community_id)]);
        }

        match request.send().await {
            Ok(resp) if resp.status().is_success() => match resp.json::<DistributionResponse>().await {
                Ok(parsed) => {
                    *self.consecutive_failures.lock().expect("mutex not poisoned") = 0;
                    let mut cache = self.last_known_good.lock().expect("mutex not poisoned");
                    *cache = parsed.bundles.clone();
                    parsed.bundles
                }
                Err(err) => {
                    tracing::warn!(error = %err, "distribution response failed to parse, degrading to last-known-good");
                    self.backoff().await;
                    self.last_known_good.lock().expect("mutex not poisoned").clone()
                }
            },
            Ok(resp) => {
                tracing::warn!(status = %resp.status(), "distribution poll returned a non-success status, degrading to last-known-good");
                self.backoff().await;
                self.last_known_good.lock().expect("mutex not poisoned").clone()
            }
            Err(err) => {
                tracing::warn!(error = %err, "distribution poll request failed, degrading to last-known-good");
                self.backoff().await;
                self.last_known_good.lock().expect("mutex not poisoned").clone()
            }
        }
    }

    async fn backoff(&self) {
        let mut failures = self.consecutive_failures.lock().expect("mutex not poisoned");
        *failures = failures.saturating_add(1);
        let exp = 2u32.saturating_pow((*failures).min(16));
        let delay = (self.base_backoff * exp).min(self.max_backoff);
        drop(failures);
        tokio::time::sleep(delay).await;
    }
}
```

- [ ] **Step 5: Add the module to `src/lib.rs`**

```rust
pub mod distribution;
```

- [ ] **Step 6: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 3 passed; 0 failed` for `distribution::poller::tests`.

- [ ] **Step 7: Commit**

Stage `core/svc_action/src/distribution/mod.rs core/svc_action/src/distribution/poller.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): distribution API poller for stage=action

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 12: `retry.rs` — retry-with-backoff + transport outcome classification

**Files:**
- Create: `core/svc_action/src/retry.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod retry;`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `retry::{RetryConfig, TransportOutcome, TransportSuccess, RetryOutcome, retry_with_backoff}` — Task 22's consumer loop and Tasks 23-26's senders return `TransportOutcome`; `retry_with_backoff` is the one place `ACTION_MAX_RETRIES`/`ACTION_BASE_BACKOFF_MS`/`ACTION_MAX_BACKOFF_MS` and full jitter are applied.

- [ ] **Step 1: Write the failing tests** (top of a new `src/retry.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn cfg() -> RetryConfig {
        RetryConfig { max_retries: 3, base_backoff_ms: 10, max_backoff_ms: 100 }
    }

    #[tokio::test]
    async fn succeeds_immediately_without_retrying() {
        let calls = AtomicU32::new(0);
        let outcome = retry_with_backoff(&cfg(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { TransportOutcome::Success(TransportSuccess { detail: "ok".into(), http_status: Some(200), provider_message_id: None }) }
        })
        .await;
        assert!(matches!(outcome, RetryOutcome::Success(_)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn terminal_failure_never_retries() {
        let calls = AtomicU32::new(0);
        let outcome = retry_with_backoff(&cfg(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { TransportOutcome::Terminal { message: "bad auth".into(), http_status: Some(401) } }
        })
        .await;
        assert!(matches!(outcome, RetryOutcome::TerminalFailure { attempts: 1, .. }));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retryable_failure_exhausts_retries_then_reports_failure() {
        let calls = AtomicU32::new(0);
        let outcome = retry_with_backoff(&cfg(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { TransportOutcome::Retryable { message: "5xx".into(), http_status: Some(503), retry_after_ms: None } }
        })
        .await;
        // max_retries=3 -> 1 initial attempt + 3 retries = 4 total calls.
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert!(matches!(outcome, RetryOutcome::RetriesExhausted { attempts: 4, .. }));
    }

    #[tokio::test]
    async fn retryable_then_success_returns_success_with_attempt_count() {
        let calls = AtomicU32::new(0);
        let outcome = retry_with_backoff(&cfg(), || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if n == 0 {
                    TransportOutcome::Retryable { message: "429".into(), http_status: Some(429), retry_after_ms: None }
                } else {
                    TransportOutcome::Success(TransportSuccess { detail: "ok".into(), http_status: Some(200), provider_message_id: None })
                }
            }
        })
        .await;
        assert!(matches!(outcome, RetryOutcome::Success(_)));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn backoff_delay_never_exceeds_max_and_grows_with_attempt() {
        let cfg = cfg();
        for attempt in 1..=6u32 {
            let delay = compute_backoff_ms(&cfg, attempt, None);
            assert!(delay <= cfg.max_backoff_ms, "attempt {attempt} delay {delay} exceeds cap");
        }
    }

    #[test]
    fn retry_after_override_wins_when_larger_and_is_capped() {
        let cfg = cfg();
        let delay = compute_backoff_ms(&cfg, 1, Some(10_000));
        assert_eq!(delay, cfg.max_backoff_ms, "retry-after must be capped at max_backoff_ms");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `retry` module does not exist yet.

- [ ] **Step 3: Write `src/retry.rs`** (test module from Step 1 goes at the bottom)

```rust
//! Retry-with-backoff owned entirely by the stage -- a bundle/sender
//! never sleeps itself (spec Sec 4.3). `transport-error.retryable = true`
//! retries; `false` is terminal. Full jitter; a `retry-after-ms` override
//! wins only when larger than the computed delay, capped at
//! `ACTION_MAX_BACKOFF_MS`.

use rand::Rng;

/// Knobs from `ACTION_MAX_RETRIES`/`ACTION_BASE_BACKOFF_MS`/`ACTION_MAX_BACKOFF_MS`.
#[derive(Debug, Clone, Copy)]
pub struct RetryConfig {
    pub max_retries: u32,
    pub base_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

/// A dispatch attempt's successful result (mirrors the WIT `transport-result` record).
#[derive(Debug, Clone)]
pub struct TransportSuccess {
    pub detail: String,
    pub http_status: Option<u16>,
    pub provider_message_id: Option<String>,
}

/// One dispatch attempt's outcome (mirrors the WIT `transport-result`/`transport-error` split).
#[derive(Debug, Clone)]
pub enum TransportOutcome {
    Success(TransportSuccess),
    /// `transport-error.retryable = true`.
    Retryable { message: String, http_status: Option<u16>, retry_after_ms: Option<u64> },
    /// `transport-error.retryable = false`.
    Terminal { message: String, http_status: Option<u16> },
}

/// The final outcome after retry-with-backoff has run its course.
#[derive(Debug, Clone)]
pub enum RetryOutcome {
    Success(TransportSuccess),
    /// The attempt returned a terminal failure on its very first try (or
    /// any try -- terminal never retries). `attempts` is always 1.
    TerminalFailure { attempts: u32, message: String, http_status: Option<u16> },
    /// Every attempt (`1 + max_retries` total) returned retryable.
    RetriesExhausted { attempts: u32, message: String, http_status: Option<u16> },
}

fn compute_backoff_ms(cfg: &RetryConfig, attempt: u32, retry_after_ms: Option<u64>) -> u64 {
    let exp = cfg.base_backoff_ms.saturating_mul(1u64 << attempt.min(20));
    let computed = exp.min(cfg.max_backoff_ms);
    let base = match retry_after_ms {
        Some(r) if r > computed => r,
        _ => computed,
    };
    base.min(cfg.max_backoff_ms)
}

fn jittered_delay_ms(upper_bound_ms: u64) -> u64 {
    if upper_bound_ms == 0 {
        return 0;
    }
    rand::thread_rng().gen_range(0..=upper_bound_ms)
}

/// Runs `attempt` up to `1 + cfg.max_retries` times, sleeping a
/// full-jitter exponential backoff between retryable failures. `attempt`
/// is an `FnMut` (not `Fn`) so a caller can capture and mutate local
/// per-call state (e.g. a mutable client handle) between tries.
pub async fn retry_with_backoff<F, Fut>(cfg: &RetryConfig, mut attempt: F) -> RetryOutcome
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = TransportOutcome>,
{
    let mut attempts = 0u32;
    loop {
        attempts += 1;
        match attempt().await {
            TransportOutcome::Success(success) => return RetryOutcome::Success(success),
            TransportOutcome::Terminal { message, http_status } => {
                return RetryOutcome::TerminalFailure { attempts, message, http_status }
            }
            TransportOutcome::Retryable { message, http_status, retry_after_ms } => {
                if attempts > cfg.max_retries {
                    return RetryOutcome::RetriesExhausted { attempts, message, http_status };
                }
                let upper = compute_backoff_ms(cfg, attempts, retry_after_ms);
                let delay = jittered_delay_ms(upper);
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        }
    }
}
```

- [ ] **Step 4: Add the module to `src/lib.rs`**

```rust
pub mod retry;
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 6 passed; 0 failed` for `retry::tests`.

- [ ] **Step 6: Commit**

Stage `core/svc_action/src/retry.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): retry-with-backoff, full jitter, retry-after override

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 13: `action_dispatch_log` SeaORM entity + audit write

**Files:**
- Create: `core/svc_action/src/audit/mod.rs`
- Create: `core/svc_action/src/audit/entities.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod audit;`)

**Interfaces:**
- Consumes: nothing new (SeaORM `DatabaseConnection` is constructed by Task 27's runner wiring, passed in here).
- Produces: `audit::{AuditWriter, AuditError, RecordParams}`, `audit::entities::{action_dispatch_log, tenants}` — `AuditWriter::new(DatabaseConnection) -> Self`, `async fn resolve_tenant_id(&self, tenant_slug: &str) -> Result<i32, AuditError>` (memoized per-process), `async fn record(&self, params: RecordParams) -> Result<(), AuditError>` — Task 22's consumer loop calls `record` after every dispatch attempt and only logs (never propagates) an `Err`.

- [ ] **Step 1: Write the failing tests** (top of a new `src/audit/mod.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{DatabaseBackend, MockDatabase, MockExecResult, Transaction};

    fn tenants_row(id: i32, slug: &str) -> entities::tenants::Model {
        entities::tenants::Model { id, slug: slug.to_string() }
    }

    #[tokio::test]
    async fn resolve_tenant_id_queries_then_memoizes() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([vec![tenants_row(7, "global")]])
            .into_connection();
        let writer = AuditWriter::new(db);

        let first = writer.resolve_tenant_id("global").await.expect("row exists");
        assert_eq!(first, 7);
        // Second call must not issue a second query -- MockDatabase would
        // panic on an unconsumed extra query result if it did; instead
        // this call succeeds purely from the in-memory cache.
        let second = writer.resolve_tenant_id("global").await.expect("memoized");
        assert_eq!(second, 7);
    }

    #[tokio::test]
    async fn resolve_tenant_id_errors_on_unknown_slug() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results::<entities::tenants::Model, _, _>([vec![]])
            .into_connection();
        let writer = AuditWriter::new(db);
        let err = writer.resolve_tenant_id("no-such-tenant").await.unwrap_err();
        assert!(matches!(err, AuditError::UnknownTenant(_)));
    }

    #[tokio::test]
    async fn record_inserts_a_row_and_truncates_detail() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_exec_results([MockExecResult { last_insert_id: 1, rows_affected: 1 }])
            .into_connection();
        let writer = AuditWriter::new(db);
        let long_detail = "x".repeat(600);
        writer
            .record(RecordParams {
                tenant_id: 1,
                community_id: None,
                app_id: "waddles.bot.discord.default".to_string(),
                target_type: "bundle".to_string(),
                status: "success".to_string(),
                attempt: 1,
                http_status: Some(200),
                detail: long_detail,
                envelope_ts: None,
            })
            .await
            .expect("insert succeeds");
        let log = db.into_transaction_log();
        assert_eq!(log.len(), 1);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `audit` module does not exist yet.

- [ ] **Step 3: Write `src/audit/entities.rs`**

```rust
//! SeaORM entities for `action_dispatch_log` (owned by
//! `config/postgres/migrations/074_action_dispatch_log.sql` -- this
//! module maps onto the already-migrated table, it never owns the DDL)
//! and the minimal `tenants` slug->id lookup this service needs.

/// `action_dispatch_log` -- one row per dispatch attempt outcome.
pub mod action_dispatch_log {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "action_dispatch_log")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        pub tenant_id: i32,
        pub community_id: Option<i32>,
        pub app_id: String,
        pub target_type: String,
        pub status: String,
        pub attempt: i32,
        pub http_status: Option<i32>,
        pub detail: String,
        pub envelope_ts: Option<DateTimeUtc>,
        pub dispatched_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// `tenants` -- read-only slug->id lookup; this service never writes it.
pub mod tenants {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "tenants")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub slug: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
```

- [ ] **Step 4: Write `src/audit/mod.rs`** (test module from Step 1 goes at the bottom)

```rust
//! Audit write path: resolves a `StageEnvelope.tenant` slug to its FK
//! (memoized per process, mirroring the Python runner's own
//! `_tenant_id_cache`) and inserts one `action_dispatch_log` row per
//! dispatch attempt outcome. A write failure here must never mask or
//! retry-loop the dispatch outcome it is trying to record -- callers
//! catch and log `Err`, never propagate it into the retry/DLQ path.

pub mod entities;

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QuerySelect, Set};
use thiserror::Error;

use entities::{action_dispatch_log, tenants};

/// Errors from the audit write path -- always caught and logged by the
/// caller, never propagated into the dispatch/retry decision.
#[derive(Debug, Error)]
pub enum AuditError {
    #[error("tenant slug {0:?} has no matching tenants row")]
    UnknownTenant(String),
    #[error("database error: {0}")]
    Db(#[from] sea_orm::DbErr),
}

/// One `action_dispatch_log` row's fields.
#[derive(Debug, Clone)]
pub struct RecordParams {
    pub tenant_id: i32,
    pub community_id: Option<i32>,
    pub app_id: String,
    pub target_type: String,
    pub status: String,
    pub attempt: i32,
    pub http_status: Option<i32>,
    pub detail: String,
    pub envelope_ts: Option<DateTime<Utc>>,
}

/// Writes `action_dispatch_log` rows and memoizes tenant-slug resolution.
pub struct AuditWriter {
    db: DatabaseConnection,
    tenant_id_cache: Mutex<HashMap<String, i32>>,
}

impl AuditWriter {
    /// Builds a writer bound to one Postgres connection pool.
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db, tenant_id_cache: Mutex::new(HashMap::new()) }
    }

    /// Resolves `tenant_slug` to `tenants.id`, memoized per process (this
    /// runner instance serves one tenant scope for its whole lifetime, so
    /// the cache never grows unbounded).
    pub async fn resolve_tenant_id(&self, tenant_slug: &str) -> Result<i32, AuditError> {
        if let Some(cached) = self.tenant_id_cache.lock().expect("mutex not poisoned").get(tenant_slug) {
            return Ok(*cached);
        }
        let row = tenants::Entity::find()
            .filter(tenants::Column::Slug.eq(tenant_slug))
            .limit(1)
            .one(&self.db)
            .await?;
        let row = row.ok_or_else(|| AuditError::UnknownTenant(tenant_slug.to_string()))?;
        self.tenant_id_cache.lock().expect("mutex not poisoned").insert(tenant_slug.to_string(), row.id);
        Ok(row.id)
    }

    /// Inserts one audit row. `detail` is bounded to 500 chars -- this is
    /// a status string, never a body dump.
    pub async fn record(&self, params: RecordParams) -> Result<(), AuditError> {
        let detail: String = params.detail.chars().take(500).collect();
        let model = action_dispatch_log::ActiveModel {
            tenant_id: Set(params.tenant_id),
            community_id: Set(params.community_id),
            app_id: Set(params.app_id),
            target_type: Set(params.target_type),
            status: Set(params.status),
            attempt: Set(params.attempt),
            http_status: Set(params.http_status),
            detail: Set(detail),
            envelope_ts: Set(params.envelope_ts),
            dispatched_at: Set(Utc::now()),
            ..Default::default()
        };
        model.insert(&self.db).await?;
        Ok(())
    }
}
```

- [ ] **Step 5: Add the module to `src/lib.rs`**

```rust
pub mod audit;
```

- [ ] **Step 6: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 3 passed; 0 failed` for `audit::tests`.

- [ ] **Step 7: Commit**

Stage `core/svc_action/src/audit/mod.rs core/svc_action/src/audit/entities.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): action_dispatch_log SeaORM audit write path

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 14: Wire host-API mTLS listener + `hello`/`hello-ok` handshake

**Files:**
- Modify: `core/svc_action/Cargo.toml` (add `x509-parser`)
- Create: `core/svc_action/src/hostapi/mod.rs`
- Create: `core/svc_action/src/hostapi/server.rs`
- Create: `core/svc_action/tests/support/mod.rs`
- Create: `core/svc_action/tests/support/test_certs.rs`
- Create: `core/svc_action/tests/hostapi_handshake.rs`

**Interfaces:**
- Consumes: `penguin_bundle_host::wire::{message::{Frame, Message, SandboxInfo, HelloLimits, ErrorCode}, frame::MAX_FRAME_BYTES, transport::{FrameTransport, TransportError}}` (crates.io, spec §6.6 / plan-penguin-bundle-host Task 2-4), `config::Config` (Task 3).
- Produces: `hostapi::server::{HostApiServer, HostApiServerError, build_tls_acceptor, extract_peer_common_name}` — `HostApiServer::new(cfg: &Config) -> Result<Self, HostApiServerError>`, `async fn accept_loop(self: Arc<Self>) -> anyhow::Result<()>` — Task 15 extends `accept_loop`'s per-connection handler to register the connection in a `BundleRegistry` and serve `Load`/`Invoke`/`HostCall` traffic after the handshake below completes; `waddles_host_api_rejected_total{reason}` counter registered here, incremented by both this task and Task 15.

- [ ] **Step 1: Add `x509-parser` to `Cargo.toml`** (needed to read the executor's client-certificate Common Name for peer-identity pinning)

```toml
x509-parser = "=0.16.0"
```

- [ ] **Step 2: Write the test certificate helper**

`tests/support/mod.rs`:

```rust
pub mod test_certs;
pub mod fake_executor;
```

`tests/support/test_certs.rs`:

```rust
//! `rcgen`-generated self-signed test CA + server/client certs for the
//! host-API mTLS listener's tests. Never used outside `tests/` -- the
//! real chart provisions certs per spec Sec 11.6.3.

use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};

/// A generated CA plus one server cert and one client cert, both signed
/// by it -- everything [`crate::hostapi_handshake`]'s tests need.
pub struct TestPki {
    pub ca_pem: String,
    pub server_cert_pem: String,
    pub server_key_pem: String,
    pub client_cert_pem: String,
    pub client_key_pem: String,
    pub client_common_name: String,
}

/// Builds a fresh CA and a server/client cert pair, the client cert's
/// Common Name set to `client_common_name`.
pub fn build_test_pki(client_common_name: &str) -> TestPki {
    let ca_key = KeyPair::generate().expect("keypair generation");
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("empty SAN list is valid");
    ca_params.distinguished_name = DistinguishedName::new();
    ca_params.distinguished_name.push(DnType::CommonName, "svc-action-test-ca");
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let ca_cert = ca_params.self_signed(&ca_key).expect("self-sign CA");

    let server_key = KeyPair::generate().expect("keypair generation");
    let mut server_params = CertificateParams::new(vec!["localhost".to_string()]).expect("valid SAN");
    server_params.distinguished_name = DistinguishedName::new();
    server_params.distinguished_name.push(DnType::CommonName, "svc-action-test-server");
    server_params.subject_alt_names = vec![SanType::DnsName("localhost".try_into().expect("valid dns name"))];
    let server_cert = server_params.signed_by(&server_key, &ca_cert, &ca_key).expect("sign server cert");

    let client_key = KeyPair::generate().expect("keypair generation");
    let mut client_params = CertificateParams::new(Vec::<String>::new()).expect("empty SAN list is valid");
    client_params.distinguished_name = DistinguishedName::new();
    client_params.distinguished_name.push(DnType::CommonName, client_common_name);
    let client_cert = client_params.signed_by(&client_key, &ca_cert, &ca_key).expect("sign client cert");

    TestPki {
        ca_pem: ca_cert.pem(),
        server_cert_pem: server_cert.pem(),
        server_key_pem: server_key.serialize_pem(),
        client_cert_pem: client_cert.pem(),
        client_key_pem: client_key.serialize_pem(),
        client_common_name: client_common_name.to_string(),
    }
}
```

- [ ] **Step 3: Write the failing handshake test**

`tests/hostapi_handshake.rs`:

```rust
mod support;

use std::io::Write;
use std::sync::Arc;

use penguin_bundle_host::wire::message::{Frame, Message, SandboxInfo};
use penguin_bundle_host::wire::transport::FrameTransport;
use rustls_pemfile::{certs, pkcs8_private_keys};
use support::test_certs::build_test_pki;
use svc_action::hostapi::server::HostApiServer;

fn write_temp_pem(contents: &str) -> tempfile_like::NamedFile {
    tempfile_like::NamedFile::new(contents)
}

// A tiny local stand-in for `tempfile` (not a dev-dependency of this
// crate) -- writes a PEM string to a uniquely-named file under the OS
// temp dir and deletes it on drop.
mod tempfile_like {
    use std::path::PathBuf;

    pub struct NamedFile {
        pub path: PathBuf,
    }

    impl NamedFile {
        pub fn new(contents: &str) -> Self {
            let path = std::env::temp_dir().join(format!("svc-action-test-{}.pem", uuid::Uuid::new_v4()));
            std::fs::write(&path, contents).expect("write temp pem");
            Self { path }
        }
    }

    impl Drop for NamedFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

async fn connect_client(
    addr: std::net::SocketAddr,
    pki: &support::test_certs::TestPki,
) -> tokio_rustls::client::TlsStream<tokio::net::TcpStream> {
    let ca_certs = certs(&mut pki.ca_pem.as_bytes()).collect::<Result<Vec<_>, _>>().unwrap();
    let mut roots = rustls::RootCertStore::empty();
    for c in ca_certs {
        roots.add(c).unwrap();
    }
    let client_certs = certs(&mut pki.client_cert_pem.as_bytes()).collect::<Result<Vec<_>, _>>().unwrap();
    let client_key = pkcs8_private_keys(&mut pki.client_key_pem.as_bytes())
        .next()
        .unwrap()
        .unwrap();
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(client_certs, rustls::pki_types::PrivateKeyDer::Pkcs8(client_key))
        .expect("client config with client cert");
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let tcp = tokio::net::TcpStream::connect(addr).await.expect("tcp connect");
    let server_name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
    connector.connect(server_name, tcp).await.expect("tls handshake")
}

#[tokio::test]
async fn hello_from_the_expected_peer_receives_hello_ok() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let pki = build_test_pki("svc-action-executor-test");

    let cert_file = write_temp_pem(&pki.server_cert_pem);
    let key_file = write_temp_pem(&pki.server_key_pem);
    let ca_file = write_temp_pem(&pki.ca_pem);

    let cli = svc_action::config::CliConfig::parse_from([
        "svc-action",
        "--host-api-port",
        "0",
        "--host-api-tls-cert-file",
        cert_file.path.to_str().unwrap(),
        "--host-api-tls-key-file",
        key_file.path.to_str().unwrap(),
        "--host-api-tls-ca-file",
        ca_file.path.to_str().unwrap(),
        "--host-api-peer-identity",
        "svc-action-executor-test",
    ]);
    // SAFETY: this test owns its own process-wide secret env vars.
    unsafe {
        std::env::set_var("DB_PASSWORD", "x");
        std::env::set_var("SECRET_KEY", "x");
        std::env::set_var("VALKEY_URL", "redis://127.0.0.1:1/0");
    }
    let config = svc_action::config::Config::from_cli(cli).unwrap();

    let registry = prometheus::Registry::new();
    let server = Arc::new(HostApiServer::new(&config, &registry).expect("server builds"));
    let bound_addr = server.local_addr();
    tokio::spawn(server.clone().accept_loop());

    let tls_stream = connect_client(bound_addr, &pki).await;
    let transport = FrameTransport::spawn(tls_stream, 1_048_576);
    let reply = transport
        .call(Message::Hello {
            protocol_version: 1,
            executor_version: "0.1.0".into(),
            wasmtime_version: "48.0.2".into(),
            wasmtime_abi: "48".into(),
            collector: "drc".into(),
            sandbox: SandboxInfo { runtime: "gvisor".into(), verified: true },
        })
        .await
        .expect("hello call succeeds");
    match reply {
        Message::HelloOk { stage, protocol_version, .. } => {
            assert_eq!(stage, "action");
            assert_eq!(protocol_version, 1);
        }
        other => panic!("expected HelloOk, got {other:?}"),
    }
}

#[tokio::test]
async fn hello_reporting_runc_when_gvisor_is_expected_is_refused() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let pki = build_test_pki("svc-action-executor-test");
    let cert_file = write_temp_pem(&pki.server_cert_pem);
    let key_file = write_temp_pem(&pki.server_key_pem);
    let ca_file = write_temp_pem(&pki.ca_pem);

    let cli = svc_action::config::CliConfig::parse_from([
        "svc-action",
        "--host-api-port",
        "0",
        "--host-api-tls-cert-file",
        cert_file.path.to_str().unwrap(),
        "--host-api-tls-key-file",
        key_file.path.to_str().unwrap(),
        "--host-api-tls-ca-file",
        ca_file.path.to_str().unwrap(),
        "--host-api-peer-identity",
        "svc-action-executor-test",
        "--waddles-sandbox-gvisor",
        "true",
    ]);
    // SAFETY: this test owns its own process-wide secret env vars.
    unsafe {
        std::env::set_var("DB_PASSWORD", "x");
        std::env::set_var("SECRET_KEY", "x");
        std::env::set_var("VALKEY_URL", "redis://127.0.0.1:1/0");
    }
    let config = svc_action::config::Config::from_cli(cli).unwrap();
    let registry = prometheus::Registry::new();
    let server = Arc::new(HostApiServer::new(&config, &registry).expect("server builds"));
    let bound_addr = server.local_addr();
    tokio::spawn(server.clone().accept_loop());

    let tls_stream = connect_client(bound_addr, &pki).await;
    let transport = FrameTransport::spawn(tls_stream, 1_048_576);
    let reply = transport
        .call(Message::Hello {
            protocol_version: 1,
            executor_version: "0.1.0".into(),
            wasmtime_version: "48.0.2".into(),
            wasmtime_abi: "48".into(),
            collector: "drc".into(),
            sandbox: SandboxInfo { runtime: "runc".into(), verified: false },
        })
        .await
        .expect("hello call still gets a reply frame (an Error, not a hang)");
    match reply {
        Message::Error { code, .. } => assert_eq!(code, penguin_bundle_host::wire::message::ErrorCode::UnsandboxedExecutor),
        other => panic!("expected Error(UnsandboxedExecutor), got {other:?}"),
    }
}
```

Add `uuid = { version = "=1.26.1", features = ["v4"] }` is already a dependency (Task 1); add `[dev-dependencies] tempfile-adjacent helper needs no new crate` — the inline `tempfile_like` module above uses only `std` + the already-pinned `uuid` crate.

- [ ] **Step 4: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `hostapi` module does not exist yet.

- [ ] **Step 5: Write `src/hostapi/mod.rs`**

```rust
//! The mTLS host-API server (`:8302`) the `svc-action-executor` Deployment
//! dials into. The stage never dials the executor. See spec Sec 6.6/7.1.

pub mod server;
pub mod registry;
pub mod capabilities;
pub mod dispatch;
```

(`registry`, `capabilities`, `dispatch` are created by Tasks 15-16-21; declare the `pub mod` lines now so this task compiles once those files exist -- for this task alone, temporarily stub `registry.rs`/`capabilities/mod.rs`/`dispatch.rs` with just their module doc comment and no items, since Rust requires the file to exist for `pub mod` to resolve:)

```rust
// src/hostapi/registry.rs (temporary content for this task; Task 15 replaces it)
//! Bundle digest registry -- replaced by Task 15.
```

```rust
// src/hostapi/capabilities/mod.rs (temporary content for this task; Task 16 replaces it)
//! Host capability implementations -- replaced by Tasks 16-20.
```

```rust
// src/hostapi/dispatch.rs (temporary content for this task; Task 21 replaces it)
//! Host-call dispatch multiplexer -- replaced by Task 21.
```

- [ ] **Step 6: Write `src/hostapi/server.rs`**

```rust
//! mTLS TCP listener: accepts the executor's dial-in connection, verifies
//! its client certificate and pinned Common Name, and runs the
//! `hello`/`hello-ok` handshake (spec Sec 6.6). Frame traffic after the
//! handshake is handled by Task 15's connection loop.

use std::net::SocketAddr;
use std::sync::Arc;

use penguin_bundle_host::wire::message::{ErrorCode, HelloLimits, Message};
use penguin_bundle_host::wire::transport::FrameTransport;
use rustls_pemfile::{certs, pkcs8_private_keys};
use thiserror::Error;
use x509_parser::prelude::{FromDer, X509Certificate};

use crate::config::Config;

/// Errors constructing or running the host-API server.
#[derive(Debug, Error)]
pub enum HostApiServerError {
    #[error("failed to read {path}: {source}")]
    ReadFile { path: String, #[source] source: std::io::Error },
    #[error("no private key found in {0}")]
    NoPrivateKey(String),
    #[error("TLS configuration error: {0}")]
    Tls(#[from] rustls::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

fn load_certs(path: &str) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>, HostApiServerError> {
    let bytes = std::fs::read(path).map_err(|source| HostApiServerError::ReadFile { path: path.to_string(), source })?;
    certs(&mut bytes.as_slice())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| HostApiServerError::ReadFile { path: path.to_string(), source })
}

fn load_private_key(path: &str) -> Result<rustls::pki_types::PrivateKeyDer<'static>, HostApiServerError> {
    let bytes = std::fs::read(path).map_err(|source| HostApiServerError::ReadFile { path: path.to_string(), source })?;
    let key = pkcs8_private_keys(&mut bytes.as_slice())
        .next()
        .ok_or_else(|| HostApiServerError::NoPrivateKey(path.to_string()))?
        .map_err(|source| HostApiServerError::ReadFile { path: path.to_string(), source })?;
    Ok(rustls::pki_types::PrivateKeyDer::Pkcs8(key))
}

fn build_tls_config(cert_path: &str, key_path: &str, ca_path: &str) -> Result<rustls::ServerConfig, HostApiServerError> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let cert_chain = load_certs(cert_path)?;
    let key = load_private_key(key_path)?;
    let mut root_store = rustls::RootCertStore::empty();
    for ca_cert in load_certs(ca_path)? {
        root_store.add(ca_cert)?;
    }
    let client_verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(root_store))
        .build()
        .map_err(|err| HostApiServerError::Tls(rustls::Error::General(err.to_string())))?;
    let config = rustls::ServerConfig::builder()
        .with_client_cert_verifier(client_verifier)
        .with_single_cert(cert_chain, key)?;
    Ok(config)
}

/// Reads the leaf client certificate's Subject Common Name out of a
/// completed mTLS handshake's peer certificate chain.
pub fn extract_peer_common_name(
    peer_certs: &[rustls::pki_types::CertificateDer<'_>],
) -> Option<String> {
    let leaf = peer_certs.first()?;
    let (_, cert) = X509Certificate::from_der(leaf.as_ref()).ok()?;
    cert.subject().iter_common_name().next()?.as_str().ok().map(str::to_string)
}

/// Counters incremented on a rejected host-API connection attempt.
#[derive(Clone)]
pub struct HostApiMetrics {
    pub rejected_total: prometheus::IntCounterVec,
}

fn register_host_api_metrics(registry: &prometheus::Registry) -> HostApiMetrics {
    let rejected_total = prometheus::IntCounterVec::new(
        prometheus::Opts::new("waddles_host_api_rejected_total", "Host-API connections refused, by reason"),
        &["reason"],
    )
    .expect("valid metric definition");
    registry.register(Box::new(rejected_total.clone())).expect("register waddles_host_api_rejected_total");
    HostApiMetrics { rejected_total }
}

/// The mTLS host-API server. Owns the TCP listener and TLS acceptor;
/// Task 15 extends the per-connection handler this struct drives.
pub struct HostApiServer {
    listener: tokio::net::TcpListener,
    local_addr: SocketAddr,
    tls_acceptor: tokio_rustls::TlsAcceptor,
    expected_peer_cn: String,
    sandbox_runtime_expected: String,
    executor_wasm_collector: String,
    max_frame_bytes: usize,
    call_timeout_ms: u64,
    max_call_timeout_ms: u64,
    metrics: HostApiMetrics,
}

impl HostApiServer {
    /// Binds `HOST_API_PORT` and loads the TLS material. Binding is
    /// synchronous-looking but `TcpListener::bind` here is actually async;
    /// callers must `.await` construction via [`Self::bind`] instead of
    /// calling this directly in async contexts that need the listener
    /// bound before returning.
    pub fn new(config: &Config, registry: &prometheus::Registry) -> Result<PendingServer, HostApiServerError> {
        let tls_config = build_tls_config(
            &config.cli.host_api_tls_cert_file,
            &config.cli.host_api_tls_key_file,
            &config.cli.host_api_tls_ca_file,
        )?;
        Ok(PendingServer {
            tls_acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(tls_config)),
            bind_addr: SocketAddr::new(config.cli.bind_addr, config.cli.host_api_port),
            expected_peer_cn: config.cli.host_api_peer_identity.clone(),
            sandbox_runtime_expected: config.cli.sandbox_runtime_expected.clone(),
            executor_wasm_collector: config.cli.executor_wasm_collector.clone(),
            max_frame_bytes: config.cli.executor_max_frame_bytes,
            call_timeout_ms: config.cli.executor_call_timeout_ms,
            max_call_timeout_ms: config.cli.executor_max_call_timeout_ms,
            metrics: register_host_api_metrics(registry),
        })
    }

    /// The bound local address (useful in tests that bind port `0`).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Accepts connections until the process shuts down. Each connection
    /// runs the `hello`/`hello-ok` handshake; a handshake failure closes
    /// the connection and increments `waddles_host_api_rejected_total`.
    pub async fn accept_loop(self: Arc<Self>) -> anyhow::Result<()> {
        loop {
            let (tcp, _peer_addr) = self.listener.accept().await?;
            let acceptor = self.tls_acceptor.clone();
            let this = self.clone();
            tokio::spawn(async move {
                match acceptor.accept(tcp).await {
                    Ok(tls_stream) => this.handle_connection(tls_stream).await,
                    Err(err) => {
                        this.metrics.rejected_total.with_label_values(&["tls_handshake_failed"]).inc();
                        tracing::warn!(error = %err, "host-api TLS handshake failed");
                    }
                }
            });
        }
    }

    async fn handle_connection(&self, tls_stream: tokio_rustls::server::TlsStream<tokio::net::TcpStream>) {
        let peer_certs = tls_stream.get_ref().1.peer_certificates().map(<[_]>::to_vec).unwrap_or_default();
        let peer_cn = extract_peer_common_name(&peer_certs);
        if peer_cn.as_deref() != Some(self.expected_peer_cn.as_str()) {
            self.metrics.rejected_total.with_label_values(&["peer_identity_mismatch"]).inc();
            tracing::warn!(expected = %self.expected_peer_cn, got = ?peer_cn, "host-api connection from unexpected peer identity");
            return;
        }

        let transport = FrameTransport::spawn(tls_stream, self.max_frame_bytes);
        let frame = match transport.recv_unsolicited().await {
            Ok(f) => f,
            Err(err) => {
                tracing::warn!(error = %err, "host-api connection closed before hello");
                return;
            }
        };
        let Message::Hello { collector, sandbox, .. } = frame.message else {
            self.metrics.rejected_total.with_label_values(&["expected_hello"]).inc();
            return;
        };

        if self.sandbox_runtime_expected == "gvisor" && sandbox.runtime != "gvisor" {
            self.metrics.rejected_total.with_label_values(&["unsandboxed_executor"]).inc();
            let _ = transport
                .send(frame.id, Message::Error { code: ErrorCode::UnsandboxedExecutor, message: format!("stage expects gvisor, executor reported {}", sandbox.runtime), detail: None })
                .await;
            return;
        }
        if collector != self.executor_wasm_collector {
            self.metrics.rejected_total.with_label_values(&["collector_mismatch"]).inc();
            let _ = transport
                .send(frame.id, Message::Error { code: ErrorCode::ProtocolVersion, message: format!("stage expects collector {}, executor reported {collector}", self.executor_wasm_collector), detail: None })
                .await;
            return;
        }

        let _ = transport
            .send(
                frame.id,
                Message::HelloOk {
                    stage: "action".to_string(),
                    protocol_version: 1,
                    limits: HelloLimits {
                        call_timeout_ms: self.call_timeout_ms,
                        memory_mb: 64,
                        max_concurrent_calls: 32,
                    },
                },
            )
            .await;

        // Task 15 replaces the line below with the Load/Invoke/HostCall
        // serving loop for this now-handshaken connection.
        tracing::info!("host-api connection handshake complete; frame serving lands in Task 15");
    }
}

/// Intermediate builder that still needs its listener bound
/// asynchronously -- kept separate from [`HostApiServer`] so
/// [`HostApiServer::new`] stays a plain, testable, synchronous
/// constructor and binding stays explicit at the call site.
pub struct PendingServer {
    tls_acceptor: tokio_rustls::TlsAcceptor,
    bind_addr: SocketAddr,
    expected_peer_cn: String,
    sandbox_runtime_expected: String,
    executor_wasm_collector: String,
    max_frame_bytes: usize,
    call_timeout_ms: u64,
    max_call_timeout_ms: u64,
    metrics: HostApiMetrics,
}

impl PendingServer {
    /// Binds the listener and returns the ready-to-run [`HostApiServer`].
    pub async fn bind(self) -> Result<HostApiServer, HostApiServerError> {
        let listener = tokio::net::TcpListener::bind(self.bind_addr).await?;
        let local_addr = listener.local_addr()?;
        Ok(HostApiServer {
            listener,
            local_addr,
            tls_acceptor: self.tls_acceptor,
            expected_peer_cn: self.expected_peer_cn,
            sandbox_runtime_expected: self.sandbox_runtime_expected,
            executor_wasm_collector: self.executor_wasm_collector,
            max_frame_bytes: self.max_frame_bytes,
            call_timeout_ms: self.call_timeout_ms,
            max_call_timeout_ms: self.max_call_timeout_ms,
            metrics: self.metrics,
        })
    }
}
```

Amend the handshake test's usage: `HostApiServer::new(&config, &registry).expect("server builds")` returns a `PendingServer`; the test must additionally `.bind().await.expect("bind")` before calling `.local_addr()`/`accept_loop()`. Update both test functions in Step 3 to:

```rust
let server = Arc::new(
    HostApiServer::new(&config, &registry)
        .expect("server builds")
        .bind()
        .await
        .expect("bind succeeds"),
);
```

- [ ] **Step 7: Add the module to `src/lib.rs`**

```rust
pub mod hostapi;
```

- [ ] **Step 8: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 2 passed; 0 failed` for `hostapi_handshake`.

- [ ] **Step 9: Commit**

Stage `core/svc_action/Cargo.toml core/svc_action/Cargo.lock core/svc_action/src/hostapi/ core/svc_action/src/lib.rs core/svc_action/tests/support/ core/svc_action/tests/hostapi_handshake.rs` and commit with message:

```
feat(svc-action): mTLS host-API listener + hello/hello-ok handshake

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 15: Bundle registry + `load`/`unload`/`invoke` round trip

**Files:**
- Modify: `core/svc_action/src/hostapi/server.rs` (extend `handle_connection` to register the connection and enter the serving loop)
- Create: `core/svc_action/src/hostapi/registry.rs` (replaces Task 14's stub)
- Create: `core/svc_action/tests/support/fake_executor.rs`
- Modify: `core/svc_action/tests/support/mod.rs` (add `pub mod fake_executor;`)
- Create: `core/svc_action/tests/hostapi_load_invoke.rs`

**Interfaces:**
- Consumes: `penguin_bundle_host::wire::message::{Message, ExportKind, ErrorCode}`, `hostapi::server::HostApiServer` (Task 14).
- Produces: `hostapi::registry::{BundleRegistry, ExecutorConnection, ConnectionPool, LoadRequest, LoadedInfo, LoadError, InvokeRequest, InvokeError}` — Task 21's dispatch multiplexer calls `ConnectionPool::pick()` to get an `Arc<ExecutorConnection>` and `.invoke(req)`; Task 22's consumer loop calls `BundleRegistry::reconcile(...)` once per distribution poll.

- [ ] **Step 1: Write the fake executor test double**

`tests/support/fake_executor.rs`:

```rust
//! A scripted wire-protocol executor double: dials the stage exactly like
//! the real `bundle-executor` would, completes the `hello`/`hello-ok`
//! handshake, and then answers exactly the frames a test script expects.
//! No wasmtime, no real WASM -- this exercises the stage's own protocol
//! handling, which is `svc-action`'s responsibility, not the executor's.

use std::sync::Arc;

use penguin_bundle_host::wire::message::{Frame, Message, SandboxInfo};
use penguin_bundle_host::wire::transport::FrameTransport;
use rustls_pemfile::{certs, pkcs8_private_keys};

use super::test_certs::TestPki;

/// A connected, handshaken fake executor.
pub struct FakeExecutor {
    pub transport: Arc<FrameTransport>,
}

impl FakeExecutor {
    /// Dials `addr` over mTLS using `pki`'s client certificate, sends
    /// `hello`, and awaits `hello-ok`. Panics (via `expect`) on any
    /// handshake failure -- a test fixture, not production code.
    pub async fn connect(addr: std::net::SocketAddr, pki: &TestPki) -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let ca_certs = certs(&mut pki.ca_pem.as_bytes()).collect::<Result<Vec<_>, _>>().unwrap();
        let mut roots = rustls::RootCertStore::empty();
        for c in ca_certs {
            roots.add(c).unwrap();
        }
        let client_certs = certs(&mut pki.client_cert_pem.as_bytes()).collect::<Result<Vec<_>, _>>().unwrap();
        let client_key = pkcs8_private_keys(&mut pki.client_key_pem.as_bytes()).next().unwrap().unwrap();
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_client_auth_cert(client_certs, rustls::pki_types::PrivateKeyDer::Pkcs8(client_key))
            .expect("client config with client cert");
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        let tcp = tokio::net::TcpStream::connect(addr).await.expect("tcp connect");
        let server_name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
        let tls_stream = connector.connect(server_name, tcp).await.expect("tls handshake");

        let transport = FrameTransport::spawn(tls_stream, 1_048_576);
        let reply = transport
            .call(Message::Hello {
                protocol_version: 1,
                executor_version: "0.1.0".into(),
                wasmtime_version: "48.0.2".into(),
                wasmtime_abi: "48".into(),
                collector: "drc".into(),
                sandbox: SandboxInfo { runtime: "gvisor".into(), verified: true },
            })
            .await
            .expect("hello call succeeds");
        assert!(matches!(reply, Message::HelloOk { .. }), "handshake must complete before the test proceeds");

        Self { transport: Arc::new(transport) }
    }

    /// Awaits the next unsolicited frame from the stage (a `load`,
    /// `unload` or `invoke`) and returns it for the caller's own
    /// assertions/replies.
    pub async fn recv(&self) -> Frame {
        self.transport.recv_unsolicited().await.expect("connection stays open for the scripted exchange")
    }

    /// Replies to a received frame's `id` with `message`.
    pub async fn reply(&self, id: u64, message: Message) {
        self.transport.send(id, message).await.expect("reply send succeeds");
    }
}
```

- [ ] **Step 2: Write the failing load/invoke test**

`tests/hostapi_load_invoke.rs`:

```rust
mod support;

use std::sync::Arc;

use penguin_bundle_host::wire::message::{ExportKind, Message};
use support::fake_executor::FakeExecutor;
use support::test_certs::build_test_pki;
use svc_action::hostapi::registry::{BundleRegistry, ConnectionPool, ExecutorConnection, InvokeRequest, LoadRequest};
use svc_action::hostapi::server::HostApiServer;

async fn start_test_server() -> (Arc<HostApiServer>, support::test_certs::TestPki, std::net::SocketAddr) {
    let pki = build_test_pki("svc-action-executor-test");
    let cert_file = std::env::temp_dir().join(format!("cert-{}.pem", uuid::Uuid::new_v4()));
    let key_file = std::env::temp_dir().join(format!("key-{}.pem", uuid::Uuid::new_v4()));
    let ca_file = std::env::temp_dir().join(format!("ca-{}.pem", uuid::Uuid::new_v4()));
    std::fs::write(&cert_file, &pki.server_cert_pem).unwrap();
    std::fs::write(&key_file, &pki.server_key_pem).unwrap();
    std::fs::write(&ca_file, &pki.ca_pem).unwrap();

    let cli = svc_action::config::CliConfig::parse_from([
        "svc-action",
        "--host-api-port", "0",
        "--host-api-tls-cert-file", cert_file.to_str().unwrap(),
        "--host-api-tls-key-file", key_file.to_str().unwrap(),
        "--host-api-tls-ca-file", ca_file.to_str().unwrap(),
        "--host-api-peer-identity", "svc-action-executor-test",
    ]);
    // SAFETY: this test owns its own process-wide secret env vars.
    unsafe {
        std::env::set_var("DB_PASSWORD", "x");
        std::env::set_var("SECRET_KEY", "x");
        std::env::set_var("VALKEY_URL", "redis://127.0.0.1:1/0");
    }
    let config = svc_action::config::Config::from_cli(cli).unwrap();
    let registry = prometheus::Registry::new();
    let server = Arc::new(HostApiServer::new(&config, &registry).unwrap().bind().await.unwrap());
    let addr = server.local_addr();
    (server, pki, addr)
}

#[tokio::test]
async fn stage_loads_a_digest_then_invokes_dispatch_and_gets_a_result() {
    let (server, pki, addr) = start_test_server().await;
    let pool = Arc::new(ConnectionPool::new());
    let pool_clone = pool.clone();
    tokio::spawn(server.clone().accept_loop_into_pool(pool_clone));

    let fake = FakeExecutor::connect(addr, &pki).await;
    // Give the stage's accept loop a moment to register the connection.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let conn = pool.pick().expect("one connection registered");

    let fake_task = tokio::spawn(async move {
        let load_frame = fake.recv().await;
        let Message::Load { app_id, digest, .. } = load_frame.message else { panic!("expected Load") };
        fake.reply(load_frame.id, Message::Loaded { app_id: app_id.clone(), digest: digest.clone(), precompile_ms: 5, exports: vec!["dispatch".into()] }).await;

        let invoke_frame = fake.recv().await;
        let Message::Invoke { .. } = invoke_frame.message else { panic!("expected Invoke") };
        fake.reply(invoke_frame.id, Message::Result { payload: serde_json::json!({"ok": true}), duration_ms: 3, fuel_used: 0 }).await;
    });

    let loaded = conn
        .load(LoadRequest {
            app_id: "waddles.socials.music.default".to_string(),
            version: "3.0.0".to_string(),
            digest: "sha256:abc".to_string(),
            component_key: "bundles/waddles.socials.music.default/3.0.0/abc.wasm".to_string(),
            sidecar_key: "bundles/waddles.socials.music.default/3.0.0/abc.json".to_string(),
            capabilities: vec!["http".to_string()],
            timeout_ms: 2000,
            memory_mb: 64,
        })
        .await
        .expect("load succeeds");
    assert_eq!(loaded.exports, vec!["dispatch".to_string()]);

    let result = conn
        .invoke(InvokeRequest {
            app_id: "waddles.socials.music.default".to_string(),
            digest: "sha256:abc".to_string(),
            export: ExportKind::Dispatch,
            payload: serde_json::json!({"tenant": "global"}),
            deadline_ms: 2000,
            trace_context: None,
        })
        .await
        .expect("invoke succeeds");
    assert_eq!(result["ok"], true);

    fake_task.await.unwrap();
}

#[test]
fn bundle_registry_tracks_current_digest_per_app_id() {
    let prom = prometheus::Registry::new();
    let registry = BundleRegistry::new(&prom);
    assert_eq!(registry.current_digest("waddles.bot.commands.default"), None);
    registry.record_loaded("waddles.bot.commands.default", "sha256:abc");
    assert_eq!(registry.current_digest("waddles.bot.commands.default"), Some("sha256:abc".to_string()));
    registry.record_unloaded("waddles.bot.commands.default");
    assert_eq!(registry.current_digest("waddles.bot.commands.default"), None);
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `hostapi::registry` items (`BundleRegistry`, `ConnectionPool`, ...) and `HostApiServer::accept_loop_into_pool` do not exist yet.

- [ ] **Step 4: Write `src/hostapi/registry.rs`** (replaces Task 14's stub content)

```rust
//! Tracks which digest is currently loaded per `app_id` (spec Sec 7.6
//! reconciliation) and the pool of live executor connections a stage can
//! dispatch `load`/`unload`/`invoke` calls across.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use penguin_bundle_host::wire::message::{ErrorCode, ExportKind, LoadLimits, Message};
use penguin_bundle_host::wire::transport::{FrameTransport, TransportError};
use thiserror::Error;

/// One `load` call's parameters (spec Sec 6.6 `load` frame).
#[derive(Debug, Clone)]
pub struct LoadRequest {
    pub app_id: String,
    pub version: String,
    pub digest: String,
    pub component_key: String,
    pub sidecar_key: String,
    pub capabilities: Vec<String>,
    pub timeout_ms: u64,
    pub memory_mb: u32,
}

/// A successful `loaded` reply's payload.
#[derive(Debug, Clone)]
pub struct LoadedInfo {
    pub precompile_ms: u64,
    pub exports: Vec<String>,
}

/// Errors from `load`/`unload`.
#[derive(Debug, Error)]
pub enum LoadError {
    #[error("transport error: {0}")]
    Transport(#[from] TransportError),
    #[error("executor reported {code:?}: {message}")]
    Remote { code: ErrorCode, message: String },
    #[error("unexpected reply frame")]
    UnexpectedReply,
}

/// One `invoke` call's parameters (spec Sec 6.6 `invoke` frame).
#[derive(Debug, Clone)]
pub struct InvokeRequest {
    pub app_id: String,
    pub digest: String,
    pub export: ExportKind,
    pub payload: serde_json::Value,
    pub deadline_ms: u64,
    pub trace_context: Option<String>,
}

/// Errors from `invoke`.
#[derive(Debug, Error)]
pub enum InvokeError {
    #[error("transport error: {0}")]
    Transport(#[from] TransportError),
    #[error("executor reported {code:?}: {message}")]
    Remote { code: ErrorCode, message: String },
    #[error("call exceeded its deadline")]
    Deadline,
    #[error("unexpected reply frame")]
    UnexpectedReply,
}

/// One live, handshaken executor connection this stage can send
/// `load`/`unload`/`invoke` calls across. `host-call` traffic on the same
/// connection is served by Task 21's dispatch loop, which owns
/// `recv_unsolicited()` for this transport -- `load`/`invoke` use
/// `FrameTransport::call`, which is safe to interleave with that loop
/// because `FrameTransport` demultiplexes by correlation id.
pub struct ExecutorConnection {
    transport: Arc<FrameTransport>,
}

impl ExecutorConnection {
    /// Wraps an already-handshaken [`FrameTransport`].
    pub fn new(transport: Arc<FrameTransport>) -> Self {
        Self { transport }
    }

    /// Sends `load` and awaits `loaded` or `error`.
    pub async fn load(&self, req: LoadRequest) -> Result<LoadedInfo, LoadError> {
        let reply = self
            .transport
            .call(Message::Load {
                app_id: req.app_id,
                version: req.version,
                digest: req.digest,
                component_key: req.component_key,
                sidecar_key: req.sidecar_key,
                capabilities: req.capabilities,
                limits: LoadLimits { timeout_ms: req.timeout_ms, memory_mb: req.memory_mb },
            })
            .await?;
        match reply {
            Message::Loaded { precompile_ms, exports, .. } => Ok(LoadedInfo { precompile_ms, exports }),
            Message::Error { code, message, .. } => Err(LoadError::Remote { code, message }),
            _ => Err(LoadError::UnexpectedReply),
        }
    }

    /// Sends `unload` and awaits `unloaded` or `error`.
    pub async fn unload(&self, app_id: &str, digest: &str) -> Result<(), LoadError> {
        let reply = self
            .transport
            .call(Message::Unload { app_id: app_id.to_string(), digest: digest.to_string() })
            .await?;
        match reply {
            Message::Unloaded { .. } => Ok(()),
            Message::Error { code, message, .. } => Err(LoadError::Remote { code, message }),
            _ => Err(LoadError::UnexpectedReply),
        }
    }

    /// Sends `invoke` and awaits `result` or `error`, backstopped by the
    /// stage's own `deadline_ms + 250ms` timer (spec Sec 6.6 Deadline
    /// ownership) -- a wedged executor is treated as `InvokeError::Deadline`
    /// rather than hanging forever.
    pub async fn invoke(&self, req: InvokeRequest) -> Result<serde_json::Value, InvokeError> {
        let deadline_ms = req.deadline_ms;
        let call = self.transport.call(Message::Invoke {
            app_id: req.app_id,
            digest: req.digest,
            export: req.export,
            payload: req.payload,
            deadline_ms,
            trace_context: req.trace_context,
        });
        match tokio::time::timeout(Duration::from_millis(deadline_ms + 250), call).await {
            Ok(Ok(Message::Result { payload, .. })) => Ok(payload),
            Ok(Ok(Message::Error { code, message, .. })) => Err(InvokeError::Remote { code, message }),
            Ok(Ok(_)) => Err(InvokeError::UnexpectedReply),
            Ok(Err(transport_err)) => Err(InvokeError::Transport(transport_err)),
            Err(_elapsed) => Err(InvokeError::Deadline),
        }
    }
}

/// The set of live executor connections this stage can dispatch across.
/// Picking is round-robin; a connection that closes removes itself via
/// [`Self::remove`] (called by the server's connection-drop path).
#[derive(Default)]
pub struct ConnectionPool {
    connections: Mutex<Vec<Arc<ExecutorConnection>>>,
    next: std::sync::atomic::AtomicUsize,
}

impl ConnectionPool {
    /// An empty pool.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a newly-handshaken connection.
    pub fn insert(&self, conn: Arc<ExecutorConnection>) {
        self.connections.lock().expect("mutex not poisoned").push(conn);
    }

    /// Round-robin picks one live connection, or `None` if the executor
    /// is entirely unavailable (spec Sec 5.5: this drives
    /// `executor_unavailable` DLQ classification in Task 22).
    pub fn pick(&self) -> Option<Arc<ExecutorConnection>> {
        let conns = self.connections.lock().expect("mutex not poisoned");
        if conns.is_empty() {
            return None;
        }
        let idx = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % conns.len();
        Some(conns[idx].clone())
    }

    /// Current live connection count.
    pub fn len(&self) -> usize {
        self.connections.lock().expect("mutex not poisoned").len()
    }

    /// True when no connection is currently registered.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Tracks which digest is currently loaded per `app_id`.
pub struct BundleRegistry {
    loaded: Mutex<HashMap<String, String>>,
    bundles_loaded_gauge: prometheus::IntGauge,
}

impl BundleRegistry {
    /// Registers `waddles_bundles_loaded{stage="action"}` against `registry`.
    pub fn new(registry: &prometheus::Registry) -> Self {
        let bundles_loaded_gauge = prometheus::IntGauge::new("waddles_bundles_loaded_action", "Components currently resident in the action stage's executors")
            .expect("valid metric definition");
        registry.register(Box::new(bundles_loaded_gauge.clone())).expect("register waddles_bundles_loaded_action");
        Self { loaded: Mutex::new(HashMap::new()), bundles_loaded_gauge }
    }

    /// The digest currently believed loaded for `app_id`, if any.
    pub fn current_digest(&self, app_id: &str) -> Option<String> {
        self.loaded.lock().expect("mutex not poisoned").get(app_id).cloned()
    }

    /// Records that `app_id` is now loaded at `digest`.
    pub fn record_loaded(&self, app_id: &str, digest: &str) {
        self.loaded.lock().expect("mutex not poisoned").insert(app_id.to_string(), digest.to_string());
        self.bundles_loaded_gauge.set(self.loaded.lock().expect("mutex not poisoned").len() as i64);
    }

    /// Records that `app_id` is no longer loaded.
    pub fn record_unloaded(&self, app_id: &str) {
        self.loaded.lock().expect("mutex not poisoned").remove(app_id);
        self.bundles_loaded_gauge.set(self.loaded.lock().expect("mutex not poisoned").len() as i64);
    }

    /// Every `app_id` currently believed loaded.
    pub fn loaded_app_ids(&self) -> Vec<String> {
        self.loaded.lock().expect("mutex not poisoned").keys().cloned().collect()
    }
}
```

- [ ] **Step 5: Extend `src/hostapi/server.rs`** — replace the handshake success comment (`"host-api connection handshake complete; ..."`) with connection-pool registration, and add `accept_loop_into_pool`

```rust
// Add near the top of hostapi/server.rs:
use crate::hostapi::registry::{ConnectionPool, ExecutorConnection};

// Replace the trailing `tracing::info!(...)` line inside `handle_connection`
// (added in Task 14, Step 6) with:
        let conn = Arc::new(ExecutorConnection::new(Arc::new(transport)));
        if let Some(pool) = &self.connection_pool {
            pool.insert(conn.clone());
            tracing::info!("host-api executor connection registered, pool size {}", pool.len());
        }
        // Task 21 replaces this line with the host-call serving loop that
        // reads this connection's `recv_unsolicited()` for `host-call`
        // frames for as long as the connection stays open.

// Add a `connection_pool: Option<Arc<ConnectionPool>>` field to both
// `HostApiServer` and `PendingServer` structs (default `None`, set by a
// new `with_connection_pool` builder method), and the driving method:

impl HostApiServer {
    /// Same as [`Self::accept_loop`], but registers every handshaken
    /// connection into `pool` so [`ConnectionPool::pick`] can dispatch
    /// `load`/`invoke` calls across it.
    pub async fn accept_loop_into_pool(self: Arc<Self>, pool: Arc<ConnectionPool>) -> anyhow::Result<()> {
        let mut this = (*self).clone_with_pool(pool);
        Arc::new(this).accept_loop().await
    }
}
```

Because `HostApiServer` as written in Task 14 has no `Clone` derive and owns a non-cloneable `TcpListener`, replace the above sketch with the concrete, compiling shape: add `connection_pool: Mutex<Option<Arc<ConnectionPool>>>` as a field (mutable interior, no `Clone` needed), a `pub fn set_connection_pool(&self, pool: Arc<ConnectionPool>)` setter, and call `self.set_connection_pool(pool)` at the top of `accept_loop_into_pool` before delegating to `self.accept_loop()`. Update `handle_connection` to read `self.connection_pool.lock().expect(...).clone()` instead of a plain field access.

- [ ] **Step 6: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 2 passed; 0 failed` for `hostapi_load_invoke`, plus all prior suites still green.

- [ ] **Step 7: Commit**

Stage `core/svc_action/src/hostapi/registry.rs core/svc_action/src/hostapi/server.rs core/svc_action/tests/support/fake_executor.rs core/svc_action/tests/support/mod.rs core/svc_action/tests/hostapi_load_invoke.rs` and commit with message:

```
feat(svc-action): bundle registry + load/unload/invoke round trip

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 16: Host capabilities — `context`, `clock`, `flags`

**Files:**
- Create: `core/svc_action/src/hostapi/capabilities/context.rs`
- Create: `core/svc_action/src/hostapi/capabilities/flags.rs`
- Modify: `core/svc_action/src/hostapi/capabilities/mod.rs` (replaces Task 14's stub)
- Test: `core/svc_action/tests/capabilities_context_flags.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `hostapi::capabilities::{context::{build_bundle_context, BundleContext}, flags::{FlagsClient, PostHogFlagsClient}}` — Task 21's dispatch multiplexer calls `build_bundle_context` for `capability: context, op: "get-context"` and `FlagsClient::enabled`/`tier` for `capability: flags`.

- [ ] **Step 1: Write the failing tests**

`tests/capabilities_context_flags.rs`:

```rust
use svc_action::hostapi::capabilities::context::build_bundle_context;
use svc_action::hostapi::capabilities::flags::{FlagsClient, PostHogFlagsClient};

#[test]
fn build_bundle_context_carries_envelope_and_config_fields() {
    let ctx = build_bundle_context(
        "global",
        Some("main"),
        "waddles.bot.discord.default",
        "waddles.bot.discord",
        "3.0.0",
        "1757851200000-0",
        &serde_json::json!({"channel_id": "123"}),
    );
    assert_eq!(ctx.tenant, "global");
    assert_eq!(ctx.community.as_deref(), Some("main"));
    assert_eq!(ctx.app_id, "waddles.bot.discord.default");
    assert_eq!(ctx.message_id, "1757851200000-0");
    let config: serde_json::Value = serde_json::from_str(&ctx.config_json).unwrap();
    assert_eq!(config["channel_id"], "123");
}

#[tokio::test]
async fn flags_client_fails_open_to_the_supplied_default_when_unconfigured() {
    let client = PostHogFlagsClient::unconfigured();
    assert!(client.enabled("waddles.core.bundle-egress", true).await);
    assert!(!client.enabled("waddles.core.bundle-egress", false).await);
    assert_eq!(client.tier().await, "free");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `hostapi::capabilities::context`/`flags` do not exist yet.

- [ ] **Step 3: Write `src/hostapi/capabilities/context.rs`**

```rust
//! `context` host capability -- immutable, per-call scope, always granted
//! (spec Sec 6.5 `interface context`). Built once per `invoke` from the
//! envelope the stage took off the key plus the resolved 3-tier config;
//! tenant/community always come from the key, never from payload.

use serde::Serialize;

/// Mirrors the WIT `bundle-context` record.
#[derive(Debug, Clone, Serialize)]
pub struct BundleContext {
    pub tenant: String,
    pub community: Option<String>,
    pub app_id: String,
    pub feature: String,
    pub version: String,
    pub message_id: String,
    pub config_json: String,
}

/// Builds the `context` capability's `get-context` response.
/// `config_json` is the resolved 3-tier config, already serialized.
pub fn build_bundle_context(
    tenant: &str,
    community: Option<&str>,
    app_id: &str,
    feature: &str,
    version: &str,
    message_id: &str,
    config: &serde_json::Value,
) -> BundleContext {
    BundleContext {
        tenant: tenant.to_string(),
        community: community.map(str::to_string),
        app_id: app_id.to_string(),
        feature: feature.to_string(),
        version: version.to_string(),
        message_id: message_id.to_string(),
        config_json: config.to_string(),
    }
}

/// `clock` host capability -- wall clock from the stage, monotonic from
/// the stage's own `Instant`; the guest gets no other time source.
pub struct ClockCapability;

impl ClockCapability {
    /// Milliseconds since the Unix epoch.
    pub fn now_millis() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock is after the Unix epoch")
            .as_millis() as u64
    }

    /// RFC 3339 UTC, millisecond precision.
    pub fn now_rfc3339() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// Monotonic nanoseconds, for in-bundle duration measurement only.
    pub fn monotonic_nanos() -> u64 {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        let start = START.get_or_init(std::time::Instant::now);
        start.elapsed().as_nanos() as u64
    }
}
```

- [ ] **Step 4: Write `src/hostapi/capabilities/flags.rs`**

```rust
//! `flags` host capability -- PostHog feature flag + license entitlement,
//! two-gate, cached, fail-open to the supplied default (spec Sec 6.5
//! `interface flags`; `rules/critical-rules.md` Feature Flags & License
//! Tiers). See this plan's Global Constraints P6 for why this is a local
//! `FlagsClient` rather than a `penguin-licensing` dependency.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The behavior every flags adapter must provide.
#[async_trait::async_trait]
pub trait FlagsClient: Send + Sync {
    /// Resolves `key` against PostHog + license entitlement; fails open
    /// to `default_value` on any resolution failure or when unconfigured.
    async fn enabled(&self, key: &str, default_value: bool) -> bool;
    /// `"free" | "professional" | "enterprise"`.
    async fn tier(&self) -> String;
}

struct CachedFlag {
    value: bool,
    fetched_at: Instant,
}

/// A PostHog-backed client with a 5-minute cache and fail-open behavior.
/// [`Self::unconfigured`] builds one with no `POSTHOG_HOST`/`POSTHOG_KEY`
/// set, which always falls through to the caller's default -- the
/// correct behavior for local/dev and for the many callers this service
/// has that never set those env vars.
pub struct PostHogFlagsClient {
    posthog_host: Option<String>,
    posthog_key: Option<String>,
    http: reqwest::Client,
    cache: Mutex<HashMap<String, CachedFlag>>,
    cache_ttl: Duration,
}

impl PostHogFlagsClient {
    /// Builds a client from the standard `POSTHOG_HOST`/`POSTHOG_KEY` env
    /// vars (spec Sec 12.7); either unset means every call fails open.
    pub fn from_env() -> Self {
        Self {
            posthog_host: std::env::var("POSTHOG_HOST").ok(),
            posthog_key: std::env::var("POSTHOG_KEY").ok(),
            http: reqwest::Client::new(),
            cache: Mutex::new(HashMap::new()),
            cache_ttl: Duration::from_secs(300),
        }
    }

    /// A client with no PostHog configuration -- every call fails open to
    /// the caller's default. Used by tests and by deployments that have
    /// not opted into flag-gated behavior.
    pub fn unconfigured() -> Self {
        Self { posthog_host: None, posthog_key: None, http: reqwest::Client::new(), cache: Mutex::new(HashMap::new()), cache_ttl: Duration::from_secs(300) }
    }
}

#[async_trait::async_trait]
impl FlagsClient for PostHogFlagsClient {
    async fn enabled(&self, key: &str, default_value: bool) -> bool {
        let (Some(host), Some(api_key)) = (&self.posthog_host, &self.posthog_key) else {
            return default_value;
        };
        if let Some(cached) = self.cache.lock().expect("mutex not poisoned").get(key) {
            if cached.fetched_at.elapsed() < self.cache_ttl {
                return cached.value;
            }
        }
        let url = format!("{host}/decide?v=3");
        let body = serde_json::json!({"api_key": api_key, "distinct_id": "svc-action"});
        let resolved = match self.http.post(&url).json(&body).send().await {
            Ok(resp) => match resp.json::<serde_json::Value>().await {
                Ok(payload) => payload["featureFlags"][key].as_bool().unwrap_or(default_value),
                Err(_) => default_value,
            },
            Err(_) => default_value,
        };
        self.cache.lock().expect("mutex not poisoned").insert(key.to_string(), CachedFlag { value: resolved, fetched_at: Instant::now() });
        resolved
    }

    async fn tier(&self) -> String {
        std::env::var("LICENSE_TIER").unwrap_or_else(|_| "free".to_string())
    }
}
```

- [ ] **Step 5: Write `src/hostapi/capabilities/mod.rs`** (replaces Task 14's stub)

```rust
//! Stage-side implementations of the seven host capabilities a bundle can
//! import (spec Sec 6.5, Sec 7.4). See this plan's Global Constraints P3
//! for why these live here rather than in `penguin-bundle-host::host::*`.

pub mod context;
pub mod db;
pub mod flags;
pub mod http_egress;
pub mod kv;
pub mod relay;
```

(`db`, `http_egress`, `kv`, `relay` are written by Tasks 17-20; declare their `pub mod` lines now and give each file a one-line module doc comment as a temporary placeholder body, replaced by those tasks' own Step content — same pattern as Task 14's `registry`/`dispatch` stubs.)

- [ ] **Step 6: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 2 passed; 0 failed` for `capabilities_context_flags`.

- [ ] **Step 7: Commit**

Stage `core/svc_action/src/hostapi/capabilities/` and commit with message:

```
feat(svc-action): context, clock, flags host capabilities

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 17: Host capability — `kv`

**Files:**
- Create: `core/svc_action/src/hostapi/capabilities/kv.rs` (replaces Task 16's stub)
- Test: `core/svc_action/tests/capabilities_kv.rs`

**Interfaces:**
- Consumes: `config::Config` (Task 3).
- Produces: `hostapi::capabilities::kv::{KvCapability, KvError}` — `KvCapability::new(redis_client, max_value_bytes, max_ttl_s)`, `async fn get/set/delete/increment(&self, scope_key: &str, key: &str, ...)` — Task 21's dispatch multiplexer routes `capability: kv` ops here.

- [ ] **Step 1: Write the failing tests**

`tests/capabilities_kv.rs`:

```rust
use svc_action::hostapi::capabilities::kv::{KvCapability, KvError};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::redis::Redis;

#[tokio::test]
async fn set_get_delete_round_trip_is_namespaced_under_b_prefix() {
    let container = Redis::default().start().await.expect("valkey container starts");
    let port = container.get_host_port_ipv4(6379).await.expect("port mapped");
    let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap();
    let kv = KvCapability::new(client, 65_536, 2_592_000);

    kv.set("waddles:t:global:c:_tenant:app:waddles.bot.commands.default:state", "counter", b"42".to_vec(), 0).await.unwrap();
    let got = kv.get("waddles:t:global:c:_tenant:app:waddles.bot.commands.default:state", "counter").await.unwrap();
    assert_eq!(got, Some(b"42".to_vec()));

    kv.delete("waddles:t:global:c:_tenant:app:waddles.bot.commands.default:state", "counter").await.unwrap();
    let after_delete = kv.get("waddles:t:global:c:_tenant:app:waddles.bot.commands.default:state", "counter").await.unwrap();
    assert_eq!(after_delete, None);
}

#[tokio::test]
async fn increment_creates_then_adds() {
    let container = Redis::default().start().await.expect("valkey container starts");
    let port = container.get_host_port_ipv4(6379).await.expect("port mapped");
    let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap();
    let kv = KvCapability::new(client, 65_536, 2_592_000);

    let first = kv.increment("waddles:t:global:c:_tenant:app:waddles.bot.commands.default:state", "hits", 1, 0).await.unwrap();
    assert_eq!(first, 1);
    let second = kv.increment("waddles:t:global:c:_tenant:app:waddles.bot.commands.default:state", "hits", 5, 0).await.unwrap();
    assert_eq!(second, 6);
}

#[tokio::test]
async fn oversized_value_is_rejected() {
    let container = Redis::default().start().await.expect("valkey container starts");
    let port = container.get_host_port_ipv4(6379).await.expect("port mapped");
    let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap();
    let kv = KvCapability::new(client, 8, 2_592_000);

    let err = kv.set("scope:state", "k", vec![0u8; 100], 0).await.unwrap_err();
    assert!(matches!(err, KvError::TooLarge(_)));
}

#[tokio::test]
async fn one_bundle_never_reads_another_bundles_namespace() {
    let container = Redis::default().start().await.expect("valkey container starts");
    let port = container.get_host_port_ipv4(6379).await.expect("port mapped");
    let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap();
    let kv = KvCapability::new(client, 65_536, 2_592_000);

    kv.set("waddles:t:global:c:_tenant:app:waddles.bot.a.default:state", "secret", b"a-only".to_vec(), 0).await.unwrap();
    let cross_read = kv.get("waddles:t:global:c:_tenant:app:waddles.bot.b.default:state", "secret").await.unwrap();
    assert_eq!(cross_read, None, "bundle b's scope key is a different Valkey hash entirely");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `KvCapability` does not exist yet.

- [ ] **Step 3: Write `src/hostapi/capabilities/kv.rs`** (replaces Task 16's stub)

```rust
//! `kv` host capability -- bundle-scoped key/value over the bundle's own
//! `...:state` hash key (spec Sec 6.5 `interface kv`, Sec 7.4). The
//! guest's key is namespaced as `b:{key}` inside that hash so a bundle
//! cannot reach the stage's own fields on the same hash. TTL is per-field
//! via `{value, expires_at}` and filtered on read, since not every
//! deployed Valkey has per-field `HEXPIRE`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors from a `kv` capability call (mirrors the WIT `kv` `error` variant).
#[derive(Debug, Error)]
pub enum KvError {
    #[error("value of {0} bytes exceeds the configured KV_MAX_VALUE_BYTES limit")]
    TooLarge(usize),
    #[error("backend error: {0}")]
    Backend(String),
}

#[derive(Serialize, Deserialize)]
struct StoredValue {
    value: Vec<u8>,
    expires_at: Option<u64>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock after epoch").as_secs()
}

/// Bundle-scoped KV over a Valkey hash per `scope_key` (the bundle's
/// `...:state` key), with byte-size and TTL clamping.
pub struct KvCapability {
    client: redis::Client,
    max_value_bytes: usize,
    max_ttl_s: u64,
}

impl KvCapability {
    /// Builds a capability handler bound to one Valkey client and this
    /// deployment's `KV_MAX_VALUE_BYTES`/`KV_MAX_TTL_S` limits.
    pub fn new(client: redis::Client, max_value_bytes: usize, max_ttl_s: u64) -> Self {
        Self { client, max_value_bytes, max_ttl_s }
    }

    fn namespaced(key: &str) -> String {
        format!("b:{key}")
    }

    async fn conn(&self) -> Result<redis::aio::MultiplexedConnection, KvError> {
        self.client.get_multiplexed_tokio_connection().await.map_err(|e| KvError::Backend(e.to_string()))
    }

    /// Reads and TTL-filters one field; an expired-but-not-yet-evicted
    /// entry reads as absent.
    pub async fn get(&self, scope_key: &str, key: &str) -> Result<Option<Vec<u8>>, KvError> {
        let mut conn = self.conn().await?;
        let raw: Option<Vec<u8>> = redis::cmd("HGET")
            .arg(scope_key)
            .arg(Self::namespaced(key))
            .query_async(&mut conn)
            .await
            .map_err(|e| KvError::Backend(e.to_string()))?;
        let Some(raw) = raw else { return Ok(None) };
        let stored: StoredValue = serde_json::from_slice(&raw).map_err(|e| KvError::Backend(e.to_string()))?;
        if let Some(expires_at) = stored.expires_at {
            if expires_at <= now_secs() {
                return Ok(None);
            }
        }
        Ok(Some(stored.value))
    }

    /// Writes one field, clamping `ttl_seconds` to `max_ttl_s`; `0` means
    /// no expiry.
    pub async fn set(&self, scope_key: &str, key: &str, value: Vec<u8>, ttl_seconds: u32) -> Result<(), KvError> {
        if value.len() > self.max_value_bytes {
            return Err(KvError::TooLarge(value.len()));
        }
        let clamped_ttl = (ttl_seconds as u64).min(self.max_ttl_s);
        let expires_at = if clamped_ttl == 0 { None } else { Some(now_secs() + clamped_ttl) };
        let stored = StoredValue { value, expires_at };
        let encoded = serde_json::to_vec(&stored).map_err(|e| KvError::Backend(e.to_string()))?;
        let mut conn = self.conn().await?;
        let _: () = redis::cmd("HSET")
            .arg(scope_key)
            .arg(Self::namespaced(key))
            .arg(encoded)
            .query_async(&mut conn)
            .await
            .map_err(|e| KvError::Backend(e.to_string()))?;
        Ok(())
    }

    /// Deletes one field.
    pub async fn delete(&self, scope_key: &str, key: &str) -> Result<(), KvError> {
        let mut conn = self.conn().await?;
        let _: () = redis::cmd("HDEL")
            .arg(scope_key)
            .arg(Self::namespaced(key))
            .query_async(&mut conn)
            .await
            .map_err(|e| KvError::Backend(e.to_string()))?;
        Ok(())
    }

    /// Reads the field as a `s64` counter (defaulting to 0), adds `delta`,
    /// writes it back with the same TTL semantics as [`Self::set`], and
    /// returns the new value.
    pub async fn increment(&self, scope_key: &str, key: &str, delta: i64, ttl_seconds: u32) -> Result<i64, KvError> {
        let current = match self.get(scope_key, key).await? {
            Some(bytes) => String::from_utf8_lossy(&bytes).parse::<i64>().unwrap_or(0),
            None => 0,
        };
        let updated = current + delta;
        self.set(scope_key, key, updated.to_string().into_bytes(), ttl_seconds).await?;
        Ok(updated)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 4 passed; 0 failed` for `capabilities_kv` (requires Docker-in-Docker for `testcontainers` — the containerized toolchain image mounts the host Docker socket for this target; see Task 2's `Makefile` `DOCKER_RUN` recipe, which already bind-mounts nothing Docker-socket-specific — extend it for this one target only: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$(CURDIR)":/workspace ... test`. Add a `test-integration` Makefile target with that extra mount rather than changing `test`'s default mount set.)

- [ ] **Step 5: Add the `test-integration` Makefile target**

Append to `core/svc_action/Makefile`:

```makefile
# Targets requiring `testcontainers` (Docker-in-Docker) -- separate from
# `test` so a plain `make test` never needs the host Docker socket mounted.
test-integration: toolchain-build
	docker run --rm \
		-v "$(CURDIR)":/workspace \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v $(CARGO_CACHE_VOLUME):/usr/local/cargo/registry \
		-v $(TARGET_VOLUME):/workspace/target \
		-w /workspace \
		$(TOOLCHAIN_IMAGE) cargo test --locked -- --include-ignored
```

Mark every `testcontainers`-backed test function from this task onward with `#[ignore = "requires Docker-in-Docker; run via make test-integration"]` so `make test` (Task 2's default) stays fast and host-Docker-socket-free, and `make test-integration` is what CI's dedicated integration job (Task 31) runs.

- [ ] **Step 6: Commit**

Stage `core/svc_action/src/hostapi/capabilities/kv.rs core/svc_action/tests/capabilities_kv.rs core/svc_action/Makefile` and commit with message:

```
feat(svc-action): kv host capability over a bundle-scoped Valkey hash

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---
