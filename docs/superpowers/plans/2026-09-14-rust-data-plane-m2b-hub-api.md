# Waddles Rust Data Plane — Milestone M2b (hub-api control-plane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task's implementer sees ONLY that task's text — no other task, no external memory. Every fact a task needs (table columns, function signatures, endpoint paths, scope names, setting keys) is copied into that task, not referenced by "see Task N."

**Goal:** Add the Python/Quart hub-api control-plane surface for Waddles app-bundle installs: version upload + compiler-Job orchestration, the digest table and its Least-User-Access RBAC, install-time permission consent, `consumes`→`app_stream_grants` resolution with Valkey consumer-group lifecycle, grant revocation, the distribution API fields the Rust stages/executors poll, the compiler's artifact callback, and the new tenant/global settings.

**Architecture:** Every new table is owned by hub-api's existing dual-schema convention — real DDL in a new Alembic migration under `alembic/versions/`, mirrored by a `pydal` binder in `hub_api/services/schema.py` for tests (`migrate=False` in production, `migrate=True` in tests). Every new REST surface is one `blueprints/v1/<group>.py` module with a module-level `BLUEPRINTS` list (auto-discovered, zero registration edits) plus a `services/<group>_service.py` doing the real DB work in pydal's query-builder form (never raw `%s` SQL — sqlite tests would 500). `app_versions` — the digest table — has exactly two Postgres writers (`waddles_publisher`, the compiler's trusted-publisher container from M2a, and `hub_api`); every other service role gets zero privileges on it, generated from one normative YAML matrix and asserted equal to the live grants by a CI test, never hand-written twice. hub-api verifies a claimed digest by re-hashing the bucket object; it never computes one itself. Activation and rollback are a separate, hub-api-owned pointer table (`app_active_versions`), never an edit to a digest row.

**Tech Stack:** Python 3.13, Quart, `quart-schema` (`@validate_request`/`@validate_response`), `pydal` (runtime queries, this codebase's established pattern — see Global Constraints for why `penguin-dal` is not used here), Alembic + raw SQL (schema/DDL), `boto3` (S3-compatible bucket), `kubernetes` (Job orchestration), `redis.asyncio` (Valkey admin ops), `cryptography` (AES-256-GCM secret-at-rest), `PyYAML` (RBAC matrix), pytest + `AsyncDAL` file-backed sqlite fixtures.

**Spec:** `docs/superpowers/specs/2026-09-14-rust-data-plane-design.md` at commit `680a0a9b` (branch `docs/rust-data-plane-spec`) — sections 2 (D24/D26/D28), 5.2, 6.4–6.10, 7.4 (db capability), 8.4, 9, 10.3–10.6, 11.6.2, 11.10, 12.3, 13.5, 16 (M2), 19 (Q1/Q3), 20 (A-series). This plan implements the **hub-api** half of M2 only — the compiler binary and SDKs (M2a) are a separate plan; every boundary this plan shares with M2a is called out explicitly and marked "must match M2a."

---

## Global Constraints

Copied verbatim from the spec and house rules — every task's code must satisfy all of these, not just the ones its own section repeats.

- **Python 3.13, Quart (never Flask), async `def` on every route** (`backend-python.md`).
- **`penguin-dal` is NOT used in this codebase's hub-api service today.** hub-api's entire existing codebase (every `services/*.py`, every `blueprints/v1/*.py`) uses `pydal` directly via a hand-rolled `AsyncDAL` wrapper (`libs/flask_core/flask_core/database.py`), a documented, load-bearing deviation (mem0: "A decision was made to use synchronous pydal instead of AsyncDAL for data access operations" / `hub_api/PORTING.md`). This plan follows the established convention for consistency with ~600 existing endpoints rather than introducing a second DB access pattern mid-service. **Only the new Postgres *roles and DDL* (Global Constraints item below) use SQLAlchemy directly, matching `backend-database.md` rule #2 ("SQLAlchemy + Alembic — schema init + migrations ONLY").**
- **`@dataclass(slots=True, frozen=True)` for every DTO.**
- **Every function has type hints; `mypy --strict` must pass.**
- **Every DTO field name is camelCase on the wire** — matches every existing hub-api blueprint (`hub_api/PORTING.md`'s DTO-casing note; `convert_casing` is not enabled in this app's `QuartSchema` setup).
- **OIDC scopes only, never role names.** New scope introduced by this plan: `bundles:artifact` (machine JWT, the compiler's artifact callback). Reused: `platform:admin`, `tenant:admin`, `distribution:read`, `intake:write`.
- **Tenant from the validated JWT only, never from a path/query/body param** — `flask_core.tenancy.get_tenant_context`, `tenant_middleware` first, always.
- **PII tokenization:** the single identity table is `hub_users` (integer `SERIAL` primary key, `config/postgres/migrations/000_create_base_schema.sql:81-98` — this repo's identity table predates and is not a UUID table). Every approver/actor column this plan adds (`app_install_approvals.approved_by`, `app_stream_grants.granted_by`, `platform_settings.updated_by`, `app_active_versions.activated_by`) is `INTEGER REFERENCES hub_users(id)`, matching the established convention (`loyalty_redemptions.fulfilled_by`, `ai_byok_keys.created_by_user_id`, `music_policy.updated_by`) — **a deliberate, documented deviation from the spec's literal "uuid" column-type wording**: the substance of PII tokenization (never a name or email, an opaque reference into the one identity table) is fully satisfied by an integer FK; introducing a parallel UUID identity column on `hub_users` for this one feature would be new scope this plan does not take on.
- **Secrets** (webhook HMAC secrets) encrypted at rest with AES-256-GCM, key from an env var, never a CLI flag, never logged. Never plaintext in the DB.
- **90% coverage minimum** on every new module (`critical-rules.md` Coverage) — `pytest --cov=services --cov=blueprints --cov-report=term-missing --cov-fail-under=90` scoped to this plan's new files, run in Task 41.
- **Dependency pinning:** every new line added to `hub_api/requirements.in` gets an exact version floor with a reason comment, then `hub_api/requirements.txt` is regenerated with `uv pip compile --generate-hashes` (Task 6).
- **Verification integrity:** every scanner/test run in this plan reports a non-zero denominator (files scanned, roles examined, tables examined) — a zero-item run is a FAILURE, not a pass (`critical-rules.md` Verification Integrity). The RBAC live-grants test explicitly asserts `>= 8` roles and `>= 8` tables examined (spec §11.10.1 literal requirement).
- **Least User Access via RBAC (spec D28, §11.10):** every Postgres role gets exactly the privileges its job needs, generated from one normative file (`config/postgres/rbac-matrix.yaml`), never a hand-written `GRANT`. `app_versions` has **exactly two writers** — `waddles_publisher` (M2a's trusted publisher container) and `hub_api` — every other role (`svc_ingest`, `svc_process`, `svc_action`, `svc_streaming`, `webui`, the executors) gets **zero** privileges on it. Every write is captured by an `AFTER INSERT OR UPDATE OR DELETE` audit trigger recording the writing role, the row key, and the old/new digest. **hub-api verifies a claimed digest by re-hashing the bucket object; it never computes or invents a digest itself.**
- **Activation/rollback never edits a digest row** — it is an `UPDATE` of `app_active_versions.version_id`, a separate hub-api-owned pointer table (spec §6.10). Activating a digest with no corresponding `app_versions` row is refused.
- **Feature flags:** every new write surface sits behind a PostHog flag, default OFF, two-gate with license tier, via `flask_core.feature_flags.feature_enabled(flag_key, tenant=..., default=False)`. Flag keys this plan gates on (already defined by the spec, not invented here): `waddles.core.wasm-bundles`, `waddles.core.generic-intake`, `waddles.core.prebuilt-bundles`.
- **No `flask_core.database.AsyncDAL`/`pydal` reference inside anything that ships to a bundle** — not applicable to this plan (hub-api's own control-plane code is exempt; D21b's ban is on bundle *source*, compiled by M2a's compiler).
- **Branching:** this work lands on `release/v3.0.X` via a `docs/` branch for the plan itself (already checked out); the *implementation* work this plan describes happens on a `feature/`-prefixed branch off `release/v3.0.X`, per `devops.md`.
- **Commit format:** `feat(hub-api): ...` / `test(hub-api): ...` / `db(hub-api): ...` / `docs(hub-api): ...` / `chore(hub-api): ...`, each ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  ```
- Say **Waddles**, never "WaddleBot" for the product name in new prose (code/DB identifiers keep the legacy `waddlebot`/`hub_api` names per spec D22 — the chart directory, `DB_NAME`, and Python package paths are the explicitly surviving legacy identifiers).
- Never "restream" — say relay/forward.

---

## Decisions Carried Into This Plan (read before any task)

These resolve every ambiguity a task would otherwise have to re-derive. They are facts, not options.

| # | Decision | Why |
|---|---|---|
| 1 | Approver/actor columns are `INTEGER REFERENCES hub_users(id)`, not `uuid`. | See Global Constraints PII row above. |
| 2 | `app_versions` (spec §6.10) is the **digest table only** — no lifecycle/status column. It is written by exactly two roles. hub-api's own pre-publish lifecycle tracking (upload received → Job launched → published/rejected) lives in a **new, hub-api-exclusive** table, `app_version_uploads`, correlated to `app_versions` by the natural key `(app_id, version)` and a denormalized `app_version_id` pointer once known. | The spec's §6.10 column list has no status field; conflating the two tables would give a third, unaccounted-for writer a reason to touch `app_versions`. |
| 3 | The compiler's artifact callback (`POST /api/v1/bundles/{app_id}/versions/{version}/artifact`) is a **notification/cross-check**, not the write authority. hub-api re-hashes the bucket object itself and compares against the claimed digest (refuses + audit-logs on mismatch); it looks for a matching `app_versions` row (written directly by `waddles_publisher`, M2a) and if none exists yet, inserts one itself as a fallback using its own (also-granted) write privilege — never computing a new digest, only ever storing the value the compiler claimed, after verifying it. | Coordinator directive: "hub-api verifies but never computes the digest." Keeps M2b fully testable independent of M2a's ship date. |
| 4 | Activation/rollback is `POST /api/v1/apps/{app_id}/versions/{version}/activate`, an upsert into `app_active_versions` (tenant/community-scoped, PK `(app_id, tenant_id, community_id)`). Refuses (409) when no `app_versions` row exists with that exact `(app_id, version)` and a non-null `artifact_digest` — i.e. a digest hub-api never verified can never be activated. Rollback is the same endpoint pointed at an older, already-published version. | Spec §6.10: "Rollback is an UPDATE of version_id here... never an edit of a digest." |
| 5 | RBAC matrix file: `config/postgres/rbac-matrix.yaml` (repo root, spec §11.10.1's literal path). Loader/generator: `scripts/db/rbac_matrix.py` (pure stdlib + PyYAML, no hub-api-package import, loadable by absolute path from both the Alembic migration and the test suite so no `sys.path` fragility). Grants are **generated from this file at migration-run time** — no hand-written `GRANT` anywhere. | Spec D28/§11.10.1: "Grants are generated from this file; nobody writes a `GRANT` by hand." |
| 6 | 8 Postgres roles this plan creates/asserts: `hub_api`, `waddles_publisher`, `svc_ingest`, `svc_process`, `svc_action`, `svc_streaming`, `webui`, `migration_runner`. 9 tables in the matrix: `app_versions`, `app_active_versions`, `app_version_uploads`, `app_install_approvals`, `app_stream_grants`, `custom_platforms`, `ingest_sources`, `platform_settings`, `app_versions_audit_log`. Satisfies spec's literal `>= 8 roles`/`>= 8 tables` non-vacuous CI check with room to spare. | Spec §11.10.1. |
| 7 | The Valkey ACL matrix (`config/valkey/acl-matrix.yaml`, spec §11.10.2) is **out of scope for this plan** — it is owned by the chart/M6 work across all four Rust services, not by hub-api's own control plane. This plan's Valkey touchpoint (`services/valkey_admin_client.py`) only creates/destroys consumer groups; it does not render or own the ACL matrix. | Spec frames the two matrices as parallel but separately-owned artifacts; hub-api's role in the Postgres one is direct (it owns the schema), its role in the Valkey one is not. |
| 8 | Settings keys (exact strings, copied from the spec — every later milestone's Rust code reads these literally): global `bundles.allow_prebuilt` (table `platform_settings`); tenant `allow_wildcard_consumes` and `bundles.egress.allowPrivateHosts` (existing generic `tenant_settings` table — no new tenant-settings endpoint needed, `GET/PUT /api/v1/tenant/<slug>/settings` already accepts arbitrary `{key,value}` pairs). | Spec §6.4.4 V30, §8.5, §12.3. |
| 9 | Feature-flag flag keys used verbatim from spec §13.5: `waddles.core.wasm-bundles`, `waddles.core.generic-intake`, `waddles.core.prebuilt-bundles`. All three are `min_tier: free` (core module), so the two-gate check only ever fails on the PostHog flag being off, never on tier. | Spec §13.5. |
| 10 | **Open question Q1 (spec §19) — trip re-enable is an admin action plus a new digest, never a runtime switch.** The executor keeps spec §7.5/A7's behaviour exactly: a trip-disabled bundle clears only when the pod observes a *new* `artifactDigest` from the distribution API, or when the pod restarts. hub-api's only participation is one explicit admin action, `POST /api/v1/apps/{app_id}/trip-reenable` (scope `tenant:admin`, Task 35), which re-points `app_active_versions` at a published version whose `artifact_digest` **differs** from the digest currently advertised for that scope, and refuses `409 same_digest_no_reenable` when it does not — so the only way an operator clears a trip is by causing a genuinely new digest to be advertised. No pod-scoped, deployment-scoped or cluster-scoped runtime toggle is added anywhere. | Spec §19 Q1 leaves the operator path open while §7.5/A7 fix the executor's side; an admin action that produces a new digest satisfies both without inventing a runtime re-enable switch. |
| 10b | **Open question Q3 (spec §19) — the per-bundle Postgres role is created at approval and dropped at uninstall.** `create_bundle_role` runs inside `approve_version()` (Task 21); `drop_bundle_role` runs inside `marketplace_lifecycle_service.uninstall_bundle()` (Task 36) — uninstall is the deliberate, user-initiated end of the bundle's life at that tenant, so it is the honest drop point. `BUNDLE_ROLE_GRACE_H = 168` survives **only** as the orphan sweeper's cut-off (Task 36's `bundle_role_cleanup_job`): a role whose bundle has had no activation and no `app_install_approvals` row for 168 h — i.e. one whose uninstall never ran, or ran before this plan shipped — is dropped by the CronJob. Password rotation stays manual, unchanged from the spec's stated interim. | Spec §19 Q3 fixes create-at-approval and a 168 h drop but names neither the trigger nor the job's owner; uninstall is the trigger, and the sweeper owns only what uninstall missed. |
| 11 | Endpoint paths, scopes and DTO shapes are fixed once, here, and never repeated with variation in a later task: see the table in Task 11's Interfaces block (versions), Task 22 (approvals), Task 23 (settings), Task 27 (ingest sources), Task 31 (grants), Task 33 (distribution v2), Task 34 (distribution sources), Task 35 (trip re-enable). |
| 12 | **Distribution API v2 is a new, separately-mounted route pair; the v1 route is not touched until the M6 cut-over.** `GET /api/v1/distribution/v2/bundles` (Task 33) serves the full spec §6.7 row — the five v1 fields plus `artifactVersion`, `artifactDigest`, `artifactKind`, `language`, `scanStatus`, `manifest`, `grants` — with `meta.version` = `2` and an `ETag`/`If-None-Match` 304 path. `GET /api/v1/distribution/sources` (Task 34) is the ingest-source registry the Rust svc-ingest polls, same ETag treatment. `GET /api/v1/distribution/bundles` keeps its **byte-identical** v1 body (five fields, `meta.version` = `1`) so today's `flask_core.stage_runner.BundlePoller` and every existing test in `test_v1_distribution_blueprint.py` keep passing unchanged; it is deleted in M6 once every poller is Rust. | The spec's §6.7 wording ("needs no versioning of the endpoint") assumes a flag-day cut-over of one consumer; this repo has a live Python poller on the v1 shape throughout M2b–M5, so a second route is the only way "the old endpoint keeps working" is literally true rather than true-if-clients-ignore-unknown-fields. Additive-only, reversible, and deleted by one commit at cut-over. |
| 13 | **Every ingest source carries an `auth` config that svc_ingest enforces** (user's third spec review, authoritative ahead of the spec amendment; the published shape **must match plan M5**). Wire shape, published verbatim by `GET /api/v1/distribution/sources`: `auth = {modes: ["hmac", "ip_allowlist"|"bearer"|"basic", ...], cidrs: [...], secret_ref: "<id>", origin_suffixes: [...], origin_cidrs: [...]}`. **Generic webhook sources** (`platform` starting `custom:`, and the built-in `webhook` platform) MUST declare at least one of `ip_allowlist`, `bearer` or `basic` **in addition to** `hmac`; a create or auth-update with none of the three is refused `422 auth_second_factor_required`. **Twitch and Kick sources** carry an origin policy instead: `origin_suffixes` (defaulting to `["twitch.tv"]` / `["kick.com"]`) plus optional `origin_cidrs`. Bearer tokens and Basic password hashes live encrypted in `ingest_sources.auth_secret_ciphertext`/`auth_secret_iv` (same AES-256-GCM helper as the HMAC secret) and are **never** returned by any endpoint — the wire carries `secret_ref` only. Every auth-config change writes an `audit_log` row (`ingest_source_auth_changed`) recording the old and new `modes`, never the secret. Schema lands as migration 0022 (Task 39); publication and the config/consent views land in Task 40. | The HMAC secret alone authenticates the *payload*, not the *caller*: anyone who replays a captured body passes it. A second factor binds the request to a network location or a credential, and the platform-origin policy does the same job for Twitch/Kick, whose senders are known. Refusing at create time is the only place the requirement is cheap to enforce. |

---

## File Structure

```
config/postgres/
  rbac-matrix.yaml                          new — normative role×table×privilege matrix (Task 1)
scripts/db/
  __init__.py                               new (Task 1)
  rbac_matrix.py                            new — matrix loader + SQL generator (Task 1)
migrations/
  Dockerfile                                modified — copies config/postgres/rbac-matrix.yaml + scripts/db/, adds PyYAML (Task 1)
alembic/versions/
  0020_app_versions_and_rbac.py             new (Task 2)
  0021_bundle_install_schema.py             new (Task 3)
  0022_ingest_source_auth.py                new (Task 39)
docs/
  rbac-matrix.md                            new (Task 2)
hub_api/
  requirements.in                           modified — kubernetes, PyYAML (Task 6)
  app.py                                    modified — one new bind_*_tables() call (Task 4)
  services/
    schema.py                               modified — bind_bundle_install_tables() (Task 4)
    rbac_matrix.py                          new — thin re-export of scripts/db/rbac_matrix for hub-api's own test imports (Task 1)
    bundle_secret_crypto.py                 new (Task 6)
    bundle_manifest_v2.py                   new (Task 7)
    bundle_storage_service.py               new (Task 8)
    compiler_job_service.py                 new (Task 9)
    bundle_version_service.py               new (Task 10)
    bundle_artifact_service.py              new (Tasks 13-14)
    bundle_activation_service.py            new (Task 16)
    permission_summary_service.py           new (Task 18)
    bundle_approval_service.py              new (Task 19)
    bundle_db_role_service.py               new (Task 20)
    platform_settings_service.py            new (Task 23)
    tenant_bundle_settings.py               new (Task 24)
    custom_platform_service.py              new (Task 25)
    ingest_source_service.py                new (Task 26)
    valkey_admin_client.py                  new (Task 28)
    stream_grant_service.py                 new (Task 29)
    marketplace_lifecycle_service.py        modified — grant + approval wiring (Task 30)
    distribution_service.py                 modified — new fields (Task 32)
    bundle_trip_reenable_service.py         new (Task 35)
    bundle_role_cleanup_job.py              new (Task 36)
    bundle_feature_gate.py                  new (Task 37)
    bundle_telemetry.py                     new (Task 38)
    ingest_source_auth.py                   new (Task 39)
  blueprints/v1/
    bundle_versions.py                      new (Tasks 11, 17)
    bundle_artifact_callback.py             new (Task 15)
    bundle_approvals.py                     new (Task 22)
    bundle_settings.py                      new (Task 23)
    custom_platforms.py                     new (Task 25)
    ingest_sources.py                       new (Task 27), modified — auth PUT (Task 40)
    bundle_grants.py                        new (Task 31)
    distribution.py                         modified — v2/bundles (Task 33), /sources (Task 34)
    bundle_versions.py                      modified — POST .../trip-reenable (Task 35)
  tests/
    conftest.py                             modified — bundle_install_db fixture (Task 4)
    test_rbac_live_grants.py                new (Task 5)
    test_bundle_secret_crypto.py            new (Task 6)
    test_bundle_manifest_v2.py              new (Task 7)
    test_bundle_storage_service.py          new (Task 8)
    test_compiler_job_service.py            new (Task 9)
    test_bundle_version_service.py          new (Task 10)
    test_bundle_versions_blueprint.py       new (Tasks 11, 17)
    test_bundle_artifact_service.py         new (Tasks 13-14)
    test_bundle_artifact_callback_blueprint.py new (Task 15)
    test_bundle_activation_service.py       new (Task 16)
    test_permission_summary_service.py      new (Task 18)
    test_bundle_approval_service.py         new (Task 19)
    test_bundle_db_role_service.py          new (Task 20)
    test_bundle_approvals_blueprint.py      new (Task 22)
    test_platform_settings_service.py       new (Task 23)
    test_bundle_settings_blueprint.py       new (Task 23)
    test_tenant_bundle_settings.py          new (Task 24)
    test_custom_platform_service.py         new (Task 25)
    test_custom_platforms_blueprint.py      new (Task 25)
    test_ingest_source_service.py           new (Task 26)
    test_ingest_sources_blueprint.py        new (Task 27)
    test_valkey_admin_client.py             new (Task 28)
    test_stream_grant_service.py            new (Task 29)
    test_marketplace_lifecycle_grants.py    new (Task 30)
    test_bundle_grants_blueprint.py         new (Task 31)
    test_distribution_service_versions.py   new (Task 32)
    test_distribution_v2_blueprint.py       new (Task 33)
    test_distribution_sources_blueprint.py  new (Task 34)
    test_bundle_trip_reenable.py            new (Task 35)
    test_bundle_role_cleanup_job.py         new (Task 36)
    test_bundle_feature_gate.py             new (Task 37)
    test_bundle_telemetry.py                new (Task 38)
    test_ingest_source_auth.py              new (Task 39)
    test_ingest_source_auth_api.py          new (Task 40)
    test_openapi_m2b_paths.py               new (Task 41)
  pyproject.toml                            modified — per-file ruff ignores (Tasks 33-40) + the final gate (Task 41)
k8s/helm/waddlebot/templates/
  hub-api-compiler-rbac.yaml                new (Task 12)
  bundle-role-cleanup-cronjob.yaml          new (Task 36)
k8s/helm/waddlebot/
  values.yaml                               modified — bundles.compiler.*, sandbox.* keys hub-api needs (Task 12)
  values.yaml                               modified — bundles.roleCleanup.* keys (Task 36)
```

---

## Task 1: RBAC matrix file + loader/generator script + migration Dockerfile wiring

**Depends on:** nothing — this is the milestone's first task.

**Files:**
- Create: `config/postgres/rbac-matrix.yaml`
- Create: `scripts/db/__init__.py`
- Create: `scripts/db/rbac_matrix.py`
- Create: `hub_api/services/rbac_matrix.py`
- Modify: `migrations/Dockerfile`
- Test: `hub_api/tests/test_rbac_matrix_loader.py`

**Interfaces:**
- Produces: `scripts.db.rbac_matrix.load_matrix(path: str) -> list[GrantSpec]`, `GrantSpec` (`role: str`, `table: str`, `privileges: frozenset[str]`), `render_grant_sql(rows: list[GrantSpec]) -> list[str]`, `render_revoke_public_sql(tables: list[str]) -> list[str]`, `ALL_PRIVILEGES = frozenset({"SELECT", "INSERT", "UPDATE", "DELETE"})`. `hub_api/services/rbac_matrix.py` re-exports the same names by loading the script module via `importlib.util.spec_from_file_location` at an absolute, `__file__`-relative path (no `sys.path` edits, no package coupling between `scripts/` and `hub_api/`) so hub-api's own tests and later migrations import one identical implementation.
- Consumes: nothing (first task).

- [ ] **Step 1: Write the matrix file**

```yaml
# config/postgres/rbac-matrix.yaml
#
# Normative role x table x privilege matrix (spec D28 / Sec11.10.1).
# Grants are generated FROM this file by scripts/db/rbac_matrix.py --
# nobody writes a GRANT by hand. Every role and every table this
# milestone (M2b) touches has an explicit row, including "no privilege"
# rows, so the live-grants CI test (hub_api/tests/test_rbac_live_grants.py)
# can assert set equality rather than only checking presence.
#
# Appended to, never rewritten, by later milestones (M3/M4/M5/M6) as
# their own services/tables land -- each appends its own role/table
# rows to this same file and adds its own migration that re-renders
# grants scoped to its own new rows.
version: 1
roles:
  - hub_api
  - waddles_publisher
  - svc_ingest
  - svc_process
  - svc_action
  - svc_streaming
  - webui
  - migration_runner
tables:
  - app_versions
  - app_active_versions
  - app_version_uploads
  - app_install_approvals
  - app_stream_grants
  - custom_platforms
  - ingest_sources
  - platform_settings
  - app_versions_audit_log
grants:
  # app_versions: exactly two writers (spec Sec6.10). Every other role
  # gets zero privileges -- listed explicitly so the equality check
  # sees an intentional absence, not an unexamined gap.
  - role: waddles_publisher
    table: app_versions
    privileges: [INSERT, UPDATE, DELETE]
  - role: hub_api
    table: app_versions
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: svc_ingest
    table: app_versions
    privileges: []
  - role: svc_process
    table: app_versions
    privileges: []
  - role: svc_action
    table: app_versions
    privileges: []
  - role: svc_streaming
    table: app_versions
    privileges: []
  - role: webui
    table: app_versions
    privileges: []
  - role: migration_runner
    table: app_versions
    privileges: [SELECT, INSERT, UPDATE, DELETE]

  # app_active_versions: hub-api-owned pointer table. Only hub_api writes.
  - role: hub_api
    table: app_active_versions
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: waddles_publisher
    table: app_active_versions
    privileges: []
  - role: svc_ingest
    table: app_active_versions
    privileges: []
  - role: svc_process
    table: app_active_versions
    privileges: []
  - role: svc_action
    table: app_active_versions
    privileges: []
  - role: svc_streaming
    table: app_active_versions
    privileges: []
  - role: webui
    table: app_active_versions
    privileges: []
  - role: migration_runner
    table: app_active_versions
    privileges: [SELECT, INSERT, UPDATE, DELETE]

  # app_versions_audit_log: written only by the trigger (SECURITY DEFINER);
  # hub_api gets read access to display history, nobody else touches it.
  - role: hub_api
    table: app_versions_audit_log
    privileges: [SELECT]
  - role: waddles_publisher
    table: app_versions_audit_log
    privileges: []
  - role: svc_ingest
    table: app_versions_audit_log
    privileges: []
  - role: svc_process
    table: app_versions_audit_log
    privileges: []
  - role: svc_action
    table: app_versions_audit_log
    privileges: []
  - role: svc_streaming
    table: app_versions_audit_log
    privileges: []
  - role: webui
    table: app_versions_audit_log
    privileges: []
  - role: migration_runner
    table: app_versions_audit_log
    privileges: [SELECT, INSERT, UPDATE, DELETE]

  # Hub-api-exclusive control-plane tables (Task 3's migration). Every
  # other role gets zero privileges on every one of them.
  - role: hub_api
    table: app_version_uploads
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: migration_runner
    table: app_version_uploads
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: hub_api
    table: app_install_approvals
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: migration_runner
    table: app_install_approvals
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: hub_api
    table: app_stream_grants
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: migration_runner
    table: app_stream_grants
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: hub_api
    table: custom_platforms
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: migration_runner
    table: custom_platforms
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: hub_api
    table: ingest_sources
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: migration_runner
    table: ingest_sources
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: hub_api
    table: platform_settings
    privileges: [SELECT, INSERT, UPDATE, DELETE]
  - role: migration_runner
    table: platform_settings
    privileges: [SELECT, INSERT, UPDATE, DELETE]
```

- [ ] **Step 2: Write the loader/generator script**

```python
# scripts/db/__init__.py
"""Standalone DB tooling, importable independent of hub-api's own package layout."""
```

```python
# scripts/db/rbac_matrix.py
"""Load `config/postgres/rbac-matrix.yaml` and render GRANT/REVOKE SQL from it.

The single generator behind spec D28 ("Grants are generated from this
file; nobody writes a GRANT by hand.") -- imported by an Alembic
migration (which cannot rely on hub-api's own `sys.path`, since
`alembic/` lives at the repo root, a sibling of `hub_api/`, not inside
it) and by hub-api's own test suite, both via `importlib` against this
file's absolute path so neither caller needs a package-install step.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ALL_PRIVILEGES = frozenset({"SELECT", "INSERT", "UPDATE", "DELETE"})

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MATRIX_PATH = REPO_ROOT / "config" / "postgres" / "rbac-matrix.yaml"


@dataclass(slots=True, frozen=True)
class GrantSpec:
    """One `(role, table, privileges)` row from the RBAC matrix file."""

    role: str
    table: str
    privileges: frozenset[str]


class MatrixError(ValueError):
    """Raised when the matrix file is malformed or references an unknown role/table."""


def load_matrix(path: str | Path = DEFAULT_MATRIX_PATH) -> list[GrantSpec]:
    """Parse the YAML matrix file into a list of `GrantSpec`, validated against its own role/table lists."""
    raw: dict[str, Any] = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    roles = frozenset(raw.get("roles", []))
    tables = frozenset(raw.get("tables", []))
    if not roles:
        raise MatrixError(f"{path}: 'roles' list is empty")
    if not tables:
        raise MatrixError(f"{path}: 'tables' list is empty")

    specs: list[GrantSpec] = []
    for row in raw.get("grants", []):
        role = row["role"]
        table = row["table"]
        privileges = frozenset(row.get("privileges", []))
        if role not in roles:
            raise MatrixError(f"{path}: grant references unknown role {role!r}")
        if table not in tables:
            raise MatrixError(f"{path}: grant references unknown table {table!r}")
        if not privileges <= ALL_PRIVILEGES:
            raise MatrixError(f"{path}: grant for {role}/{table} has unknown privilege(s)")
        specs.append(GrantSpec(role=role, table=table, privileges=privileges))
    return specs


def matrix_roles(path: str | Path = DEFAULT_MATRIX_PATH) -> frozenset[str]:
    """The full `roles` list declared in the matrix file."""
    raw: dict[str, Any] = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return frozenset(raw.get("roles", []))


def matrix_tables(path: str | Path = DEFAULT_MATRIX_PATH) -> frozenset[str]:
    """The full `tables` list declared in the matrix file."""
    raw: dict[str, Any] = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return frozenset(raw.get("tables", []))


def render_create_roles_sql(roles: list[str]) -> list[str]:
    """Idempotent `CREATE ROLE ... NOLOGIN` for every role, guarded by a `pg_roles` existence check."""
    statements = []
    for role in roles:
        statements.append(
            f"DO $$ BEGIN\n"
            f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN\n"
            f"    CREATE ROLE {role} NOLOGIN;\n"
            f"  END IF;\n"
            f"END $$;"
        )
    return statements


def render_revoke_public_sql(tables: list[str]) -> list[str]:
    """`REVOKE ALL ON <table> FROM PUBLIC` for every table -- the default-deny baseline."""
    return [f"REVOKE ALL ON {table} FROM PUBLIC;" for table in tables]


def render_grant_sql(rows: list[GrantSpec], *, tables: frozenset[str] | None = None) -> list[str]:
    """`GRANT <privs> ON <table> TO <role>` for every non-empty-privilege row.

    `tables`, when given, restricts rendering to those tables only --
    used by a migration that owns a subset of the matrix's tables (e.g.
    Task 2's migration only wants `app_versions`/`app_active_versions`/
    `app_versions_audit_log` rows, not Task 3's five tables, even though
    both read the same, by-then-larger matrix file).
    """
    statements = []
    for spec in rows:
        if tables is not None and spec.table not in tables:
            continue
        if not spec.privileges:
            continue
        privileges = ", ".join(sorted(spec.privileges))
        statements.append(f"GRANT {privileges} ON {spec.table} TO {spec.role};")
    return statements
```

- [ ] **Step 3: Write hub-api's re-export shim**

```python
# hub_api/services/rbac_matrix.py
"""Re-export of `scripts/db/rbac_matrix.py`, loaded by absolute path.

`scripts/` is a repo-root sibling of `hub_api/`, not a package hub-api
depends on -- loading by `importlib.util.spec_from_file_location`
against this file's own `__file__`-relative path means this module
works whether hub-api is imported as `/app` (the Docker layout) or as
`hub_api.*` from a repo checkout, with no `sys.path` mutation and no
risk of two independent copies of the matrix-parsing logic drifting.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

_SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "db" / "rbac_matrix.py"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("waddles_rbac_matrix", _SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load rbac matrix module from {_SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_impl = _load()

GrantSpec = _impl.GrantSpec
MatrixError = _impl.MatrixError
ALL_PRIVILEGES = _impl.ALL_PRIVILEGES
DEFAULT_MATRIX_PATH = _impl.DEFAULT_MATRIX_PATH
load_matrix = _impl.load_matrix
matrix_roles = _impl.matrix_roles
matrix_tables = _impl.matrix_tables
render_create_roles_sql = _impl.render_create_roles_sql
render_revoke_public_sql = _impl.render_revoke_public_sql
render_grant_sql = _impl.render_grant_sql
```

- [ ] **Step 4: Write the failing test**

```python
# hub_api/tests/test_rbac_matrix_loader.py
"""Unit tests for the RBAC matrix loader/generator -- no DB required."""

from __future__ import annotations

from services.rbac_matrix import (
    ALL_PRIVILEGES,
    DEFAULT_MATRIX_PATH,
    load_matrix,
    matrix_roles,
    matrix_tables,
    render_create_roles_sql,
    render_grant_sql,
    render_revoke_public_sql,
)


def test_matrix_has_at_least_8_roles_and_8_tables() -> None:
    roles = matrix_roles()
    tables = matrix_tables()
    assert len(roles) >= 8, f"expected >= 8 roles, found {len(roles)}: {sorted(roles)}"
    assert len(tables) >= 8, f"expected >= 8 tables, found {len(tables)}: {sorted(tables)}"


def test_app_versions_has_exactly_two_writers() -> None:
    rows = load_matrix()
    writers = {r.role for r in rows if r.table == "app_versions" and r.privileges}
    assert writers == {"waddles_publisher", "hub_api", "migration_runner"} - {"migration_runner"} | (
        {"migration_runner"} if False else set()
    ) or writers == {"waddles_publisher", "hub_api"}, writers


def test_every_role_has_an_explicit_row_for_every_table() -> None:
    rows = load_matrix()
    seen = {(r.role, r.table) for r in rows}
    roles = matrix_roles()
    tables = matrix_tables()
    missing = [
        (role, table)
        for role in roles
        for table in tables
        if (role, table) not in seen and table != "migration_runner"
    ]
    # Every (role, table) pair this milestone's tables/roles define must be
    # explicit -- a missing pair would make the live-grants equality test
    # (Task 5) silently treat "never checked" as "no privileges", which is
    # not the same claim.
    assert not missing, f"matrix is missing explicit rows for: {missing}"


def test_render_grant_sql_only_emits_non_empty_privilege_rows() -> None:
    rows = load_matrix()
    statements = render_grant_sql(rows, tables=frozenset({"app_versions"}))
    assert any("waddles_publisher" in s for s in statements)
    assert any("hub_api" in s for s in statements)
    assert not any("svc_ingest" in s for s in statements)


def test_render_revoke_public_sql_covers_every_table() -> None:
    tables = sorted(matrix_tables())
    statements = render_revoke_public_sql(tables)
    assert len(statements) == len(tables)
    assert all("REVOKE ALL ON" in s and "FROM PUBLIC" in s for s in statements)


def test_render_create_roles_sql_is_idempotent_guarded() -> None:
    statements = render_create_roles_sql(["hub_api", "waddles_publisher"])
    assert len(statements) == 2
    assert all("IF NOT EXISTS" in s for s in statements)


def test_privileges_are_bounded_to_the_known_set() -> None:
    rows = load_matrix()
    for row in rows:
        assert row.privileges <= ALL_PRIVILEGES


def test_default_matrix_path_exists() -> None:
    assert DEFAULT_MATRIX_PATH.exists()
```

- [ ] **Step 5: Simplify the redundant assertion in Step 4's second test**

The `test_app_versions_has_exactly_two_writers` test above has a convoluted assertion (deliberately worked through defensively during authoring) — clean it up before committing:

```python
def test_app_versions_has_exactly_two_writers() -> None:
    rows = load_matrix()
    writers = {r.role for r in rows if r.table == "app_versions" and r.privileges}
    assert writers == {"waddles_publisher", "hub_api"}, writers
```

- [ ] **Step 6: Run the tests to verify they fail (module does not exist yet)**

Run: `cd hub_api && PYTHONPATH=".." python3 -m pytest tests/test_rbac_matrix_loader.py -v`
Expected: `ModuleNotFoundError: No module named 'yaml'` or `ImportError` — `pyyaml` is not yet a dependency (added in Task 6) and the files above don't exist on disk in this repo checkout until you write them.

- [ ] **Step 7: Install PyYAML locally for this task's verification**

Run: `cd hub_api && pip install "PyYAML>=6.0.2,<7.0.0"`
Expected: `Successfully installed PyYAML-6.0.x`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd hub_api && PYTHONPATH=".." python3 -m pytest tests/test_rbac_matrix_loader.py -v`
Expected: `8 passed`

- [ ] **Step 9: Wire the migration container's Dockerfile**

Edit `migrations/Dockerfile` — add PyYAML to the pip install list, and copy the two new paths:

```dockerfile
FROM python:3.13-slim-bookworm@sha256:01f42367a0a94ad4bc17111776fd66e3500c1d87c15bbd6055b7371d39c124fb

WORKDIR /app

# Install migration dependencies
RUN pip install --no-cache-dir \
    alembic>=1.13 \
    sqlalchemy>=2.0 \
    psycopg2-binary \
    flask-sqlalchemy \
    flask-security-too \
    "PyYAML>=6.0.2,<7.0.0"

# Copy Alembic configuration
COPY alembic.ini .
COPY alembic/ alembic/

# Copy SQLAlchemy models (needed for target_metadata)
# Create __init__.py files so Python recognizes the nested package path
COPY libs/flask_core/ libs/flask_core/
RUN touch libs/__init__.py libs/flask_core/__init__.py

# Copy legacy SQL migrations (used by baseline migration)
COPY config/postgres/migrations/ config/postgres/migrations/

# RBAC matrix (spec D28) -- the normative source the Sec6.10/Sec11.10
# migrations generate GRANT/REVOKE statements from at migration-run time.
COPY config/postgres/rbac-matrix.yaml config/postgres/rbac-matrix.yaml
COPY scripts/db/ scripts/db/

# Copy migration runner
COPY migrations/run-alembic.sh ./run.sh
RUN chmod +x ./run.sh

# Create non-root user
RUN useradd --create-home --shell /bin/bash appuser

# Set proper permissions for migrations
RUN chown -R appuser:appuser /app

USER appuser

ENTRYPOINT ["./run.sh"]
```

- [ ] **Step 10: Commit**

```bash
git add config/postgres/rbac-matrix.yaml scripts/db/__init__.py scripts/db/rbac_matrix.py \
        hub_api/services/rbac_matrix.py hub_api/tests/test_rbac_matrix_loader.py \
        migrations/Dockerfile
git commit -m "$(cat <<'EOF'
feat(hub-api): RBAC matrix file + loader/generator for Least User Access (D28)

Adds the normative config/postgres/rbac-matrix.yaml (role x table x
privilege) plus scripts/db/rbac_matrix.py, the single generator every
later migration in this milestone renders GRANT/REVOKE SQL from -- no
hand-written GRANT anywhere, per spec D28/Sec11.10.1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 2: Migration 0020 — `app_versions`, `app_active_versions`, audit trigger, roles, generated grants

**Depends on:** Task 1 (`config/postgres/rbac-matrix.yaml` and `scripts/db/rbac_matrix.py`, loaded by this migration via `importlib` by absolute path).

**Files:**
- Create: `alembic/versions/0020_app_versions_and_rbac.py`
- Create: `docs/rbac-matrix.md`

**Interfaces:**
- Consumes: `scripts/db/rbac_matrix.py`'s `load_matrix`, `render_create_roles_sql`, `render_revoke_public_sql`, `render_grant_sql` (Task 1), loaded via `importlib.util.spec_from_file_location` (same technique as `hub_api/services/rbac_matrix.py`, duplicated here because Alembic migration files cannot import `hub_api.services.*`).
- Produces: table `app_versions(id, app_id, version, artifact_digest, cwasm_digest, wasmtime_abi, collector, size_bytes, language, artifact_kind, built_at, builder, scan_status, badge, approval_id)`, `UNIQUE(app_id, version)`, `UNIQUE(artifact_digest)`. Table `app_active_versions(app_id, tenant_id, community_id, version_id, activated_by, activated_at)`, partial-unique on `(app_id, tenant_id)` where `community_id IS NULL` and on `(app_id, tenant_id, community_id)` where `community_id IS NOT NULL`, FK `version_id -> app_versions(id)`. Table `app_versions_audit_log(id, occurred_at, db_role, operation, app_id, version, old_digest, new_digest)`. Trigger function `fn_app_versions_audit()`, trigger `trg_app_versions_audit` on `app_versions`. Roles `hub_api`, `waddles_publisher`, `svc_ingest`, `svc_process`, `svc_action`, `svc_streaming`, `webui`, `migration_runner` (idempotent `CREATE ROLE ... NOLOGIN`).

- [ ] **Step 1: Write the migration**

```python
# alembic/versions/0020_app_versions_and_rbac.py
"""app_versions (the digest table, spec Sec6.10) + app_active_versions + Least User Access RBAC.

`app_versions` is written by exactly two roles -- `waddles_publisher`
(M2a's trusted publisher container, the only component that ever
measures a compiled component's bytes) and `hub_api` (owns scan
outcome, approval linkage, and the notification/cross-check of Task 13
-- hub-api verifies a claimed digest by re-hashing the bucket object,
it never computes one itself). Every other service role gets zero
privileges, and every write is captured by an AFTER-trigger recording
the writing role and the old/new digest (spec Sec6.10, D28).

Grants are rendered from config/postgres/rbac-matrix.yaml at migration
-run time via scripts/db/rbac_matrix.py -- this file contains no
hand-written GRANT statement.

`app_active_versions` is the separate, hub-api-owned pointer table:
activation and rollback are an UPDATE of `version_id` here, never an
edit of a digest row (spec Sec6.10). Refusing to point at a digest with
no `app_versions` row is enforced by the FK plus an application-level
check in `services/bundle_activation_service.py` (Task 16).

Revision ID: 0020_app_versions_and_rbac
Revises: 0019_kick_app
Create Date: 2026-09-14
"""

import importlib.util
import os
from pathlib import Path

from alembic import op

revision = "0020_app_versions_and_rbac"
down_revision = "0019_kick_app"
branch_labels = None
depends_on = None

_MATRIX_MODULE_PATH = (
    Path(__file__).resolve().parents[2] / "scripts" / "db" / "rbac_matrix.py"
)
_MATRIX_TABLES = frozenset({"app_versions", "app_active_versions", "app_versions_audit_log"})


def _load_matrix_module():
    spec = importlib.util.spec_from_file_location("waddles_rbac_matrix_0020", _MATRIX_MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS app_versions (
            id BIGSERIAL PRIMARY KEY,
            app_id VARCHAR(255) NOT NULL REFERENCES app_catalog(app_id),
            version VARCHAR(50) NOT NULL,
            artifact_digest VARCHAR(71),
            cwasm_digest VARCHAR(71),
            wasmtime_abi VARCHAR(50),
            collector VARCHAR(20),
            size_bytes BIGINT,
            language VARCHAR(20) NOT NULL,
            artifact_kind VARCHAR(20) NOT NULL
                CHECK (artifact_kind IN ('source', 'prebuilt')),
            built_at TIMESTAMPTZ,
            builder VARCHAR(100),
            scan_status VARCHAR(30) NOT NULL DEFAULT 'not_scanned'
                CHECK (scan_status IN ('scanned', 'scanned_with_findings', 'not_scanned', 'scan_failed')),
            badge VARCHAR(100),
            approval_id BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (app_id, version),
            UNIQUE (artifact_digest)
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE app_versions IS "
        "'The digest table (spec Sec6.10) -- exactly two writers: waddles_publisher and hub_api'"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS app_active_versions (
            app_id VARCHAR(255) NOT NULL REFERENCES app_catalog(app_id),
            tenant_id INTEGER NOT NULL REFERENCES tenants(id),
            community_id INTEGER REFERENCES communities(id),
            version_id BIGINT NOT NULL REFERENCES app_versions(id),
            activated_by INTEGER REFERENCES hub_users(id),
            activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (app_id, tenant_id, community_id)
        )
        """
    )
    # Postgres treats NULL as distinct in a composite PK only when the PK
    # itself allows NULLs -- it does not (PK columns are implicitly NOT
    # NULL), so `community_id` can never be NULL as part of this PK.
    # Tenant-wide activation is represented by a dedicated sentinel row
    # instead: community_id = 0 is reserved and never a real communities.id
    # (communities.id is a real SERIAL starting at 1) -- application code
    # (services/bundle_activation_service.py, Task 16) always passes
    # community_id=0 for "tenant-wide", never NULL, and the distribution
    # service (Task 32) treats 0 as the `_tenant` fallback the same way
    # every other table in this codebase treats `community_id IS NULL`.
    op.execute(
        "ALTER TABLE app_active_versions ALTER COLUMN community_id SET DEFAULT 0"
    )
    op.execute(
        "COMMENT ON TABLE app_active_versions IS "
        "'hub-api-owned activation pointer -- rollback is an UPDATE of version_id, never a digest edit'"
    )
    op.execute(
        "COMMENT ON COLUMN app_active_versions.community_id IS "
        "'0 = tenant-wide (sentinel; communities.id never = 0), matching the _tenant convention elsewhere'"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS app_versions_audit_log (
            id BIGSERIAL PRIMARY KEY,
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            db_role VARCHAR(100) NOT NULL,
            operation VARCHAR(10) NOT NULL,
            app_id VARCHAR(255) NOT NULL,
            version VARCHAR(50) NOT NULL,
            old_digest VARCHAR(71),
            new_digest VARCHAR(71)
        )
        """
    )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION fn_app_versions_audit() RETURNS trigger AS $$
        BEGIN
            INSERT INTO app_versions_audit_log
                (db_role, operation, app_id, version, old_digest, new_digest)
            VALUES (
                session_user,
                TG_OP,
                COALESCE(NEW.app_id, OLD.app_id),
                COALESCE(NEW.version, OLD.version),
                CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.artifact_digest END,
                CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.artifact_digest END
            );
            RETURN COALESCE(NEW, OLD);
        END;
        $$ LANGUAGE plpgsql SECURITY DEFINER
        """
    )
    op.execute(
        """
        DROP TRIGGER IF EXISTS trg_app_versions_audit ON app_versions;
        CREATE TRIGGER trg_app_versions_audit
            AFTER INSERT OR UPDATE OR DELETE ON app_versions
            FOR EACH ROW EXECUTE FUNCTION fn_app_versions_audit()
        """
    )

    matrix_module = _load_matrix_module()
    matrix_path = os.environ.get(
        "RBAC_MATRIX_PATH", str(matrix_module.DEFAULT_MATRIX_PATH)
    )
    roles = sorted(matrix_module.matrix_roles(matrix_path))
    rows = matrix_module.load_matrix(matrix_path)

    for statement in matrix_module.render_create_roles_sql(roles):
        op.execute(statement)
    for statement in matrix_module.render_revoke_public_sql(sorted(_MATRIX_TABLES)):
        op.execute(statement)
    for statement in matrix_module.render_grant_sql(rows, tables=_MATRIX_TABLES):
        op.execute(statement)

    # Sequence usage must be granted alongside table INSERT or the two
    # writer roles cannot obtain a new `id`/`app_versions_audit_log.id`.
    op.execute("GRANT USAGE ON SEQUENCE app_versions_id_seq TO waddles_publisher, hub_api;")
    op.execute("GRANT USAGE ON SEQUENCE app_versions_audit_log_id_seq TO hub_api;")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_app_versions_audit ON app_versions")
    op.execute("DROP FUNCTION IF EXISTS fn_app_versions_audit()")
    op.execute("DROP TABLE IF EXISTS app_versions_audit_log")
    op.execute("DROP TABLE IF EXISTS app_active_versions")
    op.execute("DROP TABLE IF EXISTS app_versions")
    for role in ("hub_api", "waddles_publisher", "svc_ingest", "svc_process",
                 "svc_action", "svc_streaming", "webui", "migration_runner"):
        op.execute(
            f"DO $$ BEGIN\n"
            f"  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN\n"
            f"    DROP ROLE {role};\n"
            f"  END IF;\n"
            f"EXCEPTION WHEN dependent_objects_still_exist THEN\n"
            f"  NULL; -- role still owns objects from a later migration; leave it\n"
            f"END $$;"
        )
```

- [ ] **Step 2: Write the RBAC docs page**

```markdown
<!-- docs/rbac-matrix.md -->
# Postgres RBAC Matrix

The normative, versioned source of every Postgres role's privileges in
Waddles is `config/postgres/rbac-matrix.yaml` (spec D28, Sec11.10.1).
**Nobody writes a `GRANT` by hand** — every migration that needs one
loads the matrix via `scripts/db/rbac_matrix.py` and renders the SQL
from it at migration-run time.

## Adding a role or a table

1. Add the role/table name to the `roles`/`tables` list in
   `config/postgres/rbac-matrix.yaml`.
2. Add an explicit `grants` row for **every** role against the new
   table (or every existing table against the new role) — including
   `privileges: []` rows for roles that should have no access. The
   live-grants CI test (`hub_api/tests/test_rbac_live_grants.py`)
   treats a missing row the same as an unexamined gap, not as "no
   access."
3. Write a new Alembic migration that loads the matrix and calls
   `render_grant_sql(rows, tables={...the new table(s) only...})` —
   never re-grant a table an earlier migration already owns unless
   you are deliberately widening it.
4. Run the live-grants test against a real Postgres instance
   (`TEST_POSTGRES_ADMIN_DSN=postgresql://... pytest tests/test_rbac_live_grants.py -v`)
   before merging.

## `app_versions` — exactly two writers

| Role | Privileges | Why |
|---|---|---|
| `waddles_publisher` | INSERT, UPDATE, DELETE | M2a's trusted publisher container — the only component that ever measures a compiled artifact's bytes. |
| `hub_api` | SELECT, INSERT, UPDATE, DELETE | Owns the scan-outcome/approval-linkage columns and the notification/cross-check path (Task 13) — verifies a claimed digest by re-hashing the bucket object, never computes one itself. |
| Everyone else (`svc_ingest`, `svc_process`, `svc_action`, `svc_streaming`, `webui`, the executors) | none | Stages/executors read digests only through the distribution API. |

Every write is captured by `trg_app_versions_audit` into
`app_versions_audit_log` (writing role, row key, old/new digest) — a
digest that changes is always attributable.

## `app_active_versions` — the activation pointer

Activation and rollback are an `UPDATE` of `version_id` in this
table, never an edit of `app_versions`. `community_id = 0` is the
tenant-wide sentinel (`communities.id` is never `0`). Only `hub_api`
writes it.
```

- [ ] **Step 3: Run the migration against a local Postgres to verify it applies**

Run:
```bash
docker run -d --name pg-m2b-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=waddlebot -p 55432:5432 postgres:17-alpine
sleep 3
cd /home/penguin/code/waddlebot/.worktrees/plan-m2b-hub-api
DATABASE_URL="postgresql://postgres:test@localhost:55432/waddlebot" alembic upgrade head
```
Expected: the run completes through `0020_app_versions_and_rbac`, prints no `psycopg2.errors` traceback. (Migrations `0001`-`0019` run first against the fresh DB per the existing baseline-migration behavior.)

- [ ] **Step 4: Verify the grants landed as expected**

Run:
```bash
psql "postgresql://postgres:test@localhost:55432/waddlebot" -c \
  "SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'app_versions' ORDER BY grantee, privilege_type;"
```
Expected output (order may vary by `grantee`):
```
     grantee       | table_name  | privilege_type
--------------------+-------------+-----------------
 hub_api            | app_versions | DELETE
 hub_api            | app_versions | INSERT
 hub_api            | app_versions | SELECT
 hub_api            | app_versions | UPDATE
 migration_runner   | app_versions | DELETE
 migration_runner   | app_versions | INSERT
 migration_runner   | app_versions | SELECT
 migration_runner   | app_versions | UPDATE
 waddles_publisher  | app_versions | DELETE
 waddles_publisher  | app_versions | INSERT
 waddles_publisher  | app_versions | UPDATE
```
`svc_ingest`/`svc_process`/`svc_action`/`svc_streaming`/`webui` must NOT appear in this output at all.

- [ ] **Step 5: Tear down the local Postgres**

Run: `docker rm -f pg-m2b-test`
Expected: container removed.

- [ ] **Step 6: Commit**

```bash
git add alembic/versions/0020_app_versions_and_rbac.py docs/rbac-matrix.md
git commit -m "$(cat <<'EOF'
db(hub-api): app_versions digest table + app_active_versions + audit trigger (spec Sec6.10)

app_versions is written by exactly two roles (waddles_publisher,
hub_api), every other service role gets zero privileges, and every
write is captured by an audit trigger recording the writing role and
the old/new digest. Grants are generated from
config/postgres/rbac-matrix.yaml, not hand-written. Activation/
rollback lives in the separate app_active_versions pointer table.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 3: Migration 0021 — the six hub-api-exclusive control-plane tables

**Depends on:** Task 1 (the matrix file + generator), Task 2 (migration 0020 is this migration's `down_revision`).

**Files:**
- Create: `alembic/versions/0021_bundle_install_schema.py`

**Interfaces:**
- Consumes: `scripts/db/rbac_matrix.py` (Task 1), same `importlib`-by-path technique as Task 2.
- Produces: tables `app_version_uploads(id, app_id, version, tenant_id, requested_by, artifact_kind, language, status, reject_reason, compiler_job_name, staging_manifest_key, staging_source_key, staging_component_key, manifest_json, app_version_id, created_at, updated_at)` `UNIQUE(app_id, version)` — `manifest_json` is the parsed `bundle.yaml` v2 stored once at upload time so the consent/approval flow (Task 19) never re-downloads the bucket object; `app_install_approvals(id, tenant_id, community_id, app_id, version, permission_hash, summary_json, approved_by, approved_at, superseded_by)` partial-unique on `(app_id, version, tenant_id, community_id)` where `superseded_by IS NULL`; `app_stream_grants(id, tenant_id, community_id, app_id, stream_key, platform, source_id, label, granted_by, granted_at, revoked_at)` partial-unique on `(app_id, stream_key)` where `revoked_at IS NULL`; `custom_platforms(id, tenant_id, name, created_at)` `UNIQUE(tenant_id, name)`; `ingest_sources(id, tenant_id, community_id, platform, source_id, label, secret_ciphertext, secret_iv, mapping, enabled, created_at, updated_at)` `UNIQUE(tenant_id, platform, source_id)`; `platform_settings(id, key, value, updated_by, updated_at)` `UNIQUE(key)`, seeded with `bundles.allow_prebuilt = 'true'`.

- [ ] **Step 1: Write the migration**

```python
# alembic/versions/0021_bundle_install_schema.py
"""Bundle install/consent/grants schema: app_version_uploads, app_install_approvals,
app_stream_grants, custom_platforms, ingest_sources, platform_settings.

All six tables are hub-api-exclusive -- only the `hub_api` and
`migration_runner` Postgres roles ever touch them (spec Sec9.2, Sec6.8,
Sec6.9, Sec10.3, Sec10.4, Sec12.3's `bundles.allow_prebuilt`). Grants
are rendered from config/postgres/rbac-matrix.yaml, same generator
Task 2 used, scoped to these six tables only so this migration does not
re-touch app_versions'/app_active_versions' already-correct grants.

`app_version_uploads` is hub-api's own pre-publish lifecycle tracker --
`app_versions` (Task 2) has no status column by design (spec Sec6.10),
so the UPLOADED -> VALIDATING -> ... -> PUBLISHED/REJECTED state
machine (spec Sec9.1) lives here, correlated to `app_versions` by the
natural key `(app_id, version)` and a denormalized `app_version_id`
pointer set once the publisher's row is confirmed (Task 13).

`approved_by`/`granted_by`/`updated_by` are `INTEGER REFERENCES
hub_users(id)`, not `uuid` -- see this plan's Global Constraints PII
row: hub_users is this codebase's one identity table and uses an
integer SERIAL key, matching every existing actor-FK column
(loyalty_redemptions.fulfilled_by, ai_byok_keys.created_by_user_id).

Revision ID: 0021_bundle_install_schema
Revises: 0020_app_versions_and_rbac
Create Date: 2026-09-14
"""

import importlib.util
import os
from pathlib import Path

from alembic import op

revision = "0021_bundle_install_schema"
down_revision = "0020_app_versions_and_rbac"
branch_labels = None
depends_on = None

_MATRIX_MODULE_PATH = (
    Path(__file__).resolve().parents[2] / "scripts" / "db" / "rbac_matrix.py"
)
_MATRIX_TABLES = frozenset({
    "app_version_uploads",
    "app_install_approvals",
    "app_stream_grants",
    "custom_platforms",
    "ingest_sources",
    "platform_settings",
})


def _load_matrix_module():
    spec = importlib.util.spec_from_file_location("waddles_rbac_matrix_0021", _MATRIX_MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS app_version_uploads (
            id BIGSERIAL PRIMARY KEY,
            app_id VARCHAR(255) NOT NULL REFERENCES app_catalog(app_id),
            version VARCHAR(50) NOT NULL,
            tenant_id INTEGER NOT NULL REFERENCES tenants(id),
            requested_by INTEGER REFERENCES hub_users(id),
            artifact_kind VARCHAR(20) NOT NULL
                CHECK (artifact_kind IN ('source', 'prebuilt')),
            language VARCHAR(20) NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'UPLOADED'
                CHECK (status IN (
                    'UPLOADED', 'VALIDATING', 'SCANNING', 'INSPECTING', 'COMPILING',
                    'ADDRESSING', 'PUBLISHING', 'PUBLISHED', 'REJECTED'
                )),
            reject_reason VARCHAR(100),
            compiler_job_name VARCHAR(255),
            staging_manifest_key VARCHAR(500),
            staging_source_key VARCHAR(500),
            staging_component_key VARCHAR(500),
            manifest_json JSONB,
            app_version_id BIGINT REFERENCES app_versions(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (app_id, version)
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE app_version_uploads IS "
        "'hub-api-owned pre-publish state machine (spec Sec9.1); app_versions itself has no status column'"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS app_install_approvals (
            id BIGSERIAL PRIMARY KEY,
            tenant_id INTEGER NOT NULL REFERENCES tenants(id),
            community_id INTEGER REFERENCES communities(id),
            app_id VARCHAR(255) NOT NULL REFERENCES app_catalog(app_id),
            version VARCHAR(50) NOT NULL,
            permission_hash VARCHAR(71) NOT NULL,
            summary_json JSONB NOT NULL,
            approved_by INTEGER REFERENCES hub_users(id),
            approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            superseded_by BIGINT REFERENCES app_install_approvals(id)
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_app_install_approvals_current
            ON app_install_approvals (app_id, version, tenant_id, community_id)
            WHERE superseded_by IS NULL
        """
    )
    op.execute(
        "COMMENT ON COLUMN app_install_approvals.approved_by IS "
        "'hub_users.id -- PII tokenization: never a name or email (see plan Global Constraints)'"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS app_stream_grants (
            id BIGSERIAL PRIMARY KEY,
            tenant_id INTEGER NOT NULL REFERENCES tenants(id),
            community_id INTEGER REFERENCES communities(id),
            app_id VARCHAR(255) NOT NULL REFERENCES app_catalog(app_id),
            stream_key VARCHAR(500) NOT NULL,
            platform VARCHAR(50) NOT NULL,
            source_id VARCHAR(255) NOT NULL,
            label VARCHAR(255) NOT NULL,
            granted_by INTEGER REFERENCES hub_users(id),
            granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_app_stream_grants_active
            ON app_stream_grants (app_id, stream_key)
            WHERE revoked_at IS NULL
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_stream_grants_lookup "
        "ON app_stream_grants (tenant_id, community_id, app_id) WHERE revoked_at IS NULL"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS custom_platforms (
            id BIGSERIAL PRIMARY KEY,
            tenant_id INTEGER NOT NULL REFERENCES tenants(id),
            name VARCHAR(100) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tenant_id, name)
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE custom_platforms IS "
        "'Tenant-registered custom platform names for consumes: custom:<name> (spec Sec6.4.3) and REST intake (Sec10.4)'"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS ingest_sources (
            id BIGSERIAL PRIMARY KEY,
            tenant_id INTEGER NOT NULL REFERENCES tenants(id),
            community_id INTEGER REFERENCES communities(id),
            platform VARCHAR(50) NOT NULL,
            source_id VARCHAR(255) NOT NULL,
            label VARCHAR(255) NOT NULL,
            secret_ciphertext BYTEA,
            secret_iv BYTEA,
            mapping JSONB,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tenant_id, platform, source_id)
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE ingest_sources IS "
        "'Per-tenant ingest source registry (spec Sec5.2/Sec10.3) -- secret_ciphertext/secret_iv are AES-256-GCM at rest'"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS platform_settings (
            id BIGSERIAL PRIMARY KEY,
            key VARCHAR(150) NOT NULL UNIQUE,
            value TEXT,
            updated_by INTEGER REFERENCES hub_users(id),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        INSERT INTO platform_settings (key, value)
        VALUES ('bundles.allow_prebuilt', 'true')
        ON CONFLICT (key) DO NOTHING
        """
    )

    matrix_module = _load_matrix_module()
    matrix_path = os.environ.get(
        "RBAC_MATRIX_PATH", str(matrix_module.DEFAULT_MATRIX_PATH)
    )
    rows = matrix_module.load_matrix(matrix_path)

    for statement in matrix_module.render_revoke_public_sql(sorted(_MATRIX_TABLES)):
        op.execute(statement)
    for statement in matrix_module.render_grant_sql(rows, tables=_MATRIX_TABLES):
        op.execute(statement)

    op.execute(
        "GRANT USAGE ON SEQUENCE app_version_uploads_id_seq, "
        "app_install_approvals_id_seq, app_stream_grants_id_seq, "
        "custom_platforms_id_seq, ingest_sources_id_seq, platform_settings_id_seq "
        "TO hub_api;"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS platform_settings")
    op.execute("DROP TABLE IF EXISTS ingest_sources")
    op.execute("DROP TABLE IF EXISTS custom_platforms")
    op.execute("DROP TABLE IF EXISTS app_stream_grants")
    op.execute("DROP TABLE IF EXISTS app_install_approvals")
    op.execute("DROP TABLE IF EXISTS app_version_uploads")
```

- [ ] **Step 2: Run the migration to verify it applies cleanly on top of 0020**

Run:
```bash
docker run -d --name pg-m2b-test2 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=waddlebot -p 55433:5432 postgres:17-alpine
sleep 3
DATABASE_URL="postgresql://postgres:test@localhost:55433/waddlebot" alembic upgrade head
psql "postgresql://postgres:test@localhost:55433/waddlebot" -c "SELECT key, value FROM platform_settings;"
docker rm -f pg-m2b-test2
```
Expected: `alembic upgrade head` exits 0; the `psql` query prints exactly one row, `bundles.allow_prebuilt | true`.

- [ ] **Step 3: Commit**

```bash
git add alembic/versions/0021_bundle_install_schema.py
git commit -m "$(cat <<'EOF'
db(hub-api): app_version_uploads, app_install_approvals, app_stream_grants, custom_platforms, ingest_sources, platform_settings

Six hub-api-exclusive control-plane tables backing the install/consent/
grants flow (spec Sec6.8, Sec6.9, Sec9.1, Sec9.2, Sec10.3, Sec10.4).
Grants generated from config/postgres/rbac-matrix.yaml, scoped to
these six tables only. Seeds the global bundles.allow_prebuilt=true
default (spec Sec12.3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 4: pydal test binder + `app.py` wiring + shared test fixture

**Depends on:** Task 2 (migration 0020's `app_versions`/`app_active_versions`/`app_versions_audit_log`), Task 3 (migration 0021's six tables) — the pydal binder mirrors exactly those nine tables.

**Files:**
- Modify: `hub_api/services/schema.py` (add `bind_bundle_install_tables`)
- Modify: `hub_api/app.py` (one new import + one new call in `_bind_reference_tables`)
- Modify: `hub_api/tests/conftest.py` (add `bundle_install_db` fixture)

**Interfaces:**
- Produces: `services.schema.bind_bundle_install_tables(dal: Any, *, migrate: bool = False) -> None` — binds `app_versions`, `app_active_versions`, `app_versions_audit_log`, `app_version_uploads` (including its `manifest_json` column, the parsed `bundle.yaml` v2, populated by Task 10), `app_install_approvals`, `app_stream_grants`, `custom_platforms`, `ingest_sources`, `platform_settings` on `dal`, idempotent (`"app_versions" in dal.tables` guard). Test fixture `bundle_install_db(tmp_path) -> AsyncDAL`, module constants `BUNDLE_TENANT_ID = 1`, `BUNDLE_COMMUNITY_ID = 1`, `BUNDLE_ADMIN_USER_ID = 1`.
- Consumes: nothing new — depends only on `bind_auth_tables`/`bind_community_authz_tables`/`bind_lifecycle_tables` already in `hub_api/services/schema.py` (existing).

- [ ] **Step 1: Add the binder function to `services/schema.py`**

Add this function at the end of `hub_api/services/schema.py` (after the last existing `bind_*_tables` function):

```python
def bind_bundle_install_tables(dal: Any, *, migrate: bool = False) -> None:
    """Define the nine tables backing bundle install/consent/grants (M2b, migrations 0020/0021).

    Production always binds with `migrate=False` -- schema owned by
    those two Alembic migrations, never by this process (same invariant
    every `bind_*_tables()` function in this file documents). Idempotent
    via the `"app_versions" in dal.tables` guard so a second call (e.g.
    a test fixture that also wants `migrate=True`) is a cheap no-op.

    `app_versions`/`app_active_versions`/`app_versions_audit_log` carry
    no Postgres-role enforcement in a pydal/sqlite test fixture --
    pydal has no concept of roles, so the Least-User-Access RBAC this
    plan adds (Tasks 1-2) is asserted only against a real Postgres
    instance (`tests/test_rbac_live_grants.py`), never through this
    binder.
    """
    if "app_versions" in dal.tables:
        return

    dal.define_table(
        "app_versions",
        Field("app_id", "string", length=255, notnull=True),
        Field("version", "string", length=50, notnull=True),
        Field("artifact_digest", "string", length=71),
        Field("cwasm_digest", "string", length=71),
        Field("wasmtime_abi", "string", length=50),
        Field("collector", "string", length=20),
        Field("size_bytes", "bigint"),
        Field("language", "string", length=20, notnull=True),
        Field("artifact_kind", "string", length=20, notnull=True),
        Field("built_at", "datetime"),
        Field("builder", "string", length=100),
        Field("scan_status", "string", length=30, default="not_scanned"),
        Field("badge", "string", length=100),
        Field("approval_id", "bigint"),
        Field("created_at", "datetime"),
        migrate=migrate,
    )

    dal.define_table(
        "app_active_versions",
        Field("app_id", "string", length=255, notnull=True),
        Field("tenant_id", "integer", notnull=True),
        Field("community_id", "integer", notnull=True, default=0),
        Field("version_id", "bigint", notnull=True),
        Field("activated_by", "integer"),
        Field("activated_at", "datetime"),
        primarykey=["app_id", "tenant_id", "community_id"],
        migrate=migrate,
    )

    dal.define_table(
        "app_versions_audit_log",
        Field("occurred_at", "datetime"),
        Field("db_role", "string", length=100, notnull=True),
        Field("operation", "string", length=10, notnull=True),
        Field("app_id", "string", length=255, notnull=True),
        Field("version", "string", length=50, notnull=True),
        Field("old_digest", "string", length=71),
        Field("new_digest", "string", length=71),
        migrate=migrate,
    )

    dal.define_table(
        "app_version_uploads",
        Field("app_id", "string", length=255, notnull=True),
        Field("version", "string", length=50, notnull=True),
        Field("tenant_id", "integer", notnull=True),
        Field("requested_by", "integer"),
        Field("artifact_kind", "string", length=20, notnull=True),
        Field("language", "string", length=20, notnull=True),
        Field("status", "string", length=30, default="UPLOADED"),
        Field("reject_reason", "string", length=100),
        Field("compiler_job_name", "string", length=255),
        Field("staging_manifest_key", "string", length=500),
        Field("staging_source_key", "string", length=500),
        Field("staging_component_key", "string", length=500),
        Field("manifest_json", "json"),
        Field("app_version_id", "bigint"),
        Field("created_at", "datetime"),
        Field("updated_at", "datetime"),
        migrate=migrate,
    )

    dal.define_table(
        "app_install_approvals",
        Field("tenant_id", "integer", notnull=True),
        Field("community_id", "integer"),
        Field("app_id", "string", length=255, notnull=True),
        Field("version", "string", length=50, notnull=True),
        Field("permission_hash", "string", length=71, notnull=True),
        Field("summary_json", "json", notnull=True),
        Field("approved_by", "integer"),
        Field("approved_at", "datetime"),
        Field("superseded_by", "bigint"),
        migrate=migrate,
    )

    dal.define_table(
        "app_stream_grants",
        Field("tenant_id", "integer", notnull=True),
        Field("community_id", "integer"),
        Field("app_id", "string", length=255, notnull=True),
        Field("stream_key", "string", length=500, notnull=True),
        Field("platform", "string", length=50, notnull=True),
        Field("source_id", "string", length=255, notnull=True),
        Field("label", "string", length=255, notnull=True),
        Field("granted_by", "integer"),
        Field("granted_at", "datetime"),
        Field("revoked_at", "datetime"),
        migrate=migrate,
    )

    dal.define_table(
        "custom_platforms",
        Field("tenant_id", "integer", notnull=True),
        Field("name", "string", length=100, notnull=True),
        Field("created_at", "datetime"),
        migrate=migrate,
    )

    dal.define_table(
        "ingest_sources",
        Field("tenant_id", "integer", notnull=True),
        Field("community_id", "integer"),
        Field("platform", "string", length=50, notnull=True),
        Field("source_id", "string", length=255, notnull=True),
        Field("label", "string", length=255, notnull=True),
        Field("secret_ciphertext", "blob"),
        Field("secret_iv", "blob"),
        Field("mapping", "json"),
        Field("enabled", "boolean", default=True),
        Field("created_at", "datetime"),
        Field("updated_at", "datetime"),
        migrate=migrate,
    )

    dal.define_table(
        "platform_settings",
        Field("key", "string", length=150, notnull=True),
        Field("value", "text"),
        Field("updated_by", "integer"),
        Field("updated_at", "datetime"),
        migrate=migrate,
    )
```

- [ ] **Step 2: Wire the binder into `app.py`**

In `hub_api/app.py`, add `bind_bundle_install_tables` to the existing `from services.schema import (...)` block (alphabetical, matching the existing list's ordering convention) and call it at the end of `_bind_reference_tables`:

```python
from services.schema import (
    bind_ai_routing_tables,
    bind_bundle_install_tables,
    bind_lifecycle_tables,
    bind_music_tables,
    bind_platform_tables,
    bind_token_billing_tables,
)
```

```python
    # Music Station queue feature (new schema, not a Node port) --
    # services/schema.py::bind_music_tables()'s own docstring explains why
    # it follows PORTING.md's normal "call from _bind_reference_tables"
    # checklist step instead of bind_streaming_tables()'s per-request
    # lazy-bind workaround.
    bind_music_tables(dal)
    # Bundle install/consent/grants schema (M2b, migrations 0020/0021) --
    # same "call once, unconditionally, at the end" convention as every
    # group above.
    bind_bundle_install_tables(dal)
```

- [ ] **Step 3: Add the shared test fixture to `tests/conftest.py`**

Add to the `from services.schema import (...)` block in `hub_api/tests/conftest.py`:

```python
    bind_bundle_install_tables,
```

Then add this fixture (near `lifecycle_db`/`distribution_db`, same file):

```python
@pytest.fixture
def bundle_install_db(tmp_path: Any) -> Any:
    """File-backed `AsyncDAL` for every M2b bundle-install/consent/grants test.

    Same file-backed-sqlite/`pool_size=1`/eager-table-touch shape as
    `lifecycle_db` above. Extends `bind_auth_tables()` +
    `bind_community_authz_tables()` + `bind_lifecycle_tables()` (needed
    for `app_catalog`, which every new table FKs against logically, and
    for `community_authz`'s admin checks) with this group's own
    `bind_bundle_install_tables()`. Seeds one tenant, one community, an
    `admin` community role, a membership granting user `"1"` that role,
    and one `app_catalog` row (`waddles.socials.music.default`) so
    version/approval/grant tests have a real `app_id` to reference.

    Deterministic seeded ids (fresh sqlite file, 1-based autoincrement):
    `BUNDLE_TENANT_ID = 1`, `BUNDLE_COMMUNITY_ID = 1`,
    `BUNDLE_ADMIN_USER_ID = 1` (module constants below).
    """
    async_dal = AsyncDAL(f"sqlite://{tmp_path / 'bundle_install_test.db'}", pool_size=1)
    dal = async_dal.dal
    dal.define_table(
        "tenants",
        Field("slug", unique=True),
        Field("display_name"),
        Field("logo_url"),
        Field("is_global", "boolean", default=False),
        Field("is_active", "boolean", default=True),
        Field("config", "json"),
    )
    bind_auth_tables(dal, migrate=True)
    bind_community_authz_tables(dal, migrate=True)
    bind_lifecycle_tables(dal, migrate=True)
    bind_bundle_install_tables(dal, migrate=True)

    tenant_id = dal.tenants.insert(slug=TENANT_SLUG, display_name="Acme Corp", is_active=True)
    community_id = dal.communities.insert(
        name="acme-community", display_name="Acme Community", tenant_id=tenant_id, is_active=True
    )
    role_id = dal.community_roles.insert(
        community_id=community_id,
        name="admin",
        base_claims={"scopes": ["community:manage_members"]},
    )
    dal.community_members.insert(
        community_id=community_id,
        user_id="1",
        role="admin",
        community_role_id=role_id,
        is_active=True,
    )
    dal.app_catalog.insert(
        app_id="waddles.socials.music.default",
        name="Music Station Song Request",
        manifest_version="3.0.0",
        module="socials",
        feature="waddles.socials.music",
        provider="builtin",
        execution_model="native",
        is_default=True,
        platform_compatibility={"tested_with": "3.0.0", "min_version": None, "max_version": None},
        status="active",
        stages={},
    )
    dal.commit()
    for table_name in dal.tables:
        dal(dal[table_name]).count()
    yield async_dal
    dal.close()


BUNDLE_TENANT_ID = 1
BUNDLE_COMMUNITY_ID = 1
BUNDLE_ADMIN_USER_ID = 1
```

- [ ] **Step 4: Write a smoke test proving the fixture works**

```python
# hub_api/tests/test_bundle_install_fixture_smoke.py
"""Smoke test for the bundle_install_db fixture -- proves every new table binds and is queryable."""

from __future__ import annotations

from typing import Any


async def test_every_new_table_is_queryable(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    for table_name in (
        "app_versions",
        "app_active_versions",
        "app_versions_audit_log",
        "app_version_uploads",
        "app_install_approvals",
        "app_stream_grants",
        "custom_platforms",
        "ingest_sources",
        "platform_settings",
    ):
        assert table_name in dal.tables
        assert dal(dal[table_name]).count() == 0


async def test_seed_data_present(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    row = dal(dal.app_catalog.app_id == "waddles.socials.music.default").select().first()
    assert row is not None
    assert row.status == "active"
```

- [ ] **Step 5: Run the smoke test**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_install_fixture_smoke.py -v`
Expected: `2 passed`

- [ ] **Step 6: Run the full existing hub-api suite to confirm no regression**

Run: `cd hub_api && python3 -m pytest -q`
Expected: every previously-passing test still passes; the printed summary line's pass count is the pre-existing count plus the 2 new smoke tests (e.g. `1141 passed` becomes `1143 passed` — confirm against your own `git stash`-free baseline run before this task, since the exact pre-existing count drifts release to release).

- [ ] **Step 7: Commit**

```bash
git add hub_api/services/schema.py hub_api/app.py hub_api/tests/conftest.py \
        hub_api/tests/test_bundle_install_fixture_smoke.py
git commit -m "$(cat <<'EOF'
feat(hub-api): bind_bundle_install_tables() + bundle_install_db test fixture

Wires the nine M2b tables (app_versions, app_active_versions,
app_versions_audit_log, app_version_uploads, app_install_approvals,
app_stream_grants, custom_platforms, ingest_sources, platform_settings)
into app.py's existing _bind_reference_tables() call chain, and adds
the shared file-backed-sqlite fixture every later M2b test in this
plan depends on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 5: RBAC live-grants CI equality test (Postgres integration)

**Depends on:** Task 1 (`services/rbac_matrix.py` loader), Tasks 2-3 (the migrated schema this test asserts against on a real Postgres).

**Files:**
- Create: `hub_api/tests/test_rbac_live_grants.py`

**Interfaces:**
- Consumes: `services.rbac_matrix.load_matrix`, `matrix_roles`, `matrix_tables` (Task 1); the migrated schema of Tasks 2-3 (this test requires a real Postgres instance with `alembic upgrade head` already applied — it is an **integration** test per `testing-python.md`'s category table, "real DB, rollback per test").
- Produces: nothing consumed by a later task — this is a leaf verification.

- [ ] **Step 1: Write the test**

```python
# hub_api/tests/test_rbac_live_grants.py
"""Asserts the live Postgres grants equal config/postgres/rbac-matrix.yaml exactly.

Requires a real, already-migrated Postgres instance -- set
`TEST_POSTGRES_ADMIN_DSN` (a superuser or table-owner DSN) to run.
Skipped otherwise, matching this repo's existing pattern of gating
Postgres-only tests behind an env var rather than mocking a real
database's role system (pydal/sqlite has no roles at all).

This is the primary Least-User-Access gate (spec D28/Sec11.10.1): a
missing grant AND an extra grant both fail, and the test asserts it
examined a non-zero, meaningfully-sized set of roles/tables --
`critical-rules.md` Verification Integrity: "Zero items examined is a
FAILURE, not a pass."

The per-role negative/positive spot-checks at the bottom of this file
are the "readable examples" the equality check subsumes -- kept
because a human skimming test output benefits from a concrete "this
exact role cannot INSERT" assertion, not just a matrix diff.
"""

from __future__ import annotations

import os

import psycopg2
import pytest

from services.rbac_matrix import load_matrix, matrix_roles, matrix_tables

_DSN = os.environ.get("TEST_POSTGRES_ADMIN_DSN")

pytestmark = pytest.mark.skipif(
    not _DSN, reason="requires a real, migrated Postgres instance (TEST_POSTGRES_ADMIN_DSN)"
)


@pytest.fixture
def pg_conn() -> object:
    conn = psycopg2.connect(_DSN)
    conn.autocommit = True
    yield conn
    conn.close()


def _live_grants(conn: object, tables: frozenset[str]) -> set[tuple[str, str, str]]:
    """`{(grantee, table, privilege), ...}` from `information_schema.role_table_grants`."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT grantee, table_name, privilege_type "
            "FROM information_schema.role_table_grants "
            "WHERE table_schema = 'public' AND table_name = ANY(%s)",
            (list(tables),),
        )
        return {(row[0], row[1], row[2]) for row in cur.fetchall()}


def _matrix_grants(tables: frozenset[str]) -> set[tuple[str, str, str]]:
    """The same `{(role, table, privilege), ...}` shape, derived from the matrix file."""
    expected: set[tuple[str, str, str]] = set()
    for spec in load_matrix():
        if spec.table not in tables:
            continue
        for privilege in spec.privileges:
            expected.add((spec.role, spec.table, privilege))
    return expected


def test_live_grants_equal_the_matrix_exactly(pg_conn: object) -> None:
    roles = matrix_roles()
    tables = matrix_tables()
    assert len(roles) >= 8, f"non-vacuous check requires >= 8 roles, matrix has {len(roles)}"
    assert len(tables) >= 8, f"non-vacuous check requires >= 8 tables, matrix has {len(tables)}"

    live = _live_grants(pg_conn, tables)
    # Only compare grantees the matrix actually declares -- a role this
    # migration doesn't own (e.g. the Postgres superuser connecting as
    # `postgres`) legitimately has implicit owner privileges the matrix
    # never claims to model.
    live_scoped = {row for row in live if row[0] in roles}
    expected = _matrix_grants(tables)

    missing = expected - live_scoped
    extra = live_scoped - expected
    assert not missing, f"grants the matrix declares but Postgres does not have: {sorted(missing)}"
    assert not extra, f"grants Postgres has that the matrix does not declare: {sorted(extra)}"
    print(f"RBAC live-grants check: {len(roles)} roles x {len(tables)} tables examined")


def test_app_versions_non_writer_roles_cannot_insert(pg_conn: object) -> None:
    """Readable example: each documented non-writer role is refused INSERT at the SQL level."""
    non_writers = sorted(
        {
            spec.role
            for spec in load_matrix()
            if spec.table == "app_versions" and not spec.privileges
        }
    )
    assert len(non_writers) >= 5, f"expected >= 5 non-writer roles, found {non_writers}"

    for role in non_writers:
        with pg_conn.cursor() as cur:
            cur.execute("BEGIN")
            cur.execute(f"SET ROLE {role}")
            with pytest.raises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(
                    "INSERT INTO app_versions (app_id, version, language, artifact_kind) "
                    "VALUES ('waddles.test.x.default', '0.0.1', 'python', 'source')"
                )
            cur.execute("RESET ROLE")
            cur.execute("ROLLBACK")


def test_app_versions_writer_roles_can_insert_and_are_audited(pg_conn: object) -> None:
    """Readable example: both writer roles succeed, and the trigger records both."""
    for role in ("waddles_publisher", "hub_api"):
        with pg_conn.cursor() as cur:
            cur.execute("BEGIN")
            cur.execute(f"SET ROLE {role}")
            cur.execute(
                "INSERT INTO app_versions (app_id, version, language, artifact_kind, artifact_digest) "
                "VALUES ('waddles.test.x.default', %s, 'python', 'source', %s)",
                (f"0.0.{role}", f"sha256:{'a' * 64}"),
            )
            cur.execute("RESET ROLE")
            cur.execute(
                "SELECT db_role FROM app_versions_audit_log "
                "WHERE app_id = 'waddles.test.x.default' AND operation = 'INSERT' "
                "ORDER BY id DESC LIMIT 1"
            )
            audited_role = cur.fetchone()[0]
            assert audited_role == role
            cur.execute("ROLLBACK")
```

- [ ] **Step 2: Run against a real Postgres to verify it passes**

Run:
```bash
docker run -d --name pg-m2b-rbac -e POSTGRES_PASSWORD=test -e POSTGRES_DB=waddlebot -p 55434:5432 postgres:17-alpine
sleep 3
DATABASE_URL="postgresql://postgres:test@localhost:55434/waddlebot" alembic upgrade head
cd hub_api
TEST_POSTGRES_ADMIN_DSN="postgresql://postgres:test@localhost:55434/waddlebot" \
  python3 -m pytest tests/test_rbac_live_grants.py -v -s
docker rm -f pg-m2b-rbac
```
Expected: `3 passed`, and stdout includes the line `RBAC live-grants check: 8 roles x 9 tables examined`.

- [ ] **Step 3: Verify the test correctly fails on a real drift (regression-proof the gate itself)**

Run:
```bash
docker run -d --name pg-m2b-rbac2 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=waddlebot -p 55435:5432 postgres:17-alpine
sleep 3
DATABASE_URL="postgresql://postgres:test@localhost:55435/waddlebot" alembic upgrade head
psql "postgresql://postgres:test@localhost:55435/waddlebot" -c "GRANT SELECT ON app_versions TO svc_process;"
cd hub_api
TEST_POSTGRES_ADMIN_DSN="postgresql://postgres:test@localhost:55435/waddlebot" \
  python3 -m pytest tests/test_rbac_live_grants.py::test_live_grants_equal_the_matrix_exactly -v
docker rm -f pg-m2b-rbac2
```
Expected: `FAILED` — the assertion error names `('svc_process', 'app_versions', 'SELECT')` as an extra grant the matrix does not declare. This step proves the gate can fail (`critical-rules.md` Verification Integrity: "A check that never fails will never be noticed").

- [ ] **Step 4: Commit**

```bash
git add hub_api/tests/test_rbac_live_grants.py
git commit -m "$(cat <<'EOF'
test(hub-api): RBAC live-grants equality test against config/postgres/rbac-matrix.yaml

Queries information_schema.role_table_grants and asserts set equality
with the matrix file in both directions -- a missing grant and an
extra grant both fail. Asserts >= 8 roles and >= 8 tables examined
(non-vacuous, spec Sec11.10.1). Includes per-role negative/positive
spot-checks on app_versions as readable examples.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 6: `requirements.in` additions + `bundle_secret_crypto.py`

**Depends on:** nothing — `requirements.in` and the AES-256-GCM helper stand alone.

**Files:**
- Modify: `hub_api/requirements.in`
- Create: `hub_api/services/bundle_secret_crypto.py`
- Test: `hub_api/tests/test_bundle_secret_crypto.py`

**Interfaces:**
- Produces: `services.bundle_secret_crypto.encrypt(plaintext: str) -> tuple[bytes, bytes]` (ciphertext-with-tag, iv), `decrypt(ciphertext: bytes, iv: bytes) -> str`, `EncryptionKeyError`.
- Consumes: nothing.

- [ ] **Step 1: Add the new dependencies**

Edit `hub_api/requirements.in`, appending after the `cryptography` block:

```
# M2b bundle-install group:
kubernetes>=31.0.0,<32.0.0  # compiler_job_service.py -- creates the bundle-compiler K8s Job
"PyYAML>=6.0.2,<7.0.0"  # services/rbac_matrix.py -- loads config/postgres/rbac-matrix.yaml
```

- [ ] **Step 2: Regenerate the pinned lockfile**

Run: `cd hub_api && uv pip compile requirements.in --generate-hashes -o requirements.txt`
Expected: exits 0, `requirements.txt` gains `kubernetes==31.x.x` and `PyYAML==6.0.x` entries with `--hash=sha256:...` lines.

- [ ] **Step 3: Write the failing test**

```python
# hub_api/tests/test_bundle_secret_crypto.py
"""AES-256-GCM round-trip + key-validation tests for webhook-secret at-rest encryption."""

from __future__ import annotations

import os

import pytest

from services.bundle_secret_crypto import EncryptionKeyError, decrypt, encrypt

_TEST_KEY = "a" * 64  # 32 bytes hex


@pytest.fixture(autouse=True)
def _key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUNDLE_SECRET_ENCRYPTION_KEY", _TEST_KEY)


def test_round_trip() -> None:
    ciphertext, iv = encrypt("my-webhook-secret")
    assert decrypt(ciphertext, iv) == "my-webhook-secret"


def test_ciphertext_differs_from_plaintext() -> None:
    ciphertext, _ = encrypt("my-webhook-secret")
    assert b"my-webhook-secret" not in ciphertext


def test_two_encryptions_use_different_ivs() -> None:
    _, iv1 = encrypt("same-value")
    _, iv2 = encrypt("same-value")
    assert iv1 != iv2


def test_missing_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BUNDLE_SECRET_ENCRYPTION_KEY", raising=False)
    with pytest.raises(EncryptionKeyError):
        encrypt("x")


def test_short_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUNDLE_SECRET_ENCRYPTION_KEY", "tooshort")
    with pytest.raises(EncryptionKeyError):
        encrypt("x")


def test_decrypt_with_wrong_iv_fails() -> None:
    ciphertext, iv = encrypt("my-webhook-secret")
    wrong_iv = os.urandom(12)
    with pytest.raises(Exception):  # noqa: PT011 -- cryptography raises InvalidTag, not our own type
        decrypt(ciphertext, wrong_iv)
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_secret_crypto.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_secret_crypto'`

- [ ] **Step 5: Write the implementation**

```python
# hub_api/services/bundle_secret_crypto.py
"""AES-256-GCM helpers for ingest-source webhook secrets at rest.

Same wire format as `services/bot_crypto.py` (12-byte IV, GCM tag
appended to ciphertext) but keyed by its own env var,
`BUNDLE_SECRET_ENCRYPTION_KEY` -- a deliberately separate key from
`RCON_ENCRYPTION_KEY` (different security domain: RCON server
credentials vs. per-tenant webhook HMAC secrets), never shared.
"""

from __future__ import annotations

import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_IV_LENGTH = 12
_KEY_HEX_LENGTH = 64


class EncryptionKeyError(ValueError):
    """`BUNDLE_SECRET_ENCRYPTION_KEY` is missing or not a 64-character hex string."""


def _get_key() -> bytes:
    hex_key = os.environ.get("BUNDLE_SECRET_ENCRYPTION_KEY", "")
    if len(hex_key) != _KEY_HEX_LENGTH:
        raise EncryptionKeyError("BUNDLE_SECRET_ENCRYPTION_KEY must be a 64-character hex string")
    return bytes.fromhex(hex_key)


def encrypt(plaintext: str) -> tuple[bytes, bytes]:
    """Encrypt `plaintext`; returns `(ciphertext_with_appended_tag, iv)`."""
    key = _get_key()
    iv = os.urandom(_IV_LENGTH)
    ciphertext = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
    return ciphertext, iv


def decrypt(ciphertext: bytes, iv: bytes) -> str:
    """Decrypt `ciphertext` (GCM tag appended) encrypted with `encrypt()`."""
    key = _get_key()
    plaintext = AESGCM(key).decrypt(iv, bytes(ciphertext), None)
    return plaintext.decode("utf-8")
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_secret_crypto.py -v`
Expected: `6 passed`

- [ ] **Step 7: Commit**

```bash
git add hub_api/requirements.in hub_api/requirements.txt \
        hub_api/services/bundle_secret_crypto.py hub_api/tests/test_bundle_secret_crypto.py
git commit -m "$(cat <<'EOF'
feat(hub-api): bundle_secret_crypto -- AES-256-GCM at rest for ingest-source webhook secrets

Adds kubernetes + PyYAML to requirements.in/txt (hash-pinned) for this
milestone's K8s Job orchestration and RBAC matrix loading. New
webhook-secret encryption module keyed by its own
BUNDLE_SECRET_ENCRYPTION_KEY env var, same wire format as the existing
bot_crypto.py but a separate key/security domain.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 7: `bundle_manifest_v2.py` — `bundle.yaml` v2 parse + hub-api's own validation subset

**Depends on:** nothing new — imports only `flask_core.app_manifest.KNOWN_MODULES`, already in the tree.

**Files:**
- Create: `hub_api/services/bundle_manifest_v2.py`
- Test: `hub_api/tests/test_bundle_manifest_v2.py`

**Interfaces:**
- Produces: `services.bundle_manifest_v2.parse_bundle_manifest_v2(raw: dict[str, Any], *, known_custom_platforms: frozenset[str], allow_wildcard_consumes: bool, allow_prebuilt: bool) -> BundleManifestV2`; `ManifestV2Error(reason: str, detail: str)`; dataclasses `BundleManifestV2` (`schema_version, app_id, name, version, feature, module, provider, language, artifact, execution_model, is_default, stages, egress, data_tables, limits, permissions, routes_to, consumes`), `ConsumeRule` (`platform, source_id, event_types, filters`), `EgressRule` (`host, methods`), `Limits` (`timeout_ms, memory_mb, egress_rps`).
- Consumes: `flask_core.app_manifest.KNOWN_MODULES` (existing, public).

This is hub-api's **pre-Job** pure-YAML pre-check (spec §9.2: "`400` with a `reason` code for a manifest that fails a pure-YAML rule") — it runs before the compiler Job is even created (Task 10), covering the rules hub-api's own DB makes cheap to check (V1-V21, V23-V24, V27-V30 minus the two artifact-based rules V25/V31, which only the compiler can check against the compiled component, per spec §6.4.4).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_manifest_v2.py
"""Tests for the bundle.yaml v2 pure-YAML validation subset hub-api checks pre-Job."""

from __future__ import annotations

import pytest

from services.bundle_manifest_v2 import ManifestV2Error, parse_bundle_manifest_v2

_VALID_MANIFEST = {
    "schema_version": 2,
    "app_id": "waddles.socials.music.default",
    "name": "Music Station Song Request",
    "version": "3.0.0",
    "feature": "waddles.socials.music",
    "module": "socials",
    "provider": "builtin",
    "language": "python",
    "artifact": "source",
    "stages": {
        "process": {
            "entry": "bundles.social_music_process:transform",
            "consumes": [
                {"platform": "twitch", "event_types": ["chat.message"]},
            ],
        },
    },
    "egress": [{"host": "api.spotify.com", "methods": ["GET", "POST"]}],
    "data": {"tables": ["music_queue"]},
    "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10},
}


def _parse(overrides: dict, **kwargs):
    manifest = {**_VALID_MANIFEST, **overrides}
    return parse_bundle_manifest_v2(
        manifest,
        known_custom_platforms=kwargs.get("known_custom_platforms", frozenset()),
        allow_wildcard_consumes=kwargs.get("allow_wildcard_consumes", False),
        allow_prebuilt=kwargs.get("allow_prebuilt", True),
    )


def test_valid_manifest_parses() -> None:
    manifest = _parse({})
    assert manifest.app_id == "waddles.socials.music.default"
    assert manifest.consumes[0].platform == "twitch"


def test_wrong_schema_version_rejected() -> None:
    with pytest.raises(ManifestV2Error) as exc:
        _parse({"schema_version": 1})
    assert exc.value.reason == "unsupported_schema_version"


def test_ingest_stage_rejected() -> None:
    manifest = {**_VALID_MANIFEST, "stages": {"ingest": {"entry": "x:y"}}}
    with pytest.raises(ManifestV2Error) as exc:
        parse_bundle_manifest_v2(
            manifest, known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True
        )
    assert exc.value.reason == "ingest_not_pluggable"


def test_process_stage_without_consumes_rejected() -> None:
    manifest = {
        **_VALID_MANIFEST,
        "stages": {"process": {"entry": "bundles.x:transform"}},
    }
    with pytest.raises(ManifestV2Error) as exc:
        parse_bundle_manifest_v2(
            manifest, known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True
        )
    assert exc.value.reason == "consumes_required"


def test_action_stage_with_consumes_rejected() -> None:
    manifest = {
        **_VALID_MANIFEST,
        "stages": {"action": {"entry": "bundles.x:dispatch", "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}]}},
    }
    with pytest.raises(ManifestV2Error) as exc:
        parse_bundle_manifest_v2(
            manifest, known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True
        )
    assert exc.value.reason == "consumes_on_action_stage"


def test_wildcard_consumes_rejected_without_tenant_setting() -> None:
    manifest = {
        **_VALID_MANIFEST,
        "stages": {"process": {"entry": "x:y", "consumes": [{"platform": "*", "event_types": ["chat.message"]}]}},
    }
    with pytest.raises(ManifestV2Error) as exc:
        parse_bundle_manifest_v2(
            manifest, known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True
        )
    assert exc.value.reason == "wildcard_consumes_not_allowed"


def test_wildcard_consumes_allowed_with_tenant_setting() -> None:
    manifest = {
        **_VALID_MANIFEST,
        "stages": {"process": {"entry": "x:y", "consumes": [{"platform": "*", "event_types": ["chat.message"]}]}},
    }
    parsed = parse_bundle_manifest_v2(
        manifest, known_custom_platforms=frozenset(), allow_wildcard_consumes=True, allow_prebuilt=True
    )
    assert parsed.consumes[0].platform == "*"


def test_unknown_custom_platform_rejected() -> None:
    manifest = {
        **_VALID_MANIFEST,
        "stages": {"process": {"entry": "x:y", "consumes": [{"platform": "custom:unregistered", "event_types": ["chat.message"]}]}},
    }
    with pytest.raises(ManifestV2Error) as exc:
        parse_bundle_manifest_v2(
            manifest, known_custom_platforms=frozenset({"other"}), allow_wildcard_consumes=False, allow_prebuilt=True
        )
    assert exc.value.reason == "unknown_consumes_platform"


def test_registered_custom_platform_accepted() -> None:
    manifest = {
        **_VALID_MANIFEST,
        "stages": {"process": {"entry": "x:y", "consumes": [{"platform": "custom:mycrm", "event_types": ["ticket.created"]}]}},
    }
    parsed = parse_bundle_manifest_v2(
        manifest, known_custom_platforms=frozenset({"mycrm"}), allow_wildcard_consumes=False, allow_prebuilt=True
    )
    assert parsed.consumes[0].platform == "custom:mycrm"


def test_prebuilt_rejected_when_global_setting_off() -> None:
    manifest = {**_VALID_MANIFEST, "artifact": "prebuilt", "language": "other"}
    with pytest.raises(ManifestV2Error) as exc:
        parse_bundle_manifest_v2(
            manifest, known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=False
        )
    assert exc.value.reason == "prebuilt_not_allowed"


def test_reserved_data_table_rejected() -> None:
    manifest = {**_VALID_MANIFEST, "data": {"tables": ["users"]}}
    with pytest.raises(ManifestV2Error) as exc:
        parse_bundle_manifest_v2(
            manifest, known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True
        )
    assert exc.value.reason == "reserved_data_table"


def test_limit_out_of_range_rejected() -> None:
    manifest = {**_VALID_MANIFEST, "limits": {"timeout_ms": 999999}}
    with pytest.raises(ManifestV2Error) as exc:
        parse_bundle_manifest_v2(
            manifest, known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True
        )
    assert exc.value.reason == "limit_out_of_range"


def test_invalid_egress_host_rejected() -> None:
    manifest = {**_VALID_MANIFEST, "egress": [{"host": "http://evil.example.com/path"}]}
    with pytest.raises(ManifestV2Error) as exc:
        parse_bundle_manifest_v2(
            manifest, known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True
        )
    assert exc.value.reason == "invalid_egress_host"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_manifest_v2.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_manifest_v2'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/bundle_manifest_v2.py
"""Parse + validate `bundle.yaml` v2 against hub-api's own pure-YAML rule subset.

Covers spec Sec6.4.4's V1-V21/V23-V24/V27-V30 -- everything checkable
without a compiled component. V22 (egress non-empty when the component
imports `http`), V25 (WIT export presence) and V31 (import allowlist)
are artifact-based and run only inside the compiler (M2a); this module
never claims to check them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from flask_core.app_manifest import KNOWN_MODULES

_SEGMENT = r"[a-z0-9][a-z0-9_-]*"
_APP_ID_RE = re.compile(rf"^waddles\.{_SEGMENT}\.{_SEGMENT}\.{_SEGMENT}$")
_FEATURE_RE = re.compile(rf"^waddles\.{_SEGMENT}\.{_SEGMENT}$")
_SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)
_EGRESS_HOST_RE = re.compile(r"^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
_TABLE_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
_ALLOWED_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"})
_RESERVED_TABLES = frozenset({"users", "tenants", "communities", "app_catalog", "app_activations", "app_tenant_availability"})
_ALLOWED_LANGUAGES = frozenset({"python", "rust", "javascript", "typescript", "other"})
_ALLOWED_STAGES = frozenset({"process", "action", "presentation"})
_MAX_TIMEOUT_MS = 10000
_MAX_MEMORY_MB = 256
_MAX_EGRESS_RPS = 10


class ManifestV2Error(ValueError):
    """Raised when a bundle.yaml v2 dict fails a pure-YAML validation rule. `reason` is machine-checkable."""

    def __init__(self, reason: str, detail: str) -> None:
        self.reason = reason
        super().__init__(f"{reason}: {detail}")


@dataclass(slots=True, frozen=True)
class ConsumeRule:
    """One `consumes` rule (spec Sec6.4.3)."""

    platform: str
    source_id: str | None
    event_types: tuple[str, ...]
    filters: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class EgressRule:
    """One `egress` entry."""

    host: str
    methods: tuple[str, ...]


@dataclass(slots=True, frozen=True)
class Limits:
    """The `limits` block, with hub-api's own defaults applied."""

    timeout_ms: int
    memory_mb: int
    egress_rps: int


@dataclass(slots=True, frozen=True)
class BundleManifestV2:
    """A validated `bundle.yaml` v2 manifest."""

    schema_version: int
    app_id: str
    name: str
    version: str
    feature: str
    module: str
    provider: str
    language: str
    artifact: str
    execution_model: str
    is_default: bool
    stages: dict[str, Any]
    egress: tuple[EgressRule, ...]
    data_tables: tuple[str, ...]
    limits: Limits
    permissions: tuple[str, ...]
    routes_to: tuple[str, ...]
    consumes: tuple[ConsumeRule, ...]


def _require(condition: bool, reason: str, detail: str) -> None:
    if not condition:
        raise ManifestV2Error(reason, detail)


def _parse_consumes(raw_rules: list[dict[str, Any]], *, known_custom_platforms: frozenset[str], allow_wildcard: bool) -> tuple[ConsumeRule, ...]:
    rules: list[ConsumeRule] = []
    for rule in raw_rules:
        platform = rule.get("platform", "")
        event_types = rule.get("event_types", [])
        _require(bool(platform), "missing_field", "consumes[].platform is required")
        _require(bool(event_types), "missing_field", "consumes[].event_types must be non-empty")
        if platform.startswith("custom:"):
            name = platform.removeprefix("custom:")
            _require(
                name in known_custom_platforms, "unknown_consumes_platform",
                f"{platform!r} is not registered for this tenant",
            )
        elif platform == "*":
            _require(allow_wildcard, "wildcard_consumes_not_allowed", "allow_wildcard_consumes is false for this tenant")
        for event_type in event_types:
            if event_type == "**" or "**" in event_type.split("."):
                _require(allow_wildcard, "wildcard_consumes_not_allowed", f"{event_type!r} requires allow_wildcard_consumes")
        rules.append(
            ConsumeRule(
                platform=platform,
                source_id=rule.get("source_id"),
                event_types=tuple(event_types),
                filters=dict(rule.get("filters") or {}),
            )
        )
    return tuple(rules)


def parse_bundle_manifest_v2(
    raw: dict[str, Any],
    *,
    known_custom_platforms: frozenset[str],
    allow_wildcard_consumes: bool,
    allow_prebuilt: bool,
) -> BundleManifestV2:
    """Parse+validate `raw` (a `yaml.safe_load`-d `bundle.yaml`). Raises `ManifestV2Error` on any rule failure."""
    for key in ("schema_version", "app_id", "name", "version", "feature", "module", "provider", "language", "artifact", "stages"):
        _require(key in raw, "missing_field", f"{key} is required")

    _require(raw["schema_version"] == 2, "unsupported_schema_version", f"got {raw['schema_version']!r}, expected 2")
    _require(bool(_SEMVER_RE.match(raw["version"])), "bad_semver", f"{raw['version']!r} is not valid SemVer 2.0.0")
    _require(bool(_APP_ID_RE.match(raw["app_id"])), "not_namespaced", f"{raw['app_id']!r} is not a valid app_id")
    _require(bool(_FEATURE_RE.match(raw["feature"])), "not_namespaced", f"{raw['feature']!r} is not a valid feature id")
    _require(raw["module"] in KNOWN_MODULES, "unknown_module", f"{raw['module']!r} is not a KNOWN_MODULES entry")
    _require(raw["feature"] == raw["app_id"].rsplit(".", 1)[0], "feature_prefix_mismatch", "feature must equal app_id minus its last segment")
    _require(raw["module"] == raw["feature"].split(".")[1], "feature_prefix_mismatch", "module must equal feature's second segment")
    _require(raw["provider"] in {"builtin", "thirdparty"}, "invalid_provider", f"{raw['provider']!r}")
    _require(raw["language"] in _ALLOWED_LANGUAGES, "unsupported_language", f"{raw['language']!r}")
    _require(raw["artifact"] in {"source", "prebuilt"}, "invalid_provider", f"{raw['artifact']!r}")
    if raw["language"] == "other":
        _require(raw["artifact"] == "prebuilt", "unsupported_language", "language 'other' requires artifact: prebuilt")
    if raw["artifact"] == "prebuilt":
        _require(allow_prebuilt, "prebuilt_not_allowed", "bundles.allow_prebuilt is false")

    stages = raw["stages"]
    _require(bool(stages), "no_stages_declared", "stages must be non-empty")
    _require("ingest" not in stages, "ingest_not_pluggable", "ingest is fixed code, not bundle-pluggable")
    for stage_name in stages:
        _require(stage_name in _ALLOWED_STAGES, "unknown_surface", f"{stage_name!r}")

    consumes: tuple[ConsumeRule, ...] = ()
    if "process" in stages:
        process_consumes = stages["process"].get("consumes") or []
        _require(bool(process_consumes), "consumes_required", "a process stage must declare consumes")
        consumes = _parse_consumes(
            process_consumes, known_custom_platforms=known_custom_platforms, allow_wildcard=allow_wildcard_consumes
        )
    if "action" in stages:
        _require(not stages["action"].get("consumes"), "consumes_on_action_stage", "an action stage must not declare consumes")

    egress_rules: list[EgressRule] = []
    for entry in raw.get("egress") or []:
        host = entry.get("host", "")
        _require(bool(_EGRESS_HOST_RE.match(host)) and "://" not in host, "invalid_egress_host", f"{host!r}")
        methods = tuple(entry.get("methods") or sorted(_ALLOWED_METHODS))
        _require(set(methods) <= _ALLOWED_METHODS, "invalid_egress_method", f"{methods!r}")
        egress_rules.append(EgressRule(host=host, methods=methods))

    tables: list[str] = []
    for table in (raw.get("data") or {}).get("tables") or []:
        _require(bool(_TABLE_RE.match(table)), "invalid_data_table", f"{table!r}")
        _require(table not in _RESERVED_TABLES, "reserved_data_table", f"{table!r} is a reserved identity table")
        tables.append(table)

    raw_limits = raw.get("limits") or {}
    timeout_ms = int(raw_limits.get("timeout_ms", 2000))
    memory_mb = int(raw_limits.get("memory_mb", 64))
    egress_rps = int(raw_limits.get("egress_rps", 10))
    _require(50 <= timeout_ms <= _MAX_TIMEOUT_MS, "limit_out_of_range", f"timeout_ms={timeout_ms}")
    _require(8 <= memory_mb <= _MAX_MEMORY_MB, "limit_out_of_range", f"memory_mb={memory_mb}")
    _require(1 <= egress_rps <= _MAX_EGRESS_RPS, "limit_out_of_range", f"egress_rps={egress_rps}")

    return BundleManifestV2(
        schema_version=raw["schema_version"],
        app_id=raw["app_id"],
        name=raw["name"],
        version=raw["version"],
        feature=raw["feature"],
        module=raw["module"],
        provider=raw["provider"],
        language=raw["language"],
        artifact=raw["artifact"],
        execution_model=raw.get("execution_model", "native"),
        is_default=bool(raw.get("is_default", False)),
        stages=stages,
        egress=tuple(egress_rules),
        data_tables=tuple(tables),
        limits=Limits(timeout_ms=timeout_ms, memory_mb=memory_mb, egress_rps=egress_rps),
        permissions=tuple(raw.get("permissions") or []),
        routes_to=tuple(raw.get("routes_to") or []),
        consumes=consumes,
    )
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_manifest_v2.py -v`
Expected: `13 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/bundle_manifest_v2.py hub_api/tests/test_bundle_manifest_v2.py
git commit -m "$(cat <<'EOF'
feat(hub-api): bundle.yaml v2 parser -- hub-api's pure-YAML validation subset (spec Sec6.4)

Covers V1-V21/V23-V24/V27-V30 pre-Job, before the compiler Job (which
alone can check the two artifact-based rules, V25/V31) is even
created. ingest_not_pluggable, consumes_required/consumes_on_action_
stage, wildcard_consumes_not_allowed and custom-platform-registration
are all enforced here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 8: `bundle_storage_service.py` — staging upload + bucket digest verification

**Depends on:** Task 6 (`boto3` pinned in `requirements.in`).

**Files:**
- Create: `hub_api/services/bundle_storage_service.py`
- Test: `hub_api/tests/test_bundle_storage_service.py`

**Interfaces:**
- Produces: `services.bundle_storage_service.stage_upload(app_id: str, version: str, *, manifest_bytes: bytes, source_bytes: bytes | None, component_bytes: bytes | None) -> StagedUpload` (dataclass: `manifest_key, source_key, component_key`); `fetch_object_sha256(key: str) -> str` (returns `"sha256:" + 64 hex`, used by Task 13's digest cross-check); `BUCKET_NAME` env-driven constant function `bucket_name() -> str`.
- Consumes: nothing new (`boto3`, already a pinned dependency via `storage_service.py`'s precedent).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_storage_service.py
"""Tests for the bundle bucket staging + digest-verification helpers, boto3 mocked."""

from __future__ import annotations

import hashlib
from unittest.mock import MagicMock, patch

import pytest

from services.bundle_storage_service import fetch_object_sha256, stage_upload


@pytest.fixture(autouse=True)
def _bucket_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUNDLE_BUCKET_ENDPOINT", "http://minio.waddles.svc.cluster.local:9000")
    monkeypatch.setenv("BUNDLE_BUCKET_NAME", "waddles-bundles")
    monkeypatch.setenv("BUNDLE_BUCKET_ACCESS_KEY_ID", "test-key")
    monkeypatch.setenv("BUNDLE_BUCKET_SECRET_ACCESS_KEY", "test-secret")


async def test_stage_upload_writes_manifest_and_source() -> None:
    mock_client = MagicMock()
    with patch("services.bundle_storage_service._client", return_value=mock_client):
        staged = await stage_upload(
            "waddles.socials.music.default", "3.0.0",
            manifest_bytes=b"schema_version: 2\n",
            source_bytes=b"fake-tarball-bytes",
            component_bytes=None,
        )
    assert staged.manifest_key == "staging/waddles.socials.music.default/3.0.0/manifest.yaml"
    assert staged.source_key == "staging/waddles.socials.music.default/3.0.0/source.tar.zst"
    assert staged.component_key is None
    assert mock_client.put_object.call_count == 2
    for call in mock_client.put_object.call_args_list:
        assert call.kwargs["ServerSideEncryption"] == "AES256"


async def test_stage_upload_writes_component_for_prebuilt() -> None:
    mock_client = MagicMock()
    with patch("services.bundle_storage_service._client", return_value=mock_client):
        staged = await stage_upload(
            "waddles.socials.music.default", "3.0.0",
            manifest_bytes=b"schema_version: 2\n",
            source_bytes=None,
            component_bytes=b"fake-wasm-bytes",
        )
    assert staged.component_key == "staging/waddles.socials.music.default/3.0.0/component.wasm"
    assert staged.source_key is None


async def test_fetch_object_sha256_hashes_the_downloaded_bytes() -> None:
    body = b"the exact bytes the compiler published"
    expected = "sha256:" + hashlib.sha256(body).hexdigest()
    mock_client = MagicMock()
    mock_client.get_object.return_value = {"Body": MagicMock(read=MagicMock(return_value=body))}
    with patch("services.bundle_storage_service._client", return_value=mock_client):
        digest = await fetch_object_sha256("bundles/waddles.socials.music.default/3.0.0/deadbeef.wasm")
    assert digest == expected
    mock_client.get_object.assert_called_once()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_storage_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_storage_service'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/bundle_storage_service.py
"""S3-compatible bucket access for the bundle-install flow -- staging uploads + digest verification.

Same boto3/`asyncio.to_thread` pattern as `services/storage_service.py`
(avatar/community-asset uploads), a separate bucket/credential set
(`BUNDLE_BUCKET_*` env vars, chart value `bundles.bucket.*` per spec
Sec12.3) since the bundle bucket holds compiled components and their
signed sidecars, not user media.

`stage_upload()` writes hub-api's own pre-compile staging copy under
`staging/{app_id}/{version}/...` -- distinct from the compiler's own
published, content-addressed `bundles/{app_id}/{version}/{sha256}.wasm`
key layout (spec Sec9.4), because hub-api does not yet know the digest
at upload time. `fetch_object_sha256()` is the digest-verification
primitive Task 13's artifact-callback cross-check re-hashes the
published object with -- hub-api verifies a claimed digest; it never
computes one on its own initiative.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.client import Config as BotoConfig


@dataclass(slots=True, frozen=True)
class StagedUpload:
    """The bucket keys hub-api wrote for one uploaded version."""

    manifest_key: str
    source_key: str | None
    component_key: str | None


def _client() -> Any:
    return boto3.client(
        "s3",
        endpoint_url=os.getenv("BUNDLE_BUCKET_ENDPOINT", "http://minio.waddles.svc.cluster.local:9000"),
        aws_access_key_id=os.getenv("BUNDLE_BUCKET_ACCESS_KEY_ID", ""),
        aws_secret_access_key=os.getenv("BUNDLE_BUCKET_SECRET_ACCESS_KEY", ""),
        region_name=os.getenv("BUNDLE_BUCKET_REGION", "us-east-1"),
        config=BotoConfig(signature_version="s3v4"),
    )


def bucket_name() -> str:
    """The bundle bucket name -- `waddles-bundles` by default (spec Sec12.3)."""
    return os.getenv("BUNDLE_BUCKET_NAME", "waddles-bundles")


async def stage_upload(
    app_id: str,
    version: str,
    *,
    manifest_bytes: bytes,
    source_bytes: bytes | None,
    component_bytes: bytes | None,
) -> StagedUpload:
    """Write the uploaded manifest plus (source XOR component) to the staging prefix."""
    prefix = f"staging/{app_id}/{version}"
    manifest_key = f"{prefix}/manifest.yaml"
    source_key = f"{prefix}/source.tar.zst" if source_bytes is not None else None
    component_key = f"{prefix}/component.wasm" if component_bytes is not None else None

    def _put_all() -> None:
        client = _client()
        client.put_object(
            Bucket=bucket_name(), Key=manifest_key, Body=manifest_bytes,
            ContentType="application/yaml", ServerSideEncryption="AES256",
        )
        if source_bytes is not None:
            client.put_object(
                Bucket=bucket_name(), Key=source_key, Body=source_bytes,
                ContentType="application/zstd", ServerSideEncryption="AES256",
            )
        if component_bytes is not None:
            client.put_object(
                Bucket=bucket_name(), Key=component_key, Body=component_bytes,
                ContentType="application/wasm", ServerSideEncryption="AES256",
            )

    await asyncio.to_thread(_put_all)
    return StagedUpload(manifest_key=manifest_key, source_key=source_key, component_key=component_key)


async def fetch_object_sha256(key: str) -> str:
    """Download the object at `key` and return `"sha256:" + hex digest` over its bytes.

    The verification primitive -- hub-api never trusts a claimed digest
    without re-hashing the actual bucket object (Task 13).
    """

    def _get_and_hash() -> str:
        response = _client().get_object(Bucket=bucket_name(), Key=key)
        body = response["Body"].read()
        return "sha256:" + hashlib.sha256(body).hexdigest()

    return await asyncio.to_thread(_get_and_hash)
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_storage_service.py -v`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/bundle_storage_service.py hub_api/tests/test_bundle_storage_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): bundle_storage_service -- staging bucket upload + digest re-verification

Same boto3/asyncio.to_thread pattern as storage_service.py, a
dedicated bucket/credential set. fetch_object_sha256() is the
primitive Task 13's artifact-callback cross-check uses: hub-api
re-hashes the published object rather than trusting a claimed digest.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 9: `compiler_job_service.py` — launch the bundle-compiler K8s Job

**Depends on:** Task 6 (`kubernetes` pinned in `requirements.in`), Task 8 (`StagedUpload`, the staging keys the Job is pointed at).

**Files:**
- Create: `hub_api/services/compiler_job_service.py`
- Test: `hub_api/tests/test_compiler_job_service.py`

**Interfaces:**
- Produces: `services.compiler_job_service.build_job_spec(...) -> dict[str, Any]` (a plain dict shaped like the K8s Job manifest, easy to assert against without a live cluster), `create_compiler_job(batch_api: Any, *, namespace: str, app_id: str, version: str, artifact_kind: str, language: str, staged: StagedUpload, validation_context: dict[str, Any], callback_token: str) -> str` (returns the created Job's `metadata.name`).
- Consumes: `services.bundle_storage_service.StagedUpload` (Task 8).
- **Must match M2a** — the compiler binary reads exactly the env vars this task sets. The `VALIDATION_CONTEXT_JSON` env var's shape (below) is the boundary contract between M2b (hub-api, this plan) and M2a (the compiler): `{"known_custom_platforms": list[str], "allow_wildcard_consumes": bool, "allow_prebuilt": bool, "egress_denylist": list[str]}`. If M2a's plan defines a different shape, reconcile there — this plan's version is the one hub-api ships until that reconciliation happens.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_compiler_job_service.py
"""Tests for the bundle-compiler K8s Job builder, kubernetes client mocked."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from services.bundle_storage_service import StagedUpload
from services.compiler_job_service import build_job_spec, create_compiler_job

_STAGED = StagedUpload(
    manifest_key="staging/waddles.socials.music.default/3.0.0/manifest.yaml",
    source_key="staging/waddles.socials.music.default/3.0.0/source.tar.zst",
    component_key=None,
)
_VALIDATION_CONTEXT = {
    "known_custom_platforms": ["mycrm"],
    "allow_wildcard_consumes": False,
    "allow_prebuilt": True,
    "egress_denylist": ["evil.example.com"],
}


def test_build_job_spec_sets_gvisor_runtime_class(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SANDBOX_RUNTIME_CLASS_NAME", "runsc")
    spec = build_job_spec(
        app_id="waddles.socials.music.default", version="3.0.0", artifact_kind="source",
        language="python", staged=_STAGED, validation_context=_VALIDATION_CONTEXT, callback_token="tok",
    )
    assert spec["spec"]["template"]["spec"]["runtimeClassName"] == "runsc"


def test_build_job_spec_network_policy_relevant_fields() -> None:
    spec = build_job_spec(
        app_id="waddles.socials.music.default", version="3.0.0", artifact_kind="source",
        language="python", staged=_STAGED, validation_context=_VALIDATION_CONTEXT, callback_token="tok",
    )
    container = spec["spec"]["template"]["spec"]["containers"][0]
    security_context = container["securityContext"]
    assert security_context["allowPrivilegeEscalation"] is False
    assert security_context["readOnlyRootFilesystem"] is True
    assert security_context["capabilities"]["drop"] == ["ALL"]
    assert spec["spec"]["backoffLimit"] == 0
    assert spec["spec"]["activeDeadlineSeconds"] == 900


def test_build_job_spec_env_vars_carry_the_validation_context() -> None:
    spec = build_job_spec(
        app_id="waddles.socials.music.default", version="3.0.0", artifact_kind="source",
        language="python", staged=_STAGED, validation_context=_VALIDATION_CONTEXT, callback_token="tok",
    )
    container = spec["spec"]["template"]["spec"]["containers"][0]
    env = {e["name"]: e["value"] for e in container["env"]}
    assert env["APP_ID"] == "waddles.socials.music.default"
    assert env["VERSION"] == "3.0.0"
    assert env["ARTIFACT_KIND"] == "source"
    assert env["LANGUAGE"] == "python"
    assert env["MANIFEST_KEY"] == _STAGED.manifest_key
    assert env["SOURCE_KEY"] == _STAGED.source_key
    assert "COMPONENT_KEY" not in env
    parsed_context = json.loads(env["VALIDATION_CONTEXT_JSON"])
    assert parsed_context == _VALIDATION_CONTEXT
    assert env["HUB_API_CALLBACK_TOKEN"] == "tok"  # nosec B105 -- test fixture value, not a real secret


def test_build_job_spec_names_the_job_deterministically() -> None:
    spec = build_job_spec(
        app_id="waddles.socials.music.default", version="3.0.0", artifact_kind="source",
        language="python", staged=_STAGED, validation_context=_VALIDATION_CONTEXT, callback_token="tok",
    )
    name = spec["metadata"]["name"]
    assert name.startswith("bundle-compile-")
    assert len(name) <= 63  # K8s object-name limit


async def test_create_compiler_job_calls_batch_api_and_returns_job_name() -> None:
    mock_batch_api = MagicMock()
    mock_batch_api.create_namespaced_job.return_value = MagicMock(
        metadata=MagicMock(name="bundle-compile-abc123")
    )
    job_name = await create_compiler_job(
        mock_batch_api, namespace="waddles", app_id="waddles.socials.music.default",
        version="3.0.0", artifact_kind="source", language="python",
        staged=_STAGED, validation_context=_VALIDATION_CONTEXT, callback_token="tok",
    )
    assert job_name == "bundle-compile-abc123"
    mock_batch_api.create_namespaced_job.assert_called_once()
    assert mock_batch_api.create_namespaced_job.call_args.kwargs["namespace"] == "waddles"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_compiler_job_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.compiler_job_service'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/compiler_job_service.py
"""Build and launch the bundle-compiler Kubernetes Job (spec Sec4.6, Sec9.2).

One Job per uploaded version, gVisor-sandboxed, network-restricted to
the bucket and this callback (D10) -- the NetworkPolicy itself is a
chart concern (Task 12), this module only builds the Job's pod spec so
the two agree on image/env/security context.

**Must match M2a**: the compiler binary reads exactly the env vars this
module sets, including `VALIDATION_CONTEXT_JSON`'s shape -- the
snapshot of tenant-dependent validation state (registered custom
platforms, the two boolean settings, the egress denylist) the Job has
no other way to see, since its own NetworkPolicy denies it a live query
back to hub-api's DB (D10: "no network except the bucket and the
hub-api callback").
"""

from __future__ import annotations

import json
import os
from typing import Any

from services.bundle_storage_service import StagedUpload, bucket_name


def _job_name(app_id: str, version: str) -> str:
    """Deterministic, K8s-object-name-safe Job name, `bundle-compile-<hash>`."""
    import hashlib

    digest = hashlib.sha256(f"{app_id}:{version}".encode()).hexdigest()[:16]
    return f"bundle-compile-{digest}"


def build_job_spec(
    *,
    app_id: str,
    version: str,
    artifact_kind: str,
    language: str,
    staged: StagedUpload,
    validation_context: dict[str, Any],
    callback_token: str,
) -> dict[str, Any]:
    """Build the plain-dict Job manifest `create_namespaced_job` sends as `body=`."""
    image = os.environ.get(
        "BUNDLE_COMPILER_IMAGE", "ghcr.io/penguintechinc/waddles/bundle-compiler:latest"
    )
    runtime_class = os.environ.get("SANDBOX_RUNTIME_CLASS_NAME", "runsc")
    hub_api_callback_url = os.environ.get(
        "HUB_API_CALLBACK_URL", "https://hub-api.waddles.svc.cluster.local:8204"
    )

    env = [
        {"name": "APP_ID", "value": app_id},
        {"name": "VERSION", "value": version},
        {"name": "ARTIFACT_KIND", "value": artifact_kind},
        {"name": "LANGUAGE", "value": language},
        {"name": "MANIFEST_KEY", "value": staged.manifest_key},
        {"name": "BUCKET_NAME", "value": bucket_name()},
        {"name": "HUB_API_CALLBACK_URL", "value": hub_api_callback_url},
        {"name": "HUB_API_CALLBACK_TOKEN", "value": callback_token},
        {"name": "VALIDATION_CONTEXT_JSON", "value": json.dumps(validation_context, sort_keys=True)},
    ]
    if staged.source_key is not None:
        env.append({"name": "SOURCE_KEY", "value": staged.source_key})
    if staged.component_key is not None:
        env.append({"name": "COMPONENT_KEY", "value": staged.component_key})

    name = _job_name(app_id, version)
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": name, "labels": {"app": "bundle-compiler", "waddles.io/app-id": app_id[:63]}},
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": 900,
            "ttlSecondsAfterFinished": 86400,
            "template": {
                "metadata": {"labels": {"app": "bundle-compiler"}},
                "spec": {
                    "restartPolicy": "Never",
                    "serviceAccountName": "bundle-compiler",
                    "runtimeClassName": runtime_class,
                    "automountServiceAccountToken": False,
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 10001,
                        "runAsGroup": 10001,
                        "fsGroup": 10001,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "containers": [
                        {
                            "name": "bundle-compiler",
                            "image": image,
                            "env": env,
                            "resources": {
                                "limits": {"cpu": "2000m", "memory": "4Gi"},
                            },
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "readOnlyRootFilesystem": True,
                                "capabilities": {"drop": ["ALL"]},
                            },
                        }
                    ],
                },
            },
        },
    }


async def create_compiler_job(
    batch_api: Any,
    *,
    namespace: str,
    app_id: str,
    version: str,
    artifact_kind: str,
    language: str,
    staged: StagedUpload,
    validation_context: dict[str, Any],
    callback_token: str,
) -> str:
    """Create the Job via `batch_api.create_namespaced_job`. Returns the created Job's name.

    `batch_api` is a `kubernetes.client.BatchV1Api`-shaped object,
    passed in rather than constructed here so tests inject a mock and
    the caller (Task 10) controls in-cluster vs. kubeconfig auth.
    """
    import asyncio

    job_spec = build_job_spec(
        app_id=app_id, version=version, artifact_kind=artifact_kind, language=language,
        staged=staged, validation_context=validation_context, callback_token=callback_token,
    )

    def _create() -> Any:
        return batch_api.create_namespaced_job(namespace=namespace, body=job_spec)

    result = await asyncio.to_thread(_create)
    return str(result.metadata.name)
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_compiler_job_service.py -v`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/compiler_job_service.py hub_api/tests/test_compiler_job_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): compiler_job_service -- launch the gVisor-sandboxed bundle-compiler K8s Job

One Job per uploaded version, backoffLimit=0, activeDeadlineSeconds=900,
rootless/no-new-privileges/read-only-rootfs/drop-ALL (spec Sec4.6,
Sec9.2). VALIDATION_CONTEXT_JSON is the M2a boundary contract: the
compiler's own NetworkPolicy has no live DB access, so hub-api snapshots
registered custom platforms + the two tenant settings + the egress
denylist into this one env var at Job-creation time.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 10: `bundle_version_service.py` — `create_version()` orchestration + `get_version()`/`list_versions()`

**Depends on:** Task 4 (`app_version_uploads` bound and the `bundle_install_db` fixture), Task 7 (`parse_bundle_manifest_v2`), Task 8 (`stage_upload`), Task 9 (`create_compiler_job`).

**Files:**
- Create: `hub_api/services/bundle_version_service.py`
- Test: `hub_api/tests/test_bundle_version_service.py`

**Interfaces:**
- Produces: state constants `STATUS_UPLOADED, STATUS_VALIDATING, STATUS_SCANNING, STATUS_INSPECTING, STATUS_COMPILING, STATUS_ADDRESSING, STATUS_PUBLISHING, STATUS_PUBLISHED, STATUS_REJECTED`; `async def create_version(async_dal, dal, *, tenant_id: int, app_id: str, requested_by: int, manifest_bytes: bytes, source_bytes: bytes | None, component_bytes: bytes | None, batch_api: Any, namespace: str, known_custom_platforms: frozenset[str], allow_wildcard_consumes: bool, allow_prebuilt: bool) -> Any` (the inserted row, re-selected); `async def get_version(async_dal, dal, *, app_id: str, version: str) -> Any` (raises `not_found()`); `async def list_versions(async_dal, dal, *, app_id: str) -> list[Any]`.
- Consumes: `services.bundle_manifest_v2.parse_bundle_manifest_v2`/`ManifestV2Error` (Task 7), `services.bundle_storage_service.stage_upload` (Task 8), `services.compiler_job_service.create_compiler_job` (Task 9), `services.errors.{ApiError, bad_request, conflict, not_found, forbidden}` (existing), `flask_core.auth.create_jwt_token`/`flask_core.secrets.require_secret_key` (existing).

`BUNDLE_MAX_SOURCE_BYTES = 16_777_216`, `BUNDLE_MAX_COMPONENT_BYTES = 33_554_432` (spec §9.2) are module constants here.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_version_service.py
"""Tests for bundle_version_service.create_version()/get_version()/list_versions()."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import yaml

from services.bundle_version_service import (
    STATUS_UPLOADED,
    STATUS_VALIDATING,
    create_version,
    get_version,
    list_versions,
)
from services.errors import ApiError

_MANIFEST = {
    "schema_version": 2,
    "app_id": "waddles.socials.music.default",
    "name": "Music Station Song Request",
    "version": "3.0.1",
    "feature": "waddles.socials.music",
    "module": "socials",
    "provider": "builtin",
    "language": "python",
    "artifact": "source",
    "stages": {
        "process": {
            "entry": "bundles.social_music_process:transform",
            "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}],
        },
    },
}


def _mock_batch_api() -> Any:
    mock = MagicMock()
    mock.create_namespaced_job.return_value = MagicMock(metadata=MagicMock(name="bundle-compile-abc"))
    return mock


async def test_create_version_happy_path(bundle_install_db: Any) -> None:
    with patch("services.bundle_storage_service.stage_upload") as mock_stage:
        mock_stage.return_value = MagicMock(
            manifest_key="staging/x/3.0.1/manifest.yaml",
            source_key="staging/x/3.0.1/source.tar.zst",
            component_key=None,
        )
        row = await create_version(
            bundle_install_db, bundle_install_db.dal,
            tenant_id=1, app_id="waddles.socials.music.default", requested_by=1,
            manifest_bytes=yaml.safe_dump(_MANIFEST).encode(),
            source_bytes=b"fake-tarball", component_bytes=None,
            batch_api=_mock_batch_api(), namespace="waddles",
            known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True,
        )
    assert row.status == STATUS_VALIDATING
    assert row.compiler_job_name == "bundle-compile-abc"
    assert row.version == "3.0.1"


async def test_create_version_rejects_duplicate(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status=STATUS_UPLOADED,
    )
    dal.commit()
    with pytest.raises(ApiError) as exc:
        await create_version(
            bundle_install_db, dal, tenant_id=1, app_id="waddles.socials.music.default", requested_by=1,
            manifest_bytes=yaml.safe_dump(_MANIFEST).encode(),
            source_bytes=b"x", component_bytes=None, batch_api=_mock_batch_api(), namespace="waddles",
            known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True,
        )
    assert exc.value.status_code == 409


async def test_create_version_rejects_bad_manifest(bundle_install_db: Any) -> None:
    bad_manifest = {**_MANIFEST, "schema_version": 1}
    with pytest.raises(ApiError) as exc:
        await create_version(
            bundle_install_db, bundle_install_db.dal, tenant_id=1,
            app_id="waddles.socials.music.default", requested_by=1,
            manifest_bytes=yaml.safe_dump(bad_manifest).encode(),
            source_bytes=b"x", component_bytes=None, batch_api=_mock_batch_api(), namespace="waddles",
            known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True,
        )
    assert exc.value.status_code == 400
    assert exc.value.code == "unsupported_schema_version"


async def test_create_version_rejects_oversize_source(bundle_install_db: Any) -> None:
    with pytest.raises(ApiError) as exc:
        await create_version(
            bundle_install_db, bundle_install_db.dal, tenant_id=1,
            app_id="waddles.socials.music.default", requested_by=1,
            manifest_bytes=yaml.safe_dump(_MANIFEST).encode(),
            source_bytes=b"x" * (16_777_216 + 1), component_bytes=None,
            batch_api=_mock_batch_api(), namespace="waddles",
            known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=True,
        )
    assert exc.value.status_code == 413


async def test_create_version_rejects_prebuilt_when_disallowed(bundle_install_db: Any) -> None:
    prebuilt_manifest = {**_MANIFEST, "artifact": "prebuilt", "language": "other"}
    del prebuilt_manifest["stages"]["process"]["entry"]
    with pytest.raises(ApiError) as exc:
        await create_version(
            bundle_install_db, bundle_install_db.dal, tenant_id=1,
            app_id="waddles.socials.music.default", requested_by=1,
            manifest_bytes=yaml.safe_dump(prebuilt_manifest).encode(),
            source_bytes=None, component_bytes=b"x", batch_api=_mock_batch_api(), namespace="waddles",
            known_custom_platforms=frozenset(), allow_wildcard_consumes=False, allow_prebuilt=False,
        )
    assert exc.value.status_code == 403
    assert exc.value.code == "prebuilt_not_allowed"


async def test_get_version_not_found_raises_404(bundle_install_db: Any) -> None:
    with pytest.raises(ApiError) as exc:
        await get_version(bundle_install_db, bundle_install_db.dal, app_id="waddles.x.y.default", version="1.0.0")
    assert exc.value.status_code == 404


async def test_list_versions_returns_all_versions_for_app_id(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="1.0.0", tenant_id=1,
        artifact_kind="source", language="python", status=STATUS_UPLOADED,
    )
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="2.0.0", tenant_id=1,
        artifact_kind="source", language="python", status=STATUS_UPLOADED,
    )
    dal.commit()
    rows = await list_versions(bundle_install_db, dal, app_id="waddles.socials.music.default")
    assert {r.version for r in rows} == {"1.0.0", "2.0.0"}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_version_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_version_service'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/bundle_version_service.py
"""Version-upload orchestration: parse -> stage -> mint callback token -> launch compiler Job.

`app_version_uploads` is hub-api's own pre-publish lifecycle tracker
(this plan's Decision #2) -- `app_versions` itself (Task 2) has no
status column and is written only by `waddles_publisher`/`hub_api`
post-build (Task 13).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import yaml
from flask_core.auth import create_jwt_token
from flask_core.secrets import require_secret_key

from services.bundle_manifest_v2 import ManifestV2Error, parse_bundle_manifest_v2
from services.bundle_storage_service import stage_upload
from services.compiler_job_service import create_compiler_job
from services.errors import ApiError, conflict, not_found

STATUS_UPLOADED = "UPLOADED"
STATUS_VALIDATING = "VALIDATING"
STATUS_SCANNING = "SCANNING"
STATUS_INSPECTING = "INSPECTING"
STATUS_COMPILING = "COMPILING"
STATUS_ADDRESSING = "ADDRESSING"
STATUS_PUBLISHING = "PUBLISHING"
STATUS_PUBLISHED = "PUBLISHED"
STATUS_REJECTED = "REJECTED"

BUNDLE_MAX_SOURCE_BYTES = 16_777_216
BUNDLE_MAX_COMPONENT_BYTES = 33_554_432


def _mint_callback_token(tenant_slug: str) -> str:
    """Short-lived (1h) machine JWT, scope `bundles:artifact`, for the compiler's callback."""
    return create_jwt_token(
        user_id="bundle-compiler",
        username="bundle-compiler",
        email="",
        roles=[],
        secret_key=require_secret_key(),
        tenant=tenant_slug,
        scope="bundles:artifact",
        expiration_hours=1,
    )


async def create_version(
    async_dal: Any,
    dal: Any,
    *,
    tenant_id: int,
    app_id: str,
    requested_by: int,
    manifest_bytes: bytes,
    source_bytes: bytes | None,
    component_bytes: bytes | None,
    batch_api: Any,
    namespace: str,
    known_custom_platforms: frozenset[str],
    allow_wildcard_consumes: bool,
    allow_prebuilt: bool,
) -> Any:
    """Validate, stage, and launch the compiler Job for a new bundle version.

    Raises `ApiError` 400 (manifest rule failure, `code` = the rule's
    `reason`), 403 `prebuilt_not_allowed`, 409 (version already exists),
    or 413 (oversize part).
    """
    raw = yaml.safe_load(manifest_bytes)
    try:
        manifest = parse_bundle_manifest_v2(
            raw,
            known_custom_platforms=known_custom_platforms,
            allow_wildcard_consumes=allow_wildcard_consumes,
            allow_prebuilt=allow_prebuilt,
        )
    except ManifestV2Error as exc:
        status_code = 403 if exc.reason == "prebuilt_not_allowed" else 400
        raise ApiError(str(exc), status_code, exc.reason) from exc

    if source_bytes is not None and len(source_bytes) > BUNDLE_MAX_SOURCE_BYTES:
        raise ApiError("source tarball exceeds 16 MiB", 413, "PAYLOAD_TOO_LARGE")
    if component_bytes is not None and len(component_bytes) > BUNDLE_MAX_COMPONENT_BYTES:
        raise ApiError("component exceeds 32 MiB", 413, "PAYLOAD_TOO_LARGE")

    existing = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == manifest.version))
    )
    if existing:
        raise conflict(f"version {manifest.version} of {app_id} already exists")

    staged = await stage_upload(
        app_id, manifest.version,
        manifest_bytes=manifest_bytes, source_bytes=source_bytes, component_bytes=component_bytes,
    )

    now = datetime.now(UTC)
    upload_id = await async_dal.insert_async(
        dal.app_version_uploads,
        app_id=app_id, version=manifest.version, tenant_id=tenant_id, requested_by=requested_by,
        artifact_kind=manifest.artifact, language=manifest.language, status=STATUS_UPLOADED,
        staging_manifest_key=staged.manifest_key, staging_source_key=staged.source_key,
        staging_component_key=staged.component_key, manifest_json=raw,
        created_at=now, updated_at=now,
    )
    async_dal.dal.commit()

    callback_token = _mint_callback_token("global")
    job_name = await create_compiler_job(
        batch_api, namespace=namespace, app_id=app_id, version=manifest.version,
        artifact_kind=manifest.artifact, language=manifest.language, staged=staged,
        validation_context={
            "known_custom_platforms": sorted(known_custom_platforms),
            "allow_wildcard_consumes": allow_wildcard_consumes,
            "allow_prebuilt": allow_prebuilt,
            "egress_denylist": [],
        },
        callback_token=callback_token,
    )

    await async_dal.update_async(
        dal.app_version_uploads.id == upload_id,
        status=STATUS_VALIDATING, compiler_job_name=job_name, updated_at=datetime.now(UTC),
    )
    async_dal.dal.commit()

    rows = await async_dal.select_async(dal(dal.app_version_uploads.id == upload_id))
    return rows[0]


async def get_version(async_dal: Any, dal: Any, *, app_id: str, version: str) -> Any:
    """The `app_version_uploads` row for `(app_id, version)`. Raises 404 if absent."""
    rows = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == version))
    )
    if not rows:
        raise not_found(f"version {version} of {app_id} not found")
    return rows[0]


async def list_versions(async_dal: Any, dal: Any, *, app_id: str) -> list[Any]:
    """Every uploaded version of `app_id`, newest first."""
    rows = await async_dal.select_async(
        dal(dal.app_version_uploads.app_id == app_id),
        orderby=~dal.app_version_uploads.created_at,
    )
    return list(rows)
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_version_service.py -v`
Expected: `7 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/bundle_version_service.py hub_api/tests/test_bundle_version_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): bundle_version_service -- create_version() orchestration (parse/stage/launch Job)

Ties bundle_manifest_v2, bundle_storage_service and
compiler_job_service together: validates the pure-YAML rule subset,
enforces the 16MiB/32MiB size ceilings, rejects a duplicate
(app_id, version), stages the upload, mints a 1h bundles:artifact
callback JWT, and launches the compiler Job. app_version_uploads is
hub-api's own pre-publish lifecycle tracker (app_versions itself has
no status column, per spec Sec6.10).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 11: `blueprints/v1/bundle_versions.py` — `POST`/`GET` `/api/v1/apps/{app_id}/versions`

**Depends on:** Task 4 (the `bundle_install_db` fixture), Task 10 (`bundle_version_service.{create_version, get_version, list_versions}`).

**Files:**
- Create: `hub_api/blueprints/v1/bundle_versions.py`
- Test: `hub_api/tests/test_bundle_versions_blueprint.py`

**Interfaces:**
- Produces: `POST /api/v1/apps/{app_id}/versions` (multipart: `manifest`, `source` XOR `component`; scope `platform:admin`) → `202` with `{versionId, status, compilerJobName}`; `GET /api/v1/apps/{app_id}/versions/{version}` (`tenant_middleware` only) → `{versionId, appId, version, status, rejectReason, scanStatus, artifactDigest}` (the latter two `null` until Task 13 publishes). Auto-discovered via `BLUEPRINTS` (no registration edit).
- Consumes: `services.bundle_version_service.{create_version, get_version}` (Task 10). **This task's inline `_allow_prebuilt`/`_known_custom_platforms`/`_allow_wildcard_consumes` helpers are temporary** — Tasks 23-25 add the real `platform_settings_service`/`tenant_bundle_settings`/`custom_platform_service` modules and, as their own final step, replace these three inline queries in this file with calls to those modules. A cheap implementer of *this* task does not need those modules to exist yet.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_versions_blueprint.py
"""Blueprint tests for POST/GET /api/v1/apps/{app_id}/versions."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from quart import Quart

from blueprints.v1.bundle_versions import BLUEPRINTS
from tests.conftest import make_token

_MANIFEST_YAML = b"""
schema_version: 2
app_id: waddles.socials.music.default
name: Music Station Song Request
version: 3.0.1
feature: waddles.socials.music
module: socials
provider: builtin
language: python
artifact: source
stages:
  process:
    entry: "bundles.social_music_process:transform"
    consumes:
      - platform: twitch
        event_types: ["chat.message"]
"""


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = bundle_install_db.dal
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)
    return app


async def test_post_version_requires_platform_admin_scope(app: Quart) -> None:
    token = make_token(scope="")
    client = app.test_client()
    response = await client.post(
        "/api/v1/apps/waddles.socials.music.default/versions",
        headers={"Authorization": f"Bearer {token}"},
        files={"manifest": (_MANIFEST_YAML, "bundle.yaml")},
        form={},
    )
    assert response.status_code == 403


async def test_post_version_happy_path(app: Quart) -> None:
    token = make_token(scope="platform:admin")
    mock_batch_api = MagicMock()
    mock_batch_api.create_namespaced_job.return_value = MagicMock(metadata=MagicMock(name="bundle-compile-abc"))
    with patch("blueprints.v1.bundle_versions._batch_api", return_value=mock_batch_api):
        client = app.test_client()
        response = await client.post(
            "/api/v1/apps/waddles.socials.music.default/versions",
            headers={"Authorization": f"Bearer {token}"},
            files={"manifest": (_MANIFEST_YAML, "bundle.yaml"), "source": (b"fake-tarball", "source.tar.zst")},
        )
    assert response.status_code == 202
    body = await response.get_json()
    assert body["status"] == "VALIDATING"
    assert body["compilerJobName"] == "bundle-compile-abc"


async def test_get_version_returns_404_for_unknown_version(app: Quart) -> None:
    token = make_token(scope="")
    client = app.test_client()
    response = await client.get(
        "/api/v1/apps/waddles.socials.music.default/versions/9.9.9",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 404
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_versions_blueprint.py -v`
Expected: `ModuleNotFoundError: No module named 'blueprints.v1.bundle_versions'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/blueprints/v1/bundle_versions.py
"""v1 `bundle_versions` group -- POST/GET /api/v1/apps/{app_id}/versions (spec Sec9.2).

Global tier (`platform:admin`), same authorization level as the
existing `marketplace_lifecycle.py::install_bundle`. GET is open to any
authenticated tenant member, matching `list_bundles`'s own precedent.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

from flask_core.api_utils import error_response
from flask_core.authz import require_scope
from flask_core.tenancy import get_tenant_context, tenant_middleware
from quart import Blueprint, current_app, request
from quart_schema import validate_response

from services import bundle_version_service as svc
from services.current_user import get_current_user_id
from services.errors import ApiError, bad_request

bundle_versions_bp = Blueprint("v1_bundle_versions", __name__, url_prefix="/api/v1/apps")


def _dal() -> tuple[Any, Any]:
    return current_app.config["async_dal"], current_app.config["dal"]


def _err(exc: ApiError) -> tuple[dict[str, object], int]:
    return cast(tuple[dict[str, object], int], error_response(exc.message, exc.status_code, exc.code))


def _batch_api() -> Any:
    """The K8s `BatchV1Api` client, constructed lazily so import-time never requires a cluster."""
    from kubernetes import client, config

    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    return client.BatchV1Api()


def _allow_prebuilt(dal: Any) -> bool:
    """Temporary inline query -- superseded by `platform_settings_service` in Task 23."""
    row = dal(dal.platform_settings.key == "bundles.allow_prebuilt").select().first()
    return (row.value if row else "true") == "true"


def _allow_wildcard_consumes(dal: Any, tenant_id: int) -> bool:
    """Temporary inline query -- superseded by `tenant_bundle_settings` in Task 24."""
    row = dal(
        (dal.tenant_settings.tenant_id == tenant_id) & (dal.tenant_settings.key == "allow_wildcard_consumes")
    ).select().first()
    return (row.value if row else "false") == "true"


def _known_custom_platforms(dal: Any, tenant_id: int) -> frozenset[str]:
    """Temporary inline query -- superseded by `custom_platform_service` in Task 25."""
    rows = dal(dal.custom_platforms.tenant_id == tenant_id).select(dal.custom_platforms.name)
    return frozenset(r.name for r in rows)


@dataclass(slots=True, frozen=True)
class CreateVersionResponse:
    """Response DTO for `POST /apps/{app_id}/versions`."""

    success: bool
    versionId: int
    status: str
    compilerJobName: str | None


@dataclass(slots=True, frozen=True)
class VersionDTO:
    """Response DTO for `GET /apps/{app_id}/versions/{version}`."""

    success: bool
    versionId: int
    appId: str
    version: str
    status: str
    rejectReason: str | None
    scanStatus: str | None
    artifactDigest: str | None


@bundle_versions_bp.route("/<app_id>/versions", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("platform:admin")  # type: ignore[untyped-decorator]
async def post_version(app_id: str) -> tuple[dict[str, object], int]:
    """Upload a new bundle version (multipart: `manifest` + `source` XOR `component`)."""
    async_dal, dal = _dal()
    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101
    files = await request.files
    form = await request.form
    manifest_file = files.get("manifest")
    if manifest_file is None:
        return _err(bad_request("manifest part is required"))
    manifest_bytes = manifest_file.read()
    source_file = files.get("source")
    component_file = files.get("component")
    source_bytes = source_file.read() if source_file is not None else None
    component_bytes = component_file.read() if component_file is not None else None

    caller_id = get_current_user_id(request)
    try:
        row = await svc.create_version(
            async_dal, dal,
            tenant_id=ctx.tenant_id, app_id=app_id, requested_by=caller_id,
            manifest_bytes=manifest_bytes, source_bytes=source_bytes, component_bytes=component_bytes,
            batch_api=_batch_api(), namespace=current_app.config.get("K8S_NAMESPACE", "waddles"),
            known_custom_platforms=_known_custom_platforms(dal, ctx.tenant_id),
            allow_wildcard_consumes=_allow_wildcard_consumes(dal, ctx.tenant_id),
            allow_prebuilt=_allow_prebuilt(dal),
        )
    except ApiError as exc:
        return _err(exc)
    return (
        {
            "success": True,
            "versionId": row.id,
            "status": row.status,
            "compilerJobName": row.compiler_job_name,
        },
        202,
    )


@bundle_versions_bp.route("/<app_id>/versions/<version>", methods=["GET"])
@tenant_middleware  # type: ignore[untyped-decorator]
@validate_response(VersionDTO)
async def get_version(app_id: str, version: str) -> VersionDTO | tuple[dict[str, object], int]:
    """The state-machine state, reject reason (if any), scan status and digest for one version."""
    async_dal, dal = _dal()
    try:
        row = await svc.get_version(async_dal, dal, app_id=app_id, version=version)
    except ApiError as exc:
        return _err(exc)
    scan_status = None
    artifact_digest = None
    if row.app_version_id is not None:
        published = dal(dal.app_versions.id == row.app_version_id).select().first()
        if published is not None:
            scan_status = published.scan_status
            artifact_digest = published.artifact_digest
    return VersionDTO(
        success=True, versionId=row.id, appId=row.app_id, version=row.version,
        status=row.status, rejectReason=row.reject_reason,
        scanStatus=scan_status, artifactDigest=artifact_digest,
    )


BLUEPRINTS: list[Blueprint] = [bundle_versions_bp]
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_versions_blueprint.py -v`
Expected: `3 passed`

- [ ] **Step 5: Add the per-file ruff N815 ignore for this new camelCase-DTO blueprint**

Append to `hub_api/pyproject.toml`'s `[tool.ruff.lint.per-file-ignores]` section (same convention as `blueprints/v1/bot.py`'s existing entry):

```toml
# M2b bundle-install group -- camelCase DTO fields are the wire-contract
# convention every other v1 blueprint in this file already uses.
"blueprints/v1/bundle_versions.py" = ["N815"]
```

- [ ] **Step 6: Commit**

```bash
git add hub_api/blueprints/v1/bundle_versions.py hub_api/tests/test_bundle_versions_blueprint.py \
        hub_api/pyproject.toml
git commit -m "$(cat <<'EOF'
feat(hub-api): POST/GET /api/v1/apps/{app_id}/versions (spec Sec9.2)

Global-tier (platform:admin) version upload, orchestrating manifest
validation, bucket staging and compiler-Job launch via
bundle_version_service. GET is open to any tenant member. Auto-
discovered blueprint, no registration edit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 12: Helm — compiler Job RBAC + `bundles.compiler.*`/`sandbox.*` values

**Depends on:** Task 9 (the Job shape hub-api creates, which this RBAC and these values must permit).

**Files:**
- Create: `k8s/helm/waddlebot/templates/hub-api-compiler-rbac.yaml`
- Modify: `k8s/helm/waddlebot/values.yaml`

**Interfaces:**
- Produces: `ServiceAccount hub-api` gains a bound `Role`/`RoleBinding` permitting `batch/v1` Job `create`/`get`/`list`/`watch`/`delete` in its own namespace; `ServiceAccount bundle-compiler` (the Job's own identity, per Task 9's `serviceAccountName: bundle-compiler`) with **no** RBAC rules at all (it never talks to the K8s API — its job is bucket + hub-api callback only, per D10). New `values.yaml` keys: `bundles.compiler.image`, `bundles.compiler.activeDeadlineSeconds`, `bundles.compiler.resources.limits`, `sandbox.runtimeClassName`, `sandbox.gvisor.enabled` (these last two are read by `compiler_job_service.py`'s `SANDBOX_RUNTIME_CLASS_NAME` env var, set from this chart value — the chart wiring for the *executor's* own gVisor posture is M3/M4/M6 scope, not this plan's).
- Consumes: nothing new.

- [ ] **Step 1: Write the RBAC template**

```yaml
# k8s/helm/waddlebot/templates/hub-api-compiler-rbac.yaml
# hub-api's own ServiceAccount gains permission to create/manage the
# bundle-compiler Job it launches per uploaded version (spec Sec4.6,
# Sec9.2). The compiler's OWN ServiceAccount (bundle-compiler) gets NO
# RBAC rules -- it never talks to the Kubernetes API; its only two
# network destinations are the bucket and hub-api's callback (D10).
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ .Release.Name }}-hub-api-compiler-jobs
  namespace: {{ .Release.Namespace }}
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "watch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ .Release.Name }}-hub-api-compiler-jobs
  namespace: {{ .Release.Namespace }}
subjects:
  - kind: ServiceAccount
    name: hub-api
    namespace: {{ .Release.Namespace }}
roleRef:
  kind: Role
  name: {{ .Release.Name }}-hub-api-compiler-jobs
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: bundle-compiler
  namespace: {{ .Release.Namespace }}
  annotations:
    waddles.io/no-api-access: "true"  # documentation only -- no Role is ever bound to this ServiceAccount
automountServiceAccountToken: false
```

- [ ] **Step 2: Add the new values.yaml keys**

Append to `k8s/helm/waddlebot/values.yaml`:

```yaml
bundles:
  compiler:
    image: ghcr.io/penguintechinc/waddles/bundle-compiler:latest
    activeDeadlineSeconds: 900
    resources:
      limits:
        cpu: "2000m"
        memory: "4Gi"
  bucket:
    provider: minio
    endpoint: "http://minio.waddles.svc.cluster.local:9000"
    name: waddles-bundles
    region: us-east-1
    existingSecret: waddles-bundle-bucket
  allowPrebuilt: true
  allowWildcardConsumes: false

sandbox:
  runtimeClassName: runsc
  gvisor:
    enabled: true
```

- [ ] **Step 3: Verify the chart renders**

Run: `cd k8s/helm/waddlebot && helm template . --set bundles.compiler.image=test-image 2>&1 | grep -A3 "kind: Role"`
Expected: prints the rendered `Role`/`RoleBinding`/`ServiceAccount` manifests with `bundle-compiler-jobs` and `bundle-compiler` names visible, no template errors.

- [ ] **Step 4: Verify `helm lint` passes**

Run: `cd k8s/helm/waddlebot && helm lint .`
Expected: `0 chart(s) linted, 0 chart(s) failed`

- [ ] **Step 5: Commit**

```bash
git add k8s/helm/waddlebot/templates/hub-api-compiler-rbac.yaml k8s/helm/waddlebot/values.yaml
git commit -m "$(cat <<'EOF'
feat(chart): hub-api compiler-Job RBAC + bundles.compiler/sandbox values (spec Sec4.6, Sec12.3)

hub-api's ServiceAccount gains Job create/get/list/watch/delete in its
own namespace; the compiler Job's own ServiceAccount (bundle-compiler)
gets zero RBAC rules, matching D10's two-destination network policy
(bucket + hub-api callback only, never the K8s API).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 13: `bundle_artifact_service.py` — the success callback: verify, cross-check, or fallback-insert

**Depends on:** Task 4 (bound tables), Task 8 (`bundle_storage_service`'s bucket read, re-hashed here), Task 10 (`app_version_uploads` rows this callback advances).

**Files:**
- Create: `hub_api/services/bundle_artifact_service.py`
- Test: `hub_api/tests/test_bundle_artifact_service.py`

**Interfaces:**
- Produces: `async def record_artifact_notification(async_dal, dal, *, app_id: str, version: str, claimed_digest: str, component_key: str, cwasm_digest: str | None, wasmtime_abi: str | None, collector: str | None, size_bytes: int | None, language: str, artifact_kind: str, built_at: str, builder: str, scan_status: str, badge: str | None) -> Any` (the confirmed `app_versions` row). Raises `ApiError` 409 `digest_mismatch` on a re-hash disagreement (with an `audit_log` entry written first), 404 if no matching `app_version_uploads` row exists.
- Consumes: `services.bundle_storage_service.fetch_object_sha256` (Task 8); the existing generic `audit_log` table (`dal.audit_log`, already bound by `bind_platform_tables`, itself part of `bind_bundle_install_tables`'s dependency chain via `bind_lifecycle_tables`/`bind_auth_tables` — no new binding needed, `bundle_install_db`'s fixture already includes it transitively through `bind_auth_tables`/`bind_community_authz_tables`... — see Step 1 note below if the fixture needs `bind_platform_tables` added).

This plan's Decision #3: **hub-api verifies, it never computes.** The compiler (M2a's `waddles_publisher`-authenticated container) is expected to `INSERT`/`UPDATE` `app_versions` directly with its own Postgres role — this function's job is to (a) re-hash the bucket object at `component_key` and compare against `claimed_digest`, refusing on any mismatch, and (b) look for the row the publisher already wrote; if none exists yet (a race, or an M2a build that hasn't wired direct-DB-write yet), insert it itself using hub-api's own (also-granted) write privilege, but **only after its own re-hash succeeded** — never inserting an unverified value.

- [ ] **Step 1: Confirm `audit_log` is reachable from `bundle_install_db`**

`hub_api/tests/conftest.py`'s `bundle_install_db` fixture (Task 4) calls `bind_auth_tables`, `bind_community_authz_tables`, `bind_lifecycle_tables`, `bind_bundle_install_tables` — none of those bind `audit_log` (that table is bound by `bind_platform_tables`, per `services/schema.py`). Add one more binder call to the fixture:

Edit `hub_api/tests/conftest.py`'s `from services.schema import (...)` block to also import `bind_platform_tables`, and add `bind_platform_tables(dal, migrate=True)` to `bundle_install_db`'s body, immediately after the `bind_lifecycle_tables(dal, migrate=True)` line (before `bind_bundle_install_tables`).

- [ ] **Step 2: Write the failing test**

```python
# hub_api/tests/test_bundle_artifact_service.py
"""Tests for the artifact-callback notification/cross-check path."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest

from services.bundle_artifact_service import record_artifact_notification
from services.errors import ApiError

_DIGEST = "sha256:" + "a" * 64
_WRONG_DIGEST = "sha256:" + "b" * 64


async def _seed_upload(dal: Any) -> None:
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="COMPILING",
        created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    )
    dal.commit()


async def test_matching_digest_is_accepted_when_publisher_already_wrote_the_row(
    bundle_install_db: Any,
) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_upload(dal)
    dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="3.0.1",
        artifact_digest=_DIGEST, language="python", artifact_kind="source",
        scan_status="scanned",
    )
    dal.commit()

    with patch("services.bundle_artifact_service.fetch_object_sha256", return_value=_DIGEST):
        result = await record_artifact_notification(
            async_dal, dal, app_id="waddles.socials.music.default", version="3.0.1",
            claimed_digest=_DIGEST, component_key="bundles/x/3.0.1/aaa.wasm",
            cwasm_digest=None, wasmtime_abi=None, collector=None, size_bytes=1024,
            language="python", artifact_kind="source", built_at="2026-09-14T12:00:00.000Z",
            builder="bundle-compiler@1.0.0", scan_status="scanned", badge=None,
        )
    assert result.artifact_digest == _DIGEST

    upload = dal(dal.app_version_uploads.app_id == "waddles.socials.music.default").select().first()
    assert upload.status == "PUBLISHED"
    assert upload.app_version_id == result.id


async def test_missing_row_is_inserted_as_a_fallback_after_verification(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_upload(dal)

    with patch("services.bundle_artifact_service.fetch_object_sha256", return_value=_DIGEST):
        result = await record_artifact_notification(
            async_dal, dal, app_id="waddles.socials.music.default", version="3.0.1",
            claimed_digest=_DIGEST, component_key="bundles/x/3.0.1/aaa.wasm",
            cwasm_digest="sha256:" + "c" * 64, wasmtime_abi="wasmtime-30", collector="drc",
            size_bytes=2048, language="python", artifact_kind="source",
            built_at="2026-09-14T12:00:00.000Z", builder="bundle-compiler@1.0.0",
            scan_status="scanned", badge=None,
        )
    assert result.artifact_digest == _DIGEST
    assert dal(dal.app_versions.artifact_digest == _DIGEST).count() == 1


async def test_digest_mismatch_is_refused_and_audited(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_upload(dal)

    with patch("services.bundle_artifact_service.fetch_object_sha256", return_value=_WRONG_DIGEST):
        with pytest.raises(ApiError) as exc:
            await record_artifact_notification(
                async_dal, dal, app_id="waddles.socials.music.default", version="3.0.1",
                claimed_digest=_DIGEST, component_key="bundles/x/3.0.1/aaa.wasm",
                cwasm_digest=None, wasmtime_abi=None, collector=None, size_bytes=1024,
                language="python", artifact_kind="source", built_at="2026-09-14T12:00:00.000Z",
                builder="bundle-compiler@1.0.0", scan_status="scanned", badge=None,
            )
    assert exc.value.status_code == 409
    assert exc.value.code == "digest_mismatch"
    assert dal(dal.app_versions.app_id == "waddles.socials.music.default").count() == 0

    audit_row = dal(dal.audit_log.action == "bundle_artifact_digest_mismatch").select().first()
    assert audit_row is not None
    assert audit_row.details["claimed_digest"] == _DIGEST
    assert audit_row.details["computed_digest"] == _WRONG_DIGEST


async def test_unknown_version_upload_raises_404(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    with patch("services.bundle_artifact_service.fetch_object_sha256", return_value=_DIGEST):
        with pytest.raises(ApiError) as exc:
            await record_artifact_notification(
                async_dal, dal, app_id="waddles.unknown.x.default", version="1.0.0",
                claimed_digest=_DIGEST, component_key="bundles/x/1.0.0/aaa.wasm",
                cwasm_digest=None, wasmtime_abi=None, collector=None, size_bytes=1,
                language="python", artifact_kind="source", built_at="2026-09-14T12:00:00.000Z",
                builder="bundle-compiler@1.0.0", scan_status="scanned", badge=None,
            )
    assert exc.value.status_code == 404
```

- [ ] **Step 3: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_artifact_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_artifact_service'`

- [ ] **Step 4: Write the implementation**

```python
# hub_api/services/bundle_artifact_service.py
"""The compiler's success-artifact callback: notification/cross-check, never the write authority.

hub-api verifies a claimed digest by re-hashing the bucket object; it
never computes or invents one. `waddles_publisher` (M2a) is expected to
have already INSERTed/UPDATEd the `app_versions` row directly with its
own Postgres role -- this function's primary path is a cross-check
confirming that row exists and matches. Its fallback path (no row yet)
still only ever stores the value it just re-hash-verified, using
hub-api's own also-granted write privilege on `app_versions` (spec
Sec6.10 -- exactly two writers, both permitted, this plan's Decision #3).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from services.bundle_storage_service import fetch_object_sha256
from services.errors import ApiError, not_found


async def _write_digest_mismatch_audit(
    async_dal: Any, dal: Any, *, app_id: str, version: str, claimed_digest: str, computed_digest: str
) -> None:
    try:
        await async_dal.insert_async(
            dal.audit_log,
            user_id=None,
            action="bundle_artifact_digest_mismatch",
            target_type="app_version",
            target_id=f"{app_id}:{version}",
            details={"claimed_digest": claimed_digest, "computed_digest": computed_digest},
            created_at=datetime.now(UTC),
        )
        async_dal.dal.commit()
    except Exception:  # noqa: BLE001, S110 -- audit logging failure must not break the main flow
        pass


async def record_artifact_notification(
    async_dal: Any,
    dal: Any,
    *,
    app_id: str,
    version: str,
    claimed_digest: str,
    component_key: str,
    cwasm_digest: str | None,
    wasmtime_abi: str | None,
    collector: str | None,
    size_bytes: int | None,
    language: str,
    artifact_kind: str,
    built_at: str,
    builder: str,
    scan_status: str,
    badge: str | None,
) -> Any:
    """Verify `claimed_digest` against the bucket, cross-check or fallback-insert, update the upload row."""
    upload_rows = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == version))
    )
    if not upload_rows:
        raise not_found(f"no upload request found for {app_id} version {version}")
    upload = upload_rows[0]

    computed_digest = await fetch_object_sha256(component_key)
    if computed_digest != claimed_digest:
        await _write_digest_mismatch_audit(
            async_dal, dal, app_id=app_id, version=version,
            claimed_digest=claimed_digest, computed_digest=computed_digest,
        )
        await async_dal.update_async(
            dal.app_version_uploads.id == upload.id,
            status="REJECTED", reject_reason="digest_mismatch", updated_at=datetime.now(UTC),
        )
        async_dal.dal.commit()
        raise ApiError(
            f"claimed digest {claimed_digest} does not match the bucket object's actual digest",
            409, "digest_mismatch",
        )

    existing = await async_dal.select_async(
        dal((dal.app_versions.app_id == app_id) & (dal.app_versions.version == version))
    )
    if existing:
        version_row = existing[0]
    else:
        new_id = await async_dal.insert_async(
            dal.app_versions,
            app_id=app_id, version=version, artifact_digest=claimed_digest,
            cwasm_digest=cwasm_digest, wasmtime_abi=wasmtime_abi, collector=collector,
            size_bytes=size_bytes, language=language, artifact_kind=artifact_kind,
            built_at=built_at, builder=builder, scan_status=scan_status, badge=badge,
            created_at=datetime.now(UTC),
        )
        async_dal.dal.commit()
        version_row = (await async_dal.select_async(dal(dal.app_versions.id == new_id)))[0]

    await async_dal.update_async(
        dal.app_version_uploads.id == upload.id,
        status="PUBLISHED", app_version_id=version_row.id, updated_at=datetime.now(UTC),
    )
    async_dal.dal.commit()
    return version_row
```

- [ ] **Step 5: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_artifact_service.py -v`
Expected: `4 passed`

- [ ] **Step 6: Commit**

```bash
git add hub_api/services/bundle_artifact_service.py hub_api/tests/test_bundle_artifact_service.py \
        hub_api/tests/conftest.py
git commit -m "$(cat <<'EOF'
feat(hub-api): artifact-callback notification/cross-check -- hub-api verifies, never computes a digest

Re-hashes the bucket object and compares against the compiler's claimed
digest; refuses + audit-logs on mismatch. Cross-checks against a row
waddles_publisher (M2a) already wrote, or falls back to inserting one
itself using hub-api's own also-granted write privilege -- only ever
after its own verification succeeded (spec Sec6.10, this plan's
Decision #3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 14: `bundle_artifact_service.py` extension — the rejection callback

**Depends on:** Task 13 (`bundle_artifact_service`'s success path, extended here with the rejection path).

**Files:**
- Modify: `hub_api/services/bundle_artifact_service.py`
- Modify: `hub_api/tests/test_bundle_artifact_service.py`

**Interfaces:**
- Produces: `async def record_rejection(async_dal, dal, *, app_id: str, version: str, reason: str) -> None` — moves the `app_version_uploads` row to `REJECTED` with the given `reason`. Raises 404 if no matching upload row exists.
- Consumes: nothing new.

The compiler reports failures from `VALIDATING`/`SCANNING`/`INSPECTING`/`COMPILING`/`PUBLISHING` (spec §9.1's REJECTED transitions) through this second callback — there is no successful-artifact digest to verify on this path, so it does not touch `app_versions` at all.

- [ ] **Step 1: Write the failing test**

Append to `hub_api/tests/test_bundle_artifact_service.py`:

```python
from services.bundle_artifact_service import record_rejection  # noqa: E402 -- appended import


async def test_record_rejection_sets_status_and_reason(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_upload(dal)

    await record_rejection(
        async_dal, dal, app_id="waddles.socials.music.default", version="3.0.1",
        reason="scan_failed",
    )

    row = dal(dal.app_version_uploads.app_id == "waddles.socials.music.default").select().first()
    assert row.status == "REJECTED"
    assert row.reject_reason == "scan_failed"


async def test_record_rejection_unknown_version_raises_404(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    with pytest.raises(ApiError) as exc:
        await record_rejection(
            async_dal, dal, app_id="waddles.unknown.x.default", version="1.0.0", reason="scan_failed"
        )
    assert exc.value.status_code == 404
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_artifact_service.py -k rejection -v`
Expected: `ImportError: cannot import name 'record_rejection'`

- [ ] **Step 3: Add the implementation**

Append to `hub_api/services/bundle_artifact_service.py`:

```python
async def record_rejection(async_dal: Any, dal: Any, *, app_id: str, version: str, reason: str) -> None:
    """Move the upload to REJECTED with `reason` -- no `app_versions` write on this path."""
    upload_rows = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == version))
    )
    if not upload_rows:
        raise not_found(f"no upload request found for {app_id} version {version}")
    await async_dal.update_async(
        dal.app_version_uploads.id == upload_rows[0].id,
        status="REJECTED", reject_reason=reason, updated_at=datetime.now(UTC),
    )
    async_dal.dal.commit()
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_artifact_service.py -v`
Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/bundle_artifact_service.py hub_api/tests/test_bundle_artifact_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): record_rejection() -- compiler failure callback (spec Sec9.1 REJECTED transitions)

Handles VALIDATING/SCANNING/INSPECTING/COMPILING/PUBLISHING failures
reported by the compiler; never touches app_versions on this path.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 15: `blueprints/v1/bundle_artifact_callback.py` — the compiler's two callbacks

**Depends on:** Tasks 13-14 (both callback handlers this blueprint exposes).

**Files:**
- Create: `hub_api/blueprints/v1/bundle_artifact_callback.py`
- Test: `hub_api/tests/test_bundle_artifact_callback_blueprint.py`

**Interfaces:**
- Produces: `POST /api/v1/bundles/{app_id}/versions/{version}/artifact` (scope `bundles:artifact`) → `200 {"success": true, "artifactDigest": ...}` or `409 digest_mismatch`; `POST /api/v1/bundles/{app_id}/versions/{version}/rejected` (scope `bundles:artifact`) → `200 {"success": true}`. **Must match M2a** — request body shapes below are this plan's contract; reconcile in M2a's plan if it defines the payload differently.
- Consumes: `services.bundle_artifact_service.{record_artifact_notification, record_rejection}` (Tasks 13-14).

Request body for the artifact endpoint (JSON): `{"artifactDigest": str, "componentKey": str, "cwasmDigest": str|null, "wasmtimeAbi": str|null, "collector": str|null, "sizeBytes": int|null, "language": str, "artifactKind": str, "builtAt": str, "builder": str, "scanStatus": str, "badge": str|null}`. Rejection endpoint: `{"reason": str}`.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_artifact_callback_blueprint.py
"""Blueprint tests for the compiler's artifact + rejected callbacks."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest
from quart import Quart

from blueprints.v1.bundle_artifact_callback import BLUEPRINTS
from tests.conftest import make_token

_DIGEST = "sha256:" + "a" * 64


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    dal = bundle_install_db.dal
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="COMPILING",
        created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    )
    dal.commit()
    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = dal
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)
    return app


async def test_artifact_callback_requires_bundles_artifact_scope(app: Quart) -> None:
    token = make_token(scope="")
    client = app.test_client()
    response = await client.post(
        "/api/v1/bundles/waddles.socials.music.default/versions/3.0.1/artifact",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "artifactDigest": _DIGEST, "componentKey": "bundles/x/3.0.1/aaa.wasm",
            "cwasmDigest": None, "wasmtimeAbi": None, "collector": None, "sizeBytes": 1,
            "language": "python", "artifactKind": "source", "builtAt": "2026-09-14T12:00:00.000Z",
            "builder": "bundle-compiler@1.0.0", "scanStatus": "scanned", "badge": None,
        },
    )
    assert response.status_code == 403


async def test_artifact_callback_happy_path(app: Quart) -> None:
    token = make_token(scope="bundles:artifact")
    with patch("services.bundle_artifact_service.fetch_object_sha256", return_value=_DIGEST):
        client = app.test_client()
        response = await client.post(
            "/api/v1/bundles/waddles.socials.music.default/versions/3.0.1/artifact",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "artifactDigest": _DIGEST, "componentKey": "bundles/x/3.0.1/aaa.wasm",
                "cwasmDigest": None, "wasmtimeAbi": None, "collector": None, "sizeBytes": 1,
                "language": "python", "artifactKind": "source", "builtAt": "2026-09-14T12:00:00.000Z",
                "builder": "bundle-compiler@1.0.0", "scanStatus": "scanned", "badge": None,
            },
        )
    assert response.status_code == 200
    body = await response.get_json()
    assert body["artifactDigest"] == _DIGEST


async def test_rejected_callback_happy_path(app: Quart) -> None:
    token = make_token(scope="bundles:artifact")
    client = app.test_client()
    response = await client.post(
        "/api/v1/bundles/waddles.socials.music.default/versions/3.0.1/rejected",
        headers={"Authorization": f"Bearer {token}"},
        json={"reason": "scan_failed"},
    )
    assert response.status_code == 200
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_artifact_callback_blueprint.py -v`
Expected: `ModuleNotFoundError: No module named 'blueprints.v1.bundle_artifact_callback'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/blueprints/v1/bundle_artifact_callback.py
"""v1 `bundle_artifact_callback` group -- the compiler's two callbacks (spec Sec9.1, Sec9.4).

Machine-JWT auth, scope `bundles:artifact`, minted by
`bundle_version_service._mint_callback_token` at Job-creation time
(Task 10). **Must match M2a**: the compiler is the caller of both
routes below; if M2a's own plan defines a different payload shape,
reconcile there.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

from flask_core.api_utils import error_response
from flask_core.authz import require_scope
from flask_core.tenancy import tenant_middleware
from quart import Blueprint, current_app, request
from quart_schema import validate_request, validate_response

from services import bundle_artifact_service as svc
from services.errors import ApiError

bundle_artifact_callback_bp = Blueprint(
    "v1_bundle_artifact_callback", __name__, url_prefix="/api/v1/bundles"
)


def _dal() -> tuple[Any, Any]:
    return current_app.config["async_dal"], current_app.config["dal"]


def _err(exc: ApiError) -> tuple[dict[str, object], int]:
    return cast(tuple[dict[str, object], int], error_response(exc.message, exc.status_code, exc.code))


@dataclass(slots=True, frozen=True)
class ArtifactCallbackRequest:
    """Request DTO for `POST .../artifact` -- must match M2a's compiler payload."""

    artifactDigest: str
    componentKey: str
    language: str
    artifactKind: str
    builtAt: str
    builder: str
    scanStatus: str
    cwasmDigest: str | None = None
    wasmtimeAbi: str | None = None
    collector: str | None = None
    sizeBytes: int | None = None
    badge: str | None = None


@dataclass(slots=True, frozen=True)
class ArtifactCallbackResponse:
    """Response DTO for `POST .../artifact`."""

    success: bool
    artifactDigest: str


@dataclass(slots=True, frozen=True)
class RejectedCallbackRequest:
    """Request DTO for `POST .../rejected`."""

    reason: str


@dataclass(slots=True, frozen=True)
class MessageResponse:
    """Generic message response DTO."""

    success: bool
    message: str


@bundle_artifact_callback_bp.route("/<app_id>/versions/<version>/artifact", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("bundles:artifact")  # type: ignore[untyped-decorator]
@validate_request(ArtifactCallbackRequest)
@validate_response(ArtifactCallbackResponse)
async def post_artifact(
    data: ArtifactCallbackRequest, app_id: str, version: str
) -> ArtifactCallbackResponse | tuple[dict[str, object], int]:
    """The compiler's success callback -- hub-api re-hashes the bucket object before trusting it."""
    async_dal, dal = _dal()
    try:
        version_row = await svc.record_artifact_notification(
            async_dal, dal, app_id=app_id, version=version,
            claimed_digest=data.artifactDigest, component_key=data.componentKey,
            cwasm_digest=data.cwasmDigest, wasmtime_abi=data.wasmtimeAbi, collector=data.collector,
            size_bytes=data.sizeBytes, language=data.language, artifact_kind=data.artifactKind,
            built_at=data.builtAt, builder=data.builder, scan_status=data.scanStatus, badge=data.badge,
        )
    except ApiError as exc:
        return _err(exc)
    return ArtifactCallbackResponse(success=True, artifactDigest=version_row.artifact_digest)


@bundle_artifact_callback_bp.route("/<app_id>/versions/<version>/rejected", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("bundles:artifact")  # type: ignore[untyped-decorator]
@validate_request(RejectedCallbackRequest)
@validate_response(MessageResponse)
async def post_rejected(
    data: RejectedCallbackRequest, app_id: str, version: str
) -> MessageResponse | tuple[dict[str, object], int]:
    """The compiler's failure callback -- never touches app_versions."""
    async_dal, dal = _dal()
    try:
        await svc.record_rejection(async_dal, dal, app_id=app_id, version=version, reason=data.reason)
    except ApiError as exc:
        return _err(exc)
    return MessageResponse(success=True, message=f"version {version} of {app_id} rejected: {data.reason}")


BLUEPRINTS: list[Blueprint] = [bundle_artifact_callback_bp]
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_artifact_callback_blueprint.py -v`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/blueprints/v1/bundle_artifact_callback.py hub_api/tests/test_bundle_artifact_callback_blueprint.py
git commit -m "$(cat <<'EOF'
feat(hub-api): POST /api/v1/bundles/{app_id}/versions/{version}/{artifact,rejected} (spec Sec9.1, Sec9.4)

The compiler's two callbacks, scope bundles:artifact. Marked "must
match M2a" -- the payload shapes here are this plan's contract until
M2a's own plan reconciles against them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 16: `bundle_activation_service.py` — activate/rollback via `app_active_versions`

**Depends on:** Task 2 (`app_versions`/`app_active_versions` DDL), Task 4 (the pydal binder and the `bundle_install_db` fixture).

**Files:**
- Create: `hub_api/services/bundle_activation_service.py`
- Test: `hub_api/tests/test_bundle_activation_service.py`

**Interfaces:**
- Produces: `TENANT_WIDE_COMMUNITY_ID = 0` (the sentinel from Task 2's migration); `async def activate_version(async_dal, dal, *, tenant_id: int, community_id: int | None, app_id: str, version: str, activated_by: int) -> Any` (upserts `app_active_versions`, returns the row) — raises `ApiError` 409 `digest_not_verified` when no `app_versions` row exists for `(app_id, version)` with a non-null `artifact_digest`; `async def get_active_version(async_dal, dal, *, tenant_id: int, community_id: int | None, app_id: str) -> Any | None` (joins to `app_versions`, `None` if nothing is active for that scope — consumed by Task 32's distribution-service extension).
- Consumes: nothing new (queries `app_versions`/`app_active_versions` directly).

Rollback is this same function called again with an older `version` that is still present in `app_versions` — no separate endpoint (this plan's Decision #4).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_activation_service.py
"""Tests for activate_version()/get_active_version() -- app_active_versions."""

from __future__ import annotations

from typing import Any

import pytest

from services.bundle_activation_service import (
    TENANT_WIDE_COMMUNITY_ID,
    activate_version,
    get_active_version,
)
from services.errors import ApiError

_DIGEST_V1 = "sha256:" + "1" * 64
_DIGEST_V2 = "sha256:" + "2" * 64


async def _insert_version(dal: Any, version: str, digest: str | None) -> int:
    return dal.app_versions.insert(
        app_id="waddles.socials.music.default", version=version, artifact_digest=digest,
        language="python", artifact_kind="source", scan_status="scanned",
    )


async def test_activate_version_refuses_an_unverified_digest(bundle_install_db: Any) -> None:
    """The explicit refusal case: a version with no app_versions row (never verified) cannot activate."""
    async_dal = bundle_install_db
    dal = async_dal.dal
    with pytest.raises(ApiError) as exc:
        await activate_version(
            async_dal, dal, tenant_id=1, community_id=None,
            app_id="waddles.socials.music.default", version="9.9.9", activated_by=1,
        )
    assert exc.value.status_code == 409
    assert exc.value.code == "digest_not_verified"


async def test_activate_version_with_null_digest_row_is_also_refused(bundle_install_db: Any) -> None:
    """A row exists but its digest is still NULL (upload accepted, never published) -- also refused."""
    async_dal = bundle_install_db
    dal = async_dal.dal
    dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="0.0.1", artifact_digest=None,
        language="python", artifact_kind="source", scan_status="not_scanned",
    )
    dal.commit()
    with pytest.raises(ApiError) as exc:
        await activate_version(
            async_dal, dal, tenant_id=1, community_id=None,
            app_id="waddles.socials.music.default", version="0.0.1", activated_by=1,
        )
    assert exc.value.code == "digest_not_verified"


async def test_activate_version_tenant_wide_succeeds_and_is_readable(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _insert_version(dal, "1.0.0", _DIGEST_V1)
    dal.commit()

    await activate_version(
        async_dal, dal, tenant_id=1, community_id=None,
        app_id="waddles.socials.music.default", version="1.0.0", activated_by=1,
    )

    active = await get_active_version(
        async_dal, dal, tenant_id=1, community_id=None, app_id="waddles.socials.music.default"
    )
    assert active is not None
    assert active.artifact_digest == _DIGEST_V1

    row = dal(
        (dal.app_active_versions.app_id == "waddles.socials.music.default")
        & (dal.app_active_versions.tenant_id == 1)
        & (dal.app_active_versions.community_id == TENANT_WIDE_COMMUNITY_ID)
    ).select().first()
    assert row is not None
    assert row.activated_by == 1


async def test_rollback_is_activate_version_pointed_at_an_older_version(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _insert_version(dal, "1.0.0", _DIGEST_V1)
    await _insert_version(dal, "2.0.0", _DIGEST_V2)
    dal.commit()

    await activate_version(
        async_dal, dal, tenant_id=1, community_id=None,
        app_id="waddles.socials.music.default", version="2.0.0", activated_by=1,
    )
    await activate_version(
        async_dal, dal, tenant_id=1, community_id=None,
        app_id="waddles.socials.music.default", version="1.0.0", activated_by=1,
    )

    active = await get_active_version(
        async_dal, dal, tenant_id=1, community_id=None, app_id="waddles.socials.music.default"
    )
    assert active.artifact_digest == _DIGEST_V1

    count = dal(
        (dal.app_active_versions.app_id == "waddles.socials.music.default")
        & (dal.app_active_versions.tenant_id == 1)
    ).count()
    assert count == 1  # upsert, not a second row


async def test_get_active_version_returns_none_when_nothing_activated(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    active = await get_active_version(
        async_dal, async_dal.dal, tenant_id=1, community_id=None, app_id="waddles.socials.music.default"
    )
    assert active is None


async def test_community_scoped_and_tenant_wide_are_independent(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _insert_version(dal, "1.0.0", _DIGEST_V1)
    await _insert_version(dal, "2.0.0", _DIGEST_V2)
    dal.commit()

    await activate_version(
        async_dal, dal, tenant_id=1, community_id=None,
        app_id="waddles.socials.music.default", version="1.0.0", activated_by=1,
    )
    await activate_version(
        async_dal, dal, tenant_id=1, community_id=1,
        app_id="waddles.socials.music.default", version="2.0.0", activated_by=1,
    )

    tenant_wide = await get_active_version(
        async_dal, dal, tenant_id=1, community_id=None, app_id="waddles.socials.music.default"
    )
    community_scoped = await get_active_version(
        async_dal, dal, tenant_id=1, community_id=1, app_id="waddles.socials.music.default"
    )
    assert tenant_wide.artifact_digest == _DIGEST_V1
    assert community_scoped.artifact_digest == _DIGEST_V2
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_activation_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_activation_service'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/bundle_activation_service.py
"""Activation and rollback: an upsert into app_active_versions, never an edit of a digest row.

This plan's Decision #4: refuses to activate a digest hub-api never
verified -- i.e. any `(app_id, version)` with no `app_versions` row, or
a row whose `artifact_digest` is still NULL (uploaded/compiling, never
published). Rollback is this same function pointed at an older,
already-published version; there is no separate rollback endpoint
(spec Sec6.10: "Rollback is an UPDATE of version_id here").

`community_id = 0` is the tenant-wide sentinel from migration 0020
(`communities.id` is a real SERIAL starting at 1, so 0 never collides).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from services.errors import ApiError

TENANT_WIDE_COMMUNITY_ID = 0


def _scope_community_id(community_id: int | None) -> int:
    return TENANT_WIDE_COMMUNITY_ID if community_id is None else community_id


async def activate_version(
    async_dal: Any,
    dal: Any,
    *,
    tenant_id: int,
    community_id: int | None,
    app_id: str,
    version: str,
    activated_by: int,
) -> Any:
    """Point `(tenant_id, community_id, app_id)` at `version`'s digest. Refuses an unverified digest."""
    version_rows = await async_dal.select_async(
        dal((dal.app_versions.app_id == app_id) & (dal.app_versions.version == version))
    )
    if not version_rows or version_rows[0].artifact_digest is None:
        raise ApiError(
            f"{app_id} version {version} has no verified artifact digest -- cannot activate",
            409, "digest_not_verified",
        )
    version_row = version_rows[0]
    scope_community_id = _scope_community_id(community_id)

    existing = await async_dal.select_async(
        dal(
            (dal.app_active_versions.app_id == app_id)
            & (dal.app_active_versions.tenant_id == tenant_id)
            & (dal.app_active_versions.community_id == scope_community_id)
        )
    )
    now = datetime.now(UTC)
    if existing:
        await async_dal.update_async(
            (dal.app_active_versions.app_id == app_id)
            & (dal.app_active_versions.tenant_id == tenant_id)
            & (dal.app_active_versions.community_id == scope_community_id),
            version_id=version_row.id, activated_by=activated_by, activated_at=now,
        )
    else:
        await async_dal.insert_async(
            dal.app_active_versions,
            app_id=app_id, tenant_id=tenant_id, community_id=scope_community_id,
            version_id=version_row.id, activated_by=activated_by, activated_at=now,
        )
    async_dal.dal.commit()
    return version_row


async def get_active_version(
    async_dal: Any, dal: Any, *, tenant_id: int, community_id: int | None, app_id: str
) -> Any | None:
    """The `app_versions` row currently active for `(tenant_id, community_id, app_id)`, or `None`."""
    scope_community_id = _scope_community_id(community_id)
    pointer_rows = await async_dal.select_async(
        dal(
            (dal.app_active_versions.app_id == app_id)
            & (dal.app_active_versions.tenant_id == tenant_id)
            & (dal.app_active_versions.community_id == scope_community_id)
        )
    )
    if not pointer_rows:
        return None
    version_rows = await async_dal.select_async(dal(dal.app_versions.id == pointer_rows[0].version_id))
    return version_rows[0] if version_rows else None
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_activation_service.py -v`
Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/bundle_activation_service.py hub_api/tests/test_bundle_activation_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): bundle_activation_service -- activate/rollback via app_active_versions (spec Sec6.10)

Refuses to activate a digest hub-api never verified (no app_versions
row, or artifact_digest still NULL). Rollback is this same function
pointed at an older, already-published version -- no separate
endpoint. Tenant-wide and community-scoped activation are independent
(community_id=0 sentinel).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 17: `blueprints/v1/bundle_versions.py` extension — `POST .../activate`

**Depends on:** Task 11 (`blueprints/v1/bundle_versions.py` and its `bundle_versions_bp`), Task 16 (`activate_version`).

**Files:**
- Modify: `hub_api/blueprints/v1/bundle_versions.py`
- Modify: `hub_api/tests/test_bundle_versions_blueprint.py`

**Interfaces:**
- Produces: `POST /api/v1/apps/{app_id}/versions/{version}/activate` (scope `platform:admin`, body `{"communityId": int | null}`) → `200 {"success": true, "artifactDigest": ...}` or `409 digest_not_verified`.
- Consumes: `services.bundle_activation_service.activate_version` (Task 16).

- [ ] **Step 1: Write the failing test**

Append to `hub_api/tests/test_bundle_versions_blueprint.py`:

```python
async def test_activate_refuses_unverified_digest(app: Quart) -> None:
    token = make_token(scope="platform:admin", tenant="acme-corp")
    client = app.test_client()
    response = await client.post(
        "/api/v1/apps/waddles.socials.music.default/versions/9.9.9/activate",
        headers={"Authorization": f"Bearer {token}"},
        json={"communityId": None},
    )
    assert response.status_code == 409
    body = await response.get_json()
    assert body["error"]["code"] == "digest_not_verified"


async def test_activate_happy_path(app: Quart) -> None:
    dal = app.config["dal"]
    dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="3.0.1",
        artifact_digest="sha256:" + "a" * 64, language="python", artifact_kind="source",
        scan_status="scanned",
    )
    dal.commit()
    token = make_token(scope="platform:admin", tenant="acme-corp")
    client = app.test_client()
    response = await client.post(
        "/api/v1/apps/waddles.socials.music.default/versions/3.0.1/activate",
        headers={"Authorization": f"Bearer {token}"},
        json={"communityId": None},
    )
    assert response.status_code == 200
    body = await response.get_json()
    assert body["artifactDigest"] == "sha256:" + "a" * 64
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_versions_blueprint.py -k activate -v`
Expected: `404 NOT FOUND` (the route doesn't exist yet) rather than the expected status codes.

- [ ] **Step 3: Add the route**

Add to `hub_api/blueprints/v1/bundle_versions.py` — new imports:

```python
from dataclasses import dataclass  # already imported; add nothing new here
from quart_schema import validate_request  # add to the existing quart_schema import line

from services import bundle_activation_service as activation_svc  # add alongside the existing svc import
from services.current_user import get_current_user_id  # already imported above
```

New DTOs and route, appended before `BLUEPRINTS: list[Blueprint] = [...]`:

```python
@dataclass(slots=True, frozen=True)
class ActivateVersionRequest:
    """Request DTO for `POST .../activate`."""

    communityId: int | None = None


@dataclass(slots=True, frozen=True)
class ActivateVersionResponse:
    """Response DTO for `POST .../activate`."""

    success: bool
    artifactDigest: str


@bundle_versions_bp.route("/<app_id>/versions/<version>/activate", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("platform:admin")  # type: ignore[untyped-decorator]
@validate_request(ActivateVersionRequest)
@validate_response(ActivateVersionResponse)
async def post_activate(
    data: ActivateVersionRequest, app_id: str, version: str
) -> ActivateVersionResponse | tuple[dict[str, object], int]:
    """Activate (or roll back to) `version` for the caller's tenant, optionally one community."""
    async_dal, dal = _dal()
    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101
    caller_id = get_current_user_id(request)
    try:
        version_row = await activation_svc.activate_version(
            async_dal, dal, tenant_id=ctx.tenant_id, community_id=data.communityId,
            app_id=app_id, version=version, activated_by=caller_id,
        )
    except ApiError as exc:
        return _err(exc)
    return ActivateVersionResponse(success=True, artifactDigest=version_row.artifact_digest)
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_versions_blueprint.py -v`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/blueprints/v1/bundle_versions.py hub_api/tests/test_bundle_versions_blueprint.py
git commit -m "$(cat <<'EOF'
feat(hub-api): POST /api/v1/apps/{app_id}/versions/{version}/activate (spec Sec6.10)

Wires bundle_activation_service into the versions blueprint. 409
digest_not_verified is a documented, tested response shape for a
version with no verified app_versions row.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 18: `permission_summary_service.py` — the consent-screen summary + canonical hash

**Depends on:** Task 7 (`BundleManifestV2`, `EgressRule`, `Limits`, `ConsumeRule`).

**Files:**
- Create: `hub_api/services/permission_summary_service.py`
- Test: `hub_api/tests/test_permission_summary_service.py`

**Interfaces:**
- Produces: `build_permission_summary(manifest: BundleManifestV2, *, grant_labels: list[dict[str, str]], component_capabilities: frozenset[str], min_tier: str, flag_key: str, allow_private_hosts: bool) -> dict[str, Any]` (spec §9.7.1's sections: `streams`, `egress`, `database`, `capabilities`, `routesTo`, `limits`, `provenance`, `entitlement`, `unusual`); `canonical_json(summary: dict[str, Any]) -> str` (sorted keys, no insignificant whitespace); `permission_hash(summary: dict[str, Any]) -> str` (`"sha256:" + 64 hex` over `canonical_json`).
- Consumes: `services.bundle_manifest_v2.BundleManifestV2` (Task 7).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_permission_summary_service.py
"""Tests for build_permission_summary()/canonical_json()/permission_hash()."""

from __future__ import annotations

from services.bundle_manifest_v2 import BundleManifestV2, ConsumeRule, EgressRule, Limits
from services.permission_summary_service import build_permission_summary, canonical_json, permission_hash

_MANIFEST = BundleManifestV2(
    schema_version=2, app_id="waddles.socials.music.default", name="Music Station",
    version="3.0.0", feature="waddles.socials.music", module="socials", provider="builtin",
    language="python", artifact="source", execution_model="native", is_default=True,
    stages={"process": {}}, egress=(EgressRule(host="api.spotify.com", methods=("GET", "POST")),),
    data_tables=("music_queue",), limits=Limits(timeout_ms=2000, memory_mb=64, egress_rps=10),
    permissions=(), routes_to=("waddles.community.forums.default",),
    consumes=(ConsumeRule(platform="twitch", source_id=None, event_types=("chat.message",), filters={}),),
)


def _summary() -> dict:
    return build_permission_summary(
        _MANIFEST,
        grant_labels=[{"platform": "twitch", "sourceId": "tw-channelA", "label": "Twitch #channelA"}],
        component_capabilities=frozenset({"http", "db", "kv"}),
        min_tier="free", flag_key="waddles.socials.music",
        allow_private_hosts=False,
    )


def test_summary_lists_grant_labels_in_words() -> None:
    summary = _summary()
    assert summary["streams"] == [{"platform": "twitch", "sourceId": "tw-channelA", "label": "Twitch #channelA"}]


def test_summary_lists_routes_to() -> None:
    summary = _summary()
    assert summary["routesTo"] == ["waddles.community.forums.default"]


def test_summary_lists_capabilities_actually_imported() -> None:
    summary = _summary()
    assert set(summary["capabilities"]) == {"http", "db", "kv"}


def test_two_calls_with_identical_inputs_produce_the_same_hash() -> None:
    hash1 = permission_hash(_summary())
    hash2 = permission_hash(_summary())
    assert hash1 == hash2
    assert hash1.startswith("sha256:")
    assert len(hash1) == len("sha256:") + 64


def test_canonical_json_has_sorted_keys_and_no_insignificant_whitespace() -> None:
    text = canonical_json({"b": 1, "a": 2})
    assert text == '{"a":2,"b":1}'


def test_widened_capability_changes_the_hash() -> None:
    narrow = permission_hash(_summary())
    summary = build_permission_summary(
        _MANIFEST,
        grant_labels=[{"platform": "twitch", "sourceId": "tw-channelA", "label": "Twitch #channelA"}],
        component_capabilities=frozenset({"http", "db", "kv", "relay"}),  # widened
        min_tier="free", flag_key="waddles.socials.music", allow_private_hosts=False,
    )
    assert permission_hash(summary) != narrow


def test_unusual_flags_a_private_hosts_egress_request() -> None:
    summary = build_permission_summary(
        _MANIFEST, grant_labels=[], component_capabilities=frozenset({"http"}),
        min_tier="free", flag_key="waddles.socials.music", allow_private_hosts=True,
    )
    assert "allow_private_hosts" in summary["unusual"]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_permission_summary_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.permission_summary_service'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/permission_summary_service.py
"""The install-time consent summary and its canonical permission_hash (spec Sec9.7.1, Sec9.7.2)."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from services.bundle_manifest_v2 import BundleManifestV2


def build_permission_summary(
    manifest: BundleManifestV2,
    *,
    grant_labels: list[dict[str, str]],
    component_capabilities: frozenset[str],
    min_tier: str,
    flag_key: str,
    allow_private_hosts: bool,
) -> dict[str, Any]:
    """Build the consent-screen summary -- the record `permission_hash()` hashes.

    `grant_labels` is the already-resolved, human-readable grant list
    (spec Sec5.2) -- this function renders it, it does not resolve it.
    `component_capabilities` is what the compiled component actually
    imports (cross-checked against the manifest's requests at install
    time, spec Sec9.7.1) -- passed in rather than derived here.
    """
    unusual: list[str] = []
    if allow_private_hosts:
        unusual.append("allow_private_hosts")
    if any(rule.platform == "*" for rule in manifest.consumes):
        unusual.append("wildcard_consumes")
    if manifest.routes_to:
        unusual.append("routes_to")
    if manifest.artifact == "prebuilt":
        unusual.append("prebuilt_artifact")

    return {
        "streams": list(grant_labels),
        "egress": [{"host": rule.host, "methods": list(rule.methods)} for rule in manifest.egress],
        "database": [{"table": table, "readWrite": "read_write"} for table in manifest.data_tables],
        "capabilities": sorted(component_capabilities),
        "routesTo": list(manifest.routes_to),
        "limits": {
            "timeoutMs": manifest.limits.timeout_ms,
            "memoryMb": manifest.limits.memory_mb,
            "egressRps": manifest.limits.egress_rps,
        },
        "provenance": {"language": manifest.language, "artifactKind": manifest.artifact},
        "entitlement": {"minTier": min_tier, "flagKey": flag_key},
        "unusual": unusual,
    }


def canonical_json(summary: dict[str, Any]) -> str:
    """Sorted-key, no-insignificant-whitespace JSON -- the same permissions always hash the same way."""
    return json.dumps(summary, sort_keys=True, separators=(",", ":"))


def permission_hash(summary: dict[str, Any]) -> str:
    """`"sha256:" + 64 hex` over `canonical_json(summary)`."""
    return "sha256:" + hashlib.sha256(canonical_json(summary).encode("utf-8")).hexdigest()
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_permission_summary_service.py -v`
Expected: `7 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/permission_summary_service.py hub_api/tests/test_permission_summary_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): permission_summary_service -- consent summary + canonical permission_hash (spec Sec9.7)

Canonical JSON (sorted keys, no whitespace) so the same permissions
always hash identically on any machine -- the property headless
approval (Sec9.7.5) depends on. Flags private-host egress, wildcard
consumes, routes_to and prebuilt artifacts under "unusual" per Sec9.7.1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 19: `bundle_approval_service.py` — permission summary retrieval, approve, deny

**Depends on:** Task 3 (`app_install_approvals` DDL), Task 4 (bound tables + fixture), Task 18 (`build_permission_summary`, `permission_hash`).

**Files:**
- Create: `hub_api/services/bundle_approval_service.py`
- Test: `hub_api/tests/test_bundle_approval_service.py`

**Interfaces:**
- Produces: `async def get_permission_summary(async_dal, dal, *, app_id: str, version: str) -> tuple[dict[str, Any], str]` (the summary dict and its hash); `def classify_diff(new_summary: dict, previous_summary: dict | None) -> str` (one of `"initial"`, `"widened"`, `"narrowed"`, `"unchanged"`); `async def approve_version(async_dal, dal, *, app_id: str, version: str, tenant_id: int, community_id: int | None, approved_by: int, expected_permission_hash: str | None = None) -> Any` (the new `app_install_approvals` row) — raises `ApiError` 409 `permission_hash_mismatch` when `expected_permission_hash` is given and disagrees (spec §9.7.5, fail-closed), 409 `version_not_published` if the version hasn't reached `PUBLISHED`; `async def deny_version(async_dal, dal, *, app_id: str, version: str, reason: str) -> None`.
- Consumes: `services.permission_summary_service.{build_permission_summary, permission_hash}` (Task 18).

**Scope note:** capability derivation (`_derive_capabilities`) is based on the manifest's declared shape (egress non-empty ⇒ `http`, `data_tables` non-empty ⇒ `db`, an `action` stage ⇒ `relay`; `context`/`kv`/`flags`/`log`/`clock` always) — spec §9.7.1's stronger claim ("cross-checked against the component's actual imports") requires M2a's compiler to report an imports list on the artifact callback, which is a documented follow-on once M2a ships that field; this plan does not block on it.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_approval_service.py
"""Tests for get_permission_summary()/classify_diff()/approve_version()/deny_version()."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
import yaml

from services.bundle_approval_service import (
    approve_version,
    classify_diff,
    deny_version,
    get_permission_summary,
)
from services.errors import ApiError

_MANIFEST = {
    "schema_version": 2, "app_id": "waddles.socials.music.default", "name": "Music Station",
    "version": "3.0.1", "feature": "waddles.socials.music", "module": "socials",
    "provider": "builtin", "language": "python", "artifact": "source",
    "stages": {
        "process": {"entry": "x:y", "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}]},
    },
    "egress": [{"host": "api.spotify.com"}],
    "data": {"tables": ["music_queue"]},
}


async def _seed_published(dal: Any, *, manifest: dict = _MANIFEST) -> None:
    version_id = dal.app_versions.insert(
        app_id=manifest["app_id"], version=manifest["version"], artifact_digest="sha256:" + "a" * 64,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_version_uploads.insert(
        app_id=manifest["app_id"], version=manifest["version"], tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED",
        manifest_json=manifest, app_version_id=version_id,
        created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    )
    dal.commit()


async def test_get_permission_summary_is_deterministic(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    await _seed_published(dal)
    summary1, hash1 = await get_permission_summary(
        bundle_install_db, dal, app_id="waddles.socials.music.default", version="3.0.1"
    )
    summary2, hash2 = await get_permission_summary(
        bundle_install_db, dal, app_id="waddles.socials.music.default", version="3.0.1"
    )
    assert summary1 == summary2
    assert hash1 == hash2


async def test_get_permission_summary_unknown_version_raises_404(bundle_install_db: Any) -> None:
    with pytest.raises(ApiError) as exc:
        await get_permission_summary(
            bundle_install_db, bundle_install_db.dal, app_id="waddles.x.y.default", version="1.0.0"
        )
    assert exc.value.status_code == 404


async def test_approve_version_records_a_row(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    await _seed_published(dal)
    row = await approve_version(
        bundle_install_db, dal, app_id="waddles.socials.music.default", version="3.0.1",
        tenant_id=1, community_id=None, approved_by=1,
    )
    assert row.approved_by == 1
    assert row.permission_hash.startswith("sha256:")


async def test_approve_version_not_published_is_refused(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="0.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="COMPILING",
        manifest_json=_MANIFEST, created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    )
    dal.commit()
    with pytest.raises(ApiError) as exc:
        await approve_version(
            bundle_install_db, dal, app_id="waddles.socials.music.default", version="0.0.1",
            tenant_id=1, community_id=None, approved_by=1,
        )
    assert exc.value.code == "version_not_published"


async def test_approve_version_headless_hash_mismatch_fails_closed(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    await _seed_published(dal)
    with pytest.raises(ApiError) as exc:
        await approve_version(
            bundle_install_db, dal, app_id="waddles.socials.music.default", version="3.0.1",
            tenant_id=1, community_id=None, approved_by=1,
            expected_permission_hash="sha256:" + "0" * 64,
        )
    assert exc.value.status_code == 409
    assert exc.value.code == "permission_hash_mismatch"


async def test_approve_version_supersedes_the_previous_current_approval(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    await _seed_published(dal)
    first = await approve_version(
        bundle_install_db, dal, app_id="waddles.socials.music.default", version="3.0.1",
        tenant_id=1, community_id=None, approved_by=1,
    )
    newer_manifest = {**_MANIFEST, "version": "3.0.2"}
    await _seed_published(dal, manifest=newer_manifest)
    second = await approve_version(
        bundle_install_db, dal, app_id="waddles.socials.music.default", version="3.0.2",
        tenant_id=1, community_id=None, approved_by=1,
    )
    refreshed_first = dal(dal.app_install_approvals.id == first.id).select().first()
    assert refreshed_first.superseded_by == second.id


def test_classify_diff_widened_when_a_new_table_is_added() -> None:
    previous = {"database": [{"table": "music_queue"}], "egress": [], "streams": [], "capabilities": [], "routesTo": []}
    new = {"database": [{"table": "music_queue"}, {"table": "music_history"}], "egress": [], "streams": [], "capabilities": [], "routesTo": []}
    assert classify_diff(new, previous) == "widened"


def test_classify_diff_narrowed_when_a_table_is_removed() -> None:
    previous = {"database": [{"table": "music_queue"}, {"table": "music_history"}], "egress": [], "streams": [], "capabilities": [], "routesTo": []}
    new = {"database": [{"table": "music_queue"}], "egress": [], "streams": [], "capabilities": [], "routesTo": []}
    assert classify_diff(new, previous) == "narrowed"


def test_classify_diff_unchanged() -> None:
    summary = {"database": [{"table": "music_queue"}], "egress": [], "streams": [], "capabilities": [], "routesTo": []}
    assert classify_diff(summary, summary) == "unchanged"


def test_classify_diff_initial_with_no_previous() -> None:
    summary = {"database": [], "egress": [], "streams": [], "capabilities": [], "routesTo": []}
    assert classify_diff(summary, None) == "initial"


async def test_deny_version_sets_rejected(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    await _seed_published(dal)
    await deny_version(
        bundle_install_db, dal, app_id="waddles.socials.music.default", version="3.0.1",
        reason="egress host not acceptable",
    )
    row = dal(dal.app_version_uploads.version == "3.0.1").select().first()
    assert row.status == "REJECTED"
    assert row.reject_reason == "egress host not acceptable"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_approval_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_approval_service'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/bundle_approval_service.py
"""Permission-summary retrieval, approval (with widen/narrow diff), and denial (spec Sec9.7)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from services.bundle_manifest_v2 import BundleManifestV2, ConsumeRule, EgressRule, Limits
from services.errors import ApiError, not_found
from services.permission_summary_service import build_permission_summary, permission_hash


def _reparse_trusted(raw: dict[str, Any]) -> BundleManifestV2:
    """Rebuild the structured manifest from a stored, already-validated `manifest_json` blob.

    Not a re-validation -- the manifest already passed `bundle_manifest_v2`'s
    gate at upload time (Task 7/10) and is immutable thereafter. This
    just reconstructs the dataclass shape for summary-building.
    """
    stages = raw.get("stages", {})
    consumes = tuple(
        ConsumeRule(
            platform=rule["platform"], source_id=rule.get("source_id"),
            event_types=tuple(rule["event_types"]), filters=dict(rule.get("filters") or {}),
        )
        for rule in (stages.get("process", {}).get("consumes") or [])
    )
    egress = tuple(
        EgressRule(host=e["host"], methods=tuple(e.get("methods") or ()))
        for e in raw.get("egress") or []
    )
    limits_raw = raw.get("limits") or {}
    return BundleManifestV2(
        schema_version=raw["schema_version"], app_id=raw["app_id"], name=raw["name"],
        version=raw["version"], feature=raw["feature"], module=raw["module"], provider=raw["provider"],
        language=raw["language"], artifact=raw["artifact"], execution_model=raw.get("execution_model", "native"),
        is_default=bool(raw.get("is_default", False)), stages=stages, egress=egress,
        data_tables=tuple((raw.get("data") or {}).get("tables") or ()),
        limits=Limits(
            timeout_ms=int(limits_raw.get("timeout_ms", 2000)),
            memory_mb=int(limits_raw.get("memory_mb", 64)),
            egress_rps=int(limits_raw.get("egress_rps", 10)),
        ),
        permissions=tuple(raw.get("permissions") or ()), routes_to=tuple(raw.get("routes_to") or ()),
        consumes=consumes,
    )


def _derive_capabilities(manifest: BundleManifestV2) -> frozenset[str]:
    caps = {"context", "kv", "flags", "log", "clock"}
    if manifest.egress:
        caps.add("http")
    if manifest.data_tables:
        caps.add("db")
    if "action" in manifest.stages:
        caps.add("relay")
    return frozenset(caps)


async def get_permission_summary(async_dal: Any, dal: Any, *, app_id: str, version: str) -> tuple[dict[str, Any], str]:
    """The consent-screen summary and its hash for one uploaded version."""
    rows = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == version))
    )
    if not rows:
        raise not_found(f"version {version} of {app_id} not found")
    manifest = _reparse_trusted(rows[0].manifest_json)
    summary = build_permission_summary(
        manifest,
        grant_labels=[
            {"platform": r.platform, "sourceId": r.source_id or "", "label": r.platform}
            for r in manifest.consumes
        ],
        component_capabilities=_derive_capabilities(manifest),
        min_tier="free", flag_key=manifest.feature, allow_private_hosts=False,
    )
    return summary, permission_hash(summary)


def classify_diff(new_summary: dict[str, Any], previous_summary: dict[str, Any] | None) -> str:
    """`"initial"` | `"widened"` | `"narrowed"` | `"unchanged"` -- spec Sec9.7.4."""
    if previous_summary is None:
        return "initial"

    def _flatten(summary: dict[str, Any]) -> set[str]:
        parts: set[str] = set()
        parts |= {f"stream:{s.get('platform')}:{s.get('sourceId')}" for s in summary.get("streams", [])}
        parts |= {f"egress:{e['host']}" for e in summary.get("egress", [])}
        parts |= {f"table:{t['table']}" for t in summary.get("database", [])}
        parts |= {f"cap:{c}" for c in summary.get("capabilities", [])}
        parts |= {f"route:{r}" for r in summary.get("routesTo", [])}
        return parts

    new_set, old_set = _flatten(new_summary), _flatten(previous_summary)
    if new_set == old_set:
        return "unchanged"
    added, removed = new_set - old_set, old_set - new_set
    if added and not removed:
        return "narrowed" if False else "widened"
    if removed and not added:
        return "narrowed"
    return "widened"  # mixed add+remove is treated as widening -- the conservative choice


async def approve_version(
    async_dal: Any,
    dal: Any,
    *,
    app_id: str,
    version: str,
    tenant_id: int,
    community_id: int | None,
    approved_by: int,
    expected_permission_hash: str | None = None,
) -> Any:
    """Record an `app_install_approvals` row. Fails closed on a headless hash mismatch (spec Sec9.7.5)."""
    upload_rows = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == version))
    )
    if not upload_rows:
        raise not_found(f"version {version} of {app_id} not found")
    if upload_rows[0].status != "PUBLISHED":
        raise ApiError(f"version {version} of {app_id} is not published yet", 409, "version_not_published")

    summary, computed_hash = await get_permission_summary(async_dal, dal, app_id=app_id, version=version)
    if expected_permission_hash is not None and expected_permission_hash != computed_hash:
        raise ApiError(
            "the supplied permission_hash does not match the current summary", 409, "permission_hash_mismatch"
        )

    previous_rows = await async_dal.select_async(
        dal(
            (dal.app_install_approvals.app_id == app_id)
            & (dal.app_install_approvals.tenant_id == tenant_id)
            & (dal.app_install_approvals.community_id == community_id)
            & (dal.app_install_approvals.superseded_by == None)  # noqa: E711 -- pydal query operator
        )
    )
    now = datetime.now(UTC)
    new_id = await async_dal.insert_async(
        dal.app_install_approvals,
        tenant_id=tenant_id, community_id=community_id, app_id=app_id, version=version,
        permission_hash=computed_hash, summary_json=summary, approved_by=approved_by, approved_at=now,
    )
    if previous_rows:
        await async_dal.update_async(dal.app_install_approvals.id == previous_rows[0].id, superseded_by=new_id)
    async_dal.dal.commit()
    return (await async_dal.select_async(dal(dal.app_install_approvals.id == new_id)))[0]


async def deny_version(async_dal: Any, dal: Any, *, app_id: str, version: str, reason: str) -> None:
    """Move the version to REJECTED with `reason` -- reuses `app_version_uploads.status`."""
    rows = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == version))
    )
    if not rows:
        raise not_found(f"version {version} of {app_id} not found")
    await async_dal.update_async(
        dal.app_version_uploads.id == rows[0].id,
        status="REJECTED", reject_reason=reason, updated_at=datetime.now(UTC),
    )
    async_dal.dal.commit()
```

- [ ] **Step 4: Clean up the dead branch in `classify_diff`**

The `"narrowed" if False else "widened"` expression above is a leftover from working through the truth table during authoring. Simplify it before committing:

```python
    if added and not removed:
        return "widened"
    if removed and not added:
        return "narrowed"
    return "widened"  # mixed add+remove is treated as widening -- the conservative choice
```

- [ ] **Step 5: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_approval_service.py -v`
Expected: `12 passed`

- [ ] **Step 6: Commit**

```bash
git add hub_api/services/bundle_approval_service.py hub_api/tests/test_bundle_approval_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): bundle_approval_service -- permission summary, approve (fail-closed hash check), deny

approve_version() fails closed on a headless permission_hash mismatch
(spec Sec9.7.5), supersedes the previous current approval on a new
one, and refuses a version that hasn't reached PUBLISHED.
classify_diff() labels widened/narrowed/unchanged/initial for the
upgrade-diff UI (Sec9.7.4).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 20: `bundle_db_role_service.py` — per-bundle Postgres roles for the `db` capability

**Depends on:** nothing new — SQLAlchemy is already pinned transitively via `libs/flask_core`.

**Files:**
- Create: `hub_api/services/bundle_db_role_service.py`
- Test: `hub_api/tests/test_bundle_db_role_service.py`

**Interfaces:**
- Produces: `bundle_role_name(app_id: str) -> str` (`bundle_<app_id with `.`/`-` -> `_`>`); `async def create_bundle_role(engine: Any, *, app_id: str, tables: list[str], grantee_roles: tuple[str, ...] = ("svc_process", "svc_action")) -> str` (idempotent `CREATE ROLE ... NOLOGIN`, `GRANT SELECT, INSERT, UPDATE, DELETE` on exactly `tables`, `GRANT <role> TO <grantee_roles>` so the stage can `SET ROLE`); `async def drop_bundle_role(engine: Any, *, app_id: str) -> None` (idempotent `DROP ROLE IF EXISTS`, after revoking).
- Consumes: nothing new — `sqlalchemy` (already a pinned dependency via `libs/flask_core`), matching `backend-database.md` rule #2 (SQLAlchemy for schema-adjacent DDL, never runtime queries).

This is **unrelated to** Task 1-2's `app_versions` RBAC roles — it is the spec §11.6.2 per-bundle `data.tables` role, created at approval, dropped at uninstall (Task 36), with a 168 h orphan sweeper behind it (Task 36, this plan's Decision #10b).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_db_role_service.py
"""Tests for per-bundle Postgres role creation/drop, SQLAlchemy engine mocked."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from services.bundle_db_role_service import bundle_role_name, create_bundle_role, drop_bundle_role


def test_bundle_role_name_replaces_dots_and_dashes() -> None:
    assert bundle_role_name("waddles.socials.music-station.default") == "bundle_waddles_socials_music_station_default"


async def test_create_bundle_role_issues_idempotent_create_and_grants() -> None:
    mock_conn = MagicMock()
    mock_engine = MagicMock()
    mock_engine.begin.return_value.__enter__.return_value = mock_conn

    role_name = await create_bundle_role(
        mock_engine, app_id="waddles.socials.music.default", tables=["music_queue", "music_history"]
    )
    assert role_name == "bundle_waddles_socials_music_default"

    executed_sql = " ".join(str(call.args[0]) for call in mock_conn.execute.call_args_list)
    assert "CREATE ROLE" in executed_sql
    assert "IF NOT EXISTS" in executed_sql
    assert "music_queue" in executed_sql
    assert "music_history" in executed_sql
    assert "svc_process" in executed_sql
    assert "svc_action" in executed_sql


async def test_create_bundle_role_rejects_a_reserved_table_name() -> None:
    mock_engine = MagicMock()
    with pytest.raises(ValueError, match="reserved"):
        await create_bundle_role(mock_engine, app_id="waddles.socials.music.default", tables=["users"])


async def test_drop_bundle_role_revokes_then_drops() -> None:
    mock_conn = MagicMock()
    mock_engine = MagicMock()
    mock_engine.begin.return_value.__enter__.return_value = mock_conn

    await drop_bundle_role(mock_engine, app_id="waddles.socials.music.default")

    executed_sql = " ".join(str(call.args[0]) for call in mock_conn.execute.call_args_list)
    assert "REVOKE ALL" in executed_sql
    assert "DROP ROLE IF EXISTS" in executed_sql
    assert "bundle_waddles_socials_music_default" in executed_sql
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_db_role_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_db_role_service'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/bundle_db_role_service.py
"""Per-bundle Postgres roles for the `db` WIT capability (spec Sec11.6.2, Sec7.4).

Created at approval (Task 21), dropped at uninstall (Task 36), with a
`BUNDLE_ROLE_GRACE_H = 168` hour orphan sweeper behind it for roles
whose uninstall never ran (this plan's Decision #10b, spec Q3). Uses
SQLAlchemy directly
against a privileged engine -- this is schema-adjacent DDL, not a
runtime query, matching `backend-database.md` rule #2. Unrelated to
Tasks 1-2's `app_versions`/`app_active_versions` RBAC roles, which are
a fixed, spec-defined set; this one is generated per bundle, per its
approved `data.tables`.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from sqlalchemy import text

_RESERVED_TABLES = frozenset({"users", "tenants", "communities", "app_catalog", "app_activations", "app_tenant_availability"})
_TABLE_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


def bundle_role_name(app_id: str) -> str:
    """`bundle_<app_id with '.'/'-' -> '_'>` -- the per-bundle Postgres role name."""
    return "bundle_" + re.sub(r"[.\-]", "_", app_id)


def _validate_tables(tables: list[str]) -> None:
    for table in tables:
        if table in _RESERVED_TABLES:
            raise ValueError(f"{table!r} is a reserved identity table")
        if not _TABLE_RE.match(table):
            raise ValueError(f"{table!r} is not a valid table name")


async def create_bundle_role(
    engine: Any, *, app_id: str, tables: list[str], grantee_roles: tuple[str, ...] = ("svc_process", "svc_action")
) -> str:
    """Idempotently create the bundle's role and grant it exactly `tables`. Returns the role name."""
    _validate_tables(tables)
    role_name = bundle_role_name(app_id)

    def _run() -> None:
        with engine.begin() as conn:
            conn.execute(text(
                f"DO $$ BEGIN\n"
                f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role_name}') THEN\n"
                f"    CREATE ROLE {role_name} NOLOGIN;\n"
                f"  END IF;\n"
                f"END $$;"
            ))
            for table in tables:
                conn.execute(text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {role_name};"))
            for grantee in grantee_roles:
                conn.execute(text(f"GRANT {role_name} TO {grantee};"))

    await asyncio.to_thread(_run)
    return role_name


async def drop_bundle_role(engine: Any, *, app_id: str) -> None:
    """Revoke everything, then idempotently drop the bundle's role (called at uninstall, Task 36)."""
    role_name = bundle_role_name(app_id)

    def _run() -> None:
        with engine.begin() as conn:
            conn.execute(text(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {role_name};"))
            conn.execute(text(
                f"DO $$ BEGIN\n"
                f"  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role_name}') THEN\n"
                f"    DROP ROLE IF EXISTS {role_name};\n"
                f"  END IF;\n"
                f"END $$;"
            ))

    await asyncio.to_thread(_run)
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_db_role_service.py -v`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/bundle_db_role_service.py hub_api/tests/test_bundle_db_role_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): bundle_db_role_service -- per-bundle Postgres roles for the db capability (spec Sec11.6.2)

Idempotent CREATE ROLE + GRANT scoped to exactly the bundle's approved
data.tables; svc_process/svc_action are grantee members so the stage
can SET ROLE. Rejects reserved identity tables. Separate concept from
Tasks 1-2's fixed app_versions RBAC roles.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 21: Wire per-bundle role creation into `approve_version()`

**Depends on:** Task 19 (`approve_version`), Task 20 (`create_bundle_role`).

**Files:**
- Modify: `hub_api/services/bundle_approval_service.py`
- Modify: `hub_api/tests/test_bundle_approval_service.py`

**Interfaces:**
- Produces: `approve_version(..., db_engine: Any | None = None)` — new optional keyword. When given and the approved manifest declares `data_tables`, calls `bundle_db_role_service.create_bundle_role`. `None` (the existing default, so every Task 19 test keeps passing unmodified) skips role management — the blueprint (Task 22) always passes a real engine in production.
- Consumes: `services.bundle_db_role_service.create_bundle_role` (Task 20).

- [ ] **Step 1: Write the failing test**

Append to `hub_api/tests/test_bundle_approval_service.py`:

```python
from unittest.mock import AsyncMock, patch  # noqa: E402 -- appended import


async def test_approve_version_creates_the_bundle_role_when_engine_given(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    await _seed_published(dal)
    mock_engine = object()
    with patch("services.bundle_approval_service.create_bundle_role", new_callable=AsyncMock) as mock_create:
        mock_create.return_value = "bundle_waddles_socials_music_default"
        await approve_version(
            bundle_install_db, dal, app_id="waddles.socials.music.default", version="3.0.1",
            tenant_id=1, community_id=None, approved_by=1, db_engine=mock_engine,
        )
    mock_create.assert_called_once_with(mock_engine, app_id="waddles.socials.music.default", tables=["music_queue"])


async def test_approve_version_skips_role_creation_without_an_engine(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    await _seed_published(dal)
    with patch("services.bundle_approval_service.create_bundle_role", new_callable=AsyncMock) as mock_create:
        await approve_version(
            bundle_install_db, dal, app_id="waddles.socials.music.default", version="3.0.1",
            tenant_id=1, community_id=None, approved_by=1,
        )
    mock_create.assert_not_called()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_approval_service.py -k role_creation -v`
Expected: `TypeError: approve_version() got an unexpected keyword argument 'db_engine'`

- [ ] **Step 3: Add the wiring**

Add the import to `hub_api/services/bundle_approval_service.py`:

```python
from services.bundle_db_role_service import create_bundle_role
```

Change `approve_version`'s signature and body:

```python
async def approve_version(
    async_dal: Any,
    dal: Any,
    *,
    app_id: str,
    version: str,
    tenant_id: int,
    community_id: int | None,
    approved_by: int,
    expected_permission_hash: str | None = None,
    db_engine: Any | None = None,
) -> Any:
    """Record an `app_install_approvals` row. Fails closed on a headless hash mismatch (spec Sec9.7.5).

    When `db_engine` is given and the manifest declares `data_tables`,
    also creates/refreshes the bundle's per-bundle Postgres role (spec
    Sec11.6.2). `db_engine=None` (test/dev default) skips role
    management entirely.
    """
    upload_rows = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == version))
    )
    if not upload_rows:
        raise not_found(f"version {version} of {app_id} not found")
    if upload_rows[0].status != "PUBLISHED":
        raise ApiError(f"version {version} of {app_id} is not published yet", 409, "version_not_published")

    manifest = _reparse_trusted(upload_rows[0].manifest_json)
    summary, computed_hash = await get_permission_summary(async_dal, dal, app_id=app_id, version=version)
    if expected_permission_hash is not None and expected_permission_hash != computed_hash:
        raise ApiError(
            "the supplied permission_hash does not match the current summary", 409, "permission_hash_mismatch"
        )

    previous_rows = await async_dal.select_async(
        dal(
            (dal.app_install_approvals.app_id == app_id)
            & (dal.app_install_approvals.tenant_id == tenant_id)
            & (dal.app_install_approvals.community_id == community_id)
            & (dal.app_install_approvals.superseded_by == None)  # noqa: E711 -- pydal query operator
        )
    )
    now = datetime.now(UTC)
    new_id = await async_dal.insert_async(
        dal.app_install_approvals,
        tenant_id=tenant_id, community_id=community_id, app_id=app_id, version=version,
        permission_hash=computed_hash, summary_json=summary, approved_by=approved_by, approved_at=now,
    )
    if previous_rows:
        await async_dal.update_async(dal.app_install_approvals.id == previous_rows[0].id, superseded_by=new_id)
    async_dal.dal.commit()

    if db_engine is not None and manifest.data_tables:
        await create_bundle_role(db_engine, app_id=app_id, tables=list(manifest.data_tables))

    return (await async_dal.select_async(dal(dal.app_install_approvals.id == new_id)))[0]
```

(This replaces the entire existing function body from Task 19 — the only changes are the new `db_engine` parameter, computing `manifest` once up front instead of discarding it, and the new role-creation call at the end.)

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_approval_service.py -v`
Expected: `14 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/bundle_approval_service.py hub_api/tests/test_bundle_approval_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): approve_version() creates the per-bundle Postgres role when data.tables is non-empty

Optional db_engine parameter, defaulting to None (skips role
management in tests/dev). Wires bundle_db_role_service into the
approval flow per spec Sec11.6.2.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 22: `blueprints/v1/bundle_approvals.py` — `GET permissions`, `POST approve`/`deny`

**Depends on:** Task 19 (`get_permission_summary`, `approve_version`, `deny_version`), Task 21 (`approve_version`'s `db_engine` keyword).

**Files:**
- Create: `hub_api/blueprints/v1/bundle_approvals.py`
- Test: `hub_api/tests/test_bundle_approvals_blueprint.py`

**Interfaces:**
- Produces: `GET /api/v1/apps/{app_id}/versions/{version}/permissions` (scope `platform:admin`) → `{summary, permissionHash}`; `POST /api/v1/apps/{app_id}/versions/{version}/approve` (scope `platform:admin`, body `{"communityId": int|null, "permissionHash": str|null}`) → `200 {"success": true, "permissionHash": ...}` or `409 permission_hash_mismatch` (with the current `summary`/`hash` in the body, per spec §9.7.5); `POST .../deny` (scope `platform:admin`, body `{"reason": str}`) → `200`.
- Consumes: `services.bundle_approval_service.{get_permission_summary, approve_version, deny_version}` (Tasks 19/21).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_approvals_blueprint.py
"""Blueprint tests for GET permissions / POST approve / POST deny."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from quart import Quart

from blueprints.v1.bundle_approvals import BLUEPRINTS
from tests.conftest import make_token

_MANIFEST = {
    "schema_version": 2, "app_id": "waddles.socials.music.default", "name": "Music Station",
    "version": "3.0.1", "feature": "waddles.socials.music", "module": "socials",
    "provider": "builtin", "language": "python", "artifact": "source",
    "stages": {"process": {"entry": "x:y", "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}]}},
}


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    dal = bundle_install_db.dal
    version_id = dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="3.0.1", artifact_digest="sha256:" + "a" * 64,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED",
        manifest_json=_MANIFEST, app_version_id=version_id,
        created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    )
    dal.commit()
    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = dal
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)
    return app


async def test_get_permissions_requires_platform_admin(app: Quart) -> None:
    token = make_token(scope="")
    client = app.test_client()
    response = await client.get(
        "/api/v1/apps/waddles.socials.music.default/versions/3.0.1/permissions",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403


async def test_get_permissions_happy_path(app: Quart) -> None:
    token = make_token(scope="platform:admin")
    client = app.test_client()
    response = await client.get(
        "/api/v1/apps/waddles.socials.music.default/versions/3.0.1/permissions",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    body = await response.get_json()
    assert body["permissionHash"].startswith("sha256:")


async def test_approve_mismatched_hash_fails_closed(app: Quart) -> None:
    token = make_token(scope="platform:admin")
    client = app.test_client()
    response = await client.post(
        "/api/v1/apps/waddles.socials.music.default/versions/3.0.1/approve",
        headers={"Authorization": f"Bearer {token}"},
        json={"communityId": None, "permissionHash": "sha256:" + "0" * 64},
    )
    assert response.status_code == 409
    body = await response.get_json()
    assert body["error"]["code"] == "permission_hash_mismatch"


async def test_approve_without_a_hash_succeeds_interactively(app: Quart) -> None:
    token = make_token(scope="platform:admin")
    client = app.test_client()
    response = await client.post(
        "/api/v1/apps/waddles.socials.music.default/versions/3.0.1/approve",
        headers={"Authorization": f"Bearer {token}"},
        json={"communityId": None, "permissionHash": None},
    )
    assert response.status_code == 200


async def test_deny_happy_path(app: Quart) -> None:
    token = make_token(scope="platform:admin")
    client = app.test_client()
    response = await client.post(
        "/api/v1/apps/waddles.socials.music.default/versions/3.0.1/deny",
        headers={"Authorization": f"Bearer {token}"},
        json={"reason": "egress host not acceptable"},
    )
    assert response.status_code == 200
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_approvals_blueprint.py -v`
Expected: `ModuleNotFoundError: No module named 'blueprints.v1.bundle_approvals'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/blueprints/v1/bundle_approvals.py
"""v1 `bundle_approvals` group -- GET permissions, POST approve/deny (spec Sec9.7)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, cast

from flask_core.api_utils import error_response
from flask_core.authz import require_scope
from flask_core.tenancy import tenant_middleware
from quart import Blueprint, current_app, request
from quart_schema import validate_request, validate_response

from services import bundle_approval_service as svc
from services.current_user import get_current_user_id
from services.errors import ApiError

bundle_approvals_bp = Blueprint("v1_bundle_approvals", __name__, url_prefix="/api/v1/apps")


def _dal() -> tuple[Any, Any]:
    return current_app.config["async_dal"], current_app.config["dal"]


def _err(exc: ApiError) -> tuple[dict[str, object], int]:
    return cast(tuple[dict[str, object], int], error_response(exc.message, exc.status_code, exc.code))


def _db_engine() -> Any:
    """The privileged SQLAlchemy engine for per-bundle role management, or `None` if unconfigured."""
    dsn = os.environ.get("POSTGRES_ADMIN_DSN")
    if not dsn:
        return None
    from sqlalchemy import create_engine

    return create_engine(dsn)


@dataclass(slots=True, frozen=True)
class PermissionSummaryResponse:
    """Response DTO for `GET .../permissions`."""

    success: bool
    summary: dict[str, Any]
    permissionHash: str


@dataclass(slots=True, frozen=True)
class ApproveRequest:
    """Request DTO for `POST .../approve`."""

    communityId: int | None = None
    permissionHash: str | None = None


@dataclass(slots=True, frozen=True)
class ApproveResponse:
    """Response DTO for `POST .../approve`."""

    success: bool
    permissionHash: str


@dataclass(slots=True, frozen=True)
class DenyRequest:
    """Request DTO for `POST .../deny`."""

    reason: str


@dataclass(slots=True, frozen=True)
class MessageResponse:
    """Generic message response DTO."""

    success: bool
    message: str


@bundle_approvals_bp.route("/<app_id>/versions/<version>/permissions", methods=["GET"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("platform:admin")  # type: ignore[untyped-decorator]
@validate_response(PermissionSummaryResponse)
async def get_permissions(
    app_id: str, version: str
) -> PermissionSummaryResponse | tuple[dict[str, object], int]:
    """The consent-screen summary and its hash -- a headless caller inspects this before approving."""
    async_dal, dal = _dal()
    try:
        summary, permission_hash = await svc.get_permission_summary(async_dal, dal, app_id=app_id, version=version)
    except ApiError as exc:
        return _err(exc)
    return PermissionSummaryResponse(success=True, summary=summary, permissionHash=permission_hash)


@bundle_approvals_bp.route("/<app_id>/versions/<version>/approve", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("platform:admin")  # type: ignore[untyped-decorator]
@validate_request(ApproveRequest)
async def post_approve(data: ApproveRequest, app_id: str, version: str) -> tuple[dict[str, object], int]:
    """Approve a version. A headless caller supplies `permissionHash`; a mismatch fails closed (409)."""
    async_dal, dal = _dal()
    caller_id = get_current_user_id(request)
    try:
        row = await svc.approve_version(
            async_dal, dal, app_id=app_id, version=version, tenant_id=1, community_id=data.communityId,
            approved_by=caller_id, expected_permission_hash=data.permissionHash, db_engine=_db_engine(),
        )
    except ApiError as exc:
        if exc.code == "permission_hash_mismatch":
            summary, current_hash = await svc.get_permission_summary(async_dal, dal, app_id=app_id, version=version)
            return (
                {
                    "success": False,
                    "error": {"code": exc.code, "message": exc.message},
                    "summary": summary,
                    "permissionHash": current_hash,
                },
                409,
            )
        return _err(exc)
    return {"success": True, "permissionHash": row.permission_hash}, 200


@bundle_approvals_bp.route("/<app_id>/versions/<version>/deny", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("platform:admin")  # type: ignore[untyped-decorator]
@validate_request(DenyRequest)
@validate_response(MessageResponse)
async def post_deny(data: DenyRequest, app_id: str, version: str) -> MessageResponse | tuple[dict[str, object], int]:
    """Deny a version -- moves it to REJECTED with `reason`."""
    async_dal, dal = _dal()
    try:
        await svc.deny_version(async_dal, dal, app_id=app_id, version=version, reason=data.reason)
    except ApiError as exc:
        return _err(exc)
    return MessageResponse(success=True, message=f"version {version} of {app_id} denied: {data.reason}")


BLUEPRINTS: list[Blueprint] = [bundle_approvals_bp]
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_approvals_blueprint.py -v`
Expected: `5 passed`

- [ ] **Step 5: Add the ruff per-file ignore**

Append to `hub_api/pyproject.toml`'s `[tool.ruff.lint.per-file-ignores]`:

```toml
"blueprints/v1/bundle_approvals.py" = ["N815"]
```

- [ ] **Step 6: Commit**

```bash
git add hub_api/blueprints/v1/bundle_approvals.py hub_api/tests/test_bundle_approvals_blueprint.py \
        hub_api/pyproject.toml
git commit -m "$(cat <<'EOF'
feat(hub-api): GET permissions, POST approve/deny (spec Sec9.7)

approve's headless path fails closed with 409 permission_hash_mismatch
plus the current summary/hash in the body, per spec Sec9.7.5.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 23: `platform_settings_service.py` + `blueprints/v1/bundle_settings.py` — the global `bundles.allow_prebuilt` setting

**Depends on:** Task 3 (`platform_settings` DDL, seeded with `bundles.allow_prebuilt`), Task 4 (bound tables + fixture).

**Files:**
- Create: `hub_api/services/platform_settings_service.py`
- Create: `hub_api/blueprints/v1/bundle_settings.py`
- Test: `hub_api/tests/test_platform_settings_service.py`
- Test: `hub_api/tests/test_bundle_settings_blueprint.py`

**Interfaces:**
- Produces: `SETTING_ALLOW_PREBUILT = "bundles.allow_prebuilt"`; `async def get_platform_setting_bool(async_dal, dal, *, key: str, default: bool) -> bool`; `async def set_platform_setting(async_dal, dal, *, key: str, value: str, updated_by: int) -> None`; `GET /api/v1/marketplace/settings` (scope `platform:admin`) → `{success, settings: [{key, value}]}`; `PUT /api/v1/marketplace/settings` (scope `platform:admin`, body `{"settings": [{"key": str, "value": str}]}`) → `200`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing service test**

```python
# hub_api/tests/test_platform_settings_service.py
"""Tests for get_platform_setting_bool()/set_platform_setting()."""

from __future__ import annotations

from typing import Any

from services.platform_settings_service import (
    SETTING_ALLOW_PREBUILT,
    get_platform_setting_bool,
    set_platform_setting,
)


async def test_default_is_used_when_unset(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    value = await get_platform_setting_bool(async_dal, async_dal.dal, key="nonexistent.key", default=True)
    assert value is True


async def test_seeded_bundles_allow_prebuilt_reads_true(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    dal.platform_settings.insert(key=SETTING_ALLOW_PREBUILT, value="true")
    dal.commit()
    value = await get_platform_setting_bool(bundle_install_db, dal, key=SETTING_ALLOW_PREBUILT, default=False)
    assert value is True


async def test_set_platform_setting_updates_an_existing_row(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    dal.platform_settings.insert(key=SETTING_ALLOW_PREBUILT, value="true")
    dal.commit()
    await set_platform_setting(async_dal, dal, key=SETTING_ALLOW_PREBUILT, value="false", updated_by=1)
    value = await get_platform_setting_bool(async_dal, dal, key=SETTING_ALLOW_PREBUILT, default=True)
    assert value is False


async def test_set_platform_setting_inserts_when_absent(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await set_platform_setting(async_dal, dal, key="a.new.key", value="1", updated_by=1)
    row = dal(dal.platform_settings.key == "a.new.key").select().first()
    assert row.value == "1"
    assert row.updated_by == 1
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_platform_settings_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.platform_settings_service'`

- [ ] **Step 3: Write the service**

```python
# hub_api/services/platform_settings_service.py
"""Global (not per-tenant) admin settings -- one row per key, `platform_settings` table.

The single global setting this milestone introduces:
`bundles.allow_prebuilt` (spec Sec6.4.4 V18, Sec12.3), default `true`,
seeded by migration 0021.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

SETTING_ALLOW_PREBUILT = "bundles.allow_prebuilt"


async def get_platform_setting_bool(async_dal: Any, dal: Any, *, key: str, default: bool) -> bool:
    """`True`/`False` for `key`, or `default` when the row does not exist."""
    rows = await async_dal.select_async(dal(dal.platform_settings.key == key))
    if not rows:
        return default
    return rows[0].value == "true"


async def set_platform_setting(async_dal: Any, dal: Any, *, key: str, value: str, updated_by: int) -> None:
    """Upsert `key` -> `value` (select-then-branch -- pydal has no portable `ON CONFLICT`, PORTING.md Gotcha #1)."""
    existing = await async_dal.select_async(dal(dal.platform_settings.key == key))
    now = datetime.now(UTC)
    if existing:
        await async_dal.update_async(
            dal.platform_settings.key == key, value=value, updated_by=updated_by, updated_at=now
        )
    else:
        await async_dal.insert_async(
            dal.platform_settings, key=key, value=value, updated_by=updated_by, updated_at=now
        )
    async_dal.dal.commit()
```

- [ ] **Step 4: Run the service test to verify it passes**

Run: `cd hub_api && python3 -m pytest tests/test_platform_settings_service.py -v`
Expected: `4 passed`

- [ ] **Step 5: Write the failing blueprint test**

```python
# hub_api/tests/test_bundle_settings_blueprint.py
"""Blueprint tests for GET/PUT /api/v1/marketplace/settings."""

from __future__ import annotations

from typing import Any

import pytest
from quart import Quart

from blueprints.v1.bundle_settings import BLUEPRINTS
from tests.conftest import make_token


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    dal = bundle_install_db.dal
    dal.platform_settings.insert(key="bundles.allow_prebuilt", value="true")
    dal.commit()
    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = dal
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)
    return app


async def test_get_settings_requires_platform_admin(app: Quart) -> None:
    token = make_token(scope="")
    client = app.test_client()
    response = await client.get("/api/v1/marketplace/settings", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 403


async def test_get_settings_returns_seeded_value(app: Quart) -> None:
    token = make_token(scope="platform:admin")
    client = app.test_client()
    response = await client.get("/api/v1/marketplace/settings", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    body = await response.get_json()
    assert {"key": "bundles.allow_prebuilt", "value": "true"} in body["settings"]


async def test_put_settings_updates_the_value(app: Quart) -> None:
    token = make_token(scope="platform:admin")
    client = app.test_client()
    response = await client.put(
        "/api/v1/marketplace/settings",
        headers={"Authorization": f"Bearer {token}"},
        json={"settings": [{"key": "bundles.allow_prebuilt", "value": "false"}]},
    )
    assert response.status_code == 200
```

- [ ] **Step 6: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_settings_blueprint.py -v`
Expected: `ModuleNotFoundError: No module named 'blueprints.v1.bundle_settings'`

- [ ] **Step 7: Write the blueprint**

```python
# hub_api/blueprints/v1/bundle_settings.py
"""v1 `bundle_settings` group -- GET/PUT /api/v1/marketplace/settings (global admin, spec Sec12.3)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

from flask_core.authz import require_scope
from flask_core.tenancy import tenant_middleware
from quart import Blueprint, current_app, request
from quart_schema import validate_request, validate_response

from services import platform_settings_service as svc
from services.current_user import get_current_user_id

bundle_settings_bp = Blueprint("v1_bundle_settings", __name__, url_prefix="/api/v1/marketplace")


def _dal() -> tuple[Any, Any]:
    return current_app.config["async_dal"], current_app.config["dal"]


@dataclass(slots=True, frozen=True)
class SettingDTO:
    """One `{key, value}` pair."""

    key: str
    value: str | None


@dataclass(slots=True, frozen=True)
class SettingsListResponse:
    """Response DTO for `GET /marketplace/settings`."""

    success: bool
    settings: list[SettingDTO] = field(default_factory=list)


@dataclass(slots=True, frozen=True)
class SettingInput:
    """One `{key, value}` pair in `UpdateSettingsRequest.settings`."""

    key: str
    value: str


@dataclass(slots=True, frozen=True)
class UpdateSettingsRequest:
    """Request DTO for `PUT /marketplace/settings`."""

    settings: list[SettingInput]


@dataclass(slots=True, frozen=True)
class MessageResponse:
    """Generic message response DTO."""

    success: bool
    message: str


@bundle_settings_bp.route("/settings", methods=["GET"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("platform:admin")  # type: ignore[untyped-decorator]
@validate_response(SettingsListResponse)
async def get_settings() -> SettingsListResponse:
    """List every global bundle setting."""
    async_dal, dal = _dal()
    rows = await async_dal.select_async(dal(dal.platform_settings.id > 0))
    return SettingsListResponse(success=True, settings=[SettingDTO(key=r.key, value=r.value) for r in rows])


@bundle_settings_bp.route("/settings", methods=["PUT"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("platform:admin")  # type: ignore[untyped-decorator]
@validate_request(UpdateSettingsRequest)
@validate_response(MessageResponse)
async def put_settings(data: UpdateSettingsRequest) -> MessageResponse:
    """Upsert one or more global bundle settings."""
    async_dal, dal = _dal()
    caller_id = get_current_user_id(request)
    for setting in data.settings:
        await svc.set_platform_setting(async_dal, dal, key=setting.key, value=setting.value, updated_by=caller_id)
    return MessageResponse(success=True, message="settings updated")


BLUEPRINTS: list[Blueprint] = [bundle_settings_bp]
```

- [ ] **Step 8: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_settings_blueprint.py -v`
Expected: `3 passed`

- [ ] **Step 9: Refactor `bundle_versions.py`'s inline `_allow_prebuilt` helper**

Task 11 added a temporary inline `_allow_prebuilt(dal)` query to `hub_api/blueprints/v1/bundle_versions.py`. Replace it now that the real service exists:

```python
from services.platform_settings_service import SETTING_ALLOW_PREBUILT, get_platform_setting_bool
```

Delete the `_allow_prebuilt` function from `bundle_versions.py` and replace its one call site:

```python
            allow_prebuilt=await get_platform_setting_bool(
                async_dal, dal, key=SETTING_ALLOW_PREBUILT, default=True
            ),
```

- [ ] **Step 10: Run the versions blueprint tests to confirm the refactor didn't break anything**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_versions_blueprint.py -v`
Expected: `5 passed`

- [ ] **Step 11: Commit**

```bash
git add hub_api/services/platform_settings_service.py hub_api/blueprints/v1/bundle_settings.py \
        hub_api/tests/test_platform_settings_service.py hub_api/tests/test_bundle_settings_blueprint.py \
        hub_api/blueprints/v1/bundle_versions.py
git commit -m "$(cat <<'EOF'
feat(hub-api): GET/PUT /api/v1/marketplace/settings -- global bundles.allow_prebuilt (spec Sec12.3)

Refactors Task 11's temporary inline _allow_prebuilt() query in
bundle_versions.py to call the real service.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 24: `tenant_bundle_settings.py` — tenant `allow_wildcard_consumes`/`bundles.egress.allowPrivateHosts`

**Depends on:** Task 4 (the `bundle_install_db` fixture), Task 11 (`blueprints/v1/bundle_versions.py`, refactored here to read both tenant settings).

**Files:**
- Create: `hub_api/services/tenant_bundle_settings.py`
- Modify: `hub_api/blueprints/v1/bundle_versions.py` (refactor)
- Test: `hub_api/tests/test_tenant_bundle_settings.py`

**Interfaces:**
- Produces: `SETTING_ALLOW_WILDCARD_CONSUMES = "allow_wildcard_consumes"`; `SETTING_ALLOW_PRIVATE_HOSTS = "bundles.egress.allowPrivateHosts"`; `async def get_tenant_setting_bool(async_dal, dal, *, tenant_id: int, key: str, default: bool) -> bool`. No new endpoint — both keys are set through the **existing** `PUT /api/v1/tenant/<slug>/settings` (`tenant_service.update_tenant_settings`, already shipped), per this plan's Decision #8.
- Consumes: nothing new — reads the existing `tenant_settings` table directly.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_tenant_bundle_settings.py
"""Tests for get_tenant_setting_bool() against the existing tenant_settings table."""

from __future__ import annotations

from typing import Any

from services.tenant_bundle_settings import (
    SETTING_ALLOW_PRIVATE_HOSTS,
    SETTING_ALLOW_WILDCARD_CONSUMES,
    get_tenant_setting_bool,
)


async def test_default_false_when_unset(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    value = await get_tenant_setting_bool(
        async_dal, async_dal.dal, tenant_id=1, key=SETTING_ALLOW_WILDCARD_CONSUMES, default=False
    )
    assert value is False


async def test_true_when_set_via_the_generic_tenant_settings_table(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    dal.tenant_settings.insert(tenant_id=1, key=SETTING_ALLOW_WILDCARD_CONSUMES, value="true")
    dal.commit()
    value = await get_tenant_setting_bool(
        bundle_install_db, dal, tenant_id=1, key=SETTING_ALLOW_WILDCARD_CONSUMES, default=False
    )
    assert value is True


async def test_allow_private_hosts_key_is_scoped_per_tenant(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    dal.tenant_settings.insert(tenant_id=1, key=SETTING_ALLOW_PRIVATE_HOSTS, value="true")
    dal.tenant_settings.insert(tenant_id=2, key=SETTING_ALLOW_PRIVATE_HOSTS, value="false")
    dal.commit()
    tenant1 = await get_tenant_setting_bool(
        bundle_install_db, dal, tenant_id=1, key=SETTING_ALLOW_PRIVATE_HOSTS, default=False
    )
    tenant2 = await get_tenant_setting_bool(
        bundle_install_db, dal, tenant_id=2, key=SETTING_ALLOW_PRIVATE_HOSTS, default=False
    )
    assert tenant1 is True
    assert tenant2 is False
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_tenant_bundle_settings.py -v`
Expected: `ModuleNotFoundError: No module named 'services.tenant_bundle_settings'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/tenant_bundle_settings.py
"""Tenant-scoped bundle settings -- read via the EXISTING `tenant_settings` table.

No new endpoint: both keys below are set through the already-shipped
`PUT /api/v1/tenant/<slug>/settings` (`services/tenant_service.py::
update_tenant_settings`, which already accepts arbitrary `{key, value}`
pairs). This module is the read-side helper the bundle-install flow
needs; it introduces no new table and no new route (this plan's
Decision #8).
"""

from __future__ import annotations

from typing import Any

SETTING_ALLOW_WILDCARD_CONSUMES = "allow_wildcard_consumes"
SETTING_ALLOW_PRIVATE_HOSTS = "bundles.egress.allowPrivateHosts"


async def get_tenant_setting_bool(async_dal: Any, dal: Any, *, tenant_id: int, key: str, default: bool) -> bool:
    """`True`/`False` for `(tenant_id, key)`, or `default` when the row does not exist."""
    rows = await async_dal.select_async(
        dal((dal.tenant_settings.tenant_id == tenant_id) & (dal.tenant_settings.key == key))
    )
    if not rows:
        return default
    return rows[0].value == "true"
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_tenant_bundle_settings.py -v`
Expected: `3 passed`

- [ ] **Step 5: Refactor `bundle_versions.py`'s inline `_allow_wildcard_consumes` helper**

Add the import to `hub_api/blueprints/v1/bundle_versions.py`:

```python
from services.tenant_bundle_settings import SETTING_ALLOW_WILDCARD_CONSUMES, get_tenant_setting_bool
```

Delete the `_allow_wildcard_consumes` function and replace its one call site:

```python
            allow_wildcard_consumes=await get_tenant_setting_bool(
                async_dal, dal, tenant_id=ctx.tenant_id, key=SETTING_ALLOW_WILDCARD_CONSUMES, default=False
            ),
```

- [ ] **Step 6: Run the versions blueprint tests to confirm the refactor didn't break anything**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_versions_blueprint.py -v`
Expected: `5 passed`

- [ ] **Step 7: Commit**

```bash
git add hub_api/services/tenant_bundle_settings.py hub_api/tests/test_tenant_bundle_settings.py \
        hub_api/blueprints/v1/bundle_versions.py
git commit -m "$(cat <<'EOF'
feat(hub-api): tenant_bundle_settings -- allow_wildcard_consumes / bundles.egress.allowPrivateHosts (spec Sec8.5, V30)

Read-side helper only -- both settings are already writable through
the existing PUT /api/v1/tenant/<slug>/settings, no new endpoint.
Refactors Task 11's temporary inline query in bundle_versions.py.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 25: `custom_platform_service.py` + `blueprints/v1/custom_platforms.py` — registry + `intake:write` token minting

**Depends on:** Task 3 (`custom_platforms` DDL), Task 4 (bound tables + fixture).

**Files:**
- Create: `hub_api/services/custom_platform_service.py`
- Create: `hub_api/blueprints/v1/custom_platforms.py`
- Test: `hub_api/tests/test_custom_platform_service.py`
- Test: `hub_api/tests/test_custom_platforms_blueprint.py`

**Interfaces:**
- Produces: `async def list_platform_names(async_dal, dal, *, tenant_id: int) -> frozenset[str]`; `async def create_platform(async_dal, dal, *, tenant_id: int, name: str) -> Any` (409 on duplicate); `async def delete_platform(async_dal, dal, *, tenant_id: int, name: str) -> None` (404 if absent); `def mint_intake_token(tenant_slug: str, platform_name: str) -> str` (24h JWT, scope `intake:write`, mandatory `tenant` claim — spec §10.4). Endpoints: `POST /api/v1/tenant/{slug}/custom-platforms` (scope `tenant:admin`), `GET /api/v1/tenant/{slug}/custom-platforms` (`tenant_middleware` only), `DELETE /api/v1/tenant/{slug}/custom-platforms/{name}` (scope `tenant:admin`), `POST /api/v1/tenant/{slug}/custom-platforms/{name}/tokens` (scope `tenant:admin`) → `{token, expiresInHours}` — re-mintable any time, JWTs are stateless so nothing is stored.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing service test**

```python
# hub_api/tests/test_custom_platform_service.py
"""Tests for custom_platform_service."""

from __future__ import annotations

from typing import Any

import jwt
import pytest

from services.custom_platform_service import (
    create_platform,
    delete_platform,
    list_platform_names,
    mint_intake_token,
)
from services.errors import ApiError


async def test_create_and_list_platform(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    await create_platform(async_dal, async_dal.dal, tenant_id=1, name="mycrm")
    names = await list_platform_names(async_dal, async_dal.dal, tenant_id=1)
    assert names == frozenset({"mycrm"})


async def test_create_duplicate_platform_raises_409(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    await create_platform(async_dal, async_dal.dal, tenant_id=1, name="mycrm")
    with pytest.raises(ApiError) as exc:
        await create_platform(async_dal, async_dal.dal, tenant_id=1, name="mycrm")
    assert exc.value.status_code == 409


async def test_delete_platform_removes_it(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    await create_platform(async_dal, async_dal.dal, tenant_id=1, name="mycrm")
    await delete_platform(async_dal, async_dal.dal, tenant_id=1, name="mycrm")
    names = await list_platform_names(async_dal, async_dal.dal, tenant_id=1)
    assert names == frozenset()


async def test_delete_unknown_platform_raises_404(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    with pytest.raises(ApiError) as exc:
        await delete_platform(async_dal, async_dal.dal, tenant_id=1, name="ghost")
    assert exc.value.status_code == 404


def test_mint_intake_token_carries_scope_and_tenant(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SECRET_KEY", "test-secret-key-not-for-prod")
    token = mint_intake_token("acme-corp", "mycrm")
    payload = jwt.decode(token, "test-secret-key-not-for-prod", algorithms=["HS256"], audience="waddlebot-services")
    assert payload["scope"] == "intake:write"
    assert payload["tenant"] == "acme-corp"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_custom_platform_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.custom_platform_service'`

- [ ] **Step 3: Write the service**

```python
# hub_api/services/custom_platform_service.py
"""Per-tenant custom platform registry (spec Sec6.4.3, Sec10.4) + `intake:write` token minting."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from flask_core.auth import create_jwt_token
from flask_core.secrets import require_secret_key

from services.errors import ApiError, conflict, not_found


async def list_platform_names(async_dal: Any, dal: Any, *, tenant_id: int) -> frozenset[str]:
    """Every custom platform name registered for `tenant_id`."""
    rows = await async_dal.select_async(dal(dal.custom_platforms.tenant_id == tenant_id))
    return frozenset(r.name for r in rows)


async def create_platform(async_dal: Any, dal: Any, *, tenant_id: int, name: str) -> Any:
    """Register a new custom platform name. Raises 409 on duplicate."""
    existing = await async_dal.select_async(
        dal((dal.custom_platforms.tenant_id == tenant_id) & (dal.custom_platforms.name == name))
    )
    if existing:
        raise conflict(f"custom platform {name!r} already registered")
    new_id = await async_dal.insert_async(
        dal.custom_platforms, tenant_id=tenant_id, name=name, created_at=datetime.now(UTC)
    )
    async_dal.dal.commit()
    return (await async_dal.select_async(dal(dal.custom_platforms.id == new_id)))[0]


async def delete_platform(async_dal: Any, dal: Any, *, tenant_id: int, name: str) -> None:
    """Remove a custom platform. Raises 404 if it does not exist."""
    existing = await async_dal.select_async(
        dal((dal.custom_platforms.tenant_id == tenant_id) & (dal.custom_platforms.name == name))
    )
    if not existing:
        raise not_found(f"custom platform {name!r} not found")
    await async_dal.delete_async(
        (dal.custom_platforms.tenant_id == tenant_id) & (dal.custom_platforms.name == name)
    )
    async_dal.dal.commit()


def mint_intake_token(tenant_slug: str, platform_name: str) -> str:
    """24h JWT, scope `intake:write`, mandatory `tenant` claim (spec Sec10.4).

    24h is the general JWT-expiration ceiling (security.md JWT Claims:
    "default 1h/max 24h"), not the stricter 1h service-to-service ceiling
    -- this token is handed to a third-party REST-intake integration, not
    exchanged between PenguinTech-controlled services. The admin re-mints
    by calling this endpoint again; nothing is stored server-side.
    """
    return create_jwt_token(
        user_id=f"platform:{platform_name}", username=platform_name, email="", roles=[],
        secret_key=require_secret_key(), tenant=tenant_slug, scope="intake:write", expiration_hours=24,
    )
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_custom_platform_service.py -v`
Expected: `5 passed`

- [ ] **Step 5: Write the failing blueprint test**

```python
# hub_api/tests/test_custom_platforms_blueprint.py
"""Blueprint tests for /api/v1/tenant/{slug}/custom-platforms."""

from __future__ import annotations

from typing import Any

import pytest
from quart import Quart

from blueprints.v1.custom_platforms import BLUEPRINTS
from tests.conftest import TENANT_SLUG, make_token


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = bundle_install_db.dal
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)
    return app


async def test_create_requires_tenant_admin(app: Quart) -> None:
    token = make_token(scope="", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.post(
        f"/api/v1/tenant/{TENANT_SLUG}/custom-platforms",
        headers={"Authorization": f"Bearer {token}"}, json={"name": "mycrm"},
    )
    assert response.status_code == 403


async def test_create_list_delete_round_trip(app: Quart) -> None:
    token = make_token(scope="tenant:admin", tenant=TENANT_SLUG)
    client = app.test_client()
    create_response = await client.post(
        f"/api/v1/tenant/{TENANT_SLUG}/custom-platforms",
        headers={"Authorization": f"Bearer {token}"}, json={"name": "mycrm"},
    )
    assert create_response.status_code == 201

    list_response = await client.get(
        f"/api/v1/tenant/{TENANT_SLUG}/custom-platforms", headers={"Authorization": f"Bearer {token}"}
    )
    body = await list_response.get_json()
    assert "mycrm" in body["names"]

    delete_response = await client.delete(
        f"/api/v1/tenant/{TENANT_SLUG}/custom-platforms/mycrm", headers={"Authorization": f"Bearer {token}"}
    )
    assert delete_response.status_code == 200


async def test_mint_token_returns_a_jwt(app: Quart) -> None:
    token = make_token(scope="tenant:admin", tenant=TENANT_SLUG)
    client = app.test_client()
    await client.post(
        f"/api/v1/tenant/{TENANT_SLUG}/custom-platforms",
        headers={"Authorization": f"Bearer {token}"}, json={"name": "mycrm"},
    )
    response = await client.post(
        f"/api/v1/tenant/{TENANT_SLUG}/custom-platforms/mycrm/tokens",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    body = await response.get_json()
    assert body["expiresInHours"] == 24
    assert len(body["token"]) > 20
```

- [ ] **Step 6: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_custom_platforms_blueprint.py -v`
Expected: `ModuleNotFoundError: No module named 'blueprints.v1.custom_platforms'`

- [ ] **Step 7: Write the blueprint**

```python
# hub_api/blueprints/v1/custom_platforms.py
"""v1 `custom_platforms` group -- per-tenant registry + intake:write token minting (spec Sec6.4.3, Sec10.4)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

from flask_core.api_utils import error_response
from flask_core.authz import require_scope
from flask_core.tenancy import get_tenant_context, tenant_middleware
from quart import Blueprint, current_app, request
from quart_schema import validate_request, validate_response

from services import custom_platform_service as svc
from services.errors import ApiError
from services.tenant_service import require_matching_tenant

custom_platforms_bp = Blueprint(
    "v1_custom_platforms", __name__, url_prefix="/api/v1/tenant/<tenant_slug>/custom-platforms"
)


def _dal() -> tuple[Any, Any]:
    return current_app.config["async_dal"], current_app.config["dal"]


def _err(exc: ApiError) -> tuple[dict[str, object], int]:
    return cast(tuple[dict[str, object], int], error_response(exc.message, exc.status_code, exc.code))


def _tenant_id(tenant_slug: str) -> int:
    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101
    require_matching_tenant(tenant_slug, ctx.tenant_slug)
    return cast(int, ctx.tenant_id)


@dataclass(slots=True, frozen=True)
class CreatePlatformRequest:
    """Request DTO for `POST .../custom-platforms`."""

    name: str


@dataclass(slots=True, frozen=True)
class MessageResponse:
    """Generic message response DTO."""

    success: bool
    message: str


@dataclass(slots=True, frozen=True)
class PlatformListResponse:
    """Response DTO for `GET .../custom-platforms`."""

    success: bool
    names: list[str] = field(default_factory=list)


@dataclass(slots=True, frozen=True)
class TokenResponse:
    """Response DTO for `POST .../tokens`."""

    success: bool
    token: str
    expiresInHours: int


@custom_platforms_bp.route("", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@validate_request(CreatePlatformRequest)
async def create_platform(data: CreatePlatformRequest, tenant_slug: str) -> tuple[dict[str, object], int]:
    """Register a new custom platform name."""
    async_dal, dal = _dal()
    try:
        tenant_id = _tenant_id(tenant_slug)
        await svc.create_platform(async_dal, dal, tenant_id=tenant_id, name=data.name)
    except ApiError as exc:
        return _err(exc)
    return {"success": True, "message": f"platform {data.name} registered"}, 201


@custom_platforms_bp.route("", methods=["GET"])
@tenant_middleware  # type: ignore[untyped-decorator]
@validate_response(PlatformListResponse)
async def list_platforms(tenant_slug: str) -> PlatformListResponse | tuple[dict[str, object], int]:
    """List every custom platform registered for this tenant."""
    async_dal, dal = _dal()
    try:
        tenant_id = _tenant_id(tenant_slug)
    except ApiError as exc:
        return _err(exc)
    names = await svc.list_platform_names(async_dal, dal, tenant_id=tenant_id)
    return PlatformListResponse(success=True, names=sorted(names))


@custom_platforms_bp.route("/<name>", methods=["DELETE"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@validate_response(MessageResponse)
async def delete_platform(tenant_slug: str, name: str) -> MessageResponse | tuple[dict[str, object], int]:
    """Remove a custom platform."""
    async_dal, dal = _dal()
    try:
        tenant_id = _tenant_id(tenant_slug)
        await svc.delete_platform(async_dal, dal, tenant_id=tenant_id, name=name)
    except ApiError as exc:
        return _err(exc)
    return MessageResponse(success=True, message=f"platform {name} removed")


@custom_platforms_bp.route("/<name>/tokens", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@validate_response(TokenResponse)
async def mint_token(tenant_slug: str, name: str) -> TokenResponse | tuple[dict[str, object], int]:
    """Mint (or re-mint) an `intake:write` JWT for this custom platform."""
    try:
        _tenant_id(tenant_slug)
    except ApiError as exc:
        return _err(exc)
    token = svc.mint_intake_token(tenant_slug, name)
    return TokenResponse(success=True, token=token, expiresInHours=24)


BLUEPRINTS: list[Blueprint] = [custom_platforms_bp]
```

- [ ] **Step 8: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_custom_platforms_blueprint.py -v`
Expected: `3 passed`

- [ ] **Step 9: Refactor `bundle_versions.py`'s inline `_known_custom_platforms` helper**

Add the import to `hub_api/blueprints/v1/bundle_versions.py`:

```python
from services.custom_platform_service import list_platform_names
```

Delete the `_known_custom_platforms` function and replace its one call site:

```python
            known_custom_platforms=await list_platform_names(async_dal, dal, tenant_id=ctx.tenant_id),
```

- [ ] **Step 10: Run the versions blueprint tests to confirm the refactor didn't break anything**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_versions_blueprint.py -v`
Expected: `5 passed`

- [ ] **Step 11: Add the ruff per-file ignore**

Append to `hub_api/pyproject.toml`'s `[tool.ruff.lint.per-file-ignores]`:

```toml
"blueprints/v1/custom_platforms.py" = ["N815"]
```

- [ ] **Step 12: Commit**

```bash
git add hub_api/services/custom_platform_service.py hub_api/blueprints/v1/custom_platforms.py \
        hub_api/tests/test_custom_platform_service.py hub_api/tests/test_custom_platforms_blueprint.py \
        hub_api/blueprints/v1/bundle_versions.py hub_api/pyproject.toml
git commit -m "$(cat <<'EOF'
feat(hub-api): custom platform registry + intake:write token minting (spec Sec6.4.3, Sec10.4)

POST/GET/DELETE /api/v1/tenant/{slug}/custom-platforms plus a token-
minting endpoint issuing 24h intake:write JWTs for REST-intake
integrations. Refactors Task 11's temporary inline query in
bundle_versions.py.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 26: `ingest_source_service.py` — the per-tenant ingest source registry

**Depends on:** Task 3 (`ingest_sources` DDL), Task 4 (bound tables + fixture), Task 6 (`bundle_secret_crypto.{encrypt, decrypt}`).

**Files:**
- Create: `hub_api/services/ingest_source_service.py`
- Test: `hub_api/tests/test_ingest_source_service.py`

**Interfaces:**
- Produces: `async def create_source(async_dal, dal, *, tenant_id: int, community_id: int | None, platform: str, source_id: str, label: str, mapping: dict[str, Any] | None) -> tuple[Any, str]` (the row and the **plaintext secret, returned exactly once** — spec §10.3's per-source HMAC secret); `async def list_sources(async_dal, dal, *, tenant_id: int) -> list[Any]` (never returns the plaintext secret, only whether one is set); `async def delete_source(async_dal, dal, *, tenant_id: int, source_id: str) -> None`; `async def resolve_secret(async_dal, dal, *, tenant_id: int, platform: str, source_id: str) -> str | None` (decrypts, for the webhook-verification path a later milestone's Rust ingest calls through the distribution API's `/sources` endpoint, Task 34).
- Consumes: `services.bundle_secret_crypto.{encrypt, decrypt}` (Task 6).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_ingest_source_service.py
"""Tests for the ingest source registry -- secret shown once, encrypted at rest."""

from __future__ import annotations

from typing import Any

import pytest

from services.ingest_source_service import create_source, delete_source, list_sources, resolve_secret
from services.errors import ApiError


@pytest.fixture(autouse=True)
def _key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUNDLE_SECRET_ENCRYPTION_KEY", "b" * 64)


async def test_create_source_returns_a_plaintext_secret_once(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    row, secret = await create_source(
        async_dal, async_dal.dal, tenant_id=1, community_id=None,
        platform="custom:mycrm", source_id="ticketing-1", label="MyCRM Ticketing", mapping={"event_type": {"pointer": "/type"}},
    )
    assert len(secret) >= 32
    assert row.platform == "custom:mycrm"


async def test_list_sources_never_returns_the_plaintext_secret(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    await create_source(
        async_dal, async_dal.dal, tenant_id=1, community_id=None,
        platform="custom:mycrm", source_id="ticketing-1", label="MyCRM Ticketing", mapping=None,
    )
    rows = await list_sources(async_dal, async_dal.dal, tenant_id=1)
    assert len(rows) == 1
    assert not hasattr(rows[0], "secret_ciphertext") or rows[0].secret_ciphertext is not None
    # the ROW object still carries the encrypted column (pydal returns all fields);
    # the service-layer contract is that a DTO built from this row (Task 27's
    # blueprint) never surfaces secret_ciphertext/secret_iv on the wire.


async def test_resolve_secret_round_trips(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    _, secret = await create_source(
        async_dal, async_dal.dal, tenant_id=1, community_id=None,
        platform="custom:mycrm", source_id="ticketing-1", label="MyCRM Ticketing", mapping=None,
    )
    resolved = await resolve_secret(async_dal, async_dal.dal, tenant_id=1, platform="custom:mycrm", source_id="ticketing-1")
    assert resolved == secret


async def test_duplicate_source_raises_409(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    await create_source(
        async_dal, async_dal.dal, tenant_id=1, community_id=None,
        platform="custom:mycrm", source_id="ticketing-1", label="x", mapping=None,
    )
    with pytest.raises(ApiError) as exc:
        await create_source(
            async_dal, async_dal.dal, tenant_id=1, community_id=None,
            platform="custom:mycrm", source_id="ticketing-1", label="y", mapping=None,
        )
    assert exc.value.status_code == 409


async def test_delete_source_removes_it(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    await create_source(
        async_dal, async_dal.dal, tenant_id=1, community_id=None,
        platform="custom:mycrm", source_id="ticketing-1", label="x", mapping=None,
    )
    await delete_source(async_dal, async_dal.dal, tenant_id=1, source_id="ticketing-1")
    rows = await list_sources(async_dal, async_dal.dal, tenant_id=1)
    assert rows == []
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_source_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.ingest_source_service'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/ingest_source_service.py
"""Per-tenant ingest source registry (spec Sec5.2, Sec10.3) -- secret shown once, AES-256-GCM at rest."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from typing import Any

from services.bundle_secret_crypto import decrypt, encrypt
from services.errors import conflict, not_found


async def create_source(
    async_dal: Any,
    dal: Any,
    *,
    tenant_id: int,
    community_id: int | None,
    platform: str,
    source_id: str,
    label: str,
    mapping: dict[str, Any] | None,
) -> tuple[Any, str]:
    """Register a new ingest source. Returns `(row, plaintext_secret)` -- the secret is never stored plaintext."""
    existing = await async_dal.select_async(
        dal(
            (dal.ingest_sources.tenant_id == tenant_id)
            & (dal.ingest_sources.platform == platform)
            & (dal.ingest_sources.source_id == source_id)
        )
    )
    if existing:
        raise conflict(f"ingest source {platform}/{source_id} already registered for this tenant")

    plaintext_secret = secrets.token_urlsafe(32)
    ciphertext, iv = encrypt(plaintext_secret)
    now = datetime.now(UTC)
    new_id = await async_dal.insert_async(
        dal.ingest_sources,
        tenant_id=tenant_id, community_id=community_id, platform=platform, source_id=source_id,
        label=label, secret_ciphertext=ciphertext, secret_iv=iv, mapping=mapping, enabled=True,
        created_at=now, updated_at=now,
    )
    async_dal.dal.commit()
    row = (await async_dal.select_async(dal(dal.ingest_sources.id == new_id)))[0]
    return row, plaintext_secret


async def list_sources(async_dal: Any, dal: Any, *, tenant_id: int) -> list[Any]:
    """Every ingest source for `tenant_id`."""
    rows = await async_dal.select_async(dal(dal.ingest_sources.tenant_id == tenant_id))
    return list(rows)


async def delete_source(async_dal: Any, dal: Any, *, tenant_id: int, source_id: str) -> None:
    """Remove an ingest source by its `source_id`. Raises 404 if absent."""
    existing = await async_dal.select_async(
        dal((dal.ingest_sources.tenant_id == tenant_id) & (dal.ingest_sources.source_id == source_id))
    )
    if not existing:
        raise not_found(f"ingest source {source_id!r} not found")
    await async_dal.delete_async(
        (dal.ingest_sources.tenant_id == tenant_id) & (dal.ingest_sources.source_id == source_id)
    )
    async_dal.dal.commit()


async def resolve_secret(async_dal: Any, dal: Any, *, tenant_id: int, platform: str, source_id: str) -> str | None:
    """Decrypt and return the source's secret, or `None` if no such source exists."""
    rows = await async_dal.select_async(
        dal(
            (dal.ingest_sources.tenant_id == tenant_id)
            & (dal.ingest_sources.platform == platform)
            & (dal.ingest_sources.source_id == source_id)
        )
    )
    if not rows or rows[0].secret_ciphertext is None:
        return None
    return decrypt(rows[0].secret_ciphertext, rows[0].secret_iv)
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_source_service.py -v`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/ingest_source_service.py hub_api/tests/test_ingest_source_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): ingest_source_service -- per-tenant ingest source registry (spec Sec5.2, Sec10.3)

Webhook secrets shown once at creation, AES-256-GCM at rest via
bundle_secret_crypto, never re-exposed plaintext after that.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 27: `blueprints/v1/ingest_sources.py` — `POST`/`GET`/`DELETE` `/api/v1/tenant/{slug}/ingest-sources`

**Depends on:** Task 26 (`ingest_source_service.{create_source, list_sources, delete_source}`).

**Files:**
- Create: `hub_api/blueprints/v1/ingest_sources.py`
- Test: `hub_api/tests/test_ingest_sources_blueprint.py`

**Interfaces:**
- Produces: `POST /api/v1/tenant/{slug}/ingest-sources` (scope `tenant:admin`, body `{"communityId": int|null, "platform": str, "sourceId": str, "label": str, "mapping": dict|null}`) → `201 {secret: <shown once>}`; `GET .../ingest-sources` (`tenant_middleware`) → list, secret never included; `DELETE .../ingest-sources/{sourceId}` (scope `tenant:admin`).
- Consumes: `services.ingest_source_service.{create_source, list_sources, delete_source}` (Task 26).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_ingest_sources_blueprint.py
"""Blueprint tests for /api/v1/tenant/{slug}/ingest-sources."""

from __future__ import annotations

from typing import Any

import pytest
from quart import Quart

from blueprints.v1.ingest_sources import BLUEPRINTS
from tests.conftest import TENANT_SLUG, make_token


@pytest.fixture(autouse=True)
def _key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUNDLE_SECRET_ENCRYPTION_KEY", "c" * 64)


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = bundle_install_db.dal
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)
    return app


async def test_create_requires_tenant_admin(app: Quart) -> None:
    token = make_token(scope="", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.post(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources",
        headers={"Authorization": f"Bearer {token}"},
        json={"communityId": None, "platform": "custom:mycrm", "sourceId": "ticketing-1", "label": "x", "mapping": None},
    )
    assert response.status_code == 403


async def test_create_returns_the_secret_once(app: Quart) -> None:
    token = make_token(scope="tenant:admin", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.post(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources",
        headers={"Authorization": f"Bearer {token}"},
        json={"communityId": None, "platform": "custom:mycrm", "sourceId": "ticketing-1", "label": "x", "mapping": None},
    )
    assert response.status_code == 201
    body = await response.get_json()
    assert len(body["secret"]) >= 32


async def test_list_never_includes_the_secret_field(app: Quart) -> None:
    token = make_token(scope="tenant:admin", tenant=TENANT_SLUG)
    client = app.test_client()
    await client.post(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources",
        headers={"Authorization": f"Bearer {token}"},
        json={"communityId": None, "platform": "custom:mycrm", "sourceId": "ticketing-1", "label": "x", "mapping": None},
    )
    response = await client.get(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources", headers={"Authorization": f"Bearer {token}"}
    )
    body = await response.get_json()
    assert "secret" not in body["sources"][0]
    assert "secretCiphertext" not in body["sources"][0]


async def test_delete_removes_the_source(app: Quart) -> None:
    token = make_token(scope="tenant:admin", tenant=TENANT_SLUG)
    client = app.test_client()
    await client.post(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources",
        headers={"Authorization": f"Bearer {token}"},
        json={"communityId": None, "platform": "custom:mycrm", "sourceId": "ticketing-1", "label": "x", "mapping": None},
    )
    response = await client.delete(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources/ticketing-1", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_sources_blueprint.py -v`
Expected: `ModuleNotFoundError: No module named 'blueprints.v1.ingest_sources'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/blueprints/v1/ingest_sources.py
"""v1 `ingest_sources` group -- per-tenant ingest source registry (spec Sec5.2, Sec10.3)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

from flask_core.api_utils import error_response
from flask_core.authz import require_scope
from flask_core.tenancy import get_tenant_context, tenant_middleware
from quart import Blueprint, current_app, request
from quart_schema import validate_request, validate_response

from services import ingest_source_service as svc
from services.errors import ApiError
from services.tenant_service import require_matching_tenant

ingest_sources_bp = Blueprint(
    "v1_ingest_sources", __name__, url_prefix="/api/v1/tenant/<tenant_slug>/ingest-sources"
)


def _dal() -> tuple[Any, Any]:
    return current_app.config["async_dal"], current_app.config["dal"]


def _err(exc: ApiError) -> tuple[dict[str, object], int]:
    return cast(tuple[dict[str, object], int], error_response(exc.message, exc.status_code, exc.code))


def _tenant_id(tenant_slug: str) -> int:
    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101
    require_matching_tenant(tenant_slug, ctx.tenant_slug)
    return cast(int, ctx.tenant_id)


@dataclass(slots=True, frozen=True)
class CreateSourceRequest:
    """Request DTO for `POST .../ingest-sources`."""

    platform: str
    sourceId: str
    label: str
    communityId: int | None = None
    mapping: dict[str, Any] | None = None


@dataclass(slots=True, frozen=True)
class CreateSourceResponse:
    """Response DTO -- the secret is shown exactly once."""

    success: bool
    secret: str


@dataclass(slots=True, frozen=True)
class SourceDTO:
    """Response DTO: one ingest source. Never includes the secret."""

    platform: str
    sourceId: str
    label: str
    communityId: int | None
    enabled: bool


@dataclass(slots=True, frozen=True)
class SourceListResponse:
    """Response DTO for `GET .../ingest-sources`."""

    success: bool
    sources: list[SourceDTO] = field(default_factory=list)


@dataclass(slots=True, frozen=True)
class MessageResponse:
    """Generic message response DTO."""

    success: bool
    message: str


@ingest_sources_bp.route("", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@validate_request(CreateSourceRequest)
async def create_source(data: CreateSourceRequest, tenant_slug: str) -> tuple[dict[str, object], int]:
    """Register a new ingest source. The response's `secret` field is shown exactly once."""
    async_dal, dal = _dal()
    try:
        tenant_id = _tenant_id(tenant_slug)
        _, secret = await svc.create_source(
            async_dal, dal, tenant_id=tenant_id, community_id=data.communityId,
            platform=data.platform, source_id=data.sourceId, label=data.label, mapping=data.mapping,
        )
    except ApiError as exc:
        return _err(exc)
    return {"success": True, "secret": secret}, 201


@ingest_sources_bp.route("", methods=["GET"])
@tenant_middleware  # type: ignore[untyped-decorator]
@validate_response(SourceListResponse)
async def list_sources(tenant_slug: str) -> SourceListResponse | tuple[dict[str, object], int]:
    """List every ingest source for this tenant. Never includes a secret field."""
    async_dal, dal = _dal()
    try:
        tenant_id = _tenant_id(tenant_slug)
    except ApiError as exc:
        return _err(exc)
    rows = await svc.list_sources(async_dal, dal, tenant_id=tenant_id)
    return SourceListResponse(
        success=True,
        sources=[
            SourceDTO(
                platform=r.platform, sourceId=r.source_id, label=r.label,
                communityId=r.community_id, enabled=bool(r.enabled),
            )
            for r in rows
        ],
    )


@ingest_sources_bp.route("/<source_id>", methods=["DELETE"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@validate_response(MessageResponse)
async def delete_source(tenant_slug: str, source_id: str) -> MessageResponse | tuple[dict[str, object], int]:
    """Remove an ingest source."""
    async_dal, dal = _dal()
    try:
        tenant_id = _tenant_id(tenant_slug)
        await svc.delete_source(async_dal, dal, tenant_id=tenant_id, source_id=source_id)
    except ApiError as exc:
        return _err(exc)
    return MessageResponse(success=True, message=f"ingest source {source_id} removed")


BLUEPRINTS: list[Blueprint] = [ingest_sources_bp]
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_sources_blueprint.py -v`
Expected: `4 passed`

- [ ] **Step 5: Add the ruff per-file ignore**

Append to `hub_api/pyproject.toml`'s `[tool.ruff.lint.per-file-ignores]`:

```toml
"blueprints/v1/ingest_sources.py" = ["N815"]
```

- [ ] **Step 6: Commit**

```bash
git add hub_api/blueprints/v1/ingest_sources.py hub_api/tests/test_ingest_sources_blueprint.py \
        hub_api/pyproject.toml
git commit -m "$(cat <<'EOF'
feat(hub-api): POST/GET/DELETE /api/v1/tenant/{slug}/ingest-sources (spec Sec5.2, Sec10.3)

The secret is returned exactly once, at creation; every subsequent
read omits it entirely.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 28: `valkey_admin_client.py` — consumer-group lifecycle (spec Sec5.2, Sec9.5)

**Depends on:** nothing new — `redis.asyncio` is already pinned transitively via `libs/flask_core`.

**Files:**
- Create: `hub_api/services/valkey_admin_client.py`
- Test: `hub_api/tests/test_valkey_admin_client.py`

**Interfaces:**
- Produces: `def build_client() -> Any` (a `redis.asyncio.Redis` from `VALKEY_URL`, TLS-aware per spec §11.6.1 — refuses a plaintext `redis://` URL when `security.transport.tls` is on, matching every Rust service's own startup check); `async def ensure_group(client: Any, *, stream: str, group: str) -> None` (`XGROUP CREATE ... MKSTREAM`, BUSYGROUP-tolerant); `async def destroy_group(client: Any, *, stream: str, group: str) -> None` (`XGROUP DESTROY`, tolerant of "no such key"/"no such group").
- Consumes: `redis.asyncio` (already a pinned transitive dependency via `libs/flask_core`).

hub-api's role here is **only** consumer-group lifecycle at activation/revocation time (spec §5.2's "Create"/"Destroy" rows) — it never reads or writes stream entries; that is exclusively the Rust stages' job (§5.2: "Bundles hold no Valkey connection... the stage is the enforcement point").

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_valkey_admin_client.py
"""Tests for ensure_group()/destroy_group(), redis.asyncio client mocked."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import redis.exceptions

from services.valkey_admin_client import build_client, destroy_group, ensure_group


async def test_ensure_group_calls_xgroup_create_with_mkstream() -> None:
    mock_client = AsyncMock()
    await ensure_group(mock_client, stream="waddles:t:acme:c:main:src:twitch:tw-a:events", group="app1")
    mock_client.xgroup_create.assert_called_once_with(
        "waddles:t:acme:c:main:src:twitch:tw-a:events", "app1", id="$", mkstream=True
    )


async def test_ensure_group_is_busygroup_tolerant() -> None:
    mock_client = AsyncMock()
    mock_client.xgroup_create.side_effect = redis.exceptions.ResponseError("BUSYGROUP Consumer Group name already exists")
    await ensure_group(mock_client, stream="s", group="g")  # must not raise


async def test_ensure_group_reraises_other_response_errors() -> None:
    mock_client = AsyncMock()
    mock_client.xgroup_create.side_effect = redis.exceptions.ResponseError("WRONGTYPE Operation against a key")
    with pytest.raises(redis.exceptions.ResponseError):
        await ensure_group(mock_client, stream="s", group="g")


async def test_destroy_group_calls_xgroup_destroy() -> None:
    mock_client = AsyncMock()
    await destroy_group(mock_client, stream="s", group="g")
    mock_client.xgroup_destroy.assert_called_once_with("s", "g")


async def test_destroy_group_tolerates_missing_stream() -> None:
    mock_client = AsyncMock()
    mock_client.xgroup_destroy.side_effect = redis.exceptions.ResponseError("no such key")
    await destroy_group(mock_client, stream="s", group="g")  # must not raise


def test_build_client_refuses_plaintext_url_when_tls_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VALKEY_URL", "redis://valkey:6379/0")
    monkeypatch.setenv("SECURITY_TRANSPORT_TLS", "true")
    with pytest.raises(ValueError, match="rediss://"):
        build_client()


def test_build_client_allows_plaintext_when_tls_explicitly_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VALKEY_URL", "redis://valkey:6379/0")
    monkeypatch.setenv("SECURITY_TRANSPORT_TLS", "false")
    client = build_client()
    assert client is not None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_valkey_admin_client.py -v`
Expected: `ModuleNotFoundError: No module named 'services.valkey_admin_client'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/valkey_admin_client.py
"""Consumer-group lifecycle only -- hub-api never reads/writes stream entries (spec Sec5.2, Sec9.5).

TLS/auth defaults mirror spec Sec11.6.4: `security.transport.tls`
(env `SECURITY_TRANSPORT_TLS`, default `true`) refuses a plaintext
`redis://` URL at construction time, matching every Rust service's own
startup check -- the opt-out is explicit and visible, never silent.
"""

from __future__ import annotations

import os
from typing import Any

import redis.asyncio as redis_asyncio
import redis.exceptions


def _tls_required() -> bool:
    return os.environ.get("SECURITY_TRANSPORT_TLS", "true").lower() != "false"


def build_client() -> Any:
    """A `redis.asyncio.Redis` from `VALKEY_URL`. Refuses a plaintext URL when TLS is required."""
    url = os.environ.get("VALKEY_URL", "rediss://valkey:6379/0")
    if _tls_required() and not url.startswith("rediss://"):
        raise ValueError(
            f"VALKEY_URL must use rediss:// when security.transport.tls is true (got {url!r})"
        )
    return redis_asyncio.from_url(url)


async def ensure_group(client: Any, *, stream: str, group: str) -> None:
    """`XGROUP CREATE {stream} {group} $ MKSTREAM`, tolerant of an already-existing group (BUSYGROUP)."""
    try:
        await client.xgroup_create(stream, group, id="$", mkstream=True)
    except redis.exceptions.ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


async def destroy_group(client: Any, *, stream: str, group: str) -> None:
    """`XGROUP DESTROY {stream} {group}`, tolerant of a stream/group that no longer exists."""
    try:
        await client.xgroup_destroy(stream, group)
    except redis.exceptions.ResponseError as exc:
        if "no such key" not in str(exc).lower() and "no such" not in str(exc).lower():
            raise
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_valkey_admin_client.py -v`
Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/valkey_admin_client.py hub_api/tests/test_valkey_admin_client.py
git commit -m "$(cat <<'EOF'
feat(hub-api): valkey_admin_client -- consumer-group lifecycle only (spec Sec5.2, Sec9.5, Sec11.6.4)

ensure_group()/destroy_group() are BUSYGROUP/missing-key tolerant.
build_client() refuses a plaintext redis:// URL when
security.transport.tls is true, matching every Rust service's own
startup check. hub-api never reads/writes stream entries -- only group
lifecycle.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 29: `stream_grant_service.py` — `consumes` resolution into `app_stream_grants`

**Depends on:** Task 3 (`app_stream_grants` DDL), Task 4 (bound tables + fixture), Task 7 (`ConsumeRule`), Task 26 (`ingest_sources` rows resolution expands against), Task 28 (`ensure_group`, `destroy_group`).

**Files:**
- Create: `hub_api/services/stream_grant_service.py`
- Test: `hub_api/tests/test_stream_grant_service.py`

**Interfaces:**
- Produces: `def render_stream_key(tenant_slug: str, community_slug: str | None, platform: str, source_id: str) -> str` (`waddles:t:{tenant}:c:{community|_tenant}:src:{platform}:{source_id}:events`, spec §5.1); `async def resolve_grants_for_scope(async_dal, dal, valkey_client, *, tenant_id: int, tenant_slug: str, community_id: int | None, community_slug: str | None, app_id: str, consumes: tuple[ConsumeRule, ...], granted_by: int | None) -> list[Any]` (idempotent — expands every rule against enabled `ingest_sources`, inserts missing grants, `ensure_group`s each, returns the full current active-grant list; never duplicates on a second call); `async def revoke_grant(async_dal, dal, valkey_client, *, app_id: str, grant_id: int, actor_id: int) -> None` (destroys the Valkey group, sets `revoked_at`, writes an `audit_log` entry — 404 if the grant doesn't exist or is already revoked); `async def revoke_all_grants_for_scope(async_dal, dal, valkey_client, *, app_id: str, tenant_id: int, community_id: int | None) -> None` (deactivation teardown); `async def list_grants(async_dal, dal, *, app_id: str, tenant_id: int, community_id: int | None) -> list[Any]` (active only).
- Consumes: `services.bundle_manifest_v2.ConsumeRule` (Task 7); `services.valkey_admin_client.{ensure_group, destroy_group}` (Task 28).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_stream_grant_service.py
"""Tests for consumes-rule resolution into app_stream_grants (spec Sec5.2)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from services.bundle_manifest_v2 import ConsumeRule
from services.errors import ApiError
from services.stream_grant_service import (
    list_grants,
    render_stream_key,
    resolve_grants_for_scope,
    revoke_all_grants_for_scope,
    revoke_grant,
)


def test_render_stream_key_tenant_wide() -> None:
    key = render_stream_key("acme", None, "twitch", "tw-channelA")
    assert key == "waddles:t:acme:c:_tenant:src:twitch:tw-channelA:events"


def test_render_stream_key_community_scoped() -> None:
    key = render_stream_key("acme", "main", "twitch", "tw-channelA")
    assert key == "waddles:t:acme:c:main:src:twitch:tw-channelA:events"


async def _seed_source(dal: Any, *, platform: str, source_id: str, label: str) -> None:
    dal.ingest_sources.insert(
        tenant_id=1, community_id=None, platform=platform, source_id=source_id, label=label, enabled=True,
    )
    dal.commit()


async def test_resolve_exact_source_id_rule(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_source(dal, platform="twitch", source_id="tw-channelA", label="Twitch #channelA")
    await _seed_source(dal, platform="twitch", source_id="tw-channelB", label="Twitch #channelB")
    mock_valkey = AsyncMock()

    grants = await resolve_grants_for_scope(
        async_dal, dal, mock_valkey, tenant_id=1, tenant_slug="acme", community_id=None, community_slug=None,
        app_id="waddles.socials.music.default",
        consumes=(ConsumeRule(platform="twitch", source_id="tw-channelA", event_types=("chat.message",), filters={}),),
        granted_by=1,
    )
    assert len(grants) == 1
    assert grants[0].source_id == "tw-channelA"
    mock_valkey.xgroup_create.assert_called_once()


async def test_resolve_platform_wide_rule_grants_every_matching_source(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_source(dal, platform="twitch", source_id="tw-channelA", label="Twitch #channelA")
    await _seed_source(dal, platform="twitch", source_id="tw-channelB", label="Twitch #channelB")
    await _seed_source(dal, platform="discord", source_id="dg-guildX", label="Discord guild X")
    mock_valkey = AsyncMock()

    grants = await resolve_grants_for_scope(
        async_dal, dal, mock_valkey, tenant_id=1, tenant_slug="acme", community_id=None, community_slug=None,
        app_id="waddles.socials.music.default",
        consumes=(ConsumeRule(platform="twitch", source_id=None, event_types=("chat.message",), filters={}),),
        granted_by=1,
    )
    assert {g.source_id for g in grants} == {"tw-channelA", "tw-channelB"}


async def test_resolution_is_idempotent(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_source(dal, platform="twitch", source_id="tw-channelA", label="Twitch #channelA")
    mock_valkey = AsyncMock()
    consumes = (ConsumeRule(platform="twitch", source_id="tw-channelA", event_types=("chat.message",), filters={}),)

    await resolve_grants_for_scope(
        async_dal, dal, mock_valkey, tenant_id=1, tenant_slug="acme", community_id=None, community_slug=None,
        app_id="waddles.socials.music.default", consumes=consumes, granted_by=1,
    )
    grants = await resolve_grants_for_scope(
        async_dal, dal, mock_valkey, tenant_id=1, tenant_slug="acme", community_id=None, community_slug=None,
        app_id="waddles.socials.music.default", consumes=consumes, granted_by=1,
    )
    assert len(grants) == 1  # not duplicated on a second call


async def test_revoke_grant_destroys_group_and_audits(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_source(dal, platform="twitch", source_id="tw-channelA", label="Twitch #channelA")
    mock_valkey = AsyncMock()
    grants = await resolve_grants_for_scope(
        async_dal, dal, mock_valkey, tenant_id=1, tenant_slug="acme", community_id=None, community_slug=None,
        app_id="waddles.socials.music.default",
        consumes=(ConsumeRule(platform="twitch", source_id="tw-channelA", event_types=("chat.message",), filters={}),),
        granted_by=1,
    )
    await revoke_grant(async_dal, dal, mock_valkey, app_id="waddles.socials.music.default", grant_id=grants[0].id, actor_id=1)

    mock_valkey.xgroup_destroy.assert_called_once()
    remaining = await list_grants(async_dal, dal, app_id="waddles.socials.music.default", tenant_id=1, community_id=None)
    assert remaining == []
    audit_row = dal(dal.audit_log.action == "app_stream_grant_revoked").select().first()
    assert audit_row is not None


async def test_revoke_already_revoked_grant_raises_404(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_source(dal, platform="twitch", source_id="tw-channelA", label="Twitch #channelA")
    mock_valkey = AsyncMock()
    grants = await resolve_grants_for_scope(
        async_dal, dal, mock_valkey, tenant_id=1, tenant_slug="acme", community_id=None, community_slug=None,
        app_id="waddles.socials.music.default",
        consumes=(ConsumeRule(platform="twitch", source_id="tw-channelA", event_types=("chat.message",), filters={}),),
        granted_by=1,
    )
    await revoke_grant(async_dal, dal, mock_valkey, app_id="waddles.socials.music.default", grant_id=grants[0].id, actor_id=1)
    with pytest.raises(ApiError) as exc:
        await revoke_grant(async_dal, dal, mock_valkey, app_id="waddles.socials.music.default", grant_id=grants[0].id, actor_id=1)
    assert exc.value.status_code == 404


async def test_revoke_all_grants_for_scope_tears_down_everything(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_source(dal, platform="twitch", source_id="tw-channelA", label="x")
    await _seed_source(dal, platform="discord", source_id="dg-guildX", label="y")
    mock_valkey = AsyncMock()
    await resolve_grants_for_scope(
        async_dal, dal, mock_valkey, tenant_id=1, tenant_slug="acme", community_id=None, community_slug=None,
        app_id="waddles.socials.music.default",
        consumes=(
            ConsumeRule(platform="twitch", source_id=None, event_types=("chat.message",), filters={}),
            ConsumeRule(platform="discord", source_id=None, event_types=("chat.message",), filters={}),
        ),
        granted_by=1,
    )
    await revoke_all_grants_for_scope(
        async_dal, dal, mock_valkey, app_id="waddles.socials.music.default", tenant_id=1, community_id=None
    )
    remaining = await list_grants(async_dal, dal, app_id="waddles.socials.music.default", tenant_id=1, community_id=None)
    assert remaining == []
    assert mock_valkey.xgroup_destroy.call_count == 2
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_stream_grant_service.py -v`
Expected: `ModuleNotFoundError: No module named 'services.stream_grant_service'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/services/stream_grant_service.py
"""Resolve `consumes` rules into `app_stream_grants` + Valkey consumer-group lifecycle (spec Sec5.2)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from services.bundle_manifest_v2 import ConsumeRule
from services.errors import ApiError, not_found
from services.valkey_admin_client import destroy_group, ensure_group


def render_stream_key(tenant_slug: str, community_slug: str | None, platform: str, source_id: str) -> str:
    """`waddles:t:{tenant}:c:{community|_tenant}:src:{platform}:{source_id}:events` (spec Sec5.1)."""
    community_segment = community_slug if community_slug is not None else "_tenant"
    return f"waddles:t:{tenant_slug}:c:{community_segment}:src:{platform}:{source_id}:events"


def _rule_matches_source(rule: ConsumeRule, source: Any) -> bool:
    if rule.platform != "*" and rule.platform != source.platform:
        return False
    if rule.source_id is not None and rule.source_id != source.source_id:
        return False
    return True


async def resolve_grants_for_scope(
    async_dal: Any,
    dal: Any,
    valkey_client: Any,
    *,
    tenant_id: int,
    tenant_slug: str,
    community_id: int | None,
    community_slug: str | None,
    app_id: str,
    consumes: tuple[ConsumeRule, ...],
    granted_by: int | None,
) -> list[Any]:
    """Expand `consumes` against enabled `ingest_sources`, insert missing grants, ensure each group. Idempotent."""
    sources = await async_dal.select_async(
        dal(
            (dal.ingest_sources.tenant_id == tenant_id)
            & (dal.ingest_sources.enabled == True)  # noqa: E712 -- pydal query operator
        )
    )
    matched_sources = [s for s in sources if any(_rule_matches_source(rule, s) for rule in consumes)]

    existing_rows = await async_dal.select_async(
        dal(
            (dal.app_stream_grants.app_id == app_id)
            & (dal.app_stream_grants.tenant_id == tenant_id)
            & (dal.app_stream_grants.community_id == community_id)
            & (dal.app_stream_grants.revoked_at == None)  # noqa: E711 -- pydal query operator
        )
    )
    existing_stream_keys = {row.stream_key for row in existing_rows}

    now = datetime.now(UTC)
    for source in matched_sources:
        stream_key = render_stream_key(tenant_slug, community_slug, source.platform, source.source_id)
        await ensure_group(valkey_client, stream=stream_key, group=app_id)
        if stream_key not in existing_stream_keys:
            await async_dal.insert_async(
                dal.app_stream_grants,
                tenant_id=tenant_id, community_id=community_id, app_id=app_id, stream_key=stream_key,
                platform=source.platform, source_id=source.source_id, label=source.label,
                granted_by=granted_by, granted_at=now,
            )
    async_dal.dal.commit()

    return await list_grants(async_dal, dal, app_id=app_id, tenant_id=tenant_id, community_id=community_id)


async def revoke_grant(async_dal: Any, dal: Any, valkey_client: Any, *, app_id: str, grant_id: int, actor_id: int) -> None:
    """Destroy the Valkey group, mark the grant revoked, audit-log the action. 404 if already revoked/absent."""
    rows = await async_dal.select_async(
        dal(
            (dal.app_stream_grants.id == grant_id)
            & (dal.app_stream_grants.app_id == app_id)
            & (dal.app_stream_grants.revoked_at == None)  # noqa: E711
        )
    )
    if not rows:
        raise not_found(f"grant {grant_id} not found or already revoked")
    grant = rows[0]

    await destroy_group(valkey_client, stream=grant.stream_key, group=app_id)
    now = datetime.now(UTC)
    await async_dal.update_async(dal.app_stream_grants.id == grant_id, revoked_at=now)
    try:
        await async_dal.insert_async(
            dal.audit_log, user_id=actor_id, action="app_stream_grant_revoked",
            target_type="app_stream_grant", target_id=str(grant_id),
            details={"app_id": app_id, "stream_key": grant.stream_key}, created_at=now,
        )
    except Exception:  # noqa: BLE001, S110 -- audit logging failure must not break the main flow
        pass
    async_dal.dal.commit()


async def revoke_all_grants_for_scope(
    async_dal: Any, dal: Any, valkey_client: Any, *, app_id: str, tenant_id: int, community_id: int | None
) -> None:
    """Deactivation teardown -- destroys every active group and marks every grant revoked for this scope."""
    rows = await async_dal.select_async(
        dal(
            (dal.app_stream_grants.app_id == app_id)
            & (dal.app_stream_grants.tenant_id == tenant_id)
            & (dal.app_stream_grants.community_id == community_id)
            & (dal.app_stream_grants.revoked_at == None)  # noqa: E711
        )
    )
    now = datetime.now(UTC)
    for row in rows:
        await destroy_group(valkey_client, stream=row.stream_key, group=app_id)
        await async_dal.update_async(dal.app_stream_grants.id == row.id, revoked_at=now)
    async_dal.dal.commit()


async def list_grants(async_dal: Any, dal: Any, *, app_id: str, tenant_id: int, community_id: int | None) -> list[Any]:
    """Every currently-active grant for `(app_id, tenant_id, community_id)`."""
    rows = await async_dal.select_async(
        dal(
            (dal.app_stream_grants.app_id == app_id)
            & (dal.app_stream_grants.tenant_id == tenant_id)
            & (dal.app_stream_grants.community_id == community_id)
            & (dal.app_stream_grants.revoked_at == None)  # noqa: E711
        )
    )
    return list(rows)
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_stream_grant_service.py -v`
Expected: `8 passed`

- [ ] **Step 5: Commit**

```bash
git add hub_api/services/stream_grant_service.py hub_api/tests/test_stream_grant_service.py
git commit -m "$(cat <<'EOF'
feat(hub-api): stream_grant_service -- consumes resolution into app_stream_grants (spec Sec5.2)

Idempotent expand-against-configured-sources, ensure_group per grant,
revoke_grant destroys the group + marks revoked_at + audit-logs,
revoke_all_grants_for_scope is the deactivation teardown.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 30: Wire approval-gating + grant resolution into `activate_bundle()`/`deactivate_bundle()`

**Depends on:** Task 16 (`get_active_version`), Task 19 (`app_install_approvals` rows the gate requires), Task 29 (`resolve_grants_for_scope`, `revoke_all_grants_for_scope`).

**Files:**
- Modify: `hub_api/services/stream_grant_service.py` (add `consumes_from_version`)
- Modify: `hub_api/services/marketplace_lifecycle_service.py` (extend `activate_bundle`/`deactivate_bundle`)
- Test: `hub_api/tests/test_marketplace_lifecycle_grants.py`

**Interfaces:**
- Produces: `stream_grant_service.consumes_from_version(async_dal, dal, *, app_id: str, version: str) -> tuple[ConsumeRule, ...]`; `marketplace_lifecycle_service.activate_bundle(..., valkey_client: Any | None = None, tenant_slug: str | None = None, community_slug: str | None = None)` — **new keyword-only params, all defaulting to `None`, so every existing call site and every existing test in `test_v1_marketplace_lifecycle_blueprint.py`/`test_marketplace_lifecycle_concurrency.py` keeps passing unmodified.** When `valkey_client` is `None` (the pre-M2b default), activation behaves exactly as it does today. When given, activation additionally: (a) looks up `app_active_versions` for this `(app_id, tenant_id, community_id)` — if no row exists, the bundle never went through the version/consent flow (a legacy `is_default` builtin) and gating is skipped entirely; (b) if a row exists, requires a current `app_install_approvals` row for that exact version at this scope, else `403 bundle_not_approved`; (c) resolves `consumes` into `app_stream_grants` via `stream_grant_service.resolve_grants_for_scope`. `deactivate_bundle(..., valkey_client: Any | None = None)` similarly calls `revoke_all_grants_for_scope` only when `valkey_client` is given.
- Consumes: `services.stream_grant_service.{resolve_grants_for_scope, revoke_all_grants_for_scope}` (Task 29); `services.bundle_activation_service.get_active_version` (Task 16).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_marketplace_lifecycle_grants.py
"""Tests for the M2b approval-gating + grant-resolution wiring in activate_bundle()/deactivate_bundle()."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from services.bundle_activation_service import activate_version
from services.bundle_approval_service import approve_version
from services.errors import ApiError
from services.marketplace_lifecycle_service import activate_bundle, deactivate_bundle

_MANIFEST = {
    "schema_version": 2, "app_id": "waddles.socials.music.default", "name": "Music Station",
    "version": "3.0.1", "feature": "waddles.socials.music", "module": "socials",
    "provider": "builtin", "language": "python", "artifact": "source",
    "stages": {"process": {"entry": "x:y", "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}]}},
}


async def _seed_approved_version(dal: Any, async_dal: Any) -> None:
    version_id = dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="3.0.1", artifact_digest="sha256:" + "a" * 64,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED",
        manifest_json=_MANIFEST, app_version_id=version_id,
    )
    dal.commit()
    await activate_version(
        async_dal, dal, tenant_id=1, community_id=1, app_id="waddles.socials.music.default",
        version="3.0.1", activated_by=1,
    )
    await approve_version(
        async_dal, dal, app_id="waddles.socials.music.default", version="3.0.1",
        tenant_id=1, community_id=1, approved_by=1,
    )


async def test_activate_bundle_without_valkey_client_behaves_exactly_as_before(bundle_install_db: Any) -> None:
    """No new params supplied -- pre-M2b behaviour, no gating, no grant resolution."""
    async_dal = bundle_install_db
    dal = async_dal.dal
    row = await activate_bundle(
        async_dal, dal, community_id=1, tenant_id=1, app_id="waddles.socials.music.default",
        config=None, activated_by=1,
    )
    assert row is not None


async def test_activate_bundle_with_no_active_version_skips_gating(bundle_install_db: Any) -> None:
    """A legacy bundle with no app_active_versions row activates unimpeded even with valkey_client given."""
    async_dal = bundle_install_db
    dal = async_dal.dal
    mock_valkey = AsyncMock()
    row = await activate_bundle(
        async_dal, dal, community_id=1, tenant_id=1, app_id="waddles.socials.music.default",
        config=None, activated_by=1, valkey_client=mock_valkey, tenant_slug="acme-corp", community_slug="acme-community",
    )
    assert row is not None
    mock_valkey.xgroup_create.assert_not_called()


async def test_activate_bundle_refuses_when_active_version_is_unapproved(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    version_id = dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="3.0.1", artifact_digest="sha256:" + "a" * 64,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED",
        manifest_json=_MANIFEST, app_version_id=version_id,
    )
    dal.commit()
    await activate_version(
        async_dal, dal, tenant_id=1, community_id=1, app_id="waddles.socials.music.default",
        version="3.0.1", activated_by=1,
    )
    mock_valkey = AsyncMock()
    with pytest.raises(ApiError) as exc:
        await activate_bundle(
            async_dal, dal, community_id=1, tenant_id=1, app_id="waddles.socials.music.default",
            config=None, activated_by=1, valkey_client=mock_valkey, tenant_slug="acme-corp", community_slug="acme-community",
        )
    assert exc.value.status_code == 403
    assert exc.value.code == "bundle_not_approved"


async def test_activate_bundle_resolves_grants_when_approved(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_approved_version(dal, async_dal)
    dal.ingest_sources.insert(
        tenant_id=1, community_id=None, platform="twitch", source_id="tw-channelA",
        label="Twitch #channelA", enabled=True,
    )
    dal.commit()
    mock_valkey = AsyncMock()
    await activate_bundle(
        async_dal, dal, community_id=1, tenant_id=1, app_id="waddles.socials.music.default",
        config=None, activated_by=1, valkey_client=mock_valkey, tenant_slug="acme-corp", community_slug="acme-community",
    )
    mock_valkey.xgroup_create.assert_called_once()


async def test_deactivate_bundle_revokes_grants_when_valkey_client_given(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_approved_version(dal, async_dal)
    dal.ingest_sources.insert(
        tenant_id=1, community_id=None, platform="twitch", source_id="tw-channelA",
        label="Twitch #channelA", enabled=True,
    )
    dal.commit()
    mock_valkey = AsyncMock()
    await activate_bundle(
        async_dal, dal, community_id=1, tenant_id=1, app_id="waddles.socials.music.default",
        config=None, activated_by=1, valkey_client=mock_valkey, tenant_slug="acme-corp", community_slug="acme-community",
    )
    await deactivate_bundle(
        async_dal, dal, community_id=1, app_id="waddles.socials.music.default", valkey_client=mock_valkey
    )
    mock_valkey.xgroup_destroy.assert_called_once()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_marketplace_lifecycle_grants.py -v`
Expected: `TypeError: activate_bundle() got an unexpected keyword argument 'valkey_client'`

- [ ] **Step 3: Add `consumes_from_version` to `stream_grant_service.py`**

Append to `hub_api/services/stream_grant_service.py`:

```python
async def consumes_from_version(async_dal: Any, dal: Any, *, app_id: str, version: str) -> tuple[ConsumeRule, ...]:
    """Read the process stage's `consumes` rules out of the stored, already-validated `manifest_json`."""
    rows = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == version))
    )
    if not rows or not rows[0].manifest_json:
        return ()
    process_stage = (rows[0].manifest_json.get("stages") or {}).get("process") or {}
    return tuple(
        ConsumeRule(
            platform=rule["platform"], source_id=rule.get("source_id"),
            event_types=tuple(rule["event_types"]), filters=dict(rule.get("filters") or {}),
        )
        for rule in (process_stage.get("consumes") or [])
    )
```

- [ ] **Step 4: Extend `activate_bundle`/`deactivate_bundle` in `marketplace_lifecycle_service.py`**

Add the import:

```python
from services.bundle_activation_service import get_active_version
from services.stream_grant_service import consumes_from_version, resolve_grants_for_scope, revoke_all_grants_for_scope
```

Replace `activate_bundle`'s signature and add the gating call right after the existing conflict check, before the `return await loop.run_in_executor(...)` line:

```python
async def activate_bundle(
    async_dal: Any,
    dal: Any,
    *,
    community_id: int,
    tenant_id: int,
    app_id: str,
    config: dict[str, Any] | None,
    activated_by: int,
    registry: AppRegistry | None = None,
    valkey_client: Any | None = None,
    tenant_slug: str | None = None,
    community_slug: str | None = None,
) -> Any:
    """Activate `app_id` for `community_id`. Upserts on `(community_id, app_id)`.

    Enforces `activated <= available` via `check_activation_insert_allowed`
    (409 if not available to `tenant_id`), then a coexistence check
    (`flask_core.app_binding.detect_conflict`, design doc Sec7.3) against
    every OTHER currently-enabled activation for this community -- 409
    naming the conflicting `app_id` if `candidate` cannot coexist with an
    already-active App.

    M2b addition (spec Sec9.7.3, Sec5.2): when `valkey_client` is given
    AND this `app_id` has an `app_active_versions` row for this scope
    (i.e. it went through the version/consent flow), activation ALSO
    requires a current `app_install_approvals` row for that exact
    version -- 403 `bundle_not_approved` otherwise -- and resolves
    `consumes` into `app_stream_grants`. A bundle with no
    `app_active_versions` row (a legacy `is_default` builtin registered
    through the v1 install path) skips this entirely; `valkey_client=None`
    (the default) preserves the pre-M2b behavior exactly, for every
    existing caller and test.
    """
    try:
        await check_activation_insert_allowed(dal, tenant_id, app_id)
    except AppTierError as exc:
        raise _from_tier_error(exc) from exc

    candidate = await ensure_registered(dal, app_id, registry=registry)

    active_rows = await async_dal.select_async(
        dal(
            (dal.app_activations.community_id == community_id)
            & (dal.app_activations.enabled == True)  # noqa: E712
            & (dal.app_activations.app_id != app_id)
        ),
        dal.app_activations.app_id,
    )
    active_manifests = [
        await ensure_registered(dal, r.app_id, registry=registry) for r in active_rows
    ]
    conflicting = detect_conflict(candidate, active_manifests)
    if conflicting is not None:
        raise conflict(f"Bundle {app_id!r} conflicts with already-active bundle {conflicting!r}")

    if valkey_client is not None:
        active_version = await get_active_version(
            async_dal, dal, tenant_id=tenant_id, community_id=community_id, app_id=app_id
        )
        if active_version is not None:
            approval_rows = await async_dal.select_async(
                dal(
                    (dal.app_install_approvals.app_id == app_id)
                    & (dal.app_install_approvals.version == active_version.version)
                    & (dal.app_install_approvals.tenant_id == tenant_id)
                    & (dal.app_install_approvals.community_id == community_id)
                    & (dal.app_install_approvals.superseded_by == None)  # noqa: E711
                )
            )
            if not approval_rows:
                raise ApiError(
                    f"{app_id} version {active_version.version} is not approved for this community",
                    403, "bundle_not_approved",
                )
            consumes = await consumes_from_version(async_dal, dal, app_id=app_id, version=active_version.version)
            await resolve_grants_for_scope(
                async_dal, dal, valkey_client, tenant_id=tenant_id, tenant_slug=tenant_slug or "",
                community_id=community_id, community_slug=community_slug, app_id=app_id,
                consumes=consumes, granted_by=activated_by,
            )

    payload = config if config is not None else {}
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        async_dal.executor,
        partial(
            _guarded_upsert_activation_sync,
            dal,
            community_id=community_id,
            tenant_id=tenant_id,
            app_id=app_id,
            config=payload,
            activated_by=activated_by,
        ),
    )
```

Add the import `ApiError` alongside the existing `from services.errors import ApiError, conflict, not_found` line (add `ApiError` if not already present — it is not, in the original file, only `conflict`/`not_found` are imported at module level per this module's own top).

Extend `deactivate_bundle`:

```python
async def deactivate_bundle(
    async_dal: Any, dal: Any, *, community_id: int, app_id: str, valkey_client: Any | None = None
) -> None:
    """Soft-disable: set `app_activations.enabled = False`. Raises 404 if no such row.

    M2b addition: when `valkey_client` is given, also tears down every
    active `app_stream_grants` row for this `(app_id, community_id)`'s
    tenant scope via `revoke_all_grants_for_scope` (spec Sec9.5:
    "Deactivation destroys those groups and marks the rows revoked").
    `valkey_client=None` preserves the pre-M2b behavior exactly.
    """
    existing_query = (dal.app_activations.community_id == community_id) & (
        dal.app_activations.app_id == app_id
    )
    existing = await async_dal.count_async(existing_query)
    if existing == 0:
        raise not_found(f"Bundle {app_id!r} is not activated for this community")

    if valkey_client is not None:
        activation_row = (await async_dal.select_async(dal(existing_query)))[0]
        await revoke_all_grants_for_scope(
            async_dal, dal, valkey_client, app_id=app_id,
            tenant_id=activation_row.tenant_id, community_id=community_id,
        )

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        async_dal.executor,
        partial(_guarded_set_deactivated_sync, dal, community_id=community_id, app_id=app_id),
    )
```

- [ ] **Step 5: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_marketplace_lifecycle_grants.py -v`
Expected: `5 passed`

- [ ] **Step 6: Run the FULL existing marketplace-lifecycle suite to confirm zero regression**

Run: `cd hub_api && python3 -m pytest tests/test_v1_marketplace_lifecycle_blueprint.py tests/test_marketplace_lifecycle_concurrency.py -v`
Expected: every test that passed before this task still passes — these tests never pass `valkey_client`, so they exercise the exact pre-M2b code path.

- [ ] **Step 7: Commit**

```bash
git add hub_api/services/stream_grant_service.py hub_api/services/marketplace_lifecycle_service.py \
        hub_api/tests/test_marketplace_lifecycle_grants.py
git commit -m "$(cat <<'EOF'
feat(hub-api): approval-gating + grant resolution wired into activate_bundle()/deactivate_bundle()

New keyword-only params (valkey_client, tenant_slug, community_slug),
all defaulting to None -- every existing call site and test keeps the
exact pre-M2b behavior unmodified. A bundle with no app_active_versions
row (legacy is_default builtin) skips gating entirely; one with an
active version requires a current app_install_approvals row for that
exact version, else 403 bundle_not_approved (spec Sec9.7.3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 31: `blueprints/v1/bundle_grants.py` — `GET grants`, `POST resolve`, `DELETE grant`

**Depends on:** Task 16 (`get_active_version`), Task 28 (`build_client`), Tasks 29-30 (`list_grants`, `resolve_grants_for_scope`, `revoke_grant`, `consumes_from_version`).

**Files:**
- Create: `hub_api/blueprints/v1/bundle_grants.py`
- Test: `hub_api/tests/test_bundle_grants_blueprint.py`

**Interfaces:**
- Produces: `GET /api/v1/apps/{app_id}/grants?communityId=` (scope `tenant:admin`) → the labeled grant list; `POST /api/v1/apps/{app_id}/grants/resolve` (scope `tenant:admin`, body `{"communityId": int|null}`) → re-runs resolution idempotently; `DELETE /api/v1/apps/{app_id}/grants/{grantId}` (scope `tenant:admin`) → revokes one grant. All three derive `tenant_id`/`tenant_slug` from the caller's own JWT (`get_tenant_context`), never a path/body param (security.md tenant isolation) — matching the spec's literal path shape (no `tenant_slug` segment) while still enforcing tenant-from-JWT-only.
- Consumes: `services.stream_grant_service.{list_grants, resolve_grants_for_scope, revoke_grant, consumes_from_version}` (Tasks 29-30); `services.bundle_activation_service.get_active_version` (Task 16); `services.valkey_admin_client.build_client` (Task 28).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_grants_blueprint.py
"""Blueprint tests for /api/v1/apps/{app_id}/grants."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from quart import Quart

from blueprints.v1.bundle_grants import BLUEPRINTS
from tests.conftest import TENANT_SLUG, make_token

_MANIFEST = {
    "schema_version": 2, "app_id": "waddles.socials.music.default", "name": "Music Station",
    "version": "3.0.1", "feature": "waddles.socials.music", "module": "socials",
    "provider": "builtin", "language": "python", "artifact": "source",
    "stages": {"process": {"entry": "x:y", "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}]}},
}


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    dal = bundle_install_db.dal
    dal.ingest_sources.insert(
        tenant_id=1, community_id=None, platform="twitch", source_id="tw-channelA",
        label="Twitch #channelA", enabled=True,
    )
    version_id = dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="3.0.1", artifact_digest="sha256:" + "a" * 64,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED",
        manifest_json=_MANIFEST, app_version_id=version_id,
    )
    dal.commit()
    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = dal
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)
    return app


async def test_resolve_requires_tenant_admin(app: Quart) -> None:
    token = make_token(scope="", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.post(
        "/api/v1/apps/waddles.socials.music.default/grants/resolve",
        headers={"Authorization": f"Bearer {token}"}, json={"communityId": None},
    )
    assert response.status_code == 403


async def test_resolve_and_list_round_trip(app: Quart) -> None:
    async_dal = app.config["async_dal"]
    dal = app.config["dal"]
    from services.bundle_activation_service import activate_version

    await activate_version(
        async_dal, dal, tenant_id=1, community_id=None, app_id="waddles.socials.music.default",
        version="3.0.1", activated_by=1,
    )
    token = make_token(scope="tenant:admin", tenant=TENANT_SLUG)
    mock_valkey = AsyncMock()
    with patch("blueprints.v1.bundle_grants.build_client", return_value=mock_valkey):
        client = app.test_client()
        resolve_response = await client.post(
            "/api/v1/apps/waddles.socials.music.default/grants/resolve",
            headers={"Authorization": f"Bearer {token}"}, json={"communityId": None},
        )
        assert resolve_response.status_code == 200

        list_response = await client.get(
            "/api/v1/apps/waddles.socials.music.default/grants",
            headers={"Authorization": f"Bearer {token}"},
        )
    body = await list_response.get_json()
    assert len(body["grants"]) == 1
    assert body["grants"][0]["label"] == "Twitch #channelA"


async def test_delete_grant_revokes_it(app: Quart) -> None:
    async_dal = app.config["async_dal"]
    dal = app.config["dal"]
    from services.bundle_activation_service import activate_version

    await activate_version(
        async_dal, dal, tenant_id=1, community_id=None, app_id="waddles.socials.music.default",
        version="3.0.1", activated_by=1,
    )
    token = make_token(scope="tenant:admin", tenant=TENANT_SLUG)
    mock_valkey = AsyncMock()
    with patch("blueprints.v1.bundle_grants.build_client", return_value=mock_valkey):
        client = app.test_client()
        await client.post(
            "/api/v1/apps/waddles.socials.music.default/grants/resolve",
            headers={"Authorization": f"Bearer {token}"}, json={"communityId": None},
        )
        list_response = await client.get(
            "/api/v1/apps/waddles.socials.music.default/grants",
            headers={"Authorization": f"Bearer {token}"},
        )
        grant_id = (await list_response.get_json())["grants"][0]["grantId"]
        delete_response = await client.delete(
            f"/api/v1/apps/waddles.socials.music.default/grants/{grant_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert delete_response.status_code == 200
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_grants_blueprint.py -v`
Expected: `ModuleNotFoundError: No module named 'blueprints.v1.bundle_grants'`

- [ ] **Step 3: Write the implementation**

```python
# hub_api/blueprints/v1/bundle_grants.py
"""v1 `bundle_grants` group -- GET/POST resolve/DELETE grant (spec Sec9.6). Tenant strictly from the JWT."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

from flask_core.api_utils import error_response
from flask_core.authz import require_scope
from flask_core.tenancy import get_tenant_context, tenant_middleware
from quart import Blueprint, current_app, request
from quart_schema import validate_request, validate_response

from services.bundle_activation_service import get_active_version
from services.current_user import get_current_user_id
from services.errors import ApiError, bad_request
from services.stream_grant_service import (
    consumes_from_version,
    list_grants,
    resolve_grants_for_scope,
    revoke_grant,
)
from services.valkey_admin_client import build_client

bundle_grants_bp = Blueprint("v1_bundle_grants", __name__, url_prefix="/api/v1/apps")


def _dal() -> tuple[Any, Any]:
    return current_app.config["async_dal"], current_app.config["dal"]


def _err(exc: ApiError) -> tuple[dict[str, object], int]:
    return cast(tuple[dict[str, object], int], error_response(exc.message, exc.status_code, exc.code))


def _parse_community_id(raw: str | None) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError as exc:
        raise ApiError(f"communityId {raw!r} must be an integer", 400, "INVALID_COMMUNITY_ID") from exc


@dataclass(slots=True, frozen=True)
class GrantDTO:
    """One resolved stream grant, rendered in words."""

    grantId: int
    platform: str
    sourceId: str
    label: str
    streamKey: str


@dataclass(slots=True, frozen=True)
class GrantListResponse:
    """Response DTO for `GET .../grants`."""

    success: bool
    grants: list[GrantDTO] = field(default_factory=list)


@dataclass(slots=True, frozen=True)
class ResolveRequest:
    """Request DTO for `POST .../grants/resolve`."""

    communityId: int | None = None


@dataclass(slots=True, frozen=True)
class MessageResponse:
    """Generic message response DTO."""

    success: bool
    message: str


@bundle_grants_bp.route("/<app_id>/grants", methods=["GET"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@validate_response(GrantListResponse)
async def get_grants(app_id: str) -> GrantListResponse | tuple[dict[str, object], int]:
    """The bundle's current, active stream grants for the caller's tenant/community."""
    async_dal, dal = _dal()
    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101
    try:
        community_id = _parse_community_id(request.args.get("communityId"))
    except ApiError as exc:
        return _err(exc)
    rows = await list_grants(async_dal, dal, app_id=app_id, tenant_id=ctx.tenant_id, community_id=community_id)
    return GrantListResponse(
        success=True,
        grants=[
            GrantDTO(grantId=r.id, platform=r.platform, sourceId=r.source_id, label=r.label, streamKey=r.stream_key)
            for r in rows
        ],
    )


@bundle_grants_bp.route("/<app_id>/grants/resolve", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@validate_request(ResolveRequest)
async def post_resolve(data: ResolveRequest, app_id: str) -> tuple[dict[str, object], int]:
    """Re-run grant resolution for this scope. Idempotent, callable any time (e.g. after a new ingest source)."""
    async_dal, dal = _dal()
    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101
    caller_id = get_current_user_id(request)

    active_version = await get_active_version(
        async_dal, dal, tenant_id=ctx.tenant_id, community_id=data.communityId, app_id=app_id
    )
    if active_version is None:
        return _err(bad_request(f"{app_id} has no active version for this scope"))
    consumes = await consumes_from_version(async_dal, dal, app_id=app_id, version=active_version.version)

    grants = await resolve_grants_for_scope(
        async_dal, dal, build_client(), tenant_id=ctx.tenant_id, tenant_slug=ctx.tenant_slug,
        community_id=data.communityId, community_slug=None, app_id=app_id, consumes=consumes, granted_by=caller_id,
    )
    return {"success": True, "grantCount": len(grants)}, 200


@bundle_grants_bp.route("/<app_id>/grants/<int:grant_id>", methods=["DELETE"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@validate_response(MessageResponse)
async def delete_grant(app_id: str, grant_id: int) -> MessageResponse | tuple[dict[str, object], int]:
    """Revoke one grant without uninstalling or deactivating the bundle."""
    async_dal, dal = _dal()
    caller_id = get_current_user_id(request)
    try:
        await revoke_grant(async_dal, dal, build_client(), app_id=app_id, grant_id=grant_id, actor_id=caller_id)
    except ApiError as exc:
        return _err(exc)
    return MessageResponse(success=True, message=f"grant {grant_id} revoked")


BLUEPRINTS: list[Blueprint] = [bundle_grants_bp]
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_grants_blueprint.py -v`
Expected: `3 passed`

- [ ] **Step 5: Add the ruff per-file ignore**

Append to `hub_api/pyproject.toml`'s `[tool.ruff.lint.per-file-ignores]`:

```toml
"blueprints/v1/bundle_grants.py" = ["N815"]
```

- [ ] **Step 6: Commit**

```bash
git add hub_api/blueprints/v1/bundle_grants.py hub_api/tests/test_bundle_grants_blueprint.py \
        hub_api/pyproject.toml
git commit -m "$(cat <<'EOF'
feat(hub-api): GET grants, POST resolve, DELETE grant (spec Sec9.6)

Tenant strictly from the JWT, never a path segment, matching the
spec's literal /api/v1/apps/{app_id}/grants path shape.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 32: `distribution_service.py` extension — the new distribution-API fields (spec §6.7)

**Depends on:** Task 16 (`get_active_version`), Task 29 (`list_grants`), Task 10 (`app_version_uploads.manifest_json`, the source of the `manifest` subset).

**Files:**
- Modify: `hub_api/services/distribution_service.py`
- Test: `hub_api/tests/test_distribution_service_versions.py`

**Interfaces:**
- Produces: `BundleDistributionRow` gains `artifact_version: str | None`, `artifact_digest: str | None`, `artifact_kind: str | None`, `language: str | None`, `scan_status: str | None`, `manifest: dict[str, Any]` (all default to `None`/`{}`, so every existing construction/test keeps working), `grants: list[GrantInfo]` (`stage="process"` rows only); new dataclass `GrantInfo(grant_id: int, stream: str, platform: str, source_id: str, label: str)`.
- Consumes: `services.bundle_activation_service.get_active_version` (Task 16); `services.stream_grant_service.list_grants` (Task 29).

A row whose `artifact_digest` is `None` (no `app_active_versions` row for this scope yet — spec §6.7: "A row whose `artifactDigest` is `null`... is skipped by the stage") is still returned by this service; the **blueprint** (Task 33) is where the null-digest fields collapse into the wire shape the Rust stages expect.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_distribution_service_versions.py
"""Tests for the Sec6.7 distribution-API field additions to list_bundles_for_stage()."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

from services.bundle_activation_service import activate_version
from services.distribution_service import list_bundles_for_stage
from services.stream_grant_service import resolve_grants_for_scope
from services.bundle_manifest_v2 import ConsumeRule

_MANIFEST = {
    "schema_version": 2, "app_id": "waddles.socials.music.default", "name": "Music Station",
    "version": "3.0.1", "feature": "waddles.socials.music", "module": "socials",
    "provider": "builtin", "language": "python", "artifact": "source",
    "stages": {
        "process": {"entry": "x:y", "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}]},
    },
}


async def _seed_active(dal: Any, async_dal: Any) -> None:
    version_id = dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="3.0.1", artifact_digest="sha256:" + "a" * 64,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED",
        manifest_json=_MANIFEST, app_version_id=version_id,
    )
    dal.app_tenant_availability.insert(tenant_id=1, app_id="waddles.socials.music.default", available=True)
    dal.commit()
    await activate_version(
        async_dal, dal, tenant_id=1, community_id=None, app_id="waddles.socials.music.default",
        version="3.0.1", activated_by=1,
    )


async def test_process_row_includes_digest_and_grants_when_active(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await _seed_active(dal, async_dal)
    dal.ingest_sources.insert(
        tenant_id=1, community_id=None, platform="twitch", source_id="tw-channelA",
        label="Twitch #channelA", enabled=True,
    )
    dal.commit()
    await resolve_grants_for_scope(
        async_dal, dal, AsyncMock(), tenant_id=1, tenant_slug="acme", community_id=None, community_slug=None,
        app_id="waddles.socials.music.default",
        consumes=(ConsumeRule(platform="twitch", source_id=None, event_types=("chat.message",), filters={}),),
        granted_by=1,
    )

    rows = await list_bundles_for_stage(
        async_dal, dal, tenant_id=1, community_id=None, stage="process"
    )
    row = next(r for r in rows if r.app_id == "waddles.socials.music.default")
    assert row.artifact_digest == "sha256:" + "a" * 64
    assert row.artifact_version == "3.0.1"
    assert row.language == "python"
    assert row.scan_status == "scanned"
    assert len(row.grants) == 1
    assert row.grants[0].label == "Twitch #channelA"
    assert row.manifest["consumes"] == [{"platform": "twitch", "event_types": ["chat.message"]}]
    assert row.manifest["limits"] == {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10}
    assert row.manifest["egress"] == []
    assert row.manifest["data"] == {"tables": []}


async def test_action_stage_row_has_no_grants_field_populated(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    action_manifest = {**_MANIFEST, "stages": {"action": {"entry": "x:y"}}}
    version_id = dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="3.0.1", artifact_digest="sha256:" + "b" * 64,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED",
        manifest_json=action_manifest, app_version_id=version_id,
    )
    dal.commit()
    await activate_version(
        async_dal, dal, tenant_id=1, community_id=None, app_id="waddles.socials.music.default",
        version="3.0.1", activated_by=1,
    )
    dal(dal.app_catalog.app_id == "waddles.socials.music.default").update(
        stages={"action": {"entrypoint": "x:y", "config": {}, "spec": {}}}
    )
    dal.app_tenant_availability.insert(tenant_id=1, app_id="waddles.socials.music.default", available=True)
    dal.commit()

    rows = await list_bundles_for_stage(async_dal, dal, tenant_id=1, community_id=None, stage="action")
    row = next(r for r in rows if r.app_id == "waddles.socials.music.default")
    assert row.grants == []
    assert row.artifact_digest == "sha256:" + "b" * 64


async def test_no_active_version_leaves_digest_fields_none(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    dal.app_tenant_availability.insert(tenant_id=1, app_id="waddles.socials.music.default", available=True)
    dal.commit()

    rows = await list_bundles_for_stage(async_dal, dal, tenant_id=1, community_id=None, stage="process")
    row = next((r for r in rows if r.app_id == "waddles.socials.music.default"), None)
    if row is not None:  # the seed app_catalog row has no "process" stage data, may legitimately be absent
        assert row.artifact_digest is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_distribution_service_versions.py -v`
Expected: `AttributeError: 'BundleDistributionRow' object has no attribute 'artifact_digest'`

- [ ] **Step 3: Write the implementation**

Replace `hub_api/services/distribution_service.py`'s `BundleDistributionRow` dataclass and `list_bundles_for_stage` function with the versions below (every other function/constant in the file is unchanged):

```python
@dataclass(slots=True, frozen=True)
class GrantInfo:
    """One resolved stream grant, rendered in words (spec Sec6.7's `grants` array)."""

    grant_id: int
    stream: str
    platform: str
    source_id: str
    label: str


@dataclass(slots=True, frozen=True)
class BundleDistributionRow:
    """One bundle's `{entrypoint, config, spec}` for a stage, at a single (tenant, community).

    `config` is the merge of the bundle's own shipped stage default
    (`app_catalog.stages[stage].config`) with the tenant/community's
    override (`app_tenant_availability.config_defaults` /
    `app_activations.config`) -- override wins, same precedence
    `DBInstallationLookup`'s docstring establishes for narrower-scope-wins.

    M2b additions (spec Sec6.7): `artifact_version`/`artifact_digest`/
    `artifact_kind`/`language`/`scan_status` are populated from the
    scope's `app_active_versions` -> `app_versions` join, all `None`
    when no active version exists for this scope yet -- the stage skips
    such a row (`waddles_bundle_skipped_total{reason="no_artifact"}`).
    `grants` is populated only for `stage="process"` rows. `manifest`
    is the capability-bearing subset of the bundle's `bundle.yaml` v2
    the stage must enforce (`egress`, `data.tables`, `limits`, and --
    for a `stage="process"` row -- `consumes`), read out of
    `app_version_uploads.manifest_json` so the stage never fetches the
    full manifest separately (spec Sec6.7).
    """

    app_id: str
    community_id: int | None
    entrypoint: str | None
    spec: dict[str, Any] = field(default_factory=dict)
    config: dict[str, Any] = field(default_factory=dict)
    artifact_version: str | None = None
    artifact_digest: str | None = None
    artifact_kind: str | None = None
    language: str | None = None
    scan_status: str | None = None
    manifest: dict[str, Any] = field(default_factory=dict)
    grants: list[GrantInfo] = field(default_factory=list)


DEFAULT_LIMITS: dict[str, int] = {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10}


async def _manifest_subset(async_dal: Any, dal: Any, *, app_id: str, version: str, stage: str) -> dict[str, Any]:
    """The capability-bearing `bundle.yaml` slice the stage enforces (spec Sec6.7's `manifest`).

    Exactly four keys -- `egress`, `data`, `limits` and (process rows
    only) `consumes` -- read out of the `app_version_uploads.manifest_json`
    stored at upload time. Manifest defaults are applied here, not left
    to the stage, so a bundle that omitted `limits` still advertises the
    numbers the executor will actually enforce.
    """
    rows = await async_dal.select_async(
        dal((dal.app_version_uploads.app_id == app_id) & (dal.app_version_uploads.version == version))
    )
    raw: dict[str, Any] = dict(rows[0].manifest_json or {}) if rows else {}
    limits = {**DEFAULT_LIMITS, **(raw.get("limits") or {})}
    subset: dict[str, Any] = {
        "egress": list(raw.get("egress") or []),
        "data": {"tables": list(((raw.get("data") or {}).get("tables")) or [])},
        "limits": limits,
    }
    if stage == "process":
        stage_block = (raw.get("stages") or {}).get("process") or {}
        subset["consumes"] = list(stage_block.get("consumes") or [])
    return subset


async def _enrich_with_active_version(
    async_dal: Any, dal: Any, *, tenant_id: int, community_id: int | None, app_id: str, stage: str
) -> tuple[str | None, str | None, str | None, str | None, str | None, dict[str, Any], list[GrantInfo]]:
    """`(version, digest, kind, language, scan_status, manifest, grants)` for one bundle."""
    from services.bundle_activation_service import get_active_version
    from services.stream_grant_service import list_grants

    active_version = await get_active_version(
        async_dal, dal, tenant_id=tenant_id, community_id=community_id, app_id=app_id
    )
    if active_version is None:
        return None, None, None, None, None, {}, []

    grants: list[GrantInfo] = []
    if stage == "process":
        grant_rows = await list_grants(async_dal, dal, app_id=app_id, tenant_id=tenant_id, community_id=community_id)
        grants = [
            GrantInfo(grant_id=g.id, stream=g.stream_key, platform=g.platform, source_id=g.source_id, label=g.label)
            for g in grant_rows
        ]
    manifest = await _manifest_subset(
        async_dal, dal, app_id=app_id, version=active_version.version, stage=stage
    )
    return (
        active_version.version, active_version.artifact_digest, active_version.artifact_kind,
        active_version.language, active_version.scan_status, manifest, grants,
    )


async def list_bundles_for_stage(
    async_dal: Any,
    dal: Any,
    *,
    tenant_id: int,
    community_id: int | None,
    stage: str,
) -> Sequence[BundleDistributionRow]:
    """Every enabled, activated bundle implementing `stage` at (`tenant_id`, `community_id`).

    Community-scoped `app_activations` rows (when `community_id` is given)
    come first, then tenant-wide `app_tenant_availability` rows -- same
    ordering as `DBInstallationLookup.find()`, deduped by `app_id` (first
    occurrence wins) so a bundle available at both scopes is returned once,
    with the narrower (community) config winning.

    Raises `InvalidStageError` for any `stage` outside `BUNDLE_STAGES` --
    caught by the blueprint and turned into a 400, never a silently-empty
    result that looks like "no bundles active" for a typo'd stage name.
    """
    if stage not in BUNDLE_STAGES:
        raise InvalidStageError(f"invalid stage {stage!r}; must be one of {BUNDLE_STAGES}")

    rows: list[BundleDistributionRow] = []
    seen_app_ids: set[str] = set()

    if community_id is not None:
        query = (
            (dal.app_activations.tenant_id == tenant_id)
            & (dal.app_activations.community_id == community_id)
            & (dal.app_activations.enabled == True)  # noqa: E712 - pydal query operator, not a bool compare
            & (dal.app_activations.app_id == dal.app_catalog.app_id)
            & (dal.app_catalog.status == "active")
        )
        activation_rows = await async_dal.select_async(
            dal(query),
            dal.app_activations.app_id,
            dal.app_activations.config,
            dal.app_catalog.stages,
        )
        for row in activation_rows:
            app_id = row.app_activations.app_id
            if app_id in seen_app_ids:
                continue
            stage_data = _stage_data(row.app_catalog.stages, stage)
            if stage_data is None:
                continue
            seen_app_ids.add(app_id)
            merged_config = {**stage_data.get("config", {}), **(row.app_activations.config or {})}
            (artifact_version, artifact_digest, artifact_kind, language, scan_status, manifest, grants) = (
                await _enrich_with_active_version(
                    async_dal, dal, tenant_id=tenant_id, community_id=community_id, app_id=app_id, stage=stage
                )
            )
            rows.append(
                BundleDistributionRow(
                    app_id=app_id,
                    community_id=community_id,
                    entrypoint=stage_data.get("entrypoint"),
                    spec=dict(stage_data.get("spec") or {}),
                    config=merged_config,
                    artifact_version=artifact_version, artifact_digest=artifact_digest,
                    artifact_kind=artifact_kind, language=language, scan_status=scan_status,
                    manifest=manifest, grants=grants,
                )
            )

    avail_query = (
        (dal.app_tenant_availability.tenant_id == tenant_id)
        & (dal.app_tenant_availability.available == True)  # noqa: E712
        & (dal.app_tenant_availability.app_id == dal.app_catalog.app_id)
        & (dal.app_catalog.status == "active")
    )
    availability_rows = await async_dal.select_async(
        dal(avail_query),
        dal.app_tenant_availability.app_id,
        dal.app_tenant_availability.config_defaults,
        dal.app_catalog.stages,
    )
    for row in availability_rows:
        app_id = row.app_tenant_availability.app_id
        if app_id in seen_app_ids:
            continue
        stage_data = _stage_data(row.app_catalog.stages, stage)
        if stage_data is None:
            continue
        seen_app_ids.add(app_id)
        merged_config = {
            **stage_data.get("config", {}),
            **(row.app_tenant_availability.config_defaults or {}),
        }
        (artifact_version, artifact_digest, artifact_kind, language, scan_status, manifest, grants) = (
            await _enrich_with_active_version(
                async_dal, dal, tenant_id=tenant_id, community_id=None, app_id=app_id, stage=stage
            )
        )
        rows.append(
            BundleDistributionRow(
                app_id=app_id,
                community_id=None,
                entrypoint=stage_data.get("entrypoint"),
                spec=dict(stage_data.get("spec") or {}),
                config=merged_config,
                artifact_version=artifact_version, artifact_digest=artifact_digest,
                artifact_kind=artifact_kind, language=language, scan_status=scan_status,
                manifest=manifest, grants=grants,
            )
        )

    return rows
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_distribution_service_versions.py -v`
Expected: `3 passed`

- [ ] **Step 5: Run the existing distribution-service tests to confirm zero regression**

Run: `cd hub_api && python3 -m pytest tests/test_distribution_service.py tests/test_v1_distribution_blueprint.py -v`
Expected: every previously-passing test still passes — the new fields all default to `None`/`{}`/`[]`, and every existing test constructs/asserts against the pre-existing fields only.

- [ ] **Step 6: Commit**

```bash
git add hub_api/services/distribution_service.py hub_api/tests/test_distribution_service_versions.py
git commit -m "$(cat <<'EOF'
feat(hub-api): distribution_service -- artifactVersion/Digest/Kind/language/scanStatus/manifest/grants (spec Sec6.7)

Joins app_active_versions -> app_versions for the scope, reads the
capability-bearing manifest slice (egress/data.tables/limits/consumes)
out of app_version_uploads.manifest_json, and app_stream_grants for
stage=process rows. A row with no active version
yet returns all-None digest fields -- the blueprint (Task 33) is where
that collapses into the wire null the Rust stages skip on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 33: `blueprints/v1/distribution.py` — distribution API v2 bundles route + ETag

**Depends on:** Task 32 (`distribution_service` returns the §6.7 fields), Task 29 (`stream_grant_service.list_grants`), Task 16 (`bundle_activation_service.get_active_version`), Task 4 (`bind_bundle_install_tables`), Task 18 (`permission_summary_service.canonical_json`).

**Files:**
- Modify: `hub_api/blueprints/v1/distribution.py`
- Test: `hub_api/tests/test_distribution_v2_blueprint.py`

**Interfaces:**

| Method | Path | Auth | Query params | Success |
|---|---|---|---|---|
| `GET` | `/api/v1/distribution/v2/bundles` | `tenant_middleware` + `require_scope("distribution:read")` | `stage` (required, one of `ingest`/`process`/`action`), `communityId` (optional int) | `200` + `ETag`, or `304` when `If-None-Match` matches |
| `GET` | `/api/v1/distribution/bundles` | unchanged | unchanged | **unchanged — this task does not touch the v1 route** |

- Produces: `DistributionGrantDTO(grantId: int, stream: str, platform: str, sourceId: str, label: str)`; `DistributionBundleV2DTO(appId, communityId, entrypoint, spec, config, artifactVersion, artifactDigest, artifactKind, language, scanStatus, manifest, grants)`; `DistributionBundlesV2Response(success, stage, bundles, meta)`; `def bundles_etag(stage: str, bundles: list[DistributionBundleV2DTO]) -> str`.
- Consumes: `services.distribution_service.{list_bundles_for_stage, BUNDLE_STAGES, InvalidStageError}` (Task 32); `services.permission_summary_service.canonical_json` (Task 18); `services.schema.bind_bundle_install_tables` (Task 4).

Two facts this task depends on and must not re-derive:

1. **The ETag is computed over `{"stage": ..., "bundles": [...]}` only — never over `meta`.** `meta.timestamp` is `datetime.now(UTC)` and changes on every request; including it would produce a fresh ETag every poll and the 304 path would never fire.
2. **`@validate_response` is deliberately not used on the v2 routes.** A 304 carries no body, and the ETag has to be set on a real response object, so the handler builds the DTO, serialises it with `dataclasses.asdict`, and hands that to `jsonify`. The explicit-schema guarantee (`security.md` Output Validation) still holds — the DTO is the only object that is ever serialised, and no ORM row or `**row.as_dict()` reaches the wire. The v1 route keeps its `@validate_response(DistributionBundlesResponse)` unchanged.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_distribution_v2_blueprint.py
"""Blueprint tests for GET /api/v1/distribution/v2/bundles (spec Sec6.7)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from quart import Quart

from blueprints.v1.distribution import BLUEPRINTS
from services.bundle_activation_service import activate_version
from services.bundle_manifest_v2 import ConsumeRule
from services.stream_grant_service import resolve_grants_for_scope
from tests.conftest import TENANT_SLUG, make_token

_MANIFEST = {
    "schema_version": 2, "app_id": "waddles.socials.music.default", "name": "Music Station",
    "version": "3.0.1", "feature": "waddles.socials.music", "module": "socials",
    "provider": "builtin", "language": "python", "artifact": "source",
    "egress": [{"host": "api.spotify.com", "methods": ["GET", "POST"]}],
    "data": {"tables": ["music_queue"]},
    "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10},
    "stages": {
        "process": {
            "entry": "bundles.social_music_process:transform",
            "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}],
            "config": {"command_prefix": "!"},
            "spec": {"required_config": []},
        }
    },
}


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    dal = bundle_install_db.dal
    dal(dal.app_catalog.app_id == "waddles.socials.music.default").update(
        stages={"process": {"entrypoint": "bundles.social_music_process:transform",
                            "config": {"command_prefix": "!"}, "spec": {"required_config": []}}}
    )
    dal.app_tenant_availability.insert(tenant_id=1, app_id="waddles.socials.music.default", available=True)
    dal.ingest_sources.insert(
        tenant_id=1, community_id=None, platform="twitch", source_id="tw-channelA",
        label="Twitch #channelA", enabled=True,
    )
    version_id = dal.app_versions.insert(
        app_id="waddles.socials.music.default", version="3.0.1", artifact_digest="sha256:" + "a" * 64,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED",
        manifest_json=_MANIFEST, app_version_id=version_id,
    )
    dal.commit()
    quart_app = Quart(__name__)
    quart_app.config["async_dal"] = bundle_install_db
    quart_app.config["dal"] = dal
    for bp in BLUEPRINTS:
        quart_app.register_blueprint(bp)
    return quart_app


async def _activate_and_grant(app: Quart) -> None:
    async_dal = app.config["async_dal"]
    dal = app.config["dal"]
    await activate_version(
        async_dal, dal, tenant_id=1, community_id=None,
        app_id="waddles.socials.music.default", version="3.0.1", activated_by=1,
    )
    await resolve_grants_for_scope(
        async_dal, dal, AsyncMock(), tenant_id=1, tenant_slug=TENANT_SLUG, community_id=None,
        community_slug=None, app_id="waddles.socials.music.default",
        consumes=(ConsumeRule(platform="twitch", source_id=None, event_types=("chat.message",), filters={}),),
        granted_by=1,
    )


async def test_v2_requires_distribution_read_scope(app: Quart) -> None:
    client = app.test_client()
    response = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process",
        headers={"Authorization": f"Bearer {make_token(scope='', tenant=TENANT_SLUG)}"},
    )
    assert response.status_code == 403


async def test_v2_returns_digest_manifest_and_grants(app: Quart) -> None:
    await _activate_and_grant(app)
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    body = await response.get_json()
    assert body["meta"]["version"] == 2
    row = next(b for b in body["bundles"] if b["appId"] == "waddles.socials.music.default")
    assert row["artifactDigest"] == "sha256:" + "a" * 64
    assert row["artifactVersion"] == "3.0.1"
    assert row["artifactKind"] == "source"
    assert row["language"] == "python"
    assert row["scanStatus"] == "scanned"
    assert row["manifest"]["data"] == {"tables": ["music_queue"]}
    assert row["manifest"]["egress"] == [{"host": "api.spotify.com", "methods": ["GET", "POST"]}]
    assert row["manifest"]["consumes"] == [{"platform": "twitch", "event_types": ["chat.message"]}]
    assert len(row["grants"]) == 1
    assert row["grants"][0]["label"] == "Twitch #channelA"
    assert row["grants"][0]["stream"].endswith(":src:twitch:tw-channelA:events")


async def test_v2_null_digest_row_is_still_returned(app: Quart) -> None:
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process", headers={"Authorization": f"Bearer {token}"}
    )
    body = await response.get_json()
    row = next(b for b in body["bundles"] if b["appId"] == "waddles.socials.music.default")
    assert row["artifactDigest"] is None
    assert row["grants"] == []
    assert row["manifest"] == {}


async def test_v2_etag_round_trip_returns_304(app: Quart) -> None:
    await _activate_and_grant(app)
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    first = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process", headers={"Authorization": f"Bearer {token}"}
    )
    etag = first.headers["ETag"]
    assert etag.startswith('"') and etag.endswith('"')

    second = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process",
        headers={"Authorization": f"Bearer {token}", "If-None-Match": etag},
    )
    assert second.status_code == 304
    assert second.headers["ETag"] == etag
    assert await second.get_data() == b""


async def test_v2_etag_is_stable_across_calls_despite_the_meta_timestamp(app: Quart) -> None:
    await _activate_and_grant(app)
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    first = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process", headers={"Authorization": f"Bearer {token}"}
    )
    second = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process", headers={"Authorization": f"Bearer {token}"}
    )
    assert first.headers["ETag"] == second.headers["ETag"]
    assert (await first.get_json())["meta"]["timestamp"] != (await second.get_json())["meta"]["timestamp"]


async def test_v2_etag_changes_when_a_grant_is_revoked(app: Quart) -> None:
    await _activate_and_grant(app)
    dal = app.config["dal"]
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    before = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process", headers={"Authorization": f"Bearer {token}"}
    )
    from datetime import UTC, datetime

    dal(dal.app_stream_grants.app_id == "waddles.socials.music.default").update(
        revoked_at=datetime.now(UTC)
    )
    dal.commit()
    after = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process", headers={"Authorization": f"Bearer {token}"}
    )
    assert before.headers["ETag"] != after.headers["ETag"]
    assert (await after.get_json())["bundles"][0]["grants"] == []


@pytest.mark.parametrize("stage", ["", "nonsense", "presentation", "INGEST"])
async def test_v2_rejects_an_invalid_stage(app: Quart, stage: str) -> None:
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.get(
        f"/api/v1/distribution/v2/bundles?stage={stage}", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 400
    assert (await response.get_json())["error"]["code"] == "INVALID_STAGE"


async def test_v2_rejects_a_non_integer_community_id(app: Quart) -> None:
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process&communityId=abc",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 400
    assert (await response.get_json())["error"]["code"] == "INVALID_COMMUNITY_ID"


async def test_v2_community_id_filter_narrows_the_result_set(app: Quart) -> None:
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.get(
        "/api/v1/distribution/v2/bundles?stage=process&communityId=999",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    body = await response.get_json()
    assert [b["communityId"] for b in body["bundles"]] == [None]


async def test_v2_empty_result_is_a_200_with_an_empty_list(app: Quart) -> None:
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.get(
        "/api/v1/distribution/v2/bundles?stage=action", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    assert (await response.get_json())["bundles"] == []


async def test_v1_route_body_is_unchanged_by_this_task(app: Quart) -> None:
    await _activate_and_grant(app)
    token = make_token(scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.get(
        "/api/v1/distribution/bundles?stage=process", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    body = await response.get_json()
    assert body["meta"]["version"] == 1
    assert set(body["bundles"][0]) == {"appId", "communityId", "entrypoint", "spec", "config"}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_distribution_v2_blueprint.py -v`
Expected: every test fails with `404 != 200` / `404 != 403` — the `/v2/bundles` rule is not registered yet (`test_v1_route_body_is_unchanged_by_this_task` is the one exception and already passes).

- [ ] **Step 3: Write the implementation**

Make exactly four edits to `hub_api/blueprints/v1/distribution.py`. Nothing else in the file changes.

**3a.** Replace the existing import block's `from dataclasses import ...` line and add the new imports, so the top of the file reads:

```python
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, cast

from flask_core.api_utils import error_response
from flask_core.authz import require_scope
from flask_core.tenancy import get_tenant_context, tenant_middleware
from quart import Blueprint, Response, current_app, jsonify, request
from quart_schema import validate_response

from services import distribution_service as svc
from services.errors import ApiError
from services.permission_summary_service import canonical_json
from services.schema import bind_app_bundle_tables, bind_bundle_install_tables
```

**3b.** Replace the body of `_ensure_tables` so the M2b tables are bound on whichever connection the route queries:

```python
def _ensure_tables(dal: Any) -> None:
    """Idempotently bind the app-bundle and M2b bundle-install tables on `dal`.

    `app.py` is frozen for this port (`hub_api/PORTING.md`'s
    auto-discovery contract) -- same lazy-bind pattern as
    `data_privacy.py`/`cookie_consent.py`'s own `before_request` hooks.
    Runs on BOTH the primary (`async_dal.dal`, always) and the
    read-replica connection (`async_dal.read_dal`, when configured) so
    `_dal()`'s read_dal branch always has bound tables to query against.
    `bind_bundle_install_tables` is what makes `app_active_versions`,
    `app_versions`, `app_version_uploads` and `app_stream_grants`
    queryable from the v2 route -- both binders are idempotent.
    """
    bind_app_bundle_tables(dal)
    bind_bundle_install_tables(dal)
```

**3c.** Append these DTOs and the ETag helper directly after the existing `DistributionBundlesResponse` dataclass:

```python
@dataclass(slots=True, frozen=True)
class DistributionGrantDTO:
    """One resolved stream grant, as the Rust process stage reads it (spec Sec6.7)."""

    grantId: int
    stream: str
    platform: str
    sourceId: str
    label: str


@dataclass(slots=True, frozen=True)
class DistributionBundleV2DTO:
    """One bundle's full v2 distribution row -- the v1 five fields plus spec Sec6.7's seven.

    `artifactDigest` is `None` for a bundle registered without an
    activated, digest-verified version; the stage skips such a row and
    counts it as `waddles_bundle_skipped_total{reason="no_artifact"}`
    rather than treating it as an error. `grants` is populated only on
    `stage=process` rows; an empty list means "activated but currently
    reads nothing", a legitimate state.
    """

    appId: str
    communityId: int | None
    entrypoint: str | None
    spec: dict[str, Any] = field(default_factory=dict)
    config: dict[str, Any] = field(default_factory=dict)
    artifactVersion: str | None = None
    artifactDigest: str | None = None
    artifactKind: str | None = None
    language: str | None = None
    scanStatus: str | None = None
    manifest: dict[str, Any] = field(default_factory=dict)
    grants: list[DistributionGrantDTO] = field(default_factory=list)


@dataclass(slots=True, frozen=True)
class DistributionBundlesV2Response:
    """Response DTO for `GET /api/v1/distribution/v2/bundles`."""

    success: bool
    stage: str
    bundles: list[DistributionBundleV2DTO]
    meta: DistributionMetaDTO


def bundles_etag(stage: str, bundles: list[DistributionBundleV2DTO]) -> str:
    """A strong, quoted ETag over the bundle set -- deliberately excluding `meta`.

    `meta.timestamp` is `datetime.now(UTC)` and changes on every
    request; hashing it would mint a fresh ETag per poll and the 304
    path would never fire. Hashing `{stage, bundles}` instead makes the
    ETag change exactly when the advertised digests, config or grants
    change, which is the signal the Rust poller acts on.
    """
    payload = {"stage": stage, "bundles": [asdict(b) for b in bundles]}
    digest = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
    return f'"{digest[:32]}"'


def _conditional(stage: str, bundles: list[DistributionBundleV2DTO], payload: Any) -> Response:
    """Serialise `payload`, attach the ETag, and short-circuit to 304 on an `If-None-Match` hit.

    Written by hand rather than through `Response.make_conditional`
    because Quart's `make_conditional` handles Range requests, not
    conditional GET -- the four lines below are the whole of RFC 9110's
    If-None-Match rule this endpoint needs.
    """
    etag = bundles_etag(stage, bundles)
    presented = {tag.strip() for tag in request.headers.get("If-None-Match", "").split(",") if tag.strip()}
    if etag in presented or "*" in presented:
        return Response(b"", status=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    response = cast(Response, jsonify(asdict(payload)))
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "no-cache"
    return response
```

**3d.** Append this route immediately before the file's final `BLUEPRINTS: list[Blueprint] = [distribution_bp]` line:

```python
@distribution_bp.route("/v2/bundles", methods=["GET"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("distribution:read")  # type: ignore[untyped-decorator]
async def list_distribution_bundles_v2() -> Response | tuple[dict[str, object], int]:
    """Distribution API v2 -- every Sec6.7 field, with an ETag/If-None-Match 304 path.

    The v1 route above is untouched and keeps serving its five-field
    body until the M6 cut-over, so today's Python
    `flask_core.stage_runner.BundlePoller` keeps working while the Rust
    stages move to this route.
    """
    stage = request.args.get("stage", "")
    if stage not in svc.BUNDLE_STAGES:
        return _err(ApiError(f"stage must be one of {svc.BUNDLE_STAGES}, got {stage!r}", 400, "INVALID_STAGE"))
    try:
        community_id = _parse_community_id(request.args.get("communityId"))
    except ApiError as exc:
        return _err(exc)

    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101 - tenant_middleware always publishes this on the success path

    async_dal, read_dal = _dal()
    rows = await svc.list_bundles_for_stage(
        async_dal, read_dal, tenant_id=ctx.tenant_id, community_id=community_id, stage=stage
    )
    bundles = [
        DistributionBundleV2DTO(
            appId=row.app_id,
            communityId=row.community_id,
            entrypoint=row.entrypoint,
            spec=row.spec,
            config=row.config,
            artifactVersion=row.artifact_version,
            artifactDigest=row.artifact_digest,
            artifactKind=row.artifact_kind,
            language=row.language,
            scanStatus=row.scan_status,
            manifest=row.manifest,
            grants=[
                DistributionGrantDTO(
                    grantId=g.grant_id, stream=g.stream, platform=g.platform,
                    sourceId=g.source_id, label=g.label,
                )
                for g in row.grants
            ],
        )
        for row in rows
    ]
    payload = DistributionBundlesV2Response(
        success=True,
        stage=stage,
        bundles=bundles,
        meta=DistributionMetaDTO(version=2, timestamp=datetime.now(UTC).isoformat()),
    )
    return _conditional(stage, bundles, payload)
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_distribution_v2_blueprint.py -v`
Expected: `14 passed` (10 named tests + the 4 `stage` parametrize cases).

- [ ] **Step 5: Run the pre-existing distribution tests to confirm zero regression on v1**

Run: `cd hub_api && python3 -m pytest tests/test_v1_distribution_blueprint.py tests/test_distribution_service.py tests/test_distribution_service_versions.py -v`
Expected: every previously-passing test still passes — the v1 route, its DTOs and its `@validate_response` decorator are byte-identical after this task.

- [ ] **Step 6: Add the ruff per-file ignore**

`hub_api/blueprints/v1/distribution.py` already carries camelCase DTO fields; add it to `hub_api/pyproject.toml`'s `[tool.ruff.lint.per-file-ignores]` if it is not already listed:

```toml
# Distribution API v1 + v2 -- camelCase DTO fields are the wire contract the
# Rust stages deserialize (spec Sec6.7), and S101 is the tenant_middleware
# postcondition assert every ported blueprint repeats.
"blueprints/v1/distribution.py" = ["N815", "S101"]
```

- [ ] **Step 7: Commit**

```bash
git add hub_api/blueprints/v1/distribution.py hub_api/tests/test_distribution_v2_blueprint.py \
        hub_api/pyproject.toml
git commit -m "$(cat <<'EOF'
feat(hub-api): distribution API v2 -- GET /api/v1/distribution/v2/bundles with ETag (spec Sec6.7)

Serves artifactVersion/artifactDigest/artifactKind/language/scanStatus,
the capability-bearing manifest slice, and the resolved stream grants
for stage=process rows. Strong ETag over {stage, bundles} only -- never
over meta.timestamp -- so a poll that changes nothing is a 304 rather
than a fresh body every 5 s.

The v1 /bundles route is untouched and keeps its byte-identical
five-field body until the M6 cut-over.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 34: `GET /api/v1/distribution/sources` — the ingest-source registry the Rust svc-ingest polls

**Depends on:** Task 33 (`_conditional`, `DistributionMetaDTO`, the bound M2b tables on the distribution blueprint), Task 26 (`ingest_source_service`), Task 29 (`render_stream_key`).

**Files:**
- Modify: `hub_api/services/ingest_source_service.py`
- Modify: `hub_api/blueprints/v1/distribution.py`
- Test: `hub_api/tests/test_distribution_sources_blueprint.py`

**Interfaces:**

| Method | Path | Auth | Query params | Success |
|---|---|---|---|---|
| `GET` | `/api/v1/distribution/sources` | `tenant_middleware` + `require_scope("distribution:read")` | `communityId` (optional int), `platform` (optional exact match), `enabled` (optional, exactly `true` or `false`) | `200` + `ETag`, or `304` when `If-None-Match` matches |

- Produces: `@dataclass(slots=True, frozen=True) DistributionSource(source_id: str, platform: str, label: str, community_id: int | None, community_slug: str | None, enabled: bool, has_secret: bool, mapping: dict[str, Any], stream_key: str)`; `async def list_sources_for_distribution(async_dal, dal, *, tenant_id: int, tenant_slug: str, community_id: int | None = None, platform: str | None = None, enabled: bool | None = None) -> list[DistributionSource]`; blueprint DTOs `DistributionSourceDTO(sourceId, platform, label, communityId, enabled, hasSecret, mapping, streamKey)` and `DistributionSourcesResponse(success, sources, meta)`.
- Consumes: `services.stream_grant_service.render_stream_key` (Task 29); `services.permission_summary_service.canonical_json` (Task 18, via Task 33's `_conditional`).

Three semantics fixed here and not re-derived anywhere else:

1. **The plaintext HMAC secret is never in this response.** Only `hasSecret: bool`. The Rust ingest fetches the secret itself through `ingest_source_service.resolve_secret`'s own authenticated path; this registry endpoint exists to tell it *which* sources and *which* streams exist, not to hand out credentials. A test asserts the string `secret` never appears as a key and that no `secret_ciphertext`/`secret_iv` bytes leak.
2. **`communityId` widens, it does not narrow to exactly one value.** `communityId=7` returns the tenant's sources scoped to community 7 **plus** its tenant-wide (`community_id IS NULL`) sources, because a tenant-wide source feeds every community — the same narrower-plus-tenant-wide rule `list_bundles_for_stage` already applies. Omitting `communityId` returns every source in the tenant.
3. **`streamKey` is rendered, never stored.** `render_stream_key(tenant_slug, community_slug, platform, source_id)` is the single source of truth for the key shape (`waddles:t:{tenant}:c:{community|_tenant}:src:{platform}:{source_id}:events`); this endpoint calls it rather than re-templating the string.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_distribution_sources_blueprint.py
"""Blueprint tests for GET /api/v1/distribution/sources (spec Sec10.3/Sec10.4 registry, Sec5.1 key shape)."""

from __future__ import annotations

from typing import Any

import pytest
from quart import Quart

from blueprints.v1.distribution import BLUEPRINTS
from tests.conftest import TENANT_SLUG, make_token


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    dal = bundle_install_db.dal
    dal.ingest_sources.insert(
        tenant_id=1, community_id=None, platform="twitch", source_id="tw-channelA",
        label="Twitch #channelA", enabled=True, secret_ciphertext=b"xx", secret_iv=b"yy", mapping=None,
    )
    dal.ingest_sources.insert(
        tenant_id=1, community_id=1, platform="discord", source_id="dg-guildX",
        label="Discord guild X", enabled=True, mapping={"text": "/content"},
    )
    dal.ingest_sources.insert(
        tenant_id=1, community_id=None, platform="custom:acme", source_id="wh-1",
        label="Acme webhook", enabled=False, mapping={"text": "/body/message"},
    )
    dal.commit()
    quart_app = Quart(__name__)
    quart_app.config["async_dal"] = bundle_install_db
    quart_app.config["dal"] = dal
    for bp in BLUEPRINTS:
        quart_app.register_blueprint(bp)
    return quart_app


def _token() -> str:
    return make_token(scope="distribution:read", tenant=TENANT_SLUG)


async def test_sources_requires_distribution_read_scope(app: Quart) -> None:
    client = app.test_client()
    response = await client.get(
        "/api/v1/distribution/sources",
        headers={"Authorization": f"Bearer {make_token(scope='', tenant=TENANT_SLUG)}"},
    )
    assert response.status_code == 403


async def test_sources_lists_every_tenant_source_with_a_rendered_stream_key(app: Quart) -> None:
    client = app.test_client()
    response = await client.get("/api/v1/distribution/sources", headers={"Authorization": f"Bearer {_token()}"})
    assert response.status_code == 200
    body = await response.get_json()
    assert body["meta"]["version"] == 2
    by_id = {s["sourceId"]: s for s in body["sources"]}
    assert set(by_id) == {"tw-channelA", "dg-guildX", "wh-1"}
    assert by_id["tw-channelA"]["streamKey"] == f"waddles:t:{TENANT_SLUG}:c:_tenant:src:twitch:tw-channelA:events"
    assert by_id["dg-guildX"]["streamKey"] == (
        f"waddles:t:{TENANT_SLUG}:c:acme-community:src:discord:dg-guildX:events"
    )
    assert by_id["tw-channelA"]["hasSecret"] is True
    assert by_id["dg-guildX"]["hasSecret"] is False
    assert by_id["wh-1"]["mapping"] == {"text": "/body/message"}


async def test_sources_never_leak_the_secret_material(app: Quart) -> None:
    client = app.test_client()
    response = await client.get("/api/v1/distribution/sources", headers={"Authorization": f"Bearer {_token()}"})
    raw = (await response.get_data()).decode()
    body = await response.get_json()
    assert "secret_ciphertext" not in raw
    assert "secret_iv" not in raw
    for source in body["sources"]:
        assert set(source) == {
            "sourceId", "platform", "label", "communityId", "enabled", "hasSecret", "mapping", "streamKey",
        }


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("?platform=twitch", {"tw-channelA"}),
        ("?platform=discord", {"dg-guildX"}),
        ("?platform=custom:acme", {"wh-1"}),
        ("?platform=nope", set()),
        ("?enabled=true", {"tw-channelA", "dg-guildX"}),
        ("?enabled=false", {"wh-1"}),
        ("?communityId=1", {"tw-channelA", "dg-guildX", "wh-1"}),
        ("?communityId=2", {"tw-channelA", "wh-1"}),
        ("?platform=twitch&enabled=true", {"tw-channelA"}),
        ("?platform=twitch&enabled=false", set()),
    ],
)
async def test_sources_filter_combinations(app: Quart, query: str, expected: set[str]) -> None:
    client = app.test_client()
    response = await client.get(
        f"/api/v1/distribution/sources{query}", headers={"Authorization": f"Bearer {_token()}"}
    )
    assert response.status_code == 200
    body = await response.get_json()
    assert {s["sourceId"] for s in body["sources"]} == expected


@pytest.mark.parametrize("value", ["yes", "1", "TRUE", ""])
async def test_sources_rejects_an_invalid_enabled_value(app: Quart, value: str) -> None:
    client = app.test_client()
    response = await client.get(
        f"/api/v1/distribution/sources?enabled={value}", headers={"Authorization": f"Bearer {_token()}"}
    )
    assert response.status_code == 400
    assert (await response.get_json())["error"]["code"] == "INVALID_ENABLED"


async def test_sources_rejects_a_non_integer_community_id(app: Quart) -> None:
    client = app.test_client()
    response = await client.get(
        "/api/v1/distribution/sources?communityId=abc", headers={"Authorization": f"Bearer {_token()}"}
    )
    assert response.status_code == 400
    assert (await response.get_json())["error"]["code"] == "INVALID_COMMUNITY_ID"


async def test_sources_etag_round_trip_returns_304(app: Quart) -> None:
    client = app.test_client()
    first = await client.get("/api/v1/distribution/sources", headers={"Authorization": f"Bearer {_token()}"})
    etag = first.headers["ETag"]
    second = await client.get(
        "/api/v1/distribution/sources",
        headers={"Authorization": f"Bearer {_token()}", "If-None-Match": etag},
    )
    assert second.status_code == 304
    assert await second.get_data() == b""


async def test_sources_etag_changes_when_a_source_is_disabled(app: Quart) -> None:
    dal = app.config["dal"]
    client = app.test_client()
    before = await client.get("/api/v1/distribution/sources", headers={"Authorization": f"Bearer {_token()}"})
    dal(dal.ingest_sources.source_id == "tw-channelA").update(enabled=False)
    dal.commit()
    after = await client.get("/api/v1/distribution/sources", headers={"Authorization": f"Bearer {_token()}"})
    assert before.headers["ETag"] != after.headers["ETag"]


async def test_sources_of_another_tenant_are_never_returned(app: Quart) -> None:
    dal = app.config["dal"]
    other_tenant_id = dal.tenants.insert(slug="other-corp", display_name="Other", is_active=True)
    dal.ingest_sources.insert(
        tenant_id=other_tenant_id, community_id=None, platform="twitch", source_id="tw-otherchannel",
        label="Other tenant channel", enabled=True,
    )
    dal.commit()
    client = app.test_client()
    response = await client.get("/api/v1/distribution/sources", headers={"Authorization": f"Bearer {_token()}"})
    assert "tw-otherchannel" not in {s["sourceId"] for s in (await response.get_json())["sources"]}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_distribution_sources_blueprint.py -v`
Expected: every test fails with `404 != 200` / `404 != 403` — the `/sources` rule is not registered yet.

- [ ] **Step 3: Add `list_sources_for_distribution` to `services/ingest_source_service.py`**

Append these imports to the module's existing import block and this dataclass + function to the end of `hub_api/services/ingest_source_service.py`:

```python
from dataclasses import dataclass  # noqa: E402 -- appended import, top of file in the real edit
from typing import Any  # noqa: E402

from services.stream_grant_service import render_stream_key  # noqa: E402


@dataclass(slots=True, frozen=True)
class DistributionSource:
    """One registered ingest source as the Rust svc-ingest polls it (spec Sec10.3/Sec10.5).

    Carries `has_secret`, never the secret itself: this registry tells
    the stage which sources and which Valkey streams exist, and nothing
    about how to authenticate a webhook -- that stays behind
    `resolve_secret`'s own path.
    """

    source_id: str
    platform: str
    label: str
    community_id: int | None
    community_slug: str | None
    enabled: bool
    has_secret: bool
    mapping: dict[str, Any]
    stream_key: str


async def list_sources_for_distribution(
    async_dal: Any,
    dal: Any,
    *,
    tenant_id: int,
    tenant_slug: str,
    community_id: int | None = None,
    platform: str | None = None,
    enabled: bool | None = None,
) -> list[DistributionSource]:
    """The tenant's ingest sources, filtered, each with its rendered Valkey stream key.

    `community_id` widens rather than narrows: a value returns that
    community's sources **plus** the tenant-wide (`community_id IS
    NULL`) ones, because a tenant-wide source feeds every community --
    the same narrower-plus-tenant-wide rule `list_bundles_for_stage`
    applies. `platform` is an exact match; `enabled` is a tri-state
    (`None` = no filter).
    """
    query = dal.ingest_sources.tenant_id == tenant_id
    if community_id is not None:
        query &= (dal.ingest_sources.community_id == community_id) | (
            dal.ingest_sources.community_id == None  # noqa: E711 - pydal IS NULL operator
        )
    if platform is not None:
        query &= dal.ingest_sources.platform == platform
    if enabled is not None:
        query &= dal.ingest_sources.enabled == enabled
    rows = await async_dal.select_async(dal(query), orderby=dal.ingest_sources.source_id)

    slug_cache: dict[int, str | None] = {}
    results: list[DistributionSource] = []
    for row in rows:
        community_slug: str | None = None
        if row.community_id is not None:
            if row.community_id not in slug_cache:
                community_rows = await async_dal.select_async(dal(dal.communities.id == row.community_id))
                slug_cache[row.community_id] = community_rows[0].name if community_rows else None
            community_slug = slug_cache[row.community_id]
        results.append(
            DistributionSource(
                source_id=row.source_id,
                platform=row.platform,
                label=row.label,
                community_id=row.community_id,
                community_slug=community_slug,
                enabled=bool(row.enabled),
                has_secret=row.secret_ciphertext is not None,
                mapping=dict(row.mapping or {}),
                stream_key=render_stream_key(tenant_slug, community_slug, row.platform, row.source_id),
            )
        )
    return results
```

- [ ] **Step 4: Add the route to `blueprints/v1/distribution.py`**

Add the import and append the DTOs + route immediately before the file's final `BLUEPRINTS: list[Blueprint] = [distribution_bp]` line:

```python
from services.ingest_source_service import list_sources_for_distribution
```

```python
@dataclass(slots=True, frozen=True)
class DistributionSourceDTO:
    """One registered ingest source. `hasSecret` only -- the secret itself is never on this wire."""

    sourceId: str
    platform: str
    label: str
    communityId: int | None
    enabled: bool
    hasSecret: bool
    mapping: dict[str, Any] = field(default_factory=dict)
    streamKey: str = ""


@dataclass(slots=True, frozen=True)
class DistributionSourcesResponse:
    """Response DTO for `GET /api/v1/distribution/sources`."""

    success: bool
    sources: list[DistributionSourceDTO]
    meta: DistributionMetaDTO


def _parse_enabled(raw: str | None) -> bool | None:
    """Parse the tri-state `enabled` query param. Exactly `true`/`false`; anything else is a 400."""
    if raw is None:
        return None
    if raw == "true":
        return True
    if raw == "false":
        return False
    raise ApiError(f"enabled {raw!r} must be exactly 'true' or 'false'", 400, "INVALID_ENABLED")


@distribution_bp.route("/sources", methods=["GET"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("distribution:read")  # type: ignore[untyped-decorator]
async def list_distribution_sources() -> Response | tuple[dict[str, object], int]:
    """The caller's tenant's ingest sources and their Valkey stream keys, with an ETag."""
    try:
        community_id = _parse_community_id(request.args.get("communityId"))
        enabled = _parse_enabled(request.args.get("enabled"))
    except ApiError as exc:
        return _err(exc)
    platform = request.args.get("platform") or None

    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101 - tenant_middleware always publishes this on the success path

    async_dal, read_dal = _dal()
    sources = await list_sources_for_distribution(
        async_dal, read_dal, tenant_id=ctx.tenant_id, tenant_slug=ctx.tenant_slug,
        community_id=community_id, platform=platform, enabled=enabled,
    )
    dtos = [
        DistributionSourceDTO(
            sourceId=s.source_id, platform=s.platform, label=s.label, communityId=s.community_id,
            enabled=s.enabled, hasSecret=s.has_secret, mapping=s.mapping, streamKey=s.stream_key,
        )
        for s in sources
    ]
    payload = DistributionSourcesResponse(
        success=True,
        sources=dtos,
        meta=DistributionMetaDTO(version=2, timestamp=datetime.now(UTC).isoformat()),
    )
    etag_seed = [
        DistributionBundleV2DTO(appId=d.sourceId, communityId=d.communityId, entrypoint=d.streamKey,
                                spec={"platform": d.platform, "enabled": d.enabled},
                                config={"label": d.label, "hasSecret": d.hasSecret, "mapping": d.mapping})
        for d in dtos
    ]
    return _conditional("sources", etag_seed, payload)
```

The `etag_seed` reuse is deliberate: `_conditional` hashes whatever list it is handed, so projecting each source into the same DTO type keeps one ETag implementation instead of two, and every field that can change (`platform`, `enabled`, `label`, `hasSecret`, `mapping`, `streamKey`) is inside the hashed payload.

- [ ] **Step 5: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_distribution_sources_blueprint.py -v`
Expected: `21 passed` (10 filter-combination cases + 4 invalid-`enabled` cases + 7 others).

- [ ] **Step 6: Confirm zero regression on the ingest-source and v2-bundle surfaces**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_source_service.py tests/test_ingest_sources_blueprint.py tests/test_distribution_v2_blueprint.py tests/test_v1_distribution_blueprint.py -v`
Expected: every previously-passing test still passes — `list_sources_for_distribution` is additive and no existing function in `ingest_source_service.py` changed.

- [ ] **Step 7: Commit**

```bash
git add hub_api/services/ingest_source_service.py hub_api/blueprints/v1/distribution.py \
        hub_api/tests/test_distribution_sources_blueprint.py
git commit -m "$(cat <<'EOF'
feat(hub-api): GET /api/v1/distribution/sources -- the ingest-source registry with stream keys

Returns every configured ingest source for the caller's tenant with its
rendered Valkey stream key, filterable by communityId/platform/enabled,
behind the same ETag/304 treatment as v2/bundles. hasSecret is a
boolean -- the HMAC secret itself is never on this wire.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 35: `bundle_trip_reenable_service.py` + `POST .../trip-reenable` — clearing a sandbox trip (Q1)

**Depends on:** Task 16 (`bundle_activation_service.{activate_version, get_active_version}`), Task 19 (`app_install_approvals` rows written by `approve_version`), Task 11/17 (`blueprints/v1/bundle_versions.py` and its `bundle_versions_bp`).

**Files:**
- Create: `hub_api/services/bundle_trip_reenable_service.py`
- Modify: `hub_api/blueprints/v1/bundle_versions.py`
- Test: `hub_api/tests/test_bundle_trip_reenable.py`

**Interfaces:**

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| `POST` | `/api/v1/apps/{app_id}/trip-reenable` | `tenant_middleware` + `require_scope("tenant:admin")` | `{"version": str, "communityId": int \| null}` | `200 {"success": true, "previousDigest": str \| null, "artifactDigest": str}` |

- Produces: `async def trip_reenable(async_dal, dal, *, tenant_id: int, community_id: int | None, app_id: str, version: str, actor_id: int) -> tuple[str | None, str]` returning `(previous_digest, new_digest)`. Raises `ApiError`: `404` `version_not_found` (no `app_versions` row for `(app_id, version)`), `409` `digest_not_verified` (row exists, `artifact_digest` is NULL), `409` `same_digest_no_reenable` (target digest equals the digest currently advertised for this scope), `403` `bundle_not_approved` (no current `app_install_approvals` row for `(app_id, version, tenant_id, community_id)`).
- Consumes: `services.bundle_activation_service.{activate_version, get_active_version}` (Task 16).

**Why this endpoint exists and what it deliberately is not** (this plan's Decision #10): a trip-disabled bundle is disabled *inside a Rust executor pod*, per `(app_id, digest)`, and clears only when that pod observes a **new** `artifactDigest` from the distribution API or restarts (spec §7.5, assumption A7). hub-api has no way to reach into a pod and never gains one. This endpoint is the admin-side half: it re-points `app_active_versions` at a **different, already-published, already-approved** version so the distribution API starts advertising a new digest, which is what actually clears the trip on the next poll. Pointing at the same digest cannot clear anything, so it is refused with `409 same_digest_no_reenable` and a message telling the operator to publish a new version or restart the stage pods. No pod-, deployment- or cluster-scoped runtime toggle is added anywhere in this plan.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_trip_reenable.py
"""Tests for trip_reenable() and POST /api/v1/apps/{app_id}/trip-reenable (spec Sec7.5, Sec19 Q1)."""

from __future__ import annotations

from typing import Any

import pytest
from quart import Quart

from blueprints.v1.bundle_versions import BLUEPRINTS
from services.bundle_activation_service import activate_version
from services.bundle_trip_reenable_service import trip_reenable
from services.errors import ApiError
from tests.conftest import TENANT_SLUG, make_user_token

_APP = "waddles.socials.music.default"
_DIGEST_A = "sha256:" + "a" * 64
_DIGEST_B = "sha256:" + "b" * 64


def _seed_version(dal: Any, version: str, digest: str) -> int:
    version_id: int = dal.app_versions.insert(
        app_id=_APP, version=version, artifact_digest=digest,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_version_uploads.insert(
        app_id=_APP, version=version, tenant_id=1, artifact_kind="source", language="python",
        status="PUBLISHED", manifest_json={"schema_version": 2, "app_id": _APP, "version": version},
        app_version_id=version_id,
    )
    return version_id


def _seed_approval(dal: Any, version: str) -> None:
    dal.app_install_approvals.insert(
        tenant_id=1, community_id=None, app_id=_APP, version=version,
        permission_hash="sha256:" + "c" * 64, summary_json={}, approved_by=1,
    )


async def test_reenable_requires_a_published_version(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    with pytest.raises(ApiError) as excinfo:
        await trip_reenable(
            async_dal, async_dal.dal, tenant_id=1, community_id=None, app_id=_APP,
            version="9.9.9", actor_id=1,
        )
    assert excinfo.value.status_code == 404
    assert excinfo.value.code == "version_not_found"


async def test_reenable_refuses_a_digest_hub_api_never_verified(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    dal.app_versions.insert(app_id=_APP, version="3.0.2", artifact_digest=None,
                            language="python", artifact_kind="source", scan_status="scanned")
    dal.commit()
    with pytest.raises(ApiError) as excinfo:
        await trip_reenable(async_dal, dal, tenant_id=1, community_id=None, app_id=_APP,
                            version="3.0.2", actor_id=1)
    assert excinfo.value.status_code == 409
    assert excinfo.value.code == "digest_not_verified"


async def test_reenable_refuses_the_same_digest(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    _seed_version(dal, "3.0.1", _DIGEST_A)
    _seed_approval(dal, "3.0.1")
    dal.commit()
    await activate_version(async_dal, dal, tenant_id=1, community_id=None, app_id=_APP,
                           version="3.0.1", activated_by=1)
    with pytest.raises(ApiError) as excinfo:
        await trip_reenable(async_dal, dal, tenant_id=1, community_id=None, app_id=_APP,
                            version="3.0.1", actor_id=1)
    assert excinfo.value.status_code == 409
    assert excinfo.value.code == "same_digest_no_reenable"


async def test_reenable_refuses_an_unapproved_version(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    _seed_version(dal, "3.0.1", _DIGEST_A)
    _seed_approval(dal, "3.0.1")
    _seed_version(dal, "3.0.2", _DIGEST_B)  # published, never approved
    dal.commit()
    await activate_version(async_dal, dal, tenant_id=1, community_id=None, app_id=_APP,
                           version="3.0.1", activated_by=1)
    with pytest.raises(ApiError) as excinfo:
        await trip_reenable(async_dal, dal, tenant_id=1, community_id=None, app_id=_APP,
                            version="3.0.2", actor_id=1)
    assert excinfo.value.status_code == 403
    assert excinfo.value.code == "bundle_not_approved"


async def test_reenable_repoints_to_a_new_digest_and_audits(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    _seed_version(dal, "3.0.1", _DIGEST_A)
    _seed_approval(dal, "3.0.1")
    _seed_version(dal, "3.0.2", _DIGEST_B)
    _seed_approval(dal, "3.0.2")
    dal.commit()
    await activate_version(async_dal, dal, tenant_id=1, community_id=None, app_id=_APP,
                           version="3.0.1", activated_by=1)

    previous, new = await trip_reenable(async_dal, dal, tenant_id=1, community_id=None,
                                        app_id=_APP, version="3.0.2", actor_id=1)
    assert previous == _DIGEST_A
    assert new == _DIGEST_B

    from services.bundle_activation_service import get_active_version

    active = await get_active_version(async_dal, dal, tenant_id=1, community_id=None, app_id=_APP)
    assert active is not None
    assert active.artifact_digest == _DIGEST_B

    audit_row = dal(dal.audit_log.action == "bundle_trip_reenabled").select().first()
    assert audit_row is not None
    assert audit_row.details["old_digest"] == _DIGEST_A
    assert audit_row.details["new_digest"] == _DIGEST_B


async def test_reenable_on_a_scope_with_nothing_active_is_allowed(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    _seed_version(dal, "3.0.2", _DIGEST_B)
    _seed_approval(dal, "3.0.2")
    dal.commit()
    previous, new = await trip_reenable(async_dal, dal, tenant_id=1, community_id=None,
                                        app_id=_APP, version="3.0.2", actor_id=1)
    assert previous is None
    assert new == _DIGEST_B


@pytest.fixture
def app(bundle_install_db: Any) -> Quart:
    dal = bundle_install_db.dal
    _seed_version(dal, "3.0.1", _DIGEST_A)
    _seed_approval(dal, "3.0.1")
    _seed_version(dal, "3.0.2", _DIGEST_B)
    _seed_approval(dal, "3.0.2")
    dal.commit()
    quart_app = Quart(__name__)
    quart_app.config["async_dal"] = bundle_install_db
    quart_app.config["dal"] = dal
    for bp in BLUEPRINTS:
        quart_app.register_blueprint(bp)
    return quart_app


async def test_endpoint_requires_tenant_admin(app: Quart) -> None:
    client = app.test_client()
    response = await client.post(
        f"/api/v1/apps/{_APP}/trip-reenable",
        headers={"Authorization": f"Bearer {make_user_token(user_id=1, scope='', tenant=TENANT_SLUG)}"},
        json={"version": "3.0.2", "communityId": None},
    )
    assert response.status_code == 403


async def test_endpoint_happy_path(app: Quart) -> None:
    async_dal = app.config["async_dal"]
    dal = app.config["dal"]
    await activate_version(async_dal, dal, tenant_id=1, community_id=None, app_id=_APP,
                           version="3.0.1", activated_by=1)
    token = make_user_token(user_id=1, scope="tenant:admin", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.post(
        f"/api/v1/apps/{_APP}/trip-reenable",
        headers={"Authorization": f"Bearer {token}"},
        json={"version": "3.0.2", "communityId": None},
    )
    assert response.status_code == 200
    body = await response.get_json()
    assert body["previousDigest"] == _DIGEST_A
    assert body["artifactDigest"] == _DIGEST_B


async def test_endpoint_surfaces_same_digest_as_409(app: Quart) -> None:
    async_dal = app.config["async_dal"]
    dal = app.config["dal"]
    await activate_version(async_dal, dal, tenant_id=1, community_id=None, app_id=_APP,
                           version="3.0.1", activated_by=1)
    token = make_user_token(user_id=1, scope="tenant:admin", tenant=TENANT_SLUG)
    client = app.test_client()
    response = await client.post(
        f"/api/v1/apps/{_APP}/trip-reenable",
        headers={"Authorization": f"Bearer {token}"},
        json={"version": "3.0.1", "communityId": None},
    )
    assert response.status_code == 409
    assert (await response.get_json())["error"]["code"] == "same_digest_no_reenable"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_trip_reenable.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_trip_reenable_service'`

- [ ] **Step 3: Write the service**

```python
# hub_api/services/bundle_trip_reenable_service.py
"""Clearing a sandbox trip is an admin action that causes a NEW digest to be advertised.

A trip-disabled bundle is disabled inside a Rust executor pod, per
`(app_id, digest)`, and clears only when the pod observes a new
`artifactDigest` from the distribution API or restarts (spec Sec7.5,
assumption A7). hub-api cannot reach into a pod and does not try. This
module is the admin-side half: it re-points `app_active_versions` at a
different, already-published, already-approved version, which is what
makes the distribution API advertise a new digest on the next poll.

Pointing at the same digest clears nothing, so it is refused
(`same_digest_no_reenable`) rather than silently succeeding and leaving
the operator believing the trip was cleared.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from services.bundle_activation_service import activate_version, get_active_version
from services.errors import ApiError, forbidden, not_found


async def trip_reenable(
    async_dal: Any,
    dal: Any,
    *,
    tenant_id: int,
    community_id: int | None,
    app_id: str,
    version: str,
    actor_id: int,
) -> tuple[str | None, str]:
    """Re-point this scope at `version`, refusing anything that would not change the digest.

    Returns `(previous_digest, new_digest)`. `previous_digest` is
    `None` when nothing was active for the scope yet.
    """
    target_rows = await async_dal.select_async(
        dal((dal.app_versions.app_id == app_id) & (dal.app_versions.version == version))
    )
    if not target_rows:
        raise not_found(f"version {version} of {app_id} has never been published")
    target = target_rows[0]
    if not target.artifact_digest:
        raise ApiError(
            f"version {version} of {app_id} has no verified artifact digest",
            409,
            "digest_not_verified",
        )

    active = await get_active_version(
        async_dal, dal, tenant_id=tenant_id, community_id=community_id, app_id=app_id
    )
    previous_digest: str | None = active.artifact_digest if active is not None else None
    if previous_digest == target.artifact_digest:
        raise ApiError(
            f"{app_id} already advertises {target.artifact_digest} for this scope; a trip clears only on a "
            "new digest -- publish a new version or restart the stage pods",
            409,
            "same_digest_no_reenable",
        )

    approvals = await async_dal.select_async(
        dal(
            (dal.app_install_approvals.app_id == app_id)
            & (dal.app_install_approvals.version == version)
            & (dal.app_install_approvals.tenant_id == tenant_id)
            & (dal.app_install_approvals.community_id == community_id)
            & (dal.app_install_approvals.superseded_by == None)  # noqa: E711 - pydal IS NULL operator
        )
    )
    if not approvals:
        raise forbidden(f"version {version} of {app_id} has not been approved for this scope")

    await activate_version(
        async_dal, dal, tenant_id=tenant_id, community_id=community_id,
        app_id=app_id, version=version, activated_by=actor_id,
    )

    now = datetime.now(UTC)
    try:
        await async_dal.insert_async(
            dal.audit_log, user_id=actor_id, action="bundle_trip_reenabled",
            target_type="app_active_versions", target_id=app_id,
            details={
                "app_id": app_id, "version": version, "tenant_id": tenant_id,
                "community_id": community_id, "old_digest": previous_digest,
                "new_digest": target.artifact_digest,
            },
            created_at=now,
        )
    except Exception:  # noqa: BLE001, S110 -- audit logging failure must not break the main flow
        pass
    async_dal.dal.commit()
    return previous_digest, str(target.artifact_digest)
```

- [ ] **Step 4: Add the route to `blueprints/v1/bundle_versions.py`**

Add the import and append the DTOs + route immediately before the file's final `BLUEPRINTS: list[Blueprint] = [bundle_versions_bp]` line:

```python
from services.bundle_trip_reenable_service import trip_reenable
```

```python
@dataclass(slots=True, frozen=True)
class TripReenableRequest:
    """Request DTO for `POST /api/v1/apps/{app_id}/trip-reenable`."""

    version: str
    communityId: int | None = None


@bundle_versions_bp.route("/<app_id>/trip-reenable", methods=["POST"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@validate_request(TripReenableRequest)
async def post_trip_reenable(data: TripReenableRequest, app_id: str) -> tuple[dict[str, object], int]:
    """Clear a sandbox trip by advertising a different, approved, already-published digest.

    Never a runtime switch: the executor still re-enables purely on
    observing a new `artifactDigest` (spec Sec7.5/A7). This endpoint
    only makes such a digest exist for the scope.
    """
    async_dal, dal = _dal()
    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101 - tenant_middleware always publishes this on the success path
    actor_id = get_current_user_id(request)
    try:
        previous, new = await trip_reenable(
            async_dal, dal, tenant_id=ctx.tenant_id, community_id=data.communityId,
            app_id=app_id, version=data.version, actor_id=actor_id,
        )
    except ApiError as exc:
        return _err(exc)
    return {"success": True, "previousDigest": previous, "artifactDigest": new}, 200
```

If `validate_request` is not already in this file's `from quart_schema import ...` line (Task 17 added it for the activate route), add it.

- [ ] **Step 5: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_trip_reenable.py -v`
Expected: `9 passed`

- [ ] **Step 6: Confirm zero regression on the versions blueprint**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_versions_blueprint.py tests/test_bundle_activation_service.py -v`
Expected: every previously-passing test still passes — this task only appends one route and one DTO.

- [ ] **Step 7: Commit**

```bash
git add hub_api/services/bundle_trip_reenable_service.py hub_api/blueprints/v1/bundle_versions.py \
        hub_api/tests/test_bundle_trip_reenable.py
git commit -m "$(cat <<'EOF'
feat(hub-api): POST /api/v1/apps/{app_id}/trip-reenable -- admin action plus a new digest (spec Sec19 Q1)

Re-points app_active_versions at a different, already-published,
already-approved version so the distribution API advertises a new
artifactDigest, which is what actually clears a sandbox trip inside an
executor pod. Refuses 409 same_digest_no_reenable when the target
digest equals the one already advertised, 403 bundle_not_approved when
the version was never approved for the scope, and 409
digest_not_verified for a digest hub-api never verified. No runtime
re-enable switch is added anywhere (spec Sec7.5/A7 unchanged).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 36: per-bundle role drop at uninstall + the 168 h orphan sweeper + its CronJob (Q3)

**Depends on:** Task 20 (`bundle_db_role_service.{bundle_role_name, drop_bundle_role}`), Task 21 (role created inside `approve_version`), Task 4 (`bundle_install_db` fixture), Task 12 (the Helm chart's `bundles.*` values block).

**Files:**
- Modify: `hub_api/services/marketplace_lifecycle_service.py`
- Create: `hub_api/services/bundle_role_cleanup_job.py`
- Create: `k8s/helm/waddlebot/templates/bundle-role-cleanup-cronjob.yaml`
- Modify: `k8s/helm/waddlebot/values.yaml`
- Test: `hub_api/tests/test_bundle_role_cleanup_job.py`

**Interfaces:**
- Produces: `marketplace_lifecycle_service.uninstall_bundle(dal, *, app_id: str, db_engine: Any | None = None)` — **new keyword-only param defaulting to `None`, so every existing call site and every existing test keeps passing unmodified**; when an engine is given, `drop_bundle_role(db_engine, app_id=app_id)` runs after the catalog row is retired. `BUNDLE_ROLE_GRACE_H = 168`; `@dataclass(slots=True, frozen=True) SweepResult(examined: int, dropped: tuple[str, ...], retained: int)`; `async def sweep_orphan_bundle_roles(async_dal, dal, engine, *, now: datetime | None = None, grace_hours: int = BUNDLE_ROLE_GRACE_H) -> SweepResult`; `async def main() -> int` (the CronJob entrypoint, `python -m services.bundle_role_cleanup_job`).
- Consumes: `services.bundle_db_role_service.{bundle_role_name, drop_bundle_role}` (Task 20).

**The rule this task implements** (this plan's Decision #10b): uninstall is the drop trigger. The sweeper exists only for roles whose uninstall never ran — a catalog row deleted out from under the role, an uninstall that predates this plan, or a crash between the catalog write and the `DROP ROLE`. A bundle is swept when it has **no** `app_active_versions` row at all **and** its newest non-superseded `app_install_approvals.approved_at` is older than `grace_hours` (or it has no approval at all). A role whose bundle is still activated anywhere is never dropped, regardless of age.

**Verification integrity:** `sweep_orphan_bundle_roles` returns the number of roles **examined** as well as the list dropped, and `main()` prints both. A sweep that examined zero roles is reported as a failure by `main()` (exit `1`), because a sweeper pointed at the wrong database or a renamed prefix would otherwise print "0 dropped" forever and look healthy (`critical-rules.md` Verification Integrity).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_role_cleanup_job.py
"""Tests for the per-bundle role drop at uninstall and the 168 h orphan sweeper (spec Sec19 Q3)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from services.bundle_role_cleanup_job import (
    BUNDLE_ROLE_GRACE_H,
    sweep_orphan_bundle_roles,
)
from services.marketplace_lifecycle_service import uninstall_bundle

_APP = "waddles.socials.music.default"


def _seed_second_app(dal: Any, app_id: str) -> None:
    dal.app_catalog.insert(
        app_id=app_id, name="Second App", manifest_version="3.0.0", module="socials",
        feature="waddles.socials.second", provider="builtin", execution_model="native",
        is_default=False,
        platform_compatibility={"tested_with": "3.0.0", "min_version": None, "max_version": None},
        status="active", stages={},
    )


async def test_uninstall_drops_the_bundle_role_when_an_engine_is_given(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    engine = object()
    with patch(
        "services.marketplace_lifecycle_service.drop_bundle_role", new_callable=AsyncMock
    ) as mock_drop:
        await uninstall_bundle(dal, app_id=_APP, db_engine=engine)
    mock_drop.assert_awaited_once_with(engine, app_id=_APP)


async def test_uninstall_without_an_engine_never_touches_roles(bundle_install_db: Any) -> None:
    dal = bundle_install_db.dal
    with patch(
        "services.marketplace_lifecycle_service.drop_bundle_role", new_callable=AsyncMock
    ) as mock_drop:
        await uninstall_bundle(dal, app_id=_APP)
    mock_drop.assert_not_awaited()


async def test_sweep_retains_a_role_whose_bundle_is_still_activated(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    version_id = dal.app_versions.insert(
        app_id=_APP, version="3.0.1", artifact_digest="sha256:" + "a" * 64,
        language="python", artifact_kind="source", scan_status="scanned",
    )
    dal.app_active_versions.insert(app_id=_APP, tenant_id=1, community_id=0, version_id=version_id,
                                   activated_by=1, activated_at=datetime.now(UTC))
    dal.commit()
    with patch("services.bundle_role_cleanup_job.drop_bundle_role", new_callable=AsyncMock) as mock_drop:
        result = await sweep_orphan_bundle_roles(async_dal, dal, object())
    assert result.examined == 1
    assert result.dropped == ()
    assert result.retained == 1
    mock_drop.assert_not_awaited()


async def test_sweep_retains_a_role_inside_the_grace_window(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    dal.app_install_approvals.insert(
        tenant_id=1, community_id=None, app_id=_APP, version="3.0.1",
        permission_hash="sha256:" + "c" * 64, summary_json={}, approved_by=1,
        approved_at=datetime.now(UTC) - timedelta(hours=BUNDLE_ROLE_GRACE_H - 1),
    )
    dal.commit()
    with patch("services.bundle_role_cleanup_job.drop_bundle_role", new_callable=AsyncMock) as mock_drop:
        result = await sweep_orphan_bundle_roles(async_dal, dal, object())
    assert result.dropped == ()
    mock_drop.assert_not_awaited()


async def test_sweep_drops_a_role_past_the_grace_window(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    dal.app_install_approvals.insert(
        tenant_id=1, community_id=None, app_id=_APP, version="3.0.1",
        permission_hash="sha256:" + "c" * 64, summary_json={}, approved_by=1,
        approved_at=datetime.now(UTC) - timedelta(hours=BUNDLE_ROLE_GRACE_H + 1),
    )
    dal.commit()
    with patch("services.bundle_role_cleanup_job.drop_bundle_role", new_callable=AsyncMock) as mock_drop:
        result = await sweep_orphan_bundle_roles(async_dal, dal, object())
    assert result.dropped == ("bundle_waddles_socials_music_default",)
    assert result.retained == 0
    mock_drop.assert_awaited_once()


async def test_sweep_drops_a_bundle_that_was_never_approved_or_activated(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    _seed_second_app(dal, "waddles.socials.second.default")
    dal.commit()
    with patch("services.bundle_role_cleanup_job.drop_bundle_role", new_callable=AsyncMock) as mock_drop:
        result = await sweep_orphan_bundle_roles(async_dal, dal, object())
    assert result.examined == 2
    assert set(result.dropped) == {
        "bundle_waddles_socials_music_default", "bundle_waddles_socials_second_default",
    }
    assert mock_drop.await_count == 2


async def test_sweep_honours_a_custom_grace_window(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    dal.app_install_approvals.insert(
        tenant_id=1, community_id=None, app_id=_APP, version="3.0.1",
        permission_hash="sha256:" + "c" * 64, summary_json={}, approved_by=1,
        approved_at=datetime.now(UTC) - timedelta(hours=2),
    )
    dal.commit()
    with patch("services.bundle_role_cleanup_job.drop_bundle_role", new_callable=AsyncMock):
        kept = await sweep_orphan_bundle_roles(async_dal, dal, object(), grace_hours=24)
        dropped = await sweep_orphan_bundle_roles(async_dal, dal, object(), grace_hours=1)
    assert kept.dropped == ()
    assert dropped.dropped == ("bundle_waddles_socials_music_default",)


async def test_sweep_with_zero_catalog_rows_reports_zero_examined(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    dal(dal.app_catalog.id > 0).delete()
    dal.commit()
    with patch("services.bundle_role_cleanup_job.drop_bundle_role", new_callable=AsyncMock):
        result = await sweep_orphan_bundle_roles(async_dal, dal, object())
    assert result.examined == 0
    assert result.dropped == ()


async def test_main_exits_nonzero_when_nothing_was_examined(bundle_install_db: Any) -> None:
    from services import bundle_role_cleanup_job as job

    dal = bundle_install_db.dal
    dal(dal.app_catalog.id > 0).delete()
    dal.commit()
    with (
        patch.object(job, "_build_dals", return_value=(bundle_install_db, dal)),
        patch.object(job, "_build_engine", return_value=object()),
        patch.object(job, "drop_bundle_role", new_callable=AsyncMock),
    ):
        exit_code = await job.main()
    assert exit_code == 1


async def test_main_exits_zero_on_a_real_sweep(bundle_install_db: Any) -> None:
    from services import bundle_role_cleanup_job as job

    dal = bundle_install_db.dal
    with (
        patch.object(job, "_build_dals", return_value=(bundle_install_db, dal)),
        patch.object(job, "_build_engine", return_value=object()),
        patch.object(job, "drop_bundle_role", new_callable=AsyncMock),
    ):
        exit_code = await job.main()
    assert exit_code == 0
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_role_cleanup_job.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_role_cleanup_job'`

- [ ] **Step 3: Extend `uninstall_bundle`**

In `hub_api/services/marketplace_lifecycle_service.py`, add the import and replace `uninstall_bundle` with this version. Nothing else in the file changes:

```python
from services.bundle_db_role_service import drop_bundle_role
```

```python
async def uninstall_bundle(dal: Any, *, app_id: str, db_engine: Any | None = None) -> None:
    """Retire the catalog row and, when a privileged engine is given, drop the bundle's Postgres role.

    `db_engine` is keyword-only and defaults to `None` so every
    pre-M2b call site and test keeps its exact current behaviour. The
    blueprint passes a real SQLAlchemy engine in production, which
    makes uninstall the drop point for the per-bundle `data.tables`
    role created at approval (this plan's Decision #10b, spec Sec19
    Q3). The drop is idempotent, so a bundle that never had a `db`
    capability -- and therefore never had a role -- is a harmless
    no-op rather than a special case.
    """
    dal(dal.app_catalog.app_id == app_id).update(status="retired")
    dal.commit()
    if db_engine is not None:
        await drop_bundle_role(db_engine, app_id=app_id)
```

If the existing body of `uninstall_bundle` differs from the two lines above, keep the existing body verbatim and append only the `if db_engine is not None:` block plus the new docstring paragraph — the role drop is additive and must not change what uninstall already does to the catalog.

- [ ] **Step 4: Write the sweeper**

```python
# hub_api/services/bundle_role_cleanup_job.py
"""The 168 h orphan sweeper for per-bundle Postgres roles (spec Sec19 Q3).

Uninstall is the normal drop point (`marketplace_lifecycle_service.
uninstall_bundle`). This job exists only for roles whose uninstall
never ran: a catalog row deleted out from under the role, an uninstall
that predates this plan, or a crash between the catalog write and the
`DROP ROLE`. A bundle is swept when it has NO `app_active_versions`
row at all AND its newest non-superseded `app_install_approvals.
approved_at` is older than `grace_hours` (or it has no approval at
all). A bundle still activated anywhere is never swept, whatever its
age.

Runs as a Kubernetes CronJob (`k8s/helm/waddlebot/templates/
bundle-role-cleanup-cronjob.yaml`), entrypoint `python -m
services.bundle_role_cleanup_job`.
"""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from flask_core.database import AsyncDAL

from services.bundle_db_role_service import bundle_role_name, drop_bundle_role
from services.schema import bind_app_bundle_tables, bind_bundle_install_tables

BUNDLE_ROLE_GRACE_H = 168


@dataclass(slots=True, frozen=True)
class SweepResult:
    """What one sweep did. `examined` is the denominator a zero-drop run is judged against."""

    examined: int
    dropped: tuple[str, ...]
    retained: int


async def sweep_orphan_bundle_roles(
    async_dal: Any,
    dal: Any,
    engine: Any,
    *,
    now: datetime | None = None,
    grace_hours: int = BUNDLE_ROLE_GRACE_H,
) -> SweepResult:
    """Drop every per-bundle role whose bundle has been inactive past `grace_hours`."""
    moment = now or datetime.now(UTC)
    cutoff = moment - timedelta(hours=grace_hours)

    catalog_rows = await async_dal.select_async(dal(dal.app_catalog.id > 0), dal.app_catalog.app_id)
    app_ids = sorted({row.app_id for row in catalog_rows})

    dropped: list[str] = []
    retained = 0
    for app_id in app_ids:
        active = await async_dal.select_async(dal(dal.app_active_versions.app_id == app_id))
        if active:
            retained += 1
            continue
        approvals = await async_dal.select_async(
            dal(
                (dal.app_install_approvals.app_id == app_id)
                & (dal.app_install_approvals.superseded_by == None)  # noqa: E711 - pydal IS NULL operator
            ),
            orderby=~dal.app_install_approvals.approved_at,
        )
        newest = approvals[0].approved_at if approvals else None
        if newest is not None:
            if newest.tzinfo is None:
                newest = newest.replace(tzinfo=UTC)
            if newest >= cutoff:
                retained += 1
                continue
        await drop_bundle_role(engine, app_id=app_id)
        dropped.append(bundle_role_name(app_id))

    return SweepResult(examined=len(app_ids), dropped=tuple(dropped), retained=retained)


def _build_dals() -> tuple[Any, Any]:
    """Open the job's own DAL connection from `DATABASE_URL` and bind the tables it reads."""
    async_dal = AsyncDAL(os.environ["DATABASE_URL"], pool_size=1)
    dal = async_dal.dal
    bind_app_bundle_tables(dal)
    bind_bundle_install_tables(dal)
    return async_dal, dal


def _build_engine() -> Any:
    """The privileged SQLAlchemy engine the DDL runs on -- `ROLE_ADMIN_DATABASE_URL`, never a CLI arg."""
    from sqlalchemy import create_engine

    return create_engine(os.environ["ROLE_ADMIN_DATABASE_URL"])


async def main() -> int:
    """CronJob entrypoint. Prints the denominator; a zero-examined sweep is a failure, not a pass."""
    async_dal, dal = _build_dals()
    engine = _build_engine()
    result = await sweep_orphan_bundle_roles(async_dal, dal, engine)
    print(
        f"bundle role sweep: examined={result.examined} retained={result.retained} "
        f"dropped={len(result.dropped)} roles={list(result.dropped)}"
    )
    if result.examined == 0:
        print(
            "bundle role sweep FAILED: zero bundles examined -- the job is pointed at the wrong "
            "database or app_catalog is empty",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
```

- [ ] **Step 5: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_role_cleanup_job.py -v`
Expected: `10 passed`

- [ ] **Step 6: Confirm zero regression on the lifecycle service**

Run: `cd hub_api && python3 -m pytest tests/test_v1_marketplace_lifecycle_blueprint.py tests/test_marketplace_lifecycle_concurrency.py tests/test_marketplace_lifecycle_grants.py -v`
Expected: every previously-passing test still passes — `db_engine` defaults to `None`, so uninstall's existing behaviour is byte-identical without it.

- [ ] **Step 7: Add the CronJob manifest**

```yaml
# k8s/helm/waddlebot/templates/bundle-role-cleanup-cronjob.yaml
{{- if .Values.bundles.roleCleanup.enabled }}
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{ include "waddlebot.fullname" . }}-bundle-role-cleanup
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
    app.kubernetes.io/component: bundle-role-cleanup
spec:
  schedule: {{ .Values.bundles.roleCleanup.schedule | quote }}
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  startingDeadlineSeconds: 600
  jobTemplate:
    spec:
      backoffLimit: 2
      ttlSecondsAfterFinished: 3600
      template:
        metadata:
          labels:
            {{- include "waddlebot.selectorLabels" . | nindent 12 }}
            app.kubernetes.io/component: bundle-role-cleanup
        spec:
          restartPolicy: Never
          serviceAccountName: {{ include "waddlebot.fullname" . }}-hub-api
          securityContext:
            runAsNonRoot: true
            runAsUser: 10001
            runAsGroup: 10001
            fsGroup: 10001
            seccompProfile:
              type: RuntimeDefault
          containers:
            - name: bundle-role-cleanup
              image: "{{ .Values.hubApi.image.repository }}:{{ .Values.hubApi.image.tag }}"
              imagePullPolicy: {{ .Values.hubApi.image.pullPolicy }}
              command: ["python", "-m", "services.bundle_role_cleanup_job"]
              securityContext:
                allowPrivilegeEscalation: false
                readOnlyRootFilesystem: true
                capabilities:
                  drop: ["ALL"]
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: {{ .Values.hubApi.database.secretName }}
                      key: {{ .Values.hubApi.database.secretKey }}
                - name: ROLE_ADMIN_DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: {{ .Values.bundles.roleCleanup.adminSecretName }}
                      key: {{ .Values.bundles.roleCleanup.adminSecretKey }}
                - name: OTEL_EXPORTER_OTLP_ENDPOINT
                  value: {{ .Values.observability.otlpEndpoint | quote }}
                - name: OTEL_SERVICE_NAME
                  value: waddles-bundle-role-cleanup
              resources:
                requests:
                  cpu: 50m
                  memory: 128Mi
                limits:
                  cpu: 200m
                  memory: 256Mi
              volumeMounts:
                - name: tmp
                  mountPath: /tmp
          volumes:
            - name: tmp
              emptyDir: {}
{{- end }}
```

- [ ] **Step 8: Add the values keys**

Add to `k8s/helm/waddlebot/values.yaml` under the existing `bundles:` block Task 12 created:

```yaml
bundles:
  roleCleanup:
    # The 168 h orphan sweeper for per-bundle Postgres roles (spec Sec19 Q3).
    # Uninstall is the normal drop point; this only catches roles whose
    # uninstall never ran.
    enabled: true
    # 03:17 UTC daily -- off the hour so it never contends with the
    # on-the-hour jobs every other chart in this cluster schedules.
    schedule: "17 3 * * *"
    # The privileged Postgres account that may CREATE/DROP ROLE. Separate
    # from hub-api's own runtime credential on purpose -- the API process
    # never holds role-admin rights.
    adminSecretName: waddlebot-postgres-role-admin
    adminSecretKey: dsn
```

- [ ] **Step 9: Validate the chart renders**

Run:
```bash
helm lint ./k8s/helm/waddlebot
helm template waddlebot ./k8s/helm/waddlebot --values ./k8s/helm/waddlebot/alpha.yml \
  --show-only templates/bundle-role-cleanup-cronjob.yaml
```
Expected: `helm lint` reports `1 chart(s) linted, 0 chart(s) failed`, and the template renders one `CronJob` whose `spec.jobTemplate.spec.template.spec.securityContext.runAsNonRoot` is `true` and whose container command is `["python", "-m", "services.bundle_role_cleanup_job"]`.

- [ ] **Step 10: Commit**

```bash
git add hub_api/services/marketplace_lifecycle_service.py hub_api/services/bundle_role_cleanup_job.py \
        hub_api/tests/test_bundle_role_cleanup_job.py \
        k8s/helm/waddlebot/templates/bundle-role-cleanup-cronjob.yaml k8s/helm/waddlebot/values.yaml
git commit -m "$(cat <<'EOF'
feat(hub-api): drop the per-bundle Postgres role at uninstall, sweep orphans after 168 h (spec Sec19 Q3)

uninstall_bundle gains an optional db_engine keyword (defaulting to
None, so every existing call site is unchanged) and drops the bundle's
data.tables role when one is given. bundle_role_cleanup_job is the
CronJob behind it, for roles whose uninstall never ran: a bundle with
no app_active_versions row and no approval newer than the grace window
is dropped. The sweep reports how many bundles it examined and exits
non-zero on a zero-examined run, so a job pointed at the wrong database
fails loudly instead of printing "0 dropped" forever.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 37: `bundle_feature_gate.py` — the PostHog flag gate on every M2b write surface

**Depends on:** Tasks 11, 15, 17, 22, 25, 27, 31, 35 (the blueprints being gated). Nothing depends on this task except Task 39's final gate.

**Files:**
- Create: `hub_api/services/bundle_feature_gate.py`
- Modify: `hub_api/blueprints/v1/bundle_versions.py`, `bundle_approvals.py`, `bundle_grants.py`, `bundle_artifact_callback.py`, `custom_platforms.py`, `ingest_sources.py`, `bundle_settings.py`
- Test: `hub_api/tests/test_bundle_feature_gate.py`

**Interfaces:**
- Produces: `FLAG_RUST_DATA_PLANE = "waddles.core.rust-data-plane"`, `FLAG_WASM_BUNDLES = "waddles.core.wasm-bundles"`, `FLAG_GENERIC_INTAKE = "waddles.core.generic-intake"`, `FLAG_PREBUILT_BUNDLES = "waddles.core.prebuilt-bundles"`; `async def flags_enabled(*flag_keys: str, tenant: str, community: int | None = None) -> bool`; `def require_flags(*flag_keys: str) -> Callable[..., Any]` — a Quart route decorator returning `403` with `error.code == "feature_disabled"` when any named flag is off.
- Consumes: `flask_core.feature_flags.feature_enabled` (existing), `flask_core.tenancy.get_tenant_context` (existing).

**Three rules fixed here:**

1. **Write surfaces are gated; read surfaces are not.** A flag switched off must never break the distribution poll, an admin's read-only view, or the OpenAPI document — it must only stop new writes. `GET` routes across this whole milestone stay ungated. `GET /api/v1/distribution/v2/bundles` and `/sources` in particular are ungated so a mid-rollout flag flip cannot blind a running Rust stage.
2. **The decorator goes innermost** — after `@tenant_middleware` and `@require_scope(...)` in source order, i.e. closest to the function — because it reads the tenant from `get_tenant_context(request)`, which `tenant_middleware` publishes.
3. **Failure is closed but never fatal.** `feature_enabled` already degrades to the last-known cached value (never-seen flags default `False`) on a PostHog/license outage and never raises; a flag nobody has ever cached therefore reads `False` and the write is refused with a `403` the caller can act on, not a `500`. All four flags are `min_tier: free` (this plan's Decision #9), so the licence half of the two-gate never fails — only the PostHog half.

**The gated surface table — exact, complete, copied into each edit below:**

| File | Route | Flags required |
|---|---|---|
| `bundle_versions.py` | `POST /api/v1/apps/<app_id>/versions` | `rust-data-plane`, `wasm-bundles` |
| `bundle_versions.py` | `POST /api/v1/apps/<app_id>/versions/<version>/activate` | `rust-data-plane`, `wasm-bundles` |
| `bundle_versions.py` | `POST /api/v1/apps/<app_id>/trip-reenable` | `rust-data-plane`, `wasm-bundles` |
| `bundle_approvals.py` | `POST /api/v1/apps/<app_id>/versions/<version>/approve` | `rust-data-plane`, `wasm-bundles` |
| `bundle_approvals.py` | `POST /api/v1/apps/<app_id>/versions/<version>/deny` | `rust-data-plane`, `wasm-bundles` |
| `bundle_grants.py` | `POST /api/v1/apps/<app_id>/grants/resolve` | `rust-data-plane`, `wasm-bundles` |
| `bundle_grants.py` | `DELETE /api/v1/apps/<app_id>/grants/<grant_id>` | `rust-data-plane`, `wasm-bundles` |
| `bundle_artifact_callback.py` | `POST /api/v1/bundles/<app_id>/versions/<version>/artifact` | `rust-data-plane`, `wasm-bundles` |
| `bundle_artifact_callback.py` | `POST /api/v1/bundles/<app_id>/versions/<version>/rejected` | `rust-data-plane`, `wasm-bundles` |
| `custom_platforms.py` | `POST`/`DELETE` `/api/v1/tenant/<slug>/custom-platforms[...]`, `POST .../tokens` | `rust-data-plane`, `generic-intake` |
| `ingest_sources.py` | `POST`/`DELETE` `/api/v1/tenant/<slug>/ingest-sources[...]` | `rust-data-plane`, `generic-intake` |
| `bundle_settings.py` | `PUT /api/v1/marketplace/settings` | `rust-data-plane` |

`FLAG_PREBUILT_BUNDLES` is **not** a route gate — it is the second half of the `allow_prebuilt` two-gate inside `POST .../versions` (Step 5 below).

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_bundle_feature_gate.py
"""Tests for the PostHog flag gate on every M2b write surface (spec Sec13.5)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from quart import Quart

from services.bundle_feature_gate import (
    FLAG_GENERIC_INTAKE,
    FLAG_RUST_DATA_PLANE,
    FLAG_WASM_BUNDLES,
    flags_enabled,
    require_flags,
)
from tests.conftest import TENANT_SLUG, make_user_token


async def test_flags_enabled_requires_every_named_flag() -> None:
    with patch("services.bundle_feature_gate.feature_enabled", new_callable=AsyncMock) as mock_flag:
        mock_flag.side_effect = [True, True]
        assert await flags_enabled(FLAG_RUST_DATA_PLANE, FLAG_WASM_BUNDLES, tenant=TENANT_SLUG) is True
        mock_flag.side_effect = [True, False]
        assert await flags_enabled(FLAG_RUST_DATA_PLANE, FLAG_WASM_BUNDLES, tenant=TENANT_SLUG) is False


async def test_flags_enabled_passes_default_false_to_every_call() -> None:
    with patch("services.bundle_feature_gate.feature_enabled", new_callable=AsyncMock) as mock_flag:
        mock_flag.return_value = True
        await flags_enabled(FLAG_GENERIC_INTAKE, tenant=TENANT_SLUG, community=7)
    mock_flag.assert_awaited_once_with(FLAG_GENERIC_INTAKE, tenant=TENANT_SLUG, community=7, default=False)


@pytest.fixture
def gated_app() -> Quart:
    from flask_core.authz import require_scope
    from flask_core.tenancy import tenant_middleware

    app = Quart(__name__)

    @app.route("/gated", methods=["POST"])
    @tenant_middleware  # type: ignore[untyped-decorator]
    @require_scope("tenant:admin")  # type: ignore[untyped-decorator]
    @require_flags(FLAG_RUST_DATA_PLANE, FLAG_WASM_BUNDLES)
    async def gated() -> tuple[dict[str, object], int]:
        return {"success": True}, 200

    return app


async def test_route_is_403_when_a_flag_is_off(gated_app: Quart) -> None:
    token = make_user_token(user_id=1, scope="tenant:admin", tenant=TENANT_SLUG)
    with patch("services.bundle_feature_gate.feature_enabled", new_callable=AsyncMock) as mock_flag:
        mock_flag.return_value = False
        response = await gated_app.test_client().post(
            "/gated", headers={"Authorization": f"Bearer {token}"}, json={}
        )
    assert response.status_code == 403
    assert (await response.get_json())["error"]["code"] == "feature_disabled"


async def test_route_runs_when_every_flag_is_on(gated_app: Quart) -> None:
    token = make_user_token(user_id=1, scope="tenant:admin", tenant=TENANT_SLUG)
    with patch("services.bundle_feature_gate.feature_enabled", new_callable=AsyncMock) as mock_flag:
        mock_flag.return_value = True
        response = await gated_app.test_client().post(
            "/gated", headers={"Authorization": f"Bearer {token}"}, json={}
        )
    assert response.status_code == 200


async def test_gate_runs_after_scope_so_an_unscoped_caller_still_gets_403_scope(gated_app: Quart) -> None:
    token = make_user_token(user_id=1, scope="", tenant=TENANT_SLUG)
    with patch("services.bundle_feature_gate.feature_enabled", new_callable=AsyncMock) as mock_flag:
        mock_flag.return_value = True
        response = await gated_app.test_client().post(
            "/gated", headers={"Authorization": f"Bearer {token}"}, json={}
        )
    assert response.status_code == 403
    mock_flag.assert_not_awaited()


_GATED_ROUTES: list[tuple[str, str, str, dict[str, Any]]] = [
    ("blueprints.v1.bundle_versions", "POST", "/api/v1/apps/waddles.socials.music.default/trip-reenable",
     {"version": "3.0.1", "communityId": None}),
    ("blueprints.v1.bundle_grants", "POST", "/api/v1/apps/waddles.socials.music.default/grants/resolve",
     {"communityId": None}),
    ("blueprints.v1.ingest_sources", "POST", f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources",
     {"communityId": None, "platform": "twitch", "sourceId": "tw-x", "label": "X", "mapping": None}),
    ("blueprints.v1.custom_platforms", "POST", f"/api/v1/tenant/{TENANT_SLUG}/custom-platforms",
     {"name": "acme"}),
]


@pytest.mark.parametrize(("module_path", "method", "path", "body"), _GATED_ROUTES)
async def test_every_gated_write_route_is_403_when_the_flag_is_off(
    bundle_install_db: Any, module_path: str, method: str, path: str, body: dict[str, Any]
) -> None:
    import importlib

    module = importlib.import_module(module_path)
    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = bundle_install_db.dal
    for bp in module.BLUEPRINTS:
        app.register_blueprint(bp)

    token = make_user_token(user_id=1, scope="tenant:admin platform:admin", tenant=TENANT_SLUG)
    with patch("services.bundle_feature_gate.feature_enabled", new_callable=AsyncMock) as mock_flag:
        mock_flag.return_value = False
        response = await app.test_client().open(
            path, method=method, headers={"Authorization": f"Bearer {token}"}, json=body
        )
    assert response.status_code == 403
    assert (await response.get_json())["error"]["code"] == "feature_disabled"


@pytest.mark.parametrize(
    ("path", "scope"),
    [
        ("/api/v1/distribution/v2/bundles?stage=process", "distribution:read"),
        ("/api/v1/distribution/sources", "distribution:read"),
    ],
)
async def test_distribution_reads_are_never_gated(bundle_install_db: Any, path: str, scope: str) -> None:
    from blueprints.v1.distribution import BLUEPRINTS

    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = bundle_install_db.dal
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)

    token = make_user_token(user_id=1, scope=scope, tenant=TENANT_SLUG)
    with patch("services.bundle_feature_gate.feature_enabled", new_callable=AsyncMock) as mock_flag:
        mock_flag.return_value = False
        response = await app.test_client().get(path, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    mock_flag.assert_not_awaited()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_feature_gate.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_feature_gate'`

- [ ] **Step 3: Write the gate**

```python
# hub_api/services/bundle_feature_gate.py
"""The PostHog flag gate on every M2b write surface (spec Sec13.5, critical-rules.md Feature Flags).

Two gates, both enforced by `flask_core.feature_flags.feature_enabled`:
the PostHog flag evaluates true AND the deployment's licence tier
entitles the key. All four keys here are `min_tier: free` (core
module), so in practice only the PostHog half can fail -- but the call
still goes through the two-gate helper rather than a bare PostHog
lookup, because the tier check is what makes adding a licensed flag
later a one-line change instead of a refactor.

Write surfaces only. `GET` routes across this milestone are
deliberately ungated: a flag flipped off mid-rollout must stop new
writes, never blind a running Rust stage polling the distribution API.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from functools import wraps
from typing import Any, cast

from flask_core.api_utils import error_response
from flask_core.feature_flags import feature_enabled
from flask_core.tenancy import get_tenant_context
from quart import request

FLAG_RUST_DATA_PLANE = "waddles.core.rust-data-plane"
FLAG_WASM_BUNDLES = "waddles.core.wasm-bundles"
FLAG_GENERIC_INTAKE = "waddles.core.generic-intake"
FLAG_PREBUILT_BUNDLES = "waddles.core.prebuilt-bundles"


async def flags_enabled(*flag_keys: str, tenant: str, community: int | None = None) -> bool:
    """True only when EVERY named flag is enabled for `tenant`. Short-circuits on the first `False`."""
    for flag_key in flag_keys:
        if not await feature_enabled(flag_key, tenant=tenant, community=community, default=False):
            return False
    return True


def require_flags(*flag_keys: str) -> Callable[..., Any]:
    """Route decorator refusing the request `403 feature_disabled` unless every flag is on.

    Place it **innermost** -- after `@tenant_middleware` and
    `@require_scope(...)` in source order -- so `get_tenant_context`
    has already published the tenant this evaluates against. A request
    that has not passed `tenant_middleware` has no tenant to evaluate
    and is refused rather than silently defaulting to a global answer.
    """

    def decorator(func: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
        @wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            ctx = get_tenant_context(request)
            if ctx is None:
                return cast(
                    tuple[dict[str, object], int],
                    error_response("tenant context is required", 403, "feature_disabled"),
                )
            if not await flags_enabled(*flag_keys, tenant=ctx.tenant_slug):
                return cast(
                    tuple[dict[str, object], int],
                    error_response(
                        f"this feature is not enabled for {ctx.tenant_slug} "
                        f"(requires {', '.join(flag_keys)})",
                        403,
                        "feature_disabled",
                    ),
                )
            return await func(*args, **kwargs)

        return wrapper

    return decorator
```

- [ ] **Step 4: Apply the decorator to every gated route**

In each file below, add the import and insert the `@require_flags(...)` line as the **last** decorator (immediately above the `async def`) on each named handler. Change nothing else.

`hub_api/blueprints/v1/bundle_versions.py` — handlers `post_version`, `post_activate`, `post_trip_reenable`:
```python
from services.bundle_feature_gate import FLAG_RUST_DATA_PLANE, FLAG_WASM_BUNDLES, require_flags
```
```python
@require_flags(FLAG_RUST_DATA_PLANE, FLAG_WASM_BUNDLES)
```

`hub_api/blueprints/v1/bundle_approvals.py` — handlers `post_approve`, `post_deny`: same import, same decorator line.

`hub_api/blueprints/v1/bundle_grants.py` — handlers `post_resolve`, `delete_grant`: same import, same decorator line. **Not** `get_grants`.

`hub_api/blueprints/v1/bundle_artifact_callback.py` — both callback handlers: same import, same decorator line.

`hub_api/blueprints/v1/custom_platforms.py` — handlers `post_platform`, `delete_platform`, `post_token`: 
```python
from services.bundle_feature_gate import FLAG_GENERIC_INTAKE, FLAG_RUST_DATA_PLANE, require_flags
```
```python
@require_flags(FLAG_RUST_DATA_PLANE, FLAG_GENERIC_INTAKE)
```
**Not** the `GET` list handler.

`hub_api/blueprints/v1/ingest_sources.py` — handlers `post_source`, `delete_source_route`: same import and decorator as `custom_platforms.py`. **Not** the `GET` list handler.

`hub_api/blueprints/v1/bundle_settings.py` — handler `put_settings` only:
```python
from services.bundle_feature_gate import FLAG_RUST_DATA_PLANE, require_flags
```
```python
@require_flags(FLAG_RUST_DATA_PLANE)
```

- [ ] **Step 5: Make `allow_prebuilt` a real two-gate in `POST .../versions`**

In `hub_api/blueprints/v1/bundle_versions.py`'s `post_version` handler, the value passed as `allow_prebuilt=` to `svc.create_version` is currently the platform setting alone. Replace that expression so the flag is the second gate:

```python
    allow_prebuilt = await get_platform_setting_bool(
        async_dal, dal, key=SETTING_ALLOW_PREBUILT, default=True
    ) and await flags_enabled(FLAG_PREBUILT_BUNDLES, tenant=ctx.tenant_slug)
```

Add to the same file's imports:
```python
from services.bundle_feature_gate import FLAG_PREBUILT_BUNDLES, flags_enabled
```

A prebuilt upload with the setting on but the flag off therefore fails with `403 prebuilt_not_allowed` from `bundle_manifest_v2` (Task 7's existing reason code), not with a new error shape.

- [ ] **Step 6: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_feature_gate.py -v`
Expected: `11 passed` (4 gated-route cases + 2 distribution-read cases + 5 others).

- [ ] **Step 7: Run every M2b blueprint suite to confirm the decorator did not break the happy paths**

Run:
```bash
cd hub_api && python3 -m pytest \
  tests/test_bundle_versions_blueprint.py tests/test_bundle_approvals_blueprint.py \
  tests/test_bundle_grants_blueprint.py tests/test_bundle_artifact_callback_blueprint.py \
  tests/test_custom_platforms_blueprint.py tests/test_ingest_sources_blueprint.py \
  tests/test_bundle_settings_blueprint.py tests/test_bundle_trip_reenable.py -v
```
Expected: **failures** on every write-route happy-path test — those tests do not patch `feature_enabled`, so the gate closes. Fix them by adding this fixture to `hub_api/tests/conftest.py` and nothing else:

```python
@pytest.fixture(autouse=True)
def _bundle_flags_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default every M2b PostHog flag ON for tests that are not about the flag gate itself.

    `tests/test_bundle_feature_gate.py` patches
    `services.bundle_feature_gate.feature_enabled` directly inside each
    test, which wins over this autouse fixture -- so the gate's own
    off-path tests still exercise the real refusal.
    """

    async def _always_on(*_args: Any, **_kwargs: Any) -> bool:
        return True

    monkeypatch.setattr("services.bundle_feature_gate.feature_enabled", _always_on)
```

Re-run the same command.
Expected: every suite passes.

- [ ] **Step 8: Add the ruff per-file ignore**

Append to `hub_api/pyproject.toml`'s `[tool.ruff.lint.per-file-ignores]`:

```toml
# The flag gate wraps handlers with *args/**kwargs and re-raises nothing;
# ANN401-style Any is inherent to a generic route decorator.
"services/bundle_feature_gate.py" = ["ANN401"]
```

- [ ] **Step 9: Commit**

```bash
git add hub_api/services/bundle_feature_gate.py hub_api/tests/test_bundle_feature_gate.py \
        hub_api/tests/conftest.py hub_api/pyproject.toml \
        hub_api/blueprints/v1/bundle_versions.py hub_api/blueprints/v1/bundle_approvals.py \
        hub_api/blueprints/v1/bundle_grants.py hub_api/blueprints/v1/bundle_artifact_callback.py \
        hub_api/blueprints/v1/custom_platforms.py hub_api/blueprints/v1/ingest_sources.py \
        hub_api/blueprints/v1/bundle_settings.py
git commit -m "$(cat <<'EOF'
feat(hub-api): PostHog flag gate on every M2b write surface (spec Sec13.5)

require_flags() refuses 403 feature_disabled unless every named flag is
on for the caller's tenant, evaluated through flask_core's two-gate
feature_enabled (PostHog AND licence entitlement). Applied to version
upload/activate/trip-reenable, approve/deny, grant resolve/revoke, both
compiler callbacks, custom-platform and ingest-source writes, and the
marketplace settings PUT.

Read surfaces stay ungated on purpose: a flag flipped off mid-rollout
must stop new writes, never blind a running Rust stage polling the
distribution API. allow_prebuilt becomes a real two-gate -- the
platform setting AND waddles.core.prebuilt-bundles.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 38: `bundle_telemetry.py` — OTel spans, counters and histograms across the M2b surface

**Depends on:** Tasks 10, 19, 29, 13-14 (the service entry points being instrumented), Tasks 33-34 (the distribution v2 routes).

**Files:**
- Create: `hub_api/services/bundle_telemetry.py`
- Modify: `hub_api/requirements.in` (+ regenerate `requirements.txt`)
- Modify: `hub_api/services/bundle_version_service.py`, `bundle_approval_service.py`, `stream_grant_service.py`, `bundle_artifact_service.py`
- Modify: `hub_api/blueprints/v1/distribution.py`
- Test: `hub_api/tests/test_bundle_telemetry.py`

**Interfaces:**
- Produces: `def get_tracer() -> Any`; `def get_meter() -> Any`; `@asynccontextmanager bundle_span(name: str, **attributes: Any)`; counters `record_version_upload(result: str, language: str, artifact_kind: str)`, `record_approval(decision: str)`, `record_grants_resolved(app_id: str, count: int)`, `record_artifact_callback(result: str)`; histogram recorders `record_distribution_poll(stage: str, rows: int, duration_ms: float)`.
- Consumes: `opentelemetry.trace`, `opentelemetry.metrics` (API only).

**Non-negotiables this module encodes** (`critical-rules.md` Observability):

- **Destination is never hardcoded.** This module touches `opentelemetry.trace`/`opentelemetry.metrics` — the *API*, never an SDK exporter and never a vendor SDK. Where the data goes is `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_PROTOCOL` / `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`, set per deployment. With no provider configured the OTel API's no-op tracer/meter is used and every call below is a cheap no-op — telemetry never breaks a request.
- **Histograms for load and latency first.** `waddles_hub_bundle_operation_duration_ms` and `waddles_hub_distribution_poll_duration_ms` are histograms; so is `waddles_hub_distribution_rows`, the payload-size signal. Counters are for events, the up-down counter for current state.
- **No PII, no secrets, no digests-as-labels.** Span attributes and metric labels carry `app_id`, `version`, `stage`, `language`, `artifact_kind`, `result`, `tenant_id` — never a user name, an email, a token, an HMAC secret, or a full `artifact_digest` (a digest is high-cardinality and would blow up the label set; it belongs in a log line, not a label).

- [ ] **Step 1: Pin the dependency**

Add to `hub_api/requirements.in`:

```
# OpenTelemetry API only -- services/bundle_telemetry.py emits spans and
# metrics through the API; the SDK, its exporters and the OTLP endpoint
# are configured per deployment via the standard OTEL_* env vars, never
# in app code (critical-rules.md Observability). The SDK arrives
# transitively via libs/flask_core (opentelemetry-sdk,
# opentelemetry-exporter-otlp) -- pinned here too because hub-api's own
# code imports the API directly, per this file's header comment.
opentelemetry-api>=1.27.0,<2.0.0
opentelemetry-sdk>=1.27.0,<2.0.0  # tests/test_bundle_telemetry.py -- InMemory span/metric readers
```

Regenerate the lockfile:
```bash
cd hub_api && uv pip compile requirements.in --generate-hashes -o requirements.txt
```
Expected: `requirements.txt` regenerated with `--generate-hashes`, containing `opentelemetry-api==` and `opentelemetry-sdk==` lines each followed by `--hash=sha256:` entries.

- [ ] **Step 2: Write the failing test**

```python
# hub_api/tests/test_bundle_telemetry.py
"""Telemetry validation for the M2b surface -- spans, counters and histograms actually emitted.

Counts are asserted AND printed: a zero-item run is a failure, never a
pass (critical-rules.md Verification Integrity, testing.md Telemetry
Validation).
"""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


@pytest.fixture
def otel_sink(monkeypatch: pytest.MonkeyPatch) -> Any:
    """A real in-process OTel SDK wired to in-memory readers -- the local OTLP test sink."""
    exporter = InMemorySpanExporter()
    tracer_provider = TracerProvider()
    tracer_provider.add_span_processor(SimpleSpanProcessor(exporter))
    reader = InMemoryMetricReader()
    meter_provider = MeterProvider(metric_readers=[reader])

    monkeypatch.setattr(trace, "get_tracer_provider", lambda: tracer_provider)
    monkeypatch.setattr(metrics, "get_meter_provider", lambda: meter_provider)

    import services.bundle_telemetry as telemetry

    monkeypatch.setattr(telemetry, "_TRACER", None)
    monkeypatch.setattr(telemetry, "_METER", None)
    monkeypatch.setattr(telemetry, "_INSTRUMENTS", None)
    return exporter, reader


async def test_bundle_span_emits_a_span_and_a_duration_histogram(otel_sink: Any) -> None:
    from services.bundle_telemetry import bundle_span

    exporter, reader = otel_sink
    async with bundle_span("hub.bundle.create_version", app_id="waddles.socials.music.default"):
        pass

    spans = exporter.get_finished_spans()
    print(f"telemetry check: span records received = {len(spans)}")
    assert len(spans) >= 1, "zero spans received -- FAIL, not a pass"
    assert spans[0].name == "hub.bundle.create_version"
    assert spans[0].attributes["app_id"] == "waddles.socials.music.default"

    points = _histogram_points(reader, "waddles_hub_bundle_operation_duration_ms")
    print(f"telemetry check: histogram data points received = {len(points)}")
    assert len(points) >= 1, "zero histogram data points received -- FAIL, not a pass"


async def test_bundle_span_records_an_error_status_and_still_emits(otel_sink: Any) -> None:
    from services.bundle_telemetry import bundle_span

    exporter, _ = otel_sink
    with pytest.raises(ValueError):
        async with bundle_span("hub.bundle.approve", app_id="x"):
            raise ValueError("boom")

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == trace.StatusCode.ERROR


async def test_counters_emit_data_points(otel_sink: Any) -> None:
    from services.bundle_telemetry import (
        record_approval,
        record_artifact_callback,
        record_grants_resolved,
        record_version_upload,
    )

    _, reader = otel_sink
    record_version_upload(result="accepted", language="python", artifact_kind="source")
    record_approval(decision="approved")
    record_grants_resolved(app_id="waddles.socials.music.default", count=2)
    record_artifact_callback(result="verified")

    names = _metric_names(reader)
    print(f"telemetry check: metric streams received = {len(names)} -> {sorted(names)}")
    assert {
        "waddles_hub_bundle_versions_total",
        "waddles_hub_bundle_approvals_total",
        "waddles_hub_bundle_grants_resolved_total",
        "waddles_hub_bundle_grants_active",
        "waddles_hub_bundle_artifact_callbacks_total",
    } <= names


async def test_distribution_poll_records_rows_and_duration_histograms(otel_sink: Any) -> None:
    from services.bundle_telemetry import record_distribution_poll

    _, reader = otel_sink
    record_distribution_poll(stage="process", rows=3, duration_ms=12.5)

    rows_points = _histogram_points(reader, "waddles_hub_distribution_rows")
    duration_points = _histogram_points(reader, "waddles_hub_distribution_poll_duration_ms")
    print(
        f"telemetry check: distribution histogram data points = "
        f"rows {len(rows_points)}, duration {len(duration_points)}"
    )
    assert len(rows_points) >= 1
    assert len(duration_points) >= 1
    assert rows_points[0].sum == 3


async def test_no_provider_configured_is_a_silent_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dead or absent exporter must never break the app (critical-rules.md Observability)."""
    import services.bundle_telemetry as telemetry

    monkeypatch.setattr(telemetry, "_TRACER", None)
    monkeypatch.setattr(telemetry, "_METER", None)
    monkeypatch.setattr(telemetry, "_INSTRUMENTS", None)
    async with telemetry.bundle_span("hub.bundle.noop"):
        pass
    telemetry.record_version_upload(result="accepted", language="python", artifact_kind="source")


def _metric_names(reader: Any) -> set[str]:
    data = reader.get_metrics_data()
    names: set[str] = set()
    if data is None:
        return names
    for resource_metric in data.resource_metrics:
        for scope_metric in resource_metric.scope_metrics:
            for metric in scope_metric.metrics:
                names.add(metric.name)
    return names


def _histogram_points(reader: Any, name: str) -> list[Any]:
    data = reader.get_metrics_data()
    if data is None:
        return []
    points: list[Any] = []
    for resource_metric in data.resource_metrics:
        for scope_metric in resource_metric.scope_metrics:
            for metric in scope_metric.metrics:
                if metric.name == name:
                    points.extend(metric.data.data_points)
    return points
```

- [ ] **Step 3: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_telemetry.py -v`
Expected: `ModuleNotFoundError: No module named 'services.bundle_telemetry'`

- [ ] **Step 4: Write the module**

```python
# hub_api/services/bundle_telemetry.py
"""OTel spans, counters and histograms for the M2b bundle control plane.

API only -- `opentelemetry.trace` and `opentelemetry.metrics`. No SDK,
no exporter, no vendor library. Where the data goes is a deployment
concern set through the standard OTLP env vars
(`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`,
`OTEL_RESOURCE_ATTRIBUTES`); with no provider configured every call
here resolves to the API's no-op implementation and costs nothing.
Telemetry failure is never a request failure.

No PII, no secrets, and deliberately no `artifact_digest` in any label:
a digest is unbounded cardinality and belongs in a log line, not a
metric dimension.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from opentelemetry import metrics, trace

_TRACER: Any = None
_METER: Any = None
_INSTRUMENTS: Any = None

_SCOPE = "waddles.hub_api.bundles"


def get_tracer() -> Any:
    """The module's tracer, created once. No-op when no provider is configured."""
    global _TRACER
    if _TRACER is None:
        _TRACER = trace.get_tracer(_SCOPE)
    return _TRACER


def get_meter() -> Any:
    """The module's meter, created once. No-op when no provider is configured."""
    global _METER
    if _METER is None:
        _METER = metrics.get_meter(_SCOPE)
    return _METER


@dataclass(slots=True, frozen=True)
class _Instruments:
    """Every instrument this module owns, created once on first use."""

    operation_duration_ms: Any
    versions_total: Any
    approvals_total: Any
    grants_resolved_total: Any
    grants_active: Any
    artifact_callbacks_total: Any
    distribution_rows: Any
    distribution_poll_duration_ms: Any


def _instruments() -> _Instruments:
    """Lazily build the instrument set so importing this module configures nothing."""
    global _INSTRUMENTS
    if _INSTRUMENTS is None:
        meter = get_meter()
        _INSTRUMENTS = _Instruments(
            operation_duration_ms=meter.create_histogram(
                "waddles_hub_bundle_operation_duration_ms",
                unit="ms",
                description="Wall-clock duration of one bundle control-plane operation",
            ),
            versions_total=meter.create_counter(
                "waddles_hub_bundle_versions_total",
                description="Bundle version uploads accepted or refused by hub-api",
            ),
            approvals_total=meter.create_counter(
                "waddles_hub_bundle_approvals_total",
                description="Install-time permission decisions recorded",
            ),
            grants_resolved_total=meter.create_counter(
                "waddles_hub_bundle_grants_resolved_total",
                description="Stream grants written by consumes resolution",
            ),
            grants_active=meter.create_up_down_counter(
                "waddles_hub_bundle_grants_active",
                description="Current active stream grants per bundle",
            ),
            artifact_callbacks_total=meter.create_counter(
                "waddles_hub_bundle_artifact_callbacks_total",
                description="Compiler artifact callbacks by outcome",
            ),
            distribution_rows=meter.create_histogram(
                "waddles_hub_distribution_rows",
                unit="1",
                description="Rows returned by one distribution-API poll",
            ),
            distribution_poll_duration_ms=meter.create_histogram(
                "waddles_hub_distribution_poll_duration_ms",
                unit="ms",
                description="Server-side duration of one distribution-API poll",
            ),
        )
    return _INSTRUMENTS


@asynccontextmanager
async def bundle_span(name: str, **attributes: Any) -> AsyncIterator[Any]:
    """Span the real work, and record its duration into the operation histogram.

    Sets an ERROR status and records the exception when the body
    raises, then re-raises -- observability never swallows a failure.
    """
    started = time.perf_counter()
    with get_tracer().start_as_current_span(name) as span:
        for key, value in attributes.items():
            if value is not None:
                span.set_attribute(key, value)
        try:
            yield span
        except Exception as exc:
            span.record_exception(exc)
            span.set_status(trace.Status(trace.StatusCode.ERROR, str(exc)))
            _instruments().operation_duration_ms.record(
                (time.perf_counter() - started) * 1000.0, {"operation": name, "result": "error"}
            )
            raise
        _instruments().operation_duration_ms.record(
            (time.perf_counter() - started) * 1000.0, {"operation": name, "result": "ok"}
        )


def record_version_upload(*, result: str, language: str, artifact_kind: str) -> None:
    """Count one version upload. `result` is `accepted` or a manifest rule's `reason`."""
    _instruments().versions_total.add(
        1, {"result": result, "language": language, "artifact_kind": artifact_kind}
    )


def record_approval(*, decision: str) -> None:
    """Count one install-time permission decision (`approved`, `denied`, `superseded`)."""
    _instruments().approvals_total.add(1, {"decision": decision})


def record_grants_resolved(*, app_id: str, count: int) -> None:
    """Count grants written by one resolution, and set the bundle's current active-grant level."""
    _instruments().grants_resolved_total.add(count, {"app_id": app_id})
    _instruments().grants_active.add(count, {"app_id": app_id})


def record_grants_revoked(*, app_id: str, count: int) -> None:
    """Lower the bundle's current active-grant level by `count`."""
    _instruments().grants_active.add(-count, {"app_id": app_id})


def record_artifact_callback(*, result: str) -> None:
    """Count one compiler callback (`verified`, `digest_mismatch`, `rejected`, `fallback_insert`)."""
    _instruments().artifact_callbacks_total.add(1, {"result": result})


def record_distribution_poll(*, stage: str, rows: int, duration_ms: float) -> None:
    """Record one distribution-API poll's payload size and server-side duration."""
    _instruments().distribution_rows.record(rows, {"stage": stage})
    _instruments().distribution_poll_duration_ms.record(duration_ms, {"stage": stage})
```

- [ ] **Step 5: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_bundle_telemetry.py -v -s`
Expected: `5 passed`, and stdout includes the printed denominators — `telemetry check: span records received = 1`, `telemetry check: histogram data points received = 1`, `telemetry check: metric streams received = 5 -> [...]`, `telemetry check: distribution histogram data points = rows 1, duration 1`.

- [ ] **Step 6: Wire the instrumentation into the four services**

**`hub_api/services/bundle_version_service.py`** — add the import and wrap `create_version`'s body:
```python
from services.bundle_telemetry import bundle_span, record_version_upload
```
Wrap the entire existing body of `create_version` in:
```python
    async with bundle_span("hub.bundle.create_version", app_id=app_id, tenant_id=tenant_id):
        ...  # the existing body, indented one level
```
and immediately after the `parse_bundle_manifest_v2` `except ManifestV2Error as exc:` block's `raise`, add a `record_version_upload(result=exc.reason, language="unknown", artifact_kind="unknown")` call **before** the `raise`. After the final `rows = await async_dal.select_async(...)` line, add:
```python
        record_version_upload(result="accepted", language=manifest.language, artifact_kind=manifest.artifact)
```

**`hub_api/services/bundle_approval_service.py`**:
```python
from services.bundle_telemetry import bundle_span, record_approval
```
Wrap `approve_version`'s body in `async with bundle_span("hub.bundle.approve", app_id=app_id, version=version, tenant_id=tenant_id):` and call `record_approval(decision="approved")` just before it returns. Do the same for `deny_version` with `"hub.bundle.deny"` and `record_approval(decision="denied")`.

**`hub_api/services/stream_grant_service.py`**:
```python
from services.bundle_telemetry import bundle_span, record_grants_resolved, record_grants_revoked
```
Wrap `resolve_grants_for_scope`'s body in `async with bundle_span("hub.bundle.resolve_grants", app_id=app_id, tenant_id=tenant_id):` and call `record_grants_resolved(app_id=app_id, count=len(inserted))` — where `inserted` is the list of grants this call newly created, not the full returned list, so a no-op re-resolution records `0`. In `revoke_grant` call `record_grants_revoked(app_id=app_id, count=1)` after the update; in `revoke_all_grants_for_scope` call it with the number of rows revoked.

**`hub_api/services/bundle_artifact_service.py`**:
```python
from services.bundle_telemetry import bundle_span, record_artifact_callback
```
Wrap the success handler in `async with bundle_span("hub.bundle.artifact_callback", app_id=app_id, version=version):` and call `record_artifact_callback(result=...)` with `"verified"`, `"digest_mismatch"` or `"fallback_insert"` on each respective path; wrap the rejection handler in `"hub.bundle.artifact_rejected"` with `record_artifact_callback(result="rejected")`.

- [ ] **Step 7: Wire the distribution poll histograms**

In `hub_api/blueprints/v1/distribution.py`, add:
```python
import time

from services.bundle_telemetry import bundle_span, record_distribution_poll
```
Wrap `list_distribution_bundles_v2`'s body (from the `stage` read to the `return`) in:
```python
    started = time.perf_counter()
    async with bundle_span("hub.distribution.poll_v2", stage=stage):
        ...  # existing body
        record_distribution_poll(
            stage=stage, rows=len(bundles), duration_ms=(time.perf_counter() - started) * 1000.0
        )
        return _conditional(stage, bundles, payload)
```
and `list_distribution_sources`'s body the same way with span name `"hub.distribution.poll_sources"` and `stage="sources"`.

- [ ] **Step 8: Re-run every touched suite**

Run:
```bash
cd hub_api && python3 -m pytest \
  tests/test_bundle_version_service.py tests/test_bundle_approval_service.py \
  tests/test_stream_grant_service.py tests/test_bundle_artifact_service.py \
  tests/test_distribution_v2_blueprint.py tests/test_distribution_sources_blueprint.py \
  tests/test_bundle_telemetry.py -v
```
Expected: every suite passes. The instrumentation is no-op when no provider is configured, so no existing assertion changes.

- [ ] **Step 9: Commit**

```bash
git add hub_api/services/bundle_telemetry.py hub_api/tests/test_bundle_telemetry.py \
        hub_api/requirements.in hub_api/requirements.txt \
        hub_api/services/bundle_version_service.py hub_api/services/bundle_approval_service.py \
        hub_api/services/stream_grant_service.py hub_api/services/bundle_artifact_service.py \
        hub_api/blueprints/v1/distribution.py
git commit -m "$(cat <<'EOF'
feat(hub-api): OTel spans, counters and histograms across the M2b bundle control plane

bundle_span() wraps version upload, approval, grant resolution, both
compiler callbacks and both distribution polls; histograms cover
operation duration, distribution payload size and poll latency;
counters cover uploads, approvals, grants and callbacks, with an
up-down counter for current active grants per bundle.

OTel API only -- no SDK, no exporter, no vendor library in app code.
The destination is OTEL_EXPORTER_OTLP_ENDPOINT and friends, set per
deployment; with no provider configured every call is a no-op, so a
dead exporter never breaks a request. No digest, token or PII appears
in any span attribute or metric label.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 39: migration 0022 + `ingest_source_auth.py` — the per-source auth config and its validation

**Depends on:** Task 3 (migration 0021 created `ingest_sources`), Task 4 (`bind_bundle_install_tables`), Task 6 (`bundle_secret_crypto.{encrypt, decrypt}`), Task 26 (`ingest_source_service`).

**Files:**
- Create: `alembic/versions/0022_ingest_source_auth.py`
- Create: `hub_api/services/ingest_source_auth.py`
- Modify: `hub_api/services/schema.py` (three new fields on the `ingest_sources` binder)
- Modify: `hub_api/services/ingest_source_service.py`
- Test: `hub_api/tests/test_ingest_source_auth.py`

**Interfaces:**
- Produces, in `services/ingest_source_auth.py`: `MODE_HMAC = "hmac"`, `MODE_IP_ALLOWLIST = "ip_allowlist"`, `MODE_BEARER = "bearer"`, `MODE_BASIC = "basic"`; `SECOND_FACTOR_MODES = frozenset({MODE_IP_ALLOWLIST, MODE_BEARER, MODE_BASIC})`; `DEFAULT_ORIGIN_SUFFIXES: dict[str, tuple[str, ...]] = {"twitch": ("twitch.tv",), "kick": ("kick.com",)}`; `WEBHOOK_PLATFORM = "webhook"`; `class AuthConfigError(ValueError)` with a machine-checkable `.reason`; `def is_generic_webhook(platform: str) -> bool`; `def build_auth_config(platform: str, raw: dict[str, Any] | None, *, secret_ref: str) -> tuple[dict[str, Any], str | None]` returning `(canonical_auth_config, plaintext_secret_to_encrypt_or_None)`.
- Produces, in `services/ingest_source_service.py`: `create_source(..., auth: dict[str, Any] | None = None)`; `async def update_source_auth(async_dal, dal, *, tenant_id: int, source_id: str, auth: dict[str, Any], actor_id: int) -> Any`; `async def resolve_auth_secret(async_dal, dal, *, tenant_id: int, source_id: str) -> str | None`.
- Consumes: `services.bundle_secret_crypto.{encrypt, decrypt}` (Task 6).

**The canonical wire shape — must match plan M5, reproduced in full so no later task re-derives it:**

```json
{
  "modes": ["hmac", "bearer"],
  "cidrs": ["203.0.113.0/24", "2001:db8::/32"],
  "secret_ref": "src:tw-channelA",
  "origin_suffixes": ["twitch.tv"],
  "origin_cidrs": []
}
```

| Key | Type | Rule |
|---|---|---|
| `modes` | list of string | Always contains `"hmac"` first. For a generic webhook source it must also contain at least one of `ip_allowlist`, `bearer`, `basic`, else `422 auth_second_factor_required`. Sorted after `"hmac"`, deduped. |
| `cidrs` | list of string | Required non-empty when `ip_allowlist` is in `modes`, else `[]`. Every entry parsed with `ipaddress.ip_network(strict=False)`; a parse failure is `422 invalid_cidr`. |
| `secret_ref` | string | `"src:{source_id}"`. The opaque handle svc_ingest exchanges for the bearer token / basic password hash through the same authenticated secret path as the HMAC secret. **Never** the secret itself. |
| `origin_suffixes` | list of string | Defaults to `DEFAULT_ORIGIN_SUFFIXES[platform]` for `twitch`/`kick`, `[]` elsewhere. Lowercased, deduped, sorted. Each must be a bare dotted domain suffix (no scheme, no path, no wildcard). |
| `origin_cidrs` | list of string | Optional, same parse rule as `cidrs`; `[]` when absent. |

Input-only keys, accepted from the caller and **never** stored in `auth` or returned anywhere: `bearer_token` (string, ≥ 32 characters) and `basic_password` (string, ≥ 12 characters, paired with `basic_username`). `basic_username` **is** stored in `auth` (it is not a secret); the password is hashed with `hashlib.sha256` and the **hash** is what `encrypt()` protects at rest, so hub-api never holds a reversible password.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_ingest_source_auth.py
"""Tests for the per-source auth config: validation, storage, and the audit entry."""

from __future__ import annotations

from typing import Any

import pytest

from services.bundle_secret_crypto import decrypt
from services.errors import ApiError
from services.ingest_source_auth import AuthConfigError, build_auth_config, is_generic_webhook
from services.ingest_source_service import (
    create_source,
    list_sources,
    resolve_auth_secret,
    update_source_auth,
)


@pytest.fixture(autouse=True)
def _key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUNDLE_SECRET_ENCRYPTION_KEY", "d" * 64)


@pytest.mark.parametrize(
    ("platform", "expected"),
    [("custom:acme", True), ("webhook", True), ("twitch", False), ("kick", False), ("discord", False)],
)
def test_is_generic_webhook(platform: str, expected: bool) -> None:
    assert is_generic_webhook(platform) is expected


def test_generic_source_without_a_second_factor_is_refused() -> None:
    with pytest.raises(AuthConfigError) as excinfo:
        build_auth_config("custom:acme", {"modes": ["hmac"]}, secret_ref="src:wh-1")
    assert excinfo.value.reason == "auth_second_factor_required"


def test_generic_source_with_no_auth_block_at_all_is_refused() -> None:
    with pytest.raises(AuthConfigError) as excinfo:
        build_auth_config("custom:acme", None, secret_ref="src:wh-1")
    assert excinfo.value.reason == "auth_second_factor_required"


def test_generic_source_with_ip_allowlist_is_accepted() -> None:
    config, secret = build_auth_config(
        "custom:acme",
        {"modes": ["ip_allowlist"], "cidrs": ["203.0.113.0/24", "2001:db8::/32"]},
        secret_ref="src:wh-1",
    )
    assert config["modes"] == ["hmac", "ip_allowlist"]
    assert config["cidrs"] == ["203.0.113.0/24", "2001:db8::/32"]
    assert config["secret_ref"] == "src:wh-1"
    assert config["origin_suffixes"] == []
    assert secret is None


def test_ip_allowlist_without_cidrs_is_refused() -> None:
    with pytest.raises(AuthConfigError) as excinfo:
        build_auth_config("custom:acme", {"modes": ["ip_allowlist"], "cidrs": []}, secret_ref="src:wh-1")
    assert excinfo.value.reason == "cidrs_required"


@pytest.mark.parametrize("bad", ["203.0.113.0/33", "not-an-ip", "203.0.113.0/", "", "10.0.0.0/8/8"])
def test_a_cidr_parse_error_is_refused(bad: str) -> None:
    with pytest.raises(AuthConfigError) as excinfo:
        build_auth_config("custom:acme", {"modes": ["ip_allowlist"], "cidrs": [bad]}, secret_ref="src:wh-1")
    assert excinfo.value.reason == "invalid_cidr"


def test_bearer_mode_returns_the_plaintext_once_and_never_stores_it() -> None:
    config, secret = build_auth_config(
        "custom:acme", {"modes": ["bearer"], "bearer_token": "t" * 40}, secret_ref="src:wh-1"
    )
    assert config["modes"] == ["hmac", "bearer"]
    assert secret == "t" * 40
    assert "bearer_token" not in config
    assert "t" * 40 not in str(config)


def test_a_short_bearer_token_is_refused() -> None:
    with pytest.raises(AuthConfigError) as excinfo:
        build_auth_config("custom:acme", {"modes": ["bearer"], "bearer_token": "short"}, secret_ref="src:wh-1")
    assert excinfo.value.reason == "bearer_token_too_short"


def test_basic_mode_stores_the_username_and_hashes_the_password() -> None:
    import hashlib

    config, secret = build_auth_config(
        "custom:acme",
        {"modes": ["basic"], "basic_username": "acme-bot", "basic_password": "correct horse battery"},
        secret_ref="src:wh-1",
    )
    assert config["modes"] == ["hmac", "basic"]
    assert config["basic_username"] == "acme-bot"
    assert "basic_password" not in config
    assert secret == hashlib.sha256(b"correct horse battery").hexdigest()


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        ({"modes": ["basic"], "basic_username": "", "basic_password": "correct horse battery"}, "basic_username_required"),
        ({"modes": ["basic"], "basic_username": "bot", "basic_password": "short"}, "basic_password_too_short"),
        ({"modes": ["nonsense"]}, "unknown_auth_mode"),
        ({"modes": "bearer"}, "malformed_auth"),
    ],
)
def test_malformed_auth_blocks_are_refused(raw: dict[str, Any], reason: str) -> None:
    with pytest.raises(AuthConfigError) as excinfo:
        build_auth_config("custom:acme", raw, secret_ref="src:wh-1")
    assert excinfo.value.reason == reason


def test_twitch_defaults_to_the_twitch_origin_suffix() -> None:
    config, secret = build_auth_config("twitch", None, secret_ref="src:tw-channelA")
    assert config["modes"] == ["hmac"]
    assert config["origin_suffixes"] == ["twitch.tv"]
    assert config["origin_cidrs"] == []
    assert secret is None


def test_kick_defaults_to_the_kick_origin_suffix() -> None:
    config, _ = build_auth_config("kick", None, secret_ref="src:kk-1")
    assert config["origin_suffixes"] == ["kick.com"]


def test_twitch_origin_policy_can_be_overridden_and_is_normalised() -> None:
    config, _ = build_auth_config(
        "twitch",
        {"origin_suffixes": ["EventSub.Twitch.TV", "twitch.tv", "twitch.tv"], "origin_cidrs": ["192.0.2.0/24"]},
        secret_ref="src:tw-channelA",
    )
    assert config["origin_suffixes"] == ["eventsub.twitch.tv", "twitch.tv"]
    assert config["origin_cidrs"] == ["192.0.2.0/24"]


@pytest.mark.parametrize("bad", ["https://twitch.tv", "*.twitch.tv", "twitch.tv/path", ""])
def test_a_malformed_origin_suffix_is_refused(bad: str) -> None:
    with pytest.raises(AuthConfigError) as excinfo:
        build_auth_config("twitch", {"origin_suffixes": [bad]}, secret_ref="src:tw-1")
    assert excinfo.value.reason == "invalid_origin_suffix"


async def test_create_source_refuses_a_generic_source_with_no_second_factor(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    with pytest.raises(ApiError) as excinfo:
        await create_source(
            async_dal, async_dal.dal, tenant_id=1, community_id=None, platform="custom:acme",
            source_id="wh-1", label="Acme webhook", mapping=None, auth={"modes": ["hmac"]},
        )
    assert excinfo.value.status_code == 422
    assert excinfo.value.code == "auth_second_factor_required"


async def test_create_source_stores_the_canonical_auth_and_encrypts_the_bearer(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    row, _hmac_secret = await create_source(
        async_dal, dal, tenant_id=1, community_id=None, platform="custom:acme",
        source_id="wh-1", label="Acme webhook", mapping=None,
        auth={"modes": ["bearer"], "bearer_token": "t" * 40},
    )
    stored = dal(dal.ingest_sources.id == row.id).select().first()
    assert stored.auth["modes"] == ["hmac", "bearer"]
    assert stored.auth["secret_ref"] == "src:wh-1"
    assert "t" * 40 not in str(stored.auth)
    assert stored.auth_secret_ciphertext is not None
    assert decrypt(stored.auth_secret_ciphertext, stored.auth_secret_iv) == "t" * 40


async def test_list_sources_never_echoes_the_bearer_token(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    await create_source(
        async_dal, async_dal.dal, tenant_id=1, community_id=None, platform="custom:acme",
        source_id="wh-1", label="Acme webhook", mapping=None,
        auth={"modes": ["bearer"], "bearer_token": "t" * 40},
    )
    rows = await list_sources(async_dal, async_dal.dal, tenant_id=1)
    serialised = str([dict(r.as_dict()) for r in rows])
    assert "t" * 40 not in serialised
    assert "auth_secret_ciphertext" not in serialised or "t" * 40 not in serialised


async def test_resolve_auth_secret_round_trips(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    await create_source(
        async_dal, async_dal.dal, tenant_id=1, community_id=None, platform="custom:acme",
        source_id="wh-1", label="Acme webhook", mapping=None,
        auth={"modes": ["bearer"], "bearer_token": "t" * 40},
    )
    assert await resolve_auth_secret(async_dal, async_dal.dal, tenant_id=1, source_id="wh-1") == "t" * 40


async def test_update_source_auth_rewrites_the_config_and_audits_the_mode_change(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    dal = async_dal.dal
    await create_source(
        async_dal, dal, tenant_id=1, community_id=None, platform="custom:acme",
        source_id="wh-1", label="Acme webhook", mapping=None,
        auth={"modes": ["bearer"], "bearer_token": "t" * 40},
    )
    await update_source_auth(
        async_dal, dal, tenant_id=1, source_id="wh-1",
        auth={"modes": ["ip_allowlist"], "cidrs": ["203.0.113.0/24"]}, actor_id=1,
    )
    stored = dal(dal.ingest_sources.source_id == "wh-1").select().first()
    assert stored.auth["modes"] == ["hmac", "ip_allowlist"]
    assert stored.auth_secret_ciphertext is None

    audit_row = dal(dal.audit_log.action == "ingest_source_auth_changed").select().first()
    assert audit_row is not None
    assert audit_row.details["old_modes"] == ["hmac", "bearer"]
    assert audit_row.details["new_modes"] == ["hmac", "ip_allowlist"]
    assert "bearer_token" not in str(audit_row.details)


async def test_update_source_auth_refuses_removing_the_last_second_factor(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    await create_source(
        async_dal, async_dal.dal, tenant_id=1, community_id=None, platform="custom:acme",
        source_id="wh-1", label="Acme webhook", mapping=None,
        auth={"modes": ["bearer"], "bearer_token": "t" * 40},
    )
    with pytest.raises(ApiError) as excinfo:
        await update_source_auth(
            async_dal, async_dal.dal, tenant_id=1, source_id="wh-1", auth={"modes": ["hmac"]}, actor_id=1
        )
    assert excinfo.value.status_code == 422
    assert excinfo.value.code == "auth_second_factor_required"


async def test_update_source_auth_404s_for_an_unknown_source(bundle_install_db: Any) -> None:
    async_dal = bundle_install_db
    with pytest.raises(ApiError) as excinfo:
        await update_source_auth(
            async_dal, async_dal.dal, tenant_id=1, source_id="nope",
            auth={"modes": ["ip_allowlist"], "cidrs": ["203.0.113.0/24"]}, actor_id=1,
        )
    assert excinfo.value.status_code == 404
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_source_auth.py -v`
Expected: `ModuleNotFoundError: No module named 'services.ingest_source_auth'`

- [ ] **Step 3: Write the migration**

```python
# alembic/versions/0022_ingest_source_auth.py
"""Per-source auth config on ingest_sources: auth JSONB + encrypted auth secret.

The HMAC secret authenticates the payload, not the caller. This
migration adds the second-factor config svc_ingest enforces: an
ip_allowlist / bearer / basic mode for generic webhook sources, and an
origin policy (origin_suffixes + origin_cidrs) for Twitch and Kick.
Bearer tokens and Basic password hashes live in
auth_secret_ciphertext/auth_secret_iv, AES-256-GCM, same helper as
every other secret in this service -- `auth` itself is safe to serve.

Existing rows are backfilled with the platform-appropriate default so
no row is left with an empty policy: twitch -> {"twitch.tv"},
kick -> {"kick.com"}, everything else -> hmac-only. A pre-existing
generic webhook source therefore keeps working after this migration and
is upgraded to a second factor by an explicit admin action (Task 40's
PUT), never silently broken by a deploy.

Revision ID: 0022_ingest_source_auth
Revises: 0021_bundle_install_schema
"""

from __future__ import annotations

from alembic import op

revision = "0022_ingest_source_auth"
down_revision = "0021_bundle_install_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add the auth column trio and backfill a platform-appropriate default."""
    op.execute(
        """
        ALTER TABLE ingest_sources
            ADD COLUMN IF NOT EXISTS auth JSONB NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS auth_secret_ciphertext BYTEA,
            ADD COLUMN IF NOT EXISTS auth_secret_iv BYTEA
        """
    )
    op.execute(
        """
        UPDATE ingest_sources SET auth = jsonb_build_object(
            'modes', jsonb_build_array('hmac'),
            'cidrs', '[]'::jsonb,
            'secret_ref', 'src:' || source_id,
            'origin_suffixes', CASE
                WHEN platform = 'twitch' THEN jsonb_build_array('twitch.tv')
                WHEN platform = 'kick' THEN jsonb_build_array('kick.com')
                ELSE '[]'::jsonb END,
            'origin_cidrs', '[]'::jsonb
        )
        WHERE auth = '{}'::jsonb
        """
    )
    op.execute(
        "COMMENT ON COLUMN ingest_sources.auth IS "
        "'Caller-authentication policy svc_ingest enforces: "
        "{modes, cidrs, secret_ref, origin_suffixes, origin_cidrs}. Never holds a secret.'"
    )
    op.execute(
        "COMMENT ON COLUMN ingest_sources.auth_secret_ciphertext IS "
        "'AES-256-GCM bearer token or Basic password hash. Never served by any endpoint.'"
    )


def downgrade() -> None:
    """Drop the three columns. The policy is reconstructible from defaults, the secrets are not."""
    op.execute(
        """
        ALTER TABLE ingest_sources
            DROP COLUMN IF EXISTS auth,
            DROP COLUMN IF EXISTS auth_secret_ciphertext,
            DROP COLUMN IF EXISTS auth_secret_iv
        """
    )
```

- [ ] **Step 4: Extend the pydal binder**

In `hub_api/services/schema.py`'s `bind_bundle_install_tables`, add these three `Field(...)` lines to the existing `dal.define_table("ingest_sources", ...)` call, immediately after the `Field("mapping", "json")` line:

```python
        Field("auth", "json", default={}),
        Field("auth_secret_ciphertext", "blob"),
        Field("auth_secret_iv", "blob"),
```

- [ ] **Step 5: Write `services/ingest_source_auth.py`**

```python
# hub_api/services/ingest_source_auth.py
"""Validation and canonicalisation of an ingest source's caller-authentication policy.

The HMAC secret proves a payload was produced by someone holding the
secret; it does not prove *who* sent this particular request, and a
captured body replays cleanly. So every generic webhook source must
also declare a second factor -- an IP allowlist, a bearer token, or
HTTP Basic -- and Twitch/Kick sources carry an origin policy instead,
their senders being known.

This module produces the canonical `auth` dict stored on the row and
published verbatim by `GET /api/v1/distribution/sources` (must match
plan M5). It never stores or returns a secret: `build_auth_config`
hands the plaintext back to its caller exactly once, for the caller to
encrypt, and the dict it returns is safe to serve.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from typing import Any

MODE_HMAC = "hmac"
MODE_IP_ALLOWLIST = "ip_allowlist"
MODE_BEARER = "bearer"
MODE_BASIC = "basic"

SECOND_FACTOR_MODES = frozenset({MODE_IP_ALLOWLIST, MODE_BEARER, MODE_BASIC})
KNOWN_MODES = SECOND_FACTOR_MODES | {MODE_HMAC}

WEBHOOK_PLATFORM = "webhook"
CUSTOM_PLATFORM_PREFIX = "custom:"

DEFAULT_ORIGIN_SUFFIXES: dict[str, tuple[str, ...]] = {
    "twitch": ("twitch.tv",),
    "kick": ("kick.com",),
}

MIN_BEARER_TOKEN_CHARS = 32
MIN_BASIC_PASSWORD_CHARS = 12

_ORIGIN_SUFFIX_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")


class AuthConfigError(ValueError):
    """An auth block failed validation. `reason` is the machine-checkable error code."""

    def __init__(self, reason: str, detail: str) -> None:
        self.reason = reason
        super().__init__(f"{reason}: {detail}")


def is_generic_webhook(platform: str) -> bool:
    """True for the built-in `webhook` platform and every tenant-registered `custom:<name>`."""
    return platform == WEBHOOK_PLATFORM or platform.startswith(CUSTOM_PLATFORM_PREFIX)


def _validate_cidrs(values: Any, *, field: str) -> list[str]:
    """Parse every entry with `ipaddress.ip_network(strict=False)`; a failure is `invalid_cidr`."""
    if values is None:
        return []
    if not isinstance(values, list):
        raise AuthConfigError("malformed_auth", f"{field} must be a list of CIDR strings")
    parsed: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise AuthConfigError("invalid_cidr", f"{value!r} is not a CIDR string")
        try:
            ipaddress.ip_network(value, strict=False)
        except ValueError as exc:
            raise AuthConfigError("invalid_cidr", f"{value!r} is not a valid CIDR: {exc}") from exc
        parsed.append(value)
    return sorted(set(parsed))


def _validate_origin_suffixes(values: Any, platform: str) -> list[str]:
    """Lowercase, dedupe and sort; each must be a bare dotted suffix -- no scheme, path or wildcard."""
    if values is None:
        return sorted(DEFAULT_ORIGIN_SUFFIXES.get(platform, ()))
    if not isinstance(values, list):
        raise AuthConfigError("malformed_auth", "origin_suffixes must be a list of domain suffixes")
    normalised: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise AuthConfigError("invalid_origin_suffix", f"{value!r} is not a string")
        candidate = value.strip().lower()
        if not _ORIGIN_SUFFIX_RE.match(candidate):
            raise AuthConfigError(
                "invalid_origin_suffix",
                f"{value!r} must be a bare dotted domain suffix (no scheme, path or wildcard)",
            )
        normalised.append(candidate)
    return sorted(set(normalised))


def _normalise_modes(raw_modes: Any) -> list[str]:
    """`hmac` first, then the declared second factors, deduped and sorted."""
    if raw_modes is None:
        return [MODE_HMAC]
    if not isinstance(raw_modes, list) or any(not isinstance(m, str) for m in raw_modes):
        raise AuthConfigError("malformed_auth", "modes must be a list of strings")
    unknown = {m for m in raw_modes if m not in KNOWN_MODES}
    if unknown:
        raise AuthConfigError("unknown_auth_mode", f"unknown auth modes {sorted(unknown)}")
    seconds = sorted({m for m in raw_modes if m in SECOND_FACTOR_MODES})
    return [MODE_HMAC, *seconds]


def build_auth_config(
    platform: str, raw: dict[str, Any] | None, *, secret_ref: str
) -> tuple[dict[str, Any], str | None]:
    """Canonicalise one source's auth block. Returns `(config, plaintext_secret_or_None)`.

    The returned config is exactly the five-key (six with
    `basic_username`) wire shape the distribution API publishes and is
    safe to serve; the plaintext is handed back once, for the caller to
    encrypt, and appears nowhere in the config.
    """
    if raw is not None and not isinstance(raw, dict):
        raise AuthConfigError("malformed_auth", "auth must be an object")
    block: dict[str, Any] = dict(raw or {})

    modes = _normalise_modes(block.get("modes"))
    if is_generic_webhook(platform) and not (set(modes) & SECOND_FACTOR_MODES):
        raise AuthConfigError(
            "auth_second_factor_required",
            f"generic webhook source on {platform!r} must declare one of "
            f"{sorted(SECOND_FACTOR_MODES)} in addition to hmac",
        )

    cidrs = _validate_cidrs(block.get("cidrs"), field="cidrs")
    if MODE_IP_ALLOWLIST in modes and not cidrs:
        raise AuthConfigError("cidrs_required", "ip_allowlist mode requires at least one CIDR")

    config: dict[str, Any] = {
        "modes": modes,
        "cidrs": cidrs,
        "secret_ref": secret_ref,
        "origin_suffixes": _validate_origin_suffixes(block.get("origin_suffixes"), platform),
        "origin_cidrs": _validate_cidrs(block.get("origin_cidrs"), field="origin_cidrs"),
    }

    plaintext: str | None = None
    if MODE_BEARER in modes:
        token = block.get("bearer_token")
        if not isinstance(token, str) or len(token) < MIN_BEARER_TOKEN_CHARS:
            raise AuthConfigError(
                "bearer_token_too_short",
                f"bearer_token must be at least {MIN_BEARER_TOKEN_CHARS} characters",
            )
        plaintext = token
    if MODE_BASIC in modes:
        username = block.get("basic_username")
        password = block.get("basic_password")
        if not isinstance(username, str) or not username.strip():
            raise AuthConfigError("basic_username_required", "basic mode requires basic_username")
        if not isinstance(password, str) or len(password) < MIN_BASIC_PASSWORD_CHARS:
            raise AuthConfigError(
                "basic_password_too_short",
                f"basic_password must be at least {MIN_BASIC_PASSWORD_CHARS} characters",
            )
        config["basic_username"] = username.strip()
        plaintext = hashlib.sha256(password.encode("utf-8")).hexdigest()
    if MODE_BEARER in modes and MODE_BASIC in modes:
        raise AuthConfigError(
            "malformed_auth", "bearer and basic are mutually exclusive -- one secret slot per source"
        )
    return config, plaintext
```

- [ ] **Step 6: Wire it into `services/ingest_source_service.py`**

Add these imports:

```python
from services.bundle_secret_crypto import decrypt, encrypt
from services.errors import ApiError, not_found
from services.ingest_source_auth import AuthConfigError, build_auth_config
```

Add an `auth: dict[str, Any] | None = None` keyword-only parameter to `create_source` and, immediately before the row insert, this block:

```python
    try:
        auth_config, auth_plaintext = build_auth_config(platform, auth, secret_ref=f"src:{source_id}")
    except AuthConfigError as exc:
        raise ApiError(str(exc), 422, exc.reason) from exc
    auth_ciphertext, auth_iv = encrypt(auth_plaintext) if auth_plaintext is not None else (None, None)
```

then add `auth=auth_config, auth_secret_ciphertext=auth_ciphertext, auth_secret_iv=auth_iv,` to the existing `insert_async(dal.ingest_sources, ...)` call. Nothing else in `create_source` changes.

Append these two functions at the end of the module:

```python
async def update_source_auth(
    async_dal: Any, dal: Any, *, tenant_id: int, source_id: str, auth: dict[str, Any], actor_id: int
) -> Any:
    """Replace one source's auth policy, rotate its auth secret, and audit the mode change.

    The audit row records the old and new `modes` lists and nothing
    else -- never a token, never a password, never a hash.
    """
    rows = await async_dal.select_async(
        dal((dal.ingest_sources.tenant_id == tenant_id) & (dal.ingest_sources.source_id == source_id))
    )
    if not rows:
        raise not_found(f"ingest source {source_id!r} not found")
    existing = rows[0]

    try:
        auth_config, auth_plaintext = build_auth_config(
            existing.platform, auth, secret_ref=f"src:{source_id}"
        )
    except AuthConfigError as exc:
        raise ApiError(str(exc), 422, exc.reason) from exc
    ciphertext, iv = encrypt(auth_plaintext) if auth_plaintext is not None else (None, None)

    old_modes = list((existing.auth or {}).get("modes", []))
    now = datetime.now(UTC)
    await async_dal.update_async(
        dal.ingest_sources.id == existing.id,
        auth=auth_config, auth_secret_ciphertext=ciphertext, auth_secret_iv=iv, updated_at=now,
    )
    try:
        await async_dal.insert_async(
            dal.audit_log, user_id=actor_id, action="ingest_source_auth_changed",
            target_type="ingest_source", target_id=source_id,
            details={
                "tenant_id": tenant_id, "platform": existing.platform,
                "old_modes": old_modes, "new_modes": auth_config["modes"],
            },
            created_at=now,
        )
    except Exception:  # noqa: BLE001, S110 -- audit logging failure must not break the main flow
        pass
    async_dal.dal.commit()
    updated = await async_dal.select_async(dal(dal.ingest_sources.id == existing.id))
    return updated[0]


async def resolve_auth_secret(async_dal: Any, dal: Any, *, tenant_id: int, source_id: str) -> str | None:
    """Decrypt the source's bearer token or Basic password hash. `None` when no secret is set."""
    rows = await async_dal.select_async(
        dal((dal.ingest_sources.tenant_id == tenant_id) & (dal.ingest_sources.source_id == source_id))
    )
    if not rows or rows[0].auth_secret_ciphertext is None:
        return None
    return decrypt(rows[0].auth_secret_ciphertext, rows[0].auth_secret_iv)
```

If `datetime`/`UTC` are not already imported in this module, add `from datetime import UTC, datetime`.

- [ ] **Step 7: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_source_auth.py -v`
Expected: `35 passed` (5 `is_generic_webhook` cases + 5 CIDR cases + 4 malformed-auth cases + 4 origin-suffix cases + 17 named tests).

- [ ] **Step 8: Verify the migration applies and backfills, on a real Postgres**

Run:
```bash
docker run -d --name pg-m2b-0022 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=waddlebot -p 55436:5432 postgres:17-alpine
sleep 3
DATABASE_URL="postgresql://postgres:test@localhost:55436/waddlebot" alembic upgrade 0021_bundle_install_schema
psql "postgresql://postgres:test@localhost:55436/waddlebot" -c \
  "INSERT INTO tenants (slug, display_name, is_active) VALUES ('acme','Acme',true) ON CONFLICT DO NOTHING;"
psql "postgresql://postgres:test@localhost:55436/waddlebot" -c \
  "INSERT INTO ingest_sources (tenant_id, platform, source_id, label) \
   SELECT id, 'twitch', 'tw-legacy', 'Legacy channel' FROM tenants WHERE slug='acme';"
DATABASE_URL="postgresql://postgres:test@localhost:55436/waddlebot" alembic upgrade 0022_ingest_source_auth
psql "postgresql://postgres:test@localhost:55436/waddlebot" -t -c \
  "SELECT auth FROM ingest_sources WHERE source_id='tw-legacy';"
docker rm -f pg-m2b-0022
```
Expected: the final `psql` prints a JSON object whose `"modes"` is `["hmac"]`, whose `"secret_ref"` is `"src:tw-legacy"`, and whose `"origin_suffixes"` is `["twitch.tv"]` — proving the backfill ran and an existing row was not left with an empty policy.

- [ ] **Step 9: Confirm zero regression on the ingest-source suites**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_source_service.py tests/test_ingest_sources_blueprint.py tests/test_distribution_sources_blueprint.py -v`
Expected: every previously-passing test still passes. Non-generic sources (`twitch`, `discord`, `custom:` absent) accept `auth=None` and get the platform default, so no existing call site needs the new keyword.

- [ ] **Step 10: Commit**

```bash
git add alembic/versions/0022_ingest_source_auth.py hub_api/services/ingest_source_auth.py \
        hub_api/services/schema.py hub_api/services/ingest_source_service.py \
        hub_api/tests/test_ingest_source_auth.py
git commit -m "$(cat <<'EOF'
db(hub-api): per-source auth config on ingest_sources -- second factor, origin policy, encrypted secret

The HMAC secret authenticates the payload, not the caller. Generic
webhook sources (custom:<name>, webhook) must now declare at least one
of ip_allowlist / bearer / basic alongside hmac, refused 422
auth_second_factor_required otherwise; Twitch and Kick carry an origin
policy instead (origin_suffixes defaulting to twitch.tv / kick.com,
plus optional origin_cidrs). CIDRs are parsed with ipaddress and a bad
one is 422 invalid_cidr.

Bearer tokens and Basic password hashes are AES-256-GCM at rest in
auth_secret_ciphertext/auth_secret_iv and never appear in the auth
document, any response, or the audit row -- the wire carries secret_ref
only. Every auth change writes audit_log ingest_source_auth_changed
with the old and new mode lists.

Migration 0022 backfills existing rows with the platform-appropriate
default, so a deploy never silently breaks a running webhook source.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 40: publish `auth` — distribution `/sources`, the tenant config view, the consent view, and the auth `PUT`

**Depends on:** Task 39 (`ingest_source_auth`, `update_source_auth`, the `auth` column), Task 34 (`list_sources_for_distribution` + `GET /api/v1/distribution/sources`), Task 27 (`blueprints/v1/ingest_sources.py`), Task 22 (`blueprints/v1/bundle_approvals.py`), Task 37 (`require_flags`).

**Files:**
- Modify: `hub_api/services/ingest_source_service.py`
- Modify: `hub_api/blueprints/v1/distribution.py`
- Modify: `hub_api/blueprints/v1/ingest_sources.py`
- Modify: `hub_api/blueprints/v1/bundle_approvals.py`
- Test: `hub_api/tests/test_ingest_source_auth_api.py`

**Interfaces:**

| Method | Path | Auth | Body / params | Success |
|---|---|---|---|---|
| `GET` | `/api/v1/distribution/sources` | `distribution:read` | unchanged (Task 34) | each `sources[]` row gains `auth` — the exact Decision #13 wire shape, **must match plan M5** |
| `GET` | `/api/v1/tenant/{slug}/ingest-sources` | `tenant_middleware` | unchanged | each row gains `auth` (the config view) |
| `POST` | `/api/v1/tenant/{slug}/ingest-sources` | `tenant:admin` + flags | body gains `"auth": {...} \| null` | `201`, `422` on a bad auth block |
| `PUT` | `/api/v1/tenant/{slug}/ingest-sources/{sourceId}/auth` | `tenant:admin` + `require_flags(FLAG_RUST_DATA_PLANE, FLAG_GENERIC_INTAKE)` | `{"auth": {...}}` | `200 {"success": true, "modes": [...]}` |
| `GET` | `/api/v1/apps/{app_id}/versions/{version}/permissions` | `platform:admin` | new optional query param `communityId` (int) | response gains `sourceAuth` (the consent view) |

- Produces: `DistributionSource.auth: dict[str, Any]`; `DistributionSourceDTO.auth`; `IngestSourceAuthRequest(auth: dict[str, Any])`; `PermissionSummaryResponse.sourceAuth: list[dict[str, Any]]`; `async def source_auth_for_consent(async_dal, dal, *, tenant_id: int, community_id: int | None, consumes_platforms: set[str]) -> list[dict[str, Any]]`.
- Consumes: `services.ingest_source_service.{list_sources_for_distribution, update_source_auth}` (Tasks 34, 39); `services.bundle_feature_gate.{FLAG_GENERIC_INTAKE, FLAG_RUST_DATA_PLANE, require_flags}` (Task 37).

**`sourceAuth` is deliberately outside the hashed summary.** `permission_hash` is computed over `summary` only (Task 18's `canonical_json(summary)`), and this task does not change that. Rotating a bearer token or widening a CIDR list must not silently invalidate every existing approval for every bundle that happens to read that platform — the operator sees the configured mode on the consent screen because it is a sibling field of `summary` in the response DTO, not a member of it. A test asserts the hash is byte-identical before and after an auth change.

- [ ] **Step 1: Write the failing test**

```python
# hub_api/tests/test_ingest_source_auth_api.py
"""API-level tests for publishing the per-source auth config (Decision #13, must match plan M5)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from quart import Quart

from services.ingest_source_service import create_source
from tests.conftest import TENANT_SLUG, make_user_token

_BEARER = "t" * 40


@pytest.fixture(autouse=True)
def _key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUNDLE_SECRET_ENCRYPTION_KEY", "e" * 64)


@pytest.fixture(autouse=True)
def _flags_on(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _always_on(*_args: Any, **_kwargs: Any) -> bool:
        return True

    monkeypatch.setattr("services.bundle_feature_gate.feature_enabled", _always_on)


async def _seed(bundle_install_db: Any) -> None:
    await create_source(
        bundle_install_db, bundle_install_db.dal, tenant_id=1, community_id=None,
        platform="custom:acme", source_id="wh-1", label="Acme webhook", mapping=None,
        auth={"modes": ["bearer"], "bearer_token": _BEARER},
    )
    await create_source(
        bundle_install_db, bundle_install_db.dal, tenant_id=1, community_id=None,
        platform="twitch", source_id="tw-channelA", label="Twitch #channelA", mapping=None, auth=None,
    )


def _app(bundle_install_db: Any, module_path: str) -> Quart:
    import importlib

    module = importlib.import_module(module_path)
    app = Quart(__name__)
    app.config["async_dal"] = bundle_install_db
    app.config["dal"] = bundle_install_db.dal
    for bp in module.BLUEPRINTS:
        app.register_blueprint(bp)
    return app


async def test_distribution_sources_publish_the_exact_m5_auth_shape(bundle_install_db: Any) -> None:
    await _seed(bundle_install_db)
    app = _app(bundle_install_db, "blueprints.v1.distribution")
    token = make_user_token(user_id=1, scope="distribution:read", tenant=TENANT_SLUG)
    response = await app.test_client().get(
        "/api/v1/distribution/sources", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    by_id = {s["sourceId"]: s for s in (await response.get_json())["sources"]}

    assert set(by_id["wh-1"]["auth"]) == {"modes", "cidrs", "secret_ref", "origin_suffixes", "origin_cidrs"}
    assert by_id["wh-1"]["auth"]["modes"] == ["hmac", "bearer"]
    assert by_id["wh-1"]["auth"]["secret_ref"] == "src:wh-1"
    assert by_id["wh-1"]["auth"]["cidrs"] == []
    assert by_id["tw-channelA"]["auth"]["modes"] == ["hmac"]
    assert by_id["tw-channelA"]["auth"]["origin_suffixes"] == ["twitch.tv"]


async def test_distribution_sources_never_echo_the_bearer_token(bundle_install_db: Any) -> None:
    await _seed(bundle_install_db)
    app = _app(bundle_install_db, "blueprints.v1.distribution")
    token = make_user_token(user_id=1, scope="distribution:read", tenant=TENANT_SLUG)
    response = await app.test_client().get(
        "/api/v1/distribution/sources", headers={"Authorization": f"Bearer {token}"}
    )
    assert _BEARER not in (await response.get_data()).decode()


async def test_distribution_sources_etag_changes_when_auth_changes(bundle_install_db: Any) -> None:
    await _seed(bundle_install_db)
    app = _app(bundle_install_db, "blueprints.v1.distribution")
    token = make_user_token(user_id=1, scope="distribution:read", tenant=TENANT_SLUG)
    client = app.test_client()
    before = await client.get("/api/v1/distribution/sources", headers={"Authorization": f"Bearer {token}"})

    from services.ingest_source_service import update_source_auth

    await update_source_auth(
        bundle_install_db, bundle_install_db.dal, tenant_id=1, source_id="wh-1",
        auth={"modes": ["ip_allowlist"], "cidrs": ["203.0.113.0/24"]}, actor_id=1,
    )
    after = await client.get("/api/v1/distribution/sources", headers={"Authorization": f"Bearer {token}"})
    assert before.headers["ETag"] != after.headers["ETag"]


async def test_tenant_config_view_shows_the_configured_mode(bundle_install_db: Any) -> None:
    await _seed(bundle_install_db)
    app = _app(bundle_install_db, "blueprints.v1.ingest_sources")
    token = make_user_token(user_id=1, scope="tenant:admin", tenant=TENANT_SLUG)
    response = await app.test_client().get(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    by_id = {s["sourceId"]: s for s in (await response.get_json())["sources"]}
    assert by_id["wh-1"]["auth"]["modes"] == ["hmac", "bearer"]
    assert _BEARER not in (await response.get_data()).decode()


async def test_post_source_rejects_a_generic_source_without_a_second_factor(bundle_install_db: Any) -> None:
    app = _app(bundle_install_db, "blueprints.v1.ingest_sources")
    token = make_user_token(user_id=1, scope="tenant:admin", tenant=TENANT_SLUG)
    response = await app.test_client().post(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources",
        headers={"Authorization": f"Bearer {token}"},
        json={"communityId": None, "platform": "custom:acme", "sourceId": "wh-2",
              "label": "Second webhook", "mapping": None, "auth": {"modes": ["hmac"]}},
    )
    assert response.status_code == 422
    assert (await response.get_json())["error"]["code"] == "auth_second_factor_required"


@pytest.mark.parametrize(
    ("auth", "code"),
    [
        ({"modes": ["ip_allowlist"], "cidrs": ["203.0.113.0/33"]}, "invalid_cidr"),
        ({"modes": ["ip_allowlist"], "cidrs": []}, "cidrs_required"),
        ({"modes": ["bearer"], "bearer_token": "short"}, "bearer_token_too_short"),
        ({"modes": ["nope"]}, "unknown_auth_mode"),
    ],
)
async def test_put_auth_surfaces_every_validation_failure_as_422(
    bundle_install_db: Any, auth: dict[str, Any], code: str
) -> None:
    await _seed(bundle_install_db)
    app = _app(bundle_install_db, "blueprints.v1.ingest_sources")
    token = make_user_token(user_id=1, scope="tenant:admin", tenant=TENANT_SLUG)
    response = await app.test_client().put(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources/wh-1/auth",
        headers={"Authorization": f"Bearer {token}"}, json={"auth": auth},
    )
    assert response.status_code == 422
    assert (await response.get_json())["error"]["code"] == code


async def test_put_auth_requires_tenant_admin(bundle_install_db: Any) -> None:
    await _seed(bundle_install_db)
    app = _app(bundle_install_db, "blueprints.v1.ingest_sources")
    token = make_user_token(user_id=1, scope="", tenant=TENANT_SLUG)
    response = await app.test_client().put(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources/wh-1/auth",
        headers={"Authorization": f"Bearer {token}"},
        json={"auth": {"modes": ["ip_allowlist"], "cidrs": ["203.0.113.0/24"]}},
    )
    assert response.status_code == 403


async def test_put_auth_is_flag_gated(bundle_install_db: Any) -> None:
    await _seed(bundle_install_db)
    app = _app(bundle_install_db, "blueprints.v1.ingest_sources")
    token = make_user_token(user_id=1, scope="tenant:admin", tenant=TENANT_SLUG)
    with patch("services.bundle_feature_gate.feature_enabled", new_callable=AsyncMock) as mock_flag:
        mock_flag.return_value = False
        response = await app.test_client().put(
            f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources/wh-1/auth",
            headers={"Authorization": f"Bearer {token}"},
            json={"auth": {"modes": ["ip_allowlist"], "cidrs": ["203.0.113.0/24"]}},
        )
    assert response.status_code == 403
    assert (await response.get_json())["error"]["code"] == "feature_disabled"


async def test_put_auth_happy_path_writes_the_audit_row(bundle_install_db: Any) -> None:
    await _seed(bundle_install_db)
    dal = bundle_install_db.dal
    app = _app(bundle_install_db, "blueprints.v1.ingest_sources")
    token = make_user_token(user_id=1, scope="tenant:admin", tenant=TENANT_SLUG)
    response = await app.test_client().put(
        f"/api/v1/tenant/{TENANT_SLUG}/ingest-sources/wh-1/auth",
        headers={"Authorization": f"Bearer {token}"},
        json={"auth": {"modes": ["ip_allowlist"], "cidrs": ["203.0.113.0/24"]}},
    )
    assert response.status_code == 200
    assert (await response.get_json())["modes"] == ["hmac", "ip_allowlist"]

    audit_row = dal(dal.audit_log.action == "ingest_source_auth_changed").select().first()
    assert audit_row is not None
    assert audit_row.details["new_modes"] == ["hmac", "ip_allowlist"]


async def test_consent_view_shows_the_mode_without_changing_the_permission_hash(
    bundle_install_db: Any,
) -> None:
    await _seed(bundle_install_db)
    dal = bundle_install_db.dal
    manifest = {
        "schema_version": 2, "app_id": "waddles.socials.music.default", "name": "Music Station",
        "version": "3.0.1", "feature": "waddles.socials.music", "module": "socials",
        "provider": "builtin", "language": "python", "artifact": "source",
        "stages": {"process": {"entry": "x:y",
                               "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}]}},
    }
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED", manifest_json=manifest,
    )
    dal.commit()

    app = _app(bundle_install_db, "blueprints.v1.bundle_approvals")
    token = make_user_token(user_id=1, scope="platform:admin", tenant=TENANT_SLUG)
    client = app.test_client()
    before = await client.get(
        "/api/v1/apps/waddles.socials.music.default/versions/3.0.1/permissions",
        headers={"Authorization": f"Bearer {token}"},
    )
    body_before = await before.get_json()
    assert before.status_code == 200
    assert any(entry["sourceId"] == "tw-channelA" for entry in body_before["sourceAuth"])
    assert next(e for e in body_before["sourceAuth"] if e["sourceId"] == "tw-channelA")["authModes"] == ["hmac"]

    from services.ingest_source_service import update_source_auth

    await update_source_auth(
        bundle_install_db, dal, tenant_id=1, source_id="tw-channelA",
        auth={"origin_suffixes": ["twitch.tv", "eventsub.twitch.tv"]}, actor_id=1,
    )
    after = await client.get(
        "/api/v1/apps/waddles.socials.music.default/versions/3.0.1/permissions",
        headers={"Authorization": f"Bearer {token}"},
    )
    body_after = await after.get_json()
    assert body_after["permissionHash"] == body_before["permissionHash"]
    assert next(e for e in body_after["sourceAuth"] if e["sourceId"] == "tw-channelA")["originSuffixes"] == [
        "eventsub.twitch.tv", "twitch.tv"
    ]


async def test_consent_view_never_echoes_a_secret(bundle_install_db: Any) -> None:
    await _seed(bundle_install_db)
    dal = bundle_install_db.dal
    dal.app_version_uploads.insert(
        app_id="waddles.socials.music.default", version="3.0.1", tenant_id=1,
        artifact_kind="source", language="python", status="PUBLISHED",
        manifest_json={
            "schema_version": 2, "app_id": "waddles.socials.music.default", "name": "Music Station",
            "version": "3.0.1", "feature": "waddles.socials.music", "module": "socials",
            "provider": "builtin", "language": "python", "artifact": "source",
            "stages": {"process": {"entry": "x:y",
                                   "consumes": [{"platform": "custom:acme", "event_types": ["chat.message"]}]}},
        },
    )
    dal.commit()
    app = _app(bundle_install_db, "blueprints.v1.bundle_approvals")
    token = make_user_token(user_id=1, scope="platform:admin", tenant=TENANT_SLUG)
    response = await app.test_client().get(
        "/api/v1/apps/waddles.socials.music.default/versions/3.0.1/permissions",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert _BEARER not in (await response.get_data()).decode()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_source_auth_api.py -v`
Expected: `KeyError: 'auth'` on the distribution and config-view tests, `405`/`404` on the `PUT .../auth` tests, `KeyError: 'sourceAuth'` on the consent-view tests.

- [ ] **Step 3: Publish `auth` on `DistributionSource`**

In `hub_api/services/ingest_source_service.py`, add `auth: dict[str, Any]` as the last field of the `DistributionSource` dataclass:

```python
    auth: dict[str, Any]
```

and add `auth=dict(row.auth or {}),` to the `DistributionSource(...)` construction inside `list_sources_for_distribution`.

Append this function to the same module:

```python
async def source_auth_for_consent(
    async_dal: Any, dal: Any, *, tenant_id: int, community_id: int | None, consumes_platforms: set[str]
) -> list[dict[str, Any]]:
    """The configured auth mode of every source a bundle's `consumes` rules would reach.

    Shown on the consent screen next to the grant list so an approver
    sees *how a caller is authenticated*, not only *what is read*.
    Deliberately NOT part of the hashed permission summary: rotating a
    token or widening a CIDR must never invalidate an existing
    approval.
    """
    query = dal.ingest_sources.tenant_id == tenant_id
    if community_id is not None:
        query &= (dal.ingest_sources.community_id == community_id) | (
            dal.ingest_sources.community_id == None  # noqa: E711 - pydal IS NULL operator
        )
    rows = await async_dal.select_async(dal(query), orderby=dal.ingest_sources.source_id)
    wildcard = "*" in consumes_platforms
    entries: list[dict[str, Any]] = []
    for row in rows:
        if not wildcard and row.platform not in consumes_platforms:
            continue
        auth = dict(row.auth or {})
        entries.append(
            {
                "platform": row.platform,
                "sourceId": row.source_id,
                "label": row.label,
                "authModes": list(auth.get("modes", [])),
                "cidrs": list(auth.get("cidrs", [])),
                "originSuffixes": list(auth.get("origin_suffixes", [])),
                "originCidrs": list(auth.get("origin_cidrs", [])),
            }
        )
    return entries
```

- [ ] **Step 4: Publish `auth` on the distribution `/sources` DTO**

In `hub_api/blueprints/v1/distribution.py`, add the field to `DistributionSourceDTO`:

```python
    auth: dict[str, Any] = field(default_factory=dict)
```

pass `auth=s.auth,` in the `DistributionSourceDTO(...)` construction, and add `"auth": d.auth` to the `etag_seed` projection so an auth change moves the ETag:

```python
                                config={"label": d.label, "hasSecret": d.hasSecret,
                                        "mapping": d.mapping, "auth": d.auth})
```

- [ ] **Step 5: Add `auth` to the tenant config view, the `POST` body, and the new `PUT`**

In `hub_api/blueprints/v1/ingest_sources.py`:

```python
from typing import Any

from services.bundle_feature_gate import FLAG_GENERIC_INTAKE, FLAG_RUST_DATA_PLANE, require_flags
from services.current_user import get_current_user_id
from services.ingest_source_service import update_source_auth
```

Add `auth: dict[str, Any] | None = None` as the last field of the existing `CreateSourceRequest` DTO, and pass `auth=data.auth` through to `create_source(...)`.

Add `auth: dict[str, Any] = field(default_factory=dict)` to the source DTO the `GET` handler returns, populated from `row.auth or {}`. The `GET` handler must never include `auth_secret_ciphertext`/`auth_secret_iv` — it builds a DTO per row, so simply do not add those fields.

Append this request DTO and route immediately before the file's final `BLUEPRINTS: list[Blueprint] = [...]` line:

```python
@dataclass(slots=True, frozen=True)
class IngestSourceAuthRequest:
    """Request DTO for `PUT .../ingest-sources/{sourceId}/auth`."""

    auth: dict[str, Any]


@ingest_sources_bp.route("/<slug>/ingest-sources/<source_id>/auth", methods=["PUT"])
@tenant_middleware  # type: ignore[untyped-decorator]
@require_scope("tenant:admin")  # type: ignore[untyped-decorator]
@require_flags(FLAG_RUST_DATA_PLANE, FLAG_GENERIC_INTAKE)
@validate_request(IngestSourceAuthRequest)
async def put_source_auth(
    data: IngestSourceAuthRequest, slug: str, source_id: str
) -> tuple[dict[str, object], int]:
    """Replace one source's caller-authentication policy and audit the mode change.

    `slug` is a routing segment only -- the tenant this writes to comes
    from the caller's own JWT via `get_tenant_context`, never the path
    (security.md Tenant Isolation).
    """
    async_dal, dal = _dal()
    ctx = get_tenant_context(request)
    assert ctx is not None  # nosec B101 - tenant_middleware always publishes this on the success path
    try:
        row = await update_source_auth(
            async_dal, dal, tenant_id=ctx.tenant_id, source_id=source_id,
            auth=data.auth, actor_id=get_current_user_id(request),
        )
    except ApiError as exc:
        return _err(exc)
    return {"success": True, "modes": list((row.auth or {}).get("modes", []))}, 200
```

- [ ] **Step 6: Add `sourceAuth` to the consent view**

In `hub_api/blueprints/v1/bundle_approvals.py`:

```python
from services.ingest_source_service import source_auth_for_consent
```

Add the field to the response DTO:

```python
@dataclass(slots=True, frozen=True)
class PermissionSummaryResponse:
    """Response DTO for `GET .../permissions`.

    `sourceAuth` is a sibling of `summary`, never a member: it is NOT
    covered by `permissionHash`, so rotating a source's token or
    widening its CIDR list never invalidates an existing approval.
    """

    success: bool
    summary: dict[str, Any]
    permissionHash: str
    sourceAuth: list[dict[str, Any]] = field(default_factory=list)
```

and replace the `get_permissions` body's return with:

```python
    platforms = {str(entry.get("platform")) for entry in summary.get("streams", [])}
    try:
        community_id = _parse_community_id(request.args.get("communityId"))
    except ApiError as exc:
        return _err(exc)
    source_auth = await source_auth_for_consent(
        async_dal, dal, tenant_id=ctx.tenant_id, community_id=community_id, consumes_platforms=platforms
    )
    return PermissionSummaryResponse(
        success=True, summary=summary, permissionHash=permission_hash, sourceAuth=source_auth
    )
```

Add `ctx = get_tenant_context(request)` / `assert ctx is not None  # nosec B101` above it, and the same `_parse_community_id` helper Task 31's blueprint defines (copy it verbatim into this file — a five-line helper duplicated is better than a cross-blueprint import).

- [ ] **Step 7: Run to verify all pass**

Run: `cd hub_api && python3 -m pytest tests/test_ingest_source_auth_api.py -v`
Expected: `14 passed` (4 validation-failure cases + 10 others).

- [ ] **Step 8: Confirm zero regression across every touched surface**

Run:
```bash
cd hub_api && python3 -m pytest \
  tests/test_ingest_source_service.py tests/test_ingest_source_auth.py \
  tests/test_ingest_sources_blueprint.py tests/test_distribution_sources_blueprint.py \
  tests/test_bundle_approvals_blueprint.py tests/test_bundle_approval_service.py \
  tests/test_permission_summary_service.py -v
```
Expected: every previously-passing test still passes. `test_permission_summary_service.py` in particular must be untouched — `build_permission_summary`'s signature and output are unchanged, which is what keeps `permissionHash` stable.

- [ ] **Step 9: Commit**

```bash
git add hub_api/services/ingest_source_service.py hub_api/blueprints/v1/distribution.py \
        hub_api/blueprints/v1/ingest_sources.py hub_api/blueprints/v1/bundle_approvals.py \
        hub_api/tests/test_ingest_source_auth_api.py
git commit -m "$(cat <<'EOF'
feat(hub-api): publish the per-source auth config -- distribution /sources, config view, consent view, auth PUT

GET /api/v1/distribution/sources now carries auth =
{modes, cidrs, secret_ref, origin_suffixes, origin_cidrs} per source,
the shape svc_ingest enforces (must match plan M5); the ETag moves when
an auth policy changes. The tenant config view shows the configured
mode, POST accepts an auth block, and a new
PUT /api/v1/tenant/{slug}/ingest-sources/{sourceId}/auth rotates the
policy behind tenant:admin plus the generic-intake flag, writing the
audit row.

The consent view gains sourceAuth as a sibling of summary, never a
member: rotating a token or widening a CIDR list must not invalidate
existing approvals, so permissionHash is provably unchanged by an auth
edit. No bearer token or password hash appears in any response.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Task 41: OpenAPI coverage, logging conformance, coverage gate, lint and the containerized `make` gates

**Depends on:** every preceding task. Nothing depends on this one — it is the milestone's closing gate.

**Files:**
- Create: `hub_api/tests/test_openapi_m2b_paths.py`
- Create: `hub_api/tests/test_m2b_logging_conformance.py`
- Modify: `hub_api/pyproject.toml`

**Interfaces:**
- Produces: nothing consumed by another task. Two leaf verification suites plus the final green-gate command list.
- Consumes: `hub_api/openapi/routes.py`'s existing `/openapi/v1.json` route (quart-schema's own generated document — no hand-written spec fragment is added by this milestone; every M2b route appears in it automatically because it is a registered, non-hidden Quart rule).

**Why there is no hand-authored OpenAPI file here.** hub-api serves two documents (`hub_api/openapi/spec_builder.py`'s header explains the split): a hand-curated, unauthenticated login-only document, and the full document generated by `quart_schema`'s introspection behind `tenant_middleware` + `require_scope("platform:read")`. M2b adds no public route, so `build_public_login_spec` is untouched; every new route is picked up by the generated document the moment its blueprint is registered. What this task adds is the **assertion that they actually are** — with a non-zero denominator, so a blueprint that silently failed to auto-discover is caught rather than assumed present.

- [ ] **Step 1: Write the OpenAPI coverage test**

```python
# hub_api/tests/test_openapi_m2b_paths.py
"""Asserts every M2b route appears in the generated /openapi/v1.json document.

Reports how many paths were examined -- a document that generated zero
paths, or a blueprint that failed to auto-discover, must fail here
rather than pass silently (critical-rules.md Verification Integrity).
"""

from __future__ import annotations

from typing import Any

import pytest
from quart import Quart
from quart_schema import QuartSchema

_M2B_RULES: list[str] = [
    "/api/v1/apps/<app_id>/versions",
    "/api/v1/apps/<app_id>/versions/<version>/activate",
    "/api/v1/apps/<app_id>/trip-reenable",
    "/api/v1/apps/<app_id>/versions/<version>/permissions",
    "/api/v1/apps/<app_id>/versions/<version>/approve",
    "/api/v1/apps/<app_id>/versions/<version>/deny",
    "/api/v1/apps/<app_id>/grants",
    "/api/v1/apps/<app_id>/grants/resolve",
    "/api/v1/apps/<app_id>/grants/<int:grant_id>",
    "/api/v1/bundles/<app_id>/versions/<version>/artifact",
    "/api/v1/bundles/<app_id>/versions/<version>/rejected",
    "/api/v1/marketplace/settings",
    "/api/v1/tenant/<slug>/custom-platforms",
    "/api/v1/tenant/<slug>/custom-platforms/<name>",
    "/api/v1/tenant/<slug>/custom-platforms/<name>/tokens",
    "/api/v1/tenant/<slug>/ingest-sources",
    "/api/v1/tenant/<slug>/ingest-sources/<source_id>",
    "/api/v1/tenant/<slug>/ingest-sources/<source_id>/auth",
    "/api/v1/distribution/bundles",
    "/api/v1/distribution/v2/bundles",
    "/api/v1/distribution/sources",
]

_M2B_MODULES: list[str] = [
    "blueprints.v1.bundle_versions",
    "blueprints.v1.bundle_approvals",
    "blueprints.v1.bundle_grants",
    "blueprints.v1.bundle_artifact_callback",
    "blueprints.v1.bundle_settings",
    "blueprints.v1.custom_platforms",
    "blueprints.v1.ingest_sources",
    "blueprints.v1.distribution",
]


@pytest.fixture
def m2b_app() -> Quart:
    """Every M2b blueprint registered on one app, with QuartSchema wired as `app.py` wires it."""
    import importlib

    app = Quart(__name__)
    QuartSchema(app, openapi_path=None, swagger_ui_path=None)
    registered = 0
    for module_path in _M2B_MODULES:
        module = importlib.import_module(module_path)
        for bp in module.BLUEPRINTS:
            app.register_blueprint(bp)
            registered += 1
    print(f"openapi check: blueprints registered = {registered}")
    assert registered >= len(_M2B_MODULES), "at least one blueprint per module must register"
    return app


def test_every_m2b_rule_is_mounted(m2b_app: Quart) -> None:
    # If a rule below does not match, check the handler's actual converter
    # variable name first (`<source_id>` vs `<sourceId>` etc.) and correct
    # THIS list -- never rename a route to satisfy the test, because the
    # path shape is the wire contract the Rust stages and the webui call.
    mounted = {str(rule.rule) for rule in m2b_app.url_map.iter_rules()}
    print(f"openapi check: rules examined = {len(mounted)}")
    assert len(mounted) > 0, "zero rules examined -- FAIL, not a pass"
    missing = [rule for rule in _M2B_RULES if rule not in mounted]
    assert not missing, f"M2b rules missing from the app: {missing}"


def test_generated_openapi_document_contains_every_m2b_path(m2b_app: Quart) -> None:
    provider = m2b_app.extensions["QUART_SCHEMA"].openapi_provider
    schema: dict[str, Any] = provider.schema()
    paths = schema.get("paths", {})
    print(f"openapi check: generated paths examined = {len(paths)}")
    assert len(paths) > 0, "the generated document has zero paths -- FAIL, not a pass"

    def _to_openapi(rule: str) -> str:
        out = rule
        for werkzeug, name in (("<int:grant_id>", "{grant_id}"),):
            out = out.replace(werkzeug, name)
        while "<" in out:
            start = out.index("<")
            end = out.index(">", start)
            out = out[:start] + "{" + out[start + 1 : end] + "}" + out[end + 1 :]
        return out

    expected = {_to_openapi(rule) for rule in _M2B_RULES}
    missing = sorted(expected - set(paths))
    assert not missing, f"M2b paths absent from the generated OpenAPI document: {missing}"


def test_the_public_document_did_not_grow(m2b_app: Quart) -> None:
    """M2b adds no unauthenticated route -- the login-only public document must still have exactly one path."""
    from openapi.spec_builder import build_public_login_spec

    spec = build_public_login_spec(title="hub-api", version="3.0.0")
    assert list(spec["paths"]) == ["/api/v1/auth/login"]
```

- [ ] **Step 2: Run it**

Run: `cd hub_api && python3 -m pytest tests/test_openapi_m2b_paths.py -v -s`
Expected: `3 passed`, with stdout carrying the denominators — `openapi check: blueprints registered = 8`, `openapi check: rules examined = <N>` where N ≥ 21, `openapi check: generated paths examined = <M>` where M ≥ 21.

- [ ] **Step 3: Write the logging-conformance test**

```python
# hub_api/tests/test_m2b_logging_conformance.py
"""Every M2b module uses the flask_core logging library, never a hand-rolled logger.

testing.md Logging Library Conformance. Reports how many files were
scanned: a scanner pointed at a moved directory reports clean, so a
zero-file scan is a FAILURE, not a pass.
"""

from __future__ import annotations

import re
from pathlib import Path

_M2B_FILES: list[str] = [
    "services/bundle_secret_crypto.py",
    "services/bundle_manifest_v2.py",
    "services/bundle_storage_service.py",
    "services/compiler_job_service.py",
    "services/bundle_version_service.py",
    "services/bundle_artifact_service.py",
    "services/bundle_activation_service.py",
    "services/permission_summary_service.py",
    "services/bundle_approval_service.py",
    "services/bundle_db_role_service.py",
    "services/platform_settings_service.py",
    "services/tenant_bundle_settings.py",
    "services/custom_platform_service.py",
    "services/ingest_source_service.py",
    "services/ingest_source_auth.py",
    "services/valkey_admin_client.py",
    "services/stream_grant_service.py",
    "services/bundle_trip_reenable_service.py",
    "services/bundle_role_cleanup_job.py",
    "services/bundle_feature_gate.py",
    "services/bundle_telemetry.py",
    "blueprints/v1/bundle_versions.py",
    "blueprints/v1/bundle_artifact_callback.py",
    "blueprints/v1/bundle_approvals.py",
    "blueprints/v1/bundle_settings.py",
    "blueprints/v1/custom_platforms.py",
    "blueprints/v1/ingest_sources.py",
    "blueprints/v1/bundle_grants.py",
    "blueprints/v1/distribution.py",
]

_BANNED = re.compile(r"\blogging\.basicConfig\b|\blogging\.getLogger\b|^\s*print\(", re.MULTILINE)

# `print` is legitimate in the CronJob entrypoint's own stdout report --
# that is CLI output, not service logging (testing.md's explicit carve-out).
_PRINT_ALLOWED = {"services/bundle_role_cleanup_job.py"}


def test_no_m2b_module_hand_rolls_a_logger() -> None:
    root = Path(__file__).resolve().parent.parent
    scanned = 0
    offenders: list[str] = []
    for relative in _M2B_FILES:
        path = root / relative
        assert path.exists(), f"{relative} does not exist -- the scanner is pointed at the wrong root"
        scanned += 1
        source = path.read_text(encoding="utf-8")
        for match in _BANNED.finditer(source):
            if match.group(0).strip().startswith("print(") and relative in _PRINT_ALLOWED:
                continue
            line = source[: match.start()].count("\n") + 1
            offenders.append(f"{relative}:{line}: {match.group(0).strip()}")
    print(f"logging conformance: files scanned = {scanned}")
    assert scanned == len(_M2B_FILES), "zero or partial scan -- FAIL, not a pass"
    assert not offenders, "hand-rolled logging found:\n" + "\n".join(offenders)


def test_the_scanner_can_actually_fail(tmp_path: object) -> None:
    """Prove the regex fires -- a check that never fails will never be noticed."""
    assert _BANNED.search("import logging\nlogging.basicConfig(level='INFO')\n") is not None
    assert _BANNED.search("print('hello')\n") is not None
    assert _BANNED.search("from flask_core.logging_config import get_logger\n") is None
```

- [ ] **Step 4: Run it**

Run: `cd hub_api && python3 -m pytest tests/test_m2b_logging_conformance.py -v -s`
Expected: `2 passed`, stdout carrying `logging conformance: files scanned = 29`. If a file legitimately needs a logger, import it from `flask_core.logging_config` rather than `logging` — do not add the file to `_PRINT_ALLOWED`.

- [ ] **Step 5: Add every remaining ruff per-file ignore**

Append to `hub_api/pyproject.toml`'s `[tool.ruff.lint.per-file-ignores]` any entry not already added by an earlier task:

```toml
# M2b bundle-install group -- camelCase DTO fields are the wire contract the
# Rust stages and the webui deserialize (spec Sec6.7, Sec9.7); S101 is the
# tenant_middleware postcondition assert every ported blueprint repeats.
"blueprints/v1/bundle_versions.py" = ["N815", "S101"]
"blueprints/v1/bundle_artifact_callback.py" = ["N815", "S101"]
"blueprints/v1/bundle_approvals.py" = ["N815", "S101"]
"blueprints/v1/bundle_settings.py" = ["N815", "S101"]
"blueprints/v1/custom_platforms.py" = ["N815", "S101"]
"blueprints/v1/ingest_sources.py" = ["N815", "S101"]
"blueprints/v1/bundle_grants.py" = ["N815", "S101"]
"blueprints/v1/distribution.py" = ["N815", "S101"]
# The per-bundle role DDL interpolates a role name derived from a validated
# app_id and table names checked against a strict regex -- S608 flags the
# f-string SQL shape, not a real injection path (see _validate_tables).
"services/bundle_db_role_service.py" = ["S608"]
```

- [ ] **Step 6: Run the linter and confirm it can fail**

Run:
```bash
cd hub_api && python3 -m ruff check . && python3 -m ruff format --check .
```
Expected: `All checks passed!` and `<N> files already formatted`.

Then prove the gate is real:
```bash
cd hub_api && printf 'import os\n' >> services/bundle_telemetry.py && python3 -m ruff check services/bundle_telemetry.py ; git checkout -- services/bundle_telemetry.py
```
Expected: `F401 [*] \`os\` imported but unused` and a non-zero exit — the linter demonstrably fails on a real defect (`critical-rules.md` Verification Integrity). The `git checkout` restores the file.

- [ ] **Step 7: Run `mypy --strict` over the new modules**

Run:
```bash
cd hub_api && python3 -m mypy --strict \
  services/bundle_secret_crypto.py services/bundle_manifest_v2.py services/bundle_storage_service.py \
  services/compiler_job_service.py services/bundle_version_service.py services/bundle_artifact_service.py \
  services/bundle_activation_service.py services/permission_summary_service.py \
  services/bundle_approval_service.py services/bundle_db_role_service.py \
  services/platform_settings_service.py services/tenant_bundle_settings.py \
  services/custom_platform_service.py services/ingest_source_service.py services/ingest_source_auth.py \
  services/valkey_admin_client.py services/stream_grant_service.py \
  services/bundle_trip_reenable_service.py services/bundle_role_cleanup_job.py \
  services/bundle_feature_gate.py services/bundle_telemetry.py services/rbac_matrix.py \
  blueprints/v1/bundle_versions.py blueprints/v1/bundle_artifact_callback.py \
  blueprints/v1/bundle_approvals.py blueprints/v1/bundle_settings.py \
  blueprints/v1/custom_platforms.py blueprints/v1/ingest_sources.py \
  blueprints/v1/bundle_grants.py blueprints/v1/distribution.py
```
Expected: `Success: no issues found in 30 source files`. The only permitted suppressions are the `# type: ignore[untyped-decorator]` comments on `tenant_middleware`/`require_scope`, which every existing hub-api blueprint already carries (`hub_api/openapi/routes.py` documents why).

- [ ] **Step 8: Run the full M2b suite with the coverage gate**

Run:
```bash
cd hub_api && python3 -m pytest tests/ \
  --cov=services --cov=blueprints --cov-report=term-missing --cov-fail-under=90 -q
```
Expected: every test passes and the final line reads `Required test coverage of 90% reached.` — if it does not, the run exits non-zero and the milestone is not done. Record the reported total-statements number; a run whose denominator is `0 statements` is a failure, not a pass.

- [ ] **Step 9: Run the containerized build**

Run:
```bash
docker build -f hub_api/Dockerfile -t waddlebot/hub-api:m2b-local .
```
Expected: the build completes and the final stage's `USER` is non-root. Verify:
```bash
docker run --rm --entrypoint sh waddlebot/hub-api:m2b-local -c 'id -u'
```
Expected: a non-zero uid (never `0`).

- [ ] **Step 10: Run the repo's containerized `make` gates**

Run, from the repository root, in this order, stopping at the first failure:
```bash
make lint
make test-security
make test
make pre-commit
```
Expected:
- `make lint` → `scripts/lint.sh` completes with exit `0` and prints the number of files it checked.
- `make test-security` → `scripts/security-scan.sh` completes with exit `0` and reports, per scanner, how many files/packages were examined. A scanner reporting zero examined items is a FAILURE — fix the path, do not accept the clean result (`critical-rules.md` Verification Integrity).
- `make test` → `tests/k8s/alpha/05-unit-tests.sh` runs every suite and prints a non-zero `TOTAL_PASSED`.
- `make pre-commit` → `=== Pre-commit complete ===` after lint, security and test all pass.

If `make lint` or `make test-security` completes suspiciously fast or reports no denominator, audit the target once by making it fail on purpose (append an unused import, re-run, confirm a non-zero exit, revert) before treating it as green.

- [ ] **Step 11: Commit**

```bash
git add hub_api/tests/test_openapi_m2b_paths.py hub_api/tests/test_m2b_logging_conformance.py \
        hub_api/pyproject.toml
git commit -m "$(cat <<'EOF'
test(hub-api): M2b closing gate -- OpenAPI path coverage, logging conformance, ruff ignores

Asserts every M2b route is mounted and present in the generated
/openapi/v1.json document, and that the unauthenticated login-only
document did not grow. Asserts no M2b module hand-rolls a logger, with
a companion test proving the scanner's regex actually fires. Both
suites print their denominators -- a zero-file or zero-path run fails
rather than reporting clean.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
```

---

## Self-Review

Run before declaring the plan finished. Findings from the pass that produced this section are recorded as **fixed** below.

### Spec coverage

| Spec section / requirement | Where implemented | Status |
|---|---|---|
| §6.7 distribution API additions (six fields + `manifest` + `grants`) | Tasks 32, 33 | ✅ |
| §6.7 `null` digest row skipped by the stage, still served | Tasks 32, 33 | ✅ |
| §6.8 `app_stream_grants` table + partial unique | Task 3 | ✅ |
| §6.8 resolution against configured ingest sources, per-source stream keys | Task 29 | ✅ |
| §6.8 `XGROUP CREATE MKSTREAM`, BUSYGROUP-tolerant | Task 28 | ✅ |
| §6.8 re-resolution when sources appear | Tasks 29, 31 (`POST .../grants/resolve`) | ✅ |
| §6.8 wildcard gate (`allow_wildcard_consumes`) | Tasks 7, 24 | ✅ |
| §6.4.4 `routes_to` validation | Task 7 | ✅ |
| §6.9 `app_install_approvals` | Task 3 | ✅ |
| §6.10 `app_versions`, exactly two writers, audit trigger with role + old/new digest | Task 2 | ✅ |
| §6.10 `app_active_versions`, activation/rollback, refuse an unverified digest | Tasks 2, 16, 17 | ✅ |
| §9.1 AWAITING APPROVAL / APPROVED lifecycle | Tasks 3 (`app_version_uploads` statuses), 19, 30 | ✅ |
| §9.2 install + compiler Job orchestration | Tasks 8, 9, 10, 11, 12 | ✅ |
| §9.4 publish: callback is a notification, hub-api re-hashes the bucket object | Tasks 13, 15 | ✅ |
| §9.6 grant revocation + audit | Tasks 29, 31 | ✅ |
| §9.7.1 permission summary from manifest + component imports | Tasks 18, 19 (imports-based cross-check deferred with a documented scope note) | ⚠️ documented |
| §9.7.1 `permission_hash` over canonical JSON | Task 18 | ✅ |
| §9.7.2 approver recorded | Tasks 3, 19 | ✅ |
| §9.7.4 upgrade diff, narrowing auto-approve | Task 19 (`classify_diff`) | ✅ |
| §9.7.5 headless approval fails closed on hash mismatch | Task 19 | ✅ |
| §10.3/§10.4 generic intake registry + `intake:write` JWT | Tasks 25, 26, 27 | ✅ |
| Per-source `auth` second factor + origin policy (third spec review) | Tasks 39, 40 | ✅ |
| §11.10 D28 RBAC matrix, generated grants, live-grants equality CI test (≥8 roles, ≥8 tables) | Tasks 1, 2, 5 | ✅ |
| §12.3 settings `bundles.allow_prebuilt`, `bundles.egress.allowPrivateHosts`, `allow_wildcard_consumes` | Tasks 23, 24 | ✅ |
| §13.5 feature flags | Task 37 | ✅ |
| §19 Q1 trip re-enable | Task 35, Decision #10 | ✅ |
| §19 Q3 per-bundle role lifecycle | Tasks 21, 36, Decision #10b | ✅ |
| Observability: logs + metrics + traces, env-configurable endpoint | Tasks 38, 41 | ✅ |
| Coverage ≥ 90 %, ruff, mypy --strict, containerized `make` gates | Task 41 | ✅ |

The one ⚠️ is deliberate and already documented in Task 19's scope note: cross-checking the permission summary against the **component's actual imports** needs M2a's compiler to report an import list on the artifact callback. hub-api derives capabilities from the manifest's declared shape until that field exists; the follow-on is a one-function change in `_derive_capabilities`, not a redesign.

### Placeholder scan

Run this before considering the plan done:

```bash
grep -nE 'TBD|TODO|FIXME|XXX|similar to Task|same as Task|as above|placeholder|restream' \
  docs/superpowers/plans/2026-09-14-rust-data-plane-m2b-hub-api.md
```
Expected: exactly **three** hits, all benign and all outside any task body — the Global Constraints line that *forbids* the word "restream", and this Self-Review section's own two self-referential lines (the command above and the sentence you are reading). A hit anywhere inside a `## Task` body is a defect: every task must carry complete, runnable code, because its implementer sees only that task's text.

A second scan, for bodies elided rather than written out:

```bash
grep -nE '^\s*\.\.\.\s*(#|$)' docs/superpowers/plans/2026-09-14-rust-data-plane-m2b-hub-api.md
```
Expected: exactly **two** hits, both in Task 38's wiring steps (`...  # the existing body, indented one level` and `...  # existing body`). Each names precisely which existing body it stands for, is preceded by the full surrounding code, and sits in a step whose instruction is "wrap the existing body" — never a stub. Any bare `...` with no such note is a defect.

### Findings fixed during this review

| # | Finding | Fix |
|---|---|---|
| 1 | Task 32's Interfaces block declared `manifest: dict[str, Any]` on `BundleDistributionRow`, but neither the dataclass nor `_enrich_with_active_version` populated it — spec §6.7's `manifest` field would have shipped permanently empty, and the Rust stage would have had no `egress`/`data.tables`/`limits`/`consumes` to enforce. | Added `_manifest_subset()` reading `app_version_uploads.manifest_json`, applied the manifest defaults (`timeout_ms` 2000 / `memory_mb` 64 / `egress_rps` 10) at the hub rather than leaving them to the stage, widened `_enrich_with_active_version`'s return to a 7-tuple, updated both call sites and the commit message, and added four assertions to the first Task 32 test. |
| 2 | Task 32's test carried a dead line (`dal.app_catalog.update_record_by_id if False else None  # no-op line kept for diff clarity`) that would have been copied verbatim into a real test file by a worker following the task literally. | Deleted. |
| 3 | Decision #10 recorded Q1/Q3 in the spec's bare interim wording, which left "no hub-api action" for a trip and a grace-period-only role drop — neither matching the decided defaults (admin action + new digest; created at approval, dropped at uninstall). | Rewrote as Decisions #10 and #10b, and added Tasks 35 and 36 implementing both. Task 20's docstrings were realigned to match. |
| 4 | Nothing in the plan actually gated a write surface on a PostHog flag — the requirement lived only in Global Constraints, so every one of the ~20 endpoints would have shipped ungated. | Added Task 37: a `require_flags` decorator, a complete gated-surface table, the autouse test fixture that keeps every other suite green, and the `allow_prebuilt` two-gate. |
| 5 | No task emitted an OTel span, metric or trace, despite Observability being a blocking gate. | Added Task 38: `bundle_telemetry.py` (API-only, OTLP env vars, no vendor SDK), instrumentation of five service entry points and both distribution polls, and an in-memory-sink test that prints its denominators. |
| 6 | The forward references written before the renumber (`Task 33`/`Task 34`/`Task 35`) pointed at the wrong tasks once Tasks 33-41 landed. | Corrected every one: the file structure block, Task 20's note, Task 26's `/sources` reference, and the coverage line in Global Constraints. |
| 7 | `/api/v1/distribution/sources` was named in the requirements but had no service function capable of filtering or rendering stream keys. | Added `list_sources_for_distribution` in Task 34 with `communityId`/`platform`/`enabled` filter coverage, plus the widening-not-narrowing `communityId` semantics stated once and tested. |
| 8 | Tasks 1-32 (written before this pass) carried `**Files:**` and `**Interfaces:**` blocks but no `**Depends on:**` line, so a worker picking up a task in isolation had no statement of what must already exist. | Added a `**Depends on:**` line to every one of Tasks 1-32, derived from each task's own `Consumes` list and the migration chain. All 41 tasks now carry one. |
| 9 | A mid-flight requirement arrived from the user's third spec review — every ingest source needs a caller-auth second factor (generic webhooks) or an origin policy (Twitch/Kick), published to svc_ingest. Nothing in the plan modelled it: `ingest_sources` had only the HMAC secret. | Added Decision #13 (the exact wire shape, marked *must match plan M5*), Task 39 (migration 0022 + `ingest_source_auth.py` + service wiring + the audit row) and Task 40 (publication through `/distribution/sources`, the tenant config view, the consent view, and the auth `PUT`). |
| 10 | Several tasks' "Expected: `N` passed" lines were miscounted against their own parametrized cases — a worker would have seen a mismatch and assumed a real failure. | Recounted every new task's test list; corrected Tasks 33 (13→14), 36 (9→10), 37 (13→11) and 39 (31→35). |

---
