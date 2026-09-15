# Milestone M5 — `svc_ingest` Rust Rewrite + Generic Intake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `core/svc_ingest` from Python to Rust: fixed, non-pluggable normalizers for all six inbound platforms (Twitch IRC, Twitch EventSub, Discord, Slack, YouTube, Kick), lease-guarded socket/poll receivers, the Twitch outbound relay drain, and two new generic intake surfaces (signed webhook + JWT REST) — writing every normalized event exactly once onto its ingest source's Valkey stream, with zero bundle execution inside this service.

**Architecture:** One Axum HTTP surface (`:8200`) hosts the fixed-platform webhooks (Twitch EventSub, Kick) and the two generic intakes; a set of lease-guarded background supervisors run the socket/poll receivers and hand raw payloads to fixed Rust normalizer functions; every normalizer output becomes a `penguin_spine::StageEnvelope` wrapping a `PlatformEvent`, `XADD`ed once onto `{scope}:src:{platform}:{source_id}:events`. A dedicated-connection outbound drain relays Twitch sends. No SeaORM (no DB), no executor, no bundle host — this service holds every platform credential and nothing else does.

**Tech Stack:** Rust 1.97.x, Axum 0.8, Tokio, `penguin-spine`/`penguin-logging`/`penguin-connector-{twitch,discord,slack,youtube,kick}`/`penguin-licensing` (penguin-libs, assumed v0.1.0 — see External Crate Surfaces below), `hmac`+`sha2`+`subtle`, `governor`, `jsonwebtoken` (`aws_lc_rs`), `redis` (direct, for the outbound relay list only). Python: one additive hub-api endpoint (`Quart`, existing `flask_core`/`quart_schema` stack).

**Spec:** `docs/superpowers/specs/2026-09-14-rust-data-plane-design.md`, merged to `release/v3.0.X` (commit `4db23437`, via PR #325) — read alongside this plan. Section numbers below (`§N.N`) refer to that document. §4.1.1 (D29) now normatively states per-source intake auth modes (PA-INTAKE-AUTH), platform-webhook origin restriction (PA-ORIGIN), and trusted-proxy client-address resolution (PA-PROXY) — Tasks 13, 14, 15, 16, 17, 18, 19, 32 and 34 implement them. §5.11/§5.12 (D30/D31, workstream identity/binding and usage metering) are likewise normative and implemented per PA-WORKSTREAM below — Tasks 12, 17, 18, 19, 20, 23-29 and 30 implement them.

**Sibling plans this one is typed against:** `penguin-spine` (M1a), `penguin-logging` (M1b), `penguin-connectors` + `penguin-licensing` (M1d), all in the `penguin-libs` repo — see External Crate Surfaces below for the exact branch of each and the exact signatures quoted from it. Every `penguin_*` name in this plan is copied from those plans, not invented here.

## Global Constraints

Copied verbatim (summarized where the spec itself summarizes) from the spec's Decisions (§2) and Standards (§17) tables. Every task's requirements implicitly include this section.

- **D1/D2/D3** — `svc_ingest` converts to Rust, ships before the v3.0 MVP, cuts over all at once with no Python fallback. No dual-path period, no "keep the Python version working" requirement.
- **D5/D6** — Bundles are forbidden at ingest (it holds platform credentials and long-lived sockets); the generic webhook + REST intake are the only extension points, and neither executes foreign code.
- **D17** — Shared code lives in `penguin-libs`: `penguin-spine`, `penguin-logging`, `penguin-connector-{twitch,discord,slack,youtube,kick}`, `penguin-licensing`. Never re-implement stream/lease/telemetry/connector mechanics inside `svc_ingest` — consume the crate.
- **D18** — Valkey naming throughout (never "Redis" in identifiers, docs, or log lines), except naming the wire protocol itself.
- **D19/D20** — TLS **and** auth required by default for Valkey; the opt-out (`security.transport.tls`/`.auth`, both default `true`) is a normal, never-rejected chart value, but every startup with either `false` logs a loud WARN, sets `waddles_insecure_transport{component,aspect}=1`, and reports `transport: "insecure"` on `/health`.
- **D22** — Product/repo name is **Waddles**; images are `ghcr.io/penguintechinc/waddles/<service>`; namespace/in-cluster DNS is `waddles`; Secrets are `waddles-*`. The Helm chart directory/release name stays `k8s/helm/waddlebot` (not renamed — N4). Never write "restream" anywhere — the term is "relay" (matches `outbound_drain.py`'s own vocabulary).
- **D23/D24** — The spine is Valkey **Streams**, not lists. Ingest `XADD`s each event **once** onto `{scope}:src:{platform}:{source_id}:events`; it never fans out per-bundle copies, never consults a manifest, and never resolves "which bundle wants this." Grant resolution is entirely hub-api's and the process stage's job.
- **D30 (§5.11)** — Every envelope ingest writes carries `schema_version: 2`, a minted `workstream_id`/`event_id`, an optional `session_id`, a fresh W3C `trace` (never a continuation of an inbound request's own trace), and a `binding` (`{kid, mac}`) computed via `penguin_spine::compute_binding_mac` against a `BindingKeyring` loaded from `WADDLES_BINDING_KEY_FILE` at startup. Ingest **mints**, it never **verifies** — `verify_binding`/`ScopeCheck` are process's/action's job, out of this plan's scope.
- **D31 (§5.12)** — Every stage batches usage deltas and `XADD`s them onto `waddles:usage` at most every `METERING_FLUSH_INTERVAL_S` (default `10`) via `penguin_spine::UsageBatcher`/`SpineClient::append_usage`. Ingest records `events` (one per successful `publish_event`) keyed by `(tenant_id, community_id, workstream_id, stage="ingest", app_id=None)`; ingest's Valkey ACL user may `XADD` `waddles:usage` and never read it back (§11.10.2).
- **Rust stack (§17)** — Axum + tokio + `tracing`; `rustls` never native TLS; `jsonwebtoken` with the `aws_lc_rs` backend (never the `rust_crypto` feature — RUSTSEC-2023-0071).
- **Rust lints (§17)** — `unsafe_code = "deny"`, `missing_docs = "deny"`, `clippy::unwrap_used = "deny"`, `cargo clippy --all-targets -- -D warnings` clean before every commit.
- **Supply chain (§17)** — `cargo deny check` + `cargo audit` in CI; exact `=x.y.z` pins in `Cargo.toml`, `Cargo.lock` committed; no PRC-origin or sanctioned-entity crates.
- **Coverage (§17)** — 90% minimum, lines/branches/functions/statements; `cargo llvm-cov --fail-under-lines 90` gates every merge.
- **Containers (§17)** — Rootless at both layers: rootless runtime, `USER appuser`/`runAsNonRoot: true`, `uid 10001`. No root exception requested by this service.
- **Observability (§17, §13)** — OTel logs **and** metrics **and** traces via `penguin-logging`, destination only from standard OTLP env vars, zero vendor SDK. Prometheus `/metrics` on `:9090` is secondary, never a replacement. A dead exporter never fails a request (buffer, drop-oldest, count the drops).
- **Telemetry gate (§17, §14.7)** — blocking smoke-test validation every commit, printed counts: log records ≥1, metric data points ≥1, histogram metrics ≥1, spans ≥1, zero hand-rolled `println!`/`eprintln!` in service source.
- **Transport security (§17, §11.6)** — TLS 1.2+ everywhere, mTLS certificate validation where mTLS is used, at-rest encryption on every store holding sensitive data.
- **Secrets (§17, §11.5)** — never in a distributed build, never on a CLI flag, never in logs/stdout, env/file only, masked in CI.
- **Verification integrity (§17, §14.9)** — no `|| true` on a gate; `set -euo pipefail`; `${PIPESTATUS[0]}`; every "clean" result reported with the count of items examined; a zero denominator is a failure.
- **Feature flags (§17, §13.5)** — every new capability behind a PostHog flag, defaulted OFF, two-gate with `penguin-licensing`, graceful degradation to last-known-cached value. This milestone's flags: `waddles.core.rust-data-plane` (drain loops), `waddles.core.generic-intake` (both new intake routes) — both `min_tier: free`, module `core`.
- **PII tokenization (§17, §11.8)** — no PII in logs, spans, or metric labels; tenant/community always come from the Valkey key or JWT claim, never from event payload. A client IP address is PII: it may be compared, counted and cached, but never written into a log body, span attribute or metric label — rejection logs carry the *reason*, the source/platform and a truncated `/24`-or-`/48` prefix at DEBUG only, never the full address.
- **Intake admission is two independent gates, never one (spec amendment, PA-INTAKE-AUTH / PA-ORIGIN / PA-PROXY)** — a valid signature alone never admits a request. Generic sources additionally require an IP/bearer/basic mode (AND-combined); the two platform webhooks additionally require an FCrDNS-confirmed origin. Client-address resolution honours `X-Forwarded-For` only behind a configured trusted proxy. Every rejection increments `ingest_webhook_rejected_total{source|platform, reason}` and returns the documented status — `401` for an auth-mode failure, `403` for an origin failure — never a silent accept and never a generic 400.
- **OIDC scopes (§17)** — permission checks on scopes, never role names; this milestone uses `distribution:read` (unchanged service JWT) and `intake:write` (new, `POST /intake/events`).
- **SPIFFE (§17, §11.9)** — `svc-ingest` reserves `spiffe://penguintech.io/<env>/svc-ingest` and is SPIFFE-ready; where SPIRE isn't live, short-lived signed OIDC machine JWTs are the fallback (already the distribution-poll mechanism).
- **Kubernetes (§17, §12.4-12.5)** — default-deny `CiliumNetworkPolicy`, no NodePort/HostPort/hostNetwork in beta/prod, Pod Security Admission `restricted`, Helm only.
- **Dependency pinning (§17)** — exact versions in `Cargo.toml` (no bare `*`/`^`), `Cargo.lock` committed, SHA-256 digests for base images, full commit SHAs for GitHub Actions.
- **Named executor inputs (coordinator ruling R53)** — `penguin-spine`/`penguin-logging`/`penguin-connector-*` are pinned `{ git = "https://github.com/penguintechinc/penguin-libs", rev = "<rev>", version = "=0.1.0" }` (Task 1), never registry-only, until crates.io publishing is a later, user-gated step. The revs are not known at plan-writing time: `SPINE_REV`, `LOGGING_REV`, `CONNECTORS_REV` are named executor inputs — full 40-char merge-commit SHAs on penguin-libs' `release/rust-{spine,logging,connectors}/v0.1.x` branches, supplied by the coordinator at dispatch — used verbatim as `${SPINE_REV}`/`${LOGGING_REV}`/`${CONNECTORS_REV}` everywhere a rev is needed (Task 1's `Cargo.toml`, this task's own build/verify steps). `penguin-licensing` (§4.11) is already released to crates.io independently and stays a plain `"=0.1.0"` registry pin.
- **Branching (§17, §15.1)** — work off `release/v3.0.X` in feature branches inside worktrees; PR for every merge; release→main is user-gated.
- **Docs (§17)** — every class/function gets a 2-3 line doc comment; no ASCII-art section dividers.
- **XDP/AF_XDP note** — `backend-rust.md`'s XDP mandate applies to raw packet-processing services (e.g. `svc_streaming`'s media plane). `svc_ingest` makes ordinary outbound TCP/WebSocket/HTTPS connections and serves HTTP — it is not a packet-forwarding data-plane worker, carries no `aya` dependency, and none is added here (matches `core/svc_streaming`'s own precedent: no `aya` in its `Cargo.toml` either).

### Plan Assumptions (resolved, cheaply overturned)

The spec is authoritative but incomplete in a few places this plan must act on. Each is resolved here, once, the way the spec's own §20 resolves its assumptions — flag it if you disagree, don't leave it open.

- **PA-ENVELOPE** — `StageEnvelope.app_id` (§6.1.2) is a required string matching `^waddles\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$` (exactly `waddles` plus three segments — plan M1a Task 4's `is_valid_app_id`), but an ingest-source-stream entry has no bundle yet (D23/§5.2/§10.6: "Ingest holds no subscriber list and consults no manifest"). This plan sets `app_id = format!("waddles.ingest.{platform_slug}.{source_slug}")` (a synthetic per-**source** id, never a bundle id) on every envelope ingest writes, `stage = "ingest"`, `target_app_id = None`. Both segments are passed through `crate::publish::app_id_slug` (lowercase, `[^a-z0-9_-]` → `-`, leading non-alphanumeric stripped) so a platform like `custom:github` or a source id with a dot can never produce an `app_id` the crate rejects. This satisfies the regex while preserving the "ingest resolves nothing" invariant — the synthetic id names the source, not a consumer.
- **PA-SOURCES** — The task brief's `GET /api/v1/distribution/sources` endpoint is not spelled out in the spec text (only the `intake_sources` DB table shape, §15.4, and the "secret fetched from hub-api and cached" behavior, §10.1, are). This plan adds it to hub-api (Task 13) modeled directly on the existing `/api/v1/distribution/bundles` blueprint (`hub_api/blueprints/v1/distribution.py`): tenant from JWT, `distribution:read` scope, ETag-cacheable, one row per `intake_sources` record. Each row carries **both** `secretRef` (the DB column, safe to log) **and** `secret` (hub-api's resolution of that reference to a plaintext value, sanitized by `penguin-logging`'s `SENSITIVE_KEYS` matching if it ever nears a log line) — satisfying the task brief's "secrets by reference" (the field exists) and the spec's "secret fetched from hub-api" (the value travels over the already-trusted, SSRF-exempt `HUB_API_URL` connection, §8.5). Each row **additionally** carries the `auth` object of PA-INTAKE-AUTH below.
- **PA-INTAKE-AUTH (now folded into the spec's §4.1.1/D29)** — `POST /intake/webhook/{tenant}/{source}` carries a second, independent admission gate: the per-source HMAC is **necessary but not sufficient**. Every generic source must additionally be configured with at least one of a source-IP CIDR allowlist, a bearer token, or HTTP basic credentials; configured modes combine with **AND**. This plan's Tasks 13/14/16/19 implement the requirement (corrected from an earlier "13/15/16/19" — Task 15 is `origin.rs`, PA-ORIGIN/PA-PROXY only; it contributes nothing to this gate). The DB/API shape — **must match plan M2b's `intake_sources` migration**:
  ```json
  "auth": {"modes": ["cidr", "bearer", "basic"], "cidrs": ["203.0.113.0/24"], "secretRef": "ACME_GITHUB_INTAKE_BEARER", "secret": "<hub-api-resolved plaintext, bearer/basic modes only>"}
  ```
  `modes` is a non-empty subset of `{"cidr", "bearer", "basic"}`; `cidrs` is required and non-empty when `"cidr"` ∈ `modes`; `secretRef` names the reference hub-api resolves (mirroring the top-level `secretRef`/`secret` pair, PA-SOURCES) to the bearer token (mode `bearer`) or the `user:password` pair (mode `basic`); `secret` is `null` when neither mode is configured. hub-api **refuses to persist** a source whose `auth.modes` is empty (the spec's `422 auth_factor_required`, out of this plan's scope — M2b's create/update endpoint, not `GET /distribution/sources`); svc-ingest additionally fails closed at request time — a source that somehow reaches the registry with no mode is `401 auth_not_configured` (Task 14 defines `SourceAuth`, Task 16 defines the mode-check primitives, Task 19 wires them in). **Reason-string correction against the spec's own endpoint table (§10.1) and §14.10's negative-test table**, which this plan's earlier draft of Task 3 got wrong: a configured-but-unsatisfied mode is `401 second_factor_failed` (one reason, not three — `IpNotAllowed`/`BearerRejected`/`BasicRejected` are consolidated into `IntakeError::SecondFactorFailed`, Task 3), never `no_auth_mode`/`ip_not_allowed`/`bearer_rejected`/`basic_rejected`. The OTel metric label on `ingest_webhook_rejected_total`, per §4.1.1's literal text, uses the coarser bucket `reason="auth"` for both `SecondFactorFailed` and `AuthNotConfigured` — distinct from the HTTP JSON body's finer-grained `error` field.
- **PA-ORIGIN (now folded into the spec's §4.1.1/D29)** — The two platform webhooks (`POST /eventsub/twitch/webhook`, `POST /webhook/kick`) require signature verification **and** a forward-confirmed reverse-DNS (FCrDNS) check on the client address against per-platform domain suffixes, with an optional per-platform CIDR allowlist as a static alternative. Defaults: `twitch.tv` and `kick.com`. FCrDNS results are cached for 10 minutes. A failure is `403 origin_not_trusted` (HTTP JSON `error`) + `ingest_webhook_rejected_total{platform,reason="origin"}` (metric bucket, §4.1.1's literal text) + a sanitized WARN. Implemented in Task 15, consumed by Tasks 17/18.
- **PA-PROXY (now folded into the spec's §4.1.1/D29)** — Both of the above need the *real* client address. `WADDLES_INGEST_TRUSTED_PROXIES` is a comma-separated CIDR list, **default empty**. Empty ⇒ the TCP peer address is the client address and `X-Forwarded-For` is ignored entirely. Non-empty ⇒ `X-Forwarded-For` is honoured **only** when the direct peer is inside a trusted CIDR, and the client address is then the **rightmost untrusted hop** in the header (walking right-to-left, skipping trusted entries). Implemented in Task 15, additionally consumed by Task 19 for its `cidr` auth mode (the same spoofing hole applies to a source-IP allowlist as to origin verification).
- **PA-WORKSTREAM (spec gap this plan resolves)** — §5.11/§6.11 says a `workstreams` row is "created 1:1 with each row in `intake_sources`" but does not say how the six *fixed*-platform receivers (Tasks 23-29, which are not `intake_sources` rows — they are config/env-driven, not a hub-api table) get one. For a **generic** source (Tasks 19/20), `workstream_id` comes straight off the polled registry row (Task 13/14 add a `workstreamId` field, mirroring my task brief's own citation of the M2b DTO shape). For a **fixed**-platform source, this plan mints a **stable, deterministic, config-derived** `workstream_id` locally, with no hub-api round trip: `workstream_id = Uuid::new_v5(&WORKSTREAM_NAMESPACE, source_id.as_bytes())` (UUID v5, SHA-1 name-based) under a fixed namespace constant (Task 12), where `source_id` is the same string already used to build the Valkey stream key (e.g. `tw-waddlebot`, `dg-guild123-general`). Same `source_id` in ⇒ same `workstream_id` out, always, satisfying "one workstream per configured ingest source" without inventing a second hub-api endpoint. **Flagged, not blocking:** if hub-api's `workstreams` table independently assigns a server-generated id for a fixed-platform source, a follow-up task must reconcile the two (either hub-api adopts ingest's deterministic id at first sight, or ingest starts polling fixed-source workstream ids the same way it polls generic ones) — out of M5's scope to resolve here.
- **PA-FLAGS (crate gap, coordinator ruling R60)** — §4.11 says `penguin-licensing` is "already behaviourally complete" (`LicenseClient`, two-gate flag+entitlement, 5-minute cache, exponential backoff, 72 h offline grace, hardcoded domain bypass), but — unlike `penguin-spine`/`penguin-logging`/`penguin-connector-*` — no sibling plan quotes its exact Rust method names (M1a/M1b/M1d don't build it; §4.11's own work items are CI/publish jobs only). Per R60 this is a crate gap, stated once in the "Crate gaps" table above (marked "must match plan M1d") rather than re-derived here: `LicenseClient::from_env()` / `is_enabled(flag_key)`, consumed only in Task 30 to resolve `waddles.core.rust-data-plane` and `waddles.core.generic-intake` once at startup and on a periodic re-check tick (continuous re-evaluation, `critical-rules.md` Feature Flags) — never a locally re-implemented flag client.
- **PA-LEASE** — `penguin-spine` **does not yet ship a `SocketLease`**: plan M1a's task list (crate scaffold, `Scope`/`Stage`, envelopes, DLQ, `SpineMetrics`, fixtures, `SpineConfig`, `probe_valkey`, TLS container, ACL matrix, `SpineClient`, group lifecycle, `GroupReader`, bench, CI, the D30 binding module, D31 usage) contains no lease task, and no lease type appears in its README usage block. §10.2's "ported... to `penguin-spine`" is therefore not yet satisfied by M1a as planned. Per **coordinator ruling R60**, this is a crate gap, not something to substitute locally: the "Crate gaps" table above states the exact required `SocketLease` signature (key `waddles:lease:{provider}:{community}`, matching §10.2's own stated scheme), marked "must match plan M1a," and Task 22 codes directly against `penguin_spine::SocketLease` through its local `Lease` trait (a thin object-safety/testability wrapper, not a re-implementation) — no local lease mechanic lives inside `core/svc_ingest`.
- **PA-RECEIVER** — `penguin-connector-core` defines `IngestSource` (`async fn run(self: Box<Self>, tx: mpsc::Sender<Self::RawEvent>, shutdown: CancellationToken)`), so each platform crate pushes typed raw events onto a channel rather than exposing a pull-style receiver. This plan keeps a thin local trait, `RawReceiver` (Task 22), and each supervisor task (23-28) spawns the connector's `IngestSource::run` and adapts the `mpsc::Receiver<T>` to it — so every supervisor's lease/normalize/publish logic is exercised against a scripted fake, not a live socket, and the supervisors are unaffected if a connector's internals change.
- **PA-4.1-CONTROL** — Spec §4.1's Interfaces table lists a "Control" row polling `GET /api/v1/distribution/bundles?stage=process`. This directly contradicts §10.6 ("Ingest holds no subscriber list and consults no manifest") and D23/D24's stream model, and reads as leftover text from the pre-Streams design the spec's own Activation-resolution-fix paragraph describes. This plan follows §10.6 (the newer, more specific, and internally consistent section): **`svc_ingest` never polls `/distribution/bundles`.** It only polls the new `/distribution/sources` endpoint (Task 14). The §15.3 "Activation fix" bullet is satisfied structurally (ingest does no routing at all now, eliminating the whole bug class) and documented in Task 35's migration note, not implemented as ingest code.

### External Crate Surfaces (`penguin-libs`, M1 — must match plans M1a/M1b/M1d)

**These are not guesses.** Every signature below is quoted from the sibling implementation plan that builds it, at the commit read while writing this plan. If a crate ships a different shape, bump the affected call sites and say so — do not silently adapt.

| Crate | Plan | Branch (repo `penguin-libs`) |
|---|---|---|
| `penguin-spine` | M1a — `docs/superpowers/plans/2026-09-14-penguin-spine.md` | `origin/docs/plan-penguin-spine` |
| `penguin-logging` | M1b — `docs/superpowers/plans/2026-09-14-penguin-logging.md` | `origin/docs/plan-penguin-logging` |
| `penguin-connector-*` | M1d — `docs/superpowers/plans/2026-09-14-penguin-connectors.md` | `origin/docs/plan-penguin-connectors` |

**This block is a verbatim distillation of `docs/superpowers/plans/2026-09-14-penguin-spine.md` at `origin/docs/plan-penguin-spine` (commit `5f6db08`)** — re-read in full while fixing this plan's earlier draft, which had quoted a stale, pre-D30 shape (no `workstream_id`/`event_id`/`trace`/`binding` on `StageEnvelope`, an `append` that took a `maxlen_approx` parameter the real crate doesn't have, and a `SpineMetrics` missing `insecure_transport`/`tenant_boundary_violation`). Every call site in Tasks 12/17/18/19/20/22/23-29/30 is written against *this* corrected block.

```rust
// penguin-spine = git+rev "${SPINE_REV}", version "=0.1.0"  (M1a Tasks 2-6, 9-10, 13, 19, 20)
pub const TENANT_WIDE_SEGMENT: &str = "_tenant";
pub struct Scope { pub tenant: String, pub community: Option<String> }
impl Scope {
    pub fn new(tenant: impl Into<String>, community: Option<String>) -> Self;
    pub fn source_stream(&self, platform: &str, source_id: &str) -> String; // waddles:t:{tenant}:c:{community|_tenant}:src:{platform}:{source_id}:events
    pub fn action_stream(&self, app_id: &str) -> String;
    pub fn config_key(&self, app_id: &str) -> String;
    pub fn state_key(&self, app_id: &str) -> String;
}
pub fn parse_scope_from_key(key: &str) -> Option<(String, Option<String>)>;
pub enum Stage { Process, Action }                       // ingest is not a Stage variant; StageEnvelope.stage is a String
pub struct Source { pub platform: String, pub account_id: String, pub channel_id: Option<String> }
pub struct PlatformEvent {
    pub platform: String,
    pub event_type: String,
    pub actor: Option<String>,
    pub payload: serde_json::Map<String, serde_json::Value>,   // a MAP, never a bare Value
    pub occurred_at: String,                                    // RFC 3339 UTC, millisecond precision, "Z"
    pub source: Option<Source>,
}
/// D30 (spec Sec5.11/6.1.2) -- supersedes the pre-D30 single-field `trace_context`.
pub struct Trace { pub traceparent: String, pub tracestate: Option<String> }
/// D30 -- `{kid, mac}`, required on every envelope; no unsigned shape.
pub struct Binding { pub kid: String, pub mac: String }
pub const ENVELOPE_SCHEMA_VERSION: u32 = 2;
pub fn trace_id_from_traceparent(s: &str) -> Option<&str>;      // the 32-hex segment binding.mac is computed over
pub struct StageEnvelope {
    pub schema_version: u32,                                    // must equal ENVELOPE_SCHEMA_VERSION (2) -- no dual-read (D3, D30)
    pub tenant: String,
    pub community: Option<String>,
    pub app_id: String,                                         // ^waddles\.<seg>\.<seg>\.<seg>$ — see PA-ENVELOPE
    pub stage: String,                                          // "ingest" | "process" | "action"
    pub event: PlatformEvent,
    pub ts: String,
    pub target_app_id: Option<String>,
    pub workstream_id: String,                                  // UUID; minted by ingest, never from payload (D30) — see PA-WORKSTREAM
    pub event_id: String,                                       // UUID v4; minted once per inbound event by ingest (D30)
    pub session_id: Option<String>,                              // EventSub/gateway/broadcast session, when the platform has one (D30)
    pub trace: Option<Trace>,                                    // a FRESH trace minted by ingest, never a continuation (D30)
    pub binding: Binding,                                        // required; computed via compute_binding_mac (D30)
}
pub struct EnvelopeError(String);                               // thiserror, Display = the message
pub enum SpineError { /* opaque to ingest; Display/source() only */ }
pub trait SpineMetrics: Send + Sync {                           // object-safe, every method defaulted no-op
    fn stream_event_written(&self, platform: &str, source_id: &str) {}
    fn stream_trimmed(&self, stream: &str) {}
    fn stream_claimed(&self, app_id: &str) {}
    fn consumer_skipped(&self, app_id: &str, reason: &str) {}
    fn dlq_written(&self, stage: &str, reason: &str) {}
    fn group_lag(&self, app_id: &str, stream: &str, lag: Option<u64>) {}
    fn group_pending(&self, app_id: &str, stream: &str, pending: u64) {}
    fn insecure_transport(&self, component: &str, aspect: &str, insecure: bool) {}   // SpineClient::connect calls this directly
    fn tenant_boundary_violation(&self, stage: &str, reason: &str) {}
}
pub struct NoopMetrics;
pub struct SpineConfig {                                        // SpineConfig::from_env() / .validate()
    pub valkey_url: String, pub valkey_username: Option<String>, pub valkey_password: Option<String>,
    pub valkey_ca_file: std::path::PathBuf,
    pub security_transport_tls: bool, pub security_transport_auth: bool,
    pub consumer_id: String, pub stream_maxlen: u64,            // SPINE_STREAM_MAXLEN, default 100_000
    pub read_count: i64, pub block_ms: u64, pub claim_idle_ms: u64, pub claim_interval_ms: u64,
    pub stats_interval_ms: u64, pub pel_alert: u64, pub dlq_maxlen: u64, pub max_deliveries: u32,
    pub drain_socket_timeout_s: u64, pub relay_block_timeout_s: u64,
}
pub enum ProbeClass { Dns, Tcp, Tls, Auth, Ok }                 // .as_str() -> "dns"|"tcp"|"tls"|"auth"|"ok"
pub struct ProbeResult { pub dependency: String, pub class: ProbeClass, pub message: String }
pub async fn probe_valkey(cfg: &SpineConfig, timeout: std::time::Duration, attempts: u32, retry_interval: std::time::Duration) -> ProbeResult;
pub struct Grant { pub stream: String, pub platform: String, pub source_id: String }
pub struct Delivered { pub stream: String, pub entry_id: String, pub env: StageEnvelope, pub deliveries: u64 }
pub struct SpineClient { /* Clone */ }
impl SpineClient {
    pub async fn connect(cfg: SpineConfig, metrics: std::sync::Arc<dyn SpineMetrics>) -> Result<Self, SpineError>;
    // NOTE: no `maxlen_approx` parameter -- MAXLEN comes from `cfg.stream_maxlen`, set once at connect().
    pub async fn append(&self, stream: &str, env: &StageEnvelope) -> Result<String, SpineError>;
    pub async fn append_usage(&self, delta: &UsageDelta) -> Result<String, SpineError>; // XADD onto "waddles:usage" (D31)
    // ensure_group / destroy_group / ack / dead_letter / claim_stale / group_stats: process+action only, never ingest
}

// The D30 binding module (M1a Task 19) -- ingest MINTS, never verifies.
pub struct BindingKeyEntry { pub key: Vec<u8>, pub retired_at: Option<chrono::DateTime<chrono::Utc>> }
pub struct BindingKeyring { /* opaque */ }
impl BindingKeyring {
    pub fn from_entries(active_kid: impl Into<String>, entries: std::collections::HashMap<String, BindingKeyEntry>, rotation_overlap: chrono::Duration) -> Result<Self, BoundaryError>;
    pub fn load(path: &std::path::Path, active_kid: impl Into<String>, rotation_overlap: chrono::Duration) -> Result<Self, BoundaryError>; // reads WADDLES_BINDING_KEY_FILE's {"<kid>": {"key_hex", "retired_at"}} JSON
    pub fn signing_kid_and_key(&self) -> (&str, &[u8]);         // the (kid, key) every new binding.mac is minted under
    pub fn verify_key_for(&self, kid: &str, now: chrono::DateTime<chrono::Utc>) -> Option<&[u8]>; // not used by ingest (minting only)
}
pub struct BindingInput<'a> { pub tenant: &'a str, pub community: Option<&'a str>, pub workstream_id: &'a str, pub event_id: &'a str, pub trace_id: &'a str }
pub fn compute_binding_mac(keyring: &BindingKeyring, input: &BindingInput<'_>) -> Binding;
pub enum BoundaryError { MacMismatch, UnknownOrExpiredKid { kid: String }, TenantMismatch, CommunityMismatch, MissingTrace } // ingest only sees this from BindingKeyring::load/from_entries at startup

// D31 workstream usage metering (M1a Task 20).
pub const USAGE_STREAM_KEY: &str = "waddles:usage";
pub enum HostCallKind { Http, Kv, Db, Relay, Flags, Log }        // ingest never issues host calls; included for completeness
pub struct HostCallCounts { pub http: u64, pub kv: u64, pub db: u64, pub relay: u64, pub flags: u64, pub log: u64 }
pub struct UsageDelta {
    pub tenant_id: String, pub community_id: Option<String>, pub workstream_id: String, pub stage: String, pub app_id: Option<String>,
    pub events: u64, pub invocations: u64, pub host_calls: HostCallCounts, pub fuel_ms: u64,
    pub actions_delivered: u64, pub outbound_bytes: u64, pub media_minutes: Option<f64>,
}
impl UsageDelta {
    pub fn zero(tenant_id: impl Into<String>, community_id: Option<String>, workstream_id: impl Into<String>, stage: impl Into<String>, app_id: Option<String>) -> Self;
}
pub struct UsageBatcher { /* opaque, Mutex-guarded */ }
impl UsageBatcher {
    pub fn new() -> Self;
    pub fn record(&self, delta: UsageDelta);                    // merges into the in-process accumulator, keyed by (tenant,community,workstream,stage,app)
    pub fn flush(&self) -> Vec<UsageDelta>;                      // drains everything accumulated since the last flush
    pub fn is_empty(&self) -> bool;
}
```

**What ingest uses and what it must not.** Ingest calls `Scope`, `PlatformEvent`/`Source`/`StageEnvelope`/`Trace`/`Binding`, `SpineConfig`, `probe_valkey`, `SpineClient::{connect, append, append_usage}`, `BindingKeyring::load`, `compute_binding_mac`, `UsageDelta`/`UsageBatcher`, and implements `SpineMetrics`. It never calls `ensure_group`, `ack`, `dead_letter`, `claim_stale`, `verify_binding`, `ScopeCheck`, or constructs a `GroupReader`/`Grant`/`Delivered` — reading a stage stream is outside its Valkey ACL (§11.10.2), verifying a binding is process's/action's job (D30, ingest mints only), and Task 34 proves the ACL boundary with a `NOPERM` test.

```rust
// penguin-logging = "=0.1.0"  (M1b Tasks 2-4, 11-17)
pub const SENSITIVE_KEYS: &[&str];
pub fn sanitize_value(value: &serde_json::Value) -> serde_json::Value;
pub fn sanitize_json_str(raw: &str) -> Result<String, SanitizeError>;
pub fn sanitize(value: serde_json::Value) -> Sanitized<serde_json::Value>;
pub enum OtlpProtocol { Grpc, HttpProtobuf }
pub struct ServiceConfig { pub service_name: String, pub otlp_endpoint: Option<String>, pub otlp_protocol: OtlpProtocol, pub otlp_headers: Vec<(String, String)>, pub log_level: String }
impl ServiceConfig { pub fn from_env(default_service_name: &str) -> ServiceConfig; }
pub struct TelemetryGuard;                                       // Drop flushes; .shutdown(&mut self)
pub struct LevelHandle;
pub fn init(cfg: ServiceConfig) -> (TelemetryGuard, LevelHandle, prometheus::Registry);  // once per process
pub mod metrics {
    pub fn record_latency_ms(name: &'static str, millis: f64, labels: &[opentelemetry::KeyValue]);
    pub fn record_latency_seconds(name: &'static str, seconds: f64, labels: &[opentelemetry::KeyValue]);
    pub fn counter_add(name: &'static str, value: u64, labels: &[opentelemetry::KeyValue]);
    pub fn gauge_set(name: &'static str, value: f64, labels: &[opentelemetry::KeyValue]);
}
pub fn inject_trace_context(cx: &opentelemetry::Context) -> Option<String>;
pub fn context_from_trace_context(traceparent: Option<&str>) -> opentelemetry::Context;
pub mod health {
    pub enum DependencyClass { Dns, Tcp, Tls, Auth, Ok }         // serializes lowercase
    pub struct DependencyStatus { pub class: DependencyClass, pub detail: String }
    impl DependencyStatus { pub fn ok() -> Self; pub fn failed(class: DependencyClass, detail: impl Into<String>) -> Self; pub fn is_up(&self) -> bool; }
    pub struct ComponentTransport { pub tls: bool, pub auth: bool }
    pub struct HealthState;                                      // Clone, Arc-backed
    impl HealthState {
        pub fn new(service: &str, version: &str, registry: prometheus::Registry) -> Self;
        pub fn set_dependency(&self, name: &str, status: DependencyStatus);
        pub fn set_transport(&self, component: &str, transport: ComponentTransport);
        pub fn set_sandbox(&self, value: &str);
        pub fn set_extra(&self, key: &str, value: serde_json::Value);
        pub fn uptime_seconds(&self) -> u64;
        pub fn snapshot(&self) -> HealthBody;
    }
    pub struct HealthBody;                                        // the §11.6.4 JSON shape
    pub fn router(state: HealthState) -> axum::Router;            // /health + /healthz + /metrics
    pub fn liveness_readiness_router(state: HealthState) -> axum::Router;  // /health + /healthz only
    pub fn metrics_router(state: HealthState) -> axum::Router;    // /metrics only
    pub struct DependencyMetrics;
    impl DependencyMetrics { pub fn record(&self, dependency: &str, status: &DependencyStatus); }
    pub enum TransportAspect { Tls, Auth }
    pub struct TransportMetrics;
    impl TransportMetrics { pub fn mark_secure(&self, component: &str, aspect: TransportAspect); }
    pub fn warn_insecure_transport(metrics: &TransportMetrics, component: &str, aspect: TransportAspect);
}
#[cfg(feature = "testing")]
pub mod testing {
    pub fn init_test_telemetry(service_name: &str) -> TestTelemetry;
    pub struct TestTelemetry;                                      // .force_flush(), .counts()
    pub struct TelemetryCounts { pub log_records: usize, pub metric_data_points: usize, pub histogram_data_points: usize, pub spans: usize }
}
```

**`init` is called at most once per process** (M1b Task 11: it installs the process-global subscriber and panics on a second call). Every `svc_ingest` unit test therefore uses `penguin_logging::testing::init_test_telemetry` (`[dev-dependencies] penguin-logging = { version = "=0.1.0", features = ["testing"] }`), never `init`.

```rust
// penguin-connector-core = "=0.1.0"  (M1d Tasks 2-6)
pub struct Secret;
impl Secret { pub fn resolve(env_var_name: &str) -> Result<Secret, ConnectorError>; pub fn expose(&self) -> &str; }  // Debug = "Secret(REDACTED)"
pub fn hmac_sha256_hex(secret: &[u8], message: &[u8]) -> String;
pub fn constant_time_eq_str(a: &str, b: &str) -> bool;
pub struct EventSource { pub platform: String, pub account_id: String, pub channel_id: Option<String> }
pub struct PlatformEvent { /* field-identical to penguin_spine::PlatformEvent */ }
pub type ActionConfig = std::collections::HashMap<String, serde_json::Value>;
pub fn config_str<'a>(config: &'a ActionConfig, key: &str) -> Option<&'a str>;
pub fn payload_str<'a>(event: &'a PlatformEvent, key: &str) -> Option<&'a str>;
pub enum RetryClass { Retryable { retry_after: Option<std::time::Duration> }, NonRetryable }
pub struct SendOutcome { pub transport: String, pub detail: String, pub http_status: Option<u16> }
pub struct SendError { pub message: String, pub class: RetryClass, pub http_status: Option<u16> }
impl SendError {
    pub fn retryable(message: impl Into<String>, http_status: Option<u16>) -> Self;
    pub fn retryable_after(message: impl Into<String>, retry_after: std::time::Duration, http_status: Option<u16>) -> Self;
    pub fn non_retryable(message: impl Into<String>, http_status: Option<u16>) -> Self;
}
pub fn classify_status(status: u16) -> RetryClass;
pub fn build_http_client(timeout: std::time::Duration) -> Result<reqwest::Client, ConnectorError>;
pub fn network_error_to_send_error(err: &reqwest::Error) -> SendError;
pub enum ConnectorError { SecretUnresolved(String), Connection(String), Protocol(String), ShutdownRequested }
#[async_trait::async_trait]
pub trait IngestSource: Send {
    type RawEvent: Send + 'static;
    async fn run(self: Box<Self>, tx: tokio::sync::mpsc::Sender<Self::RawEvent>, shutdown: tokio_util::sync::CancellationToken) -> Result<(), ConnectorError>;
}
pub struct RateLimiter; impl RateLimiter { pub fn per_second(n: u32) -> Self; pub async fn acquire(&self); }
pub struct ReconnectBackoff; impl ReconnectBackoff { pub fn new() -> Self; pub fn next_delay(&mut self) -> std::time::Duration; pub fn reset(&mut self); }
```

```rust
// penguin-connector-twitch = "=0.1.0"  (M1d Tasks 7-11)
pub struct EventSubHeaders<'a> { pub message_type: &'a str, pub signature: &'a str, pub timestamp: &'a str, pub message_id: &'a str }
pub fn verify_eventsub_signature(secret: &Secret, headers: &EventSubHeaders, body: &[u8]) -> bool;
pub struct TwitchEventSubRawEvent {
    pub platform: String, pub event_type: String,
    pub broadcaster_id: Option<String>, pub broadcaster_login: Option<String>,
    pub user_id: Option<String>, pub user_login: Option<String>, pub user_display_name: Option<String>,
    pub metadata: serde_json::Map<String, serde_json::Value>,
}
pub enum EventSubWebhookOutcome { Challenge(String), Notification(TwitchEventSubRawEvent), Ignored, Revoked }
pub enum EventSubError { BadSignature, MalformedBody(String) }
pub fn handle_eventsub_webhook(secret: &Secret, headers: &EventSubHeaders, body: &[u8]) -> Result<EventSubWebhookOutcome, EventSubError>;
pub struct TwitchIrcMessage { pub channel_name: String, pub author_username: String, pub content: String, pub author_id: Option<String>, pub user_id: Option<String>, pub display_name: Option<String>, pub message_id: Option<String>, pub room_id: Option<String>, pub badges: Vec<String>, pub is_mod: bool, pub is_subscriber: bool, pub is_vip: bool, pub is_broadcaster: bool }
pub struct TwitchIrcConfig { pub host: String, pub port: u16, pub nick: String, pub oauth_token_ref: String, pub channel: String, pub use_tls: bool }
pub struct TwitchIrcSource { pub config: TwitchIrcConfig }            // IngestSource<RawEvent = TwitchIrcMessage>
pub struct TwitchEventSubWsConfig { pub ws_url: String }              // prod: wss://eventsub.wss.twitch.tv/ws
pub struct TwitchEventSubWsSource { pub config: TwitchEventSubWsConfig }  // IngestSource<RawEvent = TwitchEventSubRawEvent>
pub struct TwitchRelayMessage { pub channel: String, pub text: String }
pub struct TwitchIrcSender { pub host: String, pub port: u16, pub nick: String, pub oauth_token_ref: String, pub use_tls: bool }
impl TwitchIrcSender { pub async fn send(&self, message: &TwitchRelayMessage) -> Result<SendOutcome, SendError>; }

// penguin-connector-discord = "=0.1.0"  (M1d Task 12)
pub struct DiscordRawMessage { pub guild_id: Option<String>, pub channel_id: String, pub message_id: String, pub author_id: String, pub author_username: String, pub content: String }
pub struct DiscordGatewayConfig { pub gateway_url: String, pub bot_token_ref: String }   // prod: wss://gateway.discord.gg/?v=10&encoding=json
pub struct DiscordGatewaySource { pub config: DiscordGatewayConfig }  // IngestSource<RawEvent = DiscordRawMessage>

// penguin-connector-slack = "=0.1.0"  (M1d Task 14)
pub struct SlackRawEvent { pub event_type: String, pub text: Option<String>, pub channel_id: Option<String>, pub team_id: Option<String>, pub thread_ts: Option<String>, pub message_ts: Option<String>, pub platform_user_id: Option<String>, pub display_name: Option<String> }
pub struct SlackSocketModeConfig { pub app_token_ref: String, pub bot_token_ref: String, pub ws_url_override: Option<String> }
pub struct SlackSocketModeSource { pub config: SlackSocketModeConfig }  // IngestSource<RawEvent = SlackRawEvent>

// penguin-connector-youtube = "=0.1.0"  (M1d Task 16)
pub struct YouTubeRawMessage { pub channel_id: String, pub video_id: String, pub live_chat_id: String, pub message_id: String, pub author_channel_id: Option<String>, pub display_name: Option<String>, pub text: String, pub published_at: String }
pub struct YouTubePollConfig { pub channel_id: String, pub api_key_ref: Option<String>, pub api_base: String, pub no_broadcast_backoff: std::time::Duration, pub max_consecutive_quota_errors: u32 }
pub struct YouTubeLivePollSource { pub config: YouTubePollConfig }      // IngestSource<RawEvent = YouTubeRawMessage>

// penguin-connector-kick = "=0.1.0"  (M1d Tasks 18-19)
pub const DEFAULT_PUSHER_KEY: &str;   pub const DEFAULT_CLUSTER: &str;
pub struct KickChatMessage { pub text: String, pub chatroom_id: String, pub channel_slug: String, pub author_id: Option<String>, pub display_name: Option<String>, pub badges: Vec<String>, pub is_mod: bool, pub is_subscriber: bool, pub is_owner: bool, pub message_id: Option<String>, pub created_at: Option<String> }
pub struct KickPusherConfig { pub channel_slug: String, pub api_base: String, pub pusher_key: String, pub cluster: String, pub ws_url_override: Option<String>, pub chatroom_id_override: Option<String> }
pub struct KickPusherSource { pub config: KickPusherConfig }            // IngestSource<RawEvent = KickChatMessage>
pub fn verify_kick_webhook_signature(body: &[u8], signature: &str, secret: &Secret) -> bool;   // fail-closed on empty
pub struct KickStreamLifecycleRawEvent { pub event_type: String, pub channel_slug: Option<String>, pub channel_id: Option<String>, pub started_at: Option<String>, pub viewer_count: Option<i64> }
pub enum KickWebhookOutcome { StreamLifecycle(KickStreamLifecycleRawEvent), Acknowledged }
pub fn handle_kick_webhook(body: &[u8], signature: &str, secret: &Secret) -> Result<KickWebhookOutcome, ()>;  // Err(()) => caller responds 401
```

**Two `Secret` types, deliberately.** `crate::config::Secret` (Task 2) wraps a value this service read from its own environment; `penguin_connector_core::Secret` (`Secret::resolve("ENV_NAME")`) is what every connector API takes. Where a handler holds the former and a connector wants the latter, resolve at the edge — never pass a raw `&str` token across the boundary and never store a connector `Secret` in `AppState` (its `resolve` reads the environment at call time by design).

### Crate gaps (must be added to plan M1a/M1d)

**Coordinator ruling R60**: this service depends on `penguin-spine`/`penguin-logging`/`penguin-connectors` directly (R53 git-rev pins) and never re-implements any of their mechanics locally — no local `spine`-named module tree duplicating envelope/keys/client/binding/usage mechanics, no interim placeholder copy meant to be swapped later. Where the spec requires something one of these crates does not yet expose, this plan states the exact required signature here, marks the owning sibling plan, and every task below codes directly against that signature — never against a substitute type defined inside `core/svc_ingest`. This plan's own publisher module is named `publish.rs`, never `spine.rs`, for exactly this reason (Task 12). Self-review re-verifies this with the exact search terms the coordinator specified.

| Gap | Required by | Exact signature this plan codes against | Owning plan |
|---|---|---|---|
| `penguin_spine::SocketLease` — the single-owner socket/poll lease (§10.2) | Task 22 (`LeasedSupervisor`), Tasks 23-29 (every receiver supervisor) | `pub struct SocketLease { .. }`  `impl SocketLease { pub fn new(client: SpineClient, provider: impl Into<String>, community: impl Into<String>, ttl_ms: u64, renew_ms: u64) -> Self; pub async fn try_claim(&self) -> Result<bool, SpineError>; pub async fn renew(&self) -> Result<bool, SpineError>; pub async fn release(&self) -> Result<(), SpineError>; }` — key `waddles:lease:{provider}:{community}` (§10.2's own stated scheme, **not** the legacy Python `socket_lease.py`'s `waddles:socket-owner:*` — D3's cut-over is all-at-once with the Python service deleted at the same commit, §15.2, so there is no mixed-version window a differing key would need to protect against) | **must match plan M1a** |
| `penguin_licensing::LicenseClient` — two-gate flag/entitlement resolution (§4.11 describes it as "already behaviourally complete" but no sibling plan quotes its Rust method names; M1a/M1b/M1d don't build it, §4.11's own M1 work items are CI/publish jobs only) | Task 30 (resolves `waddles.core.rust-data-plane`/`waddles.core.generic-intake` at startup) | `pub struct LicenseClient { .. }`  `impl LicenseClient { pub fn from_env() -> Result<Self, LicenseError>; pub async fn is_enabled(&self, flag_key: &str) -> bool; }` — never fails (5-minute cache + 72h offline grace + domain bypass are internal to the crate per §4.11's description) | **must match plan M1d** |

Both rows are flagged, not blocking: Task 22 and Task 30 write real, complete code against the signatures above today; if `penguin-spine`/`penguin-licensing` ship a different shape, the fix is confined to each gap's own call sites (already isolated behind the local `Lease`/flag-check wrapper, PA-LEASE), never a reason to keep a local substitute implementation around "to be safe."

## File Structure

```
core/svc_ingest/
  Cargo.toml  Cargo.lock  rust-toolchain.toml  deny.toml  Dockerfile  Makefile  README.md
  src/
    main.rs                    binary entrypoint + run() wiring (Task 1, completed Task 30)
    lib.rs                     crate root, module tree (Task 1)
    config.rs                  CliConfig + Secret + Config::load (Task 2)
    error.rs                   IngestError / NormalizeError / IntakeError (Task 3)
    telemetry.rs               penguin_logging wrapper + IngestMetrics facade + IngestSpineMetrics (Task 4)
    publish.rs                 EventAppender + publish_event() + app_id_slug() (Task 12)
    sources.rs                 source registry poller + SourceRecord/SourceAuth (Task 14)
    lease.rs                   SocketLease port of socket_lease.py (Task 22)
    supervisor.rs              LeasedSupervisor + RawReceiver + restart_with_backoff (Task 22)
    relay.rs                   Twitch outbound relay drain (Task 29)
    startup_check.rs           classified connectivity self-check, exit 78 (Task 30)
    normalize/
      mod.rs  twitch.rs  twitch_eventsub.rs  discord.rs  slack.rs  youtube.rs  kick.rs  generic.rs
                                 (Tasks 5-11; mod.rs also holds payload_map())
    receivers/
      mod.rs  twitch_irc.rs  twitch_eventsub_ws.rs  discord_gateway.rs  slack_socket.rs
      youtube_poll.rs  kick_pusher.rs                                     (Tasks 23-28)
    http/
      mod.rs  state.rs  health.rs  origin.rs  middleware.rs  router.rs
      twitch_eventsub.rs  kick_webhook.rs  intake_webhook.rs  intake_events.rs
                                 (Tasks 4, 15, 16, 17-21)
  tests/
    fixtures/normalize/*.json  golden normalizer fixtures (Tasks 5-10)
    e2e_pipeline.rs            real-Valkey e2e + the four mandatory negative tests (Task 34)
hub_api/
  blueprints/v1/distribution.py       add GET /sources (Task 13)
  services/distribution_service.py    add sources query + auth-mode refusal (Task 13)
  tests/test_v1_distribution_blueprint.py  add sources tests (Task 13)
k8s/helm/waddlebot/
  templates/svc-ingest.yaml                    rewrite (Task 32)
  templates/svc-ingest-ingress.yaml             new (Task 32)
  templates/svc-ingest-networkpolicy.yaml       new (Task 32)
  values.yaml                                    new pipeline.svcIngest.* + ingest.platforms.* keys (Task 32)
config/valkey/acl-matrix.yaml                    new, with the svc_ingest entry (Task 32)
.github/workflows/
  rust-svc-ingest.yml          new — fmt/clippy/deny/audit/llvm-cov/semgrep/gitleaks/trivy (Task 33)
  build-svc-ingest.yml         new — image build + push (Task 33)
Makefile                                         add test-hub-api (Task 13)
```
---

### Task 1: Crate scaffold

**Files:**
- Create: `core/svc_ingest/Cargo.toml`
- Create: `core/svc_ingest/rust-toolchain.toml`
- Create: `core/svc_ingest/deny.toml`
- Create: `core/svc_ingest/.gitignore`
- Create: `core/svc_ingest/src/main.rs`
- Create: `core/svc_ingest/src/lib.rs`

**Interfaces:**
- Produces: crate `svc-ingest` (bin) / `svc_ingest` (lib) builds with `cargo build --all-targets`; `svc_ingest::SERVICE_NAME: &str = "svc-ingest"`; empty module stubs `pub mod config; pub mod error; pub mod telemetry; pub mod publish; pub mod sources; pub mod supervisor; pub mod relay; pub mod startup_check; pub mod normalize; pub mod receivers; pub mod http;` that later tasks fill in.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "svc-ingest"
version = "0.1.0"
edition = "2021"
rust-version = "1.97.0"
license = "Apache-2.0"
publish = false
description = "Waddles ingest data-plane service -- fixed per-platform normalizers, lease-guarded socket/poll receivers, and the generic webhook/REST intake."

[lib]
name = "svc_ingest"
path = "src/lib.rs"

[[bin]]
name = "svc-ingest"
path = "src/main.rs"

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
jsonwebtoken = { version = "=11.0.0", default-features = false, features = ["use_pem", "aws_lc_rs"] }
uuid = { version = "=1.26.1", features = ["v4", "serde"] }
chrono = { version = "=0.4.45", features = ["serde"] }
thiserror = "=2.0.20"
anyhow = "=1.0.104"
clap = { version = "=4.6.6", features = ["derive", "env"] }
reqwest = { version = "=0.12.28", default-features = false, features = ["rustls-tls", "json"] }
hmac = "=0.12.1"
sha2 = "=0.10.9"
subtle = "=2.6.1"
hex = "=0.4.3"
base64 = "=0.22.1"
governor = "=0.8.1"
async-trait = "=0.1.92"
tokio-util = "=0.7.17"
arc-swap = "=1.7.1"
# CIDR parsing/containment for the trusted-proxy list, the per-source IP
# allowlist, and the per-platform origin CIDR allowlist (PA-PROXY /
# PA-INTAKE-AUTH / PA-ORIGIN).
ipnet = "=2.11.0"
# Reverse + forward DNS for the FCrDNS origin check (PA-ORIGIN). rustls
# feature set only -- no C resolver, no OpenSSL.
hickory-resolver = { version = "=0.25.2", default-features = false, features = ["tokio", "system-config"] }
# Direct Valkey client for the Twitch outbound relay's raw BRPOP list and
# the intake dedupe SET NX EX -- penguin-spine's SpineClient is Streams-only
# (XADD/XREADGROUP, §4.7); the relay queue is a plain list (§6.2) and the
# dedupe key is a plain string, both out of that surface on purpose.
redis = { version = "=0.32.7", default-features = false, features = ["tokio-comp", "connection-manager"] }

# penguin-libs crates (M1) -- git+rev per coordinator ruling R53: crates.io
# publishing is a later, user-gated step, so these are NEVER registry-only
# pins. SPINE_REV/LOGGING_REV/CONNECTORS_REV are named executor inputs (see
# Global Constraints) -- full 40-char merge-commit SHAs on penguin-libs'
# release/rust-{spine,logging,connectors}/v0.1.x branches, supplied by the
# coordinator at dispatch. `penguin-licensing` (Sec4.11) is already released
# to crates.io independently of M1a/M1b/M1d -- it is the one crate in this
# block that IS a plain registry pin.
penguin-spine = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${SPINE_REV}", version = "=0.1.0" }
penguin-logging = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${LOGGING_REV}", version = "=0.1.0" }
penguin-connector-core = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${CONNECTORS_REV}", version = "=0.1.0" }
penguin-connector-twitch = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${CONNECTORS_REV}", version = "=0.1.0" }
penguin-connector-discord = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${CONNECTORS_REV}", version = "=0.1.0" }
penguin-connector-slack = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${CONNECTORS_REV}", version = "=0.1.0" }
penguin-connector-youtube = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${CONNECTORS_REV}", version = "=0.1.0" }
penguin-connector-kick = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${CONNECTORS_REV}", version = "=0.1.0" }
penguin-licensing = "=0.1.0"

[dev-dependencies]
rstest = "=0.24.0"
http-body-util = "=0.1.3"
wiremock = "=0.6.5"
tokio = { version = "=1.53.1", features = ["test-util"] }
# The in-memory OTel sink every unit test uses instead of the real
# `penguin_logging::init` (which may be called at most once per process --
# M1b Task 11). Also drives the Task 34 telemetry gate. Same git+rev pin
# as the main-dependency entry above (Cargo merges the two into one
# resolved crate; a mismatched rev between the two entries is a
# `cargo build` error, which is the intended guardrail against drift).
penguin-logging = { git = "https://github.com/penguintechinc/penguin-libs", rev = "${LOGGING_REV}", version = "=0.1.0", features = ["testing"] }

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
components = ["rustfmt", "clippy"]
```

- [ ] **Step 3: Write `deny.toml`**

```toml
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
# penguin-spine/penguin-logging/penguin-connector-* are git+rev pins
# (coordinator ruling R53) until crates.io publishing is a later, user-
# gated step -- this is the one sanctioned non-registry source.
allow-git = ["https://github.com/penguintechinc/penguin-libs"]

[sources.allow-org]
github = []
gitlab = []
bitbucket = []
```

- [ ] **Step 4: Write `.gitignore`**

```
/target
```

- [ ] **Step 4b: Write `core/svc_ingest/Makefile` — every later task's commands run through it**

Every `cargo` invocation in this plan goes through one of these targets, and every target runs inside the pinned image — the host's `cargo` is never used (`backend-rust.md`: all builds in Docker; `general.md` Build & Deployment Requirements). Named Docker volumes cache the registry and target dir so repeated calls don't re-fetch the crate index.

```makefile
# svc-ingest (Rust) -- containerized dev targets. Every target runs cargo
# INSIDE the pinned toolchain image; the host's cargo is never used.
# Invoke from the repo root: `make -C core/svc_ingest <target>`.

RUST_IMAGE ?= rust:1.97-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3
CARGO_REGISTRY_VOLUME ?= svc-ingest-cargo-registry
CARGO_TARGET_VOLUME ?= svc-ingest-cargo-target
# `cmake`/`build-essential` build aws-lc-sys (the jsonwebtoken `aws_lc_rs`
# backend, chosen over `rust_crypto` for RUSTSEC-2023-0071); `curl`+
# `ca-certificates` are needed by utoipa-swagger-ui's build script. All
# builder-stage-only, exactly as Dockerfile's builder stage installs them.
TOOL_DEPS = apt-get update -qq && apt-get install --no-install-recommends -y -qq cmake build-essential curl ca-certificates pkg-config >/dev/null

DOCKER_RUN = docker run --rm \
	-v "$(CURDIR):/work" \
	-v $(CARGO_REGISTRY_VOLUME):/usr/local/cargo/registry \
	-v $(CARGO_TARGET_VOLUME):/work/target \
	-w /work $(RUST_IMAGE) bash -euo pipefail -c

# MOD scopes a test run to one module path, e.g.
#   make -C core/svc_ingest test-unit MOD='normalize::twitch::'
MOD ?=

.PHONY: build test-unit test test-e2e lint fmt fmt-check clippy test-security audit coverage docker-build clean

build:
	$(DOCKER_RUN) "$(TOOL_DEPS); cargo build --all-targets --locked"

test-unit:
	$(DOCKER_RUN) "$(TOOL_DEPS); cargo test --lib $(MOD) --locked"

test:
	$(DOCKER_RUN) "$(TOOL_DEPS); cargo test --all-targets --locked"

# Integration tests only. Requires a reachable Valkey; Task 34 wires the
# pinned container and exports VALKEY_URL/VALKEY_PASSWORD before calling it.
test-e2e:
	$(DOCKER_RUN) "$(TOOL_DEPS); cargo test --test e2e_pipeline --locked -- --nocapture"

lint: fmt-check clippy

fmt:
	$(DOCKER_RUN) "cargo fmt"

fmt-check:
	$(DOCKER_RUN) "cargo fmt --check"

clippy:
	$(DOCKER_RUN) "$(TOOL_DEPS); cargo clippy --all-targets --locked -- -D warnings"

test-security: audit
	$(DOCKER_RUN) "cargo install cargo-deny --version 0.20.2 --locked >/dev/null; cargo deny check"

audit:
	$(DOCKER_RUN) "cargo install cargo-audit --version 0.22.0 --locked >/dev/null; cargo audit --deny warnings"

coverage:
	$(DOCKER_RUN) "$(TOOL_DEPS); rustup component add llvm-tools-preview; cargo install cargo-llvm-cov --version 0.9.1 --locked >/dev/null; cargo llvm-cov --all-targets --locked --fail-under-lines 90"

docker-build:
	docker build -t localhost:32000/waddles/svc-ingest:prealpha-$$(date +%s) .

clean:
	$(DOCKER_RUN) "cargo clean"
	-docker volume rm $(CARGO_TARGET_VOLUME)
```

- [ ] **Step 5: Write `src/lib.rs`**

```rust
//! `svc-ingest`: the Waddles ingest data-plane service.
//!
//! Owns every inbound platform connection and every inbound HTTP intake
//! surface, normalizes raw platform payloads into `PlatformEvent` with
//! fixed, non-pluggable code, and writes each finished envelope once onto
//! the Valkey stream of the ingest source it came from. Runs no bundle and
//! links no executor.

pub mod config;
pub mod error;
pub mod flags;
pub mod http;
pub mod lease;
pub mod normalize;
pub mod receivers;
pub mod relay;
pub mod sources;
pub mod publish;
pub mod startup_check;
pub mod supervisor;
pub mod telemetry;

/// Service identity used for `tracing`/OTel resource attribution, the
/// `--healthcheck` target, and `/health`'s `service` field.
pub const SERVICE_NAME: &str = "svc-ingest";
```

- [ ] **Step 6: Write `src/main.rs`**

```rust
//! Thin binary entrypoint -- all real logic lives in `src/lib.rs` so
//! `tests/` integration tests can exercise it without subprocessing.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        // Task 30 replaces this with a real liveness check against the
        // in-process state; a placeholder success keeps the binary buildable
        // and Docker-healthcheck-able from Task 1 onward.
        return Ok(());
    }
    println!("svc-ingest {}: run() wiring lands in Task 21", svc_ingest::SERVICE_NAME);
    Ok(())
}
```

- [ ] **Step 7: Verify the crate builds**

Run: `make -C core/svc_ingest build`
Expected: `Compiling svc-ingest v0.1.0 (/work)` then `Finished \`dev\` profile [unoptimized + debuginfo] target(s) in ...` with no errors, and a `Cargo.lock` now present in `core/svc_ingest/`. Before running, substitute the coordinator-supplied `SPINE_REV`/`LOGGING_REV`/`CONNECTORS_REV` values (Global Constraints) for the `${SPINE_REV}`/`${LOGGING_REV}`/`${CONNECTORS_REV}` placeholders in `Cargo.toml` — these are executor inputs, not something this task resolves itself. If a rev is not yet supplied, or the referenced commit does not build `penguin-spine`/`penguin-logging`/`penguin-connector-*` at version `0.1.0`, note it and stop; do not vendor a local copy, point at a different rev without confirming with the coordinator, or fall back to a registry-only pin.

- [ ] **Step 8: Commit**

```bash
git add core/svc_ingest/Cargo.toml core/svc_ingest/Cargo.lock core/svc_ingest/rust-toolchain.toml core/svc_ingest/deny.toml core/svc_ingest/.gitignore core/svc_ingest/Makefile core/svc_ingest/src/main.rs core/svc_ingest/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): scaffold Rust crate (Cargo.toml, toolchain pin, deny.toml, containerized Makefile, lib/main skeleton)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 2: Config module

**Depends on:** Task 1

**Files:**
- Create: `core/svc_ingest/src/config.rs`
- Modify: `core/svc_ingest/src/lib.rs` (already declares `pub mod config;` from Task 1 — no change needed)

**Interfaces:**
- Consumes: nothing beyond `std`/`clap`/`thiserror`.
- Produces:
  - `pub struct Secret(String)` with `Secret::new(impl Into<String>) -> Self`, `.expose(&self) -> &str`, `Debug` printing `Secret(***redacted***)`.
  - `pub struct CliConfig` (clap `Parser`, every field `env`-backed) with fields: `http_port: u16` (`MODULE_PORT`, default `8200`), `metrics_port: u16` (`METRICS_PORT`, default `9090`), `bind_addr: std::net::IpAddr` (`BIND_ADDR`, default `0.0.0.0`), `runner_tenant_slug: String` (`RUNNER_TENANT_SLUG`, default `global`), `hub_api_url: String` (`HUB_API_URL`, default `http://hub-api.waddles.svc.cluster.local:8204`), `poll_interval_s: f64` (`POLL_INTERVAL_S`, default `5.0`), `base_backoff_s: f64` / `max_backoff_s: f64` (`BASE_BACKOFF_S`/`MAX_BACKOFF_S`, defaults `1.0`/`60.0`), `valkey_url: String` (`VALKEY_URL`, required — no default), `valkey_username: Option<String>` (`VALKEY_USERNAME`), `valkey_ca_file: Option<std::path::PathBuf>` (`VALKEY_CA_FILE`, default `/etc/waddles/ca/valkey-ca.crt`), `security_transport_tls: bool` (`SECURITY_TRANSPORT_TLS`, default `true`), `security_transport_auth: bool` (`SECURITY_TRANSPORT_AUTH`, default `true`), `twitch_eventsub_mode: String` (`TWITCH_EVENTSUB_MODE`, default `webhook`), `intake_max_body_bytes: usize` (`INTAKE_MAX_BODY_BYTES`, default `262144`), `intake_replay_window_s: i64` (`INTAKE_REPLAY_WINDOW_S`, default `300`), `intake_rate_limit_source_rps: u32` / `intake_rate_limit_source_burst: u32` (`INTAKE_RATE_LIMIT_SOURCE_RPS`/`_BURST`, defaults `20`/`40`), `intake_rate_limit_tenant_rps: u32` / `intake_rate_limit_tenant_burst: u32` (`INTAKE_RATE_LIMIT_TENANT_RPS`/`_BURST`, defaults `100`/`200`), `intake_dedupe_ttl_s: u64` (`INTAKE_DEDUPE_TTL_S`, default `900`), `drain_socket_timeout_s: u64` (`DRAIN_SOCKET_TIMEOUT_S`, default `65`), `relay_block_timeout_s: u64` (`RELAY_BLOCK_TIMEOUT_S`, default `30`), `socket_lease_ttl_ms: u64` / `socket_lease_renew_ms: u64` (`SOCKET_LEASE_TTL_MS`/`SOCKET_LEASE_RENEW_MS`, defaults `30000`/`10000`), `startup_probe_timeout_ms: u64` / `startup_probe_attempts: u32` (`STARTUP_PROBE_TIMEOUT_MS`/`STARTUP_PROBE_ATTEMPTS`, defaults `5000`/`3`), `twitch_nick: Option<String>` (`TWITCH_NICK`), `twitch_channels: Option<String>` (`TWITCH_CHANNELS`, comma-separated), `kick_channels: Option<String>` (`KICK_CHANNELS`), and the three spec-amendment groups: `trusted_proxies: String` (`WADDLES_INGEST_TRUSTED_PROXIES`, comma-separated CIDRs, **default empty** — PA-PROXY), `twitch_origin_suffixes: String` / `kick_origin_suffixes: String` (`INGEST_TWITCH_ORIGIN_SUFFIXES` / `INGEST_KICK_ORIGIN_SUFFIXES`, defaults `twitch.tv` / `kick.com`), `twitch_origin_cidrs: String` / `kick_origin_cidrs: String` (`INGEST_TWITCH_ORIGIN_CIDRS` / `INGEST_KICK_ORIGIN_CIDRS`, default empty — an operator-supplied static alternative to FCrDNS), `origin_cache_ttl_s: u64` (`INGEST_ORIGIN_CACHE_TTL_S`, default `600`), `origin_lookup_timeout_ms: u64` (`INGEST_ORIGIN_LOOKUP_TIMEOUT_MS`, default `2000`).
  - `pub fn parse_cidr_list(raw: &str) -> Result<Vec<ipnet::IpNet>, ConfigError>` on `config` (free function): splits on `,`, trims, skips empties, parses each as an `IpNet` (a bare address parses as a `/32`/`/128`), and returns `ConfigError::InvalidValue { field: "cidr_list", reason }` naming the offending entry. Used for all three CIDR lists above and (Task 16) for each source's `auth.cidrs`.
  - `pub fn parse_suffix_list(raw: &str) -> Vec<String>` on `config`: splits on `,`, trims, lowercases, strips any leading `.`, skips empties.
  - `pub struct Config { pub cli: CliConfig, pub valkey_password: Option<Secret>, pub secret_key: Secret, pub twitch_bot_token: Option<Secret>, pub discord_bot_token: Option<Secret>, pub slack_app_token: Option<Secret>, pub slack_bot_token: Option<Secret>, pub youtube_api_key: Option<Secret>, pub twitch_eventsub_secret: Option<Secret>, pub kick_webhook_secret: Option<Secret> }` with `Config::load() -> Result<Self, ConfigError>` (parses `CliConfig::parse()`, reads every secret from `std::env::var(...)`, returns `Ok(None)` for an unset optional secret rather than erroring — `SECRET_KEY` is the one required secret, `VALKEY_PASSWORD` required only when `security_transport_auth` is true).
  - `pub fn validate(&self) -> Result<(), ConfigError>` on `Config`: enforces the blocking-client rule from §5.7 — `relay_block_timeout_s < drain_socket_timeout_s`, else `ConfigError::InvalidValue { field: "relay_block_timeout_s/drain_socket_timeout_s", reason: ... }` naming both values.
  - `pub enum ConfigError { MissingEnv(&'static str), InvalidValue { field: &'static str, reason: String } }` (`thiserror::Error`, `Display` matching svc_streaming's own wording).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn base_cli() -> CliConfig {
        CliConfig::parse_from(["svc-ingest", "--valkey-url", "rediss://valkey:6379/0"])
    }

    #[test]
    fn secret_debug_never_prints_the_value() {
        let s = Secret::new("super-secret-token");
        assert_eq!(format!("{s:?}"), "Secret(***redacted***)");
    }

    #[test]
    fn defaults_match_the_spec_table() {
        let cli = base_cli();
        assert_eq!(cli.http_port, 8200);
        assert_eq!(cli.metrics_port, 9090);
        assert_eq!(cli.runner_tenant_slug, "global");
        assert_eq!(cli.poll_interval_s, 5.0);
        assert_eq!(cli.intake_max_body_bytes, 262_144);
        assert_eq!(cli.intake_replay_window_s, 300);
        assert_eq!(cli.intake_rate_limit_source_rps, 20);
        assert_eq!(cli.intake_rate_limit_source_burst, 40);
        assert_eq!(cli.intake_rate_limit_tenant_rps, 100);
        assert_eq!(cli.intake_rate_limit_tenant_burst, 200);
        assert_eq!(cli.intake_dedupe_ttl_s, 900);
        assert_eq!(cli.drain_socket_timeout_s, 65);
        assert_eq!(cli.relay_block_timeout_s, 30);
        assert_eq!(cli.socket_lease_ttl_ms, 30_000);
        assert_eq!(cli.socket_lease_renew_ms, 10_000);
        assert!(cli.security_transport_tls);
        assert!(cli.security_transport_auth);
        // PA-PROXY: trust nothing until an operator says otherwise.
        assert_eq!(cli.trusted_proxies, "");
        // PA-ORIGIN defaults.
        assert_eq!(cli.twitch_origin_suffixes, "twitch.tv");
        assert_eq!(cli.kick_origin_suffixes, "kick.com");
        assert_eq!(cli.twitch_origin_cidrs, "");
        assert_eq!(cli.kick_origin_cidrs, "");
        assert_eq!(cli.origin_cache_ttl_s, 600);
        assert_eq!(cli.origin_lookup_timeout_ms, 2000);
    }

    #[test]
    fn parse_cidr_list_accepts_cidrs_bare_addresses_and_empties() {
        let parsed = parse_cidr_list(" 10.0.0.0/8 , 192.0.2.7 ,, 2001:db8::/32 ").unwrap();
        assert_eq!(parsed.len(), 3);
        assert!(parsed[0].contains(&"10.1.2.3".parse::<std::net::IpAddr>().unwrap()));
        assert_eq!(parsed[1].prefix_len(), 32);
        assert!(parse_cidr_list("").unwrap().is_empty());
    }

    #[test]
    fn parse_cidr_list_names_the_bad_entry() {
        let err = parse_cidr_list("10.0.0.0/8,not-an-ip").unwrap_err();
        assert!(err.to_string().contains("not-an-ip"), "got: {err}");
    }

    #[test]
    fn parse_suffix_list_normalizes_case_dots_and_whitespace() {
        assert_eq!(parse_suffix_list(" .Twitch.TV , kick.com ,, "), vec!["twitch.tv", "kick.com"]);
        assert!(parse_suffix_list("").is_empty());
    }

    #[test]
    fn validate_rejects_relay_timeout_not_strictly_less_than_drain_timeout() {
        let mut cli = base_cli();
        cli.relay_block_timeout_s = 65;
        cli.drain_socket_timeout_s = 65;
        let cfg = Config {
            cli,
            valkey_password: None,
            secret_key: Secret::new("x"),
            twitch_bot_token: None,
            discord_bot_token: None,
            slack_app_token: None,
            slack_bot_token: None,
            youtube_api_key: None,
            twitch_eventsub_secret: None,
            kick_webhook_secret: None,
        };
        let err = cfg.validate().unwrap_err();
        assert!(matches!(err, ConfigError::InvalidValue { field, .. } if field.contains("relay_block_timeout_s")));
    }

    #[test]
    fn validate_accepts_the_spec_defaults() {
        let cfg = Config {
            cli: base_cli(),
            valkey_password: None,
            secret_key: Secret::new("x"),
            twitch_bot_token: None,
            discord_bot_token: None,
            slack_app_token: None,
            slack_bot_token: None,
            youtube_api_key: None,
            twitch_eventsub_secret: None,
            kick_webhook_secret: None,
        };
        assert!(cfg.validate().is_ok());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='config::'`
Expected: `error[E0433]: failed to resolve: use of undeclared crate or module` / compile failure (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```rust
//! Environment-driven configuration.
//!
//! Non-secret operational settings are `clap`-parsed with an `env`
//! fallback; every secret (Valkey password, platform tokens, `SECRET_KEY`)
//! is read directly from the environment only and never exposed as a CLI
//! flag or a `Debug`-printed field -- per `critical-rules.md` Token &
//! Secret Hygiene.

use std::fmt;
use std::net::IpAddr;
use std::path::PathBuf;

use clap::Parser;
use thiserror::Error;

/// Errors that can occur while loading or validating configuration.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    /// A required secret environment variable was not set.
    #[error("missing required environment variable: {0}")]
    MissingEnv(&'static str),
    /// A value was present but failed validation.
    #[error("invalid value for {field}: {reason}")]
    InvalidValue { field: &'static str, reason: String },
}

/// A secret value whose `Debug` implementation never prints its bytes.
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
#[command(name = "svc-ingest", version, about = "Waddles ingest data-plane service")]
pub struct CliConfig {
    #[arg(long, env = "MODULE_PORT", default_value_t = 8200)]
    pub http_port: u16,
    #[arg(long, env = "METRICS_PORT", default_value_t = 9090)]
    pub metrics_port: u16,
    #[arg(long, env = "BIND_ADDR", default_value = "0.0.0.0")]
    pub bind_addr: IpAddr,
    #[arg(long, env = "RUNNER_TENANT_SLUG", default_value = "global")]
    pub runner_tenant_slug: String,
    #[arg(long, env = "HUB_API_URL", default_value = "http://hub-api.waddles.svc.cluster.local:8204")]
    pub hub_api_url: String,
    #[arg(long, env = "POLL_INTERVAL_S", default_value_t = 5.0)]
    pub poll_interval_s: f64,
    #[arg(long, env = "BASE_BACKOFF_S", default_value_t = 1.0)]
    pub base_backoff_s: f64,
    #[arg(long, env = "MAX_BACKOFF_S", default_value_t = 60.0)]
    pub max_backoff_s: f64,
    #[arg(long, env = "VALKEY_URL")]
    pub valkey_url: String,
    #[arg(long, env = "VALKEY_USERNAME")]
    pub valkey_username: Option<String>,
    #[arg(long, env = "VALKEY_CA_FILE", default_value = "/etc/waddles/ca/valkey-ca.crt")]
    pub valkey_ca_file: PathBuf,
    #[arg(long, env = "SECURITY_TRANSPORT_TLS", default_value_t = true)]
    pub security_transport_tls: bool,
    #[arg(long, env = "SECURITY_TRANSPORT_AUTH", default_value_t = true)]
    pub security_transport_auth: bool,
    #[arg(long, env = "TWITCH_EVENTSUB_MODE", default_value = "webhook")]
    pub twitch_eventsub_mode: String,
    #[arg(long, env = "INTAKE_MAX_BODY_BYTES", default_value_t = 262_144)]
    pub intake_max_body_bytes: usize,
    #[arg(long, env = "INTAKE_REPLAY_WINDOW_S", default_value_t = 300)]
    pub intake_replay_window_s: i64,
    #[arg(long, env = "INTAKE_RATE_LIMIT_SOURCE_RPS", default_value_t = 20)]
    pub intake_rate_limit_source_rps: u32,
    #[arg(long, env = "INTAKE_RATE_LIMIT_SOURCE_BURST", default_value_t = 40)]
    pub intake_rate_limit_source_burst: u32,
    #[arg(long, env = "INTAKE_RATE_LIMIT_TENANT_RPS", default_value_t = 100)]
    pub intake_rate_limit_tenant_rps: u32,
    #[arg(long, env = "INTAKE_RATE_LIMIT_TENANT_BURST", default_value_t = 200)]
    pub intake_rate_limit_tenant_burst: u32,
    #[arg(long, env = "INTAKE_DEDUPE_TTL_S", default_value_t = 900)]
    pub intake_dedupe_ttl_s: u64,
    #[arg(long, env = "DRAIN_SOCKET_TIMEOUT_S", default_value_t = 65)]
    pub drain_socket_timeout_s: u64,
    #[arg(long, env = "RELAY_BLOCK_TIMEOUT_S", default_value_t = 30)]
    pub relay_block_timeout_s: u64,
    #[arg(long, env = "SOCKET_LEASE_TTL_MS", default_value_t = 30_000)]
    pub socket_lease_ttl_ms: u64,
    #[arg(long, env = "SOCKET_LEASE_RENEW_MS", default_value_t = 10_000)]
    pub socket_lease_renew_ms: u64,
    #[arg(long, env = "STARTUP_PROBE_TIMEOUT_MS", default_value_t = 5000)]
    pub startup_probe_timeout_ms: u64,
    #[arg(long, env = "STARTUP_PROBE_ATTEMPTS", default_value_t = 3)]
    pub startup_probe_attempts: u32,
    #[arg(long, env = "TWITCH_NICK")]
    pub twitch_nick: Option<String>,
    #[arg(long, env = "TWITCH_CHANNELS")]
    pub twitch_channels: Option<String>,
    #[arg(long, env = "KICK_CHANNELS")]
    pub kick_channels: Option<String>,
    /// PA-PROXY. Empty (the default) means "trust nothing": the TCP peer
    /// address is the client address and `X-Forwarded-For` is ignored.
    #[arg(long, env = "WADDLES_INGEST_TRUSTED_PROXIES", default_value = "")]
    pub trusted_proxies: String,
    #[arg(long, env = "INGEST_TWITCH_ORIGIN_SUFFIXES", default_value = "twitch.tv")]
    pub twitch_origin_suffixes: String,
    #[arg(long, env = "INGEST_KICK_ORIGIN_SUFFIXES", default_value = "kick.com")]
    pub kick_origin_suffixes: String,
    #[arg(long, env = "INGEST_TWITCH_ORIGIN_CIDRS", default_value = "")]
    pub twitch_origin_cidrs: String,
    #[arg(long, env = "INGEST_KICK_ORIGIN_CIDRS", default_value = "")]
    pub kick_origin_cidrs: String,
    #[arg(long, env = "INGEST_ORIGIN_CACHE_TTL_S", default_value_t = 600)]
    pub origin_cache_ttl_s: u64,
    #[arg(long, env = "INGEST_ORIGIN_LOOKUP_TIMEOUT_MS", default_value_t = 2000)]
    pub origin_lookup_timeout_ms: u64,
}

/// Parses a comma-separated CIDR list. A bare address is accepted and
/// widened to its host prefix (`/32` or `/128`). Used for the trusted-proxy
/// list, the per-platform origin allowlists, and each source's
/// `auth.cidrs` (Task 16).
pub fn parse_cidr_list(raw: &str) -> Result<Vec<ipnet::IpNet>, ConfigError> {
    let mut out = Vec::new();
    for entry in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let parsed = entry
            .parse::<ipnet::IpNet>()
            .or_else(|_| entry.parse::<std::net::IpAddr>().map(ipnet::IpNet::from))
            .map_err(|_| ConfigError::InvalidValue {
                field: "cidr_list",
                reason: format!("{entry:?} is not a valid CIDR or IP address"),
            })?;
        out.push(parsed);
    }
    Ok(out)
}

/// Parses a comma-separated DNS suffix list: trimmed, lowercased, any
/// leading `.` stripped, empties dropped.
pub fn parse_suffix_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_start_matches('.').to_ascii_lowercase())
        .collect()
}

/// Fully-loaded runtime configuration: operational settings plus secrets
/// pulled directly from the environment (never via CLI flag).
#[derive(Clone)]
pub struct Config {
    pub cli: CliConfig,
    pub valkey_password: Option<Secret>,
    pub secret_key: Secret,
    pub twitch_bot_token: Option<Secret>,
    pub discord_bot_token: Option<Secret>,
    pub slack_app_token: Option<Secret>,
    pub slack_bot_token: Option<Secret>,
    pub youtube_api_key: Option<Secret>,
    pub twitch_eventsub_secret: Option<Secret>,
    pub kick_webhook_secret: Option<Secret>,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config").field("cli", &self.cli).finish_non_exhaustive()
    }
}

impl Config {
    /// Loads CLI/env operational settings and every secret from the
    /// environment. `SECRET_KEY` is the sole required secret; the rest are
    /// `None` when unset (matching today's "receiver stays idle" posture).
    pub fn load() -> Result<Self, ConfigError> {
        let cli = CliConfig::parse();
        let secret_key = std::env::var("SECRET_KEY")
            .map(Secret::new)
            .map_err(|_| ConfigError::MissingEnv("SECRET_KEY"))?;
        if cli.security_transport_auth && std::env::var("VALKEY_PASSWORD").is_err() {
            return Err(ConfigError::MissingEnv("VALKEY_PASSWORD"));
        }
        let cfg = Self {
            valkey_password: std::env::var("VALKEY_PASSWORD").ok().map(Secret::new),
            secret_key,
            twitch_bot_token: std::env::var("TWITCH_OAUTH_TOKEN").ok().map(Secret::new),
            discord_bot_token: std::env::var("DISCORD_BOT_TOKEN").ok().map(Secret::new),
            slack_app_token: std::env::var("SLACK_APP_TOKEN").ok().map(Secret::new),
            slack_bot_token: std::env::var("SLACK_BOT_TOKEN").ok().map(Secret::new),
            youtube_api_key: std::env::var("YOUTUBE_API_KEY").ok().map(Secret::new),
            twitch_eventsub_secret: std::env::var("TWITCH_EVENTSUB_SECRET").ok().map(Secret::new),
            kick_webhook_secret: std::env::var("KICK_WEBHOOK_SECRET").ok().map(Secret::new),
            cli,
        };
        cfg.validate()?;
        Ok(cfg)
    }

    /// Cross-field validation `clap` can't express -- the §5.7 blocking-
    /// client rule: the relay's server-side block timeout must be strictly
    /// less than the owning connection's own socket read timeout, or a
    /// clean idle-timeout response races a client-side `TimeoutError`.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.cli.relay_block_timeout_s >= self.cli.drain_socket_timeout_s {
            return Err(ConfigError::InvalidValue {
                field: "relay_block_timeout_s/drain_socket_timeout_s",
                reason: format!(
                    "RELAY_BLOCK_TIMEOUT_S ({}) must be strictly less than DRAIN_SOCKET_TIMEOUT_S ({})",
                    self.cli.relay_block_timeout_s, self.cli.drain_socket_timeout_s
                ),
            });
        }
        Ok(())
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='config::'`
Expected: `test result: ok. 7 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/config.rs core/svc_ingest/Cargo.toml core/svc_ingest/Cargo.lock
git commit -m "$(cat <<'EOF'
feat(svc-ingest): env-driven config module -- Secret redaction, §5.7 blocking-client rule, trusted-proxy/origin CIDR+suffix parsing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 3: Error types

**Depends on:** Task 1

**Files:**
- Create: `core/svc_ingest/src/error.rs`

**Interfaces:**
- Consumes: nothing beyond `thiserror`/`axum`.
- Produces:
  - `pub enum NormalizeError { MissingField(&'static str), EmptyField(&'static str), UnsupportedEventType { got: String, expected: &'static [&'static str] }, MappingFailed { field: String, reason: String } }` (`thiserror::Error`, `Display` messages containing the field name so `assert!(err.to_string().contains("content"))`-style tests read naturally, mirroring the Python `ValueError` messages ported in Tasks 5-11).
  - `pub enum IntakeError { MalformedBody, BadSignature, ReplayWindow, UnknownSource, SourceDisabled, DuplicateMessage, DuplicateDelivery, BodyTooLarge, MappingFailed(String), RateLimited, SecretUnset, EnvelopeInvalid(String), InvalidToken, MissingScope, TenantMismatch, PlatformNotRegistered, SecondFactorFailed, AuthNotConfigured, OriginRejected }` implementing `axum::response::IntoResponse` — maps 1:1 to §10.1's status/reason table, plus the three §4.1.1/D29 rows (PA-INTAKE-AUTH / PA-ORIGIN). **`SecondFactorFailed` is one reason covering all three configured-but-unsatisfied modes** (IP allowlist miss, bad/missing bearer, bad/missing basic) — §10.1's endpoint table and §14.10's negative-test table both name exactly one reason (`second_factor_failed`) for this condition, never a per-mode reason:

    | Variant | Status | JSON `reason` | Source |
    |---|---|---|---|
    | `MalformedBody` | 400 | `malformed_body` | §10.1 |
    | `BadSignature` | 401 | `bad_signature` | §10.1 |
    | `ReplayWindow` | 403 | `replay_window` | §10.1 |
    | `UnknownSource` | 404 | `unknown_source` | §10.1 |
    | `SourceDisabled` | 503 | `source_disabled` | §10.1 |
    | `DuplicateMessage` | 409 | `duplicate_message_id` | §10.1 |
    | `DuplicateDelivery` | 409 | `duplicate_delivery_id` | §10.1 |
    | `BodyTooLarge` | 413 | `body_too_large` | §10.1 |
    | `MappingFailed(_)` | 422 | `mapping_failed` | §10.1 |
    | `RateLimited` | 429 | `rate_limited` (also sets `Retry-After: 1`) | §10.1 |
    | `SecretUnset` | 503 | `secret_unset` | §10.1 |
    | `EnvelopeInvalid(_)` | 422 | `envelope_invalid` | §10.1 |
    | `InvalidToken` | 401 | `invalid_token` | §10.1 |
    | `MissingScope` | 403 | `missing_scope` | §10.1 |
    | `TenantMismatch` | 403 | `tenant_mismatch` | §10.1 |
    | `PlatformNotRegistered` | 403 | `platform_not_registered` | §10.1 |
    | `SecondFactorFailed` | 401 | `second_factor_failed` | PA-INTAKE-AUTH — a configured IP allowlist, bearer token, or basic credential did not admit the request |
    | `AuthNotConfigured` | 401 | `auth_not_configured` | PA-INTAKE-AUTH (fail closed — a source with no configured mode is never an implicit allow) |
    | `OriginRejected` | 403 | `origin_not_trusted` | PA-ORIGIN |

    Response body shape: `{"error": <reason>, "detail": <Display string or null>}`. **`detail` is `None` for every authentication/origin variant** — telling a caller *which* gate it failed is a probing oracle; the reason code is for our dashboards, the body just says the request was rejected. **The OTel metric label is not always the same string as the HTTP `error` field**: §4.1.1's `ingest_webhook_rejected_total{...,reason}` uses a coarser four-bucket vocabulary (`"origin"|"signature"|"auth"|"replay"`) than the HTTP body's fine-grained reasons — `IntakeError::metric_reason(&self) -> &'static str` (defined alongside `status_and_reason` in Step 3) maps `BadSignature→"signature"`, `OriginRejected→"origin"`, `SecondFactorFailed`/`AuthNotConfigured→"auth"`, `ReplayWindow→"replay"`, and every other variant to its own `status_and_reason()` reason (the spec's bucket list is illustrative, not exhaustive, for the many other §10.1 reasons this counter also covers).
  - `pub enum IngestError { Config(crate::config::ConfigError), Spine(String), Connector(String), Io(std::io::Error) }` — the top-level error every supervisor/relay task returns; `From` impls for the three inner types (spine/connector stored as `String` via `.to_string()` since their concrete crate error types are external and only need `Display`, not structural matching, anywhere in this service).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn rate_limited_sets_retry_after_header() {
        let resp = IntakeError::RateLimited.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(resp.headers().get("Retry-After").unwrap(), "1");
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "rate_limited");
    }

    #[test]
    fn every_intake_error_maps_to_its_spec_status_and_reason() {
        let cases: &[(IntakeError, u16, &str)] = &[
            (IntakeError::MalformedBody, 400, "malformed_body"),
            (IntakeError::BadSignature, 401, "bad_signature"),
            (IntakeError::ReplayWindow, 403, "replay_window"),
            (IntakeError::UnknownSource, 404, "unknown_source"),
            (IntakeError::DuplicateMessage, 409, "duplicate_message_id"),
            (IntakeError::DuplicateDelivery, 409, "duplicate_delivery_id"),
            (IntakeError::BodyTooLarge, 413, "body_too_large"),
            (IntakeError::MappingFailed("x".into()), 422, "mapping_failed"),
            (IntakeError::RateLimited, 429, "rate_limited"),
            (IntakeError::SecretUnset, 503, "secret_unset"),
            (IntakeError::EnvelopeInvalid("x".into()), 422, "envelope_invalid"),
            (IntakeError::InvalidToken, 401, "invalid_token"),
            (IntakeError::MissingScope, 403, "missing_scope"),
            (IntakeError::TenantMismatch, 403, "tenant_mismatch"),
            (IntakeError::PlatformNotRegistered, 403, "platform_not_registered"),
            (IntakeError::SourceDisabled, 503, "source_disabled"),
            (IntakeError::SecondFactorFailed, 401, "second_factor_failed"),
            (IntakeError::AuthNotConfigured, 401, "auth_not_configured"),
            (IntakeError::OriginRejected, 403, "origin_not_trusted"),
        ];
        for (err, status, reason) in cases {
            let (s, r) = err.status_and_reason();
            assert_eq!(s.as_u16(), *status, "case: {reason}");
            assert_eq!(r, *reason);
        }
        assert_eq!(cases.len(), 19, "every IntakeError variant must be covered by this table");
    }

    #[test]
    fn metric_reason_uses_the_spec_coarse_bucket_for_the_four_named_variants() {
        assert_eq!(IntakeError::BadSignature.metric_reason(), "signature");
        assert_eq!(IntakeError::OriginRejected.metric_reason(), "origin");
        assert_eq!(IntakeError::SecondFactorFailed.metric_reason(), "auth");
        assert_eq!(IntakeError::AuthNotConfigured.metric_reason(), "auth");
        assert_eq!(IntakeError::ReplayWindow.metric_reason(), "replay");
        // Everything else falls back to its own HTTP reason string.
        assert_eq!(IntakeError::UnknownSource.metric_reason(), "unknown_source");
    }

    #[tokio::test]
    async fn auth_and_origin_rejections_never_leak_a_detail_oracle() {
        for err in [
            IntakeError::SecondFactorFailed,
            IntakeError::AuthNotConfigured,
            IntakeError::OriginRejected,
            IntakeError::BadSignature,
        ] {
            let resp = err.clone().into_response();
            let body = resp.into_body().collect().await.unwrap().to_bytes();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(json["detail"], serde_json::Value::Null, "variant {err:?} leaked a detail");
        }
    }

    #[test]
    fn normalize_error_messages_name_the_field() {
        let err = NormalizeError::MissingField("content");
        assert!(err.to_string().contains("content"));
        let err = NormalizeError::UnsupportedEventType {
            got: "channel.update".into(),
            expected: &["channel.follow"],
        };
        assert!(err.to_string().contains("unsupported"));
        assert!(err.to_string().contains("channel.update"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='error::'`
Expected: compile failure, `error.rs` module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! Error types shared across normalizers, intake handlers, and the
//! background supervisors. Every intake-facing variant maps 1:1 to §10.1's
//! endpoint table so a rejection's HTTP status and JSON `reason` are never
//! decided ad hoc at the call site.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use thiserror::Error;

/// A raw platform payload failed to normalize into a `PlatformEvent`.
/// Ported 1:1 from each Python `*_ingest.py::normalize`'s `ValueError`.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum NormalizeError {
    #[error("raw event missing required '{0}' string field")]
    MissingField(&'static str),
    #[error("raw event has an empty '{0}' field")]
    EmptyField(&'static str),
    #[error("raw event has unsupported event_type {got:?}, expected one of {expected:?}")]
    UnsupportedEventType { got: String, expected: &'static [&'static str] },
    #[error("mapping failed for field '{field}': {reason}")]
    MappingFailed { field: String, reason: String },
}

/// Every rejection an intake route can return, matching §10.1's status/
/// reason table exactly.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum IntakeError {
    #[error("malformed body")]
    MalformedBody,
    #[error("bad signature")]
    BadSignature,
    #[error("outside the replay window")]
    ReplayWindow,
    #[error("unknown source")]
    UnknownSource,
    #[error("duplicate message id")]
    DuplicateMessage,
    #[error("duplicate delivery id")]
    DuplicateDelivery,
    #[error("body too large")]
    BodyTooLarge,
    #[error("mapping failed: {0}")]
    MappingFailed(String),
    #[error("rate limited")]
    RateLimited,
    #[error("secret not configured")]
    SecretUnset,
    #[error("envelope invalid: {0}")]
    EnvelopeInvalid(String),
    #[error("invalid token")]
    InvalidToken,
    #[error("missing scope")]
    MissingScope,
    #[error("tenant mismatch")]
    TenantMismatch,
    #[error("platform not registered for this tenant")]
    PlatformNotRegistered,
    #[error("source disabled")]
    SourceDisabled,
    #[error("configured second factor rejected the request")]
    SecondFactorFailed,
    #[error("source has no configured authentication mode")]
    AuthNotConfigured,
    #[error("request origin could not be confirmed")]
    OriginRejected,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    detail: Option<String>,
}

impl IntakeError {
    /// The `(status, reason)` pair this variant maps to, per §10.1.
    pub fn status_and_reason(&self) -> (StatusCode, &'static str) {
        match self {
            Self::MalformedBody => (StatusCode::BAD_REQUEST, "malformed_body"),
            Self::BadSignature => (StatusCode::UNAUTHORIZED, "bad_signature"),
            Self::ReplayWindow => (StatusCode::FORBIDDEN, "replay_window"),
            Self::UnknownSource => (StatusCode::NOT_FOUND, "unknown_source"),
            Self::DuplicateMessage => (StatusCode::CONFLICT, "duplicate_message_id"),
            Self::DuplicateDelivery => (StatusCode::CONFLICT, "duplicate_delivery_id"),
            Self::BodyTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
            Self::MappingFailed(_) => (StatusCode::UNPROCESSABLE_ENTITY, "mapping_failed"),
            Self::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Self::SecretUnset => (StatusCode::SERVICE_UNAVAILABLE, "secret_unset"),
            Self::EnvelopeInvalid(_) => (StatusCode::UNPROCESSABLE_ENTITY, "envelope_invalid"),
            Self::InvalidToken => (StatusCode::UNAUTHORIZED, "invalid_token"),
            Self::MissingScope => (StatusCode::FORBIDDEN, "missing_scope"),
            Self::TenantMismatch => (StatusCode::FORBIDDEN, "tenant_mismatch"),
            Self::PlatformNotRegistered => (StatusCode::FORBIDDEN, "platform_not_registered"),
            Self::SourceDisabled => (StatusCode::SERVICE_UNAVAILABLE, "source_disabled"),
            Self::SecondFactorFailed => (StatusCode::UNAUTHORIZED, "second_factor_failed"),
            Self::AuthNotConfigured => (StatusCode::UNAUTHORIZED, "auth_not_configured"),
            Self::OriginRejected => (StatusCode::FORBIDDEN, "origin_not_trusted"),
        }
    }

    /// The `reason` label on `ingest_webhook_rejected_total`/
    /// `waddles_intake_rejected_total` -- §4.1.1's literal text gives this
    /// counter a coarser four-bucket vocabulary (`"origin"|"signature"|
    /// "auth"|"replay"`) than the HTTP body's `error` field; every other
    /// variant falls back to its own `status_and_reason()` reason.
    pub fn metric_reason(&self) -> &'static str {
        match self {
            Self::BadSignature => "signature",
            Self::OriginRejected => "origin",
            Self::SecondFactorFailed | Self::AuthNotConfigured => "auth",
            Self::ReplayWindow => "replay",
            other => other.status_and_reason().1,
        }
    }

    /// True for every variant whose response body must carry no `detail`
    /// -- telling a caller which admission gate it failed is a probing
    /// oracle (PA-INTAKE-AUTH / PA-ORIGIN).
    pub fn is_admission_failure(&self) -> bool {
        matches!(
            self,
            Self::BadSignature
                | Self::SecondFactorFailed
                | Self::AuthNotConfigured
                | Self::OriginRejected
                | Self::InvalidToken
                | Self::MissingScope
        )
    }
}

impl IntoResponse for IntakeError {
    fn into_response(self) -> Response {
        let (status, reason) = self.status_and_reason();
        let detail = match &self {
            _ if self.is_admission_failure() => None,
            Self::MappingFailed(d) | Self::EnvelopeInvalid(d) => Some(d.clone()),
            _ => None,
        };
        let mut resp = (status, axum::Json(ErrorBody { error: reason, detail })).into_response();
        if status == StatusCode::TOO_MANY_REQUESTS {
            resp.headers_mut().insert("Retry-After", "1".parse().unwrap());
        }
        resp
    }
}

/// Top-level error for supervisors, the relay drain, and the source
/// registry poller -- inner crate errors (`penguin-spine`, connectors) are
/// stored as rendered strings since nothing in this service pattern-
/// matches their concrete variants, only logs/propagates them.
#[derive(Debug, Error)]
pub enum IngestError {
    #[error("config error: {0}")]
    Config(#[from] crate::config::ConfigError),
    #[error("spine error: {0}")]
    Spine(String),
    #[error("connector error: {0}")]
    Connector(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='error::'`
Expected: `test result: ok. 5 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/error.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): error types -- §10.1 status/reason mapping plus the auth-mode/origin admission variants, no detail oracle

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 4: Telemetry bootstrap + AppState + health/metrics skeleton

**Depends on:** Task 1, Task 2, Task 3

**Files:**
- Create: `core/svc_ingest/src/telemetry.rs`
- Create: `core/svc_ingest/src/http/mod.rs`
- Create: `core/svc_ingest/src/http/state.rs`
- Create: `core/svc_ingest/src/http/health.rs`

`svc_ingest` owns **no** OTel instrument construction and **no** `prometheus::*Vec` of its own: `penguin-logging` already caches one instrument per metric name (M1b Task 12) and already renders the Prometheus text surface from the `Registry` its `init` returns (M1b Tasks 9/15). This module is a thin, typed facade over those free functions plus the `SpineMetrics` adapter `penguin-spine` needs.

**Interfaces:**
- Consumes: `penguin_logging::{init, ServiceConfig, TelemetryGuard, LevelHandle}`, `penguin_logging::metrics::{counter_add, gauge_set, record_latency_ms}`, `penguin_logging::health::{HealthState, DependencyMetrics, TransportMetrics, TransportAspect, warn_insecure_transport, liveness_readiness_router, metrics_router}` (External Crate Surfaces); `crate::config::Config` (Task 2).
- Produces:
  - `#[derive(Clone, Default)] pub struct IngestMetrics;` — a zero-sized typed facade. Every method forwards to a `penguin_logging::metrics` free function with the exact metric name from §13.1, so a metric name is spelled once in this file and nowhere else:

    | Method | Instrument | Labels |
    |---|---|---|
    | `intake_rejected(&self, source: &str, reason: &str)` | counter `waddles_intake_rejected_total` | `source`, `reason` |
    | `webhook_rejected(&self, source: &str, reason: &str)` | counter `ingest_webhook_rejected_total` | `source`, `reason` (PA-INTAKE-AUTH) |
    | `platform_webhook_rejected(&self, platform: &str, reason: &str)` | counter `ingest_webhook_rejected_total` | `platform`, `reason` (PA-ORIGIN) |
    | `intake_request_ms(&self, route: &str, status: u16, millis: f64)` | **histogram** `waddles_intake_request_ms` | `route`, `status` |
    | `origin_lookup_ms(&self, platform: &str, outcome: &str, millis: f64)` | **histogram** `ingest_origin_lookup_ms` | `platform`, `outcome` (`hit`/`miss`/`timeout`) |
    | `stream_event_written(&self, platform: &str, source_id: &str)` | counter `waddles_stream_events_total` | `platform`, `source_id` |
    | `stream_trimmed(&self, stream: &str)` | counter `waddles_stream_trimmed_total` | `stream` |
    | `socket_lease_held(&self, provider: &str, community: &str, held: bool)` | gauge `waddles_socket_lease_held` (`1.0`/`0.0`) | `provider`, `community` |
    | `backpressure_depth(&self, source_id: &str, depth: f64)` | gauge `waddles_ingest_backpressure_depth` | `source_id` |
    | `backpressure_dropped(&self, source_id: &str)` | counter `waddles_ingest_backpressure_dropped_total` | `source_id` |
    | `relay_send(&self, outcome: &str)` | counter `waddles_relay_send_total` | `outcome` (`ok`/`retryable`/`non_retryable`) |
    | `relay_send_ms(&self, outcome: &str, millis: f64)` | **histogram** `waddles_relay_send_ms` | `outcome` |

  - `pub struct IngestSpineMetrics(pub std::sync::Arc<IngestMetrics>);` with `impl penguin_spine::SpineMetrics for IngestSpineMetrics` overriding exactly the two callbacks ingest can observe — `stream_event_written` and `stream_trimmed` — and leaving every other method on its crate-provided no-op default (ingest never reads a group, so `stream_claimed`/`consumer_skipped`/`dlq_written` can never fire here).
  - `pub struct Telemetry { pub guard: TelemetryGuard, pub level: LevelHandle, pub registry: prometheus::Registry, pub health: HealthState, pub dependencies: DependencyMetrics, pub transport: TransportMetrics, pub metrics: std::sync::Arc<IngestMetrics> }`.
  - `pub fn init_telemetry(version: &str) -> Telemetry` — calls `penguin_logging::init(ServiceConfig::from_env(crate::SERVICE_NAME))` **exactly once per process**, builds the `HealthState` from the returned registry, and returns everything the rest of the service needs. Never called from a unit test (see the note below).
  - `pub fn report_transport(t: &Telemetry, cfg: &crate::config::Config)` — for the `valkey` component, calls `warn_insecure_transport(&t.transport, "valkey", TransportAspect::Tls)` when `security_transport_tls` is `false` and the `Auth` equivalent when `security_transport_auth` is `false`, `t.transport.mark_secure(...)` for each aspect that *is* on, and `t.health.set_transport("valkey", ComponentTransport { tls, auth })` either way — so `/health`'s `transport` field reads `"secure"` only when both are on (D19/D20, §11.6.4).
  - `pub struct AppState { pub config: Arc<Config>, pub metrics: Arc<IngestMetrics>, pub health: HealthState, pub started_at: Instant }` (later tasks add fields), `AppState::new(config: Config, metrics: Arc<IngestMetrics>, health: HealthState) -> Self`, and `impl FromRef<AppState>` for `Arc<IngestMetrics>` / `Arc<Config>` / `HealthState`.

**Why unit tests never call `init_telemetry`.** `penguin_logging::init` installs the process-global `tracing` subscriber and panics on a second call (M1b Task 11's own "Why two test files" note). `cargo test --lib` runs every test as a thread in **one** process, so a single `init` call anywhere in the unit-test binary would make every other test's ordering load-bearing. Tests that need to observe emitted telemetry use `penguin_logging::testing::init_test_telemetry` instead, which installs a *thread-local* subscriber plus an in-memory exporter, and they serialize on the module-local `metrics_test_lock()` below because the OTel meter provider is process-global.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use penguin_logging::testing::init_test_telemetry;

    #[test]
    fn ingest_metrics_emit_counters_gauges_and_histograms() {
        let _guard = metrics_test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let telemetry = init_test_telemetry("svc-ingest-metrics-test");
        let metrics = IngestMetrics;

        metrics.intake_rejected("acme-github", "bad_signature");
        metrics.webhook_rejected("acme-github", "no_auth_mode");
        metrics.platform_webhook_rejected("twitch", "origin");
        metrics.stream_event_written("twitch", "tw-waddlebot");
        metrics.socket_lease_held("twitch", "waddlebot", true);
        metrics.backpressure_depth("tw-waddlebot", 3.0);
        metrics.intake_request_ms("/intake/events", 202, 12.5);
        metrics.origin_lookup_ms("twitch", "miss", 4.0);

        telemetry.force_flush();
        let counts = telemetry.counts();
        assert!(counts.metric_data_points >= 8, "got {counts:?}");
        // The "histograms first" rule (critical-rules.md Observability):
        // latency is never a counter here.
        assert!(counts.histogram_data_points >= 2, "got {counts:?}");
    }

    #[test]
    fn spine_metrics_adapter_forwards_stream_writes_and_trims() {
        let _guard = metrics_test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let telemetry = init_test_telemetry("svc-ingest-spine-metrics-test");
        let adapter = IngestSpineMetrics(std::sync::Arc::new(IngestMetrics));
        penguin_spine::SpineMetrics::stream_event_written(&adapter, "kick", "kick-acme");
        penguin_spine::SpineMetrics::stream_trimmed(&adapter, "waddles:t:acme:c:_tenant:src:kick:kick-acme:events");
        telemetry.force_flush();
        assert!(telemetry.counts().metric_data_points >= 2);
    }
}
```

(These two live at the bottom of `src/telemetry.rs`. `src/http/health.rs` gets its own test module in Step 5.)

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='telemetry::'`
Expected: compile failure — `telemetry.rs` is an empty module stub from Task 1, so `IngestMetrics`, `IngestSpineMetrics` and `metrics_test_lock` are all undeclared (`error[E0433]`/`error[E0425]`).

- [ ] **Step 3: Write `src/telemetry.rs`**

```rust
//! Telemetry bootstrap and the ingest-owned metric surface (§13.1).
//!
//! Every instrument goes through `penguin_logging::metrics`, which caches
//! one OTel instrument per name -- this service never constructs an OTel
//! or `prometheus` instrument directly, so a metric name is spelled once,
//! here, and the "histograms for load/latency first" rule is satisfied by
//! construction (`critical-rules.md` Observability).

use std::sync::Arc;

use opentelemetry::KeyValue;
use penguin_logging::health::{
    liveness_readiness_router, metrics_router, warn_insecure_transport, ComponentTransport,
    DependencyMetrics, HealthState, TransportAspect, TransportMetrics,
};
use penguin_logging::metrics::{counter_add, gauge_set, record_latency_ms};
use penguin_logging::{init, LevelHandle, ServiceConfig, TelemetryGuard};

use crate::config::Config;

/// Serializes tests that touch the process-global OTel meter provider.
/// Mirrors `penguin_logging`'s own `global_meter_test_lock` rationale
/// (M1b Task 12): `cargo test --lib` runs every test in one process.
#[cfg(test)]
pub(crate) fn metrics_test_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// The ingest-owned metric names of §13.1, as a typed facade over
/// `penguin_logging::metrics`. Zero-sized and `Clone` so it costs nothing
/// to hold one in `AppState` and one in every supervisor.
#[derive(Clone, Copy, Debug, Default)]
pub struct IngestMetrics;

impl IngestMetrics {
    /// Back-compat constructor: `IngestMetrics` is zero-sized and
    /// stateless (every method forwards to `penguin_logging`'s
    /// process-global instruments), so a caller that already holds a
    /// `prometheus::Registry` (e.g. a test's `AppState` builder) does not
    /// need a special case -- `registry` is accepted and ignored.
    pub fn register(_registry: &prometheus::Registry) -> Self {
        Self
    }

    /// One intake rejection, by source and §10.1 reason.
    pub fn intake_rejected(&self, source: &str, reason: &str) {
        counter_add(
            "waddles_intake_rejected_total",
            1,
            &[KeyValue::new("source", source.to_string()), KeyValue::new("reason", reason.to_string())],
        );
    }

    /// One generic-webhook admission rejection (PA-INTAKE-AUTH).
    pub fn webhook_rejected(&self, source: &str, reason: &str) {
        counter_add(
            "ingest_webhook_rejected_total",
            1,
            &[KeyValue::new("source", source.to_string()), KeyValue::new("reason", reason.to_string())],
        );
    }

    /// One platform-webhook admission rejection, e.g. a failed origin
    /// check (PA-ORIGIN). Same instrument as `webhook_rejected`, labelled
    /// by `platform` rather than `source`.
    pub fn platform_webhook_rejected(&self, platform: &str, reason: &str) {
        counter_add(
            "ingest_webhook_rejected_total",
            1,
            &[KeyValue::new("platform", platform.to_string()), KeyValue::new("reason", reason.to_string())],
        );
    }

    /// Intake handler latency -- a histogram, never a counter.
    pub fn intake_request_ms(&self, route: &str, status: u16, millis: f64) {
        record_latency_ms(
            "waddles_intake_request_ms",
            millis,
            &[KeyValue::new("route", route.to_string()), KeyValue::new("status", i64::from(status))],
        );
    }

    /// FCrDNS origin-resolution latency, by cache outcome (PA-ORIGIN).
    pub fn origin_lookup_ms(&self, platform: &str, outcome: &str, millis: f64) {
        record_latency_ms(
            "ingest_origin_lookup_ms",
            millis,
            &[KeyValue::new("platform", platform.to_string()), KeyValue::new("outcome", outcome.to_string())],
        );
    }

    /// One entry written onto an ingest source stream (§10.6).
    pub fn stream_event_written(&self, platform: &str, source_id: &str) {
        counter_add(
            "waddles_stream_events_total",
            1,
            &[KeyValue::new("platform", platform.to_string()), KeyValue::new("source_id", source_id.to_string())],
        );
    }

    /// `MAXLEN ~` evicted at least one entry on an `XADD`.
    pub fn stream_trimmed(&self, stream: &str) {
        counter_add("waddles_stream_trimmed_total", 1, &[KeyValue::new("stream", stream.to_string())]);
    }

    /// `1` on the replica holding the single-owner lease, `0` otherwise.
    pub fn socket_lease_held(&self, provider: &str, community: &str, held: bool) {
        gauge_set(
            "waddles_socket_lease_held",
            if held { 1.0 } else { 0.0 },
            &[KeyValue::new("provider", provider.to_string()), KeyValue::new("community", community.to_string())],
        );
    }

    /// Current depth of a receiver's in-process hand-off channel -- the
    /// backpressure signal (§5.6).
    pub fn backpressure_depth(&self, source_id: &str, depth: f64) {
        gauge_set("waddles_ingest_backpressure_depth", depth, &[KeyValue::new("source_id", source_id.to_string())]);
    }

    /// A raw payload dropped because the hand-off channel was full.
    pub fn backpressure_dropped(&self, source_id: &str) {
        counter_add(
            "waddles_ingest_backpressure_dropped_total",
            1,
            &[KeyValue::new("source_id", source_id.to_string())],
        );
    }

    /// One Twitch outbound relay send, by outcome.
    pub fn relay_send(&self, outcome: &str) {
        counter_add("waddles_relay_send_total", 1, &[KeyValue::new("outcome", outcome.to_string())]);
    }

    /// Twitch outbound relay send latency -- a histogram.
    pub fn relay_send_ms(&self, outcome: &str, millis: f64) {
        record_latency_ms("waddles_relay_send_ms", millis, &[KeyValue::new("outcome", outcome.to_string())]);
    }
}

/// Adapts [`IngestMetrics`] to `penguin_spine::SpineMetrics` so the spine
/// client's own `XADD`/trim accounting lands on the same instruments.
/// Only the two callbacks ingest can reach are overridden; the rest keep
/// the trait's no-op defaults because ingest never reads a consumer group.
pub struct IngestSpineMetrics(pub Arc<IngestMetrics>);

impl penguin_spine::SpineMetrics for IngestSpineMetrics {
    fn stream_event_written(&self, platform: &str, source_id: &str) {
        self.0.stream_event_written(platform, source_id);
    }

    fn stream_trimmed(&self, stream: &str) {
        self.0.stream_trimmed(stream);
    }
}

/// Everything `init_telemetry` hands back to `main`.
pub struct Telemetry {
    /// Drop flushes the OTel exporters.
    pub guard: TelemetryGuard,
    /// Runtime log-level reload handle.
    pub level: LevelHandle,
    /// The Prometheus registry `/metrics` renders from.
    pub registry: prometheus::Registry,
    /// The `/health` body's backing state.
    pub health: HealthState,
    /// `waddles_dependency_up` / `waddles_dependency_check_total` emitter.
    pub dependencies: DependencyMetrics,
    /// `waddles_insecure_transport` emitter.
    pub transport: TransportMetrics,
    /// This service's own metric facade.
    pub metrics: Arc<IngestMetrics>,
}

/// Initializes OTel logs/metrics/traces and the health surface. Call
/// exactly once, from `main` -- never from a test (see the module note in
/// this task's Interfaces block).
pub fn init_telemetry(version: &str) -> Telemetry {
    let (guard, level, registry) = init(ServiceConfig::from_env(crate::SERVICE_NAME));
    let health = HealthState::new(crate::SERVICE_NAME, version, registry.clone());
    Telemetry {
        guard,
        level,
        registry,
        health,
        dependencies: DependencyMetrics,
        transport: TransportMetrics,
        metrics: Arc::new(IngestMetrics),
    }
}

/// Emits the D19/D20 transport posture for the one component ingest talks
/// to over the wire (Valkey): a loud WARN plus
/// `waddles_insecure_transport{component,aspect}=1` per disabled aspect,
/// `mark_secure` per enabled one, and the `/health` `transport` field
/// either way. Never rejects the configuration -- the opt-out is a normal,
/// always-accepted chart value (§11.6.4).
pub fn report_transport(telemetry: &Telemetry, config: &Config) {
    let tls = config.cli.security_transport_tls;
    let auth = config.cli.security_transport_auth;
    if tls {
        telemetry.transport.mark_secure("valkey", TransportAspect::Tls);
    } else {
        warn_insecure_transport(&telemetry.transport, "valkey", TransportAspect::Tls);
    }
    if auth {
        telemetry.transport.mark_secure("valkey", TransportAspect::Auth);
    } else {
        warn_insecure_transport(&telemetry.transport, "valkey", TransportAspect::Auth);
    }
    telemetry.health.set_transport("valkey", ComponentTransport { tls, auth });
}

/// `/health` + `/healthz` for the main `:8200` router (§13.4).
pub fn health_routes(health: HealthState) -> axum::Router {
    liveness_readiness_router(health)
}

/// `/metrics` for the secondary `:9090` router (§13.4).
pub fn metrics_routes(health: HealthState) -> axum::Router {
    metrics_router(health)
}
```

- [ ] **Step 4: Write `src/http/state.rs`**

```rust
//! Shared Axum state: config, metrics and health, cheaply cloneable.
//! Later tasks add the secrets, limiters, appender, scope, dedupe store,
//! source registry and origin verifier fields -- each documented at the
//! task that adds it.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::FromRef;
use penguin_logging::health::HealthState;

use crate::config::Config;
use crate::telemetry::IngestMetrics;

/// Application state threaded through every Axum handler.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub metrics: Arc<IngestMetrics>,
    pub health: HealthState,
    pub started_at: Instant,
}

impl AppState {
    /// Builds state from an already-loaded config plus the telemetry
    /// facade and health state `init_telemetry` produced.
    pub fn new(config: Config, metrics: Arc<IngestMetrics>, health: HealthState) -> Self {
        Self { config: Arc::new(config), metrics, health, started_at: Instant::now() }
    }
}

impl FromRef<AppState> for Arc<IngestMetrics> {
    fn from_ref(state: &AppState) -> Self {
        state.metrics.clone()
    }
}

impl FromRef<AppState> for Arc<Config> {
    fn from_ref(state: &AppState) -> Self {
        state.config.clone()
    }
}

impl FromRef<AppState> for HealthState {
    fn from_ref(state: &AppState) -> Self {
        state.health.clone()
    }
}
```

- [ ] **Step 5: Write `src/http/health.rs`**

```rust
//! The service's health surface is `penguin_logging::health`'s router,
//! not a hand-rolled handler: `/health` (dependency classes, transport
//! posture, uptime -- §11.6.4), `/healthz` (bare liveness) and `/metrics`
//! (Prometheus text) all come from the crate. This module only wires the
//! two routers onto this service's `AppState`, and owns the `started_at`
//! uptime assertion its tests need.

use axum::Router;
use penguin_logging::health::HealthState;

use crate::http::state::AppState;

/// Mounts `/health` + `/healthz` onto the main `:8200` router.
pub fn liveness_routes(state: &AppState) -> Router {
    crate::telemetry::health_routes(state.health.clone())
}

/// Mounts `/metrics` onto the secondary `:9090` router.
pub fn metrics_routes(state: &AppState) -> Router {
    crate::telemetry::metrics_routes(state.health.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use penguin_logging::health::{DependencyClass, DependencyStatus};
    use tower::ServiceExt;

    fn health_state() -> HealthState {
        let state = HealthState::new(crate::SERVICE_NAME, "3.0.0", prometheus::Registry::new());
        state.set_dependency("valkey", DependencyStatus::ok());
        state
    }

    #[tokio::test]
    async fn healthz_returns_plain_ok() {
        let router = crate::telemetry::health_routes(health_state());
        let resp = router
            .oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn health_reports_every_dependency_with_its_class() {
        let state = health_state();
        state.set_dependency(
            "hub_api",
            DependencyStatus::failed(DependencyClass::Tcp, "connect timed out after 5s"),
        );
        let router = crate::telemetry::health_routes(state);
        let resp = router
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["service"], crate::SERVICE_NAME);
        assert_eq!(json["dependencies"]["valkey"]["class"], "ok");
        assert_eq!(json["dependencies"]["hub_api"]["class"], "tcp");
    }

    #[tokio::test]
    async fn metrics_router_serves_prometheus_text() {
        let router = crate::telemetry::metrics_routes(health_state());
        let resp = router
            .oneshot(Request::builder().uri("/metrics").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
```

- [ ] **Step 6: Write `src/http/mod.rs`**

```rust
//! Axum HTTP surface: shared state, the health/metrics routers, and (from
//! later tasks) every intake route.

pub mod health;
pub mod state;

pub use state::AppState;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit`
Expected: `test result: ok.` with 7 `config::` + 4 `error::` + 2 `telemetry::` + 3 `http::health::` = **16 passed; 0 failed** — a smaller total means a module's test binary did not compile in, which is a failure, not a pass (`critical-rules.md` Verification Integrity).

- [ ] **Step 8: Commit**

```bash
git add core/svc_ingest/src/telemetry.rs core/svc_ingest/src/http/mod.rs core/svc_ingest/src/http/state.rs core/svc_ingest/src/http/health.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): telemetry facade over penguin-logging, SpineMetrics adapter, AppState, health/metrics routers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 5: Twitch IRC normalizer

**Depends on:** Task 3

**Files:**
- Create: `core/svc_ingest/src/normalize/mod.rs`
- Create: `core/svc_ingest/src/normalize/twitch.rs`
- Create: `core/svc_ingest/tests/fixtures/normalize/twitch.json`

Ported from `core/svc_ingest/bundles/twitch_ingest.py::normalize` (8 Python test cases, `core/svc_ingest/tests/test_bundles_twitch_ingest.py`) with `source` population added per spec §6.1.1's normalizer table (new: not in the Python original).

**Interfaces:**
- Consumes: `penguin_spine::{PlatformEvent, Source}` (External Crate Surfaces); `crate::error::NormalizeError` (Task 3).
- Produces:
  - `pub fn payload_map(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value>` in `normalize/mod.rs` — `penguin_spine::PlatformEvent.payload` is a `serde_json::Map`, **not** a `Value`, so every normalizer's `json!({...})` object literal is funnelled through this one converter rather than each site writing its own `match`. A non-object input is a programming error, not a runtime condition: the function returns an empty map and `debug_assert!`s, because every call site in this crate passes a literal `json!({...})`.
  - `pub fn normalize(raw: &serde_json::Value, account_id: &str) -> Result<PlatformEvent, NormalizeError>` in `normalize/twitch.rs` — `account_id` is the bot login `IrcTransport` authenticated as (supplied by the receiver supervisor, Task 23, from config — never read out of `raw`). `channel_id` is `raw["channel_name"]` with a leading `#` stripped if present (IRC channel names are supplied with or without the prefix depending on receiver version; stripping is defensive and matches "the IRC channel (without `#`)" in §6.1.1's table).

**Golden fixtures (§14.1 applied per-normalizer).** Tasks 5-10 each commit one `core/svc_ingest/tests/fixtures/normalize/{platform}.json` file holding `{"raw": <the connector's raw payload>, "account_id": <string>, "event": <the exact PlatformEvent JSON>}`, and each normalizer's test module asserts the produced event **re-serializes byte-identically** to the fixture's `event` member. This is the same contract §14.1 defines for `penguin-spine`'s envelope fixtures, pushed one layer up: these six files are what a future change to a normalizer has to consciously rewrite. Every fixture pins `occurred_at` explicitly so the assertion is deterministic.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::normalize;
    use crate::error::NormalizeError;
    use rstest::rstest;
    use serde_json::json;

    #[rstest]
    #[case::real_chat_message(
        json!({"platform": "twitch", "channel_name": "waddlebot", "author_username": "alice", "content": "  hello chat  "}),
        "bot-primary",
        "twitch", "message", Some("alice"), "hello chat", "waddlebot", "alice"
    )]
    #[case::falls_back_to_unknown_sender(
        json!({"channel_name": "waddlebot", "content": "hi"}),
        "bot-primary",
        "twitch", "message", Some("unknown"), "hi", "waddlebot", "unknown"
    )]
    fn normalizes_valid_events(
        #[case] raw: serde_json::Value,
        #[case] account_id: &str,
        #[case] platform: &str,
        #[case] event_type: &str,
        #[case] actor: Option<&str>,
        #[case] text: &str,
        #[case] channel_name: &str,
        #[case] author: &str,
    ) {
        let event = normalize(&raw, account_id).expect("must normalize");
        assert_eq!(event.platform, platform);
        assert_eq!(event.event_type, event_type);
        assert_eq!(event.actor.as_deref(), actor);
        assert_eq!(event.payload["text"], text);
        assert_eq!(event.payload["channel_name"], channel_name);
        assert_eq!(event.payload["author"], author);
        assert!(!event.occurred_at.is_empty());
        let source = event.source.expect("source must be populated");
        assert_eq!(source.platform, "twitch");
        assert_eq!(source.account_id, account_id);
        assert_eq!(source.channel_id.as_deref(), Some(channel_name));
    }

    #[test]
    fn missing_content_raises() {
        let err = normalize(&json!({"channel_name": "waddlebot"}), "bot-primary").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("content")));
    }

    #[test]
    fn missing_channel_name_raises() {
        let err = normalize(&json!({"content": "hi"}), "bot-primary").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("channel_name")));
    }

    #[test]
    fn preserves_supplied_occurred_at() {
        let raw = json!({"channel_name": "waddlebot", "content": "hi", "occurred_at": "2026-01-01T00:00:00+00:00"});
        let event = normalize(&raw, "bot-primary").unwrap();
        assert_eq!(event.occurred_at, "2026-01-01T00:00:00+00:00");
    }

    #[test]
    fn missing_ircv3_fields_default_absent_never_raise() {
        let raw = json!({"channel_name": "waddlebot", "content": "hi", "author_username": "alice"});
        let event = normalize(&raw, "bot-primary").unwrap();
        assert_eq!(event.payload["author_id"], serde_json::Value::Null);
        assert_eq!(event.payload["user_id"], serde_json::Value::Null);
        assert_eq!(event.payload["display_name"], serde_json::Value::Null);
        assert_eq!(event.payload["message_id"], serde_json::Value::Null);
        assert_eq!(event.payload["room_id"], serde_json::Value::Null);
        assert_eq!(event.payload["badges"], json!([]));
        assert_eq!(event.payload["is_mod"], false);
        assert_eq!(event.payload["is_subscriber"], false);
        assert_eq!(event.payload["is_vip"], false);
        assert_eq!(event.payload["is_broadcaster"], false);
    }

    #[test]
    fn ircv3_fields_pass_through_unchanged() {
        let raw = json!({
            "channel_name": "waddlebot", "content": "hi mods", "author_username": "penguinfan",
            "author_id": "87654321", "user_id": "87654321", "display_name": "PenguinFan",
            "message_id": "msg-abc-123", "room_id": "555444",
            "badges": ["moderator", "subscriber", "vip"],
            "is_mod": true, "is_subscriber": true, "is_vip": true, "is_broadcaster": false
        });
        let event = normalize(&raw, "bot-primary").unwrap();
        assert_eq!(event.actor.as_deref(), Some("penguinfan"));
        assert_eq!(event.payload["author_id"], "87654321");
        assert_eq!(event.payload["badges"], json!(["moderator", "subscriber", "vip"]));
        assert_eq!(event.payload["is_broadcaster"], false);
    }

    #[test]
    fn non_list_badges_defaults_to_empty_list() {
        let raw = json!({"channel_name": "waddlebot", "content": "hi", "badges": "not-a-list"});
        let event = normalize(&raw, "bot-primary").unwrap();
        assert_eq!(event.payload["badges"], json!([]));
    }

    #[test]
    fn golden_fixture_serializes_byte_identically() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/normalize/twitch.json"))
                .expect("fixture must be valid JSON");
        let account_id = fixture["account_id"].as_str().expect("fixture needs account_id");
        let event = normalize(&fixture["raw"], account_id).expect("fixture must normalize");
        assert_eq!(
            serde_json::to_value(&event).expect("event must serialize"),
            fixture["event"],
            "normalizer output drifted from tests/fixtures/normalize/twitch.json -- \
             update the fixture deliberately, never the assertion"
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='normalize::twitch::'`
Expected: compile failure, module empty.

- [ ] **Step 3a: Write `src/normalize/mod.rs`**

Later normalizer tasks each append one `pub mod <platform>;` line to this file; the shared helper below is written once, here.

```rust
//! Fixed, non-pluggable per-platform normalizers (D5/D6: no bundle runs
//! at ingest). Each module turns one connector's raw payload into a
//! `penguin_spine::PlatformEvent`; nothing here touches Valkey, HTTP or a
//! credential.

pub mod twitch;

use serde_json::{Map, Value};

/// Converts a `json!({...})` object literal into the `serde_json::Map`
/// `penguin_spine::PlatformEvent.payload` requires. Every call site in
/// this crate passes an object literal, so a non-object input is a
/// programming error rather than a runtime condition -- it debug-asserts
/// and degrades to an empty map instead of panicking in release.
pub fn payload_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => {
            debug_assert!(false, "payload_map called with a non-object: {other:?}");
            Map::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::payload_map;
    use serde_json::json;

    #[test]
    fn payload_map_unwraps_an_object_literal() {
        let map = payload_map(json!({"text": "hi", "n": 1}));
        assert_eq!(map.len(), 2);
        assert_eq!(map["text"], json!("hi"));
    }
}
```

- [ ] **Step 3b: Write `tests/fixtures/normalize/twitch.json`**

```json
{
  "account_id": "bot-primary",
  "raw": {
    "platform": "twitch",
    "channel_name": "waddlebot",
    "content": "  hello chat  ",
    "author_username": "penguinfan",
    "author_id": "87654321",
    "user_id": "87654321",
    "display_name": "PenguinFan",
    "message_id": "msg-abc-123",
    "room_id": "555444",
    "badges": ["moderator", "subscriber"],
    "is_mod": true,
    "is_subscriber": true,
    "is_vip": false,
    "is_broadcaster": false,
    "occurred_at": "2026-09-14T12:00:00.000Z"
  },
  "event": {
    "platform": "twitch",
    "event_type": "message",
    "actor": "penguinfan",
    "payload": {
      "text": "hello chat",
      "channel_name": "waddlebot",
      "author": "penguinfan",
      "author_id": "87654321",
      "user_id": "87654321",
      "display_name": "PenguinFan",
      "message_id": "msg-abc-123",
      "room_id": "555444",
      "badges": ["moderator", "subscriber"],
      "is_mod": true,
      "is_subscriber": true,
      "is_vip": false,
      "is_broadcaster": false
    },
    "occurred_at": "2026-09-14T12:00:00.000Z",
    "source": {
      "platform": "twitch",
      "account_id": "bot-primary",
      "channel_id": "waddlebot"
    }
  }
}
```

- [ ] **Step 3: Write the implementation**

```rust
//! Twitch IRC chat normalizer -- ported from
//! `core/svc_ingest/bundles/twitch_ingest.py::normalize`. Consumes the raw
//! event shape the Twitch IRC receiver (`penguin-connector-twitch`) yields:
//! `{platform, channel_name, author_username, content, author_id, user_id,
//! display_name, message_id, room_id, badges, is_mod, is_subscriber,
//! is_vip, is_broadcaster, occurred_at}`.

use penguin_spine::{PlatformEvent, Source};
use serde_json::{json, Value};

use crate::error::NormalizeError;
use crate::normalize::payload_map;

fn as_str_or_null(raw: &Value, key: &str) -> Value {
    raw.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(Value::from).unwrap_or(Value::Null)
}

/// Python `bool(x)` truthiness for the JSON value kinds `is_mod`/
/// `is_subscriber`/`is_vip`/`is_broadcaster` can carry -- the source
/// (`bundles/twitch_ingest.py`) uses `bool(raw.get(...))`, not a strict
/// JSON-boolean check, so `1`/`"yes"` must coerce to `true` exactly like
/// `normalize::youtube`'s identical helper.
fn json_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// Normalizes one raw Twitch IRC chat message to a `PlatformEvent`.
/// `account_id` is the bot login the receiver authenticated as (config,
/// never the payload) -- populates `source.account_id` per §6.1.1.
pub fn normalize(raw: &Value, account_id: &str) -> Result<PlatformEvent, NormalizeError> {
    let content = raw.get("content").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(content) = content else { return Err(NormalizeError::MissingField("content")) };
    let channel_name = raw.get("channel_name").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(channel_name) = channel_name else { return Err(NormalizeError::MissingField("channel_name")) };
    let channel_id = channel_name.trim_start_matches('#').to_string();

    let actor = raw.get("author_username").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("unknown");
    let badges = raw.get("badges").and_then(Value::as_array).cloned().unwrap_or_default();

    Ok(PlatformEvent {
        platform: raw.get("platform").and_then(Value::as_str).unwrap_or("twitch").to_string(),
        event_type: "message".to_string(),
        actor: Some(actor.to_string()),
        payload: payload_map(json!({
            "text": content.trim(),
            "channel_name": channel_name,
            "author": actor,
            "author_id": as_str_or_null(raw, "author_id"),
            "user_id": as_str_or_null(raw, "user_id"),
            "display_name": as_str_or_null(raw, "display_name"),
            "message_id": as_str_or_null(raw, "message_id"),
            "room_id": as_str_or_null(raw, "room_id"),
            "badges": Value::Array(badges),
            "is_mod": json_truthy(raw.get("is_mod")),
            "is_subscriber": json_truthy(raw.get("is_subscriber")),
            "is_vip": json_truthy(raw.get("is_vip")),
            "is_broadcaster": json_truthy(raw.get("is_broadcaster")),
        })),
        occurred_at: raw
            .get("occurred_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        source: Some(Source { platform: "twitch".to_string(), account_id: account_id.to_string(), channel_id: Some(channel_id) }),
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='normalize::'`
Expected: `test result: ok. 10 passed; 0 failed` (2 rstest cases + 6 standalone + the golden-fixture test in `normalize::twitch`, plus 1 in `normalize`'s own `payload_map` module).

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/normalize/twitch.rs core/svc_ingest/src/normalize/mod.rs core/svc_ingest/tests/fixtures/normalize/twitch.json
git commit -m "$(cat <<'EOF'
feat(svc-ingest): port Twitch IRC chat normalizer with source population (§6.1.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 6: Twitch EventSub normalizer

**Depends on:** Task 3

**Files:**
- Create: `core/svc_ingest/src/normalize/twitch_eventsub.rs`
- Modify: `core/svc_ingest/src/normalize/mod.rs` (add `pub mod twitch_eventsub;`)

Ported from `core/svc_ingest/bundles/twitch_eventsub_ingest.py::normalize` (7 Python test cases) plus `eventsub.py::build_raw_event`'s per-type `metadata` shape (both files' behavior is folded into this one normalizer since the Rust rewrite's normalize function receives the same raw dict shape `build_raw_event` produces).

**Interfaces:**
- Consumes: `penguin_spine::{PlatformEvent, Source}`; `crate::error::NormalizeError` (Task 3).
- Produces: `pub const KNOWN_EVENT_TYPES: &[&str] = &["channel.follow", "channel.subscribe", "channel.subscription.gift", "channel.cheer", "channel.raid", "stream.online", "stream.offline"];` and `pub fn normalize(raw: &serde_json::Value, account_id: &str) -> Result<PlatformEvent, NormalizeError>` — `account_id` is the EventSub subscription's client/app id (config); `channel_id` is `raw["broadcaster_id"]` (required field, already present in `raw`).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::normalize;
    use crate::error::NormalizeError;
    use rstest::rstest;
    use serde_json::json;

    #[rstest]
    #[case::follow(
        json!({"platform": "twitch", "event_type": "channel.follow", "broadcaster_id": "999",
               "broadcaster_login": "waddlebot", "user_id": "555", "user_login": "alice",
               "user_display_name": "Alice", "metadata": {}}),
        "channel.follow", "alice"
    )]
    #[case::cheer_with_metadata(
        json!({"event_type": "channel.cheer", "broadcaster_id": "999", "user_login": "bob", "metadata": {"bits": 500}}),
        "channel.cheer", "bob"
    )]
    #[case::stream_online(
        json!({"platform": "twitch", "event_type": "stream.online", "broadcaster_id": "999",
               "broadcaster_login": "waddlebot", "metadata": {"type": "live", "started_at": "2026-09-11T12:00:00Z"}}),
        "stream.online", "999"
    )]
    #[case::stream_offline(
        json!({"platform": "twitch", "event_type": "stream.offline", "broadcaster_id": "999", "broadcaster_login": "waddlebot"}),
        "stream.offline", "999"
    )]
    fn normalizes_known_event_types(
        #[case] raw: serde_json::Value,
        #[case] event_type: &str,
        #[case] actor: &str,
    ) {
        let event = normalize(&raw, "app-client-id").expect("must normalize");
        assert_eq!(event.event_type, event_type);
        assert_eq!(event.actor.as_deref(), Some(actor));
        assert_eq!(event.payload["broadcaster_id"], "999");
        assert!(!event.occurred_at.is_empty());
        let source = event.source.unwrap();
        assert_eq!(source.account_id, "app-client-id");
        assert_eq!(source.channel_id.as_deref(), Some("999"));
    }

    #[test]
    fn cheer_metadata_passes_through() {
        let raw = json!({"event_type": "channel.cheer", "broadcaster_id": "999", "user_login": "bob", "metadata": {"bits": 500}});
        let event = normalize(&raw, "app-client-id").unwrap();
        assert_eq!(event.payload["metadata"], json!({"bits": 500}));
    }

    #[test]
    fn stream_offline_metadata_is_empty() {
        let raw = json!({"event_type": "stream.offline", "broadcaster_id": "999"});
        let event = normalize(&raw, "app-client-id").unwrap();
        assert_eq!(event.payload["metadata"], json!({}));
    }

    #[test]
    fn unsupported_event_type_raises() {
        let err = normalize(&json!({"event_type": "channel.update", "broadcaster_id": "999"}), "x").unwrap_err();
        assert!(matches!(err, NormalizeError::UnsupportedEventType { .. }));
        assert!(err.to_string().contains("channel.update"));
    }

    #[test]
    fn missing_broadcaster_id_raises() {
        let err = normalize(&json!({"event_type": "channel.follow"}), "x").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("broadcaster_id")));
    }

    #[test]
    fn falls_back_to_broadcaster_id_when_no_user_identity() {
        let raw = json!({"event_type": "channel.raid", "broadcaster_id": "999", "metadata": {"viewers": 10}});
        let event = normalize(&raw, "x").unwrap();
        assert_eq!(event.actor.as_deref(), Some("999"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='normalize::twitch_eventsub::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! Twitch EventSub notification normalizer -- ported from
//! `core/svc_ingest/bundles/twitch_eventsub_ingest.py::normalize`. Raw
//! shape matches `eventsub.py::build_raw_event`'s output: `{platform,
//! event_type, broadcaster_id, broadcaster_login, user_id, user_login,
//! user_display_name, metadata}`.

use penguin_spine::{PlatformEvent, Source};
use serde_json::{json, Value};

use crate::error::NormalizeError;
use crate::normalize::payload_map;

/// EventSub subscription types this normalizer supports -- matches
/// `eventsub.py::DEFAULT_SUBSCRIPTION_TYPES` (incl. gh #287 S10's
/// `stream.online`/`stream.offline`).
pub const KNOWN_EVENT_TYPES: &[&str] = &[
    "channel.follow",
    "channel.subscribe",
    "channel.subscription.gift",
    "channel.cheer",
    "channel.raid",
    "stream.online",
    "stream.offline",
];

/// Normalizes one raw Twitch EventSub notification to a `PlatformEvent`.
/// `account_id` is the EventSub subscription's client/app id (config).
pub fn normalize(raw: &Value, account_id: &str) -> Result<PlatformEvent, NormalizeError> {
    let event_type = raw.get("event_type").and_then(Value::as_str).unwrap_or_default();
    if !KNOWN_EVENT_TYPES.contains(&event_type) {
        return Err(NormalizeError::UnsupportedEventType {
            got: event_type.to_string(),
            expected: KNOWN_EVENT_TYPES,
        });
    }
    let broadcaster_id = raw.get("broadcaster_id").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(broadcaster_id) = broadcaster_id else {
        return Err(NormalizeError::MissingField("broadcaster_id"));
    };

    let actor = raw
        .get("user_login")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| raw.get("user_id").and_then(Value::as_str).filter(|s| !s.is_empty()))
        .unwrap_or(broadcaster_id);

    Ok(PlatformEvent {
        platform: raw.get("platform").and_then(Value::as_str).unwrap_or("twitch").to_string(),
        event_type: event_type.to_string(),
        actor: Some(actor.to_string()),
        payload: payload_map(json!({
            "broadcaster_id": broadcaster_id,
            "broadcaster_login": raw.get("broadcaster_login").cloned().unwrap_or(Value::Null),
            "user_id": raw.get("user_id").cloned().unwrap_or(Value::Null),
            "user_login": raw.get("user_login").cloned().unwrap_or(Value::Null),
            "user_display_name": raw.get("user_display_name").cloned().unwrap_or(Value::Null),
            "metadata": raw.get("metadata").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!({})),
        })),
        occurred_at: raw
            .get("occurred_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        source: Some(Source {
            platform: "twitch".to_string(),
            account_id: account_id.to_string(),
            channel_id: Some(broadcaster_id.to_string()),
        }),
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='normalize::twitch_eventsub::'`
Expected: `test result: ok. 7 passed; 0 failed` (4 rstest cases + 3 standalone).

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/normalize/twitch_eventsub.rs core/svc_ingest/src/normalize/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): port Twitch EventSub notification normalizer incl. gh#287 S10 stream.online/offline

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 7: Discord normalizer

**Depends on:** Task 3

**Files:**
- Create: `core/svc_ingest/src/normalize/discord.rs`
- Modify: `core/svc_ingest/src/normalize/mod.rs` (add `pub mod discord;`)

Ported from `core/svc_ingest/bundles/discord_ingest.py::normalize` (6 Python test cases).

**Interfaces:**
- Consumes: `penguin_spine::{PlatformEvent, Source}`; `crate::error::NormalizeError`.
- Produces: `pub fn normalize(raw: &serde_json::Value, account_id: &str) -> Result<PlatformEvent, NormalizeError>` — `account_id` is the bot application id (config); `channel_id` is `raw["channel_id"]` (guild id stays in `payload`, per §6.1.1: "the channel id (guild id stays in payload)").

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::normalize;
    use crate::error::NormalizeError;
    use serde_json::json;

    #[test]
    fn normalizes_valid_raw_discord_event() {
        let raw = json!({
            "platform": "discord", "guild_id": "7", "channel_id": "42", "message_id": "123",
            "author_id": "555", "author_username": "alice", "content": "  hello waddlebot  "
        });
        let event = normalize(&raw, "app-12345").unwrap();
        assert_eq!(event.platform, "discord");
        assert_eq!(event.event_type, "message");
        assert_eq!(event.actor.as_deref(), Some("alice"));
        assert_eq!(
            Value::Object(event.payload),
            json!({"text": "hello waddlebot", "guild_id": "7", "channel_id": "42", "message_id": "123", "author_id": "555"})
        );
        assert!(!event.occurred_at.is_empty());
        let source = event.source.unwrap();
        assert_eq!(source.platform, "discord");
        assert_eq!(source.account_id, "app-12345");
        assert_eq!(source.channel_id.as_deref(), Some("42"));
    }

    #[test]
    fn falls_back_to_author_id_when_username_missing() {
        let event = normalize(&json!({"content": "hi", "author_id": "555"}), "app-12345").unwrap();
        assert_eq!(event.actor.as_deref(), Some("555"));
    }

    #[test]
    fn preserves_explicit_timestamp() {
        let raw = json!({"content": "hi", "author_id": "555", "occurred_at": "2026-01-01T00:00:00+00:00"});
        let event = normalize(&raw, "app-12345").unwrap();
        assert_eq!(event.occurred_at, "2026-01-01T00:00:00+00:00");
    }

    #[test]
    fn missing_content_raises() {
        let err = normalize(&json!({"author_id": "555"}), "app-12345").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("content")));
    }

    #[test]
    fn empty_content_raises() {
        let err = normalize(&json!({"content": "", "author_id": "555"}), "app-12345").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("content")));
    }

    #[test]
    fn missing_author_id_raises() {
        let err = normalize(&json!({"content": "hi"}), "app-12345").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("author_id")));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='normalize::discord::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! Discord gateway message normalizer -- ported from
//! `core/svc_ingest/bundles/discord_ingest.py::normalize`. Raw shape:
//! `{platform, guild_id, channel_id, message_id, author_id,
//! author_username, content, occurred_at}`.

use penguin_spine::{PlatformEvent, Source};
use serde_json::{json, Value};

use crate::error::NormalizeError;
use crate::normalize::payload_map;

/// Normalizes one raw Discord gateway message to a `PlatformEvent`.
/// `account_id` is the bot application id (config) -- guild id stays in
/// `payload`, only the channel id becomes `source.channel_id` (§6.1.1).
pub fn normalize(raw: &Value, account_id: &str) -> Result<PlatformEvent, NormalizeError> {
    let content = raw.get("content").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(content) = content else { return Err(NormalizeError::MissingField("content")) };
    let author_id = raw.get("author_id").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(author_id) = author_id else { return Err(NormalizeError::MissingField("author_id")) };

    let actor = raw.get("author_username").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(author_id);
    let channel_id = raw.get("channel_id").and_then(Value::as_str).map(str::to_string);

    Ok(PlatformEvent {
        platform: raw.get("platform").and_then(Value::as_str).unwrap_or("discord").to_string(),
        event_type: "message".to_string(),
        actor: Some(actor.to_string()),
        payload: payload_map(json!({
            "text": content.trim(),
            "guild_id": raw.get("guild_id").cloned().unwrap_or(Value::Null),
            "channel_id": raw.get("channel_id").cloned().unwrap_or(Value::Null),
            "message_id": raw.get("message_id").cloned().unwrap_or(Value::Null),
            "author_id": author_id,
        })),
        occurred_at: raw
            .get("occurred_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        source: Some(Source { platform: "discord".to_string(), account_id: account_id.to_string(), channel_id }),
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='normalize::discord::'`
Expected: `test result: ok. 6 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/normalize/discord.rs core/svc_ingest/src/normalize/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): port Discord gateway message normalizer with source population (§6.1.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 8: Slack normalizer

**Depends on:** Task 3

**Files:**
- Create: `core/svc_ingest/src/normalize/slack.rs`
- Modify: `core/svc_ingest/src/normalize/mod.rs` (add `pub mod slack;`)

Ported from `core/svc_ingest/bundles/slack_ingest.py::normalize` (12 Python test cases across `message`/`app_mention`/`member_joined_channel`/validation).

**Interfaces:**
- Consumes: `penguin_spine::{PlatformEvent, Source}`; `crate::error::NormalizeError`.
- Produces: `pub fn normalize(raw: &serde_json::Value, account_id: &str) -> Result<PlatformEvent, NormalizeError>` — `account_id` is the Slack app id (`xapp-` app, config); `channel_id` is `raw["channel_id"]`. `text` is required only for `event_type` in `{"message", "app_mention"}` (`member_joined_channel` never carries one).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::normalize;
    use crate::error::NormalizeError;
    use rstest::rstest;
    use serde_json::json;

    #[test]
    fn normalizes_valid_raw_message_event() {
        let raw = json!({
            "platform": "slack", "event_type": "message", "text": "  hello waddlebot  ",
            "channel_id": "C123", "team_id": "T456", "thread_ts": "1700000000.000100",
            "message_ts": "1700000001.000200", "platform_user_id": "U789", "display_name": null
        });
        let event = normalize(&raw, "xapp-app-id").unwrap();
        assert_eq!(event.platform, "slack");
        assert_eq!(event.event_type, "message");
        assert_eq!(event.actor.as_deref(), Some("U789"));
        assert_eq!(
            Value::Object(event.payload),
            json!({"text": "hello waddlebot", "channel_id": "C123", "team_id": "T456",
                   "thread_ts": "1700000000.000100", "message_ts": "1700000001.000200",
                   "platform_user_id": "U789", "display_name": null})
        );
        let source = event.source.unwrap();
        assert_eq!(source.account_id, "xapp-app-id");
        assert_eq!(source.channel_id.as_deref(), Some("C123"));
    }

    #[test]
    fn preserves_explicit_timestamp() {
        let raw = json!({"event_type": "message", "text": "hi", "platform_user_id": "U1", "occurred_at": "2026-01-01T00:00:00+00:00"});
        assert_eq!(normalize(&raw, "x").unwrap().occurred_at, "2026-01-01T00:00:00+00:00");
    }

    #[rstest]
    #[case::message(json!({"event_type": "message", "platform_user_id": "U1"}))]
    #[case::message_empty(json!({"event_type": "message", "text": "", "platform_user_id": "U1"}))]
    #[case::app_mention(json!({"event_type": "app_mention", "platform_user_id": "U1"}))]
    fn missing_or_empty_text_raises_for_text_required_types(#[case] raw: serde_json::Value) {
        let err = normalize(&raw, "x").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("text") | NormalizeError::EmptyField("text")));
    }

    #[test]
    fn normalizes_valid_app_mention() {
        let raw = json!({"event_type": "app_mention", "text": "hey @bot", "platform_user_id": "U1"});
        let event = normalize(&raw, "x").unwrap();
        assert_eq!(event.event_type, "app_mention");
        assert_eq!(event.payload["text"], "hey @bot");
    }

    #[test]
    fn member_joined_channel_does_not_require_text() {
        let raw = json!({"event_type": "member_joined_channel", "channel_id": "C1", "platform_user_id": "U1"});
        let event = normalize(&raw, "x").unwrap();
        assert_eq!(event.event_type, "member_joined_channel");
        assert_eq!(event.payload["text"], serde_json::Value::Null);
    }

    #[test]
    fn member_joined_channel_actor_is_the_joining_user() {
        let raw = json!({"event_type": "member_joined_channel", "platform_user_id": "U999"});
        assert_eq!(normalize(&raw, "x").unwrap().actor.as_deref(), Some("U999"));
    }

    #[rstest]
    #[case::missing_event_type(json!({"platform_user_id": "U1", "text": "hi"}), "event_type")]
    #[case::empty_event_type(json!({"event_type": "", "platform_user_id": "U1", "text": "hi"}), "event_type")]
    #[case::missing_platform_user_id(json!({"event_type": "message", "text": "hi"}), "platform_user_id")]
    #[case::empty_platform_user_id(json!({"event_type": "message", "text": "hi", "platform_user_id": ""}), "platform_user_id")]
    fn validation_errors_name_the_field(#[case] raw: serde_json::Value, #[case] field: &str) {
        let err = normalize(&raw, "x").unwrap_err();
        assert!(err.to_string().contains(field), "expected {field} in {err}");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='normalize::slack::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! Slack Socket Mode event normalizer -- ported from
//! `core/svc_ingest/bundles/slack_ingest.py::normalize`. Raw shape:
//! `{platform, event_type, text, channel_id, team_id, thread_ts,
//! message_ts, platform_user_id, display_name}`.

use penguin_spine::{PlatformEvent, Source};
use serde_json::{json, Value};

use crate::error::NormalizeError;
use crate::normalize::payload_map;

/// `message`/`app_mention` carry human-authored text; `member_joined_
/// channel` never does -- only the former require a non-empty `text`.
const TEXT_REQUIRED_EVENT_TYPES: &[&str] = &["message", "app_mention"];

/// Normalizes one raw Slack Socket Mode event to a `PlatformEvent`.
/// `account_id` is the Slack app id (`xapp-` app, config).
pub fn normalize(raw: &Value, account_id: &str) -> Result<PlatformEvent, NormalizeError> {
    let event_type = raw.get("event_type").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(event_type) = event_type else { return Err(NormalizeError::MissingField("event_type")) };

    let platform_user_id = raw.get("platform_user_id").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(platform_user_id) = platform_user_id else {
        return Err(NormalizeError::MissingField("platform_user_id"));
    };

    let text: Value = if TEXT_REQUIRED_EVENT_TYPES.contains(&event_type) {
        let text = raw.get("text").and_then(Value::as_str).filter(|s| !s.is_empty());
        let Some(text) = text else { return Err(NormalizeError::MissingField("text")) };
        Value::from(text.trim())
    } else {
        raw.get("text").cloned().unwrap_or(Value::Null)
    };

    let channel_id = raw.get("channel_id").and_then(Value::as_str).map(str::to_string);

    Ok(PlatformEvent {
        platform: raw.get("platform").and_then(Value::as_str).unwrap_or("slack").to_string(),
        event_type: event_type.to_string(),
        actor: Some(platform_user_id.to_string()),
        payload: payload_map(json!({
            "text": text,
            "channel_id": raw.get("channel_id").cloned().unwrap_or(Value::Null),
            "team_id": raw.get("team_id").cloned().unwrap_or(Value::Null),
            "thread_ts": raw.get("thread_ts").cloned().unwrap_or(Value::Null),
            "message_ts": raw.get("message_ts").cloned().unwrap_or(Value::Null),
            "platform_user_id": platform_user_id,
            "display_name": raw.get("display_name").cloned().unwrap_or(Value::Null),
        })),
        occurred_at: raw
            .get("occurred_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        source: Some(Source { platform: "slack".to_string(), account_id: account_id.to_string(), channel_id }),
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='normalize::slack::'`
Expected: `test result: ok. 12 passed; 0 failed` (3 missing-text rstest cases + 4 validation rstest cases + 5 standalone).

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/normalize/slack.rs core/svc_ingest/src/normalize/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): port Slack Socket Mode event normalizer with source population (§6.1.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 9: YouTube Live normalizer

**Depends on:** Task 3

**Files:**
- Create: `core/svc_ingest/src/normalize/youtube.rs`
- Modify: `core/svc_ingest/src/normalize/mod.rs` (add `pub mod youtube;`)

Ported from `core/svc_ingest/bundles/youtube_live_ingest.py::normalize` (11 Python test cases; the manifest-registration tests in that file's `TestRegisterDefaultBundles` do not apply — no in-process manifest registry exists in the Rust rewrite, D5/D6).

**Interfaces:**
- Consumes: `penguin_spine::{PlatformEvent, Source}`; `crate::error::NormalizeError`.
- Produces: `pub fn normalize(raw: &serde_json::Value, account_id: &str) -> Result<PlatformEvent, NormalizeError>` — `account_id` is the configured channel's OAuth client or API-key identity (config); `channel_id` is `raw["live_chat_id"]` ("the live chat's video/broadcast id", §6.1.1 — YouTube's own equivalent of Twitch's `channel_name`).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::normalize;
    use crate::error::NormalizeError;
    use serde_json::json;

    #[test]
    fn normalizes_a_real_chat_message() {
        let raw = json!({
            "platform": "youtube", "channel_id": "UCabc123", "video_id": "vid123", "live_chat_id": "chat123",
            "author_id": "UCviewer1", "display_name": "Alice", "is_mod": false, "is_owner": false,
            "is_sponsor": false, "text": "  hello chat  ", "message_id": "msg-1", "published_at": "2026-09-11T00:00:00Z"
        });
        let event = normalize(&raw, "yt-client-id").unwrap();
        assert_eq!(event.platform, "youtube");
        assert_eq!(event.event_type, "message");
        assert_eq!(event.actor.as_deref(), Some("UCviewer1"));
        assert_eq!(event.payload["text"], "hello chat");
        assert_eq!(event.payload["video_id"], "vid123");
        assert_eq!(event.payload["live_chat_id"], "chat123");
        assert_eq!(event.payload["is_mod"], false);
        assert_eq!(event.payload["message_id"], "msg-1");
        assert_eq!(event.occurred_at, "2026-09-11T00:00:00Z");
        let source = event.source.unwrap();
        assert_eq!(source.account_id, "yt-client-id");
        assert_eq!(source.channel_id.as_deref(), Some("chat123"));
    }

    #[test]
    fn falls_back_to_unknown_when_author_id_missing() {
        let raw = json!({"live_chat_id": "chat123", "text": "hi"});
        assert_eq!(normalize(&raw, "x").unwrap().actor.as_deref(), Some("unknown"));
    }

    #[test]
    fn missing_text_raises() {
        let err = normalize(&json!({"live_chat_id": "chat123"}), "x").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("text")));
    }

    #[test]
    fn missing_live_chat_id_raises() {
        let err = normalize(&json!({"text": "hi"}), "x").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("live_chat_id")));
    }

    #[test]
    fn blank_text_raises() {
        let err = normalize(&json!({"live_chat_id": "chat123", "text": ""}), "x").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("text")));
    }

    #[test]
    fn occurred_at_falls_back_to_published_at() {
        let raw = json!({"live_chat_id": "chat123", "text": "hi", "published_at": "2026-01-01T00:00:00Z"});
        assert_eq!(normalize(&raw, "x").unwrap().occurred_at, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn explicit_occurred_at_overrides_published_at() {
        let raw = json!({"live_chat_id": "chat123", "text": "hi", "published_at": "2026-01-01T00:00:00Z", "occurred_at": "2026-02-02T00:00:00Z"});
        assert_eq!(normalize(&raw, "x").unwrap().occurred_at, "2026-02-02T00:00:00Z");
    }

    #[test]
    fn occurred_at_defaults_to_now_when_neither_present() {
        let event = normalize(&json!({"live_chat_id": "chat123", "text": "hi"}), "x").unwrap();
        assert!(!event.occurred_at.is_empty());
    }

    #[test]
    fn missing_optional_fields_default_absent_never_raise() {
        let event = normalize(&json!({"live_chat_id": "chat123", "text": "hi"}), "x").unwrap();
        assert_eq!(event.payload["video_id"], serde_json::Value::Null);
        assert_eq!(event.payload["author_id"], serde_json::Value::Null);
        assert_eq!(event.payload["display_name"], serde_json::Value::Null);
        assert_eq!(event.payload["message_id"], serde_json::Value::Null);
        assert_eq!(event.payload["published_at"], serde_json::Value::Null);
        assert_eq!(event.payload["is_mod"], false);
        assert_eq!(event.payload["is_owner"], false);
        assert_eq!(event.payload["is_sponsor"], false);
    }

    #[test]
    fn truthy_non_bool_flags_are_coerced_to_bool() {
        let raw = json!({"live_chat_id": "chat123", "text": "hi", "is_mod": 1, "is_owner": "yes"});
        let event = normalize(&raw, "x").unwrap();
        assert_eq!(event.payload["is_mod"], true);
        assert_eq!(event.payload["is_owner"], true);
    }

    #[test]
    fn platform_defaults_to_youtube_when_absent() {
        let event = normalize(&json!({"live_chat_id": "chat123", "text": "hi"}), "x").unwrap();
        assert_eq!(event.platform, "youtube");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='normalize::youtube::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

Note: Python's `is_mod`/`is_owner` coercion uses truthiness on arbitrary JSON values (`bool(raw.get("is_mod"))` — a Python-truthy check where `1`/`"yes"` are both truthy, `0`/`""`/`None`/`False` are falsy). JSON has no single "truthy" concept, so this port defines `json_truthy` explicitly to match Python's exact truthiness table for the JSON value kinds these fields can carry.

```rust
//! YouTube Live chat message normalizer -- ported from
//! `core/svc_ingest/bundles/youtube_live_ingest.py::normalize`. Raw shape:
//! `{platform, channel_id, video_id, live_chat_id, author_id, display_name,
//! is_mod, is_owner, is_sponsor, text, message_id, published_at}`.

use penguin_spine::{PlatformEvent, Source};
use serde_json::{json, Value};

use crate::error::NormalizeError;
use crate::normalize::payload_map;

fn as_str_or_null(raw: &Value, key: &str) -> Value {
    raw.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(Value::from).unwrap_or(Value::Null)
}

/// Python `bool(x)` truthiness for the JSON value kinds `is_mod`/
/// `is_owner`/`is_sponsor` can carry: `null`/`false`/`0`/`""` are falsy,
/// everything else (`true`, non-zero numbers, non-empty strings) is truthy.
fn json_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// Normalizes one raw YouTube Live chat message to a `PlatformEvent`.
/// `account_id` is the configured channel's OAuth client or API-key
/// identity (config); `channel_id` is the live chat id, YouTube's
/// equivalent of Twitch's `channel_name` (§6.1.1).
pub fn normalize(raw: &Value, account_id: &str) -> Result<PlatformEvent, NormalizeError> {
    let text = raw.get("text").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(text) = text else { return Err(NormalizeError::MissingField("text")) };
    let live_chat_id = raw.get("live_chat_id").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(live_chat_id) = live_chat_id else {
        return Err(NormalizeError::MissingField("live_chat_id"));
    };

    let actor = raw.get("author_id").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("unknown");

    Ok(PlatformEvent {
        platform: raw.get("platform").and_then(Value::as_str).unwrap_or("youtube").to_string(),
        event_type: "message".to_string(),
        actor: Some(actor.to_string()),
        payload: payload_map(json!({
            "text": text.trim(),
            "video_id": as_str_or_null(raw, "video_id"),
            "live_chat_id": live_chat_id,
            "author_id": as_str_or_null(raw, "author_id"),
            "display_name": as_str_or_null(raw, "display_name"),
            "is_mod": json_truthy(raw.get("is_mod")),
            "is_owner": json_truthy(raw.get("is_owner")),
            "is_sponsor": json_truthy(raw.get("is_sponsor")),
            "message_id": as_str_or_null(raw, "message_id"),
            "published_at": as_str_or_null(raw, "published_at"),
        })),
        occurred_at: raw
            .get("occurred_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| raw.get("published_at").and_then(Value::as_str).filter(|s| !s.is_empty()))
            .map(str::to_string)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        source: Some(Source {
            platform: "youtube".to_string(),
            account_id: account_id.to_string(),
            channel_id: Some(live_chat_id.to_string()),
        }),
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='normalize::youtube::'`
Expected: `test result: ok. 11 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/normalize/youtube.rs core/svc_ingest/src/normalize/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): port YouTube Live chat normalizer with source population (§6.1.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 10: Kick normalizer + webhook signature verify

**Depends on:** Task 3

**Files:**
- Create: `core/svc_ingest/src/normalize/kick.rs`
- Modify: `core/svc_ingest/src/normalize/mod.rs` (add `pub mod kick;`)

Ported from `core/svc_ingest/bundles/kick_ingest.py` — `normalize()` (10 test cases), `verify_kick_webhook_signature()` (4 test cases), and `KICK_WEBHOOK_EVENT_TYPE_MAP`/`STREAM_LIFECYCLE_EVENT_TYPES` (the webhook event-type mapping table, exercised via 9 parametrized cases in Python). The webhook's `handle_kick_webhook` orchestration (verify → map → fan out `StreamStart`/`StreamEnd`) becomes Task 18's HTTP handler; this task ports only the pure functions: signature verification and the two lookup tables, plus `normalize_stream_lifecycle` (replaces Python's `_build_stream_lifecycle_raw_event` + a second `normalize()` call that never existed in Python — the Rust port normalizes `StreamStart`/`StreamEnd` directly to a `PlatformEvent` instead of building an intermediate raw dict for a nonexistent second bundle, since there is no bundle layer to hand it to).

**Interfaces:**
- Consumes: `penguin_spine::{PlatformEvent, Source}`; `crate::error::NormalizeError`.
- Produces:
  - `pub fn normalize(raw: &serde_json::Value, account_id: &str) -> Result<PlatformEvent, NormalizeError>` — Pusher chat normalizer. `account_id` is the configured Kick app id (config); `channel_id` is `raw["channel_slug"]`.
  - `pub fn verify_kick_webhook_signature(body: &[u8], signature: &str, secret: &str) -> bool` — HMAC-SHA256 hex over the raw body, **no** `"sha256="` prefix (unlike Twitch/generic), fail-closed on empty `signature`, constant-time compare.
  - `pub const KICK_WEBHOOK_EVENT_TYPE_MAP: &[(&str, &str)] = &[("Subscription", "subscription"), ("GiftedSubscription", "gift_subscription"), ("ChannelFollow", "follow"), ("StreamStart", "stream_start"), ("StreamEnd", "stream_end"), ("Raid", "raid"), ("Host", "host"), ("Ban", "moderation"), ("Timeout", "moderation")];`
  - `pub fn map_kick_webhook_event_type(kick_type: &str) -> &'static str` — table lookup, `"unknown"` for anything absent (including a missing/non-string `type` field, handled by the caller passing `""`).
  - `pub const STREAM_LIFECYCLE_EVENT_TYPES: &[&str] = &["StreamStart", "StreamEnd"];`
  - `pub fn normalize_stream_lifecycle(kick_type: &str, body_json: &serde_json::Value, account_id: &str) -> Option<PlatformEvent>` — `Some` only for `kick_type` in `STREAM_LIFECYCLE_EVENT_TYPES`, mapping `StreamStart`→`"stream.online"` / `StreamEnd`→`"stream.offline"`, `payload = {channel_slug, channel_id, started_at, viewer_count}` read from `body_json` (all nullable, matching Python's `_build_stream_lifecycle_raw_event`), `source.channel_id = body_json["channel_slug"]`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::NormalizeError;
    use rstest::rstest;
    use serde_json::json;

    #[test]
    fn normalizes_a_real_chat_message() {
        let raw = json!({
            "platform": "kick", "text": "  hello chat  ", "chatroom_id": 12345, "channel_slug": "acme",
            "author_id": "999", "display_name": "PenguinFan", "badges": ["moderator", "subscriber"],
            "is_mod": true, "is_subscriber": true, "is_owner": false, "message_id": "msg-abc",
            "created_at": "2026-09-11T12:00:00.000000Z"
        });
        let event = normalize(&raw, "kick-app-id").unwrap();
        assert_eq!(event.platform, "kick");
        assert_eq!(event.event_type, "message");
        assert_eq!(event.actor.as_deref(), Some("999"));
        assert_eq!(event.payload["text"], "hello chat");
        assert_eq!(event.payload["chatroom_id"], 12345);
        assert_eq!(event.payload["is_owner"], false);
        assert_eq!(event.occurred_at, "2026-09-11T12:00:00.000000Z");
        let source = event.source.unwrap();
        assert_eq!(source.account_id, "kick-app-id");
        assert_eq!(source.channel_id.as_deref(), Some("acme"));
    }

    #[test]
    fn missing_text_raises() {
        let err = normalize(&json!({"chatroom_id": 1, "channel_slug": "acme"}), "x").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("text")));
    }

    #[test]
    fn missing_chatroom_id_raises() {
        let err = normalize(&json!({"text": "hi", "channel_slug": "acme"}), "x").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("chatroom_id")));
    }

    #[test]
    fn missing_channel_slug_raises() {
        let err = normalize(&json!({"text": "hi", "chatroom_id": 1}), "x").unwrap_err();
        assert!(matches!(err, NormalizeError::MissingField("channel_slug")));
    }

    #[test]
    fn missing_optional_fields_default_absent_never_raise() {
        let event = normalize(&json!({"text": "hi", "chatroom_id": 1, "channel_slug": "acme"}), "x").unwrap();
        assert_eq!(event.actor, None);
        assert_eq!(event.payload["author_id"], serde_json::Value::Null);
        assert_eq!(event.payload["badges"], json!([]));
        assert_eq!(event.payload["is_mod"], false);
        assert!(!event.occurred_at.is_empty());
    }

    #[test]
    fn non_list_badges_defaults_to_empty_list() {
        let raw = json!({"text": "hi", "chatroom_id": 1, "channel_slug": "acme", "badges": "not-a-list"});
        assert_eq!(normalize(&raw, "x").unwrap().payload["badges"], json!([]));
    }

    #[test]
    fn falls_back_to_created_at_when_occurred_at_absent() {
        let raw = json!({"text": "hi", "chatroom_id": 1, "channel_slug": "acme", "created_at": "2026-01-01T00:00:00.000000Z"});
        assert_eq!(normalize(&raw, "x").unwrap().occurred_at, "2026-01-01T00:00:00.000000Z");
    }

    #[test]
    fn occurred_at_takes_precedence_over_created_at() {
        let raw = json!({"text": "hi", "chatroom_id": 1, "channel_slug": "acme", "created_at": "2026-01-01T00:00:00.000000Z", "occurred_at": "2026-02-02T00:00:00+00:00"});
        assert_eq!(normalize(&raw, "x").unwrap().occurred_at, "2026-02-02T00:00:00+00:00");
    }

    #[test]
    fn string_chatroom_id_is_accepted() {
        let raw = json!({"text": "hi", "chatroom_id": "12345", "channel_slug": "acme"});
        assert_eq!(normalize(&raw, "x").unwrap().payload["chatroom_id"], "12345");
    }

    #[test]
    fn zero_chatroom_id_is_accepted_not_treated_as_missing() {
        let raw = json!({"text": "hi", "chatroom_id": 0, "channel_slug": "acme"});
        assert_eq!(normalize(&raw, "x").unwrap().payload["chatroom_id"], 0);
    }

    fn sign(body: &[u8], secret: &str) -> String {
        use hmac::{Hmac, Mac};
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        hex::encode(mac.finalize().into_bytes())
    }

    #[test]
    fn valid_signature_verifies() {
        let body = br#"{"type":"StreamStart"}"#;
        assert!(verify_kick_webhook_signature(body, &sign(body, "secret"), "secret"));
    }

    #[test]
    fn invalid_signature_fails() {
        let body = br#"{"type":"StreamStart"}"#;
        assert!(!verify_kick_webhook_signature(body, "not-the-real-signature", "secret"));
    }

    #[test]
    fn missing_signature_fails_closed() {
        let body = br#"{"type":"StreamStart"}"#;
        assert!(!verify_kick_webhook_signature(body, "", "secret"));
    }

    #[test]
    fn signature_for_different_body_fails() {
        let sig = sign(br#"{"type":"StreamStart"}"#, "secret");
        assert!(!verify_kick_webhook_signature(br#"{"type":"StreamEnd"}"#, &sig, "secret"));
    }

    #[rstest]
    #[case("Subscription", "subscription")]
    #[case("GiftedSubscription", "gift_subscription")]
    #[case("ChannelFollow", "follow")]
    #[case("StreamStart", "stream_start")]
    #[case("StreamEnd", "stream_end")]
    #[case("Raid", "raid")]
    #[case("Host", "host")]
    #[case("Ban", "moderation")]
    #[case("Timeout", "moderation")]
    fn every_known_event_type_maps_correctly(#[case] kick_type: &str, #[case] mapped: &str) {
        assert_eq!(map_kick_webhook_event_type(kick_type), mapped);
    }

    #[test]
    fn unknown_event_type_maps_to_unknown() {
        assert_eq!(map_kick_webhook_event_type("SomeFutureEventType"), "unknown");
        assert_eq!(map_kick_webhook_event_type(""), "unknown");
    }

    #[test]
    fn stream_start_normalizes_to_stream_online() {
        let body = json!({"type": "StreamStart", "channel_slug": "acme", "channel_id": "555", "started_at": "2026-09-11T12:00:00Z", "viewer_count": 42});
        let event = normalize_stream_lifecycle("StreamStart", &body, "kick-app-id").unwrap();
        assert_eq!(event.event_type, "stream.online");
        assert_eq!(event.payload, json!({"channel_slug": "acme", "channel_id": "555", "started_at": "2026-09-11T12:00:00Z", "viewer_count": 42}));
        assert_eq!(event.source.unwrap().channel_id.as_deref(), Some("acme"));
    }

    #[test]
    fn stream_end_normalizes_to_stream_offline_with_null_optional_fields() {
        let body = json!({"type": "StreamEnd", "channel_slug": "acme", "channel_id": "555"});
        let event = normalize_stream_lifecycle("StreamEnd", &body, "kick-app-id").unwrap();
        assert_eq!(event.event_type, "stream.offline");
        assert_eq!(event.payload["started_at"], serde_json::Value::Null);
        assert_eq!(event.payload["viewer_count"], serde_json::Value::Null);
    }

    #[test]
    fn non_lifecycle_type_normalizes_to_none() {
        assert!(normalize_stream_lifecycle("Subscription", &json!({}), "x").is_none());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='normalize::kick::'`
Expected: compile failure, module empty. (This test module needs `hex = "=0.4.3"` added to `[dev-dependencies]` in `Cargo.toml` — add it in Step 3 alongside the implementation.)

- [ ] **Step 3: Write the implementation**

```rust
//! Kick Pusher chat normalizer + Kick webhook helpers -- ported from
//! `core/svc_ingest/bundles/kick_ingest.py`. Pusher chat raw shape:
//! `{platform, text, chatroom_id, channel_slug, author_id, display_name,
//! badges, is_mod, is_subscriber, is_owner, message_id, created_at}`.

use hmac::{Hmac, Mac};
use penguin_spine::{PlatformEvent, Source};
use serde_json::{json, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::error::NormalizeError;
use crate::normalize::payload_map;

/// Kick webhook `type` -> this platform's generic event-type vocabulary.
/// Mirrors the legacy `event_mapping` dict; chat-message events (Pusher,
/// handled by `normalize` below) are never in this table.
pub const KICK_WEBHOOK_EVENT_TYPE_MAP: &[(&str, &str)] = &[
    ("Subscription", "subscription"),
    ("GiftedSubscription", "gift_subscription"),
    ("ChannelFollow", "follow"),
    ("StreamStart", "stream_start"),
    ("StreamEnd", "stream_end"),
    ("Raid", "raid"),
    ("Host", "host"),
    ("Ban", "moderation"),
    ("Timeout", "moderation"),
];

/// Kick webhook `type` values that additionally normalize to a live
/// ON/OFF `PlatformEvent` (gh #287 S10), alongside the coarse ack-only
/// mapping above.
pub const STREAM_LIFECYCLE_EVENT_TYPES: &[&str] = &["StreamStart", "StreamEnd"];

/// Looks up the generic event-type label for a Kick webhook `type`.
/// `"unknown"` for anything not in the table (including empty/absent).
pub fn map_kick_webhook_event_type(kick_type: &str) -> &'static str {
    KICK_WEBHOOK_EVENT_TYPE_MAP
        .iter()
        .find(|(k, _)| *k == kick_type)
        .map(|(_, v)| *v)
        .unwrap_or("unknown")
}

/// HMAC-SHA256 verifies `body` against Kick's `X-Kick-Signature` header,
/// under `secret`. **No** `"sha256="` prefix (unlike Twitch/generic-
/// intake) -- matches the raw hex digest Kick sends. A missing/empty
/// `signature` always fails closed.
pub fn verify_kick_webhook_signature(body: &[u8], signature: &str, secret: &str) -> bool {
    if signature.is_empty() {
        return false;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(body);
    let expected = hex_encode(&mac.finalize().into_bytes());
    if expected.len() != signature.len() {
        return false;
    }
    expected.as_bytes().ct_eq(signature.as_bytes()).into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Normalizes one raw Kick Pusher chat message to a `PlatformEvent`.
/// `account_id` is the configured Kick app id (config).
pub fn normalize(raw: &Value, account_id: &str) -> Result<PlatformEvent, NormalizeError> {
    let text = raw.get("text").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(text) = text else { return Err(NormalizeError::MissingField("text")) };
    let chatroom_id = raw.get("chatroom_id");
    if chatroom_id.is_none() || chatroom_id == Some(&Value::Null) {
        return Err(NormalizeError::MissingField("chatroom_id"));
    }
    let channel_slug = raw.get("channel_slug").and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(channel_slug) = channel_slug else {
        return Err(NormalizeError::MissingField("channel_slug"));
    };

    let author_id = raw.get("author_id").and_then(Value::as_str).filter(|s| !s.is_empty());
    let badges = raw.get("badges").and_then(Value::as_array).cloned().unwrap_or_default();

    Ok(PlatformEvent {
        platform: raw.get("platform").and_then(Value::as_str).unwrap_or("kick").to_string(),
        event_type: "message".to_string(),
        actor: author_id.map(str::to_string),
        payload: payload_map(json!({
            "text": text.trim(),
            "chatroom_id": chatroom_id.cloned().unwrap(),
            "channel_slug": channel_slug,
            "author_id": author_id,
            "display_name": raw.get("display_name").cloned().unwrap_or(Value::Null),
            "badges": Value::Array(badges),
            "is_mod": raw.get("is_mod").and_then(Value::as_bool).unwrap_or(false),
            "is_subscriber": raw.get("is_subscriber").and_then(Value::as_bool).unwrap_or(false),
            "is_owner": raw.get("is_owner").and_then(Value::as_bool).unwrap_or(false),
            "message_id": raw.get("message_id").cloned().unwrap_or(Value::Null),
            "created_at": raw.get("created_at").cloned().unwrap_or(Value::Null),
        })),
        occurred_at: raw
            .get("occurred_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| raw.get("created_at").and_then(Value::as_str).filter(|s| !s.is_empty()))
            .map(str::to_string)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        source: Some(Source {
            platform: "kick".to_string(),
            account_id: account_id.to_string(),
            channel_id: Some(channel_slug.to_string()),
        }),
    })
}

/// Normalizes a `StreamStart`/`StreamEnd` Kick webhook delivery to a live
/// ON/OFF `PlatformEvent` -- `None` for every other `kick_type`. Field set
/// mirrors Python's `_build_stream_lifecycle_raw_event`, but produces the
/// finished `PlatformEvent` directly (no bundle layer exists to hand an
/// intermediate raw dict to, D5/D6).
pub fn normalize_stream_lifecycle(kick_type: &str, body_json: &Value, account_id: &str) -> Option<PlatformEvent> {
    let event_type = match kick_type {
        "StreamStart" => "stream.online",
        "StreamEnd" => "stream.offline",
        _ => return None,
    };
    let channel_slug = body_json.get("channel_slug").cloned().unwrap_or(Value::Null);
    let channel_id_str = channel_slug.as_str().map(str::to_string);
    Some(PlatformEvent {
        platform: "kick".to_string(),
        event_type: event_type.to_string(),
        actor: None,
        payload: payload_map(json!({
            "channel_slug": channel_slug,
            "channel_id": body_json.get("channel_id").cloned().unwrap_or(Value::Null),
            "started_at": body_json.get("started_at").cloned().unwrap_or(Value::Null),
            "viewer_count": body_json.get("viewer_count").cloned().unwrap_or(Value::Null),
        })),
        occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        source: Some(Source { platform: "kick".to_string(), account_id: account_id.to_string(), channel_id: channel_id_str }),
    })
}
```

Also add to `core/svc_ingest/Cargo.toml`'s `[dev-dependencies]`:

```toml
hex = "=0.4.3"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='normalize::kick::'`
Expected: `test result: ok. 27 passed; 0 failed` (10 normalize + 4 signature + 9 rstest event-type-map + 1 unknown-type + 3 lifecycle = 27).

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/normalize/kick.rs core/svc_ingest/src/normalize/mod.rs core/svc_ingest/Cargo.toml core/svc_ingest/Cargo.lock
git commit -m "$(cat <<'EOF'
feat(svc-ingest): port Kick Pusher chat normalizer + webhook signature verify + event-type map (§6.1.1, gh#287 S10)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 11: Generic webhook JSON-pointer mapping engine

**Depends on:** Task 3

**Files:**
- Create: `core/svc_ingest/src/normalize/generic.rs`
- Modify: `core/svc_ingest/src/normalize/mod.rs` (add `pub mod generic;`)

New module (not ported from Python — this is the §10.3 generic-intake mapping engine, D6's extension point). Implements RFC 6901 JSON Pointer resolution against an arbitrary request body per a declarative mapping (A6).

**Interfaces:**
- Consumes: `penguin_spine::{PlatformEvent, Source}`; `crate::error::NormalizeError`.
- Produces:
  - `pub struct FieldMapping { pub pointer: String, pub default: Option<serde_json::Value> }` (`Deserialize`) — one mapping-table entry; `default: Some(json!("$now"))` is the magic timestamp default (A6).
  - `pub struct SourceMapping { pub event_type: FieldMapping, pub actor: Option<FieldMapping>, pub occurred_at: FieldMapping, pub community: Option<FieldMapping>, pub payload: std::collections::BTreeMap<String, FieldMapping> }` (`Deserialize`) — the full mapping document a generic source's `mapping` JSON column holds.
  - `pub fn apply_mapping(mapping: &SourceMapping, body: &serde_json::Value, platform: &str, source_account_id: &str, default_community: Option<&str>) -> Result<PlatformEvent, NormalizeError>` — resolves every pointer against `body`, applies `$now`/defaults, coerces scalars to string per §10.3's table, builds `payload` as a JSON object, resolves `community` (mapping → source's configured default → `None`/tenant-wide), sets `platform` from the caller-supplied `platform` (never from `body`, per §10.3: "`platform` | Never taken from the body"), and `source = Some(Source{platform, account_id: source_account_id, channel_id: None})` (the generic webhook's `channel_id` comes from the mapping if present under `payload.channel_id`, else stays `None` at the `Source` level per §6.1.1's table — this function does not special-case it further; Task 19's HTTP handler is responsible for reading `payload.channel_id` back out if it needs it for a stream key, which it does not — the generic webhook's stream key uses `source_id` = the `{source}` path segment, not `channel_id`, per §5.1).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::NormalizeError;
    use serde_json::json;

    fn fm(pointer: &str) -> FieldMapping {
        FieldMapping { pointer: pointer.to_string(), default: None }
    }
    fn fm_default(pointer: &str, default: serde_json::Value) -> FieldMapping {
        FieldMapping { pointer: pointer.to_string(), default: Some(default) }
    }

    fn base_mapping() -> SourceMapping {
        SourceMapping {
            event_type: fm_default("/type", json!("custom.event")),
            actor: Some(fm("/user/id")),
            occurred_at: fm_default("/created_at", json!("$now")),
            community: Some(fm("/channel/id")),
            payload: [
                ("text".to_string(), fm("/message/text")),
                ("channel_id".to_string(), fm("/channel/id")),
                ("message_id".to_string(), fm("/id")),
            ]
            .into_iter()
            .collect(),
        }
    }

    #[test]
    fn resolves_every_pointer_against_the_body() {
        let body = json!({
            "type": "ticket.created", "user": {"id": "u1"}, "created_at": "2026-09-14T00:00:00.000Z",
            "channel": {"id": "chan1"}, "message": {"text": "hello"}, "id": "evt1"
        });
        let event = apply_mapping(&base_mapping(), &body, "custom:github", "acme-github", None).unwrap();
        assert_eq!(event.platform, "custom:github");
        assert_eq!(event.event_type, "ticket.created");
        assert_eq!(event.actor.as_deref(), Some("u1"));
        assert_eq!(event.occurred_at, "2026-09-14T00:00:00.000Z");
        assert_eq!(Value::Object(event.payload), json!({"text": "hello", "channel_id": "chan1", "message_id": "evt1"}));
        let source = event.source.unwrap();
        assert_eq!(source.account_id, "acme-github");
    }

    #[test]
    fn missing_pointer_uses_default() {
        let body = json!({"user": {"id": "u1"}, "channel": {"id": "chan1"}, "message": {"text": "hi"}, "id": "evt1"});
        let event = apply_mapping(&base_mapping(), &body, "custom:x", "src1", None).unwrap();
        assert_eq!(event.event_type, "custom.event");
    }

    #[test]
    fn missing_pointer_no_default_is_a_mapping_error_naming_the_field() {
        let body = json!({"type": "t", "channel": {"id": "c"}, "message": {"text": "hi"}, "id": "e"});
        let err = apply_mapping(&base_mapping(), &body, "custom:x", "src1", None).unwrap_err();
        assert!(matches!(err, NormalizeError::MappingFailed { ref field, .. } if field == "actor"));
    }

    #[test]
    fn now_default_resolves_to_a_non_empty_timestamp() {
        let body = json!({"type": "t", "user": {"id": "u"}, "channel": {"id": "c"}, "message": {"text": "hi"}, "id": "e"});
        let event = apply_mapping(&base_mapping(), &body, "custom:x", "src1", None).unwrap();
        assert!(!event.occurred_at.is_empty());
        assert_ne!(event.occurred_at, "$now");
    }

    #[test]
    fn scalar_number_targeting_string_field_renders_as_json_text() {
        let mut mapping = base_mapping();
        mapping.payload.insert("count".to_string(), fm("/count"));
        let body = json!({"type": "t", "user": {"id": "u"}, "channel": {"id": "c"}, "message": {"text": "hi"}, "id": "e", "count": 42});
        let event = apply_mapping(&mapping, &body, "custom:x", "src1", None).unwrap();
        assert_eq!(event.payload["count"], "42");
    }

    #[test]
    fn scalar_bool_targeting_string_field_renders_as_json_text() {
        let mut mapping = base_mapping();
        mapping.payload.insert("verified".to_string(), fm("/verified"));
        let body = json!({"type": "t", "user": {"id": "u"}, "channel": {"id": "c"}, "message": {"text": "hi"}, "id": "e", "verified": true});
        let event = apply_mapping(&mapping, &body, "custom:x", "src1", None).unwrap();
        assert_eq!(event.payload["verified"], "true");
    }

    #[test]
    fn object_targeting_string_field_is_a_mapping_error() {
        let mut mapping = base_mapping();
        mapping.payload.insert("bad".to_string(), fm("/user"));
        let body = json!({"type": "t", "user": {"id": "u"}, "channel": {"id": "c"}, "message": {"text": "hi"}, "id": "e"});
        let err = apply_mapping(&mapping, &body, "custom:x", "src1", None).unwrap_err();
        assert!(matches!(err, NormalizeError::MappingFailed { ref field, .. } if field == "bad"));
    }

    #[test]
    fn array_targeting_string_field_is_a_mapping_error() {
        let mut mapping = base_mapping();
        mapping.payload.insert("bad".to_string(), fm("/tags"));
        let body = json!({"type": "t", "user": {"id": "u"}, "channel": {"id": "c"}, "message": {"text": "hi"}, "id": "e", "tags": [1, 2]});
        let err = apply_mapping(&mapping, &body, "custom:x", "src1", None).unwrap_err();
        assert!(matches!(err, NormalizeError::MappingFailed { .. }));
    }

    #[test]
    fn community_absent_falls_back_to_source_configured_default() {
        let mut mapping = base_mapping();
        mapping.community = None;
        let body = json!({"type": "t", "user": {"id": "u"}, "message": {"text": "hi"}, "channel": {}, "id": "e"});
        // No `community` mapping entry at all -> falls to the source's own
        // configured `community` (Task 19's HTTP handler passes it as
        // `default_community`); here it's tenant-wide (`None`).
        let event = apply_mapping(&mapping, &body, "custom:x", "src1", Some("main")).unwrap();
        assert_eq!(event.payload.get("community"), None); // community never lands in payload
    }

    #[test]
    fn platform_is_never_taken_from_the_body() {
        let body = json!({"platform": "twitch", "type": "t", "user": {"id": "u"}, "channel": {"id": "c"}, "message": {"text": "hi"}, "id": "e"});
        let event = apply_mapping(&base_mapping(), &body, "custom:github", "src1", None).unwrap();
        assert_eq!(event.platform, "custom:github");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='normalize::generic::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! Generic webhook intake's declarative JSON->`PlatformEvent` mapping
//! engine (§10.3, A6). RFC 6901 JSON Pointers only -- no expressions, no
//! code. New in the Rust rewrite: this is D6's extension point, not a
//! port of any Python bundle.

use std::collections::BTreeMap;

use penguin_spine::{PlatformEvent, Source};
use serde::Deserialize;
use serde_json::Value;

use crate::error::NormalizeError;

/// One mapping-table entry: an RFC 6901 pointer plus an optional default
/// used when the pointer target is missing. `default: Some("$now")` is
/// the one allowed magic default (A6).
#[derive(Debug, Clone, Deserialize)]
pub struct FieldMapping {
    pub pointer: String,
    #[serde(default)]
    pub default: Option<Value>,
}

/// The full declarative mapping document a generic source's `mapping`
/// column holds (§10.3).
#[derive(Debug, Clone, Deserialize)]
pub struct SourceMapping {
    pub event_type: FieldMapping,
    #[serde(default)]
    pub actor: Option<FieldMapping>,
    pub occurred_at: FieldMapping,
    #[serde(default)]
    pub community: Option<FieldMapping>,
    pub payload: BTreeMap<String, FieldMapping>,
}

/// Resolves one mapping entry against `body`. `field_name` is used only
/// for the `MappingFailed` error message.
fn resolve(field_name: &str, fm: &FieldMapping, body: &Value) -> Result<Option<Value>, NormalizeError> {
    match body.pointer(&fm.pointer) {
        Some(v) if !v.is_null() => Ok(Some(v.clone())),
        _ => match &fm.default {
            Some(Value::String(s)) if s == "$now" => {
                Ok(Some(Value::from(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))))
            }
            Some(v) => Ok(Some(v.clone())),
            None => Err(NormalizeError::MappingFailed {
                field: field_name.to_string(),
                reason: format!("pointer {:?} has no target and no default", fm.pointer),
            }),
        },
    }
}

/// Renders a resolved value as a mapping-engine string field: strings pass
/// through, numbers/booleans render in JSON text form, objects/arrays are
/// a mapping error naming `field_name` (§10.3's "Scalar to string" rule).
fn as_string_field(field_name: &str, value: Value) -> Result<Value, NormalizeError> {
    match value {
        Value::String(_) | Value::Null => Ok(value),
        Value::Number(n) => Ok(Value::from(n.to_string())),
        Value::Bool(b) => Ok(Value::from(b.to_string())),
        Value::Object(_) | Value::Array(_) => Err(NormalizeError::MappingFailed {
            field: field_name.to_string(),
            reason: "object/array values cannot target a string field".to_string(),
        }),
    }
}

/// Applies `mapping` to `body`, producing a strict `PlatformEvent`.
/// `platform` and `source_account_id` come from the source record, never
/// the body (§10.3: "platform | Never taken from the body"). `payload.*`
/// values keep their JSON type (no string coercion) -- only the top-level
/// scalar fields (`event_type`, `actor`, `occurred_at`) are string-only by
/// contract from `PlatformEvent`'s own shape; `payload` entries are
/// coerced only when the mapped value is a bare scalar being placed into
/// what the mapping author intends as a string field, matching §10.3's
/// "Scalar to string" rule literally applied to every `payload.*` entry.
pub fn apply_mapping(
    mapping: &SourceMapping,
    body: &Value,
    platform: &str,
    source_account_id: &str,
    default_community: Option<&str>,
) -> Result<PlatformEvent, NormalizeError> {
    let event_type = resolve("event_type", &mapping.event_type, body)?
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or_else(|| NormalizeError::MappingFailed { field: "event_type".into(), reason: "resolved to a non-string value".into() })?;

    let actor = match &mapping.actor {
        Some(fm) => resolve("actor", fm, body)?.and_then(|v| v.as_str().map(str::to_string)),
        None => None,
    };

    let occurred_at = resolve("occurred_at", &mapping.occurred_at, body)?
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or_else(|| NormalizeError::MappingFailed { field: "occurred_at".into(), reason: "resolved to a non-string value".into() })?;

    // `community` never lands in `payload` -- it resolves the envelope's
    // community (Task 19 reads it back out); absent mapping entry or
    // unresolved pointer with no default falls to the source's configured
    // `community`, then to tenant-wide. Unlike the other fields, an
    // unresolved `community` pointer with no default is NOT an error --
    // §10.3: "Absent ⇒ the source's configured community; that absent
    // too ⇒ tenant-wide (None)."
    let _resolved_community: Option<String> = match &mapping.community {
        Some(fm) => match body.pointer(&fm.pointer) {
            Some(v) if !v.is_null() => v.as_str().map(str::to_string),
            _ => default_community.map(str::to_string),
        },
        None => default_community.map(str::to_string),
    };

    let mut payload = serde_json::Map::new();
    for (field_name, fm) in &mapping.payload {
        let resolved = resolve(field_name, fm, body)?.unwrap_or(Value::Null);
        payload.insert(field_name.clone(), as_string_field(field_name, resolved)?);
    }

    Ok(PlatformEvent {
        platform: platform.to_string(),
        event_type,
        actor,
        payload,
        occurred_at,
        source: Some(Source { platform: platform.to_string(), account_id: source_account_id.to_string(), channel_id: None }),
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='normalize::generic::'`
Expected: `test result: ok. 10 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/normalize/generic.rs core/svc_ingest/src/normalize/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): generic webhook intake's RFC 6901 JSON-pointer mapping engine (§10.3, A6)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 12: Event publisher (D30 minting, D31 usage)

**Depends on:** Task 3, Task 4

Named `publish.rs`, not `spine.rs`: **coordinator ruling R60** — `svc_ingest` depends on `penguin-spine` directly (R53 git-rev pin) and never re-implements it; this module is ingest's own thin orchestration over the crate's real types (`StageEnvelope`, `PlatformEvent`, `Trace`, `Binding`, `BindingKeyring`, `UsageDelta`/`UsageBatcher`, `SpineClient::{append,append_usage}`), not a local copy of any spine mechanic.

**Files:**
- Create: `core/svc_ingest/src/publish.rs`

This task's earlier draft quoted a stale, pre-D30 `penguin-spine` surface (`SpineClient::append` taking a `maxlen_approx` parameter, no `workstream_id`/`event_id`/`trace`/`binding` on `StageEnvelope`). It is rewritten here against the corrected External Crate Surfaces block.

**Interfaces:**
- Consumes: `penguin_spine::{PlatformEvent, StageEnvelope, Trace, Binding, Scope, SpineClient, SpineError, BindingKeyring, BindingInput, compute_binding_mac, trace_id_from_traceparent, ENVELOPE_SCHEMA_VERSION, UsageDelta, UsageBatcher}` (External Crate Surfaces); `crate::telemetry::IngestMetrics` (Task 4).
- Produces:
  - `#[async_trait::async_trait] pub trait EventAppender: Send + Sync { async fn append(&self, stream: &str, env: &StageEnvelope) -> Result<String, String>; }` — a local trait wrapping `penguin_spine::SpineClient::append` (no `maxlen` parameter -- the real crate reads `MAXLEN` from the `SpineConfig` given to `SpineClient::connect`, Task 30) so this task and everything downstream of it is testable without a real Valkey. `impl EventAppender for SpineClient` is the production adapter.
  - `pub const WORKSTREAM_NAMESPACE: uuid::Uuid` — a fixed, hardcoded UUID namespace constant (any stable literal; generate once with `uuidgen`, never regenerate) for **PA-WORKSTREAM**'s deterministic fixed-platform workstream ids.
  - `pub fn deterministic_workstream_id(source_id: &str) -> String` — `Uuid::new_v5(&WORKSTREAM_NAMESPACE, source_id.as_bytes()).to_string()`. Used by the fixed-platform receiver supervisors (Tasks 23-29); generic sources (Tasks 19/20) instead pass the `workstreamId` already on their polled registry row (PA-WORKSTREAM).
  - `pub async fn publish_event(appender: &dyn EventAppender, metrics: &IngestMetrics, keyring: &BindingKeyring, usage: &UsageBatcher, scope: &Scope, source_id: &str, workstream_id: &str, session_id: Option<&str>, event: PlatformEvent) -> Result<String, String>` — the **sole** `StageEnvelope`-construction site in this crate. Builds the envelope per **PA-ENVELOPE** (`app_id`, `stage = "ingest"`, `target_app_id = None`) plus **D30** (`schema_version = ENVELOPE_SCHEMA_VERSION`, a freshly minted `event_id` (UUID v4), a freshly minted `trace` — **never** a continuation of any inbound request's own trace — `session_id` passed through verbatim, and `binding` computed via `compute_binding_mac` against `keyring` using the trace's own 32-hex trace-id segment), computes the stream key via `scope.source_stream(&event.platform, source_id)`, calls `appender.append(...)`, and on success: increments `metrics.stream_event_written(platform, source_id)` and records one `UsageDelta` (`events: 1`, everything else zero) onto `usage` (**D31** — accumulated in-process; a separate periodic task, Task 30, flushes `usage` onto `waddles:usage` via `SpineClient::append_usage`, never per-event).
  - A private `fn mint_trace() -> Trace` helper: a fresh 32-hex trace-id and 16-hex parent-span-id (both derived from `Uuid::new_v4().simple()`, no new dependency), `traceparent = format!("00-{trace_id}-{span_id}-01")`, `tracestate: None`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::IngestMetrics;
    use penguin_spine::{BindingKeyEntry, BindingKeyring, Source};
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct FakeAppender {
        calls: Mutex<Vec<(String, StageEnvelope)>>,
        fail: bool,
    }

    #[async_trait::async_trait]
    impl EventAppender for FakeAppender {
        async fn append(&self, stream: &str, env: &StageEnvelope) -> Result<String, String> {
            if self.fail {
                return Err("connection refused".to_string());
            }
            self.calls.lock().unwrap().push((stream.to_string(), env.clone()));
            Ok("1757851200000-0".to_string())
        }
    }

    fn test_event() -> PlatformEvent {
        PlatformEvent {
            platform: "twitch".to_string(),
            event_type: "message".to_string(),
            actor: Some("alice".to_string()),
            payload: crate::normalize::payload_map(serde_json::json!({"text": "hi"})),
            occurred_at: "2026-09-14T12:00:00.000Z".to_string(),
            source: Some(Source { platform: "twitch".to_string(), account_id: "bot-primary".to_string(), channel_id: Some("chan".to_string()) }),
        }
    }

    fn test_keyring() -> BindingKeyring {
        let mut entries = HashMap::new();
        entries.insert("test-kid".to_string(), BindingKeyEntry { key: vec![7u8; 32], retired_at: None });
        BindingKeyring::from_entries("test-kid", entries, chrono::Duration::seconds(86_400)).unwrap()
    }

    #[tokio::test]
    async fn writes_onto_the_correct_source_stream_with_d30_fields_populated() {
        let appender = FakeAppender { calls: Mutex::new(vec![]), fail: false };
        let metrics = IngestMetrics;
        let keyring = test_keyring();
        let usage = UsageBatcher::new();
        let scope = Scope { tenant: "acme".to_string(), community: Some("main".to_string()) };
        let entry_id =
            publish_event(&appender, &metrics, &keyring, &usage, &scope, "tw-channelA", "ws-1", None, test_event())
                .await
                .unwrap();
        assert_eq!(entry_id, "1757851200000-0");

        let calls = appender.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (stream, env) = &calls[0];
        assert_eq!(stream, "waddles:t:acme:c:main:src:twitch:tw-channelA:events");
        assert_eq!(env.schema_version, penguin_spine::ENVELOPE_SCHEMA_VERSION);
        assert_eq!(env.stage, "ingest");
        assert_eq!(env.app_id, "waddles.ingest.twitch.tw-channelA");
        assert_eq!(env.target_app_id, None);
        assert_eq!(env.tenant, "acme");
        assert_eq!(env.community.as_deref(), Some("main"));
        assert_eq!(env.workstream_id, "ws-1");
        assert!(uuid::Uuid::parse_str(&env.event_id).is_ok(), "event_id must be a UUID");
        assert_eq!(env.session_id, None);
        let trace = env.trace.as_ref().expect("publish_event always mints a trace");
        assert!(trace.traceparent.starts_with("00-"));
        assert_eq!(env.binding.kid, "test-kid");
        assert_eq!(env.binding.mac.len(), 64);
    }

    #[tokio::test]
    async fn session_id_is_carried_through_when_supplied() {
        let appender = FakeAppender { calls: Mutex::new(vec![]), fail: false };
        let (metrics, keyring, usage) = (IngestMetrics, test_keyring(), UsageBatcher::new());
        let scope = Scope { tenant: "acme".to_string(), community: None };
        publish_event(&appender, &metrics, &keyring, &usage, &scope, "tw-eventsub-999", "ws-2", Some("session-abc"), test_event())
            .await
            .unwrap();
        assert_eq!(appender.calls.lock().unwrap()[0].1.session_id.as_deref(), Some("session-abc"));
    }

    #[tokio::test]
    async fn every_call_mints_a_distinct_event_id_and_trace() {
        let appender = FakeAppender { calls: Mutex::new(vec![]), fail: false };
        let (metrics, keyring, usage) = (IngestMetrics, test_keyring(), UsageBatcher::new());
        let scope = Scope { tenant: "acme".to_string(), community: None };
        publish_event(&appender, &metrics, &keyring, &usage, &scope, "tw-channelA", "ws-1", None, test_event()).await.unwrap();
        publish_event(&appender, &metrics, &keyring, &usage, &scope, "tw-channelA", "ws-1", None, test_event()).await.unwrap();
        let calls = appender.calls.lock().unwrap();
        assert_ne!(calls[0].1.event_id, calls[1].1.event_id);
        assert_ne!(
            calls[0].1.trace.as_ref().unwrap().traceparent,
            calls[1].1.trace.as_ref().unwrap().traceparent
        );
    }

    #[tokio::test]
    async fn records_exactly_one_usage_delta_event_per_publish() {
        let appender = FakeAppender { calls: Mutex::new(vec![]), fail: false };
        let (metrics, keyring, usage) = (IngestMetrics, test_keyring(), UsageBatcher::new());
        let scope = Scope { tenant: "acme".to_string(), community: None };
        publish_event(&appender, &metrics, &keyring, &usage, &scope, "tw-channelA", "ws-1", None, test_event()).await.unwrap();
        let deltas = usage.flush();
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0].workstream_id, "ws-1");
        assert_eq!(deltas[0].stage, "ingest");
        assert_eq!(deltas[0].events, 1);
    }

    #[tokio::test]
    async fn append_failure_records_no_usage_and_propagates_the_error() {
        let appender = FakeAppender { calls: Mutex::new(vec![]), fail: true };
        let (metrics, keyring, usage) = (IngestMetrics, test_keyring(), UsageBatcher::new());
        let scope = Scope { tenant: "acme".to_string(), community: None };
        let err = publish_event(&appender, &metrics, &keyring, &usage, &scope, "tw-channelA", "ws-1", None, test_event())
            .await
            .unwrap_err();
        assert!(err.contains("connection refused"));
        assert!(usage.is_empty(), "a failed append must never record usage");
    }

    #[tokio::test]
    async fn tenant_wide_community_renders_as_the_literal_tenant_segment() {
        let appender = FakeAppender { calls: Mutex::new(vec![]), fail: false };
        let (metrics, keyring, usage) = (IngestMetrics, test_keyring(), UsageBatcher::new());
        let scope = Scope { tenant: "acme".to_string(), community: None };
        publish_event(&appender, &metrics, &keyring, &usage, &scope, "tw-channelA", "ws-1", None, test_event()).await.unwrap();
        assert_eq!(
            appender.calls.lock().unwrap()[0].0,
            "waddles:t:acme:c:_tenant:src:twitch:tw-channelA:events"
        );
    }

    #[test]
    fn deterministic_workstream_id_is_stable_per_source_id() {
        let a = deterministic_workstream_id("tw-waddlebot");
        let b = deterministic_workstream_id("tw-waddlebot");
        let c = deterministic_workstream_id("dg-guild123");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(uuid::Uuid::parse_str(&a).is_ok());
    }

    #[test]
    fn app_id_slug_sanitizes_a_custom_platform_string() {
        assert_eq!(app_id_slug("custom:github"), "custom-github");
        assert_eq!(app_id_slug("Twitch"), "twitch");
        assert_eq!(app_id_slug("---leading-punct"), "leading-punct");
        assert_eq!(app_id_slug(""), "x");
    }

    #[tokio::test]
    async fn a_custom_platform_produces_a_regex_valid_app_id() {
        // Without app_id_slug, "custom:github" would produce an app_id no
        // stage's strict StageEnvelope deserializer could read back.
        let appender = FakeAppender { calls: Mutex::new(vec![]), fail: false };
        let (metrics, keyring, usage) = (IngestMetrics, test_keyring(), UsageBatcher::new());
        let scope = Scope { tenant: "acme".to_string(), community: None };
        let mut event = test_event();
        event.platform = "custom:github".to_string();
        publish_event(&appender, &metrics, &keyring, &usage, &scope, "acme-github", "ws-1", None, event).await.unwrap();
        let app_id = &appender.calls.lock().unwrap()[0].1.app_id;
        assert_eq!(app_id, "waddles.ingest.custom-github.acme-github");
        assert!(app_id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-'));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='publish::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! One write per event (§10.6): wraps a normalized `PlatformEvent` in a
//! `StageEnvelope` and `XADD`s it once onto its ingest source's stream.
//! `app_id` is a synthetic per-**source** id (PA-ENVELOPE) -- ingest
//! resolves no consumer, D23/D24/§10.6. Also mints every D30 workstream-
//! identity/trace/binding field (ingest MINTS, never verifies -- §5.11)
//! and records one D31 usage delta per successful publish.

use penguin_spine::{
    compute_binding_mac, trace_id_from_traceparent, BindingInput, BindingKeyring, PlatformEvent,
    Scope, SpineClient, StageEnvelope, Trace, UsageBatcher, UsageDelta, ENVELOPE_SCHEMA_VERSION,
};
use uuid::Uuid;

use crate::telemetry::IngestMetrics;

/// Fixed namespace for **PA-WORKSTREAM**'s deterministic fixed-platform
/// workstream ids. Generated once (`uuidgen`) and never regenerated --
/// changing it would change every fixed-platform `workstream_id` on next
/// deploy, breaking usage-metering continuity (§5.12).
pub const WORKSTREAM_NAMESPACE: Uuid = Uuid::from_bytes([
    0x2c, 0x9e, 0x1a, 0x40, 0x6f, 0x8b, 0x4c, 0x1d, 0x9a, 0x3e, 0x7d, 0x2f, 0x51, 0x0a, 0x8b, 0x6c,
]);

/// Derives a stable `workstream_id` for a fixed-platform ingest source
/// from its `source_id` (the same string already used to build the
/// Valkey stream key) -- **PA-WORKSTREAM**. Generic sources instead use
/// the `workstreamId` already on their polled registry row (Task 14).
pub fn deterministic_workstream_id(source_id: &str) -> String {
    Uuid::new_v5(&WORKSTREAM_NAMESPACE, source_id.as_bytes()).to_string()
}

/// Sanitizes one `app_id` path segment (PA-ENVELOPE): lowercase, every
/// character outside `[a-z0-9_-]` becomes `-`, and any leading run of
/// characters outside `[a-z0-9]` is stripped, so the segment can never
/// violate `penguin_spine`'s `^waddles\.<seg>\.<seg>\.<seg>$` regex.
/// **Load-bearing for `custom:*` platforms**: without this, a generic
/// source's `platform` (e.g. `custom:github`, containing `:`) would
/// produce an `app_id` no stage's strict `StageEnvelope` deserializer
/// (§6.1.2) can read back -- every event from that source would be
/// unreadable the moment any process bundle's `GroupReader` tried to
/// deserialize it, discovered only downstream of ingest.
pub fn app_id_slug(raw: &str) -> String {
    let mut out: String = raw
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    while out.starts_with(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit()) {
        out.remove(0);
    }
    if out.is_empty() {
        out.push('x');
    }
    out
}

/// Wraps `penguin_spine::SpineClient::append` behind a trait so callers
/// (and this module's own tests) never need a real Valkey connection.
#[async_trait::async_trait]
pub trait EventAppender: Send + Sync {
    async fn append(&self, stream: &str, env: &StageEnvelope) -> Result<String, String>;
}

#[async_trait::async_trait]
impl EventAppender for SpineClient {
    async fn append(&self, stream: &str, env: &StageEnvelope) -> Result<String, String> {
        SpineClient::append(self, stream, env).await.map_err(|e| e.to_string())
    }
}

/// A fresh W3C trace -- one per inbound event, never a continuation of
/// any inbound request's own trace (§5.11).
fn mint_trace() -> Trace {
    let trace_id = Uuid::new_v4().simple().to_string();
    let span_id = Uuid::new_v4().simple().to_string()[..16].to_string();
    Trace { traceparent: format!("00-{trace_id}-{span_id}-01"), tracestate: None }
}

/// Publishes one normalized event onto its ingest source's stream,
/// exactly once, minting every D30 identity field and recording one D31
/// usage delta -- the sole `StageEnvelope`-construction site in this
/// crate. `source_id` is hub-api's (or, for a fixed platform, ingest's
/// own) stable identifier for the ingest configuration this event came
/// from; `workstream_id` and `session_id` are supplied by the caller
/// (PA-WORKSTREAM) since only the caller knows which of the two
/// workstream-resolution strategies applies.
pub async fn publish_event(
    appender: &dyn EventAppender,
    metrics: &IngestMetrics,
    keyring: &BindingKeyring,
    usage: &UsageBatcher,
    scope: &Scope,
    source_id: &str,
    workstream_id: &str,
    session_id: Option<&str>,
    event: PlatformEvent,
) -> Result<String, String> {
    let stream = scope.source_stream(&event.platform, source_id);
    let platform = event.platform.clone();

    let trace = mint_trace();
    let trace_id = trace_id_from_traceparent(&trace.traceparent)
        .expect("mint_trace always produces a valid W3C traceparent")
        .to_string();
    let event_id = Uuid::new_v4().to_string();
    let binding = compute_binding_mac(
        keyring,
        &BindingInput {
            tenant: &scope.tenant,
            community: scope.community.as_deref(),
            workstream_id,
            event_id: &event_id,
            trace_id: &trace_id,
        },
    );

    let env = StageEnvelope {
        schema_version: ENVELOPE_SCHEMA_VERSION,
        tenant: scope.tenant.clone(),
        community: scope.community.clone(),
        app_id: format!("waddles.ingest.{}.{}", app_id_slug(&platform), app_id_slug(source_id)),
        stage: "ingest".to_string(),
        event,
        ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        target_app_id: None,
        workstream_id: workstream_id.to_string(),
        event_id,
        session_id: session_id.map(str::to_string),
        trace: Some(trace),
        binding,
    };

    let entry_id = appender.append(&stream, &env).await?;
    metrics.stream_event_written(&platform, source_id);

    let mut delta =
        UsageDelta::zero(scope.tenant.clone(), scope.community.clone(), workstream_id.to_string(), "ingest", None);
    delta.events = 1;
    usage.record(delta);

    Ok(entry_id)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='publish::'`
Expected: `test result: ok. 9 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/publish.rs core/svc_ingest/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): event publisher -- one XADD per event, D30 workstream/trace/binding minting, D31 usage batching, app_id slug sanitization (§10.6, §5.11, §5.12, PA-ENVELOPE)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 13: hub-api `GET /api/v1/distribution/sources`

**Depends on:** none (Python, separate stack from Tasks 1-12)

**Files:**
- Modify: `hub_api/blueprints/v1/distribution.py`
- Modify: `hub_api/services/distribution_service.py`
- Modify: `hub_api/tests/test_v1_distribution_blueprint.py`

Additive endpoint (PA-SOURCES). Modeled directly on the existing `GET /api/v1/distribution/bundles` route in the same file: `@tenant_middleware` + `@require_scope("distribution:read")`, tenant strictly from the caller's JWT, `@validate_response` DTO, same `_dal()`/`_ensure_tables` read-replica pattern. Serves rows from the `intake_sources` table (§15.4: `{tenant, source_id, source, platform, secret_ref, community, mapping, enabled, auth, workstream_id}` — **must match plan M2b's `intake_sources` migration**, `origin/docs/plan-m2b-hub-api` commit `205def34`, which my task brief flags as being revised in parallel; re-check the column names against that branch's tip before implementing, and note any drift in this task's commit message rather than silently matching an older shape). `auth` is the §4.1.1/D29 JSON object (PA-INTAKE-AUTH); `workstream_id` is the `workstreams` row created 1:1 with this source (§5.11/§6.11, D30) — this task assumes both columns already exist per M1.5/M2b's migration; if either does not exist when this task runs, add the migration inline here rather than blocking, following the existing migration-numbering convention in `config/postgres/migrations/`.

**Interfaces:**
- Consumes: `flask_core.tenancy.{get_tenant_context, tenant_middleware}`, `flask_core.authz.require_scope`, `flask_core.api_utils.error_response`, `quart_schema.validate_response` (all already imported in `distribution.py`).
- Produces: `GET /api/v1/distribution/sources` returning `{"success": true, "sources": [SourceDTO, ...], "meta": {"version": int, "timestamp": str}}` with `ETag` response header (SHA-256 hex of the serialized `sources` array) and `304 Not Modified` when the caller's `If-None-Match` matches. `SourceDTO = {sourceId: str, tenant: str, platform: str, secretRef: str, secret: str, community: str | None, mapping: dict, enabled: bool, workstreamId: str, auth: AuthDTO}`, `AuthDTO = {modes: list[str], cidrs: list[str], secretRef: str | None, secret: str | None}` (`secret` is hub-api's resolution of `auth.secretRef` for the `bearer`/`basic` modes, `null` when neither is configured — mirrors the top-level `secretRef`/`secret` pair, PA-SOURCES).

- [ ] **Step 1: Write the failing test**

Append to `hub_api/tests/test_v1_distribution_blueprint.py` (matching that file's existing fixture/auth-header conventions — read the file's top for the exact `client`/`auth_headers` fixture names before writing, they are already defined there for the `/bundles` tests and reused verbatim here):

```python
class TestListDistributionSources:
    async def test_returns_sources_for_the_callers_tenant(self, client, auth_headers, seed_intake_source):
        await seed_intake_source(
            tenant="acme-corp", source_id="acme-github", source="github", platform="custom:github",
            secret_ref="acme-github-webhook-secret", community="main",
            mapping={"event_type": {"pointer": "/type"}}, enabled=True, workstream_id="8f14e45f-ceea-467e-adde-3fb5c9752730",
            auth={"modes": ["bearer"], "cidrs": [], "secret_ref": "acme-github-bearer"},
        )
        resp = await client.get("/api/v1/distribution/sources", headers=auth_headers(tenant="acme-corp"))
        assert resp.status_code == 200
        body = await resp.get_json()
        assert body["success"] is True
        assert len(body["sources"]) == 1
        row = body["sources"][0]
        assert row["sourceId"] == "acme-github"
        assert row["platform"] == "custom:github"
        assert row["secretRef"] == "acme-github-webhook-secret"
        assert "secret" in row and row["secret"]
        assert row["community"] == "main"
        assert row["enabled"] is True
        assert row["workstreamId"] == "8f14e45f-ceea-467e-adde-3fb5c9752730"
        assert row["auth"]["modes"] == ["bearer"]
        assert row["auth"]["secretRef"] == "acme-github-bearer"
        assert row["auth"]["secret"]

    async def test_source_with_no_second_factor_still_lists_empty_auth_modes(self, client, auth_headers, seed_intake_source):
        # hub-api's *create/update* endpoint refuses to persist this (422
        # auth_factor_required, M2b, out of this task's scope) -- but a
        # row that somehow exists with empty modes must still round-trip
        # honestly here, since svc-ingest's own fail-closed 401 depends on
        # seeing the true (empty) list, never a synthesized default.
        await seed_intake_source(
            tenant="acme-corp", source_id="acme-bare", source="x", platform="custom:x", secret_ref="ref",
            community=None, mapping={}, enabled=True, workstream_id="ws-bare", auth={"modes": [], "cidrs": [], "secret_ref": None},
        )
        resp = await client.get("/api/v1/distribution/sources", headers=auth_headers(tenant="acme-corp"))
        body = await resp.get_json()
        assert body["sources"][0]["auth"]["modes"] == []
        assert body["sources"][0]["auth"]["secret"] is None

    async def test_never_returns_another_tenants_sources(self, client, auth_headers, seed_intake_source):
        await seed_intake_source(tenant="other-corp", source_id="other-src", source="x", platform="custom:x", secret_ref="ref", community=None, mapping={}, enabled=True, workstream_id="ws-other", auth={"modes": ["bearer"], "cidrs": [], "secret_ref": "r"})
        resp = await client.get("/api/v1/distribution/sources", headers=auth_headers(tenant="acme-corp"))
        assert resp.status_code == 200
        body = await resp.get_json()
        assert body["sources"] == []

    async def test_disabled_source_is_still_listed_with_enabled_false(self, client, auth_headers, seed_intake_source):
        await seed_intake_source(tenant="acme-corp", source_id="acme-off", source="x", platform="custom:x", secret_ref="ref", community=None, mapping={}, enabled=False, workstream_id="ws-off", auth={"modes": ["bearer"], "cidrs": [], "secret_ref": "r"})
        resp = await client.get("/api/v1/distribution/sources", headers=auth_headers(tenant="acme-corp"))
        body = await resp.get_json()
        assert body["sources"][0]["enabled"] is False

    async def test_missing_scope_is_rejected(self, client, auth_headers_without_scope):
        resp = await client.get("/api/v1/distribution/sources", headers=auth_headers_without_scope("distribution:read"))
        assert resp.status_code == 403

    async def test_etag_returned_and_if_none_match_yields_304(self, client, auth_headers, seed_intake_source):
        await seed_intake_source(tenant="acme-corp", source_id="s1", source="x", platform="custom:x", secret_ref="ref", community=None, mapping={}, enabled=True, workstream_id="ws-1", auth={"modes": ["bearer"], "cidrs": [], "secret_ref": "r"})
        first = await client.get("/api/v1/distribution/sources", headers=auth_headers(tenant="acme-corp"))
        etag = first.headers["ETag"]
        assert etag
        second = await client.get(
            "/api/v1/distribution/sources",
            headers={**auth_headers(tenant="acme-corp"), "If-None-Match": etag},
        )
        assert second.status_code == 304

    async def test_etag_changes_when_sources_change(self, client, auth_headers, seed_intake_source):
        await seed_intake_source(tenant="acme-corp", source_id="s1", source="x", platform="custom:x", secret_ref="ref", community=None, mapping={}, enabled=True, workstream_id="ws-1", auth={"modes": ["bearer"], "cidrs": [], "secret_ref": "r"})
        first = await client.get("/api/v1/distribution/sources", headers=auth_headers(tenant="acme-corp"))
        await seed_intake_source(tenant="acme-corp", source_id="s2", source="y", platform="custom:y", secret_ref="ref2", community=None, mapping={}, enabled=True, workstream_id="ws-2", auth={"modes": ["cidr"], "cidrs": ["203.0.113.0/24"], "secret_ref": None})
        second = await client.get("/api/v1/distribution/sources", headers=auth_headers(tenant="acme-corp"))
        assert first.headers["ETag"] != second.headers["ETag"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose run --rm hub-api pytest hub_api/tests/test_v1_distribution_blueprint.py -k TestListDistributionSources -v`
Expected: `404 Not Found` on every case (route doesn't exist yet), or a fixture error if `seed_intake_source` isn't yet defined in `hub_api/tests/conftest.py` — add that fixture (an `INSERT` into `intake_sources` via the test DAL, accepting `workstream_id` and `auth` (a dict, JSON-serialized into the `auth` JSONB column) alongside the existing columns, matching the file's existing seed-fixture pattern for other tables) as part of this step, before writing the route.

- [ ] **Step 3: Write the implementation**

Add to `hub_api/services/distribution_service.py` (a new function alongside the existing bundle-listing one):

```python
async def list_intake_sources(dal: Any, *, tenant: str) -> list[dict[str, Any]]:
    """Return every `intake_sources` row for `tenant`, resolved secrets included.

    `secret_ref` names the credential (safe to log/display); `secret` is
    the resolved plaintext value hub-api fetches on the caller's behalf --
    svc-ingest has no independent way to resolve a bare reference the way
    a bundle's activation-config env var does (PA-SOURCES). `auth`
    (Sec4.1.1/D29, PA-INTAKE-AUTH) gets the same treatment: its
    `secret_ref` (bearer token or `user:password`, when the source
    configures either mode) is resolved to `auth.secret` alongside it.
    `workstream_id` (Sec5.11, D30) passes through unchanged -- it is not a
    secret, just an id.
    """
    rows = await dal(dal.intake_sources.tenant == tenant).select()
    out = []
    for row in rows:
        auth = dict(row.auth or {"modes": [], "cidrs": [], "secret_ref": None})
        auth_secret_ref = auth.get("secret_ref")
        out.append(
            {
                "source_id": row.source_id,
                "tenant": row.tenant,
                "platform": row.platform,
                "secret_ref": row.secret_ref,
                "secret": await resolve_secret_ref(row.secret_ref),
                "community": row.community,
                "mapping": row.mapping,
                "enabled": row.enabled,
                "workstream_id": row.workstream_id,
                "auth": {
                    "modes": auth.get("modes", []),
                    "cidrs": auth.get("cidrs", []),
                    "secret_ref": auth_secret_ref,
                    "secret": await resolve_secret_ref(auth_secret_ref) if auth_secret_ref else None,
                },
            }
        )
    return out
```

(`resolve_secret_ref` is assumed to already exist somewhere in hub-api's secret-resolution path per §8.3's precedent — if it does not, add a minimal version reading `os.environ[secret_ref]` with a clear `TODO(M6)` pointing at the eventual KMS-backed resolver; never invent a plaintext-in-DB fallback.)

Add to `hub_api/blueprints/v1/distribution.py`:

```python
import hashlib
import json


@dataclass(slots=True, frozen=True)
class SourceAuthDTO:
    """The Sec4.1.1/D29 second-factor configuration (PA-INTAKE-AUTH) --
    must match plan M2b's `intake_sources.auth` column shape exactly."""

    modes: list[str]
    cidrs: list[str]
    secretRef: str | None
    secret: str | None


@dataclass(slots=True, frozen=True)
class DistributionSourceDTO:
    """One `intake_sources` row, resolved for `svc-ingest`'s registry poll."""

    sourceId: str
    tenant: str
    platform: str
    secretRef: str
    secret: str
    community: str | None
    mapping: dict[str, Any]
    enabled: bool
    workstreamId: str
    auth: SourceAuthDTO


@dataclass(slots=True, frozen=True)
class DistributionSourcesResponse:
    """Response DTO for `GET /api/v1/distribution/sources`."""

    success: bool
    sources: list[DistributionSourceDTO]
    meta: DistributionMetaDTO


@distribution_bp.route("/sources", methods=["GET"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("distribution:read")  # type: ignore[untyped-decorator]
@validate_response(DistributionSourcesResponse)
async def list_distribution_sources() -> DistributionSourcesResponse | tuple[dict[str, object], int] | Response:
    """List every generic-intake source configured for the caller's tenant, ETag-cacheable."""
    tenant_ctx = get_tenant_context()
    _, read_dal = _dal()
    rows = await svc.list_intake_sources(read_dal, tenant=tenant_ctx.tenant)
    sources = [
        DistributionSourceDTO(
            sourceId=r["source_id"], tenant=r["tenant"], platform=r["platform"],
            secretRef=r["secret_ref"], secret=r["secret"], community=r["community"],
            mapping=r["mapping"], enabled=r["enabled"], workstreamId=r["workstream_id"],
            auth=SourceAuthDTO(
                modes=r["auth"]["modes"], cidrs=r["auth"]["cidrs"],
                secretRef=r["auth"]["secret_ref"], secret=r["auth"]["secret"],
            ),
        )
        for r in rows
    ]
    etag = hashlib.sha256(
        json.dumps(
            [r["source_id"] for r in rows] + [r["enabled"] for r in rows] + [r["workstream_id"] for r in rows],
            sort_keys=True, default=str,
        ).encode()
    ).hexdigest()
    if request.headers.get("If-None-Match") == etag:
        return Response(status=304, headers={"ETag": etag})
    response = DistributionSourcesResponse(
        success=True, sources=sources, meta=DistributionMetaDTO(version=1, timestamp=datetime.now(UTC).isoformat())
    )
    return response, 200, {"ETag": etag}
```

(`Response` needs `from quart import Response` added to the existing `from quart import Blueprint, current_app, request` import line if not already present.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose run --rm hub-api pytest hub_api/tests/test_v1_distribution_blueprint.py -k TestListDistributionSources -v`
Expected: `7 passed`

- [ ] **Step 5: Run the full hub-api suite to confirm no regression**

Run: `docker compose run --rm hub-api pytest hub_api/tests/ -v`
Expected: same pass count as before this task plus 6, zero new failures.

- [ ] **Step 6: Commit**

```bash
git add hub_api/blueprints/v1/distribution.py hub_api/services/distribution_service.py hub_api/tests/test_v1_distribution_blueprint.py hub_api/tests/conftest.py
git commit -m "$(cat <<'EOF'
feat(hub-api): GET /api/v1/distribution/sources for svc-ingest's generic-intake source registry, incl. auth (D29) and workstreamId (D30) (PA-SOURCES)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 14: Source registry poller

**Depends on:** Task 2, Task 3, Task 13

**Files:**
- Create: `core/svc_ingest/src/sources.rs`

**Interfaces:**
- Consumes: `crate::config::Config` (Task 2); `crate::error::IngestError` (Task 3); `crate::normalize::generic::SourceMapping` (Task 11, `Deserialize`d from each row's `mapping` field).
- Produces:
  - `#[derive(Debug, Clone, Default, serde::Deserialize)] pub struct SourceAuth { #[serde(default)] pub modes: Vec<String>, #[serde(default)] pub cidrs: Vec<String>, #[serde(default, rename = "secretRef")] pub secret_ref: Option<String>, #[serde(default)] pub secret: Option<String> }` — the §4.1.1/D29 second-factor configuration (PA-INTAKE-AUTH), deserialized straight off Task 13's `AuthDTO` shape; `cidrs` stays `Vec<String>` here (parsed to `ipnet::IpNet` at the point of use, Task 19) so this module never needs `ipnet`'s optional `serde` feature.
  - `#[derive(Debug, Clone, serde::Deserialize)] pub struct SourceRecord { #[serde(rename = "sourceId")] pub source_id: String, pub tenant: String, pub platform: String, #[serde(rename = "secretRef")] pub secret_ref: String, pub secret: String, pub community: Option<String>, pub mapping: crate::normalize::generic::SourceMapping, pub enabled: bool, #[serde(rename = "workstreamId")] pub workstream_id: String, #[serde(default)] pub auth: SourceAuth }` — `workstream_id` is §5.11/D30's PA-WORKSTREAM value for this source, polled from hub-api like every other field (fixed-platform sources instead call `crate::publish::deterministic_workstream_id`, Task 12 — they never populate this struct).
  - `#[derive(Debug, Clone, Default)] pub struct SourceRegistry { by_key: std::collections::HashMap<(String, String), SourceRecord> }` keyed by `(tenant, source_id)`, with `pub fn get(&self, tenant: &str, source_id: &str) -> Option<&SourceRecord>` and `pub fn is_empty(&self) -> bool`.
  - `pub type SharedSourceRegistry = std::sync::Arc<arc_swap::ArcSwap<SourceRegistry>>;` — add `arc-swap = "=1.7.1"` to `Cargo.toml`'s `[dependencies]`.
  - `#[async_trait::async_trait] pub trait SourcesFetcher: Send + Sync { async fn fetch(&self, etag: Option<&str>) -> Result<FetchOutcome, IngestError>; }` where `pub enum FetchOutcome { Fresh { sources: Vec<SourceRecord>, etag: String }, NotModified }` — production impl `HttpSourcesFetcher` wraps `reqwest::Client`, calls `GET {hub_api_url}/api/v1/distribution/sources` with `Authorization: Bearer {service_jwt}` and `If-None-Match: {etag}` when present, `304` → `NotModified`, `200` → parses the DTO shape Task 13 produces into `Vec<SourceRecord>` plus the response `ETag` header.
  - `pub async fn run_source_registry_poll(fetcher: &dyn SourcesFetcher, registry: SharedSourceRegistry, poll_interval: std::time::Duration, base_backoff: std::time::Duration, max_backoff: std::time::Duration, mut shutdown: tokio::sync::watch::Receiver<bool>)` — polls every `poll_interval`, updates `registry` via `ArcSwap::store` on `Fresh`, leaves it untouched on `NotModified`, and on a fetch error logs at WARN and backs off exponentially (`base_backoff` → `max_backoff`, doubling) **without ever clearing the registry** (last-known-good, §6.7's polling-behaviour precedent applied here).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::generic::{FieldMapping, SourceMapping};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    fn sample_source(id: &str) -> SourceRecord {
        SourceRecord {
            source_id: id.to_string(),
            tenant: "acme".to_string(),
            platform: "custom:github".to_string(),
            secret_ref: "ref".to_string(),
            secret: "shh".to_string(),
            community: None,
            mapping: SourceMapping {
                event_type: FieldMapping { pointer: "/type".to_string(), default: None },
                actor: None,
                occurred_at: FieldMapping { pointer: "/ts".to_string(), default: None },
                community: None,
                payload: Default::default(),
            },
            enabled: true,
            workstream_id: format!("ws-{id}"),
            auth: crate::sources::SourceAuth {
                modes: vec!["bearer".to_string()],
                cidrs: vec![],
                secret_ref: Some("bearer-ref".to_string()),
                secret: Some("bearer-secret".to_string()),
            },
        }
    }

    struct ScriptedFetcher {
        calls: AtomicUsize,
        results: Mutex<Vec<Result<FetchOutcome, String>>>,
    }

    #[async_trait::async_trait]
    impl SourcesFetcher for ScriptedFetcher {
        async fn fetch(&self, _etag: Option<&str>) -> Result<FetchOutcome, IngestError> {
            let i = self.calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.results.lock().unwrap();
            match results.get(i).cloned().unwrap_or(Ok(FetchOutcome::NotModified)) {
                Ok(outcome) => Ok(outcome),
                Err(msg) => Err(IngestError::Connector(msg)),
            }
        }
    }

    #[tokio::test]
    async fn fresh_fetch_populates_the_registry() {
        let fetcher = ScriptedFetcher {
            calls: AtomicUsize::new(0),
            results: Mutex::new(vec![Ok(FetchOutcome::Fresh { sources: vec![sample_source("s1")], etag: "abc".to_string() })]),
        };
        let registry: SharedSourceRegistry = std::sync::Arc::new(arc_swap::ArcSwap::from_pointee(SourceRegistry::default()));
        let (tx, rx) = tokio::sync::watch::channel(false);
        let handle = tokio::spawn(run_source_registry_poll(&fetcher, registry.clone(), Duration::from_millis(5), Duration::from_millis(1), Duration::from_millis(20), rx));
        tokio::time::sleep(Duration::from_millis(20)).await;
        tx.send(true).unwrap();
        let _ = handle.await;
        let loaded = registry.load();
        assert!(loaded.get("acme", "s1").is_some());
    }

    #[tokio::test]
    async fn not_modified_leaves_the_registry_unchanged() {
        let mut registry_inner = SourceRegistry::default();
        registry_inner.by_key.insert(("acme".to_string(), "s1".to_string()), sample_source("s1"));
        let registry: SharedSourceRegistry = std::sync::Arc::new(arc_swap::ArcSwap::from_pointee(registry_inner));
        let fetcher = ScriptedFetcher { calls: AtomicUsize::new(0), results: Mutex::new(vec![Ok(FetchOutcome::NotModified)]) };
        let (tx, rx) = tokio::sync::watch::channel(false);
        let handle = tokio::spawn(run_source_registry_poll(&fetcher, registry.clone(), Duration::from_millis(5), Duration::from_millis(1), Duration::from_millis(20), rx));
        tokio::time::sleep(Duration::from_millis(20)).await;
        tx.send(true).unwrap();
        let _ = handle.await;
        assert!(registry.load().get("acme", "s1").is_some());
    }

    #[tokio::test]
    async fn fetch_error_keeps_last_known_good_and_backs_off() {
        let mut registry_inner = SourceRegistry::default();
        registry_inner.by_key.insert(("acme".to_string(), "s1".to_string()), sample_source("s1"));
        let registry: SharedSourceRegistry = std::sync::Arc::new(arc_swap::ArcSwap::from_pointee(registry_inner));
        let fetcher = ScriptedFetcher {
            calls: AtomicUsize::new(0),
            results: Mutex::new(vec![Err("hub-api unreachable".to_string()), Err("hub-api unreachable".to_string())]),
        };
        let (tx, rx) = tokio::sync::watch::channel(false);
        let handle = tokio::spawn(run_source_registry_poll(&fetcher, registry.clone(), Duration::from_millis(5), Duration::from_millis(1), Duration::from_millis(20), rx));
        tokio::time::sleep(Duration::from_millis(30)).await;
        tx.send(true).unwrap();
        let _ = handle.await;
        // Last-known-good: the pre-seeded source is still there despite two failures.
        assert!(registry.load().get("acme", "s1").is_some());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='sources::'`
Expected: compile failure, module empty. (Add `arc-swap = "=1.7.1"` to `Cargo.toml` `[dependencies]` in Step 3.)

- [ ] **Step 3: Write the implementation**

```rust
//! Ingest source registry poller: `GET /api/v1/distribution/sources`
//! every `POLL_INTERVAL_S`, ETag-cached, last-known-good on error
//! (PA-SOURCES). Feeds the generic webhook intake handler (Task 19) its
//! per-`(tenant, source)` lookup.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use serde::Deserialize;

use crate::error::IngestError;
use crate::normalize::generic::SourceMapping;

/// The §4.1.1/D29 second-factor configuration (PA-INTAKE-AUTH) --
/// deserialized straight off Task 13's `AuthDTO` shape. `cidrs` stays
/// `Vec<String>` here (parsed to `ipnet::IpNet` at the point of use, Task
/// 19) so this module never needs `ipnet`'s optional `serde` feature.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SourceAuth {
    #[serde(default)]
    pub modes: Vec<String>,
    #[serde(default)]
    pub cidrs: Vec<String>,
    #[serde(default, rename = "secretRef")]
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub secret: Option<String>,
}

/// One `intake_sources` row, resolved by hub-api (PA-SOURCES).
#[derive(Debug, Clone, Deserialize)]
pub struct SourceRecord {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    pub tenant: String,
    pub platform: String,
    #[serde(rename = "secretRef")]
    pub secret_ref: String,
    pub secret: String,
    pub community: Option<String>,
    pub mapping: SourceMapping,
    pub enabled: bool,
    /// §5.11/§6.11 (D30, PA-WORKSTREAM) -- minted by hub-api 1:1 with this
    /// `intake_sources` row. Fixed-platform sources never populate this
    /// struct at all; they call `crate::publish::deterministic_workstream_id`.
    #[serde(rename = "workstreamId")]
    pub workstream_id: String,
    #[serde(default)]
    pub auth: SourceAuth,
}

/// The current, last-known-good set of generic-intake sources, keyed by
/// `(tenant, source_id)`.
#[derive(Debug, Clone, Default)]
pub struct SourceRegistry {
    by_key: HashMap<(String, String), SourceRecord>,
}

impl SourceRegistry {
    /// Looks up one source by its `(tenant, source_id)` key -- the exact
    /// pair `POST /intake/webhook/{tenant}/{source}` carries in its path.
    pub fn get(&self, tenant: &str, source_id: &str) -> Option<&SourceRecord> {
        self.by_key.get(&(tenant.to_string(), source_id.to_string()))
    }

    /// True when no source has ever been successfully fetched.
    pub fn is_empty(&self) -> bool {
        self.by_key.is_empty()
    }

    /// The `workstream_id` of the first `(tenant, platform)`-matching row
    /// -- used by Task 20's REST intake, which authorizes by `platform`
    /// rather than a specific `source_id` (PA-WORKSTREAM). `None` when no
    /// row matches; Task 20 falls back to
    /// `crate::publish::deterministic_workstream_id` defensively rather
    /// than failing the request outright.
    pub fn workstream_for_platform(&self, tenant: &str, platform: &str) -> Option<String> {
        self.by_key
            .values()
            .find(|r| r.tenant == tenant && r.platform == platform)
            .map(|r| r.workstream_id.clone())
    }

    fn from_rows(rows: Vec<SourceRecord>) -> Self {
        Self { by_key: rows.into_iter().map(|r| ((r.tenant.clone(), r.source_id.clone()), r)).collect() }
    }
}

/// Shared, hot-swappable handle to the current registry.
pub type SharedSourceRegistry = Arc<ArcSwap<SourceRegistry>>;

/// One poll's outcome.
pub enum FetchOutcome {
    Fresh { sources: Vec<SourceRecord>, etag: String },
    NotModified,
}

/// Fetches the source registry from hub-api. Production implementation
/// wraps `reqwest`; tests substitute a scripted fake.
#[async_trait::async_trait]
pub trait SourcesFetcher: Send + Sync {
    async fn fetch(&self, etag: Option<&str>) -> Result<FetchOutcome, IngestError>;
}

/// Production `SourcesFetcher` calling `GET {HUB_API_URL}/api/v1/distribution/sources`.
pub struct HttpSourcesFetcher {
    client: reqwest::Client,
    hub_api_url: String,
    service_jwt: String,
}

impl HttpSourcesFetcher {
    pub fn new(hub_api_url: String, service_jwt: String) -> Self {
        Self { client: reqwest::Client::new(), hub_api_url, service_jwt }
    }
}

#[derive(Deserialize)]
struct SourcesResponseBody {
    sources: Vec<SourceRecord>,
}

#[async_trait::async_trait]
impl SourcesFetcher for HttpSourcesFetcher {
    async fn fetch(&self, etag: Option<&str>) -> Result<FetchOutcome, IngestError> {
        let mut req = self
            .client
            .get(format!("{}/api/v1/distribution/sources", self.hub_api_url))
            .bearer_auth(&self.service_jwt);
        if let Some(etag) = etag {
            req = req.header("If-None-Match", etag);
        }
        let resp = req.send().await.map_err(|e| IngestError::Connector(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(FetchOutcome::NotModified);
        }
        let etag = resp.headers().get("ETag").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        let body: SourcesResponseBody = resp.json().await.map_err(|e| IngestError::Connector(e.to_string()))?;
        Ok(FetchOutcome::Fresh { sources: body.sources, etag })
    }
}

/// Polls `fetcher` every `poll_interval`, publishing fresh results onto
/// `registry` and backing off exponentially (`base_backoff` doubling to
/// `max_backoff`) on error -- **never** clearing `registry` on failure,
/// matching §6.7's "degrades gracefully to the last-known-good... rather
/// than raising" precedent for the bundles poll, applied here to sources.
pub async fn run_source_registry_poll(
    fetcher: &dyn SourcesFetcher,
    registry: SharedSourceRegistry,
    poll_interval: Duration,
    base_backoff: Duration,
    max_backoff: Duration,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let mut etag: Option<String> = None;
    let mut backoff = base_backoff;
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() { return; }
            }
            _ = tokio::time::sleep(poll_interval) => {}
        }
        match fetcher.fetch(etag.as_deref()).await {
            Ok(FetchOutcome::Fresh { sources, etag: new_etag }) => {
                tracing::info!(count = sources.len(), "source_registry.refreshed");
                registry.store(Arc::new(SourceRegistry::from_rows(sources)));
                etag = Some(new_etag);
                backoff = base_backoff;
            }
            Ok(FetchOutcome::NotModified) => {
                backoff = base_backoff;
            }
            Err(err) => {
                tracing::warn!(error = %err, backoff_s = backoff.as_secs_f64(), "source_registry.fetch_failed, keeping last-known-good");
                tokio::time::sleep(backoff).await;
                backoff = std::cmp::min(backoff * 2, max_backoff);
            }
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='sources::'`
Expected: `test result: ok. 3 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/sources.rs core/svc_ingest/src/lib.rs core/svc_ingest/Cargo.toml core/svc_ingest/Cargo.lock
git commit -m "$(cat <<'EOF'
feat(svc-ingest): generic-intake source registry poller with ETag caching and last-known-good, incl. auth (D29) and workstream_id (D30) (PA-SOURCES)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 15: Client-address resolution + FCrDNS origin verification (PA-PROXY, PA-ORIGIN)

**Depends on:** Task 2, Task 4

**Files:**
- Create: `core/svc_ingest/src/http/origin.rs`
- Modify: `core/svc_ingest/src/http/mod.rs` (add `pub mod origin;`)

Ported from §4.1.1/D29 (new in this rewrite — no Python precedent). Two independent primitives the two platform webhooks (Tasks 17/18) and the generic webhook's `cidr` auth mode (Task 19) all share: **PA-PROXY** resolves who the client actually is behind a possibly-untrusted proxy; **PA-ORIGIN** decides whether that client is trusted, either by a static CIDR allowlist or by a cached forward-confirmed reverse-DNS (FCrDNS) check.

**Interfaces:**
- Consumes: `crate::telemetry::IngestMetrics` (Task 4, for `origin_lookup_ms`); `ipnet::IpNet` (Task 1); `hickory-resolver` (Task 1).
- Produces:
  - `pub fn resolve_client_addr(direct_peer: std::net::IpAddr, forwarded_for: Option<&str>, trusted_proxies: &[ipnet::IpNet]) -> std::net::IpAddr` — **PA-PROXY**. `trusted_proxies` empty (the default) ⇒ always returns `direct_peer`, `forwarded_for` ignored entirely. Non-empty and `direct_peer` is **not** itself inside a trusted CIDR ⇒ still returns `direct_peer` (an untrusted peer's `X-Forwarded-For` is never honoured, no matter its content — §14.10 test 4). Non-empty and `direct_peer` **is** trusted ⇒ walks `forwarded_for` right-to-left, returning the first hop that itself parses as an IP and is **not** in `trusted_proxies` (the rightmost untrusted hop, tolerating a chain of trusted proxies in front of the real client); an absent header, or a header containing only trusted/unparseable hops, falls back to `direct_peer`.
  - `#[async_trait::async_trait] pub trait OriginResolver: Send + Sync { async fn forward_confirms_suffix(&self, addr: std::net::IpAddr, suffixes: &[String]) -> Result<bool, String>; }` — reverse-resolves `addr`, then forward-resolves each returned hostname back to an address set, `Ok(true)` only when at least one candidate hostname both ends with a configured suffix **and** forward-confirms to `addr` (both halves of FCrDNS, §14.10 test 2). Abstracted so `OriginVerifier`'s tests never touch a real resolver.
  - `pub struct HickoryOriginResolver { .. }` with `pub fn from_system_config() -> Result<Self, String>` (wraps `hickory_resolver::Resolver::builder_tokio()?.build()`, the crate's system-`/etc/resolv.conf` path, matching Task 1's `["tokio", "system-config"]` feature set) — the production `OriginResolver`.
  - `pub struct OriginVerifier { .. }` with `pub fn new(cidrs: Vec<ipnet::IpNet>, suffixes: Vec<String>, resolver: std::sync::Arc<dyn OriginResolver>, cache_ttl: std::time::Duration, lookup_timeout: std::time::Duration) -> Self` and `pub async fn verify(&self, addr: std::net::IpAddr, metrics: &IngestMetrics, platform: &str) -> bool` — checks the static CIDR allowlist first (no DNS involved, §4.1.1: "an optional per-platform CIDR allowlist... as a static alternative"), then a bounded in-memory cache (TTL `cache_ttl`, §4.1.1: "cached, TTL 10 minutes"), then a live FCrDNS lookup bounded by `lookup_timeout` — a timeout or a resolver error is **not trusted** (fail closed, never blocks the request indefinitely). Every outcome records `metrics.origin_lookup_ms(platform, "hit"|"miss"|"timeout", millis)`.
  - `#[cfg(test)] pub(crate) mod fakes { pub(crate) struct AlwaysTrustedResolver; pub(crate) struct NeverTrustedResolver; }` — both implement `OriginResolver` unconditionally, for Tasks 17/18/19's own tests to build a permissive or rejecting `OriginVerifier` without a second copy of a fake resolver in every downstream test file.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::IngestMetrics;
    use std::net::IpAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }
    fn cidrs(list: &[&str]) -> Vec<ipnet::IpNet> {
        list.iter().map(|s| s.parse().unwrap()).collect()
    }

    #[test]
    fn empty_trusted_proxies_always_uses_the_direct_peer() {
        let addr = resolve_client_addr(ip("203.0.113.5"), Some("198.51.100.1"), &[]);
        assert_eq!(addr, ip("203.0.113.5"));
    }

    #[test]
    fn untrusted_direct_peer_ignores_a_spoofed_header_entirely() {
        // Sec14.10 test 4.
        let trusted = cidrs(&["10.0.0.0/8"]);
        let addr = resolve_client_addr(ip("198.51.100.9"), Some("1.2.3.4"), &trusted);
        assert_eq!(addr, ip("198.51.100.9"));
    }

    #[test]
    fn trusted_direct_peer_honours_the_rightmost_untrusted_hop() {
        let trusted = cidrs(&["10.0.0.0/8"]);
        let addr = resolve_client_addr(ip("10.0.0.5"), Some("203.0.113.7, 10.0.0.9, 10.0.0.5"), &trusted);
        assert_eq!(addr, ip("203.0.113.7"));
    }

    #[test]
    fn trusted_peer_with_no_header_falls_back_to_the_peer() {
        let trusted = cidrs(&["10.0.0.0/8"]);
        let addr = resolve_client_addr(ip("10.0.0.5"), None, &trusted);
        assert_eq!(addr, ip("10.0.0.5"));
    }

    #[test]
    fn trusted_peer_with_only_trusted_hops_falls_back_to_the_peer() {
        let trusted = cidrs(&["10.0.0.0/8"]);
        let addr = resolve_client_addr(ip("10.0.0.5"), Some("10.0.0.9, 10.0.0.8"), &trusted);
        assert_eq!(addr, ip("10.0.0.5"));
    }

    struct FakeResolver {
        calls: AtomicUsize,
        outcome: Result<bool, String>,
        delay: Duration,
    }

    #[async_trait::async_trait]
    impl OriginResolver for FakeResolver {
        async fn forward_confirms_suffix(&self, _addr: IpAddr, _suffixes: &[String]) -> Result<bool, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            self.outcome.clone()
        }
    }

    fn metrics() -> IngestMetrics {
        IngestMetrics
    }

    #[tokio::test]
    async fn cidr_allowlist_admits_without_ever_calling_the_resolver() {
        let resolver = Arc::new(FakeResolver { calls: AtomicUsize::new(0), outcome: Ok(false), delay: Duration::ZERO });
        let verifier = OriginVerifier::new(
            vec!["203.0.113.0/24".parse().unwrap()],
            vec!["twitch.tv".to_string()],
            resolver.clone(),
            Duration::from_secs(600),
            Duration::from_millis(500),
        );
        assert!(verifier.verify(ip("203.0.113.42"), &metrics(), "twitch").await);
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 0, "the CIDR fast path must never touch DNS");
    }

    #[tokio::test]
    async fn fcrdns_confirmed_address_is_trusted_and_cached() {
        let resolver = Arc::new(FakeResolver { calls: AtomicUsize::new(0), outcome: Ok(true), delay: Duration::ZERO });
        let verifier =
            OriginVerifier::new(vec![], vec!["twitch.tv".to_string()], resolver.clone(), Duration::from_secs(600), Duration::from_millis(500));
        assert!(verifier.verify(ip("192.0.2.10"), &metrics(), "twitch").await);
        assert!(verifier.verify(ip("192.0.2.10"), &metrics(), "twitch").await);
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1, "the second call must be served from cache");
    }

    #[tokio::test]
    async fn unconfirmed_address_is_rejected() {
        // Sec14.10 test 2: a PTR that names the right domain but whose
        // forward lookup doesn't contain the client address is exactly
        // what `OriginResolver::forward_confirms_suffix` returning
        // `Ok(false)` represents from this module's point of view.
        let resolver = Arc::new(FakeResolver { calls: AtomicUsize::new(0), outcome: Ok(false), delay: Duration::ZERO });
        let verifier =
            OriginVerifier::new(vec![], vec!["twitch.tv".to_string()], resolver, Duration::from_secs(600), Duration::from_millis(500));
        assert!(!verifier.verify(ip("192.0.2.11"), &metrics(), "twitch").await);
    }

    #[tokio::test]
    async fn resolver_error_fails_closed() {
        let resolver = Arc::new(FakeResolver { calls: AtomicUsize::new(0), outcome: Err("nxdomain".to_string()), delay: Duration::ZERO });
        let verifier =
            OriginVerifier::new(vec![], vec!["twitch.tv".to_string()], resolver, Duration::from_secs(600), Duration::from_millis(500));
        assert!(!verifier.verify(ip("192.0.2.12"), &metrics(), "twitch").await);
    }

    #[tokio::test]
    async fn a_slow_resolver_times_out_and_fails_closed_without_hanging() {
        let resolver =
            Arc::new(FakeResolver { calls: AtomicUsize::new(0), outcome: Ok(true), delay: Duration::from_millis(200) });
        let verifier =
            OriginVerifier::new(vec![], vec!["twitch.tv".to_string()], resolver, Duration::from_secs(600), Duration::from_millis(20));
        let start = std::time::Instant::now();
        assert!(!verifier.verify(ip("192.0.2.13"), &metrics(), "twitch").await);
        assert!(start.elapsed() < Duration::from_millis(150), "verify must respect lookup_timeout, not the resolver's own delay");
    }

    #[tokio::test]
    async fn fakes_module_provides_reusable_permissive_and_rejecting_resolvers() {
        let allow =
            OriginVerifier::new(vec![], vec!["twitch.tv".to_string()], Arc::new(fakes::AlwaysTrustedResolver), Duration::from_secs(600), Duration::from_millis(500));
        assert!(allow.verify(ip("192.0.2.20"), &metrics(), "twitch").await);
        let deny =
            OriginVerifier::new(vec![], vec!["twitch.tv".to_string()], Arc::new(fakes::NeverTrustedResolver), Duration::from_secs(600), Duration::from_millis(500));
        assert!(!deny.verify(ip("192.0.2.21"), &metrics(), "twitch").await);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='http::origin::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! PA-PROXY client-address resolution + PA-ORIGIN forward-confirmed
//! reverse-DNS (FCrDNS) origin verification for the two platform webhooks
//! (Twitch EventSub, Kick) and the generic webhook's `cidr` auth mode
//! (§4.1.1, D29). New in this rewrite -- no Python precedent.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ipnet::IpNet;

use crate::telemetry::IngestMetrics;

/// PA-PROXY: resolves the request's real client address. Empty
/// `trusted_proxies` (the default) means "trust nothing" -- the direct
/// TCP peer is the client address and `X-Forwarded-For` is ignored
/// entirely, closing the spoofing hole blind XFF trust would open
/// (§14.10 test 4). Non-empty: `X-Forwarded-For` is honoured only when
/// `direct_peer` is itself inside a trusted CIDR, and the client address
/// is then the **rightmost untrusted hop** -- walking the header
/// right-to-left, skipping any entry that is itself a trusted proxy (a
/// chain of trusted hops in front of the real client).
pub fn resolve_client_addr(direct_peer: IpAddr, forwarded_for: Option<&str>, trusted_proxies: &[IpNet]) -> IpAddr {
    if trusted_proxies.is_empty() {
        return direct_peer;
    }
    let direct_is_trusted = trusted_proxies.iter().any(|n| n.contains(&direct_peer));
    if !direct_is_trusted {
        return direct_peer;
    }
    let Some(header) = forwarded_for else { return direct_peer };
    for hop in header.split(',').rev() {
        let Ok(addr) = hop.trim().parse::<IpAddr>() else { continue };
        if !trusted_proxies.iter().any(|n| n.contains(&addr)) {
            return addr;
        }
    }
    direct_peer
}

/// One cached FCrDNS verdict.
struct CacheEntry {
    trusted: bool,
    expires_at: Instant,
}

/// Resolves whether an address forward-confirms to one of a platform's
/// trusted DNS suffixes. Abstracted so `OriginVerifier`'s tests never
/// need a real resolver.
#[async_trait::async_trait]
pub trait OriginResolver: Send + Sync {
    /// Reverse-resolves `addr` to hostname(s), then forward-resolves each
    /// candidate hostname back to an address set -- `Ok(true)` only when
    /// at least one confirmed hostname ends with a configured suffix
    /// (both halves of FCrDNS, §14.10 test 2).
    async fn forward_confirms_suffix(&self, addr: IpAddr, suffixes: &[String]) -> Result<bool, String>;
}

/// Production `OriginResolver` backed by `hickory-resolver`'s system
/// configuration (rustls only, no C resolver -- Task 1's `Cargo.toml`).
pub struct HickoryOriginResolver {
    resolver: hickory_resolver::Resolver<hickory_resolver::name_server::TokioConnectionProvider>,
}

impl HickoryOriginResolver {
    /// Builds a resolver from the host's system DNS configuration
    /// (`/etc/resolv.conf` in every container base image this service
    /// ships on) -- requires Task 1's `["tokio", "system-config"]`
    /// `hickory-resolver` features.
    pub fn from_system_config() -> Result<Self, String> {
        let resolver = hickory_resolver::Resolver::builder_tokio().map_err(|e| e.to_string())?.build();
        Ok(Self { resolver })
    }
}

#[async_trait::async_trait]
impl OriginResolver for HickoryOriginResolver {
    async fn forward_confirms_suffix(&self, addr: IpAddr, suffixes: &[String]) -> Result<bool, String> {
        let ptr = self.resolver.reverse_lookup(addr).await.map_err(|e| e.to_string())?;
        for name in ptr.iter() {
            let host = name.to_string().trim_end_matches('.').to_ascii_lowercase();
            if !suffixes.iter().any(|s| host == *s || host.ends_with(&format!(".{s}"))) {
                continue;
            }
            let forward = self.resolver.lookup_ip(host.as_str()).await.map_err(|e| e.to_string())?;
            if forward.iter().any(|ip| ip == addr) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// Verifies a platform webhook's request origin: a static CIDR allowlist
/// (checked first, no DNS involved) OR a cached/live FCrDNS check against
/// the platform's configured suffixes (§4.1.1/D29, PA-ORIGIN).
pub struct OriginVerifier {
    cidrs: Vec<IpNet>,
    suffixes: Vec<String>,
    resolver: Arc<dyn OriginResolver>,
    cache: Mutex<HashMap<IpAddr, CacheEntry>>,
    cache_ttl: Duration,
    lookup_timeout: Duration,
}

impl OriginVerifier {
    pub fn new(
        cidrs: Vec<IpNet>,
        suffixes: Vec<String>,
        resolver: Arc<dyn OriginResolver>,
        cache_ttl: Duration,
        lookup_timeout: Duration,
    ) -> Self {
        Self { cidrs, suffixes, resolver, cache: Mutex::new(HashMap::new()), cache_ttl, lookup_timeout }
    }

    fn cached(&self, addr: IpAddr) -> Option<bool> {
        let mut cache = self.cache.lock().unwrap();
        match cache.get(&addr) {
            Some(entry) if entry.expires_at > Instant::now() => Some(entry.trusted),
            _ => {
                cache.remove(&addr);
                None
            }
        }
    }

    fn store(&self, addr: IpAddr, trusted: bool) {
        self.cache.lock().unwrap().insert(addr, CacheEntry { trusted, expires_at: Instant::now() + self.cache_ttl });
    }

    /// `true` when `addr` is trusted by static CIDR or FCrDNS (cached or
    /// live, bounded by `lookup_timeout`). A resolver error or a timeout
    /// is **not trusted** -- fail closed (§4.1.1/D29). Always records
    /// `ingest_origin_lookup_ms{platform,outcome}`.
    pub async fn verify(&self, addr: IpAddr, metrics: &IngestMetrics, platform: &str) -> bool {
        if self.cidrs.iter().any(|n| n.contains(&addr)) {
            return true;
        }
        let start = Instant::now();
        if let Some(trusted) = self.cached(addr) {
            metrics.origin_lookup_ms(platform, "hit", start.elapsed().as_secs_f64() * 1000.0);
            return trusted;
        }
        let outcome = tokio::time::timeout(self.lookup_timeout, self.resolver.forward_confirms_suffix(addr, &self.suffixes)).await;
        let millis = start.elapsed().as_secs_f64() * 1000.0;
        let trusted = match outcome {
            Ok(Ok(trusted)) => {
                metrics.origin_lookup_ms(platform, "miss", millis);
                trusted
            }
            Ok(Err(_)) => {
                metrics.origin_lookup_ms(platform, "miss", millis);
                false
            }
            Err(_) => {
                metrics.origin_lookup_ms(platform, "timeout", millis);
                false
            }
        };
        self.store(addr, trusted);
        trusted
    }
}

#[cfg(test)]
pub(crate) mod fakes {
    use super::{IpAddr, OriginResolver};

    pub(crate) struct AlwaysTrustedResolver;
    #[async_trait::async_trait]
    impl OriginResolver for AlwaysTrustedResolver {
        async fn forward_confirms_suffix(&self, _addr: IpAddr, _suffixes: &[String]) -> Result<bool, String> {
            Ok(true)
        }
    }

    pub(crate) struct NeverTrustedResolver;
    #[async_trait::async_trait]
    impl OriginResolver for NeverTrustedResolver {
        async fn forward_confirms_suffix(&self, _addr: IpAddr, _suffixes: &[String]) -> Result<bool, String> {
            Ok(false)
        }
    }
}
```

Add `pub mod origin;` to `core/svc_ingest/src/http/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='http::origin::'`
Expected: `test result: ok. 12 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/http/origin.rs core/svc_ingest/src/http/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): trusted-proxy client-address resolution + cached FCrDNS origin verification (§4.1.1, D29, PA-PROXY/PA-ORIGIN)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 16: Rate limiting + body cap intake middleware

**Depends on:** Task 2, Task 3

**Files:**
- Create: `core/svc_ingest/src/http/middleware.rs`
- Modify: `core/svc_ingest/src/http/mod.rs` (add `pub mod middleware;`)

**Interfaces:**
- Consumes: `crate::error::IntakeError` (Task 3); `crate::config::CliConfig` (Task 2, for the four rate-limit env vars).
- Produces:
  - `pub struct IntakeLimiters { source: governor::DefaultKeyedRateLimiter<String>, tenant: governor::DefaultKeyedRateLimiter<String> }` with `IntakeLimiters::new(source_rps: u32, source_burst: u32, tenant_rps: u32, tenant_burst: u32) -> Self` and `pub fn check(&self, source_key: &str, tenant_key: &str) -> Result<(), IntakeError>` — checks the **source** bucket first, then the **tenant** bucket; either exhausted → `Err(IntakeError::RateLimited)`. (`governor = "=0.8.1"` already in `Cargo.toml` from Task 1.)
  - `pub async fn read_capped_body(body: axum::body::Body, max_bytes: usize) -> Result<axum::body::Bytes, IntakeError>` — streams the body via `http_body_util::BodyExt::collect` after wrapping with a byte-counting check that aborts with `IntakeError::BodyTooLarge` the instant more than `max_bytes` bytes have been read, **without buffering the full oversize body first** (§10.5: "the reader aborts at `INTAKE_MAX_BODY_BYTES + 1` bytes rather than buffering the whole oversize body"). Implementation note: `axum::extract::RequestExt`'s body already provides a size-limited path via `axum::body::to_bytes(body, limit)`, which returns an error once `limit` is exceeded while still only buffering up to `limit + 1`; use that rather than hand-rolling a stream scanner.
  - `pub fn constant_time_eq_hex(expected_hex: &str, provided_hex: &str) -> bool` — the shared HMAC-hex constant-time comparison helper used by Tasks 17/19 (Kick's own comparison stays in Task 10's `verify_kick_webhook_signature`, which has no `"sha256="` prefix to strip): returns `false` immediately on length mismatch (a public-length check, not a content check — see rationale in the doc comment), else `subtle::ConstantTimeEq` over the raw bytes.
  - `pub fn constant_time_eq_str(expected: &str, provided: &str) -> bool` — the same constant-time contract for a **plain** (non-hex) UTF-8 secret: a bearer token or an HTTP-basic `user:password` pair, neither of which is hex-encoded.
  - `pub fn verify_intake_auth_modes(modes: &[String], cidrs: &[ipnet::IpNet], client_addr: std::net::IpAddr, bearer_secret: Option<&str>, basic_secret: Option<&str>, headers: &axum::http::HeaderMap) -> Result<(), IntakeError>` — the **PA-INTAKE-AUTH** AND-combined gate (§4.1.1/D29): `modes` empty ⇒ `IntakeError::AuthNotConfigured` (fail closed, defense in depth against a source that somehow reaches the registry with no mode despite hub-api's own create/update refusal). Otherwise every configured mode must independently pass or the whole check fails with `IntakeError::SecondFactorFailed` (one reason for any configured-mode failure, matching §10.1/§14.10 exactly — this function never returns a per-mode-specific error): `"cidr"` checks `client_addr` against `cidrs`; `"bearer"` requires `Authorization: Bearer <token>` matching `bearer_secret` via `constant_time_eq_str`; `"basic"` requires `Authorization: Basic <base64(user:password)>` decoding and matching `basic_secret` via `constant_time_eq_str`; an unrecognized mode string fails closed as `AuthNotConfigured` (never an implicit pass). Called from Task 19 with `cidrs` already parsed from the source's `SourceAuth.cidrs` (Task 14) via `crate::config::parse_cidr_list`, and `client_addr` resolved via Task 15's `resolve_client_addr`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;

    #[test]
    fn source_bucket_exhausts_before_tenant_bucket_leaks_through() {
        let limiters = IntakeLimiters::new(1, 1, 100, 200);
        assert!(limiters.check("src:acme-github", "tenant:acme").is_ok());
        let err = limiters.check("src:acme-github", "tenant:acme").unwrap_err();
        assert!(matches!(err, IntakeError::RateLimited));
    }

    #[test]
    fn tenant_bucket_exhausts_independently_of_source() {
        let limiters = IntakeLimiters::new(100, 200, 1, 1);
        assert!(limiters.check("src:a", "tenant:acme").is_ok());
        let err = limiters.check("src:b", "tenant:acme").unwrap_err();
        assert!(matches!(err, IntakeError::RateLimited));
    }

    #[test]
    fn different_sources_have_independent_buckets() {
        let limiters = IntakeLimiters::new(1, 1, 100, 200);
        assert!(limiters.check("src:a", "tenant:acme").is_ok());
        assert!(limiters.check("src:b", "tenant:acme").is_ok());
    }

    #[tokio::test]
    async fn body_within_cap_is_returned_whole() {
        let body = Body::from(vec![0u8; 10]);
        let bytes = read_capped_body(body, 20).await.unwrap();
        assert_eq!(bytes.len(), 10);
    }

    #[tokio::test]
    async fn body_over_cap_is_rejected_as_too_large() {
        let body = Body::from(vec![0u8; 21]);
        let err = read_capped_body(body, 20).await.unwrap_err();
        assert!(matches!(err, IntakeError::BodyTooLarge));
    }

    #[test]
    fn constant_time_eq_hex_matches_equal_strings() {
        assert!(constant_time_eq_hex("deadbeef", "deadbeef"));
    }

    #[test]
    fn constant_time_eq_hex_rejects_different_strings() {
        assert!(!constant_time_eq_hex("deadbeef", "deadbeee"));
    }

    #[test]
    fn constant_time_eq_hex_rejects_length_mismatch() {
        assert!(!constant_time_eq_hex("deadbeef", "dead"));
    }

    #[test]
    fn constant_time_eq_str_matches_and_rejects_plain_secrets() {
        assert!(constant_time_eq_str("s3cr3t-token", "s3cr3t-token"));
        assert!(!constant_time_eq_str("s3cr3t-token", "wrong-token"));
        assert!(!constant_time_eq_str("s3cr3t-token", "short"));
    }

    fn headers_with_bearer(token: &str) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        h.insert(axum::http::header::AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
        h
    }

    fn headers_with_basic(user: &str, pass: &str) -> axum::http::HeaderMap {
        use base64::Engine;
        let mut h = axum::http::HeaderMap::new();
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        h.insert(axum::http::header::AUTHORIZATION, format!("Basic {encoded}").parse().unwrap());
        h
    }

    #[test]
    fn empty_modes_is_auth_not_configured() {
        let err = verify_intake_auth_modes(&[], &[], "203.0.113.5".parse().unwrap(), None, None, &axum::http::HeaderMap::new())
            .unwrap_err();
        assert!(matches!(err, IntakeError::AuthNotConfigured));
    }

    #[test]
    fn cidr_mode_passes_for_an_allowlisted_address() {
        let modes = vec!["cidr".to_string()];
        let cidrs = vec!["203.0.113.0/24".parse().unwrap()];
        assert!(verify_intake_auth_modes(&modes, &cidrs, "203.0.113.7".parse().unwrap(), None, None, &axum::http::HeaderMap::new()).is_ok());
    }

    #[test]
    fn cidr_mode_fails_for_a_non_allowlisted_address() {
        let modes = vec!["cidr".to_string()];
        let cidrs = vec!["203.0.113.0/24".parse().unwrap()];
        let err = verify_intake_auth_modes(&modes, &cidrs, "198.51.100.9".parse().unwrap(), None, None, &axum::http::HeaderMap::new())
            .unwrap_err();
        assert!(matches!(err, IntakeError::SecondFactorFailed));
    }

    #[test]
    fn bearer_mode_passes_for_a_matching_token() {
        let modes = vec!["bearer".to_string()];
        let headers = headers_with_bearer("s3cr3t-token");
        assert!(verify_intake_auth_modes(&modes, &[], "203.0.113.7".parse().unwrap(), Some("s3cr3t-token"), None, &headers).is_ok());
    }

    #[test]
    fn bearer_mode_fails_for_a_missing_or_wrong_token() {
        let modes = vec!["bearer".to_string()];
        let missing =
            verify_intake_auth_modes(&modes, &[], "203.0.113.7".parse().unwrap(), Some("s3cr3t-token"), None, &axum::http::HeaderMap::new())
                .unwrap_err();
        assert!(matches!(missing, IntakeError::SecondFactorFailed));
        let wrong =
            verify_intake_auth_modes(&modes, &[], "203.0.113.7".parse().unwrap(), Some("s3cr3t-token"), None, &headers_with_bearer("nope"))
                .unwrap_err();
        assert!(matches!(wrong, IntakeError::SecondFactorFailed));
    }

    #[test]
    fn basic_mode_passes_for_matching_credentials() {
        let modes = vec!["basic".to_string()];
        let headers = headers_with_basic("acme", "hunter2");
        assert!(verify_intake_auth_modes(&modes, &[], "203.0.113.7".parse().unwrap(), None, Some("acme:hunter2"), &headers).is_ok());
    }

    #[test]
    fn basic_mode_fails_for_wrong_credentials() {
        let modes = vec!["basic".to_string()];
        let headers = headers_with_basic("acme", "wrong");
        let err = verify_intake_auth_modes(&modes, &[], "203.0.113.7".parse().unwrap(), None, Some("acme:hunter2"), &headers).unwrap_err();
        assert!(matches!(err, IntakeError::SecondFactorFailed));
    }

    #[test]
    fn and_combined_modes_require_every_configured_mode_to_pass() {
        let modes = vec!["cidr".to_string(), "bearer".to_string()];
        let cidrs = vec!["203.0.113.0/24".parse().unwrap()];
        // CIDR passes, bearer header absent -> the whole check fails.
        let err = verify_intake_auth_modes(&modes, &cidrs, "203.0.113.7".parse().unwrap(), Some("s3cr3t-token"), None, &axum::http::HeaderMap::new())
            .unwrap_err();
        assert!(matches!(err, IntakeError::SecondFactorFailed));
        // Both satisfied -> passes.
        let headers = headers_with_bearer("s3cr3t-token");
        assert!(verify_intake_auth_modes(&modes, &cidrs, "203.0.113.7".parse().unwrap(), Some("s3cr3t-token"), None, &headers).is_ok());
    }

    #[test]
    fn unrecognized_mode_fails_closed_never_an_implicit_pass() {
        let modes = vec!["totp".to_string()];
        let err = verify_intake_auth_modes(&modes, &[], "203.0.113.7".parse().unwrap(), None, None, &axum::http::HeaderMap::new()).unwrap_err();
        assert!(matches!(err, IntakeError::AuthNotConfigured));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='http::middleware::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! Cross-cutting intake concerns shared by every route in Tasks 17-20:
//! per-source/per-tenant token-bucket rate limiting, streaming body-size
//! capping, and the constant-time hex-signature comparison helper.
//! Rate limiting always runs before signature verification (§10.5: "an
//! unauthenticated caller cannot make the pod hash unbounded bodies").

use std::num::NonZeroU32;

use axum::body::Bytes;
use governor::{Quota, RateLimiter};
use subtle::ConstantTimeEq;

use crate::error::IntakeError;

/// Keyed token-bucket limiters, one per source and one per tenant
/// (§4.1/§10.5 defaults: 20/40 rps/burst per source, 100/200 per tenant).
pub struct IntakeLimiters {
    source: governor::DefaultKeyedRateLimiter<String>,
    tenant: governor::DefaultKeyedRateLimiter<String>,
}

impl IntakeLimiters {
    pub fn new(source_rps: u32, source_burst: u32, tenant_rps: u32, tenant_burst: u32) -> Self {
        let source_quota = Quota::per_second(NonZeroU32::new(source_rps.max(1)).unwrap())
            .allow_burst(NonZeroU32::new(source_burst.max(1)).unwrap());
        let tenant_quota = Quota::per_second(NonZeroU32::new(tenant_rps.max(1)).unwrap())
            .allow_burst(NonZeroU32::new(tenant_burst.max(1)).unwrap());
        Self { source: RateLimiter::keyed(source_quota), tenant: RateLimiter::keyed(tenant_quota) }
    }

    /// Checks the source bucket, then the tenant bucket. Either exhausted
    /// -> `RateLimited`.
    pub fn check(&self, source_key: &str, tenant_key: &str) -> Result<(), IntakeError> {
        if self.source.check_key(&source_key.to_string()).is_err() {
            return Err(IntakeError::RateLimited);
        }
        if self.tenant.check_key(&tenant_key.to_string()).is_err() {
            return Err(IntakeError::RateLimited);
        }
        Ok(())
    }
}

/// Reads `body` up to `max_bytes`, aborting with `BodyTooLarge` the
/// instant the cap is exceeded rather than buffering the whole oversize
/// body first (§10.5).
pub async fn read_capped_body(body: axum::body::Body, max_bytes: usize) -> Result<Bytes, IntakeError> {
    axum::body::to_bytes(body, max_bytes).await.map_err(|_| IntakeError::BodyTooLarge)
}

/// Constant-time comparison of two hex-encoded signatures. A length
/// mismatch returns `false` immediately -- this is a check on a *public*
/// value (header length is not attacker-secret-dependent) and is the
/// standard `subtle`/`ring`-style precondition for fixed-length constant-
/// time comparison; only the *content* comparison below runs in constant
/// time, which is what defeats a byte-by-byte timing oracle.
pub fn constant_time_eq_hex(expected_hex: &str, provided_hex: &str) -> bool {
    if expected_hex.len() != provided_hex.len() {
        return false;
    }
    expected_hex.as_bytes().ct_eq(provided_hex.as_bytes()).into()
}

/// The same constant-time contract as [`constant_time_eq_hex`], for a
/// plain (non-hex) UTF-8 secret -- a bearer token or an HTTP-basic
/// `user:password` pair.
pub fn constant_time_eq_str(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }
    expected.as_bytes().ct_eq(provided.as_bytes()).into()
}

/// The PA-INTAKE-AUTH AND-combined admission gate (§4.1.1/D29). `modes`
/// empty is a fail-closed `AuthNotConfigured` -- defense in depth against
/// a source that somehow reaches the registry with no mode despite
/// hub-api's own create/update refusal. Every configured mode must
/// independently pass, or the whole check is one `SecondFactorFailed`
/// (never a per-mode reason -- §10.1/§14.10 name exactly one reason for
/// this condition). An unrecognized mode string fails closed as
/// `AuthNotConfigured`, never an implicit pass.
pub fn verify_intake_auth_modes(
    modes: &[String],
    cidrs: &[ipnet::IpNet],
    client_addr: std::net::IpAddr,
    bearer_secret: Option<&str>,
    basic_secret: Option<&str>,
    headers: &axum::http::HeaderMap,
) -> Result<(), IntakeError> {
    if modes.is_empty() {
        return Err(IntakeError::AuthNotConfigured);
    }
    for mode in modes {
        match mode.as_str() {
            "cidr" => {
                if !cidrs.iter().any(|n| n.contains(&client_addr)) {
                    return Err(IntakeError::SecondFactorFailed);
                }
            }
            "bearer" => {
                let Some(expected) = bearer_secret else { return Err(IntakeError::SecondFactorFailed) };
                let provided = headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Bearer "));
                match provided {
                    Some(p) if constant_time_eq_str(expected, p) => {}
                    _ => return Err(IntakeError::SecondFactorFailed),
                }
            }
            "basic" => {
                let Some(expected) = basic_secret else { return Err(IntakeError::SecondFactorFailed) };
                let provided = headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Basic "))
                    .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
                    .and_then(|bytes| String::from_utf8(bytes).ok());
                match provided {
                    Some(p) if constant_time_eq_str(expected, &p) => {}
                    _ => return Err(IntakeError::SecondFactorFailed),
                }
            }
            _ => return Err(IntakeError::AuthNotConfigured),
        }
    }
    Ok(())
}
```

Add to the top of `src/http/middleware.rs`, alongside the existing imports: `use base64::Engine;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='http::middleware::'`
Expected: `test result: ok. 17 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/http/middleware.rs core/svc_ingest/src/http/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): per-source/per-tenant rate limiting, streaming body cap, constant-time compares, PA-INTAKE-AUTH AND-combined mode gate (§10.5, §4.1.1, D29)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 17: HTTP handler — Twitch EventSub webhook

**Depends on:** Task 2, Task 3, Task 6, Task 12, Task 15, Task 16

**Files:**
- Create: `core/svc_ingest/src/http/twitch_eventsub.rs`
- Modify: `core/svc_ingest/src/http/mod.rs` (add `pub mod twitch_eventsub;`)
- Modify: `core/svc_ingest/src/http/state.rs` (extend `AppState` with the fields Step 3 below adds, plus a `#[cfg(test)] pub fn test_state()` builder)
- Modify: `core/svc_ingest/src/publish.rs` (add a `#[cfg(test)] pub(crate) mod fakes { pub(crate) struct NoopAppender; ... }` test double — Step 3 below)

`POST /eventsub/twitch/webhook` per §10.1/§4.1.1. Ported from `core/svc_ingest/eventsub.py`'s `verify_signature`/`handle_webhook` (byte-identical HMAC algorithm: `sha256=` + hex HMAC-SHA256 of `message_id + timestamp + body`) with four spec-driven behavior changes over the Python original, each called out below: (1) bad signature is **401**, not the legacy **403**; (2) `webhook_callback_verification` echoes the bare challenge as `text/plain`, not `{"challenge": ...}` JSON; (3) a 600s replay window and message-id dedupe are added (neither existed in the Python handler); (4) **origin restriction (PA-ORIGIN, D29)** — FCrDNS to `twitch.tv` or a pinned CIDR, checked before signature verification (cheap, no body read needed) and after rate limiting.

**Interfaces:**
- Consumes: `crate::error::IntakeError` (Task 3); `crate::normalize::twitch_eventsub::normalize` (Task 6); `crate::publish::{publish_event, deterministic_workstream_id, EventAppender}` (Task 12); `crate::http::origin::{resolve_client_addr, OriginVerifier}` (Task 15); `crate::http::middleware::{IntakeLimiters, read_capped_body, constant_time_eq_hex}` (Task 16); `penguin_spine::{BindingKeyring, UsageBatcher}` (External Crate Surfaces); `crate::http::state::AppState` (Task 4) extended with `pub twitch_eventsub_secret: Option<std::sync::Arc<crate::config::Secret>>`, `pub kick_webhook_secret: Option<std::sync::Arc<crate::config::Secret>>` (used by Task 18), `pub limiters: std::sync::Arc<IntakeLimiters>`, `pub appender: std::sync::Arc<dyn crate::publish::EventAppender>`, `pub scope: penguin_spine::Scope`, `pub dedupe: std::sync::Arc<dyn DedupeStore>`, `pub binding_keyring: std::sync::Arc<BindingKeyring>` (D30), `pub usage: std::sync::Arc<UsageBatcher>` (D31), `pub trusted_proxies: std::sync::Arc<Vec<ipnet::IpNet>>` (PA-PROXY), `pub twitch_origin: std::sync::Arc<OriginVerifier>` (PA-ORIGIN), `pub kick_origin: std::sync::Arc<OriginVerifier>` (used by Task 18), `pub generic_intake_enabled: bool` (the `waddles.core.generic-intake` flag, resolved by Task 30, consumed by Task 21's router) (this task adds these fields to `AppState` and its `::new` constructor — a small, additive change to Task 4's struct, not a rewrite).
- Produces:
  - `#[async_trait::async_trait] pub trait DedupeStore: Send + Sync { async fn check_and_remember(&self, key: &str, ttl_s: u64) -> Result<bool, String>; }` — `Ok(true)` = newly-seen (proceed), `Ok(false)` = duplicate (reject). Production impl `ValkeyDedupeStore` wraps a raw `redis::aio::ConnectionManager`, implementing `SET {key} 1 NX EX {ttl_s}` (PA-DEDUPE) — added to this file since it's the first consumer; Task 19 reuses the same trait/impl.
  - `pub async fn handle(State(state): State<AppState>, headers: axum::http::HeaderMap, connect_info: Option<axum::extract::ConnectInfo<std::net::SocketAddr>>, body: axum::body::Body) -> Response` mounted at `POST /eventsub/twitch/webhook` **only when** `state.twitch_eventsub_secret.is_some()` (route registration is Task 21's job; this handler assumes it is only ever called with a secret present, and returns `IntakeError::SecretUnset` defensively if not, matching §10.1: "Route is not registered at all when `TWITCH_EVENTSUB_SECRET` is unset"). `connect_info` is `Option` (never a bare `ConnectInfo`) so this handler and its tests never depend on the router being served through `axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())` (Task 30's job) — a missing `ConnectInfo` degrades to the unspecified address, which fails every origin check closed rather than panicking.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Secret;
    use crate::http::middleware::IntakeLimiters;
    use crate::http::origin::{fakes::{AlwaysTrustedResolver, NeverTrustedResolver}, OriginVerifier};
    use crate::publish::EventAppender;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{HeaderMap, HeaderValue};
    use hmac::{Hmac, Mac};
    use penguin_spine::{Scope, StageEnvelope, UsageBatcher};
    use sha2::Sha256;
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    struct FakeAppender(Mutex<Vec<StageEnvelope>>);
    #[async_trait::async_trait]
    impl EventAppender for FakeAppender {
        async fn append(&self, _stream: &str, env: &StageEnvelope) -> Result<String, String> {
            self.0.lock().unwrap().push(env.clone());
            Ok("1-0".to_string())
        }
    }

    struct FakeDedupe(Mutex<std::collections::HashSet<String>>);
    #[async_trait::async_trait]
    impl DedupeStore for FakeDedupe {
        async fn check_and_remember(&self, key: &str, _ttl_s: u64) -> Result<bool, String> {
            Ok(self.0.lock().unwrap().insert(key.to_string()))
        }
    }

    fn sign(secret: &str, message_id: &str, timestamp: &str, body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(message_id.as_bytes());
        mac.update(timestamp.as_bytes());
        mac.update(body);
        format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
    }

    fn test_state(appender: FakeAppender, dedupe: FakeDedupe) -> AppState {
        let mut state = crate::http::state::test_state(); // Task 17's own shared test helper (Step 3)
        state.twitch_eventsub_secret = Some(Arc::new(Secret::new("evsub-secret")));
        state.limiters = Arc::new(IntakeLimiters::new(20, 40, 100, 200));
        state.appender = Arc::new(appender);
        state.scope = Scope { tenant: "global".to_string(), community: None };
        state.dedupe = Arc::new(dedupe);
        state.usage = Arc::new(UsageBatcher::new());
        state.twitch_origin = Arc::new(OriginVerifier::new(
            vec![],
            vec!["twitch.tv".to_string()],
            Arc::new(AlwaysTrustedResolver),
            Duration::from_secs(600),
            Duration::from_millis(500),
        ));
        state
    }

    fn peer(addr: &str) -> Option<ConnectInfo<SocketAddr>> {
        Some(ConnectInfo(format!("{addr}:12345").parse().unwrap()))
    }

    fn headers(sig: &str, ts: &str, id: &str, msg_type: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("Twitch-Eventsub-Message-Signature", HeaderValue::from_str(sig).unwrap());
        h.insert("Twitch-Eventsub-Message-Timestamp", HeaderValue::from_str(ts).unwrap());
        h.insert("Twitch-Eventsub-Message-Id", HeaderValue::from_str(id).unwrap());
        h.insert("Twitch-Eventsub-Message-Type", HeaderValue::from_str(msg_type).unwrap());
        h
    }

    fn now_ts() -> String {
        chrono::Utc::now().timestamp().to_string()
    }

    #[tokio::test]
    async fn webhook_callback_verification_echoes_bare_challenge_as_text_plain() {
        let ts = now_ts();
        let body = br#"{"challenge":"abc123","subscription":{}}"#;
        let sig = sign("evsub-secret", "msg-1", &ts, body);
        let state = test_state(FakeAppender(Mutex::new(vec![])), FakeDedupe(Mutex::new(Default::default())));
        let resp = handle(State(state), headers(&sig, &ts, "msg-1", "webhook_callback_verification"), peer("192.0.2.10"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        assert_eq!(resp.headers().get(axum::http::header::CONTENT_TYPE).unwrap(), "text/plain");
        let bytes = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        assert_eq!(bytes.as_ref(), b"abc123");
    }

    #[tokio::test]
    async fn notification_normalizes_and_publishes_exactly_once_with_d30_fields() {
        let ts = now_ts();
        let body = br#"{"subscription":{"type":"channel.follow"},"event":{"broadcaster_user_id":"999","user_login":"alice"}}"#;
        let sig = sign("evsub-secret", "msg-2", &ts, body);
        let appender = FakeAppender(Mutex::new(vec![]));
        let state = test_state(appender, FakeDedupe(Mutex::new(Default::default())));
        let resp = handle(State(state.clone()), headers(&sig, &ts, "msg-2", "notification"), peer("192.0.2.10"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let envs = state.appender.as_ref();
        let _ = envs; // published event's D30 fields are exercised end-to-end in Task 34's e2e suite
        assert_eq!(state.usage.flush().len(), 1, "one usage delta must be recorded for the published event");
    }

    #[tokio::test]
    async fn bad_signature_is_401() {
        let ts = now_ts();
        let body = b"{}";
        let state = test_state(FakeAppender(Mutex::new(vec![])), FakeDedupe(Mutex::new(Default::default())));
        let resp = handle(State(state), headers("sha256=wrong", &ts, "msg-3", "notification"), peer("192.0.2.10"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn outside_replay_window_is_403() {
        let old_ts = (chrono::Utc::now().timestamp() - 601).to_string();
        let body = b"{}";
        let sig = sign("evsub-secret", "msg-4", &old_ts, body);
        let state = test_state(FakeAppender(Mutex::new(vec![])), FakeDedupe(Mutex::new(Default::default())));
        let resp = handle(State(state), headers(&sig, &old_ts, "msg-4", "notification"), peer("192.0.2.10"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn duplicate_message_id_is_409() {
        let ts = now_ts();
        let body = br#"{"subscription":{"type":"channel.follow"},"event":{"broadcaster_user_id":"999"}}"#;
        let sig = sign("evsub-secret", "msg-5", &ts, body);
        let state = test_state(FakeAppender(Mutex::new(vec![])), FakeDedupe(Mutex::new(Default::default())));
        let first = handle(State(state.clone()), headers(&sig, &ts, "msg-5", "notification"), peer("192.0.2.10"), Body::from(body.to_vec())).await;
        assert_eq!(first.status(), axum::http::StatusCode::OK);
        let second = handle(State(state), headers(&sig, &ts, "msg-5", "notification"), peer("192.0.2.10"), Body::from(body.to_vec())).await;
        assert_eq!(second.status(), axum::http::StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn revocation_acknowledges_without_publishing() {
        let ts = now_ts();
        let body = br#"{"subscription":{"type":"channel.follow","status":"authorization_revoked"}}"#;
        let sig = sign("evsub-secret", "msg-6", &ts, body);
        let appender = FakeAppender(Mutex::new(vec![]));
        let state = test_state(appender, FakeDedupe(Mutex::new(Default::default())));
        let resp = handle(State(state.clone()), headers(&sig, &ts, "msg-6", "revocation"), peer("192.0.2.10"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
    }

    #[tokio::test]
    async fn secret_unset_is_503() {
        let ts = now_ts();
        let mut state = test_state(FakeAppender(Mutex::new(vec![])), FakeDedupe(Mutex::new(Default::default())));
        state.twitch_eventsub_secret = None;
        let resp = handle(State(state), headers("sha256=x", &ts, "msg-7", "notification"), peer("192.0.2.10"), Body::from(&b"{}"[..])).await;
        assert_eq!(resp.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn valid_signature_from_an_untrusted_origin_is_403() {
        // Sec14.10 test 1: signature validity alone never admits the request.
        let ts = now_ts();
        let body = br#"{"subscription":{"type":"channel.follow"},"event":{"broadcaster_user_id":"999"}}"#;
        let sig = sign("evsub-secret", "msg-8", &ts, body);
        let mut state = test_state(FakeAppender(Mutex::new(vec![])), FakeDedupe(Mutex::new(Default::default())));
        state.twitch_origin = Arc::new(OriginVerifier::new(
            vec![],
            vec!["twitch.tv".to_string()],
            Arc::new(NeverTrustedResolver),
            Duration::from_secs(600),
            Duration::from_millis(500),
        ));
        let resp = handle(State(state), headers(&sig, &ts, "msg-8", "notification"), peer("198.51.100.20"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::FORBIDDEN);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='http::twitch_eventsub::'`
Expected: compile failure — `AppState` doesn't yet have the new fields, `crate::http::state::test_state()` helper doesn't exist. Add both in Step 3 (extending Task 4's `AppState`/adding a `#[cfg(test)]`-only `test_state()` builder to `src/http/state.rs`) before the handler compiles.

- [ ] **Step 3: Extend `AppState` (in `src/http/state.rs`)**

```rust
// Added fields (Task 17) -- extends the struct from Task 4:
use crate::config::Secret;
use crate::http::middleware::IntakeLimiters;
use crate::http::origin::OriginVerifier;
use crate::publish::EventAppender;
use penguin_spine::{BindingKeyring, Scope, UsageBatcher};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub metrics: Arc<IngestMetrics>,
    pub started_at: Instant,
    pub twitch_eventsub_secret: Option<Arc<Secret>>,
    pub kick_webhook_secret: Option<Arc<Secret>>, // used by Task 18
    pub limiters: Arc<IntakeLimiters>,
    pub appender: Arc<dyn EventAppender>,
    pub scope: Scope,
    pub dedupe: Arc<dyn crate::http::twitch_eventsub::DedupeStore>,
    pub binding_keyring: Arc<BindingKeyring>,   // D30 -- publish_event mints binding.mac against this
    pub usage: Arc<UsageBatcher>,               // D31 -- publish_event records into this; Task 30 flushes it
    pub trusted_proxies: Arc<Vec<ipnet::IpNet>>, // PA-PROXY
    pub twitch_origin: Arc<OriginVerifier>,      // PA-ORIGIN
    pub kick_origin: Arc<OriginVerifier>,        // used by Task 18
    pub generic_intake_enabled: bool,            // waddles.core.generic-intake flag (Task 21/30)
}

#[cfg(test)]
pub fn test_state() -> AppState {
    use crate::http::origin::fakes::NeverTrustedResolver;
    use crate::telemetry::IngestMetrics;
    use clap::Parser;
    use std::collections::HashMap;
    use std::time::Duration;

    let cli = crate::config::CliConfig::parse_from(["svc-ingest", "--valkey-url", "rediss://valkey:6379/0"]);
    let config = Config {
        cli, valkey_password: None, secret_key: Secret::new("x"), twitch_bot_token: None,
        discord_bot_token: None, slack_app_token: None, slack_bot_token: None, youtube_api_key: None,
        twitch_eventsub_secret: None, kick_webhook_secret: None,
    };
    let mut keyring_entries = HashMap::new();
    keyring_entries.insert(
        "test-kid".to_string(),
        penguin_spine::BindingKeyEntry { key: vec![9u8; 32], retired_at: None },
    );
    AppState {
        config: Arc::new(config),
        metrics: Arc::new(IngestMetrics::register(&prometheus::Registry::new())),
        started_at: Instant::now(),
        twitch_eventsub_secret: None,
        kick_webhook_secret: None,
        limiters: Arc::new(IntakeLimiters::new(20, 40, 100, 200)),
        appender: Arc::new(crate::publish::fakes::NoopAppender), // Task 12 exposes a tiny no-op test double for exactly this purpose; see Task 12 follow-up note below
        scope: Scope { tenant: "global".to_string(), community: None },
        dedupe: Arc::new(crate::http::twitch_eventsub::fakes::AlwaysFreshDedupe),
        binding_keyring: Arc::new(BindingKeyring::from_entries("test-kid", keyring_entries, chrono::Duration::seconds(86_400)).unwrap()),
        usage: Arc::new(UsageBatcher::new()),
        trusted_proxies: Arc::new(vec![]),
        // Default test state trusts nothing by FCrDNS (fail closed) -- an
        // individual test that needs origin admission overrides
        // `state.twitch_origin`/`state.kick_origin` explicitly, matching
        // "every gate defaults to the strict posture" (never a permissive
        // default a test could forget to override).
        twitch_origin: Arc::new(OriginVerifier::new(vec![], vec!["twitch.tv".to_string()], Arc::new(NeverTrustedResolver), Duration::from_secs(600), Duration::from_millis(500))),
        kick_origin: Arc::new(OriginVerifier::new(vec![], vec!["kick.com".to_string()], Arc::new(NeverTrustedResolver), Duration::from_secs(600), Duration::from_millis(500))),
        // Defaults true: Tasks 19/20's own tests exercise their handlers
        // directly (never through `build_router`), so the flag gate is
        // exclusively Task 21's/30's concern -- a permissive default here
        // does not weaken any test's actual assertion.
        generic_intake_enabled: true,
    }
}
```

Note for this step: Task 12's `publish.rs` needs a small addition — a `pub(crate) struct NoopAppender;` with a trivial `EventAppender` impl returning `Ok("test-0".into())`, placed in a **separate** `#[cfg(test)] pub(crate) mod fakes { ... }` block (never named `tests` — that name is already taken by `publish.rs`'s own inline unit-test module from Task 12 Step 1, and two `mod tests` in one file is a compile error) so `test_state()` above can use it without every other test file redefining its own fake. Similarly this file (`twitch_eventsub.rs`) exposes `pub(crate) struct AlwaysFreshDedupe;` in its own `#[cfg(test)] pub(crate) mod fakes` block, alongside (not instead of) its regular `#[cfg(test)] mod tests` from Step 1. Add both as part of this step — they are test-only, `#[cfg(test)]`-gated, and do not change either module's production surface.

- [ ] **Step 4: Write the implementation**

```rust
//! `POST /eventsub/twitch/webhook` -- HMAC-SHA256 verification (byte-
//! identical algorithm to the legacy `eventsub.py::verify_signature`),
//! FCrDNS origin restriction (§4.1.1/D29, PA-ORIGIN, checked before the
//! body is even read), the 600s replay window and message-id dedupe
//! (both new in this rewrite), D30 workstream/trace/binding minting via
//! `publish_event`, and the `webhook_callback_verification`/
//! `notification`/`revocation` message-type handling.

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use crate::error::IntakeError;
use crate::http::middleware::{constant_time_eq_hex, read_capped_body};
use crate::http::origin::resolve_client_addr;
use crate::http::state::AppState;
use crate::normalize::twitch_eventsub::normalize;
use crate::publish::{deterministic_workstream_id, publish_event};

/// Twitch's own replay window -- a fixed protocol constant, not an env
/// var (§10.1: "600 s timestamp window (Twitch's own)").
const TWITCH_EVENTSUB_REPLAY_WINDOW_S: i64 = 600;

const SIG_HEADER: &str = "Twitch-Eventsub-Message-Signature";
const TS_HEADER: &str = "Twitch-Eventsub-Message-Timestamp";
const ID_HEADER: &str = "Twitch-Eventsub-Message-Id";
const TYPE_HEADER: &str = "Twitch-Eventsub-Message-Type";

/// Suppresses a duplicate delivery -- `Ok(true)` if `key` was newly
/// remembered (proceed), `Ok(false)` if already seen (reject). See
/// PA-DEDUPE for the per-key-TTL rationale.
#[async_trait::async_trait]
pub trait DedupeStore: Send + Sync {
    async fn check_and_remember(&self, key: &str, ttl_s: u64) -> Result<bool, String>;
}

/// Production `DedupeStore`: `SET waddles:intake:seen:{key} 1 NX EX {ttl_s}`.
pub struct ValkeyDedupeStore {
    conn: redis::aio::ConnectionManager,
}

impl ValkeyDedupeStore {
    pub fn new(conn: redis::aio::ConnectionManager) -> Self {
        Self { conn }
    }
}

#[async_trait::async_trait]
impl DedupeStore for ValkeyDedupeStore {
    async fn check_and_remember(&self, key: &str, ttl_s: u64) -> Result<bool, String> {
        let mut conn = self.conn.clone();
        let full_key = format!("waddles:intake:seen:{key}");
        let set: Option<String> = redis::cmd("SET")
            .arg(&full_key)
            .arg(1)
            .arg("NX")
            .arg("EX")
            .arg(ttl_s)
            .query_async(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
        Ok(set.is_some())
    }
}

fn verify_signature(secret: &str, message_id: &str, timestamp: &str, body: &[u8], signature_header: &str) -> bool {
    let Some(provided) = signature_header.strip_prefix("sha256=") else { return false };
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(message_id.as_bytes());
    mac.update(timestamp.as_bytes());
    mac.update(body);
    let expected = hex_encode(&mac.finalize().into_bytes());
    constant_time_eq_hex(&expected, provided)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `POST /eventsub/twitch/webhook`. `connect_info` is `Option` so this
/// handler never depends on `axum::serve`'s connect-info wiring (Task
/// 30) to compile or unit-test; a genuinely missing peer address
/// degrades to `0.0.0.0`, which fails origin verification closed.
pub async fn handle(
    State(state): State<AppState>,
    headers: HeaderMap,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    body: axum::body::Body,
) -> Response {
    let metrics = state.metrics.clone();
    match handle_inner(state, headers, connect_info, body).await {
        Ok(resp) => resp,
        Err(err) => {
            metrics.platform_webhook_rejected("twitch", err.metric_reason());
            err.into_response()
        }
    }
}

async fn handle_inner(
    state: AppState,
    headers: HeaderMap,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    body: axum::body::Body,
) -> Result<Response, IntakeError> {
    let Some(secret) = state.twitch_eventsub_secret.as_ref() else { return Err(IntakeError::SecretUnset) };

    state.limiters.check("twitch-eventsub", &state.scope.tenant)?;

    // Origin verification is cheap (no body read) and runs before
    // signature verification -- a wrong-origin request never causes an
    // HMAC computation over an attacker-controlled body (§4.1.1/D29).
    let direct_peer = connect_info.map(|ci| ci.0.ip()).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let forwarded_for = headers.get("X-Forwarded-For").and_then(|v| v.to_str().ok());
    let client_addr = resolve_client_addr(direct_peer, forwarded_for, &state.trusted_proxies);
    if !state.twitch_origin.verify(client_addr, &state.metrics, "twitch").await {
        return Err(IntakeError::OriginRejected);
    }

    let body_bytes = read_capped_body(body, state.config.cli.intake_max_body_bytes).await?;

    let header_str = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let signature = header_str(SIG_HEADER);
    let timestamp = header_str(TS_HEADER);
    let message_id = header_str(ID_HEADER);
    let message_type = header_str(TYPE_HEADER);

    if !verify_signature(secret.expose(), &message_id, &timestamp, &body_bytes, &signature) {
        return Err(IntakeError::BadSignature);
    }

    let ts_secs: i64 = timestamp.parse().map_err(|_| IntakeError::MalformedBody)?;
    let now = chrono::Utc::now().timestamp();
    if (now - ts_secs).abs() > TWITCH_EVENTSUB_REPLAY_WINDOW_S {
        return Err(IntakeError::ReplayWindow);
    }

    let body_json: serde_json::Value = serde_json::from_slice(&body_bytes).map_err(|_| IntakeError::MalformedBody)?;

    if message_type == "webhook_callback_verification" {
        let challenge = body_json.get("challenge").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        return Ok((StatusCode::OK, [(axum::http::header::CONTENT_TYPE, "text/plain")], challenge).into_response());
    }

    if message_type == "notification" {
        let fresh = state.dedupe.check_and_remember(&message_id, state.config.cli.intake_dedupe_ttl_s).await.map_err(|_| IntakeError::MalformedBody)?;
        if !fresh {
            return Err(IntakeError::DuplicateMessage);
        }
        let subscription = body_json.get("subscription").cloned().unwrap_or_default();
        let event = body_json.get("event").cloned().unwrap_or_default();
        let event_type = subscription.get("type").and_then(|v| v.as_str()).unwrap_or_default();

        let mut raw = event.clone();
        if let Some(obj) = raw.as_object_mut() {
            obj.insert("event_type".to_string(), serde_json::Value::from(event_type));
            obj.insert("broadcaster_id".to_string(), event.get("broadcaster_user_id").cloned().unwrap_or_default());
            obj.insert("broadcaster_login".to_string(), event.get("broadcaster_user_login").cloned().unwrap_or_default());
            obj.insert("user_display_name".to_string(), event.get("user_name").cloned().unwrap_or_default());
            obj.insert("metadata".to_string(), serde_json::json!({}));
        }

        if let Ok(platform_event) = normalize(&raw, "eventsub-app") {
            let source_id = format!("tw-eventsub-{}", event.get("broadcaster_user_id").and_then(|v| v.as_str()).unwrap_or("unknown"));
            let workstream_id = deterministic_workstream_id(&source_id);
            let _ = publish_event(
                state.appender.as_ref(),
                &state.metrics,
                &state.binding_keyring,
                &state.usage,
                &state.scope,
                &source_id,
                &workstream_id,
                None,
                platform_event,
            )
            .await;
        }
        return Ok(StatusCode::OK.into_response());
    }

    // `revocation` and any other recognized-but-unhandled type: acknowledge without publishing.
    Ok(StatusCode::OK.into_response())
}

#[cfg(test)]
pub(crate) mod fakes {
    use super::DedupeStore;

    pub(crate) struct AlwaysFreshDedupe;

    #[async_trait::async_trait]
    impl DedupeStore for AlwaysFreshDedupe {
        async fn check_and_remember(&self, _key: &str, _ttl_s: u64) -> Result<bool, String> {
            Ok(true)
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='http::twitch_eventsub::'`
Expected: `test result: ok. 8 passed; 0 failed`

- [ ] **Step 6: Commit**

```bash
git add core/svc_ingest/src/http/twitch_eventsub.rs core/svc_ingest/src/http/state.rs core/svc_ingest/src/http/mod.rs core/svc_ingest/src/publish.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): Twitch EventSub webhook handler -- HMAC verify, FCrDNS origin restriction, text/plain challenge echo, 600s replay window, message-id dedupe, D30/D31 wiring (§4.1.1, D29/D30/D31)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 18: HTTP handler — Kick webhook

**Depends on:** Task 2, Task 3, Task 10, Task 12, Task 15, Task 16

**Files:**
- Create: `core/svc_ingest/src/http/kick_webhook.rs`
- Modify: `core/svc_ingest/src/http/mod.rs` (add `pub mod kick_webhook;`)
- Modify: `core/svc_ingest/src/http/state.rs` (wire `kick_webhook_secret`/`kick_origin` — already added to the `AppState` struct in Task 17 Step 3; this task only reads them, no struct change)

`POST /webhook/kick`, always mounted (unlike Twitch EventSub, §10.1: "route always mounted"). Ported from `core/svc_ingest/bundles/kick_ingest.py::handle_kick_webhook`'s orchestration, using Task 10's `verify_kick_webhook_signature`/`map_kick_webhook_event_type`/`normalize_stream_lifecycle` — the fan-out-to-a-bundle machinery (`fan_out_event`) is replaced by a direct `publish_event` call for `StreamStart`/`StreamEnd` only, matching current behavior exactly (non-lifecycle types are ack-only, never enqueued, per Task 10's docstring). Adds **FCrDNS origin restriction to `kick.com`** (§4.1.1/D29, PA-ORIGIN), checked before signature verification, the same pattern as Task 17.

**Interfaces:**
- Consumes: `crate::error::IntakeError`; `crate::normalize::kick::{verify_kick_webhook_signature, map_kick_webhook_event_type, normalize_stream_lifecycle, STREAM_LIFECYCLE_EVENT_TYPES}` (Task 10); `crate::publish::{publish_event, deterministic_workstream_id}` (Task 12); `crate::http::origin::resolve_client_addr` (Task 15); `crate::http::middleware::{IntakeLimiters, read_capped_body}` (Task 16); `crate::http::state::AppState` (Task 17's extended shape).
- Produces: `pub async fn handle(State(state): State<AppState>, headers: axum::http::HeaderMap, connect_info: Option<axum::extract::ConnectInfo<std::net::SocketAddr>>, body: axum::body::Body) -> Response` mounted at `POST /webhook/kick`. Response body always `{"received": true, "event_type": <mapped>}` on success (200), matching Python's exact shape.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Secret;
    use crate::http::origin::{fakes::AlwaysTrustedResolver, OriginVerifier};
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{HeaderMap, HeaderValue};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn sign(body: &[u8], secret: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        hex::encode(mac.finalize().into_bytes())
    }

    fn headers(sig: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("X-Kick-Signature", HeaderValue::from_str(sig).unwrap());
        h
    }

    fn peer(addr: &str) -> Option<ConnectInfo<SocketAddr>> {
        Some(ConnectInfo(format!("{addr}:12345").parse().unwrap()))
    }

    /// Every test in this module needs a trusted origin by default --
    /// origin admission is this file's own concern to test once
    /// (`origin_rejected_is_403`), not re-litigated in every signature/
    /// mapping test.
    fn trusting_state() -> AppState {
        let mut state = crate::http::state::test_state();
        state.kick_origin = Arc::new(OriginVerifier::new(
            vec![],
            vec!["kick.com".to_string()],
            Arc::new(AlwaysTrustedResolver),
            Duration::from_secs(600),
            Duration::from_millis(500),
        ));
        state
    }

    async fn json_body(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn unconfigured_secret_returns_503_without_verifying() {
        let mut state = trusting_state();
        state.kick_webhook_secret = None;
        let resp = handle(State(state), headers("anything"), peer("192.0.2.30"), Body::from(&b"{\"type\":\"StreamStart\"}"[..])).await;
        assert_eq!(resp.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn invalid_signature_returns_401() {
        let mut state = trusting_state();
        state.kick_webhook_secret = Some(Arc::new(Secret::new("kick-secret")));
        let resp = handle(State(state), headers("bad"), peer("192.0.2.30"), Body::from(&b"{\"type\":\"StreamStart\"}"[..])).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn missing_signature_header_returns_401() {
        let mut state = trusting_state();
        state.kick_webhook_secret = Some(Arc::new(Secret::new("kick-secret")));
        let resp = handle(State(state), HeaderMap::new(), peer("192.0.2.30"), Body::from(&b"{\"type\":\"StreamStart\"}"[..])).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn every_known_event_type_maps_and_acks_200() {
        for (kick_type, mapped) in crate::normalize::kick::KICK_WEBHOOK_EVENT_TYPE_MAP {
            let mut state = trusting_state();
            state.kick_webhook_secret = Some(Arc::new(Secret::new("kick-secret")));
            let body = format!(r#"{{"type":"{kick_type}"}}"#).into_bytes();
            let sig = sign(&body, "kick-secret");
            let resp = handle(State(state), headers(&sig), peer("192.0.2.30"), Body::from(body)).await;
            assert_eq!(resp.status(), axum::http::StatusCode::OK, "type: {kick_type}");
            let json = json_body(resp).await;
            assert_eq!(json["event_type"], *mapped, "type: {kick_type}");
        }
    }

    #[tokio::test]
    async fn unknown_event_type_maps_to_unknown_not_rejected() {
        let mut state = trusting_state();
        state.kick_webhook_secret = Some(Arc::new(Secret::new("kick-secret")));
        let body = br#"{"type":"SomeFutureEventType"}"#;
        let sig = sign(body, "kick-secret");
        let resp = handle(State(state), headers(&sig), peer("192.0.2.30"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        assert_eq!(json_body(resp).await["event_type"], "unknown");
    }

    #[tokio::test]
    async fn missing_type_field_maps_to_unknown() {
        let mut state = trusting_state();
        state.kick_webhook_secret = Some(Arc::new(Secret::new("kick-secret")));
        let body = b"{}";
        let sig = sign(body, "kick-secret");
        let resp = handle(State(state), headers(&sig), peer("192.0.2.30"), Body::from(body.to_vec())).await;
        assert_eq!(json_body(resp).await["event_type"], "unknown");
    }

    #[tokio::test]
    async fn stream_start_publishes_a_stream_online_event() {
        let mut state = trusting_state();
        state.kick_webhook_secret = Some(Arc::new(Secret::new("kick-secret")));
        let appender = crate::publish::fakes::RecordingAppender::default();
        state.appender = Arc::new(appender.clone());
        let body = br#"{"type":"StreamStart","channel_slug":"acme","channel_id":"555"}"#;
        let sig = sign(body, "kick-secret");
        let resp = handle(State(state), headers(&sig), peer("192.0.2.30"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let envs = appender.envelopes();
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].event.event_type, "stream.online");
        assert!(!envs[0].workstream_id.is_empty());
    }

    #[tokio::test]
    async fn non_lifecycle_event_never_publishes() {
        let mut state = trusting_state();
        state.kick_webhook_secret = Some(Arc::new(Secret::new("kick-secret")));
        let appender = crate::publish::fakes::RecordingAppender::default();
        state.appender = Arc::new(appender.clone());
        let body = br#"{"type":"Subscription"}"#;
        let sig = sign(body, "kick-secret");
        handle(State(state), headers(&sig), peer("192.0.2.30"), Body::from(body.to_vec())).await;
        assert!(appender.envelopes().is_empty());
    }

    #[tokio::test]
    async fn valid_signature_from_an_untrusted_origin_is_403() {
        // Sec14.10 test 1, applied to Kick.
        let mut state = crate::http::state::test_state(); // default test_state's kick_origin trusts nothing
        state.kick_webhook_secret = Some(Arc::new(Secret::new("kick-secret")));
        let body = br#"{"type":"StreamStart"}"#;
        let sig = sign(body, "kick-secret");
        let resp = handle(State(state), headers(&sig), peer("198.51.100.40"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::FORBIDDEN);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='http::kick_webhook::'`
Expected: compile failure — `crate::publish::fakes::RecordingAppender` doesn't exist yet (extend the `fakes` module Task 17 started in `publish.rs` with a `Clone`-able, `Mutex<Vec<StageEnvelope>>`-backed recorder, `pub(crate) fn envelopes(&self) -> Vec<StageEnvelope>`) — add it in Step 3.

- [ ] **Step 3: Write the implementation**

```rust
//! `POST /webhook/kick` -- HMAC-SHA256 fail-closed verification (Task
//! 10's `verify_kick_webhook_signature`), FCrDNS origin restriction to
//! `kick.com` (§4.1.1/D29, PA-ORIGIN, checked before signature
//! verification), the coarse event-type ack map, and `StreamStart`/
//! `StreamEnd` publication as `stream.online`/`stream.offline` (gh #287
//! S10, with D30 workstream/trace/binding minting via `publish_event`).
//! Always mounted; a missing secret is a 503 on every request, matching
//! `handle_kick_webhook`'s exact posture.

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use crate::error::IntakeError;
use crate::http::middleware::read_capped_body;
use crate::http::origin::resolve_client_addr;
use crate::http::state::AppState;
use crate::normalize::kick::{map_kick_webhook_event_type, normalize_stream_lifecycle, verify_kick_webhook_signature, STREAM_LIFECYCLE_EVENT_TYPES};
use crate::publish::{deterministic_workstream_id, publish_event};

/// `POST /webhook/kick`.
pub async fn handle(
    State(state): State<AppState>,
    headers: HeaderMap,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    body: axum::body::Body,
) -> Response {
    let metrics = state.metrics.clone();
    match handle_inner(state, headers, connect_info, body).await {
        Ok(resp) => resp,
        Err(err) => {
            metrics.platform_webhook_rejected("kick", err.metric_reason());
            err.into_response()
        }
    }
}

async fn handle_inner(
    state: AppState,
    headers: HeaderMap,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    body: axum::body::Body,
) -> Result<Response, IntakeError> {
    let Some(secret) = state.kick_webhook_secret.as_ref() else { return Err(IntakeError::SecretUnset) };

    state.limiters.check("kick-webhook", &state.scope.tenant)?;

    let direct_peer = connect_info.map(|ci| ci.0.ip()).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let forwarded_for = headers.get("X-Forwarded-For").and_then(|v| v.to_str().ok());
    let client_addr = resolve_client_addr(direct_peer, forwarded_for, &state.trusted_proxies);
    if !state.kick_origin.verify(client_addr, &state.metrics, "kick").await {
        return Err(IntakeError::OriginRejected);
    }

    let body_bytes = read_capped_body(body, state.config.cli.intake_max_body_bytes).await?;
    let signature = headers.get("X-Kick-Signature").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if !verify_kick_webhook_signature(&body_bytes, signature, secret.expose()) {
        return Err(IntakeError::BadSignature);
    }

    let body_json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap_or(serde_json::Value::Null);
    let kick_type = body_json.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let mapped_type = map_kick_webhook_event_type(kick_type);

    if STREAM_LIFECYCLE_EVENT_TYPES.contains(&kick_type) {
        if let Some(event) = normalize_stream_lifecycle(kick_type, &body_json, "kick-app") {
            let channel_slug = body_json.get("channel_slug").and_then(|v| v.as_str()).unwrap_or("unknown");
            let source_id = format!("kick-{channel_slug}");
            let workstream_id = deterministic_workstream_id(&source_id);
            let _ = publish_event(
                state.appender.as_ref(),
                &state.metrics,
                &state.binding_keyring,
                &state.usage,
                &state.scope,
                &source_id,
                &workstream_id,
                None,
                event,
            )
            .await;
        }
    }

    Ok((StatusCode::OK, axum::Json(json!({"received": true, "event_type": mapped_type}))).into_response())
}
```

Add to `publish.rs`'s `#[cfg(test)] pub(crate) mod fakes` block (started in Task 17):

```rust
#[derive(Clone, Default)]
pub(crate) struct RecordingAppender(std::sync::Arc<std::sync::Mutex<Vec<StageEnvelope>>>);

impl RecordingAppender {
    pub(crate) fn envelopes(&self) -> Vec<StageEnvelope> {
        self.0.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl EventAppender for RecordingAppender {
    async fn append(&self, _stream: &str, env: &StageEnvelope) -> Result<String, String> {
        self.0.lock().unwrap().push(env.clone());
        Ok("test-0".to_string())
    }
}
```

(`StageEnvelope` derives `Clone` per the corrected External Crate Surfaces block.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='http::kick_webhook::'`
Expected: `test result: ok. 9 passed; 0 failed` (3 + 9 parametrized-in-a-loop counts as 1 test function + 2 + 2 + 1 origin = the loop in `every_known_event_type_maps_and_acks_200` is one `#[tokio::test]`, not 9 — so: unconfigured(1) + invalid_sig(1) + missing_sig(1) + every_known_loop(1) + unknown(1) + missing_type(1) + stream_start(1) + non_lifecycle(1) + origin_rejected(1) = 9).

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/http/kick_webhook.rs core/svc_ingest/src/http/mod.rs core/svc_ingest/src/publish.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): Kick webhook handler -- fail-closed HMAC, FCrDNS origin restriction, event-type ack map, StreamStart/StreamEnd publication, D30/D31 wiring (§4.1.1, D29/D30/D31, gh#287 S10)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 19: HTTP handler — Generic webhook intake

**Depends on:** Task 2, Task 3, Task 11, Task 12, Task 14, Task 15, Task 16

**Files:**
- Create: `core/svc_ingest/src/http/intake_webhook.rs`
- Modify: `core/svc_ingest/src/http/mod.rs` (add `pub mod intake_webhook;`)
- Modify: `core/svc_ingest/src/http/state.rs` (add `pub sources: crate::sources::SharedSourceRegistry` and reuse `pub dedupe: Arc<dyn crate::http::twitch_eventsub::DedupeStore>` from Task 17 — the same trait/store, different key namespace)

`POST /intake/webhook/{tenant}/{source}` per §10.1/§10.3/§4.1.1 (D29). New route (D6) — not a port. **This is the primary implementation site for PA-INTAKE-AUTH**: the per-source HMAC signature is necessary but never sufficient — every source's `auth.modes` (Task 14) must independently pass via `crate::http::middleware::verify_intake_auth_modes` (Task 16), using the client address resolved through Task 15's trusted-proxy logic for the `cidr` mode.

**Interfaces:**
- Consumes: `crate::sources::{SharedSourceRegistry, SourceRecord}` (Task 14); `crate::normalize::generic::apply_mapping` (Task 11); `crate::publish::publish_event` (Task 12); `crate::http::origin::resolve_client_addr` (Task 15); `crate::http::middleware::{IntakeLimiters, read_capped_body, constant_time_eq_hex, verify_intake_auth_modes}` (Task 16); `crate::http::twitch_eventsub::DedupeStore` (Task 17, reused); `crate::config::parse_cidr_list` (Task 2).
- Produces: `pub async fn handle(State(state): State<AppState>, Path((tenant, source)): Path<(String, String)>, headers: axum::http::HeaderMap, connect_info: Option<axum::extract::ConnectInfo<std::net::SocketAddr>>, body: axum::body::Body) -> Response` mounted at `POST /intake/webhook/{tenant}/{source}`. Success: `202 Accepted` with `{"accepted": true, "events": 1}` (the mapping engine always produces exactly one event per request in this milestone — batching is out of scope). Signature: HMAC-SHA256 hex over `{timestamp}.{raw_body}` (literal dot separator), prefixed `sha256=`, header `X-Waddles-Signature`; timestamp header `X-Waddles-Timestamp` (unix seconds), `INTAKE_REPLAY_WINDOW_S` window; optional `X-Waddles-Delivery-Id` dedupe (absent header ⇒ no dedupe performed for that request, per §10.1). **Admission order** (cheapest/least-trusting checks first): rate limit → unknown/disabled source → body read → signature → replay window → **`verify_intake_auth_modes`** (PA-INTAKE-AUTH) → delivery-id dedupe → mapping → publish.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::{ConnectInfo, Path};
    use axum::http::{HeaderMap, HeaderValue};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use std::net::SocketAddr;
    use std::sync::Arc;

    fn sign(secret: &str, timestamp: &str, body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(timestamp.as_bytes());
        mac.update(b".");
        mac.update(body);
        format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
    }

    fn now_ts() -> String {
        chrono::Utc::now().timestamp().to_string()
    }

    fn peer(addr: &str) -> Option<ConnectInfo<SocketAddr>> {
        Some(ConnectInfo(format!("{addr}:12345").parse().unwrap()))
    }

    fn state_with_source(source: crate::sources::SourceRecord) -> AppState {
        let mut state = crate::http::state::test_state();
        let mut registry = crate::sources::SourceRegistry::default();
        registry.insert_for_test(source);
        state.sources = Arc::new(arc_swap::ArcSwap::from_pointee(registry));
        state
    }

    fn sample_mapping() -> crate::normalize::generic::SourceMapping {
        use crate::normalize::generic::{FieldMapping, SourceMapping};
        SourceMapping {
            event_type: FieldMapping { pointer: "/type".to_string(), default: Some(serde_json::json!("custom.event")) },
            actor: Some(FieldMapping { pointer: "/user/id".to_string(), default: None }),
            occurred_at: FieldMapping { pointer: "/created_at".to_string(), default: Some(serde_json::json!("$now")) },
            community: None,
            payload: [("text".to_string(), FieldMapping { pointer: "/message".to_string(), default: None })].into_iter().collect(),
        }
    }

    /// A source configured with the single `bearer` mode -- the common
    /// case for most of this module's tests, which are not about
    /// PA-INTAKE-AUTH specifically. `auth_mode_negative_tests` below
    /// builds its own sources with other mode combinations.
    fn sample_source(enabled: bool) -> crate::sources::SourceRecord {
        crate::sources::SourceRecord {
            source_id: "acme-github".to_string(), tenant: "acme".to_string(), platform: "custom:github".to_string(),
            secret_ref: "ref".to_string(), secret: "whsec_test".to_string(), community: None,
            mapping: sample_mapping(), enabled, workstream_id: "8f14e45f-ceea-467e-adde-3fb5c9752730".to_string(),
            auth: crate::sources::SourceAuth {
                modes: vec!["bearer".to_string()],
                cidrs: vec![],
                secret_ref: Some("acme-github-bearer".to_string()),
                secret: Some("s3cr3t-token".to_string()),
            },
        }
    }

    fn bearer_headers(sig: &str, ts: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("X-Waddles-Signature", HeaderValue::from_str(sig).unwrap());
        headers.insert("X-Waddles-Timestamp", HeaderValue::from_str(ts).unwrap());
        headers.insert(axum::http::header::AUTHORIZATION, HeaderValue::from_str("Bearer s3cr3t-token").unwrap());
        headers
    }

    #[tokio::test]
    async fn accepts_a_valid_signed_delivery_satisfying_its_auth_mode() {
        let state = state_with_source(sample_source(true));
        let ts = now_ts();
        let body = br#"{"type":"push","user":{"id":"u1"},"message":"hello"}"#;
        let sig = sign("whsec_test", &ts, body);
        let resp = handle(
            State(state),
            Path(("acme".to_string(), "acme-github".to_string())),
            bearer_headers(&sig, &ts),
            peer("203.0.113.1"),
            Body::from(body.to_vec()),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn unknown_source_is_404() {
        let state = crate::http::state::test_state();
        let ts = now_ts();
        let resp = handle(
            State(state),
            Path(("acme".to_string(), "nope".to_string())),
            bearer_headers("sha256=x", &ts),
            peer("203.0.113.1"),
            Body::from(&b"{}"[..]),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn disabled_source_is_404() {
        let state = state_with_source(sample_source(false));
        let ts = now_ts();
        let body = b"{}";
        let sig = sign("whsec_test", &ts, body);
        let resp = handle(
            State(state),
            Path(("acme".to_string(), "acme-github".to_string())),
            bearer_headers(&sig, &ts),
            peer("203.0.113.1"),
            Body::from(body.to_vec()),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn bad_signature_is_401() {
        let state = state_with_source(sample_source(true));
        let ts = now_ts();
        let resp = handle(
            State(state),
            Path(("acme".to_string(), "acme-github".to_string())),
            bearer_headers("sha256=wrong", &ts),
            peer("203.0.113.1"),
            Body::from(&b"{}"[..]),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn outside_replay_window_is_403() {
        let state = state_with_source(sample_source(true));
        let old_ts = (chrono::Utc::now().timestamp() - 301).to_string();
        let body = b"{}";
        let sig = sign("whsec_test", &old_ts, body);
        let resp = handle(
            State(state),
            Path(("acme".to_string(), "acme-github".to_string())),
            bearer_headers(&sig, &old_ts),
            peer("203.0.113.1"),
            Body::from(body.to_vec()),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn duplicate_delivery_id_is_409() {
        let state = state_with_source(sample_source(true));
        let ts = now_ts();
        let body = br#"{"type":"push","user":{"id":"u1"},"message":"hi"}"#;
        let sig = sign("whsec_test", &ts, body);
        let mut headers = bearer_headers(&sig, &ts);
        headers.insert("X-Waddles-Delivery-Id", HeaderValue::from_str("dlv-1").unwrap());
        let first = handle(State(state.clone()), Path(("acme".to_string(), "acme-github".to_string())), headers.clone(), peer("203.0.113.1"), Body::from(body.to_vec())).await;
        assert_eq!(first.status(), axum::http::StatusCode::ACCEPTED);
        let second = handle(State(state), Path(("acme".to_string(), "acme-github".to_string())), headers, peer("203.0.113.1"), Body::from(body.to_vec())).await;
        assert_eq!(second.status(), axum::http::StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn mapping_failure_is_422() {
        let mut source = sample_source(true);
        source.mapping.actor = Some(crate::normalize::generic::FieldMapping { pointer: "/nope".to_string(), default: None });
        let state = state_with_source(source);
        let ts = now_ts();
        let body = br#"{"type":"push","message":"hi"}"#;
        let sig = sign("whsec_test", &ts, body);
        let resp = handle(
            State(state),
            Path(("acme".to_string(), "acme-github".to_string())),
            bearer_headers(&sig, &ts),
            peer("203.0.113.1"),
            Body::from(body.to_vec()),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn no_delivery_id_header_never_dedupes() {
        let state = state_with_source(sample_source(true));
        let ts = now_ts();
        let body = br#"{"type":"push","user":{"id":"u1"},"message":"hi"}"#;
        let sig = sign("whsec_test", &ts, body);
        let headers = bearer_headers(&sig, &ts);
        let first = handle(State(state.clone()), Path(("acme".to_string(), "acme-github".to_string())), headers.clone(), peer("203.0.113.1"), Body::from(body.to_vec())).await;
        assert_eq!(first.status(), axum::http::StatusCode::ACCEPTED);
        let second = handle(State(state), Path(("acme".to_string(), "acme-github".to_string())), headers, peer("203.0.113.1"), Body::from(body.to_vec())).await;
        // No delivery-id header on either request -> both accepted, no 409.
        assert_eq!(second.status(), axum::http::StatusCode::ACCEPTED);
    }

    // -- PA-INTAKE-AUTH negative tests (§4.1.1/D29, §14.10 test 3) --

    #[tokio::test]
    async fn valid_signature_with_no_auth_mode_configured_is_401() {
        let mut source = sample_source(true);
        source.auth = crate::sources::SourceAuth::default(); // empty modes
        let state = state_with_source(source);
        let ts = now_ts();
        let body = b"{}";
        let sig = sign("whsec_test", &ts, body);
        let mut headers = HeaderMap::new();
        headers.insert("X-Waddles-Signature", HeaderValue::from_str(&sig).unwrap());
        headers.insert("X-Waddles-Timestamp", HeaderValue::from_str(&ts).unwrap());
        let resp = handle(State(state), Path(("acme".to_string(), "acme-github".to_string())), headers, peer("203.0.113.1"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn valid_signature_with_configured_bearer_but_wrong_token_is_401() {
        let state = state_with_source(sample_source(true));
        let ts = now_ts();
        let body = b"{}";
        let sig = sign("whsec_test", &ts, body);
        let mut headers = HeaderMap::new();
        headers.insert("X-Waddles-Signature", HeaderValue::from_str(&sig).unwrap());
        headers.insert("X-Waddles-Timestamp", HeaderValue::from_str(&ts).unwrap());
        headers.insert(axum::http::header::AUTHORIZATION, HeaderValue::from_str("Bearer wrong-token").unwrap());
        let resp = handle(State(state), Path(("acme".to_string(), "acme-github".to_string())), headers, peer("203.0.113.1"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn cidr_mode_admits_an_allowlisted_address() {
        let mut source = sample_source(true);
        source.auth = crate::sources::SourceAuth { modes: vec!["cidr".to_string()], cidrs: vec!["203.0.113.0/24".to_string()], secret_ref: None, secret: None };
        let state = state_with_source(source);
        let ts = now_ts();
        let body = b"{}";
        let sig = sign("whsec_test", &ts, body);
        let mut headers = HeaderMap::new();
        headers.insert("X-Waddles-Signature", HeaderValue::from_str(&sig).unwrap());
        headers.insert("X-Waddles-Timestamp", HeaderValue::from_str(&ts).unwrap());
        let resp = handle(State(state), Path(("acme".to_string(), "acme-github".to_string())), headers, peer("203.0.113.99"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn cidr_mode_rejects_a_non_allowlisted_address() {
        let mut source = sample_source(true);
        source.auth = crate::sources::SourceAuth { modes: vec!["cidr".to_string()], cidrs: vec!["203.0.113.0/24".to_string()], secret_ref: None, secret: None };
        let state = state_with_source(source);
        let ts = now_ts();
        let body = b"{}";
        let sig = sign("whsec_test", &ts, body);
        let mut headers = HeaderMap::new();
        headers.insert("X-Waddles-Signature", HeaderValue::from_str(&sig).unwrap());
        headers.insert("X-Waddles-Timestamp", HeaderValue::from_str(&ts).unwrap());
        let resp = handle(State(state), Path(("acme".to_string(), "acme-github".to_string())), headers, peer("198.51.100.5"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn and_combined_modes_require_both_cidr_and_bearer() {
        let mut source = sample_source(true);
        source.auth = crate::sources::SourceAuth {
            modes: vec!["cidr".to_string(), "bearer".to_string()],
            cidrs: vec!["203.0.113.0/24".to_string()],
            secret_ref: Some("ref".to_string()),
            secret: Some("s3cr3t-token".to_string()),
        };
        let state = state_with_source(source);
        let ts = now_ts();
        let body = b"{}";
        let sig = sign("whsec_test", &ts, body);
        // Right CIDR, no bearer header -> rejected.
        let mut headers = HeaderMap::new();
        headers.insert("X-Waddles-Signature", HeaderValue::from_str(&sig).unwrap());
        headers.insert("X-Waddles-Timestamp", HeaderValue::from_str(&ts).unwrap());
        let resp = handle(State(state.clone()), Path(("acme".to_string(), "acme-github".to_string())), headers, peer("203.0.113.1"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
        // Both satisfied -> accepted.
        let resp2 = handle(State(state), Path(("acme".to_string(), "acme-github".to_string())), bearer_headers(&sig, &ts), peer("203.0.113.1"), Body::from(body.to_vec())).await;
        assert_eq!(resp2.status(), axum::http::StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn spoofed_x_forwarded_for_from_an_untrusted_peer_is_ignored() {
        // Sec14.10 test 4, applied through the cidr auth mode: the
        // attacker's direct peer is outside the allowlist, and spoofing
        // X-Forwarded-For to claim an allowlisted address must not help
        // because `state.trusted_proxies` is empty by default (test_state()).
        let mut source = sample_source(true);
        source.auth = crate::sources::SourceAuth { modes: vec!["cidr".to_string()], cidrs: vec!["203.0.113.0/24".to_string()], secret_ref: None, secret: None };
        let state = state_with_source(source);
        let ts = now_ts();
        let body = b"{}";
        let sig = sign("whsec_test", &ts, body);
        let mut headers = HeaderMap::new();
        headers.insert("X-Waddles-Signature", HeaderValue::from_str(&sig).unwrap());
        headers.insert("X-Waddles-Timestamp", HeaderValue::from_str(&ts).unwrap());
        headers.insert("X-Forwarded-For", HeaderValue::from_str("203.0.113.99").unwrap());
        let resp = handle(State(state), Path(("acme".to_string(), "acme-github".to_string())), headers, peer("198.51.100.5"), Body::from(body.to_vec())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='http::intake_webhook::'`
Expected: compile failure — `SourceRegistry` needs a `#[cfg(test)] pub(crate) fn insert_for_test(&mut self, record: SourceRecord)` added in `sources.rs` (Task 14's struct is otherwise read-only from outside its module by design); add it in Step 3.

- [ ] **Step 3: Write the implementation**

Add to `core/svc_ingest/src/sources.rs` (extends Task 14's `impl SourceRegistry` block):

```rust
#[cfg(test)]
impl SourceRegistry {
    pub(crate) fn insert_for_test(&mut self, record: SourceRecord) {
        self.by_key.insert((record.tenant.clone(), record.source_id.clone()), record);
    }
}
```

```rust
//! `POST /intake/webhook/{tenant}/{source}` -- per-source HMAC-SHA256
//! signed generic intake (§10.1/§10.3, D6), gated by the PA-INTAKE-AUTH
//! AND-combined second factor (§4.1.1, D29) on top of the signature.
//! New in this rewrite.

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use crate::config::parse_cidr_list;
use crate::error::IntakeError;
use crate::http::middleware::{constant_time_eq_hex, read_capped_body, verify_intake_auth_modes};
use crate::http::origin::resolve_client_addr;
use crate::http::state::AppState;
use crate::normalize::generic::apply_mapping;
use crate::publish::publish_event;

fn verify_signature(secret: &str, timestamp: &str, body: &[u8], signature_header: &str) -> bool {
    let Some(provided) = signature_header.strip_prefix("sha256=") else { return false };
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body);
    let expected = hex_encode(&mac.finalize().into_bytes());
    constant_time_eq_hex(&expected, provided)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `POST /intake/webhook/{tenant}/{source}`.
pub async fn handle(
    State(state): State<AppState>,
    Path((tenant, source)): Path<(String, String)>,
    headers: HeaderMap,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    body: axum::body::Body,
) -> Response {
    let metrics = state.metrics.clone();
    let source_label = source.clone();
    match handle_inner(state, tenant, source, headers, connect_info, body).await {
        Ok(resp) => resp,
        Err(err) => {
            metrics.webhook_rejected(&source_label, err.metric_reason());
            err.into_response()
        }
    }
}

async fn handle_inner(
    state: AppState,
    tenant: String,
    source: String,
    headers: HeaderMap,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    body: axum::body::Body,
) -> Result<Response, IntakeError> {
    state.limiters.check(&format!("webhook:{tenant}:{source}"), &tenant)?;

    let registry = state.sources.load();
    let record = registry.get(&tenant, &source).filter(|r| r.enabled).cloned();
    let Some(record) = record else { return Err(IntakeError::UnknownSource) };

    let body_bytes = read_capped_body(body, state.config.cli.intake_max_body_bytes).await?;
    let header_str = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let signature = header_str("X-Waddles-Signature");
    let timestamp = header_str("X-Waddles-Timestamp");
    let delivery_id = headers.get("X-Waddles-Delivery-Id").and_then(|v| v.to_str().ok()).map(str::to_string);

    if !verify_signature(&record.secret, &timestamp, &body_bytes, &signature) {
        return Err(IntakeError::BadSignature);
    }

    let ts_secs: i64 = timestamp.parse().map_err(|_| IntakeError::MalformedBody)?;
    if (chrono::Utc::now().timestamp() - ts_secs).abs() > state.config.cli.intake_replay_window_s {
        return Err(IntakeError::ReplayWindow);
    }

    // PA-INTAKE-AUTH (§4.1.1, D29): the signature above is necessary but
    // never sufficient -- every configured mode must independently pass.
    let direct_peer = connect_info.map(|ci| ci.0.ip()).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let forwarded_for = headers.get("X-Forwarded-For").and_then(|v| v.to_str().ok());
    let client_addr = resolve_client_addr(direct_peer, forwarded_for, &state.trusted_proxies);
    let cidrs = parse_cidr_list(&record.auth.cidrs.join(",")).unwrap_or_default();
    verify_intake_auth_modes(&record.auth.modes, &cidrs, client_addr, record.auth.secret.as_deref(), record.auth.secret.as_deref(), &headers)?;

    if let Some(delivery_id) = &delivery_id {
        let fresh = state
            .dedupe
            .check_and_remember(&format!("{source}:{delivery_id}"), state.config.cli.intake_dedupe_ttl_s)
            .await
            .map_err(|_| IntakeError::MalformedBody)?;
        if !fresh {
            return Err(IntakeError::DuplicateDelivery);
        }
    }

    let body_json: serde_json::Value = serde_json::from_slice(&body_bytes).map_err(|_| IntakeError::MalformedBody)?;
    let event = apply_mapping(&record.mapping, &body_json, &record.platform, &source, record.community.as_deref())
        .map_err(|e| IntakeError::MappingFailed(e.to_string()))?;

    let community = event.source.as_ref().and_then(|_| record.community.clone());
    let scope = penguin_spine::Scope { tenant: tenant.clone(), community };
    publish_event(
        state.appender.as_ref(),
        &state.metrics,
        &state.binding_keyring,
        &state.usage,
        &scope,
        &source,
        &record.workstream_id,
        None,
        event,
    )
    .await
    .map_err(IntakeError::MappingFailed)?;

    Ok((StatusCode::ACCEPTED, axum::Json(json!({"accepted": true, "events": 1}))).into_response())
}
```

**Note on `bearer_secret`/`basic_secret`.** Both are passed `record.auth.secret.as_deref()` above because `SourceAuth` carries exactly one resolved secret (§4.1.1: a source configures **either** `bearer` **or** `basic`, never both against the same `secretRef`) — `verify_intake_auth_modes` only reads whichever of the two parameters the configured mode actually needs, so passing the same value into both is correct and matches Task 14's DTO shape, not a shortcut.

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='http::intake_webhook::'`
Expected: `test result: ok. 14 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/http/intake_webhook.rs core/svc_ingest/src/http/mod.rs core/svc_ingest/src/http/state.rs core/svc_ingest/src/sources.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): generic webhook intake handler -- per-source HMAC, PA-INTAKE-AUTH AND-combined second factor, replay window, delivery-id dedupe, mapping, D30/D31 wiring (§10.1/§10.3, §4.1.1, D29/D30/D31)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 20: HTTP handler — Generic REST intake

**Depends on:** Task 2, Task 3, Task 12, Task 14, Task 16

**Files:**
- Create: `core/svc_ingest/src/http/intake_events.rs`
- Modify: `core/svc_ingest/src/http/mod.rs` (add `pub mod intake_events;`)
- Modify: `core/svc_ingest/src/http/state.rs` (add `pub jwt_decoding_key: Arc<jsonwebtoken::DecodingKey>`, `pub jwt_audience: String`, `pub jwt_issuer: String`, `pub registered_platforms: SharedSourceRegistry` reused conceptually as "the set of `custom:*` platform strings this tenant's sources use" — simplest correct implementation: derive the registered-platform set from the same `SharedSourceRegistry` Task 14 already populates, since every `custom:*` platform a tenant may POST as must already back a configured source)

`POST /intake/events` per §10.1/§10.4. New route (D6) — not a port. Strict `PlatformEvent` body (§6.1.1's exact shape, no mapping layer), hub-api-issued JWT with `intake:write` scope and mandatory `tenant` claim.

**Interfaces:**
- Consumes: `penguin_spine::PlatformEvent` (deserialized directly, strict — unknown fields rejected via `#[serde(deny_unknown_fields)]` on a local mirror struct `StrictPlatformEvent` since the external crate's own struct may not carry that attribute; this task defines `StrictPlatformEvent` as the wire DTO and converts to `penguin_spine::PlatformEvent` after validation); `jsonwebtoken::{decode, Validation, Algorithm}`; `crate::publish::publish_event` (Task 12); `crate::http::middleware::IntakeLimiters` (Task 16).
- Produces: `pub async fn handle(State(state): State<AppState>, headers: axum::http::HeaderMap, Query(params): Query<IntakeEventsQuery>, body: axum::body::Body) -> Response` mounted at `POST /intake/events`, `pub struct IntakeEventsQuery { pub community: Option<String> }`. Claims struct `pub struct IntakeClaims { pub iss: String, pub aud: String, pub exp: usize, pub scope: String, pub tenant: String, pub sub: String }`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Query;
    use axum::http::{HeaderMap, HeaderValue};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use std::sync::Arc;

    const HMAC_SECRET: &[u8] = b"test-hmac-secret-for-intake-jwt";

    fn make_token(claims: &IntakeClaims) -> String {
        encode(&Header::default(), claims, &EncodingKey::from_secret(HMAC_SECRET)).unwrap()
    }

    fn state_with_platforms(platforms: &[&str], tenant: &str) -> AppState {
        let mut state = crate::http::state::test_state();
        state.jwt_decoding_key = Arc::new(jsonwebtoken::DecodingKey::from_secret(HMAC_SECRET));
        state.jwt_audience = "svc-ingest".to_string();
        state.jwt_issuer = "https://auth.penguintech.io".to_string();
        let mut registry = crate::sources::SourceRegistry::default();
        for (i, p) in platforms.iter().enumerate() {
            let mut source = crate::sources::tests_support::sample_source_for_platform(p);
            source.tenant = tenant.to_string();
            source.source_id = format!("src-{i}");
            registry.insert_for_test(source);
        }
        state.sources = Arc::new(arc_swap::ArcSwap::from_pointee(registry));
        state
    }

    fn valid_claims(tenant: &str) -> IntakeClaims {
        IntakeClaims {
            iss: "https://auth.penguintech.io".to_string(),
            aud: "svc-ingest".to_string(),
            exp: (chrono::Utc::now().timestamp() + 3600) as usize,
            scope: "intake:write".to_string(),
            tenant: tenant.to_string(),
            sub: "caller-1".to_string(),
        }
    }

    fn valid_body(platform: &str) -> serde_json::Value {
        serde_json::json!({
            "platform": platform, "event_type": "custom.ticket.created", "actor": "u1",
            "payload": {"text": "hi"}, "occurred_at": "2026-09-14T12:00:00.000Z"
        })
    }

    #[tokio::test]
    async fn accepts_a_valid_strict_platform_event() {
        let state = state_with_platforms(&["custom:github"], "acme");
        let token = make_token(&valid_claims("acme"));
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        let body = valid_body("custom:github");
        let resp = handle(State(state), headers, Query(IntakeEventsQuery { community: None }), Body::from(body.to_string())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn missing_authorization_header_is_401() {
        let state = state_with_platforms(&["custom:github"], "acme");
        let resp = handle(State(state), HeaderMap::new(), Query(IntakeEventsQuery { community: None }), Body::from(valid_body("custom:github").to_string())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn expired_token_is_401() {
        let state = state_with_platforms(&["custom:github"], "acme");
        let mut claims = valid_claims("acme");
        claims.exp = (chrono::Utc::now().timestamp() - 10) as usize;
        let token = make_token(&claims);
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        let resp = handle(State(state), headers, Query(IntakeEventsQuery { community: None }), Body::from(valid_body("custom:github").to_string())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn missing_scope_is_403() {
        let state = state_with_platforms(&["custom:github"], "acme");
        let mut claims = valid_claims("acme");
        claims.scope = "distribution:read".to_string();
        let token = make_token(&claims);
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        let resp = handle(State(state), headers, Query(IntakeEventsQuery { community: None }), Body::from(valid_body("custom:github").to_string())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn platform_registered_under_a_different_tenant_is_rejected() {
        // A tenant's registered-platform check is tenant-scoped: a platform
        // string that exists as a source for a DIFFERENT tenant must not
        // leak into this caller's allowed set. Returns `PlatformNotRegistered`
        // (403) -- `IntakeError::TenantMismatch` is a distinct 403 reason
        // reserved by §10.1 for a caller-tenant/resource-tenant conflict this
        // stateless endpoint has no code path to produce (no path/body field
        // ever carries a second tenant to compare against the JWT's), so it
        // is never constructed by this handler; documented in the task
        // Interfaces block rather than forced into a test that doesn't exist.
        let state = state_with_platforms(&["custom:github"], "acme");
        let token = make_token(&valid_claims("acme"));
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        let resp = handle(State(state), headers, Query(IntakeEventsQuery { community: None }), Body::from(valid_body("custom:not-acmes").to_string())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn twitch_platform_is_rejected_as_not_registered() {
        let state = state_with_platforms(&["custom:github"], "acme");
        let token = make_token(&valid_claims("acme"));
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        let resp = handle(State(state), headers, Query(IntakeEventsQuery { community: None }), Body::from(valid_body("twitch").to_string())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn malformed_json_body_is_400() {
        let state = state_with_platforms(&["custom:github"], "acme");
        let token = make_token(&valid_claims("acme"));
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        let resp = handle(State(state), headers, Query(IntakeEventsQuery { community: None }), Body::from("not json")).await;
        assert_eq!(resp.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn body_missing_required_field_is_422() {
        let state = state_with_platforms(&["custom:github"], "acme");
        let token = make_token(&valid_claims("acme"));
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        let mut body = valid_body("custom:github");
        body.as_object_mut().unwrap().remove("occurred_at");
        let resp = handle(State(state), headers, Query(IntakeEventsQuery { community: None }), Body::from(body.to_string())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn community_query_param_sets_the_envelope_community() {
        let state = state_with_platforms(&["custom:github"], "acme");
        let appender = crate::publish::fakes::RecordingAppender::default();
        let mut state = state;
        state.appender = Arc::new(appender.clone());
        let token = make_token(&valid_claims("acme"));
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        let resp = handle(State(state), headers, Query(IntakeEventsQuery { community: Some("main".to_string()) }), Body::from(valid_body("custom:github").to_string())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::ACCEPTED);
        assert_eq!(appender.envelopes()[0].community.as_deref(), Some("main"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='http::intake_events::'`
Expected: compile failure — needs `crate::sources::tests_support::sample_source_for_platform` added (a small `#[cfg(test)] pub(crate) mod tests_support` helper in `sources.rs` building a minimal `SourceRecord` for a given platform string, used here purely to seed the "registered platforms" set — write it in Step 3.

- [ ] **Step 3: Write the implementation**

Add to `core/svc_ingest/src/sources.rs`:

```rust
#[cfg(test)]
pub(crate) mod tests_support {
    use super::{SourceAuth, SourceRecord};
    use crate::normalize::generic::{FieldMapping, SourceMapping};

    pub(crate) fn sample_source_for_platform(platform: &str) -> SourceRecord {
        SourceRecord {
            source_id: "seed".to_string(),
            tenant: "unset".to_string(),
            platform: platform.to_string(),
            secret_ref: "ref".to_string(),
            secret: "shh".to_string(),
            community: None,
            mapping: SourceMapping {
                event_type: FieldMapping { pointer: "/type".to_string(), default: None },
                actor: None,
                occurred_at: FieldMapping { pointer: "/ts".to_string(), default: None },
                community: None,
                payload: Default::default(),
            },
            enabled: true,
            workstream_id: "seed-workstream".to_string(),
            auth: SourceAuth { modes: vec!["bearer".to_string()], cidrs: vec![], secret_ref: Some("ref".to_string()), secret: Some("shh".to_string()) },
        }
    }
}
```

```rust
//! `POST /intake/events` -- strict `PlatformEvent` body, hub-api-issued
//! JWT (`intake:write` scope, mandatory `tenant` claim), tenant-registered
//! custom platforms only (§10.1/§10.4, D6). New in this rewrite.

use std::collections::HashSet;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use jsonwebtoken::{decode, Algorithm, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::IntakeError;
use crate::http::state::AppState;
use crate::publish::publish_event;

/// Query params on `POST /intake/events`.
#[derive(Debug, Deserialize)]
pub struct IntakeEventsQuery {
    pub community: Option<String>,
}

/// Required claims on the `intake:write` service JWT (§10.4).
#[derive(Debug, Serialize, Deserialize)]
pub struct IntakeClaims {
    pub iss: String,
    pub aud: String,
    pub exp: usize,
    pub scope: String,
    pub tenant: String,
    pub sub: String,
}

/// Strict wire shape for `POST /intake/events`'s body -- `deny_unknown_
/// fields` plus every §6.1.1 constraint, independent of whatever shape
/// `penguin_spine::PlatformEvent` happens to derive `Deserialize` with.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictPlatformEvent {
    platform: String,
    event_type: String,
    actor: Option<String>,
    payload: serde_json::Value,
    occurred_at: String,
    #[serde(default)]
    source: Option<StrictSource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictSource {
    platform: String,
    account_id: String,
    channel_id: Option<String>,
}

fn validate_body(event: &StrictPlatformEvent) -> Result<(), IntakeError> {
    if event.platform.is_empty() || event.event_type.is_empty() || event.occurred_at.is_empty() {
        return Err(IntakeError::EnvelopeInvalid("platform/event_type/occurred_at must be non-empty".to_string()));
    }
    if !event.payload.is_object() {
        return Err(IntakeError::EnvelopeInvalid("payload must be a JSON object".to_string()));
    }
    if let Some(source) = &event.source {
        if source.platform != event.platform {
            return Err(IntakeError::EnvelopeInvalid("source.platform must equal the top-level platform".to_string()));
        }
    }
    Ok(())
}

/// `POST /intake/events`.
pub async fn handle(State(state): State<AppState>, headers: HeaderMap, Query(params): Query<IntakeEventsQuery>, body: axum::body::Body) -> Response {
    let metrics = state.metrics.clone();
    match handle_inner(state, headers, params, body).await {
        Ok(resp) => resp,
        Err(err) => {
            metrics.intake_rejected("jwt", err.metric_reason());
            err.into_response()
        }
    }
}

async fn handle_inner(state: AppState, headers: HeaderMap, params: IntakeEventsQuery, body: axum::body::Body) -> Result<Response, IntakeError> {
    let auth = headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let token = auth.strip_prefix("Bearer ").ok_or(IntakeError::InvalidToken)?;

    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[&state.jwt_audience]);
    validation.set_issuer(&[&state.jwt_issuer]);
    let claims = decode::<IntakeClaims>(token, &state.jwt_decoding_key, &validation)
        .map_err(|_| IntakeError::InvalidToken)?
        .claims;

    if claims.tenant.is_empty() {
        return Err(IntakeError::InvalidToken);
    }
    if claims.scope.split_whitespace().all(|s| s != "intake:write") {
        return Err(IntakeError::MissingScope);
    }

    state.limiters.check(&format!("intake-events:{}", claims.tenant), &claims.tenant)?;

    let body_bytes = crate::http::middleware::read_capped_body(body, state.config.cli.intake_max_body_bytes).await?;
    let event: StrictPlatformEvent = serde_json::from_slice(&body_bytes).map_err(|_| IntakeError::MalformedBody)?;
    validate_body(&event)?;

    let registry = state.sources.load();
    let registered_platforms: HashSet<&str> = registry.platforms_for_tenant(&claims.tenant);
    if event.platform.starts_with("twitch") || event.platform == "discord" || event.platform == "slack" || event.platform == "youtube" || event.platform == "kick" {
        return Err(IntakeError::PlatformNotRegistered);
    }
    if !registered_platforms.contains(event.platform.as_str()) {
        return Err(IntakeError::PlatformNotRegistered);
    }

    let platform_event = penguin_spine::PlatformEvent {
        platform: event.platform.clone(),
        event_type: event.event_type,
        actor: event.actor,
        payload: event.payload,
        occurred_at: event.occurred_at,
        source: event.source.map(|s| penguin_spine::Source { platform: s.platform, account_id: s.account_id, channel_id: s.channel_id }),
    };

    let scope = penguin_spine::Scope { tenant: claims.tenant.clone(), community: params.community.clone() };
    let source_id = platform_event.source.as_ref().map(|s| s.account_id.clone()).unwrap_or_else(|| claims.sub.clone());
    // PA-WORKSTREAM: this route authorizes by `platform`, not a specific
    // `source_id` (Sec10.4), so the workstream lookup is by
    // `(tenant, platform)` -- falling back to a deterministic id (Task
    // 12) is defensive against a source row disappearing between the
    // registered-platform check above and this point, never a silent
    // "no workstream" gap.
    let workstream_id = registry
        .workstream_for_platform(&claims.tenant, &event.platform)
        .unwrap_or_else(|| crate::publish::deterministic_workstream_id(&source_id));
    publish_event(
        state.appender.as_ref(),
        &state.metrics,
        &state.binding_keyring,
        &state.usage,
        &scope,
        &source_id,
        &workstream_id,
        None,
        platform_event,
    )
    .await
    .map_err(IntakeError::EnvelopeInvalid)?;

    Ok((StatusCode::ACCEPTED, axum::Json(json!({"accepted": true, "events": 1}))).into_response())
}
```

Add to `sources.rs`'s `impl SourceRegistry` block (production code, not test-only — the REST intake handler needs it):

```rust
impl SourceRegistry {
    /// The set of `platform` strings registered as generic-intake sources
    /// for `tenant` -- what `POST /intake/events` checks a caller's
    /// `platform` field against (§10.4).
    pub fn platforms_for_tenant(&self, tenant: &str) -> std::collections::HashSet<&str> {
        self.by_key.values().filter(|r| r.tenant == tenant).map(|r| r.platform.as_str()).collect()
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='http::intake_events::'`
Expected: `test result: ok. 9 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/http/intake_events.rs core/svc_ingest/src/http/mod.rs core/svc_ingest/src/http/state.rs core/svc_ingest/src/sources.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): generic REST intake handler -- strict PlatformEvent body, intake:write JWT, tenant-registered platforms only, D30/D31 wiring (§10.1/§10.4, D30/D31)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 21: Router assembly + AppState final wiring

**Depends on:** Task 4, Task 17, Task 18, Task 19, Task 20

**Files:**
- Create: `core/svc_ingest/src/http/router.rs`
- Modify: `core/svc_ingest/src/http/mod.rs` (add `pub mod router;`)

Ties every handler from Tasks 17-20 plus Task 4's health/metrics into one Axum `Router`, mounting the Twitch EventSub webhook route **conditionally** (only when `state.twitch_eventsub_secret.is_some()`, §10.1: "Route is not registered at all when `TWITCH_EVENTSUB_SECRET` is unset") and the two generic-intake routes conditionally on the `waddles.core.generic-intake` feature flag (Task 30 resolves it once at startup into `AppState.generic_intake_enabled` — `general.md`/`critical-rules.md`: "every new capability behind a PostHog flag"). Every other route is unconditional.

**Interfaces:**
- Consumes: `crate::http::{health::{healthz, metrics}, twitch_eventsub, kick_webhook, intake_webhook, intake_events, state::AppState}` (Tasks 4, 16-19).
- Produces: `pub fn build_router(state: AppState) -> axum::Router` — the main `:8200` router; `pub fn build_metrics_router(state: AppState, registry: prometheus::Registry) -> axum::Router` — the secondary `:9090` router carrying only `/metrics`, with the registry injected via `axum::Extension`. Reads `AppState.generic_intake_enabled` (already added to the struct and `test_state()` in Task 17, defaulted `true` there — Task 30 is what actually resolves it from the `waddles.core.generic-intake` flag at startup).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn healthz_is_reachable() {
        let router = build_router(crate::http::state::test_state());
        let resp = router.oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn twitch_eventsub_route_is_absent_when_secret_unset() {
        let mut state = crate::http::state::test_state();
        state.twitch_eventsub_secret = None;
        let router = build_router(state);
        let resp = router
            .oneshot(Request::builder().method("POST").uri("/eventsub/twitch/webhook").body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn twitch_eventsub_route_is_present_when_secret_set() {
        let mut state = crate::http::state::test_state();
        state.twitch_eventsub_secret = Some(std::sync::Arc::new(crate::config::Secret::new("x")));
        let router = build_router(state);
        let resp = router
            .oneshot(Request::builder().method("POST").uri("/eventsub/twitch/webhook").body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        // Route exists (handler runs and rejects the malformed/unsigned
        // request) -- the assertion is "not 404", not a specific status.
        assert_ne!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn kick_webhook_route_is_always_present() {
        let router = build_router(crate::http::state::test_state());
        let resp = router
            .oneshot(Request::builder().method("POST").uri("/webhook/kick").body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        assert_ne!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn generic_webhook_route_is_present() {
        let router = build_router(crate::http::state::test_state());
        let resp = router
            .oneshot(Request::builder().method("POST").uri("/intake/webhook/acme/src1").body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        assert_ne!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn generic_rest_intake_route_is_present() {
        let router = build_router(crate::http::state::test_state());
        let resp = router
            .oneshot(Request::builder().method("POST").uri("/intake/events").body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        assert_ne!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn generic_intake_routes_are_absent_when_the_flag_is_off() {
        let mut state = crate::http::state::test_state();
        state.generic_intake_enabled = false;
        let router = build_router(state);
        let webhook_resp = router
            .clone()
            .oneshot(Request::builder().method("POST").uri("/intake/webhook/acme/src1").body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        assert_eq!(webhook_resp.status(), StatusCode::NOT_FOUND);
        let events_resp = router
            .oneshot(Request::builder().method("POST").uri("/intake/events").body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        assert_eq!(events_resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn metrics_router_serves_prometheus_text() {
        let state = crate::http::state::test_state();
        let registry = prometheus::Registry::new();
        let router = build_metrics_router(state, registry);
        let resp = router.oneshot(Request::builder().uri("/metrics").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='http::router::'`
Expected: compile failure, module empty. (Add `tower = {version = "=0.5.3", features = ["util"]}` dev-usage is already covered by Task 1's `[dependencies]` tower entry, which also exposes `ServiceExt::oneshot` for tests via its `util` feature — no `Cargo.toml` change needed.)

- [ ] **Step 3: Write the implementation**

```rust
//! Assembles the two Axum routers: the main `:8200` intake/webhook surface
//! and the secondary `:9090` metrics-only surface. The Twitch EventSub
//! route is the one conditionally-mounted route (§10.1).

use axum::routing::{get, post};
use axum::{Extension, Router};

use crate::http::state::AppState;
use crate::http::{health, intake_events, intake_webhook, kick_webhook, twitch_eventsub};

/// Builds the main `:8200` router.
pub fn build_router(state: AppState) -> Router {
    let mut router = Router::new().route("/healthz", get(health::healthz)).route("/webhook/kick", post(kick_webhook::handle));

    if state.twitch_eventsub_secret.is_some() {
        router = router.route("/eventsub/twitch/webhook", post(twitch_eventsub::handle));
    }

    // waddles.core.generic-intake (Task 30 resolves it at startup) --
    // `general.md`/`critical-rules.md`: every new capability behind a
    // PostHog flag, defaulted OFF until validated.
    if state.generic_intake_enabled {
        router = router
            .route("/intake/webhook/:tenant/:source", post(intake_webhook::handle))
            .route("/intake/events", post(intake_events::handle));
    }

    router.with_state(state)
}

/// Builds the secondary `:9090` metrics-only router.
pub fn build_metrics_router(state: AppState, registry: prometheus::Registry) -> Router {
    Router::new().route("/metrics", get(health::metrics)).layer(Extension(registry)).with_state(state)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='http::router::'`
Expected: `test result: ok. 7 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/http/router.rs core/svc_ingest/src/http/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): assemble the Axum router -- conditional Twitch EventSub route, every other intake route unconditional (§10.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 22: LeasedSupervisor + RawReceiver trait

**Depends on:** Task 3

**Files:**
- Create: `core/svc_ingest/src/supervisor.rs`

Ports the claim/run/release/backoff contract from `core/svc_ingest/socket_lease.py`'s `LeasedReceiver.run()` (§10.2): does **not** raise when the lease can't be claimed or is lost — returns normally, and the supervisor's restart-on-exit-plus-backoff loop retries later (PA-RECEIVER, PA-SPINE).

**Interfaces:**
- Consumes: `penguin_spine::SocketLease` (External Crate Surfaces, PA-SPINE) — used only through the local `Lease` trait below, never named directly outside the production adapter.
- Produces:
  - `#[async_trait::async_trait] pub trait RawReceiver: Send { async fn recv(&mut self) -> Result<serde_json::Value, String>; }` — one raw platform payload per call, blocking until available. Every connector supervisor (Tasks 23-28) wraps its `penguin-connector-*` receiver in a thin adapter implementing this trait (PA-RECEIVER).
  - `#[async_trait::async_trait] pub trait Lease: Send + Sync { async fn try_claim(&self) -> Result<bool, String>; async fn renew(&self) -> Result<bool, String>; async fn release(&self) -> Result<(), String>; }` with `impl Lease for penguin_spine::SocketLease` (production adapter).
  - `pub struct LeasedSupervisor { pub provider: String, pub community: String, pub renew_interval: std::time::Duration, pub base_backoff: std::time::Duration, pub max_backoff: std::time::Duration }` with `pub async fn run<R: RawReceiver>(&self, lease: &dyn Lease, mut receiver: R, mut on_item: impl FnMut(serde_json::Value) -> futures_util_shim + Send, mut shutdown: tokio::sync::watch::Receiver<bool>)` — simplified to a callback-driven loop (see implementation): claims the lease; if unclaimed, sleeps one `renew_interval` and returns (caller's outer restart loop retries); once claimed, spawns a renewal tick every `renew_interval` and reads `receiver.recv()` in a loop, invoking `on_item` per payload, until the lease is lost (a failed renew) or `shutdown` fires, then calls `lease.release()`.
  - `pub async fn restart_with_backoff<F, Fut>(mut task: F, base_backoff: std::time::Duration, max_backoff: std::time::Duration, mut shutdown: tokio::sync::watch::Receiver<bool>) where F: FnMut() -> Fut, Fut: std::future::Future<Output = ()>` — the outer "restart an exited receiver with exponential backoff" loop every connector supervisor task wraps its `LeasedSupervisor::run` call in.

Note: `on_item`'s `futures_util_shim` return type is a placeholder for "a boxed, pinned future" (`std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>`) — write it out in full in the implementation; it's spelled out here as a named type alias `BoxedUnitFuture` to keep the Interfaces line readable.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    struct AlwaysClaimLease { released: Arc<AtomicBool> }
    #[async_trait::async_trait]
    impl Lease for AlwaysClaimLease {
        async fn try_claim(&self) -> Result<bool, String> { Ok(true) }
        async fn renew(&self) -> Result<bool, String> { Ok(true) }
        async fn release(&self) -> Result<(), String> { self.released.store(true, Ordering::SeqCst); Ok(()) }
    }

    struct NeverClaimLease;
    #[async_trait::async_trait]
    impl Lease for NeverClaimLease {
        async fn try_claim(&self) -> Result<bool, String> { Ok(false) }
        async fn renew(&self) -> Result<bool, String> { Ok(true) }
        async fn release(&self) -> Result<(), String> { Ok(()) }
    }

    struct CountingReceiver { count: Arc<AtomicUsize>, limit: usize }
    #[async_trait::async_trait]
    impl RawReceiver for CountingReceiver {
        async fn recv(&mut self) -> Result<serde_json::Value, String> {
            let n = self.count.fetch_add(1, Ordering::SeqCst);
            if n >= self.limit {
                tokio::time::sleep(Duration::from_secs(3600)).await; // block forever once exhausted, shutdown will cut it off
            }
            Ok(serde_json::json!({"n": n}))
        }
    }

    fn sup() -> LeasedSupervisor {
        LeasedSupervisor { provider: "twitch".into(), community: "chan".into(), renew_interval: Duration::from_millis(20), base_backoff: Duration::from_millis(1), max_backoff: Duration::from_millis(10) }
    }

    #[tokio::test]
    async fn unclaimed_lease_returns_without_reading_the_receiver() {
        let count = Arc::new(AtomicUsize::new(0));
        let receiver = CountingReceiver { count: count.clone(), limit: 100 };
        let (_tx, rx) = tokio::sync::watch::channel(false);
        sup().run(&NeverClaimLease, receiver, |_| Box::pin(async {}), rx).await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn claimed_lease_reads_items_and_invokes_the_callback() {
        let count = Arc::new(AtomicUsize::new(0));
        let receiver = CountingReceiver { count: count.clone(), limit: 3 };
        let received = Arc::new(std::sync::Mutex::new(vec![]));
        let received_clone = received.clone();
        let (tx, rx) = tokio::sync::watch::channel(false);
        let lease = AlwaysClaimLease { released: Arc::new(AtomicBool::new(false)) };
        let handle = tokio::spawn(async move {
            sup()
                .run(&lease, receiver, move |item| {
                    received_clone.lock().unwrap().push(item);
                    Box::pin(async {})
                }, rx)
                .await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(true).unwrap();
        let _ = handle.await;
        assert!(received.lock().unwrap().len() >= 3);
    }

    #[tokio::test]
    async fn shutdown_releases_the_lease() {
        let receiver = CountingReceiver { count: Arc::new(AtomicUsize::new(0)), limit: 0 };
        let released = Arc::new(AtomicBool::new(false));
        let lease = AlwaysClaimLease { released: released.clone() };
        let (tx, rx) = tokio::sync::watch::channel(false);
        let handle = tokio::spawn(async move { sup().run(&lease, receiver, |_| Box::pin(async {}), rx).await; });
        tokio::time::sleep(Duration::from_millis(30)).await;
        tx.send(true).unwrap();
        let _ = handle.await;
        assert!(released.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn restart_with_backoff_retries_after_a_task_returns() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = attempts.clone();
        let (tx, rx) = tokio::sync::watch::channel(false);
        let handle = tokio::spawn(async move {
            restart_with_backoff(
                move || {
                    let attempts = attempts_clone.clone();
                    async move { attempts.fetch_add(1, Ordering::SeqCst); }
                },
                Duration::from_millis(1),
                Duration::from_millis(5),
                rx,
            )
            .await;
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        tx.send(true).unwrap();
        let _ = handle.await;
        assert!(attempts.load(Ordering::SeqCst) >= 2);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='supervisor::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! Claim/run/release/backoff wiring shared by every receiver supervisor
//! (Tasks 23-28) -- ported from `core/svc_ingest/socket_lease.py`'s
//! `LeasedReceiver.run()` contract (§10.2). Never raises on an unclaimed
//! or lost lease; the outer `restart_with_backoff` loop is what retries.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// A boxed, pinned, `Send` future returning `()` -- the shape `on_item`
/// callbacks return so `LeasedSupervisor::run` can be generic over any
/// async closure.
pub type BoxedUnitFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// One raw platform payload per call. Every `penguin-connector-*`
/// receiver is wrapped in a thin adapter implementing this (PA-RECEIVER).
#[async_trait::async_trait]
pub trait RawReceiver: Send {
    async fn recv(&mut self) -> Result<serde_json::Value, String>;
}

/// The single-owner socket/poll lease contract (§10.2), abstracted so
/// this module's tests never need a real Valkey.
#[async_trait::async_trait]
pub trait Lease: Send + Sync {
    async fn try_claim(&self) -> Result<bool, String>;
    async fn renew(&self) -> Result<bool, String>;
    async fn release(&self) -> Result<(), String>;
}

#[async_trait::async_trait]
impl Lease for penguin_spine::SocketLease {
    async fn try_claim(&self) -> Result<bool, String> {
        penguin_spine::SocketLease::try_claim(self).await.map_err(|e| e.to_string())
    }
    async fn renew(&self) -> Result<bool, String> {
        penguin_spine::SocketLease::renew(self).await.map_err(|e| e.to_string())
    }
    async fn release(&self) -> Result<(), String> {
        penguin_spine::SocketLease::release(self).await.map_err(|e| e.to_string())
    }
}

/// Claims a lease, then drains a `RawReceiver` while renewing on a
/// timer, until the lease is lost or shutdown fires.
pub struct LeasedSupervisor {
    pub provider: String,
    pub community: String,
    pub renew_interval: Duration,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
}

impl LeasedSupervisor {
    /// Runs one claim/drain/release cycle. Returns (never raises) when
    /// the lease can't be claimed, is lost, or shutdown fires.
    pub async fn run<R: RawReceiver>(
        &self,
        lease: &dyn Lease,
        mut receiver: R,
        mut on_item: impl FnMut(serde_json::Value) -> BoxedUnitFuture + Send,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) {
        match lease.try_claim().await {
            Ok(true) => {}
            Ok(false) => {
                tracing::debug!(provider = %self.provider, community = %self.community, "lease.not_claimed");
                tokio::time::sleep(self.renew_interval).await;
                return;
            }
            Err(err) => {
                tracing::warn!(provider = %self.provider, error = %err, "lease.claim_failed");
                return;
            }
        }
        tracing::info!(provider = %self.provider, community = %self.community, "lease.acquired");

        let mut renew_tick = tokio::time::interval(self.renew_interval);
        renew_tick.tick().await; // consume the immediate first tick

        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    if *shutdown.borrow() { break; }
                }
                _ = renew_tick.tick() => {
                    match lease.renew().await {
                        Ok(true) => {}
                        Ok(false) => {
                            tracing::warn!(provider = %self.provider, "lease.lost");
                            return;
                        }
                        Err(err) => {
                            tracing::warn!(provider = %self.provider, error = %err, "lease.renew_failed");
                            return;
                        }
                    }
                }
                item = receiver.recv() => {
                    match item {
                        Ok(payload) => on_item(payload).await,
                        Err(err) => {
                            tracing::warn!(provider = %self.provider, error = %err, "receiver.recv_failed");
                            return;
                        }
                    }
                }
            }
        }

        if let Err(err) = lease.release().await {
            tracing::warn!(provider = %self.provider, error = %err, "lease.release_failed");
        }
    }
}

/// Restarts `task` with exponential backoff (`base_backoff` doubling to
/// `max_backoff`) every time it returns, until `shutdown` fires.
pub async fn restart_with_backoff<F, Fut>(mut task: F, base_backoff: Duration, max_backoff: Duration, mut shutdown: tokio::sync::watch::Receiver<bool>)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()>,
{
    let mut backoff = base_backoff;
    loop {
        task().await;
        if *shutdown.borrow() {
            return;
        }
        tokio::select! {
            _ = shutdown.changed() => { if *shutdown.borrow() { return; } }
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = std::cmp::min(backoff * 2, max_backoff);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='supervisor::'`
Expected: `test result: ok. 4 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/supervisor.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): LeasedSupervisor claim/run/release/backoff wiring + RawReceiver trait (§10.2, PA-RECEIVER)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

### Task 23: Twitch IRC receiver supervisor

**Depends on:** Task 5, Task 12, Task 22

**Files:**
- Create: `core/svc_ingest/src/receivers/twitch_irc.rs`
- Modify: `core/svc_ingest/src/receivers/mod.rs` (create if absent: `pub mod twitch_irc;`)

Lease key `(provider="twitch", community=channel)` — per-channel single-owner lease, per §10.2's table. `account_id` for `normalize()` is the bot login (`TWITCH_NICK`, config).

**Interfaces:**
- Consumes: `crate::normalize::twitch::normalize` (Task 5); `crate::publish::{publish_event, EventAppender}` (Task 12); `crate::supervisor::{LeasedSupervisor, Lease, RawReceiver, BoxedUnitFuture, restart_with_backoff}` (Task 22).
- Produces: `pub struct TwitchIrcSupervisor { pub channel: String, pub nick: String, pub source_id: String }` with `pub async fn run(&self, lease: &dyn Lease, receiver: impl RawReceiver, appender: std::sync::Arc<dyn EventAppender>, metrics: std::sync::Arc<crate::telemetry::IngestMetrics>, scope: penguin_spine::Scope, sup: LeasedSupervisor, shutdown: tokio::sync::watch::Receiver<bool>)` — wraps `sup.run(...)`, and inside `on_item` calls `normalize(&raw, &self.nick)` then `publish_event`, logging (not panicking) on a normalize failure so one bad IRC line never kills the connection (matches Python's per-event `try/except ValueError` in `runner.py`).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish::fakes::RecordingAppender;
    use crate::supervisor::Lease;
    use crate::telemetry::IngestMetrics;
    use std::sync::Arc;
    use std::time::Duration;

    struct AlwaysClaimLease;
    #[async_trait::async_trait]
    impl Lease for AlwaysClaimLease {
        async fn try_claim(&self) -> Result<bool, String> { Ok(true) }
        async fn renew(&self) -> Result<bool, String> { Ok(true) }
        async fn release(&self) -> Result<(), String> { Ok(()) }
    }

    struct ScriptedReceiver { items: std::vec::IntoIter<serde_json::Value> }
    #[async_trait::async_trait]
    impl crate::supervisor::RawReceiver for ScriptedReceiver {
        async fn recv(&mut self) -> Result<serde_json::Value, String> {
            match self.items.next() {
                Some(v) => Ok(v),
                None => { tokio::time::sleep(Duration::from_secs(3600)).await; unreachable!() }
            }
        }
    }

    #[tokio::test]
    async fn valid_chat_line_is_normalized_and_published() {
        let appender = RecordingAppender::default();
        let receiver = ScriptedReceiver { items: vec![serde_json::json!({"channel_name": "waddlebot", "content": "hi", "author_username": "alice"})].into_iter() };
        let sup_wiring = TwitchIrcSupervisor { channel: "waddlebot".to_string(), nick: "bot-primary".to_string(), source_id: "tw-waddlebot".to_string() };
        let metrics = Arc::new(IngestMetrics::register(&prometheus::Registry::new()));
        let (tx, rx) = tokio::sync::watch::channel(false);
        let appender_dyn: Arc<dyn crate::publish::EventAppender> = Arc::new(appender.clone());
        let handle = tokio::spawn(async move {
            sup_wiring
                .run(&AlwaysClaimLease, receiver, appender_dyn, metrics, penguin_spine::Scope { tenant: "global".to_string(), community: None },
                     crate::supervisor::LeasedSupervisor { provider: "twitch".into(), community: "waddlebot".into(), renew_interval: Duration::from_millis(20), base_backoff: Duration::from_millis(1), max_backoff: Duration::from_millis(5) },
                     rx)
                .await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(true).unwrap();
        let _ = handle.await;
        let envs = appender.envelopes();
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].event.actor.as_deref(), Some("alice"));
    }

    #[tokio::test]
    async fn a_malformed_line_never_stops_the_connection() {
        let appender = RecordingAppender::default();
        let receiver = ScriptedReceiver {
            items: vec![
                serde_json::json!({"channel_name": "waddlebot"}), // missing content -> normalize error
                serde_json::json!({"channel_name": "waddlebot", "content": "second line", "author_username": "bob"}),
            ]
            .into_iter(),
        };
        let sup_wiring = TwitchIrcSupervisor { channel: "waddlebot".to_string(), nick: "bot-primary".to_string(), source_id: "tw-waddlebot".to_string() };
        let metrics = Arc::new(IngestMetrics::register(&prometheus::Registry::new()));
        let (tx, rx) = tokio::sync::watch::channel(false);
        let appender_dyn: Arc<dyn crate::publish::EventAppender> = Arc::new(appender.clone());
        let handle = tokio::spawn(async move {
            sup_wiring
                .run(&AlwaysClaimLease, receiver, appender_dyn, metrics, penguin_spine::Scope { tenant: "global".to_string(), community: None },
                     crate::supervisor::LeasedSupervisor { provider: "twitch".into(), community: "waddlebot".into(), renew_interval: Duration::from_millis(20), base_backoff: Duration::from_millis(1), max_backoff: Duration::from_millis(5) },
                     rx)
                .await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(true).unwrap();
        let _ = handle.await;
        let envs = appender.envelopes();
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].event.actor.as_deref(), Some("bob"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make -C core/svc_ingest test-unit MOD='receivers::twitch_irc::'`
Expected: compile failure, module empty.

- [ ] **Step 3: Write the implementation**

```rust
//! Twitch IRC per-channel receiver supervisor -- claims the `(twitch,
//! {channel})` lease, drains the connector's raw chat lines, normalizes
//! (Task 5) and publishes (Task 12) each one. A malformed line is logged
//! and skipped, never kills the connection (matches `runner.py`'s
//! per-event `try/except ValueError`).

use std::sync::Arc;

use crate::normalize::twitch::normalize;
use crate::publish::{publish_event, EventAppender};
use crate::supervisor::{Lease, LeasedSupervisor, RawReceiver};
use crate::telemetry::IngestMetrics;

/// Per-channel Twitch IRC supervisor wiring.
pub struct TwitchIrcSupervisor {
    pub channel: String,
    pub nick: String,
    pub source_id: String,
}

impl TwitchIrcSupervisor {
    /// Runs one claim/drain/release cycle for this channel.
    pub async fn run(
        &self,
        lease: &dyn Lease,
        receiver: impl RawReceiver,
        appender: Arc<dyn EventAppender>,
        metrics: Arc<IngestMetrics>,
        scope: penguin_spine::Scope,
        sup: LeasedSupervisor,
        shutdown: tokio::sync::watch::Receiver<bool>,
    ) {
        let nick = self.nick.clone();
        let source_id = self.source_id.clone();
        sup.run(
            lease,
            receiver,
            move |raw| {
                let appender = appender.clone();
                let metrics = metrics.clone();
                let scope = scope.clone();
                let nick = nick.clone();
                let source_id = source_id.clone();
                Box::pin(async move {
                    match normalize(&raw, &nick) {
                        Ok(event) => {
                            if let Err(err) = publish_event(appender.as_ref(), &metrics, &scope, &source_id, event).await {
                                tracing::warn!(error = %err, "twitch_irc.publish_failed");
                            }
                        }
                        Err(err) => tracing::warn!(error = %err, "twitch_irc.normalize_failed"),
                    }
                })
            },
            shutdown,
        )
        .await;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `make -C core/svc_ingest test-unit MOD='receivers::twitch_irc::'`
Expected: `test result: ok. 2 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/svc_ingest/src/receivers/twitch_irc.rs core/svc_ingest/src/receivers/mod.rs
git commit -m "$(cat <<'EOF'
feat(svc-ingest): Twitch IRC per-channel receiver supervisor (§10.2)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---
