# Gazer Mobile 2.0 — M2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Gazer Mobile 2.0 Milestone 2 — UVC capture-card support via Camera2's `LENS_FACING_EXTERNAL` path (Pixel 6+/Pixel Tablet-class hardware) plus USB Audio Class input, on top of M1's phone-camera → RTMP pipeline. Device enumeration with hot-plug, USB permission flow, resolution/fps negotiation against the card's real stream configurations, audio-follows-video-source selection with an explicit override, and the failure semantics for detach/permission-denied/unsupported-format — all through the existing never-throw Pigeon bridge, extending zero new contract surface (verified below).

**Architecture:** Unchanged from M1's boundary rule — Kotlin is bridge-only (enumerate, request permission, capture, encode, publish, report facts); every decision (source selection, audio-follows-video, flag gating, retry, orientation) is Dart. M2 adds: a `CameraManager`-driven UVC device factory extension, a pure Camera2 stream-configuration negotiator, a `UsbManager`-driven permission coordinator and hot-plug controller (both Kotlin, both fully unit-testable via injected seams — no Robolectric), a `AudioRecord`-backed USB audio source, and the Dart-side hot-plug-aware device providers, audio-source-selection policy, USB permission gate, and StatusPanel UVC row that consume them.

**Tech Stack:** Same as M1 — no new dependency is introduced anywhere in this plan (every capability M2 needs — `CameraManager`, `UsbManager`, `AudioRecord`, `AudioManager` — is Android SDK, already available; `kotlinx-coroutines-core`/`-android` 1.10.2 is already a dependency, reused for the permission coordinator's `suspend`/`CompletableDeferred` flow, matching `PigeonHostApiImpl`'s existing `awaitBoundHost` pattern).

**Spec:** `docs/superpowers/specs/2026-09-07-gazer-mobile-v2-design.md`

**M1 plan (format/conventions reference):** `docs/superpowers/plans/2026-09-07-gazer-mobile-v2-m1.md`

## App root

This plan writes every path as `<app>/...`. Today (this branch, `feature/gazer-mobile-v2`, repo `waddlebot`) `<app>` = `mobile/gazer/`. After the M1→penguinm move, `<app>` = `gazer/` in the `penguinm` macro-repo, and this plan executes there — see Global Constraints below. The plan document itself always lives at `docs/superpowers/plans/2026-09-14-gazer-mobile-v2-m2.md` relative to whichever repo root it runs in.

## Global Constraints

Every task's requirements implicitly include these:

- **Executes in `penguinm` post-move:** by the time M2 starts, Gazer has moved out of `waddlebot` into the `penguinm` mobile macro-repo under `<app>` = `gazer/`, per `client-flutter.md`'s updated repo-placement rule ("all mobile apps live in the `penguinm` macro-repo"). The repo-root `Makefile`'s `mobile-*` targets and `.github/workflows/gazer-mobile.yml` move with it under the same names — this plan never re-scaffolds them, only assumes they exist and mount `<app>` exactly as M1's did for `mobile/gazer/`. The toolchain image tag changes to `ghcr.io/penguintechinc/penguinm/gazer-toolchain:<sha256-of-Dockerfile-first-12>` (was `ghcr.io/penguintechinc/waddlebot/gazer-toolchain:...`); local tag stays `gazer-toolchain:3.47.2`.
- **Android floors:** Android 10+ (minSdk 29), targetSdk 36, compileSdk 36 (spec, Non-Functional) — unchanged from M1.
- **Flutter/Dart pin:** Flutter `3.47.2` / Dart `>=3.13.2 <3.14.0` (`<app>/.flutter-version`, `<app>/pubspec.yaml`) — unchanged from M1, no bump in this plan.
- **Exact pins, no ranges:** every dependency below is the literal version already resolved and committed on the M1 branch (`<app>/pubspec.lock`, `<app>/android/gradle/libs.versions.toml`) — this plan adds **zero new dependencies**; where M1's pin diverged from the spec's original table (documented inline in `pubspec.yaml`/`libs.versions.toml` as "pin what actually resolves"), the M1-resolved pin is the one this plan's tasks build against:
  - Dart: `flutter_riverpod 3.4.3`, `riverpod_annotation 4.0.7`, `go_router 18.0.1`, `freezed_annotation 3.1.0`, `json_annotation 4.12.0`, `flutter_secure_storage 9.2.4`, `shared_preferences 2.5.5`, `connectivity_plus 7.3.1`, `intl 0.20.3`, `package_info_plus 9.0.1`, `dio 5.11.1`, `url_launcher 6.3.2`, `permission_handler 12.0.3` + direct `permission_handler_android 13.0.1`, `device_info_plus 12.4.0`.
  - Android/Gradle: `compileSdk`/`targetSdk` 36, `minSdk` 29, AGP `9.1.0`, Gradle `9.3.1`, Kotlin `2.4.0`, Java 17 (temurin), RootEncoder `2.8.1` (JitPack `library` module ONLY — `extra-sources` forever forbidden), JUnit Jupiter `5.12.2`, JUnit Platform Launcher `1.12.2`, MockK `1.14.3`, `androidx-test-runner 1.7.0`, `androidx-test-ext-junit 1.3.0`, `androidx-test-rules 1.7.0`, `junit4 4.13.2`, JaCoCo `0.8.13`, ktlint Gradle plugin `14.2.0`, `kotlinx-coroutines-{core,android} 1.10.2`.
- **RootEncoder scope:** only `com.github.pedroSG94.RootEncoder:library:2.8.1` may ever be depended on; `extra-sources` is never added.
- **Supply chain:** no PRC-origin, no dead/archived libraries; M2 introduces zero new third-party code, so nothing new to vet — the two reused pieces from `<app-parent>/flutter_gazer` (the old, pre-rewrite app, cited per-task below) are house code, not a dependency.
- **Secrets storage:** unchanged — target URL/key/username/password stay in `flutter_secure_storage`; M2 adds no new secret.
- **Coverage gates:** ≥90% both Dart (`mobile-test`, lcov) and Kotlin (`mobile-test-android`, JaCoCo) — every task below carries its own tests; new Android classes that structurally cannot run on the JVM unit-test target (need a real `Context`/`AudioRecord`/`Service`) are narrowly JaCoCo-excluded by name, following the exact precedent below (R29), never a blanket exclusion.
- **Kotlin test discipline:** every Kotlin change ships a JUnit 5 (+ MockK where a collaborator needs faking) test in the same task.
- **Dart owns decisions, Kotlin is bridge only:** source selection, audio-follows-video policy, feature-flag gating, orientation, and retry all stay in Dart; Kotlin only enumerates/permits/captures/encodes/publishes and reports facts (state, stats, attach/detach, errors) — unchanged from M1.
- **Banned word:** "restream" (any casing/spacing) never appears anywhere in this app.
- **Container-only tooling:** every command in this plan is a `make mobile-*` target (unchanged names, see App root above), which runs inside the toolchain container; the host's Flutter/Gradle are never invoked directly.
- **Commit trailers:** every commit created while executing this plan ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  ```
  (Matches the M1 branch's actual tip convention as of `520df364` — both trailers, not the single-trailer ruling from an earlier point in M1's history that was itself superseded.)
- **Commit prefixes:** `feat(gazer):`, `test(gazer):`, `chore(gazer):`, `fix(gazer):`, `docs(gazer):` per the nature of the change.
- **No Pigeon contract change in this plan:** verified against `<app>/pigeons/pipeline.dart` (read in full before writing this plan) — `VideoDeviceKind.uvcCamera2`, `GazerErrorCode.{usbPermissionDenied, uvcNoUsableFormat, uvcOpenFailed, cameraUnavailable, cameraInUse, usbDetached, serviceStartDenied}`, `GazerHostApi.requestUsbPermission(deviceId)`, and `GazerFlutterApi.{onUsbAttached, onUsbDetached}` already exist and are exactly what M2 needs. Every task below reuses them; none adds, renames, or removes a Pigeon type or method. (M1 also already shipped `FlagKeys.uvcCapture`, `AudioSourceChoice.usbAudio`, the Settings screen's audio dropdown with all four choices, `SourcePicker`'s `uvcCamera2`-aware label branch, and every `GazerErrorCode` case's l10n text in `error_text.dart` — all confirmed present and unchanged by this plan except where a task explicitly says otherwise.)
- **M1 rulings that still bind** (from `.superpowers/sdd/2026-09-07-gazer-mobile-v2-m1/progress.md`):
  - **R26**: the generated settings provider is `settingsProvider` (mutator `save(GazerSettings)`), not `settingsNotifierProvider`/`update` — this plan uses those real names.
  - **R28**: `GazerPipeline` never calls the engine or the listener while holding its internal lock — mutate/snapshot under `synchronized(lock)`, then call out afterward. Every `GazerPipeline` change in this plan (Task 4) preserves this.
  - **R29**: a JVM-untestable Android class (needs a real `Context`/`Service`/hardware I/O) gets a **narrow**, by-name JaCoCo exclusion with a documented reason, never a blanket one — `<app>/android/app/build.gradle.kts`'s `fileFilter` list already excludes `RootEncoderEngine.class` and `StreamService.class`/`StreamService$*.class` on this precedent; this plan adds `UsbAudioSource.class` and `MainActivity` stays excluded, following the same pattern.
  - **R33/superseded**: see the Commit trailers bullet above — both trailers, matching the branch's actual tip.
  - **R40**: `rtmps://` targets are rejected by `TargetValidator` in M1 for a verified TLS-hostname-verification gap in RootEncoder 2.8.1 — unrelated to and unchanged by M2 (UVC video/audio sources publish through the same `RootEncoderEngine`/`GenericStream`, which this plan does not touch).
  - **R45**: `StreamService`'s idle-release/foreground-service lifecycle (60s idle timer, re-bind on next prepare) is unchanged by this plan; `GazerPipeline.reportExternalFailure` (Task 4) reports through the same `PipelineListener`/`RelayPipelineListener` path `onConnectionFailed`/`onDisconnect` already use, so the existing wake-lock/foreground-service reaction to an `ERROR` state applies unchanged.

## Environment & Commands

Unchanged from M1 (`docs/superpowers/plans/2026-09-07-gazer-mobile-v2-m1.md` Environment & Commands) except every path is `<app>`-relative and the image tag is the one in Global Constraints. Commands used in this plan:

- `make mobile-run CMD="..."` — passthrough for one ad hoc in-container command.
- `make mobile-lint` — `flutter analyze` + `dart format --set-exit-if-changed .` + `gradlew ktlintCheck lint`.
- `make mobile-test` — `flutter test --coverage` + `scripts/coverage_gate.sh 90 coverage/lcov.info lcov lib`.
- `make mobile-test-android` — `gradlew testDebugUnitTest jacocoTestReport` + `scripts/coverage_gate.sh 90 <jacoco xml> jacoco`.
- `make mobile-test-integration` — emulator (`/dev/kvm`): `integration_test/` + `connectedDebugAndroidTest`.
- `make mobile-telemetry-check` — OTel local-sink smoke test, asserts logs/metrics/histograms/spans all ≥1.
- `make mobile-codegen` — `dart run pigeon` + `build_runner` + `flutter gen-l10n` (only needed if a task regenerates l10n; this plan makes no Pigeon change, so `dart run pigeon` never actually changes output).

## File Map (M2) — create unless marked Modify

```
<app>/
  android/app/src/main/res/xml/usb_device_filter.xml          Create (Task 1)
  android/app/src/main/AndroidManifest.xml                    Modify (Task 1)
  android/app/src/test/kotlin/io/waddlebot/gazer/ManifestContentTest.kt  Modify (Task 1)
  android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/Camera2FormatNegotiator.kt  Create (Task 2)
  android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/Camera2FormatNegotiatorTest.kt  Create (Task 2)
  android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbCaptureDeviceNames.kt  Create (Task 3)
  android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/VideoSourceFactory.kt     Modify (Task 3)
  android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/VideoSourceFactoryTest.kt Modify (Task 3)
  android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbCaptureDeviceNamesTest.kt  Create (Task 3)
  android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/GazerPipeline.kt   Modify (Task 4)
  android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/GazerPipelineTest.kt  Modify (Task 4)
  android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbPermissionCoordinator.kt  Create (Task 5)
  android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbPermissionCoordinatorTest.kt  Create (Task 5)
  android/app/src/main/kotlin/io/waddlebot/gazer/PigeonHostApiImpl.kt  Modify (Task 5)
  android/app/src/test/kotlin/io/waddlebot/gazer/PigeonHostApiImplTest.kt  Modify (Task 5)
  android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbHotplugController.kt  Create (Task 6)
  android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbHotplugControllerTest.kt  Create (Task 6)
  android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/AudioSourceFactory.kt  Modify (Task 7)
  android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/AudioSourceFactoryTest.kt  Modify (Task 7)
  android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbAudioFramingTest.kt  Create (Task 7)
  android/app/build.gradle.kts  Modify (Task 7 — JaCoCo exclusion)
  android/app/src/main/kotlin/io/waddlebot/gazer/GazerFlutterBindings.kt  Modify (Task 8)
  android/app/src/test/kotlin/io/waddlebot/gazer/GazerFlutterBindingsTest.kt  Modify (Task 8)
  android/app/src/androidTest/kotlin/io/waddlebot/gazer/UsbHotplugInstrumentedTest.kt  Create (Task 9)
  test/helpers/fake_host_api.dart  Modify (Task 10)
  lib/providers/devices_provider.dart  Modify (Task 11)
  test/providers/devices_provider_test.dart  Modify (Task 11)
  lib/services/audio_source_selector.dart  Create (Task 12)
  test/services/audio_source_selector_test.dart  Create (Task 12)
  lib/services/pipeline_controller.dart  Modify (Task 12)
  test/services/pipeline_controller_test.dart  Modify (Task 12)
  lib/providers/devices_provider.dart  Modify again (Task 13 — visibleVideoDevicesProvider)
  lib/screens/home_screen.dart  Modify (Task 13, Task 14)
  test/screens/home_screen_test.dart  Modify (Task 13, Task 14)
  lib/l10n/app_en.arb  Modify (Task 14, Task 15)
  lib/screens/status_panel.dart  Modify (Task 15)
  test/screens/status_panel_test.dart  Modify (Task 15)
  README.md  Modify (Task 16)
  docs/superpowers/plans/2026-09-14-gazer-mobile-v2-m2-verification.md  Create (Task 17)
```

## Shared Contract (M2 additions to M1's)

Names/signatures below are used **verbatim** by later tasks; never invent alternatives.

- `NegotiatedFormat(width: Long, height: Long, fps: Long)` (Kotlin, `pipeline/sources/VideoSourceFactory.kt`) — the resolved capture geometry: identical to the request for phone cameras, narrowed to the nearest mode a UVC/Camera2-external device actually supports.
- `CameraStreamOption(width: Int, height: Int, maxFps: Int)` (Kotlin, `pipeline/sources/Camera2FormatNegotiator.kt`) — one mode a camera id advertises.
- `object Camera2FormatNegotiator { fun negotiate(options: List<CameraStreamOption>, requestedWidth: Int, requestedHeight: Int, requestedFps: Int): CameraStreamOption? }`
- `CameraIds` (Kotlin) gains `fun externalIds(): List<String>` and `fun streamOptions(cameraId: String): List<CameraStreamOption>` alongside M1's `byFacing`.
- `UsbCaptureDeviceInfo(name: String, vendorId: Int, productId: Int, device: UsbDevice)`, `fun interface UsbDeviceLister { fun devices(): Collection<UsbDevice> }`, `class UsbManagerDeviceLister(usbManager: UsbManager) : UsbDeviceLister`, `class UsbCaptureDeviceNames(lister: UsbDeviceLister) { fun isCaptureDevice(device: UsbDevice): Boolean; fun primary(): UsbCaptureDeviceInfo? }` (Kotlin, `pipeline/sources/UsbCaptureDeviceNames.kt`).
- `VideoSourceFactory` (Kotlin) constructor gains a required `captureDeviceNames: UsbCaptureDeviceNames` parameter; gains `fun negotiate(deviceId: String, requestedWidth: Long, requestedHeight: Long, requestedFps: Long): NegotiatedFormat` and `fun onPrepared(deviceId: String, source: VideoSource)`; `"camera:uvc:<cameraId>"` is the M2 device-id shape (constant `UVC_DEVICE_PREFIX = "camera:uvc:"`, top-level in this file).
- `GazerPipeline` (Kotlin) gains `val activeVideoDeviceId: String?` (volatile, set on successful `prepare`, cleared on `stop`/terminal error) and `fun reportExternalFailure(code: GazerErrorCode, detail: String?)`.
- `interface UsbDevicesGateway { fun deviceFor(cameraId: String): UsbDevice?; fun hasPermission(device: UsbDevice): Boolean; fun requestPermission(device: UsbDevice, pendingIntent: PendingIntent) }`, `class AndroidUsbDevicesGateway(usbManager: UsbManager, captureDeviceNames: UsbCaptureDeviceNames) : UsbDevicesGateway` (Kotlin, `pipeline/sources/UsbPermissionCoordinator.kt`).
- `class UsbPermissionCoordinator(gateway: UsbDevicesGateway, buildPendingIntent: () -> PendingIntent, registerReceiver: (BroadcastReceiver, IntentFilter) -> Unit, unregisterReceiver: (BroadcastReceiver) -> Unit, timeoutMs: Long = 15_000L) { suspend fun request(deviceId: String): Boolean }` (Kotlin).
- `interface ReceiverRegistrar { fun register(receiver: BroadcastReceiver, filter: IntentFilter); fun unregister(receiver: BroadcastReceiver) }`, `class ContextReceiverRegistrar(context: Context) : ReceiverRegistrar` (Kotlin, `pipeline/sources/UsbHotplugController.kt`).
- `class UsbHotplugController(registrar: ReceiverRegistrar, listVideoDevices: () -> List<VideoDevice>, pipeline: () -> GazerPipeline?, onAttached: (VideoDevice) -> Unit, onDetached: (String) -> Unit, postDelayed: (Long, () -> Unit) -> Unit) { fun start(); fun stop() }` (Kotlin).
- `fun interface AudioInputDevices { fun usbInputDevice(): AudioDeviceInfo? }`, `object NoUsbInput : AudioInputDevices`, `class AndroidAudioInputDevices(audioManager: AudioManager) : AudioInputDevices` (Kotlin, `pipeline/sources/AudioSourceFactory.kt`); `AudioSourceFactory` constructor gains `audioInputDevices: AudioInputDevices = NoUsbInput` (default preserves every M1 call site); gains `"audio:usb"` → `UsbAudioSource`. `object UsbAudioFraming { fun chunkByteSize(sampleRate: Int, channels: Int, chunkMillis: Long = 20L): Int }` (pure, extracted for testability).
- Dart `class AudioSourceSelector { const AudioSourceSelector(); String deviceIdFor({required AudioSourceChoice choice, required VideoDeviceKind? selectedVideoKind, required List<AudioDevice> audioDevices}); }` (`lib/services/audio_source_selector.dart`) — replaces `PipelineController._audioDeviceIdFor`'s M1 stub.
- Dart `PipelineController.goLive` gains one new **optional** named param, `List<AudioDevice> audioDevices = const <AudioDevice>[]` (default keeps all 31 existing call sites in `test/services/pipeline_controller_test.dart` compiling unchanged — an empty list means "assume no USB audio available," which is exactly M1's prior behavior); internally it now resolves the audio device id via `AudioSourceSelector` instead of the M1 stub. HomeScreen (Task 14) is updated to pass its already-`ref.watch`ed `audioDevicesProvider` value through. `PipelineController` also exposes a new `Stream<PrepareResult?> get negotiatedFormat` (broadcast, most-recent-value not replayed — mirrors `stats`/`state`) plus `PrepareResult? get currentNegotiatedFormat` (Task 15).
- Dart `lib/providers/devices_provider.dart` gains `@riverpod Future<List<VideoDevice>> visibleVideoDevices(Ref ref)` (flag-filtered) and hot-plug refresh on the existing `videoDevicesProvider`/`audioDevicesProvider` via `ref.watch(pipelineControllerProvider)`'s underlying `NativeEventBridge` streams (exposed through a new `@Riverpod(keepAlive: true) NativeEventBridge nativeEventBridge(Ref ref)` provider factored out of `pipeline_provider.dart` so `devices_provider.dart` can watch it without a circular import on `pipelineControllerProvider` itself).
- Dart `test/helpers/fake_host_api.dart`'s `FakeGazerHostApi` gains `bool requestUsbPermissionResult = true` (used by the real `requestUsbPermission` override) and `Future<void> emitUsbAttached(VideoDevice device)` / `Future<void> emitUsbDetached(String deviceId)` helpers mirroring `emitState`/`emitStats`.

---

### Task 1: USB manifest, device filter, and the M1→M2 manifest-test flip

**Files:**
- Create: `<app>/android/app/src/main/res/xml/usb_device_filter.xml`
- Modify: `<app>/android/app/src/main/AndroidManifest.xml`
- Modify: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/ManifestContentTest.kt`

**Interfaces:** none new — this task only declares the manifest surface later tasks' code relies on (the `android.hardware.usb.host` feature and the `USB_DEVICE_ATTACHED` intent-filter + device filter resource). No Kotlin class is created.

**Reused from `<app-parent>/flutter_gazer`** (the pre-rewrite 1.0 app, per the design spec's Background: "keeps only reusable ideas: USB permission flow + vendor-ID filter"): the exact `usb_device_filter.xml` shape (UVC class/subclass entries + Elgato/AVerMedia/Magewell vendor IDs) and the manifest's `USB_DEVICE_ATTACHED` intent-filter + meta-data pattern, both at `<app-parent>/flutter_gazer/android/app/src/main/res/xml/usb_device_filter.xml` and `.../AndroidManifest.xml`.

- [ ] **Step 1: Write the failing manifest-content test additions.**

  M1's `ManifestContentTest.kt` has a test named `` `declares no USB permissions or features in M1` `` that asserts the OPPOSITE of what M2 needs — it must flip, not just gain new assertions, or it fails the moment Step 3 adds the USB feature. Replace the whole file:

  `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/ManifestContentTest.kt`:
  ```kotlin
  package io.waddlebot.gazer

  import org.junit.jupiter.api.Assertions.assertEquals
  import org.junit.jupiter.api.Assertions.assertFalse
  import org.junit.jupiter.api.Assertions.assertTrue
  import org.junit.jupiter.api.BeforeAll
  import org.junit.jupiter.api.Test
  import org.w3c.dom.Document
  import org.w3c.dom.Element
  import java.io.File
  import javax.xml.parsers.DocumentBuilderFactory

  /**
   * Parses the real AndroidManifest.xml from source with a plain XML DOM parser (no Android
   * framework, no Robolectric) and asserts the required permissions/features, the StreamService
   * foreground-service declaration, and (from M2) the USB host feature + hot-plug intent-filter +
   * device-filter resource. Exists so a manifest regression fails a JVM unit test instead of only
   * surfacing at runtime on-device.
   */
  class ManifestContentTest {
      companion object {
          private lateinit var document: Document

          @BeforeAll
          @JvmStatic
          fun loadManifest() {
              val manifestFile = File("src/main/AndroidManifest.xml")
              require(manifestFile.exists()) { "AndroidManifest.xml not found at ${manifestFile.absolutePath}" }
              val builder = DocumentBuilderFactory.newInstance().newDocumentBuilder()
              document = builder.parse(manifestFile)
          }
      }

      private fun permissionNames(): List<String> {
          val nodes = document.getElementsByTagName("uses-permission")
          return (0 until nodes.length).map { (nodes.item(it) as Element).getAttribute("android:name") }
      }

      private fun featureNames(): List<String> {
          val nodes = document.getElementsByTagName("uses-feature")
          return (0 until nodes.length).map { (nodes.item(it) as Element).getAttribute("android:name") }
      }

      private fun mainActivityElement(): Element {
          val activities = document.getElementsByTagName("activity")
          return (0 until activities.length)
              .map { activities.item(it) as Element }
              .first { it.getAttribute("android:name") == ".MainActivity" }
      }

      @Test
      fun `declares camera and microphone permissions`() {
          val names = permissionNames()
          assertTrue(names.contains("android.permission.CAMERA"))
          assertTrue(names.contains("android.permission.RECORD_AUDIO"))
      }

      @Test
      fun `declares foreground service permissions for camera and microphone`() {
          val names = permissionNames()
          assertTrue(names.contains("android.permission.FOREGROUND_SERVICE"))
          assertTrue(names.contains("android.permission.FOREGROUND_SERVICE_CAMERA"))
          assertTrue(names.contains("android.permission.FOREGROUND_SERVICE_MICROPHONE"))
      }

      @Test
      fun `declares network, notification and wake lock permissions`() {
          val names = permissionNames()
          assertTrue(names.contains("android.permission.INTERNET"))
          assertTrue(names.contains("android.permission.POST_NOTIFICATIONS"))
          assertTrue(names.contains("android.permission.WAKE_LOCK"))
      }

      @Test
      fun `declares StreamService as a non-exported camera and microphone foreground service`() {
          val services = document.getElementsByTagName("service")
          val streamService = (0 until services.length)
              .map { services.item(it) as Element }
              .firstOrNull { it.getAttribute("android:name") == ".pipeline.StreamService" }
          requireNotNull(streamService) { "StreamService not declared in AndroidManifest.xml" }
          val serviceType = streamService.getAttribute("android:foregroundServiceType")
          assertTrue(serviceType.contains("camera"))
          assertTrue(serviceType.contains("microphone"))
          assertFalse(streamService.getAttribute("android:exported").toBoolean())
      }

      @Test
      fun `declares the USB host feature as not required (M2)`() {
          val features = document.getElementsByTagName("uses-feature")
          val usbHost = (0 until features.length)
              .map { features.item(it) as Element }
              .firstOrNull { it.getAttribute("android:name") == "android.hardware.usb.host" }
          requireNotNull(usbHost) { "android.hardware.usb.host uses-feature not declared" }
          assertFalse(usbHost.getAttribute("android:required").toBoolean())
      }

      @Test
      fun `MainActivity declares a USB_DEVICE_ATTACHED intent-filter with a device-filter meta-data (M2)`() {
          val activity = mainActivityElement()
          val intentFilters = activity.getElementsByTagName("intent-filter")
          val hasUsbAttachedAction =
              (0 until intentFilters.length).any { i ->
                  val filter = intentFilters.item(i) as Element
                  val actions = filter.getElementsByTagName("action")
                  (0 until actions.length).any { j ->
                      (actions.item(j) as Element).getAttribute("android:name") ==
                          "android.hardware.usb.action.USB_DEVICE_ATTACHED"
                  }
              }
          assertTrue(hasUsbAttachedAction, "MainActivity is missing the USB_DEVICE_ATTACHED intent-filter")

          val metaData = activity.getElementsByTagName("meta-data")
          val usbFilterMeta =
              (0 until metaData.length)
                  .map { metaData.item(it) as Element }
                  .firstOrNull { it.getAttribute("android:name") == "android.hardware.usb.action.USB_DEVICE_ATTACHED" }
          requireNotNull(usbFilterMeta) { "MainActivity is missing the USB_DEVICE_ATTACHED meta-data resource pointer" }
          assertEquals("@xml/usb_device_filter", usbFilterMeta.getAttribute("android:resource"))
      }

      @Test
      fun `declares no runtime USB permission (permission is per-device, requested at runtime via UsbManager)`() {
          // android.permission.USB_PERMISSION does not exist as a manifest permission on Android --
          // access is granted per-device via UsbManager.requestPermission at runtime (Task 5). This
          // guards against a future author adding a nonexistent manifest permission by mistake.
          assertFalse(permissionNames().any { it.contains("USB_PERMISSION") })
      }
  }
  ```

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.ManifestContentTest'"`
  Expected: 7 tests run, 2 failures — `` `declares the USB host feature as not required (M2)` `` fails on `requireNotNull` (feature not yet declared) and `` `MainActivity declares a USB_DEVICE_ATTACHED intent-filter...` `` fails the same way.

- [ ] **Step 3: Create the device filter resource.**

  `<app>/android/app/src/main/res/xml/usb_device_filter.xml`:
  ```xml
  <?xml version="1.0" encoding="utf-8"?>
  <resources>
      <!-- USB Video Class (UVC) devices -- standard for USB capture cards. Ported from
           <app-parent>/flutter_gazer/android/app/src/main/res/xml/usb_device_filter.xml (the 1.0
           app's USB permission/vendor-filter code, reused per the design spec's Background). -->
      <usb-device class="14" subclass="1" protocol="0" />
      <usb-device class="14" subclass="2" protocol="0" />

      <!-- Common USB capture card vendors (ported from the same source). -->
      <!-- Elgato -->
      <usb-device vendor-id="2893" />
      <!-- AVerMedia -->
      <usb-device vendor-id="1817" />
      <!-- Magewell -->
      <usb-device vendor-id="4176" />
      <!-- Generic UVC composite devices -->
      <usb-device class="239" subclass="2" />
  </resources>
  ```

- [ ] **Step 4: Add the manifest declarations.**

  In `<app>/android/app/src/main/AndroidManifest.xml`, add the `uses-feature` line immediately after the existing `microphone` feature line:
  ```xml
      <uses-feature android:name="android.hardware.microphone" android:required="true" />
      <!-- required="false": M2's UVC capture-card path is optional -- devices with no USB host
           controller (or with the feature but no card ever attached) still run every M1 feature
           unaffected. -->
      <uses-feature android:name="android.hardware.usb.host" android:required="false" />
  ```

  And add the intent-filter + meta-data to the `.MainActivity` `<activity>` element, immediately after its existing `MAIN`/`LAUNCHER` intent-filter's closing tag:
  ```xml
              <intent-filter>
                  <action android:name="android.intent.action.MAIN" />
                  <category android:name="android.intent.category.LAUNCHER" />
              </intent-filter>
              <!-- M2: brings MainActivity to the foreground when a matching UVC capture card is
                   plugged in, even if Gazer was not already running -- the standard Android
                   USB-accessory-attached launch pattern. Device match list: usb_device_filter.xml
                   (ported from <app-parent>/flutter_gazer, see Task 1 brief). Hot-plug detection
                   WHILE the app is already foregrounded is a separate, dynamically-registered
                   BroadcastReceiver (Task 6) -- this intent-filter only covers cold/background
                   attach. -->
              <intent-filter>
                  <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
              </intent-filter>
              <meta-data
                  android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
                  android:resource="@xml/usb_device_filter" />
  ```

- [ ] **Step 5: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.ManifestContentTest'"`
  Expected: `7 tests completed, 0 failed`.

- [ ] **Step 6: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 7: Commit.**
  ```bash
  git add <app>/android/app/src/main/res/xml/usb_device_filter.xml \
          <app>/android/app/src/main/AndroidManifest.xml \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/ManifestContentTest.kt
  git commit -m "$(cat <<'EOF'
  feat(gazer): declare USB host feature, hot-plug intent-filter, and device filter (M2)

  Ports usb_device_filter.xml's UVC class/vendor-ID match list and the
  USB_DEVICE_ATTACHED intent-filter pattern from the 1.0 app
  (flutter_gazer), and flips ManifestContentTest's M1 "no USB" assertion
  to M2's "USB host feature present, optional" shape.

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 2: Camera2FormatNegotiator (pure resolution/fps negotiation)

**Files:**
- Create: `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/Camera2FormatNegotiator.kt`
- Create, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/Camera2FormatNegotiatorTest.kt`

**Interfaces:**
- Produces (verbatim, Shared Contract): `data class CameraStreamOption(val width: Int, val height: Int, val maxFps: Int)`; `object Camera2FormatNegotiator { fun negotiate(options: List<CameraStreamOption>, requestedWidth: Int, requestedHeight: Int, requestedFps: Int): CameraStreamOption? }`.
- No Android/Camera2 types touched — pure data in, pure data out, so this is exercised entirely on the JVM with fabricated option lists. `VideoSourceFactory` (Task 3) is what feeds it real `CameraCharacteristics` data.

- [ ] **Step 1: Write the failing table-driven test.**

  `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/Camera2FormatNegotiatorTest.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import org.junit.jupiter.api.Assertions.assertEquals
  import org.junit.jupiter.api.Assertions.assertNull
  import org.junit.jupiter.api.Test

  class Camera2FormatNegotiatorTest {

      @Test
      fun `exact match is returned unchanged`() {
          val options = listOf(CameraStreamOption(1920, 1080, 30), CameraStreamOption(1280, 720, 30))
          val result = Camera2FormatNegotiator.negotiate(options, requestedWidth = 1920, requestedHeight = 1080, requestedFps = 30)
          assertEquals(CameraStreamOption(1920, 1080, 30), result)
      }

      @Test
      fun `no options returns null`() {
          assertNull(Camera2FormatNegotiator.negotiate(emptyList(), 1920, 1080, 30))
      }

      @Test
      fun `nearest resolution by area is chosen when the exact size is unsupported`() {
          // Requested 1920x1080 (area 2,073,600); 1600x900 (1,440,000) is closer than 1280x720
          // (921,600) or 2560x1440 (3,686,400).
          val options =
              listOf(
                  CameraStreamOption(1280, 720, 30),
                  CameraStreamOption(1600, 900, 30),
                  CameraStreamOption(2560, 1440, 30),
              )
          val result = Camera2FormatNegotiator.negotiate(options, 1920, 1080, 30)
          assertEquals(CameraStreamOption(1600, 900, 30), result)
      }

      @Test
      fun `fps at or below the request is preferred at the chosen resolution -- highest such fps wins`() {
          val options =
              listOf(
                  CameraStreamOption(1920, 1080, 15),
                  CameraStreamOption(1920, 1080, 24),
                  CameraStreamOption(1920, 1080, 60),
              )
          // Requested 30fps: 24 (<=30) beats 15 (<=30, lower) and beats 60 (>30).
          val result = Camera2FormatNegotiator.negotiate(options, 1920, 1080, 30)
          assertEquals(CameraStreamOption(1920, 1080, 24), result)
      }

      @Test
      fun `when every option at the chosen resolution exceeds the request, the lowest is used`() {
          val options = listOf(CameraStreamOption(1920, 1080, 60), CameraStreamOption(1920, 1080, 50))
          val result = Camera2FormatNegotiator.negotiate(options, 1920, 1080, 30)
          assertEquals(CameraStreamOption(1920, 1080, 50), result)
      }

      @Test
      fun `single option is always returned regardless of how far it is from the request`() {
          val options = listOf(CameraStreamOption(640, 480, 15))
          val result = Camera2FormatNegotiator.negotiate(options, 1920, 1080, 60)
          assertEquals(CameraStreamOption(640, 480, 15), result)
      }
  }
  ```

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.Camera2FormatNegotiatorTest'"`
  Expected: compile error — `unresolved reference: CameraStreamOption`, `unresolved reference: Camera2FormatNegotiator`.

- [ ] **Step 3: Implement.**

  `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/Camera2FormatNegotiator.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import kotlin.math.abs

  /** One capture mode a camera id advertises: a supported output size and the fastest fps it runs at. */
  data class CameraStreamOption(
      val width: Int,
      val height: Int,
      val maxFps: Int,
  )

  /**
   * Resolves a requested width/height/fps against the modes a Camera2 device (in practice: a
   * `LENS_FACING_EXTERNAL` UVC card) actually advertises, per the spec's M2 note ("resolution/fps
   * negotiation against the device's supported stream configurations ... mapped to the nearest
   * supported"). Pure and Android-free so it is testable with fabricated option lists -- the real
   * `CameraCharacteristics` query lives in `CameraManagerIds.streamOptions` (Task 3).
   */
  object Camera2FormatNegotiator {
      /**
       * Picks the [CameraStreamOption] closest to the request: nearest total pixel area for
       * resolution, then — among options at that exact resolution — the highest fps that does not
       * exceed [requestedFps], falling back to the lowest available fps if every option at that
       * resolution exceeds the request. Returns null only when [options] is empty.
       */
      fun negotiate(
          options: List<CameraStreamOption>,
          requestedWidth: Int,
          requestedHeight: Int,
          requestedFps: Int,
      ): CameraStreamOption? {
          if (options.isEmpty()) return null
          val requestedArea = requestedWidth.toLong() * requestedHeight.toLong()
          val bestResolution =
              options.minBy { option ->
                  val area = option.width.toLong() * option.height.toLong()
                  abs(area - requestedArea)
              }
          val sameResolution = options.filter { it.width == bestResolution.width && it.height == bestResolution.height }
          val atOrBelowRequest = sameResolution.filter { it.maxFps <= requestedFps }
          return if (atOrBelowRequest.isNotEmpty()) {
              atOrBelowRequest.maxBy { it.maxFps }
          } else {
              sameResolution.minBy { it.maxFps }
          }
      }
  }
  ```

- [ ] **Step 4: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.Camera2FormatNegotiatorTest'"`
  Expected: `6 tests completed, 0 failed`.

- [ ] **Step 5: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 6: Commit.**
  ```bash
  git add <app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/Camera2FormatNegotiator.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/Camera2FormatNegotiatorTest.kt
  git commit -m "$(cat <<'EOF'
  feat(gazer): add pure Camera2 resolution/fps negotiator

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 3: VideoSourceFactory UVC enumeration, naming, creation, negotiation

**Depends on:** Task 2 (`Camera2FormatNegotiator`).

**Files:**
- Create: `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbCaptureDeviceNames.kt`
- Create, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbCaptureDeviceNamesTest.kt`
- Modify: `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/VideoSourceFactory.kt`
- Modify, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/VideoSourceFactoryTest.kt`

**Interfaces:**
- Consumes: `Camera2FormatNegotiator`/`CameraStreamOption` (Task 2); Pigeon `VideoDevice`/`VideoDeviceKind.UVC_CAMERA2`.
- Produces (verbatim, Shared Contract): `UsbCaptureDeviceInfo`, `UsbDeviceLister`, `UsbManagerDeviceLister`, `UsbCaptureDeviceNames`; `CameraIds` gains `externalIds()`/`streamOptions(cameraId)`; `VideoSourceFactory` constructor gains `captureDeviceNames: UsbCaptureDeviceNames` (no default — every call site is updated in this task); gains `negotiate(...)`, `onPrepared(...)`; top-level `const val UVC_DEVICE_PREFIX = "camera:uvc:"` and `data class NegotiatedFormat(val width: Long, val height: Long, val fps: Long)` land in `VideoSourceFactory.kt`.

**Reused from `<app-parent>/flutter_gazer`**: `UsbCaptureDeviceNames.isCaptureDevice`'s class/vendor-ID heuristic ports `UsbCapturePlugin.kt`'s `isVideoDevice()` (USB Video Class 14, or a known vendor ID) from the 1.0 app — same vendor set as Task 1's `usb_device_filter.xml`.

**Single-capture-card assumption (documented, not a placeholder):** Camera2 exposes no public API linking a `LENS_FACING_EXTERNAL` camera id to the specific `UsbDevice` behind it. `UsbCaptureDeviceNames.primary()` returns device info only when **exactly one** matching USB device is attached (the spec's own framing throughout — Manual Device Matrix, "a UVC capture card" — is always singular); with zero or more than one match it returns `null` and every external camera id falls back to a generic name. This never affects correctness (the camera id itself, not the name, is what `create()`/`negotiate()`/`onPrepared()` act on) — only the cosmetic device name/vendor/product id shown in the picker and StatusPanel.

- [ ] **Step 1: Write the failing UsbCaptureDeviceNames test.**

  `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbCaptureDeviceNamesTest.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import android.hardware.usb.UsbDevice
  import android.hardware.usb.UsbInterface
  import io.mockk.every
  import io.mockk.mockk
  import org.junit.jupiter.api.Assertions.assertEquals
  import org.junit.jupiter.api.Assertions.assertFalse
  import org.junit.jupiter.api.Assertions.assertNull
  import org.junit.jupiter.api.Assertions.assertTrue
  import org.junit.jupiter.api.Test

  class UsbCaptureDeviceNamesTest {

      private fun fakeDevice(
          deviceClass: Int = 0,
          vendorId: Int = 0,
          productId: Int = 0,
          productName: String? = "Capture Card X1",
          interfaceClasses: List<Int> = emptyList(),
      ): UsbDevice {
          val device = mockk<UsbDevice>()
          every { device.deviceClass } returns deviceClass
          every { device.vendorId } returns vendorId
          every { device.productId } returns productId
          every { device.productName } returns productName
          every { device.interfaceCount } returns interfaceClasses.size
          interfaceClasses.forEachIndexed { index, ifaceClass ->
              val iface = mockk<UsbInterface>()
              every { iface.interfaceClass } returns ifaceClass
              every { device.getInterface(index) } returns iface
          }
          return device
      }

      @Test
      fun `device-class 14 is recognized as a capture device`() {
          val device = fakeDevice(deviceClass = 14)
          assertTrue(UsbCaptureDeviceNames(UsbDeviceLister { listOf(device) }).isCaptureDevice(device))
      }

      @Test
      fun `an interface of class 14 is recognized even when the device class itself is not`() {
          val device = fakeDevice(deviceClass = 0, interfaceClasses = listOf(1, 14))
          assertTrue(UsbCaptureDeviceNames(UsbDeviceLister { listOf(device) }).isCaptureDevice(device))
      }

      @Test
      fun `a known vendor id is recognized even with an unrelated device class`() {
          val device = fakeDevice(deviceClass = 0, vendorId = 1817) // AVerMedia
          assertTrue(UsbCaptureDeviceNames(UsbDeviceLister { listOf(device) }).isCaptureDevice(device))
      }

      @Test
      fun `an unrelated device is not recognized`() {
          val device = fakeDevice(deviceClass = 9, vendorId = 1, interfaceClasses = listOf(3))
          assertFalse(UsbCaptureDeviceNames(UsbDeviceLister { listOf(device) }).isCaptureDevice(device))
      }

      @Test
      fun `primary returns info when exactly one capture device is attached`() {
          val device = fakeDevice(deviceClass = 14, vendorId = 1817, productId = 42, productName = "AVerMedia Live Gamer")
          val names = UsbCaptureDeviceNames(UsbDeviceLister { listOf(device) })

          val info = names.primary()

          assertEquals("AVerMedia Live Gamer", info?.name)
          assertEquals(1817, info?.vendorId)
          assertEquals(42, info?.productId)
      }

      @Test
      fun `primary falls back to a generic name when productName is null or blank`() {
          val device = fakeDevice(deviceClass = 14, productName = null)
          assertEquals("USB capture card", UsbCaptureDeviceNames(UsbDeviceLister { listOf(device) }).primary()?.name)
      }

      @Test
      fun `primary returns null when no capture device is attached`() {
          val nonCapture = fakeDevice(deviceClass = 9)
          assertNull(UsbCaptureDeviceNames(UsbDeviceLister { listOf(nonCapture) }).primary())
      }

      @Test
      fun `primary returns null when more than one capture device is attached (ambiguous)`() {
          val a = fakeDevice(deviceClass = 14, productName = "Card A")
          val b = fakeDevice(deviceClass = 14, productName = "Card B")
          assertNull(UsbCaptureDeviceNames(UsbDeviceLister { listOf(a, b) }).primary())
      }
  }
  ```

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.UsbCaptureDeviceNamesTest'"`
  Expected: compile error — `unresolved reference: UsbCaptureDeviceNames`, `unresolved reference: UsbDeviceLister`.

- [ ] **Step 3: Implement UsbCaptureDeviceNames.kt.**

  `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbCaptureDeviceNames.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import android.hardware.usb.UsbDevice
  import android.hardware.usb.UsbManager

  private const val USB_CLASS_VIDEO = 14

  /** Vendor IDs of known USB capture-card manufacturers -- ported from
   * `<app-parent>/flutter_gazer/android/app/src/main/kotlin/io/waddlebot/gazer/UsbCapturePlugin.kt`'s
   * `isVideoDevice()` (Elgato, AVerMedia, Magewell), matching Task 1's usb_device_filter.xml. */
  private val KNOWN_CAPTURE_VENDOR_IDS = setOf(2893, 1817, 4176)

  /** One attached USB device recognized as a UVC-class (or known-vendor) capture card. */
  data class UsbCaptureDeviceInfo(
      val name: String,
      val vendorId: Int,
      val productId: Int,
      val device: UsbDevice,
  )

  /** Thin seam over [UsbManager.getDeviceList] so tests never need a real UsbManager. */
  fun interface UsbDeviceLister {
      fun devices(): Collection<UsbDevice>
  }

  /** Production [UsbDeviceLister] backed by the real [UsbManager]. */
  class UsbManagerDeviceLister(
      private val usbManager: UsbManager,
  ) : UsbDeviceLister {
      override fun devices(): Collection<UsbDevice> = usbManager.deviceList.values
  }

  /**
   * Recognizes attached USB capture cards (UVC class 14, an interface of that class, or a known
   * vendor ID) and names the current one, for [VideoSourceFactory]'s UVC device listing.
   *
   * Camera2 exposes no public API linking a `LENS_FACING_EXTERNAL` camera id to the specific
   * [UsbDevice] behind it, so [primary] makes a single-capture-card assumption (see Task 3 brief):
   * exactly one match is used for naming every external camera id found; zero or more than one
   * match returns null, and callers fall back to a generic name rather than guessing wrong.
   */
  class UsbCaptureDeviceNames(
      private val lister: UsbDeviceLister,
  ) {
      /** Whether [device] is a recognized UVC-class or known-vendor capture card. */
      fun isCaptureDevice(device: UsbDevice): Boolean {
          if (device.deviceClass == USB_CLASS_VIDEO) return true
          for (i in 0 until device.interfaceCount) {
              if (device.getInterface(i).interfaceClass == USB_CLASS_VIDEO) return true
          }
          return device.vendorId in KNOWN_CAPTURE_VENDOR_IDS
      }

      /** The one currently-attached capture device, or null if none or more than one is attached. */
      fun primary(): UsbCaptureDeviceInfo? {
          val device = lister.devices().filter(::isCaptureDevice).singleOrNull() ?: return null
          return UsbCaptureDeviceInfo(
              name = device.productName?.takeIf { it.isNotBlank() } ?: "USB capture card",
              vendorId = device.vendorId,
              productId = device.productId,
              device = device,
          )
      }
  }
  ```

- [ ] **Step 4: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.UsbCaptureDeviceNamesTest'"`
  Expected: `8 tests completed, 0 failed`.

- [ ] **Step 5: Update the existing VideoSourceFactoryTest.kt constructor calls and add UVC test cases.**

  Every existing `VideoSourceFactory(fakeContext(), ids)` call in the file gains a third argument. Replace the whole file:

  `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/VideoSourceFactoryTest.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import android.content.Context
  import android.hardware.camera2.CameraCharacteristics
  import android.hardware.camera2.CameraManager
  import com.pedro.encoder.input.sources.video.Camera2Source
  import io.mockk.every
  import io.mockk.mockk
  import io.waddlebot.gazer.pigeon.VideoDeviceKind
  import org.junit.jupiter.api.Assertions.assertEquals
  import org.junit.jupiter.api.Assertions.assertNull
  import org.junit.jupiter.api.Assertions.assertThrows
  import org.junit.jupiter.api.Assertions.assertTrue
  import org.junit.jupiter.api.Test

  /**
   * VideoSourceFactory covers list()/create()/negotiate()/onPrepared() using a fake CameraIds and
   * a fake UsbCaptureDeviceNames-backed lister, so no real CameraManager, UsbManager, or camera
   * hardware is required. Camera2Source's actual capture behaviour (including openCameraId) is
   * exercised only on an emulator/device via Task 9's instrumented test and manual device testing
   * (README device checklist).
   */
  class VideoSourceFactoryTest {

      private class FakeCameraIds(
          private val byFacingMap: Map<Int, String> = emptyMap(),
          private val external: List<String> = emptyList(),
          private val options: Map<String, List<CameraStreamOption>> = emptyMap(),
      ) : CameraIds {
          override fun byFacing(facing: Int): String? = byFacingMap[facing]

          override fun externalIds(): List<String> = external

          override fun streamOptions(cameraId: String): List<CameraStreamOption> = options[cameraId] ?: emptyList()
      }

      /** Context stub satisfying Camera2Source's constructor (Context.getSystemService(CAMERA_SERVICE) as CameraManager). */
      private fun fakeContext(): Context {
          val context = mockk<Context>()
          val cameraManager = mockk<CameraManager>(relaxed = true)
          every { context.getSystemService(Context.CAMERA_SERVICE) } returns cameraManager
          return context
      }

      private fun noCaptureDeviceNames(): UsbCaptureDeviceNames = UsbCaptureDeviceNames(UsbDeviceLister { emptyList() })

      @Test
      fun `list returns both cameras when both facings exist`() {
          val ids =
              FakeCameraIds(
                  byFacingMap =
                      mapOf(
                          CameraCharacteristics.LENS_FACING_BACK to "0",
                          CameraCharacteristics.LENS_FACING_FRONT to "1",
                      ),
              )
          val devices = VideoSourceFactory(fakeContext(), ids, noCaptureDeviceNames()).list()

          assertEquals(2, devices.size)
          assertEquals("camera:back", devices[0].id)
          assertEquals(VideoDeviceKind.BACK_CAMERA, devices[0].kind)
          assertEquals("camera:front", devices[1].id)
          assertEquals(VideoDeviceKind.FRONT_CAMERA, devices[1].kind)
      }

      @Test
      fun `list omits front camera when hardware lacks it`() {
          val ids = FakeCameraIds(byFacingMap = mapOf(CameraCharacteristics.LENS_FACING_BACK to "0"))
          val devices = VideoSourceFactory(fakeContext(), ids, noCaptureDeviceNames()).list()

          assertEquals(1, devices.size)
          assertEquals("camera:back", devices[0].id)
      }

      @Test
      fun `list returns empty when the device has no camera and no external id`() {
          val devices = VideoSourceFactory(fakeContext(), FakeCameraIds(), noCaptureDeviceNames()).list()

          assertEquals(0, devices.size)
      }

      @Test
      fun `create builds a back camera source without throwing`() {
          val factory = VideoSourceFactory(fakeContext(), FakeCameraIds(), noCaptureDeviceNames())

          val source = factory.create("camera:back")

          assertEquals(false, source.isRunning())
      }

      @Test
      fun `create builds a front camera source without throwing`() {
          val factory = VideoSourceFactory(fakeContext(), FakeCameraIds(), noCaptureDeviceNames())

          val source = factory.create("camera:front")

          assertEquals(false, source.isRunning())
      }

      @Test
      fun `create rejects an unknown device id`() {
          val factory = VideoSourceFactory(fakeContext(), FakeCameraIds(), noCaptureDeviceNames())

          assertThrows(IllegalArgumentException::class.java) { factory.create("camera:external") }
      }

      @Test
      fun `list surfaces an external Camera2 id as a UVC_CAMERA2 device with a generic name when no USB match exists`() {
          val ids = FakeCameraIds(external = listOf("2"))
          val devices = VideoSourceFactory(fakeContext(), ids, noCaptureDeviceNames()).list()

          assertEquals(1, devices.size)
          assertEquals("camera:uvc:2", devices[0].id)
          assertEquals(VideoDeviceKind.UVC_CAMERA2, devices[0].kind)
          assertEquals("USB capture card", devices[0].name)
          assertNull(devices[0].vendorId)
      }

      @Test
      fun `list names a UVC device from the matched USB capture device when exactly one is attached`() {
          val ids = FakeCameraIds(external = listOf("2"))
          val device = mockk<android.hardware.usb.UsbDevice>()
          every { device.deviceClass } returns 14
          every { device.interfaceCount } returns 0
          every { device.vendorId } returns 1817
          every { device.productId } returns 55
          every { device.productName } returns "AVerMedia Live Gamer"
          val names = UsbCaptureDeviceNames(UsbDeviceLister { listOf(device) })

          val devices = VideoSourceFactory(fakeContext(), ids, names).list()

          assertEquals("AVerMedia Live Gamer", devices[0].name)
          assertEquals(1817L, devices[0].vendorId)
          assertEquals(55L, devices[0].productId)
      }

      @Test
      fun `create for a UVC device id builds a plain unopened Camera2Source`() {
          val factory = VideoSourceFactory(fakeContext(), FakeCameraIds(external = listOf("2")), noCaptureDeviceNames())

          val source = factory.create("camera:uvc:2")

          assertTrue(source is Camera2Source)
          assertEquals(false, source.isRunning())
      }

      @Test
      fun `negotiate passes phone-camera requests through unchanged`() {
          val factory = VideoSourceFactory(fakeContext(), FakeCameraIds(), noCaptureDeviceNames())

          val result = factory.negotiate("camera:back", requestedWidth = 1280L, requestedHeight = 720L, requestedFps = 30L)

          assertEquals(NegotiatedFormat(1280L, 720L, 30L), result)
      }

      @Test
      fun `negotiate maps a UVC request to the nearest supported option`() {
          val ids =
              FakeCameraIds(
                  external = listOf("2"),
                  options = mapOf("2" to listOf(CameraStreamOption(1280, 720, 30), CameraStreamOption(640, 480, 30))),
              )
          val factory = VideoSourceFactory(fakeContext(), ids, noCaptureDeviceNames())

          val result = factory.negotiate("camera:uvc:2", requestedWidth = 1920L, requestedHeight = 1080L, requestedFps = 30L)

          assertEquals(NegotiatedFormat(1280L, 720L, 30L), result)
      }

      @Test
      fun `negotiate falls back to pass-through when the UVC device reports no options`() {
          val ids = FakeCameraIds(external = listOf("2"))
          val factory = VideoSourceFactory(fakeContext(), ids, noCaptureDeviceNames())

          val result = factory.negotiate("camera:uvc:2", requestedWidth = 1920L, requestedHeight = 1080L, requestedFps = 30L)

          assertEquals(NegotiatedFormat(1920L, 1080L, 30L), result)
      }

      @Test
      fun `onPrepared opens the external camera id once the source is running`() {
          val factory = VideoSourceFactory(fakeContext(), FakeCameraIds(external = listOf("2")), noCaptureDeviceNames())
          val source = mockk<Camera2Source>(relaxed = true)

          factory.onPrepared("camera:uvc:2", source)

          io.mockk.verify { source.openCameraId("2") }
      }

      @Test
      fun `onPrepared is a no-op for non-UVC device ids`() {
          val factory = VideoSourceFactory(fakeContext(), FakeCameraIds(), noCaptureDeviceNames())
          val source = mockk<Camera2Source>(relaxed = true)

          factory.onPrepared("camera:back", source)

          io.mockk.verify(exactly = 0) { source.openCameraId(any()) }
      }
  }
  ```

- [ ] **Step 6: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.VideoSourceFactoryTest'"`
  Expected: compile errors — `externalIds`/`streamOptions` unresolved on `CameraIds`, `VideoSourceFactory` 2-arg constructor mismatch, `negotiate`/`onPrepared` unresolved.

- [ ] **Step 7: Implement — extend CameraIds/CameraManagerIds and rewrite VideoSourceFactory.**

  `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/VideoSourceFactory.kt` (full replacement):
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import android.content.Context
  import android.graphics.SurfaceTexture
  import android.hardware.camera2.CameraAccessException
  import android.hardware.camera2.CameraCharacteristics
  import android.hardware.camera2.CameraManager
  import com.pedro.encoder.input.sources.video.Camera2Source
  import com.pedro.encoder.input.sources.video.VideoSource
  import io.waddlebot.gazer.pigeon.VideoDevice
  import io.waddlebot.gazer.pigeon.VideoDeviceKind

  /** Prefix for a Camera2-external (UVC-via-Camera2) device id: `"camera:uvc:<cameraId>"`. */
  const val UVC_DEVICE_PREFIX = "camera:uvc:"

  /** Resolved capture geometry: identical to the request for phone cameras (which scale digitally
   * to any size); narrowed to the nearest mode a UVC/Camera2-external device actually supports. */
  data class NegotiatedFormat(
      val width: Long,
      val height: Long,
      val fps: Long,
  )

  /**
   * Resolves a Pigeon video device id to a physical Android camera, indirected behind an interface
   * so tests can fake CameraManager without Robolectric.
   */
  interface CameraIds {
      /** Returns the camera id for [facing] (a CameraCharacteristics.LENS_FACING_* constant), or null if absent. */
      fun byFacing(facing: Int): String?

      /** Every camera id whose LENS_FACING is LENS_FACING_EXTERNAL (M2: UVC-via-Camera2 devices). */
      fun externalIds(): List<String>

      /** Every (size, max fps) mode [cameraId] advertises, for Camera2FormatNegotiator to choose from. */
      fun streamOptions(cameraId: String): List<CameraStreamOption>
  }

  /**
   * Production [CameraIds] backed by the real [CameraManager].
   *
   * `cameraIdList`/`getCameraCharacteristics` throw `CameraAccessException` when the camera service
   * is unavailable or the camera is disabled by device policy. This feeds `listVideoDevices()`, a
   * non-suspend Pigeon method, so an escaping throw would reach Dart as a PlatformException on a
   * plain device-list query; "this device has no usable camera right now" is exactly a null/empty
   * answer, so it is reported as one.
   */
  class CameraManagerIds(
      private val cameraManager: CameraManager,
  ) : CameraIds {
      override fun byFacing(facing: Int): String? {
          try {
              for (id in cameraManager.cameraIdList) {
                  val characteristics = cameraManager.getCameraCharacteristics(id)
                  if (characteristics.get(CameraCharacteristics.LENS_FACING) == facing) {
                      return id
                  }
              }
          } catch (_: CameraAccessException) {
              return null
          }
          return null
      }

      override fun externalIds(): List<String> {
          return try {
              cameraManager.cameraIdList.filter { id ->
                  cameraManager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) ==
                      CameraCharacteristics.LENS_FACING_EXTERNAL
              }
          } catch (_: CameraAccessException) {
              emptyList()
          }
      }

      override fun streamOptions(cameraId: String): List<CameraStreamOption> {
          return try {
              val characteristics = cameraManager.getCameraCharacteristics(cameraId)
              val configMap =
                  characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                      ?: return emptyList()
              val sizes = configMap.getOutputSizes(SurfaceTexture::class.java) ?: return emptyList()
              val fpsRanges = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
              val maxFps = fpsRanges?.maxOfOrNull { it.upper } ?: DEFAULT_MAX_FPS
              sizes.map { CameraStreamOption(width = it.width, height = it.height, maxFps = maxFps) }
          } catch (_: CameraAccessException) {
              emptyList()
          }
      }

      private companion object {
          const val DEFAULT_MAX_FPS = 30
      }
  }

  /**
   * Lists and creates RootEncoder [VideoSource]s: M1's back/front phone camera, plus M2's
   * Camera2-external ("`camera:uvc:<id>`") devices. UVC-via-libuvc is out of scope until M3.
   */
  class VideoSourceFactory(
      private val context: Context,
      private val cameraIds: CameraIds,
      private val captureDeviceNames: UsbCaptureDeviceNames,
  ) {
      /** Lists back/front camera (if present) followed by every external Camera2 id, named via [captureDeviceNames]. */
      fun list(): List<VideoDevice> {
          val devices = mutableListOf<VideoDevice>()
          if (cameraIds.byFacing(CameraCharacteristics.LENS_FACING_BACK) != null) {
              devices.add(VideoDevice(id = "camera:back", kind = VideoDeviceKind.BACK_CAMERA, name = "Back camera"))
          }
          if (cameraIds.byFacing(CameraCharacteristics.LENS_FACING_FRONT) != null) {
              devices.add(VideoDevice(id = "camera:front", kind = VideoDeviceKind.FRONT_CAMERA, name = "Front camera"))
          }
          val matched = captureDeviceNames.primary()
          for (externalId in cameraIds.externalIds()) {
              devices.add(
                  VideoDevice(
                      id = "$UVC_DEVICE_PREFIX$externalId",
                      kind = VideoDeviceKind.UVC_CAMERA2,
                      name = matched?.name ?: "USB capture card",
                      vendorId = matched?.vendorId?.toLong(),
                      productId = matched?.productId?.toLong(),
                  ),
              )
          }
          return devices
      }

      /**
       * Builds a [Camera2Source] for [deviceId]. VERIFIED (RootEncoder 2.8.1): Camera2Source
       * defaults to CameraHelper.Facing.BACK and only exposes facing selection via
       * switchCamera(), which flips the internal facing field unconditionally and only restarts
       * the camera if already running - safe to call immediately after construction, before
       * prepare()/start(). openCameraId(id) is NOT usable here for the same reason it cannot cold-
       * select a facing: it is a no-op unless the source isRunning() already. For a UVC device id
       * this method therefore returns a plain, not-yet-opened Camera2Source; [onPrepared] opens
       * the external id once GazerPipeline's prepare() has actually started the source (spec's
       * Camera2 External Fallback: "the M2 implementation starts the source on the default camera
       * and then calls openCameraId(externalId)").
       */
      fun create(deviceId: String): VideoSource {
          val source = Camera2Source(context)
          when {
              deviceId == "camera:back" -> Unit
              deviceId == "camera:front" -> source.switchCamera()
              deviceId.startsWith(UVC_DEVICE_PREFIX) -> Unit
              else -> throw IllegalArgumentException("Unknown video device id: $deviceId")
          }
          return source
      }

      /**
       * Opens the external camera id behind [deviceId] on [source], once it is actually running.
       * Called by [io.waddlebot.gazer.pipeline.GazerPipeline.prepare] immediately after a
       * successful `prepareVideo` (Task 4) — RootEncoder's Camera2Source is running by that point.
       * A no-op for every non-UVC device id.
       */
      fun onPrepared(
          deviceId: String,
          source: VideoSource,
      ) {
          if (deviceId.startsWith(UVC_DEVICE_PREFIX) && source is Camera2Source) {
              source.openCameraId(deviceId.removePrefix(UVC_DEVICE_PREFIX))
          }
      }

      /**
       * Resolves the requested geometry against what [deviceId] can actually deliver: unchanged
       * for a phone camera (digital scaling handles any size), narrowed to the nearest
       * [CameraStreamOption] via [Camera2FormatNegotiator] for a UVC device. Falls back to
       * pass-through if the device reports no usable options at all — `prepareVideo` will then
       * fail naturally and map to `encoderFailed`, same as an unsupported phone-camera request.
       */
      fun negotiate(
          deviceId: String,
          requestedWidth: Long,
          requestedHeight: Long,
          requestedFps: Long,
      ): NegotiatedFormat {
          if (!deviceId.startsWith(UVC_DEVICE_PREFIX)) {
              return NegotiatedFormat(requestedWidth, requestedHeight, requestedFps)
          }
          val cameraId = deviceId.removePrefix(UVC_DEVICE_PREFIX)
          val chosen =
              Camera2FormatNegotiator.negotiate(
                  options = cameraIds.streamOptions(cameraId),
                  requestedWidth = requestedWidth.toInt(),
                  requestedHeight = requestedHeight.toInt(),
                  requestedFps = requestedFps.toInt(),
              ) ?: return NegotiatedFormat(requestedWidth, requestedHeight, requestedFps)
          return NegotiatedFormat(chosen.width.toLong(), chosen.height.toLong(), chosen.maxFps.toLong())
      }
  }
  ```

- [ ] **Step 8: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.VideoSourceFactoryTest' --tests 'io.waddlebot.gazer.pipeline.sources.UsbCaptureDeviceNamesTest'"`
  Expected: `24 tests completed, 0 failed` (16 in VideoSourceFactoryTest + 8 in UsbCaptureDeviceNamesTest).

- [ ] **Step 9: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 10: Commit.**
  ```bash
  git add <app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbCaptureDeviceNames.kt \
          <app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/VideoSourceFactory.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbCaptureDeviceNamesTest.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/VideoSourceFactoryTest.kt
  git commit -m "$(cat <<'EOF'
  feat(gazer): enumerate, name, create, and negotiate format for UVC-via-Camera2 devices

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 4: GazerPipeline — negotiate/openCameraId wiring, forced UVC rotation, external-failure reporting

**Depends on:** Task 3 (`VideoSourceFactory.negotiate`/`onPrepared`).

**Files:**
- Modify: `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/GazerPipeline.kt`
- Modify, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/GazerPipelineTest.kt`

**Interfaces:**
- Consumes: `VideoSourceFactory.negotiate`/`onPrepared` (Task 3).
- Produces (verbatim, Shared Contract): `GazerPipeline` gains `val activeVideoDeviceId: String?` (volatile, set on successful `prepare`, cleared on `stop`/every terminal-failure path) and `fun reportExternalFailure(code: GazerErrorCode, detail: String?)`.

- [ ] **Step 1: Add the failing tests.**

  Add these test functions to the end of the `GazerPipelineTest` class body in `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/GazerPipelineTest.kt` (before the closing `}`), add `import io.waddlebot.gazer.pipeline.sources.NegotiatedFormat`, and add this line to `setUp()` (pass-through default, matching every existing test's phone-camera expectations unchanged — `secondArg`/`thirdArg`/`arg` are MockK's positional-argument accessors available inside an `answers` block):
  ```kotlin
  every { videoSources.negotiate(any(), any(), any(), any()) } answers {
      NegotiatedFormat(secondArg(), thirdArg(), arg(3))
  }
  ```

  ```kotlin
      @Test
      fun `activeVideoDeviceId is set on a successful prepare and cleared on stop`() {
          assertNull(pipeline.activeVideoDeviceId)
          pipeline.prepare(validConfig)
          assertEquals("camera:back", pipeline.activeVideoDeviceId)

          pipeline.stop()
          assertNull(pipeline.activeVideoDeviceId)
      }

      @Test
      fun `activeVideoDeviceId is cleared on a terminal ConnectChecker failure`() {
          pipeline.prepare(validConfig)
          pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
          pipeline.onConnectionFailed("timeout")

          assertNull(pipeline.activeVideoDeviceId)
      }

      @Test
      fun `prepare calls videoSources onPrepared with the resolved video source after a successful prepareVideo`() {
          val source = mockk<VideoSource>(relaxed = true)
          every { videoSources.create(any()) } returns source

          pipeline.prepare(validConfig)

          verify { videoSources.onPrepared("camera:back", source) }
      }

      @Test
      fun `prepare uses the negotiated geometry, not the raw request, for prepareVideo`() {
          every { videoSources.negotiate("camera:uvc:2", 1280L, 720L, 30L) } returns NegotiatedFormat(640L, 480L, 24L)
          val uvcConfig = validConfig.copy(videoDeviceId = "camera:uvc:2")

          pipeline.prepare(uvcConfig)

          verify { engine.prepareVideo(width = 640, height = 480, bitrateBps = any(), fps = 24, rotation = any()) }
      }

      @Test
      fun `a successful prepare reports the negotiated geometry, not the raw request`() {
          every { videoSources.negotiate("camera:uvc:2", 1280L, 720L, 30L) } returns NegotiatedFormat(640L, 480L, 24L)
          val uvcConfig = validConfig.copy(videoDeviceId = "camera:uvc:2")

          val result = pipeline.prepare(uvcConfig)

          assertEquals(640L, result.negotiatedWidth)
          assertEquals(480L, result.negotiatedHeight)
          assertEquals(24L, result.negotiatedFps)
      }

      @Test
      fun `rotation is forced to 0 for a UVC device even when portrait orientation is requested`() {
          val uvcPortraitConfig = validConfig.copy(videoDeviceId = "camera:uvc:2", orientation = OutputOrientation.PORTRAIT)

          pipeline.prepare(uvcPortraitConfig)

          verify { engine.prepareVideo(width = any(), height = any(), bitrateBps = any(), fps = any(), rotation = 0) }
      }

      @Test
      fun `portrait orientation still rotates 90 for a phone camera`() {
          val portraitConfig = validConfig.copy(orientation = OutputOrientation.PORTRAIT)

          pipeline.prepare(portraitConfig)

          verify { engine.prepareVideo(width = any(), height = any(), bitrateBps = any(), fps = any(), rotation = 90) }
      }

      @Test
      fun `reportExternalFailure releases the engine, stops sampling, and reports the given code`() {
          pipeline.prepare(validConfig)
          pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
          pipeline.onConnectionSuccess()
          clearMocks(listener, statsSampler, answers = false)

          pipeline.reportExternalFailure(GazerErrorCode.USB_DETACHED, "USB capture device detached: camera:uvc:2")

          assertEquals(NativePipelineState.ERROR, pipeline.state)
          assertNull(pipeline.activeVideoDeviceId)
          verify { engine.release() }
          verify { statsSampler.stop() }
          verify {
              listener.onState(
                  NativePipelineState.ERROR,
                  GazerErrorCode.USB_DETACHED,
                  "USB capture device detached: camera:uvc:2",
              )
          }
      }

      @Test
      fun `reportExternalFailure is a no-op when the pipeline is already idle`() {
          clearMocks(listener, statsSampler, answers = false)

          pipeline.reportExternalFailure(GazerErrorCode.USB_DETACHED, "irrelevant -- nothing was running")

          assertEquals(NativePipelineState.IDLE, pipeline.state)
          verify(exactly = 0) { listener.onState(any(), any(), any()) }
          verify(exactly = 0) { statsSampler.stop() }
      }
  ```

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.GazerPipelineTest'"`
  Expected: compile errors — `activeVideoDeviceId`/`reportExternalFailure` unresolved on `GazerPipeline`, `onPrepared`/`negotiate` unresolved on the `videoSources` mock (MockK still compiles those unresolved-mock-expectation calls against `VideoSourceFactory`'s real declared members, so the failure is a genuine "unresolved reference" from `VideoSourceFactory` not yet declaring them until Task 3's own build is picked up — if Task 3 already landed, these compile and the *behavioral* assertions fail instead, e.g. `activeVideoDeviceId` returns nothing because the property does not exist yet).

- [ ] **Step 3: Implement the GazerPipeline changes.**

  In `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/GazerPipeline.kt`:

  Add the field, immediately below the existing `state` property declaration:
  ```kotlin
      /**
       * The `StreamConfig.videoDeviceId` a successful [prepare] most recently configured, or null
       * when nothing is prepared/running. Read by [io.waddlebot.gazer.pipeline.sources.UsbHotplugController]
       * (Task 6) to decide whether a USB detach matches the device actually in use.
       */
      @Volatile
      var activeVideoDeviceId: String? = null
          private set
  ```

  Replace the rotation/prepareVideo block inside `prepare(config: StreamConfig)` — from `val rotation = if (config.orientation == OutputOrientation.PORTRAIT) 90 else 0` through the `if (!videoOk) { ... }` block — with:
  ```kotlin
          // UVC capture cards are always landscape (spec: "UVC always landscape 16:9") --
          // Dart is expected to send `orientation=landscape` for a UVC selection already, but the
          // rotation is forced here too so a stray/incorrect Dart-side value can never rotate a
          // capture-card feed.
          val isUvc = config.videoDeviceId.startsWith(UVC_DEVICE_PREFIX)
          val rotation = if (!isUvc && config.orientation == OutputOrientation.PORTRAIT) 90 else 0
          val negotiated = videoSources.negotiate(config.videoDeviceId, config.width, config.height, config.fps)
          val videoOk =
              runCatching {
                  newEngine.prepareVideo(
                      width = negotiated.width.toInt(),
                      height = negotiated.height.toInt(),
                      bitrateBps = (config.videoBitrateKbps * 1000).toInt(),
                      fps = negotiated.fps.toInt(),
                      rotation = rotation,
                  )
              }.getOrElse { false }
          if (!videoOk) {
              runCatching { newEngine.release() }
              val detail = "prepareVideo failed for ${negotiated.width}x${negotiated.height}@${negotiated.fps}"
              emitError(GazerErrorCode.ENCODER_FAILED, detail)
              return PrepareResult(ok = false, error = GazerErrorCode.ENCODER_FAILED, detail = detail)
          }
          videoSources.onPrepared(config.videoDeviceId, videoSource)
  ```

  Update the trailing success path — the `synchronized(lock) { engine = newEngine; ... }` block gains `activeVideoDeviceId = config.videoDeviceId`, and the returned `PrepareResult` uses the negotiated values:
  ```kotlin
          synchronized(lock) {
              engine = newEngine
              bitrateAdapter = adapter
              adaptiveBitrate = adaptive
              activeVideoDeviceId = config.videoDeviceId
              state = NativePipelineState.READY
          }
          listener.onState(NativePipelineState.READY)
          return PrepareResult(
              ok = true,
              negotiatedWidth = negotiated.width,
              negotiatedHeight = negotiated.height,
              negotiatedFps = negotiated.fps,
              negotiatedFormat = "H264/AAC",
          )
  ```

  Add the import (alongside the existing `io.waddlebot.gazer.pipeline.sources.*` imports):
  ```kotlin
  import io.waddlebot.gazer.pipeline.sources.UVC_DEVICE_PREFIX
  ```

  Clear `activeVideoDeviceId` everywhere an engine is torn down outside a fresh `prepare()`: in `stop()`'s existing `synchronized(lock) { currentEngine = engine; engine = null; bitrateAdapter = null; state = NativePipelineState.STOPPING }` block, add `activeVideoDeviceId = null`; in `captureEngineForErrorRelease()`'s `synchronized(lock) { ...; state = NativePipelineState.ERROR }` block, add `activeVideoDeviceId = null`.

  Add `reportExternalFailure` as a new public method, placed directly after `setVideoBitrate`:
  ```kotlin
      /**
       * Reports a failure detected OUTSIDE RootEncoder's own ConnectChecker callbacks — today,
       * only a mid-stream USB detach of the active UVC device
       * ([io.waddlebot.gazer.pipeline.sources.UsbHotplugController], Task 6). Captures and
       * releases whatever engine is live, stops the sampler, and reports [code]/[detail] as an
       * ERROR exactly like the three ConnectChecker terminal paths below — so Dart's
       * ReconnectPolicy and StatusPanel see one consistent failure shape regardless of which layer
       * detected it.
       *
       * A no-op when nothing is prepared/running (state already IDLE/ERROR): a detach of a device
       * that was never the active video source, or one arriving after the user already tapped
       * Stop, must not conjure a spurious error out of an idle pipeline.
       */
      fun reportExternalFailure(
          error: GazerErrorCode,
          detail: String?,
      ) {
          val engineToRelease: StreamEngine?
          val shouldReport: Boolean
          synchronized(lock) {
              shouldReport = state != NativePipelineState.IDLE && state != NativePipelineState.ERROR
              if (shouldReport) {
                  engineToRelease = engine
                  engine = null
                  bitrateAdapter = null
                  activeVideoDeviceId = null
                  state = NativePipelineState.ERROR
              } else {
                  engineToRelease = null
              }
          }
          if (!shouldReport) return
          statsSampler.stop()
          runCatching { engineToRelease?.release() }
          listener.onState(NativePipelineState.ERROR, error, detail)
      }
  ```

- [ ] **Step 4: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.GazerPipelineTest'"`
  Expected: all tests (the pre-existing ones plus the 9 added in Step 1) pass, 0 failed.

- [ ] **Step 5: Run the full Kotlin suite + coverage gate.**
  `make mobile-test-android`
  Expected: `BUILD SUCCESSFUL`, JaCoCo ≥90%.

- [ ] **Step 6: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 7: Commit.**
  ```bash
  git add <app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/GazerPipeline.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/GazerPipelineTest.kt
  git commit -m "$(cat <<'EOF'
  feat(gazer): GazerPipeline negotiates UVC geometry, opens the external camera post-prepare, and reports external failures

  Uses VideoSourceFactory.negotiate()'s resolved width/height/fps for
  prepareVideo and the returned PrepareResult instead of the raw request,
  calls onPrepared() to open the external Camera2 id once the source is
  running, forces rotation=0 for UVC regardless of requested orientation,
  and adds activeVideoDeviceId + reportExternalFailure() for Task 6's
  mid-stream USB-detach reporting.

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 5: UsbPermissionCoordinator — the real requestUsbPermission implementation

**Depends on:** Task 1 (USB manifest/feature — logical prerequisite; no runtime dependency for the JVM tests in this task).

**Files:**
- Create: `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbPermissionCoordinator.kt`
- Create, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbPermissionCoordinatorTest.kt`
- Modify: `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/PigeonHostApiImpl.kt`
- Modify, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/PigeonHostApiImplTest.kt`

**Interfaces:**
- Consumes: `UsbCaptureDeviceNames` (Task 3).
- Produces (verbatim, Shared Contract): `UsbDevicesGateway`, `AndroidUsbDevicesGateway`, `UsbPermissionCoordinator`.
- `PigeonHostApiImpl` gains a constructor parameter `private val usbPermission: UsbPermissionCoordinator` and its `requestUsbPermission` override changes from the M1 hardcoded `return false` to `return usbPermission.request(deviceId)`.

**Design note (why two seams, not a raw `UsbManager`):** `UsbDevicesGateway` covers the three real `UsbManager`/`UsbDevice` calls (`deviceFor`, `hasPermission`, `requestPermission`); the `registerReceiver`/`unregisterReceiver`/`buildPendingIntent` parameters on `UsbPermissionCoordinator` itself are injected as plain function values (not wrapped in a third interface) so the coordinator's entire decision logic — already-granted short-circuit, unknown-device rejection, timeout, and the granted/denied result itself — runs and is asserted on the JVM with no `Context` at all. Only `GazerFlutterBindings`' construction of the *real* lambdas (Task 8) touches an actual `Context`.

**Two-outcome USB permission gate, not three (documented decision):** `permission_handler`'s runtime permissions (`PermissionGate`, M1) have three outcomes because Android tracks "don't ask again" for those and exposes it via `PermissionStatus.isPermanentlyDenied`. `UsbManager`'s per-device permission dialog has no equivalent queryable "always deny" signal — every call re-shows the system dialog if not currently granted — so `UsbPermissionCoordinator.request` (and Dart's mirroring gate, Task 14) has exactly two outcomes: granted/denied.

- [ ] **Step 1: Write the failing UsbPermissionCoordinator test.**

  `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbPermissionCoordinatorTest.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import android.app.PendingIntent
  import android.content.BroadcastReceiver
  import android.content.Context
  import android.content.Intent
  import android.content.IntentFilter
  import android.hardware.usb.UsbDevice
  import android.hardware.usb.UsbManager
  import io.mockk.mockk
  import kotlinx.coroutines.async
  import kotlinx.coroutines.runBlocking
  import kotlinx.coroutines.yield
  import org.junit.jupiter.api.Assertions.assertFalse
  import org.junit.jupiter.api.Assertions.assertTrue
  import org.junit.jupiter.api.Test

  class UsbPermissionCoordinatorTest {

      private class FakeGateway(
          private val device: UsbDevice?,
          private var granted: Boolean,
      ) : UsbDevicesGateway {
          var requestPermissionCallCount = 0
              private set

          override fun deviceFor(cameraId: String): UsbDevice? = device

          override fun hasPermission(device: UsbDevice): Boolean = granted

          override fun requestPermission(
              device: UsbDevice,
              pendingIntent: PendingIntent,
          ) {
              requestPermissionCallCount += 1
          }
      }

      private fun coordinator(
          gateway: UsbDevicesGateway,
          timeoutMs: Long = 5_000L,
          onRegister: (BroadcastReceiver) -> Unit = {},
      ): UsbPermissionCoordinator =
          UsbPermissionCoordinator(
              gateway = gateway,
              buildPendingIntent = { mockk(relaxed = true) },
              registerReceiver = { receiver, _ -> onRegister(receiver) },
              unregisterReceiver = {},
              timeoutMs = timeoutMs,
          )

      @Test
      fun `a non-UVC device id is rejected without touching the gateway`() =
          runBlocking {
              val gateway = FakeGateway(device = null, granted = false)

              val result = coordinator(gateway).request("camera:back")

              assertFalse(result)
              assertEquals(0, gateway.requestPermissionCallCount)
          }

      @Test
      fun `an unresolvable UVC device id is denied`() =
          runBlocking {
              val result = coordinator(FakeGateway(device = null, granted = false)).request("camera:uvc:2")
              assertFalse(result)
          }

      @Test
      fun `already-granted permission short-circuits to true without showing the dialog`() =
          runBlocking {
              val gateway = FakeGateway(device = mockk(relaxed = true), granted = true)

              val result = coordinator(gateway).request("camera:uvc:2")

              assertTrue(result)
              assertEquals(0, gateway.requestPermissionCallCount)
          }

      @Test
      fun `a granted broadcast result resolves to true`() =
          runBlocking {
              val gateway = FakeGateway(device = mockk(relaxed = true), granted = false)
              var captured: BroadcastReceiver? = null
              val deferred = async { coordinator(gateway, onRegister = { captured = it }).request("camera:uvc:2") }
              while (captured == null) yield()

              val intent = mockk<Intent>()
              io.mockk.every { intent.action } returns UsbPermissionCoordinator.ACTION_USB_PERMISSION
              io.mockk.every { intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) } returns true
              captured!!.onReceive(mockk<Context>(), intent)

              assertTrue(deferred.await())
              assertEquals(1, gateway.requestPermissionCallCount)
          }

      @Test
      fun `a denied broadcast result resolves to false`() =
          runBlocking {
              val gateway = FakeGateway(device = mockk(relaxed = true), granted = false)
              var captured: BroadcastReceiver? = null
              val deferred = async { coordinator(gateway, onRegister = { captured = it }).request("camera:uvc:2") }
              while (captured == null) yield()

              val intent = mockk<Intent>()
              io.mockk.every { intent.action } returns UsbPermissionCoordinator.ACTION_USB_PERMISSION
              io.mockk.every { intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) } returns false
              captured!!.onReceive(mockk<Context>(), intent)

              assertFalse(deferred.await())
          }

      @Test
      fun `no broadcast arriving before the timeout resolves to false`() =
          runBlocking {
              val gateway = FakeGateway(device = mockk(relaxed = true), granted = false)

              val result = coordinator(gateway, timeoutMs = 50L).request("camera:uvc:2")

              assertFalse(result)
          }

      @Test
      fun `an unrelated broadcast action is ignored, not mistaken for the permission result`() =
          runBlocking {
              val gateway = FakeGateway(device = mockk(relaxed = true), granted = false)
              var captured: BroadcastReceiver? = null
              val deferred = async { coordinator(gateway, timeoutMs = 200L, onRegister = { captured = it }).request("camera:uvc:2") }
              while (captured == null) yield()

              val unrelated = mockk<Intent>()
              io.mockk.every { unrelated.action } returns "some.other.action"
              captured!!.onReceive(mockk<Context>(), unrelated)

              assertFalse(deferred.await())
          }
  }
  ```

  Add `import org.junit.jupiter.api.Assertions.assertEquals` alongside the other JUnit imports.

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.UsbPermissionCoordinatorTest'"`
  Expected: compile error — `unresolved reference: UsbDevicesGateway`, `unresolved reference: UsbPermissionCoordinator`.

- [ ] **Step 3: Implement.**

  `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbPermissionCoordinator.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import android.app.PendingIntent
  import android.content.BroadcastReceiver
  import android.content.Context
  import android.content.Intent
  import android.content.IntentFilter
  import android.hardware.usb.UsbDevice
  import android.hardware.usb.UsbManager
  import kotlinx.coroutines.CompletableDeferred
  import kotlinx.coroutines.withTimeoutOrNull

  /**
   * Thin seam over [UsbManager] so [UsbPermissionCoordinatorTest] never needs a real Context.
   * [deviceFor] resolves a Camera2 external camera id to its backing [UsbDevice] via
   * [UsbCaptureDeviceNames]'s single-capture-card match (Task 3) — Camera2 exposes no public API
   * linking a camera id to the USB device behind it.
   */
  interface UsbDevicesGateway {
      fun deviceFor(cameraId: String): UsbDevice?

      fun hasPermission(device: UsbDevice): Boolean

      fun requestPermission(
          device: UsbDevice,
          pendingIntent: PendingIntent,
      )
  }

  /** Production [UsbDevicesGateway] backed by the real [UsbManager] and [UsbCaptureDeviceNames]. */
  class AndroidUsbDevicesGateway(
      private val usbManager: UsbManager,
      private val captureDeviceNames: UsbCaptureDeviceNames,
  ) : UsbDevicesGateway {
      override fun deviceFor(cameraId: String): UsbDevice? = captureDeviceNames.primary()?.device

      override fun hasPermission(device: UsbDevice): Boolean = usbManager.hasPermission(device)

      override fun requestPermission(
          device: UsbDevice,
          pendingIntent: PendingIntent,
      ) {
          usbManager.requestPermission(device, pendingIntent)
      }
  }

  /**
   * Real Pigeon `requestUsbPermission(deviceId)` implementation. Resolves `"camera:uvc:<id>"` to
   * its backing UsbDevice via [gateway], short-circuits if already granted, otherwise shows
   * Android's system permission dialog and suspends on the `ACTION_USB_PERMISSION` result
   * broadcast (or [timeoutMs]).
   *
   * [registerReceiver]/[unregisterReceiver]/[buildPendingIntent] are injected function seams over
   * `Context`-bound calls (rather than holding a `Context` field) so every decision this class
   * makes — already-granted short circuit, unknown device, timeout, granted/denied — is
   * unit-testable with a synchronously-completing fake registration; only
   * [io.waddlebot.gazer.GazerFlutterBindings]' real wiring (Task 8) touches an actual Context.
   *
   * Two outcomes only, never a third "permanently denied" — see the Task 5 brief.
   */
  class UsbPermissionCoordinator(
      private val gateway: UsbDevicesGateway,
      private val buildPendingIntent: () -> PendingIntent,
      private val registerReceiver: (BroadcastReceiver, IntentFilter) -> Unit,
      private val unregisterReceiver: (BroadcastReceiver) -> Unit,
      private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
  ) {
      companion object {
          const val DEFAULT_TIMEOUT_MS = 15_000L
          const val ACTION_USB_PERMISSION = "io.waddlebot.gazer.action.USB_PERMISSION"
      }

      /** Requests permission for [deviceId]; false for anything not a `"camera:uvc:<id>"` id, an unresolvable device, denial, or timeout. */
      suspend fun request(deviceId: String): Boolean {
          if (!deviceId.startsWith(UVC_DEVICE_PREFIX)) return false
          val cameraId = deviceId.removePrefix(UVC_DEVICE_PREFIX)
          val device = gateway.deviceFor(cameraId) ?: return false
          if (gateway.hasPermission(device)) return true

          val result = CompletableDeferred<Boolean>()
          val receiver =
              object : BroadcastReceiver() {
                  override fun onReceive(
                      context: Context,
                      intent: Intent,
                  ) {
                      if (intent.action != ACTION_USB_PERMISSION) return
                      result.complete(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
                  }
              }
          registerReceiver(receiver, IntentFilter(ACTION_USB_PERMISSION))
          gateway.requestPermission(device, buildPendingIntent())
          val granted = withTimeoutOrNull(timeoutMs) { result.await() } ?: false
          unregisterReceiver(receiver)
          return granted
      }
  }
  ```

- [ ] **Step 4: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.UsbPermissionCoordinatorTest'"`
  Expected: `7 tests completed, 0 failed`.

- [ ] **Step 5: Wire into PigeonHostApiImpl — add the failing constructor-shape test first.**

  In `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/PigeonHostApiImplTest.kt`, find the test construction helper that builds a `PigeonHostApiImpl` (every existing test uses it) and add the new constructor argument there, then add this new test alongside the existing ones:
  ```kotlin
      @Test
      fun `requestUsbPermission delegates to the injected UsbPermissionCoordinator`() =
          runBlocking {
              val usbPermission = mockk<UsbPermissionCoordinator>()
              coEvery { usbPermission.request("camera:uvc:2") } returns true
              val impl = buildImpl(usbPermission = usbPermission) // helper updated in this step

              val granted = impl.requestUsbPermission("camera:uvc:2")

              assertTrue(granted)
              coVerify { usbPermission.request("camera:uvc:2") }
          }
  ```
  Add `import io.mockk.coEvery`, `import io.mockk.coVerify`, and `import io.waddlebot.gazer.pipeline.sources.UsbPermissionCoordinator` if not already present. Update every existing call to the test's `PigeonHostApiImpl(...)` constructor helper to also pass a default `usbPermission: UsbPermissionCoordinator = mockk(relaxed = true)` parameter through the helper's own signature, so none of the pre-existing tests need individual edits.

- [ ] **Step 6: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.PigeonHostApiImplTest'"`
  Expected: compile error — `PigeonHostApiImpl` has no `usbPermission` parameter yet.

- [ ] **Step 7: Implement — add the constructor parameter and real override.**

  In `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/PigeonHostApiImpl.kt`, add the import `import io.waddlebot.gazer.pipeline.sources.UsbPermissionCoordinator`, add `private val usbPermission: UsbPermissionCoordinator,` to the primary constructor (placed after `audioDevices: () -> List<AudioDevice>,`), and replace:
  ```kotlin
      override suspend fun requestUsbPermission(deviceId: String): Boolean {
          // M1 lists no USB devices; always deny so Dart's UI never offers a USB source.
          return false
      }
  ```
  with:
  ```kotlin
      override suspend fun requestUsbPermission(deviceId: String): Boolean = usbPermission.request(deviceId)
  ```

- [ ] **Step 8: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.PigeonHostApiImplTest'"`
  Expected: all `PigeonHostApiImplTest` tests pass, 0 failed. (`GazerFlutterBindings.install()`'s own construction site does not yet pass a real `UsbPermissionCoordinator` — that lands in Task 8; until then `GazerFlutterBindingsTest`/the app fail to compile if built in isolation, which is why this task's own scope is limited to `PigeonHostApiImpl` and its test, not `GazerFlutterBindings`. Confirm with `make mobile-run CMD="./gradlew :app:compileDebugKotlin"` — expected to FAIL here with `no value passed for parameter usbPermission` at `GazerFlutterBindings.kt`'s `PigeonHostApiImpl(...)` call, which is expected and resolved by Task 8; do not attempt to fix it in this task.)

- [ ] **Step 9: Lint the two files this task actually owns.**
  `make mobile-run CMD="./gradlew ktlintCheck"` → PASS (ktlint runs project-wide and does not require a full compile).

- [ ] **Step 10: Commit.**
  ```bash
  git add <app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbPermissionCoordinator.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbPermissionCoordinatorTest.kt \
          <app>/android/app/src/main/kotlin/io/waddlebot/gazer/PigeonHostApiImpl.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/PigeonHostApiImplTest.kt
  git commit -m "$(cat <<'EOF'
  feat(gazer): real requestUsbPermission via UsbPermissionCoordinator

  PigeonHostApiImpl.requestUsbPermission was hardcoded false in M1 (no
  UVC devices were ever listed); now delegates to UsbPermissionCoordinator,
  which shows UsbManager's system permission dialog and awaits its result
  broadcast. GazerFlutterBindings' construction site is intentionally left
  broken until Task 8, which wires the real Context-bound gateway.

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 6: UsbHotplugController — attach/detach forwarding + mid-stream detach reporting

**Depends on:** Task 4 (`GazerPipeline.activeVideoDeviceId`/`reportExternalFailure`), Task 5 (parallel — no direct dependency, but both feed Task 8's wiring).

**Files:**
- Create: `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbHotplugController.kt`
- Create, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbHotplugControllerTest.kt`

**Interfaces:**
- Consumes: Pigeon `VideoDevice`/`VideoDeviceKind.UVC_CAMERA2`, `GazerErrorCode.USB_DETACHED`, `GazerPipeline.activeVideoDeviceId`/`reportExternalFailure` (Task 4).
- Produces (verbatim, Shared Contract): `ReceiverRegistrar`, `ContextReceiverRegistrar`, `UsbHotplugController`.

**Attach-vs-detach asymmetry (documented decision):** a **detach** is detected by immediately re-listing (`UsbManager.ACTION_USB_DEVICE_DETACHED` fires only after Android has already dropped the device, so `listVideoDevices()` reflects the removal at once). An **attach** re-lists after a short settle delay (`ATTACH_SETTLE_DELAY_MS`): Camera2 takes a moment to surface a newly attached `LENS_FACING_EXTERNAL` camera id after the USB broadcast fires, so listing immediately can observe the pre-attach state and silently miss the new device on that pass (it would still appear on the *next* enumeration, e.g. the next app-foreground device query, but the live "device just attached" push to Dart would be lost). This mirrors the spec's own SourceSelector "wait up to 3s" allowance for Camera2-external to appear, scaled down since this is presence-detection, not full source negotiation.

- [ ] **Step 1: Write the failing test.**

  `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbHotplugControllerTest.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import android.content.BroadcastReceiver
  import android.content.Context
  import android.content.Intent
  import android.content.IntentFilter
  import android.hardware.usb.UsbManager
  import io.mockk.every
  import io.mockk.mockk
  import io.mockk.verify
  import io.waddlebot.gazer.pigeon.GazerErrorCode
  import io.waddlebot.gazer.pigeon.VideoDevice
  import io.waddlebot.gazer.pigeon.VideoDeviceKind
  import io.waddlebot.gazer.pipeline.GazerPipeline
  import org.junit.jupiter.api.Assertions.assertEquals
  import org.junit.jupiter.api.BeforeEach
  import org.junit.jupiter.api.Test

  class UsbHotplugControllerTest {

      private val backCamera = VideoDevice(id = "camera:back", kind = VideoDeviceKind.BACK_CAMERA, name = "Back camera")
      private val uvcDevice = VideoDevice(id = "camera:uvc:2", kind = VideoDeviceKind.UVC_CAMERA2, name = "USB capture card")

      private var currentDevices: List<VideoDevice> = listOf(backCamera)
      private lateinit var registeredReceiver: BroadcastReceiver
      private val attached = mutableListOf<VideoDevice>()
      private val detached = mutableListOf<String>()
      private var pipeline: GazerPipeline? = null

      private val registrar =
          object : ReceiverRegistrar {
              override fun register(
                  receiver: BroadcastReceiver,
                  filter: IntentFilter,
              ) {
                  registeredReceiver = receiver
              }

              override fun unregister(receiver: BroadcastReceiver) = Unit
          }

      private lateinit var controller: UsbHotplugController

      @BeforeEach
      fun setUp() {
          currentDevices = listOf(backCamera)
          attached.clear()
          detached.clear()
          pipeline = null
          controller =
              UsbHotplugController(
                  registrar = registrar,
                  listVideoDevices = { currentDevices },
                  pipeline = { pipeline },
                  onAttached = { attached.add(it) },
                  onDetached = { detached.add(it) },
                  // Runs the delayed action immediately -- deterministic on the JVM, no real Handler.
                  postDelayed = { _, action -> action() },
              )
          controller.start()
      }

      private fun intentFor(action: String): Intent {
          val intent = mockk<Intent>()
          every { intent.action } returns action
          return intent
      }

      @Test
      fun `an attach that adds a new UVC device is reported once settled`() {
          currentDevices = listOf(backCamera, uvcDevice)

          registeredReceiver.onReceive(mockk<Context>(), intentFor(UsbManager.ACTION_USB_DEVICE_ATTACHED))

          assertEquals(listOf(uvcDevice), attached)
      }

      @Test
      fun `an attach broadcast with no new UVC device reports nothing`() {
          registeredReceiver.onReceive(mockk<Context>(), intentFor(UsbManager.ACTION_USB_DEVICE_ATTACHED))

          assertEquals(emptyList<VideoDevice>(), attached)
      }

      @Test
      fun `a detach that removes a known UVC device is reported`() {
          currentDevices = listOf(backCamera, uvcDevice)
          registeredReceiver.onReceive(mockk<Context>(), intentFor(UsbManager.ACTION_USB_DEVICE_ATTACHED))
          currentDevices = listOf(backCamera)

          registeredReceiver.onReceive(mockk<Context>(), intentFor(UsbManager.ACTION_USB_DEVICE_DETACHED))

          assertEquals(listOf("camera:uvc:2"), detached)
      }

      @Test
      fun `a detach of the pipeline's active video device reports a USB_DETACHED pipeline error`() {
          currentDevices = listOf(backCamera, uvcDevice)
          registeredReceiver.onReceive(mockk<Context>(), intentFor(UsbManager.ACTION_USB_DEVICE_ATTACHED))
          val fakePipeline = mockk<GazerPipeline>(relaxed = true)
          every { fakePipeline.activeVideoDeviceId } returns "camera:uvc:2"
          pipeline = fakePipeline
          currentDevices = listOf(backCamera)

          registeredReceiver.onReceive(mockk<Context>(), intentFor(UsbManager.ACTION_USB_DEVICE_DETACHED))

          verify { fakePipeline.reportExternalFailure(GazerErrorCode.USB_DETACHED, any()) }
      }

      @Test
      fun `a detach that is not the pipeline's active device does not report a pipeline error`() {
          currentDevices = listOf(backCamera, uvcDevice)
          registeredReceiver.onReceive(mockk<Context>(), intentFor(UsbManager.ACTION_USB_DEVICE_ATTACHED))
          val fakePipeline = mockk<GazerPipeline>(relaxed = true)
          every { fakePipeline.activeVideoDeviceId } returns "camera:back"
          pipeline = fakePipeline
          currentDevices = listOf(backCamera)

          registeredReceiver.onReceive(mockk<Context>(), intentFor(UsbManager.ACTION_USB_DEVICE_DETACHED))

          verify(exactly = 0) { fakePipeline.reportExternalFailure(any(), any()) }
          assertEquals(listOf("camera:uvc:2"), detached)
      }

      @Test
      fun `an unrelated broadcast action is ignored`() {
          registeredReceiver.onReceive(mockk<Context>(), intentFor("some.other.action"))

          assertEquals(emptyList<VideoDevice>(), attached)
          assertEquals(emptyList<String>(), detached)
      }

      @Test
      fun `stop unregisters the receiver`() {
          var unregistered = false
          val trackingRegistrar =
              object : ReceiverRegistrar {
                  override fun register(
                      receiver: BroadcastReceiver,
                      filter: IntentFilter,
                  ) = Unit

                  override fun unregister(receiver: BroadcastReceiver) {
                      unregistered = true
                  }
              }
          val c =
              UsbHotplugController(
                  registrar = trackingRegistrar,
                  listVideoDevices = { emptyList() },
                  pipeline = { null },
                  onAttached = {},
                  onDetached = {},
                  postDelayed = { _, action -> action() },
              )
          c.start()

          c.stop()

          assertEquals(true, unregistered)
      }
  }
  ```

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.UsbHotplugControllerTest'"`
  Expected: compile error — `unresolved reference: ReceiverRegistrar`, `unresolved reference: UsbHotplugController`.

- [ ] **Step 3: Implement.**

  `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbHotplugController.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import android.content.BroadcastReceiver
  import android.content.Context
  import android.content.Intent
  import android.content.IntentFilter
  import android.hardware.usb.UsbManager
  import android.os.Build
  import io.waddlebot.gazer.pigeon.GazerErrorCode
  import io.waddlebot.gazer.pigeon.VideoDevice
  import io.waddlebot.gazer.pigeon.VideoDeviceKind
  import io.waddlebot.gazer.pipeline.GazerPipeline

  /** Thin seam over [Context.registerReceiver]/[Context.unregisterReceiver] so [UsbHotplugControllerTest] never needs a real Context. */
  interface ReceiverRegistrar {
      fun register(
          receiver: BroadcastReceiver,
          filter: IntentFilter,
      )

      fun unregister(receiver: BroadcastReceiver)
  }

  /** Production [ReceiverRegistrar], honouring Android 13+'s mandatory exported-flag argument. */
  class ContextReceiverRegistrar(
      private val context: Context,
  ) : ReceiverRegistrar {
      override fun register(
          receiver: BroadcastReceiver,
          filter: IntentFilter,
      ) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
          } else {
              @Suppress("UnspecifiedRegisterReceiverFlag")
              context.registerReceiver(receiver, filter)
          }
      }

      override fun unregister(receiver: BroadcastReceiver) {
          context.unregisterReceiver(receiver)
      }
  }

  /**
   * Detects USB capture-card attach/detach while the Flutter engine is alive and forwards the two
   * Pigeon hot-plug events (`onUsbAttached`/`onUsbDetached`) — registered/torn down alongside
   * `PigeonHostApiImpl` by `GazerFlutterBindings` (Task 8), never manifest-static: a detach only
   * matters while something could be listening for it (a cold/background attach is instead handled
   * by MainActivity's manifest intent-filter, Task 1).
   *
   * A detach that matches [GazerPipeline.activeVideoDeviceId] is additionally reported as a
   * terminal `GazerErrorCode.USB_DETACHED` pipeline error via [GazerPipeline.reportExternalFailure]
   * (spec's Foreground Service section: "USB detach while streaming: stop with error usbDetached")
   * — this class is the only place that knows both facts (which device detached, which device the
   * pipeline is actually using) at once; `GazerPipeline` only executes the decision.
   */
  class UsbHotplugController(
      private val registrar: ReceiverRegistrar,
      private val listVideoDevices: () -> List<VideoDevice>,
      private val pipeline: () -> GazerPipeline?,
      private val onAttached: (VideoDevice) -> Unit,
      private val onDetached: (String) -> Unit,
      private val postDelayed: (Long, () -> Unit) -> Unit,
  ) {
      private companion object {
          /** Camera2 can take a moment to surface a newly attached external camera id after the USB broadcast; re-listing immediately can miss it. */
          const val ATTACH_SETTLE_DELAY_MS = 1_500L
      }

      private var knownUvcIds: Set<String> = emptySet()

      private val receiver =
          object : BroadcastReceiver() {
              override fun onReceive(
                  context: Context,
                  intent: Intent,
              ) {
                  when (intent.action) {
                      UsbManager.ACTION_USB_DEVICE_ATTACHED -> handleAttach()
                      UsbManager.ACTION_USB_DEVICE_DETACHED -> handleDetach()
                  }
              }
          }

      /** Registers the receiver and snapshots the currently-known UVC device ids; call once, when the engine attaches. */
      fun start() {
          knownUvcIds = uvcIds(listVideoDevices())
          val filter =
              IntentFilter().apply {
                  addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
                  addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
              }
          registrar.register(receiver, filter)
      }

      /** Unregisters the receiver; call once, when the engine detaches. */
      fun stop() {
          registrar.unregister(receiver)
      }

      private fun handleAttach() {
          postDelayed(ATTACH_SETTLE_DELAY_MS) {
              val current = listVideoDevices()
              val currentIds = uvcIds(current)
              val newlyAttached = current.filter { it.id in currentIds && it.id !in knownUvcIds }
              knownUvcIds = currentIds
              newlyAttached.forEach(onAttached)
          }
      }

      private fun handleDetach() {
          val currentIds = uvcIds(listVideoDevices())
          val removed = knownUvcIds - currentIds
          knownUvcIds = currentIds
          removed.forEach { deviceId ->
              val active = pipeline()
              if (active?.activeVideoDeviceId == deviceId) {
                  active.reportExternalFailure(GazerErrorCode.USB_DETACHED, "USB capture device detached: $deviceId")
              }
              onDetached(deviceId)
          }
      }

      private fun uvcIds(devices: List<VideoDevice>): Set<String> =
          devices.filter { it.kind == VideoDeviceKind.UVC_CAMERA2 }.map { it.id }.toSet()
  }
  ```

- [ ] **Step 4: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.UsbHotplugControllerTest'"`
  Expected: `7 tests completed, 0 failed`.

- [ ] **Step 5: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 6: Commit.**
  ```bash
  git add <app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/UsbHotplugController.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbHotplugControllerTest.kt
  git commit -m "$(cat <<'EOF'
  feat(gazer): USB hot-plug attach/detach forwarding + mid-stream detach reporting

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 7: USB Audio Class — AudioSourceFactory extension + UsbAudioSource

**Depends on:** none (independent of Tasks 2–6; touches a different file family).

**Files:**
- Modify: `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/AudioSourceFactory.kt`
- Modify, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/AudioSourceFactoryTest.kt`
- Create, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbAudioFramingTest.kt`
- Modify: `<app>/android/app/build.gradle.kts` (JaCoCo exclusion)

**Interfaces:**
- Produces (verbatim, Shared Contract): `AudioInputDevices`, `NoUsbInput`, `AndroidAudioInputDevices`; `AudioSourceFactory` constructor gains `audioInputDevices: AudioInputDevices = NoUsbInput` (default preserves every existing `AudioSourceFactory()` call site unmodified); `"audio:usb"` → `UsbAudioSource`; `object UsbAudioFraming { fun chunkByteSize(sampleRate: Int, channels: Int, chunkMillis: Long = 20L): Int }`.
- `UsbAudioSource` cannot run on the JVM unit-test target (`AudioRecord.Builder().build()` needs a real audio HAL) — same class of limitation as `RootEncoderEngine` (M1). Its buffer-size arithmetic is extracted into `UsbAudioFraming` specifically so *something* about this class is genuinely unit-tested; the class itself is narrowly JaCoCo-excluded (this task's `build.gradle.kts` change) and its actual capture behaviour is manual-only (README device checklist, Task 16) — a USB audio device cannot be attached to CI's emulator.

- [ ] **Step 1: Write the failing tests.**

  `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbAudioFramingTest.kt`:
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import org.junit.jupiter.api.Assertions.assertEquals
  import org.junit.jupiter.api.Test

  class UsbAudioFramingTest {

      @Test
      fun `20ms of 48kHz stereo PCM16 is 3840 bytes`() {
          assertEquals(3840, UsbAudioFraming.chunkByteSize(sampleRate = 48000, channels = 2))
      }

      @Test
      fun `20ms of 48kHz mono PCM16 is 1920 bytes`() {
          assertEquals(1920, UsbAudioFraming.chunkByteSize(sampleRate = 48000, channels = 1))
      }

      @Test
      fun `a shorter chunk duration scales down proportionally`() {
          assertEquals(1920, UsbAudioFraming.chunkByteSize(sampleRate = 48000, channels = 2, chunkMillis = 10L))
      }

      @Test
      fun `result is never zero even for a very low sample rate`() {
          assertEquals(2, UsbAudioFraming.chunkByteSize(sampleRate = 1, channels = 1, chunkMillis = 20L))
      }
  }
  ```

  Add these cases to the existing `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/AudioSourceFactoryTest.kt` (append to the class body; the pre-existing `list returns mic and silence`/`create builds a MicrophoneSource...`/`create builds a SilenceAudioSource...`/`create rejects an unknown device id` tests are untouched and keep passing unmodified, since `AudioSourceFactory()`'s no-arg form still defaults to `NoUsbInput`):
  ```kotlin
      @Test
      fun `list includes USB audio between mic and silence when a USB input device is present`() {
          val devices = AudioSourceFactory(audioInputDevices = { mockk<android.media.AudioDeviceInfo>(relaxed = true) }).list()

          assertEquals(3, devices.size)
          assertEquals("audio:mic", devices[0].id)
          assertEquals("audio:usb", devices[1].id)
          assertEquals(AudioDeviceKind.USB_AUDIO, devices[1].kind)
          assertEquals("audio:silence", devices[2].id)
      }

      @Test
      fun `create builds a UsbAudioSource for audio-usb`() {
          val source = AudioSourceFactory(audioInputDevices = { mockk<android.media.AudioDeviceInfo>(relaxed = true) }).create("audio:usb")

          assertTrue(source is UsbAudioSource)
      }
  ```
  Add `import io.mockk.mockk` to that file's imports if not already present. The lambda `{ mockk<android.media.AudioDeviceInfo>(relaxed = true) }` is a SAM conversion satisfying Step 3's `fun interface AudioInputDevices { fun usbInputDevice(): AudioDeviceInfo? }` — no further change needed once Step 3 lands.

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.UsbAudioFramingTest' --tests 'io.waddlebot.gazer.pipeline.sources.AudioSourceFactoryTest'"`
  Expected: compile errors — `unresolved reference: UsbAudioFraming`, `AudioSourceFactory` has no `audioInputDevices` parameter, `unresolved reference: UsbAudioSource`.

- [ ] **Step 3: Implement.**

  `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/AudioSourceFactory.kt` (full replacement):
  ```kotlin
  package io.waddlebot.gazer.pipeline.sources

  import android.media.AudioDeviceInfo
  import android.media.AudioFormat
  import android.media.AudioManager
  import android.media.AudioRecord
  import android.media.MediaRecorder
  import com.pedro.encoder.Frame
  import com.pedro.encoder.input.audio.GetMicrophoneData
  import com.pedro.encoder.input.sources.audio.AudioSource
  import com.pedro.encoder.input.sources.audio.MicrophoneSource
  import io.waddlebot.gazer.pigeon.AudioDevice
  import io.waddlebot.gazer.pigeon.AudioDeviceKind
  import java.util.concurrent.atomic.AtomicBoolean

  /** Thin seam over [AudioManager] so tests never need a real one. */
  fun interface AudioInputDevices {
      /** The attached USB audio input device, if any exposes one right now. */
      fun usbInputDevice(): AudioDeviceInfo?
  }

  /** Default [AudioInputDevices]: reports no USB input ever — every M1 `AudioSourceFactory()` call site keeps working unchanged. */
  object NoUsbInput : AudioInputDevices {
      override fun usbInputDevice(): AudioDeviceInfo? = null
  }

  /** Production [AudioInputDevices] backed by the real [AudioManager]. */
  class AndroidAudioInputDevices(
      private val audioManager: AudioManager,
  ) : AudioInputDevices {
      override fun usbInputDevice(): AudioDeviceInfo? =
          audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull {
              it.type == AudioDeviceInfo.TYPE_USB_DEVICE || it.type == AudioDeviceInfo.TYPE_USB_HEADSET
          }
  }

  /** Pure PCM16 chunk-size arithmetic, extracted out of [UsbAudioSource] so it is unit-testable without a real `AudioRecord`. */
  object UsbAudioFraming {
      /** Bytes in one [chunkMillis] chunk of PCM16 audio at [sampleRate]/[channels]; never zero. */
      fun chunkByteSize(
          sampleRate: Int,
          channels: Int,
          chunkMillis: Long = 20L,
      ): Int {
          val samplesPerChunk = (sampleRate * chunkMillis / 1000L).toInt().coerceAtLeast(1)
          return samplesPerChunk * channels * 2 // PCM16 = 2 bytes/sample
      }
  }

  /**
   * Lists and creates RootEncoder [AudioSource]s: phone mic, USB audio (M2, when the OS reports a
   * USB input device), or synthesized silence.
   */
  class AudioSourceFactory(
      private val audioInputDevices: AudioInputDevices = NoUsbInput,
  ) {
      /** Lists mic, USB audio (if present), then silence — always in that order. */
      fun list(): List<AudioDevice> {
          val devices = mutableListOf(AudioDevice(id = "audio:mic", kind = AudioDeviceKind.MIC, name = "Phone microphone"))
          if (audioInputDevices.usbInputDevice() != null) {
              devices.add(AudioDevice(id = "audio:usb", kind = AudioDeviceKind.USB_AUDIO, name = "USB audio"))
          }
          devices.add(AudioDevice(id = "audio:silence", kind = AudioDeviceKind.SILENCE, name = "Silence"))
          return devices
      }

      /** Builds the [AudioSource] for [deviceId]. */
      fun create(deviceId: String): AudioSource =
          when (deviceId) {
              "audio:mic" -> MicrophoneSource()
              "audio:usb" -> UsbAudioSource(audioInputDevices.usbInputDevice())
              "audio:silence" -> SilenceAudioSource()
              else -> throw IllegalArgumentException("Unknown audio device id: $deviceId")
          }
  }

  /**
   * [AudioSource] capturing from a USB Audio Class input via [AudioRecord.setPreferredDevice] —
   * spec: "AudioRecord.setPreferredDevice(TYPE_USB_DEVICE/TYPE_USB_HEADSET), 48 kHz PCM16, custom
   * AudioSource via GetMicrophoneData.inputPCMData(Frame)". [preferredDevice] is resolved once, at
   * `AudioSourceFactory.create` time; if it is null (the device was unplugged between `list()` and
   * `create()`, or `AudioSourceFactory`'s default `NoUsbInput` seam is in use) capture proceeds on
   * whatever the OS routes by default rather than failing outright — the failure that actually
   * matters (no usable audio device at all) already surfaces via `create()`'s own return value
   * below.
   *
   * Cannot run on the JVM unit-test target: `AudioRecord.Builder().build()` requires a real audio
   * HAL. Narrowly JaCoCo-excluded (this task's `build.gradle.kts` change), same precedent as
   * `RootEncoderEngine` (M1) — its buffer-size arithmetic is `UsbAudioFraming`, tested separately;
   * its actual capture behaviour is manual-only (README device checklist, Task 16), since CI's
   * emulator has no attachable USB audio device.
   */
  class UsbAudioSource(
      private val preferredDevice: AudioDeviceInfo?,
  ) : AudioSource() {
      private companion object {
          const val CHUNK_MILLIS = 20L
      }

      private var audioRecord: AudioRecord? = null
      private val running = AtomicBoolean(false)
      private var thread: Thread? = null
      private var configuredSampleRate = 0
      private var configuredChannels = 0

      override fun create(
          sampleRate: Int,
          isStereo: Boolean,
          echoCanceler: Boolean,
          noiseSuppressor: Boolean,
      ): Boolean {
          configuredSampleRate = sampleRate
          configuredChannels = if (isStereo) 2 else 1
          val channelConfig = if (isStereo) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO
          val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, AudioFormat.ENCODING_PCM_16BIT)
          if (minBufferSize <= 0) return false
          val record =
              try {
                  AudioRecord.Builder()
                      .setAudioSource(MediaRecorder.AudioSource.DEFAULT)
                      .setAudioFormat(
                          AudioFormat.Builder()
                              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                              .setSampleRate(sampleRate)
                              .setChannelMask(channelConfig)
                              .build(),
                      )
                      .setBufferSizeInBytes(minBufferSize * 2)
                      .build()
              } catch (_: Exception) {
                  return false
              }
          if (record.state != AudioRecord.STATE_INITIALIZED) {
              record.release()
              return false
          }
          preferredDevice?.let { record.preferredDevice = it }
          audioRecord = record
          return true
      }

      override fun start(getMicrophoneData: GetMicrophoneData) {
          this.getMicrophoneData = getMicrophoneData
          val record = audioRecord ?: return
          if (isRunning()) return
          running.set(true)
          record.startRecording()
          val bufferSize = UsbAudioFraming.chunkByteSize(configuredSampleRate, configuredChannels, CHUNK_MILLIS)
          val sink = getMicrophoneData
          thread =
              Thread({
                  val buffer = ByteArray(bufferSize)
                  while (running.get()) {
                      val read = record.read(buffer, 0, buffer.size)
                      if (read > 0) {
                          sink.inputPCMData(Frame(buffer, 0, read, System.nanoTime() / 1000))
                      }
                  }
              }, "gazer-usb-audio").apply {
                  isDaemon = true
                  start()
              }
      }

      override fun stop() {
          running.set(false)
          thread?.join(CHUNK_MILLIS * 4)
          thread = null
          audioRecord?.stop()
      }

      override fun isRunning(): Boolean = running.get()

      override fun release() {
          audioRecord?.release()
          audioRecord = null
      }
  }
  ```

- [ ] **Step 4: Add the narrow JaCoCo exclusion.**

  In `<app>/android/app/build.gradle.kts`, add `"**/pipeline/sources/UsbAudioSource.class"` to the `fileFilter` list, immediately after the existing `"**/pipeline/RootEncoderEngine.class"` entry, with a comment matching that entry's style:
  ```kotlin
              "**/pipeline/RootEncoderEngine.class",
              // Why (Task 7): UsbAudioSource.create()/start() call real AudioRecord.Builder().build()
              // and AudioRecord.startRecording(), which need a real audio HAL and NPE/fail on the
              // JVM unit-test target the same way RootEncoderEngine's Camera2/MediaCodec calls do
              // (see that entry above). Its buffer-size arithmetic is extracted into UsbAudioFraming
              // (fully unit-tested, UsbAudioFramingTest) precisely so this exclusion covers only the
              // genuinely Android-bound I/O, not the whole class's logic. Real capture behaviour is
              // manual-only (README device checklist) — no CI emulator can attach a USB audio device.
              "**/pipeline/sources/UsbAudioSource.class",
  ```

- [ ] **Step 5: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.pipeline.sources.UsbAudioFramingTest' --tests 'io.waddlebot.gazer.pipeline.sources.AudioSourceFactoryTest'"`
  Expected: `4 tests completed` (UsbAudioFramingTest) `+ 6 tests completed` (AudioSourceFactoryTest: 4 pre-existing + 2 new), 0 failed.

- [ ] **Step 6: Run the full Kotlin coverage gate (confirms the exclusion is scoped correctly).**
  `make mobile-test-android`
  Expected: `BUILD SUCCESSFUL`, JaCoCo ≥90%.

- [ ] **Step 7: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 8: Commit.**
  ```bash
  git add <app>/android/app/src/main/kotlin/io/waddlebot/gazer/pipeline/sources/AudioSourceFactory.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/AudioSourceFactoryTest.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/pipeline/sources/UsbAudioFramingTest.kt \
          <app>/android/app/build.gradle.kts
  git commit -m "$(cat <<'EOF'
  feat(gazer): USB Audio Class input via AudioRecord.setPreferredDevice

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 8: GazerFlutterBindings — wire UVC video/audio, USB permission, and hot-plug together

**Depends on:** Task 3 (`VideoSourceFactory`/`UsbCaptureDeviceNames`), Task 5 (`UsbPermissionCoordinator`), Task 6 (`UsbHotplugController`), Task 7 (`AudioSourceFactory`/`AndroidAudioInputDevices`).

**Files:**
- Modify: `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/GazerFlutterBindings.kt`
- Modify, Test: `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/GazerFlutterBindingsTest.kt`

**Interfaces:** none new — this task only assembles Tasks 3/5/6/7's real classes into `install()`/`uninstall()`, closing the "intentionally left broken" gap Task 5 Step 8 called out.

- [ ] **Step 1: Update the failing/incomplete existing tests first.**

  In `<app>/android/app/src/test/kotlin/io/waddlebot/gazer/GazerFlutterBindingsTest.kt`, add `import android.hardware.usb.UsbManager` and `import android.media.AudioManager`, and add these two lines to **both** existing test functions, immediately after the `every { context.getSystemService(Context.CAMERA_SERVICE) } returns cameraManager` line:
  ```kotlin
          every { context.getSystemService(Context.USB_SERVICE) } returns mockk<UsbManager>(relaxed = true)
          every { context.getSystemService(Context.AUDIO_SERVICE) } returns mockk<AudioManager>(relaxed = true)
  ```
  Then add this new test to the end of the class body (before the closing `}`):
  ```kotlin
      @Test
      fun `uninstall stops the hot-plug controller`() {
          val messenger = mockk<BinaryMessenger>(relaxed = true)
          val dartExecutor = mockk<DartExecutor>(relaxed = true)
          every { dartExecutor.binaryMessenger } returns messenger
          val flutterEngine = mockk<FlutterEngine>(relaxed = true)
          every { flutterEngine.dartExecutor } returns dartExecutor
          val context = mockk<Context>(relaxed = true)
          every { context.getSystemService(Context.CAMERA_SERVICE) } returns mockk<android.hardware.camera2.CameraManager>(relaxed = true)
          every { context.getSystemService(Context.USB_SERVICE) } returns mockk<UsbManager>(relaxed = true)
          every { context.getSystemService(Context.AUDIO_SERVICE) } returns mockk<AudioManager>(relaxed = true)
          GazerFlutterBindings.install(flutterEngine, context)

          GazerFlutterBindings.uninstall(flutterEngine)

          // registerReceiver is called once by install() (the hot-plug controller's start()); a
          // matching unregisterReceiver from uninstall()'s stop() proves the receiver's lifetime is
          // bounded to the engine attach/detach, not leaked for the life of the process.
          verify { context.unregisterReceiver(any()) }
      }
  ```

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.GazerFlutterBindingsTest'"`
  Expected: the two pre-existing tests still pass (the added `every` lines are additive), but `` `uninstall stops the hot-plug controller` `` fails — `context.unregisterReceiver` is never called, since `install()` does not build a `UsbHotplugController` yet.

- [ ] **Step 3: Implement — rewrite GazerFlutterBindings.kt.**

  `<app>/android/app/src/main/kotlin/io/waddlebot/gazer/GazerFlutterBindings.kt` (full replacement):
  ```kotlin
  package io.waddlebot.gazer

  import android.content.Context
  import android.hardware.camera2.CameraManager
  import android.hardware.usb.UsbManager
  import android.media.AudioManager
  import android.os.Handler
  import android.os.Looper
  import io.flutter.embedding.engine.FlutterEngine
  import io.waddlebot.gazer.pigeon.GazerFlutterApi
  import io.waddlebot.gazer.pigeon.GazerHostApi
  import io.waddlebot.gazer.pipeline.sources.AndroidAudioInputDevices
  import io.waddlebot.gazer.pipeline.sources.AndroidUsbDevicesGateway
  import io.waddlebot.gazer.pipeline.sources.AudioSourceFactory
  import io.waddlebot.gazer.pipeline.sources.CameraManagerIds
  import io.waddlebot.gazer.pipeline.sources.ContextReceiverRegistrar
  import io.waddlebot.gazer.pipeline.sources.UsbCaptureDeviceNames
  import io.waddlebot.gazer.pipeline.sources.UsbHotplugController
  import io.waddlebot.gazer.pipeline.sources.UsbManagerDeviceLister
  import io.waddlebot.gazer.pipeline.sources.UsbPermissionCoordinator
  import io.waddlebot.gazer.pipeline.sources.VideoSourceFactory
  import kotlinx.coroutines.CoroutineScope
  import kotlinx.coroutines.Dispatchers
  import kotlinx.coroutines.cancel
  import kotlinx.coroutines.launch

  /**
   * Builds a PigeonHostApiImpl for [flutterEngine]'s Dart<->platform channel and registers it as
   * the GazerHostApi, and (M2) builds + starts the UsbHotplugController that forwards hot-plug
   * events to Dart. Extracted out of MainActivity (controller ruling R11) so this wiring is
   * covered by a plain JVM unit test — MainActivity itself needs Robolectric/instrumentation to
   * construct and is excluded from JaCoCo (see app/build.gradle.kts).
   */
  object GazerFlutterBindings {
      /** The PigeonHostApiImpl installed for the currently-attached engine, if any - retained so [uninstall] can dispose it. */
      private var activeImpl: PigeonHostApiImpl? = null

      /** The hot-plug controller started by [install], if any - retained so [uninstall] can stop it. */
      private var activeHotplug: UsbHotplugController? = null

      /** Scope for forwarding UsbHotplugController's callbacks into GazerFlutterApi's suspend methods; cancelled in [uninstall]. */
      private var hotplugScope: CoroutineScope? = null

      /** Wires PigeonHostApiImpl and the USB hot-plug controller into [flutterEngine] for [context]; safe to call once per engine attach. */
      fun install(
          flutterEngine: FlutterEngine,
          context: Context,
      ) {
          val messenger = flutterEngine.dartExecutor.binaryMessenger
          val flutterApi = GazerFlutterApi(messenger)
          val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
          val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
          val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

          val captureDeviceNames = UsbCaptureDeviceNames(UsbManagerDeviceLister(usbManager))
          val videoSourceFactory = VideoSourceFactory(context, CameraManagerIds(cameraManager), captureDeviceNames)
          val audioSourceFactory = AudioSourceFactory(AndroidAudioInputDevices(audioManager))
          val receiverRegistrar = ContextReceiverRegistrar(context)
          val usbPermission =
              UsbPermissionCoordinator(
                  gateway = AndroidUsbDevicesGateway(usbManager, captureDeviceNames),
                  buildPendingIntent = {
                      android.app.PendingIntent.getBroadcast(
                          context,
                          0,
                          android.content.Intent(UsbPermissionCoordinator.ACTION_USB_PERMISSION),
                          android.app.PendingIntent.FLAG_IMMUTABLE,
                      )
                  },
                  registerReceiver = receiverRegistrar::register,
                  unregisterReceiver = receiverRegistrar::unregister,
              )

          val impl =
              PigeonHostApiImpl(
                  context = context,
                  flutterApi = flutterApi,
                  videoDevices = { videoSourceFactory.list() },
                  audioDevices = { audioSourceFactory.list() },
                  usbPermission = usbPermission,
              )
          activeImpl = impl
          GazerHostApi.setUp(messenger, impl)

          val scope = CoroutineScope(Dispatchers.Main.immediate)
          hotplugScope = scope
          val mainHandler = Handler(Looper.getMainLooper())
          val hotplug =
              UsbHotplugController(
                  registrar = receiverRegistrar,
                  listVideoDevices = { videoSourceFactory.list() },
                  pipeline = { impl.host?.pipeline() },
                  onAttached = { device -> scope.launch { flutterApi.onUsbAttached(device) } },
                  onDetached = { deviceId -> scope.launch { flutterApi.onUsbDetached(deviceId) } },
                  postDelayed = { delayMs, action -> mainHandler.postDelayed(action, delayMs) },
              )
          hotplug.start()
          activeHotplug = hotplug
      }

      /**
       * Detaches GazerHostApi from [flutterEngine]'s channel, stops the hot-plug controller, and
       * disposes the PigeonHostApiImpl installed by [install]. Call from
       * MainActivity.cleanUpFlutterEngine so a torn-down engine's messenger is never used again by
       * a stray callback.
       */
      fun uninstall(flutterEngine: FlutterEngine) {
          val messenger = flutterEngine.dartExecutor.binaryMessenger
          GazerHostApi.setUp(messenger, null)
          activeHotplug?.stop()
          activeHotplug = null
          hotplugScope?.cancel()
          hotplugScope = null
          activeImpl?.dispose()
          activeImpl = null
      }
  }
  ```

- [ ] **Step 4: Run — expected PASS.**
  `make mobile-run CMD="./gradlew :app:testDebugUnitTest --tests 'io.waddlebot.gazer.GazerFlutterBindingsTest'"`
  Expected: `3 tests completed, 0 failed`.

- [ ] **Step 5: Run the full Kotlin suite + coverage gate — this is the first point Tasks 3/5/6/7 actually link together.**
  `make mobile-test-android`
  Expected: `BUILD SUCCESSFUL`, JaCoCo ≥90%. If this fails to *compile* (not just fails a test), the most likely cause is a leftover Task 5 Step 8 gap — re-check `PigeonHostApiImpl`'s constructor call here passes `usbPermission` — or a stale `VideoSourceFactory`/`AudioSourceFactory` call site elsewhere still using the old constructor arity; `grep -rn "VideoSourceFactory(" <app>/android/app/src/main/kotlin` and `grep -rn "AudioSourceFactory(" <app>/android/app/src/main/kotlin` to confirm this file is the only production call site for each.

- [ ] **Step 6: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 7: Commit.**
  ```bash
  git add <app>/android/app/src/main/kotlin/io/waddlebot/gazer/GazerFlutterBindings.kt \
          <app>/android/app/src/test/kotlin/io/waddlebot/gazer/GazerFlutterBindingsTest.kt
  git commit -m "$(cat <<'EOF'
  feat(gazer): wire UVC video/audio factories, USB permission, and hot-plug into GazerFlutterBindings

  Closes the gap Task 5 left open: PigeonHostApiImpl now receives a real
  UsbPermissionCoordinator, VideoSourceFactory/AudioSourceFactory are
  built with their M2 UVC/USB-audio-aware constructors, and a
  UsbHotplugController is started alongside the engine attach and
  stopped on detach.

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 9: Instrumented test — hot-plug receiver lifecycle on the emulator

**Depends on:** Task 8.

**Files:**
- Create: `<app>/android/app/src/androidTest/kotlin/io/waddlebot/gazer/UsbHotplugInstrumentedTest.kt`

**Interfaces:** none new — this task adds test-only code.

**What this test CAN verify on the emulator, and what it explicitly CANNOT (per this plan's brief):**
- **CAN**: `ContextReceiverRegistrar.register`/`unregister` against a real `Context` do not throw (the Android 13+ `RECEIVER_NOT_EXPORTED` flag path is real API surface, not mocked); a `UsbHotplugController` built with the emulator's real `CameraManager`/`UsbManager` starts and stops cleanly; the emulator's `CameraManager.cameraIdList` genuinely reports zero `LENS_FACING_EXTERNAL` cameras (documents, rather than assumes, that `hw.camera.back=webcam0` is a regular back-camera emulation, not a Camera2-external/UVC device — confirming `VideoSourceFactory.list()` returns no UVC entry on this hardware, exactly the "no crash, just nothing to show" behaviour M2 requires); `GazerFlutterBindings.install`/`uninstall` against a real `MainActivity` do not crash now that `USB_SERVICE`/`AUDIO_SERVICE` are resolved in addition to `CAMERA_SERVICE`.
- **CANNOT** (manual-only — see Task 16's device checklist): a real UVC device attach/detach broadcast (no USB device can be attached to CI's emulator or to most local emulators); the real `UsbManager.requestPermission` system dialog and its result broadcast (needs a physical device with a UVC device attached); `Camera2Source.openCameraId` actually opening an external camera (no such camera exists on any emulator); real Camera2 stream-configuration negotiation against a UVC device's actual advertised modes; real USB Audio Class capture via `AudioRecord.setPreferredDevice`.

- [ ] **Step 1: Write the test.**

  `<app>/android/app/src/androidTest/kotlin/io/waddlebot/gazer/UsbHotplugInstrumentedTest.kt`:
  ```kotlin
  package io.waddlebot.gazer

  import android.content.Context
  import android.hardware.camera2.CameraCharacteristics
  import android.hardware.camera2.CameraManager
  import androidx.test.core.app.ApplicationProvider
  import androidx.test.ext.junit.runners.AndroidJUnit4
  import io.waddlebot.gazer.pipeline.sources.CameraManagerIds
  import io.waddlebot.gazer.pipeline.sources.ContextReceiverRegistrar
  import io.waddlebot.gazer.pipeline.sources.UsbHotplugController
  import org.junit.Assert.assertEquals
  import org.junit.Assert.assertNull
  import org.junit.Assert.assertTrue
  import org.junit.Test
  import org.junit.runner.RunWith

  /**
   * Instrumented coverage for what a JVM unit test structurally cannot exercise: real
   * Context.registerReceiver/unregisterReceiver, and the emulator's real CameraManager. See the
   * Task 9 brief for the explicit list of what this test can and cannot verify — a real UVC
   * device, its permission dialog, and openCameraId cannot be exercised on any emulator.
   */
  @RunWith(AndroidJUnit4::class)
  class UsbHotplugInstrumentedTest {
      private val context: Context = ApplicationProvider.getApplicationContext()

      @Test
      fun `UsbHotplugController starts and stops against a real Context without throwing`() {
          val controller =
              UsbHotplugController(
                  registrar = ContextReceiverRegistrar(context),
                  listVideoDevices = { emptyList() },
                  pipeline = { null },
                  onAttached = {},
                  onDetached = {},
                  postDelayed = { _, action -> action() },
              )

          controller.start()
          controller.stop()
          // No assertion beyond "did not throw" -- registerReceiver/unregisterReceiver against a
          // real Context are exactly the two calls a JVM unit test cannot make (see
          // UsbHotplugControllerTest, which fakes ReceiverRegistrar for everything else).
      }

      @Test
      fun `the emulator's CameraManager reports no LENS_FACING_EXTERNAL camera`() {
          val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
          val ids = CameraManagerIds(cameraManager)

          val externalIds = ids.externalIds()

          // Documents, rather than assumes, the M2 spec's own caveat: hw.camera.back=webcam0 (or
          // any other emulator camera config) is not a Camera2-external/UVC device, so this list
          // is empty on every CI/local emulator -- VideoSourceFactory.list() therefore never
          // surfaces a UVC entry here, which is the correct "no capture card attached" behaviour,
          // not a bug this test is meant to catch.
          assertEquals(emptyList<String>(), externalIds)
      }

      @Test
      fun `VideoSourceFactory list against the real emulator camera set never includes a UVC device`() {
          val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
          val factory =
              io.waddlebot.gazer.pipeline.sources.VideoSourceFactory(
                  context,
                  CameraManagerIds(cameraManager),
                  io.waddlebot.gazer.pipeline.sources.UsbCaptureDeviceNames(
                      io.waddlebot.gazer.pipeline.sources.UsbManagerDeviceLister(
                          context.getSystemService(Context.USB_SERVICE) as android.hardware.usb.UsbManager,
                      ),
                  ),
              )

          val devices = factory.list()

          assertTrue(devices.none { it.kind == io.waddlebot.gazer.pigeon.VideoDeviceKind.UVC_CAMERA2 })
      }

      @Test
      fun `no USB capture device is matched on the emulator (no USB device can be attached to CI)`() {
          val names =
              io.waddlebot.gazer.pipeline.sources.UsbCaptureDeviceNames(
                  io.waddlebot.gazer.pipeline.sources.UsbManagerDeviceLister(
                      context.getSystemService(Context.USB_SERVICE) as android.hardware.usb.UsbManager,
                  ),
              )

          assertNull(names.primary())
      }
  }
  ```

- [ ] **Step 2: Run — expected FAIL until Task 8 lands (compile-time dependency), PASS once it has.**
  `make mobile-test-integration`
  Expected (after Task 8 is committed): `connectedDebugAndroidTest` `BUILD SUCCESSFUL`, all 4 new tests plus every pre-existing instrumented test pass; `CameraCharacteristics.LENS_FACING_EXTERNAL` never appears in the emulator's `externalIds()` result (confirms the "CANNOT verify a real card" limitation is accurately documented, not silently wrong).

- [ ] **Step 3: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 4: Commit.**
  ```bash
  git add <app>/android/app/src/androidTest/kotlin/io/waddlebot/gazer/UsbHotplugInstrumentedTest.kt
  git commit -m "$(cat <<'EOF'
  test(gazer): instrumented coverage for USB hot-plug receiver lifecycle and emulator camera set

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 10: Dart test helpers — FakeGazerHostApi grows UVC devices/events

**Depends on:** none (Dart track start; independent of the Kotlin track above — the Pigeon contract these tests exercise is unchanged, see Global Constraints).

**Files:**
- Modify: `<app>/test/helpers/fake_host_api.dart`

**Interfaces:**
- Produces (verbatim, Shared Contract): `FakeGazerHostApi` gains `bool requestUsbPermissionResult = true`; `Future<void> emitUsbAttached(VideoDevice device)`; `Future<void> emitUsbDetached(String deviceId)`.

This task has no independent test file of its own — `fake_host_api.dart` is itself test infrastructure, exercised by every later Dart task that uses it (Tasks 11–15). Its correctness is verified by writing one throwaway assertion inline in Step 1, run once, then deleted before commit (the pattern M1 used for infrastructure-only files with no natural "failing test" of their own, e.g. Task 6's `test/pigeon/pipeline_contract_test.dart`).

- [ ] **Step 1: Implement, with a throwaway verification test.**

  In `<app>/test/helpers/fake_host_api.dart`, change:
  ```dart
    @override
    Future<bool> requestUsbPermission(String deviceId) async {
      calls.add('requestUsbPermission($deviceId)');
      return false;
    }
  ```
  to:
  ```dart
    @override
    Future<bool> requestUsbPermission(String deviceId) async {
      calls.add('requestUsbPermission($deviceId)');
      return requestUsbPermissionResult;
    }
  ```

  Add the new field near `videoDevices`/`audioDevices`:
  ```dart
    /// Value [requestUsbPermission] returns; `true` by default so a widget test
    /// exercising a UVC Go Live flow does not have to opt in to the happy path.
    bool requestUsbPermissionResult = true;
  ```

  Add the two new emit helpers immediately after `emitStats`:
  ```dart
    /// Pushes a UVC device attach event into [bridge], then yields one
    /// microtask so listeners observe it before the caller continues.
    Future<void> emitUsbAttached(VideoDevice device) async {
      bridge.onUsbAttached(device);
      await Future<void>.delayed(Duration.zero);
    }

    /// Pushes a UVC device detach event into [bridge], then yields one
    /// microtask so listeners observe it before the caller continues.
    Future<void> emitUsbDetached(String deviceId) async {
      bridge.onUsbDetached(deviceId);
      await Future<void>.delayed(Duration.zero);
    }
  ```

  As a throwaway check (not committed), temporarily add to the bottom of any existing test file that already imports `fake_host_api.dart` (e.g. `<app>/test/services/pipeline_controller_test.dart`) a scratch test:
  ```dart
  test('SCRATCH -- delete before commit', () async {
    final fake = FakeGazerHostApi();
    fake.requestUsbPermissionResult = false;
    expect(await fake.requestUsbPermission('camera:uvc:2'), isFalse);
    final events = <VideoDevice>[];
    fake.bridge.usbAttached.listen(events.add);
    await fake.emitUsbAttached(
      VideoDevice(id: 'camera:uvc:2', kind: VideoDeviceKind.uvcCamera2, name: 'Test'),
    );
    expect(events, hasLength(1));
  });
  ```

- [ ] **Step 2: Run the scratch check.**
  `make mobile-run CMD="flutter test <path to the file you added the scratch test to>"`
  Expected: the scratch test passes. Delete the scratch test block immediately after confirming — it must not be committed.

- [ ] **Step 3: Run the full Dart suite (confirms nothing else broke).**
  `make mobile-test`
  Expected: `All tests passed!`, coverage gate ≥90% (unchanged from before this task — `fake_host_api.dart` is test infrastructure, excluded from the `lib/` coverage denominator already).

- [ ] **Step 4: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 5: Commit.**
  ```bash
  git add <app>/test/helpers/fake_host_api.dart
  git commit -m "$(cat <<'EOF'
  test(gazer): FakeGazerHostApi grows requestUsbPermissionResult and UVC attach/detach emit helpers

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 11: Hot-plug-aware devices providers + uvc_attach telemetry counter

**Depends on:** Task 10 (`FakeGazerHostApi.emitUsbAttached`/`emitUsbDetached`).

**Files:**
- Modify: `<app>/lib/providers/devices_provider.dart`
- Modify: `<app>/lib/providers/pipeline_provider.dart`
- Modify, Test: `<app>/test/providers/devices_provider_test.dart`

**Interfaces:**
- Produces (verbatim, Shared Contract): `@Riverpod(keepAlive: true) NativeEventBridge nativeEventBridge(Ref ref)` — lands in `devices_provider.dart` (not `pipeline_provider.dart`, which already imports `devices_provider.dart` one-way; this placement makes the "no circular import" goal automatic rather than requiring one). `videoDevicesProvider`/`audioDevicesProvider` both `ref.watch` it and invalidate themselves on `usbAttached`/`usbDetached`. `pipeline_provider.dart`'s `pipelineControllerProvider` is updated to consume the shared `nativeEventBridgeProvider` instead of constructing its own `NativeEventBridge()`.
- Consumes: `GazerFlutterApi`/`NativeEventBridge` (M1, unchanged); `GazerTelemetry.counter` (M1, unchanged signature).

**Why both providers listen to the same two streams:** the Pigeon contract has exactly one hot-plug event pair — `onUsbAttached(VideoDevice)`/`onUsbDetached(String)` — no separate audio-hotplug event exists (confirmed against `pigeons/pipeline.dart`, and this plan changes no Pigeon contract). In practice the devices this app's `usb_device_filter.xml` matches (UVC class, or the "generic UVC composite" class-239 entry) are exactly the capture cards that also expose USB Audio Class input, so one physical attach/detach is the right trigger to re-enumerate both lists.

- [ ] **Step 1: Write the failing tests.**

  Add these two tests to `<app>/test/providers/devices_provider_test.dart` (append to the existing `main()` body; the two pre-existing tests are untouched and keep passing):
  ```dart
  test(
    'videoDevicesProvider re-fetches when a UVC device attach event arrives',
    () async {
      final host = FakeGazerHostApi();
      // Override nativeEventBridgeProvider with the fake's own bridge, so emitUsbAttached
      // (which pushes into `host.bridge`) actually reaches the provider under test --
      // production wires GazerFlutterApi.setUp to the *same* bridge instance the provider
      // exposes; here the fake's bridge is that instance instead.
      final container = ProviderContainer(
        overrides: [
          gazerHostApiProvider.overrideWithValue(host),
          nativeEventBridgeProvider.overrideWithValue(host.bridge),
        ],
      );
      addTearDown(container.dispose);

      expect(await container.read(videoDevicesProvider.future), isEmpty);

      host.videoDevices = [
        VideoDevice(id: 'camera:uvc:2', kind: VideoDeviceKind.uvcCamera2, name: 'USB capture card'),
      ];
      await host.emitUsbAttached(host.videoDevices.single);

      final refreshed = await container.read(videoDevicesProvider.future);
      expect(refreshed, hasLength(1));
      expect(refreshed.single.id, 'camera:uvc:2');
    },
  );

  test(
    'audioDevicesProvider re-fetches when a UVC device detach event arrives',
    () async {
      final host = FakeGazerHostApi();
      host.audioDevices = [
        AudioDevice(id: 'audio:usb', kind: AudioDeviceKind.usbAudio, name: 'USB audio'),
      ];
      final container = ProviderContainer(
        overrides: [
          gazerHostApiProvider.overrideWithValue(host),
          nativeEventBridgeProvider.overrideWithValue(host.bridge),
        ],
      );
      addTearDown(container.dispose);

      expect(await container.read(audioDevicesProvider.future), hasLength(1));

      host.audioDevices = [];
      await host.emitUsbDetached('camera:uvc:2');

      expect(await container.read(audioDevicesProvider.future), isEmpty);
    },
  );
  ```
  Add `import 'package:gazer/pigeon/pipeline.g.dart';` to the file's imports.

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="flutter test test/providers/devices_provider_test.dart"`
  Expected: compile error — `unresolved` / `nativeEventBridgeProvider` is not defined.

- [ ] **Step 3: Implement.**

  `<app>/lib/providers/devices_provider.dart` (full replacement):
  ```dart
  import 'package:riverpod_annotation/riverpod_annotation.dart';

  import '../pigeon/pipeline.g.dart';
  import '../services/native_event_bridge.dart';
  import '../telemetry/gazer_telemetry.dart';

  part 'devices_provider.g.dart';

  /// The [GazerHostApi] the app talks to; overridden in tests with
  /// `FakeGazerHostApi` so no real Pigeon channel is ever touched.
  @Riverpod(keepAlive: true)
  GazerHostApi gazerHostApi(Ref ref) => GazerHostApi();

  /// The single [NativeEventBridge] instance shared by [pipelineControllerProvider]
  /// (`pipeline_provider.dart`, which registers it against the real Pigeon
  /// `GazerFlutterApi` channel — unchanged from M1 other than sourcing the
  /// bridge from here) and by [videoDevices]/[audioDevices] below, so a
  /// hot-plug event pushed on the one real bridge instance reaches every
  /// provider that needs it. Deliberately does NOT call `GazerFlutterApi.setUp`
  /// itself: that registration stays solely in `pipelineControllerProvider`,
  /// exactly where M1 already puts it — every other provider only ever reads
  /// events off the bridge, never registers/unregisters the platform channel,
  /// so resolving `videoDevicesProvider`/`audioDevicesProvider` alone (as
  /// `devices_provider_test.dart`'s plain, non-widget `test()` blocks already
  /// do) never touches the real channel.
  @Riverpod(keepAlive: true)
  NativeEventBridge nativeEventBridge(Ref ref) {
    final bridge = NativeEventBridge();
    ref.onDispose(bridge.dispose);
    return bridge;
  }

  /// Enumerable video sources: M1's back/front camera, plus M2's UVC-via-Camera2
  /// devices. Re-fetches on every `onUsbAttached`/`onUsbDetached` event (M1 had
  /// no hot-plug refresh at all — the list was read once per provider build).
  @riverpod
  Future<List<VideoDevice>> videoDevices(Ref ref) async {
    final host = ref.watch(gazerHostApiProvider);
    final bridge = ref.watch(nativeEventBridgeProvider);
    final attachSub = bridge.usbAttached.listen((VideoDevice device) {
      GazerTelemetry.counter('gazer.uvc.attach');
      ref.invalidateSelf();
    });
    final detachSub = bridge.usbDetached.listen((_) => ref.invalidateSelf());
    ref.onDispose(() {
      attachSub.cancel();
      detachSub.cancel();
    });
    return host.listVideoDevices();
  }

  /// Enumerable audio sources: M1's mic + silence, plus M2's USB audio (when a
  /// capture card exposing USB Audio Class is attached). Re-fetches on the same
  /// two hot-plug events as [videoDevices] — see the Task 11 brief for why one
  /// physical attach/detach drives both lists.
  @riverpod
  Future<List<AudioDevice>> audioDevices(Ref ref) async {
    final host = ref.watch(gazerHostApiProvider);
    final bridge = ref.watch(nativeEventBridgeProvider);
    final attachSub = bridge.usbAttached.listen((_) => ref.invalidateSelf());
    final detachSub = bridge.usbDetached.listen((_) => ref.invalidateSelf());
    ref.onDispose(() {
      attachSub.cancel();
      detachSub.cancel();
    });
    return host.listAudioDevices();
  }
  ```

  In `<app>/lib/providers/pipeline_provider.dart`, replace:
  ```dart
  @Riverpod(keepAlive: true)
  PipelineController pipelineController(Ref ref) {
    final events = NativeEventBridge();
    GazerFlutterApi.setUp(events);
    final controller = PipelineController(
      host: ref.watch(gazerHostApiProvider),
      events: events,
      policy: ReconnectPolicy(),
    );
    ref.onDispose(() {
      GazerFlutterApi.setUp(null);
      controller.dispose();
      events.dispose();
    });
    return controller;
  }
  ```
  with:
  ```dart
  @Riverpod(keepAlive: true)
  PipelineController pipelineController(Ref ref) {
    final events = ref.watch(nativeEventBridgeProvider);
    GazerFlutterApi.setUp(events);
    final controller = PipelineController(
      host: ref.watch(gazerHostApiProvider),
      events: events,
      policy: ReconnectPolicy(),
    );
    ref.onDispose(() {
      GazerFlutterApi.setUp(null);
      controller.dispose();
    });
    return controller;
  }
  ```
  The only change from M1: `events` now comes from the shared `nativeEventBridgeProvider` instead of a private `NativeEventBridge()` this provider constructed itself, and disposal of the bridge itself moves to `nativeEventBridgeProvider`'s own `ref.onDispose` (Task 11) — `GazerFlutterApi.setUp`'s registration/teardown call sites, and everything reachable from `PipelineController.dispose()`, are byte-for-byte unchanged from M1. This is a deliberate, minimal ownership move: every existing test overrides `pipelineControllerProvider` directly (never lets this build function run), so this risk profile is identical to M1's already-shipped code — see the `nativeEventBridgeProvider` doc comment above for why `videoDevicesProvider`/`audioDevicesProvider` resolving on their own, without `pipelineControllerProvider`, must never trigger this registration.

- [ ] **Step 4: Regenerate Riverpod code.**
  `make mobile-codegen`
  Expected: `<app>/lib/providers/devices_provider.g.dart` and `<app>/lib/providers/pipeline_provider.g.dart` regenerate with `nativeEventBridgeProvider` added and `pipelineControllerProvider` unchanged in shape.

- [ ] **Step 5: Run — expected PASS.**
  `make mobile-run CMD="flutter test test/providers/devices_provider_test.dart test/providers/pipeline_provider_test.dart"`
  Expected: `All tests passed!`.

- [ ] **Step 6: Run the full Dart suite + coverage gate.**
  `make mobile-test`
  Expected: `All tests passed!`, lcov ≥90%.

- [ ] **Step 7: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 8: Commit.**
  ```bash
  git add <app>/lib/providers/devices_provider.dart \
          <app>/lib/providers/devices_provider.g.dart \
          <app>/lib/providers/pipeline_provider.dart \
          <app>/lib/providers/pipeline_provider.g.dart \
          <app>/test/providers/devices_provider_test.dart
  git commit -m "$(cat <<'EOF'
  feat(gazer): hot-plug-aware video/audio device providers + gazer.uvc.attach counter

  Factors NativeEventBridge construction/registration out into a shared
  nativeEventBridgeProvider so videoDevicesProvider/audioDevicesProvider
  can both re-fetch on onUsbAttached/onUsbDetached; pipelineControllerProvider
  now consumes the same shared bridge instead of constructing its own.

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 12: AudioSourceSelector — audio-follows-video-source policy

**Depends on:** Task 10 (test helpers — used by the `PipelineController` tests this task adds).

**Files:**
- Create: `<app>/lib/services/audio_source_selector.dart`
- Create, Test: `<app>/test/services/audio_source_selector_test.dart`
- Modify: `<app>/lib/services/pipeline_controller.dart`
- Modify, Test: `<app>/test/services/pipeline_controller_test.dart`

**Interfaces:**
- Produces (verbatim, Shared Contract): `class AudioSourceSelector { const AudioSourceSelector(); String deviceIdFor({required AudioSourceChoice choice, required VideoDeviceKind? selectedVideoKind, required List<AudioDevice> audioDevices}); }`.
- `PipelineController.goLive` gains the optional `audioDevices` param (see Shared Contract) and drops the M1 `_audioDeviceIdFor` stub in favor of `AudioSourceSelector`; `_emit`'s existing `gazer.pipeline.state_change` counter call gains a `videoSource` attribute (the selected device's `VideoDeviceKind.name`, e.g. `"backCamera"`/`"uvcCamera2"`) whenever a session is active.

- [ ] **Step 1: Write the failing AudioSourceSelector test.**

  `<app>/test/services/audio_source_selector_test.dart`:
  ```dart
  import 'package:flutter_test/flutter_test.dart';
  import 'package:gazer/models/gazer_settings.dart';
  import 'package:gazer/pigeon/pipeline.g.dart';
  import 'package:gazer/services/audio_source_selector.dart';

  void main() {
    const selector = AudioSourceSelector();
    // Not `const`: the Pigeon-generated AudioDevice class has a plain
    // (non-const) constructor and mutable fields, so neither this instance
    // nor a list literal containing it can be `const`.
    final usbAudioDevice = AudioDevice(
      id: 'audio:usb',
      kind: AudioDeviceKind.usbAudio,
      name: 'USB audio',
    );

    group('AudioSourceSelector.deviceIdFor (table-driven)', () {
      final cases =
          <
            String,
            ({
              AudioSourceChoice choice,
              VideoDeviceKind? videoKind,
              List<AudioDevice> audioDevices,
              String expected,
            })
          >{
            'silence always wins regardless of video source or USB audio presence': (
              choice: AudioSourceChoice.silence,
              videoKind: VideoDeviceKind.uvcCamera2,
              audioDevices: [usbAudioDevice],
              expected: 'audio:silence',
            ),
            'mic is explicit even when USB audio is present': (
              choice: AudioSourceChoice.mic,
              videoKind: VideoDeviceKind.uvcCamera2,
              audioDevices: [usbAudioDevice],
              expected: 'audio:mic',
            ),
            'explicit usbAudio resolves to audio:usb when present': (
              choice: AudioSourceChoice.usbAudio,
              videoKind: VideoDeviceKind.backCamera,
              audioDevices: [usbAudioDevice],
              expected: 'audio:usb',
            ),
            'explicit usbAudio falls back to mic when absent': (
              choice: AudioSourceChoice.usbAudio,
              videoKind: VideoDeviceKind.backCamera,
              audioDevices: [],
              expected: 'audio:mic',
            ),
            'auto with a phone camera selected follows to mic': (
              choice: AudioSourceChoice.auto,
              videoKind: VideoDeviceKind.backCamera,
              audioDevices: [usbAudioDevice],
              expected: 'audio:mic',
            ),
            'auto with a UVC camera selected and USB audio present follows to USB audio': (
              choice: AudioSourceChoice.auto,
              videoKind: VideoDeviceKind.uvcCamera2,
              audioDevices: [usbAudioDevice],
              expected: 'audio:usb',
            ),
            'auto with a UVC camera selected but no USB audio falls back to mic': (
              choice: AudioSourceChoice.auto,
              videoKind: VideoDeviceKind.uvcCamera2,
              audioDevices: [],
              expected: 'audio:mic',
            ),
            'auto with no video device selected yet defaults to mic': (
              choice: AudioSourceChoice.auto,
              videoKind: null,
              audioDevices: [usbAudioDevice],
              expected: 'audio:mic',
            ),
          };

      cases.forEach((description, testCase) {
        test(description, () {
          final result = selector.deviceIdFor(
            choice: testCase.choice,
            selectedVideoKind: testCase.videoKind,
            audioDevices: testCase.audioDevices,
          );
          expect(result, testCase.expected);
        });
      });
    });
  }
  ```

- [ ] **Step 2: Run and confirm failure.**
  `make mobile-run CMD="flutter test test/services/audio_source_selector_test.dart"`
  Expected FAIL: `Error: Error when reading 'lib/services/audio_source_selector.dart': No such file or directory`.

- [ ] **Step 3: Implement `audio_source_selector.dart`.**

  `<app>/lib/services/audio_source_selector.dart`:
  ```dart
  import '../models/gazer_settings.dart';
  import '../pigeon/pipeline.g.dart';

  /// Resolves the user's [AudioSourceChoice] to the Pigeon audio device id
  /// `PipelineController.goLive` passes as `StreamConfig.audioDeviceId`.
  ///
  /// Implements the spec's audio-follows-video-source rule: "auto = camera →
  /// mic / UVC → USB audio if available else mic"; an explicit `usbAudio`
  /// choice falls back to mic when no USB audio device is currently listed,
  /// rather than failing Go Live outright. Stateless and side-effect free.
  class AudioSourceSelector {
    const AudioSourceSelector();

    /// [selectedVideoKind] is the currently-selected video device's kind (null
    /// if none is selected yet); [audioDevices] is the live
    /// `audioDevicesProvider` list.
    String deviceIdFor({
      required AudioSourceChoice choice,
      required VideoDeviceKind? selectedVideoKind,
      required List<AudioDevice> audioDevices,
    }) {
      final bool hasUsbAudio = audioDevices.any(
        (AudioDevice d) => d.kind == AudioDeviceKind.usbAudio,
      );
      switch (choice) {
        case AudioSourceChoice.silence:
          return 'audio:silence';
        case AudioSourceChoice.mic:
          return 'audio:mic';
        case AudioSourceChoice.usbAudio:
          return hasUsbAudio ? 'audio:usb' : 'audio:mic';
        case AudioSourceChoice.auto:
          final bool followsUsb =
              selectedVideoKind == VideoDeviceKind.uvcCamera2 && hasUsbAudio;
          return followsUsb ? 'audio:usb' : 'audio:mic';
      }
    }
  }
  ```

- [ ] **Step 4: Run and confirm pass.**
  `make mobile-run CMD="flutter test test/services/audio_source_selector_test.dart"`
  Expected PASS: `00:0X +8: All tests passed!`.

- [ ] **Step 5: Add the failing PipelineController tests.**

  This file's top-level `setUp()` already builds a shared `host` (`FakeGazerHostApi`), `bridge` (`NativeEventBridge`), and `controller` (`PipelineController`) reused by every test via closures, plus the fixtures `backCamera` (a `VideoDevice`), `settingsWith({username, password})`, and `flagsWith({adaptiveBitrate, rtmpAuth})` — this task adds a new group using those same names, not new ones. Add this group to `<app>/test/services/pipeline_controller_test.dart` (append after the existing `group('reconnect on rtmpConnectFailed', ...)` block; every pre-existing test in the file is unmodified and keeps passing since `audioDevices` defaults to `const <AudioDevice>[]`):
  ```dart
  group('audio source selection (M2)', () {
    // Not `const`: the Pigeon-generated VideoDevice/AudioDevice classes have
    // plain (non-const) constructors, so neither these instances nor a list
    // literal containing them can be `const`.
    final uvcDevice = VideoDevice(
      id: 'camera:uvc:2',
      kind: VideoDeviceKind.uvcCamera2,
      name: 'USB capture card',
    );
    final usbAudio = AudioDevice(
      id: 'audio:usb',
      kind: AudioDeviceKind.usbAudio,
      name: 'USB audio',
    );

    test(
      'goLive resolves audio:usb when audio is auto, a UVC device is selected, and USB audio is present',
      () async {
        await controller.goLive(
          settingsWith().copyWith(audio: AudioSourceChoice.auto),
          devices: [uvcDevice],
          videoDeviceId: 'camera:uvc:2',
          flags: flagsWith(),
          audioDevices: [usbAudio],
        );

        expect(host.prepareCalls.single.audioDeviceId, 'audio:usb');
      },
    );

    test(
      'goLive falls back to audio:mic when USB audio is explicitly chosen but absent',
      () async {
        await controller.goLive(
          settingsWith().copyWith(audio: AudioSourceChoice.usbAudio),
          devices: [backCamera],
          videoDeviceId: 'camera:back',
          flags: flagsWith(),
          // audioDevices omitted -- defaults to empty, no USB audio present.
        );

        expect(host.prepareCalls.single.audioDeviceId, 'audio:mic');
      },
    );

    test(
      'goLive keeps audio:mic for auto when the selected device is the phone camera, even with USB audio present',
      () async {
        await controller.goLive(
          settingsWith(),
          devices: [backCamera],
          videoDeviceId: 'camera:back',
          flags: flagsWith(),
          audioDevices: [usbAudio],
        );

        expect(host.prepareCalls.single.audioDeviceId, 'audio:mic');
      },
    );
  });
  ```

- [ ] **Step 6: Run — expected FAIL.**
  `make mobile-run CMD="flutter test test/services/pipeline_controller_test.dart"`
  Expected: the first test (`goLive resolves audio:usb when audio is auto...`) fails — `host.prepareCalls.single.audioDeviceId` is `'audio:mic'`, not `'audio:usb'` (M1's `_audioDeviceIdFor` stub resolves every `AudioSourceChoice` case to `'audio:mic'` except `silence`). The other two tests in this group already pass unmodified — both expect `'audio:mic'`, which the M1 stub already produces — and exist as regression coverage for the fallback/no-video-selected paths once `AudioSourceSelector` replaces the stub.

- [ ] **Step 7: Implement — wire AudioSourceSelector and the videoSource telemetry attribute into PipelineController.**

  In `<app>/lib/services/pipeline_controller.dart`, add the import:
  ```dart
  import 'audio_source_selector.dart';
  ```

  Replace the `_audioDeviceIdFor` method and its M1 doc comment entirely:
  ```dart
    /// M1 has no UVC/USB audio path: `usbAudio` and `auto` both resolve to
    /// the phone mic; `silence` resolves to the muted source.
    String _audioDeviceIdFor(AudioSourceChoice choice) {
      switch (choice) {
        case AudioSourceChoice.auto:
        case AudioSourceChoice.mic:
        case AudioSourceChoice.usbAudio:
          return 'audio:mic';
        case AudioSourceChoice.silence:
          return 'audio:silence';
      }
    }
  ```
  with nothing (delete it — `AudioSourceSelector` replaces it entirely).

  Update `goLive`'s signature — add the new optional parameter immediately after `orientation`:
  ```dart
    Future<void> goLive(
      GazerSettings settings, {
      required List<VideoDevice> devices,
      required String videoDeviceId,
      required FeatureFlags flags,
      OutputOrientation orientation = OutputOrientation.landscape,
      List<AudioDevice> audioDevices = const <AudioDevice>[],
    }) async {
  ```

  Replace the `StreamConfig` construction's `audioDeviceId` line:
  ```dart
        audioDeviceId: _audioDeviceIdFor(settings.audio),
  ```
  with:
  ```dart
        audioDeviceId: const AudioSourceSelector().deviceIdFor(
          choice: settings.audio,
          selectedVideoKind: _kindOf(devices, videoDeviceId),
          audioDevices: audioDevices,
        ),
  ```
  (`_kindOf` is a plain loop, not `Iterable.firstOrNull`, so this needs no new import — `package:collection` is not otherwise a dependency of this file.) Add this private helper near `_audioDeviceIdFor`'s old location:
  ```dart
    /// The kind of the device in [devices] whose id is [videoDeviceId], or
    /// null if none matches (defensive only — `goLive`'s own validation above
    /// already rejects an unknown [videoDeviceId] before this is ever called).
    VideoDeviceKind? _kindOf(List<VideoDevice> devices, String videoDeviceId) {
      for (final VideoDevice d in devices) {
        if (d.id == videoDeviceId) return d.kind;
      }
      return null;
    }
  ```

  Track the resolved kind for telemetry — add a field alongside `_pendingConfig`:
  ```dart
    /// The selected video device's kind for the current/most recent session,
    /// used only as the `videoSource` attribute on the `gazer.pipeline.state_change`
    /// counter (see [_emit]); cleared in [stop].
    VideoDeviceKind? _videoSourceKind;
  ```
  Set it in `goLive`, immediately before `_emit(const PreparingState());`:
  ```dart
        _videoSourceKind = _kindOf(devices, videoDeviceId);
  ```
  Clear it in `stop()`, immediately after `_cancelled = true;`:
  ```dart
        _videoSourceKind = null;
  ```

  Update `_emit`'s counter call:
  ```dart
      GazerTelemetry.counter('gazer.pipeline.state_change', <String, Object?>{
        'from': _current.runtimeType.toString(),
        'to': next.runtimeType.toString(),
      });
  ```
  to:
  ```dart
      GazerTelemetry.counter('gazer.pipeline.state_change', <String, Object?>{
        'from': _current.runtimeType.toString(),
        'to': next.runtimeType.toString(),
        if (_videoSourceKind != null) 'videoSource': _videoSourceKind!.name,
      });
  ```

- [ ] **Step 8: Run — expected PASS.**
  `make mobile-run CMD="flutter test test/services/pipeline_controller_test.dart"`
  Expected: `All tests passed!` (every pre-existing test plus the 3 added in Step 5).

- [ ] **Step 9: Run the full Dart suite + coverage gate.**
  `make mobile-test`
  Expected: `All tests passed!`, lcov ≥90%.

- [ ] **Step 10: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 11: Commit.**
  ```bash
  git add <app>/lib/services/audio_source_selector.dart \
          <app>/test/services/audio_source_selector_test.dart \
          <app>/lib/services/pipeline_controller.dart \
          <app>/test/services/pipeline_controller_test.dart
  git commit -m "$(cat <<'EOF'
  feat(gazer): AudioSourceSelector -- audio follows video source, with explicit override and USB-absent fallback

  Replaces PipelineController's M1 _audioDeviceIdFor stub (which always
  resolved to the phone mic) with AudioSourceSelector's real policy, and
  adds a videoSource attribute to the gazer.pipeline.state_change counter.

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 13: uvc-capture feature flag gating — visibleVideoDevicesProvider

**Depends on:** Task 11 (`videoDevicesProvider`/`nativeEventBridgeProvider`).

**Files:**
- Modify: `<app>/lib/providers/devices_provider.dart`
- Modify: `<app>/lib/screens/home_screen.dart`
- Modify, Test: `<app>/test/screens/home_screen_test.dart`

**Interfaces:**
- Consumes: `FlagKeys.uvcCapture` (M1, unchanged), `featureFlagsProvider` (`license_provider.dart`, M1, unchanged).
- Produces (verbatim, Shared Contract): `@riverpod Future<List<VideoDevice>> visibleVideoDevices(Ref ref)`.

**Why filtering, not hiding a picker row (design decision):** the spec requires "picker entry hidden when the flag is off" — filtering the list one level below `SourcePicker` (which already renders whatever list it is given, unchanged since M1) means `SourcePicker` needs no new code at all, and `PipelineController.goLive`'s own `devices.any((d) => d.id == videoDeviceId)` validation naturally rejects a stale/hidden UVC selection if the flag flips off mid-session, with zero new logic. `StatusPanel` intentionally keeps reading the unfiltered `videoDevicesProvider` for its device-name lookup — a UVC device can only ever become `selectedDeviceId` via the (now-filtered) `SourcePicker`, so the flag can never actually gate what `StatusPanel` displays; filtering there too would be a no-op change.

- [ ] **Step 1: Write the failing test.**

  Add this test to `<app>/test/providers/devices_provider_test.dart` (append to `main()`):
  ```dart
  test(
    'visibleVideoDevicesProvider hides UVC devices when the uvc-capture flag is off, shows them when on',
    () async {
      final host = FakeGazerHostApi()
        ..videoDevices = [
          VideoDevice(id: 'camera:back', kind: VideoDeviceKind.backCamera, name: 'Back camera'),
          VideoDevice(id: 'camera:uvc:2', kind: VideoDeviceKind.uvcCamera2, name: 'USB capture card'),
        ];

      LicenseState license(bool uvcOn) => LicenseState(
        status: LicenseStatus.valid,
        flags: {'waddlebot.gazer.uvc-capture': uvcOn},
        lastFetched: DateTime.utc(2026, 9, 14),
        deviceId: 'test-device',
      );

      final offContainer = ProviderContainer(
        overrides: [
          gazerHostApiProvider.overrideWithValue(host),
          licenseProvider.overrideWith((Ref ref) async => license(false)),
        ],
      );
      addTearDown(offContainer.dispose);
      final visibleWhenOff = await offContainer.read(visibleVideoDevicesProvider.future);
      expect(visibleWhenOff.map((d) => d.id), ['camera:back']);

      final onContainer = ProviderContainer(
        overrides: [
          gazerHostApiProvider.overrideWithValue(host),
          licenseProvider.overrideWith((Ref ref) async => license(true)),
        ],
      );
      addTearDown(onContainer.dispose);
      final visibleWhenOn = await onContainer.read(visibleVideoDevicesProvider.future);
      expect(visibleWhenOn.map((d) => d.id), ['camera:back', 'camera:uvc:2']);
    },
  );
  ```
  Add `import 'package:gazer/models/license_state.dart';` and `import 'package:gazer/providers/license_provider.dart';` to the file's imports.

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="flutter test test/providers/devices_provider_test.dart"`
  Expected: compile error — `unresolved reference: visibleVideoDevicesProvider`.

- [ ] **Step 3: Implement.**

  Add to `<app>/lib/providers/devices_provider.dart` (imports, then the new provider at the end of the file):
  ```dart
  import '../config/flag_keys.dart';
  import 'license_provider.dart';
  ```
  ```dart
  /// [videoDevices], filtered to exclude any UVC-kind entry while
  /// `FlagKeys.uvcCapture` is off — the gate for the whole M2 capture-card
  /// feature (spec: "picker entry hidden when the flag is off"). See the
  /// Task 13 brief for why filtering here, rather than in `SourcePicker` or
  /// `StatusPanel`, is sufficient.
  @riverpod
  Future<List<VideoDevice>> visibleVideoDevices(Ref ref) async {
    final devices = await ref.watch(videoDevicesProvider.future);
    final FeatureFlags flags = ref.watch(featureFlagsProvider);
    if (flags.isEnabled(FlagKeys.uvcCapture)) return devices;
    return devices
        .where(
          (VideoDevice d) =>
              d.kind != VideoDeviceKind.uvcCamera2 &&
              d.kind != VideoDeviceKind.uvcLibuvc,
        )
        .toList();
  }
  ```
  Add `import '../services/feature_flags.dart';` alongside the other new imports (for the `FeatureFlags` type annotation).

- [ ] **Step 4: Regenerate Riverpod code.**
  `make mobile-codegen`

- [ ] **Step 5: Run — expected PASS.**
  `make mobile-run CMD="flutter test test/providers/devices_provider_test.dart"`
  Expected: `All tests passed!`.

- [ ] **Step 6: Wire HomeScreen to the filtered provider.**

  In `<app>/lib/screens/home_screen.dart`, change every `videoDevicesProvider` reference to `visibleVideoDevicesProvider`: the `ref.watch(videoDevicesProvider).value` line building `devices`, and the `ref.listen<AsyncValue<List<VideoDevice>>>(videoDevicesProvider, ...)` call — both become `visibleVideoDevicesProvider`. No other line in this file changes; `devices` already flows into `SourcePicker`, `_requestGoLivePermissions`, and `goLive`'s `devices:` param exactly as before.

- [ ] **Step 7: Update the shared test override helper.**

  In `<app>/test/screens/home_screen_test.dart`, add `nativeEventBridgeProvider.overrideWithValue(hostApi.bridge)` to the `overrides()` helper's returned list, immediately after the existing `pipelineControllerProvider.overrideWithValue(...)` entry — this is what makes `hostApi.emitUsbAttached(...)`/`emitUsbDetached(...)` (used by Task 14's new tests) actually reach `visibleVideoDevicesProvider`/`videoDevicesProvider`, the same way `pipelineControllerProvider`'s override already wires `hostApi.bridge` for state/stats events. Add `import 'package:gazer/providers/devices_provider.dart';` if it is not already imported (it already is, per the file's existing imports).

  Add this test to the file (a `uvc-capture` flag-off/on pair, mirroring the pattern the existing `license(flagsSet: true)`/`license(flagsSet: false)` fixtures already establish):
  ```dart
  testWidgets(
    'source picker hides a UVC device when uvc-capture flag is off, shows it when on',
    (WidgetTester tester) async {
      hostApi.videoDevices = <VideoDevice>[
        VideoDevice(id: 'camera:back', kind: VideoDeviceKind.backCamera, name: 'Back Camera'),
        VideoDevice(id: 'camera:uvc:2', kind: VideoDeviceKind.uvcCamera2, name: 'USB capture card'),
      ];
      await pumpGazerApp(
        tester,
        overrides: overrides(
          license: LicenseState(
            status: LicenseStatus.valid,
            flags: const {
              'waddlebot.gazer.camera-stream': true,
              'waddlebot.gazer.uvc-capture': false,
              'waddlebot.gazer.adaptive-bitrate': true,
              'waddlebot.gazer.rtmp-auth': true,
            },
            lastFetched: DateTime.utc(2026, 9, 14),
            deviceId: 'test-device',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('USB capture card'), findsNothing);
    },
  );
  ```

- [ ] **Step 8: Run — expected PASS.**
  `make mobile-run CMD="flutter test test/screens/home_screen_test.dart"`
  Expected: `All tests passed!` (every pre-existing test plus the 1 added).

- [ ] **Step 9: Run the full Dart suite + coverage gate.**
  `make mobile-test`
  Expected: `All tests passed!`, lcov ≥90%.

- [ ] **Step 10: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 11: Commit.**
  ```bash
  git add <app>/lib/providers/devices_provider.dart \
          <app>/lib/providers/devices_provider.g.dart \
          <app>/lib/screens/home_screen.dart \
          <app>/test/providers/devices_provider_test.dart \
          <app>/test/screens/home_screen_test.dart
  git commit -m "$(cat <<'EOF'
  feat(gazer): gate UVC devices behind waddlebot.gazer.uvc-capture via visibleVideoDevicesProvider

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 14: HomeScreen — USB permission gate + forced landscape orientation for UVC

**Depends on:** Task 10 (`requestUsbPermissionResult`), Task 13 (`visibleVideoDevicesProvider`, `nativeEventBridgeProvider` override in the test helper).

**Files:**
- Modify: `<app>/lib/screens/home_screen.dart`
- Modify, Test: `<app>/test/screens/home_screen_test.dart`

**Interfaces:** none new — consumes `GazerHostApi.requestUsbPermission` (existing Pigeon method, previously unused from Dart since M1 never listed a UVC device), `gazerHostApiProvider` (`devices_provider.dart`).

**Two-outcome USB permission UX (reuses M1's l10n strings, adds none):** denial shows the same retryable `SnackBar` shape `_requestGoLivePermissions`'s `denied` case already uses, with `l10n.errorUsbPermissionDeniedMessage` ("USB permission was denied.") as the message and `l10n.permissionDeniedRetryLabel` ("Retry") as the action — both already shipped in M1's `app_en.arb` (the first for the native-error path, GazerErrorCode.usbPermissionDenied; the second for the camera/mic gate). No third "permanently denied" branch — see Task 5's brief for why `UsbManager`'s permission dialog has no such signal to react to.

- [ ] **Step 1: Write the failing tests.**

  Add these tests to `<app>/test/screens/home_screen_test.dart` (append to `main()`'s `testWidgets` calls; `hostApi`/`overrides`/`license` from the file's existing `setUp`/helpers are reused):
  ```dart
  testWidgets(
    'Go Live with a UVC device selected requests USB permission and proceeds when granted',
    (WidgetTester tester) async {
      hostApi.videoDevices = <VideoDevice>[
        VideoDevice(id: 'camera:uvc:2', kind: VideoDeviceKind.uvcCamera2, name: 'USB capture card'),
      ];
      hostApi.requestUsbPermissionResult = true;
      await pumpGazerApp(tester, overrides: overrides(license: license(flagsSet: true)));
      await tester.pumpAndSettle();

      await tester.tap(find.text('USB capture card'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('goLiveButton')));
      await tester.pumpAndSettle();

      expect(hostApi.calls, contains('requestUsbPermission(camera:uvc:2)'));
      expect(hostApi.prepareCalls, isNotEmpty);
    },
  );

  testWidgets(
    'Go Live with a UVC device selected shows a retry SnackBar when USB permission is denied',
    (WidgetTester tester) async {
      hostApi.videoDevices = <VideoDevice>[
        VideoDevice(id: 'camera:uvc:2', kind: VideoDeviceKind.uvcCamera2, name: 'USB capture card'),
      ];
      hostApi.requestUsbPermissionResult = false;
      await pumpGazerApp(tester, overrides: overrides(license: license(flagsSet: true)));
      await tester.pumpAndSettle();

      await tester.tap(find.text('USB capture card'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('goLiveButton')));
      await tester.pumpAndSettle();

      expect(hostApi.prepareCalls, isEmpty);
      expect(find.text('USB permission was denied.'), findsOneWidget);
    },
  );

  testWidgets(
    'Go Live with a UVC device selected forces landscape orientation regardless of device orientation',
    (WidgetTester tester) async {
      hostApi.videoDevices = <VideoDevice>[
        VideoDevice(id: 'camera:uvc:2', kind: VideoDeviceKind.uvcCamera2, name: 'USB capture card'),
      ];
      hostApi.requestUsbPermissionResult = true;
      tester.view.physicalSize = const Size(800, 1600); // portrait-shaped surface
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await pumpGazerApp(tester, overrides: overrides(license: license(flagsSet: true)));
      await tester.pumpAndSettle();

      await tester.tap(find.text('USB capture card'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('goLiveButton')));
      await tester.pumpAndSettle();

      expect(hostApi.prepareCalls.single.orientation, OutputOrientation.landscape);
    },
  );
  ```

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="flutter test test/screens/home_screen_test.dart"`
  Expected: the 3 new tests fail — `requestUsbPermission` is never called (Go Live proceeds straight through for any device today), so `hostApi.calls` never contains it and the denial SnackBar never appears; the orientation test fails because M1's orientation logic reads `MediaQuery.orientationOf(context)` unconditionally, so a portrait-shaped surface produces `OutputOrientation.portrait` even for a UVC device.

- [ ] **Step 3: Implement.**

  In `<app>/lib/screens/home_screen.dart`, replace `_requestGoLivePermissions`'s `PermissionOutcome.granted` case body:
  ```dart
      case PermissionOutcome.granted:
        await _handleGoLive(
          controller: controller,
          settings: settings,
          devices: devices,
          flags: flags,
          videoDeviceId: videoDeviceId,
          orientation: MediaQuery.orientationOf(context) == Orientation.portrait
              ? OutputOrientation.portrait
              : OutputOrientation.landscape,
        );
  ```
  with:
  ```dart
      case PermissionOutcome.granted:
        await _requestUsbPermissionIfNeeded(
          controller: controller,
          settings: settings,
          devices: devices,
          flags: flags,
          videoDeviceId: videoDeviceId,
        );
  ```

  Add this new method to `_HomeScreenState`, immediately after `_requestGoLivePermissions`:
  ```dart
    /// Requests USB device permission via [GazerHostApi.requestUsbPermission] before Go Live when
    /// [videoDeviceId] resolves to a UVC device (spec: the USB permission flow gates Go Live for a
    /// capture-card source); a plain passthrough to [_handleGoLive] for every other device kind.
    ///
    /// UVC sources are always landscape (spec: "UVC always landscape 16:9") regardless of the
    /// phone/tablet's current physical orientation — computed here rather than left to
    /// [GazerPipeline]'s own defensive rotation-forcing (Kotlin, Task 4) because Dart owns this
    /// decision per the boundary rule; the Kotlin-side force is a backstop, not the source of truth.
    ///
    /// Denial shows the same retryable [SnackBar] shape as [_requestGoLivePermissions]'s `denied`
    /// case, reusing its l10n strings — see the Task 14 brief for why USB permission has no
    /// "permanently denied" branch.
    Future<void> _requestUsbPermissionIfNeeded({
      required PipelineController controller,
      required GazerSettings settings,
      required List<VideoDevice> devices,
      required FeatureFlags flags,
      required String videoDeviceId,
    }) async {
      final bool isUvc = devices
          .where((VideoDevice d) => d.id == videoDeviceId)
          .any((VideoDevice d) => d.kind == VideoDeviceKind.uvcCamera2);
      final OutputOrientation orientation = isUvc
          ? OutputOrientation.landscape
          : (MediaQuery.orientationOf(context) == Orientation.portrait
                ? OutputOrientation.portrait
                : OutputOrientation.landscape);

      if (!isUvc) {
        await _handleGoLive(
          controller: controller,
          settings: settings,
          devices: devices,
          flags: flags,
          videoDeviceId: videoDeviceId,
          orientation: orientation,
        );
        return;
      }

      final GazerHostApi host = ref.read(gazerHostApiProvider);
      final bool granted = await host.requestUsbPermission(videoDeviceId);
      if (!mounted) return;
      if (!granted) {
        final AppLocalizations l10n = AppLocalizations.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(l10n.errorUsbPermissionDeniedMessage),
            action: SnackBarAction(
              label: l10n.permissionDeniedRetryLabel,
              onPressed: () => _requestUsbPermissionIfNeeded(
                controller: controller,
                settings: settings,
                devices: devices,
                flags: flags,
                videoDeviceId: videoDeviceId,
              ),
            ),
          ),
        );
        return;
      }
      await _handleGoLive(
        controller: controller,
        settings: settings,
        devices: devices,
        flags: flags,
        videoDeviceId: videoDeviceId,
        orientation: orientation,
      );
    }
  ```

- [ ] **Step 4: Run — expected PASS.**
  `make mobile-run CMD="flutter test test/screens/home_screen_test.dart"`
  Expected: `All tests passed!` (every pre-existing test plus the 3 added).

- [ ] **Step 5: Run the full Dart suite + coverage gate.**
  `make mobile-test`
  Expected: `All tests passed!`, lcov ≥90%.

- [ ] **Step 6: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 7: Commit.**
  ```bash
  git add <app>/lib/screens/home_screen.dart <app>/test/screens/home_screen_test.dart
  git commit -m "$(cat <<'EOF'
  feat(gazer): USB permission gate before Go Live for UVC devices, forced landscape orientation

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 15: PipelineController negotiated-format exposure + StatusPanel UVC row + l10n

**Depends on:** Task 12 (`PipelineController` already modified once in this plan — this task modifies it again), Task 13 (`visibleVideoDevicesProvider`, for consistency of what devices StatusPanel can ever see selected).

**Files:**
- Modify: `<app>/lib/services/pipeline_controller.dart`
- Modify, Test: `<app>/test/services/pipeline_controller_test.dart`
- Modify: `<app>/lib/providers/pipeline_provider.dart`
- Modify: `<app>/lib/l10n/app_en.arb`
- Modify: `<app>/lib/screens/status_panel.dart`
- Modify, Test: `<app>/test/screens/status_panel_test.dart`

**Interfaces:**
- Produces (verbatim, Shared Contract): `PipelineController` gains `Stream<PrepareResult?> get negotiatedFormat` and `PrepareResult? get currentNegotiatedFormat`. `pipeline_provider.dart` gains `@riverpod Stream<PrepareResult?> negotiatedFormat(Ref ref)` (seeded with the controller's current value, same pattern as `pipelineState`/`streamStats`).
- `StatusPanel`'s UVC row becomes state-driven: "No capture card connected" (M1's existing string, reused for both "no UVC device selected" and "UVC selected but pipeline idle/error" — mirrors the existing `cameraOn` row's own idle/error semantics), "Connected ({name})" while a UVC device is selected and the pipeline is preparing/ready/connecting/reconnecting/stopping, "Streaming {name} ({width}x{height}@{fps})" while actually `StreamingState` and a negotiated format is available.

- [ ] **Step 1: Write the failing PipelineController tests.**

  Add this group to `<app>/test/services/pipeline_controller_test.dart` (append after Task 12's `group('audio source selection (M2)', ...)` block; reuses the file's shared `host`/`controller`/`backCamera`/`settingsWith`/`flagsWith` from `setUp`, same as every other test in the file):
  ```dart
  group('negotiated format (M2)', () {
    test(
      'currentNegotiatedFormat is populated after a successful prepare and cleared on stop',
      () async {
        host.prepareResult = PrepareResult(
          ok: true,
          negotiatedWidth: 1280,
          negotiatedHeight: 720,
          negotiatedFps: 30,
          negotiatedFormat: 'H264/AAC',
        );
        expect(controller.currentNegotiatedFormat, isNull);

        await controller.goLive(
          settingsWith(),
          devices: [backCamera],
          videoDeviceId: 'camera:back',
          flags: flagsWith(),
        );

        expect(controller.currentNegotiatedFormat?.negotiatedWidth, 1280);
        expect(controller.currentNegotiatedFormat?.negotiatedHeight, 720);
        expect(controller.currentNegotiatedFormat?.negotiatedFps, 30);

        await controller.stop();
        expect(controller.currentNegotiatedFormat, isNull);
      },
    );

    test('negotiatedFormat stream emits the prepared result', () async {
      host.prepareResult = PrepareResult(
        ok: true,
        negotiatedWidth: 640,
        negotiatedHeight: 480,
        negotiatedFps: 24,
        negotiatedFormat: 'H264/AAC',
      );
      final events = <PrepareResult?>[];
      final sub = controller.negotiatedFormat.listen(events.add);

      await controller.goLive(
        settingsWith(),
        devices: [backCamera],
        videoDeviceId: 'camera:back',
        flags: flagsWith(),
      );
      await Future<void>.delayed(Duration.zero);

      expect(events, hasLength(1));
      expect(events.single?.negotiatedWidth, 640);
      await sub.cancel();
    });
  });
  ```

- [ ] **Step 2: Run — expected FAIL.**
  `make mobile-run CMD="flutter test test/services/pipeline_controller_test.dart"`
  Expected: compile error — `currentNegotiatedFormat`/`negotiatedFormat` unresolved on `PipelineController`.

- [ ] **Step 3: Implement the PipelineController changes.**

  In `<app>/lib/services/pipeline_controller.dart`, add the field and controller alongside `_statsController`:
  ```dart
    final StreamController<PrepareResult?> _negotiatedFormatController =
        StreamController<PrepareResult?>.broadcast();
  ```
  Add the backing field alongside `_pendingConfig`:
  ```dart
    /// The most recent successful `prepare()`'s negotiated geometry, or null
    /// when nothing has been prepared this session (or the session ended).
    /// Exposed for [StatusPanel]'s UVC row (Task 15) — the raw request is
    /// already known to Dart via [GazerSettings.quality]; this is what the
    /// native side actually negotiated (see `VideoSourceFactory.negotiate`,
    /// Task 3), which can differ for a UVC device.
    PrepareResult? _currentNegotiatedFormat;
  ```
  Add the public getters, immediately after the `stats` getter:
  ```dart
    /// Every negotiated-format update after subscription (most recent value
    /// not replayed to a late subscriber — combine with [currentNegotiatedFormat]
    /// at the call site, same pattern as [state]/[current]).
    Stream<PrepareResult?> get negotiatedFormat => _negotiatedFormatController.stream;

    /// The most recent successful prepare's negotiated geometry, synchronously.
    PrepareResult? get currentNegotiatedFormat => _currentNegotiatedFormat;
  ```
  In `goLive`, immediately after `if (!result.ok) { ...; return; }`, add:
  ```dart
      _currentNegotiatedFormat = result;
      _negotiatedFormatController.add(result);
  ```
  In `_retryAfter`, immediately after its own `if (!result.ok) { ...; return; }` block, add the same two lines (a successful reconnect re-negotiates too, and the panel should reflect it).
  In `stop()`, immediately after `_cancelled = true;`, add:
  ```dart
      _currentNegotiatedFormat = null;
      _negotiatedFormatController.add(null);
  ```
  In `dispose()`, immediately after `_statsController.close();`, add:
  ```dart
      _negotiatedFormatController.close();
  ```

- [ ] **Step 4: Run — expected PASS.**
  `make mobile-run CMD="flutter test test/services/pipeline_controller_test.dart"`
  Expected: `All tests passed!`.

- [ ] **Step 5: Add the provider.**

  In `<app>/lib/providers/pipeline_provider.dart`, add immediately after `streamStats`:
  ```dart
  /// Live [PrepareResult] negotiated-format stream, seeded with the
  /// controller's current value the same way [streamStats] is seeded.
  @riverpod
  Stream<PrepareResult?> negotiatedFormat(Ref ref) async* {
    final controller = ref.watch(pipelineControllerProvider);
    yield controller.currentNegotiatedFormat;
    yield* controller.negotiatedFormat;
  }
  ```

  `make mobile-codegen` regenerates `<app>/lib/providers/pipeline_provider.g.dart`.

- [ ] **Step 6: Add the l10n strings.**

  In `<app>/lib/l10n/app_en.arb`, add immediately after the existing `"statusPanelUvcNotConnectedLabel": "No capture card connected",` line:
  ```json
    "statusPanelUvcConnectedLabel": "Connected ({name})",
    "@statusPanelUvcConnectedLabel": { "placeholders": { "name": { "type": "String" } } },
    "statusPanelUvcStreamingLabel": "Streaming {name} ({resolution})",
    "@statusPanelUvcStreamingLabel": { "placeholders": { "name": { "type": "String" }, "resolution": { "type": "String" } } },
  ```

  `make mobile-codegen` regenerates `<app>/lib/l10n/app_localizations*.dart`.

- [ ] **Step 7: Write the failing StatusPanel tests.**

  Add to `<app>/test/screens/status_panel_test.dart`, inside (or alongside) the existing `group('camera row', ...)` block's `setUp`:
  ```dart
  group('uvc row', () {
    setUp(() {
      hostApi.videoDevices = <VideoDevice>[
        VideoDevice(id: 'camera:uvc:2', kind: VideoDeviceKind.uvcCamera2, name: 'USB capture card'),
      ];
    });

    testWidgets('shows the not-connected label when no UVC device is selected', (
      WidgetTester tester,
    ) async {
      hostApi.videoDevices = <VideoDevice>[
        VideoDevice(id: 'camera:back', kind: VideoDeviceKind.backCamera, name: 'Back Camera'),
      ];
      await pumpGazerApp(tester, overrides: overrides(), size: const Size(1280, 800));
      await tester.pumpAndSettle();

      expect(find.text('No capture card connected'), findsOneWidget);
    });

    testWidgets('shows Connected (name) once selected and the pipeline is non-idle', (
      WidgetTester tester,
    ) async {
      await pumpGazerApp(tester, overrides: overrides(), size: const Size(1280, 800));
      await tester.tap(find.text('USB capture card'));
      await tester.pumpAndSettle();
      await tester.runAsync(
        () => hostApi.emitState(NativePipelineState.connecting),
      );
      await tester.pumpAndSettle();

      expect(find.text('Connected (USB capture card)'), findsOneWidget);
    });

    testWidgets('shows the negotiated resolution while streaming', (
      WidgetTester tester,
    ) async {
      hostApi.requestUsbPermissionResult = true;
      hostApi.prepareResult = PrepareResult(
        ok: true,
        negotiatedWidth: 1280,
        negotiatedHeight: 720,
        negotiatedFps: 30,
        negotiatedFormat: 'H264/AAC',
      );
      await pumpGazerApp(tester, overrides: overrides(), size: const Size(1280, 800));
      await tester.tap(find.text('USB capture card'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('goLiveButton')));
      await tester.pumpAndSettle();
      await tester.runAsync(
        () => hostApi.emitState(NativePipelineState.streaming),
      );
      await tester.pumpAndSettle();

      expect(find.text('Streaming USB capture card (1280x720@30)'), findsOneWidget);
    });
  });
  ```

- [ ] **Step 8: Run — expected FAIL.**
  `make mobile-run CMD="flutter test test/screens/status_panel_test.dart"`
  Expected: the 3 new tests fail — the UVC row always reads "No capture card connected" today, regardless of selection or pipeline state.

- [ ] **Step 9: Implement the StatusPanel change.**

  In `<app>/lib/screens/status_panel.dart`, add the negotiated-format watch alongside the other `ref.watch` calls in `build`:
  ```dart
      final PrepareResult? negotiated = ref.watch(negotiatedFormatProvider).value;
  ```
  Add `import '../providers/pipeline_provider.dart';`'s existing import already covers `negotiatedFormatProvider` (same file as `pipelineStateProvider`) — no new import needed.

  Add, immediately after the existing `final String? deviceLabel = cameraOn ? selectedDevice?.name : null;` line:
  ```dart
      final bool uvcSelected = selectedDevice?.kind == VideoDeviceKind.uvcCamera2;
      final bool uvcOn = uvcSelected && cameraOn;
      final String uvcText = !uvcOn
          ? l10n.statusPanelUvcNotConnectedLabel
          : (state is StreamingState &&
                    negotiated?.negotiatedWidth != null &&
                    negotiated?.negotiatedHeight != null &&
                    negotiated?.negotiatedFps != null)
          ? l10n.statusPanelUvcStreamingLabel(
              selectedDevice!.name,
              '${negotiated!.negotiatedWidth}x${negotiated.negotiatedHeight}@${negotiated.negotiatedFps}',
            )
          : l10n.statusPanelUvcConnectedLabel(selectedDevice!.name);
  ```

  Replace the hardcoded UVC row:
  ```dart
            _row(
              context,
              l10n.statusPanelUvcLabel,
              l10n.statusPanelUvcNotConnectedLabel,
            ),
  ```
  with:
  ```dart
            _row(context, l10n.statusPanelUvcLabel, uvcText),
  ```

- [ ] **Step 10: Run — expected PASS.**
  `make mobile-run CMD="flutter test test/screens/status_panel_test.dart"`
  Expected: `All tests passed!` (every pre-existing test plus the 3 added).

- [ ] **Step 11: Run the full Dart suite + coverage gate.**
  `make mobile-test`
  Expected: `All tests passed!`, lcov ≥90%.

- [ ] **Step 12: Lint.**
  `make mobile-lint` → PASS.

- [ ] **Step 13: Commit.**
  ```bash
  git add <app>/lib/services/pipeline_controller.dart \
          <app>/test/services/pipeline_controller_test.dart \
          <app>/lib/providers/pipeline_provider.dart \
          <app>/lib/providers/pipeline_provider.g.dart \
          <app>/lib/l10n/app_en.arb \
          <app>/lib/l10n/app_localizations.dart \
          <app>/lib/l10n/app_localizations_en.dart \
          <app>/lib/screens/status_panel.dart \
          <app>/test/screens/status_panel_test.dart
  git commit -m "$(cat <<'EOF'
  feat(gazer): StatusPanel UVC row reflects real connected/streaming state, device name, and negotiated resolution

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 16: README — capture-card section, permissions, device matrix, troubleshooting, manual checklist

**Depends on:** Task 8 (Kotlin side complete), Task 15 (Dart side complete) — this task documents the finished feature, so it lands last among the content tasks.

**Files:**
- Modify: `<app>/README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the permissions table.**

  Replace the existing permissions table's last row:
  ```markdown
  | `android.hardware.usb.host` feature (`required="false"`) | Reserved for M2/M3 USB capture-card support; unused in M1 |
  ```
  with:
  ```markdown
  | `android.hardware.usb.host` feature (`required="false"`) | USB capture-card support (M2); devices with no USB host controller run every other feature unaffected |
  | USB device permission (per-device, requested at runtime via `UsbManager`, no manifest entry) | Shown once per attached capture card before Go Live is allowed on it |
  ```

- [ ] **Step 2: Add the capture-card section.**

  Insert a new section immediately after the existing "## Telemetry" section (before "## Build / test / run"):
  ```markdown
  ## USB capture cards (M2)

  Gazer can stream from a USB Video Class (UVC) capture card in addition to
  the phone/tablet's own camera, via Android's Camera2 `LENS_FACING_EXTERNAL`
  path — supported on Pixel 6 and later, and Pixel Tablet-class hardware whose
  OEM exposes an external-camera HAL. Devices without that HAL (most
  non-Pixel phones) simply never list a capture card; nothing else about the
  app is affected. UVC-via-`libusb`/`libuvc` (for hardware without the
  Camera2-external path, e.g. Galaxy phones) is M3 scope, not yet supported.

  **Behind a feature flag:** the whole capture-card path is gated by
  `waddlebot.gazer.uvc-capture` — with the flag off, no capture card ever
  appears in the source picker, even if one is attached.

  **Permission prompt:** the first time you select an attached capture card
  and tap Go Live, Android shows its standard "Allow Gazer to access this USB
  device?" dialog. Unlike the camera/microphone permission prompt, this one
  has no "don't ask again" — declining it simply re-prompts the next time you
  try. If it's declined, Go Live does not start and a retry option is shown.

  **Audio follows video by default:** with the audio source set to
  "Automatic" (the default), selecting a capture card exposing USB Audio
  Class input switches audio to that USB input automatically; selecting the
  phone/tablet's own camera switches audio back to the phone microphone.
  Override this from Settings → Audio (Phone Microphone / USB Audio /
  Silence) — an explicit "USB Audio" choice falls back to the phone
  microphone if no USB audio device is currently attached, rather than
  failing Go Live outright.

  **Hot-plug:** attaching or detaching a capture card while Gazer is running
  updates the source picker and StatusPanel automatically. Detaching the
  card that is actively streaming stops the stream with a `usbDetached`
  error (StatusPanel + the home screen's error banner both show it);
  reconnect the card and tap Go Live again.

  **Orientation:** capture cards are always treated as landscape 16:9 —
  there is no "portrait capture card" concept, unlike the phone/tablet's own
  camera which follows the device's physical orientation at Go Live.
  ```

- [ ] **Step 3: Update the device matrix.**

  Replace:
  ```markdown
  ## Device matrix (M1 — phone camera only)

  "Camera path" below is the capture source used for the stream, not an
  on-screen preview — M1 ships no live viewfinder on any device (see the M1
  scope note above); status is surfaced via the StatusPanel instead.

  | Device | Camera path | Orientation | Status |
  |---|---|---|---|
  | Pixel 8 | Back/front Camera2 | Portrait + landscape | Supported |
  | Pixel 9 | Back/front Camera2 | Portrait + landscape | Supported |
  | Galaxy S24 | Back/front Camera2 | Portrait + landscape | Supported |
  | Galaxy Tab S9 | Back/front Camera2 | Portrait + landscape | Supported (two-pane layout, >=600dp) |

  USB capture-card rows (Camera2-external, libuvc) are out of scope until
  M2/M3.
  ```
  with:
  ```markdown
  ## Device matrix

  "Camera path" below is the capture source used for the stream, not an
  on-screen preview — no live viewfinder ships in v1 on any device (see the
  scope note above); status is surfaced via the StatusPanel instead.

  | Device | Camera path | UVC capture card | Orientation | Status |
  |---|---|---|---|---|
  | Pixel 8 | Back/front Camera2 | Camera2-external (LENS_FACING_EXTERNAL) | Portrait + landscape (card always landscape) | Supported |
  | Pixel 9 | Back/front Camera2 | Camera2-external (LENS_FACING_EXTERNAL) | Portrait + landscape (card always landscape) | Supported |
  | Pixel Tablet | Back/front Camera2 | Camera2-external (LENS_FACING_EXTERNAL) | Landscape primary (card always landscape) | Supported, two-pane layout (>=600dp) |
  | Galaxy S24 | Back/front Camera2 | Not supported (no Camera2-external HAL) — see M3 for `libuvc` fallback | Portrait + landscape | Phone camera supported; capture card deferred to M3 |
  | Galaxy Tab S9 | Back/front Camera2 | Not supported (no Camera2-external HAL) — see M3 | Portrait + landscape | Phone camera supported; capture card deferred to M3, two-pane layout (>=600dp) |

  See "Manual device checklist" below for the capture-card verification steps
  that cannot be automated (no CI emulator can attach a real USB device).
  ```

- [ ] **Step 4: Add capture-card troubleshooting rows.**

  Add these rows to the existing "## Troubleshooting" table:
  ```markdown
  | `usbPermissionDenied` | USB permission prompt was declined | Reconnect the capture card and tap Go Live again; grant the prompt this time |
  | `uvcOpenFailed` | The capture card could not be opened (`UsbDeviceConnection`/Camera2 failure) | Disconnect and reconnect the card, or restart the app |
  | `uvcNoUsableFormat` | No usable resolution/fps was found on the card | Try a lower resolution/fps in Settings, or switch to the phone camera |
  | `usbDetached` | The capture card was physically removed while streaming | Reconnect the card and tap Go Live again |
  ```

- [ ] **Step 5: Add the manual device checklist.**

  Add a new section immediately before "## iOS" (the README's last section):
  ```markdown
  ## Manual device checklist (M2 — cannot be automated)

  No CI emulator can attach a real USB device, so the following require a
  physical Pixel 8/9/Tablet-class device and a real UVC capture card
  (UGREEN, AVerMedia, or similar):

  - [ ] Attach the capture card before launching Gazer — it appears in the
        source picker on cold start.
  - [ ] Attach the capture card while Gazer is already running — it appears
        in the picker and StatusPanel within a few seconds, with no restart.
  - [ ] Select the capture card, tap Go Live — the USB permission dialog
        appears; accept it, confirm the stream reaches the RTMP target.
  - [ ] Repeat, but decline the permission dialog — confirm Go Live does not
        start and a retry option is shown; tapping it re-shows the dialog.
  - [ ] While streaming from the capture card, set audio to "Automatic" with
        a USB Audio Class-capable card attached — confirm the RTMP target
        receives audio from the card, not the phone mic.
  - [ ] While streaming from the capture card, detach it — confirm the
        stream stops with a `usbDetached` error shown in the home screen's
        error banner and StatusPanel, and no crash.
  - [ ] With `waddlebot.gazer.uvc-capture` off (license server override or a
        test tenant), confirm the capture card never appears in the picker
        even while attached.
  - [ ] Confirm StatusPanel's UVC row shows the card's negotiated resolution
        (e.g. `1920x1080@30`) once actually streaming, not just once
        selected.
  - [ ] Confirm the capture card's video is landscape-oriented regardless of
        how the phone/tablet itself is held.
  ```

- [ ] **Step 6: Lint (markdown has no dedicated lint target in this repo, but the file is UTF-8 plain text — a plain read-back is the check).**
  `make mobile-run CMD="cat README.md | head -5"` → confirms the file is still well-formed and readable inside the container (catches an accidental encoding/permission issue from the edit).

- [ ] **Step 7: Commit.**
  ```bash
  git add <app>/README.md
  git commit -m "$(cat <<'EOF'
  docs(gazer): M2 capture-card section, updated permissions/device matrix/troubleshooting, manual device checklist

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

### Task 17: M2 verification run

**Depends on:** Task 16 (every prior task).

**Files:**
- Create: `docs/superpowers/plans/2026-09-14-gazer-mobile-v2-m2-verification.md`

**Interfaces:** none — this task runs every gate and records results; it changes no app code.

- [ ] **Step 1: Run every automated gate, in this order, capturing each command's real output.**
  ```bash
  make mobile-lint
  make mobile-test
  make mobile-telemetry-check
  make mobile-test-android
  make mobile-security
  make mobile-build
  make mobile-test-integration
  ```
  For each: record PASS/FAIL, the exact counts the command itself prints (tests run, coverage %, files examined, packages scanned, findings) — never "no errors" alone, per `critical-rules.md` Verification Integrity's "assert a non-zero denominator" rule. A gate that reports 0 items examined is a FAIL, not a pass, and must be investigated (wrong path, empty report) before recording a result.

- [ ] **Step 2: Confirm CI is green on the integration branch/PR for this plan's final commit.**
  `gh run list --branch <this-plan's-branch> --limit 5` then `gh run view <run-id>` for the most recent run against the final commit — record the run URL and per-job conclusions (toolchain/analyze/test/android-unit/telemetry/build/security/integration), same table shape as the M1 verification doc.

- [ ] **Step 3: Confirm the M1 verification doc's still-passing gates were not silently broken.**
  Every M1 gate command above is the *same* command M2 now also gates on — this step is naturally covered by Step 1 rerunning them on the full M2 tree, not a separate check. Explicitly confirm the M1-era manual-device item (physical Pixel + real RTMP endpoint, phone-camera path) is unaffected by anything in this plan (no task in this plan touches `RootEncoderEngine`, `StreamService`'s core teardown, or `TargetValidator`).

- [ ] **Step 4: Record what remains manual-only for M2, verbatim from Task 16's checklist.**
  Copy Task 16 Step 5's "Manual device checklist" list into the verification doc as **DEFERRED, not fabricated** — same honesty bar the M1 verification doc set for its own physical-device step. Do not check off any item without an actual physical device and a real attached UVC capture card.

- [ ] **Step 5: Write the verification doc.**

  `docs/superpowers/plans/2026-09-14-gazer-mobile-v2-m2-verification.md`, following the exact section shape of `docs/superpowers/plans/2026-09-07-gazer-mobile-v2-m1-verification.md` (Gate results table, per-gate detail notes, CI per-job table, deferred-items table, merge gate paragraph) — populate every cell with this run's real output, never a copy of the M1 numbers. At minimum:
  ```markdown
  # Gazer Mobile 2.0 M2 — Verification Results

  **Date:** <run date> | **HEAD:** `<commit sha>` | **Branch:** `<branch>` | **CI run:** [`<run id>`](<run url>) — **<conclusion>**

  Verification run against the M2 integration HEAD, per Task 17. All automated gates below are [green/list what is not]. UVC capture-card manual device items (Task 16 checklist) could not be performed in this automated agent environment (no physical device or real UVC capture card available) and are recorded as **deferred**, not fabricated.

  ## Gate results

  | Gate | Result |
  |---|---|
  | `make mobile-lint` | <PASS/FAIL — exact tool output summary> |
  | `make mobile-test` | <PASS/FAIL — N/N Dart tests, lcov %, files examined> |
  | `make mobile-telemetry-check` | <PASS/FAIL — logs=N metrics=N histograms=N spans=N> |
  | `make mobile-test-android` | <PASS/FAIL — N/N JUnit tests, JaCoCo %> |
  | `make mobile-security` | <PASS/FAIL — packages examined both lockfiles, semgrep rules/files, gitleaks> |
  | `make mobile-build` | <PASS/FAIL — APK/AAB artifacts + sizes> |
  | `make mobile-test-integration` | <PASS/FAIL — Dart integration test result, connectedDebugAndroidTest result including the new UsbHotplugInstrumentedTest's 4 tests> |
  | CI (`gazer-mobile.yml`, run `<id>`) | <PASS/FAIL — per-job table> |

  ## Manual device checklist — DEFERRED

  <Task 16 Step 5's checklist, copied verbatim, every box unchecked, with the same reasoning M1's verification doc used for its own physical-device step.>

  ## Merge gate

  Every scripted/CI gate above is green; the manual device checklist is the one remaining item before this milestone's merge gate is fully satisfied — flagged here rather than merged prematurely, matching the M1 verification doc's own standard.
  ```

- [ ] **Step 6: Commit.**
  ```bash
  git add docs/superpowers/plans/2026-09-14-gazer-mobile-v2-m2-verification.md
  git commit -m "$(cat <<'EOF'
  docs(gazer): M2 verification results

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N2rQgkHY872RubwXoBZxtE
  EOF
  )"
  ```

---

## Self-Review

### Spec coverage table

| M2 requirement (spec + task brief) | Task(s) |
|---|---|
| Camera2 `LENS_FACING_EXTERNAL` enumeration as `VideoDeviceKind.uvcCamera2` | 3 |
| Hot-plug: USB attach/detach → re-enumerate → `onUsbAttached`/`onUsbDetached` (native) | 6, 8 |
| Hot-plug: Dart devices providers reflect attach/detach | 11 |
| Source picker shows the capture card when present (already M1-built, flag-gated) | 13 (gating only — `SourcePicker` itself unchanged) |
| StatusPanel UVC row: on/off + device name + negotiated format while streaming | 15 |
| USB permission flow: `UsbManager` permission request for the matching device | 5 |
| `device_filter.xml` + manifest intent-filter for `USB_DEVICE_ATTACHED` | 1 |
| Dart-side USB permission gate (denied UX, retry, l10n) | 14 |
| `waddlebot.gazer.uvc-capture` flag gates the whole feature, picker entry hidden when off | 13 |
| RootEncoder `VideoSource` fed by the external Camera2 device | 3, 4 |
| Resolution/fps negotiation against the device's real stream configurations | 2, 3, 4 |
| Orientation: no rotation for UVC by default | 4 (Kotlin force), 14 (Dart force) |
| USB Audio Class `AudioSource` via `AudioRecord` + `TYPE_USB_DEVICE` routing | 7 |
| Audio-follows-video default, with explicit override + USB-absent fallback | 12 |
| Failure semantics via the EXISTING `GazerErrorCode` set (no contract change) | 4, 6 (Kotlin); reused l10n confirmed already shipped in M1 |
| Telemetry: `video_source` attribute + `uvc_attach` counter | 12 (attribute), 11 (counter) |
| Dart unit + widget tests; fake host API grows UVC devices/events | 10 (helpers), 11–15 (usage) |
| Kotlin JUnit5 + MockK for enumeration/permission/negotiation policies | 2, 3, 5, 6, 7 |
| Instrumented test for the permission/hot-plug broadcast wiring | 9 |
| Integration-test extension + explicit manual-only list | 9 (what CAN run), 16 (manual checklist), 17 (deferred reporting) |
| Coverage ≥90% both languages | every task's own gate run + Task 17 final check |
| README section + verification checklist | 16, 17 |

Every bullet in the assignment's "What M2 must deliver" list maps to at least one task above; nothing in that list is unaddressed.

### Placeholder scan

Searched this document for "TBD", "similar to Task", "add tests for the above", "..." (elision), and "XXX"/"FIXME" markers — none found. Every code block is complete, runnable source (or a complete diff against a file this plan quotes verbatim from the real branch); every command is the literal `make mobile-*` invocation; every commit message is final text, not a template. Two narrative slips were caught and fixed during drafting: a stray `hotplog@` Kotlin label typo in Task 8's `GazerFlutterBindings.install` (removed), and a MockK `it.invocation.args[...]` cast that used the wrong DSL surface in Task 4 (replaced with `secondArg()`/`thirdArg()`/`arg(3)`).

### Type/signature consistency across tasks

- `VideoSourceFactory(context, cameraIds, captureDeviceNames)` — three-arg constructor introduced in Task 3, consumed identically in Task 4 (no constructor call, only method calls), Task 8 (`GazerFlutterBindings.install`), and Task 9 (instrumented test). No task calls the old two-arg M1 constructor.
- `AudioSourceFactory(audioInputDevices = NoUsbInput)` — optional param with a default, introduced in Task 7, consumed with the default (bare `AudioSourceFactory()`) in every pre-existing call site and with an explicit `AndroidAudioInputDevices` in Task 8; no task assumes a different arity.
- `NegotiatedFormat(width: Long, height: Long, fps: Long)` and `GazerPipeline.reportExternalFailure`/`activeVideoDeviceId` — declared in Tasks 3/4, consumed with matching `Long` types in Task 4's own tests and Task 6's `UsbHotplugController` (via `pipeline().activeVideoDeviceId` compared against a `String`, and `reportExternalFailure(GazerErrorCode, String?)` called with matching arg types).
- `PigeonHostApiImpl`'s `usbPermission: UsbPermissionCoordinator` constructor param — added in Task 5, its ONE production call site (`GazerFlutterBindings.install`) updated in Task 8; Task 5 Step 8 explicitly documents that `GazerFlutterBindings` is left non-compiling in between, so no task after 5 and before 8 accidentally assumes it already compiles end-to-end.
- `PipelineController.goLive`'s new `audioDevices` param — optional with an empty-list default (Task 12), so Tasks 12/15's own new tests are the only call sites passing a non-default value; every other task (14) passes it explicitly from `ref.watch(audioDevicesProvider)`.
- `AudioSourceSelector.deviceIdFor` — identical named-parameter shape (`choice`, `selectedVideoKind`, `audioDevices`) in its own test (Task 12 Step 1) and its call site inside `PipelineController.goLive` (Task 12 Step 7).
- `visibleVideoDevicesProvider` — introduced in Task 13, consumed by `HomeScreen` (Task 13 Step 6) in place of `videoDevicesProvider`; `StatusPanel` deliberately keeps `videoDevicesProvider` (documented in Task 13's design-decision note), so no task conflates the two.
- `negotiatedFormatProvider`/`PipelineController.currentNegotiatedFormat` — introduced in Task 15, consumed only by `StatusPanel` in the same task; no earlier task references it.
- Every Kotlin enum/class name used across tasks (`GazerErrorCode.USB_DETACHED`, `VideoDeviceKind.UVC_CAMERA2`, etc.) uses the SCREAMING_SNAKE_CASE Pigeon-Kotlin naming confirmed against the actual generated `Pipeline.g.kt` (read before writing this plan) — never the Dart camelCase spelling inside Kotlin code, and never the reverse in Dart code.
- Dart list literals holding a Pigeon-generated class instance (`VideoDevice`, `AudioDevice`, `PrepareResult`) are never `const` anywhere in this plan — verified by grep against the generated `pipeline.g.dart` constructors (plain, non-const) during drafting; `const <AudioDevice>[]` (an empty list default) is the sole exception, which is valid Dart regardless of element const-ability.

### Fixes made during self-review (before this plan was committed)

1. Removed a stray `hotplog@` Kotlin label typo from Task 8's `GazerFlutterBindings.install` code block.
2. Corrected Task 4's MockK stub from an invalid `it.invocation.args[...]` cast to the idiomatic `secondArg()`/`thirdArg()`/`arg(3)` accessors.
3. Replaced fabricated test-fixture names (`buildController`, `validSettings`, `allEnabledFlags`, `fake`) in Tasks 12 and 15 with the real fixture names read from the actual `<app>/test/services/pipeline_controller_test.dart` (`host`, `controller`, `settingsWith()`, `flagsWith()`, `backCamera`, all from a shared top-level `setUp()`), and rewrote both tasks' test code to match the file's real structure (a `group(...)` appended to `main()`, not a fresh `ProviderContainer`/controller per test).
4. Removed every invalid `const` usage against Pigeon-generated Dart classes (`VideoDevice`, `AudioDevice`) — their generated constructors are plain, not `const` — across Tasks 12 and 13's test code; local variables changed from `const x = ...` to `final x = ...` and list literals from `const [x]` to `[x]`.
5. Made two MockK SAM-lambda type inferences explicit (`mockk<android.media.AudioDeviceInfo>(relaxed = true)` instead of a bare `mockk(relaxed = true)`) in Task 7's `AudioSourceFactoryTest` additions, removing reliance on lambda-return-type inference through a `fun interface` SAM conversion.
6. Fixed `fun interface` vs. plain `interface` inconsistencies between the Shared Contract summary and each task's actual code for `UsbDeviceLister` (single-method → `fun interface`) and `AudioInputDevices` (single-method → `fun interface`); confirmed `UsbDevicesGateway`/`ReceiverRegistrar` (multi-method) correctly stay plain `interface` in both places.
7. **Load-bearing fix:** Task 11's original design called `GazerFlutterApi.setUp(bridge)` from inside the new `nativeEventBridgeProvider` — a provider `videoDevicesProvider`/`audioDevicesProvider` unconditionally watch. Since `<app>/test/providers/devices_provider_test.dart`'s two pre-existing tests are plain `test()` blocks (not `testWidgets()`) that never override `nativeEventBridgeProvider`, this would have made a real Pigeon platform-channel registration call reachable from a plain non-widget test for the first time in this codebase — genuinely uncertain to be safe without `TestWidgetsFlutterBinding.ensureInitialized()` (no test file in this project calls that explicitly, and no existing test currently lets `pipelineControllerProvider`'s real build function — the only place M1 already made this exact call — run un-overridden). Fixed by moving `GazerFlutterApi.setUp`/its teardown back into `pipelineControllerProvider` exclusively (identical call sites to M1, sourcing only the bridge *instance* from the new shared provider), and making `nativeEventBridgeProvider` construct-and-dispose only, never registering the channel. This keeps the risk profile of every existing test byte-for-byte identical to M1 while still sharing one bridge instance for hot-plug delivery.

### Pigeon contract

No addition, rename, or removal — confirmed at the start of drafting (Global Constraints) and re-confirmed here: `VideoDeviceKind.uvcCamera2`, every `GazerErrorCode` this plan uses (`usbPermissionDenied`, `uvcNoUsableFormat`, `uvcOpenFailed`, `cameraUnavailable`, `cameraInUse`, `usbDetached`, `serviceStartDenied`), `requestUsbPermission`, `onUsbAttached`, and `onUsbDetached` were all already present in `<app>/pigeons/pipeline.dart` before this plan was written.

### What cannot be verified on the emulator

No CI/local emulator can attach a real USB device. Concretely unverifiable by any automated test in this plan: a real UVC device's attach/detach broadcast; the real `UsbManager.requestPermission` dialog and its result broadcast; `Camera2Source.openCameraId` actually opening an external camera; real Camera2 stream-configuration negotiation against a genuine card's advertised modes; real USB Audio Class capture via `AudioRecord.setPreferredDevice`. Task 9's instrumented tests state this explicitly and verify everything adjacent that CAN run for real (receiver registration lifecycle, the emulator's actual empty `LENS_FACING_EXTERNAL`/USB device sets). Task 16's manual device checklist and Task 17's verification doc carry these as explicitly DEFERRED, never fabricated.
