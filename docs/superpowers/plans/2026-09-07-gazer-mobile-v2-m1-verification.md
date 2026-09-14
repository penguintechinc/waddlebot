# Gazer Mobile 2.0 M1 — Verification Results

**Date:** 2026-09-14 | **HEAD:** `520df364fbf312bceaa4a93e66f1daff555d0a27` | **Branch:** `feature/gazer-mobile-v2` | **CI run A:** [`34883243843`](https://github.com/penguintechinc/waddlebot/actions/runs/34883243843) — **success**

Verification re-run against integration round 10 — the final fix wave (platform / Android / Dart-core / UI), per Task 26 brief Step 13 and ruling R41. This supersedes the round-9 results recorded here previously; every number below was re-measured against the run-A HEAD, not carried forward. All automated gates are green. One item — the manual physical-device stream/reconnect test — could not be performed in this automated agent environment (no physical phone, no real RTMP endpoint) and is recorded as **deferred**, not fabricated.

## Gate results

| Gate | Result |
|---|---|
| `make mobile-lint` | **PASS** (exit 0) — `flutter analyze`: No issues found (72.9s); `dart format --set-exit-if-changed .`: **127 files, 0 changed**; `ktlintCheck` + gradle `lint`: BUILD SUCCESSFUL (2m 3s, 532 tasks) |
| `make mobile-test` | **PASS** — **326/326** Dart tests passed; lcov coverage **93.18%** (1639/1759 lines), **44 files examined** (59 records total, 15 generated-file records excluded) — threshold 90% met. Includes the new on-disk completeness check: **44 of 46** hand-written `lib/` files carry a coverage record, **2 allowlisted** as statement-free (R43, below) |
| `make mobile-telemetry-check` | **PASS** — `telemetry sink received: logs=1 metrics=2 histograms=1 spans=2` — all four counts ≥1; spans now carry real 32-hex trace ids and 16-hex span ids (asserted in `otlp_sink_test.dart`, not just counted) |
| `make mobile-test-android` | **PASS** — **126/126** JUnit tests, 0 failures/errors/skips (**21** app-module `TEST-*.xml` files); JaCoCo **96.76%** (507/524 lines) — threshold 90% met |
| `make mobile-security` | **PASS** — osv-scanner: **156 packages** examined (`pubspec.lock`) + **162 packages** examined (`android/app/gradle.lockfile`), 0 vulnerabilities in either; semgrep: **465 rules** run on **148 files**, **0 findings**; gitleaks: **0 leaks** (2.19 MB scanned, 309 ms). Run against a `make mobile-clean` tree — see note below |
| `make mobile-build` | **PASS** — all 3 split-per-ABI APKs and the AAB built, obfuscated, split debug info; sizes below, all < 100 MB |
| `make mobile-test-integration` | **PASS** — Dart integration `00:18 +2: All tests passed!`; screenshot `build/integration_screenshots/go-live-unreachable.png` (53,008 bytes) decoded; `connectedDebugAndroidTest` **Starting 1 tests / Finished 1 tests**, BUILD SUCCESSFUL (non-zero test count asserted by the new I3 grep, not inferred from BUILD SUCCESSFUL) |
| `make mobile-screenshots` | **PASS** — exactly the 5 named files in `docs/screenshots/gazer/`; all 5 visually reviewed (no DEBUG ribbon, no error text, License row "Valid", Go Live enabled with its label fully settled, stream key masked) |
| `scripts/coverage_gate_selftest.sh` | **PASS** — all **6** synthetic fixtures (a, b, c1, c2, d1, d2), exit 0. Runs inside `make mobile-test` and as its own CI step, exactly as CI invokes it |
| CI (`gazer-mobile.yml`, run `34883243843`) | **PASS** — every job success or correctly skipped; table below |
| apksigner (CI-built APK) | **PASS (debug-signed, as expected)** — see below |
| Manual physical-device test | **DEFERRED** — see below, not fabricated |

### R43 — coverage completeness allowlist

The platform wave added an on-disk completeness check: every hand-written `lib/**.dart` file must appear as an `SF:` record in the lcov report, because `flutter test --coverage` emits records only for libraries a test actually loads — a file no test imports is invisible to the percentage rather than merely under-covered. Two files can never satisfy it, for a reason no test can change:

| File | Why it can never receive a record |
|---|---|
| `lib/config/constants.dart` | `const`-only library — compile-time values, zero executable statements. (`test/config/constants_test.dart` exercises the values regardless.) |
| `lib/models/validation_issue.dart` | Bare `@freezed` declaration; the whole implementation is generated into `validation_issue.freezed.dart`, which the generated-record filter already excludes. |

Both are named in `COMPLETENESS_ALLOWLIST` in `scripts/coverage_gate.sh` with that justification inline, and each is printed by name on every run rather than silently skipped. The check was simultaneously **strengthened**, not weakened: it now compares the two *sets* rather than their counts (equal counts could hide a swap — one file gaining a record while another lost one), fails naming every offending path, and treats a zero denominator as a failure. Selftest fixtures `d1`/`d2` prove both halves — an allowlisted absentee passes, and a non-allowlisted absentee alongside it still fails and is named. The ≥90% threshold is untouched and unaffected by the allowlist.

### R39 — semgrep ruleset

`--config auto` with an explicit `--metrics=on`, accepted for M1. The literal ruling asked for `--metrics=off`, which semgrep 1.176.1 refuses outright in combination with `--config auto` ("Cannot create auto config when metrics are off"), and vendoring a pinned ruleset is M2 scope — so the flag is explicit rather than implicit, with no behavior change. Binary version is pinned in the toolchain image (`SEMGREP_VERSION=1.176.1`); the registry served **1074 Code rules**, of which **465 ran** against **148 files** (18 skipped via `.semgrepignore`, 2 skipped for exceeding 1.0 MB) with **0 findings**, scanned 2026-09-14.

### `mobile-security` — clean-tree note

Unchanged from round 9 and applied again here: `mobile-security` is run after `make mobile-clean`. A tree still carrying local `build/` output produces gitleaks false positives (BouncyCastle class-path strings inside `build/.../zip-cache/...`), which are gitignored and absent from CI's fresh-checkout scan surface. Cleaning matches CI's actual surface; no gitleaks/semgrep/osv config was loosened.

### APK sizes (per ABI, all < 100 MB)

| Artifact | Size |
|---|---|
| `app-armeabi-v7a-release.apk` | 18,305,936 bytes (17.5 MB) |
| `app-arm64-v8a-release.apk` | 20,995,520 bytes (20.0 MB) |
| `app-x86_64-release.apk` | 22,479,296 bytes (21.4 MB) |
| `app-release.aab` (bundle) | 53.4 MB reported by Flutter / 50.9 MB on disk |

### CI run `34883243843` — per-job results

The workflow gained three jobs this round (telemetry gate, signed-release build, and ktlint + Android Lint folded into analyze), so this is a 10-job graph where round 9 had 7.

| Job | Conclusion |
|---|---|
| Build toolchain image | success (cache hit — Dockerfile untouched, tag stays `a0a28722ac14`) |
| Dart analyze (now incl. ktlint + Android Lint) | success |
| Dart unit tests + coverage gate (incl. coverage-gate selftest) | success |
| Kotlin unit tests + JaCoCo gate | success |
| Telemetry emission gate | success |
| Security scans | success |
| Build APK + AAB (debug/testing artifacts) | success |
| Build signed release APK + AAB (release tags only) | **skipped** — correct: gated on `refs/tags/gazer-v*` **and** the `gazer-release` environment, so the keystore-decode step never starts on a branch push |
| Integration test (emulator) | success |
| GitHub Release | skipped (not a `gazer-v*` tag — correct) |

An earlier run at HEAD `00ecaae8` ([`34880882720`](https://github.com/penguintechinc/waddlebot/actions/runs/34880882720)) failed on the emulator job alone and is fixed in `520df364`: the "Settings saved" SnackBar raised by the integration test's first step survives the Navigator pop (ScaffoldMessenger sits above the Navigator in MaterialApp) and covered the bottom-anchored Go Live button for its 4-second life, so the tap was swallowed. Test-only fix; no assertion relaxed.

### apksigner check (CI-built `app-arm64-v8a-release.apk`, via `gh run download 34883243843 -n gazer-apk`)

```
Signer #1 certificate DN: C=US, O=Android, CN=Android Debug
Signer #1 certificate SHA-256 digest: 9cbe011f595a38c80dafcc3408d72d2550da78c372d692225a9de36bf172a3f1
```

Exactly **1 signer**, and it is the **Android debug certificate**. Release signing is deferred, not silently skipped: it now lives in a separate `build-signed` job gated on a `gazer-v*` tag **and** the `gazer-release` GitHub Environment, and waits on the user supplying a keystore plus the four `ANDROID_UPLOAD_KEY_*` secrets **in that environment** (not as repo-level secrets). Until then `build` hardcodes `GAZER_REQUIRE_SIGNING=0` and never touches those secrets on any branch or PR push.

## Manual physical-device step — DEFERRED

Task 26 brief Step 13's manual step (install on a physical Pixel 8/9 or Galaxy S24, enter a real RTMP endpoint on-device, stream 5 minutes, disable Wi-Fi mid-stream, confirm bitrate within ±20% of 2000 kbps, dropped frames < 1%, and Streaming → Reconnecting → Streaming recovery without a manual Stop/Go-Live cycle) requires physical hardware and a real RTMP ingest endpoint that this automated environment does not have. It was **not performed** and its results are **not fabricated** here. It remains open and must be run by a human before the merge gate below is fully satisfied.

## Known deferred items

| Item | Status |
|---|---|
| Release signing (real upload keystore) | Waiting on the user's keystore + the four `ANDROID_UPLOAD_KEY_*` secrets, now to be placed in the **`gazer-release` GitHub Environment**; the `build-signed` job is already wired and correctly skipped until a `gazer-v*` tag exists |
| Manual physical-device stream/reconnect test | Not run (see above) — needs a human with hardware + a real RTMP endpoint |
| Repo-wide "Security & Code Quality" workflow | **Red** ([`34883243917`](https://github.com/penguintechinc/waddlebot/actions/runs/34883243917), same HEAD) on pre-existing Node audit findings outside `mobile/gazer` — equally red at round 9's HEAD and at `00ecaae8`; out of scope, not newly broken here. The repo-wide "Waddles CI/CD Pipeline" (`34883244032`) is green at this HEAD |
| `rtmps://` targets | Rejected in M1 (ruling R40) — RootEncoder 2.8.1 validates the certificate chain but never verifies the TLS hostname, and the switch is unreachable through `GenericStream`, so an `rtmps://` publish would accept any chain-valid certificate for any name. Planned for a later milestone; `TargetValidator` rejects the scheme with its own message, the README says so, and no seeded demo target uses it |
| USB capture-card (UVC) input | M2/M3 scope, not M1 |
| iOS client | Later milestone, not M1 |

## Merge gate

Per the brief: merge to `release/v3.0.X` happens via PR once every gate is green **and** the manual physical-device test passes. Every scripted and CI gate above is green at `520df364`. The manual physical-device step is the one remaining item before that gate is fully satisfied — flagged here rather than merged prematurely.
