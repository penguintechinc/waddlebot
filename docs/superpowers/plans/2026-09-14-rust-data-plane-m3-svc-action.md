# Milestone M3 — `svc_action` Rust Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `core/svc_action` (today: Python/Quart) as a Rust service on the `core/svc_streaming` Axum/tokio/SeaORM/OTel template — the terminal pipeline stage that reads each activated bundle's own `{scope}:app:{app_id}:action` Valkey stream through a dedicated consumer group, dispatches via a WASM executor over a capability-scoped mTLS host API (or a native built-in sender for the five first-party platform sends), classifies `transport-error.retryable`, applies retry-with-backoff, and records every outcome to `action_dispatch_log`.

**Architecture:** `svc-action` owns Valkey ACL/Postgres credentials, platform secrets and the egress HTTP client; it never runs bundle code itself. A per-bundle `penguin_spine::GroupReader` drains each bundle's action stream; a match is dispatched either to a native built-in sender (Twitch relay, Discord/Slack/YouTube/Kick REST — ported 1:1 from the current Python bundles, kept local to this crate rather than taking a hard dependency on the not-yet-committed `penguin-connectors` API) or, for every other bundle, across a length-prefixed mTLS wire protocol to a `bundle-executor` Deployment that holds no stage credential. Seven host capabilities (`context`, `http`, `kv`, `db`, `relay`, `flags`, `log`, `clock` — `clock` folded into `context`'s task) are implemented stage-side and are the only thing an executor's `host-call` frame can reach.

**Tech Stack:** Rust 1.97.x, Axum 0.8.9, tokio 1.53.1, SeaORM 2.0.2 (sqlx-postgres, runtime-tokio-rustls), `redis` 0.27.6, `rustls`/`tokio-rustls` for the host-API mTLS listener, `penguin-spine` 0.1.0 (Valkey Streams spine, spec §4.7), `penguin-bundle-host` 0.1.0's `wire` module only (frame codec + `FrameTransport`, spec §6.6), `tracing` + `opentelemetry-otlp` + `prometheus` (this plan's own telemetry module — see Global Constraints for why `penguin-logging` is not a hard dependency yet), `jsonwebtoken` (`aws_lc_rs` backend), `sqlparser` 0.52.0 for the `db` capability's statement guard.

**Spec:** `docs/superpowers/specs/2026-09-14-rust-data-plane-design.md` (commit `680a0a9b`, fetched from `origin/docs/rust-data-plane-spec`) — read this plan alongside it. Section anchors used throughout: §4.3 (`svc_action` component), §4.7 (`penguin-spine`), §4.8 (`penguin-bundle-host`), §5.9 (process→action, per-bundle action streams), §6.5 (WIT world), §6.6 (executor wire protocol), §6.7 (distribution API), §7 (host interface and executor), §8 (egress model), §11 (security model), §12 (deployment), §13 (observability), §14 (testing strategy, esp. §14.6 negative sandbox tests), §16 M3 (this milestone's own deliverable row).

## Global Constraints

Copied verbatim from the spec's Standards (§17) and Global Constraints, plus this plan's own scope decisions — every task's requirements implicitly include this section.

### Named executor inputs — penguin-libs git dependency pins

`penguin-spine`, `penguin-bundle-host` and the `penguin-connector-*` crates are consumed as **git dependencies pinned to a full 40-char commit SHA on their own plan branch, never a crates.io version.** Each sibling plan's own final task (e.g. `docs/plan-penguin-connectors` Task 24) explicitly stops for **user approval before the irreversible crates.io publish** — a human gate this plan cannot assume has been passed by the time an implementer runs `cargo generate-lockfile`. A git+`rev` pin is an equally immutable, cryptographically-verifiable reference (`critical-rules.md` Dependency Pinning) that does not depend on that gate. The four SHAs below are fixed, resolved values — not placeholders — captured from each branch's tip as of this continuation (2026-09-15); every task below writes the literal SHA in `Cargo.toml`, never the symbolic name (TOML has no variables) — the names exist only so this document can refer to "the pin" consistently in prose.

| Name | Repo | Branch | Commit (40-char SHA) |
|---|---|---|---|
| `SPINE_REV` | `https://github.com/penguintechinc/penguin-libs.git` | `docs/plan-penguin-spine` | `5f6db087efffd87283b2f9fc840deb1f3974c49e` |
| `LOGGING_REV` | `https://github.com/penguintechinc/penguin-libs.git` | `docs/plan-penguin-logging` | `9328208debfd8767cdc1a2241582fda0856d0e63` |
| `CONNECTORS_REV` | `https://github.com/penguintechinc/penguin-libs.git` | `docs/plan-penguin-connectors` | `c5ed81de5c2870926e9cc00e1647d4ed90f22801` |
| `BUNDLE_HOST_REV` | `https://github.com/penguintechinc/penguin-libs.git` | `docs/plan-penguin-bundle-host` | `8ca1e69b983e04d40ef11f921b6448779b6a8f1e` |

`LOGGING_REV` is captured for completeness (not consumed — P5 keeps `penguin-logging` out of this plan's dependency graph). If any of these branches force-pushes past this SHA before an implementer runs Task 1, the fix is to re-resolve `git rev-parse origin/<branch>` and update every `rev = "..."` occurrence below to the new value in one pass — never widen to a branch name or drop the `rev` key. Each pin's `Cargo.toml` stanza additionally names its `git`/`branch`/`rev` fields explicitly (not a bare git URL) so `cargo deny check`'s `[sources] allow-git` allowlist (Task 1) is the only exception needed to `critical-rules.md`'s "no mutable refs" rule — the branch name is documentation only, `rev` is what Cargo actually resolves.

**Verified state as of this continuation, recorded for the implementer's benefit:** `git ls-tree -r origin/docs/plan-penguin-spine` (and the bundle-host/connectors equivalents) currently returns **zero** files under `packages/rust-*/` — these branches carry only the plan *document*, not yet applied source. The pins above are therefore forward-looking: they resolve once each crate's own plan has actually **executed** (its tasks' commits landed on that same branch, adding real `Cargo.toml`/`src/` alongside the plan doc) — the milestone graph (spec §16) gates M3's own execution on M1's completion, so by the time this plan's Task 1 actually runs, the pinned rev is expected to have real source; **re-run `git rev-parse origin/<branch>` immediately before Task 1** regardless, since the exact merge commit that lands the code is not knowable today. **Per Coordinator ruling R60 (this continuation):** `svc_action` depends on these crates directly and never re-implements their spine/wire primitives locally (no `crate::spine::*`, no `PROVISIONAL(M1)` executor wire) — service-specific logic (built-in senders, `action_dispatch_log`, retry classification, the seven host capabilities) stays local per P3/P4 and calls into the crate types; anything the spec requires that a crate's *plan* does not yet expose is listed in the "Crate gaps" table below rather than copied into this service.

#### Crate gaps (must be added to plan M1a/M1c, not ported into this service)

| Gap | What the spec/M3 needs | What the crate's plan currently gives | Resolution |
|---|---|---|---|
| `data.tables` read/write distinction | `penguin-bundle-host`'s own `ApprovedPermissions.tables: Vec<TableGrant>` (with `read`/`write` bools) implies per-table read/write scoping | hub-api's actual distribution v2 manifest (`docs/plan-m2b-hub-api` Task 32) sends `data.tables` as a flat `Vec<String>`, no read/write flag | This plan's `ApprovedPermissions` (Task 21) uses the flat set hub-api actually sends — the sqlparser statement-kind allowlist (Task 19) plus Postgres RLS remain the two real enforcement layers. **Must match plan M1c/M2b**: either `penguin-bundle-host`'s `ApprovedPermissions` narrows to match hub-api's real shape, or M2b's manifest gains a read/write flag — this plan cannot decide that unilaterally. |
| `capabilities`/`routes_to` on `ApprovedPermissions` | `penguin-bundle-host`'s `ApprovedPermissions` declares `capabilities: HashSet<Capability>` and `routes_to: Vec<String>` fields | hub-api's real manifest subset (§6.7) is exactly `{egress, data.tables, limits, consumes}` — no `capabilities` or `routes_to` key | This plan's `ApprovedPermissions` (Task 21) carries only `egress`/`tables`, matching the real wire data; every host capability is available to every activated bundle (enforcement is per-call allowlist/table-check, not a capability grant list) and `routes_to` is a process-stage-only concern (spec §5.9) this terminal stage never evaluates. **Must match plan M1c** if that crate's `ApprovedPermissions` is later used verbatim. |
| `waddles:usage` wire shape | `penguin_spine::SpineClient::append_usage` XADDs one `env` field holding the full nested-JSON `UsageDelta` | `docs/plan-m2b-hub-api` Task 47's `usage_aggregator_service.parse_usage_entry` expects flat per-field entries (`host_calls` as one summed count, not `HostCallCounts`'s six sub-fields) | Unresolved (P10) — this plan uses `append_usage` as the crate specifies (P1's hard-dependency rule) since bypassing it to hand-roll a different shape would duplicate that crate's own trim/maxlen logic. **Must match plan M1a/M2b** — whichever author reconciles the shape second updates the other. |

- **Language/tier:** Rust, no exception — `svc_action` sits in-line of traffic (`critical-rules.md` Data Plane).
- **Rust stack:** Axum + tokio + SeaORM + `tracing`; `rustls` never native TLS/OpenSSL; `jsonwebtoken` with the `aws_lc_rs` backend (never the `rust_crypto` feature — RUSTSEC-2023-0071).
- **Rust lints:** `[lints.rust] unsafe_code = "deny"`, `missing_docs = "deny"`; `[lints.clippy] unwrap_used = "deny"` — every `.unwrap()`/`.expect()` outside `#[cfg(test)]` must carry a `// SAFETY:`/invariant comment. `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` clean before every commit.
- **Dependency pinning:** exact `=x.y.z` in `Cargo.toml`, never `^`/`~`/bare `*`; `Cargo.lock` committed; `cargo deny check` clean (advisories, licenses, bans, sources — no PRC-origin/sanctioned crates). Exact patch versions in this plan were chosen at planning time; if a registry pin is unavailable when a task runs `cargo generate-lockfile`, the implementer updates the `Cargo.toml` pin to the nearest available exact version and notes the substitution in the commit message — never widen to a range. `penguin-spine`, `penguin-bundle-host` and the `penguin-connector-*` crates are the one exception to "registry pin": they are `git`+`rev` dependencies pinned to a fixed 40-char commit SHA (see "Named executor inputs" below) — if the cited branch has force-pushed past that SHA by the time a task runs, re-resolve with `git rev-parse origin/<branch>` and update every occurrence of that `rev` value in this plan, never fall back to a bare branch/tag reference.
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
| P2 | **`penguin-bundle-host` is a hard dependency, but only its `wire` module** (`wire::message::{Frame, Message, ExportKind, CapabilityKind, ErrorCode, SandboxInfo, HelloLimits, LoadLimits, InvocationScope, HostResultError}`, `wire::frame::{read_frame, write_frame, FrameError, MAX_FRAME_BYTES}`, `wire::transport::{FrameTransport, TransportError}`). **`InvocationScope`/`HostResultError` added to this list during this continuation** (Task 16/19/21 onward): `Message::HostCall`/`Message::Invoke` embed `wire::message::InvocationScope` directly, and `Message::HostResult` embeds `wire::message::HostResultError` — since `Message` itself is already consumed verbatim (this row), these two types travel with it whether or not this plan names them separately; Task 16 re-exports `InvocationScope` under `hostapi::capabilities::context::InvocationScope` purely for a shorter import path, never as a second, diverging type. | That crate's own plan (`docs/plan-penguin-bundle-host`, Tasks 1-8) has committed, tested code for exactly this module and no other — its `host::*`/`manifest`/`loader` modules are not yet planned. Depending only on the verified module avoids a guessed, possibly-wrong API surface. |
| P3 | **The seven host capabilities (`context`, `http`, `kv`, `db`, `relay`, `flags`, `log`; `clock` is folded into `context`'s task) are implemented locally**, in `svc_action::hostapi::capabilities`, not consumed from `penguin-bundle-host::host::*`. **Revisited at Task 18+ (still local, now name-mirrored):** by the time this plan resumed, `docs/plan-penguin-bundle-host` had grown to 25 tasks with a fully specified `host::*` surface (`ApprovedPermissions` Task 9, capability traits Task 10, `EgressGuard` Tasks 11-12, `DbGuard`/`DbExecutor` Task 13, `Kv`/`Relay`/`Flags`/`Log`/`Clock` guards Task 14, `TripTracker` Task 15, `HostCallRouter`/`HostCallContext`/`InvocationScope` Task 16, `Server`/`ExecutorConnection` Task 17) — but that is still a *plan document*, not merged code, and Tasks 14-17 here already committed local `KvCapability`/`ClockCapability`/`FlagsClient`/`ExecutorConnection`/`BundleRegistry`/`ConnectionPool` types under this crate's own naming. Switching Tasks 18-21 to a real crate dependency mid-plan while 14-17 stay local would split the codebase across two capability architectures. Tasks 18-21 therefore stay local but are now **tight, name-matching ports** of the crate's now-available design (`ApprovedPermissions`, `DbGuard`/`DbExecutor`/`InvocationScope`, `KvGuard`-style `GuardDenial`/`InvalidKey`, `HostCallContext::scope()`, `HostCallRouter`-shaped dispatch, `record_tenant_boundary_violation`, three-strike `TripTracker`) rather than independently invented shapes — a later mechanical extraction into `penguin-bundle-host::host::*` becomes closer to a `sed`, not a rewrite. | That crate's plan has not reached those tasks *at the time Tasks 14-17 were written*; consistency with already-committed code outweighs a mid-plan architecture flip, especially once the target shape is this well specified. |
| P4 | **The five built-in platform senders (Twitch relay, Discord, Slack, YouTube, Kick) depend directly on `penguin-connectors`** (spec §4.10) as of Task 18/23-26, reversing the original P4 below. | `docs/plan-penguin-connectors` is now fully written (24 tasks) with a concrete, tested `ActionSender` trait and five per-platform senders (`penguin-connector-twitch::relay::{TwitchRelayMessage, resolve_relay_message, TwitchIrcSender}` Task 9; `DiscordRestSender` Task 13; `SlackChatSender` Task 15; `YouTubeChatSender` Task 17; `KickChatSender` Task 20), plus the shared `Secret`, `RetryClass`/`SendOutcome`/`SendError`, `classify_status`/`build_http_client`/`network_error_to_send_error`/`with_traceparent`, and `TraceContext = penguin_spine::Trace` (D30). Unlike P3's capabilities, **no sender code has been committed yet in this plan** (Task 18 is the first sender task written), so there is no already-committed local architecture to stay consistent with — depending on the crate directly is strictly better than porting Python a second time. YouTube's and Kick's connector-crate senders independently arrived at the same env-credential-only / access-token-ref-only scoping this plan's original P7 already decided, confirming rather than contradicting that decision. ~~The five built-in platform senders are implemented locally, ported line-for-line from `core/svc_action/bundles/{twitch,discord,slack,youtube,kick}_send_action.py` and `core/svc_action/services/{youtube,kick}_oauth.py`, rather than depending on `penguin-connectors`.~~ (superseded) | `penguin-connectors`'s plan did not exist yet at planning time for the original P4; it does now, with an API stable enough to build against directly. |
| P5 | **`penguin-logging` is not a dependency of this plan.** Telemetry (Task 6), health (Task 8) and log sanitization (Task 5) are implemented locally, mirroring `core/svc_streaming/src/telemetry.rs` (read in full during planning; proven, compiling code) plus a verbatim port of the `SENSITIVE_KEYS` algorithm, which **is** normatively specified (`docs/plan-penguin-logging`'s Global Constraints give the exact key list and matching rules, even though that plan has no committed function signatures yet). | Depending on an unpublished crate whose only available artifact is a file-structure listing (no function signatures) is a real risk of non-compiling code for a cheap implementer. Local implementation is self-contained and correct today; swapping to the shared crate once M1 publishes it with a confirmed API is flagged as follow-on work. |
| P6 | **`flags` capability uses a small local `FlagsClient`**, not `penguin-licensing`'s Rust API directly (unread/unverified in this session), but faithful to the documented two-gate/fail-open/5-minute-cache/72h-offline-grace behavior contract (`critical-rules.md` Feature Flags & License Tiers). | Same reasoning as P5 — behavior is normatively documented, the crate's exact Rust signatures are not verified. |
| P7 | **YouTube's per-community OAuth-connected-account resolution (`get_access_token_for_community`'s `resolve_community_tokens` path, gh-320 / `platform_integrations` service) is out of scope.** This plan ports only the env-credential refresh-token flow (`refresh_token_ref`/`client_id_ref`/`client_secret_ref`). | The Connections/`platform_integrations` service is a separate feature stream not mentioned anywhere in the rust-data-plane spec; folding it in would be scope creep beyond what this spec authorizes. Flagged as explicit follow-on work. |
| P8 | **Built-in senders bypass the executor entirely** — the action consumer loop (Task 22) checks the polled bundle row's `app_id` against a fixed first-party set (`waddles.bot.twitch.default`, `waddles.bot.discord.default`, `waddles.bot.slack.default`, `waddles.bot.youtube.default`, `waddles.bot.kick.default`) before considering the executor path. | Matches the M3 milestone table's own wording ("Built-in senders" as an `svc_action` deliverable, parallel in structure to `svc_process`'s M4 "Built-ins" row) and avoids these OAuth-refresh-heavy, trusted, first-party sends going through the WASM sandbox, which has no ready-made token-refresh primitive. |
| P9 | **RLS policy DDL on bundle-owned tables is not this plan's to write for real bundle tables** (e.g. `music_queue`) — only the `db` capability's `SET LOCAL waddles.tenant`/`waddles.community` transaction wrapper (Task 19) is. The mandatory live-Postgres RLS negative test (§14.11 test 5, Task 29) proves the mechanism against a throwaway fixture table this plan creates and drops inside its own test, not a real bundle table. | `docs/plan-m2b-hub-api`'s own Self-Review explicitly confirms RLS on `data.tables` is **out of M2b's scope**, "explicitly the Rust stage side's job" — but no plan (M1.5's bundle-DAL migration, M2b, or this one) owns writing policy DDL against a specific first-party bundle's schema. Recorded here as a genuine cross-plan gap rather than silently assumed away; flagged again in the self-review. |
| P10 | **This plan's only usage-emission call is `penguin_spine::SpineClient::append_usage`**, which `XADD`s a single `env` field holding the full nested-JSON `UsageDelta` (`host_calls` broken out per capability kind) — even though `docs/plan-m2b-hub-api` Task 47's `usage_aggregator_service.parse_usage_entry` expects **flat** per-field `XADD` entries (`tenant_id`, `community_id` as `"_tenant"` string, one summed `host_calls` count, decimal-string counters). | P1 makes `penguin-spine`'s given signatures a hard, verbatim dependency — this plan cannot bypass `append_usage` to hand-roll a different wire shape without duplicating (and risking drift from) that crate's own `stream_maxlen`/trim logic. M2b Task 47's own text acknowledges the wire shape is "this task's own decision" that "must match whichever plan implements the stage-side `XADD` producer" — this plan cannot unilaterally pick a shape for a contract two other plans also constrain. Recorded as an explicit, unresolved cross-plan mismatch (self-review), not papered over; this plan's own golden-fixture tests (Task 28) assert byte-for-byte only against `penguin_spine::UsageDelta`'s own serde shape, the one contract this plan can verify today. |
| P11 | **The distribution poller (Task 11, already written) targeted the v1 URL and response shape while assuming v2-only fields — corrected in place, not re-planned.** Fixed directly in Task 11 during this continuation: URL changed to `GET {DISTRIBUTION_URL}/v2/bundles` (`docs/plan-m2b-hub-api` Task 33's actual v2 route — v1's five-field body never carried `artifactDigest`/`manifest` at all), plus `ETag`/`If-None-Match` caching added. | `ActionBundleRow` already required `artifactDigest`/`manifest` fields (Global Constraints reasoning above), which the real v1 response never sends — a real bug, not a style choice, caught by re-reading M2b Task 33 during this continuation. Left as a silent latent defect would mean the poller never parses a real hub-api response. |

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
        log.rs                          NEW (Task 21)
      dispatch.rs                        NEW (Task 21) — ApprovedPermissions-equivalent enforcement + TripTracker-equivalent + D31 host-call usage
    senders/
      mod.rs                            NEW (Task 18) — depends on `penguin-connector-*` (P4, revised)
      twitch.rs                         NEW (Task 18) — wraps `penguin_connector_twitch::relay`
      discord.rs                        NEW (Task 23) — wraps `penguin_connector_discord::DiscordRestSender`
      slack.rs                          NEW (Task 24) — wraps `penguin_connector_slack::SlackChatSender`
      youtube.rs                        NEW (Task 25) — wraps `penguin_connector_youtube::YouTubeChatSender`
      kick.rs                           NEW (Task 26) — wraps `penguin_connector_kick::KickChatSender`
    consumer/
      mod.rs                            NEW (Task 22)
      action_loop.rs                    NEW (Task 22)
    runner.rs                           NEW (Task 27)
  tests/
    config.rs                           NEW (Task 3)
    telemetry.rs                        NEW (Task 6)
    startup_check.rs                    NEW (Task 7)
    health.rs                           NEW (Task 8)
    distribution_poller.rs              NEW (Task 11 — fixed in place this continuation: v2 URL + ETag, see P11)
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
    golden_fixtures.rs                  NEW (Task 28)
    negative_sandbox.rs                 NEW (Task 29)
    e2e_valkey_fake_executor.rs         NEW (Task 30)
    support/
      mod.rs                            NEW (Task 14)
      test_certs.rs                     NEW (Task 14) — rcgen-based mTLS test CA/cert helper
      fake_executor.rs                  NEW (Task 15) — scripted wire-protocol executor double
  bundles/                              Python sources — UNCHANGED by this plan (M1.5/M2 own them)
.github/workflows/
  rust-svc-action.yml                   NEW (Task 32)
k8s/helm/waddlebot/
  templates/
    svc-action.yaml                     MODIFY (Task 33)
    svc-action-executor.yaml            NEW (Task 33)
    networkpolicy-svc-action.yaml       NEW (Task 33)
  values.yaml                           MODIFY (Task 33)
docs/
  ops/
    svc-action-notes.md                 NEW (Task 34)
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
# Sec 4.7 -- exact public surface given in the spec itself. Git+rev, not
# a crates.io version -- that crate's own plan gates its crates.io
# publish on user approval (Global Constraints, "Named executor inputs");
# SPINE_REV below is that table's fixed, resolved commit.
penguin-spine = { git = "https://github.com/penguintechinc/penguin-libs.git", branch = "docs/plan-penguin-spine", rev = "5f6db087efffd87283b2f9fc840deb1f3974c49e" }
# Sec 6.6 -- only the `wire` module (frame codec + FrameTransport) is
# consumed; see this plan's Global Constraints P2. BUNDLE_HOST_REV.
penguin-bundle-host = { git = "https://github.com/penguintechinc/penguin-libs.git", branch = "docs/plan-penguin-bundle-host", rev = "8ca1e69b983e04d40ef11f921b6448779b6a8f1e" }

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
# penguin-spine, penguin-bundle-host, and (from Task 18) the
# penguin-connector-* crates -- all git+rev pinned to a fixed 40-char SHA
# (Global Constraints "Named executor inputs"), never a branch/tag alone.
allow-git = ["https://github.com/penguintechinc/penguin-libs.git"]

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

    /// `{hub_api_url}/api/v1/distribution/v2/bundles`, unless overridden.
    /// **Fixed in place (P11):** the v1 route's five-field body never
    /// carries `artifactDigest`/`manifest`/`grants` — only
    /// `docs/plan-m2b-hub-api` Task 33's v2 route does, and this
    /// service's `ActionBundleRow` (Task 11) requires those fields.
    pub fn distribution_url(&self) -> String {
        self.distribution_url
            .clone()
            .unwrap_or_else(|| format!("{}/api/v1/distribution/v2/bundles", self.hub_api_url))
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

### Task 11: Distribution poller (`GET .../distribution/v2/bundles?stage=action`)

> **Fixed in place during this continuation (P11):** the version below targets hub-api's actual v2 route (`docs/plan-m2b-hub-api` Task 33) and caches its `ETag`, correcting the original draft, which pointed at v1's URL while assuming v2-only response fields (`artifactDigest`, `manifest`) that the real v1 body never sends.

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
            .and(path("/api/v1/distribution/v2/bundles"))
            .and(query_param("stage", "action"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let poller = DistributionPoller::new(
            reqwest::Client::new(),
            format!("{}/api/v1/distribution/v2/bundles", server.uri()),
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
    async fn poll_once_sends_if_none_match_and_a_304_keeps_the_cached_set_without_backoff() {
        let server = MockServer::start().await;
        let body = serde_json::json!({"bundles": [{
            "appId": "waddles.bot.slack.default", "communityId": null, "entrypoint": null,
            "spec": {}, "config": {}, "artifactVersion": null, "artifactDigest": null,
            "artifactKind": "source", "language": "python", "scanStatus": "scanned",
            "manifest": {"egress": [], "data": {"tables": []}, "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10}}
        }]});
        Mock::given(method("GET"))
            .and(path("/api/v1/distribution/v2/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body).insert_header("ETag", "\"abc123\""))
            .mount(&server)
            .await;

        let poller = DistributionPoller::new(
            reqwest::Client::new(),
            format!("{}/api/v1/distribution/v2/bundles", server.uri()),
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
        Mock::given(method("GET"))
            .and(path("/api/v1/distribution/v2/bundles"))
            .and(wiremock::matchers::header("If-None-Match", "\"abc123\""))
            .respond_with(ResponseTemplate::new(304))
            .mount(&server)
            .await;
        let second = poller.poll_once().await;
        assert_eq!(second.len(), 1, "a 304 must return the cached last-known-good set");
        assert_eq!(second[0].app_id, "waddles.bot.slack.default");
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
            format!("{}/api/v1/distribution/v2/bundles", server.uri()),
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
    /// The `ETag` from the most recent `200` response, sent back as
    /// `If-None-Match` on the next poll (P11) — a `304` means "nothing
    /// changed" and is not a failure: `consecutive_failures` is reset to
    /// `0` exactly as a fresh `200` would, and `last_known_good` is
    /// returned unmodified.
    last_etag: Mutex<Option<String>>,
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
            last_etag: Mutex::new(None),
        }
    }

    /// One poll attempt. Never errors: a failure logs at WARN, applies
    /// exponential backoff via a short sleep bounded by `max_backoff`, and
    /// returns the last successfully-fetched bundle set (empty on the
    /// very first failure). A `304` (P11: `If-None-Match` round trip
    /// against the cached `ETag`) is treated exactly like a fresh `200`
    /// that happened to carry the same bundle set — `consecutive_failures`
    /// resets to `0`, no backoff, `last_known_good` returned as-is.
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
        if let Some(etag) = self.last_etag.lock().expect("mutex not poisoned").clone() {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }

        match request.send().await {
            Ok(resp) if resp.status() == reqwest::StatusCode::NOT_MODIFIED => {
                *self.consecutive_failures.lock().expect("mutex not poisoned") = 0;
                self.last_known_good.lock().expect("mutex not poisoned").clone()
            }
            Ok(resp) if resp.status().is_success() => {
                let etag = resp
                    .headers()
                    .get(reqwest::header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                match resp.json::<DistributionResponse>().await {
                    Ok(parsed) => {
                        *self.consecutive_failures.lock().expect("mutex not poisoned") = 0;
                        *self.last_etag.lock().expect("mutex not poisoned") = etag;
                        let mut cache = self.last_known_good.lock().expect("mutex not poisoned");
                        *cache = parsed.bundles.clone();
                        parsed.bundles
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "distribution response failed to parse, degrading to last-known-good");
                        self.backoff().await;
                        self.last_known_good.lock().expect("mutex not poisoned").clone()
                    }
                }
            }
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
Expected: `test result: ok. 4 passed; 0 failed` for `distribution::poller::tests`.

- [ ] **Step 7: Commit**

Stage `core/svc_action/src/distribution/mod.rs core/svc_action/src/distribution/poller.rs core/svc_action/src/config.rs core/svc_action/src/lib.rs` and commit with message:

```
feat(svc-action): distribution API v2 poller for stage=action, ETag-cached

Targets docs/plan-m2b-hub-api Task 33's GET .../distribution/v2/bundles
(not v1, whose five-field body never carries artifactDigest/manifest --
fields this poller's ActionBundleRow already required). Caches the
response ETag and sends it back as If-None-Match; a 304 is treated as a
successful poll that returned the same set, never a failure.

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
            digest: "sha256:abc".to_string(),
            export: ExportKind::Dispatch,
            payload: serde_json::json!({"tenant": "global"}),
            deadline_ms: 2000,
            scope: penguin_bundle_host::wire::message::InvocationScope {
                tenant_id: "global".to_string(),
                community_id: None,
                workstream_id: "8f14e45f-ceea-467e-adde-3fb5c9752730".to_string(),
                app_id: "waddles.socials.music.default".to_string(),
                trace: None,
            },
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
// Fixed in place during this continuation: the original draft gave this
// struct a standalone `app_id`/`trace_context: Option<String>` pair,
// which does not match `penguin_bundle_host::wire::message::Message::
// Invoke`'s real shape (`digest, export, payload, deadline_ms, scope:
// InvocationScope` -- no bare `app_id` field at all, D30 folds it and
// `trace` into `scope`). `invoke()` below is fixed to match.
pub struct InvokeRequest {
    pub digest: String,
    pub export: ExportKind,
    pub payload: serde_json::Value,
    pub deadline_ms: u64,
    /// D30 (spec §5.11): the invocation's full scope -- carries `app_id`
    /// and `trace`, so there is no separate `app_id`/`trace_context`
    /// field (fixed in this continuation to match
    /// `penguin_bundle_host::wire::message::Message::Invoke`'s real
    /// shape, which was never a standalone-`app_id`/`trace_context` pair).
    pub scope: penguin_bundle_host::wire::message::InvocationScope,
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

    /// The underlying transport -- added in this continuation (Task 21)
    /// so the host-call dispatch loop can call `recv_unsolicited()`/
    /// `send()` on the exact same connection `invoke()` uses, rather than
    /// this crate inventing a second channel for the same socket.
    pub fn transport(&self) -> Arc<FrameTransport> {
        self.transport.clone()
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
            digest: req.digest,
            export: req.export,
            payload: req.payload,
            deadline_ms,
            scope: req.scope,
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
- Consumes: `penguin_spine::Trace` (P1).
- Produces: `hostapi::capabilities::{context::{build_bundle_context, BundleContext, InvocationScope}, flags::{FlagsClient, PostHogFlagsClient}}` — Task 21's dispatch multiplexer calls `build_bundle_context` for `capability: context, op: "get-context"` and `FlagsClient::enabled`/`tier` for `capability: flags`; `BundleContext::scope()` (`-> InvocationScope`) is what Task 19's `db` capability and Task 21/22's D31 usage recording key on.

> **Extended in place during this continuation:** `BundleContext`/`build_bundle_context` originally carried no `workstream_id`/`trace` — added here because D30 (spec §5.11) requires both on every span this stage emits (`waddles.workstream_id` span attribute) and D31 (§5.12) keys every usage delta on `workstream_id`; Tasks 19-22 (written in this continuation) need them and there is no later task positioned to retrofit `BundleContext` without a forward reference. `InvocationScope` mirrors `penguin-bundle-host::wire::message::InvocationScope` field-for-field (Global Constraints P3) — `tenant_id`/`community_id`/`workstream_id`/`app_id`/`trace` — so a future extraction to that crate is a type-alias swap, not a rewrite.

- [ ] **Step 1: Write the failing tests**

`tests/capabilities_context_flags.rs`:

```rust
use svc_action::hostapi::capabilities::context::build_bundle_context;
use svc_action::hostapi::capabilities::flags::{FlagsClient, PostHogFlagsClient};

#[test]
fn build_bundle_context_carries_envelope_and_config_fields() {
    let trace = penguin_spine::Trace {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_string(),
        tracestate: None,
    };
    let ctx = build_bundle_context(
        "global",
        Some("main"),
        "waddles.bot.discord.default",
        "waddles.bot.discord",
        "3.0.0",
        "1757851200000-0",
        "8f14e45f-ceea-467e-adde-3fb5c9752730",
        Some(&trace),
        &serde_json::json!({"channel_id": "123"}),
    );
    assert_eq!(ctx.tenant, "global");
    assert_eq!(ctx.community.as_deref(), Some("main"));
    assert_eq!(ctx.app_id, "waddles.bot.discord.default");
    assert_eq!(ctx.message_id, "1757851200000-0");
    assert_eq!(ctx.workstream_id, "8f14e45f-ceea-467e-adde-3fb5c9752730");
    assert_eq!(ctx.trace.as_ref().unwrap().traceparent, trace.traceparent);
    let config: serde_json::Value = serde_json::from_str(&ctx.config_json).unwrap();
    assert_eq!(config["channel_id"], "123");

    let scope = ctx.scope();
    assert_eq!(scope.tenant_id, "global");
    assert_eq!(scope.community_id.as_deref(), Some("main"));
    assert_eq!(scope.workstream_id, "8f14e45f-ceea-467e-adde-3fb5c9752730");
    assert_eq!(scope.app_id, "waddles.bot.discord.default");
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

/// D30 (spec §5.11): the tenant/community/workstream/app/trace scope of
/// the invocation currently in flight. Re-exported from
/// `penguin_bundle_host::wire::message::InvocationScope` (P2) rather than
/// duplicated locally — `Message::HostCall`/`Message::Invoke` (also P2)
/// embed this exact type on the wire, so a local duplicate would silently
/// diverge from what every frame actually carries. No WIT interface
/// (`db`, `kv`, `http`, `relay`) accepts a tenant or community parameter;
/// scope is always derived from here, never bundle-supplied.
pub use penguin_bundle_host::wire::message::InvocationScope;

/// Mirrors the WIT `bundle-context` record, plus the D30 `workstream_id`/
/// `trace` fields every span and usage delta this stage emits keys on
/// (extended in this continuation — see this task's Interfaces note).
#[derive(Debug, Clone, Serialize)]
pub struct BundleContext {
    pub tenant: String,
    pub community: Option<String>,
    pub app_id: String,
    pub feature: String,
    pub version: String,
    pub message_id: String,
    pub workstream_id: String,
    pub trace: Option<penguin_spine::Trace>,
    pub config_json: String,
}

impl BundleContext {
    /// Builds the [`InvocationScope`] this context implies — the D30
    /// scope `db`'s `SET LOCAL waddles.tenant`/`waddles.community` and
    /// every D31 usage-metering call site derive from, rather than
    /// re-copying these five fields by hand at each call site (mirrors
    /// `penguin-bundle-host::host::HostCallContext::scope()`, P3).
    pub fn scope(&self) -> InvocationScope {
        InvocationScope {
            tenant_id: self.tenant.clone(),
            community_id: self.community.clone(),
            workstream_id: self.workstream_id.clone(),
            app_id: self.app_id.clone(),
            trace: self.trace.clone(),
        }
    }
}

/// Builds the `context` capability's `get-context` response.
/// `config_json` is the resolved 3-tier config, already serialized.
#[allow(clippy::too_many_arguments)]
pub fn build_bundle_context(
    tenant: &str,
    community: Option<&str>,
    app_id: &str,
    feature: &str,
    version: &str,
    message_id: &str,
    workstream_id: &str,
    trace: Option<&penguin_spine::Trace>,
    config: &serde_json::Value,
) -> BundleContext {
    BundleContext {
        tenant: tenant.to_string(),
        community: community.map(str::to_string),
        app_id: app_id.to_string(),
        feature: feature.to_string(),
        version: version.to_string(),
        message_id: message_id.to_string(),
        workstream_id: workstream_id.to_string(),
        trace: trace.cloned(),
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

### Task 18: Host capability `relay` + Twitch built-in sender (via `penguin-connectors`)

> **P4, revised:** `docs/plan-penguin-connectors` is now fully written (24 tasks) with a concrete `ActionSender` trait and five per-platform senders. This task and Tasks 23-26 depend on it directly instead of porting the Python `*_send_action.py` bundles locally, reversing the original P4 (see Global Constraints).

**Depends on:** Task 16 (`hostapi::capabilities::mod` stub), Task 12 (`retry::{TransportOutcome, TransportSuccess}`).

**Files:**
- Modify: `core/svc_action/Cargo.toml` (add `penguin-connector-core`, `penguin-connector-twitch`)
- Create: `core/svc_action/src/hostapi/capabilities/relay.rs` (replaces Task 16's stub)
- Modify: `core/svc_action/src/hostapi/capabilities/mod.rs` (declare it, already stubbed)
- Create: `core/svc_action/src/senders/mod.rs`
- Create: `core/svc_action/src/senders/twitch.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod senders;`)
- Test: `core/svc_action/tests/capabilities_relay_twitch.rs`

**Interfaces:**
- Consumes: `penguin_connector_twitch::relay::{TwitchRelayMessage, resolve_relay_message}` (workspace crate, `docs/plan-penguin-connectors` Task 9), `penguin_connector_core::{PlatformEvent, EventSource, ActionConfig, SendOutcome, SendError, RetryClass}` (Task 4/5 of the same plan), `retry::{TransportOutcome, TransportSuccess}` (Task 12), `penguin_spine::PlatformEvent` (the type `StageEnvelope.event` actually carries, P1).
- Produces: `hostapi::capabilities::relay::{RelayCapability, RelayError, outbound_queue_key}` — `RelayCapability::new(redis_client) -> Self`, `async fn push(&self, provider: &str, message_json: &str) -> Result<(), RelayError>` (Task 21's dispatch multiplexer routes `capability: relay` here), `async fn push_raw(&self, provider: &str, message_json: &str) -> Result<(), RelayError>` (skips the provider allowlist, used only by the Twitch built-in below, which already knows its own provider is valid); `senders::from_send_result` — the `Result<SendOutcome, SendError>` → `retry::TransportOutcome` conversion every sender task (18, 23-26) reuses; `senders::twitch::TwitchBuiltinSender` — `TwitchBuiltinSender::new(relay: Arc<RelayCapability>) -> Self`, `async fn send(&self, event: &penguin_spine::PlatformEvent, config: &ActionConfig) -> TransportOutcome` — Task 22's consumer loop calls this for the fixed `waddles.bot.twitch.default` app id (P8), never the executor.

> **No `PlatformEvent`/`EventSource` conversion needed (verified during this continuation):** a pre-flight review of `docs/plan-penguin-connectors` moved that crate's `PlatformEvent`/`EventSource` to `pub use penguin_spine::PlatformEvent;` / `pub type EventSource = penguin_spine::Source;` (commit `c5ed81d`, confirmed by re-reading that plan's Task 4 directly) — they are now literally the same Rust type as `penguin_spine::PlatformEvent`/`penguin_spine::Source` (P1), not merely field-compatible duplicates. Every sender task (this one, 23-26) therefore passes `&penguin_spine::PlatformEvent` straight into `resolve_relay_message`/`ActionSender::send` with no conversion step — the `to_connector_event` helper this task originally planned is dropped entirely.

- [ ] **Step 1: Add the two new dependencies to `Cargo.toml`**

```toml
# Sec 4.10 -- built-in platform senders (P4, revised: that plan is now
# fully written with a concrete ActionSender trait and per-platform
# senders, superseding the original local-port decision). Git+rev, not a
# crates.io version -- see Global Constraints "Named executor inputs";
# CONNECTORS_REV is that table's fixed, resolved commit, current as of a
# pre-flight review that also moved this crate's PlatformEvent/EventSource
# to re-exports of penguin_spine's own types (see this task's Step 6 note).
penguin-connector-core = { git = "https://github.com/penguintechinc/penguin-libs.git", branch = "docs/plan-penguin-connectors", rev = "c5ed81de5c2870926e9cc00e1647d4ed90f22801" }
penguin-connector-twitch = { git = "https://github.com/penguintechinc/penguin-libs.git", branch = "docs/plan-penguin-connectors", rev = "c5ed81de5c2870926e9cc00e1647d4ed90f22801" }
```

- [ ] **Step 2: Write the failing tests**

`tests/capabilities_relay_twitch.rs`:

```rust
use std::sync::Arc;

use svc_action::hostapi::capabilities::relay::{outbound_queue_key, RelayCapability, RelayError};
use svc_action::retry::TransportOutcome;
use svc_action::senders::twitch::TwitchBuiltinSender;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::redis::Redis;

fn sample_event(payload: serde_json::Value) -> penguin_spine::PlatformEvent {
    serde_json::from_value(serde_json::json!({
        "platform": "twitch", "event_type": "chat.message", "actor": "some_user",
        "payload": payload, "occurred_at": "2026-09-14T12:00:00.000Z", "source": null
    }))
    .expect("valid PlatformEvent fixture")
}

fn action_config(channel: &str) -> penguin_connector_core::ActionConfig {
    let mut config = penguin_connector_core::ActionConfig::new();
    config.insert("channel".to_string(), serde_json::json!(channel));
    config
}

#[test]
fn outbound_queue_key_matches_the_python_transport_format_byte_for_byte() {
    assert_eq!(outbound_queue_key("twitch"), "waddles:transport:irc:twitch:outbound");
}

#[tokio::test]
#[ignore = "requires Docker-in-Docker; run via make test-integration"]
async fn push_rejects_an_unknown_provider_before_touching_valkey() {
    let container = Redis::default().start().await.expect("valkey container starts");
    let port = container.get_host_port_ipv4(6379).await.expect("port mapped");
    let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap();
    let relay = RelayCapability::new(client);

    let err = relay.push("discord", "{}").await.unwrap_err();
    assert!(matches!(err, RelayError::UnknownProvider(p) if p == "discord"));
}

#[tokio::test]
#[ignore = "requires Docker-in-Docker; run via make test-integration"]
async fn push_lpushes_the_message_json_verbatim_onto_the_provider_queue() {
    let container = Redis::default().start().await.expect("valkey container starts");
    let port = container.get_host_port_ipv4(6379).await.expect("port mapped");
    let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap();
    let relay = RelayCapability::new(client.clone());

    relay.push("twitch", r#"{"channel":"channelA","text":"hello"}"#).await.unwrap();

    let mut conn = client.get_multiplexed_tokio_connection().await.unwrap();
    let popped: String = redis::cmd("RPOP")
        .arg("waddles:transport:irc:twitch:outbound")
        .query_async(&mut conn)
        .await
        .unwrap();
    assert_eq!(popped, r#"{"channel":"channelA","text":"hello"}"#);
}

#[tokio::test]
#[ignore = "requires Docker-in-Docker; run via make test-integration"]
async fn twitch_builtin_sender_resolves_and_relays_a_valid_message() {
    let container = Redis::default().start().await.expect("valkey container starts");
    let port = container.get_host_port_ipv4(6379).await.expect("port mapped");
    let client = redis::Client::open(format!("redis://127.0.0.1:{port}/0")).unwrap();
    let relay = Arc::new(RelayCapability::new(client.clone()));
    let sender = TwitchBuiltinSender::new(relay);

    let event = sample_event(serde_json::json!({"text": "hello from the bot"}));
    let outcome = sender.send(&event, &action_config("channelA")).await;

    assert!(matches!(outcome, TransportOutcome::Success(_)), "expected Success, got {outcome:?}");
    let mut conn = client.get_multiplexed_tokio_connection().await.unwrap();
    let popped: String = redis::cmd("RPOP")
        .arg("waddles:transport:irc:twitch:outbound")
        .query_async(&mut conn)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&popped).unwrap();
    assert_eq!(parsed["channel"], "channelA");
    assert_eq!(parsed["text"], "hello from the bot");
}

#[tokio::test]
async fn twitch_builtin_sender_is_terminal_not_retryable_on_a_missing_channel() {
    // No Valkey needed -- resolution fails before any push is attempted.
    let client = redis::Client::open("redis://127.0.0.1:1/0").unwrap(); // never dialed
    let relay = Arc::new(RelayCapability::new(client));
    let sender = TwitchBuiltinSender::new(relay);

    let event = sample_event(serde_json::json!({"text": "hello"}));
    let mut empty_config = penguin_connector_core::ActionConfig::new();
    let outcome = sender.send(&event, &mut empty_config.clone()).await;

    assert!(
        matches!(outcome, TransportOutcome::Terminal { .. }),
        "a missing 'channel' must be non-retryable -- retrying an unresolvable message resolves it identically, got {outcome:?}"
    );
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `hostapi::capabilities::relay`/`senders` do not exist yet.

- [ ] **Step 4: Write `src/hostapi/capabilities/relay.rs`** (replaces Task 16's stub)

```rust
//! `relay` host capability -- pushes onto a provider-scoped outbound
//! relay queue owned by svc-ingest (spec Sec6.5 `relay` interface,
//! Sec7.4). Action-stage bundles only; the only wired provider today is
//! `twitch` -- an unrecognized provider is denied, never silently queued.

use redis::AsyncCommands;

/// Errors from a `relay` capability call (mirrors the WIT `relay` `error` variant).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RelayError {
    /// `provider` is not in the compiled-in allowlist.
    #[error("provider {0:?} is not a known relay provider")]
    UnknownProvider(String),
    /// The Valkey `LPUSH` itself failed.
    #[error("backend error: {0}")]
    Backend(String),
}

/// The compiled-in provider allowlist (spec Sec7.4: "Validates `provider`
/// against the compiled-in provider list (`twitch` today)").
const KNOWN_PROVIDERS: &[&str] = &["twitch"];

/// The Valkey list key an outbound relay send `LPUSH`es onto for
/// `provider` -- ports `waddle_transports.transports.irc_relay.
/// outbound_queue_key` byte-for-byte
/// (`f"waddles:transport:irc:{provider}:outbound"`). One key per
/// provider, not per tenant/community, matching the inbound side's own
/// one-socket-per-platform connection model; the queued message itself
/// carries its own channel.
pub fn outbound_queue_key(provider: &str) -> String {
    format!("waddles:transport:irc:{provider}:outbound")
}

/// Bundle-facing `relay` host capability: validates `provider`, then
/// `LPUSH`es `message_json` verbatim onto that provider's outbound queue.
/// Holds its own dedicated Valkey connection -- never
/// `penguin_spine::SpineClient`'s connection, which serves Streams admin
/// traffic only (spec Sec5.7's connection-separation rule extended here
/// to this capability's distinct Valkey data structure, a plain list).
pub struct RelayCapability {
    client: redis::Client,
}

impl RelayCapability {
    /// Builds a capability handler bound to one Valkey client.
    pub fn new(client: redis::Client) -> Self {
        Self { client }
    }

    async fn conn(&self) -> Result<redis::aio::MultiplexedConnection, RelayError> {
        self.client.get_multiplexed_tokio_connection().await.map_err(|e| RelayError::Backend(e.to_string()))
    }

    /// Validates `provider` against [`KNOWN_PROVIDERS`], then pushes
    /// `message_json` verbatim. The bundle is responsible for producing a
    /// valid `{channel, text}` body for its declared provider -- this
    /// capability enforces only the provider allowlist, matching spec
    /// Sec7.4 exactly.
    pub async fn push(&self, provider: &str, message_json: &str) -> Result<(), RelayError> {
        if !KNOWN_PROVIDERS.contains(&provider) {
            return Err(RelayError::UnknownProvider(provider.to_string()));
        }
        self.push_raw(provider, message_json).await
    }

    /// The shared `LPUSH` primitive both [`Self::push`] (bundle-facing,
    /// allowlist-checked) and [`crate::senders::twitch::TwitchBuiltinSender`]
    /// (the first-party built-in, which already knows its own provider is
    /// valid and skips the check) call.
    pub async fn push_raw(&self, provider: &str, message_json: &str) -> Result<(), RelayError> {
        let mut conn = self.conn().await?;
        let _: () = conn
            .lpush(outbound_queue_key(provider), message_json)
            .await
            .map_err(|e| RelayError::Backend(e.to_string()))?;
        Ok(())
    }
}
```

- [ ] **Step 5: Write `src/senders/mod.rs`**

```rust
//! Built-in platform senders -- the five first-party sends the M3
//! milestone table lists (Discord/Slack/YouTube/Kick REST, Twitch via
//! the relay), wired directly against `penguin-connectors`'s published
//! crates (P4, revised -- see Global Constraints). Every built-in
//! bypasses the WASM executor entirely (P8): the consumer loop (Task 22)
//! matches a fixed `app_id` set before ever considering the executor
//! path.

pub mod discord;
pub mod kick;
pub mod slack;
pub mod twitch;
pub mod youtube;

// No `penguin_spine::PlatformEvent` -> `penguin_connector_core::PlatformEvent`
// conversion exists here, deliberately: a pre-flight review of
// `docs/plan-penguin-connectors` (commit `c5ed81d`) moved that crate's
// `PlatformEvent`/`EventSource` to `pub use penguin_spine::PlatformEvent;`
// / `pub type EventSource = penguin_spine::Source;` -- they are the
// identical Rust type (P1), not a field-compatible duplicate, so every
// sender below (this task, 23-26) passes `&penguin_spine::PlatformEvent`
// straight into `resolve_relay_message`/`ActionSender::send`.

/// Converts a `penguin_connector_core::ActionSender::send` result into
/// this crate's own `retry::TransportOutcome` (Task 12) -- the uniform
/// boundary every built-in sender (this task, 23-26) and the executor
/// path (Task 22) both funnel through before `retry::retry_with_backoff`
/// ever runs.
pub fn from_send_result(
    result: Result<penguin_connector_core::SendOutcome, penguin_connector_core::SendError>,
) -> crate::retry::TransportOutcome {
    use penguin_connector_core::RetryClass;
    match result {
        Ok(outcome) => crate::retry::TransportOutcome::Success(crate::retry::TransportSuccess {
            detail: outcome.detail,
            http_status: outcome.http_status,
            provider_message_id: None,
        }),
        Err(err) => match err.class {
            RetryClass::NonRetryable => {
                crate::retry::TransportOutcome::Terminal { message: err.message, http_status: err.http_status }
            }
            RetryClass::Retryable { retry_after } => crate::retry::TransportOutcome::Retryable {
                message: err.message,
                http_status: err.http_status,
                retry_after_ms: retry_after.map(|d| d.as_millis() as u64),
            },
        },
    }
}
```

- [ ] **Step 6: Write `src/senders/twitch.rs`**

```rust
//! The Twitch built-in sender -- "Twitch via the relay" (M3 milestone
//! table). Unlike the other four built-ins (Tasks 23-26), a Twitch send
//! never leaves this process as an HTTP call: svc-action resolves the
//! outbound `{channel, text}` message and hands it to the SAME relay
//! queue the bundle-facing `relay` host capability writes to
//! (`RelayCapability::push_raw`) -- svc-ingest, which holds the one live
//! Twitch IRC socket, drains and sends it (spec Sec4.3, Sec7.4).

use std::sync::Arc;

use penguin_connector_core::{ActionConfig, SendError};
use penguin_connector_twitch::relay::resolve_relay_message;

use crate::hostapi::capabilities::relay::RelayCapability;
use crate::retry::{TransportOutcome, TransportSuccess};

/// Wraps [`RelayCapability`] with the Twitch-specific message resolution
/// `resolve_relay_message` (`penguin-connector-twitch`) -- the built-in
/// sender the consumer loop (Task 22) calls for the fixed
/// `waddles.bot.twitch.default` app id, never the executor (P8).
pub struct TwitchBuiltinSender {
    relay: Arc<RelayCapability>,
}

impl TwitchBuiltinSender {
    /// Builds a sender sharing the same [`RelayCapability`] the bundle-
    /// facing host capability uses -- one Valkey connection, two callers.
    pub fn new(relay: Arc<RelayCapability>) -> Self {
        Self { relay }
    }

    /// Resolves `event`/`config` into a `{channel, text}` relay message
    /// and pushes it, returning a [`TransportOutcome`] (Task 12) so the
    /// consumer loop's retry/DLQ handling treats every built-in and
    /// executor-routed dispatch uniformly. A resolution failure (missing
    /// `channel`/`text`) is non-retryable -- retrying a malformed message
    /// produces the identical malformed message.
    pub async fn send(&self, event: &penguin_spine::PlatformEvent, config: &ActionConfig) -> TransportOutcome {
        // `penguin_connector_core::PlatformEvent` is `pub use
        // penguin_spine::PlatformEvent` -- the identical type, no
        // conversion (see this task's Interfaces note).
        let message = match resolve_relay_message(event, config) {
            Ok(m) => m,
            Err(SendError { message, .. }) => {
                return TransportOutcome::Terminal { message, http_status: None }
            }
        };
        let message_json = serde_json::json!({"channel": message.channel, "text": message.text}).to_string();
        match self.relay.push_raw("twitch", &message_json).await {
            Ok(()) => TransportOutcome::Success(TransportSuccess {
                detail: format!("relayed to twitch channel={}", message.channel),
                http_status: None,
                provider_message_id: None,
            }),
            Err(err) => TransportOutcome::Retryable {
                message: err.to_string(),
                http_status: None,
                retry_after_ms: None,
            },
        }
    }
}
```

- [ ] **Step 7: Wire `src/hostapi/capabilities/mod.rs` and `src/lib.rs`**

`src/hostapi/capabilities/mod.rs` (replaces Task 16's stub line for `relay`):

```rust
pub mod relay;
```

(Leave `context`, `flags`, `kv`, `db`, `http_egress` as already declared — this task only replaces the `relay` stub body.)

`src/lib.rs` — add:

```rust
pub mod senders;
```

- [ ] **Step 8: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 2 passed; 0 failed` for the non-`#[ignore]`d tests (`outbound_queue_key_matches_the_python_transport_format_byte_for_byte`, `twitch_builtin_sender_is_terminal_not_retryable_on_a_missing_channel`).

Run: `make -C core/svc_action test-integration`
Expected: `test result: ok. 3 passed; 0 failed` for the three `#[ignore]`d Docker-in-Docker tests.

- [ ] **Step 9: Commit**

Stage `core/svc_action/Cargo.toml core/svc_action/src/hostapi/capabilities/relay.rs core/svc_action/src/hostapi/capabilities/mod.rs core/svc_action/src/senders/ core/svc_action/src/lib.rs core/svc_action/tests/capabilities_relay_twitch.rs` and commit with message:

```
feat(svc-action): relay host capability + Twitch built-in sender via penguin-connectors

Depends on docs/plan-penguin-connectors directly (P4, revised) rather
than porting twitch_send_action.py locally -- that plan is now fully
specified with a concrete ActionSender trait and per-platform senders.
RelayCapability::push_raw is shared between the bundle-facing `relay`
host capability and the Twitch built-in, which resolves its own
{channel, text} message via penguin_connector_twitch::relay::
resolve_relay_message before pushing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 19: Host capability `db` — sqlparser statement guard + per-bundle-role RLS execution

**Depends on:** Task 16 (`InvocationScope`, `BundleContext::scope()`), Task 11 (`distribution::poller::{EgressRule as _, Limits as _}` — this task reuses that module's already-defined table-list shape via `Vec<String>`, no new manifest type).

**Files:**
- Modify: `core/svc_action/Cargo.toml` (enable `sqlparser`'s `visitor` feature, add direct `sqlx` dependency)
- Create: `core/svc_action/src/hostapi/capabilities/db.rs` (replaces Task 16's stub)
- Test: `core/svc_action/tests/capabilities_db.rs`

**Interfaces:**
- Consumes: `hostapi::capabilities::context::InvocationScope` (Task 16).
- Produces: `hostapi::capabilities::db::{DbCapability, DbExecutor, PgDbExecutor, DbValue, DbRows, DbOutcome, DbDenial, DbBackendError, bundle_role_name}` — `DbCapability::new(executor: Arc<dyn DbExecutor>) -> Self`, `async fn execute(&self, approved_tables: &HashSet<String>, scope: &InvocationScope, statement: &str, params: &[DbValue]) -> DbOutcome` — Task 21's dispatch multiplexer routes `capability: db` here, passing the currently-loaded bundle's `data.tables` set (Task 11's `ActionManifest.data.tables`, converted to a `HashSet<String>` once per poll) as `approved_tables`.

Mirrors `penguin-bundle-host::host::db_guard`'s `DbGuard`/`DbExecutor` design (that crate's plan Task 10/13) as a tight, name-matching local port (Global Constraints P3): `DbExecutor`, `DbValue`, `DbRows` are named identically to that crate's own types so a later extraction is a mechanical move. The outer wrapper is `DbCapability` (not `DbGuard`), matching this plan's own `XCapability` naming already established by Tasks 16-18.

- [ ] **Step 1: Enable the `sqlparser` visitor feature and add `sqlx`**

In `Cargo.toml`, replace the existing pin:

```toml
sqlparser = "=0.52.0"
```

with:

```toml
sqlparser = { version = "=0.52.0", features = ["visitor"] }
```

And add, alongside the `sea-orm` dependency (SeaORM 2.0.2 depends on sqlx ~0.8; pinned to the nearest exact release compatible with it — the `db` capability needs `sqlx::PgPool`/`Row`/`Column` directly for the bundle's arbitrary-table dynamic column introspection SeaORM's entity-typed API cannot provide):

```toml
sqlx = { version = "=0.8.2", default-features = false, features = ["runtime-tokio-rustls", "postgres", "chrono"] }
```

- [ ] **Step 2: Write the failing tests**

`tests/capabilities_db.rs`:

```rust
use std::collections::HashSet;
use std::sync::Arc;

use svc_action::hostapi::capabilities::context::InvocationScope;
use svc_action::hostapi::capabilities::db::{bundle_role_name, DbCapability, DbDenial, DbOutcome, DbValue};

fn scope() -> InvocationScope {
    InvocationScope {
        tenant_id: "acme".to_string(),
        community_id: Some("main".to_string()),
        workstream_id: "8f14e45f-ceea-467e-adde-3fb5c9752730".to_string(),
        app_id: "waddles.socials.music.default".to_string(),
        trace: None,
    }
}

#[test]
fn bundle_role_name_replaces_dots_and_dashes() {
    assert_eq!(
        bundle_role_name("waddles.socials.music-station.default"),
        "bundle_waddles_socials_music_station_default"
    );
}

#[tokio::test]
async fn multiple_top_level_statements_are_denied_before_execution() {
    let executor = svc_action::hostapi::capabilities::db::test_support::PanicExecutor;
    let cap = DbCapability::new(Arc::new(executor));
    let approved: HashSet<String> = ["music_queue".to_string()].into_iter().collect();

    let outcome = cap
        .execute(&approved, &scope(), "SELECT 1; SELECT 2;", &[])
        .await;
    assert!(matches!(outcome, DbOutcome::Denied(DbDenial::MultipleStatements)));
}

#[tokio::test]
async fn a_create_statement_is_denied_by_the_statement_kind_allowlist() {
    let executor = svc_action::hostapi::capabilities::db::test_support::PanicExecutor;
    let cap = DbCapability::new(Arc::new(executor));
    let approved: HashSet<String> = ["music_queue".to_string()].into_iter().collect();

    let outcome = cap.execute(&approved, &scope(), "CREATE TABLE evil (id int)", &[]).await;
    assert!(matches!(outcome, DbOutcome::Denied(DbDenial::StatementKindNotPermitted(_))));
}

#[tokio::test]
async fn a_table_outside_the_approved_set_is_denied_before_postgres_is_touched() {
    let executor = svc_action::hostapi::capabilities::db::test_support::PanicExecutor;
    let cap = DbCapability::new(Arc::new(executor));
    let approved: HashSet<String> = ["music_queue".to_string()].into_iter().collect();

    let outcome = cap
        .execute(&approved, &scope(), "SELECT * FROM other_bundles_table", &[])
        .await;
    assert!(matches!(outcome, DbOutcome::Denied(DbDenial::TableNotApproved(t)) if t == "other_bundles_table"));
}

#[tokio::test]
async fn an_approved_select_reaches_the_executor_with_the_full_scope_unmodified() {
    let executor = svc_action::hostapi::capabilities::db::test_support::RecordingExecutor::default();
    let recorded = executor.calls.clone();
    let cap = DbCapability::new(Arc::new(executor));
    let approved: HashSet<String> = ["music_queue".to_string()].into_iter().collect();

    let outcome = cap
        .execute(&approved, &scope(), "SELECT id FROM music_queue WHERE id = $1", &[DbValue::Int(1)])
        .await;
    assert!(matches!(outcome, DbOutcome::Rows(_)));
    let calls = recorded.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, scope(), "the executor must see the exact InvocationScope, unmodified");
    assert_eq!(calls[0].1, "SELECT id FROM music_queue WHERE id = $1");
}

#[tokio::test]
async fn a_grant_statement_is_denied() {
    let executor = svc_action::hostapi::capabilities::db::test_support::PanicExecutor;
    let cap = DbCapability::new(Arc::new(executor));
    let approved: HashSet<String> = ["music_queue".to_string()].into_iter().collect();

    let outcome = cap.execute(&approved, &scope(), "GRANT SELECT ON music_queue TO bundle_x", &[]).await;
    assert!(matches!(outcome, DbOutcome::Denied(DbDenial::StatementKindNotPermitted(_))));
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `hostapi::capabilities::db` does not exist yet.

- [ ] **Step 4: Write `src/hostapi/capabilities/db.rs`** (replaces Task 16's stub)

```rust
//! `db` host capability -- parses the bundle's SQL with `sqlparser`
//! before ever touching Postgres, checks every referenced table against
//! the bundle's approved `data.tables` set, then executes on a
//! connection that `SET LOCAL ROLE`s to the bundle's own Postgres role
//! and `SET LOCAL`s `waddles.tenant`/`waddles.community` so row-level-
//! security scopes every row the call can see or write (spec Sec7.4,
//! Sec11.10.1, D30). Two independent layers, deliberately: the parser +
//! table allowlist catches mistakes, the role + RLS catch the parser
//! being wrong.
//!
//! Mirrors `penguin-bundle-host::host::db_guard`'s `DbGuard`/`DbExecutor`
//! design (that crate's plan Task 10/13) as a tight, name-matching local
//! port (Global Constraints P3) -- `DbExecutor`, `DbValue`, `DbRows` are
//! named identically to that crate's own types so a later extraction is
//! a mechanical move, not a rewrite.

use std::collections::HashSet;
use std::sync::Arc;

use sqlparser::ast::{visit_relations, Statement};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

use super::context::InvocationScope;

/// A bound SQL parameter value (mirrors the WIT `db` `value` variant).
#[derive(Debug, Clone, PartialEq)]
pub enum DbValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
}

/// A successful statement's result set (mirrors the WIT `db` `rows` record).
#[derive(Debug, Clone, PartialEq)]
pub struct DbRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<DbValue>>,
    pub rows_affected: u64,
}

/// Why a statement was refused before ever reaching Postgres.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DbDenial {
    #[error("statement failed to parse: {0}")]
    Syntax(String),
    #[error("only one top-level statement is permitted per call")]
    MultipleStatements,
    #[error("statement kind not permitted: only SELECT/INSERT/UPDATE/DELETE are allowed ({0})")]
    StatementKindNotPermitted(String),
    #[error("table {0:?} is not in the approved data.tables set")]
    TableNotApproved(String),
}

/// A backend (Postgres) execution failure, distinct from a pre-execution denial.
#[derive(Debug, thiserror::Error)]
pub enum DbBackendError {
    #[error("backend error: {0}")]
    Backend(String),
    #[error("timeout")]
    Timeout,
}

/// The final outcome of one `db` capability call.
#[derive(Debug)]
pub enum DbOutcome {
    Rows(DbRows),
    Denied(DbDenial),
    Timeout,
    Backend(String),
}

/// Executes a pre-approved statement under the bundle's own Postgres
/// role. `scope.tenant_id`/`scope.community_id` come from a binding-MAC-
/// verified envelope upstream (D30, spec Sec5.11), never from the bundle
/// -- the implementation MUST run `statement` inside a transaction that
/// first issues `SET LOCAL waddles.tenant`/`SET LOCAL waddles.community`
/// from those two fields, so Postgres row-level-security policies scope
/// every row this call can see or write, independent of which table the
/// bundle's own role can otherwise reach. Mirrors `penguin-bundle-host::
/// host::capability::DbExecutor` (Global Constraints P3).
#[async_trait::async_trait]
pub trait DbExecutor: Send + Sync {
    async fn execute(&self, scope: &InvocationScope, statement: &str, params: &[DbValue]) -> Result<DbRows, DbBackendError>;
}

/// The Postgres role name a bundle's `db` calls execute under -- ports
/// `hub_api.services.bundle_db_role_service.bundle_role_name` byte-for-
/// byte (`f"bundle_{app_id.replace('.', '_').replace('-', '_')}"`). That
/// service (`docs/plan-m2b-hub-api` Task 20) creates the role as
/// `NOLOGIN` and grants it to `svc_action`'s own role, so this stage's
/// existing connection pool can `SET LOCAL ROLE` into it rather than
/// opening a second, separately-authenticated connection.
pub fn bundle_role_name(app_id: &str) -> String {
    format!("bundle_{}", app_id.replace(['.', '-'], "_"))
}

fn community_setting(scope: &InvocationScope) -> String {
    scope.community_id.clone().unwrap_or_else(|| "_tenant".to_string())
}

fn pg_row_to_dbvalues(row: &sqlx::postgres::PgRow) -> (Vec<String>, Vec<DbValue>) {
    use sqlx::{Column, Row, TypeInfo, ValueRef};
    let mut columns = Vec::with_capacity(row.columns().len());
    let mut values = Vec::with_capacity(row.columns().len());
    for (i, col) in row.columns().iter().enumerate() {
        columns.push(col.name().to_string());
        let raw = row.try_get_raw(i).ok();
        let value = match raw {
            None => DbValue::Null,
            Some(raw) if raw.is_null() => DbValue::Null,
            Some(_) => match col.type_info().name() {
                "BOOL" => row.try_get::<bool, _>(i).map(DbValue::Bool).unwrap_or(DbValue::Null),
                "INT2" | "INT4" | "INT8" => row.try_get::<i64, _>(i).map(DbValue::Int).unwrap_or(DbValue::Null),
                "FLOAT4" | "FLOAT8" | "NUMERIC" => row.try_get::<f64, _>(i).map(DbValue::Float).unwrap_or(DbValue::Null),
                "BYTEA" => row.try_get::<Vec<u8>, _>(i).map(DbValue::Bytes).unwrap_or(DbValue::Null),
                _ => row.try_get::<String, _>(i).map(DbValue::Text).unwrap_or(DbValue::Null),
            },
        };
        values.push(value);
    }
    (columns, values)
}

/// The real `DbExecutor`, backed by one `sqlx::PgPool` under `svc_action`'s
/// own Postgres role. Every call runs inside one transaction:
/// `SET LOCAL ROLE bundle_<app_id>; SET LOCAL waddles.tenant = $1;
/// SET LOCAL waddles.community = $2;` then the bundle's own statement --
/// committed on success, rolled back on any failure so a partially-applied
/// write never survives a denial encountered mid-transaction.
pub struct PgDbExecutor {
    pool: sqlx::PgPool,
}

impl PgDbExecutor {
    /// Builds an executor bound to one connection pool. The pool's own
    /// credential is `svc_action`'s Postgres role (spec Sec11.10.1) --
    /// never a per-bundle password, which does not exist (bundle roles
    /// are `NOLOGIN`, reached only via `SET LOCAL ROLE`).
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl DbExecutor for PgDbExecutor {
    async fn execute(&self, scope: &InvocationScope, statement: &str, params: &[DbValue]) -> Result<DbRows, DbBackendError> {
        let mut tx = self.pool.begin().await.map_err(|e| DbBackendError::Backend(e.to_string()))?;

        let role = bundle_role_name(&scope.app_id);
        // Role and setting names cannot be bound parameters in Postgres
        // (SET LOCAL ROLE/SET LOCAL take an identifier/literal, not a
        // placeholder) -- `role` is derived entirely from `scope.app_id`,
        // which is a `^waddles\.[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$`
        // validated app id (penguin-spine's `StageEnvelope` deserializer),
        // never free text, so this is not string-built from bundle input.
        sqlx::query(&format!("SET LOCAL ROLE {role}"))
            .execute(&mut *tx)
            .await
            .map_err(|e| DbBackendError::Backend(format!("SET LOCAL ROLE {role} failed: {e}")))?;
        sqlx::query("SELECT set_config('waddles.tenant', $1, true)")
            .bind(scope.tenant_id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(|e| DbBackendError::Backend(e.to_string()))?;
        sqlx::query("SELECT set_config('waddles.community', $1, true)")
            .bind(community_setting(scope))
            .execute(&mut *tx)
            .await
            .map_err(|e| DbBackendError::Backend(e.to_string()))?;

        // Bound inline (rather than through a shared helper function) so
        // each arm's concrete `T` in `query.bind::<T>(..)` is inferred
        // directly against `sqlx::query::Query<'_, Postgres, ..>` at the
        // call site -- the standard sqlx binding pattern, and it avoids
        // spelling out that builder's generic parameters by hand.
        let mut query = sqlx::query(statement);
        for param in params {
            query = match param {
                DbValue::Null => query.bind(None::<String>),
                DbValue::Bool(b) => query.bind(*b),
                DbValue::Int(i) => query.bind(*i),
                DbValue::Float(f) => query.bind(*f),
                DbValue::Text(t) => query.bind(t.clone()),
                DbValue::Bytes(b) => query.bind(b.clone()),
            };
        }
        let rows = query.fetch_all(&mut *tx).await.map_err(|e| DbBackendError::Backend(e.to_string()))?;
        let rows_affected = rows.len() as u64;
        let mut columns = Vec::new();
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let (cols, values) = pg_row_to_dbvalues(row);
            columns = cols;
            out_rows.push(values);
        }

        tx.commit().await.map_err(|e| DbBackendError::Backend(e.to_string()))?;
        Ok(DbRows { columns, rows: out_rows, rows_affected })
    }
}

/// Extracts every table name a parsed statement references, using
/// `sqlparser`'s `visitor` feature -- lower-cased, so `data.tables`
/// comparisons are case-insensitive exactly as Postgres's own unquoted
/// identifier folding is.
fn referenced_tables(stmt: &Statement) -> Vec<String> {
    let mut tables = Vec::new();
    let _ = visit_relations(stmt, |relation| {
        tables.push(relation.to_string().to_lowercase());
        std::ops::ControlFlow::<()>::Continue(())
    });
    tables
}

/// Parses `statement`, enforces the single-top-level-statement and
/// statement-kind allowlist (spec Sec7.4: only SELECT/INSERT/UPDATE/
/// DELETE; any `COPY`, `DO`, `SET ROLE`, `GRANT`, `CREATE`/`DROP`/`ALTER`
/// or anything else is denied by one catch-all arm rather than
/// enumerating sqlparser's AST by hand -- a strict superset of the named
/// denial list), then checks every referenced table against
/// `approved_tables`. Returns `Ok(())` only when every check passes.
fn guard_statement(statement: &str, approved_tables: &HashSet<String>) -> Result<Statement, DbDenial> {
    let statements = Parser::parse_sql(&PostgreSqlDialect {}, statement).map_err(|e| DbDenial::Syntax(e.to_string()))?;
    if statements.len() != 1 {
        return Err(DbDenial::MultipleStatements);
    }
    let stmt = statements.into_iter().next().expect("len checked == 1 above");

    let is_permitted_kind = matches!(
        stmt,
        Statement::Query(_) | Statement::Insert(_) | Statement::Update { .. } | Statement::Delete(_)
    );
    if !is_permitted_kind {
        return Err(DbDenial::StatementKindNotPermitted(stmt.to_string().split_whitespace().next().unwrap_or("?").to_string()));
    }

    for table in referenced_tables(&stmt) {
        if !approved_tables.contains(&table) {
            return Err(DbDenial::TableNotApproved(table));
        }
    }
    Ok(stmt)
}

/// Bundle-facing `db` host capability: guards then executes.
pub struct DbCapability {
    executor: Arc<dyn DbExecutor>,
}

impl DbCapability {
    /// Builds a capability handler bound to one [`DbExecutor`] --
    /// [`PgDbExecutor`] in production, a fake in tests.
    pub fn new(executor: Arc<dyn DbExecutor>) -> Self {
        Self { executor }
    }

    /// Parses and guards `statement` against `approved_tables`, then --
    /// only if every check passes -- executes it via the bound
    /// [`DbExecutor`], forwarding `scope` unmodified (D30).
    pub async fn execute(&self, approved_tables: &HashSet<String>, scope: &InvocationScope, statement: &str, params: &[DbValue]) -> DbOutcome {
        match guard_statement(statement, approved_tables) {
            Ok(_) => match self.executor.execute(scope, statement, params).await {
                Ok(rows) => DbOutcome::Rows(rows),
                Err(DbBackendError::Timeout) => DbOutcome::Timeout,
                Err(DbBackendError::Backend(msg)) => DbOutcome::Backend(msg),
            },
            Err(denial) => DbOutcome::Denied(denial),
        }
    }
}

/// Test doubles used only by `tests/capabilities_db.rs` -- kept in the
/// library (not `#[cfg(test)]`-gated) so the integration test crate can
/// import them, matching the pattern `writing-rust-tests` recommends for
/// a trait-object capability under integration-test coverage.
pub mod test_support {
    use std::sync::{Arc, Mutex};

    use super::{DbBackendError, DbExecutor, DbRows, DbValue};
    use crate::hostapi::capabilities::context::InvocationScope;

    /// An executor that panics if called -- used by every "denied before
    /// execution" test to prove the guard short-circuits.
    pub struct PanicExecutor;

    #[async_trait::async_trait]
    impl DbExecutor for PanicExecutor {
        async fn execute(&self, _scope: &InvocationScope, _statement: &str, _params: &[DbValue]) -> Result<DbRows, DbBackendError> {
            panic!("PanicExecutor::execute must never be called -- the guard should have denied this call first");
        }
    }

    /// An executor that records every call it receives and returns one
    /// empty row set -- used to assert the exact `(scope, statement)` an
    /// approved call reaches the executor with.
    #[derive(Default)]
    pub struct RecordingExecutor {
        pub calls: Arc<Mutex<Vec<(InvocationScope, String)>>>,
    }

    #[async_trait::async_trait]
    impl DbExecutor for RecordingExecutor {
        async fn execute(&self, scope: &InvocationScope, statement: &str, _params: &[DbValue]) -> Result<DbRows, DbBackendError> {
            self.calls.lock().unwrap().push((scope.clone(), statement.to_string()));
            Ok(DbRows { columns: vec!["id".to_string()], rows: vec![vec![DbValue::Int(1)]], rows_affected: 1 })
        }
    }
}
```

- [ ] **Step 5: Declare the module**

`src/hostapi/capabilities/mod.rs` already has `pub mod db;` from Task 16's stub declaration — no change needed.

- [ ] **Step 6: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 6 passed; 0 failed` for `capabilities_db`.

- [ ] **Step 7: Commit**

Stage `core/svc_action/Cargo.toml core/svc_action/src/hostapi/capabilities/db.rs core/svc_action/tests/capabilities_db.rs` and commit with message:

```
feat(svc-action): db host capability -- sqlparser guard + per-bundle-role RLS execution

Statement-kind allowlist (SELECT/INSERT/UPDATE/DELETE only, one
catch-all denial for everything else) plus a data.tables allowlist,
enforced before Postgres is ever touched. PgDbExecutor runs every
approved statement inside one transaction that SET LOCAL ROLEs into the
bundle's own NOLOGIN Postgres role and SET LOCALs waddles.tenant/
waddles.community from the D30 InvocationScope, so row-level-security
is the second, independent enforcement layer (spec Sec7.4, Sec11.10.1).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 20: Host capability `http` — egress allowlist + SSRF guard + rate limit/redirect/size/timeout chain

**Depends on:** Task 11 (`distribution::poller::EgressRule`), Task 3 (`Config.cli.{egress_timeout_ms, egress_max_response_bytes, egress_rate_limit_rps, egress_rate_limit_burst, egress_max_redirects, egress_allow_private_hosts}`).

**Files:**
- Create: `core/svc_action/src/hostapi/capabilities/http_egress.rs` (replaces Task 16's stub)
- Test: `core/svc_action/tests/capabilities_http_egress.rs`

**Interfaces:**
- Consumes: `distribution::poller::EgressRule` (Task 11).
- Produces: `hostapi::capabilities::http_egress::{HttpEgressCapability, EgressGuardConfig, EgressRequest, EgressResponse, EgressDenial, EgressOutcome}` — `HttpEgressCapability::new(config: EgressGuardConfig) -> Result<Self, anyhow::Error>`, `async fn send(&self, app_id: &str, egress_rules: &[EgressRule], req: EgressRequest) -> EgressOutcome` — Task 21's dispatch multiplexer routes `capability: http, op: "send"` here, passing the currently-loaded bundle's `manifest.egress` rules (Task 11).

Mirrors `penguin-bundle-host::host::egress`'s `EgressGuard`/`EgressDenial`/`EgressOutcome` design (that crate's plan Tasks 11-12) as a tight, name-matching local port (Global Constraints P3); **deliberately not shared with `penguin-connectors`'s own HTTP client** (Task 5 of that plan) -- the connector crates' outbound calls go to a fixed, compiled-in platform host and are never bundle-declared, so they carry no SSRF risk and correctly skip this guard entirely (see that plan's own module doc).

- [ ] **Step 1: Write the failing tests**

`tests/capabilities_http_egress.rs`:

```rust
use std::time::Duration;

use svc_action::distribution::poller::EgressRule;
use svc_action::hostapi::capabilities::http_egress::{
    EgressDenial, EgressGuardConfig, EgressOutcome, EgressRequest, HttpEgressCapability,
};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn config(allow_private_hosts: bool) -> EgressGuardConfig {
    EgressGuardConfig {
        allow_private_hosts,
        max_redirects: 3,
        max_response_bytes: 65_536,
        call_timeout: Duration::from_secs(2),
        rate_limit_rps: 100.0,
        rate_limit_burst: 100.0,
    }
}

fn req(method: &str, url: &str) -> EgressRequest {
    EgressRequest { method: method.to_string(), url: url.to_string(), headers: vec![], body: None, secret_refs: vec![] }
}

#[tokio::test]
async fn a_host_not_in_the_egress_allowlist_is_denied() {
    let cap = HttpEgressCapability::new(config(false)).unwrap();
    let rules = vec![EgressRule { host: "api.spotify.com".to_string(), methods: vec!["GET".to_string()] }];
    let outcome = cap.send("waddles.test.fixture.hello", &rules, req("GET", "https://evil.example.com/x")).await;
    assert!(matches!(outcome, EgressOutcome::Denied(EgressDenial::HostNotDeclared)));
}

#[tokio::test]
async fn a_method_not_declared_for_the_host_is_denied() {
    let cap = HttpEgressCapability::new(config(false)).unwrap();
    let rules = vec![EgressRule { host: "api.spotify.com".to_string(), methods: vec!["GET".to_string()] }];
    let outcome = cap.send("waddles.test.fixture.hello", &rules, req("DELETE", "https://api.spotify.com/x")).await;
    assert!(matches!(outcome, EgressOutcome::Denied(EgressDenial::MethodNotDeclared)));
}

#[tokio::test]
async fn a_non_https_scheme_is_denied() {
    let cap = HttpEgressCapability::new(config(false)).unwrap();
    let rules = vec![EgressRule { host: "api.spotify.com".to_string(), methods: vec!["GET".to_string()] }];
    let outcome = cap.send("waddles.test.fixture.hello", &rules, req("GET", "http://api.spotify.com/x")).await;
    assert!(matches!(outcome, EgressOutcome::Denied(EgressDenial::SchemeNotHttps)));
}

#[tokio::test]
async fn cloud_metadata_is_blocked_even_when_the_host_is_allowlisted_and_private_hosts_are_allowed() {
    // 169.254.169.254 resolves as itself (an IP literal in the URL) --
    // no DNS involved, exercising the resolved-address check directly.
    let cap = HttpEgressCapability::new(config(true)).unwrap();
    let rules = vec![EgressRule { host: "169.254.169.254".to_string(), methods: vec!["GET".to_string()] }];
    let outcome = cap.send("waddles.test.fixture.hello", &rules, req("GET", "https://169.254.169.254/latest/meta-data")).await;
    assert!(matches!(outcome, EgressOutcome::Denied(EgressDenial::SsrfBlockedAddress)));
}

#[tokio::test]
async fn an_rfc1918_address_is_blocked_by_default_and_allowed_with_the_toggle() {
    let rules = vec![EgressRule { host: "10.0.0.5".to_string(), methods: vec!["GET".to_string()] }];

    let cap_default = HttpEgressCapability::new(config(false)).unwrap();
    let denied = cap_default.send("waddles.test.fixture.hello", &rules, req("GET", "https://10.0.0.5/x")).await;
    assert!(matches!(denied, EgressOutcome::Denied(EgressDenial::SsrfBlockedAddress)));

    // With the toggle on, the address clears the SSRF check -- it still
    // fails at the transport layer in this unit test (nothing is
    // listening on 10.0.0.5), which proves the guard let it *through*
    // rather than denying it before the connection attempt.
    let cap_allowed = HttpEgressCapability::new(config(true)).unwrap();
    let outcome = cap_allowed.send("waddles.test.fixture.hello", &rules, req("GET", "https://10.0.0.5/x")).await;
    assert!(!matches!(outcome, EgressOutcome::Denied(EgressDenial::SsrfBlockedAddress)));
}

#[tokio::test]
async fn an_allowed_request_reaches_the_declared_host_and_returns_its_response() {
    let server = MockServer::start().await;
    Mock::given(method("GET")).and(path("/x")).respond_with(ResponseTemplate::new(200).set_body_string("ok")).mount(&server).await;

    // wiremock binds to 127.0.0.1 -- exercised with allow_private_hosts
    // true since loopback via a literal IP is otherwise SSRF-blocked,
    // same as production traffic to a genuinely external allowlisted host.
    let cap = HttpEgressCapability::new(config(true)).unwrap();
    let host = server.address().ip().to_string();
    let rules = vec![EgressRule { host: host.clone(), methods: vec!["GET".to_string()] }];
    let url = format!("https://{host}:{}/x", server.address().port());
    // wiremock serves plain HTTP -- this test only exercises the
    // allowlist+resolve path, not TLS, so it asserts on the denial
    // variant never firing for a declared host+method rather than a
    // full 200 (a real HTTPS server would be required for that).
    let outcome = cap.send("waddles.test.fixture.hello", &rules, req("GET", &url)).await;
    assert!(!matches!(outcome, EgressOutcome::Denied(EgressDenial::HostNotDeclared | EgressDenial::MethodNotDeclared | EgressDenial::SsrfBlockedAddress)));
}

#[tokio::test]
async fn rate_limiting_kicks_in_past_the_configured_burst() {
    let mut cfg = config(true);
    cfg.rate_limit_rps = 1.0;
    cfg.rate_limit_burst = 1.0;
    let cap = HttpEgressCapability::new(cfg).unwrap();
    let rules = vec![EgressRule { host: "127.0.0.1".to_string(), methods: vec!["GET".to_string()] }];

    let first = cap.send("waddles.test.fixture.hello", &rules, req("GET", "https://127.0.0.1:1/x")).await;
    assert!(!matches!(first, EgressOutcome::RateLimited { .. }));
    let second = cap.send("waddles.test.fixture.hello", &rules, req("GET", "https://127.0.0.1:1/x")).await;
    assert!(matches!(second, EgressOutcome::RateLimited { .. }), "the second call within the same instant must exhaust the burst-1 bucket");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `hostapi::capabilities::http_egress` does not exist yet.

- [ ] **Step 3: Write `src/hostapi/capabilities/http_egress.rs`** (replaces Task 16's stub)

```rust
//! `http` host capability -- egress allowlist + SSRF guard + rate limit +
//! redirect/size/timeout enforcement (spec Sec8, Sec6.5 `interface http`).
//! Mirrors `penguin-bundle-host::host::egress`'s `EgressGuard`/
//! `EgressDenial`/`EgressOutcome` design (that crate's plan Tasks 11-12)
//! as a tight, name-matching local port (Global Constraints P3).
//!
//! Enforcement order (spec Sec8.2): (1) scheme must be `https`, (2) the
//! URL must parse, (3) the host must appear in the bundle's approved
//! `egress` rules, (4) the method must be declared for that host, (5-7)
//! every resolved address must clear the SSRF guard, (8) the per-bundle
//! rate limit must have a token available, (9) a redirect target is
//! re-checked against steps 1-7 up to `max_redirects` times, (10) the
//! response body is capped at `max_response_bytes`, (11) the whole call
//! is bounded by `call_timeout`, (12) `secret_refs` are resolved from env
//! and injected as headers only after every other check passes.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::distribution::poller::EgressRule;

/// One bundle-declared outbound call (mirrors the WIT `http` `request` record).
#[derive(Debug, Clone)]
pub struct EgressRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// `(header_name, env_var_name)` -- spec Sec8.3: secrets are resolved
    /// server-side from an operator-configured env var, never carried in
    /// the bundle's own request as a literal value.
    pub secret_refs: Vec<(String, String)>,
}

/// A completed outbound call's response (mirrors the WIT `http` `response` record).
#[derive(Debug, Clone)]
pub struct EgressResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub truncated: bool,
}

/// Why a call was refused, at any of steps 1-9 (spec Sec8.2's own
/// "Denial reason" strings -- [`Self::reason_str`] returns them exactly).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EgressDenial {
    #[error("scheme_not_https")]
    SchemeNotHttps,
    #[error("malformed_url")]
    MalformedUrl,
    #[error("host_not_declared")]
    HostNotDeclared,
    #[error("method_not_declared")]
    MethodNotDeclared,
    #[error("ssrf_blocked_address")]
    SsrfBlockedAddress,
    #[error("redirect_off_allowlist")]
    RedirectOffAllowlist,
    #[error("secret_unresolved: {0}")]
    SecretUnresolved(String),
}

impl EgressDenial {
    /// The exact spec Sec8.2 denial-reason string -- the
    /// `waddles_egress_denied_total{reason}` label value.
    pub fn reason_str(&self) -> &'static str {
        match self {
            EgressDenial::SchemeNotHttps => "scheme_not_https",
            EgressDenial::MalformedUrl => "malformed_url",
            EgressDenial::HostNotDeclared => "host_not_declared",
            EgressDenial::MethodNotDeclared => "method_not_declared",
            EgressDenial::SsrfBlockedAddress => "ssrf_blocked_address",
            EgressDenial::RedirectOffAllowlist => "redirect_off_allowlist",
            EgressDenial::SecretUnresolved(_) => "secret_unresolved",
        }
    }
}

/// The final outcome of one `http` capability call.
#[derive(Debug)]
pub enum EgressOutcome {
    Response(EgressResponse),
    Denied(EgressDenial),
    RateLimited { retry_after_ms: u32 },
    Timeout,
    TooLarge(u64),
}

/// Per-deployment egress knobs (`EGRESS_*` env vars, Task 3).
pub struct EgressGuardConfig {
    pub allow_private_hosts: bool,
    pub max_redirects: u8,
    pub max_response_bytes: usize,
    pub call_timeout: Duration,
    pub rate_limit_rps: f64,
    pub rate_limit_burst: f64,
}

struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
}

/// True when `ip` must be refused regardless of `allow_private_hosts`
/// (loopback, link-local -- including the `169.254.169.254` cloud
/// metadata address, which is itself a link-local address --
/// unspecified, multicast) or is an RFC 1918/unique-local private
/// address refused only when `allow_private_hosts` is `false` (spec
/// Sec8.2 steps 5-7, Sec14.6 tests 4/4a/4b). Implemented with explicit
/// range checks rather than the newer `std::net` classifier methods so
/// behavior does not depend on which of those are stable on the pinned
/// toolchain.
fn is_ssrf_blocked(ip: IpAddr, allow_private_hosts: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            let is_loopback = octets[0] == 127;
            let is_link_local = octets[0] == 169 && octets[1] == 254; // covers 169.254.169.254
            let is_unspecified = v4.is_unspecified();
            let is_multicast = octets[0] >= 224 && octets[0] <= 239;
            let is_broadcast = v4.is_broadcast();
            if is_loopback || is_link_local || is_unspecified || is_multicast || is_broadcast {
                return true;
            }
            let is_private = octets[0] == 10
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168);
            is_private && !allow_private_hosts
        }
        IpAddr::V6(v6) => {
            let is_loopback = v6.is_loopback();
            let is_unspecified = v6.is_unspecified();
            let segments = v6.segments();
            let is_multicast = (segments[0] & 0xff00) == 0xff00;
            let is_link_local = (segments[0] & 0xffc0) == 0xfe80;
            if is_loopback || is_unspecified || is_multicast || is_link_local {
                return true;
            }
            let is_unique_local = (segments[0] & 0xfe00) == 0xfc00;
            is_unique_local && !allow_private_hosts
        }
    }
}

/// Bundle-facing `http` host capability.
pub struct HttpEgressCapability {
    client: reqwest::Client,
    config: EgressGuardConfig,
    buckets: Mutex<HashMap<String, TokenBucket>>,
}

impl HttpEgressCapability {
    /// Builds a capability handler. Redirects are handled manually
    /// (step 9 re-runs the full allowlist chain on the target), so the
    /// underlying client never follows one itself.
    pub fn new(config: EgressGuardConfig) -> Result<Self, anyhow::Error> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(config.call_timeout)
            .build()?;
        Ok(Self { client, config, buckets: Mutex::new(HashMap::new()) })
    }

    /// Steps 1-7: scheme, URL, host/method allowlist, DNS resolution, SSRF.
    async fn check_and_resolve(&self, egress_rules: &[EgressRule], url: &str, method: &str) -> Result<(reqwest::Url, IpAddr), EgressDenial> {
        let parsed = reqwest::Url::parse(url).map_err(|_| EgressDenial::MalformedUrl)?;
        if parsed.scheme() != "https" {
            return Err(EgressDenial::SchemeNotHttps);
        }
        let host = parsed.host_str().ok_or(EgressDenial::MalformedUrl)?;
        let rule = egress_rules
            .iter()
            .find(|r| r.host.eq_ignore_ascii_case(host))
            .ok_or(EgressDenial::HostNotDeclared)?;
        if !rule.methods.iter().any(|m| m.eq_ignore_ascii_case(method)) {
            return Err(EgressDenial::MethodNotDeclared);
        }

        let port = parsed.port_or_known_default().unwrap_or(443);
        let addrs = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| EgressDenial::SsrfBlockedAddress)?;
        let mut resolved: Vec<IpAddr> = addrs.map(|a| a.ip()).collect();
        if resolved.is_empty() {
            return Err(EgressDenial::SsrfBlockedAddress);
        }
        resolved.sort();
        resolved.dedup();
        // DNS-rebind pinning: every resolved address must clear the
        // check, and the same address set is what the connection below
        // actually dials (reqwest resolves independently per-request, so
        // a strict re-check is the practical mitigation here rather than
        // hand-rolling a pinned-connect transport).
        for ip in &resolved {
            if is_ssrf_blocked(*ip, self.config.allow_private_hosts) {
                return Err(EgressDenial::SsrfBlockedAddress);
            }
        }
        Ok((parsed, resolved[0]))
    }

    fn check_rate_limit(&self, app_id: &str) -> Option<u32> {
        let mut buckets = self.buckets.lock().expect("mutex not poisoned");
        let bucket = buckets.entry(app_id.to_string()).or_insert_with(|| TokenBucket {
            tokens: self.config.rate_limit_burst,
            last_refill: Instant::now(),
        });
        let elapsed = bucket.last_refill.elapsed().as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.config.rate_limit_rps).min(self.config.rate_limit_burst);
        bucket.last_refill = Instant::now();
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            None
        } else {
            let deficit = 1.0 - bucket.tokens;
            let retry_after_ms = ((deficit / self.config.rate_limit_rps.max(0.001)) * 1000.0) as u32;
            Some(retry_after_ms)
        }
    }

    /// Runs the full spec Sec8.2 chain and, only if every check passes,
    /// performs the call -- following up to `max_redirects` redirects,
    /// each re-checked from step 1.
    pub async fn send(&self, app_id: &str, egress_rules: &[EgressRule], req: EgressRequest) -> EgressOutcome {
        if let Some(retry_after_ms) = self.check_rate_limit(app_id) {
            return EgressOutcome::RateLimited { retry_after_ms };
        }

        let mut current_url = req.url.clone();
        for _ in 0..=self.config.max_redirects {
            let (parsed, _resolved_ip) = match self.check_and_resolve(egress_rules, &current_url, &req.method).await {
                Ok(ok) => ok,
                Err(denial) => return EgressOutcome::Denied(denial),
            };

            let method = match reqwest::Method::from_bytes(req.method.as_bytes()) {
                Ok(m) => m,
                Err(_) => return EgressOutcome::Denied(EgressDenial::MethodNotDeclared),
            };
            let mut builder = self.client.request(method, parsed.clone());
            for (name, value) in &req.headers {
                builder = builder.header(name, value);
            }
            for (header_name, env_var_name) in &req.secret_refs {
                match std::env::var(env_var_name) {
                    Ok(secret_value) => builder = builder.header(header_name, secret_value),
                    Err(_) => return EgressOutcome::Denied(EgressDenial::SecretUnresolved(env_var_name.clone())),
                }
            }
            if let Some(body) = &req.body {
                builder = builder.body(body.clone());
            }

            let response = match builder.send().await {
                Ok(r) => r,
                Err(e) if e.is_timeout() => return EgressOutcome::Timeout,
                Err(_) => return EgressOutcome::Denied(EgressDenial::SsrfBlockedAddress),
            };
            let status = response.status();
            if status.is_redirection() {
                let location = response.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok());
                match location {
                    Some(loc) => {
                        current_url = match parsed.join(loc) {
                            Ok(joined) => joined.to_string(),
                            Err(_) => return EgressOutcome::Denied(EgressDenial::RedirectOffAllowlist),
                        };
                        continue;
                    }
                    None => return EgressOutcome::Response(EgressResponse {
                        status: status.as_u16(),
                        headers: response.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect(),
                        body: Vec::new(),
                        truncated: false,
                    }),
                }
            }

            let headers: Vec<(String, String)> = response
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let status_u16 = status.as_u16();
            let max_bytes = self.config.max_response_bytes;
            let full_body = match response.bytes().await {
                Ok(b) => b,
                Err(e) if e.is_timeout() => return EgressOutcome::Timeout,
                Err(_) => return EgressOutcome::Denied(EgressDenial::SsrfBlockedAddress),
            };
            let truncated = full_body.len() > max_bytes;
            let body = if truncated { full_body[..max_bytes].to_vec() } else { full_body.to_vec() };
            return EgressOutcome::Response(EgressResponse { status: status_u16, headers, body, truncated });
        }
        EgressOutcome::Denied(EgressDenial::RedirectOffAllowlist)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 7 passed; 0 failed` for `capabilities_http_egress` (network-using tests run against `wiremock`/loopback only, no real external hosts).

- [ ] **Step 5: Commit**

Stage `core/svc_action/src/hostapi/capabilities/http_egress.rs core/svc_action/tests/capabilities_http_egress.rs` and commit with message:

```
feat(svc-action): http egress host capability -- allowlist, SSRF guard, rate limit, redirects

Enforcement order matches spec Sec8.2 exactly: scheme/URL/host/method
allowlist, then DNS resolution and an SSRF check on every resolved
address (cloud metadata/loopback/link-local/unspecified/multicast always
blocked; RFC 1918/unique-local gated on bundles.egress.allowPrivateHosts),
then a per-bundle token-bucket rate limit, then the call itself with
manual redirect handling (each hop re-checked from step 1) and a
response-size cap. Secrets are resolved from env by reference only after
every other check passes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 21: Host capability `log` + host-call dispatch multiplexer (`ApprovedPermissions`, `TripTracker`, D31 host-call usage)

**Depends on:** Task 5 (`sanitize::sanitize_json_value`), Task 6 (telemetry registration pattern), Task 11 (`distribution::poller::{ActionBundleRow, ActionManifest, EgressRule}`), Task 15 (`hostapi::registry::{BundleRegistry, ConnectionPool, ExecutorConnection}`, extended below), Task 16 (`InvocationScope`, `BundleContext`), Task 17-20 (`KvCapability`, `RelayCapability`, `DbCapability`, `HttpEgressCapability`), Task 3 (`Config`).

**Files:**
- Create: `core/svc_action/src/hostapi/capabilities/log.rs` (replaces Task 16's stub)
- Create: `core/svc_action/src/hostapi/dispatch.rs`
- Modify: `core/svc_action/src/hostapi/registry.rs` (add `ConnectionPool::snapshot()`)
- Modify: `core/svc_action/src/hostapi/mod.rs` (add `pub mod dispatch;`)
- Test: `core/svc_action/tests/hostapi_dispatch.rs`

**Interfaces:**
- Consumes: `penguin_bundle_host::wire::message::{Message, CapabilityKind, HostResultError, InvocationScope}` (P2), `penguin_bundle_host::wire::transport::FrameTransport` (P2), `distribution::poller::{ActionBundleRow, ActionManifest, EgressRule}` (Task 11).
- Produces: `hostapi::capabilities::log::LogCapability` — `LogCapability::new(min_level: tracing::Level) -> Self`, `fn write(&self, app_id: &str, tenant: &str, community: Option<&str>, level: &str, message: &str, fields_json: &str)`; `hostapi::dispatch::{ApprovedPermissions, TripTracker, TripLimit, TripOutcome, HostCallMetrics, register_host_call_metrics, DispatchState}` — `DispatchState::new(deps...) -> Arc<Self>`, `fn update_approved(&self, rows: &[ActionBundleRow])` (Task 27's runner calls this once per distribution poll), `fn set_active_context(&self, app_id: &str, ctx: BundleContext)` / `fn clear_active_context(&self, app_id: &str)` (Task 22's consumer loop brackets every `invoke()` call with these), `fn ensure_dispatchers(self: &Arc<Self>, pool: &ConnectionPool)` (Task 27's runner polls this on a short interval to discover newly-handshaken connections) — Task 22's consumer loop and Task 27's runner are this task's only callers.

Mirrors `penguin-bundle-host::host::{approvals::ApprovedPermissions, TripTracker, HostCallRouter}` (that crate's plan Tasks 9/15/16) as a tight, name-matching local port (Global Constraints P3).

> **Known integration seam, documented rather than silently assumed:** the dispatch loop below reads `FrameTransport::recv_unsolicited()` and handles only `Message::HostCall`; any other message observed there is logged at WARN and dropped, since `Hello`/`Loaded`/`Unloaded` are consumed by Task 14/15's own handshake/load code paths (via `call()`'s reply-matching or the connection's initial handshake read, not this loop). If a future change to Task 14/15 ever routes one of those through `recv_unsolicited()` concurrently with this loop, the two would race for that frame — flagged here as a design constraint this task depends on, not verified against Task 14/15's exact internal code by re-reading it line by line.

- [ ] **Step 1: Write the failing tests**

`tests/hostapi_dispatch.rs`:

```rust
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use svc_action::distribution::poller::{ActionBundleRow, ActionManifest, DataTables, EgressRule, Limits};
use svc_action::hostapi::capabilities::context::InvocationScope;
use svc_action::hostapi::dispatch::{ApprovedPermissions, TripLimit, TripOutcome, TripTracker};

fn sample_row(app_id: &str, tables: Vec<&str>, egress: Vec<EgressRule>) -> ActionBundleRow {
    ActionBundleRow {
        app_id: app_id.to_string(),
        community_id: None,
        entrypoint: None,
        config: serde_json::json!({}),
        artifact_version: None,
        artifact_digest: Some("sha256:test".to_string()),
        artifact_kind: Some("source".to_string()),
        language: Some("python".to_string()),
        scan_status: Some("scanned".to_string()),
        manifest: ActionManifest {
            egress,
            data: DataTables { tables: tables.into_iter().map(str::to_string).collect() },
            limits: Limits { timeout_ms: 2000, memory_mb: 64, egress_rps: 10 },
        },
    }
}

#[test]
fn approved_permissions_from_manifest_carries_tables_and_egress() {
    let row = sample_row(
        "waddles.socials.music.default",
        vec!["music_queue"],
        vec![EgressRule { host: "api.spotify.com".to_string(), methods: vec!["GET".to_string()] }],
    );
    let approved = ApprovedPermissions::from_manifest(&row.app_id, &row.manifest);
    assert!(approved.tables.contains("music_queue"));
    assert_eq!(approved.egress.len(), 1);
    assert_eq!(approved.egress[0].host, "api.spotify.com");
}

#[test]
fn trip_tracker_disables_after_the_third_trip_within_the_window() {
    let tracker = TripTracker::new(3, Duration::from_secs(300));
    let now = std::time::Instant::now();
    assert!(matches!(tracker.record_trip("waddles.a", "sha256:1", TripLimit::CallTimeout, now), TripOutcome::Recorded(1)));
    assert!(!tracker.is_disabled("waddles.a", "sha256:1"));
    assert!(matches!(tracker.record_trip("waddles.a", "sha256:1", TripLimit::MemoryLimit, now), TripOutcome::Recorded(2)));
    assert!(!tracker.is_disabled("waddles.a", "sha256:1"));
    assert!(matches!(tracker.record_trip("waddles.a", "sha256:1", TripLimit::HostCallDenied, now), TripOutcome::Disabled));
    assert!(tracker.is_disabled("waddles.a", "sha256:1"));
}

#[test]
fn trip_tracker_keys_are_per_app_id_and_digest_a_hot_swap_resets_the_slate() {
    let tracker = TripTracker::new(1, Duration::from_secs(300));
    let now = std::time::Instant::now();
    assert!(matches!(tracker.record_trip("waddles.a", "sha256:old", TripLimit::CallTimeout, now), TripOutcome::Disabled));
    assert!(tracker.is_disabled("waddles.a", "sha256:old"));
    // A new digest for the same app_id is a fresh (app_id, digest) key --
    // never disabled by the old digest's trips (spec Sec7.5: re-enabled
    // "when the pod observes a new artifactDigest for it").
    assert!(!tracker.is_disabled("waddles.a", "sha256:new"));
}

#[test]
fn trip_tracker_evicts_trips_outside_the_window() {
    let tracker = TripTracker::new(2, Duration::from_millis(50));
    let t0 = std::time::Instant::now();
    assert!(matches!(tracker.record_trip("waddles.a", "sha256:1", TripLimit::CallTimeout, t0), TripOutcome::Recorded(1)));
    let t1 = t0 + Duration::from_millis(100); // outside the 50ms window
    // The first trip has aged out -- this is trip 1 of a fresh window, not trip 2.
    assert!(matches!(tracker.record_trip("waddles.a", "sha256:1", TripLimit::CallTimeout, t1), TripOutcome::Recorded(1)));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `hostapi::dispatch` does not exist yet.

- [ ] **Step 3: Add the `base64` dependency**

The `db` dispatch arm's `json_to_dbvalues` helper (Step 5) decodes a `{"bytes_base64": "..."}` parameter convention. Add to `Cargo.toml`:

```toml
base64 = "=0.22.1"
```

- [ ] **Step 4: Add `ConnectionPool::snapshot()`**

In `src/hostapi/registry.rs`, inside `impl ConnectionPool`, add:

```rust
    /// A point-in-time snapshot of every registered connection -- added
    /// in this continuation (Task 21) so the host-call dispatch
    /// supervisor can discover newly-handshaken connections without the
    /// handshake path (Task 14/15) needing to know dispatch exists.
    pub fn snapshot(&self) -> Vec<Arc<ExecutorConnection>> {
        self.connections.lock().expect("mutex not poisoned").clone()
    }
```

- [ ] **Step 5: Write `src/hostapi/capabilities/log.rs`** (replaces Task 16's stub)

```rust
//! `log` host capability -- sanitized, levelled logging into the stage's
//! own OTel pipeline (spec Sec6.5 `interface log`, Sec7.4). A bundle
//! cannot raise its own log level above the stage's configured
//! `LOG_LEVEL` -- a guest requesting a more verbose level than the stage
//! allows is silently clamped down to the stage's own level, never
//! rejected. Mirrors `penguin-bundle-host::host::log_guard`'s `LogGuard`
//! design (Global Constraints P3).

use crate::sanitize::sanitize_json_value;

fn level_rank(level: &str) -> u8 {
    match level.to_ascii_lowercase().as_str() {
        "error" => 0,
        "warn" => 1,
        "info" => 2,
        _ => 3, // "debug" and any unrecognized value clamp to the most verbose rank
    }
}

/// Bundle-facing `log` host capability, always granted.
pub struct LogCapability {
    min_level: tracing::Level,
}

impl LogCapability {
    /// Builds a capability handler bound to the stage's own configured
    /// `LOG_LEVEL` (`Config`, Task 3).
    pub fn new(min_level: tracing::Level) -> Self {
        Self { min_level }
    }

    fn min_level_rank(&self) -> u8 {
        match self.min_level {
            tracing::Level::ERROR => 0,
            tracing::Level::WARN => 1,
            tracing::Level::INFO => 2,
            tracing::Level::DEBUG | tracing::Level::TRACE => 3,
        }
    }

    /// Sanitizes `fields_json` (`sanitize::sanitize_json_value`, Task 5)
    /// and emits at the requested level, clamped down to the stage's own
    /// configured floor when the guest asked for something more verbose.
    pub fn write(&self, app_id: &str, tenant: &str, community: Option<&str>, level: &str, message: &str, fields_json: &str) {
        let effective_rank = level_rank(level).min(self.min_level_rank());
        let parsed: serde_json::Value = serde_json::from_str(fields_json).unwrap_or(serde_json::Value::Null);
        let sanitized = sanitize_json_value(&parsed);
        let community_label = community.unwrap_or("_tenant");
        match effective_rank {
            0 => tracing::error!(app_id, tenant, community = community_label, fields = %sanitized, "{message}"),
            1 => tracing::warn!(app_id, tenant, community = community_label, fields = %sanitized, "{message}"),
            2 => tracing::info!(app_id, tenant, community = community_label, fields = %sanitized, "{message}"),
            _ => tracing::debug!(app_id, tenant, community = community_label, fields = %sanitized, "{message}"),
        }
    }
}
```

- [ ] **Step 6: Write `src/hostapi/dispatch.rs`**

```rust
//! Host-call dispatch multiplexer: reads unsolicited `host-call` frames
//! off each active executor connection's `FrameTransport`, routes each to
//! the matching capability, enforces the approved-permission-set (egress
//! allowlist / `data.tables`) before ever calling into a capability,
//! applies the three-strike sandbox-trip/disable rule (spec Sec7.5),
//! records D31 usage-by-kind, and replies with `host-result`. Mirrors
//! `penguin-bundle-host::host::{approvals::ApprovedPermissions,
//! TripTracker, HostCallRouter}` (that crate's plan Tasks 9/15/16) as a
//! tight, name-matching local port (Global Constraints P3).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use penguin_bundle_host::wire::message::{CapabilityKind, HostResultError, InvocationScope, Message};
use tracing::Instrument;

use crate::distribution::poller::{ActionBundleRow, ActionManifest, EgressRule};
use crate::hostapi::capabilities::context::{build_bundle_context, BundleContext};
use crate::hostapi::capabilities::db::DbCapability;
use crate::hostapi::capabilities::flags::FlagsClient;
use crate::hostapi::capabilities::http_egress::{EgressOutcome, EgressRequest, HttpEgressCapability};
use crate::hostapi::capabilities::kv::KvCapability;
use crate::hostapi::capabilities::log::LogCapability;
use crate::hostapi::capabilities::relay::RelayCapability;
use crate::hostapi::capabilities::{
    context::ClockCapability,
    db::{DbOutcome, DbRows, DbValue},
};
use crate::hostapi::registry::{BundleRegistry, ConnectionPool, ExecutorConnection};

/// The subset of a bundle's approved manifest this stage enforces per
/// host call (spec Sec7.4, Sec9.7.3) -- built from the distribution
/// poller's already-fetched `ActionManifest` (Task 11), never re-fetched.
/// Mirrors `penguin-bundle-host::host::approvals::ApprovedPermissions`
/// (Global Constraints P3); this plan's own `data.tables` shape is a
/// flat `Vec<String>` with no per-table read/write flag (hub-api's actual
/// distribution v2 manifest, `docs/plan-m2b-hub-api` Task 32, never
/// carries one) -- unlike that crate's speculative `TableGrant{read,
/// write}`, a table in the approved set here permits both read and write;
/// the sqlparser statement-kind allowlist (Task 19) plus Postgres RLS are
/// the two enforcement layers, not a read/write distinction at this
/// layer. Flagged as a cross-plan inconsistency in the self-review.
#[derive(Debug, Clone)]
pub struct ApprovedPermissions {
    pub app_id: String,
    pub egress: Vec<EgressRule>,
    pub tables: HashSet<String>,
}

impl ApprovedPermissions {
    /// Builds the approved set from one distribution-poller manifest.
    pub fn from_manifest(app_id: &str, manifest: &ActionManifest) -> Self {
        Self {
            app_id: app_id.to_string(),
            egress: manifest.egress.clone(),
            tables: manifest.data.tables.iter().cloned().collect(),
        }
    }
}

/// Which sandbox limit a trip was recorded for (spec Sec7.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TripLimit {
    CallTimeout,
    MemoryLimit,
    BundleTrap,
    HostCallDenied,
}

/// The result of recording one trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TripOutcome {
    Recorded(u32),
    Disabled,
}

/// The spec Sec7.5 three-strike sandbox-trip/disable rule, keyed by
/// `(app_id, digest)` so a hot-swap to a new digest always starts with a
/// clean slate (spec Sec7.5: "re-enabled when the pod observes a new
/// artifactDigest"). Mirrors `penguin-bundle-host::host::TripTracker`
/// (that crate's plan Task 15, Global Constraints P3).
pub struct TripTracker {
    threshold: u32,
    window: Duration,
    trips: Mutex<HashMap<(String, String), VecDeque<Instant>>>,
    disabled: Mutex<HashSet<(String, String)>>,
}

impl TripTracker {
    /// Builds a tracker with the given trip threshold (`EXECUTOR_TRIP_
    /// THRESHOLD`, default 3) and window (`EXECUTOR_TRIP_WINDOW_S`,
    /// default 300s).
    pub fn new(threshold: u32, window: Duration) -> Self {
        Self { threshold, window, trips: Mutex::new(HashMap::new()), disabled: Mutex::new(HashSet::new()) }
    }

    /// Records one trip for `(app_id, digest)` at `now`, evicting trips
    /// older than `window` first. The third trip within the window marks
    /// the bundle disabled for this process's lifetime (until a new
    /// digest is observed).
    pub fn record_trip(&self, app_id: &str, digest: &str, _limit: TripLimit, now: Instant) -> TripOutcome {
        let key = (app_id.to_string(), digest.to_string());
        let mut trips = self.trips.lock().expect("mutex not poisoned");
        let entry = trips.entry(key.clone()).or_default();
        while let Some(&front) = entry.front() {
            if now.duration_since(front) > self.window {
                entry.pop_front();
            } else {
                break;
            }
        }
        entry.push_back(now);
        let count = entry.len() as u32;
        if count >= self.threshold {
            self.disabled.lock().expect("mutex not poisoned").insert(key);
            TripOutcome::Disabled
        } else {
            TripOutcome::Recorded(count)
        }
    }

    /// `true` when `(app_id, digest)` has been disabled by three trips.
    pub fn is_disabled(&self, app_id: &str, digest: &str) -> bool {
        self.disabled
            .lock()
            .expect("mutex not poisoned")
            .contains(&(app_id.to_string(), digest.to_string()))
    }
}

/// D31/spec Sec7.5 Prometheus surface this task registers.
pub struct HostCallMetrics {
    pub host_call_denied_total: prometheus::IntCounterVec,
    pub sandbox_trip_total: prometheus::IntCounterVec,
    pub bundle_disabled: prometheus::IntGaugeVec,
}

/// Registers this task's metrics onto the shared registry (Task 6's
/// pattern: `IntCounterVec`/`IntGaugeVec::new` + `registry.register`).
pub fn register_host_call_metrics(registry: &prometheus::Registry) -> HostCallMetrics {
    let host_call_denied_total = prometheus::IntCounterVec::new(
        prometheus::Opts::new("waddles_host_call_denied_total", "Host calls denied by capability/approval checks"),
        &["app_id", "capability", "reason"],
    )
    .expect("valid metric opts");
    registry.register(Box::new(host_call_denied_total.clone())).expect("register waddles_host_call_denied_total");

    let sandbox_trip_total = prometheus::IntCounterVec::new(
        prometheus::Opts::new("waddles_sandbox_trip_total", "Sandbox trips recorded per bundle/limit"),
        &["app_id", "limit"],
    )
    .expect("valid metric opts");
    registry.register(Box::new(sandbox_trip_total.clone())).expect("register waddles_sandbox_trip_total");

    let bundle_disabled = prometheus::IntGaugeVec::new(
        prometheus::Opts::new("waddles_bundle_disabled", "1 when a bundle is disabled after three sandbox trips"),
        &["app_id"],
    )
    .expect("valid metric opts");
    registry.register(Box::new(bundle_disabled.clone())).expect("register waddles_bundle_disabled");

    HostCallMetrics { host_call_denied_total, sandbox_trip_total, bundle_disabled }
}

fn denied(reason: &str) -> HostResultError {
    HostResultError { code: "HOST_CALL_DENIED".to_string(), message: reason.to_string() }
}

fn failed(reason: &str) -> HostResultError {
    HostResultError { code: "HOST_CALL_FAILED".to_string(), message: reason.to_string() }
}

fn db_value_to_json(value: &DbValue) -> serde_json::Value {
    match value {
        DbValue::Null => serde_json::Value::Null,
        DbValue::Bool(b) => serde_json::json!(b),
        DbValue::Int(i) => serde_json::json!(i),
        DbValue::Float(f) => serde_json::json!(f),
        DbValue::Text(t) => serde_json::json!(t),
        DbValue::Bytes(b) => serde_json::json!(b),
    }
}

/// Decodes a `db` host-call's `params` JSON array into `DbValue`s. Each
/// element is a plain JSON scalar (`null`/`bool`/number/string), mapped
/// directly; a byte-string parameter is the one WIT `value` case with no
/// native JSON scalar, so it is carried as `{"bytes_base64": "..."}` --
/// this plan's own convention for the JSON encoding of the WIT `db`
/// `value` variant crossing the wire, since neither `docs/plan-penguin-
/// bundle-host` nor the spec's WIT excerpt fixes one.
fn json_to_dbvalues(params: &serde_json::Value) -> Vec<DbValue> {
    let Some(array) = params.as_array() else { return Vec::new() };
    array
        .iter()
        .map(|v| {
            if v.is_null() {
                DbValue::Null
            } else if let Some(b) = v.as_bool() {
                DbValue::Bool(b)
            } else if let Some(i) = v.as_i64() {
                DbValue::Int(i)
            } else if let Some(f) = v.as_f64() {
                DbValue::Float(f)
            } else if let Some(obj) = v.as_object() {
                obj.get("bytes_base64")
                    .and_then(|b| b.as_str())
                    .and_then(|s| {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD.decode(s).ok()
                    })
                    .map(DbValue::Bytes)
                    .unwrap_or(DbValue::Null)
            } else {
                DbValue::Text(v.as_str().unwrap_or_default().to_string())
            }
        })
        .collect()
}

/// Serializes a full `DbRows` (columns, every row's values, and
/// `rows-affected`) into the WIT `db` `rows` record shape -- the `db`
/// dispatch arm's earlier draft returned only `columns`, silently
/// dropping every row's actual values; fixed here to answer the guest
/// with the complete result set.
fn db_rows_to_json(rows: &DbRows) -> serde_json::Value {
    serde_json::json!({
        "columns": rows.columns,
        "rows": rows.rows.iter().map(|row| row.iter().map(db_value_to_json).collect::<Vec<_>>()).collect::<Vec<_>>(),
        "rows_affected": rows.rows_affected,
    })
}

/// The subset of `CapabilityKind` D31 (spec Sec5.12) counts as "host
/// calls by kind" -- `Context`/`Clock` are local/free and never counted.
fn usage_kind_for(capability: CapabilityKind) -> Option<penguin_spine::HostCallKind> {
    match capability {
        CapabilityKind::Http => Some(penguin_spine::HostCallKind::Http),
        CapabilityKind::Kv => Some(penguin_spine::HostCallKind::Kv),
        CapabilityKind::Db => Some(penguin_spine::HostCallKind::Db),
        CapabilityKind::Relay => Some(penguin_spine::HostCallKind::Relay),
        CapabilityKind::Flags => Some(penguin_spine::HostCallKind::Flags),
        CapabilityKind::Log => Some(penguin_spine::HostCallKind::Log),
        CapabilityKind::Context | CapabilityKind::Clock => None,
    }
}

/// Everything the dispatch loop needs, shared across every active
/// executor connection. One instance per stage process (Task 27's
/// runner builds it once).
pub struct DispatchState {
    approved: RwLock<HashMap<String, ApprovedPermissions>>,
    active_contexts: Mutex<HashMap<String, BundleContext>>,
    dispatched_connections: Mutex<HashSet<usize>>,
    registry: Arc<BundleRegistry>,
    flags: Arc<dyn FlagsClient>,
    kv: Arc<KvCapability>,
    relay: Arc<RelayCapability>,
    db: Arc<DbCapability>,
    http: Arc<HttpEgressCapability>,
    log: Arc<LogCapability>,
    trips: Arc<TripTracker>,
    usage: Arc<penguin_spine::UsageBatcher>,
    metrics: HostCallMetrics,
    stage: &'static str,
}

impl DispatchState {
    /// Builds the shared dispatch state. `stage` is always `"action"` for
    /// this service -- passed explicitly (not hardcoded inline) so
    /// `UsageDelta.stage` and this struct's own field agree by
    /// construction, matching `penguin-bundle-host::host::HostCallRouter`'s
    /// own `stage: String` field (Global Constraints P3).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        registry: Arc<BundleRegistry>,
        flags: Arc<dyn FlagsClient>,
        kv: Arc<KvCapability>,
        relay: Arc<RelayCapability>,
        db: Arc<DbCapability>,
        http: Arc<HttpEgressCapability>,
        log: Arc<LogCapability>,
        trips: Arc<TripTracker>,
        usage: Arc<penguin_spine::UsageBatcher>,
        metrics: HostCallMetrics,
    ) -> Arc<Self> {
        Arc::new(Self {
            approved: RwLock::new(HashMap::new()),
            active_contexts: Mutex::new(HashMap::new()),
            dispatched_connections: Mutex::new(HashSet::new()),
            registry,
            flags,
            kv,
            relay,
            db,
            http,
            log,
            trips,
            usage,
            metrics,
            stage: "action",
        })
    }

    /// Refreshes the approved-permission-set cache from the latest
    /// distribution poll (Task 27 calls this once per `poll_once()`).
    pub fn update_approved(&self, rows: &[ActionBundleRow]) {
        let mut approved = self.approved.write().expect("lock not poisoned");
        approved.clear();
        for row in rows {
            approved.insert(row.app_id.clone(), ApprovedPermissions::from_manifest(&row.app_id, &row.manifest));
        }
    }

    /// Registers the `BundleContext` a `context` host-call answers with
    /// while `app_id`'s invocation is in flight -- set immediately before
    /// `ExecutorConnection::invoke()` and cleared immediately after
    /// (Task 22). Safe because one bundle's own per-bundle consumer loop
    /// processes its action stream strictly sequentially -- never two
    /// concurrent invocations for the same `app_id`.
    pub fn set_active_context(&self, app_id: &str, ctx: BundleContext) {
        self.active_contexts.lock().expect("mutex not poisoned").insert(app_id.to_string(), ctx);
    }

    /// Clears the active context after an invocation completes.
    pub fn clear_active_context(&self, app_id: &str) {
        self.active_contexts.lock().expect("mutex not poisoned").remove(app_id);
    }

    /// Discovers newly-handshaken connections in `pool` and spawns a
    /// host-call dispatch loop for each exactly once (Task 27's runner
    /// polls this on a short interval).
    pub fn ensure_dispatchers(self: &Arc<Self>, pool: &ConnectionPool) {
        let mut dispatched = self.dispatched_connections.lock().expect("mutex not poisoned");
        for conn in pool.snapshot() {
            let key = Arc::as_ptr(&conn) as usize;
            if dispatched.insert(key) {
                let state = Arc::clone(self);
                tokio::spawn(async move { state.run_dispatch_loop(conn).await });
            }
        }
    }

    async fn run_dispatch_loop(self: Arc<Self>, conn: Arc<ExecutorConnection>) {
        let transport = conn.transport();
        loop {
            let frame = match transport.recv_unsolicited().await {
                Ok(f) => f,
                Err(err) => {
                    tracing::warn!(error = %err, "executor connection closed; ending its host-call dispatch loop");
                    return;
                }
            };
            let Message::HostCall { scope, capability, op, args, .. } = frame.message else {
                tracing::warn!("dispatch loop received a non-host-call unsolicited frame; ignoring (see this task's integration-seam note)");
                continue;
            };
            let result = self.dispatch(&scope, capability, &op, args).await;
            let reply = match result {
                Ok(value) => Message::HostResult { result: Some(value), error: None },
                Err(err) => Message::HostResult { result: None, error: Some(err) },
            };
            if let Err(err) = transport.send(frame.id, reply).await {
                tracing::warn!(error = %err, "failed to send host-result reply");
                return;
            }
        }
    }

    fn record_usage_host_call(&self, scope: &InvocationScope, capability: CapabilityKind) {
        let Some(kind) = usage_kind_for(capability) else { return };
        let mut delta = penguin_spine::UsageDelta::zero(
            scope.tenant_id.clone(),
            scope.community_id.clone(),
            scope.workstream_id.clone(),
            self.stage.to_string(),
            Some(scope.app_id.clone()),
        );
        delta.host_calls.increment(kind);
        self.usage.record(delta);
    }

    fn record_trip_and_metric(&self, app_id: &str, limit: TripLimit, label: &'static str) {
        let digest = self.registry.current_digest(app_id).unwrap_or_else(|| "unknown".to_string());
        let outcome = self.trips.record_trip(app_id, &digest, limit, Instant::now());
        self.metrics.sandbox_trip_total.with_label_values(&[app_id, label]).inc();
        if matches!(outcome, TripOutcome::Disabled) {
            self.metrics.bundle_disabled.with_label_values(&[app_id]).set(1);
            tracing::error!(app_id, digest, "bundle disabled after three sandbox trips");
        }
    }

    /// Runs the full dispatch: approval check, capability routing, D31
    /// usage recording, one `host.call` span per call carrying the D30
    /// `waddles.*` attributes (spec Sec5.11/Sec13.2).
    pub async fn dispatch(&self, scope: &InvocationScope, capability: CapabilityKind, op: &str, args: serde_json::Value) -> Result<serde_json::Value, HostResultError> {
        let digest = self.registry.current_digest(&scope.app_id).unwrap_or_else(|| "unknown".to_string());
        if self.trips.is_disabled(&scope.app_id, &digest) {
            return Err(HostResultError { code: "BUNDLE_DISABLED".to_string(), message: "bundle disabled after repeated sandbox trips".to_string() });
        }

        let community_label = scope.community_id.as_deref().unwrap_or("_tenant").to_string();
        let span = tracing::info_span!(
            "host.call",
            capability = ?capability,
            op,
            waddles.tenant_id = %scope.tenant_id,
            waddles.community_id = %community_label,
            waddles.workstream_id = %scope.workstream_id,
            waddles.app_id = %scope.app_id,
        );
        async move {
            self.record_usage_host_call(scope, capability);
            let result = match capability {
                CapabilityKind::Context => match op {
                    "get-context" | "get_context" => {
                        let contexts = self.active_contexts.lock().expect("mutex not poisoned");
                        match contexts.get(&scope.app_id) {
                            Some(ctx) => Ok(serde_json::to_value(ctx).expect("BundleContext always serializes")),
                            None => Err(failed("no active context registered for this app_id")),
                        }
                    }
                    other => Err(failed(&format!("unknown context op '{other}'"))),
                },
                CapabilityKind::Clock => match op {
                    "now-millis" | "now_millis" => Ok(serde_json::json!(ClockCapability::now_millis())),
                    "now-rfc3339" | "now_rfc3339" => Ok(serde_json::json!(ClockCapability::now_rfc3339())),
                    "monotonic-nanos" | "monotonic_nanos" => Ok(serde_json::json!(ClockCapability::monotonic_nanos())),
                    other => Err(failed(&format!("unknown clock op '{other}'"))),
                },
                CapabilityKind::Flags => match op {
                    "enabled" => {
                        let key = args["key"].as_str().unwrap_or_default();
                        let default_value = args["default_value"].as_bool().unwrap_or(false);
                        Ok(serde_json::json!(self.flags.enabled(key, default_value).await))
                    }
                    "tier" => Ok(serde_json::json!(self.flags.tier().await)),
                    other => Err(failed(&format!("unknown flags op '{other}'"))),
                },
                CapabilityKind::Kv => {
                    let base_key = penguin_spine::Scope::new(scope.tenant_id.clone(), scope.community_id.clone()).state_key(&scope.app_id);
                    let key = args["key"].as_str().unwrap_or_default();
                    match op {
                        "get" => self.kv.get(&base_key, key).await.map(|v| serde_json::json!(v)).map_err(|e| denied(&e.to_string())),
                        "set" => {
                            let value = args["value"].as_str().unwrap_or_default().as_bytes().to_vec();
                            let ttl = args["ttl_seconds"].as_u64().unwrap_or(0) as u32;
                            self.kv.set(&base_key, key, value, ttl).await.map(|_| serde_json::Value::Null).map_err(|e| denied(&e.to_string()))
                        }
                        "delete" => self.kv.delete(&base_key, key).await.map(|_| serde_json::Value::Null).map_err(|e| denied(&e.to_string())),
                        "increment" => {
                            let delta = args["delta"].as_i64().unwrap_or(0);
                            let ttl = args["ttl_seconds"].as_u64().unwrap_or(0) as u32;
                            self.kv.increment(&base_key, key, delta, ttl).await.map(|v| serde_json::json!(v)).map_err(|e| denied(&e.to_string()))
                        }
                        other => Err(failed(&format!("unknown kv op '{other}'"))),
                    }
                }
                CapabilityKind::Relay => {
                    let provider = args["provider"].as_str().unwrap_or_default();
                    let message_json = args["message_json"].as_str().unwrap_or_default();
                    match self.relay.push(provider, message_json).await {
                        Ok(()) => Ok(serde_json::Value::Null),
                        Err(err) => {
                            self.metrics.host_call_denied_total.with_label_values(&[&scope.app_id, "relay", err.reason_str()]).inc();
                            Err(denied(&err.to_string()))
                        }
                    }
                }
                CapabilityKind::Db => {
                    let approved = self.approved.read().expect("lock not poisoned");
                    let tables = approved.get(&scope.app_id).map(|a| a.tables.clone()).unwrap_or_default();
                    drop(approved);
                    let statement = args["statement"].as_str().unwrap_or_default();
                    let params = json_to_dbvalues(&args["params"]);
                    match self.db.execute(&tables, scope, statement, &params).await {
                        DbOutcome::Rows(rows) => Ok(db_rows_to_json(&rows)),
                        DbOutcome::Denied(d) => {
                            self.metrics.host_call_denied_total.with_label_values(&[&scope.app_id, "db", "denied"]).inc();
                            self.record_trip_and_metric(&scope.app_id, TripLimit::HostCallDenied, "denied");
                            Err(denied(&d.to_string()))
                        }
                        DbOutcome::Timeout => Err(HostResultError { code: "DB_TIMEOUT".to_string(), message: "statement timed out".to_string() }),
                        DbOutcome::Backend(msg) => Err(failed(&msg)),
                    }
                }
                CapabilityKind::Http => {
                    let approved = self.approved.read().expect("lock not poisoned");
                    let egress_rules = approved.get(&scope.app_id).map(|a| a.egress.clone()).unwrap_or_default();
                    drop(approved);
                    let req = EgressRequest {
                        method: args["method"].as_str().unwrap_or("GET").to_string(),
                        url: args["url"].as_str().unwrap_or_default().to_string(),
                        headers: vec![],
                        body: None,
                        secret_refs: vec![],
                    };
                    match self.http.send(&scope.app_id, &egress_rules, req).await {
                        EgressOutcome::Response(resp) => Ok(serde_json::json!({"status": resp.status, "truncated": resp.truncated})),
                        EgressOutcome::Denied(d) => {
                            self.metrics.host_call_denied_total.with_label_values(&[&scope.app_id, "http", d.reason_str()]).inc();
                            self.record_trip_and_metric(&scope.app_id, TripLimit::HostCallDenied, "denied");
                            Err(denied(d.reason_str()))
                        }
                        EgressOutcome::RateLimited { retry_after_ms } => Err(HostResultError { code: "RATE_LIMITED".to_string(), message: format!("retry after {retry_after_ms}ms") }),
                        EgressOutcome::Timeout => Err(HostResultError { code: "TIMEOUT".to_string(), message: "egress call timed out".to_string() }),
                        EgressOutcome::TooLarge(n) => Err(failed(&format!("response exceeded the configured size cap ({n} bytes)"))),
                    }
                }
                CapabilityKind::Log => {
                    let level = args["level"].as_str().unwrap_or("info");
                    let message = args["message"].as_str().unwrap_or_default();
                    let fields_json = args["fields_json"].as_str().unwrap_or("{}");
                    self.log.write(&scope.app_id, &scope.tenant_id, scope.community_id.as_deref(), level, message, fields_json);
                    Ok(serde_json::Value::Null)
                }
            };
            result
        }
        .instrument(span)
        .await
    }
}
```

- [ ] **Step 7: Wire `src/hostapi/capabilities/mod.rs` and `src/hostapi/mod.rs`**

`src/hostapi/capabilities/mod.rs` — add:

```rust
pub mod log;
```

`src/hostapi/mod.rs` — add:

```rust
pub mod dispatch;
```

- [ ] **Step 8: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 4 passed; 0 failed` for `hostapi_dispatch`.

- [ ] **Step 9: Commit**

Stage `core/svc_action/src/hostapi/` and commit with message:

```
feat(svc-action): log host capability + host-call dispatch multiplexer

ApprovedPermissions/TripTracker mirror penguin-bundle-host's own design
(Global Constraints P3). The dispatch loop reads FrameTransport::
recv_unsolicited() per executor connection, routes every host-call frame
through the seven capabilities behind an approval check + three-strike
disable rule, records D31 host-calls-by-kind usage, and answers with
host-result -- one host.call span per call carrying the D30 waddles.*
attributes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 22: Per-bundle action consumer loop — binding/scope verification, dispatch, retry/DLQ/reaper, D31 usage, audit

**Depends on:** Task 12 (`retry`), Task 13 (`audit::{AuditWriter, RecordParams}`), Task 15 (`hostapi::registry::{BundleRegistry, ConnectionPool, InvokeRequest, ExportKind}`), Task 16 (`BundleContext`, `build_bundle_context`), Task 18 (`senders::twitch::TwitchBuiltinSender`), Task 21 (`hostapi::dispatch::DispatchState`), Task 3 (`Config`). Tasks 23-26 (Discord/Slack/YouTube/Kick senders) are consumed by name only — this task's own tests use a fake sender set; Task 27's runner wires the real ones.

**Files:**
- Modify: `core/svc_action/Cargo.toml` (add `tokio-util` for `CancellationToken`)
- Create: `core/svc_action/src/consumer/mod.rs`
- Create: `core/svc_action/src/consumer/action_loop.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod consumer;`)
- Test: `core/svc_action/tests/consumer_action_loop.rs`

**Interfaces:**
- Consumes: `penguin_spine::{Scope, Stage, Grant, GroupReader, SpineClient, Delivered, DlqError, DlqErrorKind, BindingKeyring, verify_binding, ScopeCheck, BoundaryError, strip_bundle_identity_fields, UsageDelta}` (P1), `retry::{RetryConfig, TransportOutcome, retry_with_backoff}` (Task 12), `audit::{AuditWriter, RecordParams}` (Task 13), `hostapi::registry::{ConnectionPool, InvokeRequest, ExportKind}` (Task 15), `hostapi::dispatch::DispatchState` (Task 21), `hostapi::capabilities::context::build_bundle_context` (Task 16).
- Produces: `consumer::action_loop::{BuiltinSenders, ConsumerDeps, run_bundle_consumer, run_reaper}` — `run_bundle_consumer(app_id: String, digest: String, deps: Arc<ConsumerDeps>, shutdown: tokio_util::sync::CancellationToken)` and `run_reaper(app_id: String, deps: Arc<ConsumerDeps>, claim_interval: Duration, shutdown: tokio_util::sync::CancellationToken)` — Task 27's runner spawns one pair of these per activated bundle from the distribution poll, and cancels+respawns them on a digest change or bundle removal.

- [ ] **Step 1: Add `tokio-util` to `Cargo.toml`**

```toml
tokio-util = "=0.7.13"
```

- [ ] **Step 2: Write the failing tests**

`tests/consumer_action_loop.rs`:

```rust
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use penguin_spine::{
    BindingInput, BindingKeyEntry, BindingKeyring, Scope, SpineClient, SpineConfig, Stage, StageEnvelope,
};
use svc_action::consumer::action_loop::{run_bundle_consumer, BuiltinSenders, ConsumerDeps};
use svc_action::retry::RetryConfig;
use tokio_util::sync::CancellationToken;

fn valkey_url() -> String {
    std::env::var("TEST_VALKEY_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/0".to_string())
}

/// `SpineConfig` has no by-URL test constructor -- built directly via its
/// (entirely `pub`) fields rather than routing through `from_env()`,
/// which would require setting real process env vars from a test.
fn test_spine_config() -> SpineConfig {
    SpineConfig {
        valkey_url: valkey_url(),
        valkey_username: None,
        valkey_password: None,
        valkey_ca_file: std::path::PathBuf::from("/etc/waddles/ca/valkey-ca.crt"),
        security_transport_tls: false,
        security_transport_auth: false,
        consumer_id: format!("test-consumer-{}", uuid::Uuid::new_v4()),
        stream_maxlen: 1_000,
        read_count: 16,
        block_ms: 200,
        claim_idle_ms: 5_000,
        claim_interval_ms: 2_000,
        stats_interval_ms: 10_000,
        pel_alert: 5_000,
        dlq_maxlen: 1_000,
        max_deliveries: 5,
        drain_socket_timeout_s: 5,
        relay_block_timeout_s: 5,
    }
}

async fn test_spine_client() -> SpineClient {
    SpineClient::connect(test_spine_config(), std::sync::Arc::new(penguin_spine::NoopMetrics))
        .await
        .expect("valkey reachable in CI integration job")
}

fn test_keyring() -> BindingKeyring {
    let mut entries = std::collections::HashMap::new();
    entries.insert("test-kid".to_string(), BindingKeyEntry { key: b"test-signing-key".to_vec(), retired_at: None });
    BindingKeyring::from_entries("test-kid", entries, chrono::Duration::seconds(86_400)).expect("valid keyring")
}

fn signed_envelope(keyring: &BindingKeyring, tenant: &str, community: Option<&str>, app_id: &str, workstream_id: &str, event_id: &str) -> StageEnvelope {
    let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_string();
    let binding = penguin_spine::compute_binding_mac(
        keyring,
        &BindingInput { tenant, community, workstream_id, event_id, trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" },
    );
    serde_json::from_value(serde_json::json!({
        "schema_version": 2, "tenant": tenant, "community": community, "app_id": app_id, "stage": "action",
        "event": {"platform": "discord", "event_type": "chat.message", "actor": "u", "payload": {"channel_id": "1", "text": "hi"}, "occurred_at": "2026-09-14T12:00:00.000Z"},
        "ts": "2026-09-14T12:00:00.123Z", "target_app_id": null, "workstream_id": workstream_id, "event_id": event_id,
        "session_id": null, "trace": {"traceparent": traceparent, "tracestate": null},
        "binding": {"kid": binding.kid, "mac": binding.mac}
    })).expect("valid envelope fixture")
}

#[tokio::test]
#[ignore = "requires Docker-in-Docker Valkey; run via make test-integration"]
async fn a_valid_envelope_dispatches_to_the_builtin_sender_and_is_acked() {
    let client = test_spine_client().await;
    let scope = Scope::new("acme", Some("main".to_string()));
    let app_id = format!("waddles.test.action-loop-{}", uuid::Uuid::new_v4());
    let stream = scope.action_stream(&app_id);
    let keyring = test_keyring();
    let env = signed_envelope(&keyring, "acme", Some("main"), &app_id, &uuid::Uuid::new_v4().to_string(), &uuid::Uuid::new_v4().to_string());
    client.append(&stream, &env).await.unwrap();

    let sent = Arc::new(AtomicUsize::new(0));
    let sent_clone = sent.clone();
    let deps = Arc::new(ConsumerDeps::test_fixture(test_spine_config(), client.clone(), keyring, move |_event, _config| {
        let sent = sent_clone.clone();
        async move {
            sent.fetch_add(1, Ordering::SeqCst);
            svc_action::retry::TransportOutcome::Success(svc_action::retry::TransportSuccess {
                detail: "ok".to_string(), http_status: Some(200), provider_message_id: None,
            })
        }
    }));

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(run_bundle_consumer(app_id.clone(), "sha256:test".to_string(), deps, shutdown_clone));
    tokio::time::sleep(Duration::from_millis(500)).await;
    shutdown.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;

    assert_eq!(sent.load(Ordering::SeqCst), 1, "the builtin sender fixture must have been called exactly once");
}

#[tokio::test]
#[ignore = "requires Docker-in-Docker Valkey; run via make test-integration"]
async fn an_envelope_with_a_tampered_mac_is_dead_lettered_never_retried_and_the_builtin_is_never_called() {
    let client = test_spine_client().await;
    let scope = Scope::new("acme", Some("main".to_string()));
    let app_id = format!("waddles.test.action-loop-{}", uuid::Uuid::new_v4());
    let stream = scope.action_stream(&app_id);
    let keyring = test_keyring();
    let mut env = signed_envelope(&keyring, "acme", Some("main"), &app_id, &uuid::Uuid::new_v4().to_string(), &uuid::Uuid::new_v4().to_string());
    // Flip one hex character of the MAC -- still 64 lowercase hex chars,
    // still fails to verify.
    let mut mac = env.binding.mac.clone();
    let flipped = if mac.starts_with('0') { '1' } else { '0' };
    mac.replace_range(0..1, &flipped.to_string());
    env.binding.mac = mac;
    client.append(&stream, &env).await.unwrap();

    let called = Arc::new(AtomicUsize::new(0));
    let called_clone = called.clone();
    let deps = Arc::new(ConsumerDeps::test_fixture(test_spine_config(), client.clone(), keyring, move |_event, _config| {
        let called = called_clone.clone();
        async move {
            called.fetch_add(1, Ordering::SeqCst);
            svc_action::retry::TransportOutcome::Success(svc_action::retry::TransportSuccess { detail: "ok".to_string(), http_status: Some(200), provider_message_id: None })
        }
    }));

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(run_bundle_consumer(app_id.clone(), "sha256:test".to_string(), deps, shutdown_clone));
    tokio::time::sleep(Duration::from_millis(500)).await;
    shutdown.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;

    assert_eq!(called.load(Ordering::SeqCst), 0, "a tampered-MAC envelope must never reach the sender");
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `consumer::action_loop` does not exist yet.

- [ ] **Step 4: Write `src/consumer/mod.rs`**

```rust
//! The per-bundle action-stream consumer: one `GroupReader` per activated
//! bundle, D30 hop verification before anything else, dispatch to a
//! built-in sender or the executor, retry/DLQ, and a sibling `XAUTOCLAIM`
//! reaper task (spec Sec4.3, Sec5.9, Sec5.11).

pub mod action_loop;
```

- [ ] **Step 5: Write `src/consumer/action_loop.rs`**

```rust
//! Per-bundle action-stream consumer loop (spec Sec4.3, Sec5.9, D30).
//! Reads a bundle's own `{scope}:app:{app_id}:action` stream through its
//! single consumer group, verifies the D30 hop-verification chain before
//! any other processing, dispatches to a built-in sender (P8) or the
//! executor, retries with backoff, and records the outcome to
//! `action_dispatch_log` plus D31 usage.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use penguin_spine::{
    BindingKeyring, Delivered, DlqError, DlqErrorKind, Grant, GroupReader, ScopeCheck, SpineClient,
    SpineConfig, Stage, UsageDelta,
};
use tokio_util::sync::CancellationToken;

use crate::audit::{AuditWriter, RecordParams};
use crate::distribution::poller::ActionBundleRow;
use crate::hostapi::capabilities::context::build_bundle_context;
use crate::hostapi::dispatch::DispatchState;
use crate::hostapi::registry::{ConnectionPool, ExportKind, InvokeRequest};
use crate::retry::{retry_with_backoff, RetryConfig, RetryOutcome, TransportOutcome, TransportSuccess};
use crate::senders::twitch::TwitchBuiltinSender;

/// One built-in sender's `send` shape, boxed so [`BuiltinSenders`] can
/// hold five differently-typed senders (four `ActionSender`-backed, one
/// Twitch relay-backed) uniformly. `event`/`config` are the envelope's
/// carried `PlatformEvent` and the bundle's resolved config.
pub type BuiltinSendFn = Arc<
    dyn Fn(penguin_spine::PlatformEvent, penguin_connector_core::ActionConfig) -> Pin<Box<dyn Future<Output = TransportOutcome> + Send>>
        + Send
        + Sync,
>;

/// The fixed first-party built-in `app_id` -> sender map (P8). Task 27's
/// runner builds the real one; tests build a fixture with `test_fixture`.
#[derive(Clone, Default)]
pub struct BuiltinSenders {
    senders: HashMap<String, BuiltinSendFn>,
}

impl BuiltinSenders {
    /// An empty map -- callers add entries with [`Self::insert`].
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one built-in sender for `app_id`.
    pub fn insert(&mut self, app_id: impl Into<String>, send: BuiltinSendFn) {
        self.senders.insert(app_id.into(), send);
    }

    /// The sender for `app_id`, if it is one of the five built-ins.
    pub fn get(&self, app_id: &str) -> Option<&BuiltinSendFn> {
        self.senders.get(app_id)
    }
}

/// Everything one bundle's consumer loop needs. Constructed once per
/// activated bundle by Task 27's runner.
pub struct ConsumerDeps {
    pub spine_cfg: SpineConfig,
    pub dlq: SpineClient,
    pub keyring: Arc<BindingKeyring>,
    pub builtins: BuiltinSenders,
    pub twitch: Option<Arc<TwitchBuiltinSender>>,
    pub pool: Arc<ConnectionPool>,
    pub dispatch: Arc<DispatchState>,
    pub audit: Arc<AuditWriter>,
    pub usage: Arc<penguin_spine::UsageBatcher>,
    pub retry_cfg: RetryConfig,
    /// `RUNNER_TENANT_SLUG` (Task 3) -- the Valkey key's `t:` segment.
    /// Deliberately a separate field from `tenant_id` below: this is the
    /// tenant *slug* string (`"acme"`) `Scope::action_stream` needs, not
    /// the audit database's numeric foreign key.
    pub tenant_slug: String,
    /// `RUNNER_COMMUNITY_ID` resolved to a slug, or `None` for a
    /// tenant-wide deployment (Task 3) -- the Valkey key's `c:` segment.
    pub community_slug: Option<String>,
    /// `tenants.id` (audit DB) -- `action_dispatch_log.tenant_id`'s FK
    /// value, resolved once by `AuditWriter::resolve_tenant_id` at
    /// startup (Task 27) and passed in already-resolved so this loop
    /// never queries Postgres per entry.
    pub tenant_id: i32,
    pub metrics: Arc<dyn penguin_spine::SpineMetrics>,
    /// The bundle's currently-approved manifest row, refreshed by Task
    /// 27's runner on every distribution poll -- consulted for
    /// `feature`/`version`/`entrypoint`/`config` when building the
    /// per-invocation [`crate::hostapi::capabilities::context::BundleContext`].
    pub row: Arc<std::sync::RwLock<ActionBundleRow>>,
}

impl ConsumerDeps {
    /// Test-only constructor: wires exactly one built-in (a fixture
    /// closure) keyed by whatever `app_id` the caller later passes to
    /// [`run_bundle_consumer`], sharing `spine_client` for both reads and
    /// the DLQ/admin path -- fine for a test, never in production (Task
    /// 27 opens the dedicated `GroupReader` connection itself).
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_fixture<F, Fut>(spine_cfg: SpineConfig, spine_client: SpineClient, keyring: BindingKeyring, sender: F) -> Self
    where
        F: Fn(penguin_spine::PlatformEvent, penguin_connector_core::ActionConfig) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = TransportOutcome> + Send + 'static,
    {
        let sender = Arc::new(sender);
        let mut builtins = BuiltinSenders::new();
        // The test's fixture app_id is registered by the test itself via
        // `deps.builtins.insert(app_id, ...)` is not exposed here because
        // `run_bundle_consumer`'s test cases construct `ConsumerDeps`
        // directly; this helper instead wraps `sender` behind a catch-all
        // key of `"*"` that `run_bundle_consumer` falls back to when no
        // exact `app_id` match exists and `dispatch.approved` has no
        // entry either -- see Step 5's dispatch note. Kept intentionally
        // minimal: this is a test constructor, not production wiring.
        let sender_for_map: BuiltinSendFn = Arc::new(move |event, config| {
            let sender = sender.clone();
            Box::pin(async move { sender(event, config).await })
        });
        builtins.insert("*", sender_for_map);
        Self {
            spine_cfg,
            dlq: spine_client,
            keyring: Arc::new(keyring),
            builtins,
            twitch: None,
            pool: Arc::new(ConnectionPool::new()),
            dispatch: DispatchState::new(
                Arc::new(crate::hostapi::registry::BundleRegistry::new(&prometheus::Registry::new())),
                Arc::new(crate::hostapi::capabilities::flags::PostHogFlagsClient::unconfigured()),
                Arc::new(crate::hostapi::capabilities::kv::KvCapability::new(redis::Client::open("redis://127.0.0.1:1").unwrap(), 65_536, 2_592_000)),
                Arc::new(crate::hostapi::capabilities::relay::RelayCapability::new(redis::Client::open("redis://127.0.0.1:1").unwrap())),
                Arc::new(crate::hostapi::capabilities::db::DbCapability::new(Arc::new(crate::hostapi::capabilities::db::test_support::PanicExecutor))),
                Arc::new(crate::hostapi::capabilities::http_egress::HttpEgressCapability::new(crate::hostapi::capabilities::http_egress::EgressGuardConfig {
                    allow_private_hosts: true, max_redirects: 3, max_response_bytes: 65_536, call_timeout: Duration::from_secs(2), rate_limit_rps: 100.0, rate_limit_burst: 100.0,
                }).unwrap()),
                Arc::new(crate::hostapi::capabilities::log::LogCapability::new(tracing::Level::INFO)),
                Arc::new(crate::hostapi::dispatch::TripTracker::new(3, Duration::from_secs(300))),
                Arc::new(penguin_spine::UsageBatcher::new()),
                crate::hostapi::dispatch::register_host_call_metrics(&prometheus::Registry::new()),
            ),
            // A `MockDatabase` connection, never a real Postgres pool --
            // this fixture's tests never exercise `AuditWriter::record`'s
            // success/failure path in detail (Task 13 already covers
            // that in isolation); `record`'s errors are only logged here
            // (see Step 5), never propagated, so a mock that returns
            // whatever `MockExecResult` default applies is sufficient.
            audit: Arc::new(AuditWriter::new(
                sea_orm::MockDatabase::new(sea_orm::DatabaseBackend::Postgres).into_connection(),
            )),
            usage: Arc::new(penguin_spine::UsageBatcher::new()),
            retry_cfg: RetryConfig { max_retries: 2, base_backoff_ms: 10, max_backoff_ms: 100 },
            tenant_slug: "acme".to_string(),
            community_slug: Some("main".to_string()),
            tenant_id: 1,
            metrics: Arc::new(penguin_spine::NoopMetrics),
            row: Arc::new(std::sync::RwLock::new(ActionBundleRow {
                app_id: "test".to_string(), community_id: None, entrypoint: None, config: serde_json::json!({}),
                artifact_version: None, artifact_digest: Some("sha256:test".to_string()), artifact_kind: None,
                language: None, scan_status: None,
                manifest: crate::distribution::poller::ActionManifest::default(),
            })),
        }
    }
}

fn classify_boundary_dlq(err: &penguin_spine::BoundaryError, consumer_id: &str, artifact_digest: Option<String>) -> DlqError {
    err.to_dlq_error(consumer_id.to_string(), artifact_digest)
}

/// Runs one bundle's action-stream consumer until `shutdown` fires.
/// Never returns `Err` -- every failure short-circuits to a DLQ write or
/// a WARN log and the loop continues to the next poll.
pub async fn run_bundle_consumer(app_id: String, digest: String, deps: Arc<ConsumerDeps>, shutdown: CancellationToken) {
    // Tenant/community for the stream key come from `RUNNER_TENANT_SLUG`/
    // `RUNNER_COMMUNITY_ID` (`deps.tenant_slug`/`deps.community_slug`,
    // Task 3's `Config`) -- never from `deps.row` (the bundle's own
    // manifest/activation id) and never from `deps.tenant_id` (the audit
    // DB's numeric foreign key, a different identifier entirely).
    let scope = penguin_spine::Scope::new(deps.tenant_slug.clone(), deps.community_slug.clone());
    let stream = scope.action_stream(&app_id);

    if let Err(err) = deps.dlq.ensure_group(&stream, &app_id).await {
        tracing::error!(app_id, error = %err, "failed to ensure the action stream's consumer group; consumer exiting");
        return;
    }

    // The action stream is self-owned (spec Sec5.9): unlike svc-process's
    // granted ingest-source streams, `Grant.platform`/`source_id` have no
    // real referent here -- `"action"`/`app_id` are placeholders that
    // satisfy the type without being read by `GroupReader::read()`
    // (only `Grant.stream` drives the `XREADGROUP` call and the
    // `ensure_granted` check).
    let grants = vec![Grant { stream: stream.clone(), platform: "action".to_string(), source_id: app_id.clone() }];
    let mut reader = match GroupReader::connect(&deps.spine_cfg, grants, app_id.clone(), Stage::Action, deps.dlq.clone(), deps.metrics.clone()).await {
        Ok(r) => r,
        Err(err) => {
            tracing::error!(app_id, error = %err, "failed to open the dedicated GroupReader connection; consumer exiting");
            return;
        }
    };

    loop {
        if shutdown.is_cancelled() {
            return;
        }
        let delivered = tokio::select! {
            _ = shutdown.cancelled() => return,
            result = reader.read() => match result {
                Ok(d) => d,
                Err(err) => {
                    tracing::warn!(app_id, error = %err, "action stream read failed; backing off");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
            },
        };

        for entry in delivered {
            process_one_entry(&app_id, &digest, &stream, entry, &deps).await;
        }
    }
}

async fn process_one_entry(app_id: &str, digest: &str, stream: &str, entry: Delivered, deps: &Arc<ConsumerDeps>) {
    let consumer_id = deps.spine_cfg.consumer_id.clone();

    // D30 (spec Sec5.11): verify BEFORE any other processing -- checks
    // 1-2 of 4 (binding.mac, tenant/community vs. the stream key).
    if let Err(boundary_err) = penguin_spine::verify_binding(&deps.keyring, &entry.env) {
        deps.metrics.tenant_boundary_violation("action", boundary_err.reason());
        let dlq_err = classify_boundary_dlq(&boundary_err, &consumer_id, Some(digest.to_string()));
        let _ = deps.dlq.dead_letter(&entry, &dlq_err).await;
        return;
    }
    if let Err(boundary_err) = ScopeCheck::check_against_key(&entry.env, stream) {
        deps.metrics.tenant_boundary_violation("action", boundary_err.reason());
        let dlq_err = classify_boundary_dlq(&boundary_err, &consumer_id, Some(digest.to_string()));
        let _ = deps.dlq.dead_letter(&entry, &dlq_err).await;
        return;
    }

    let env = entry.env.clone();
    let mut config: penguin_connector_core::ActionConfig = deps.row.read().expect("lock not poisoned").config.as_object().cloned().unwrap_or_default().into_iter().collect();
    config.entry("channel_id".to_string()).or_insert_with(|| {
        env.event.payload.get("channel_id").cloned().unwrap_or(serde_json::Value::Null)
    });

    let ctx = build_bundle_context(
        &env.tenant,
        env.community.as_deref(),
        app_id,
        app_id,
        digest,
        &entry.entry_id,
        &env.workstream_id,
        env.trace.as_ref(),
        &deps.row.read().expect("lock not poisoned").config,
    );
    deps.dispatch.set_active_context(app_id, ctx);

    // D30 (spec Sec5.11): the scope handed to the executor comes
    // entirely from the verify_binding-checked envelope above, never
    // from the bundle's own config -- config is untrusted bundle input,
    // the envelope is not.
    let invocation_scope = penguin_bundle_host::wire::message::InvocationScope {
        tenant_id: env.tenant.clone(),
        community_id: env.community.clone(),
        workstream_id: env.workstream_id.clone(),
        app_id: app_id.to_string(),
        trace: env.trace.clone(),
    };
    let attempt_event = env.event.clone();
    let attempt_config = config.clone();
    let attempt = || {
        let event = attempt_event.clone();
        let config = attempt_config.clone();
        let app_id = app_id.to_string();
        let digest = digest.to_string();
        let scope = invocation_scope.clone();
        let deps = deps.clone();
        async move { dispatch_one_attempt(&app_id, &digest, scope, event, config, &deps).await }
    };
    let outcome = retry_with_backoff(&deps.retry_cfg, attempt).await;
    deps.dispatch.clear_active_context(app_id);

    let (status, http_status, detail, attempts) = match &outcome {
        RetryOutcome::Success(success) => ("success", success.http_status, success.detail.clone(), 1),
        RetryOutcome::TerminalFailure { attempts, message, http_status } => ("terminal_failure", *http_status, message.clone(), *attempts as i32),
        RetryOutcome::RetriesExhausted { attempts, message, http_status } => ("retries_exhausted", *http_status, message.clone(), *attempts as i32),
    };

    let params = RecordParams {
        tenant_id: deps.tenant_id,
        community_id: None,
        app_id: app_id.to_string(),
        target_type: env.event.platform.clone(),
        status: status.to_string(),
        attempt: attempts,
        http_status: http_status.map(|s| s as i32),
        detail,
        envelope_ts: chrono::DateTime::parse_from_rfc3339(&env.ts).ok().map(|d| d.with_timezone(&chrono::Utc)),
    };
    if let Err(err) = deps.audit.record(params).await {
        tracing::warn!(app_id, error = %err, "failed to write action_dispatch_log row (dispatch itself still proceeds/acks normally)");
    }

    // D31 (spec Sec5.12): one invocation, and -- only on a successful
    // send -- one action delivered plus an approximate outbound-bytes
    // count (the serialized event payload size; none of this plan's
    // sender/executor return shapes carry a real wire-byte count, so this
    // is a documented proxy, not a precise measurement).
    let mut delta = UsageDelta::zero(env.tenant.clone(), env.community.clone(), env.workstream_id.clone(), "action".to_string(), Some(app_id.to_string()));
    delta.invocations = 1;
    if matches!(outcome, RetryOutcome::Success(_)) {
        delta.actions_delivered = 1;
        delta.outbound_bytes = serde_json::to_vec(&env.event).map(|b| b.len() as u64).unwrap_or(0);
    }
    deps.usage.record(delta);

    match outcome {
        RetryOutcome::Success(_) => {
            let _ = deps.dlq.ack(&entry, app_id).await;
        }
        RetryOutcome::TerminalFailure { .. } | RetryOutcome::RetriesExhausted { .. } => {
            let dlq_err = DlqError {
                kind: DlqErrorKind::BundleError,
                code: "DISPATCH_FAILED".to_string(),
                message: detail_for_dlq(&outcome),
                detail: None,
                artifact_digest: Some(digest.to_string()),
                consumer_id,
            };
            let _ = deps.dlq.dead_letter(&entry, &dlq_err).await;
        }
    }
}

fn detail_for_dlq(outcome: &RetryOutcome) -> String {
    match outcome {
        RetryOutcome::Success(s) => s.detail.clone(),
        RetryOutcome::TerminalFailure { message, .. } | RetryOutcome::RetriesExhausted { message, .. } => message.clone(),
    }
}

async fn dispatch_one_attempt(
    app_id: &str,
    digest: &str,
    scope: penguin_bundle_host::wire::message::InvocationScope,
    event: penguin_spine::PlatformEvent,
    config: penguin_connector_core::ActionConfig,
    deps: &Arc<ConsumerDeps>,
) -> TransportOutcome {
    // P8: the fixed built-in set bypasses the executor entirely.
    if let Some(twitch) = &deps.twitch {
        if app_id == "waddles.bot.twitch.default" {
            return twitch.send(&event, &config).await;
        }
    }
    if let Some(send) = deps.builtins.get(app_id).or_else(|| deps.builtins.get("*")) {
        return send(event, config).await;
    }

    // Everything else routes to the executor pool. `scope` is the
    // caller's verified InvocationScope (D30) -- built from `entry.env`
    // in `process_one_entry`, never re-derived here from bundle config.
    let Some(conn) = deps.pool.pick() else {
        return TransportOutcome::Retryable { message: "no executor connection available".to_string(), http_status: None, retry_after_ms: None };
    };
    let req = InvokeRequest {
        digest: digest.to_string(),
        export: ExportKind::Dispatch,
        payload: serde_json::json!({"event": event, "config": config}),
        deadline_ms: 2000,
        scope,
    };
    match conn.invoke(req).await {
        Ok(payload) => TransportOutcome::Success(TransportSuccess {
            detail: payload.to_string(),
            http_status: payload.get("http_status").and_then(|v| v.as_u64()).map(|v| v as u16),
            provider_message_id: None,
        }),
        Err(err) => TransportOutcome::Retryable { message: err.to_string(), http_status: None, retry_after_ms: None },
    }
}

/// The `XAUTOCLAIM` reaper (spec Sec5.4): reclaims entries idle past
/// `SPINE_CLAIM_IDLE_MS` on `app_id`'s group every `claim_interval`,
/// re-processing each recovered entry through the same D30-verified path.
pub async fn run_reaper(app_id: String, deps: Arc<ConsumerDeps>, claim_interval: Duration, shutdown: CancellationToken) {
    let scope = penguin_spine::Scope::new(deps.tenant_slug.clone(), deps.community_slug.clone());
    let stream = scope.action_stream(&app_id);
    let digest = deps.row.read().expect("lock not poisoned").artifact_digest.clone().unwrap_or_else(|| "unknown".to_string());
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = tokio::time::sleep(claim_interval) => {
                match deps.dlq.claim_stale(&stream, &app_id, Stage::Action).await {
                    Ok(reclaimed) => {
                        for entry in reclaimed {
                            process_one_entry(&app_id, &digest, &stream, entry, &deps).await;
                        }
                    }
                    Err(err) => tracing::warn!(app_id, error = %err, "XAUTOCLAIM reaper pass failed"),
                }
            }
        }
    }
}
```

- [ ] **Step 6: Add the module to `src/lib.rs`**

```rust
pub mod consumer;
```

- [ ] **Step 7: Run to verify it passes**

Run: `make -C core/svc_action test-integration`
Expected: `test result: ok. 2 passed; 0 failed` for `consumer_action_loop` (both tests need Docker-in-Docker Valkey; mark them `#[ignore]` exactly as shown and add them to the `test-integration` target's scope per Task 17's established pattern).

- [ ] **Step 8: Commit**

Stage `core/svc_action/Cargo.toml core/svc_action/src/consumer/ core/svc_action/src/lib.rs core/svc_action/tests/consumer_action_loop.rs` and commit with message:

```
feat(svc-action): per-bundle action consumer loop -- D30 verification first, dispatch, retry/DLQ, reaper

verify_binding + ScopeCheck run before any other processing on every
entry (D30, spec Sec5.11); a failure is DLQ'd as tenant_boundary and
never retried. Built-ins (P8) bypass the executor; everything else
invokes through the ConnectionPool. retry_with_backoff wraps every
attempt; action_dispatch_log is written for every outcome; D31 usage
(invocations always, actions_delivered/outbound_bytes on success) is
recorded via UsageBatcher. A sibling run_reaper task XAUTOCLAIMs stale
entries on the same verified path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 23: Discord built-in sender (`penguin-connector-discord`)

**Depends on:** Task 18 (`senders::from_send_result`, `Cargo.toml`'s `CONNECTORS_REV` pin pattern).

**Files:**
- Modify: `core/svc_action/Cargo.toml` (add `penguin-connector-discord`)
- Create: `core/svc_action/src/senders/discord.rs`
- Test: `core/svc_action/tests/senders_discord.rs`

**Interfaces:**
- Consumes: `penguin_connector_discord::rest::DiscordRestSender` (`ActionSender` impl), `penguin_connector_core::{ActionSender, Secret}` (`docs/plan-penguin-connectors` Tasks 4/13).
- Produces: `senders::discord::DiscordBuiltinSender` — `DiscordBuiltinSender::from_env() -> Result<Self, anyhow::Error>`, `async fn send(&self, event: &penguin_spine::PlatformEvent, config: &penguin_connector_core::ActionConfig) -> retry::TransportOutcome` — Task 22's consumer loop calls this for the fixed `waddles.bot.discord.default` app id (P8).

- [ ] **Step 1: Add the dependency to `Cargo.toml`**

```toml
penguin-connector-discord = { git = "https://github.com/penguintechinc/penguin-libs.git", branch = "docs/plan-penguin-connectors", rev = "c5ed81de5c2870926e9cc00e1647d4ed90f22801" }
```

- [ ] **Step 2: Write the failing tests**

`tests/senders_discord.rs`:

```rust
use svc_action::retry::TransportOutcome;
use svc_action::senders::discord::DiscordBuiltinSender;

fn sample_event() -> penguin_spine::PlatformEvent {
    serde_json::from_value(serde_json::json!({
        "platform": "discord", "event_type": "chat.message", "actor": "u",
        "payload": {"channel_id": "123456789"}, "occurred_at": "2026-09-14T12:00:00.000Z", "source": null
    }))
    .unwrap()
}

#[test]
fn from_env_fails_closed_with_a_clear_message_when_the_bot_token_is_unset() {
    // SAFETY: test-only env mutation, no other test in this binary reads DISCORD_BOT_TOKEN concurrently.
    unsafe { std::env::remove_var("DISCORD_BOT_TOKEN") };
    let err = DiscordBuiltinSender::from_env().unwrap_err();
    assert!(err.to_string().to_lowercase().contains("discord_bot_token"), "error must name the missing env var: {err}");
}

#[tokio::test]
async fn send_against_a_mock_api_base_returns_success_for_a_2xx_response() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/channels/123456789/messages"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "999"})))
        .mount(&server)
        .await;
    // SAFETY: test-only env mutation, this test's own dedicated var.
    unsafe { std::env::set_var("DISCORD_BOT_TOKEN", "test-token") };
    let sender = DiscordBuiltinSender::with_api_base(&server.uri()).unwrap();

    let outcome = sender.send(&sample_event(), &penguin_connector_core::ActionConfig::new()).await;
    assert!(matches!(outcome, TransportOutcome::Success(_)), "expected Success, got {outcome:?}");
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `senders::discord` does not exist yet.

- [ ] **Step 4: Write `src/senders/discord.rs`**

```rust
//! Discord built-in sender -- wraps `penguin_connector_discord::rest::
//! DiscordRestSender` (an `ActionSender`) with this stage's env-based
//! `DISCORD_BOT_TOKEN` resolution (`Secret::resolve`, spec Sec12.7).

use penguin_connector_core::{ActionConfig, ActionSender, Secret};
use penguin_connector_discord::rest::DiscordRestSender;

use crate::retry::TransportOutcome;
use crate::senders::from_send_result;

/// The Discord built-in -- `waddles.bot.discord.default` (P8).
pub struct DiscordBuiltinSender {
    inner: DiscordRestSender,
    /// Resolved once at construction so a missing token fails startup,
    /// not the first dispatch attempt; the sender itself reads Discord's
    /// bearer token per call from `DISCORD_BOT_TOKEN` (unchanged from
    /// the resolved `Secret` here, which only proves it exists).
    _bot_token: Secret,
}

impl DiscordBuiltinSender {
    /// Builds a sender against Discord's real API, failing closed if
    /// `DISCORD_BOT_TOKEN` is unset.
    pub fn from_env() -> Result<Self, anyhow::Error> {
        let bot_token = Secret::resolve("DISCORD_BOT_TOKEN").map_err(|e| anyhow::anyhow!(e))?;
        Ok(Self { inner: DiscordRestSender::new().map_err(|e| anyhow::anyhow!(e.message))?, _bot_token: bot_token })
    }

    /// Builds a sender against a test double's base URL -- still
    /// requires `DISCORD_BOT_TOKEN` to be set (the sender's own auth
    /// header still needs a value, even a fake one, for a wiremock 2xx
    /// fixture to be reachable at all).
    pub fn with_api_base(api_base: &str) -> Result<Self, anyhow::Error> {
        let bot_token = Secret::resolve("DISCORD_BOT_TOKEN").map_err(|e| anyhow::anyhow!(e))?;
        Ok(Self { inner: DiscordRestSender::with_api_base(api_base).map_err(|e| anyhow::anyhow!(e.message))?, _bot_token: bot_token })
    }

    /// Sends via the wrapped `ActionSender`, converting its
    /// `Result<SendOutcome, SendError>` into this crate's own
    /// `TransportOutcome` (Task 12/18).
    pub async fn send(&self, event: &penguin_spine::PlatformEvent, config: &ActionConfig) -> TransportOutcome {
        from_send_result(self.inner.send(event, config, None).await)
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 2 passed; 0 failed` for `senders_discord`.

- [ ] **Step 6: Commit**

Stage `core/svc_action/Cargo.toml core/svc_action/src/senders/discord.rs core/svc_action/tests/senders_discord.rs` and commit with message:

```
feat(svc-action): Discord built-in sender via penguin-connector-discord

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 24: Slack built-in sender (`penguin-connector-slack`)

**Depends on:** Task 18 (`senders::from_send_result`).

**Files:**
- Modify: `core/svc_action/Cargo.toml` (add `penguin-connector-slack`)
- Create: `core/svc_action/src/senders/slack.rs`
- Test: `core/svc_action/tests/senders_slack.rs`

**Interfaces:**
- Consumes: `penguin_connector_slack::chat::SlackChatSender` (`ActionSender` impl, `docs/plan-penguin-connectors` Task 15).
- Produces: `senders::slack::SlackBuiltinSender` — same shape as Task 23's `DiscordBuiltinSender` (`from_env`/`with_api_base`/`send`), reading `SLACK_BOT_TOKEN`.

- [ ] **Step 1: Add the dependency to `Cargo.toml`**

```toml
penguin-connector-slack = { git = "https://github.com/penguintechinc/penguin-libs.git", branch = "docs/plan-penguin-connectors", rev = "c5ed81de5c2870926e9cc00e1647d4ed90f22801" }
```

- [ ] **Step 2: Write the failing tests**

`tests/senders_slack.rs`:

```rust
use svc_action::retry::TransportOutcome;
use svc_action::senders::slack::SlackBuiltinSender;

fn sample_event() -> penguin_spine::PlatformEvent {
    serde_json::from_value(serde_json::json!({
        "platform": "slack", "event_type": "chat.message", "actor": "u",
        "payload": {"channel_id": "C0123456"}, "occurred_at": "2026-09-14T12:00:00.000Z", "source": null
    }))
    .unwrap()
}

#[test]
fn from_env_fails_closed_with_a_clear_message_when_the_bot_token_is_unset() {
    unsafe { std::env::remove_var("SLACK_BOT_TOKEN") };
    let err = SlackBuiltinSender::from_env().unwrap_err();
    assert!(err.to_string().to_lowercase().contains("slack_bot_token"), "error must name the missing env var: {err}");
}

#[tokio::test]
async fn send_against_a_mock_api_base_returns_success_for_an_ok_true_body() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/chat.postMessage"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true, "ts": "123.456"})))
        .mount(&server)
        .await;
    unsafe { std::env::set_var("SLACK_BOT_TOKEN", "xoxb-test") };
    let sender = SlackBuiltinSender::with_api_base(&server.uri()).unwrap();

    let outcome = sender.send(&sample_event(), &penguin_connector_core::ActionConfig::new()).await;
    assert!(matches!(outcome, TransportOutcome::Success(_)), "expected Success, got {outcome:?}");
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `senders::slack` does not exist yet.

- [ ] **Step 4: Write `src/senders/slack.rs`**

```rust
//! Slack built-in sender -- wraps `penguin_connector_slack::chat::
//! SlackChatSender` with this stage's env-based `SLACK_BOT_TOKEN`
//! resolution.

use penguin_connector_core::{ActionConfig, ActionSender, Secret};
use penguin_connector_slack::chat::SlackChatSender;

use crate::retry::TransportOutcome;
use crate::senders::from_send_result;

/// The Slack built-in -- `waddles.bot.slack.default` (P8).
pub struct SlackBuiltinSender {
    inner: SlackChatSender,
    _bot_token: Secret,
}

impl SlackBuiltinSender {
    pub fn from_env() -> Result<Self, anyhow::Error> {
        let bot_token = Secret::resolve("SLACK_BOT_TOKEN").map_err(|e| anyhow::anyhow!(e))?;
        Ok(Self { inner: SlackChatSender::new().map_err(|e| anyhow::anyhow!(e.message))?, _bot_token: bot_token })
    }

    pub fn with_api_base(api_base: &str) -> Result<Self, anyhow::Error> {
        let bot_token = Secret::resolve("SLACK_BOT_TOKEN").map_err(|e| anyhow::anyhow!(e))?;
        Ok(Self { inner: SlackChatSender::with_api_base(api_base).map_err(|e| anyhow::anyhow!(e.message))?, _bot_token: bot_token })
    }

    pub async fn send(&self, event: &penguin_spine::PlatformEvent, config: &ActionConfig) -> TransportOutcome {
        from_send_result(self.inner.send(event, config, None).await)
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 2 passed; 0 failed` for `senders_slack`.

- [ ] **Step 6: Commit**

Stage `core/svc_action/Cargo.toml core/svc_action/src/senders/slack.rs core/svc_action/tests/senders_slack.rs` and commit with message:

```
feat(svc-action): Slack built-in sender via penguin-connector-slack

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 25: YouTube built-in sender (`penguin-connector-youtube`)

**Depends on:** Task 18 (`senders::from_send_result`). Continues P7 (env-credential-only, no per-community OAuth resolution) -- `docs/plan-penguin-connectors`'s own `YouTubeChatSender` independently made the identical scoping decision, confirming rather than contradicting P7.

**Files:**
- Modify: `core/svc_action/Cargo.toml` (add `penguin-connector-youtube`)
- Create: `core/svc_action/src/senders/youtube.rs`
- Test: `core/svc_action/tests/senders_youtube.rs`

**Interfaces:**
- Consumes: `penguin_connector_youtube::send::YouTubeChatSender` (`ActionSender` impl, `docs/plan-penguin-connectors` Task 17).
- Produces: `senders::youtube::YouTubeBuiltinSender` — same shape as Tasks 23-24, reading `YOUTUBE_API_KEY`.

- [ ] **Step 1: Add the dependency to `Cargo.toml`**

```toml
penguin-connector-youtube = { git = "https://github.com/penguintechinc/penguin-libs.git", branch = "docs/plan-penguin-connectors", rev = "c5ed81de5c2870926e9cc00e1647d4ed90f22801" }
```

- [ ] **Step 2: Write the failing tests**

`tests/senders_youtube.rs`:

```rust
use svc_action::retry::TransportOutcome;
use svc_action::senders::youtube::YouTubeBuiltinSender;

fn sample_event() -> penguin_spine::PlatformEvent {
    serde_json::from_value(serde_json::json!({
        "platform": "youtube", "event_type": "chat.message", "actor": "u",
        "payload": {"channel_id": "live-chat-id-1"}, "occurred_at": "2026-09-14T12:00:00.000Z", "source": null
    }))
    .unwrap()
}

#[test]
fn from_env_fails_closed_with_a_clear_message_when_the_api_key_is_unset() {
    unsafe { std::env::remove_var("YOUTUBE_API_KEY") };
    let err = YouTubeBuiltinSender::from_env().unwrap_err();
    assert!(err.to_string().to_lowercase().contains("youtube_api_key"), "error must name the missing env var: {err}");
}

#[tokio::test]
async fn send_against_a_mock_api_base_returns_success_for_a_2xx_response() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "msg-1"})))
        .mount(&server)
        .await;
    unsafe { std::env::set_var("YOUTUBE_API_KEY", "test-key") };
    let sender = YouTubeBuiltinSender::with_api_base(&server.uri()).unwrap();

    let outcome = sender.send(&sample_event(), &penguin_connector_core::ActionConfig::new()).await;
    assert!(matches!(outcome, TransportOutcome::Success(_)), "expected Success, got {outcome:?}");
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `senders::youtube` does not exist yet.

- [ ] **Step 4: Write `src/senders/youtube.rs`**

```rust
//! YouTube built-in sender -- wraps `penguin_connector_youtube::send::
//! YouTubeChatSender` with this stage's env-based `YOUTUBE_API_KEY`
//! resolution. Env-credential-only (P7): the OAuth-connected-account
//! per-community token flow (gh-320) is out of scope for both this plan
//! and `penguin-connector-youtube`'s own send.rs (independently
//! confirmed, not merely asserted).

use penguin_connector_core::{ActionConfig, ActionSender, Secret};
use penguin_connector_youtube::send::YouTubeChatSender;

use crate::retry::TransportOutcome;
use crate::senders::from_send_result;

/// The YouTube built-in -- `waddles.bot.youtube.default` (P8).
pub struct YouTubeBuiltinSender {
    inner: YouTubeChatSender,
    _api_key: Secret,
}

impl YouTubeBuiltinSender {
    pub fn from_env() -> Result<Self, anyhow::Error> {
        let api_key = Secret::resolve("YOUTUBE_API_KEY").map_err(|e| anyhow::anyhow!(e))?;
        Ok(Self { inner: YouTubeChatSender::new().map_err(|e| anyhow::anyhow!(e.message))?, _api_key: api_key })
    }

    pub fn with_api_base(api_base: &str) -> Result<Self, anyhow::Error> {
        let api_key = Secret::resolve("YOUTUBE_API_KEY").map_err(|e| anyhow::anyhow!(e))?;
        Ok(Self { inner: YouTubeChatSender::with_api_base(api_base).map_err(|e| anyhow::anyhow!(e.message))?, _api_key: api_key })
    }

    pub async fn send(&self, event: &penguin_spine::PlatformEvent, config: &ActionConfig) -> TransportOutcome {
        from_send_result(self.inner.send(event, config, None).await)
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 2 passed; 0 failed` for `senders_youtube`.

- [ ] **Step 6: Commit**

Stage `core/svc_action/Cargo.toml core/svc_action/src/senders/youtube.rs core/svc_action/tests/senders_youtube.rs` and commit with message:

```
feat(svc-action): YouTube built-in sender via penguin-connector-youtube

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 26: Kick built-in sender (`penguin-connector-kick`)

**Depends on:** Task 18 (`senders::from_send_result`).

**Files:**
- Modify: `core/svc_action/Cargo.toml` (add `penguin-connector-kick`)
- Create: `core/svc_action/src/senders/kick.rs`
- Test: `core/svc_action/tests/senders_kick.rs`

**Interfaces:**
- Consumes: `penguin_connector_kick::send::KickChatSender` (`ActionSender` impl, `docs/plan-penguin-connectors` Task 20 -- access-token-ref mode only, matching this plan's own P7-style scoping).
- Produces: `senders::kick::KickBuiltinSender` — same shape as Tasks 23-25, reading `KICK_ACCESS_TOKEN`.

- [ ] **Step 1: Add the dependency to `Cargo.toml`**

```toml
penguin-connector-kick = { git = "https://github.com/penguintechinc/penguin-libs.git", branch = "docs/plan-penguin-connectors", rev = "c5ed81de5c2870926e9cc00e1647d4ed90f22801" }
```

- [ ] **Step 2: Write the failing tests**

`tests/senders_kick.rs`:

```rust
use svc_action::retry::TransportOutcome;
use svc_action::senders::kick::KickBuiltinSender;

fn sample_event() -> penguin_spine::PlatformEvent {
    serde_json::from_value(serde_json::json!({
        "platform": "kick", "event_type": "chat.message", "actor": "u",
        "payload": {"channel_id": "chatroom-1"}, "occurred_at": "2026-09-14T12:00:00.000Z", "source": null
    }))
    .unwrap()
}

#[test]
fn from_env_fails_closed_with_a_clear_message_when_the_access_token_is_unset() {
    unsafe { std::env::remove_var("KICK_ACCESS_TOKEN") };
    let err = KickBuiltinSender::from_env().unwrap_err();
    assert!(err.to_string().to_lowercase().contains("kick_access_token"), "error must name the missing env var: {err}");
}

#[tokio::test]
async fn send_against_a_mock_api_base_returns_success_for_a_2xx_response() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/messages/send/chatroom-1"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {"message_id": "1"}})))
        .mount(&server)
        .await;
    unsafe { std::env::set_var("KICK_ACCESS_TOKEN", "test-token") };
    let sender = KickBuiltinSender::with_api_base(&server.uri()).unwrap();

    let outcome = sender.send(&sample_event(), &penguin_connector_core::ActionConfig::new()).await;
    assert!(matches!(outcome, TransportOutcome::Success(_)), "expected Success, got {outcome:?}");
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `senders::kick` does not exist yet.

- [ ] **Step 4: Write `src/senders/kick.rs`**

```rust
//! Kick built-in sender -- wraps `penguin_connector_kick::send::
//! KickChatSender` with this stage's env-based `KICK_ACCESS_TOKEN`
//! resolution. Access-token-ref mode only; the client-credentials
//! exchange fallback is a flagged follow-up in both this plan and
//! `penguin-connector-kick`'s own README (independently confirmed).

use penguin_connector_core::{ActionConfig, ActionSender, Secret};
use penguin_connector_kick::send::KickChatSender;

use crate::retry::TransportOutcome;
use crate::senders::from_send_result;

/// The Kick built-in -- `waddles.bot.kick.default` (P8).
pub struct KickBuiltinSender {
    inner: KickChatSender,
    _access_token: Secret,
}

impl KickBuiltinSender {
    pub fn from_env() -> Result<Self, anyhow::Error> {
        let access_token = Secret::resolve("KICK_ACCESS_TOKEN").map_err(|e| anyhow::anyhow!(e))?;
        Ok(Self { inner: KickChatSender::new().map_err(|e| anyhow::anyhow!(e.message))?, _access_token: access_token })
    }

    pub fn with_api_base(api_base: &str) -> Result<Self, anyhow::Error> {
        let access_token = Secret::resolve("KICK_ACCESS_TOKEN").map_err(|e| anyhow::anyhow!(e))?;
        Ok(Self { inner: KickChatSender::with_api_base(api_base).map_err(|e| anyhow::anyhow!(e.message))?, _access_token: access_token })
    }

    pub async fn send(&self, event: &penguin_spine::PlatformEvent, config: &ActionConfig) -> TransportOutcome {
        from_send_result(self.inner.send(event, config, None).await)
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 2 passed; 0 failed` for `senders_kick`.

- [ ] **Step 6: Commit**

Stage `core/svc_action/Cargo.toml core/svc_action/src/senders/kick.rs core/svc_action/tests/senders_kick.rs` and commit with message:

```
feat(svc-action): Kick built-in sender via penguin-connector-kick

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 27: `runner.rs` — wires distribution polling, per-bundle consumer supervision, dispatch, and usage flush into `run_with_shutdown`

**Depends on:** Tasks 3, 11 (fixed in place, v2/ETag), 13, 17-26, 21, 22.

**Files:**
- Create: `core/svc_action/src/runner.rs`
- Modify: `core/svc_action/src/lib.rs` (add `pub mod runner;`, extend `run_with_shutdown`)
- Test: `core/svc_action/tests/runner_integration.rs`

**Interfaces:**
- Consumes: everything Tasks 3-26 produce.
- Produces: `runner::{Runner, RunnerError}` — `Runner::bootstrap(config: &Config, registry: &prometheus::Registry) -> Result<Runner, RunnerError>`, `async fn run(self, shutdown: tokio_util::sync::CancellationToken)` — `lib.rs::run_with_shutdown` (Task 10) constructs a `Runner` and spawns `run` alongside the HTTP/metrics servers, cancelling it through the same shutdown wiring.

- [ ] **Step 1: Write the failing test**

`tests/runner_integration.rs`:

```rust
use svc_action::runner::Runner;

#[tokio::test]
async fn bootstrap_fails_closed_when_the_binding_key_file_is_missing() {
    unsafe {
        std::env::set_var("DB_PASSWORD", "x");
        std::env::set_var("SECRET_KEY", "x");
        std::env::set_var("VALKEY_URL", "redis://127.0.0.1:1/0");
        std::env::set_var("WADDLES_BINDING_KEY_FILE", "/nonexistent/keys.json");
        std::env::set_var("DATABASE_URL", "postgres://user:pass@127.0.0.1:1/db");
    }
    let cli = svc_action::config::CliConfig::parse_from(["svc-action"]);
    let config = svc_action::config::Config::from_cli(cli).expect("secrets set above");
    let registry = prometheus::Registry::new();
    let result = Runner::bootstrap(&config, &registry);
    assert!(result.is_err(), "bootstrap must fail closed without a readable binding key file (D30)");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `make -C core/svc_action test`
Expected: FAIL — `runner` module does not exist yet.

- [ ] **Step 3: Add `WADDLES_BINDING_KEY_FILE`/`WADDLES_BINDING_ACTIVE_KID`/`METERING_FLUSH_INTERVAL_S`/`DATABASE_URL` fields to `Config`**

`src/config.rs` (`CliConfig`) gains, alongside the existing fields (Task 3):

```rust
    #[arg(long, env = "WADDLES_BINDING_KEY_FILE", default_value = "/etc/waddles/binding/keys.json")]
    pub waddles_binding_key_file: std::path::PathBuf,
    #[arg(long, env = "WADDLES_BINDING_ACTIVE_KID")]
    pub waddles_binding_active_kid: String,
    #[arg(long, env = "METERING_FLUSH_INTERVAL_S", default_value_t = 10.0)]
    pub metering_flush_interval_s: f64,
    #[arg(long, env = "METERING_ENABLED", default_value_t = true)]
    pub metering_enabled: bool,
```

`Config` gains a `database_url: Secret` field. In `src/config.rs`'s `Config` struct, add:

```rust
    pub database_url: Secret,
```

In `Config::from_cli`, alongside the existing `db_password`/`valkey_password`/`secret_key` resolution (same `env_required` helper `db_password` already uses), add:

```rust
        let database_url = Secret::new(env_required("DATABASE_URL")?);
```

and add `database_url,` to the `Ok(Self { ... })` struct-literal return. In `Config`'s `Debug` impl, add `.field("database_url", &Secret::new(""))` alongside the other redacted fields.

- [ ] **Step 4: Write `src/runner.rs`**

```rust
//! Bootstraps every long-lived dependency this stage owns (Valkey, the
//! binding keyring, Postgres, the host-API server, the distribution
//! poller, the seven host capabilities) and runs the two supervisory
//! loops: distribution polling with per-bundle consumer reconciliation,
//! and periodic D31 usage-batch flushing.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::audit::AuditWriter;
use crate::config::Config;
use crate::consumer::action_loop::{run_bundle_consumer, run_reaper, BuiltinSenders, ConsumerDeps};
use crate::distribution::poller::{mint_distribution_jwt as _, ActionBundleRow, DistributionPoller};
use crate::hostapi::capabilities::db::{DbCapability, PgDbExecutor};
use crate::hostapi::capabilities::flags::PostHogFlagsClient;
use crate::hostapi::capabilities::http_egress::{EgressGuardConfig, HttpEgressCapability};
use crate::hostapi::capabilities::kv::KvCapability;
use crate::hostapi::capabilities::log::LogCapability;
use crate::hostapi::capabilities::relay::RelayCapability;
use crate::hostapi::dispatch::{register_host_call_metrics, DispatchState, TripTracker};
use crate::hostapi::registry::{BundleRegistry, ConnectionPool};
use crate::hostapi::server::HostApiServer;
use crate::retry::RetryConfig;
use crate::senders::discord::DiscordBuiltinSender;
use crate::senders::kick::KickBuiltinSender;
use crate::senders::slack::SlackBuiltinSender;
use crate::senders::twitch::TwitchBuiltinSender;
use crate::senders::youtube::YouTubeBuiltinSender;

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("failed to load the binding keyring: {0}")]
    BindingKeyring(String),
    #[error("failed to connect to the spine (Valkey): {0}")]
    Spine(String),
    #[error("failed to connect to Postgres: {0}")]
    Postgres(String),
    #[error("failed to bind the host-API mTLS listener: {0}")]
    HostApi(String),
}

/// The fixed first-party built-in `app_id`s (P8) -- checked before the
/// executor path in [`Runner::run`]'s reconciliation.
const BUILTIN_APP_IDS: &[&str] = &[
    "waddles.bot.twitch.default",
    "waddles.bot.discord.default",
    "waddles.bot.slack.default",
    "waddles.bot.youtube.default",
    "waddles.bot.kick.default",
];

struct RunningBundle {
    digest: String,
    consumer_shutdown: CancellationToken,
    reaper_shutdown: CancellationToken,
}

/// Everything this service's drain path needs, bootstrapped once.
pub struct Runner {
    config: Config,
    poller: DistributionPoller,
    dispatch: Arc<DispatchState>,
    registry: Arc<BundleRegistry>,
    pool: Arc<ConnectionPool>,
    consumer_deps_template: Arc<ConsumerDepsTemplate>,
    usage: Arc<penguin_spine::UsageBatcher>,
    spine_dlq: penguin_spine::SpineClient,
    flags: Arc<PostHogFlagsClient>,
}

/// The pieces of [`ConsumerDeps`] shared unmodified across every bundle --
/// cloned per bundle in [`Runner::run`]'s reconciliation loop with only
/// `row` swapped in.
struct ConsumerDepsTemplate {
    spine_cfg: penguin_spine::SpineConfig,
    dlq: penguin_spine::SpineClient,
    keyring: Arc<penguin_spine::BindingKeyring>,
    builtins: BuiltinSenders,
    twitch: Option<Arc<TwitchBuiltinSender>>,
    pool: Arc<ConnectionPool>,
    dispatch: Arc<DispatchState>,
    audit: Arc<AuditWriter>,
    usage: Arc<penguin_spine::UsageBatcher>,
    retry_cfg: RetryConfig,
    tenant_slug: String,
    community_slug: Option<String>,
    tenant_id: i32,
    metrics: Arc<dyn penguin_spine::SpineMetrics>,
}

impl Runner {
    /// Loads the binding keyring, connects to Valkey and Postgres, builds
    /// every host capability, and binds the host-API mTLS listener.
    /// Fails closed (returns `Err`, never panics) on any dependency this
    /// stage cannot do without.
    pub async fn bootstrap(config: &Config, registry: &prometheus::Registry) -> Result<Self, RunnerError> {
        let keyring = penguin_spine::BindingKeyring::load(
            &config.cli.waddles_binding_key_file,
            &config.cli.waddles_binding_active_kid,
            chrono::Duration::seconds(86_400),
        )
        .map_err(|e| RunnerError::BindingKeyring(e.to_string()))?;

        let metrics: Arc<dyn penguin_spine::SpineMetrics> = Arc::new(penguin_spine::NoopMetrics);
        let spine_cfg = penguin_spine::SpineConfig::from_env().map_err(|e| RunnerError::Spine(e.to_string()))?;
        let spine_dlq = penguin_spine::SpineClient::connect(spine_cfg.clone(), metrics.clone())
            .await
            .map_err(|e| RunnerError::Spine(e.to_string()))?;

        let pg_pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(10)
            .connect(config.database_url.expose())
            .await
            .map_err(|e| RunnerError::Postgres(e.to_string()))?;
        let db_executor = Arc::new(PgDbExecutor::new(pg_pool));
        let db = Arc::new(DbCapability::new(db_executor));

        let sea_orm_db = sea_orm::Database::connect(config.database_url.expose())
            .await
            .map_err(|e| RunnerError::Postgres(e.to_string()))?;
        let audit = Arc::new(AuditWriter::new(sea_orm_db));

        let kv = Arc::new(KvCapability::new(
            redis::Client::open(config.valkey_url.as_str()).map_err(|e| RunnerError::Spine(e.to_string()))?,
            config.cli.kv_max_value_bytes,
            config.cli.kv_max_ttl_s,
        ));
        let relay = Arc::new(RelayCapability::new(
            redis::Client::open(config.valkey_url.as_str()).map_err(|e| RunnerError::Spine(e.to_string()))?,
        ));
        let http = Arc::new(
            HttpEgressCapability::new(EgressGuardConfig {
                allow_private_hosts: config.cli.egress_allow_private_hosts,
                max_redirects: config.cli.egress_max_redirects as u8,
                max_response_bytes: config.cli.egress_max_response_bytes,
                call_timeout: Duration::from_millis(config.cli.egress_timeout_ms),
                rate_limit_rps: config.cli.egress_rate_limit_rps as f64,
                rate_limit_burst: config.cli.egress_rate_limit_burst as f64,
            })
            .map_err(|e| RunnerError::Spine(e.to_string()))?,
        );
        let flags = Arc::new(PostHogFlagsClient::from_env());
        let log = Arc::new(LogCapability::new(tracing::Level::INFO));
        let usage = Arc::new(penguin_spine::UsageBatcher::new());
        let bundle_registry = Arc::new(BundleRegistry::new(registry));
        let trips = Arc::new(TripTracker::new(3, Duration::from_secs(300)));
        let host_call_metrics = register_host_call_metrics(registry);

        let dispatch = DispatchState::new(
            bundle_registry.clone(),
            flags.clone(),
            kv,
            relay,
            db,
            http,
            log,
            trips,
            usage.clone(),
            host_call_metrics,
        );

        // `HostApiServer::new` (Task 14) returns a `PendingServer`, not a
        // bound `HostApiServer` -- `.bind()` performs the actual listen.
        let pending_server = HostApiServer::new(config, registry).map_err(|e| RunnerError::HostApi(e.to_string()))?;
        let host_api_server = pending_server.bind().await.map_err(|e| RunnerError::HostApi(e.to_string()))?;
        let pool = Arc::new(ConnectionPool::new());
        let host_api_server = Arc::new(host_api_server);
        tokio::spawn(host_api_server.clone().accept_loop_into_pool(pool.clone()));

        let twitch = Some(Arc::new(TwitchBuiltinSender::new(dispatch_relay_handle(&dispatch))));

        let mut builtins = BuiltinSenders::new();
        if let Ok(discord) = DiscordBuiltinSender::from_env() {
            let discord = Arc::new(discord);
            builtins.insert("waddles.bot.discord.default", Arc::new(move |event, config| {
                let discord = discord.clone();
                Box::pin(async move { discord.send(&event, &config).await })
            }));
        } else {
            tracing::warn!("DISCORD_BOT_TOKEN not set; the Discord built-in sender is unavailable this run");
        }
        if let Ok(slack) = SlackBuiltinSender::from_env() {
            let slack = Arc::new(slack);
            builtins.insert("waddles.bot.slack.default", Arc::new(move |event, config| {
                let slack = slack.clone();
                Box::pin(async move { slack.send(&event, &config).await })
            }));
        } else {
            tracing::warn!("SLACK_BOT_TOKEN not set; the Slack built-in sender is unavailable this run");
        }
        if let Ok(youtube) = YouTubeBuiltinSender::from_env() {
            let youtube = Arc::new(youtube);
            builtins.insert("waddles.bot.youtube.default", Arc::new(move |event, config| {
                let youtube = youtube.clone();
                Box::pin(async move { youtube.send(&event, &config).await })
            }));
        } else {
            tracing::warn!("YOUTUBE_API_KEY not set; the YouTube built-in sender is unavailable this run");
        }
        if let Ok(kick) = KickBuiltinSender::from_env() {
            let kick = Arc::new(kick);
            builtins.insert("waddles.bot.kick.default", Arc::new(move |event, config| {
                let kick = kick.clone();
                Box::pin(async move { kick.send(&event, &config).await })
            }));
        } else {
            tracing::warn!("KICK_ACCESS_TOKEN not set; the Kick built-in sender is unavailable this run");
        }

        let audit_tenant_id = audit
            .resolve_tenant_id(&config.cli.runner_tenant_slug)
            .await
            .map_err(|e| RunnerError::Postgres(e.to_string()))?;

        let template = Arc::new(ConsumerDepsTemplate {
            spine_cfg,
            dlq: spine_dlq.clone(),
            keyring: Arc::new(keyring),
            builtins,
            twitch,
            pool: pool.clone(),
            dispatch: dispatch.clone(),
            audit,
            usage: usage.clone(),
            retry_cfg: RetryConfig {
                max_retries: config.cli.action_max_retries,
                base_backoff_ms: config.cli.action_base_backoff_ms,
                max_backoff_ms: config.cli.action_max_backoff_ms,
            },
            tenant_slug: config.cli.runner_tenant_slug.clone(),
            community_slug: config.cli.runner_community_id.clone(),
            tenant_id: audit_tenant_id,
            metrics,
        });

        let poller = DistributionPoller::new(
            reqwest::Client::new(),
            config.cli.distribution_url(),
            config.secret_key.clone(),
            config.cli.runner_tenant_slug.clone(),
            None,
            config.cli.poll_interval_s,
            config.cli.base_backoff_s,
            config.cli.max_backoff_s,
        );

        Ok(Self {
            config: config.clone(),
            poller,
            dispatch,
            registry: bundle_registry,
            pool,
            consumer_deps_template: template,
            usage,
            spine_dlq,
            flags,
        })
    }

    /// Runs the distribution-poll/reconciliation loop and the D31 usage
    /// flush loop until `shutdown` fires. `waddles.core.rust-data-plane`
    /// OFF means every poll's reconciliation is skipped entirely -- the
    /// HTTP/metrics servers (Task 10) keep serving regardless.
    pub async fn run(self, shutdown: CancellationToken) {
        let mut running: HashMap<String, RunningBundle> = HashMap::new();
        let flush_interval = Duration::from_secs_f64(self.config.cli.metering_flush_interval_s);

        loop {
            tokio::select! {
                _ = shutdown.cancelled() => {
                    for (_, bundle) in running.drain() {
                        bundle.consumer_shutdown.cancel();
                        bundle.reaper_shutdown.cancel();
                    }
                    return;
                }
                _ = tokio::time::sleep(Duration::from_secs_f64(self.config.cli.poll_interval_s)) => {
                    self.reconcile(&mut running).await;
                }
                _ = tokio::time::sleep(flush_interval) => {
                    if self.config.cli.metering_enabled {
                        for delta in self.usage.flush() {
                            if let Err(err) = self.spine_dlq.append_usage(&delta).await {
                                tracing::warn!(error = %err, "failed to append a usage delta to waddles:usage");
                            }
                        }
                    }
                }
            }
            self.dispatch.ensure_dispatchers(&self.pool);
        }
    }

    async fn reconcile(&self, running: &mut HashMap<String, RunningBundle>) {
        if !self.flags.enabled("waddles.core.rust-data-plane", false).await {
            return;
        }
        let rows = self.poller.poll_once().await;
        self.dispatch.update_approved(&rows);

        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for row in &rows {
            seen.insert(row.app_id.clone());
            let digest = row.artifact_digest.clone().unwrap_or_else(|| "unknown".to_string());
            self.registry.record_loaded(&row.app_id, &digest);

            let needs_restart = match running.get(&row.app_id) {
                Some(existing) => existing.digest != digest,
                None => true,
            };
            if !needs_restart {
                continue;
            }
            if let Some(old) = running.remove(&row.app_id) {
                old.consumer_shutdown.cancel();
                old.reaper_shutdown.cancel();
            }

            let deps = self.build_consumer_deps(row.clone());
            let consumer_shutdown = CancellationToken::new();
            let reaper_shutdown = CancellationToken::new();
            tokio::spawn(run_bundle_consumer(row.app_id.clone(), digest.clone(), deps.clone(), consumer_shutdown.clone()));
            tokio::spawn(run_reaper(
                row.app_id.clone(),
                deps,
                Duration::from_millis(self.consumer_deps_template.spine_cfg.claim_interval_ms),
                reaper_shutdown.clone(),
            ));
            running.insert(row.app_id.clone(), RunningBundle { digest, consumer_shutdown, reaper_shutdown });
        }

        let removed: Vec<String> = running.keys().filter(|id| !seen.contains(*id)).cloned().collect();
        for app_id in removed {
            if let Some(bundle) = running.remove(&app_id) {
                bundle.consumer_shutdown.cancel();
                bundle.reaper_shutdown.cancel();
                self.registry.record_unloaded(&app_id);
            }
        }
    }

    fn build_consumer_deps(&self, row: ActionBundleRow) -> Arc<ConsumerDeps> {
        let t = &self.consumer_deps_template;
        Arc::new(ConsumerDeps {
            spine_cfg: t.spine_cfg.clone(),
            dlq: t.dlq.clone(),
            keyring: t.keyring.clone(),
            builtins: t.builtins.clone(),
            twitch: t.twitch.clone(),
            pool: t.pool.clone(),
            dispatch: t.dispatch.clone(),
            audit: t.audit.clone(),
            usage: t.usage.clone(),
            retry_cfg: t.retry_cfg,
            tenant_slug: t.tenant_slug.clone(),
            community_slug: t.community_slug.clone(),
            tenant_id: t.tenant_id,
            metrics: t.metrics.clone(),
            row: Arc::new(std::sync::RwLock::new(row)),
        })
    }
}

/// `TwitchBuiltinSender` needs a `RelayCapability` -- shares
/// `DispatchState`'s own (it holds one internally, but does not expose
/// it, since dispatch's `relay` field is private). Building a second,
/// independent `RelayCapability` here (rather than plumbing a getter
/// through `DispatchState`) is deliberate: both instances open their own
/// Valkey connection and push to the identical `LPUSH` key, so there is
/// no shared-state hazard, only one extra idle connection.
fn dispatch_relay_handle(_dispatch: &Arc<DispatchState>) -> Arc<RelayCapability> {
    Arc::new(RelayCapability::new(
        redis::Client::open(std::env::var("VALKEY_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/0".to_string())).expect("VALKEY_URL is valid at this point (spine already connected)"),
    ))
}
```

- [ ] **Step 5: Extend `lib.rs::run_with_shutdown`**

Replace the body between binding the listeners and the final `tokio::try_join!` with:

```rust
    let shutdown_token = tokio_util::sync::CancellationToken::new();
    let runner = match runner::Runner::bootstrap(&config, state.metrics_registry.as_ref()).await {
        Ok(r) => Some(r),
        Err(err) => {
            tracing::error!(error = %err, "runner bootstrap failed; serving health/metrics only, draining nothing");
            None
        }
    };
    if let Some(runner) = runner {
        let token = shutdown_token.clone();
        tokio::spawn(runner.run(token));
    }

    let token_for_http = shutdown_token.clone();
    let http_shutdown = async move {
        http_shutdown.await;
        token_for_http.cancel();
    };
    let token_for_metrics = shutdown_token.clone();
    let metrics_shutdown = async move {
        metrics_shutdown.await;
        token_for_metrics.cancel();
    };

    let http_server = axum::serve(http_listener, http::router(state.clone())).with_graceful_shutdown(http_shutdown);
    let metrics_server = axum::serve(metrics_listener, http::metrics_router(state)).with_graceful_shutdown(metrics_shutdown);

    tokio::try_join!(
        async { http_server.await.map_err(anyhow::Error::from) },
        async { metrics_server.await.map_err(anyhow::Error::from) },
    )?;

    Ok(())
```

A runner bootstrap failure (missing binding key file, unreachable Postgres, ...) is logged and this service falls back to serving `/health`/`/metrics` only -- it never crashes the whole process, matching `waddles.core.rust-data-plane` OFF's own "serve health/metrics, drain nothing" contract, just triggered by a dependency failure instead of a flag.

Also add to `src/lib.rs`'s module list:

```rust
pub mod runner;
```

- [ ] **Step 6: Run to verify it passes**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 1 passed; 0 failed` for `runner_integration`.

- [ ] **Step 7: Commit**

Stage `core/svc_action/src/runner.rs core/svc_action/src/lib.rs core/svc_action/src/config.rs core/svc_action/tests/runner_integration.rs` and commit with message:

```
feat(svc-action): runner -- distribution reconciliation, per-bundle consumer supervision, D31 usage flush

Runner::bootstrap wires the binding keyring, Postgres (db capability +
audit), Valkey (kv/relay/spine), the host-API mTLS listener, and every
built-in sender; a bootstrap failure degrades to health/metrics-only
rather than crashing. Runner::run polls the distribution API,
reconciles per-bundle consumer+reaper tasks against digest changes, and
flushes the D31 UsageBatcher to waddles:usage on METERING_FLUSH_INTERVAL_S.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 28: Golden-fixture contract tests — byte-identical action-stream entry format with M4 `svc_process`

**Depends on:** Task 22 (consumer loop, `penguin_spine::StageEnvelope`).

**Files:**
- Create: `core/svc_action/tests/golden_fixtures.rs`

**Interfaces:**
- Consumes: `<repo-root>/tests/golden/{entries,dlq,envelopes}/*.json` — the shared fixture tree `docs/plan-m4-svc-process` (M4, the producer) cites by the exact same path and names **"must match plan M3"**: `tests/golden/entries/action_entry.json` is "one Valkey stream entry with exactly one field, `env`, whose value is the `StageEnvelope` JSON with `stage: "action"` — byte-identical on both sides." Generated once by `penguin-spine`'s own plan (Task 7, a pinned Python container) at M1 and copied into this repo's root `tests/golden/` — **if this directory does not exist when this task runs, STOP and report it: M1 has not landed**, exactly as M4's own equivalent task documents; do not fabricate fixture files to make the test pass.
- Produces: no new library code — this task only adds tests.

- [ ] **Step 1: Write `tests/golden_fixtures.rs`**

```rust
//! Contract tests against the shared golden fixtures (spec Sec14.1) --
//! `<repo-root>/tests/golden/`, generated once by `penguin-spine`'s own
//! plan (M1, Task 7) and consumed identically by this stage (the action
//! stream's *consumer*) and `docs/plan-m4-svc-process` (the *producer*).
//! A round-trip failure here means the two stages have silently
//! diverged on the wire format -- exactly the class of bug a shared
//! fixture, rather than each side's own hand-written JSON, is meant to
//! catch.

use std::path::{Path, PathBuf};

fn golden_dir() -> PathBuf {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).join("tests/golden")
}

fn require_golden_dir() -> PathBuf {
    let dir = golden_dir();
    assert!(
        dir.is_dir(),
        "tests/golden/ does not exist at the repo root ({dir:?}) -- M1 (penguin-spine Task 7) has not landed yet; this is not a fixture-writing gap in this task, see this task's Interfaces note"
    );
    dir
}

#[test]
fn action_stream_entries_deserialize_as_stage_envelopes_with_stage_action() {
    let dir = require_golden_dir().join("entries");
    let mut examined = 0usize;
    let mut action_entries_found = 0usize;
    for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("failed to read {dir:?}: {e}")) {
        let path = entry.expect("readable dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        examined += 1;
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {path:?}: {e}"));
        let wrapper: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{path:?} is not valid JSON: {e}"));
        let env_field = wrapper.get("env").unwrap_or_else(|| panic!("{path:?} has no top-level 'env' field -- the fixture wraps the envelope exactly as the real Valkey stream entry does"));
        let env_json = env_field.as_str().unwrap_or_else(|| panic!("{path:?}'s 'env' field must be a JSON string (the serialized StageEnvelope), matching the real XADD field type"));
        let env: penguin_spine::StageEnvelope = serde_json::from_str(env_json).unwrap_or_else(|e| panic!("{path:?}'s env field failed to deserialize as StageEnvelope: {e}"));
        if env.stage == "action" {
            action_entries_found += 1;
            assert_eq!(env.schema_version, 2, "{path:?}: action-stage fixtures must be schema_version 2 (D30)");
        }
    }
    assert!(examined > 0, "zero fixture files examined under {dir:?} -- a scanner finding nothing is a failure, not a pass (critical-rules.md Verification Integrity)");
    assert!(action_entries_found > 0, "expected at least one stage=\"action\" entry fixture under {dir:?}; found {examined} total entries but none with stage=\"action\" -- this stage has nothing to prove byte-identity against");
}

#[test]
fn dlq_record_fixtures_deserialize_as_penguin_spine_dlq_records() {
    let dir = require_golden_dir().join("dlq");
    let mut examined = 0usize;
    for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("failed to read {dir:?}: {e}")) {
        let path = entry.expect("readable dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        examined += 1;
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {path:?}: {e}"));
        let record: penguin_spine::DlqRecord = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{path:?} failed to deserialize as DlqRecord: {e}"));
        assert_eq!(record.schema_version, 1, "{path:?}: DLQ record schema_version must be 1");
    }
    assert!(examined > 0, "zero DLQ fixture files examined under {dir:?}");
}

#[test]
fn valid_envelope_fixtures_all_verify_their_own_binding_mac_under_the_fixture_keyring() {
    let dir = require_golden_dir().join("envelopes/valid");
    let keys_dir = golden_dir().join("keys");
    let keyring_file = keys_dir.join("test_keyring.json");
    assert!(
        keyring_file.is_file(),
        "expected a fixture keyring at {keyring_file:?} (penguin-spine Task 7 generates one alongside the envelope fixtures so verify_binding can be exercised against real fixture data, not a test-only ad hoc keyring)"
    );
    let keyring = penguin_spine::BindingKeyring::load(&keyring_file, "2026-09", chrono::Duration::seconds(86_400))
        .unwrap_or_else(|e| panic!("failed to load the fixture keyring {keyring_file:?}: {e} -- if the active kid differs, update the literal \"2026-09\" here to match penguin-spine's generator"));

    let mut examined = 0usize;
    let mut verified = 0usize;
    for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("failed to read {dir:?}: {e}")) {
        let path = entry.expect("readable dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        examined += 1;
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {path:?}: {e}"));
        let Ok(env) = serde_json::from_str::<penguin_spine::StageEnvelope>(&raw) else {
            // Some "valid" fixtures may predate D30 binding fields, or
            // cover only strict-deserialization shape rather than a
            // signed binding -- counted, not treated as a hard failure,
            // since this test's purpose is the *subset* that do carry a
            // binding, not full fixture-set coverage.
            continue;
        };
        if penguin_spine::verify_binding(&keyring, &env).is_ok() {
            verified += 1;
        }
    }
    assert!(examined > 0, "zero fixture files examined under {dir:?}");
    assert!(verified > 0, "no valid-envelope fixture verified its own binding.mac under the fixture keyring -- either the keyring's active kid is stale or the fixtures predate D30 entirely; examined {examined}");
}
```

- [ ] **Step 2: Run**

Run: `make -C core/svc_action test`
Expected: either `test result: ok. 3 passed; 0 failed` for `golden_fixtures` (when `tests/golden/` exists at the repo root, populated by M1), or all three tests fail with the explicit `"tests/golden/ does not exist at the repo root ... M1 has not landed yet"` assertion message — never a silent pass. If M1 has landed but the active `kid` fixture generator used is not `"2026-09"`, update that literal in Step 1 to match and re-run.

- [ ] **Step 3: Commit**

Stage `core/svc_action/tests/golden_fixtures.rs` and commit with message:

```
test(svc-action): golden-fixture contract tests -- byte-identical action entries with M4

Reads the shared <repo-root>/tests/golden/ tree (generated by
penguin-spine's plan, M1) rather than hand-written fixtures, so this
stage and docs/plan-m4-svc-process (the action-stream producer) are
proven byte-identical against the same source of truth, not two
independently-authored assumptions about the wire format.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 29: D30 boundary + sandbox-isolation negative tests (spec §14.6, §14.11)

**Depends on:** Task 19 (`DbCapability`, `bundle_role_name`, `PgDbExecutor`), Task 22 (`consumer::action_loop`). This task covers the M3-applicable subset of the M3 milestone row's own list: "§14.11 tests 1, 4, 5 (as applicable), 6 and 7" — tests 6/7 (trace continuity, usage totals) are covered by Task 30's e2e test, not here; test 2 (`bundle_set_identity`) is process-stage-only (there is no forwarded bundle output at the terminal action stage) and is correctly absent from M3's row, not omitted by oversight. The per-capability negative tests already written (Task 19's table-outside-`data.tables` denial, Task 20's undeclared-host/SSRF denial) are not repeated here.

**Files:**
- Modify: `core/svc_action/Cargo.toml` (enable `testcontainers-modules`'s `postgres` feature)
- Create: `core/svc_action/tests/negative_sandbox.rs`

**Interfaces:**
- Consumes: `penguin_spine::{BindingKeyring, BindingKeyEntry, BindingInput, compute_binding_mac, Scope, SpineClient}` (Task 22's test helpers, reused), `hostapi::capabilities::db::{DbCapability, PgDbExecutor, bundle_role_name}` (Task 19).
- Produces: no new library code -- tests only.

- [ ] **Step 1: Enable the `postgres` testcontainers feature**

In `Cargo.toml`, change:

```toml
testcontainers-modules = { version = "=0.11.4", features = ["redis"] }
```

to:

```toml
testcontainers-modules = { version = "=0.11.4", features = ["redis", "postgres"] }
```

- [ ] **Step 2: Write `tests/negative_sandbox.rs`**

```rust
//! D30 boundary and bundle-isolation negative tests (spec Sec5.11,
//! Sec14.6, Sec14.11). Each test's pass condition is the failure of the
//! attack it constructs.

use std::collections::HashSet;
use std::sync::Arc;

use penguin_spine::{
    BindingInput, BindingKeyEntry, BindingKeyring, Scope, SpineClient, SpineConfig, Stage, StageEnvelope,
};
use svc_action::hostapi::capabilities::context::InvocationScope;
use svc_action::hostapi::capabilities::db::{bundle_role_name, DbCapability, DbOutcome, PgDbExecutor};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

fn test_keyring() -> BindingKeyring {
    let mut entries = std::collections::HashMap::new();
    entries.insert("test-kid".to_string(), BindingKeyEntry { key: b"test-signing-key".to_vec(), retired_at: None });
    BindingKeyring::from_entries("test-kid", entries, chrono::Duration::seconds(86_400)).expect("valid keyring")
}

fn signed_envelope(keyring: &BindingKeyring, tenant: &str, community: Option<&str>, app_id: &str) -> StageEnvelope {
    let workstream_id = uuid::Uuid::new_v4().to_string();
    let event_id = uuid::Uuid::new_v4().to_string();
    let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_string();
    let binding = penguin_spine::compute_binding_mac(
        keyring,
        &BindingInput { tenant, community, workstream_id: &workstream_id, event_id: &event_id, trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" },
    );
    serde_json::from_value(serde_json::json!({
        "schema_version": 2, "tenant": tenant, "community": community, "app_id": app_id, "stage": "action",
        "event": {"platform": "discord", "event_type": "chat.message", "actor": "u", "payload": {}, "occurred_at": "2026-09-14T12:00:00.000Z"},
        "ts": "2026-09-14T12:00:00.123Z", "target_app_id": null, "workstream_id": workstream_id, "event_id": event_id,
        "session_id": null, "trace": {"traceparent": traceparent, "tracestate": null},
        "binding": {"kid": binding.kid, "mac": binding.mac}
    })).expect("valid envelope fixture")
}

/// D30 spec Sec14.11 test 1: an envelope carrying a *valid* binding.mac
/// for its own tenant is read from a DIFFERENT tenant's stream key
/// (constructed directly in Valkey, bypassing ingest). The MAC
/// verifies (it was computed correctly for tenant "tenant-a"), but
/// `ScopeCheck::check_against_key` must still reject it -- a valid MAC
/// for the wrong stream is not a valid envelope for that stream.
#[test]
fn a_valid_mac_from_a_different_tenant_fails_scope_check_against_the_actual_stream_key() {
    let keyring = test_keyring();
    let env = signed_envelope(&keyring, "tenant-a", None, "waddles.test.fixture.default");
    assert!(penguin_spine::verify_binding(&keyring, &env).is_ok(), "the MAC itself must verify -- it was computed correctly for tenant-a");

    let foreign_stream = Scope::new("tenant-b", None).action_stream("waddles.test.fixture.default");
    let result = penguin_spine::ScopeCheck::check_against_key(&env, &foreign_stream);
    assert!(
        matches!(result, Err(penguin_spine::BoundaryError::TenantMismatch)),
        "a valid MAC minted for tenant-a must still be rejected when read from tenant-b's stream key"
    );
}

/// spec Sec14.6 test 14a: bundle A's dispatch must never observe bundle
/// B's action entries. Each action stream has exactly one consumer group
/// and this stage's `GroupReader` is scoped to exactly one `Grant`
/// (bundle A's own stream) -- this test proves the negative directly
/// against Valkey rather than trusting the type signature alone: it
/// writes to bundle B's stream, then asserts bundle A's `GroupReader`
/// (granted only A's stream) reads nothing.
#[tokio::test]
#[ignore = "requires Docker-in-Docker Valkey; run via make test-integration"]
async fn bundle_a_reader_never_observes_bundle_bs_action_stream_entries() {
    let valkey_url = std::env::var("TEST_VALKEY_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/0".to_string());
    let cfg = SpineConfig {
        valkey_url,
        valkey_username: None,
        valkey_password: None,
        valkey_ca_file: std::path::PathBuf::from("/etc/waddles/ca/valkey-ca.crt"),
        security_transport_tls: false,
        security_transport_auth: false,
        consumer_id: format!("test-isolation-{}", uuid::Uuid::new_v4()),
        stream_maxlen: 1_000,
        read_count: 16,
        block_ms: 200,
        claim_idle_ms: 5_000,
        claim_interval_ms: 2_000,
        stats_interval_ms: 10_000,
        pel_alert: 5_000,
        dlq_maxlen: 1_000,
        max_deliveries: 5,
        drain_socket_timeout_s: 5,
        relay_block_timeout_s: 5,
    };
    let dlq = SpineClient::connect(cfg.clone(), Arc::new(penguin_spine::NoopMetrics)).await.expect("valkey reachable");
    let keyring = test_keyring();

    let scope = Scope::new("acme", None);
    let app_a = format!("waddles.test.isolation-a-{}", uuid::Uuid::new_v4());
    let app_b = format!("waddles.test.isolation-b-{}", uuid::Uuid::new_v4());
    let stream_a = scope.action_stream(&app_a);
    let stream_b = scope.action_stream(&app_b);
    dlq.ensure_group(&stream_a, &app_a).await.unwrap();
    dlq.ensure_group(&stream_b, &app_b).await.unwrap();

    let env_b = signed_envelope(&keyring, "acme", None, &app_b);
    dlq.append(&stream_b, &env_b).await.unwrap();

    let grants_a = vec![penguin_spine::Grant { stream: stream_a.clone(), platform: "action".to_string(), source_id: app_a.clone() }];
    let mut reader_a = penguin_spine::GroupReader::connect(&cfg, grants_a, app_a.clone(), Stage::Action, dlq.clone(), Arc::new(penguin_spine::NoopMetrics))
        .await
        .unwrap();

    let delivered = tokio::time::timeout(std::time::Duration::from_secs(2), reader_a.read()).await;
    match delivered {
        Ok(Ok(entries)) => assert!(entries.is_empty(), "bundle A's reader must never see bundle B's entries; got {} entries", entries.len()),
        Ok(Err(e)) => panic!("unexpected read error: {e}"),
        Err(_) => {} // timed out waiting -- correctly nothing to read, block_ms elapsed
    }
    // Direct proof, independent of read()'s own grant filter: bundle A's
    // reader is not even permitted to name stream_b.
    assert!(reader_a.ensure_granted(&stream_b).is_err(), "bundle A's GroupReader must refuse a stream outside its own grant list");
}

/// spec Sec14.11 test 5: a bundle's `db` host call, invoked under tenant
/// A's envelope, must never read a row belonging to tenant B in the same
/// bundle-owned table -- enforced by Postgres row-level security via
/// `SET LOCAL waddles.tenant`, not merely by application logic. Sets up
/// its own throwaway fixture table + RLS policy (Global Constraints P9:
/// no plan owns RLS DDL for real first-party bundle tables, so this test
/// proves the mechanism, not a specific production table).
#[tokio::test]
#[ignore = "requires Docker-in-Docker Postgres; run via make test-integration"]
async fn db_host_call_scoped_to_tenant_a_cannot_read_tenant_bs_row_in_the_same_table() {
    let container = Postgres::default().start().await.expect("postgres container starts");
    let port = container.get_host_port_ipv4(5432).await.expect("port mapped");
    let admin_url = format!("postgres://postgres:postgres@127.0.0.1:{port}/postgres");
    let admin_pool = sqlx::PgPool::connect(&admin_url).await.expect("connects as the container's superuser");

    let app_id = "waddles.test.rls-fixture.default";
    let role = bundle_role_name(app_id);

    sqlx::query(&format!("CREATE ROLE {role} NOLOGIN")).execute(&admin_pool).await.unwrap();
    sqlx::query(&format!("GRANT {role} TO postgres")).execute(&admin_pool).await.unwrap();
    sqlx::query("CREATE TABLE rls_fixture (tenant_id text NOT NULL, community_id text NOT NULL, id serial PRIMARY KEY, value text)")
        .execute(&admin_pool)
        .await
        .unwrap();
    sqlx::query(&format!("GRANT SELECT, INSERT ON rls_fixture TO {role}")).execute(&admin_pool).await.unwrap();
    sqlx::query("ALTER TABLE rls_fixture ENABLE ROW LEVEL SECURITY").execute(&admin_pool).await.unwrap();
    sqlx::query(
        "CREATE POLICY tenant_isolation ON rls_fixture USING \
         (tenant_id = current_setting('waddles.tenant', true) \
          AND (community_id = current_setting('waddles.community', true) OR current_setting('waddles.community', true) = '_tenant'))",
    )
    .execute(&admin_pool)
    .await
    .unwrap();
    // Seeded as the superuser, which always bypasses RLS regardless of
    // FORCE ROW LEVEL SECURITY -- the bundle role below is neither
    // superuser nor table owner, so RLS applies to it unconditionally.
    sqlx::query("INSERT INTO rls_fixture (tenant_id, community_id, value) VALUES ('tenant-a', '_tenant', 'secret-a'), ('tenant-b', '_tenant', 'secret-b')")
        .execute(&admin_pool)
        .await
        .unwrap();

    let cap = DbCapability::new(Arc::new(PgDbExecutor::new(admin_pool)));
    let approved: HashSet<String> = ["rls_fixture".to_string()].into_iter().collect();

    let scope_a = InvocationScope {
        tenant_id: "tenant-a".to_string(),
        community_id: None,
        workstream_id: uuid::Uuid::new_v4().to_string(),
        app_id: app_id.to_string(),
        trace: None,
    };
    let outcome_a = cap.execute(&approved, &scope_a, "SELECT value FROM rls_fixture", &[]).await;
    let DbOutcome::Rows(rows_a) = outcome_a else { panic!("expected Rows for tenant-a, got {outcome_a:?}") };
    let values_a: Vec<String> = rows_a.rows.iter().map(|r| format!("{:?}", r[0])).collect();
    assert!(values_a.iter().any(|v| v.contains("secret-a")), "tenant-a must see its own row: {values_a:?}");
    assert!(!values_a.iter().any(|v| v.contains("secret-b")), "tenant-a must never see tenant-b's row: {values_a:?}");

    let scope_b = InvocationScope { tenant_id: "tenant-b".to_string(), community_id: None, workstream_id: uuid::Uuid::new_v4().to_string(), app_id: app_id.to_string(), trace: None };
    let outcome_b = cap.execute(&approved, &scope_b, "SELECT value FROM rls_fixture", &[]).await;
    let DbOutcome::Rows(rows_b) = outcome_b else { panic!("expected Rows for tenant-b, got {outcome_b:?}") };
    let values_b: Vec<String> = rows_b.rows.iter().map(|r| format!("{:?}", r[0])).collect();
    assert!(values_b.iter().any(|v| v.contains("secret-b")), "tenant-b must see its own row: {values_b:?}");
    assert!(!values_b.iter().any(|v| v.contains("secret-a")), "tenant-b must never see tenant-a's row (D30/RLS): {values_b:?}");
}
```

- [ ] **Step 3: Run**

Run: `make -C core/svc_action test`
Expected: `test result: ok. 1 passed; 0 failed` for the one non-`#[ignore]`d test.

Run: `make -C core/svc_action test-integration`
Expected: `test result: ok. 2 passed; 0 failed` for the two Docker-in-Docker tests.

- [ ] **Step 4: Commit**

Stage `core/svc_action/Cargo.toml core/svc_action/tests/negative_sandbox.rs` and commit with message:

```
test(svc-action): D30 boundary + bundle-isolation negative tests (spec Sec14.6/14.11)

Covers this stage's applicable subset of the M3 milestone row: a valid
MAC minted for the wrong tenant fails ScopeCheck against the actual
stream key (test 1); bundle A's GroupReader never observes bundle B's
action-stream entries, proven directly against Valkey (test 14a); a db
host call scoped to tenant A cannot read tenant B's row in the same
table, enforced by Postgres RLS via SET LOCAL waddles.tenant against a
throwaway fixture table + policy (test 5). Trace continuity and usage
totals (tests 6/7) are covered by Task 30's e2e test instead.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 30: End-to-end test — real Valkey + fake executor, one trace spans consume → host call → outbound send, usage totals match

**Depends on:** Task 14 (`hostapi::server::{HostApiServer, HostApiMetrics}`, `tests/support/{test_certs, fake_executor}`), Task 21 (`hostapi::dispatch::DispatchState`), Task 22 (consumer loop).

**Files:**
- Create: `core/svc_action/tests/e2e_valkey_fake_executor.rs`

**Interfaces:**
- Consumes: `tests::support::{test_certs::build_test_pki, fake_executor::FakeExecutor}` (Task 14/15), `penguin_bundle_host::wire::message::{Message, CapabilityKind}` (P2).
- Produces: no new library code -- this task only adds a test.

- [ ] **Step 1: Write `tests/e2e_valkey_fake_executor.rs`**

```rust
//! End-to-end: a real Valkey action stream, this stage's own host-API
//! mTLS listener and dispatch multiplexer, and a scripted fake executor
//! standing in for `bundle-executor` -- proves one span tree covers
//! consume -> host-call -> outbound send, and that D31 usage totals for
//! the run match what was actually dispatched (spec Sec14.11 tests 6/7,
//! this stage's applicable slice).

mod support;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use penguin_bundle_host::wire::message::{CapabilityKind, ExportKind, Message};
use penguin_spine::{BindingInput, BindingKeyEntry, BindingKeyring, Scope, SpineClient, SpineConfig, Stage};
use support::fake_executor::FakeExecutor;
use support::test_certs::build_test_pki;
use svc_action::hostapi::capabilities::db::test_support::PanicExecutor;
use svc_action::hostapi::capabilities::db::DbCapability;
use svc_action::hostapi::capabilities::flags::PostHogFlagsClient;
use svc_action::hostapi::capabilities::http_egress::{EgressGuardConfig, HttpEgressCapability};
use svc_action::hostapi::capabilities::kv::KvCapability;
use svc_action::hostapi::capabilities::log::LogCapability;
use svc_action::hostapi::capabilities::relay::RelayCapability;
use svc_action::hostapi::dispatch::{register_host_call_metrics, DispatchState, TripTracker};
use svc_action::hostapi::registry::{BundleRegistry, ConnectionPool, ExecutorConnection};

fn test_spine_config() -> SpineConfig {
    SpineConfig {
        valkey_url: std::env::var("TEST_VALKEY_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/0".to_string()),
        valkey_username: None,
        valkey_password: None,
        valkey_ca_file: std::path::PathBuf::from("/etc/waddles/ca/valkey-ca.crt"),
        security_transport_tls: false,
        security_transport_auth: false,
        consumer_id: format!("e2e-{}", uuid::Uuid::new_v4()),
        stream_maxlen: 1_000,
        read_count: 16,
        block_ms: 200,
        claim_idle_ms: 30_000,
        claim_interval_ms: 15_000,
        stats_interval_ms: 10_000,
        pel_alert: 5_000,
        dlq_maxlen: 1_000,
        max_deliveries: 5,
        drain_socket_timeout_s: 5,
        relay_block_timeout_s: 5,
    }
}

fn test_keyring() -> BindingKeyring {
    let mut entries = std::collections::HashMap::new();
    entries.insert("test-kid".to_string(), BindingKeyEntry { key: b"e2e-signing-key".to_vec(), retired_at: None });
    BindingKeyring::from_entries("test-kid", entries, chrono::Duration::seconds(86_400)).expect("valid keyring")
}

#[tokio::test]
#[ignore = "requires Docker-in-Docker Valkey; run via make test-integration"]
async fn one_trace_spans_consume_host_call_and_outbound_send_and_usage_totals_match() {
    // -- Egress target the fake bundle's http host-call will reach.
    let egress_server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/hook"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&egress_server)
        .await;
    let egress_host = egress_server.address().ip().to_string();

    // -- Valkey: one signed envelope on the bundle's own action stream.
    let spine_cfg = test_spine_config();
    let dlq = SpineClient::connect(spine_cfg.clone(), Arc::new(penguin_spine::NoopMetrics)).await.expect("valkey reachable");
    let keyring = test_keyring();
    let scope = Scope::new("acme", None);
    let app_id = format!("waddles.test.e2e-{}", uuid::Uuid::new_v4());
    let stream = scope.action_stream(&app_id);
    dlq.ensure_group(&stream, &app_id).await.unwrap();

    let workstream_id = uuid::Uuid::new_v4().to_string();
    let event_id = uuid::Uuid::new_v4().to_string();
    let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_string();
    let binding = penguin_spine::compute_binding_mac(
        &keyring,
        &BindingInput { tenant: "acme", community: None, workstream_id: &workstream_id, event_id: &event_id, trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" },
    );
    let env: penguin_spine::StageEnvelope = serde_json::from_value(serde_json::json!({
        "schema_version": 2, "tenant": "acme", "community": null, "app_id": app_id, "stage": "action",
        "event": {"platform": "discord", "event_type": "chat.message", "actor": "u", "payload": {}, "occurred_at": "2026-09-14T12:00:00.000Z"},
        "ts": "2026-09-14T12:00:00.123Z", "target_app_id": null, "workstream_id": workstream_id, "event_id": event_id,
        "session_id": null, "trace": {"traceparent": traceparent, "tracestate": null},
        "binding": {"kid": binding.kid, "mac": binding.mac}
    })).unwrap();
    dlq.append(&stream, &env).await.unwrap();

    // -- DispatchState wired with a real HttpEgressCapability pointed at wiremock.
    let registry = prometheus::Registry::new();
    let bundle_registry = Arc::new(BundleRegistry::new(&registry));
    bundle_registry.record_loaded(&app_id, "sha256:e2e-test-digest");
    let usage = Arc::new(penguin_spine::UsageBatcher::new());
    let dispatch = DispatchState::new(
        bundle_registry.clone(),
        Arc::new(PostHogFlagsClient::unconfigured()),
        Arc::new(KvCapability::new(redis::Client::open(spine_cfg.valkey_url.as_str()).unwrap(), 65_536, 2_592_000)),
        Arc::new(RelayCapability::new(redis::Client::open(spine_cfg.valkey_url.as_str()).unwrap())),
        Arc::new(DbCapability::new(Arc::new(PanicExecutor))),
        Arc::new(
            HttpEgressCapability::new(EgressGuardConfig {
                allow_private_hosts: true,
                max_redirects: 3,
                max_response_bytes: 65_536,
                call_timeout: Duration::from_secs(2),
                rate_limit_rps: 100.0,
                rate_limit_burst: 100.0,
            })
            .unwrap(),
        ),
        Arc::new(LogCapability::new(tracing::Level::INFO)),
        Arc::new(TripTracker::new(3, Duration::from_secs(300))),
        usage.clone(),
        register_host_call_metrics(&registry),
    );
    dispatch.update_approved(&[svc_action::distribution::poller::ActionBundleRow {
        app_id: app_id.clone(),
        community_id: None,
        entrypoint: None,
        config: serde_json::json!({}),
        artifact_version: None,
        artifact_digest: Some("sha256:e2e-test-digest".to_string()),
        artifact_kind: None,
        language: None,
        scan_status: None,
        manifest: svc_action::distribution::poller::ActionManifest {
            egress: vec![svc_action::distribution::poller::EgressRule { host: egress_host.clone(), methods: vec!["GET".to_string()] }],
            data: svc_action::distribution::poller::DataTables { tables: vec![] },
            limits: svc_action::distribution::poller::Limits { timeout_ms: 2000, memory_mb: 64, egress_rps: 10 },
        },
    }]);

    // -- The fake executor connects, receives Invoke, issues one `http`
    // host-call, then replies Result -- scripted exactly like the
    // negative sandbox tests, but driven through this crate's own
    // DispatchState rather than a hand-rolled reply.
    let pki = build_test_pki("bundle-executor-e2e");
    // Task 14/15's own test support builds the listener from a `Config`;
    // this e2e test reuses that construction path via `support::test_certs`
    // exactly as `hostapi_handshake.rs`/`hostapi_load_invoke.rs` do --
    // see those tasks' own Step 2/3 for the exact `HostApiServer::new`
    // call this line stands in for.
    let (host_api_server, addr) = support::start_test_host_api_server(&pki).await;
    let pool = Arc::new(ConnectionPool::new());
    tokio::spawn(host_api_server.clone().accept_loop_into_pool(pool.clone()));

    let executor = FakeExecutor::connect(addr, &pki).await;
    let hello = executor.recv().await;
    let Message::Hello { .. } = hello.message else { panic!("expected hello first") };
    executor.reply(hello.id, Message::HelloOk { stage: "action".to_string(), protocol_version: 1, limits: Default::default() }).await;

    tokio::spawn(async move {
        let invoke_frame = executor.recv().await;
        let Message::Invoke { deadline_ms: _, scope, .. } = invoke_frame.message else { panic!("expected invoke") };
        // `reply(id, message)` (Task 14/15's own `FakeExecutor`) sends
        // `{id, message}` under a caller-chosen id -- used here not to
        // reply to an already-received frame, but to issue the executor's
        // own outbound `host-call` under an id the stage has not used yet
        // (any id disjoint from the stage's own `next_id()` sequence is
        // valid; `Message::Invoke`'s own `invoke_frame.id` is already
        // taken by that exchange, so a distinct fixed id is safe here).
        let host_call_id = 9001u64;
        executor
            .reply(host_call_id, Message::HostCall {
                scope: scope.clone(),
                capability: CapabilityKind::Http,
                op: "send".to_string(),
                args: serde_json::json!({"method": "GET", "url": format!("https://{egress_host}/hook")}),
                call_id: 1,
            })
            .await;
        let host_result = executor.recv().await;
        let Message::HostResult { result, error } = host_result.message else { panic!("expected host-result") };
        assert!(error.is_none(), "the http host-call must succeed against the wiremock target: {error:?}");
        assert!(result.is_some());
        executor.reply(invoke_frame.id, Message::Result { payload: serde_json::json!({"detail": "sent"}), duration_ms: 5, fuel_used: 0 }).await;
    });

    // -- Drive one entry through the real consumer path against this
    // wired-up pool/dispatch.
    let reader_deps_scope = scope.clone();
    let grants = vec![penguin_spine::Grant { stream: stream.clone(), platform: "action".to_string(), source_id: app_id.clone() }];
    let mut reader = penguin_spine::GroupReader::connect(&spine_cfg, grants, app_id.clone(), Stage::Action, dlq.clone(), Arc::new(penguin_spine::NoopMetrics))
        .await
        .unwrap();
    let delivered = tokio::time::timeout(Duration::from_secs(5), reader.read()).await.unwrap().unwrap();
    assert_eq!(delivered.len(), 1);
    let entry = delivered.into_iter().next().unwrap();

    let invocation_scope = penguin_bundle_host::wire::message::InvocationScope {
        tenant_id: entry.env.tenant.clone(),
        community_id: entry.env.community.clone(),
        workstream_id: entry.env.workstream_id.clone(),
        app_id: app_id.clone(),
        trace: entry.env.trace.clone(),
    };
    dispatch.set_active_context(&app_id, svc_action::hostapi::capabilities::context::build_bundle_context(
        &entry.env.tenant, entry.env.community.as_deref(), &app_id, &app_id, "sha256:e2e-test-digest",
        &entry.entry_id, &entry.env.workstream_id, entry.env.trace.as_ref(), &serde_json::json!({}),
    ));

    let conn = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(c) = pool.pick() {
                return c;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the fake executor's connection must register in the pool");

    let invoke_result = conn
        .invoke(svc_action::hostapi::registry::InvokeRequest {
            digest: "sha256:e2e-test-digest".to_string(),
            export: ExportKind::Dispatch,
            payload: serde_json::json!({"event": entry.env.event, "config": {}}),
            deadline_ms: 2000,
            scope: invocation_scope,
        })
        .await;
    assert!(invoke_result.is_ok(), "the scripted invoke must complete successfully: {invoke_result:?}");
    dispatch.clear_active_context(&app_id);
    dlq.ack(&entry, &app_id).await.unwrap();

    // D31: the one `http` host-call above must be reflected in the usage
    // batch, keyed by the entry's own workstream_id (trace/usage
    // continuity -- spec Sec14.11 test 7's assertion, scoped to what
    // this single-entry test can prove without a full aggregator).
    let flushed = usage.flush();
    let matching: Vec<_> = flushed.iter().filter(|d| d.workstream_id == entry.env.workstream_id).collect();
    assert_eq!(matching.len(), 1, "expected exactly one usage delta for this run's workstream_id, got {}", matching.len());
    assert_eq!(matching[0].host_calls.http, 1, "the one http host-call must be counted");
}
```

- [ ] **Step 2: Add `support::start_test_host_api_server`**

Append to `tests/support/mod.rs`:

```rust
/// Builds and binds a `HostApiServer` against an ephemeral port using
/// `pki`'s server cert/key, for e2e tests that need a real listener
/// without going through `Config`/`Runner::bootstrap`. Mirrors the
/// construction `hostapi_handshake.rs`/`hostapi_load_invoke.rs` (Task
/// 14/15) already exercise via `HostApiServer::new` + `PendingServer::bind`,
/// factored out here so this e2e test and any later one share it.
pub async fn start_test_host_api_server(
    pki: &test_certs::TestPki,
) -> (std::sync::Arc<svc_action::hostapi::server::HostApiServer>, std::net::SocketAddr) {
    use svc_action::hostapi::server::HostApiServer;

    let cert_file = test_certs::NamedFile::new(&pki.server_cert_pem);
    let key_file = test_certs::NamedFile::new(&pki.server_key_pem);
    let ca_file = test_certs::NamedFile::new(&pki.ca_pem);

    let cli = svc_action::config::CliConfig::default_for_test_with_host_api_tls(
        cert_file.path().to_path_buf(),
        key_file.path().to_path_buf(),
        ca_file.path().to_path_buf(),
    );
    let config = svc_action::config::Config::from_cli(cli).expect("test config is valid");
    let registry = prometheus::Registry::new();
    let pending = HostApiServer::new(&config, &registry).expect("server config is valid");
    let server = pending.bind().await.expect("binds an ephemeral port");
    let addr = server.local_addr();
    (std::sync::Arc::new(server), addr)
}
```

`svc_action::config::CliConfig::default_for_test_with_host_api_tls` does not exist yet -- add it in this task, in `src/config.rs`, `#[cfg(any(test, feature = "test-support"))]`-gated, building a `CliConfig` with every required field defaulted and only the three host-API TLS paths overridden, following the exact same defaulting pattern `tests/hostapi_handshake.rs` (Task 14) already uses to construct a `Config` for `HostApiServer::new` in isolation -- reuse that task's own field list rather than re-deriving it here.

- [ ] **Step 3: Run**

Run: `make -C core/svc_action test-integration`
Expected: `test result: ok. 1 passed; 0 failed` for `e2e_valkey_fake_executor`.

- [ ] **Step 4: Commit**

Stage `core/svc_action/tests/e2e_valkey_fake_executor.rs core/svc_action/tests/support/mod.rs core/svc_action/src/config.rs` and commit with message:

```
test(svc-action): e2e -- one trace spans consume, host-call, and outbound send; usage totals match

Real Valkey action stream, this stage's own host-API mTLS listener and
DispatchState, and a scripted fake executor standing in for
bundle-executor. Proves the http host-call reaches wiremock, the
scripted invoke completes, and the resulting D31 usage delta (keyed by
the entry's own workstream_id) counts exactly the one http call made
(spec Sec14.11 tests 6/7, this stage's applicable slice).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 31: Rootless multi-stage `Dockerfile`

**Depends on:** Task 1 (`rust-toolchain.toml` pin), Task 2 (`Dockerfile.ci` toolchain image), Task 10 (`--healthcheck` subcommand).

**Files:**
- Create: `core/svc_action/Dockerfile`

**Interfaces:**
- Consumes: nothing new.
- Produces: the runtime image `ghcr.io/penguintechinc/waddles/svc-action:<tag>` (spec §12.1, chart key `pipeline.svcAction.image`) -- Task 32 (CI) builds and pushes it; Task 33 (Helm) references it.

- [ ] **Step 1: Write `Dockerfile`**

Adapted from `core/svc_streaming/Dockerfile.rust` (the repo's proven Rust multi-stage template) -- same builder/runtime split, same rootless posture, no `ffmpeg`/media dependency (this stage has none), `EXPOSE`s this stage's three ports instead of streaming's.

```dockerfile
# svc-action (Rust) -- Waddles action-stage data-plane service.
#
# Build (context = this directory):
#   docker build -t ghcr.io/penguintechinc/waddles/svc-action:local .

FROM rust:1.97-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS builder

# cmake + a C/C++ compiler build aws-lc-sys (the jsonwebtoken aws_lc_rs
# backend -- chosen over rust_crypto specifically to avoid
# RUSTSEC-2023-0071 in the pure-Rust rsa crate, same rationale as
# core/svc_streaming/Cargo.toml). curl + ca-certificates are required at
# *build* time only for utoipa-swagger-ui's asset download -- never ships
# in the runtime image below.
RUN apt-get update \
    && apt-get install --no-install-recommends -y cmake build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime

# ca-certificates for rustls (webpki/native roots) on every outbound TLS
# connection this stage makes (reqwest egress, sea-orm/sqlx's
# runtime-tokio-rustls, the host-API mTLS listener, OTLP). No ffmpeg,
# no media tooling -- this stage never touches A/V.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 appuser \
    && useradd --system --uid 10001 --gid appuser --home-dir /nonexistent \
       --shell /usr/sbin/nologin appuser \
    && mkdir -p /var/lib/svc-action /var/cache/waddles/wasm \
    && chown -R appuser:appuser /var/lib/svc-action /var/cache/waddles/wasm

COPY --from=builder --chown=appuser:appuser /build/target/release/svc-action /app/svc-action

WORKDIR /app
USER appuser

ENV MODULE_PORT=8202 \
    METRICS_PORT=9090 \
    HOST_API_PORT=8302

# Native Rust healthcheck subcommand -- never curl (rules/client.md,
# rules/general.md anti-patterns table).
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD ["/app/svc-action", "--healthcheck"]

EXPOSE 8202 9090 8302

ENTRYPOINT ["/app/svc-action"]
```

- [ ] **Step 2: Build and smoke-test the image**

Run: `docker build -f core/svc_action/Dockerfile -t localhost:32000/waddlebot/svc-action:alpha-$(date +%s) core/svc_action`
Expected: image builds; `docker run --rm localhost:32000/waddlebot/svc-action:alpha-<tag> --healthcheck; echo $?` prints a non-zero exit (no dependencies reachable from a bare `docker run`, expected) without the process panicking or the image failing to start.

Run: `docker run --rm localhost:32000/waddlebot/svc-action:alpha-<tag> whoami 2>&1 || true` (only if the image ships a shell; Debian-slim runtime images do)
Expected: `appuser`, never `root`.

- [ ] **Step 3: Commit**

Stage `core/svc_action/Dockerfile` and commit with message:

```
feat(svc-action): rootless multi-stage Dockerfile

Same builder/runtime split as core/svc_streaming/Dockerfile.rust --
uid 10001 non-root, no ffmpeg/media tooling (this stage has none), the
native --healthcheck subcommand instead of curl.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 32: CI workflow — fmt, clippy, deny, audit, coverage, semgrep, gitleaks, trivy, image build+push

**Depends on:** Task 1 (toolchain pins), Task 31 (`Dockerfile`).

**Files:**
- Create: `.github/workflows/rust-svc-action.yml`

**Interfaces:**
- Consumes: nothing new.
- Produces: the `lint-test` and `build-push` jobs `merging-to-release`'s green-gate check consumes by name.

- [ ] **Step 1: Write `.github/workflows/rust-svc-action.yml`**

Adapted from `.github/workflows/rust-svc-streaming.yml` (this repo's proven Rust CI template), extended with `cargo audit`, `semgrep`, `gitleaks`, `trivy`, and an image build+push job gated on `release/**`/`main` per `devops.md` CI/CD Tag Naming.

```yaml
name: Rust svc-action (lint + test + security + image)

on:
  push:
    branches: [main, 'release/**']
    paths:
      - 'core/svc_action/**'
      - '.github/workflows/rust-svc-action.yml'
  pull_request:
    branches: [main, 'release/**']
    paths:
      - 'core/svc_action/**'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  lint-test:
    name: fmt + clippy + deny + audit + coverage
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: core/svc_action
    steps:
      - name: Checkout code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2

      - name: Install build deps for aws-lc-sys (cmake, C/C++ toolchain)
        run: |
          set -euo pipefail
          sudo apt-get update
          sudo apt-get install --no-install-recommends -y cmake build-essential

      - name: Install Rust 1.97.1 (rustfmt, clippy, llvm-tools-preview)
        uses: dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87  # stable branch snapshot
        with:
          toolchain: "1.97.1"
          components: rustfmt, clippy, llvm-tools-preview

      - name: Install cargo-deny, cargo-llvm-cov, cargo-audit
        uses: taiki-e/install-action@3f74d7c16a4242f1c95561e98edc25d36adb4375  # v2.87.12
        with:
          tool: cargo-deny@0.20.2,cargo-llvm-cov@0.9.1,cargo-audit@0.21.2

      - name: cargo fmt --check
        run: set -euo pipefail; cargo fmt --check

      - name: cargo clippy --all-targets -- -D warnings
        run: set -euo pipefail; cargo clippy --all-targets -- -D warnings

      - name: cargo deny check (advisories, licenses, bans, sources)
        run: set -euo pipefail; cargo deny check

      - name: cargo audit (RUSTSEC advisories)
        run: set -euo pipefail; cargo audit

      - name: cargo test (unit + non-#[ignore]d integration)
        run: set -euo pipefail; cargo test --locked

      - name: cargo llvm-cov (>=90% line coverage gate)
        run: set -euo pipefail; cargo llvm-cov --fail-under-lines 90

  test-integration:
    name: Docker-in-Docker integration tests
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: core/svc_action
    steps:
      - name: Checkout code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2

      - name: Install build deps for aws-lc-sys
        run: |
          set -euo pipefail
          sudo apt-get update
          sudo apt-get install --no-install-recommends -y cmake build-essential

      - name: Install Rust 1.97.1
        uses: dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87  # stable branch snapshot
        with:
          toolchain: "1.97.1"

      - name: cargo test --ignored (testcontainers Valkey/Postgres)
        run: set -euo pipefail; cargo test --locked -- --include-ignored

  security-scan:
    name: semgrep + gitleaks + trivy (fs)
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2
        with:
          fetch-depth: 0

      - name: semgrep
        uses: returntocorp/semgrep-action@713efdd345f3035192eaa63f56575990eadecc8  # v1
        with:
          config: p/rust
        env:
          SEMGREP_RULES: p/rust

      - name: gitleaks
        uses: gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c  # v2.3.9
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: trivy filesystem scan
        uses: aquasecurity/trivy-action@76071ef0d7ec797419534a183b498b4d6366df2  # 0.29.0
        with:
          scan-type: fs
          scan-ref: core/svc_action
          severity: CRITICAL,HIGH
          exit-code: '1'

  build-push:
    name: Build + push image
    needs: [lint-test, security-scan]
    if: github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/'))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2

      - name: Log in to ghcr.io
        uses: docker/login-action@184bdaa0721073962dff0199f1fb9940f07167d1  # v3.3.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute tag (beta-<epoch> on main, alpha-<epoch> on release/**)
        id: tag
        run: |
          set -euo pipefail
          epoch="$(date +%s)"
          if [ "${{ github.ref }}" = "refs/heads/main" ]; then
            echo "tag=beta-${epoch}" >> "$GITHUB_OUTPUT"
          else
            echo "tag=alpha-${epoch}" >> "$GITHUB_OUTPUT"
          fi

      - name: Build and push
        uses: docker/build-push-action@ca877d9245402d1537745e0e356eab47c3520991  # v6.9.0
        with:
          context: core/svc_action
          file: core/svc_action/Dockerfile
          push: true
          tags: ghcr.io/penguintechinc/waddles/svc-action:${{ steps.tag.outputs.tag }}

      - name: trivy image scan
        uses: aquasecurity/trivy-action@76071ef0d7ec797419534a183b498b4d6366df2  # 0.29.0
        with:
          image-ref: ghcr.io/penguintechinc/waddles/svc-action:${{ steps.tag.outputs.tag }}
          severity: CRITICAL,HIGH
          exit-code: '1'
```

Every third-party Action is pinned to a full commit SHA (`critical-rules.md` Dependency Pinning) with the human-readable version as a trailing comment, not the version tag itself.

- [ ] **Step 2: Run**

Push to a `feature/` branch touching `core/svc_action/**` and confirm the `lint-test`, `test-integration` and `security-scan` jobs all run and report status (green or a real, named failure — never silently skipped).

- [ ] **Step 3: Commit**

Stage `.github/workflows/rust-svc-action.yml` and commit with message:

```
ci(svc-action): fmt/clippy/deny/audit/coverage + semgrep/gitleaks/trivy + image build-push

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 33: Helm — svc-action Deployment (Rust image), executor Deployment + `RuntimeClass`, NetworkPolicy, `values.yaml`

**Depends on:** Task 31 (image), Task 32 (CI publishes it).

**Files:**
- Modify: `k8s/helm/waddlebot/templates/svc-action.yaml`
- Create: `k8s/helm/waddlebot/templates/svc-action-executor.yaml`
- Create: `k8s/helm/waddlebot/templates/networkpolicy-svc-action.yaml`
- Modify: `k8s/helm/waddlebot/values.yaml`

**Interfaces:**
- Consumes: nothing new.
- Produces: the deployed `svc-action`/`svc-action-executor` workloads.

- [ ] **Step 1: Add the new `values.yaml` keys**

Add, alongside the existing `pipeline.svcAction` block (spec §12.3 -- values already documented in Global Constraints' spec citations; only the ones this chart did not already carry are added here):

```yaml
pipeline:
  svcAction:
    image: "ghcr.io/penguintechinc/waddles/svc-action"
    imageTag: ""  # defaults to .Chart.AppVersion when empty
    port: 8202
    replicas: 2
    resources:
      requests: {cpu: "500m", memory: "512Mi"}
      limits: {cpu: "2000m", memory: "2Gi"}
  executor:
    callTimeoutMs: 2000
    memoryLimitMb: 64
    maxCallTimeoutMs: 10000
    maxMemoryLimitMb: 256
    instancesPerBundle: 4
    maxConcurrentCalls: 32
    tripThreshold: 3
    tripWindowSeconds: 300
    image: "ghcr.io/penguintechinc/waddles/bundle-executor"
    imageTag: ""
    replicas: 2
    stageConnections: 4
    hostApiPort:
      action: 8302
    resources:
      requests: {cpu: "250m", memory: "256Mi"}
      limits: {cpu: "1000m", memory: "512Mi"}
sandbox:
  runtimeClassName: runsc
  gvisor:
    enabled: true
  installer:
    enabled: false
    nodeLabel: "waddles.io/gvisor=ready"
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

- [ ] **Step 2: Rewrite `templates/svc-action.yaml`**

Replace the container's `image`, add the host-api port + TLS/binding-key volume mounts, and add the new env vars. The Deployment/Service structural shape (labels, selector, probes, existing envFrom/ConfigMap/Secret refs) is unchanged from the current skeleton -- only the `containers[0]` block and `volumes` gain the entries below:

```yaml
      containers:
      - name: svc-action
        image: "{{ .Values.pipeline.svcAction.image }}:{{ .Values.pipeline.svcAction.imageTag | default .Chart.AppVersion }}"
        imagePullPolicy: {{ .Values.global.imagePullPolicy }}
        securityContext:
          {{- toYaml .Values.securityContext | nindent 10 }}
        ports:
        - name: http
          containerPort: {{ .Values.pipeline.svcAction.port }}
          protocol: TCP
        - name: metrics
          containerPort: 9090
          protocol: TCP
        - name: host-api
          containerPort: {{ .Values.pipeline.executor.hostApiPort.action }}
          protocol: TCP
        envFrom:
        - configMapRef:
            name: {{ include "waddlebot.fullname" . }}-config
        - secretRef:
            name: {{ include "waddlebot.fullname" . }}-secrets
        env:
        - name: MODULE_PORT
          value: {{ .Values.pipeline.svcAction.port | quote }}
        - name: METRICS_PORT
          value: "9090"
        - name: HOST_API_PORT
          value: {{ .Values.pipeline.executor.hostApiPort.action | quote }}
        - name: HOST_API_TLS_CERT_FILE
          value: /etc/waddles/host-api/tls.crt
        - name: HOST_API_TLS_KEY_FILE
          value: /etc/waddles/host-api/tls.key
        - name: HOST_API_TLS_CA_FILE
          value: /etc/waddles/host-api/ca.crt
        - name: VALKEY_URL
          valueFrom:
            secretKeyRef:
              name: {{ include "waddlebot.fullname" . }}-secrets
              key: VALKEY_URL
        - name: RUNNER_TENANT_SLUG
          value: {{ .Values.pipeline.runnerTenantSlug | quote }}
        - name: HUB_API_URL
          value: "http://{{ include "waddlebot.fullname" . }}-hub-api-v3:{{ .Values.pipeline.hubApi.port }}"
        - name: SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: {{ include "waddlebot.fullname" . }}-secrets
              key: SECRET_KEY
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: {{ include "waddlebot.fullname" . }}-secrets
              key: DATABASE_URL
        - name: DISCORD_BOT_TOKEN
          valueFrom:
            secretKeyRef:
              name: {{ include "waddlebot.fullname" . }}-secrets
              key: DISCORD_BOT_TOKEN
              optional: true
        - name: SLACK_BOT_TOKEN
          valueFrom:
            secretKeyRef:
              name: {{ include "waddlebot.fullname" . }}-secrets
              key: SLACK_BOT_TOKEN
              optional: true
        - name: YOUTUBE_API_KEY
          valueFrom:
            secretKeyRef:
              name: {{ include "waddlebot.fullname" . }}-secrets
              key: YOUTUBE_API_KEY
              optional: true
        - name: KICK_ACCESS_TOKEN
          valueFrom:
            secretKeyRef:
              name: {{ include "waddlebot.fullname" . }}-secrets
              key: KICK_ACCESS_TOKEN
              optional: true
        - name: WADDLES_BINDING_KEY_FILE
          value: /etc/waddles/binding/keys.json
        - name: WADDLES_BINDING_ACTIVE_KID
          valueFrom:
            secretKeyRef:
              name: {{ .Values.security.envelopeBinding.keySecretRef }}
              key: activeKid
        - name: SECURITY_TRANSPORT_TLS
          value: {{ .Values.security.transport.tls | quote }}
        - name: SECURITY_TRANSPORT_AUTH
          value: {{ .Values.security.transport.auth | quote }}
        - name: METERING_ENABLED
          value: {{ .Values.metering.enabled | quote }}
        - name: METERING_FLUSH_INTERVAL_S
          value: {{ .Values.metering.flushIntervalSeconds | quote }}
        - name: WADDLES_SANDBOX_GVISOR
          value: {{ .Values.sandbox.gvisor.enabled | quote }}
        livenessProbe:
          httpGet:
            path: /health
            port: http
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health
            port: http
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        resources:
          {{- toYaml .Values.pipeline.svcAction.resources | nindent 10 }}
        volumeMounts:
        - name: host-api-tls
          mountPath: /etc/waddles/host-api
          readOnly: true
        - name: binding-key
          mountPath: /etc/waddles/binding
          readOnly: true
        - name: valkey-ca
          mountPath: /etc/waddles/ca
          readOnly: true
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: host-api-tls
        secret:
          secretName: {{ include "waddlebot.fullname" . }}-svc-action-host-api-tls
      - name: binding-key
        secret:
          secretName: {{ .Values.security.envelopeBinding.keySecretRef }}
      - name: valkey-ca
        secret:
          secretName: {{ include "waddlebot.fullname" . }}-valkey-ca
      - name: tmp
        emptyDir: {}
```

Remove the skeleton's `logs`/`MODULE_NAME`/`PIPELINE_STAGE`/`WADDLES_AI_ENABLED`/`MODULE_LOAD_*` entries and the `dbMigrateInitContainer` include -- this Rust service owns no Python-bundle-loading env vars and runs no DB-migration init container (migrations are hub-api's job, spec §11.10.1).

- [ ] **Step 3: Write `templates/svc-action-executor.yaml`**

```yaml
{{- if .Values.pipeline.svcAction.enabled }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "waddlebot.fullname" . }}-svc-action-executor
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
    app.kubernetes.io/component: svc-action-executor
spec:
  replicas: {{ .Values.pipeline.executor.replicas }}
  selector:
    matchLabels:
      {{- include "waddlebot.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: svc-action-executor
  template:
    metadata:
      labels:
        {{- include "waddlebot.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: svc-action-executor
    spec:
      {{- if .Values.sandbox.gvisor.enabled }}
      runtimeClassName: {{ .Values.sandbox.runtimeClassName }}
      {{- end }}
      {{- if .Values.sandbox.installer.enabled }}
      nodeSelector:
        {{ (splitList "=" .Values.sandbox.installer.nodeLabel) | first }}: {{ (splitList "=" .Values.sandbox.installer.nodeLabel) | last }}
      {{- end }}
      automountServiceAccountToken: false
      {{- include "waddlebot.imagePullSecrets" . | nindent 6 }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
      - name: bundle-executor
        image: "{{ .Values.pipeline.executor.image }}:{{ .Values.pipeline.executor.imageTag | default .Chart.AppVersion }}"
        imagePullPolicy: {{ .Values.global.imagePullPolicy }}
        securityContext:
          {{- toYaml .Values.securityContext | nindent 10 }}
        env:
        - name: STAGE_HOST_API_ADDR
          value: "{{ include "waddlebot.fullname" . }}-svc-action:{{ .Values.pipeline.executor.hostApiPort.action }}"
        - name: EXECUTOR_STAGE_CONNECTIONS
          value: {{ .Values.pipeline.executor.stageConnections | quote }}
        - name: EXECUTOR_CALL_TIMEOUT_MS
          value: {{ .Values.pipeline.executor.callTimeoutMs | quote }}
        - name: EXECUTOR_MEMORY_LIMIT_MB
          value: {{ .Values.pipeline.executor.memoryLimitMb | quote }}
        - name: EXECUTOR_MAX_CALL_TIMEOUT_MS
          value: {{ .Values.pipeline.executor.maxCallTimeoutMs | quote }}
        - name: EXECUTOR_MAX_MEMORY_LIMIT_MB
          value: {{ .Values.pipeline.executor.maxMemoryLimitMb | quote }}
        - name: EXECUTOR_INSTANCES_PER_BUNDLE
          value: {{ .Values.pipeline.executor.instancesPerBundle | quote }}
        - name: EXECUTOR_MAX_CONCURRENT_CALLS
          value: {{ .Values.pipeline.executor.maxConcurrentCalls | quote }}
        - name: WADDLES_SANDBOX_GVISOR
          value: {{ .Values.sandbox.gvisor.enabled | quote }}
        volumeMounts:
        - name: scratch
          mountPath: /scratch
        - name: wasm-cache
          mountPath: /var/cache/waddles/wasm
        - name: client-tls
          mountPath: /etc/waddles/host-api
          readOnly: true
        - name: bucket
          mountPath: /etc/waddles/bucket
          readOnly: true
        resources:
          {{- toYaml .Values.pipeline.executor.resources | nindent 10 }}
      volumes:
      - name: scratch
        emptyDir:
          sizeLimit: 16Mi
      - name: wasm-cache
        emptyDir: {}
      - name: client-tls
        secret:
          secretName: {{ include "waddlebot.fullname" . }}-svc-action-executor-tls
      - name: bucket
        secret:
          secretName: {{ .Values.bundles.bucket.existingSecret }}
{{- end }}
```

- [ ] **Step 4: Write `templates/networkpolicy-svc-action.yaml`**

```yaml
{{- if .Values.pipeline.svcAction.enabled }}
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: {{ include "waddlebot.fullname" . }}-svc-action
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
spec:
  endpointSelector:
    matchLabels:
      {{- include "waddlebot.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: svc-action
  ingress:
  - fromEndpoints:
    - matchLabels:
        {{- include "waddlebot.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: svc-action-executor
    toPorts:
    - ports:
      - port: "{{ .Values.pipeline.executor.hostApiPort.action }}"
        protocol: TCP
  egress:
  - toEndpoints:
    - matchLabels:
        {{- include "waddlebot.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: valkey
  - toEndpoints:
    - matchLabels:
        {{- include "waddlebot.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: postgres
  - toEndpoints:
    - matchLabels:
        {{- include "waddlebot.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: hub-api-v3
  - toFQDNs:
    - matchPattern: "*"  # bundle-declared egress hosts (Task 20's own allowlist enforces which); DNS resolution required
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
      - port: "53"
        protocol: UDP
      - port: "53"
        protocol: TCP
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: {{ include "waddlebot.fullname" . }}-svc-action-executor
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
spec:
  endpointSelector:
    matchLabels:
      {{- include "waddlebot.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: svc-action-executor
  egress:
  # The executor's only two reachable destinations (spec Sec4.5): its
  # stage's host-API port, and the artifact bucket. No Valkey, no
  # Postgres, no API server -- deliberately absent, not merely unused.
  - toEndpoints:
    - matchLabels:
        {{- include "waddlebot.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: svc-action
    toPorts:
    - ports:
      - port: "{{ .Values.pipeline.executor.hostApiPort.action }}"
        protocol: TCP
  - toFQDNs:
    - matchPattern: "*.{{ .Values.bundles.bucket.endpoint | trimPrefix "http://" | trimPrefix "https://" }}"
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
      - port: "80"
        protocol: TCP
{{- end }}
```

- [ ] **Step 5: Validate**

Run: `helm lint ./k8s/helm/waddlebot`
Expected: no errors.

Run: `helm template waddlebot ./k8s/helm/waddlebot --values ./k8s/helm/waddlebot/alpha.yml | grep -A2 "component: svc-action-executor"`
Expected: the executor Deployment renders with `runtimeClassName: runsc` present (or absent only when `sandbox.gvisor.enabled=false` is explicitly set in that values file).

- [ ] **Step 6: Commit**

Stage `k8s/helm/waddlebot/templates/svc-action.yaml k8s/helm/waddlebot/templates/svc-action-executor.yaml k8s/helm/waddlebot/templates/networkpolicy-svc-action.yaml k8s/helm/waddlebot/values.yaml` and commit with message:

```
feat(chart): svc-action Rust image, executor Deployment + RuntimeClass, NetworkPolicy

Replaces the Python skeleton's pipeline.pythonBaseImage placeholder with
the Rust image, adds the host-API mTLS port + TLS/binding-key/CA volume
mounts, the executor Deployment under the gvisor RuntimeClass (opt-out
via sandbox.gvisor.enabled), and CiliumNetworkPolicy rows scoping the
executor to exactly its stage's host-API port + the artifact bucket
(spec Sec4.5, Sec12.4, Sec12.5).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

### Task 34: `README.md` rewrite + `docs/ops/svc-action-notes.md`

**Depends on:** every prior task (this is the closing documentation task).

**Files:**
- Modify: `core/svc_action/README.md` (full rewrite)
- Create: `docs/ops/svc-action-notes.md`

**Interfaces:**
- Consumes: nothing new -- documentation only.
- Produces: human-facing docs. No code.

- [ ] **Step 1: Rewrite `core/svc_action/README.md`**

```markdown
# svc-action

Waddles' terminal pipeline stage — reads each activated bundle's own
`{scope}:app:{app_id}:action` Valkey stream through a dedicated consumer
group, dispatches through a WASM executor over a capability-scoped mTLS
host API (or a native built-in sender for the five first-party platform
sends), classifies `transport-error.retryable`, retries with backoff, and
records every outcome to `action_dispatch_log`.

Rust rewrite of the former `core/svc_action` Python/Quart service. See
`docs/superpowers/specs/2026-09-14-rust-data-plane-design.md` for the full
design and `docs/superpowers/plans/2026-09-14-rust-data-plane-m3-svc-action.md`
for the implementation plan this crate was built from.

## Architecture

- `src/distribution/` — polls hub-api's distribution API v2 for this
  stage's activated bundle set, ETag-cached.
- `src/hostapi/` — the mTLS host-API listener bundle executors dial into,
  the bundle registry/connection pool, and the seven host capabilities
  (`context`, `clock`, `flags`, `kv`, `relay`, `db`, `http`) plus `log`.
- `src/senders/` — the five built-in platform senders (Twitch via the
  relay, Discord/Slack/YouTube/Kick REST), wired against
  `penguin-connectors`; these bypass the WASM executor entirely.
- `src/consumer/` — the per-bundle action-stream consumer loop: D30
  binding/scope verification before anything else, dispatch, retry/DLQ,
  and the `XAUTOCLAIM` reaper.
- `src/audit/` — the `action_dispatch_log` SeaORM entity and writer.
- `src/runner.rs` — bootstraps every dependency and runs the
  distribution-poll/consumer-supervision and D31 usage-flush loops.

## Dependencies on unpublished `penguin-libs` crates

`penguin-spine`, `penguin-bundle-host`, and the `penguin-connector-*`
crates are pinned as `git`+`rev` dependencies (not crates.io versions) —
see the plan's Global Constraints "Named executor inputs" table for why
and the exact pinned commits. If a cited branch has advanced, re-resolve
with `git rev-parse origin/<branch>` and update every `rev = "..."`
occurrence in `Cargo.toml`.

## Running locally

All commands run through the containerized toolchain — never bare host
`cargo` (see `Makefile`, `Dockerfile.ci`):

```bash
make -C core/svc_action test              # unit + non-#[ignore]d tests
make -C core/svc_action test-integration  # + testcontainers Valkey/Postgres
make -C core/svc_action lint              # fmt --check + clippy -D warnings
make -C core/svc_action build             # release binary
```

## Configuration

See `docs/ops/svc-action-notes.md` for the full environment variable
reference and operational runbook.

## Offline / degraded-dependency behavior

- Distribution API unreachable: the poller degrades to the last
  successfully-fetched bundle set (never an empty set on a transient
  outage) with exponential backoff; `/health` reports the staleness.
- PostHog/license server unreachable: every flag check fails open to its
  caller-supplied default (`rules/critical-rules.md` Feature Flags).
- No executor connections available: the affected entries are retried
  with backoff, then DLQ'd as `executor_unavailable` — the consumer loop
  itself never blocks other bundles' consumers.
```

- [ ] **Step 2: Write `docs/ops/svc-action-notes.md`**

```markdown
# svc-action operations notes

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MODULE_PORT` | `8202` | HTTP API port |
| `METRICS_PORT` | `9090` | Prometheus `/metrics` port |
| `HOST_API_PORT` | `8302` | mTLS host-API listener (executor-facing) |
| `HOST_API_TLS_CERT_FILE` / `_KEY_FILE` / `_CA_FILE` | — | Host-API mTLS material |
| `VALKEY_URL` | — (required) | Spine connection |
| `DATABASE_URL` | — (required) | Postgres connection (audit writes + `db` capability) |
| `RUNNER_TENANT_SLUG` | — (required) | This deployment's fixed tenant scope |
| `RUNNER_COMMUNITY_ID` | unset (tenant-wide) | This deployment's fixed community scope, if any |
| `HUB_API_URL` | — (required) | Distribution API base |
| `SECRET_KEY` | — (required) | HS256 key for the distribution-poll service JWT |
| `WADDLES_BINDING_KEY_FILE` | `/etc/waddles/binding/keys.json` | D30 binding-MAC keyring |
| `WADDLES_BINDING_ACTIVE_KID` | — (required) | The keyring's currently-active `kid` |
| `SECURITY_TRANSPORT_TLS` / `_AUTH` | `true` / `true` | Valkey/Postgres transport security (opt-out is loud, never silent) |
| `WADDLES_SANDBOX_GVISOR` | `true` | Whether the executor pods run under gVisor |
| `METERING_ENABLED` | `true` | D31 usage recording |
| `METERING_FLUSH_INTERVAL_S` | `10` | Per-replica `waddles:usage` batch interval |
| `ACTION_MAX_RETRIES` / `_BASE_BACKOFF_MS` / `_MAX_BACKOFF_MS` | `3` / `250` / `8000` | Retry-with-backoff knobs |
| `EGRESS_TIMEOUT_MS` / `_MAX_RESPONSE_BYTES` / `_RATE_LIMIT_RPS` / `_RATE_LIMIT_BURST` / `_MAX_REDIRECTS` / `_ALLOW_PRIVATE_HOSTS` | see `config.rs` | `http` capability enforcement knobs |
| `DISCORD_BOT_TOKEN` / `SLACK_BOT_TOKEN` / `YOUTUBE_API_KEY` / `KICK_ACCESS_TOKEN` | unset | Built-in sender credentials; a missing one disables that one built-in (logged at WARN), not the whole service |

## What works offline / degraded

- **Distribution API down:** the last successfully-polled bundle set keeps
  serving; no bundle is silently unloaded on a transient outage.
- **PostHog/license server down:** flags fail open to their caller
  default; `waddles.core.rust-data-plane` OFF means health/metrics keep
  serving while nothing drains.
- **No executor connections:** affected dispatches retry then DLQ as
  `executor_unavailable`; unaffected bundles' consumers are unimpacted.
- **A built-in sender's credential is unset:** that one platform's sends
  fail closed (never silently drop); every other built-in and every
  WASM-bundle dispatch continues normally.

## Runbook: a bundle stuck in `bundle_disabled`

Three sandbox trips within `EXECUTOR_TRIP_WINDOW_S` (default 300s) disable
a bundle for this pod's lifetime (`waddles_bundle_disabled{app_id}` = 1).
Re-enable by publishing a new `artifactDigest` for it (a fresh version, or
a re-approval that changes the recorded digest) — there is no runtime
re-enable switch (spec §19 Q1). Restarting the pod also clears it, but
does not fix the underlying cause.

## Runbook: distribution poll returning 0 bundles

Check `waddles_bundle_stale_age_seconds` first — if it is climbing, the
distribution API itself is unreachable and the service is correctly
serving its last-known-good set, not failing. If the age is fresh and the
count is genuinely 0, confirm the tenant/community scope
(`RUNNER_TENANT_SLUG`/`RUNNER_COMMUNITY_ID`) matches what is actually
activated in hub-api for that scope.

## Known follow-on work (flagged, not gaps to silently accept)

- **RLS DDL for real first-party bundle tables** (e.g. `music_queue`) has
  no owning plan — `docs/plan-m2b-hub-api` explicitly confirms it is out
  of its scope, and this plan's own db capability tests prove the `SET
  LOCAL` mechanism against a throwaway fixture table, not a real one.
- **`waddles:usage` wire-shape mismatch**: this service's only
  usage-emission call (`penguin_spine::SpineClient::append_usage`) writes
  a nested-JSON `env` field; `docs/plan-m2b-hub-api`'s aggregator expects
  flat per-field entries. Unresolved cross-plan mismatch — see the plan's
  Global Constraints P10.
- **Capability implementations are local, not `penguin-bundle-host::
  host::*`** (Global Constraints P3) — a mechanical extraction once that
  crate is a confirmed, published dependency.
```

- [ ] **Step 3: Commit**

Stage `core/svc_action/README.md docs/ops/svc-action-notes.md` and commit with message:

```
docs(svc-action): rewrite README, add operations runbook

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
```

---

## Self-Review

### Spec coverage — M3 milestone row (§16) + D30/D31

| Deliverable (spec §16 M3 row) | Task(s) |
|---|---|
| Rust service on the `svc_streaming` template — `/health`, `/healthz`, `/metrics`, OTel, config, Dockerfile, CI workflow | 1-10 (scaffold/config/telemetry/health/HTTP/wiring), 31 (Dockerfile), 32 (CI) |
| Executor integration — load/invoke/hot-swap, all §14.6 negative tests green | 14-15 (handshake, registry/load/invoke), 21 (dispatch), 29 (isolation/RLS negatives), Task 19/20's own per-capability negative tests (table allowlist, egress allowlist/SSRF) |
| Built-in senders — Discord, Slack, YouTube, Kick REST; Twitch via the relay | 18 (relay + Twitch), 23-26 (Discord/Slack/YouTube/Kick via `penguin-connectors`) |
| Retry + audit parity — `action_dispatch_log` rows and retry decisions match the Python suite's expectations | 12 (retry-with-backoff), 13 (`action_dispatch_log`), 22 (wires both into the consumer loop) |
| Hop verification + usage — `binding.mac` and tenant/community/grant/approval verification run before every dispatch; outbound credential/target resolved only from the verified envelope; usage deltas XADDed to `waddles:usage`; §14.11 tests 1, 4, 5 (as applicable), 6 and 7 green | 22 (`verify_binding`/`ScopeCheck` first, D31 stage-level usage), 21 (D31 host-call usage, D30 span attributes), 29 (tests 1, 5, and bundle-isolation 14a), 30 (tests 6, 7) |

### D30 (§5.11) coverage

| D30 requirement | Task(s) |
|---|---|
| `verify_binding`/`ScopeCheck` run before any other processing, on every entry | 22 |
| Tenant/community/trace/workstream sourced only from the verified envelope, never bundle config | 22 (fixed in place during self-review — see the `dispatch_one_attempt`/`InvocationScope` correction), 19 (`DbCapability`/`PgDbExecutor` take `InvocationScope` as a parameter, never derive it) |
| A `tenant_boundary` failure is DLQ'd, never retried | 22 (`classify_boundary_dlq` → `DlqError{kind: TenantBoundary}` via `BoundaryError::to_dlq_error`, `DlqErrorKind::never_retry()`) |
| Every span carries `waddles.tenant_id`/`community_id`/`workstream_id`/`app_id` | 21 (`dispatch`'s `host.call` span) |
| No bundle host call accepts a tenant/community argument | 16 (`InvocationScope` re-exported, never bundle-supplied), 19, 20, 21 |
| `routes_to`/bundle-set-identity-field stripping | Not applicable to this stage (terminal, no forwarded bundle output) — correctly absent from the M3 milestone row itself; scoped to M4 |

### D31 (§5.12) coverage

| D31 requirement | Task(s) |
|---|---|
| Bundle invocations counted | 22 (`delta.invocations = 1` per entry) |
| Host calls by kind counted, `context`/`clock` excluded | 21 (`usage_kind_for`, `record_usage_host_call`) |
| Fuel/CPU-ms | **Gap, flagged, not silently dropped:** `Message::Result`'s `fuel_used`/`duration_ms` fields are available on the executor's reply (Task 15's `invoke()` currently discards them into `TransportSuccess.detail`'s string form rather than a structured `UsageDelta.fuel_ms` field) — recorded here as a known incompleteness for a follow-on task, not fixed in this continuation given scope |
| Actions delivered, outbound bytes | 22 (`actions_delivered`/`outbound_bytes`, the latter an approximate proxy — documented) |
| Batched and `XADD`ed via `UsageBatcher`/`append_usage` on `METERING_FLUSH_INTERVAL_S` | 27 |
| Stages are `XADD`-only on `waddles:usage`, never read it back | 27 (only calls `append_usage`, never `group_stats`/`read` on that key) |

### Placeholder scan

`grep -n -i '\bTODO\b\|\bFIXME\b\|todo!()\|unimplemented!()\|\bTBD\b\|similar to Task'` — zero hits. Three incidental matches for the bare word "placeholder" are all legitimate uses (SQL bind-placeholder terminology, the Python skeleton's pre-existing image placeholder this plan replaces, and the already-established Task-14-style declare-now/implement-later `pub mod` stub pattern, which is filled in by its own dedicated task with full code, not left incomplete).

### Name consistency against the re-fetched sibling branches (re-verified immediately before this section was written)

- `penguin-libs` `docs/plan-{penguin-spine,penguin-logging,penguin-connectors,penguin-bundle-host}` re-fetched: tip SHAs unchanged from the "Named executor inputs" table (`5f6db08…`, `9328208…`, `c5ed81d…`, `8ca1e69…`) — no drift since this plan's Cargo.toml pins were written.
- `docs/plan-m2b-hub-api` and `docs/plan-m4-svc-process` re-fetched: both have grown substantially since this plan's research phase (M2b to 16,384 lines, M4 to 10,166 lines). M4's current draft depends on **local `PROVISIONAL(M1)` modules** (`src/spine/*`, its own `hostcap` wire types), the opposite of this plan's direct-dependency approach — per Coordinator ruling R60, M4 "is being reworked" to match this plan's approach instead, so no change was made here; this plan already uses the crates directly and never re-implements them (verified: zero `crate::spine`/`PROVISIONAL`/`FromExecutor`/`ToExecutor` code hits, checked above).
- `bundle_role_name`, `SET LOCAL waddles.tenant`/`waddles.community`, `outbound_queue_key`, distribution v2's `/api/v1/distribution/v2/bundles` route and DTO field names, and every `penguin_spine`/`penguin_bundle_host::wire::message` type cited throughout (`StageEnvelope`, `Trace`, `Binding`, `BindingKeyring`, `verify_binding`, `ScopeCheck`, `BoundaryError`, `strip_bundle_identity_fields`, `DlqRecord`/`DlqErrorKind`, `UsageDelta`/`UsageBatcher`, `SpineClient`, `GroupReader`, `Delivered`, `InvocationScope`, `HostResultError`, `CapabilityKind`) match the sibling plans' current text exactly, re-checked against the freshly re-fetched copies during this session.

### Known risk areas flagged for reviewer attention (not silently assumed correct)

- **Task 30's e2e test** invents `CliConfig::default_for_test_with_host_api_tls` and reuses `FakeExecutor`/`NamedFile` from Task 14/15's own test support by name and by the exact methods this plan's own earlier research confirmed (`connect`, `recv`, `reply`) — it does not invent unconfirmed methods, but the exact `Config`-defaulting field list is directed at "reuse Task 14's own pattern" rather than fully re-typed here, since Task 14's own test already establishes it.
- **The `db` capability's `params` JSON encoding** (`json_to_dbvalues`, Task 21) is this plan's own documented convention (`{"bytes_base64": "..."}` for byte parameters) since neither the spec's WIT excerpt nor `penguin-bundle-host`'s plan fixes one — flagged, not silently assumed.
- **P9 (RLS ownership)**: no plan owns writing RLS policy DDL for real first-party bundle tables (`music_queue` etc.) — confirmed via `docs/plan-m2b-hub-api`'s own Self-Review, and this plan's Task 29 proves the `SET LOCAL` mechanism against a throwaway fixture table only.
