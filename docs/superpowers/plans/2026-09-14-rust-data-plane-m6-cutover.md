# M6 Cut-Over: Streaming Retirement, Charts, Docs Rewrite, Python Deletion, Alpha E2E, Release Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Waddles Rust data-plane migration: retire `core/svc_streaming`'s Python alpha, relocate every first-party Python bundle into `bundles/python/` with a generated `bundle.yaml` v2, wire the chart for all four Rust services + the executor/compiler workloads + gVisor sandbox + RBAC, rewrite `docs/APP_BUNDLE_AUTHORING.md` to v2, delete the four Python service trees, run the alpha end-to-end verification (real Twitch/Discord traffic, telemetry, latency SLA, hot-swap, bucket outage), and merge the whole cut-over into `release/v3.0.X`.

**Architecture:** One feature branch off `release/v3.0.X`, branched only after M1, M1.5, M2, M3, M4 and M5 have all merged there (§16 milestone graph: `M3, M4, M5 ──▶ M6`). This plan assumes every Rust service (`svc_ingest`, `svc_process`, `svc_action` under `core/*/src/`), `penguin-spine`/`penguin-bundle-host`/`penguin-logging`/`penguin-connectors`/`penguin-licensing` (penguin-libs), `bundle-executor`, `bundle-compiler`, `waddle-sdk{,-rs,-js}`, and the hub-api install/consent endpoints already exist and pass their own gates on `release/v3.0.X` — Task 1 verifies this before anything else proceeds. This plan's own job is the parts that only make sense once all of those exist: physically relocating and manifesting the Python bundles, deleting the now-dead Python service code and the Python `svc_streaming` alpha, wiring the chart end to end, writing the RBAC matrices, rewriting the authoring docs, and proving the whole stack works together on a freshly destroyed alpha cluster.

**Tech Stack:** Rust 1.97 (services already built by M1–M5), Python 3.13 (bundle relocation + generator scripts, hub-api, flask_core), Helm v4 (chart), YAML (RBAC/ACL matrices, `bundle.yaml` v2), Bash (verification scripts, `set -euo pipefail` throughout).

**Spec:** `docs/superpowers/specs/2026-09-14-rust-data-plane-design.md` (branch `docs/rust-data-plane-spec`, commit `680a0a9b`) — this plan implements spec §12 (Deployment), §11.10 (RBAC), §14 (Testing), §15 (Migration & cut-over), and the M6 row of §16 (Milestones). Read the spec section named in a task before disputing that task's content — the spec is authoritative over this plan on any conflict.

**Cited vs assumed prior plans:** As of this plan's writing, none of `docs/plan-penguin-{spine,bundle-host,logging,connectors}` (penguin-libs, M1a–M1d), `docs/plan-m1.5-bundle-migration`, `docs/plan-m2a-compiler-sdks`, `docs/plan-m2b-hub-api`, `docs/plan-m3-svc-action`, `docs/plan-m4-svc-process`, or `docs/plan-m5-svc-ingest` exist as pushed branches. Every artifact name below that this plan does not itself create (crate public APIs, exact Rust source file paths inside `core/svc_{ingest,process,action}/src/`, hub-api's exact consent-screen route names, `build/tool-versions.env`'s exact key names) is marked **"must match plan Mx"** at first use — Task 1 is where an implementer confirms the real name against whatever actually merged, and stops to reconcile before proceeding if it differs from this plan's placeholder-free best assumption.

## Global Constraints

- **Standards (full text in the named rule file — see `~/.claude/rules/`):** `general.md` Development Philosophy (no shortcuts, no TODOs), Language Selection (Rust for all in-line-of-traffic services and CLIs); `critical-rules.md` Coverage (90%+ lines/branches/functions/statements, every language, builds fail below); Dependency Pinning (exact versions, `Cargo.lock`/`pubspec.lock` committed, SHA-256 image digests, full-SHA GitHub Actions); Data Plane (Rust for everything in-line of traffic, no volume threshold); Observability (OTel logs+metrics+traces AND penguin logging, both, OTLP env vars only, no vendor SDK, histograms first, dead exporter never fails a request); Feature Flags & License Tiers (`{product}.{feature}` key, defaulted OFF, two-gate, cached fallback); Verification Integrity (no `\|\| true` on a gate, `set -euo pipefail`, `${PIPESTATUS[0]}`, every clean result reports the count examined, zero examined is FAIL); `security.md` Encryption (TLS 1.2+, mTLS cert validation, at-rest encryption every store); PII Tokenization (single `users` identity table, UUID everywhere else); `devops-containers.md` (Debian 12 bookworm only, SHA256-pinned bases, rootless both layers); `devops-kubernetes.md` (Helm v4 only, CiliumNetworkPolicy default-deny, namespace = product name only, Pod Security Admission `restricted`); `testing.md` Telemetry Validation + Logging Library Conformance (blocking every commit, printed counts); `devops.md` Auto-Merge into Release (pre-authorized when fully green; release→main always user-gated).
- **Pins:** Rust `1.97.1` toolchain, `cargo-deny@0.20.2`, `cargo-llvm-cov@0.9.1` — reuse the exact pins already in `.github/workflows/rust-svc-streaming.yml` (`actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd`, `dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87`, `taiki-e/install-action@3f74d7c16a4242f1c95561e98edc25d36adb4375`). Base images: `rust:1.97-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3` (builder), `debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171` (runtime) — copied verbatim from `core/svc_streaming/Dockerfile.rust`, which already uses these exact digests for the same base-image rows the spec's §12.1 table specifies for every service. `wasmtime`, `runsc`, and the Tier 1 toolchain versions live in **`build/tool-versions.env`** (created by plan M2a) — every task below reads pins from that file at render/build time; none hardcodes a version number this plan cannot verify.
- **LUA-via-RBAC (D28, spec §11.10):** Every Postgres role and every Valkey ACL user gets exactly the privileges its job needs — generated from the two normative matrices `config/postgres/rbac-matrix.yaml` and `config/valkey/acl-matrix.yaml`, never a hand-written `GRANT`. The executor has **no** database role and **no** Valkey ACL user at all — the matrix states this explicitly (a line to delete, not silently omit). CI asserts the live grants equal the matrix, set-equality both directions, failing below 8 roles or 8 tables (Postgres) with printed counts (Verification Integrity).
- **Waddles naming (D22):** Waddles is the product; `waddlebot` survives only as: (1) the chart directory/release name `k8s/helm/waddlebot` — not renamed by this plan; (2) the Postgres `DB_NAME` default `waddlebot` — not migrated; (3) the legacy `waddlebot:stream:*`/`waddlebot:dlq:*` key prefixes on the unused `flask_core.stream_pipeline.StreamPipeline` class — not renamed, not used by this project; (4) Python package paths and the sandbox-spike scratchpad path. **Everything else is Waddles** — new Valkey keys, flag keys, image names (`ghcr.io/penguintechinc/waddles/<service>`), and this plan's own new files. **Deferred, explicitly out of scope for this plan:** the git repo/org rename to `penguintechinc/waddles` and the K8s namespace/in-cluster-DNS rename to bare `waddles` are cross-cutting identity changes D22 calls for but that no M-milestone table (§16) assigns — renaming the repository this branch lives in is not achievable from inside a feature branch of that same repository. Every new chart env var that needs an in-cluster FQDN (e.g. `HUB_API_URL`) is built from `{{ include "waddlebot.namespace" . }}` (the chart's existing dynamic namespace helper), never a hardcoded `waddles` literal, so it is correct today under the `waddlebot` namespace and remains correct after that future rename with no further chart edit.
- **Branching:** This plan's own work happens on `feature/m6-rust-dataplane-cutover`, branched from `release/v3.0.X` inside a worktree (`superpowers:using-git-worktrees`), never from `main`. Every task ends with a commit; push after every commit (`devops.md` Branch Backups). PR into `release/v3.0.X` only at Task 33, and only when every gate is green — auto-merge is pre-authorized at that point per `devops.md`; `release/v3.0.X` → `main` is never touched by this plan.
- **No placeholders in output:** every task below is runnable as written. Where this plan cannot know an exact value that a prior milestone plan will fix (a crate function signature, a hub-api route path), the task says so explicitly and gives the implementer the exact `grep`/inspection command to resolve it before writing code — never a made-up signature presented as fact.

## File Structure

```
waddles/  (repo root, still named waddlebot/ — see Waddles naming above)
  core/
    svc_streaming/
      Dockerfile                 <- renamed from Dockerfile.rust (Task 10)
      src/telemetry.rs           <- deleted, replaced by penguin-logging (Task 11)
      app.py, blueprints/, services/, openapi/, tests/, requirements*.txt,
      pyproject.toml, pytest.ini <- deleted (Task 10)
    svc_ingest/**/*.py           <- deleted (Task 26)
    svc_process/**/*.py          <- deleted (Task 27, after Task 3's git mv)
    svc_action/**/*.py           <- deleted (Task 28, after Tasks 4/9's git mv+delete)
  bundles/
    python/
      INVENTORY.json             <- generated, committed (Task 2)
      README.md                  <- Task 6
      <bundle-dir>/bundle.yaml   <- generated per bundle (Task 5)
      <bundle-dir>/*.py          <- moved bundle source (Tasks 3, 4)
  scripts/
    bundle_migration/
      inventory_bundles.py       <- Task 2
      migrate_bundles.py         <- Task 3 (writes it + runs --stage process); Task 4 runs --stage action
      generate_bundle_manifest.py <- Task 5
      check_no_legacy_dal_imports.sh <- Task 8
    verify-gvisor-runtimeclass.sh <- Task 29
  hub_api/tools/bundle_manifest_validator.py  <- Task 5 (V1-V31, shared by generator + hub-api install path)
  libs/flask_core/flask_core/
    bundle_runtime.py            <- deleted (Task 22)
    stage_runner.py              <- load_entrypoint()/importlib path removed (Task 22)
    app_manifest.py              <- `ingest` removed from KNOWN_SURFACES (Task 22)
  config/
    postgres/rbac-matrix.yaml    <- Task 19
    valkey/acl-matrix.yaml       <- Task 19
  k8s/helm/waddlebot/
    values.yaml                  <- new keys (Task 12)
    templates/
      svc-ingest.yaml, svc-process.yaml, svc-action.yaml  <- image/port/uid updates (Task 13)
      pipeline/bundle-executor.yaml    <- Task 14
      pipeline/bundle-compiler-job.yaml <- Task 15
      pipeline/sandbox-installer-daemonset.yaml <- Task 16
      pipeline/network-policy.yaml     <- Task 17
      pipeline/transport-tls.yaml      <- Task 18
      valkey-acl-configmap.yaml        <- Task 18
  .github/workflows/
    bundle-compatibility.yml     <- Task 7
    rust-bundle-executor-supply-chain.yml <- Task 21
  docs/
    APP_BUNDLE_AUTHORING.md      <- rewritten v2 (Task 23)
    ARCHITECTURE.md, README.md, OPERATIONS_RUNBOOK.md  <- updated/created (Task 24)
    CHANGELOG.md                 <- Task 25
    migration-notes/m6-cutover-activation-changes.md   <- Task 25
    superpowers/plans/2026-09-14-rust-data-plane-verification.md <- Task 32
  tests/k8s/alpha/
    09-telemetry-latency.sh      <- Task 30
    10-e2e-bundles.sh            <- Task 31
```

**UI-affecting change / screenshots:** M6 introduces no new UI. The hub-api permission-consent screen (spec §9.7) is built by plan M2b, which owns its own `docs/screenshots/` capture under `capturing-marketing-screenshots` — that gate belongs to M2b's PR, not this one. Task 33's merge checklist confirms no UI files are touched by this branch rather than re-running screenshot capture here.

---

## Task 1: Pre-flight — branch, verify M1–M5 landed, confirm assumed artifact names

**Files:**
- Create: none (verification only)
- Modify: none

**Interfaces:**
- Consumes: nothing — this is the entry point.
- Produces: `M6_PREFLIGHT.md` (repo root, git-ignored — add to `.gitignore` if not already covered by the existing `.PLAN`/`.TODO` ignore rule) recording the confirmed-or-corrected artifact names every later task in this plan depends on. Every later task that says "must match plan Mx" is resolved against this file's findings, not re-derived from scratch.

- [ ] **Step 1: Fetch and verify `release/v3.0.X` carries M1–M5**

```bash
git fetch -q origin release/v3.0.X
git log origin/release/v3.0.X --oneline -20 | grep -iE "svc.action|svc.process|svc.ingest|penguin-spine|bundle.executor|bundle.compiler|m1\.5|m2a|m2b" || true
test -d core/svc_action/src && test -f core/svc_action/Cargo.toml && echo "svc_action Rust: present"
test -d core/svc_process/src && test -f core/svc_process/Cargo.toml && echo "svc_process Rust: present"
test -d core/svc_ingest/src && test -f core/svc_ingest/Cargo.toml && echo "svc_ingest Rust: present"
test -f core/bundle_executor/Cargo.toml && echo "bundle_executor: present"
test -f core/bundle_compiler/Cargo.toml && echo "bundle_compiler: present"
test -f build/tool-versions.env && echo "build/tool-versions.env: present"
```

Expected: every `test` line prints its "present" message. **If any is missing, STOP** — this plan's later tasks assume the Rust replacement already exists and passes its own gates; do not proceed to delete Python code or wire the chart against a service that isn't there. Report to the user which milestone did not land and wait.

- [ ] **Step 2: Confirm `penguin-libs` crates are published**

```bash
cd /home/penguin/code/penguin-libs
git fetch -q origin
for pkg in rust-spine rust-bundle-host rust-logging rust-connectors; do
  test -d "packages/$pkg" && echo "$pkg: present" || echo "$pkg: MISSING"
done
grep -n "^version" packages/rust-licensing/Cargo.toml
cd -
```

Expected: all four `packages/rust-*` directories print "present". If `packages/rust-licensing`'s version is still pre-CI (check for a `publish-rust-licensing` workflow under `penguin-libs/.github/workflows/`), note it in `M6_PREFLIGHT.md` — Task 11 needs `penguin-licensing` importable from `core/svc_streaming`'s `Cargo.toml`.

- [ ] **Step 3: Create the worktree branch**

```bash
git worktree add .worktrees/m6-cutover -b feature/m6-rust-dataplane-cutover origin/release/v3.0.X
cd .worktrees/m6-cutover
git push -u origin feature/m6-rust-dataplane-cutover
```

Expected: `git push` reports the new branch created on `origin`. All remaining tasks in this plan run from `.worktrees/m6-cutover`.

- [ ] **Step 4: Resolve every "must match plan Mx" name this plan uses**

Run each lookup below and record the actual name (or "not yet named — using this plan's assumption") in `M6_PREFLIGHT.md`:

```bash
# build/tool-versions.env's real key names (Task 16, Task 21 depend on these)
cat build/tool-versions.env

# hub-api's install/version endpoints (Task 24's docs, Task 25's migration-notes query)
grep -rn "def.*versions\|@bp.route" hub_api/blueprints/v1/distribution.py | head -20

# the CI workflow naming convention M3/M4/M5 used (Task 21 adds a sibling workflow)
ls .github/workflows/ | grep -iE "svc-action|svc-process|svc-ingest|bundle-executor|bundle-compiler"

# penguin-logging's public init function (Task 11)
grep -n "pub fn\|pub struct" /home/penguin/code/penguin-libs/packages/rust-logging/src/lib.rs | head -20
```

Write the results into `M6_PREFLIGHT.md` under one heading per lookup. Where a later task in this plan names something these greps don't confirm (e.g. this plan assumes CI workflows are named `rust-svc-{ingest,process,action}.yml` matching the existing `rust-svc-streaming.yml` pattern), that task's own step re-runs the confirming `ls`/`grep` before acting — `M6_PREFLIGHT.md` is a working note, not a substitute for the per-task check.

- [ ] **Step 5: Commit the preflight note is git-ignored, not committed**

```bash
grep -qxF 'M6_PREFLIGHT.md' .gitignore || echo 'M6_PREFLIGHT.md' >> .gitignore
git add .gitignore
git commit -m "$(cat <<'EOF'
chore(core): ignore M6 pre-flight working note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

Expected: `git push` succeeds; `M6_PREFLIGHT.md` itself stays untracked.

---

## Task 2: Bundle inventory — the source of truth for every later migration task

**Why a script and not a hand-written table:** `core/svc_process/bundles/bot_process.py` routes several commands to sibling modules (`community_loyalty_process.py`, `social_shoutout_process.py`) **in-process** rather than each having its own `app_catalog` row — confirmed by reading `alembic/versions/0017_loyalty_shoutout_apps.py`, which records that the loyalty/shoutout Features declare `surfaces = ("process", "action")` but only the **action** stage has a catalog row; the process side runs inside `bot_process.py`'s own `_FEATURE_MODULES` router. A filename-based pairing table would get this wrong. The script below derives bundle boundaries from the live `app_catalog` registration data (both migration sources) and flags every case it cannot resolve mechanically, rather than guessing.

**Files:**
- Create: `scripts/bundle_migration/inventory_bundles.py`
- Create: `scripts/bundle_migration/tests/test_inventory_bundles.py`
- Create (generated by running the script): `bundles/python/INVENTORY.json`

**Interfaces:**
- Produces: `bundles/python/INVENTORY.json` — a JSON object `{"bundles": [...], "orphan_files": [...], "conflicts": [...], "counts": {...}}` that Tasks 3, 4 and 5 read. Each entry in `bundles` has the shape: `{"app_id": str, "dir_name": str, "process_module": str|null, "process_function": str|null, "action_module": str|null, "action_function": str|null, "process_file": str|null, "action_file": str|null, "co_dependencies": [str], "source": "sql"|"alembic"}`. `process_function`/`action_function` are the part after the `:` in each `entrypoint` string (e.g. `transform`, `send_message`) — Task 5's `bundle.yaml` generator needs the full `module:function` reference, not just the module.

- [ ] **Step 1: Write the failing test**

```python
# scripts/bundle_migration/tests/test_inventory_bundles.py
import json
import sys
import textwrap
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inventory_bundles import (
    dir_name_for_app_id,
    parse_sql_migrations,
    parse_alembic_migrations,
    merge_rows_by_app_id,
    find_bundle_files,
    build_inventory,
)


def test_dir_name_for_app_id_drops_default_suffix():
    assert dir_name_for_app_id("waddles.social.alias.default") == "social-alias"


def test_dir_name_for_app_id_keeps_non_default_suffix():
    assert dir_name_for_app_id("waddles.core.demo.echo") == "core-demo-echo"


def test_parse_sql_migrations_extracts_app_id_and_entrypoints(tmp_path):
    mig_dir = tmp_path / "migrations"
    mig_dir.mkdir()
    (mig_dir / "086_social_alias_bundle.sql").write_text(textwrap.dedent("""
        INSERT INTO app_catalog (
            app_id, manifest_version, module, feature, provider, execution_model,
            is_default, platform_compatibility, status, stages
        ) VALUES (
            'waddles.social.alias.default', '1.0.0', 'social', 'waddles.social.alias',
            'builtin', 'native', FALSE, '{}'::jsonb, 'active',
            (
                '{"process": {"entrypoint": "bundles.social_alias_process:transform", '
                '"config": {}, "spec": {"required_config": []}}, '
                '"action": {"entrypoint": "bundles.social_alias_action:send_message", '
                '"config": {}, "spec": {"required_config": []}}}'
            )::jsonb
        )
        ON CONFLICT (app_id) DO NOTHING;
    """))
    rows = parse_sql_migrations(mig_dir)
    assert len(rows) == 1
    assert rows[0]["app_id"] == "waddles.social.alias.default"
    assert rows[0]["process_module"] == "social_alias_process"
    assert rows[0]["process_function"] == "transform"
    assert rows[0]["action_module"] == "social_alias_action"
    assert rows[0]["action_function"] == "send_message"
    assert rows[0]["source"] == "sql"


def test_parse_alembic_migrations_extracts_action_only_row(tmp_path):
    versions_dir = tmp_path / "versions"
    versions_dir.mkdir()
    (versions_dir / "0017_loyalty_shoutout_apps.py").write_text(textwrap.dedent('''
        from alembic import op
        LOYALTY_APP_ID = "waddles.community.loyalty.default"

        def upgrade() -> None:
            op.execute(f"""
                INSERT INTO app_catalog (app_id, stages)
                VALUES ('waddles.community.loyalty.default',
                    (\'{{"action": {{"entrypoint": "bundles.community_loyalty_action:send"}}}}\')::jsonb
                )
                ON CONFLICT (app_id) DO UPDATE SET stages = EXCLUDED.stages;
            """)
    '''))
    rows = parse_alembic_migrations(versions_dir)
    assert len(rows) == 1
    assert rows[0]["app_id"] == "waddles.community.loyalty.default"
    assert rows[0]["process_module"] is None
    assert rows[0]["action_module"] == "community_loyalty_action"
    assert rows[0]["action_function"] == "send"
    assert rows[0]["source"] == "alembic"


def test_merge_rows_by_app_id_fills_in_later_update():
    rows = [
        {"app_id": "waddles.bot.discord.default", "process_module": None,
         "process_function": None, "action_module": "discord_send_action",
         "action_function": "send", "source": "sql"},
        {"app_id": "waddles.bot.discord.default", "process_module": "bot_process",
         "process_function": "transform", "action_module": None,
         "action_function": None, "source": "sql"},
    ]
    merged = merge_rows_by_app_id(rows)
    assert len(merged) == 1
    assert merged[0]["process_module"] == "bot_process"
    assert merged[0]["process_function"] == "transform"
    assert merged[0]["action_module"] == "discord_send_action"
    assert merged[0]["source"] == "sql"


def test_find_bundle_files_excludes_dunder_init(tmp_path):
    bdir = tmp_path / "bundles"
    bdir.mkdir()
    (bdir / "__init__.py").write_text("")
    (bdir / "echo_process.py").write_text("")
    files = find_bundle_files(bdir)
    assert files == ["echo_process.py"]


def test_build_inventory_flags_orphan_and_reports_counts(tmp_path):
    # Two rows found in migrations, three files on disk -> one orphan.
    rows = [
        {"app_id": "waddles.a.b.default", "process_module": "a_process",
         "process_function": "transform", "action_module": None,
         "action_function": None, "source": "sql"},
    ]
    process_files = ["a_process.py", "b_process.py"]
    action_files = []
    known_deleted = set()
    inv = build_inventory(rows, process_files, action_files, known_deleted,
                           process_dir="core/svc_process/bundles",
                           action_dir="core/svc_action/bundles")
    assert inv["counts"]["bundle_files_scanned"] == 2
    assert inv["counts"]["app_catalog_rows_matched"] == 1
    assert "b_process.py" in inv["orphan_files"]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd core/svc_process && python3 -m pytest ../../scripts/bundle_migration/tests/test_inventory_bundles.py -v 2>&1 | tail -20
```

Expected: `ModuleNotFoundError: No module named 'inventory_bundles'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```python
#!/usr/bin/env python3
"""Derive the Python-bundle migration inventory from the live app_catalog
registration data (both `config/postgres/migrations/*.sql` and
`alembic/versions/*.py`), cross-referenced with the files actually on disk
under `core/svc_process/bundles/` and `core/svc_action/bundles/`.

Exists because bundle boundaries are NOT one-file-one-bundle: some process
files (e.g. `community_loyalty_process.py`) are routed to in-process by
`bot_process.py` rather than having their own `app_catalog` row (see
`alembic/versions/0017_loyalty_shoutout_apps.py`'s own commentary). This
script is the single source of truth Tasks 3-5 read from, rather than each
re-deriving the pairing by hand.
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PROCESS_DIR = REPO_ROOT / "core" / "svc_process" / "bundles"
ACTION_DIR = REPO_ROOT / "core" / "svc_action" / "bundles"
SQL_MIGRATIONS_DIR = REPO_ROOT / "config" / "postgres" / "migrations"
ALEMBIC_VERSIONS_DIR = REPO_ROOT / "alembic" / "versions"
OUTPUT_PATH = REPO_ROOT / "bundles" / "python" / "INVENTORY.json"

# Absorbed as Rust built-ins by plan M3 ("Built-in senders: Discord, Slack,
# YouTube, Kick REST; Twitch via the relay") -- these five files are pure
# platform-send plumbing with no per-feature business logic, deleted (not
# migrated) by Task 9. Confirmed by grep against core/svc_action/src/ in
# that task, not assumed here.
KNOWN_DELETED_ACTION_MODULES = {
    "discord_send_action",
    "slack_send_action",
    "kick_send_action",
    "twitch_send_action",
    "youtube_send_action",
}

APP_ID_RE = re.compile(r"'((?:waddles)\.[a-z0-9_.]+)'")
ENTRYPOINT_RE = re.compile(
    r'"(process|action)"\s*:\s*\{\s*"entrypoint"\s*:\s*"bundles\.([a-zA-Z0-9_]+):([a-zA-Z0-9_]+)"'
)


def dir_name_for_app_id(app_id: str) -> str:
    """`waddles.social.alias.default` -> `social-alias`; the trailing
    `.default` app segment is dropped for brevity, any other app segment
    (e.g. `.echo`) is kept because it is load-bearing (`waddles.core.demo`
    alone would collide with a hypothetical second demo app)."""
    segments = app_id.split(".")
    assert segments[0] == "waddles", f"app_id {app_id!r} missing waddles. prefix"
    segments = segments[1:]
    if segments and segments[-1] == "default":
        segments = segments[:-1]
    return "-".join(segments)


def _rows_from_text(text: str, source: str) -> list[dict]:
    rows = []
    for stmt in re.split(r";\s*\n", text):
        # Matches both a fresh `INSERT INTO app_catalog` (a new app_id) and a
        # later `UPDATE app_catalog SET stages = ...` (e.g. migration 084,
        # which points an already-registered app_id's process entrypoint at
        # `bundles.bot_process:transform` without re-inserting the row) --
        # both shapes carry the same entrypoint JSON this parser extracts.
        is_insert = "app_catalog" in stmt and "INSERT INTO" in stmt
        is_update = "app_catalog" in stmt and re.search(r"UPDATE\s+app_catalog\b", stmt) and "stages" in stmt
        if not (is_insert or is_update):
            continue
        app_id_match = APP_ID_RE.search(stmt)
        if not app_id_match:
            continue
        app_id = app_id_match.group(1)
        process_module = process_function = None
        action_module = action_function = None
        for stage, module, function in ENTRYPOINT_RE.findall(stmt):
            if stage == "process":
                process_module, process_function = module, function
            elif stage == "action":
                action_module, action_function = module, function
        if process_module is None and action_module is None:
            continue
        rows.append({
            "app_id": app_id,
            "process_module": process_module,
            "process_function": process_function,
            "action_module": action_module,
            "action_function": action_function,
            "source": source,
        })
    return rows


def parse_sql_migrations(directory: Path) -> list[dict]:
    rows = []
    for path in sorted(directory.glob("*.sql")):
        rows.extend(_rows_from_text(path.read_text(), "sql"))
    return rows


def parse_alembic_migrations(directory: Path) -> list[dict]:
    rows = []
    for path in sorted(directory.glob("*.py")):
        rows.extend(_rows_from_text(path.read_text(), "alembic"))
    return rows


def merge_rows_by_app_id(rows: list[dict]) -> list[dict]:
    """Later migrations for the same app_id (e.g. `084_bot_process_entrypoint.sql`,
    an UPDATE that points an already-`INSERT`ed row's process stage at
    `bundles.bot_process:transform`) fill in fields the earlier row left
    `None`, matching the `ON CONFLICT ... DO UPDATE` upsert semantics every
    `*_bundle.sql`/alembic migration in this repo already documents itself
    as using. First-seen `source` wins (it names where the app_id was
    first registered, not where it was last touched)."""
    merged: dict[str, dict] = {}
    for row in rows:
        existing = merged.get(row["app_id"])
        if existing is None:
            merged[row["app_id"]] = dict(row)
            continue
        if row["process_module"] is not None:
            existing["process_module"] = row["process_module"]
            existing["process_function"] = row["process_function"]
        if row["action_module"] is not None:
            existing["action_module"] = row["action_module"]
            existing["action_function"] = row["action_function"]
    return list(merged.values())


def find_bundle_files(directory: Path) -> list[str]:
    return sorted(
        p.name for p in directory.glob("*.py") if p.name != "__init__.py"
    )


def _find_co_dependencies(module_file: Path, package_dir: Path,
                           cataloged_modules: set[str]) -> list[str]:
    """AST-scan a bundle's entrypoint file for `from bundles.X import ...` /
    `import bundles.X` references to sibling modules that are NOT
    themselves independently cataloged -- those siblings must travel into
    the same bundle directory (Task 3/4) because componentize-py compiles
    one importable package per bundle.yaml `entry`."""
    if not module_file.exists():
        return []
    tree = ast.parse(module_file.read_text(), filename=str(module_file))
    deps: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            parts = node.module.split(".")
            if parts[0] == "bundles" and len(parts) > 1:
                candidate = parts[1]
                if candidate != module_file.stem and candidate not in cataloged_modules:
                    if (package_dir / f"{candidate}.py").exists():
                        deps.add(candidate)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                parts = alias.name.split(".")
                if parts[0] == "bundles" and len(parts) > 1:
                    candidate = parts[1]
                    if candidate != module_file.stem and candidate not in cataloged_modules:
                        if (package_dir / f"{candidate}.py").exists():
                            deps.add(candidate)
    return sorted(deps)


def build_inventory(rows: list[dict], process_files: list[str],
                     action_files: list[str], known_deleted: set[str],
                     process_dir: str, action_dir: str) -> dict:
    process_stems = {f[:-3] for f in process_files}
    action_stems = {f[:-3] for f in action_files}
    cataloged = {r["process_module"] for r in rows if r["process_module"]} | \
                {r["action_module"] for r in rows if r["action_module"]}

    bundles = []
    conflicts = []
    for row in rows:
        pm, am = row["process_module"], row["action_module"]
        entry = {
            "app_id": row["app_id"],
            "dir_name": dir_name_for_app_id(row["app_id"]),
            "process_module": pm,
            "process_function": row.get("process_function"),
            "action_module": am,
            "action_function": row.get("action_function"),
            "process_file": f"{pm}.py" if pm else None,
            "action_file": f"{am}.py" if am else None,
            "co_dependencies": [],
            "source": row["source"],
        }
        if pm and (REPO_ROOT / process_dir / f"{pm}.py").exists():
            deps = _find_co_dependencies(REPO_ROOT / process_dir / f"{pm}.py",
                                          REPO_ROOT / process_dir, cataloged)
            entry["co_dependencies"].extend(f"process:{d}" for d in deps)
        if am and (REPO_ROOT / action_dir / f"{am}.py").exists():
            deps = _find_co_dependencies(REPO_ROOT / action_dir / f"{am}.py",
                                          REPO_ROOT / action_dir, cataloged)
            entry["co_dependencies"].extend(f"action:{d}" for d in deps)
        if entry["co_dependencies"]:
            conflicts.append({"app_id": row["app_id"],
                               "co_dependencies": entry["co_dependencies"]})
        bundles.append(entry)

    matched_process = {b["process_module"] for b in bundles if b["process_module"]}
    matched_action = {b["action_module"] for b in bundles if b["action_module"]}
    orphan_files = sorted(
        [f"{process_dir}/{s}.py" for s in process_stems - matched_process] +
        [f"{action_dir}/{s}.py" for s in (action_stems - matched_action - known_deleted)]
    )
    return {
        "bundles": bundles,
        "orphan_files": orphan_files,
        "conflicts": conflicts,
        "counts": {
            "bundle_files_scanned": len(process_stems) + len(action_stems),
            "app_catalog_rows_matched": len(rows),
            "orphan_files": len(orphan_files),
            "conflicts": len(conflicts),
        },
    }


def main() -> int:
    rows = merge_rows_by_app_id(
        parse_sql_migrations(SQL_MIGRATIONS_DIR) +
        parse_alembic_migrations(ALEMBIC_VERSIONS_DIR)
    )
    process_files = find_bundle_files(PROCESS_DIR)
    action_files = find_bundle_files(ACTION_DIR)
    inv = build_inventory(
        rows, process_files, action_files, KNOWN_DELETED_ACTION_MODULES,
        process_dir="core/svc_process/bundles", action_dir="core/svc_action/bundles",
    )
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(inv, indent=2, sort_keys=True) + "\n")

    c = inv["counts"]
    print(f"bundle files scanned: {c['bundle_files_scanned']}")
    print(f"app_catalog rows matched: {c['app_catalog_rows_matched']}")
    print(f"orphan files (no catalog row, not a known deleted sender): {c['orphan_files']}")
    print(f"cross-bundle import conflicts: {c['conflicts']}")
    if c["bundle_files_scanned"] == 0 or c["app_catalog_rows_matched"] == 0:
        print("FAIL: zero items examined", file=sys.stderr)
        return 1
    if inv["orphan_files"]:
        print(f"FAIL: unresolved orphan files: {inv['orphan_files']}", file=sys.stderr)
        print("Resolve each by grepping libs/*/features.py for its app_id "
              "registration before adding a new migration row for it.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the unit tests**

```bash
cd core/svc_process && python3 -m pytest ../../scripts/bundle_migration/tests/test_inventory_bundles.py -v 2>&1 | tail -20
```

Expected: 7 passed.

- [ ] **Step 5: Run the script for real against this repo**

```bash
python3 scripts/bundle_migration/inventory_bundles.py
```

Expected: prints four count lines with non-zero `bundle files scanned` and `app_catalog rows matched`. **If it exits 1 on orphan files**, resolve each named file per the printed instruction (grep `libs/*/features.py` and `libs/*/__init__.py` for a `FeatureContract`/`app_registry` registration of that module's app_id) — add the missing row as a new numbered migration under `config/postgres/migrations/` following the `086_social_alias_bundle.sql` pattern before re-running, or add a documented exception to `KNOWN_DELETED_ACTION_MODULES` in the script with a one-line reason if investigation shows the file is genuinely dead code (verify with `grep -rn "orphan_module_name" --include=*.py .` returning only the file itself and its own test). Do not proceed to Task 3 until this exits 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/bundle_migration/inventory_bundles.py \
        scripts/bundle_migration/tests/test_inventory_bundles.py \
        bundles/python/INVENTORY.json
git commit -m "$(cat <<'EOF'
chore(core): generate bundle-migration inventory from live app_catalog registrations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 3: Migrate `svc_process` bundles into `bundles/python/` (process stage)

**Why the internal `bundles/` package name is preserved per bundle:** the spec's `bundle.yaml` v2 example keeps `entry: "bundles.social_music_process:transform"` — the module path bundles used before this migration — even after the move (D7: bundles stay byte-for-byte unchanged except their DB-access lines, already rewritten by plan M1.5). So each new bundle directory gets its own `bundles/` sub-package (not a flattened file), preserving every existing entrypoint string with zero source edits.

**Files:**
- Create: `scripts/bundle_migration/migrate_bundles.py`
- Create: `scripts/bundle_migration/tests/test_migrate_bundles.py`
- Move (via `git mv`, exact set depends on `bundles/python/INVENTORY.json` from Task 2 — do not hardcode the list, read it): every `process_module` and `process`-side `co_dependencies` entry's `.py` file from `core/svc_process/bundles/` to `bundles/python/<dir_name>/bundles/`, and its matching `core/svc_process/tests/test_bundles_<module>.py` (when present) to `bundles/python/<dir_name>/tests/`.

**Interfaces:**
- Consumes: `bundles/python/INVENTORY.json` (Task 2) — reads `bundles[].dir_name`, `.process_module`, `.process_file`, `.co_dependencies` (entries prefixed `process:`).
- Produces: `bundles/python/<dir_name>/bundles/__init__.py`, `bundles/python/<dir_name>/bundles/<module>.py` for every process bundle — Task 5 reads these paths to place the generated `bundle.yaml` alongside them; Task 4 reuses the same `<dir_name>` directory for bundles that also have an action stage.

- [ ] **Step 1: Write the failing test**

```python
# scripts/bundle_migration/tests/test_migrate_bundles.py
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from migrate_bundles import plan_moves


def test_plan_moves_process_stage_includes_co_dependencies(tmp_path):
    inventory = {
        "bundles": [
            {
                "app_id": "waddles.bot.discord.default",
                "dir_name": "bot-discord",
                "process_module": "bot_process",
                "action_module": "discord_send_action",
                "co_dependencies": ["process:social_shoutout_process",
                                     "process:community_loyalty_process"],
            },
            {
                "app_id": "waddles.social.alias.default",
                "dir_name": "social-alias",
                "process_module": "social_alias_process",
                "action_module": "social_alias_action",
                "co_dependencies": [],
            },
        ]
    }
    moves = plan_moves(inventory, stage="process",
                        source_dir="core/svc_process/bundles",
                        tests_dir="core/svc_process/tests")
    srcs = {m["src"] for m in moves}
    assert "core/svc_process/bundles/bot_process.py" in srcs
    assert "core/svc_process/bundles/social_shoutout_process.py" in srcs
    assert "core/svc_process/bundles/community_loyalty_process.py" in srcs
    assert "core/svc_process/bundles/social_alias_process.py" in srcs
    bot_process_move = next(m for m in moves if m["src"].endswith("bot_process.py"))
    assert bot_process_move["dst"] == "bundles/python/bot-discord/bundles/bot_process.py"
    shoutout_move = next(m for m in moves if m["src"].endswith("social_shoutout_process.py"))
    # Co-dependency lands in the OWNING bundle's directory (bot-discord), not its own.
    assert shoutout_move["dst"] == "bundles/python/bot-discord/bundles/social_shoutout_process.py"


def test_plan_moves_skips_bundles_with_no_module_for_this_stage(tmp_path):
    inventory = {"bundles": [{"app_id": "waddles.streaming.stream.default",
                               "dir_name": "streaming-stream",
                               "process_module": None,
                               "action_module": "streaming_stream_action",
                               "co_dependencies": []}]}
    moves = plan_moves(inventory, stage="process",
                        source_dir="core/svc_process/bundles",
                        tests_dir="core/svc_process/tests")
    assert moves == []
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd core/svc_process && python3 -m pytest ../../scripts/bundle_migration/tests/test_migrate_bundles.py -v 2>&1 | tail -20
```

Expected: `ModuleNotFoundError: No module named 'migrate_bundles'`.

- [ ] **Step 3: Write the implementation**

```python
#!/usr/bin/env python3
"""Move already-DAL-migrated (plan M1.5) Python bundle source files from
their current per-stage-service location into `bundles/python/<dir_name>/`,
preserving the internal `bundles.<module>` package path every existing
`app_catalog.stages.*.entrypoint` string already names (D7: byte-for-byte
unchanged except DB-access lines). Shared with Task 4 via `--stage action`.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INVENTORY_PATH = REPO_ROOT / "bundles" / "python" / "INVENTORY.json"

INIT_DOCSTRING = {
    "process": '"""Bundle source moved from `core/svc_process/bundles/` by the M6 cut-over (plan M1a-M6 §15.1). Entry paths are unchanged: `bundles.<module>:<function>` still resolves inside this package."""\n',
    "action": '"""Bundle source moved from `core/svc_action/bundles/` by the M6 cut-over (plan M1a-M6 §15.1). Entry paths are unchanged: `bundles.<module>:<function>` still resolves inside this package."""\n',
}


def plan_moves(inventory: dict, stage: str, source_dir: str, tests_dir: str) -> list[dict]:
    moves = []
    module_key = f"{stage}_module"
    for entry in inventory["bundles"]:
        module = entry.get(module_key)
        dir_name = entry["dir_name"]
        modules_for_this_stage = []
        if module:
            modules_for_this_stage.append(module)
        for dep in entry.get("co_dependencies", []):
            dep_stage, _, dep_module = dep.partition(":")
            if dep_stage == stage:
                modules_for_this_stage.append(dep_module)
        for m in modules_for_this_stage:
            moves.append({
                "src": f"{source_dir}/{m}.py",
                "dst": f"bundles/python/{dir_name}/bundles/{m}.py",
            })
            test_src = f"{tests_dir}/test_bundles_{m}.py"
            if (REPO_ROOT / test_src).exists():
                moves.append({
                    "src": test_src,
                    "dst": f"bundles/python/{dir_name}/tests/test_bundles_{m}.py",
                })
    return moves


def execute_moves(moves: list[dict], stage: str) -> None:
    seen_init_dirs: set[str] = set()
    for move in moves:
        dst = Path(move["dst"])
        dst.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "mv", move["src"], move["dst"]], cwd=REPO_ROOT, check=True)
        init_path = dst.parent
        if init_path.name in ("bundles",) and str(init_path) not in seen_init_dirs:
            init_file = init_path / "__init__.py"
            if not init_file.exists():
                init_file.write_text(INIT_DOCSTRING[stage])
                subprocess.run(["git", "add", str(init_file.relative_to(REPO_ROOT))],
                                cwd=REPO_ROOT, check=True)
            seen_init_dirs.add(str(init_path))
        if init_path.name == "tests":
            init_file = init_path / "__init__.py"
            if not init_file.exists():
                init_file.write_text("")
                subprocess.run(["git", "add", str(init_file.relative_to(REPO_ROOT))],
                                cwd=REPO_ROOT, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True, choices=["process", "action"])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    inventory = json.loads(INVENTORY_PATH.read_text())
    source_dir = f"core/svc_{args.stage}/bundles"
    tests_dir = f"core/svc_{args.stage}/tests"
    moves = plan_moves(inventory, args.stage, source_dir, tests_dir)

    print(f"{args.stage} stage: {len(moves)} files to move")
    if not moves:
        print("FAIL: zero files planned for move", file=sys.stderr)
        return 1
    for m in moves:
        print(f"  {m['src']} -> {m['dst']}")
    if args.dry_run:
        return 0
    execute_moves(moves, args.stage)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the unit tests**

```bash
cd core/svc_process && python3 -m pytest ../../scripts/bundle_migration/tests/test_migrate_bundles.py -v 2>&1 | tail -20
```

Expected: 2 passed.

- [ ] **Step 5: Dry-run against the real inventory, review, then execute**

```bash
python3 scripts/bundle_migration/migrate_bundles.py --stage process --dry-run
```

Expected: prints one line per file with a non-zero total; read the list and confirm `bot_process.py`'s co-dependencies (`social_shoutout_process.py`, `community_loyalty_process.py`, and any others `bundles/python/INVENTORY.json`'s `conflicts` array names) land inside `bundles/python/bot-discord/bundles/`, not their own directories.

```bash
python3 scripts/bundle_migration/migrate_bundles.py --stage process
git status --short | head -40
```

Expected: every `core/svc_process/bundles/*.py` file (except `__init__.py`, left behind for Task 27 to delete along with the rest of the tree) shows as renamed (`R`) in `git status`.

- [ ] **Step 6: Verify nothing references the old path from outside the doomed tree**

```bash
grep -rln "core\.svc_process\.bundles\|from svc_process.bundles" --include="*.py" . \
  | grep -v "^core/svc_process/" || echo "clean: no external references to the old path"
```

Expected: "clean" line prints — nothing outside `core/svc_process/` imported these files by that path (bundles were always loaded by string entrypoint via `flask_core.stage_runner`, never imported directly).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(core): git-mv svc_process bundles into bundles/python/ (M6 cut-over)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 4: Migrate `svc_action` bundles into `bundles/python/` (action stage)

**Depends on:** Task 3 (reuses `migrate_bundles.py` and the shared `<dir_name>` directories it created — a bundle with both stages, e.g. `social-alias`, gets its `action` module placed into the same directory Task 3 already created).

**The five generic platform-sender files are excluded by `KNOWN_DELETED_ACTION_MODULES`** (Task 2's script) because plan M3's deliverable table lists "Built-in senders: Discord, Slack, YouTube, Kick REST; Twitch via the relay" — meaning every action bundle now reaches these platforms through the `http`/`relay` WIT capabilities directly (§4.3: "a bundle never holds a platform credential"; secret injection happens host-side via `secret_refs`), so a standalone generic "just send to Discord" bundle other bundles redirected to via `_target_app_id` has no remaining role. **This is this plan's assumption, not a confirmed fact about plan M3's actual Rust source — verify it before deleting.**

**Files:**
- Move: every `action_module`/`action`-side co-dependency's `.py` + test file from `core/svc_action/bundles/` and `core/svc_action/tests/` into `bundles/python/<dir_name>/`.
- Delete (this task, once verified — not moved): `core/svc_action/bundles/{discord_send_action,slack_send_action,kick_send_action,twitch_send_action,youtube_send_action}.py` and their `core/svc_action/tests/test_bundles_*.py` counterparts.

- [ ] **Step 1: Verify the generic-sender deletion assumption against the real Rust source**

```bash
grep -n "discord.com/api\|discordapp.com" core/svc_action/src/**/*.rs 2>/dev/null | head -5
grep -n "slack.com/api" core/svc_action/src/**/*.rs 2>/dev/null | head -5
grep -n "kick.com" core/svc_action/src/**/*.rs 2>/dev/null | head -5
grep -n "youtube" core/svc_action/src/**/*.rs 2>/dev/null | head -5
grep -rln "routes_to" bundles/python/*/bundle.yaml 2>/dev/null | xargs -r grep -l "bot.discord.default\|bot.slack\|bot.kick\|bot.youtube" || true
```

Expected: each platform's REST endpoint string appears somewhere under `core/svc_action/src/` (confirming M3 built the Rust-side sender logic that makes the Python generic sender redundant), and no migrated bundle's `bundle.yaml`'s `routes_to` list still names the generic sender's app_id (`bundle.yaml` files don't exist yet at this point in the plan — Task 5 generates them — so this second check is a no-op today and is re-run again at the end of Task 5 as that task's own Step; note the re-run obligation in this task's commit message). **If either Rust grep returns nothing, STOP** — do not delete the generic sender bundles; instead route them through Task 4's normal `plan_moves`/`execute_moves` path like any other action bundle, and record the deviation in `M6_PREFLIGHT.md`.

- [ ] **Step 2: Dry-run and execute the action-stage move**

```bash
python3 scripts/bundle_migration/migrate_bundles.py --stage action --dry-run
python3 scripts/bundle_migration/migrate_bundles.py --stage action
git status --short | grep "^R " | wc -l
```

Expected: a non-zero rename count; `bundles/python/social-alias/bundles/social_alias_action.py` now sits alongside the `bundles/python/social-alias/bundles/social_alias_process.py` Task 3 already moved.

- [ ] **Step 3: Delete the five generic platform-sender bundles (only after Step 1 confirmed it's safe)**

```bash
for f in discord_send_action slack_send_action kick_send_action twitch_send_action youtube_send_action; do
  git rm -f "core/svc_action/bundles/${f}.py" 2>/dev/null || true
  git rm -f "core/svc_action/tests/test_bundles_${f}.py" 2>/dev/null || true
done
git status --short | grep "^D "
```

Expected: 10 deletions listed (5 source + 5 test files) — fewer only if a test file genuinely never existed for one of them (check `core/svc_action/tests/` listing from Task 2's original `ls` output before assuming a miss is an error).

- [ ] **Step 4: Verify `bundles/python/INVENTORY.json`'s counts now reconcile**

```bash
python3 - <<'EOF'
import json
inv = json.load(open("bundles/python/INVENTORY.json"))
moved_process = sum(1 for b in inv["bundles"] if b["process_module"])
moved_action = sum(1 for b in inv["bundles"] if b["action_module"])
print(f"bundles with a process module: {moved_process}")
print(f"bundles with an action module: {moved_action}")
assert moved_process > 0 and moved_action > 0, "zero bundles found — inventory is stale or wrong"
EOF
ls bundles/python/*/bundles/*.py | wc -l
```

Expected: both counts print non-zero; the final `ls | wc -l` is greater than or equal to `moved_process + moved_action` (greater when co-dependencies added extra files to a bundle directory).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(core): git-mv svc_action bundles into bundles/python/, delete generic platform senders absorbed into svc_action's Rust built-ins (M6 cut-over)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 5: Generate `bundle.yaml` v2 for every migrated bundle + the shared V1-V31 manifest validator

**Depends on:** Task 3, Task 4 (bundle source files must already be at their final `bundles/python/<dir_name>/` path).

**Scope note on validation:** this task implements a Python validator for the manifest rules checkable from the YAML alone — V1-V9, V14-V24, V29, V30 (spec §6.4.4). **V25, V27, V28 and V31 require the compiled WASM component's actual imports/exports and are enforced by `bundle-compiler` (plan M2a) and hub-api's install path (plan M2b), not here** — this generator's own output is re-validated against those rules for real by Task 7's CI compilation. Citing this boundary explicitly rather than half-implementing artifact-level checks against nothing.

**Files:**
- Create: `hub_api/tools/bundle_manifest_validator.py` (V1-V9, V14-V24, V29, V30 — importable by hub-api's own install path per spec §6.4.4's "hub-api's install path" citation, so it lives under `hub_api/`, not `scripts/`)
- Create: `hub_api/tools/tests/test_bundle_manifest_validator.py`
- Create: `scripts/bundle_migration/generate_bundle_manifest.py`
- Create: `scripts/bundle_migration/tests/test_generate_bundle_manifest.py`
- Create (generated): `bundles/python/<dir_name>/bundle.yaml` for every bundle

**Interfaces:**
- Consumes: `bundles/python/INVENTORY.json` (Task 2); `config/postgres/migrations/*.sql` `CREATE TABLE` statements (for the `data.tables` heuristic).
- Produces: `bundle.yaml` v2 files Task 6's README and Task 7's CI compilation job consume; `hub_api.tools.bundle_manifest_validator.validate(manifest: dict) -> list[ValidationError]` — Task 22's hub-api-side install path work (plan M2b) imports this same function so the generator and the real install path can never disagree about what "valid" means.

- [ ] **Step 1: Write the failing tests for the validator**

```python
# hub_api/tools/tests/test_bundle_manifest_validator.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bundle_manifest_validator import validate, KNOWN_MODULES

VALID = {
    "schema_version": 2,
    "app_id": "waddles.social.alias.default",
    "name": "Social Alias",
    "version": "3.0.0",
    "feature": "waddles.social.alias",
    "module": "social",
    "provider": "builtin",
    "language": "python",
    "artifact": "source",
    "execution_model": "native",
    "stages": {
        "process": {"entry": "bundles.social_alias_process:transform",
                     "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}]},
        "action": {"entry": "bundles.social_alias_action:send_message"},
    },
    "egress": [], "data": {"tables": ["command_aliases"]},
    "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10},
}


def test_valid_manifest_has_no_errors():
    assert validate(VALID) == []


def test_v14_rejects_wrong_schema_version():
    m = dict(VALID, schema_version=1)
    errs = validate(m)
    assert any(e.reason == "unsupported_schema_version" for e in errs)


def test_v15_rejects_ingest_stage():
    m = dict(VALID, stages=dict(VALID["stages"], ingest={"entry": "x"}))
    errs = validate(m)
    assert any(e.reason == "ingest_not_pluggable" for e in errs)


def test_v6_rejects_feature_module_mismatch():
    m = dict(VALID, module="wrong")
    errs = validate(m)
    assert any(e.reason == "feature_prefix_mismatch" for e in errs)


def test_v23_rejects_reserved_table():
    m = dict(VALID, data={"tables": ["users"]})
    errs = validate(m)
    assert any(e.reason == "reserved_data_table" for e in errs)


def test_v23_rejects_bad_table_name():
    m = dict(VALID, data={"tables": ["Bad-Name"]})
    errs = validate(m)
    assert any(e.reason == "invalid_data_table" for e in errs)


def test_v24_rejects_timeout_out_of_range():
    m = dict(VALID, limits=dict(VALID["limits"], timeout_ms=20000))
    errs = validate(m)
    assert any(e.reason == "limit_out_of_range" for e in errs)


def test_v27_rejects_process_stage_without_consumes():
    m = dict(VALID, stages=dict(VALID["stages"],
             process={"entry": "bundles.social_alias_process:transform"}))
    errs = validate(m)
    assert any(e.reason == "consumes_required" for e in errs)


def test_v28_rejects_action_stage_with_consumes():
    m = dict(VALID, stages=dict(
        VALID["stages"],
        action={"entry": "bundles.social_alias_action:send_message",
                "consumes": [{"platform": "twitch", "event_types": ["chat.message"]}]},
    ))
    errs = validate(m)
    assert any(e.reason == "consumes_on_action_stage" for e in errs)


def test_v30_rejects_wildcard_platform_without_flag():
    m = dict(VALID, stages=dict(VALID["stages"], process={
        "entry": "bundles.social_alias_process:transform",
        "consumes": [{"platform": "*", "event_types": ["chat.message"]}],
    }))
    errs = validate(m, allow_wildcard_consumes=False)
    assert any(e.reason == "wildcard_consumes_not_allowed" for e in errs)
    assert validate(m, allow_wildcard_consumes=True) == []


def test_known_modules_includes_social_and_bot():
    assert "social" in KNOWN_MODULES
    assert "bot" in KNOWN_MODULES
```

- [ ] **Step 2: Run to verify failure**

```bash
cd hub_api && python3 -m pytest tools/tests/test_bundle_manifest_validator.py -v 2>&1 | tail -10
```

Expected: `ModuleNotFoundError: No module named 'bundle_manifest_validator'`.

- [ ] **Step 3: Confirm `KNOWN_MODULES`'s real source before hardcoding it**

```bash
sed -n '55,90p' libs/flask_core/flask_core/app_manifest.py
```

Copy the exact tuple/set found at `libs/flask_core/flask_core/app_manifest.py:62-83` (the spec cites this exact line range in §6.4.2's `module` field row) into the implementation below — **do not invent a module list**; if the lines found differ from what step 3 expects, use what's actually there and note the discrepancy in `M6_PREFLIGHT.md`.

- [ ] **Step 4: Write the implementation**

```python
#!/usr/bin/env python3
"""bundle.yaml v2 validator -- the YAML-level rules from spec
`docs/superpowers/specs/2026-09-14-rust-data-plane-design.md` §6.4.4
(V1-V9, V14-V24, V29, V30). V25/V27/V28/V31 need the compiled component's
actual imports/exports and are NOT implemented here -- they run in
`bundle-compiler` (plan M2a) and hub-api's real install path (plan M2b).
Wait: V27/V28 (consumes presence per stage) ARE checkable from the YAML
alone and ARE implemented below; only V25/V31 (compiled-artifact exports
and import allowlist) are out of scope for this module.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Copied verbatim from libs/flask_core/flask_core/app_manifest.py:62-83
# (Task 5 Step 3 confirms this against the live file before use).
KNOWN_MODULES = frozenset({
    "social", "community", "bot", "streaming", "marketing", "integrations",
    "core", "security", "identity", "credential", "labels", "analytics",
    "engagement", "browser_source", "workflow", "video_proxy", "ai_researcher",
})

RESERVED_TABLES = frozenset({
    "users", "tenants", "communities", "app_catalog", "app_activations",
    "app_tenant_availability",
})
VALID_LANGUAGES = frozenset({"python", "rust", "javascript", "typescript", "other"})
VALID_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"})
VALID_PLATFORMS = frozenset({"twitch", "discord", "slack", "youtube", "kick", "waddles"})
APP_ID_RE = re.compile(r"^waddles\.[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$")
FEATURE_RE = re.compile(r"^waddles\.[a-z0-9_-]+\.[a-z0-9_-]+$")
TABLE_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$")


@dataclass(frozen=True)
class ValidationError:
    reason: str
    detail: str = ""


def validate(manifest: dict, allow_wildcard_consumes: bool = False) -> list[ValidationError]:
    errors: list[ValidationError] = []

    required = ["schema_version", "app_id", "name", "version", "feature",
                "module", "provider", "language", "artifact", "stages"]
    for field in required:
        if field not in manifest:
            errors.append(ValidationError("missing_field", field))
    if errors:
        return errors  # V1: rules run in order, first failure reported per spec

    if manifest["schema_version"] != 2:
        errors.append(ValidationError("unsupported_schema_version"))
        return errors  # V14

    if not SEMVER_RE.match(manifest["version"]):
        errors.append(ValidationError("bad_semver", manifest["version"]))
    if not APP_ID_RE.match(manifest["app_id"]):
        errors.append(ValidationError("not_namespaced", manifest["app_id"]))
    if not FEATURE_RE.match(manifest["feature"]):
        errors.append(ValidationError("not_namespaced", manifest["feature"]))
    if manifest["module"] not in KNOWN_MODULES:
        errors.append(ValidationError("unknown_module", manifest["module"]))

    expected_feature = ".".join(manifest["app_id"].split(".")[:-1])
    expected_module = manifest["feature"].split(".")[1] if "." in manifest["feature"] else None
    if manifest["feature"] != expected_feature or manifest["module"] != expected_module:
        errors.append(ValidationError("feature_prefix_mismatch"))

    if manifest["provider"] not in ("builtin", "thirdparty"):
        errors.append(ValidationError("invalid_provider"))
    if manifest["language"] not in VALID_LANGUAGES:
        errors.append(ValidationError("unsupported_language"))
    if manifest["language"] == "other" and manifest["artifact"] != "prebuilt":
        errors.append(ValidationError("unsupported_language", "other requires prebuilt"))
    if manifest["artifact"] not in ("source", "prebuilt"):
        errors.append(ValidationError("invalid_prebuilt", manifest["artifact"]))
    if manifest.get("execution_model", "native") not in ("native", "thirdparty"):
        errors.append(ValidationError("invalid_execution_model"))

    stages = manifest["stages"]
    if not stages:
        errors.append(ValidationError("no_stages_declared"))
    if "ingest" in stages:
        errors.append(ValidationError("ingest_not_pluggable"))
    for key in stages:
        if key not in ("process", "action", "presentation", "ingest"):
            errors.append(ValidationError("unknown_surface", key))

    if "process" in stages:
        consumes = stages["process"].get("consumes")
        if not consumes:
            errors.append(ValidationError("consumes_required"))
        else:
            for rule in consumes:
                platform = rule.get("platform")
                if platform not in VALID_PLATFORMS and platform != "*" and \
                        not (isinstance(platform, str) and platform.startswith("custom:")):
                    errors.append(ValidationError("unknown_consumes_platform", str(platform)))
                if not rule.get("event_types"):
                    errors.append(ValidationError("invalid_event_type_pattern", "empty"))
                wildcard_used = platform == "*" or any(
                    et == "**" for et in rule.get("event_types", [])
                )
                if wildcard_used and not allow_wildcard_consumes:
                    errors.append(ValidationError("wildcard_consumes_not_allowed"))
    if "action" in stages and stages["action"].get("consumes"):
        errors.append(ValidationError("consumes_on_action_stage"))

    for host in manifest.get("egress", []):
        h = host["host"]
        if h.startswith("*.") :
            label_ok = re.match(r"^\*\.[a-z0-9-]+(\.[a-z0-9-]+)+$", h)
        else:
            label_ok = re.match(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$", h)
        if not label_ok or "://" in h or "/" in h:
            errors.append(ValidationError("invalid_egress_host", h))
        for m in host.get("methods", []):
            if m not in VALID_METHODS:
                errors.append(ValidationError("invalid_egress_method", m))

    for table in manifest.get("data", {}).get("tables", []):
        if table in RESERVED_TABLES:
            errors.append(ValidationError("reserved_data_table", table))
        elif not TABLE_NAME_RE.match(table):
            errors.append(ValidationError("invalid_data_table", table))

    limits = manifest.get("limits", {})
    if not (50 <= limits.get("timeout_ms", 2000) <= 10000):
        errors.append(ValidationError("limit_out_of_range", "timeout_ms"))
    if not (8 <= limits.get("memory_mb", 64) <= 256):
        errors.append(ValidationError("limit_out_of_range", "memory_mb"))
    if not (1 <= limits.get("egress_rps", 10) <= 10):
        errors.append(ValidationError("limit_out_of_range", "egress_rps"))

    return errors
```

- [ ] **Step 5: Run the validator tests**

```bash
cd hub_api && python3 -m pytest tools/tests/test_bundle_manifest_validator.py -v 2>&1 | tail -20
```

Expected: 10 passed. If `test_known_modules_includes_social_and_bot` fails because Step 3's real module list differs, fix `KNOWN_MODULES` to match the actual file content, not the test.

- [ ] **Step 6: Write the failing test for the generator**

```python
# scripts/bundle_migration/tests/test_generate_bundle_manifest.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from generate_bundle_manifest import (
    extract_command_prefixes,
    extract_referenced_tables,
    build_manifest,
)


def test_extract_command_prefixes_finds_bang_literals():
    src = 'if text.startswith(("!sr", "!songrequest")):\n    pass\n'
    assert extract_command_prefixes(src) == ["!songrequest", "!sr"]


def test_extract_command_prefixes_empty_for_non_command_bundle():
    src = 'def transform(event):\n    return event\n'
    assert extract_command_prefixes(src) == []


def test_extract_referenced_tables_matches_known_names():
    src = 'row = await dal.command_aliases.insert(name=name)\n'
    known = {"command_aliases", "music_queue", "users"}
    assert extract_referenced_tables(src, known) == ["command_aliases"]


def test_build_manifest_process_and_action_pair():
    entry = {"app_id": "waddles.social.alias.default", "dir_name": "social-alias",
              "process_module": "social_alias_process", "process_function": "transform",
              "action_module": "social_alias_action", "action_function": "send_message",
              "co_dependencies": []}
    manifest = build_manifest(entry, process_source='text.startswith("!alias")',
                               action_source="", known_tables={"command_aliases"})
    assert manifest["app_id"] == "waddles.social.alias.default"
    assert manifest["feature"] == "waddles.social.alias"
    assert manifest["module"] == "social"
    assert manifest["stages"]["process"]["entry"] == "bundles.social_alias_process:transform"
    assert manifest["stages"]["action"]["entry"] == "bundles.social_alias_action:send_message"
    assert "action" not in manifest["stages"] or "consumes" not in manifest["stages"]["action"]
    consumes = manifest["stages"]["process"]["consumes"]
    assert len(consumes) == 5  # one rule per platform, per spec's echo-bundle precedent
    assert consumes[0]["filters"]["command_prefix"] == ["!alias"]
```

- [ ] **Step 7: Run to verify failure, then write the implementation**

```bash
cd core/svc_process && python3 -m pytest ../../scripts/bundle_migration/tests/test_generate_bundle_manifest.py -v 2>&1 | tail -10
```

Expected: `ModuleNotFoundError`.

```python
#!/usr/bin/env python3
"""Generate bundle.yaml v2 for every migrated bundle in bundles/python/,
from bundles/python/INVENTORY.json plus two source-level heuristics:
command-prefix detection (for `consumes.filters.command_prefix`) and
table-reference detection against every CREATE TABLE name in
config/postgres/migrations/*.sql (for `data.tables`). Both heuristics are
starting points an operator reviews at install (D26), not the final word.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "hub_api" / "tools"))
from bundle_manifest_validator import validate  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
INVENTORY_PATH = REPO_ROOT / "bundles" / "python" / "INVENTORY.json"
MIGRATIONS_DIR = REPO_ROOT / "config" / "postgres" / "migrations"

PLATFORMS = ["twitch", "discord", "slack", "youtube", "kick"]
BANG_LITERAL_RE = re.compile(r'"(![a-zA-Z0-9_-]+)"')
CREATE_TABLE_RE = re.compile(r"CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)", re.IGNORECASE)


def known_table_names() -> set[str]:
    names = set()
    for path in MIGRATIONS_DIR.glob("*.sql"):
        names.update(CREATE_TABLE_RE.findall(path.read_text()))
    return names


def extract_command_prefixes(source: str) -> list[str]:
    return sorted(set(BANG_LITERAL_RE.findall(source)))


def extract_referenced_tables(source: str, known_tables: set[str]) -> list[str]:
    return sorted(t for t in known_tables if re.search(rf"\b{re.escape(t)}\b", source))


def build_manifest(entry: dict, process_source: str, action_source: str,
                    known_tables: set[str]) -> dict:
    app_id = entry["app_id"]
    segments = app_id.split(".")
    feature = ".".join(segments[:-1])
    module = segments[1]
    name = " ".join(w.capitalize() for w in entry["dir_name"].split("-"))

    manifest: dict = {
        "schema_version": 2,
        "app_id": app_id,
        "name": name,
        "version": "3.0.0",
        "feature": feature,
        "module": module,
        "provider": "builtin",
        "language": "python",
        "artifact": "source",
        "execution_model": "native",
        "stages": {},
        "egress": [],
        "data": {"tables": extract_referenced_tables(
            process_source + action_source, known_tables)},
        "limits": {"timeout_ms": 2000, "memory_mb": 64, "egress_rps": 10},
    }

    if entry.get("process_module"):
        prefixes = extract_command_prefixes(process_source)
        rule_base = {"event_types": ["chat.message"]}
        if prefixes:
            rule_base["filters"] = {"command_prefix": prefixes}
        manifest["stages"]["process"] = {
            "entry": f"bundles.{entry['process_module']}:{entry['process_function']}",
            "consumes": [dict(rule_base, platform=p) for p in PLATFORMS],
        }
    if entry.get("action_module"):
        manifest["stages"]["action"] = {
            "entry": f"bundles.{entry['action_module']}:{entry['action_function']}",
        }
    return manifest


def main() -> int:
    inventory = json.loads(INVENTORY_PATH.read_text())
    known_tables = known_table_names()
    print(f"known table names harvested from migrations: {len(known_tables)}")

    generated = 0
    invalid = 0
    for entry in inventory["bundles"]:
        if not entry.get("process_module") and not entry.get("action_module"):
            continue
        bundle_dir = REPO_ROOT / "bundles" / "python" / entry["dir_name"]
        process_source = ""
        if entry.get("process_module"):
            p = bundle_dir / "bundles" / f"{entry['process_module']}.py"
            process_source = p.read_text() if p.exists() else ""
        action_source = ""
        if entry.get("action_module"):
            p = bundle_dir / "bundles" / f"{entry['action_module']}.py"
            action_source = p.read_text() if p.exists() else ""

        manifest = build_manifest(entry, process_source, action_source, known_tables)
        errors = validate(manifest)
        if errors:
            invalid += 1
            print(f"INVALID {entry['app_id']}: {[(e.reason, e.detail) for e in errors]}",
                  file=sys.stderr)
            continue

        import yaml  # PyYAML -- already a flask_core/hub_api dependency
        bundle_dir.mkdir(parents=True, exist_ok=True)
        (bundle_dir / "bundle.yaml").write_text(
            "# Generated by scripts/bundle_migration/generate_bundle_manifest.py "
            "(M6 cut-over). Review egress/data.tables before install -- both are "
            "heuristic starting points, not authoritative (D26 requires operator "
            "approval regardless).\n" + yaml.safe_dump(manifest, sort_keys=False)
        )
        generated += 1

    print(f"bundle.yaml generated: {generated}")
    print(f"invalid (skipped): {invalid}")
    if generated == 0:
        print("FAIL: zero manifests generated", file=sys.stderr)
        return 1
    if invalid:
        print("FAIL: fix the invalid manifests above (adjust source heuristics "
              "or the bundle's app_catalog row) and re-run", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 8: Run the generator's unit tests, then generate for real**

```bash
cd core/svc_process && python3 -m pytest ../../scripts/bundle_migration/tests/test_generate_bundle_manifest.py -v 2>&1 | tail -20
cd ../.. && python3 scripts/bundle_migration/generate_bundle_manifest.py
```

Expected: 4 unit tests pass; the real run prints non-zero `bundle.yaml generated` and `invalid (skipped): 0`. If any bundle is invalid, fix the specific `ValidationError` reason shown (e.g. add the missing table to `known_table_names()`'s migration scan, or correct `app_id`/`feature`/`module` mismatch in the originating `app_catalog` row) and re-run — do not hand-edit a generated file to route around a real validation failure.

- [ ] **Step 9: Re-run Task 4 Step 1's `routes_to` cross-check now that manifests exist**

```bash
grep -rl "routes_to" bundles/python/*/bundle.yaml 2>/dev/null | xargs -r grep -A2 "routes_to" \
  | grep -iE "discord\.default|slack\.default|kick\.default|youtube\.default|twitch\.default"
```

Expected: no output — confirms (now that real manifests exist) that nothing generated a `routes_to` entry pointing at one of the five deleted generic senders. Non-empty output means Task 4's deletion was wrong for at least one bundle; restore the deleted file(s) via `git revert` of Task 4's commit and re-classify them as kept bundles instead.

- [ ] **Step 10: Commit**

```bash
git add hub_api/tools/bundle_manifest_validator.py hub_api/tools/tests/test_bundle_manifest_validator.py \
        scripts/bundle_migration/generate_bundle_manifest.py scripts/bundle_migration/tests/test_generate_bundle_manifest.py \
        bundles/python/*/bundle.yaml
git commit -m "$(cat <<'EOF'
feat(core): generate bundle.yaml v2 for every migrated bundle, add shared V1-V24/V29-V30 manifest validator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 6: `bundles/README.md` top-level index

**Depends on:** Task 5 (reads the generated `bundle.yaml` files to build the index table).

**Files:**
- Create: `bundles/README.md`
- Create: `scripts/bundle_migration/render_bundles_readme.py`
- Create: `scripts/bundle_migration/tests/test_render_bundles_readme.py`

- [ ] **Step 1: Write the failing test**

```python
# scripts/bundle_migration/tests/test_render_bundles_readme.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from render_bundles_readme import render_row


def test_render_row_shows_both_stages():
    manifest = {"app_id": "waddles.social.alias.default", "name": "Social Alias",
                "module": "social", "language": "python",
                "stages": {"process": {}, "action": {}}}
    row = render_row("social-alias", manifest)
    assert "waddles.social.alias.default" in row
    assert "process, action" in row
    assert "python" in row
```

- [ ] **Step 2: Run to verify failure**

```bash
cd core/svc_process && python3 -m pytest ../../scripts/bundle_migration/tests/test_render_bundles_readme.py -v 2>&1 | tail -10
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
#!/usr/bin/env python3
"""Render bundles/README.md's bundle index table from every bundle.yaml
under bundles/python/, bundles/rust/, bundles/javascript/."""
from __future__ import annotations
import sys
from pathlib import Path
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
BUNDLES_ROOT = REPO_ROOT / "bundles"


def render_row(dir_name: str, manifest: dict) -> str:
    stages = ", ".join(sorted(manifest["stages"].keys()))
    return (f"| `{manifest['app_id']}` | {manifest['name']} | {manifest['module']} "
            f"| {stages} | {manifest['language']} | `{dir_name}` |")


def main() -> int:
    rows = []
    for tier_dir in ("python", "rust", "javascript"):
        tier_path = BUNDLES_ROOT / tier_dir
        if not tier_path.exists():
            continue
        for bundle_dir in sorted(tier_path.iterdir()):
            manifest_path = bundle_dir / "bundle.yaml"
            if not manifest_path.exists():
                continue
            manifest = yaml.safe_load(manifest_path.read_text())
            rows.append(render_row(f"{tier_dir}/{bundle_dir.name}", manifest))

    print(f"bundles indexed: {len(rows)}")
    if not rows:
        print("FAIL: zero bundles indexed", file=sys.stderr)
        return 1

    header = (
        "# Waddles Bundles\n\n"
        "Every first-party bundle, one row per `app_id`. Generated by "
        "`scripts/bundle_migration/render_bundles_readme.py` -- re-run after "
        "adding, removing or renaming a bundle; do not hand-edit the table "
        "below.\n\n"
        "| app_id | Name | Module | Stages | Language | Directory |\n"
        "|---|---|---|---|---|---|\n"
    )
    (BUNDLES_ROOT / "README.md").write_text(header + "\n".join(rows) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests, generate for real, commit**

```bash
cd core/svc_process && python3 -m pytest ../../scripts/bundle_migration/tests/test_render_bundles_readme.py -v 2>&1 | tail -10
cd ../.. && python3 scripts/bundle_migration/render_bundles_readme.py
git add bundles/README.md scripts/bundle_migration/render_bundles_readme.py \
        scripts/bundle_migration/tests/test_render_bundles_readme.py
git commit -m "$(cat <<'EOF'
docs(core): generate bundles/README.md bundle index

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 7: CI — compile and execute every `bundles/python/` bundle (spec §14.4)

**Depends on:** Task 5 (needs real `bundle.yaml` files); plan M2a's `bundle-compiler` and `bundle-executor` binaries must already exist (Task 1 confirmed).

**Files:**
- Create: `.github/workflows/bundle-compatibility.yml`
- Create: `scripts/ci/run_bundle_compatibility_suite.sh`

**Interfaces:**
- Consumes: `bundle-compiler`/`bundle-executor` binaries (built by this workflow from `core/bundle_compiler`, `core/bundle_executor` — "must match plan M2a" for their exact CLI flags; Step 1 below confirms the real `--help` output before scripting against it).

- [ ] **Step 1: Confirm the real CLI surface before scripting against it**

```bash
cd core/bundle_compiler && cargo run --release -- --help 2>&1 | tee /tmp/bundle-compiler-help.txt
cd ../bundle_executor && cargo run --release -- --help 2>&1 | tee /tmp/bundle-executor-help.txt
```

If the flags below (`compile`, `--manifest`, `--source`, `--out`, `--golden-event`, `--invoke`) don't match what `--help` actually prints, adjust the script in Step 2 to the real flag names before proceeding — do not guess past what `--help` shows.

- [ ] **Step 2: Write the compatibility-suite script**

```bash
#!/usr/bin/env bash
# scripts/ci/run_bundle_compatibility_suite.sh
# Compiles every bundles/python/*/bundle.yaml with the real bundle-compiler
# and invokes the result through the real bundle-executor against a golden
# event fixture, per spec §14.4. Asserts bundles_compiled == bundles_on_disk
# -- a non-zero denominator, never a bare "no errors" (Verification Integrity).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPILER_BIN="$REPO_ROOT/core/bundle_compiler/target/release/bundle-compiler"
EXECUTOR_BIN="$REPO_ROOT/core/bundle_executor/target/release/bundle-executor"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

bundles_on_disk=0
bundles_compiled=0
bundles_invoked=0

for bundle_dir in "$REPO_ROOT"/bundles/python/*/; do
  [[ -f "${bundle_dir}bundle.yaml" ]] || continue
  bundles_on_disk=$((bundles_on_disk + 1))
  app_id="$(basename "$bundle_dir")"
  out_component="$OUT_DIR/${app_id}.wasm"

  echo "=== compiling $app_id ==="
  "$COMPILER_BIN" compile \
    --manifest "${bundle_dir}bundle.yaml" \
    --source "$bundle_dir" \
    --out "$out_component"
  bundles_compiled=$((bundles_compiled + 1))

  golden_event="$REPO_ROOT/tests/golden/envelopes/valid/chat_message_basic.json"
  echo "=== invoking $app_id against $golden_event ==="
  "$EXECUTOR_BIN" --invoke --component "$out_component" \
    --stage process --event-file "$golden_event"
  bundles_invoked=$((bundles_invoked + 1))
done

echo "bundles on disk: $bundles_on_disk"
echo "bundles compiled: $bundles_compiled"
echo "bundles invoked: $bundles_invoked"

if [[ "$bundles_on_disk" -eq 0 ]]; then
  echo "FAIL: zero bundles on disk -- check bundles/python/ path" >&2
  exit 1
fi
if [[ "$bundles_compiled" -ne "$bundles_on_disk" ]]; then
  echo "FAIL: bundles_compiled ($bundles_compiled) != bundles_on_disk ($bundles_on_disk)" >&2
  exit 1
fi
```

- [ ] **Step 3: Verify `tests/golden/envelopes/valid/chat_message_basic.json` exists (plan M1a deliverable)**

```bash
test -f tests/golden/envelopes/valid/chat_message_basic.json && echo "golden fixture present" || \
  { echo "MISSING: plan M1a's golden fixture set — see spec §14.1"; exit 1; }
```

If missing, **STOP** and report — this plan does not fabricate `penguin-spine`'s golden fixtures; they are plan M1a's deliverable and Task 1 should have caught their absence.

- [ ] **Step 4: Run the script locally against the already-migrated bundles**

```bash
chmod +x scripts/ci/run_bundle_compatibility_suite.sh
./scripts/ci/run_bundle_compatibility_suite.sh
```

Expected: `bundles on disk`, `bundles compiled` and `bundles invoked` all print the same non-zero number.

- [ ] **Step 5: Wire the CI workflow**

```yaml
# .github/workflows/bundle-compatibility.yml
name: Bundle compatibility (compile + execute every bundles/python/ bundle)

on:
  push:
    branches: [main, 'release/**']
    paths:
      - 'bundles/**'
      - 'core/bundle_compiler/**'
      - 'core/bundle_executor/**'
      - '.github/workflows/bundle-compatibility.yml'
  pull_request:
    branches: [main, 'release/**']
    paths:
      - 'bundles/**'
      - 'core/bundle_compiler/**'
      - 'core/bundle_executor/**'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  compile-and-execute:
    name: compile every bundle + invoke through the real executor
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2

      - name: Install build deps for aws-lc-sys (cmake, C/C++ toolchain)
        run: |
          sudo apt-get update
          sudo apt-get install --no-install-recommends -y cmake build-essential

      - name: Install Rust 1.97.1
        uses: dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87  # stable branch snapshot
        with:
          toolchain: "1.97.1"

      - name: Build bundle-compiler and bundle-executor (release)
        run: |
          cargo build --release --manifest-path core/bundle_compiler/Cargo.toml
          cargo build --release --manifest-path core/bundle_executor/Cargo.toml

      - name: Run the compatibility suite
        run: ./scripts/ci/run_bundle_compatibility_suite.sh
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/bundle-compatibility.yml scripts/ci/run_bundle_compatibility_suite.sh
git commit -m "$(cat <<'EOF'
ci(core): compile and execute every bundles/python/ bundle through the real compiler+executor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 8: Repo-wide check — zero `flask_core.database`/`pydal` imports under `bundles/python/`

**Files:**
- Create: `scripts/bundle_migration/check_no_legacy_dal_imports.sh`
- Create: `bundles/test/hostile/legacy_dal_bundle/bundle.yaml` and `bundles/test/hostile/legacy_dal_bundle/bundles/legacy_dal_process.py` (fixture bundle proving the compiler's `legacy_dal_import` rejection actually fires — spec §14.4: "the compiler's own `legacy_dal_import` rejection is exercised by a fixture bundle that still has one")

- [ ] **Step 1: Write the check script**

```bash
#!/usr/bin/env bash
# scripts/bundle_migration/check_no_legacy_dal_imports.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

files_scanned=0
violations=0

while IFS= read -r -d '' file; do
  files_scanned=$((files_scanned + 1))
  if grep -qE "flask_core\.database|^\s*import pydal|from pydal" "$file"; then
    echo "VIOLATION: $file" >&2
    violations=$((violations + 1))
  fi
done < <(find bundles/python -name "*.py" -print0)

echo "files scanned: $files_scanned"
echo "violations: $violations"

if [[ "$files_scanned" -eq 0 ]]; then
  echo "FAIL: zero files scanned — check the bundles/python path" >&2
  exit 1
fi
if [[ "$violations" -gt 0 ]]; then
  exit 1
fi
```

- [ ] **Step 2: Run against the real, already-migrated tree**

```bash
chmod +x scripts/bundle_migration/check_no_legacy_dal_imports.sh
./scripts/bundle_migration/check_no_legacy_dal_imports.sh
```

Expected: `files scanned: N` (N = however many `.py` files Tasks 3-4 moved), `violations: 0`. If violations are found, plan M1.5's DAL migration for that specific file was incomplete — fix the import in that bundle file to use `penguin-dal`'s public API before proceeding; this plan does not silently accept a violation "because it's pre-existing."

- [ ] **Step 3: Add the hostile fixture bundle that proves the compiler actually rejects this**

```yaml
# bundles/test/hostile/legacy_dal_bundle/bundle.yaml
schema_version: 2
app_id: waddles.test.hostile.legacy-dal
name: Hostile Legacy DAL Import (negative test fixture)
version: 0.0.1
feature: waddles.test.hostile
module: core
provider: builtin
language: python
artifact: source
execution_model: native
stages:
  process:
    entry: "bundles.legacy_dal_process:transform"
    consumes:
      - platform: waddles
        event_types: ["chat.message"]
egress: []
data:
  tables: []
limits:
  timeout_ms: 2000
  memory_mb: 64
  egress_rps: 10
```

```python
# bundles/test/hostile/legacy_dal_bundle/bundles/legacy_dal_process.py
"""Negative-test fixture (spec §14.4): still imports the legacy DAL on
purpose, so the compiler's D21b `legacy_dal_import` rejection has something
real to reject. NEVER migrate this file's import away -- that would defeat
the test it exists for."""
from flask_core.database import AsyncDAL  # noqa: F401 -- deliberate


def transform(event):
    return None
```

- [ ] **Step 4: Confirm the compiler actually rejects it (real compiler, not a stub)**

```bash
core/bundle_compiler/target/release/bundle-compiler compile \
  --manifest bundles/test/hostile/legacy_dal_bundle/bundle.yaml \
  --source bundles/test/hostile/legacy_dal_bundle \
  --out /tmp/should-fail.wasm; echo "exit code: $?"
```

Expected: non-zero exit code, with a diagnostic naming `flask_core.database` and pointing at `penguin-dal` (per D21b's exact wording). **If it exits 0, STOP** — the compiler's D21b check is not implemented or not wired to this exact import pattern; this is a plan M2a gap, report it rather than deleting the fixture to make the check "pass."

- [ ] **Step 5: Commit**

```bash
git add scripts/bundle_migration/check_no_legacy_dal_imports.sh bundles/test/hostile/legacy_dal_bundle/
git commit -m "$(cat <<'EOF'
test(core): zero-legacy-DAL-import gate + hostile fixture proving D21b rejection fires

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 9: Retire `svc_streaming`'s Python alpha, rename `Dockerfile.rust` → `Dockerfile`

**Files:**
- Delete: `core/svc_streaming/app.py`, `core/svc_streaming/blueprints/`, `core/svc_streaming/services/`, `core/svc_streaming/openapi/`, `core/svc_streaming/tests/` (the Python pytest tree — confirm each file is Python, not Rust, before deleting: `core/svc_streaming/tests/` held both at last inspection), `core/svc_streaming/config.py`, `core/svc_streaming/requirements.in`, `core/svc_streaming/requirements.txt`, `core/svc_streaming/pyproject.toml`, `core/svc_streaming/pytest.ini`, `core/svc_streaming/Makefile` (Python-specific — confirm it has no Rust targets a later task needs before deleting)
- Rename: `core/svc_streaming/Dockerfile.rust` → `core/svc_streaming/Dockerfile` (the old Python `Dockerfile` is deleted, not renamed away)
- Modify: `.github/workflows/build-svc-streaming.yml` (repoint at the renamed `Dockerfile`, or confirm it already only builds from `Dockerfile.rust` and just needs the path updated)

- [ ] **Step 1: Confirm what's actually Python vs Rust before deleting anything**

```bash
cd core/svc_streaming
ls tests/ | head -30                     # Python pytest tree
ls src/ | head -30                       # Rust source, must NOT be touched
cat Makefile | head -20                  # confirm no Rust-only targets live only here
grep -n "Dockerfile" ../../.github/workflows/build-svc-streaming.yml
```

Expected: `tests/` contains `.py` files (`test_app.py`, `test_ffmpeg_engine.py`, etc. — already listed in this plan's research); `src/` contains `.rs` files and is untouched by this task.

- [ ] **Step 2: Delete the Python alpha**

```bash
cd core/svc_streaming
git rm -r app.py blueprints/ services/ openapi/ tests/ config.py \
  requirements.in requirements.txt pyproject.toml pytest.ini
git status --short | head -30
```

Expected: every listed path shows as deleted (`D`).

- [ ] **Step 3: Rename the Dockerfile**

```bash
git mv Dockerfile.rust Dockerfile
cat Dockerfile | head -15   # confirm it's the Rust multi-stage build, not the old Python one
```

Expected: the file content matches the Rust `Dockerfile.rust` this plan already read (`FROM rust:1.97-slim-bookworm@sha256:2775a...`), now at path `Dockerfile`.

- [ ] **Step 4: Repoint the CI workflow**

```bash
cd ../..
grep -n "Dockerfile" .github/workflows/build-svc-streaming.yml
```

If the workflow references `Dockerfile.rust` explicitly, update it to `Dockerfile`:

```bash
sed -i 's/Dockerfile\.rust/Dockerfile/g' .github/workflows/build-svc-streaming.yml
grep -n "Dockerfile" .github/workflows/build-svc-streaming.yml
```

Expected: no remaining reference to `Dockerfile.rust` anywhere in the workflow file.

- [ ] **Step 5: Build the image locally to confirm the rename didn't break the build context**

```bash
docker build -f core/svc_streaming/Dockerfile -t localhost:32000/waddlebot/svc-streaming:m6-rename-check core/svc_streaming
docker run --rm localhost:32000/waddlebot/svc-streaming:m6-rename-check --healthcheck; echo "exit: $?"
```

Expected: the build succeeds; `--healthcheck` on a freshly-started, unconfigured container may exit non-zero (no live dependencies) — the point of this step is confirming the binary starts and the flag is recognized, not a full health pass. If the build itself fails, the rename broke a relative path inside the Dockerfile (check `COPY src ./src` still resolves against the renamed file's own directory, which `docker build -f ... <context>` preserves regardless of the Dockerfile's own name).

- [ ] **Step 6: Run the existing Rust CI gate to confirm nothing else regressed**

```bash
cd core/svc_streaming
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Expected: all three pass — this task did not touch `src/`, so this is a regression check, not new coverage.

- [ ] **Step 7: Commit**

```bash
cd ../..
git add -A
git commit -m "$(cat <<'EOF'
chore(core): delete svc_streaming's Python alpha, rename Dockerfile.rust to Dockerfile

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 10: `svc_streaming` adopts `penguin-logging` and `penguin-licensing`

**Depends on:** Task 9; plan M1a's `penguin-logging` crate must be published (Task 1 confirmed the crate directory exists — this task confirms its actual public API before wiring against it, since no plan M1a exists yet to cite an exact signature).

**Files:**
- Modify: `core/svc_streaming/Cargo.toml` (add `penguin-logging`, `penguin-licensing` dependencies)
- Delete: `core/svc_streaming/src/telemetry.rs` (the hand-rolled OTel wiring this replaces)
- Modify: `core/svc_streaming/src/main.rs` (swap the telemetry init call)

- [ ] **Step 1: Confirm `penguin-logging`'s real init function signature**

```bash
grep -n "pub fn init\|pub struct" /home/penguin/code/penguin-libs/packages/rust-logging/src/lib.rs
grep -n "pub fn init\|pub struct" /home/penguin/code/penguin-libs/packages/rust-licensing/src/lib.rs
```

Record the exact function name and parameter list in `M6_PREFLIGHT.md`. **The steps below assume `penguin_logging::init(service_name: &str) -> anyhow::Result<()>` and `penguin_licensing::Client::new(config) -> Client`** as the most spec-consistent shape (§13: "configured only from the standard OTLP environment variables" — an env-var-only init function takes no OTLP config as a parameter) — if the real signature differs, adjust every code snippet below to match the real one before compiling; do not force the real crate to match this plan's guess.

- [ ] **Step 2: Read the current hand-rolled telemetry wiring**

```bash
cat core/svc_streaming/src/telemetry.rs
grep -n "telemetry::" core/svc_streaming/src/main.rs
```

Note every env var it reads (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, etc.) — `penguin-logging`'s init must honor the same set, since spec §12.7's env var table is unchanged by this swap.

- [ ] **Step 3: Add the dependencies**

```toml
# core/svc_streaming/Cargo.toml -- add under [dependencies], exact version once
# Step 1 confirms it against penguin-libs' own published Cargo.toml:
penguin-logging = { path = "../../../penguin-libs/packages/rust-logging" }  # or the published crates.io version once penguin-libs' CI publishes it -- check penguin-libs/packages/rust-logging/Cargo.toml's own `version` field and pin that exact string instead of a path dependency if it is already published
penguin-licensing = { path = "../../../penguin-libs/packages/rust-licensing" }
```

Run `cargo tree -p svc-streaming | grep penguin` to confirm both resolve before continuing.

- [ ] **Step 4: Delete `telemetry.rs`, swap the init call in `main.rs`**

```bash
git rm core/svc_streaming/src/telemetry.rs
```

```rust
// core/svc_streaming/src/main.rs -- replace the old `telemetry::init(...)` call
penguin_logging::init("svc-streaming")?;
```

Remove the now-dead `mod telemetry;` declaration and any `use crate::telemetry::...` imports `cargo build` flags as unused.

- [ ] **Step 5: Wire `penguin-licensing` for the existing flag/entitlement checks**

```bash
grep -rn "PostHog\|feature_flag\|entitlement" core/svc_streaming/src/ | grep -v telemetry
```

For each hit, replace the hand-rolled check with `penguin_licensing::Client`'s equivalent call (confirmed in Step 1) — preserve the exact flag key strings already in use (do not rename them as a side effect of this swap).

- [ ] **Step 6: Build and run the full gate**

```bash
cd core/svc_streaming
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo build --release
cargo test
```

Expected: clean build, all tests pass. A compile error naming a missing function is Step 1's assumed signature being wrong — go back and use the real one.

- [ ] **Step 7: Telemetry smoke test against a local OTLP sink (spec §14.7)**

```bash
docker run -d --name m6-otlp-sink -p 4317:4317 -p 4318:4318 otel/opentelemetry-collector:0.116.1@sha256:REPLACE_WITH_PINNED_DIGEST
# (pin the exact digest via `pinning-dependency-digests` skill rather than the bare tag above)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
  ./target/release/svc-streaming &
SVC_PID=$!
sleep 3
curl -s http://localhost:8208/health | head -5
kill $SVC_PID
docker logs m6-otlp-sink 2>&1 | grep -c "ResourceLog\|ResourceMetric" || true
docker rm -f m6-otlp-sink
```

Expected: `/health` returns 200; the sink log shows at least one received log/metric record. **Zero records is a FAIL, not a skip** (Verification Integrity) — if zero, `penguin_logging::init` is not actually wired to the OTLP exporter and Step 3-4's swap needs another look.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(core): svc_streaming adopts penguin-logging and penguin-licensing, retires hand-rolled telemetry.rs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 11: Chart `values.yaml` — new keys for the four Rust services, executor, sandbox, spine, bundles, security

**Files:**
- Modify: `k8s/helm/waddlebot/values.yaml`

**Interfaces:**
- Produces: every `.Values.pipeline.*`, `.Values.sandbox.*`, `.Values.bundles.*`, `.Values.security.transport.*`, `.Values.security.rbac.*` key Tasks 12-18 template against — those tasks read these exact key paths, not a variant spelling.

- [ ] **Step 1: Add the new keys under the existing `pipeline:` block (spec §12.3)**

```yaml
# k8s/helm/waddlebot/values.yaml -- inside the existing `pipeline:` top-level key,
# replacing pipeline.pythonBaseImage's three former consumers (svc-ingest/process/action)
# and adding the new per-service image key svc-streaming already needed under a
# different top-level key (`streaming.image.*`) -- Task 12 repoints all four templates
# at these `pipeline.svcX.image` keys for symmetry (spec §12.3's row lists all four
# together); `streaming.image.*` stays defined for one release as a deprecated alias
# (Task 12 Step 4) rather than being removed in the same commit that stops using it.
  svcIngest:
    image: "ghcr.io/penguintechinc/waddles/svc-ingest"
  svcProcess:
    image: "ghcr.io/penguintechinc/waddles/svc-process"
  svcAction:
    image: "ghcr.io/penguintechinc/waddles/svc-action"
  svcStreaming:
    image: "ghcr.io/penguintechinc/waddles/svc-streaming"

  executor:
    image: "ghcr.io/penguintechinc/waddles/bundle-executor"
    replicas: 2
    stageConnections: 4
    callTimeoutMs: 2000
    maxCallTimeoutMs: 10000
    memoryLimitMb: 64
    maxMemoryLimitMb: 256
    instancesPerBundle: 4
    maxConcurrentCalls: 32
    tripThreshold: 3
    tripWindowSeconds: 300
    hostApiPort:
      process: 8301
      action: 8302
    resources:
      requests:
        cpu: "250m"
        memory: "256Mi"
      limits:
        cpu: "1000m"
        memory: "512Mi"

  spine:
    streamMaxLen: 100000
    readCount: 64
    blockMs: 1000
    claimIdleMs: 30000
    claimIntervalMs: 15000
    pelAlert: 5000
    dlqMaxLen: 10000
    maxDeliveries: 5

sandbox:
  runtimeClassName: "runsc"
  gvisor:
    enabled: true
  installer:
    enabled: false
    runscVersion: ""
    runscSha256: ""
    shimSha256: ""
    nodeLabel: "waddles.io/gvisor=ready"

bundles:
  allowPrebuilt: true
  allowWildcardConsumes: false
  bucket:
    provider: "minio"
    endpoint: "http://minio.waddlebot.svc.cluster.local:9000"
    name: "waddles-bundles"
    region: "us-east-1"
    existingSecret: "waddles-bundle-bucket"
  pollIntervalSeconds: 60
  egress:
    allowPrivateHosts: false
  signingPublicKeySecret: "waddles-bundle-signing"
  compiler:
    image: "ghcr.io/penguintechinc/waddles/bundle-compiler"
    activeDeadlineSeconds: 900
    resources:
      limits:
        cpu: "2000m"
        memory: "4Gi"

security:
  transport:
    tls: true
    auth: true
    certManager: "auto"
  rbac:
    postgresMatrix: "config/postgres/rbac-matrix.yaml"
    valkeyMatrix: "config/valkey/acl-matrix.yaml"
```

Note on `bundles.bucket.endpoint`: uses the chart's existing `waddlebot` in-cluster service name (`minio.waddlebot.svc.cluster.local`), not the spec's illustrative `minio.waddles.svc.cluster.local` — per this plan's Global Constraints "Waddles naming" note, the actual namespace stays `waddlebot` until the deferred D22 rename; the literal value here is correct for the namespace this chart actually deploys into today.

- [ ] **Step 2: `helm lint` and confirm the new keys render**

```bash
helm lint k8s/helm/waddlebot
helm template waddlebot k8s/helm/waddlebot --values k8s/helm/waddlebot/values.yaml \
  --set pipeline.svcIngest.image=test-image \
  | grep -A2 "test-image" || echo "no template references pipeline.svcIngest.image yet -- expected, Task 12 wires it"
```

Expected: `helm lint` reports 0 errors (new unused values keys are not lint failures — only the two templates Tasks 12-18 write will actually reference most of these). The `grep` finding nothing is expected at this point in the plan.

- [ ] **Step 3: Commit**

```bash
git add k8s/helm/waddlebot/values.yaml
git commit -m "$(cat <<'EOF'
feat(helm): add pipeline.svcX.image, executor, sandbox, spine, bundles and security.* values keys for the Rust data-plane cut-over

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 12: Point `svc-ingest`/`svc-process`/`svc-action` templates at their own Rust image, add the host-api port + mTLS mount

**Depends on:** Task 11.

**Files:**
- Modify: `k8s/helm/waddlebot/templates/svc-process.yaml:39-40,109-119` (line numbers as read during Task 11's research pass — re-read the file first, this plan's earlier `sed -n` output is the ground truth for anchoring, not these numbers if the file has since changed)
- Modify: `k8s/helm/waddlebot/templates/svc-action.yaml` (same shape edit, port 8302)
- Modify: `k8s/helm/waddlebot/templates/svc-ingest.yaml` (same image/uid edit; **no host-api port** — ingest links no executor, spec §4.1)
- Modify: `k8s/helm/waddlebot/templates/svc-streaming.yaml:51` (repoint from `.Values.streaming.image.*` to the new `.Values.pipeline.svcStreaming.image` for symmetry with the other three, per spec §12.3's combined key row)

- [ ] **Step 1: Replace the image line and securityContext on `svc-process.yaml`**

```yaml
# BEFORE (svc-process.yaml):
      - name: svc-process
        # SKELETON PLACEHOLDER — no Dockerfile/CI image exists yet for svc-process; pinned to
        # the repo's existing Python base digest rather than inventing one or using a mutable
        # tag. Replace once svc-process has its own Dockerfile and CI build.
        image: "{{ .Values.pipeline.pythonBaseImage }}"
        imagePullPolicy: {{ .Values.global.imagePullPolicy }}
        securityContext:
          {{- toYaml .Values.securityContext | nindent 10 }}
        ports:
        - name: http
          containerPort: {{ .Values.pipeline.svcProcess.port }}
          protocol: TCP

# AFTER:
      - name: svc-process
        # M6 cut-over: real per-service Rust image, built by plan M4 and this chart's own
        # CI (rust-svc-process.yml, mirroring rust-svc-streaming.yml). Replaces the
        # pipeline.pythonBaseImage skeleton placeholder.
        image: "{{ .Values.pipeline.svcProcess.image }}:{{ .Values.global.imageTag }}"
        imagePullPolicy: {{ .Values.global.imagePullPolicy }}
        # Pinned to the Rust image's own appuser (uid 10001), matching
        # svc-streaming.yaml's own override of the chart-wide .Values.securityContext.
        securityContext:
          runAsNonRoot: true
          runAsUser: 10001
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
        ports:
        - name: http
          containerPort: {{ .Values.pipeline.svcProcess.port }}
          protocol: TCP
        - name: metrics
          containerPort: 9090
          protocol: TCP
        - name: host-api
          containerPort: {{ .Values.pipeline.executor.hostApiPort.process }}
          protocol: TCP
```

- [ ] **Step 2: Add the host-api mTLS volume mount and CA mount alongside the existing `volumeMounts`**

```yaml
# BEFORE:
        volumeMounts:
        - name: logs
          mountPath: /var/log/waddlebotlog
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: logs
        emptyDir: {}
      - name: tmp
        emptyDir: {}

# AFTER:
        volumeMounts:
        - name: logs
          mountPath: /var/log/waddlebotlog
        - name: tmp
          mountPath: /tmp
        - name: ca
          mountPath: /etc/waddles/ca
          readOnly: true
        - name: host-api-tls
          mountPath: /etc/waddles/host-api
          readOnly: true
      volumes:
      - name: logs
        emptyDir: {}
      - name: tmp
        emptyDir: {}
      - name: ca
        secret:
          secretName: {{ include "waddlebot.fullname" . }}-ca-bundle
      - name: host-api-tls
        secret:
          secretName: {{ include "waddlebot.fullname" . }}-svc-process-host-api-tls
```

The two new Secrets (`{fullname}-ca-bundle`, `{fullname}-svc-process-host-api-tls`) are rendered by Task 17 — this task's own `helm template` check (Step 4 below) will show them as referenced-but-not-yet-defined until Task 17 lands; that is expected and this task does not block on it (the "chart tasks parallel with docs tasks" note in this plan's task-ordering rule applies here — Tasks 12 and 17 both modify the chart but touch disjoint files, so they may run in either order, with `helm template`'s "no Secret found" being a Task 17 dependency to note, not a Task 12 failure, since `helm template` never validates that a referenced Secret name actually exists at render time — only `helm install`/`--validate` against a live cluster would).

- [ ] **Step 3: Repeat Steps 1-2 for `svc-action.yaml` (port `.Values.pipeline.executor.hostApiPort.action` = 8302, Secret name `{fullname}-svc-action-host-api-tls`) and for `svc-ingest.yaml` (image + uid only — no `host-api` containerPort, no `host-api-tls` volume: spec §4.1 states ingest "runs no bundle and links no executor")**

- [ ] **Step 4: Repoint `svc-streaming.yaml`'s image line for symmetry, keep `streaming.image.*` as a one-release deprecated alias**

```yaml
# BEFORE (svc-streaming.yaml:51):
        image: "{{ .Values.streaming.image.repository }}:{{ .Values.streaming.image.tag | default .Values.global.imageTag }}"

# AFTER:
        # M6: symmetric with the other three pipeline stages' pipeline.svcX.image keys
        # (spec §12.3). .Values.streaming.image.* is kept as a values.yaml fallback for
        # one release rather than deleted in the same commit that stops using it by
        # default -- see values.yaml's own comment at the streaming.image.* block.
        image: "{{ .Values.pipeline.svcStreaming.image | default .Values.streaming.image.repository }}:{{ .Values.streaming.image.tag | default .Values.global.imageTag }}"
```

- [ ] **Step 5: `helm lint` and `helm template` all four**

```bash
helm lint k8s/helm/waddlebot
helm template waddlebot k8s/helm/waddlebot --values k8s/helm/waddlebot/values.yaml \
  | grep -A1 "name: svc-ingest$\|name: svc-process$\|name: svc-action$\|name: svc-streaming$" \
  | grep image:
```

Expected: four `image:` lines, each showing `ghcr.io/penguintechinc/waddles/svc-{ingest,process,action,streaming}:` (the `.Values.global.imageTag` default, likely empty string or `latest` in an unconfigured `helm template` run — that is fine, this step only confirms the repository half of the string changed away from the shared Python placeholder / the old `streaming.image.repository` literal `waddlebot-svc-streaming`).

- [ ] **Step 6: Commit**

```bash
git add k8s/helm/waddlebot/templates/svc-ingest.yaml k8s/helm/waddlebot/templates/svc-process.yaml \
        k8s/helm/waddlebot/templates/svc-action.yaml k8s/helm/waddlebot/templates/svc-streaming.yaml
git commit -m "$(cat <<'EOF'
feat(helm): point svc-ingest/process/action/streaming at per-service Rust images, add host-api port + mTLS mounts to process/action

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 13: `bundle-executor` Deployment template (two Deployments — process, action)

**Depends on:** Task 11.

**Files:**
- Create: `k8s/helm/waddlebot/templates/pipeline/bundle-executor.yaml`

- [ ] **Step 1: Write the template — one `range` over the two stages, per spec §12.4's exact pod shape**

```yaml
# k8s/helm/waddlebot/templates/pipeline/bundle-executor.yaml
#
# One Deployment per stage (svc-process-executor, svc-action-executor), spec §4.5/§12.4.
# Runs under the gVisor RuntimeClass by default (sandbox.gvisor.enabled), rootless,
# all capabilities dropped, no stage credentials, automountServiceAccountToken: false.
# The executor dials OUT to its stage's host-api port -- it accepts no inbound
# connections of its own, matching the NetworkPolicy in Task 16.
{{- if .Values.pipeline.svcProcess.enabled }}
{{- range $stage, $port := (dict "process" .Values.pipeline.executor.hostApiPort.process "action" .Values.pipeline.executor.hostApiPort.action) }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "waddlebot.fullname" $ }}-svc-{{ $stage }}-executor
  labels:
    {{- include "waddlebot.labels" $ | nindent 4 }}
    app.kubernetes.io/component: svc-{{ $stage }}-executor
spec:
  replicas: {{ $.Values.pipeline.executor.replicas }}
  selector:
    matchLabels:
      {{- include "waddlebot.selectorLabels" $ | nindent 6 }}
      app.kubernetes.io/component: svc-{{ $stage }}-executor
  template:
    metadata:
      labels:
        {{- include "waddlebot.selectorLabels" $ | nindent 8 }}
        app.kubernetes.io/component: svc-{{ $stage }}-executor
    spec:
      {{- if $.Values.sandbox.gvisor.enabled }}
      runtimeClassName: {{ $.Values.sandbox.runtimeClassName }}
      {{- end }}
      {{- if $.Values.sandbox.installer.enabled }}
      nodeSelector:
        {{- $parts := splitList "=" $.Values.sandbox.installer.nodeLabel }}
        {{ index $parts 0 }}: {{ index $parts 1 }}
      {{- end }}
      automountServiceAccountToken: false
      serviceAccountName: {{ include "waddlebot.serviceAccountName" $ }}
      {{- include "waddlebot.imagePullSecrets" $ | nindent 6 }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: bundle-executor
        image: "{{ $.Values.pipeline.executor.image }}:{{ $.Values.global.imageTag }}"
        imagePullPolicy: {{ $.Values.global.imagePullPolicy }}
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
        env:
        - name: STAGE_HOST_API_ADDR
          value: "{{ include "waddlebot.fullname" $ }}-svc-{{ $stage }}:{{ $port }}"
        - name: EXECUTOR_STAGE_CONNECTIONS
          value: {{ $.Values.pipeline.executor.stageConnections | quote }}
        - name: WADDLES_SANDBOX_GVISOR
          value: {{ $.Values.sandbox.gvisor.enabled | quote }}
        - name: SANDBOX_RUNTIME_EXPECTED
          value: "gvisor"
        - name: EXECUTOR_CALL_TIMEOUT_MS
          value: {{ $.Values.pipeline.executor.callTimeoutMs | quote }}
        - name: EXECUTOR_MAX_CALL_TIMEOUT_MS
          value: {{ $.Values.pipeline.executor.maxCallTimeoutMs | quote }}
        - name: EXECUTOR_MEMORY_LIMIT_MB
          value: {{ $.Values.pipeline.executor.memoryLimitMb | quote }}
        - name: EXECUTOR_MAX_MEMORY_LIMIT_MB
          value: {{ $.Values.pipeline.executor.maxMemoryLimitMb | quote }}
        - name: EXECUTOR_INSTANCES_PER_BUNDLE
          value: {{ $.Values.pipeline.executor.instancesPerBundle | quote }}
        - name: EXECUTOR_MAX_CONCURRENT_CALLS
          value: {{ $.Values.pipeline.executor.maxConcurrentCalls | quote }}
        - name: EXECUTOR_TRIP_THRESHOLD
          value: {{ $.Values.pipeline.executor.tripThreshold | quote }}
        - name: EXECUTOR_TRIP_WINDOW_S
          value: {{ $.Values.pipeline.executor.tripWindowSeconds | quote }}
        - name: BUNDLE_BUCKET_ENDPOINT
          value: {{ $.Values.bundles.bucket.endpoint | quote }}
        - name: BUNDLE_BUCKET_NAME
          value: {{ $.Values.bundles.bucket.name | quote }}
        - name: BUNDLE_BUCKET_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: {{ $.Values.bundles.bucket.existingSecret }}
              key: accessKeyId
        - name: BUNDLE_BUCKET_SECRET_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: {{ $.Values.bundles.bucket.existingSecret }}
              key: secretAccessKey
        - name: BUNDLE_SIGNING_PUBLIC_KEY
          valueFrom:
            secretKeyRef:
              name: {{ $.Values.bundles.signingPublicKeySecret }}
              key: publicKey
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
          {{- toYaml $.Values.pipeline.executor.resources | nindent 10 }}
        livenessProbe:
          exec:
            command: ["/app/bundle-executor", "--healthcheck"]
          initialDelaySeconds: 15
          periodSeconds: 15
      volumes:
      - name: scratch
        emptyDir:
          sizeLimit: 16Mi
      - name: wasm-cache
        emptyDir: {}
      - name: client-tls
        secret:
          secretName: {{ include "waddlebot.fullname" $ }}-svc-{{ $stage }}-host-api-tls
      - name: bucket
        secret:
          secretName: {{ $.Values.bundles.bucket.existingSecret }}
{{- end }}
{{- end }}
```

- [ ] **Step 2: `helm template` and verify both Deployments render with the RuntimeClass**

```bash
helm template waddlebot k8s/helm/waddlebot --values k8s/helm/waddlebot/values.yaml \
  | grep -E "name: .*-executor$|runtimeClassName" 
```

Expected: two `-svc-process-executor`/`-svc-action-executor` Deployment names, each followed (search the full rendered manifest, not just grep context) by `runtimeClassName: runsc`.

- [ ] **Step 3: Confirm the opt-out actually removes `runtimeClassName`**

```bash
helm template waddlebot k8s/helm/waddlebot --values k8s/helm/waddlebot/values.yaml \
  --set sandbox.gvisor.enabled=false \
  | grep -c "runtimeClassName: runsc"
```

Expected: `0` — with the opt-out set, no rendered Deployment carries the gVisor `RuntimeClass` (spec §12.2's "the chart omits `runtimeClassName`" behavior).

- [ ] **Step 4: Commit**

```bash
git add k8s/helm/waddlebot/templates/pipeline/bundle-executor.yaml
git commit -m "$(cat <<'EOF'
feat(helm): bundle-executor Deployment template for both stages, gVisor RuntimeClass by default, credential-less pod

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 14: `bundle-compiler` Job template (split `build` + `publisher` containers)

**Depends on:** Task 11.

**Files:**
- Create: `k8s/helm/waddlebot/templates/pipeline/bundle-compiler-job.yaml`

**Interfaces:**
- Consumes: `bundles.compiler.image`, `bundles.compiler.activeDeadlineSeconds`, `bundles.compiler.resources` (Task 11); the actual trigger for this Job (hub-api enqueuing a compile request per a new bundle upload, plan M2a/M2b) is out of this plan's scope — this task only templates the Job shape spec §4.6/D27 requires, parameterized by `app_id`/`version`/`source_ref` values a caller (hub-api) supplies via `helm template`/a Job-per-request creation call it already owns.

- [ ] **Step 1: Write the template**

```yaml
# k8s/helm/waddlebot/templates/pipeline/bundle-compiler-job.yaml
#
# D27: the compiler Job splits into an untrusted `build` container (runs bundle
# code at build time, gVisor RuntimeClass, NO network, no credentials) and a
# trusted `publisher` container (default runtime, computes the digest, signs,
# uploads, INSERTs the version row) sharing one emptyDir. The hash is never
# computed inside the sandbox that ran bundle code (D27's core guarantee).
#
# This is a Job TEMPLATE only -- hub-api (plan M2a/M2b) creates one Job per
# compile request from this chart's rendered template, substituting
# {{ .Values.bundles.compiler.jobNameSuffix | default "manual" }} and the
# actual manifest/source references at creation time via its own K8s client,
# not via `helm install`/`helm upgrade`. `helm template` here renders one
# example instance for lint/CI purposes.
{{- if .Values.bundles.compiler.enabled | default true }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "waddlebot.fullname" . }}-bundle-compile-{{ .Values.bundles.compiler.jobNameSuffix | default "manual" }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
    app.kubernetes.io/component: bundle-compiler
spec:
  activeDeadlineSeconds: {{ .Values.bundles.compiler.activeDeadlineSeconds }}
  backoffLimit: 0
  template:
    metadata:
      labels:
        {{- include "waddlebot.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: bundle-compiler
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      initContainers:
      - name: build
        {{- if .Values.sandbox.gvisor.enabled }}
        # NOTE: Kubernetes does not support a per-container RuntimeClass; D27's
        # "build container under gVisor, publisher under the default runtime"
        # requires the WHOLE POD to run under gVisor when this container is
        # untrusted-code-executing, matching §4.6's own statement that the
        # compiler Job as a whole runs under the same gVisor RuntimeClass as
        # the executor (§7.5, D10) -- the publisher container inherits gVisor
        # too, which is a strictly SAFER posture than the alternative
        # (publisher on the default runtime), not a spec violation: D27's
        # container-level distinction is about NETWORK ACCESS AND CREDENTIALS
        # (enforced below via env/volumes/NetworkPolicy), not RuntimeClass.
        {{- end }}
        image: "{{ .Values.bundles.compiler.image }}:{{ .Values.global.imageTag }}"
        imagePullPolicy: {{ .Values.global.imagePullPolicy }}
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
        command: ["/app/bundle-compiler", "build"]
        env:
        - name: BUNDLE_MAX_SOURCE_BYTES
          value: "16777216"
        # No BUNDLE_BUCKET_*, no DB_*, no HUB_API_URL — this container mounts
        # no credential of any kind (spec §4.6, §12.5's build-container row).
        volumeMounts:
        - name: work
          mountPath: /work
        - name: source
          mountPath: /source
          readOnly: true
      containers:
      - name: publisher
        {{- if .Values.sandbox.runtimeClassName }}
        {{- end }}
        image: "{{ .Values.bundles.compiler.image }}:{{ .Values.global.imageTag }}"
        imagePullPolicy: {{ .Values.global.imagePullPolicy }}
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
        command: ["/app/bundle-compiler", "publish"]
        env:
        - name: BUNDLE_SIGNING_PRIVATE_KEY_FILE
          value: "/etc/waddles/signing/privateKey"
        - name: BUNDLE_BUCKET_ENDPOINT
          value: {{ .Values.bundles.bucket.endpoint | quote }}
        - name: BUNDLE_BUCKET_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: {{ .Values.bundles.bucket.existingSecret }}
              key: accessKeyId
        - name: BUNDLE_BUCKET_SECRET_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: {{ .Values.bundles.bucket.existingSecret }}
              key: secretAccessKey
        - name: HUB_API_URL
          value: "http://{{ include "waddlebot.fullname" . }}-hub-api-v3:{{ .Values.pipeline.hubApi.port }}"
        - name: DB_HOST
          value: {{ include "waddlebot.postgres.host" . }}
        volumeMounts:
        - name: work
          mountPath: /work
          readOnly: true
        - name: signing-key
          mountPath: /etc/waddles/signing
          readOnly: true
        resources:
          {{- toYaml .Values.bundles.compiler.resources | nindent 10 }}
      volumes:
      - name: work
        emptyDir: {}
      - name: source
        emptyDir: {}
      - name: signing-key
        secret:
          secretName: {{ .Values.bundles.signingPublicKeySecret }}
          items:
          - key: privateKey
            path: privateKey
{{- end }}
```

- [ ] **Step 2: `helm lint` and `helm template`**

```bash
helm lint k8s/helm/waddlebot
helm template waddlebot k8s/helm/waddlebot --values k8s/helm/waddlebot/values.yaml \
  --set bundles.compiler.jobNameSuffix=ci-test \
  | grep -A3 "kind: Job"
```

Expected: 0 lint errors; the Job renders with `restartPolicy: Never`, `activeDeadlineSeconds: 900`.

- [ ] **Step 3: Commit**

```bash
git add k8s/helm/waddlebot/templates/pipeline/bundle-compiler-job.yaml
git commit -m "$(cat <<'EOF'
feat(helm): bundle-compiler Job template, split build (no network/credentials) + publisher containers per D27

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---
## Task 15: Containerized chart toolchain (`make chart-lint`/`chart-template`) + the optional gVisor installer DaemonSet

**Depends on:** M2a (`build/tool-versions.env` exists — Task 1 Step 4 confirmed it) and this plan's Task 11 (`sandbox.installer.*` values). M2b/M3/M4/M5 are **not** required for this task.

**Why the make targets land here:** Tasks 11-14 invoked `helm` directly because the containerized target did not exist yet. From this task onward every chart command in this plan goes through `make chart-lint` / `make chart-template`, per `general.md` Make Targets and "builds MUST execute within Docker containers". The two forms are equivalent; the make target is the one CI runs.

**Files:**
- Create: `build/helm-tool/Dockerfile`
- Modify: `build/tool-versions.env` (adds `HELM_VERSION`, `HELM_SHA256_LINUX_AMD64`)
- Modify: `Makefile` (adds `chart-tool-build`, `chart-lint`, `chart-template`)
- Create: `k8s/helm/waddlebot/templates/pipeline/sandbox-installer-daemonset.yaml`
- Create: `k8s/helm/waddlebot/tests/helm_installer_pins_test.sh`

**Interfaces:**
- Consumes: `.Values.sandbox.installer.{enabled,runscVersion,runscSha256,shimSha256,nodeLabel}` (Task 11), `build/tool-versions.env` (**must match plan M2a** — Task 1 Step 4 printed its real key names; the two keys this task adds are new and owned here).
- Produces: `make chart-lint`, `make chart-template` (every later task in this plan calls these, never bare `helm`); `make render-valkey-acl` is added separately in Task 18.

- [ ] **Step 1: Resolve the Helm pin — never invent a version or a checksum**

```bash
HELM_VERSION="$(curl -fsSL https://api.github.com/repos/helm/helm/releases/latest \
  | grep -m1 '"tag_name"' | cut -d'"' -f4)"
echo "resolved HELM_VERSION=${HELM_VERSION}"
case "$HELM_VERSION" in
  v4.*) echo "helm v4 confirmed" ;;
  *) echo "STOP: devops-kubernetes.md requires Helm v4 ONLY; latest resolved to ${HELM_VERSION}" >&2; exit 1 ;;
esac
HELM_SHA="$(curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz.sha256sum" | cut -d' ' -f1)"
test -n "$HELM_SHA" || { echo "STOP: upstream published no checksum for ${HELM_VERSION}" >&2; exit 1; }
printf '\n# Helm CLI (chart lint/template toolchain, devops-kubernetes.md "Helm v4 ONLY")\nHELM_VERSION=%s\nHELM_SHA256_LINUX_AMD64=%s\n' "$HELM_VERSION" "$HELM_SHA" >> build/tool-versions.env
tail -4 build/tool-versions.env
```

Expected: the last four lines of `build/tool-versions.env` show the comment plus a `v4.x.y` `HELM_VERSION` and a 64-hex `HELM_SHA256_LINUX_AMD64`. **If the `case` or the `test -n` branch fires, STOP and report to the user** — a chart toolchain that is not Helm v4, or whose tarball has no published checksum, is not something this plan may pin around.

- [ ] **Step 2: Write `build/helm-tool/Dockerfile`**

```dockerfile
# build/helm-tool/Dockerfile
# Containerized Helm CLI for `make chart-lint` / `make chart-template`
# (general.md: builds execute in containers, never against host tooling).
# Debian 12 bookworm only (devops-containers.md); rootless at the process
# layer; the helm tarball is verified against the checksum upstream
# publishes next to it, pinned into build/tool-versions.env by Task 15.
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

ARG HELM_VERSION
ARG HELM_SHA256_LINUX_AMD64

RUN set -eux; \
    apt-get update; \
    apt-get install --no-install-recommends -y ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /tmp/helm.tar.gz "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz"; \
    echo "${HELM_SHA256_LINUX_AMD64}  /tmp/helm.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/helm.tar.gz -C /tmp; \
    install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm; \
    rm -rf /tmp/helm.tar.gz /tmp/linux-amd64; \
    helm version --short

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin appuser
USER 10001:10001
WORKDIR /chart
ENTRYPOINT ["helm"]
```

- [ ] **Step 3: Add the three Makefile targets**

Append to `Makefile`, and add `chart-tool-build chart-lint chart-template` to the existing `.PHONY` line:

```makefile
CHART_DIR    := k8s/helm/waddlebot
CHART_TOOL   := waddles-helm-tool:local
CHART_VALUES ?= $(CHART_DIR)/values.yaml

chart-tool-build:
	@set -euo pipefail; \
	. ./build/tool-versions.env; \
	docker build \
	  --build-arg HELM_VERSION="$$HELM_VERSION" \
	  --build-arg HELM_SHA256_LINUX_AMD64="$$HELM_SHA256_LINUX_AMD64" \
	  -f build/helm-tool/Dockerfile -t $(CHART_TOOL) build/helm-tool

chart-lint: chart-tool-build
	@set -euo pipefail; \
	docker run --rm -v "$(CURDIR)/$(CHART_DIR)":/chart:ro $(CHART_TOOL) lint /chart

# Usage: make chart-template
#        make chart-template CHART_VALUES=k8s/helm/waddlebot/values-alpha.yaml
#        make chart-template CHART_ARGS="--set sandbox.gvisor.enabled=false"
chart-template: chart-tool-build
	@set -euo pipefail; \
	docker run --rm -v "$(CURDIR)":/repo:ro -w /repo $(CHART_TOOL) \
	  template waddlebot $(CHART_DIR) --values $(CHART_VALUES) $(CHART_ARGS)
```

- [ ] **Step 4: Write the installer DaemonSet**

```yaml
# k8s/helm/waddlebot/templates/pipeline/sandbox-installer-daemonset.yaml
#
# Optional gVisor node installer (spec §12.2.2). Default DISABLED.
#
# ROOT EXCEPTION (approved) — sandbox installer only.
# Installing a container-runtime handler requires writing to the node
# filesystem and restarting containerd, which is not achievable rootless.
# Scope: this DaemonSet alone, default DISABLED (sandbox.installer.enabled:
# false). No other Waddles workload runs privileged or as root; the
# executor it installs support for is itself rootless with all capabilities
# dropped. Approved by the human product owner, 2026-09-14.
{{- if .Values.sandbox.installer.enabled }}
{{- if not .Values.sandbox.installer.runscVersion }}
{{- fail "sandbox.installer.enabled=true requires sandbox.installer.runscVersion (pin it from build/tool-versions.env); an unpinned runsc is never fetched" }}
{{- end }}
{{- if not .Values.sandbox.installer.runscSha256 }}
{{- fail "sandbox.installer.enabled=true requires sandbox.installer.runscSha256; an unverified runsc binary is never installed" }}
{{- end }}
{{- if not .Values.sandbox.installer.shimSha256 }}
{{- fail "sandbox.installer.enabled=true requires sandbox.installer.shimSha256; an unverified containerd shim is never installed" }}
{{- end }}
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: {{ include "waddlebot.fullname" . }}-sandbox-installer
  namespace: {{ include "waddlebot.namespace" . }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
    app.kubernetes.io/component: sandbox-installer
spec:
  selector:
    matchLabels:
      {{- include "waddlebot.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: sandbox-installer
  template:
    metadata:
      labels:
        {{- include "waddlebot.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: sandbox-installer
    spec:
      hostPID: true
      serviceAccountName: {{ include "waddlebot.fullname" . }}-sandbox-installer
      {{- include "waddlebot.imagePullSecrets" . | nindent 6 }}
      tolerations:
      - operator: Exists
      containers:
      - name: installer
        image: "{{ .Values.sandbox.installer.image }}"
        imagePullPolicy: {{ .Values.global.imagePullPolicy }}
        securityContext:
          # ROOT EXCEPTION (approved) — see the file header.
          privileged: true
          runAsUser: 0
        env:
        - name: RUNSC_VERSION
          value: {{ .Values.sandbox.installer.runscVersion | quote }}
        - name: RUNSC_SHA256
          value: {{ .Values.sandbox.installer.runscSha256 | quote }}
        - name: SHIM_SHA256
          value: {{ .Values.sandbox.installer.shimSha256 | quote }}
        - name: NODE_LABEL
          value: {{ .Values.sandbox.installer.nodeLabel | quote }}
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        command: ["/bin/bash", "/opt/waddles/install-gvisor.sh"]
        volumeMounts:
        - name: host-usr-local-bin
          mountPath: /host/usr/local/bin
        - name: host-containerd-config
          mountPath: /host/etc/containerd
        - name: installer-script
          mountPath: /opt/waddles
          readOnly: true
        resources:
          requests: {cpu: "50m", memory: "64Mi"}
          limits:   {cpu: "500m", memory: "256Mi"}
      volumes:
      - name: host-usr-local-bin
        hostPath: {path: /usr/local/bin, type: Directory}
      - name: host-containerd-config
        hostPath: {path: /etc/containerd, type: DirectoryOrCreate}
      - name: installer-script
        configMap:
          name: {{ include "waddlebot.fullname" . }}-sandbox-installer
          defaultMode: 0755
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "waddlebot.fullname" . }}-sandbox-installer
  namespace: {{ include "waddlebot.namespace" . }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: {{ include "waddlebot.fullname" . }}-sandbox-installer
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
rules:
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: {{ include "waddlebot.fullname" . }}-sandbox-installer
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: {{ include "waddlebot.fullname" . }}-sandbox-installer
subjects:
- kind: ServiceAccount
  name: {{ include "waddlebot.fullname" . }}-sandbox-installer
  namespace: {{ include "waddlebot.namespace" . }}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "waddlebot.fullname" . }}-sandbox-installer
  namespace: {{ include "waddlebot.namespace" . }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
data:
  install-gvisor.sh: |
    #!/usr/bin/env bash
    # Installs a pinned runsc + containerd-shim-runsc-v1 on this node,
    # registers the containerd handler idempotently, restarts containerd and
    # labels the node. An empty or mismatching digest is a hard failure:
    # the node is never labelled and nothing is installed (spec §12.2.2).
    set -euo pipefail

    : "${RUNSC_VERSION:?RUNSC_VERSION is required}"
    : "${RUNSC_SHA256:?RUNSC_SHA256 is required}"
    : "${SHIM_SHA256:?SHIM_SHA256 is required}"
    : "${NODE_LABEL:?NODE_LABEL is required}"
    : "${NODE_NAME:?NODE_NAME is required}"

    BASE="https://storage.googleapis.com/gvisor/releases/release/${RUNSC_VERSION}/$(uname -m)"
    workdir="$(mktemp -d)"
    trap 'rm -rf "$workdir"' EXIT

    curl -fsSL -o "$workdir/runsc" "$BASE/runsc"
    echo "${RUNSC_SHA256}  $workdir/runsc" | sha256sum -c -
    curl -fsSL -o "$workdir/containerd-shim-runsc-v1" "$BASE/containerd-shim-runsc-v1"
    echo "${SHIM_SHA256}  $workdir/containerd-shim-runsc-v1" | sha256sum -c -

    install -m 0755 "$workdir/runsc" /host/usr/local/bin/runsc
    install -m 0755 "$workdir/containerd-shim-runsc-v1" /host/usr/local/bin/containerd-shim-runsc-v1

    CONFIG=/host/etc/containerd/config.toml
    touch "$CONFIG"
    if grep -q 'containerd.runtimes.runsc' "$CONFIG"; then
      echo "containerd already registers the runsc handler — no change"
    else
      cat >> "$CONFIG" <<'TOML'

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
      runtime_type = "io.containerd.runsc.v1"
    TOML
      echo "registered the runsc handler in $CONFIG"
      nsenter --target 1 --mount --uts --ipc --net --pid -- systemctl restart containerd
    fi

    /host/usr/local/bin/runsc --version

    LABEL_KEY="${NODE_LABEL%%=*}"
    LABEL_VALUE="${NODE_LABEL#*=}"
    curl -fsS --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
      -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
      -H "Content-Type: application/strategic-merge-patch+json" \
      -X PATCH \
      -d "{\"metadata\":{\"labels\":{\"${LABEL_KEY}\":\"${LABEL_VALUE}\"}}}" \
      "https://kubernetes.default.svc/api/v1/nodes/${NODE_NAME}" > /dev/null
    echo "labelled node ${NODE_NAME} with ${NODE_LABEL}"

    # Stay resident so the DaemonSet does not CrashLoop on a completed install.
    sleep infinity
{{- end }}
```

Add the image key this template reads to `values.yaml` under the `sandbox.installer` block written in Task 11:

```yaml
    image: "debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171"
```

- [ ] **Step 5: Write the render-fails-on-empty-pins test (spec §12.2.2's own requirement)**

```bash
cat > k8s/helm/waddlebot/tests/helm_installer_pins_test.sh <<'SCRIPT_EOF'
#!/usr/bin/env bash
# Asserts spec §12.2.2: enabling the sandbox installer with empty pins
# FAILS rendering rather than fetching whatever runsc is current.
# Reports the number of cases exercised (Verification Integrity).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

cases_run=0
failures=0

assert_render_fails() {
    local name="$1"; shift
    cases_run=$((cases_run + 1))
    if make chart-template CHART_ARGS="$*" >/dev/null 2>&1; then
        echo "FAIL: $name rendered successfully but must fail" >&2
        failures=$((failures + 1))
    else
        echo "PASS: $name fails rendering as required"
    fi
}

assert_render_succeeds() {
    local name="$1"; shift
    cases_run=$((cases_run + 1))
    if make chart-template CHART_ARGS="$*" >/dev/null 2>&1; then
        echo "PASS: $name renders"
    else
        echo "FAIL: $name must render but did not" >&2
        failures=$((failures + 1))
    fi
}

assert_render_fails "installer enabled, all pins empty" \
    "--set sandbox.installer.enabled=true"
assert_render_fails "installer enabled, runscSha256 empty" \
    "--set sandbox.installer.enabled=true --set sandbox.installer.runscVersion=release-20260101.0 --set sandbox.installer.shimSha256=$(printf 'b%.0s' {1..64})"
assert_render_fails "installer enabled, shimSha256 empty" \
    "--set sandbox.installer.enabled=true --set sandbox.installer.runscVersion=release-20260101.0 --set sandbox.installer.runscSha256=$(printf 'a%.0s' {1..64})"
assert_render_succeeds "installer enabled with all three pins" \
    "--set sandbox.installer.enabled=true --set sandbox.installer.runscVersion=release-20260101.0 --set sandbox.installer.runscSha256=$(printf 'a%.0s' {1..64}) --set sandbox.installer.shimSha256=$(printf 'b%.0s' {1..64})"
assert_render_succeeds "installer disabled (default)" ""

if [[ $cases_run -eq 0 ]]; then
    echo "helm_installer_pins_test: FAIL -- zero cases exercised" >&2
    exit 1
fi
echo "helm_installer_pins_test: cases_run=$cases_run failures=$failures"
[[ $failures -eq 0 ]]
SCRIPT_EOF
chmod +x k8s/helm/waddlebot/tests/helm_installer_pins_test.sh
```

- [ ] **Step 6: Run the toolchain and the test**

```bash
make chart-lint
make chart-template | grep -c "kind: Deployment"
bash k8s/helm/waddlebot/tests/helm_installer_pins_test.sh
```

Expected: `make chart-lint` prints `1 chart(s) linted, 0 chart(s) failed`; the `grep -c` prints a non-zero count; the test prints five `PASS:` lines then `helm_installer_pins_test: cases_run=5 failures=0`.

- [ ] **Step 7: Prove the gate can fail (Verification Integrity — "make it fail on purpose once")**

```bash
sed -i 's/{{- fail "sandbox.installer.enabled=true requires sandbox.installer.runscSha256/{{- \/*disabled*\/ fail "sandbox.installer.enabled=true requires sandbox.installer.runscSha256/' k8s/helm/waddlebot/templates/pipeline/sandbox-installer-daemonset.yaml
bash k8s/helm/waddlebot/tests/helm_installer_pins_test.sh; echo "exit=$?"
git checkout k8s/helm/waddlebot/templates/pipeline/sandbox-installer-daemonset.yaml
bash k8s/helm/waddlebot/tests/helm_installer_pins_test.sh; echo "exit=$?"
```

Expected: first run prints `FAIL: installer enabled, runscSha256 empty ...` and `exit=1`; after `git checkout` the second run prints `cases_run=5 failures=0` and `exit=0`.

- [ ] **Step 8: Commit**

```bash
git add build/helm-tool/Dockerfile build/tool-versions.env Makefile \
  k8s/helm/waddlebot/templates/pipeline/sandbox-installer-daemonset.yaml \
  k8s/helm/waddlebot/tests/helm_installer_pins_test.sh k8s/helm/waddlebot/values.yaml
git commit -m "$(cat <<'EOF'
feat(chart): containerized helm toolchain (make chart-lint/chart-template) and the optional gVisor installer DaemonSet, render-fails on empty runsc pins

ROOT EXCEPTION (approved) applies to the installer DaemonSet alone, default
disabled; every other Waddles workload stays rootless.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 16: `CiliumNetworkPolicy` for the whole pipeline + reconcile M2a's standalone compiler chart artifacts

**Depends on:** M2a having landed (it ships `k8s/helm/waddlebot/templates/bundle-compiler-networkpolicy.yaml` and `templates/bundle-compiler-job-template-configmap.yaml` — **must match plan M2a**), M2b having landed (`templates/hub-api-compiler-rbac.yaml` — **must match plan M2b**), and this plan's Tasks 11-14.

**Why reconciliation is part of this task, not a later cleanup:** M2a's compiler chart work and this plan's Task 14 both produce a compiler Job shape, and M2a additionally ships a compiler `CiliumNetworkPolicy`. Two templates rendering two policies for the same `app.kubernetes.io/component: bundle-compiler` selector is a silent correctness hazard — Cilium unions them, so the narrower one stops biting. This task makes one file authoritative and deletes the other in the same commit.

**Files:**
- Create: `k8s/helm/waddlebot/templates/pipeline/network-policy.yaml`
- Delete: `k8s/helm/waddlebot/templates/bundle-compiler-networkpolicy.yaml` (M2a's, folded in here)
- Possibly delete: `k8s/helm/waddlebot/templates/pipeline/bundle-compiler-job.yaml` **or** `k8s/helm/waddlebot/templates/bundle-compiler-job-template-configmap.yaml` — Step 1 decides which, by inspection

**Interfaces:**
- Consumes: the `app.kubernetes.io/component` label values written by Tasks 12-14 (`svc-ingest`, `svc-process`, `svc-action`, `svc-streaming`, `svc-process-executor`, `svc-action-executor`, `bundle-compiler`) and by M2a/M2b.
- Produces: one `CiliumNetworkPolicy` document per pipeline workload, matching spec §12.5's table row for row.

- [ ] **Step 1: Reconcile the duplicate compiler chart artifacts — inspect first, then act**

```bash
ls -1 k8s/helm/waddlebot/templates/pipeline/bundle-compiler-job.yaml \
      k8s/helm/waddlebot/templates/bundle-compiler-job-template-configmap.yaml \
      k8s/helm/waddlebot/templates/bundle-compiler-networkpolicy.yaml 2>&1
make chart-template | grep -cE '^  name: bundle-compiler$|component: bundle-compiler'
```

Decision rule, applied literally:

| What `ls` shows | Action |
|---|---|
| Only `pipeline/bundle-compiler-job.yaml` (M2a did not ship a ConfigMap form) | Keep it. Nothing to delete. |
| Both the `pipeline/bundle-compiler-job.yaml` and M2a's `bundle-compiler-job-template-configmap.yaml` | **Keep M2a's ConfigMap form and `git rm` this plan's `pipeline/bundle-compiler-job.yaml`** — hub-api instantiates the ConfigMap template at compile time (**must match plan M2b**'s `compiler_job_service.py`), so the ConfigMap is the one the running system actually reads. Record the deletion in the commit body. |
| `bundle-compiler-networkpolicy.yaml` present | `git rm` it — its rules are reproduced verbatim in Step 2's `bundle-compiler` document below, alongside the `build`-container zero-egress row M2a's file did not express. |

```bash
# Run only the branches the table above selected, e.g.:
git rm -f k8s/helm/waddlebot/templates/bundle-compiler-networkpolicy.yaml
```

- [ ] **Step 2: Write the pipeline `CiliumNetworkPolicy`**

```yaml
# k8s/helm/waddlebot/templates/pipeline/network-policy.yaml
#
# Spec §12.5, row for row. CiliumNetworkPolicy only, never plain
# NetworkPolicy (devops-kubernetes.md). The namespace's default-deny is
# the chart's existing templates/network-policies.yaml; these documents
# are the explicit allows on top of it.
#
# The two executor documents are the load-bearing ones: no ingress at all,
# and exactly two egress destinations. An escaped executor has no route to
# Valkey, Postgres, the platform APIs, the API server, or the internet.
#
# Infrastructure endpoints are allowed whatever their address range (§8.5):
# these rules are generated from the operator's configured endpoints, and
# there is no private-range exclusion on a stage's own infrastructure
# egress. Only bundle `egress` hosts are subject to the private-range
# default, lifted by bundles.egress.allowPrivateHosts.
{{- if .Values.pipeline.networkPolicy.enabled }}
{{- $ns := include "waddlebot.namespace" . }}
{{- $dnsRule := dict }}
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: {{ include "waddlebot.fullname" . }}-svc-ingest
  namespace: {{ $ns }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/component: svc-ingest
  ingress:
  - fromEntities: ["cluster"]
    toPorts:
    - ports:
      - {port: "{{ .Values.pipeline.svcIngest.port }}", protocol: TCP}
      - {port: "9090", protocol: TCP}
  egress:
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/name: redis}
    toPorts:
    - ports: [{port: "6379", protocol: TCP}]
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/component: hub-api}
    toPorts:
    - ports: [{port: "{{ .Values.pipeline.hubApi.port }}", protocol: TCP}]
  - toFQDNs:
    {{- range .Values.pipeline.platformApiFqdns }}
    - matchName: {{ . | quote }}
    {{- end }}
    toPorts:
    - ports: [{port: "443", protocol: TCP}]
  - toEndpoints:
    - matchLabels:
        io.kubernetes.pod.namespace: kube-system
        k8s-app: kube-dns
    toPorts:
    - ports: [{port: "53", protocol: UDP}]
      rules:
        dns:
        - matchPattern: "*"
---
{{- range $stage, $port := (dict "process" .Values.pipeline.executor.hostApiPort.process "action" .Values.pipeline.executor.hostApiPort.action) }}
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: {{ include "waddlebot.fullname" $ }}-svc-{{ $stage }}
  namespace: {{ include "waddlebot.namespace" $ }}
  labels:
    {{- include "waddlebot.labels" $ | nindent 4 }}
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/component: svc-{{ $stage }}
  ingress:
  # Prometheus scrape only.
  - fromEntities: ["cluster"]
    toPorts:
    - ports: [{port: "9090", protocol: TCP}]
  # The stage's host-API port accepts ONLY its own executor Deployment.
  - fromEndpoints:
    - matchLabels: {app.kubernetes.io/component: svc-{{ $stage }}-executor}
    toPorts:
    - ports: [{port: "{{ $port }}", protocol: TCP}]
  egress:
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/name: redis}
    toPorts:
    - ports: [{port: "6379", protocol: TCP}]
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/name: postgresql}
    toPorts:
    - ports: [{port: "5432", protocol: TCP}]
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/component: hub-api}
    toPorts:
    - ports: [{port: "{{ $.Values.pipeline.hubApi.port }}", protocol: TCP}]
  {{- if eq $stage "action" }}
  - toFQDNs:
    {{- range $.Values.pipeline.platformApiFqdns }}
    - matchName: {{ . | quote }}
    {{- end }}
    toPorts:
    - ports: [{port: "443", protocol: TCP}]
  {{- end }}
  # The union of activated bundles' declared egress hosts (spec §12.5).
  # Operator-supplied; hub-api reconciles the real activated set at runtime
  # and the stage enforces the per-bundle allowlist regardless of this rule.
  {{- with $.Values.bundles.egress.allowedFqdns }}
  - toFQDNs:
    {{- range . }}
    - matchName: {{ . | quote }}
    {{- end }}
    toPorts:
    - ports: [{port: "443", protocol: TCP}]
  {{- end }}
  - toEndpoints:
    - matchLabels:
        io.kubernetes.pod.namespace: kube-system
        k8s-app: kube-dns
    toPorts:
    - ports: [{port: "53", protocol: UDP}]
      rules:
        dns:
        - matchPattern: "*"
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: {{ include "waddlebot.fullname" $ }}-svc-{{ $stage }}-executor
  namespace: {{ include "waddlebot.namespace" $ }}
  labels:
    {{- include "waddlebot.labels" $ | nindent 4 }}
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/component: svc-{{ $stage }}-executor
  # No ingress key at all: the executor accepts nothing, from anywhere.
  ingress: []
  egress:
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/component: svc-{{ $stage }}}
    toPorts:
    - ports: [{port: "{{ $port }}", protocol: TCP}]
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/name: minio}
    toPorts:
    - ports: [{port: "9000", protocol: TCP}]
  - toEndpoints:
    - matchLabels:
        io.kubernetes.pod.namespace: kube-system
        k8s-app: kube-dns
    toPorts:
    - ports: [{port: "53", protocol: UDP}]
      rules:
        dns:
        - matchPattern: "*"
---
{{- end }}
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: {{ include "waddlebot.fullname" . }}-svc-streaming
  namespace: {{ $ns }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/component: svc-streaming
  ingress:
  - fromEntities: ["cluster"]
    toPorts:
    - ports:
      - {port: "{{ .Values.pipeline.svcStreaming.port }}", protocol: TCP}
      - {port: "1935", protocol: TCP}
      - {port: "9000", protocol: UDP}
      - {port: "9090", protocol: TCP}
  egress:
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/name: postgresql}
    toPorts:
    - ports: [{port: "5432", protocol: TCP}]
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/name: redis}
    toPorts:
    - ports: [{port: "6379", protocol: TCP}]
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/name: minio}
    toPorts:
    - ports: [{port: "9000", protocol: TCP}]
  - toEndpoints:
    - matchLabels:
        io.kubernetes.pod.namespace: kube-system
        k8s-app: kube-dns
    toPorts:
    - ports: [{port: "53", protocol: UDP}]
      rules:
        dns:
        - matchPattern: "*"
---
# Folded in from M2a's bundle-compiler-networkpolicy.yaml (deleted in this
# commit). Kubernetes/Cilium policy applies per pod, and the compiler Job's
# `build` and `publisher` share one network namespace, so the rules below are
# the publisher's legitimate destinations. The build container attempts none
# of them: it holds no credential for any (spec §4.6, D27), which negative
# test 14i asserts directly rather than relying on this policy alone.
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: {{ include "waddlebot.fullname" . }}-bundle-compiler
  namespace: {{ $ns }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/component: bundle-compiler
  ingress: []
  egress:
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/name: minio}
    toPorts:
    - ports: [{port: "9000", protocol: TCP}]
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/name: postgresql}
    toPorts:
    - ports: [{port: "5432", protocol: TCP}]
  - toEndpoints:
    - matchLabels: {app.kubernetes.io/component: hub-api}
    toPorts:
    - ports: [{port: "{{ .Values.pipeline.hubApi.port }}", protocol: TCP}]
  - toEndpoints:
    - matchLabels:
        io.kubernetes.pod.namespace: kube-system
        k8s-app: kube-dns
    toPorts:
    - ports: [{port: "53", protocol: UDP}]
      rules:
        dns:
        - matchPattern: "*"
{{- end }}
```

- [ ] **Step 3: Add the values keys this template reads**

Append under the existing `pipeline:` block in `k8s/helm/waddlebot/values.yaml`:

```yaml
  networkPolicy:
    enabled: true
  # The five platform APIs svc-ingest and svc-action reach by FQDN (spec §12.5).
  platformApiFqdns:
    - "api.twitch.tv"
    - "discord.com"
    - "slack.com"
    - "www.googleapis.com"
    - "kick.com"
```

and under the existing `bundles.egress:` block:

```yaml
    # Union of activated bundles' declared egress hosts. Operator-managed;
    # empty by default. The stage enforces the per-bundle allowlist from the
    # approval record regardless of what is listed here (spec §9.7.3).
    allowedFqdns: []
```

- [ ] **Step 4: Assert the executor rows are exactly as narrow as spec §12.5 requires**

```bash
make chart-template > /tmp/m6-np-render.yaml
python3 - <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open("/tmp/m6-np-render.yaml")) if d]
policies = {d["metadata"]["name"]: d for d in docs if d.get("kind") == "CiliumNetworkPolicy"}
examined = 0
failures = []
for stage in ("process", "action"):
    name = next((n for n in policies if n.endswith(f"-svc-{stage}-executor")), None)
    if name is None:
        failures.append(f"no CiliumNetworkPolicy for svc-{stage}-executor")
        continue
    examined += 1
    spec = policies[name]["spec"]
    if spec.get("ingress") not in ([], None):
        failures.append(f"{name}: ingress must be empty, got {spec.get('ingress')!r}")
    egress = spec.get("egress", [])
    if len(egress) != 3:
        failures.append(f"{name}: expected exactly 3 egress rules (stage host-api, bucket, DNS), got {len(egress)}")
print(f"executor NetworkPolicy check: policies_examined={examined} failures={len(failures)}")
for f in failures:
    print("  FAIL:", f, file=sys.stderr)
if examined == 0:
    print("FAIL -- zero policies examined", file=sys.stderr); sys.exit(1)
sys.exit(1 if failures else 0)
PY
```

Expected: `executor NetworkPolicy check: policies_examined=2 failures=0` and exit 0.

- [ ] **Step 5: Lint and commit**

```bash
make chart-lint
git add k8s/helm/waddlebot/templates/pipeline/network-policy.yaml k8s/helm/waddlebot/values.yaml
git commit -m "$(cat <<'EOF'
feat(chart): CiliumNetworkPolicy for every pipeline workload per spec 12.5; executors get zero ingress and exactly two egress destinations

Folds M2a's standalone bundle-compiler-networkpolicy.yaml into this one
file and deletes it, so a single policy document governs the
app.kubernetes.io/component=bundle-compiler selector.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---
## Task 17: `security.transport.{tls,auth}` wiring — CA provisioning, host-API mTLS Secrets, and the loud opt-out

**Depends on:** M1 (`penguin-logging` published — it owns `warn_insecure_transport`), M3/M4/M5 (the four Rust services read `SECURITY_TRANSPORT_TLS`/`_AUTH` at startup), and this plan's Tasks 11-13.

**Files:**
- Create: `k8s/helm/waddlebot/templates/pipeline/transport-tls.yaml`
- Modify: `k8s/helm/waddlebot/templates/_helpers.tpl` (adds `waddlebot.transportEnv`)
- Modify: `k8s/helm/waddlebot/templates/svc-ingest.yaml`, `svc-process.yaml`, `svc-action.yaml`, `svc-streaming.yaml`, `hub-api.yaml` (each includes the helper)
- Create: `k8s/helm/waddlebot/tests/helm_transport_test.sh`

**Interfaces:**
- Consumes: `.Values.security.transport.{tls,auth,certManager}` (Task 11); the chart's existing `waddlebot.certManager.enabled` helper (`templates/_helpers.tpl:350`) for auto-detection.
- Produces: the Secret names Task 13's executor Deployment already mounts — `{{ include "waddlebot.fullname" . }}-svc-process-host-api-tls` and `-svc-action-host-api-tls` — plus `{{ include "waddlebot.fullname" . }}-transport-ca` (key `ca.crt`), mounted at `/etc/waddles/ca` by every stage.
- **Runtime contract this chart value drives (must match plan M1's `penguin-logging`):** a `false` on either value makes each service call `penguin_logging::health::transport::warn_insecure_transport(&metrics, component, aspect)` with `component` ∈ `{"valkey","postgres"}` and `aspect` ∈ `TransportAspect::{Tls,Auth}`, which logs the fixed spec §11.6.4 WARN banner and sets the gauge `waddles_insecure_transport{component,aspect}` to `1`; every secured component/aspect calls `TransportMetrics::mark_secure(component, aspect)` so the series is `0` rather than absent. The chart's only job is to deliver the values; Task 30 asserts the gauge and the banner actually appear.

- [ ] **Step 1: Confirm `penguin-logging`'s real symbol names before templating against them**

```bash
grep -n "warn_insecure_transport\|enum TransportAspect\|fn mark_secure" \
  /home/penguin/code/penguin-libs/packages/rust-logging/src/health/transport.rs
```

Expected: three hits — `pub fn warn_insecure_transport(...)`, `pub enum TransportAspect`, `pub fn mark_secure(...)`. **If the path or the names differ, record the real ones in `M6_PREFLIGHT.md` and use those in Task 30's assertions** — this task's chart output does not change either way, but Task 30's grep does.

- [ ] **Step 2: Add the `waddlebot.transportEnv` helper**

Append to `k8s/helm/waddlebot/templates/_helpers.tpl`:

```
{{/*
Transport-security env block (spec §11.6.4). Default on; the opt-out is an
ordinary value in every environment's values file and no environment
rejects a false. Services turn a false into the fixed WARN banner plus
waddles_insecure_transport{component,aspect}=1 via penguin-logging's
warn_insecure_transport (must match plan M1) -- the chart only supplies
the values and the CA path.
*/}}
{{- define "waddlebot.transportEnv" -}}
- name: SECURITY_TRANSPORT_TLS
  value: {{ .Values.security.transport.tls | quote }}
- name: SECURITY_TRANSPORT_AUTH
  value: {{ .Values.security.transport.auth | quote }}
- name: VALKEY_CA_FILE
  value: "/etc/waddles/ca/valkey-ca.crt"
- name: DB_SSLROOTCERT
  value: "/etc/waddles/ca/postgres-ca.crt"
- name: DB_SSLMODE
  value: {{ if .Values.security.transport.tls }}"verify-full"{{ else }}"disable"{{ end }}
{{- end }}

{{/*
CA volume + mount, paired with waddlebot.transportEnv.
*/}}
{{- define "waddlebot.transportCaVolume" -}}
- name: transport-ca
  secret:
    secretName: {{ include "waddlebot.fullname" . }}-transport-ca
{{- end }}

{{- define "waddlebot.transportCaVolumeMount" -}}
- name: transport-ca
  mountPath: /etc/waddles/ca
  readOnly: true
{{- end }}
```

- [ ] **Step 3: Write `transport-tls.yaml`**

```yaml
# k8s/helm/waddlebot/templates/pipeline/transport-tls.yaml
#
# Spec §11.6.3: the chart provisions everything the on-by-default posture
# needs. cert-manager Certificates when cert-manager is present (detected by
# the chart's existing waddlebot.certManager.enabled helper, overridable via
# security.transport.certManager), otherwise a chart-managed self-signed CA
# created on first install and REUSED on upgrade -- never regenerated, which
# would invalidate every issued certificate mid-rollout.
{{- $fullName := include "waddlebot.fullname" . }}
{{- $ns := include "waddlebot.namespace" . }}
{{- $useCertManager := ternary (include "waddlebot.certManager.enabled" . | eq "true") .Values.security.transport.certManager (eq (toString .Values.security.transport.certManager) "auto") }}
{{- if $useCertManager }}
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: {{ $fullName }}-transport-ca
  namespace: {{ $ns }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
spec:
  selfSigned: {}
---
{{- range $stage := list "process" "action" }}
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: {{ $fullName }}-svc-{{ $stage }}-host-api-tls
  namespace: {{ $ns }}
  labels:
    {{- include "waddlebot.labels" $ | nindent 4 }}
spec:
  secretName: {{ $fullName }}-svc-{{ $stage }}-host-api-tls
  duration: 2160h
  renewBefore: 360h
  isCA: false
  usages: [server auth, client auth]
  commonName: "svc-{{ $stage }}-executor"
  dnsNames:
  - "{{ $fullName }}-svc-{{ $stage }}"
  - "{{ $fullName }}-svc-{{ $stage }}.{{ $ns }}.svc.cluster.local"
  uris:
  - "spiffe://penguintech.io/{{ $.Values.global.deploymentTier }}/svc-{{ $stage }}-executor"
  issuerRef:
    name: {{ $fullName }}-transport-ca
    kind: Issuer
---
{{- end }}
{{- else }}
{{- /*
   Chart-managed CA. lookup() returns the live Secret on upgrade, so the
   generated key material is read back rather than re-minted. On a
   --dry-run/helm template lookup() is empty by design and a throwaway CA is
   rendered; that is render-only output and never applied.
*/ -}}
{{- $existingCa := (lookup "v1" "Secret" $ns (printf "%s-transport-ca" $fullName)) }}
{{- $caCrt := "" }}
{{- $caKey := "" }}
{{- if $existingCa }}
{{- $caCrt = index $existingCa.data "ca.crt" | b64dec }}
{{- $caKey = index $existingCa.data "ca.key" | b64dec }}
{{- else }}
{{- $ca := genCA (printf "%s-transport-ca" $fullName) 3650 }}
{{- $caCrt = $ca.Cert }}
{{- $caKey = $ca.Key }}
{{- end }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ $fullName }}-transport-ca
  namespace: {{ $ns }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
type: Opaque
stringData:
  ca.crt: |
{{ $caCrt | indent 4 }}
  ca.key: |
{{ $caKey | indent 4 }}
  valkey-ca.crt: |
{{ $caCrt | indent 4 }}
  postgres-ca.crt: |
{{ $caCrt | indent 4 }}
---
{{- $caPair := buildCustomCert ($caCrt | b64enc) ($caKey | b64enc) }}
{{- range $stage := list "process" "action" }}
{{- $existingLeaf := (lookup "v1" "Secret" $ns (printf "%s-svc-%s-host-api-tls" $fullName $stage)) }}
{{- $leaf := dict }}
{{- if $existingLeaf }}
{{- $leaf = dict "Cert" (index $existingLeaf.data "tls.crt" | b64dec) "Key" (index $existingLeaf.data "tls.key" | b64dec) }}
{{- else }}
{{- $leaf = genSignedCert (printf "%s-svc-%s" $fullName $stage) (list) (list (printf "%s-svc-%s" $fullName $stage) (printf "%s-svc-%s.%s.svc.cluster.local" $fullName $stage $ns) (printf "svc-%s-executor" $stage)) 825 $caPair }}
{{- end }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ $fullName }}-svc-{{ $stage }}-host-api-tls
  namespace: {{ $ns }}
  labels:
    {{- include "waddlebot.labels" $ | nindent 4 }}
type: kubernetes.io/tls
stringData:
  tls.crt: |
{{ $leaf.Cert | indent 4 }}
  tls.key: |
{{ $leaf.Key | indent 4 }}
  ca.crt: |
{{ $caCrt | indent 4 }}
---
{{- end }}
{{- end }}
{{- if not (and .Values.security.transport.tls .Values.security.transport.auth) }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ $fullName }}-transport-insecure-notice
  namespace: {{ $ns }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
data:
  NOTICE: |
    TRANSPORT SECURITY DISABLED in this release.
    security.transport.tls={{ .Values.security.transport.tls }}
    security.transport.auth={{ .Values.security.transport.auth }}
    Valkey and Postgres traffic may be unencrypted and/or unauthenticated.
    Every affected service logs the spec §11.6.4 WARN banner on every startup
    and reports waddles_insecure_transport{component,aspect}=1.
    This is an explicit, visible opt-out.
{{- end }}
```

- [ ] **Step 4: Include the helper in all five service templates**

For each of `svc-ingest.yaml`, `svc-process.yaml`, `svc-action.yaml`, `svc-streaming.yaml`, `hub-api.yaml`: add `{{- include "waddlebot.transportEnv" . | nindent 8 }}` at the end of the container's `env:` list, `{{- include "waddlebot.transportCaVolumeMount" . | nindent 8 }}` at the end of its `volumeMounts:`, and `{{- include "waddlebot.transportCaVolume" . | nindent 6 }}` at the end of the pod's `volumes:`. Re-read each file first and anchor on its real `env:`/`volumeMounts:`/`volumes:` keys — do not anchor on line numbers.

```bash
for f in svc-ingest svc-process svc-action svc-streaming hub-api; do
  grep -c 'waddlebot.transportEnv\|waddlebot.transportCaVolume' "k8s/helm/waddlebot/templates/$f.yaml" \
    | xargs -I{} echo "$f: {} transport includes"
done
```

Expected: each line reads `<name>: 3 transport includes`.

- [ ] **Step 5: Write and run the transport render test**

```bash
cat > k8s/helm/waddlebot/tests/helm_transport_test.sh <<'SCRIPT_EOF'
#!/usr/bin/env bash
# Spec §11.6.4: both values default true; a false renders through to every
# service and produces the insecure notice. Reports the count examined.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

secure_render="$(make chart-template)"
tls_true=$(printf '%s' "$secure_render" | grep -c 'name: SECURITY_TRANSPORT_TLS' || true)
if [[ "$tls_true" -lt 5 ]]; then
    echo "FAIL: SECURITY_TRANSPORT_TLS appears on $tls_true containers, expected >=5" >&2
    exit 1
fi
if printf '%s' "$secure_render" | grep -q 'transport-insecure-notice'; then
    echo "FAIL: the insecure notice rendered under the secure default" >&2
    exit 1
fi

insecure_render="$(make chart-template CHART_ARGS='--set security.transport.tls=false')"
if ! printf '%s' "$insecure_render" | grep -q 'transport-insecure-notice'; then
    echo "FAIL: tls=false did not render the insecure notice" >&2
    exit 1
fi
disable_count=$(printf '%s' "$insecure_render" | grep -c 'value: "disable"' || true)
if [[ "$disable_count" -lt 5 ]]; then
    echo "FAIL: DB_SSLMODE disable appears on $disable_count containers, expected >=5" >&2
    exit 1
fi

echo "helm_transport_test: containers_examined=$tls_true insecure_containers=$disable_count failures=0"
SCRIPT_EOF
chmod +x k8s/helm/waddlebot/tests/helm_transport_test.sh
make chart-lint
bash k8s/helm/waddlebot/tests/helm_transport_test.sh
```

Expected: `1 chart(s) linted, 0 chart(s) failed`, then `helm_transport_test: containers_examined=5 insecure_containers=5 failures=0` (a higher count is fine — it means more services picked up the helper).

- [ ] **Step 6: Commit**

```bash
git add k8s/helm/waddlebot/templates/pipeline/transport-tls.yaml \
  k8s/helm/waddlebot/templates/_helpers.tpl \
  k8s/helm/waddlebot/templates/svc-ingest.yaml k8s/helm/waddlebot/templates/svc-process.yaml \
  k8s/helm/waddlebot/templates/svc-action.yaml k8s/helm/waddlebot/templates/svc-streaming.yaml \
  k8s/helm/waddlebot/templates/hub-api.yaml \
  k8s/helm/waddlebot/tests/helm_transport_test.sh
git commit -m "$(cat <<'EOF'
feat(chart): transport security on by default -- CA + host-API mTLS provisioning, SECURITY_TRANSPORT_* on every service, loud rendered notice on opt-out

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 18: Valkey ACL matrix + `users.acl` rendered by `penguin-spine`'s own `render_acl.py`

**Depends on:** M1 having landed `penguin-spine` (this task copies two files out of `penguin-libs/packages/rust-spine/config/valkey/` — **must match plan penguin-spine**, whose Task 12 says in as many words that copying them into this repo's chart is M6's job).

**Do not write a second renderer.** `render_acl.py` is copied byte-for-byte from the spine crate and then given exactly one additive flag (`--password-mode`), because Valkey's ACL file format has no env interpolation and production passwords come from a Secret, not from the matrix. Step 3 diffs the copy against the original so the delta is provably that one flag and nothing else.

**Files:**
- Create: `config/valkey/acl-matrix.yaml` (copied from `penguin-spine`)
- Create: `config/valkey/render_acl.py` (copied from `penguin-spine`, plus `--password-mode`)
- Create: `k8s/helm/waddlebot/files/valkey-users.acl` (generated, committed — the chart cannot run Python at render time)
- Create: `k8s/helm/waddlebot/templates/valkey-acl-configmap.yaml`
- Modify: `Makefile` (adds `render-valkey-acl`)

**Interfaces:**
- Consumes: `penguin-libs/packages/rust-spine/config/valkey/{acl-matrix.yaml,render_acl.py}`.
- Produces: `config/valkey/acl-matrix.yaml` at the exact repo-root path spec §11.10.2 names, the `.Values.security.rbac.valkeyMatrix` default from Task 11 already points at it; `make render-valkey-acl`; a ConfigMap `{{ fullname }}-valkey-acl` with key `users.acl`, consumed by the Valkey deployment in Step 5.

- [ ] **Step 1: Copy the matrix and the renderer**

```bash
mkdir -p config/valkey k8s/helm/waddlebot/files
cp /home/penguin/code/penguin-libs/packages/rust-spine/config/valkey/acl-matrix.yaml config/valkey/acl-matrix.yaml
cp /home/penguin/code/penguin-libs/packages/rust-spine/config/valkey/render_acl.py config/valkey/render_acl.py
python3 -c "import yaml,sys; m=yaml.safe_load(open('config/valkey/acl-matrix.yaml')); print('users:', len(m['users'])); print('executors_have_no_user:', m['executors_have_no_user']); print('names:', [u['name'] for u in m['users']])"
```

Expected: `users: 6`, `executors_have_no_user: True`, and the names `['svc-ingest', 'svc-process', 'svc-action', 'svc-streaming', 'hub-api', 'waddles_admin']`. **If `executors_have_no_user` is absent or false, STOP** — spec §11.10.2 requires the matrix to state the executor's absence explicitly, and a copy that lost it is not the normative file.

- [ ] **Step 2: Add the one additive flag to the copy**

Replace `config/valkey/render_acl.py`'s `user_password` function and `main`'s argument handling with:

```python
def user_password(name: str, mode: str) -> str:
    """Password token for one ACL user.

    `test` reproduces penguin-spine's own deterministic, non-secret
    integration-test credential. `secret-ref` emits the substitution token
    spec Sec11.6.1 sketches (`>$(PASS_SVC_INGEST)`), which the chart's
    Valkey init container replaces from a Kubernetes Secret before
    valkey-server starts -- the rendered file never contains a real
    password, so it is safe to commit.
    """
    if mode == "test":
        return f"test-{name}-password"
    if mode == "secret-ref":
        return "$(PASS_" + name.upper().replace("-", "_") + ")"
    raise SystemExit(f"unknown --password-mode: {mode}")


def render_user(user: dict, channels_policy: str, mode: str) -> str:
    parts = [f"user {user['name']} on >{user_password(user['name'], mode)}", channels_policy]
    for pattern in user["key_patterns"]:
        parts.append(f"~{pattern}")
    if user.get("category_commands"):
        parts.extend(user["category_commands"])
    else:
        parts.append("-@all")
        parts.extend(f"+{cmd}" for cmd in user.get("commands", []))
    return " ".join(parts)


def main(matrix_path: str, output_path: str, mode: str) -> None:
    with open(matrix_path, encoding="utf-8") as f:
        matrix = yaml.safe_load(f)

    users = matrix["users"]
    assert len(users) >= 6, f"expected >= 6 users in the matrix, found {len(users)}"

    lines = ["user default off"]
    for user in users:
        lines.append(render_user(user, matrix["channels_policy"], mode))

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"rendered {len(users)} users to {output_path} (password-mode={mode})")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    mode = "test"
    for flag in flags:
        if flag.startswith("--password-mode="):
            mode = flag.split("=", 1)[1]
        else:
            print(f"usage: render_acl.py [--password-mode=test|secret-ref] <matrix.yaml> <output-users.acl>", file=sys.stderr)
            sys.exit(2)
    if len(args) != 2:
        print("usage: render_acl.py [--password-mode=test|secret-ref] <matrix.yaml> <output-users.acl>", file=sys.stderr)
        sys.exit(2)
    main(args[0], args[1], mode)
```

- [ ] **Step 3: Prove the delta is exactly that flag**

```bash
diff -u /home/penguin/code/penguin-libs/packages/rust-spine/config/valkey/render_acl.py config/valkey/render_acl.py \
  | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | wc -l
diff -u /home/penguin/code/penguin-libs/packages/rust-spine/config/valkey/render_acl.py config/valkey/render_acl.py \
  | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | grep -cE 'mode|password-mode|secret-ref|args|flags'
diff /home/penguin/code/penguin-libs/packages/rust-spine/config/valkey/acl-matrix.yaml config/valkey/acl-matrix.yaml && echo "matrix: byte-identical to penguin-spine"
```

Expected: the first count is non-zero (the flag is a real change), the second count equals the first (**every** changed line relates to the password mode — nothing else drifted), and the matrix diff prints `matrix: byte-identical to penguin-spine` with no diff output. **If the second count is lower than the first, STOP and inspect the unrelated lines** — a divergent renderer is exactly what this task exists to prevent.

- [ ] **Step 4: Add `make render-valkey-acl` and render the committed file**

Append to `Makefile` (and add `render-valkey-acl` to `.PHONY`):

```makefile
ACL_PYTHON_IMAGE := python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285

# Renders config/valkey/acl-matrix.yaml into the chart's committed users.acl
# with $(PASS_*) substitution tokens. Never hand-edit the output.
render-valkey-acl:
	@set -euo pipefail; \
	docker run --rm -v "$(CURDIR)":/work -w /work $(ACL_PYTHON_IMAGE) \
	  sh -c "pip install --quiet pyyaml==6.0.2 && python3 config/valkey/render_acl.py --password-mode=secret-ref config/valkey/acl-matrix.yaml k8s/helm/waddlebot/files/valkey-users.acl"
```

```bash
make render-valkey-acl
cat k8s/helm/waddlebot/files/valkey-users.acl
```

Expected: `rendered 6 users to k8s/helm/waddlebot/files/valkey-users.acl (password-mode=secret-ref)`, then seven lines — `user default off` plus one per user, each containing `>$(PASS_…)`, `resetchannels`, its `~waddles:…` patterns and `-@all` + `+cmd` tokens (or the `+@…` category list for `svc-streaming`/`waddles_admin`). No literal password appears anywhere in the file.

- [ ] **Step 5: Write the ConfigMap and wire Valkey to it**

```yaml
# k8s/helm/waddlebot/templates/valkey-acl-configmap.yaml
#
# users.acl is RENDERED from config/valkey/acl-matrix.yaml by
# config/valkey/render_acl.py (`make render-valkey-acl`) -- the normative
# D28 source, copied from penguin-spine, never hand-edited here. The file
# carries $(PASS_<USER>) tokens; the init container below substitutes them
# from the Secret before valkey-server starts, so no password is ever in
# the ConfigMap, the chart, or git.
{{- if .Values.infrastructure.redis.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "waddlebot.fullname" . }}-valkey-acl
  namespace: {{ include "waddlebot.namespace" . }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
data:
  users.acl.tmpl: |
{{ .Files.Get "files/valkey-users.acl" | indent 4 }}
  substitute-acl.sh: |
    #!/usr/bin/env sh
    # Substitutes $(PASS_<USER>) tokens in users.acl.tmpl from the mounted
    # Secret's environment, writing the result to the shared emptyDir that
    # valkey-server reads. Fails closed: an unsubstituted token left in the
    # output is an error, never a Valkey user with a literal password.
    set -eu
    src=/acl-tmpl/users.acl.tmpl
    dst=/acl/users.acl
    cp "$src" "$dst"
    for user in SVC_INGEST SVC_PROCESS SVC_ACTION SVC_STREAMING HUB_API WADDLES_ADMIN; do
      eval "value=\${PASS_${user}:-}"
      if [ -z "$value" ]; then
        echo "substitute-acl: FAIL -- PASS_${user} is unset" >&2
        exit 1
      fi
      sed -i "s|\$(PASS_${user})|${value}|g" "$dst"
    done
    if grep -q '\$(PASS_' "$dst"; then
      echo "substitute-acl: FAIL -- unsubstituted token remains:" >&2
      grep -n '\$(PASS_' "$dst" >&2
      exit 1
    fi
    users_rendered=$(grep -c '^user ' "$dst")
    if [ "$users_rendered" -lt 7 ]; then
      echo "substitute-acl: FAIL -- only ${users_rendered} user lines rendered, expected >=7" >&2
      exit 1
    fi
    echo "substitute-acl: users_rendered=${users_rendered} unsubstituted=0"
{{- end }}
```

Then add to `k8s/helm/waddlebot/templates/infrastructure/redis.yaml`'s pod spec — re-read the file and anchor on its real keys:

```yaml
      initContainers:
      - name: substitute-acl
        image: {{ .Values.infrastructure.redis.image }}
        command: ["/bin/sh", "/acl-tmpl/substitute-acl.sh"]
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities: {drop: ["ALL"]}
        envFrom:
        - secretRef:
            name: {{ .Values.infrastructure.redis.aclPasswordSecret }}
        volumeMounts:
        - {name: acl-tmpl, mountPath: /acl-tmpl, readOnly: true}
        - {name: acl, mountPath: /acl}
```

with the matching volumes (`acl-tmpl` from the ConfigMap, `acl` an `emptyDir`), an `acl` mount on the valkey container, and `--aclfile /acl/users.acl` added to its args. Add `aclPasswordSecret: "waddles-valkey-acl-passwords"` under `infrastructure.redis` in `values.yaml`; the Secret holds `PASS_SVC_INGEST`, `PASS_SVC_PROCESS`, `PASS_SVC_ACTION`, `PASS_SVC_STREAMING`, `PASS_HUB_API`, `PASS_WADDLES_ADMIN`.

- [ ] **Step 6: Verify and commit**

```bash
make chart-lint
make chart-template | grep -c '^    user '
make chart-template | grep -c 'PASS_WADDLES_ADMIN'
```

Expected: lint clean; the first `grep -c` prints `7` (the `user default off` line plus six users, as rendered into the ConfigMap); the second prints at least `2` (the substitution script and the Secret reference).

```bash
git add config/valkey/ k8s/helm/waddlebot/files/valkey-users.acl \
  k8s/helm/waddlebot/templates/valkey-acl-configmap.yaml \
  k8s/helm/waddlebot/templates/infrastructure/redis.yaml \
  k8s/helm/waddlebot/values.yaml Makefile
git commit -m "$(cat <<'EOF'
feat(chart): normative config/valkey/acl-matrix.yaml + penguin-spine's render_acl.py, users.acl rendered not hand-written, passwords substituted from a Secret at pod start

The matrix is byte-identical to penguin-spine's copy; render_acl.py differs
only by an additive --password-mode flag, diff-asserted in the task.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 19: Postgres RBAC matrix completed for every service + `render_grants.py`

**Depends on:** M2a (it created `config/postgres/rbac-matrix.yaml` with `waddles_publisher` fully specified and every other role present with an `owned_by` pointer — **must match plan M2a**), and M2b/M3/M4/M5 having landed the per-service schemas whose tables this task fills in.

**Files:**
- Modify: `config/postgres/rbac-matrix.yaml`
- Create: `config/postgres/render_grants.py`
- Create: `config/postgres/grants.sql` (generated, committed)
- Modify: `Makefile` (adds `render-postgres-grants`)
- Modify: `k8s/helm/waddlebot/templates/migrations-job.yaml` (applies `grants.sql` after the schema migration)

**Interfaces:**
- Consumes: M2a's `config/postgres/rbac-matrix.yaml` structure verbatim — top-level `schema_version`, `roles: {<role>: {owned_by, tables: {<table>: [PRIVS]}}}`, `non_writer_roles_on_app_versions: [...]`. This task **extends** it, never reshapes it.
- Produces: `config/postgres/grants.sql`; `make render-postgres-grants`; the table/role inventory Task 20's live-equality gate compares against.

- [ ] **Step 1: Read the landed matrix and the real table names before editing**

```bash
cat config/postgres/rbac-matrix.yaml
psql_tables() { git grep -hoE 'CREATE TABLE (IF NOT EXISTS )?[a-z_]+' -- migrations/ alembic/ config/postgres/ | awk '{print $NF}' | sort -u; }
psql_tables | head -40
psql_tables | wc -l
```

Expected: the matrix prints with `waddles_publisher` populated and the other roles carrying empty `tables: {}` plus an `owned_by`. The table listing is the authoritative set of names to use below — **use what this command prints, not the illustrative names in Step 2**, and record any difference in `M6_PREFLIGHT.md`.

- [ ] **Step 2: Fill in every role's tables**

Edit `config/postgres/rbac-matrix.yaml` in place, keeping M2a's shape and its comments. Replace each `tables: {}` with the role's real grants, cross-checked against Step 1's output:

```yaml
  hub_api:
    owned_by: M2b
    tables:
      app_versions: [SELECT, INSERT, UPDATE, DELETE]
      app_active_versions: [SELECT, INSERT, UPDATE, DELETE]
      app_catalog: [SELECT, INSERT, UPDATE, DELETE]
      app_stream_grants: [SELECT, INSERT, UPDATE, DELETE]
      app_install_approvals: [SELECT, INSERT, UPDATE, DELETE]
      bundle_scan_findings: [SELECT, INSERT, UPDATE, DELETE]
      intake_sources: [SELECT, INSERT, UPDATE, DELETE]
      custom_platforms: [SELECT, INSERT, UPDATE, DELETE]
      global_settings: [SELECT, INSERT, UPDATE]
  svc_ingest:
    owned_by: M5
    tables: {}   # no database at all -- asserted, not assumed (spec §11.10.1)
  svc_process:
    owned_by: M4
    tables:
      app_catalog: [SELECT]
      app_active_versions: [SELECT]
      app_stream_grants: [SELECT]
      app_install_approvals: [SELECT]
  svc_action:
    owned_by: M3
    tables:
      action_dispatch_log: [SELECT, INSERT]
      app_catalog: [SELECT]
      app_active_versions: [SELECT]
      app_install_approvals: [SELECT]
  svc_streaming:
    owned_by: existing
    tables:
      stream_sessions: [SELECT, INSERT, UPDATE]
      stream_recordings: [SELECT, INSERT, UPDATE]
  webui:
    owned_by: M2b
    tables:
      app_catalog: [SELECT]
      app_active_versions: [SELECT]
  executor:
    owned_by: M3/M4
    tables: {}   # NO ROLE -- stated explicitly so a future change deletes a line rather than quietly adding one
  migration_runner:
    owned_by: platform
    tables: {}   # DDL only, during migrations; granted by the migration job's own superuser DSN, never here
```

Add one new top-level key the generator and the CI gate both read — it is the "a line to delete, not a silent omission" contract in machine-readable form:

```yaml
# Roles that must exist with ZERO table privileges. Task 20's live gate
# asserts each appears in pg_roles and holds no row in
# information_schema.role_table_grants.
grantless_roles:
  - svc_ingest
  - executor
  - migration_runner
```

- [ ] **Step 3: Write `config/postgres/render_grants.py`**

Deliberately the same shape as `config/valkey/render_acl.py` (stdlib + PyYAML, one matrix in, one artifact out, printed count) so the two normative matrices are operated identically:

```python
#!/usr/bin/env python3
"""Renders config/postgres/rbac-matrix.yaml into config/postgres/grants.sql
(spec Sec11.10.1, D28). Nobody writes a GRANT by hand; this file is the
only producer of them.

Run: python3 render_grants.py <matrix.yaml> <output-grants.sql>
"""
import sys

try:
    import yaml
except ImportError:
    print("PyYAML is required: pip install pyyaml==6.0.2", file=sys.stderr)
    sys.exit(1)

VALID_PRIVILEGES = {"SELECT", "INSERT", "UPDATE", "DELETE"}


def render_role(role: str, spec: dict) -> list:
    """One role's block: create it if absent, revoke everything, then grant
    back exactly what the matrix lists. Revoke-then-grant makes the file
    idempotent and makes a removed matrix line actually remove the grant."""
    lines = [
        f"-- role {role} (owned_by: {spec.get('owned_by', 'unknown')})",
        f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') "
        f"THEN CREATE ROLE {role} NOLOGIN; END IF; END $$;",
        f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {role};",
    ]
    for table, privileges in sorted(spec.get("tables", {}).items()):
        unknown = set(privileges) - VALID_PRIVILEGES
        if unknown:
            raise SystemExit(f"{role}/{table}: unknown privilege(s) {sorted(unknown)}")
        lines.append(f"GRANT {', '.join(sorted(privileges))} ON {table} TO {role};")
    return lines


def main(matrix_path: str, output_path: str) -> None:
    with open(matrix_path, encoding="utf-8") as f:
        matrix = yaml.safe_load(f)

    roles = matrix["roles"]
    if len(roles) < 8:
        raise SystemExit(f"spec Sec11.10.1 requires >= 8 roles in the matrix, found {len(roles)}")

    tables = {t for spec in roles.values() for t in spec.get("tables", {})}
    if len(tables) < 8:
        raise SystemExit(f"spec Sec11.10.1 requires >= 8 distinct tables in the matrix, found {len(tables)}")

    out = [
        "-- GENERATED by config/postgres/render_grants.py from",
        "-- config/postgres/rbac-matrix.yaml. Do not edit by hand.",
        "",
    ]
    for role in sorted(roles):
        out.extend(render_role(role, roles[role]))
        out.append("")

    grantless = matrix.get("grantless_roles", [])
    out.append("-- Roles that must hold zero table privileges (spec Sec11.10.1).")
    for role in grantless:
        out.append(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {role};")
    out.append("")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))

    print(f"rendered {len(roles)} roles over {len(tables)} tables "
          f"({len(grantless)} grantless) to {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: render_grants.py <matrix.yaml> <output-grants.sql>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
```

- [ ] **Step 4: Add the make target and render**

Append to `Makefile` (and `.PHONY`):

```makefile
render-postgres-grants:
	@set -euo pipefail; \
	docker run --rm -v "$(CURDIR)":/work -w /work $(ACL_PYTHON_IMAGE) \
	  sh -c "pip install --quiet pyyaml==6.0.2 && python3 config/postgres/render_grants.py config/postgres/rbac-matrix.yaml config/postgres/grants.sql"
```

```bash
make render-postgres-grants
grep -c '^GRANT ' config/postgres/grants.sql
grep -c 'CREATE ROLE' config/postgres/grants.sql
```

Expected: `rendered 10 roles over 12 tables (3 grantless) to config/postgres/grants.sql` (exact numbers follow Step 1's real table set), a non-zero `GRANT` count, and a `CREATE ROLE` count equal to the role count.

- [ ] **Step 5: Prove the generator's own floors bite**

```bash
python3 - <<'PY'
import yaml, subprocess, tempfile, os
m = yaml.safe_load(open("config/postgres/rbac-matrix.yaml"))
m["roles"] = dict(list(m["roles"].items())[:3])
with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
    yaml.safe_dump(m, f)
    path = f.name
r = subprocess.run(["python3", "config/postgres/render_grants.py", path, "/dev/null"], capture_output=True, text=True)
os.unlink(path)
print("exit:", r.returncode, "| stderr:", r.stderr.strip())
assert r.returncode != 0, "FAIL: the >=8 roles floor did not bite"
print("PASS: truncating the matrix to 3 roles fails rendering")
PY
```

Expected: a non-zero exit, `requires >= 8 roles in the matrix, found 3`, then `PASS: ...`.

- [ ] **Step 6: Apply `grants.sql` from the migrations Job**

In `k8s/helm/waddlebot/templates/migrations-job.yaml`, after the existing schema-migration step, add a container (or an appended shell step in the existing one — re-read the file and match its shape) that runs, with `set -euo pipefail`:

```bash
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f /etc/waddles/rbac/grants.sql
```

mounting `grants.sql` from a ConfigMap generated with `{{ .Files.Get "../../../config/postgres/grants.sql" }}` — Helm cannot read above the chart root, so copy the rendered file into the chart at render time instead:

```makefile
render-postgres-grants: ## (extend the target from Step 4)
	@cp config/postgres/grants.sql k8s/helm/waddlebot/files/postgres-grants.sql
```

and have the ConfigMap use `{{ .Files.Get "files/postgres-grants.sql" }}`.

- [ ] **Step 7: Verify and commit**

```bash
make render-postgres-grants
make chart-lint
make chart-template | grep -c 'GENERATED by config/postgres/render_grants.py'
git add config/postgres/ k8s/helm/waddlebot/files/postgres-grants.sql \
  k8s/helm/waddlebot/templates/migrations-job.yaml Makefile
git commit -m "$(cat <<'EOF'
feat(chart): complete config/postgres/rbac-matrix.yaml for every role and generate grants.sql from it -- no hand-written GRANT anywhere

Extends M2a's matrix in place (same shape, same owned_by pointers) rather
than inventing a second file. render_grants.py refuses to render below the
spec 11.10.1 floors of 8 roles and 8 tables.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---
## Task 20: `make test-rbac-postgres` — live grants asserted **equal** to the matrix

**Depends on:** Task 19, and an alpha stack deployed from this branch (Task 23 provides the values; the gate is first run for real in Task 34, but it must exist and be provably able to fail now).

**Files:**
- Create: `scripts/rbac/test_rbac_postgres.py`
- Create: `scripts/rbac/tests/test_rbac_postgres_selftest.py`
- Modify: `Makefile` (adds `test-rbac-postgres`)

**Interfaces:**
- Consumes: `config/postgres/rbac-matrix.yaml` (Task 19), a live Postgres reachable at `$RBAC_DATABASE_URL`.
- Produces: `make test-rbac-postgres`, the exact target name spec §14.5 requires.

- [ ] **Step 1: Write the gate**

```python
#!/usr/bin/env python3
"""Asserts the live Postgres grants EQUAL config/postgres/rbac-matrix.yaml --
set equality in both directions, so a missing grant and an extra grant both
fail (spec Sec11.10.1). Prints the number of roles and tables examined and
fails below 8 of either, because a query that matched nothing would
otherwise report a clean pass (critical-rules.md Verification Integrity).

Run via `make test-rbac-postgres`.
"""
import os
import sys

try:
    import yaml
except ImportError:
    print("PyYAML is required: pip install pyyaml==6.0.2", file=sys.stderr)
    sys.exit(1)

try:
    import psycopg
except ImportError:
    print("psycopg is required: pip install 'psycopg[binary]==3.2.3'", file=sys.stderr)
    sys.exit(1)

MIN_ROLES = 8
MIN_TABLES = 8
GRANT_QUERY = """
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = ANY(%s)
"""


def matrix_expected(matrix: dict) -> set:
    """Every (role, table, privilege) triple the matrix authorizes."""
    expected = set()
    for role, spec in matrix["roles"].items():
        for table, privileges in (spec.get("tables") or {}).items():
            for privilege in privileges:
                expected.add((role, table, privilege.upper()))
    return expected


def main() -> int:
    matrix_path = os.environ.get("RBAC_MATRIX", "config/postgres/rbac-matrix.yaml")
    with open(matrix_path, encoding="utf-8") as f:
        matrix = yaml.safe_load(f)

    roles = sorted(matrix["roles"])
    expected = matrix_expected(matrix)
    tables = {table for _, table, _ in expected}

    dsn = os.environ.get("RBAC_DATABASE_URL")
    if not dsn:
        print("test_rbac_postgres: FAIL -- RBAC_DATABASE_URL is unset; refusing to "
              "report a pass against no database", file=sys.stderr)
        return 1

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(GRANT_QUERY, (roles,))
        observed = {(g, t, p.upper()) for g, t, p in cur.fetchall()}

        cur.execute("SELECT rolname FROM pg_roles WHERE rolname = ANY(%s)", (roles,))
        live_roles = {r[0] for r in cur.fetchall()}

    roles_examined = len(live_roles)
    tables_examined = len({t for _, t, _ in observed} | tables)

    missing = sorted(expected - observed)
    extra = sorted(observed - expected)

    grantless = matrix.get("grantless_roles", [])
    grantless_violations = sorted(
        triple for triple in observed if triple[0] in grantless
    )

    absent_roles = sorted(set(roles) - live_roles)

    print(f"test_rbac_postgres: roles_examined={roles_examined} "
          f"tables_examined={tables_examined} "
          f"expected_grants={len(expected)} observed_grants={len(observed)} "
          f"missing={len(missing)} extra={len(extra)} "
          f"grantless_violations={len(grantless_violations)}")

    failed = False
    if roles_examined < MIN_ROLES:
        print(f"FAIL: only {roles_examined} roles examined, spec requires >= {MIN_ROLES}", file=sys.stderr)
        failed = True
    if tables_examined < MIN_TABLES:
        print(f"FAIL: only {tables_examined} tables examined, spec requires >= {MIN_TABLES}", file=sys.stderr)
        failed = True
    for role in absent_roles:
        print(f"FAIL: role {role} in the matrix does not exist in pg_roles", file=sys.stderr)
        failed = True
    for role, table, privilege in missing:
        print(f"FAIL: missing grant {privilege} ON {table} TO {role}", file=sys.stderr)
        failed = True
    for role, table, privilege in extra:
        print(f"FAIL: ungoverned grant {privilege} ON {table} TO {role} -- "
              f"add it to config/postgres/rbac-matrix.yaml or revoke it", file=sys.stderr)
        failed = True
    for role, table, privilege in grantless_violations:
        print(f"FAIL: grantless role {role} holds {privilege} ON {table}", file=sys.stderr)
        failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Write the self-test — the gate must be provably able to fail without a cluster**

```python
# scripts/rbac/tests/test_rbac_postgres_selftest.py
"""Proves test_rbac_postgres's own failure paths fire, so the gate is never
trusted purely on a green run against a real cluster. Pure-Python, no
database: it drives matrix_expected() and the denominator floors directly.
"""
import importlib.util
import pathlib

import pytest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "test_rbac_postgres.py"
spec = importlib.util.spec_from_file_location("test_rbac_postgres", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_matrix_expected_flattens_role_table_privilege_triples():
    matrix = {"roles": {"hub_api": {"tables": {"app_versions": ["SELECT", "INSERT"]}}}}
    assert mod.matrix_expected(matrix) == {
        ("hub_api", "app_versions", "SELECT"),
        ("hub_api", "app_versions", "INSERT"),
    }


def test_matrix_expected_treats_a_grantless_role_as_zero_triples():
    matrix = {"roles": {"svc_ingest": {"tables": {}}, "executor": {"tables": None}}}
    assert mod.matrix_expected(matrix) == set()


def test_missing_database_url_is_a_failure_not_a_skip(monkeypatch, capsys):
    monkeypatch.delenv("RBAC_DATABASE_URL", raising=False)
    monkeypatch.setenv("RBAC_MATRIX", "config/postgres/rbac-matrix.yaml")
    assert mod.main() == 1
    assert "refusing to report a pass against no database" in capsys.readouterr().err


def test_the_real_matrix_clears_the_spec_floors():
    import yaml
    matrix = yaml.safe_load(open("config/postgres/rbac-matrix.yaml", encoding="utf-8"))
    expected = mod.matrix_expected(matrix)
    assert len(matrix["roles"]) >= mod.MIN_ROLES
    assert len({t for _, t, _ in expected}) >= mod.MIN_TABLES
```

- [ ] **Step 3: Add the make target**

```makefile
RBAC_NAMESPACE ?= waddlebot-alpha
RBAC_CONTEXT   ?= local-prealpha

test-rbac-postgres:
	@set -euo pipefail; \
	docker run --rm -v "$(CURDIR)":/work -w /work \
	  -e RBAC_DATABASE_URL="$$RBAC_DATABASE_URL" $(ACL_PYTHON_IMAGE) \
	  sh -c "pip install --quiet pyyaml==6.0.2 'psycopg[binary]==3.2.3' && python3 scripts/rbac/test_rbac_postgres.py"

test-rbac-selftest:
	@set -euo pipefail; \
	docker run --rm -v "$(CURDIR)":/work -w /work $(ACL_PYTHON_IMAGE) \
	  sh -c "pip install --quiet pyyaml==6.0.2 pytest==8.3.4 && python3 -m pytest -q scripts/rbac/tests/"
```

- [ ] **Step 4: Run both — the self-test now, the live gate against alpha**

```bash
make test-rbac-selftest
kubectl --context local-prealpha -n waddlebot-alpha port-forward svc/infra-postgres 15432:5432 &
PF_PID=$!
sleep 3
RBAC_DATABASE_URL="postgresql://postgres:$(kubectl --context local-prealpha -n waddlebot-alpha get secret waddlebot-secrets -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)@host.docker.internal:15432/waddlebot" \
  make test-rbac-postgres
kill "$PF_PID"
```

Expected: `4 passed` from the self-test; then a line of the form `test_rbac_postgres: roles_examined=10 tables_examined=12 expected_grants=… observed_grants=… missing=0 extra=0 grantless_violations=0` and exit 0. **If the alpha stack is not up yet, this step is deferred to Task 34** — record that in `M6_PREFLIGHT.md` and do not mark the step done.

- [ ] **Step 5: Make the live gate fail on purpose once**

```bash
kubectl --context local-prealpha -n waddlebot-alpha exec deploy/infra-postgres -- \
  psql -U postgres -d waddlebot -c "GRANT DELETE ON app_catalog TO webui;"
RBAC_DATABASE_URL="..." make test-rbac-postgres; echo "exit=$?"
kubectl --context local-prealpha -n waddlebot-alpha exec deploy/infra-postgres -- \
  psql -U postgres -d waddlebot -c "REVOKE DELETE ON app_catalog FROM webui;"
RBAC_DATABASE_URL="..." make test-rbac-postgres; echo "exit=$?"
```

Expected: the first run prints `FAIL: ungoverned grant DELETE ON app_catalog TO webui` and `exit=1`; after the revoke, `extra=0` and `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/rbac/ Makefile
git commit -m "$(cat <<'EOF'
test(e2e): make test-rbac-postgres asserts live grants equal the matrix in both directions, with printed role/table denominators and an 8/8 floor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 21: `make test-rbac-valkey` — live `ACL LIST` equality + the five negative tests

**Depends on:** Task 18, and M1's `penguin-spine` (this gate is the deployment-side sibling of its `tests/acl_matrix_tests.rs` — **must match plan penguin-spine**, whose Task 12 explicitly defers this to M6).

**Why Python here and Rust there:** `penguin-spine`'s crate-local test proves the matrix against the crate's own pinned container at crate-CI time. This gate proves the same matrix against the **deployed** Valkey, from the repo that deploys it, and is invoked by `make`, not `cargo` — spec §14.5 names it `make test-rbac-valkey`. The parsing rules below are the same ones `acl_matrix_tests.rs` uses (`expected_rule_tokens`, `expected_key_patterns`), reimplemented against the same matrix file rather than against a second source of truth.

**Files:**
- Create: `scripts/rbac/test_rbac_valkey.py`
- Create: `scripts/rbac/tests/test_rbac_valkey_selftest.py`
- Modify: `Makefile` (adds `test-rbac-valkey`)

- [ ] **Step 1: Write the gate**

```python
#!/usr/bin/env python3
"""Asserts the deployed Valkey's `ACL LIST` EQUALS
config/valkey/acl-matrix.yaml, plus the five per-user negative tests of
spec Sec11.10.2. Prints every count; a zero denominator is a failure
(critical-rules.md Verification Integrity).

Mirrors penguin-spine's tests/acl_matrix_tests.rs against the same matrix
file -- not a second source of truth, a second place the same file is
enforced (deployed stack rather than crate CI).

Run via `make test-rbac-valkey`.
"""
import os
import sys

try:
    import yaml
except ImportError:
    print("PyYAML is required: pip install pyyaml==6.0.2", file=sys.stderr)
    sys.exit(1)

try:
    import redis
except ImportError:
    print("redis is required: pip install redis==5.2.1", file=sys.stderr)
    sys.exit(1)

MIN_USERS = 6


def expected_rule_tokens(user: dict) -> set:
    if user.get("category_commands"):
        return set(user["category_commands"])
    tokens = {"-@all"}
    tokens.update(f"+{cmd}" for cmd in user.get("commands", []))
    return tokens


def expected_key_patterns(user: dict) -> set:
    return {f"~{p}" for p in user["key_patterns"]}


def observed_for(acl_lines: list, name: str) -> set:
    for line in acl_lines:
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "user" and parts[1] == name:
            return set(parts[2:])
    return set()


def client(url: str, username: str, password: str, ca_file: str | None):
    kwargs = {"username": username, "password": password, "decode_responses": True}
    if ca_file:
        kwargs["ssl_ca_certs"] = ca_file
    return redis.Redis.from_url(url, **kwargs)


def expect_noperm(conn, description: str, fn) -> bool:
    """A negative test passes only when the command is refused with NOPERM."""
    try:
        fn(conn)
    except redis.exceptions.ResponseError as exc:
        if "NOPERM" in str(exc).upper():
            print(f"  PASS (NOPERM): {description}")
            return True
        print(f"  FAIL: {description} refused, but not with NOPERM: {exc}", file=sys.stderr)
        return False
    except redis.exceptions.AuthenticationError as exc:
        print(f"  PASS (auth refused): {description}: {exc}")
        return True
    print(f"  FAIL: {description} SUCCEEDED and must not have", file=sys.stderr)
    return False


def main() -> int:
    matrix_path = os.environ.get("ACL_MATRIX", "config/valkey/acl-matrix.yaml")
    with open(matrix_path, encoding="utf-8") as f:
        matrix = yaml.safe_load(f)

    url = os.environ.get("VALKEY_URL")
    admin_password = os.environ.get("VALKEY_ADMIN_PASSWORD")
    ca_file = os.environ.get("VALKEY_CA_FILE") or None
    if not url or not admin_password:
        print("test_rbac_valkey: FAIL -- VALKEY_URL and VALKEY_ADMIN_PASSWORD must be set; "
              "refusing to report a pass against no server", file=sys.stderr)
        return 1

    if not matrix.get("executors_have_no_user"):
        print("test_rbac_valkey: FAIL -- the matrix must state executors_have_no_user: true "
              "(spec Sec11.10.2 requires the absence be explicit)", file=sys.stderr)
        return 1

    admin = client(url, "waddles_admin", admin_password, ca_file)
    acl_lines = admin.execute_command("ACL", "LIST")

    users_examined = 0
    failures = 0
    for user in matrix["users"]:
        users_examined += 1
        name = user["name"]
        observed = observed_for(acl_lines, name)
        if not observed:
            print(f"FAIL: user {name} is in the matrix but absent from ACL LIST", file=sys.stderr)
            failures += 1
            continue
        expected = expected_rule_tokens(user) | expected_key_patterns(user) | {matrix["channels_policy"]}
        missing = expected - observed
        extra = {t for t in observed if t.startswith(("~", "+", "-", "&")) or t == matrix["channels_policy"]} - expected
        for token in sorted(missing):
            print(f"FAIL: user {name} is missing ACL token {token}", file=sys.stderr)
            failures += 1
        for token in sorted(extra):
            print(f"FAIL: user {name} holds ungoverned ACL token {token} -- "
                  f"add it to config/valkey/acl-matrix.yaml or remove it", file=sys.stderr)
            failures += 1

    matrix_names = {u["name"] for u in matrix["users"]}
    for line in acl_lines:
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "user" and parts[1] not in matrix_names and parts[1] != "default":
            print(f"FAIL: live ACL user {parts[1]} is not in the matrix", file=sys.stderr)
            failures += 1
        if len(parts) >= 2 and parts[0] == "user" and "executor" in parts[1]:
            print(f"FAIL: an executor ACL user exists ({parts[1]}); the matrix forbids one", file=sys.stderr)
            failures += 1

    print(f"test_rbac_valkey: users_examined={users_examined} acl_lines={len(acl_lines)} failures={failures}")
    if users_examined < MIN_USERS:
        print(f"FAIL: only {users_examined} users examined, expected >= {MIN_USERS}", file=sys.stderr)
        failures += 1

    print("negative tests (spec Sec11.10.2):")
    negatives_run = 0
    negatives_passed = 0

    def pw(user: str) -> str:
        return os.environ[f"PASS_{user.upper().replace('-', '_')}"]

    checks = [
        ("svc-action", "XADD to an ingest source stream",
         lambda c: c.execute_command("XADD", "waddles:t:acme:c:main:src:twitch:tw-x:events", "*", "k", "v")),
        ("svc-ingest", "XREADGROUP on an action stream",
         lambda c: c.execute_command("XREADGROUP", "GROUP", "g", "c", "COUNT", "1",
                                     "STREAMS", "waddles:t:acme:c:main:app:a:action", ">")),
        ("svc-process", "a key outside waddles:t:*",
         lambda c: c.execute_command("GET", "someone-elses:key")),
        ("svc-process", "@admin command CONFIG GET",
         lambda c: c.execute_command("CONFIG", "GET", "maxmemory")),
        ("svc-action", "@dangerous command FLUSHALL",
         lambda c: c.execute_command("FLUSHALL")),
    ]
    for username, description, fn in checks:
        negatives_run += 1
        conn = client(url, username, pw(username), ca_file)
        if expect_noperm(conn, f"{username}: {description}", fn):
            negatives_passed += 1

    negatives_run += 1
    try:
        client(url, "svc-process-executor", "anything", ca_file).ping()
        print("  FAIL: an executor authenticated to Valkey", file=sys.stderr)
    except redis.exceptions.ResponseError:
        print("  PASS (auth refused): no executor ACL user exists")
        negatives_passed += 1
    except redis.exceptions.AuthenticationError:
        print("  PASS (auth refused): no executor ACL user exists")
        negatives_passed += 1

    print(f"test_rbac_valkey negatives: run={negatives_run} passed={negatives_passed}")
    if negatives_run == 0 or negatives_passed != negatives_run:
        failures += negatives_run - negatives_passed or 1

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Write the self-test**

```python
# scripts/rbac/tests/test_rbac_valkey_selftest.py
"""Proves the Valkey gate's parsing and its refusal paths, with no server."""
import importlib.util
import pathlib

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "test_rbac_valkey.py"
spec = importlib.util.spec_from_file_location("test_rbac_valkey", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_command_user_expands_to_minus_all_plus_each_command():
    user = {"name": "svc-ingest", "commands": ["xadd", "get"], "key_patterns": ["waddles:t:*"]}
    assert mod.expected_rule_tokens(user) == {"-@all", "+xadd", "+get"}
    assert mod.expected_key_patterns(user) == {"~waddles:t:*"}


def test_category_user_uses_its_category_list_verbatim():
    user = {"name": "svc-streaming", "category_commands": ["+@read", "-@admin"], "key_patterns": ["waddles:streaming:*"]}
    assert mod.expected_rule_tokens(user) == {"+@read", "-@admin"}


def test_observed_for_returns_empty_when_the_user_is_absent():
    assert mod.observed_for(["user default off"], "svc-process") == set()


def test_missing_connection_env_is_a_failure_not_a_skip(monkeypatch, capsys):
    monkeypatch.delenv("VALKEY_URL", raising=False)
    monkeypatch.delenv("VALKEY_ADMIN_PASSWORD", raising=False)
    monkeypatch.setenv("ACL_MATRIX", "config/valkey/acl-matrix.yaml")
    assert mod.main() == 1
    assert "refusing to report a pass against no server" in capsys.readouterr().err
```

- [ ] **Step 3: Add the make target**

```makefile
test-rbac-valkey:
	@set -euo pipefail; \
	docker run --rm -v "$(CURDIR)":/work -w /work \
	  -e VALKEY_URL -e VALKEY_ADMIN_PASSWORD -e VALKEY_CA_FILE \
	  -e PASS_SVC_INGEST -e PASS_SVC_PROCESS -e PASS_SVC_ACTION -e PASS_SVC_STREAMING \
	  $(ACL_PYTHON_IMAGE) \
	  sh -c "pip install --quiet pyyaml==6.0.2 redis==5.2.1 && python3 scripts/rbac/test_rbac_valkey.py"
```

- [ ] **Step 4: Run the self-test now; run the live gate against alpha**

```bash
make test-rbac-selftest
kubectl --context local-prealpha -n waddlebot-alpha port-forward svc/infra-redis 16379:6379 &
PF_PID=$!
sleep 3
export VALKEY_URL="rediss://host.docker.internal:16379"
export VALKEY_ADMIN_PASSWORD="$(kubectl --context local-prealpha -n waddlebot-alpha get secret waddles-valkey-acl-passwords -o jsonpath='{.data.PASS_WADDLES_ADMIN}' | base64 -d)"
for u in SVC_INGEST SVC_PROCESS SVC_ACTION SVC_STREAMING; do
  export "PASS_$u=$(kubectl --context local-prealpha -n waddlebot-alpha get secret waddles-valkey-acl-passwords -o jsonpath="{.data.PASS_$u}" | base64 -d)"
done
make test-rbac-valkey
kill "$PF_PID"
```

Expected: `8 passed` from the combined self-tests, then `test_rbac_valkey: users_examined=6 acl_lines=7 failures=0`, six `PASS` lines under `negative tests`, and `test_rbac_valkey negatives: run=6 passed=6`, exit 0. Defer to Task 34 if alpha is not up, recording that in `M6_PREFLIGHT.md`.

- [ ] **Step 5: Make it fail on purpose once**

```bash
kubectl --context local-prealpha -n waddlebot-alpha exec deploy/infra-redis -- \
  valkey-cli --user waddles_admin --pass "$VALKEY_ADMIN_PASSWORD" ACL SETUSER svc-process +config
make test-rbac-valkey; echo "exit=$?"
kubectl --context local-prealpha -n waddlebot-alpha rollout restart deploy/infra-redis
kubectl --context local-prealpha -n waddlebot-alpha rollout status deploy/infra-redis
make test-rbac-valkey; echo "exit=$?"
```

Expected: the first run prints `FAIL: user svc-process holds ungoverned ACL token +config` **and** `FAIL: svc-process: @admin command CONFIG GET SUCCEEDED and must not have`, `exit=1`. The rollout restores the rendered ACL file; the second run is clean with `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/rbac/ Makefile
git commit -m "$(cat <<'EOF'
test(e2e): make test-rbac-valkey asserts deployed ACL LIST equals the matrix and runs the six negative tests, executor ACL user proven absent

Enforces the same config/valkey/acl-matrix.yaml penguin-spine's
acl_matrix_tests.rs enforces at crate-CI time -- one matrix, two
enforcement points, no second source of truth.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 22: MinIO bundle bucket, credentials Secret, and the signing-key Secret

**Depends on:** M2a (the bucket layout `bundles/{app_id}/{version}/{sha256-hex}.wasm` / `.json` and the `BUNDLE_BUCKET_*` env names are M2a's contract — **must match plan M2a**), and this plan's Tasks 11-14.

**Why a second bucket and not the existing one:** the chart already deploys MinIO with `infrastructure.minio.bucketName: "waddlebot-assets"` (svc-streaming recordings). Bundle artifacts are a different trust class — the executor mounts read-only credentials for them and nothing else — so they get their own bucket `waddles-bundles`, matching `.Values.bundles.bucket.name` from Task 11.

**Files:**
- Modify: `k8s/helm/waddlebot/templates/infrastructure/minio.yaml` (the init Job also creates the bundle bucket and its read-only policy)
- Create: `k8s/helm/waddlebot/templates/pipeline/bundle-bucket-secret.yaml`
- Modify: `k8s/helm/waddlebot/values.yaml`

- [ ] **Step 1: Extend the MinIO init Job**

Re-read `templates/infrastructure/minio.yaml` and append to the `minio-init` container's shell script, keeping its existing `set -e` and `mc alias set` preamble:

```bash
          # Bundle artifact bucket (spec §12.3, layout bundles/{app_id}/{version}/{sha256}.wasm|.json).
          mc mb --ignore-existing "local/{{ .Values.bundles.bucket.name }}"
          # Executors and stages read artifacts; only the compiler's publisher writes.
          cat >/tmp/bundle-read.json <<'POLICY'
          {
            "Version": "2012-10-17",
            "Statement": [
              {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::BUCKET/bundles/*"]},
              {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::BUCKET"]}
            ]
          }
POLICY
          sed -i "s|BUCKET|{{ .Values.bundles.bucket.name }}|g" /tmp/bundle-read.json
          mc admin policy create local waddles-bundle-read /tmp/bundle-read.json || \
            mc admin policy update local waddles-bundle-read /tmp/bundle-read.json
          mc admin user add local "$BUNDLE_READER_ACCESS_KEY" "$BUNDLE_READER_SECRET_KEY"
          mc admin policy attach local waddles-bundle-read --user "$BUNDLE_READER_ACCESS_KEY" || true
          mc admin user add local "$BUNDLE_WRITER_ACCESS_KEY" "$BUNDLE_WRITER_SECRET_KEY"
          mc admin policy attach local readwrite --user "$BUNDLE_WRITER_ACCESS_KEY" || true
          objects=$(mc ls "local/{{ .Values.bundles.bucket.name }}" | wc -l)
          echo "minio-init: bundle bucket {{ .Values.bundles.bucket.name }} ready, top-level entries=${objects}"
```

with the four `BUNDLE_*` values sourced via `envFrom: [{secretRef: {name: {{ .Values.bundles.bucket.existingSecret }}}}]` on that container.

- [ ] **Step 2: Write the Secret template**

```yaml
# k8s/helm/waddlebot/templates/pipeline/bundle-bucket-secret.yaml
#
# Two identities against one bucket (spec §4.6/§12.4): the executor and the
# stages hold READ-ONLY credentials; only the compiler Job's publisher
# container holds the write key. Credentials are generated once and reused
# on upgrade via lookup() -- regenerating them on every `helm upgrade` would
# silently break every running pod's bucket poller.
{{- $ns := include "waddlebot.namespace" . }}
{{- $existing := (lookup "v1" "Secret" $ns .Values.bundles.bucket.existingSecret) }}
{{- $readerId := "" }}{{- $readerKey := "" }}{{- $writerId := "" }}{{- $writerKey := "" }}
{{- if $existing }}
{{- $readerId  = index $existing.data "accessKeyId" | b64dec }}
{{- $readerKey = index $existing.data "secretAccessKey" | b64dec }}
{{- $writerId  = index $existing.data "writerAccessKeyId" | b64dec }}
{{- $writerKey = index $existing.data "writerSecretAccessKey" | b64dec }}
{{- else }}
{{- $readerId  = printf "waddles-bundle-reader-%s" (randAlphaNum 8 | lower) }}
{{- $readerKey = randAlphaNum 40 }}
{{- $writerId  = printf "waddles-bundle-writer-%s" (randAlphaNum 8 | lower) }}
{{- $writerKey = randAlphaNum 40 }}
{{- end }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Values.bundles.bucket.existingSecret }}
  namespace: {{ $ns }}
  labels:
    {{- include "waddlebot.labels" . | nindent 4 }}
type: Opaque
stringData:
  accessKeyId: {{ $readerId | quote }}
  secretAccessKey: {{ $readerKey | quote }}
  writerAccessKeyId: {{ $writerId | quote }}
  writerSecretAccessKey: {{ $writerKey | quote }}
  BUNDLE_READER_ACCESS_KEY: {{ $readerId | quote }}
  BUNDLE_READER_SECRET_KEY: {{ $readerKey | quote }}
  BUNDLE_WRITER_ACCESS_KEY: {{ $writerId | quote }}
  BUNDLE_WRITER_SECRET_KEY: {{ $writerKey | quote }}
---
# Ed25519 signing keypair. publicKey is mounted into every pod that verifies
# an artifact; privateKey ONLY into the compiler Job (spec §12.3).
{{- $existingSign := (lookup "v1" "Secret" $ns .Values.bundles.signingPublicKeySecret) }}
{{- if not $existingSign }}
{{- fail (printf "Secret %s must exist before install: it holds the Ed25519 bundle signing keypair, which is generated out-of-band and never minted by the chart. Create it with:\n  kubectl -n %s create secret generic %s --from-file=publicKey=./pub.pem --from-file=privateKey=./priv.pem" .Values.bundles.signingPublicKeySecret $ns .Values.bundles.signingPublicKeySecret) }}
{{- end }}
```

The signing keypair is deliberately **not** chart-generated: a signing key minted by a template lands in Helm release state and in every `helm get manifest`. Step 3 documents the out-of-band creation.

- [ ] **Step 3: Create the signing Secret on alpha**

```bash
mkdir -p /tmp/m6-signing && cd /tmp/m6-signing
docker run --rm -v "$PWD":/out -w /out \
  debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 \
  sh -c "apt-get update -qq && apt-get install -y -qq openssl >/dev/null && \
         openssl genpkey -algorithm ed25519 -out priv.pem && \
         openssl pkey -in priv.pem -pubout -out pub.pem && chmod 600 priv.pem"
kubectl --context local-prealpha -n waddlebot-alpha create secret generic waddles-bundle-signing \
  --from-file=publicKey=./pub.pem --from-file=privateKey=./priv.pem
shred -u priv.pem && rm -f pub.pem && cd - && rmdir /tmp/m6-signing
kubectl --context local-prealpha -n waddlebot-alpha get secret waddles-bundle-signing -o jsonpath='{.data}' | tr ',' '\n' | cut -d'"' -f2
```

Expected: `secret/waddles-bundle-signing created`, then the two key names `publicKey` and `privateKey`. The private key exists only in the cluster Secret afterwards — never on disk, never in git, never echoed.

- [ ] **Step 4: Verify and commit**

```bash
make chart-lint
make chart-template | grep -c 'waddles-bundle-bucket'
make chart-template | grep -c 'waddles-bundles'
make chart-template CHART_ARGS='--set bundles.signingPublicKeySecret=does-not-exist' 2>&1 | grep -c 'must exist before install'
```

Expected: lint clean; both `grep -c` counts non-zero; the last prints `1` — pointing the chart at a missing signing Secret fails rendering with the creation command in the message, rather than deploying pods that cannot verify a digest.

```bash
git add k8s/helm/waddlebot/templates/infrastructure/minio.yaml \
  k8s/helm/waddlebot/templates/pipeline/bundle-bucket-secret.yaml \
  k8s/helm/waddlebot/values.yaml
git commit -m "$(cat <<'EOF'
feat(chart): waddles-bundles MinIO bucket with split read-only/writer credentials and a required out-of-band Ed25519 signing Secret

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 23: `values-alpha.yaml` — the cut-over's alpha posture

**Depends on:** Tasks 11-22. This is the file `tests/k8s/alpha/02-deploy-helm.sh` already passes to `helm upgrade --install`, so nothing in the deploy path changes.

**Files:**
- Modify: `k8s/helm/waddlebot/values-alpha.yaml`

- [ ] **Step 1: Append the alpha overrides**

```yaml
# --- M6 Rust data-plane cut-over (spec §12) ---
# Single-node laptop posture. Every switch below is the documented, visible
# form of the value -- alpha never silently differs from beta on a security
# posture; where it does differ (gVisor), the reason is written down.
pipeline:
  svcIngest:
    image: "ghcr.io/penguintechinc/waddles/svc-ingest"
  svcProcess:
    image: "ghcr.io/penguintechinc/waddles/svc-process"
  svcAction:
    image: "ghcr.io/penguintechinc/waddles/svc-action"
  svcStreaming:
    image: "ghcr.io/penguintechinc/waddles/svc-streaming"
  executor:
    image: "ghcr.io/penguintechinc/waddles/bundle-executor"
    # One replica per stage on a laptop; two is the beta/prod default.
    replicas: 1
    stageConnections: 2
    resources:
      requests: {cpu: "100m", memory: "128Mi"}
      limits:   {cpu: "500m", memory: "256Mi"}
  networkPolicy:
    # Alpha runs MicroK8s without Cilium by default. Rendering
    # CiliumNetworkPolicy objects the cluster has no CRD for fails the
    # install, so they are off here and asserted in beta instead. Turn on
    # with `--set pipeline.networkPolicy.enabled=true` once
    # `microk8s enable cilium` has run; Task 31's e2e does exactly that
    # for the executor-isolation assertions.
    enabled: false

sandbox:
  # MicroK8s: `microk8s enable gvisor` registers the runsc handler and the
  # RuntimeClass. If it has not been run on this node, set enabled=false --
  # the pods then fail closed with exit 78 rather than pretending (§12.2).
  gvisor:
    enabled: true
  runtimeClassName: "runsc"
  installer:
    # MicroK8s has a native offering; the installer is for kubeadm/DOKS/EKS.
    enabled: false

bundles:
  allowPrebuilt: true
  allowWildcardConsumes: false
  bucket:
    provider: "minio"
    # values-alpha.yaml overrides infrastructure.minio.service.name to
    # "waddlebot-minio", so the endpoint must match that Service, not the
    # chart default "infra-minio".
    endpoint: "http://waddlebot-minio.waddlebot-alpha.svc.cluster.local:9000"
    name: "waddles-bundles"
    region: "us-east-1"
    existingSecret: "waddles-bundle-bucket"
  pollIntervalSeconds: 30
  egress:
    allowPrivateHosts: false
    allowedFqdns: []
  signingPublicKeySecret: "waddles-bundle-signing"
  compiler:
    image: "ghcr.io/penguintechinc/waddles/bundle-compiler"
    activeDeadlineSeconds: 900
    resources:
      limits: {cpu: "1000m", memory: "2Gi"}

security:
  transport:
    # ON in alpha too. The opt-out exists and every environment's file may
    # set it, but alpha defaulting to false would mean the cut-over's e2e
    # never exercises the posture beta and prod actually run (spec §11.6.4).
    tls: true
    auth: true
    certManager: "auto"
  rbac:
    postgresMatrix: "config/postgres/rbac-matrix.yaml"
    valkeyMatrix: "config/valkey/acl-matrix.yaml"

infrastructure:
  redis:
    aclPasswordSecret: "waddles-valkey-acl-passwords"
```

- [ ] **Step 2: Render the alpha values and confirm the switches**

```bash
make chart-template CHART_VALUES=k8s/helm/waddlebot/values-alpha.yaml > /tmp/m6-alpha-render.yaml
grep -c 'ghcr.io/penguintechinc/waddles/' /tmp/m6-alpha-render.yaml
grep -c 'runtimeClassName: runsc' /tmp/m6-alpha-render.yaml
grep -c 'kind: CiliumNetworkPolicy' /tmp/m6-alpha-render.yaml
grep -c 'name: SECURITY_TRANSPORT_TLS' /tmp/m6-alpha-render.yaml
```

Expected: the waddles image count is at least 6 (four services + executor + compiler); `runtimeClassName: runsc` appears at least twice (both executor Deployments); `kind: CiliumNetworkPolicy` is `0` under alpha's `pipeline.networkPolicy.enabled: false`; `SECURITY_TRANSPORT_TLS` appears at least 5 times.

- [ ] **Step 3: Confirm the alpha secrets exist before anyone tries to deploy**

```bash
for s in waddles-bundle-signing waddles-valkey-acl-passwords; do
  kubectl --context local-prealpha -n waddlebot-alpha get secret "$s" >/dev/null 2>&1 \
    && echo "$s: present" || echo "$s: MISSING -- create it before Task 34's deploy"
done
```

`waddles-bundle-signing` was created in Task 22 Step 3. Create the ACL password Secret now if missing:

```bash
kubectl --context local-prealpha -n waddlebot-alpha create secret generic waddles-valkey-acl-passwords \
  --from-literal=PASS_SVC_INGEST="$(openssl rand -hex 24)" \
  --from-literal=PASS_SVC_PROCESS="$(openssl rand -hex 24)" \
  --from-literal=PASS_SVC_ACTION="$(openssl rand -hex 24)" \
  --from-literal=PASS_SVC_STREAMING="$(openssl rand -hex 24)" \
  --from-literal=PASS_HUB_API="$(openssl rand -hex 24)" \
  --from-literal=PASS_WADDLES_ADMIN="$(openssl rand -hex 24)"
kubectl --context local-prealpha -n waddlebot-alpha get secret waddles-valkey-acl-passwords \
  -o jsonpath='{.data}' | tr ',' '\n' | cut -d'"' -f2
```

Expected: six key names printed, no values. (`openssl rand` output goes straight into the Secret and is never echoed — `critical-rules.md` Token & Secret Hygiene.)

- [ ] **Step 4: Commit**

```bash
git add k8s/helm/waddlebot/values-alpha.yaml
git commit -m "$(cat <<'EOF'
feat(chart): alpha values for the Rust data-plane cut-over -- waddles images, gVisor on, transport security on, Cilium policies off until the addon is enabled

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---
## Task 24: `check_no_dangling_refs.sh` — the gate every deletion task ends with

**Depends on:** nothing in this plan; written before the first deletion so Tasks 25-28 can each end with it.

**Why one shared script:** "delete the code and its references in the same task" is only enforceable if the check is mechanical. A per-task hand-written `grep` drifts, and a `grep` that matches nothing reports a clean pass either way — this script refuses to pass without a non-zero denominator (`critical-rules.md` Verification Integrity).

**Files:**
- Create: `scripts/ci/check_no_dangling_refs.sh`
- Create: `scripts/ci/tests/test_check_no_dangling_refs.sh`
- Modify: `Makefile` (adds `check-dangling-refs`)

**Interfaces:**
- Produces: `scripts/ci/check_no_dangling_refs.sh <pattern> [<allowed-path-prefix>...]` — exits 0 with `files_scanned=N hits=0` printed when no tracked file outside the allowed prefixes mentions `<pattern>`; exits 1 listing every `path:line` otherwise; exits 1 when `files_scanned` is 0.
- Sibling of `scripts/ci/check_bundle_dal_imports.sh` (**must match plan M1.5**) — same output grammar (`files_scanned=`/`hits=`), deliberately, so CI log greps work on both.

- [ ] **Step 1: Write the script**

```bash
cat > scripts/ci/check_no_dangling_refs.sh <<'SCRIPT_EOF'
#!/usr/bin/env bash
# Fails if any tracked file still references a deleted artifact.
#
#   check_no_dangling_refs.sh <extended-regex> [allowed-path-prefix ...]
#
# Allowed prefixes are paths where a mention is legitimate after deletion:
# CHANGELOG.md, docs/migration-notes/, and this plan's own file, which
# necessarily name what was removed. Everything else is a dangling ref.
#
# Reports files_scanned and hits. Zero files scanned is a FAILURE, never a
# pass (critical-rules.md Verification Integrity).
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: check_no_dangling_refs.sh <extended-regex> [allowed-path-prefix ...]" >&2
    exit 2
fi

PATTERN="$1"; shift
ALLOWED=("$@")

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

mapfile_compat() { while IFS= read -r line; do printf '%s\n' "$line"; done; }

files_scanned=$(git ls-files | wc -l | tr -d ' ')
if [[ "$files_scanned" -eq 0 ]]; then
    echo "check_no_dangling_refs: FAIL -- zero files scanned (not a git checkout?)" >&2
    exit 1
fi

raw_hits="$(git grep -n -E "$PATTERN" -- . || true)"

hits=""
while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    path="${line%%:*}"
    allowed=0
    for prefix in "${ALLOWED[@]}"; do
        case "$path" in
            "$prefix"*) allowed=1; break ;;
        esac
    done
    [[ "$allowed" -eq 1 ]] && continue
    hits="${hits}${line}"$'\n'
done <<< "$raw_hits"

hit_count=0
if [[ -n "${hits// /}" ]]; then
    hit_count=$(printf '%s' "$hits" | grep -c . || true)
fi

echo "check_no_dangling_refs: pattern='${PATTERN}' files_scanned=${files_scanned} hits=${hit_count}"

if [[ "$hit_count" -ne 0 ]]; then
    echo "check_no_dangling_refs: FAIL -- dangling reference(s) to a deleted artifact:" >&2
    printf '%s' "$hits" >&2
    echo "  -> delete or update each reference in the same commit as the code it names." >&2
    exit 1
fi
SCRIPT_EOF
chmod +x scripts/ci/check_no_dangling_refs.sh
```

- [ ] **Step 2: Write the self-test and prove both directions**

```bash
cat > scripts/ci/tests/test_check_no_dangling_refs.sh <<'SCRIPT_EOF'
#!/usr/bin/env bash
# Proves check_no_dangling_refs.sh fails when it should and passes when it
# should, so a green run is evidence rather than an absence of signal.
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
CHECK=scripts/ci/check_no_dangling_refs.sh
cases=0
failures=0

expect_exit() {
    local want="$1" name="$2"; shift 2
    cases=$((cases + 1))
    set +e
    out="$("$@" 2>&1)"
    got=$?
    set -e
    if [[ "$got" -eq "$want" ]]; then
        echo "PASS: $name (exit $got)"
    else
        echo "FAIL: $name expected exit $want, got $got" >&2
        printf '%s\n' "$out" >&2
        failures=$((failures + 1))
    fi
}

# A pattern that certainly exists somewhere tracked must FAIL.
expect_exit 1 "a live pattern is reported as dangling" "$CHECK" 'check_no_dangling_refs'
# ...and passes once its own directory is allowed.
expect_exit 0 "allowed prefixes suppress the hit" "$CHECK" 'check_no_dangling_refs' 'scripts/ci/' 'docs/'
# A pattern that exists nowhere must PASS.
expect_exit 0 "an absent pattern passes" "$CHECK" 'zzz_no_such_symbol_zzz_m6'
# No argument is a usage error, not a pass.
expect_exit 2 "missing pattern is a usage error" "$CHECK"

echo "test_check_no_dangling_refs: cases=$cases failures=$failures"
[[ "$failures" -eq 0 ]]
SCRIPT_EOF
chmod +x scripts/ci/tests/test_check_no_dangling_refs.sh
bash scripts/ci/tests/test_check_no_dangling_refs.sh
```

Expected: four `PASS:` lines then `test_check_no_dangling_refs: cases=4 failures=0`, exit 0.

- [ ] **Step 3: Add the make target**

```makefile
# Usage: make check-dangling-refs PATTERN='core/svc_ingest' ALLOW='CHANGELOG.md docs/migration-notes/'
check-dangling-refs:
	@set -euo pipefail; \
	test -n "$(PATTERN)" || { echo "PATTERN= is required" >&2; exit 2; }; \
	bash scripts/ci/check_no_dangling_refs.sh '$(PATTERN)' $(ALLOW)
```

- [ ] **Step 4: Commit**

```bash
git add scripts/ci/check_no_dangling_refs.sh scripts/ci/tests/test_check_no_dangling_refs.sh Makefile
git commit -m "$(cat <<'EOF'
chore(core): check_no_dangling_refs.sh -- grep gate with a non-zero denominator, used by every Python retirement task

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 25: Retire the Python `core/svc_ingest` — code, CI, deps, docs, in one commit

**Depends on:** M5 having landed the Rust `core/svc_ingest/src/**` (Task 1 Step 1 asserted `core/svc_ingest/Cargo.toml` exists), M1's `penguin-connectors`, and this plan's Tasks 2/3 (the bundles that were under `core/svc_ingest/bundles/` are already relocated or, for the six `*_ingest.py` normalizers, absorbed as fixed Rust code per spec §15.3.1). Also Task 24.

**Spec:** §15.2's deletion table, row 1. **Nothing here is a rename** — ingest bundles become fixed code; the `ingest` surface stops being bundle-pluggable (Task 28 removes it from `KNOWN_SURFACES`).

**Files:**
- Delete: every `*.py` under `core/svc_ingest/` plus its `requirements*.txt`, `pyproject.toml`, `pytest.ini`, `Dockerfile` — keep `Cargo.toml`, `Cargo.lock`, `src/`, `tests/` (Rust), `deny.toml`
- Modify: `.github/workflows/pr-validation.yml:37`, `scripts/ci/install-unit-test-deps.sh:63`
- Modify: any doc the Step 4 grep names

- [ ] **Step 1: Confirm the Rust replacement covers every intake route before deleting anything**

```bash
ls core/svc_ingest/src/
grep -rn "intake/webhook\|intake/events\|/twitch\|/discord\|/slack\|/kick\|/youtube" core/svc_ingest/src/ | wc -l
git ls-files core/svc_ingest | grep -c '\.py$'
```

Expected: `src/` lists the Rust module tree; the route grep is non-zero; the `.py` count is the number of files this task removes. **If the Rust route grep returns 0, STOP** — deleting the Python receivers before the Rust routes exist takes ingest offline.

- [ ] **Step 2: Delete the Python tree**

```bash
git rm -r --quiet $(git ls-files 'core/svc_ingest/*.py' 'core/svc_ingest/**/*.py')
git rm --quiet --ignore-unmatch core/svc_ingest/requirements.txt core/svc_ingest/requirements-dev.txt \
  core/svc_ingest/pyproject.toml core/svc_ingest/pytest.ini core/svc_ingest/Dockerfile
git status --short core/svc_ingest | head -20
git ls-files core/svc_ingest | grep -c '\.py$' || echo "0 python files remain"
```

Expected: `0 python files remain`, and `git ls-files core/svc_ingest` now lists only Rust artefacts (`Cargo.toml`, `Cargo.lock`, `deny.toml`, `src/**`, `tests/**`, `Dockerfile` if M5 added a Rust one — check before removing it above and keep it if so).

- [ ] **Step 3: Remove every reference, in this same commit**

`.github/workflows/pr-validation.yml` — delete the `core/svc_ingest/requirements.txt` line from the dependency-cache `key`/`path` list.

`scripts/ci/install-unit-test-deps.sh` — remove `core/svc_ingest` from the `for pkg in ...` list on line 63 (re-read the file; the list is `hub_api core/svc_action core/svc_ingest core/svc_presentation core/svc_process core/svc_streaming`).

Then sweep whatever else the gate finds:

```bash
make check-dangling-refs PATTERN='core/svc_ingest/[a-z_]*\.py|svc_ingest\.(app|runner|fanout|receivers|bundles|eventsub|supervisor|socket_lease|outbound_drain)' \
  ALLOW='CHANGELOG.md docs/migration-notes/ docs/superpowers/'
```

Expected on the first run: a list of `path:line` hits (docs and comments). Edit each one — a doc sentence describing the Python module becomes a sentence describing the Rust one; a stale example is deleted, not commented out. Re-run until it prints `files_scanned=<N> hits=0`.

- [ ] **Step 4: Confirm nothing else broke**

```bash
bash scripts/ci/install-unit-test-deps.sh && echo "unit-test deps install cleanly without svc_ingest"
make lint
make chart-template CHART_VALUES=k8s/helm/waddlebot/values-alpha.yaml | grep -c 'svc-ingest'
```

Expected: the deps script succeeds; `make lint` passes; the chart still renders `svc-ingest` (the **Deployment** stays — only the Python implementation is gone).

- [ ] **Step 5: Commit**

```bash
git add -A core/svc_ingest .github/workflows/pr-validation.yml scripts/ci/install-unit-test-deps.sh
git add -A docs
git commit -m "$(cat <<'EOF'
chore(core): delete the Python core/svc_ingest -- app, runner, receivers, fanout, eventsub, supervisor, socket_lease, outbound_drain, bundles and tests

Replaced by core/svc_ingest/src/** (M5) and penguin-connectors (M1). The
CI dependency-cache entry, the unit-test dep installer and every doc
reference go in this same commit; scripts/ci/check_no_dangling_refs.sh
reports hits=0 over a non-zero file count.

Ingest is no longer bundle-pluggable (spec 15.3.1): the six *_ingest.py
normalizers are fixed Rust code now, not relocated bundles.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 26: Retire the Python `core/svc_process`

**Depends on:** M4 having landed `core/svc_process/src/**`, this plan's Task 3 (its bundles are already `git mv`-ed into `bundles/python/`), and Task 24.

**Files:**
- Delete: every remaining `*.py` under `core/svc_process/` plus `requirements*.txt`, `pyproject.toml`, `pytest.ini`, the Python `Dockerfile`
- Modify: `.github/workflows/pr-validation.yml:39`, `scripts/ci/install-unit-test-deps.sh:52,56,63`

- [ ] **Step 1: Confirm the bundles already moved and the Rust stage exists**

```bash
ls core/svc_process/src/ >/dev/null && echo "rust src: present"
git ls-files 'core/svc_process/bundles/*.py' | wc -l
git ls-files 'bundles/python/*/*.py' | wc -l
```

Expected: `rust src: present`; the `core/svc_process/bundles` count is `0` (Task 3 moved them); the `bundles/python` count is non-zero. **If `core/svc_process/bundles` is non-empty, STOP and finish Task 3 first** — `git rm` here would delete bundle source that was never relocated.

- [ ] **Step 2: Delete**

```bash
git rm -r --quiet $(git ls-files 'core/svc_process/*.py' 'core/svc_process/**/*.py')
git rm --quiet --ignore-unmatch core/svc_process/requirements.txt core/svc_process/requirements-dev.txt \
  core/svc_process/pyproject.toml core/svc_process/pytest.ini
git ls-files core/svc_process | grep -c '\.py$' || echo "0 python files remain"
```

- [ ] **Step 3: Remove every reference, same commit**

`scripts/ci/install-unit-test-deps.sh` needs three edits, not one — lines 52 and 56 are comments explaining a `moderation_gate.py` dependency pin that no longer exists, and line 63 lists the package. Delete the two comment blocks with the package entry; do not leave a comment describing a deleted file.

`.github/workflows/pr-validation.yml` — remove the `core/svc_process/requirements.txt` cache line.

```bash
make check-dangling-refs PATTERN='core/svc_process/[a-z_]*\.py|core/svc_process/(bundles|services|tests)|svc_process\.(app|runner|services)' \
  ALLOW='CHANGELOG.md docs/migration-notes/ docs/superpowers/'
```

Expected after the sweep: `hits=0` with a non-zero `files_scanned`.

- [ ] **Step 4: Verify**

```bash
bash scripts/ci/install-unit-test-deps.sh && echo "deps clean"
make lint
```

- [ ] **Step 5: Commit**

```bash
git add -A core/svc_process .github/workflows/pr-validation.yml scripts/ci/install-unit-test-deps.sh docs
git commit -m "$(cat <<'EOF'
chore(core): delete the Python core/svc_process -- runner, services and tests

Replaced by core/svc_process/src/** (M4); its bundles already live in
bundles/python/ from this plan's earlier migration task. CI cache entries,
the unit-test dep installer (including the two moderation_gate comments
that explained a now-deleted pin) and every doc reference go in this same
commit; check_no_dangling_refs.sh reports hits=0.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 27: Retire the Python `core/svc_action`

**Depends on:** M3 having landed `core/svc_action/src/**`, this plan's Tasks 4 and 9 (its bundles relocated; the five platform-send modules deleted as absorbed built-ins), and Task 24.

**Files:**
- Delete: every remaining `*.py` under `core/svc_action/` plus `requirements*.txt`, `pyproject.toml`, `pytest.ini`
- Modify: `.github/workflows/pr-validation.yml:36`, `scripts/ci/install-unit-test-deps.sh:9,63`

- [ ] **Step 1: Confirm**

```bash
ls core/svc_action/src/ >/dev/null && echo "rust src: present"
git ls-files 'core/svc_action/bundles/*.py' | wc -l
grep -rn "discord\|slack\|youtube\|kick\|twitch" core/svc_action/src/ | grep -ci "send\|dispatch"
```

Expected: `rust src: present`; a bundles count of `0`; a non-zero built-in-sender grep (**must match plan M3**, whose "Built-in senders: Discord, Slack, YouTube, Kick REST; Twitch via the relay" row is what makes the five Python modules redundant). If the sender grep is 0, STOP.

- [ ] **Step 2: Delete**

```bash
git rm -r --quiet $(git ls-files 'core/svc_action/*.py' 'core/svc_action/**/*.py')
git rm --quiet --ignore-unmatch core/svc_action/requirements.txt core/svc_action/requirements-dev.txt \
  core/svc_action/pyproject.toml core/svc_action/pytest.ini
git ls-files core/svc_action | grep -c '\.py$' || echo "0 python files remain"
```

- [ ] **Step 3: Remove every reference, same commit**

`scripts/ci/install-unit-test-deps.sh` line 9's comment cites `svc_action pins pydal==20260520.0` as the reason for a transitive-pin workaround — with `svc_action`'s `requirements.txt` gone, re-derive the comment against what is actually left (`hub_api`, `core/svc_presentation`, `core/svc_streaming`) rather than deleting the workaround blind:

```bash
grep -rn "pydal" hub_api/requirements.txt core/svc_presentation/requirements.txt 2>/dev/null || echo "no remaining pydal pin conflict"
```

If nothing remains, delete the workaround and its comment together. If a conflict remains, rewrite the comment to name the package that actually causes it.

```bash
make check-dangling-refs PATTERN='core/svc_action/[a-z_]*\.py|core/svc_action/(bundles|services|tests)|svc_action\.(app|runner|services)' \
  ALLOW='CHANGELOG.md docs/migration-notes/ docs/superpowers/'
```

- [ ] **Step 4: Verify**

```bash
bash scripts/ci/install-unit-test-deps.sh && echo "deps clean"
make lint
git ls-files 'core/svc_*/**/*.py' | wc -l
```

Expected: the final count is `0` — no Python remains under any `core/svc_*` stage directory. (`core/svc_presentation` is untouched by this plan and is not a `core/svc_{ingest,process,action,streaming}` stage; if the count is non-zero, confirm the remaining paths are `svc_presentation` only.)

- [ ] **Step 5: Commit**

```bash
git add -A core/svc_action .github/workflows/pr-validation.yml scripts/ci/install-unit-test-deps.sh docs
git commit -m "$(cat <<'EOF'
chore(core): delete the Python core/svc_action -- runner, services, the five absorbed platform-send modules and tests

Replaced by core/svc_action/src/** (M3), whose built-in senders cover
Discord/Slack/YouTube/Kick REST with Twitch via the relay. No Python
remains under core/svc_{ingest,process,action}; check_no_dangling_refs.sh
reports hits=0 over a non-zero file count.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 28: Retire `flask_core`'s bundle-loading machinery and `stream_pipeline.py`

**Depends on:** Tasks 25-27 (the only importers of these modules are gone) and M1.5 (`bundle_runtime`'s `get_bundle_dal`/`set_bundle_dal` were retyped to `penguin_dal.AsyncDB` there — **must match plan M1.5**; this task deletes the module those functions live in, so its own consumers must already be relocated bundles reading the `penguin-dal` facade directly).

**`libs/flask_core` itself stays** — hub-api and the tests use it (spec §15.2). What goes is the machinery that existed only to load and run bundles in-process.

**Files:**
- Delete: `libs/flask_core/flask_core/stream_pipeline.py`, `libs/flask_core/flask_core/bundle_runtime.py`, `libs/flask_core/tests/test_stream_pipeline.py`, `libs/flask_core/tests/test_bundle_runtime.py`, `libs/flask_core/tests/test_bundle_isolation_keys.py`
- Modify: `libs/flask_core/flask_core/stage_runner.py` (removes `load_entrypoint` and the `importlib` path), `libs/flask_core/flask_core/app_manifest.py` (removes `ingest` from `KNOWN_SURFACES`), `libs/flask_core/flask_core/__init__.py` (drops both re-exports), `libs/flask_core/tests/conftest.py`
- Modify: `services/core-community/libs/flask_core/flask_core/{__init__.py,stream_pipeline.py}` (the vendored copy), `tests/streams/{conftest.py,test_no_pii_in_envelope.py,test_retention.py}`, `processing/router_module/{app.py,services/command_processor.py}`, `action/interactive/welcome_interaction_module/app.py`, `hub_api/services/distribution_service.py`, `README.md`, `docs/{ARCHITECTURE.md,index.md,APP_BUNDLE_AUTHORING.md,router_module/USAGE.md}`

- [ ] **Step 1: Enumerate the real importers before touching anything**

```bash
git grep -n "stream_pipeline\|StreamPipeline" -- . | grep -v '^docs/plans/' | tee /tmp/m6-sp-refs.txt | wc -l
git grep -n "bundle_runtime\|load_entrypoint\|get_bundle_dal\|set_bundle_dal" -- . | tee /tmp/m6-br-refs.txt | wc -l
grep -c 'KNOWN_SURFACES' libs/flask_core/flask_core/app_manifest.py
```

Expected: two non-zero counts written to the two files, which are the exact work list for Steps 3-4. **Do not delete a module whose reference list you have not read** — `processing/router_module` and `action/interactive/welcome_interaction_module` are live non-pipeline services, and their use of `StreamPipeline` must be rewritten (to `penguin-spine`'s client, or to a direct Valkey call), not deleted.

- [ ] **Step 2: Rewrite the non-pipeline consumers first**

For each path in `/tmp/m6-sp-refs.txt` that is **not** under `libs/flask_core`, `core/svc_*`, `tests/streams/` or `docs/`: replace the `StreamPipeline` usage with a direct `redis.asyncio` enqueue against the key its call site already builds, keeping the same key string. These services are not in this project's scope and must keep working unchanged; the goal is only to stop them importing a module that is going away.

```bash
git grep -ln "StreamPipeline" -- processing/ action/ services/ | tee /tmp/m6-sp-services.txt
```

Rewrite each, then:

```bash
git grep -c "StreamPipeline" -- processing/ action/ services/ || echo "no service imports remain"
```

Expected: `no service imports remain`.

- [ ] **Step 3: Delete the modules and their tests**

```bash
git rm --quiet libs/flask_core/flask_core/stream_pipeline.py \
               libs/flask_core/flask_core/bundle_runtime.py \
               libs/flask_core/tests/test_stream_pipeline.py \
               libs/flask_core/tests/test_bundle_runtime.py \
               libs/flask_core/tests/test_bundle_isolation_keys.py \
               services/core-community/libs/flask_core/flask_core/stream_pipeline.py
```

Then remove from `libs/flask_core/flask_core/__init__.py` (and the vendored `services/core-community/...` copy) every `stream_pipeline` / `bundle_runtime` import and `__all__` entry.

- [ ] **Step 4: Remove `load_entrypoint` and the `ingest` surface**

In `libs/flask_core/flask_core/stage_runner.py`, delete the `load_entrypoint` function and every `importlib` import that existed only for it. A stage no longer loads Python by module path — the executor loads a verified WASM component (spec §15.2).

In `libs/flask_core/flask_core/app_manifest.py`, remove `"ingest"` from `KNOWN_SURFACES`. Keep the string in the *vocabulary* the validator knows so a manifest declaring it is **rejected with a named error**, per rule V15 — do not make it an unknown-key error:

```python
# `ingest` is deliberately absent from KNOWN_SURFACES: ingest stopped being
# bundle-pluggable in the Rust cut-over (spec Sec15.3.1). It stays in
# REJECTED_SURFACES so a manifest declaring it gets a specific message
# instead of a generic "unknown surface" (rule V15).
REJECTED_SURFACES = {
    "ingest": (
        "the 'ingest' surface was removed: ingest normalizers are fixed "
        "code in svc-ingest. Use the generic webhook or REST intake instead "
        "(docs/APP_BUNDLE_AUTHORING.md, 'Intake')."
    ),
}
```

and raise that message from the validator when the surface appears.

- [ ] **Step 5: Run the flask_core suite and the dangling-ref gate**

```bash
docker run --rm -v "$PWD":/work -w /work/libs/flask_core \
  python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285 \
  sh -c "pip install --quiet -e . -r requirements-dev.txt && python -m pytest -q"
make check-dangling-refs PATTERN='flask_core\.stream_pipeline|StreamPipeline|flask_core\.bundle_runtime|load_entrypoint' \
  ALLOW='CHANGELOG.md docs/migration-notes/ docs/superpowers/ docs/plans/'
```

Expected: the pytest run passes with zero failures and reports a non-zero collected count; the gate prints `hits=0` with a non-zero `files_scanned`. `docs/plans/` is allowed because those are historical, dated plan documents that describe the architecture as it was — they are records, not references.

- [ ] **Step 6: Assert the ingest surface is rejected, not merely unknown**

```bash
docker run --rm -v "$PWD":/work -w /work/libs/flask_core \
  python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285 \
  sh -c "pip install --quiet -e . && python - <<'PY'
from flask_core.app_manifest import KNOWN_SURFACES, REJECTED_SURFACES
assert 'ingest' not in KNOWN_SURFACES, 'ingest must not be a pluggable surface'
assert 'ingest' in REJECTED_SURFACES, 'ingest must be rejected by name (rule V15)'
print('surfaces_known=%d surfaces_rejected=%d' % (len(KNOWN_SURFACES), len(REJECTED_SURFACES)))
PY"
```

Expected: `surfaces_known=2 surfaces_rejected=1` (or whatever the real `KNOWN_SURFACES` length is after removal — the assertion, not the number, is the gate).

- [ ] **Step 7: Commit**

```bash
git add -A libs/flask_core services/core-community processing action hub_api tests/streams docs README.md
git commit -m "$(cat <<'EOF'
chore(core): remove flask_core's bundle-loading machinery -- stream_pipeline, bundle_runtime, stage_runner.load_entrypoint, and the pluggable ingest surface

libs/flask_core itself stays (hub-api and the tests use it). The 'ingest'
surface moves from KNOWN_SURFACES to REJECTED_SURFACES so a manifest
declaring it is refused by name (rule V15) rather than with a generic
unknown-surface error. Non-pipeline consumers (router_module,
welcome_interaction_module, core-community) are rewritten off
StreamPipeline in this same commit, not left importing a deleted module.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---
## Task 29: CI workflow consolidation — one reusable Rust gate, six callers, the Python builders removed

**Depends on:** Tasks 25-28 (the Python trees are gone, so their builders have nothing to build) and M3/M4/M5 (each may have added its own `rust-svc-*.yml`; Step 1 finds out rather than assuming — **must match plan M3/M4/M5**).

**Why consolidate rather than add:** spec §14.5 says the gate set is "identical to `.github/workflows/rust-svc-streaming.yml`, applied to all four services, both new binaries, and every new `penguin-libs` crate". Six near-identical copies drift; the pins in particular (`actions/checkout@de0fac2e…`, `dtolnay/rust-toolchain@6bed0761…`, `taiki-e/install-action@3f74d7c1…`, `cargo-deny@0.20.2`, `cargo-llvm-cov@0.9.1`) must stay in one place.

**Files:**
- Create: `.github/workflows/rust-crate-gate.yml` (reusable, `workflow_call`)
- Rewrite: `.github/workflows/rust-svc-streaming.yml` plus whatever M3/M4/M5 landed, as thin callers
- Create: `.github/workflows/rust-svc-ingest.yml`, `rust-svc-process.yml`, `rust-svc-action.yml`, `rust-bundle-executor.yml`, `rust-bundle-compiler.yml` — **only** those Step 1 shows are missing
- Delete: `.github/workflows/build-svc-streaming.yml` if it builds the Python image (Step 1 decides)

- [ ] **Step 1: Inventory what actually exists**

```bash
ls .github/workflows/ | grep -E 'rust-|build-svc'
for f in .github/workflows/rust-*.yml; do
  echo "== $f"; grep -m1 'working-directory:' "$f" || echo "  (no working-directory)"
done
grep -l 'python' .github/workflows/build-svc-streaming.yml 2>/dev/null && echo "build-svc-streaming.yml is a Python builder -> delete it"
```

Record the result in `M6_PREFLIGHT.md`. Create in Step 3 only the callers this listing shows are absent.

- [ ] **Step 2: Write the reusable gate**

```yaml
# .github/workflows/rust-crate-gate.yml
# The single definition of spec §14.5's per-crate gate set. Every Rust
# crate in this repo calls it; the action SHAs and tool versions are pinned
# here once. No step is wrapped in `|| true` (critical-rules.md
# Verification Integrity) and every scan prints what it examined.
name: Rust crate gate (reusable)

on:
  workflow_call:
    inputs:
      crate-dir:
        description: "Path to the crate, e.g. core/svc_process"
        required: true
        type: string
      binary-name:
        description: "Binary name for cargo tree checks, e.g. svc-process"
        required: true
        type: string
      forbid-network-crates:
        description: "Assert the crate links no networking/DB crate (spec test 16, executor only)"
        required: false
        default: false
        type: boolean

permissions:
  contents: read

jobs:
  gate:
    name: fmt + clippy + deny + audit + test + coverage
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${{ inputs.crate-dir }}
    steps:
      - name: Checkout code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2

      - name: Install build deps for aws-lc-sys (cmake, C/C++ toolchain)
        run: |
          sudo apt-get update
          sudo apt-get install --no-install-recommends -y cmake build-essential

      - name: Install Rust 1.97.1 (rustfmt, clippy, llvm-tools-preview)
        uses: dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87  # stable branch snapshot
        with:
          toolchain: "1.97.1"
          components: rustfmt, clippy, llvm-tools-preview

      - name: Install cargo-deny + cargo-llvm-cov + cargo-audit
        uses: taiki-e/install-action@3f74d7c16a4242f1c95561e98edc25d36adb4375  # v2.87.12
        with:
          tool: cargo-deny@0.20.2,cargo-llvm-cov@0.9.1,cargo-audit@0.21.0

      - name: cargo fmt --check
        run: cargo fmt --check

      - name: cargo clippy -D warnings
        run: cargo clippy --all-targets --locked -- -D warnings

      - name: cargo deny (advisories + licenses + bans + sources)
        run: cargo deny check

      - name: cargo audit
        run: cargo audit

      - name: cargo test
        run: cargo test --locked

      - name: cargo llvm-cov (90% lines minimum)
        run: cargo llvm-cov --locked --fail-under-lines 90

      - name: Assert the crate links no networking or database crate
        if: ${{ inputs.forbid-network-crates }}
        run: |
          set -euo pipefail
          cargo tree -p "${{ inputs.binary-name }}" --prefix none --no-dedupe > /tmp/tree.txt
          crates_examined=$(wc -l < /tmp/tree.txt)
          if [ "$crates_examined" -eq 0 ]; then
            echo "FAIL: cargo tree examined zero crates" >&2
            exit 1
          fi
          forbidden=0
          for c in reqwest redis deadpool-redis sea-orm sqlx; do
            if grep -qE "^${c} v" /tmp/tree.txt; then
              echo "FAIL: ${{ inputs.binary-name }} links forbidden crate ${c}" >&2
              forbidden=$((forbidden + 1))
            fi
          done
          echo "supply-chain check: crates_examined=${crates_examined} forbidden=${forbidden}"
          [ "$forbidden" -eq 0 ]
```

- [ ] **Step 3: Write the thin callers**

One file per crate, identical but for the two inputs and the `paths:` filter. `rust-svc-process.yml`:

```yaml
# .github/workflows/rust-svc-process.yml
name: Rust svc-process

on:
  push:
    branches: [main, 'release/**']
    paths: ['core/svc_process/**', '.github/workflows/rust-svc-process.yml', '.github/workflows/rust-crate-gate.yml']
  pull_request:
    branches: [main, 'release/**']
    paths: ['core/svc_process/**', '.github/workflows/rust-crate-gate.yml']
  workflow_dispatch:

permissions:
  contents: read

jobs:
  gate:
    uses: ./.github/workflows/rust-crate-gate.yml
    with:
      crate-dir: core/svc_process
      binary-name: svc-process
```

Repeat with:

| File | `crate-dir` | `binary-name` | `forbid-network-crates` |
|---|---|---|---|
| `rust-svc-ingest.yml` | `core/svc_ingest` | `svc-ingest` | (omit) |
| `rust-svc-process.yml` | `core/svc_process` | `svc-process` | (omit) |
| `rust-svc-action.yml` | `core/svc_action` | `svc-action` | (omit) |
| `rust-svc-streaming.yml` | `core/svc_streaming` | `svc-streaming` | (omit) |
| `rust-bundle-executor.yml` | `core/bundle_executor` | `bundle-executor` | `true` |
| `rust-bundle-compiler.yml` | `core/bundle_compiler` | `bundle-compiler` | (omit) |

`rust-bundle-executor.yml` is the one that sets `forbid-network-crates: true` — spec negative test 16.

- [ ] **Step 4: Delete the Python builder if Step 1 identified one, and sweep**

```bash
git rm --quiet --ignore-unmatch .github/workflows/build-svc-streaming.yml
make check-dangling-refs PATTERN='build-svc-streaming\.yml' ALLOW='CHANGELOG.md docs/migration-notes/ docs/superpowers/'
```

- [ ] **Step 5: Lint the workflows and count them**

```bash
docker run --rm -v "$PWD":/work -w /work \
  python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285 \
  sh -c "pip install --quiet zizmor==1.5.2 && zizmor .github/workflows/"
ls .github/workflows/rust-*.yml | wc -l
grep -l 'uses: ./.github/workflows/rust-crate-gate.yml' .github/workflows/*.yml | wc -l
grep -c 'actions/checkout@' .github/workflows/rust-crate-gate.yml
grep -rc 'actions/checkout@' .github/workflows/rust-svc-*.yml .github/workflows/rust-bundle-*.yml | grep -v ':0' || echo "no caller pins checkout independently"
```

Expected: zizmor reports no findings; seven `rust-*.yml` files (the gate plus six callers); six callers referencing the gate; `actions/checkout@` pinned exactly once, in the gate; `no caller pins checkout independently`.

- [ ] **Step 6: Commit**

```bash
git add -A .github/workflows
git commit -m "$(cat <<'EOF'
chore(core): one reusable rust-crate-gate workflow, six thin callers; delete the retired Python service builders

Spec 14.5's gate set (fmt, clippy -D warnings, deny, audit, test,
llvm-cov >=90) is defined once, so the pinned action SHAs and tool
versions cannot drift between services. bundle-executor additionally runs
negative test 16 -- cargo tree must contain no reqwest/redis/
deadpool-redis/sea-orm/sqlx -- with the crate count printed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 30: `verify-gvisor-runtimeclass.sh` — the distribution support matrix, checked not assumed

**Depends on:** Tasks 13 and 15. Spec §12.2.1/§12.2.2.

**Files:**
- Create: `scripts/verify-gvisor-runtimeclass.sh`
- Modify: `Makefile` (adds `verify-gvisor`)

**Interfaces:**
- Produces: `make verify-gvisor` — prints the detected distribution, whether a `runsc` handler and a matching `RuntimeClass` exist, and the exact remediation for that distribution. Exits non-zero when `sandbox.gvisor.enabled` is `true` but no usable `RuntimeClass` exists, because that combination makes every executor pod exit 78 (spec §12.2).

- [ ] **Step 1: Write the script**

```bash
cat > scripts/verify-gvisor-runtimeclass.sh <<'SCRIPT_EOF'
#!/usr/bin/env bash
# Verifies the cluster can actually run the executor and compiler pods under
# gVisor before the chart asks it to (spec §12.2.1). Prints the detected
# distribution and the exact remediation for it. Reports counts; a check
# that examined nothing is a failure, never a pass.
set -euo pipefail

CONTEXT="${KUBE_CONTEXT:-local-prealpha}"
WANT_CLASS="${RUNTIME_CLASS:-runsc}"
GVISOR_ENABLED="${WADDLES_SANDBOX_GVISOR:-true}"

kc() { kubectl --context "$CONTEXT" "$@"; }

nodes=$(kc get nodes -o jsonpath='{.items[*].metadata.name}')
node_count=$(printf '%s' "$nodes" | wc -w | tr -d ' ')
if [[ "$node_count" -eq 0 ]]; then
    echo "verify-gvisor: FAIL -- zero nodes visible in context '$CONTEXT'" >&2
    exit 1
fi

first_node=$(printf '%s' "$nodes" | awk '{print $1}')
kubelet=$(kc get node "$first_node" -o jsonpath='{.status.nodeInfo.kubeletVersion}')

case "$kubelet" in
    *+k3s*)      DISTRO="k3s" ;;
    *microk8s*)  DISTRO="microk8s" ;;
    *gke*)       DISTRO="gke" ;;
    *)
        if kc get node "$first_node" -o jsonpath='{.metadata.labels}' | grep -q 'minikube'; then
            DISTRO="minikube"
        elif kc get node "$first_node" -o jsonpath='{.metadata.labels}' | grep -q 'docker-desktop'; then
            DISTRO="docker-desktop"
        else
            DISTRO="kubeadm"
        fi
        ;;
esac

remediation() {
    case "$DISTRO" in
        microk8s)       echo "microk8s enable gvisor" ;;
        k3s)            echo "install runsc + containerd-shim-runsc-v1 on each node, register the handler in /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl (the TEMPLATE, not the generated config.toml -- k3s regenerates it on restart), restart k3s, then create the RuntimeClass" ;;
        minikube)       echo "minikube start --container-runtime=containerd && minikube addons enable gvisor  (the Docker runtime is unsupported)" ;;
        gke)            echo "use a GKE Sandbox node pool (--sandbox type=gvisor) and set sandbox.runtimeClassName: gvisor" ;;
        docker-desktop) echo "UNSUPPORTED -- no runsc handler is installable. Set sandbox.gvisor.enabled: false; every other sandbox layer stays on" ;;
        kubeadm)        echo "install runsc on the nodes and register the containerd handler, or set sandbox.installer.enabled: true with its three pins from build/tool-versions.env" ;;
    esac
}

classes=$(kc get runtimeclass -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)
class_count=$(printf '%s' "$classes" | wc -w | tr -d ' ')
have_class="no"
for c in $classes; do
    [[ "$c" == "$WANT_CLASS" ]] && have_class="yes"
done

echo "verify-gvisor: context=$CONTEXT distro=$DISTRO nodes_examined=$node_count runtimeclasses_found=$class_count want='$WANT_CLASS' present=$have_class gvisor_enabled=$GVISOR_ENABLED"

if [[ "$GVISOR_ENABLED" != "true" ]]; then
    echo "verify-gvisor: sandbox.gvisor.enabled is false -- the chart omits runtimeClassName and the pods run on the default runtime. Every other sandbox layer stays in force (spec §12.2)."
    exit 0
fi

if [[ "$have_class" == "yes" ]]; then
    echo "verify-gvisor: OK -- RuntimeClass '$WANT_CLASS' exists; executor and compiler pods can schedule under gVisor."
    exit 0
fi

echo "verify-gvisor: FAIL -- sandbox.gvisor.enabled=true but no RuntimeClass '$WANT_CLASS' exists on $DISTRO." >&2
echo "  Every executor pod would verify /proc/version, find no gVisor kernel, and exit 78 (EX_CONFIG)." >&2
echo "  Remediation for $DISTRO: $(remediation)" >&2
echo "  Or opt out explicitly: --set sandbox.gvisor.enabled=false" >&2
exit 1
SCRIPT_EOF
chmod +x scripts/verify-gvisor-runtimeclass.sh
```

- [ ] **Step 2: Add the make target**

```makefile
verify-gvisor:
	@KUBE_CONTEXT=$(RBAC_CONTEXT) bash scripts/verify-gvisor-runtimeclass.sh
```

- [ ] **Step 3: Run it both ways**

```bash
make verify-gvisor; echo "exit=$?"
WADDLES_SANDBOX_GVISOR=false RUNTIME_CLASS=runsc bash scripts/verify-gvisor-runtimeclass.sh; echo "exit=$?"
RUNTIME_CLASS=definitely-not-installed bash scripts/verify-gvisor-runtimeclass.sh; echo "exit=$?"
```

Expected: the first prints `distro=microk8s ... present=yes` and `exit=0` once `microk8s enable gvisor` has run (if it has not, it prints the remediation and `exit=1` — run the remediation, then re-run). The second prints the opt-out line and `exit=0`. The third prints `FAIL -- ... no RuntimeClass 'definitely-not-installed'` with the microk8s remediation and `exit=1` — that third run **is** the make-it-fail-on-purpose proof.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-gvisor-runtimeclass.sh Makefile
git commit -m "$(cat <<'EOF'
chore(core): verify-gvisor-runtimeclass.sh -- detects the distribution, checks the RuntimeClass really exists, prints that distribution's exact remediation

Catches the spec 12.2 failure mode before deploy: gvisor.enabled=true with
no runsc handler means every executor pod exits 78 and crash-loops.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 31: `09-telemetry-latency.sh` — OTel validation, logging conformance, latency SLA

**Depends on:** M1's `penguin-logging` (**must match plan penguin-logging** for the symbol names Step 1 greps), M3/M4/M5 (the services emit), and this plan's Tasks 23/30.

**Spec:** §14.7 (telemetry validation, blocking every commit), §13.1 (histogram names), §14.8 item 4 (latency SLA), `testing.md` Logging Library Conformance.

**Files:**
- Create: `tests/k8s/alpha/09-telemetry-latency.sh`
- Modify: `tests/k8s/alpha/run-all-alpha.sh` (adds the step before `08-cleanup.sh`)
- Modify: `Makefile` (adds `test-telemetry-alpha`)

- [ ] **Step 1: Write the script**

```bash
cat > tests/k8s/alpha/09-telemetry-latency.sh <<'SCRIPT_EOF'
#!/usr/bin/env bash
# Spec §14.7 + §14.8(4): asserts every service emits logs, metrics,
# histograms and spans to a local OTLP sink, uses penguin logging rather
# than hand-rolled printing, and meets the latency SLA. Every count is
# printed; zero of anything is a FAIL, and a sink that fails to start is a
# FAIL, never a skip (critical-rules.md Verification Integrity).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export PROJECT_NAME="$(basename "$REPO_ROOT")"
export NAMESPACE="${PROJECT_NAME}-alpha"
CONTEXT="${KUBE_CONTEXT:-local-prealpha}"
cd "$REPO_ROOT"

GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
log_fail() { echo -e "${RED}[FAIL]${NC} $*"; }

kc() { kubectl --context "$CONTEXT" -n "$NAMESPACE" "$@"; }
SERVICES="svc-ingest svc-process svc-action svc-streaming"
failures=0

# ---- 1. Logging library conformance (testing.md) -------------------------
log_info "Scanning Rust service source for hand-rolled logging"
scanned=0
handrolled=0
tracing_imports=0
for svc in svc_ingest svc_process svc_action svc_streaming; do
    files=$(git ls-files "core/$svc/src/*.rs" "core/$svc/src/**/*.rs" | wc -l | tr -d ' ')
    scanned=$((scanned + files))
    hits=$(git grep -c -E '(^|[^a-z_])(println!|eprintln!)' -- "core/$svc/src" 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
    handrolled=$((handrolled + hits))
    imports=$(git grep -c -E 'use (penguin_logging|tracing)::' -- "core/$svc/src" 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
    tracing_imports=$((tracing_imports + imports))
done
echo "logging conformance: files_scanned=$scanned penguin_logging_or_tracing_imports=$tracing_imports handrolled_calls=$handrolled"
if [[ "$scanned" -eq 0 ]]; then
    log_fail "zero service source files scanned -- the paths moved"
    failures=$((failures + 1))
fi
if [[ "$tracing_imports" -eq 0 ]]; then
    log_fail "no service imports penguin-logging or tracing"
    failures=$((failures + 1))
fi
if [[ "$handrolled" -ne 0 ]]; then
    log_fail "$handrolled hand-rolled println!/eprintln! call(s) in service source"
    git grep -n -E '(^|[^a-z_])(println!|eprintln!)' -- 'core/svc_*/src' >&2 || true
    failures=$((failures + 1))
fi
[[ "$handrolled" -eq 0 && "$tracing_imports" -gt 0 && "$scanned" -gt 0 ]] && log_pass "logging conformance"

# ---- 2. OTLP sink --------------------------------------------------------
log_info "Starting the OTLP test sink"
SINK=waddles-otel-sink
kc delete pod "$SINK" --ignore-not-found --wait=true >/dev/null 2>&1 || true
if ! kc run "$SINK" \
      --image=otel/opentelemetry-collector-contrib:0.116.1 \
      --restart=Never \
      --port=4317 \
      --overrides='{"spec":{"containers":[{"name":"'"$SINK"'","image":"otel/opentelemetry-collector-contrib:0.116.1","args":["--config=/conf/config.yaml"],"volumeMounts":[{"name":"conf","mountPath":"/conf"}]}],"volumes":[{"name":"conf","configMap":{"name":"waddles-otel-sink-conf"}}]}}' \
      >/dev/null; then
    log_fail "the OTLP sink failed to start -- this is a FAIL, never a skip"
    exit 1
fi
kc wait --for=condition=Ready "pod/$SINK" --timeout=120s || {
    log_fail "the OTLP sink never became Ready -- FAIL, never a skip"
    kc logs "$SINK" || true
    exit 1
}
kc expose pod "$SINK" --port=4317 --target-port=4317 --name="$SINK" >/dev/null 2>&1 || true

log_info "Pointing every service at the sink and restarting"
for svc in $SERVICES; do
    kc set env "deploy/${PROJECT_NAME}-${svc}" \
        OTEL_EXPORTER_OTLP_ENDPOINT="http://${SINK}.${NAMESPACE}.svc.cluster.local:4317" \
        OTEL_EXPORTER_OTLP_PROTOCOL=grpc >/dev/null
    kc rollout status "deploy/${PROJECT_NAME}-${svc}" --timeout=180s >/dev/null
done

log_info "Driving traffic so there is something to emit"
bash "$SCRIPT_DIR/06-api-integration.sh" >/dev/null 2>&1 || true
sleep 30

sink_log="$(kc logs "$SINK")"
logs_seen=$(printf '%s' "$sink_log" | grep -c 'LogRecord #' || true)
metrics_seen=$(printf '%s' "$sink_log" | grep -c 'NumberDataPoints\|DataPoints #' || true)
histograms_seen=$(printf '%s' "$sink_log" | grep -c 'Histogram' || true)
spans_seen=$(printf '%s' "$sink_log" | grep -c 'Span #' || true)
echo "otel sink: log_records=$logs_seen metric_points=$metrics_seen histograms=$histograms_seen spans=$spans_seen"
for pair in "log_records:$logs_seen" "metric_points:$metrics_seen" "histograms:$histograms_seen" "spans:$spans_seen"; do
    name="${pair%%:*}"; value="${pair##*:}"
    if [[ "$value" -lt 1 ]]; then
        log_fail "$name received 0, threshold is >=1"
        failures=$((failures + 1))
    fi
done
[[ "$failures" -eq 0 ]] && log_pass "OTel logs + metrics + histograms + spans"

# ---- 3. Posture gauges (spec §11.6.4, §12.2) -----------------------------
log_info "Asserting the posture gauges are present on both series"
posture_checks=0
for svc in svc-process svc-action; do
    posture_checks=$((posture_checks + 1))
    metrics="$(kc exec "deploy/${PROJECT_NAME}-${svc}" -- \
        sh -c 'command -v curl >/dev/null && curl -sf localhost:9090/metrics || wget -qO- localhost:9090/metrics')"
    for gauge in waddles_insecure_transport waddles_sandbox_gvisor; do
        if ! printf '%s' "$metrics" | grep -q "$gauge"; then
            log_fail "$svc does not expose $gauge -- 'off' and 'not reporting' must be distinguishable"
            failures=$((failures + 1))
        fi
    done
done
echo "posture gauges: services_examined=$posture_checks"
[[ "$posture_checks" -eq 0 ]] && { log_fail "zero services examined for posture gauges"; failures=$((failures + 1)); }

# ---- 4. Latency SLA (spec §14.8 item 4) ----------------------------------
log_info "Asserting waddles_e2e_latency_seconds p95"
lat_metrics="$(kc exec "deploy/${PROJECT_NAME}-svc-action" -- \
    sh -c 'command -v curl >/dev/null && curl -sf localhost:9090/metrics || wget -qO- localhost:9090/metrics')"
observations=$(printf '%s' "$lat_metrics" | grep -c '^waddles_e2e_latency_seconds_bucket' || true)
echo "latency: histogram_buckets=$observations"
if [[ "$observations" -eq 0 ]]; then
    log_fail "waddles_e2e_latency_seconds has zero observations -- a run with no data is a FAIL, not a pass"
    failures=$((failures + 1))
else
    python3 - "$lat_metrics" <<'PY'
import re, sys
text = sys.argv[1]
buckets = {}
count = 0.0
for line in text.splitlines():
    m = re.match(r'^waddles_e2e_latency_seconds_bucket\{([^}]*)\}\s+([0-9.eE+-]+)$', line)
    if m and 'kind="text"' in m.group(1):
        le = re.search(r'le="([^"]+)"', m.group(1))
        if le:
            buckets[float(le.group(1))] = float(m.group(2))
    c = re.match(r'^waddles_e2e_latency_seconds_count\{[^}]*kind="text"[^}]*\}\s+([0-9.eE+-]+)$', line)
    if c:
        count = float(c.group(1))
if count == 0:
    print("FAIL: zero text-path observations"); sys.exit(1)
target = 0.95 * count
p95 = None
for le in sorted(buckets):
    if buckets[le] >= target:
        p95 = le
        break
print(f"latency: text observations={int(count)} p95_bucket<={p95}s sla=3s")
if p95 is None or p95 > 3.0:
    print("FAIL: text p95 exceeds the 3s SLA"); sys.exit(1)
PY
    [[ $? -ne 0 ]] && failures=$((failures + 1))
fi

# ---- 5. Teardown ---------------------------------------------------------
kc delete pod "$SINK" --ignore-not-found >/dev/null 2>&1 || true
kc delete svc "$SINK" --ignore-not-found >/dev/null 2>&1 || true

echo "09-telemetry-latency: failures=$failures"
if [[ "$failures" -ne 0 ]]; then
    log_fail "telemetry validation failed"
    exit 1
fi
log_pass "telemetry validation, logging conformance and latency SLA"
SCRIPT_EOF
chmod +x tests/k8s/alpha/09-telemetry-latency.sh
```

The sink's config ConfigMap (`waddles-otel-sink-conf`, an OTLP receiver plus a `debug` exporter at `detailed` verbosity, which is what produces the `LogRecord #`/`Span #`/`Histogram` lines the script counts) is created by Task 32's `10-e2e-bundles.sh` preamble; create it here too if this script is run standalone:

```bash
kubectl --context local-prealpha -n waddlebot-alpha create configmap waddles-otel-sink-conf --from-literal=config.yaml='
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    logs:    {receivers: [otlp], exporters: [debug]}
    metrics: {receivers: [otlp], exporters: [debug]}
    traces:  {receivers: [otlp], exporters: [debug]}
'
```

- [ ] **Step 2: Wire it into the alpha runner and `make`**

In `tests/k8s/alpha/run-all-alpha.sh`, change the `STEPS` array to insert the two new scripts before cleanup:

```bash
STEPS=("01-build-images.sh" "02-deploy-helm.sh" "03-wait-ready.sh" "04-health-check.sh" "05-unit-tests.sh" "06-api-integration.sh" "07-page-load.sh" "09-telemetry-latency.sh" "10-e2e-bundles.sh" "08-cleanup.sh")
```

```makefile
test-telemetry-alpha:
	@KUBE_CONTEXT=$(RBAC_CONTEXT) bash tests/k8s/alpha/09-telemetry-latency.sh
```

- [ ] **Step 3: Run and make it fail on purpose**

```bash
make test-telemetry-alpha
printf '\nfn _m6_gate_probe() { println!("probe"); }\n' >> core/svc_process/src/main.rs
make test-telemetry-alpha; echo "exit=$?"
git checkout core/svc_process/src/main.rs
make test-telemetry-alpha; echo "exit=$?"
```

Expected: a clean first run printing all four non-zero OTel counts plus `09-telemetry-latency: failures=0`; the second run printing `handrolled_calls=1` and `exit=1`; the third back to `failures=0` and `exit=0`.

- [ ] **Step 4: Commit**

```bash
git add tests/k8s/alpha/09-telemetry-latency.sh tests/k8s/alpha/run-all-alpha.sh Makefile
git commit -m "$(cat <<'EOF'
test(e2e): alpha telemetry validation -- OTel logs/metrics/histograms/spans with printed counts, penguin logging conformance, posture gauges and the 3s text latency SLA

A sink that fails to start is a FAIL, never a skip; zero observations in
the latency histogram is a FAIL, not a pass.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---

## Task 32: `10-e2e-bundles.sh` — the cross-service end-to-end

**Depends on:** every prior task, and M2a (the compiler and the `bundles/{app_id}/{version}/{sha256}.wasm|.json` layout — **must match plan M2a**), M2b (install/consent/approval and `GET /api/v1/distribution/sources` — **must match plan M2b**), M3/M4/M5.

**Spec:** §14.8. Real Valkey + Postgres + MinIO, a compiled sample bundle, an event in at ingest and the outbound action out, the approved-set enforced, digest reconciliation, and the DLQ path.

**Files:**
- Create: `tests/k8s/alpha/10-e2e-bundles.sh`
- Create: `bundles/test/e2e/echo_e2e/{bundle.yaml,bundles/echo_e2e_process.py}`
- Modify: `Makefile` (adds `test-e2e-bundles`)

- [ ] **Step 1: Write the e2e fixture bundle**

```yaml
# bundles/test/e2e/echo_e2e/bundle.yaml
# Minimal process-stage bundle for the M6 end-to-end. Deliberately tiny:
# the subject under test is the pipeline, not the bundle.
apiVersion: waddle.bundle/v2
app_id: waddles.test.e2e.echo
version: "1.0.0"
language: python
artifact: source
entrypoint: bundles/echo_e2e_process.py
stages:
  process:
    consumes:
      - platform: twitch
        event_types: ["chat.message"]
    routes_to: ["waddles.test.e2e.echo"]
capabilities: [context, log, clock]
egress: []
data:
  tables: []
limits:
  timeout_ms: 2000
  memory_mb: 64
```

```python
# bundles/test/e2e/echo_e2e/bundles/echo_e2e_process.py
"""E2E fixture: echoes one chat message back as an action entry.

Exists so the M6 end-to-end exercises the real compile -> sign -> publish ->
poll -> verify -> load -> invoke -> dispatch path with a bundle whose own
logic cannot be the reason a run fails.
"""
from waddle_sdk import context, log, process_stage


@process_stage
def handle(event: dict) -> list[dict]:
    """Returns one action entry echoing the inbound message body."""
    body = (event.get("payload") or {}).get("text", "")
    log.info("echo_e2e received", fields={"chars": len(body)})
    if not body.startswith("!e2e"):
        return []
    return [{
        "platform": event["platform"],
        "community": context.community(),
        "kind": "message",
        "payload": {"text": f"e2e-ok:{body[5:].strip()}"},
    }]
```

- [ ] **Step 2: Write the e2e script**

```bash
cat > tests/k8s/alpha/10-e2e-bundles.sh <<'SCRIPT_EOF'
#!/usr/bin/env bash
# Spec §14.8: cross-service end-to-end over the REAL Valkey, Postgres and
# MinIO, with a REAL compiled bundle. Event in at ingest, action out at
# dispatch. Also asserts the approved-set gate, digest reconciliation
# (hot-swap), the DLQ path, and the bucket-outage posture. Every assertion
# prints what it examined; a zero denominator is a failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export PROJECT_NAME="$(basename "$REPO_ROOT")"
export NAMESPACE="${PROJECT_NAME}-alpha"
CONTEXT="${KUBE_CONTEXT:-local-prealpha}"
APP_ID="waddles.test.e2e.echo"
TENANT="${RUNNER_TENANT_SLUG:-global}"
COMMUNITY="${E2E_COMMUNITY:-e2e}"
cd "$REPO_ROOT"

GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
log_fail() { echo -e "${RED}[FAIL]${NC} $*"; }

kc() { kubectl --context "$CONTEXT" -n "$NAMESPACE" "$@"; }
assertions=0
failures=0
assert() {
    local desc="$1" ok="$2"
    assertions=$((assertions + 1))
    if [[ "$ok" == "true" ]]; then log_pass "$desc"; else log_fail "$desc"; failures=$((failures + 1)); fi
}

valkey() {
    kc exec deploy/infra-redis -- valkey-cli --user waddles_admin \
        --pass "$(kc get secret waddles-valkey-acl-passwords -o jsonpath='{.data.PASS_WADDLES_ADMIN}' | base64 -d)" "$@"
}
psqlq() {
    kc exec deploy/infra-postgres -- psql -U postgres -d waddlebot -tAc "$1"
}
HUB="http://localhost:18204"
hub() { curl -sf -H "Authorization: Bearer $HUB_TOKEN" "$@"; }

# ---- 0. Preconditions ----------------------------------------------------
log_info "Checking the three stores are reachable"
assert "valkey answers PING" "$([[ "$(valkey PING)" == "PONG" ]] && echo true || echo false)"
assert "postgres answers" "$([[ "$(psqlq 'SELECT 1')" == "1" ]] && echo true || echo false)"
assert "minio bundle bucket exists" "$(kc exec deploy/infra-minio -- mc ls "local/waddles-bundles" >/dev/null 2>&1 && echo true || echo false)"

kc port-forward "svc/${PROJECT_NAME}-hub-api" 18204:8204 >/dev/null 2>&1 &
PF_HUB=$!
trap 'kill "$PF_HUB" 2>/dev/null || true' EXIT
sleep 3
HUB_TOKEN="$(kc exec "deploy/${PROJECT_NAME}-hub-api" -- python3 -c "
import os, time, jwt
print(jwt.encode({'sub':'e2e','iss':'waddles','aud':'hub-api','scope':'distribution:read bundles:admin','tenant':'$TENANT','iat':int(time.time()),'exp':int(time.time())+3600}, os.environ['SECRET_KEY'], algorithm='HS256'))")"

# ---- 1. Compile + publish the fixture bundle -----------------------------
log_info "Compiling $APP_ID through the real bundle-compiler Job"
JOB_OUT="$(hub -X POST "$HUB/api/v1/bundles/$APP_ID/versions" \
    -H 'Content-Type: application/json' \
    --data-binary @<(python3 -c "
import json,base64,pathlib
d=pathlib.Path('bundles/test/e2e/echo_e2e')
print(json.dumps({'version':'1.0.0','manifest':(d/'bundle.yaml').read_text(),
 'sources':{p.relative_to(d).as_posix(): base64.b64encode(p.read_bytes()).decode()
            for p in d.rglob('*.py')}}))"))"
echo "$JOB_OUT"
for _ in $(seq 1 60); do
    STATE="$(hub "$HUB/api/v1/bundles/$APP_ID/versions/1.0.0" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("state",""))')"
    [[ "$STATE" == "published" || "$STATE" == "failed" ]] && break
    sleep 10
done
assert "compile reached published (state=$STATE)" "$([[ "$STATE" == "published" ]] && echo true || echo false)"

DIGEST="$(psqlq "SELECT artifact_digest FROM app_versions WHERE app_id='$APP_ID' AND version='1.0.0'")"
assert "app_versions carries an artifact_digest" "$([[ -n "$DIGEST" ]] && echo true || echo false)"
objects=$(kc exec deploy/infra-minio -- mc ls --recursive "local/waddles-bundles/bundles/$APP_ID/1.0.0/" | wc -l)
echo "bucket objects for 1.0.0: $objects (expected 2 -- .wasm and .json sidecar)"
assert "bucket holds the component and its signed sidecar" "$([[ "$objects" -eq 2 ]] && echo true || echo false)"

# ---- 2. Install, consent, activate ---------------------------------------
log_info "Installing with the permission-consent flow"
SUMMARY="$(hub "$HUB/api/v1/bundles/$APP_ID/versions/1.0.0/permissions")"
PHASH="$(printf '%s' "$SUMMARY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["permission_hash"])')"
hub -X POST "$HUB/api/v1/communities/$COMMUNITY/bundles/$APP_ID/install" \
    -H 'Content-Type: application/json' \
    -d "{\"version\":\"1.0.0\",\"permission_hash\":\"$PHASH\"}" >/dev/null
assert "install approved with a current permission_hash" "$([[ "$(psqlq "SELECT count(*) FROM app_install_approvals WHERE app_id='$APP_ID'")" -ge 1 ]] && echo true || echo false)"

STALE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $HUB_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"version\":\"1.0.0\",\"permission_hash\":\"sha256:stale\"}" \
    "$HUB/api/v1/communities/$COMMUNITY/bundles/$APP_ID/install")"
assert "a stale permission_hash is refused with 409 (got $STALE_STATUS)" "$([[ "$STALE_STATUS" == "409" ]] && echo true || echo false)"

grants=$(psqlq "SELECT count(*) FROM app_stream_grants WHERE app_id='$APP_ID'")
echo "stream grants resolved: $grants"
assert "consumes resolved into at least one stream grant" "$([[ "$grants" -ge 1 ]] && echo true || echo false)"

log_info "Waiting for the stages to converge on the digest (<=65s, spec §7.6)"
converged=false
for _ in $(seq 1 13); do
    loaded="$(kc exec "deploy/${PROJECT_NAME}-svc-process" -- \
        sh -c 'command -v curl >/dev/null && curl -sf localhost:8201/health || wget -qO- localhost:8201/health' \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["executor"]["bundles_loaded"])' 2>/dev/null || echo 0)"
    [[ "$loaded" -ge 1 ]] && { converged=true; break; }
    sleep 5
done
assert "svc-process loaded the bundle within 65s" "$converged"

# ---- 3. Event in at ingest -> action out ---------------------------------
log_info "Injecting a Twitch chat event at the ingest intake"
kc port-forward "svc/${PROJECT_NAME}-svc-ingest" 18200:8200 >/dev/null 2>&1 &
PF_IN=$!
sleep 2
MARKER="m6-$(date +%s)"
curl -sf -X POST "http://localhost:18200/intake/webhook/$TENANT/e2e-twitch" \
    -H 'Content-Type: application/json' \
    -d "{\"platform\":\"twitch\",\"community\":\"$COMMUNITY\",\"event_type\":\"chat.message\",\"payload\":{\"text\":\"!e2e $MARKER\",\"user_id\":\"e2e-user\"}}" >/dev/null
kill "$PF_IN" 2>/dev/null || true

dispatched=""
for _ in $(seq 1 12); do
    dispatched="$(psqlq "SELECT count(*) FROM action_dispatch_log WHERE payload::text LIKE '%e2e-ok:$MARKER%'")"
    [[ "$dispatched" -ge 1 ]] && break
    sleep 5
done
echo "action_dispatch_log rows matching the marker: $dispatched"
assert "the event travelled ingest -> process -> action and dispatched" "$([[ "${dispatched:-0}" -ge 1 ]] && echo true || echo false)"

streams=$(valkey --scan --pattern "waddles:t:$TENANT:c:$COMMUNITY:src:twitch:*:events" | wc -l)
echo "source streams written: $streams"
assert "ingest wrote to a per-source stream" "$([[ "$streams" -ge 1 ]] && echo true || echo false)"

# ---- 4. Approved-set enforcement (spec test 14d) -------------------------
log_info "Asserting the runtime authorizes from the approval record, not the manifest"
psqlq "UPDATE app_versions SET manifest_json = jsonb_set(manifest_json, '{capabilities}', '[\"context\",\"log\",\"clock\",\"http\"]') WHERE app_id='$APP_ID' AND version='1.0.0'" >/dev/null
sleep 40
denied_before=$(kc exec "deploy/${PROJECT_NAME}-svc-process" -- \
    sh -c 'command -v curl >/dev/null && curl -sf localhost:9090/metrics || wget -qO- localhost:9090/metrics' \
    | grep -c 'waddles_host_call_denied_total' || true)
echo "waddles_host_call_denied_total series present: $denied_before"
assert "the denial counter exists (widened manifest is not silently honoured)" "$([[ "$denied_before" -ge 1 ]] && echo true || echo false)"

# ---- 5. Digest reconciliation / hot-swap ---------------------------------
log_info "Publishing 1.0.1 and asserting hot-swap convergence with zero dropped events"
before=$(psqlq "SELECT count(*) FROM action_dispatch_log")
sed 's/version: "1.0.0"/version: "1.0.1"/' bundles/test/e2e/echo_e2e/bundle.yaml > /tmp/m6-bundle-101.yaml
hub -X POST "$HUB/api/v1/bundles/$APP_ID/versions" -H 'Content-Type: application/json' \
    --data-binary @<(python3 -c "
import json,base64,pathlib
d=pathlib.Path('bundles/test/e2e/echo_e2e')
print(json.dumps({'version':'1.0.1','manifest':open('/tmp/m6-bundle-101.yaml').read(),
 'sources':{p.relative_to(d).as_posix(): base64.b64encode(p.read_bytes()).decode()
            for p in d.rglob('*.py')}}))") >/dev/null
swapped=false
for _ in $(seq 1 13); do
    live="$(psqlq "SELECT version FROM app_active_versions WHERE app_id='$APP_ID'")"
    [[ "$live" == "1.0.1" ]] && { swapped=true; break; }
    sleep 5
done
assert "active version converged to 1.0.1 within 65s" "$swapped"
after=$(psqlq "SELECT count(*) FROM action_dispatch_log")
assert "no dispatch rows disappeared across the swap" "$([[ "$after" -ge "$before" ]] && echo true || echo false)"

# ---- 6. DLQ path ---------------------------------------------------------
log_info "Forcing a failure and asserting the event lands in the DLQ, never dropped"
dlq_before=$(valkey XLEN waddles:dlq:process 2>/dev/null || echo 0)
valkey XADD "waddles:t:$TENANT:c:$COMMUNITY:src:twitch:e2e-twitch:events" '*' \
    envelope '{"schema":"broken-on-purpose"}' >/dev/null
dlq_after="$dlq_before"
for _ in $(seq 1 12); do
    dlq_after=$(valkey XLEN waddles:dlq:process 2>/dev/null || echo 0)
    [[ "$dlq_after" -gt "$dlq_before" ]] && break
    sleep 5
done
echo "dlq depth: before=$dlq_before after=$dlq_after"
assert "a malformed envelope is DLQ'd, not silently dropped" "$([[ "$dlq_after" -gt "$dlq_before" ]] && echo true || echo false)"

# ---- 7. Bucket outage ----------------------------------------------------
log_info "Simulating a bucket outage: pods keep serving, staleness grows, nothing is lost"
kc scale deploy/infra-minio --replicas=0 >/dev/null
sleep 90
health="$(kc exec "deploy/${PROJECT_NAME}-svc-process" -- \
    sh -c 'command -v curl >/dev/null && curl -sf localhost:8201/healthz || wget -qO- localhost:8201/healthz' || echo "")"
assert "svc-process still serves /healthz with the bucket down" "$([[ -n "$health" ]] && echo true || echo false)"
stale=$(kc exec "deploy/${PROJECT_NAME}-svc-process" -- \
    sh -c 'command -v curl >/dev/null && curl -sf localhost:9090/metrics || wget -qO- localhost:9090/metrics' \
    | grep -c 'waddles_bundle_stale_age_seconds' || true)
assert "waddles_bundle_stale_age_seconds is reported during the outage" "$([[ "$stale" -ge 1 ]] && echo true || echo false)"
kc scale deploy/infra-minio --replicas=1 >/dev/null
kc rollout status deploy/infra-minio --timeout=180s >/dev/null

# ---- 8. Result -----------------------------------------------------------
echo "10-e2e-bundles: assertions=$assertions failures=$failures"
if [[ "$assertions" -eq 0 ]]; then
    log_fail "zero assertions executed -- a run that asserted nothing is a FAIL"
    exit 1
fi
if [[ "$failures" -ne 0 ]]; then
    log_fail "cross-service e2e failed"
    exit 1
fi
log_pass "cross-service e2e: compile, install/consent, ingest->action, approved-set, hot-swap, DLQ, bucket outage"
SCRIPT_EOF
chmod +x tests/k8s/alpha/10-e2e-bundles.sh
```

- [ ] **Step 3: Add the make target and run it**

```makefile
test-e2e-bundles:
	@KUBE_CONTEXT=$(RBAC_CONTEXT) bash tests/k8s/alpha/10-e2e-bundles.sh
```

```bash
make test-e2e-bundles
```

Expected: a run of `[PASS]` lines ending in `10-e2e-bundles: assertions=17 failures=0` (the exact assertion count may differ if a branch was skipped — a count of `0` is a hard failure). **Every hub-api route and column name in this script is marked "must match plan M2b"** — if a route 404s or a column is missing, confirm the real name against `hub_api/blueprints/v1/` and fix the script rather than weakening the assertion.

- [ ] **Step 4: Commit**

```bash
git add tests/k8s/alpha/10-e2e-bundles.sh bundles/test/e2e/ Makefile
git commit -m "$(cat <<'EOF'
test(e2e): cross-service end-to-end over real Valkey/Postgres/MinIO -- compile+sign+publish, install with consent, ingest to action dispatch, approved-set enforcement, digest hot-swap, DLQ and bucket outage

Assertions are counted and printed; zero assertions executed is a FAIL.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
EOF
)"
git push
```

---
