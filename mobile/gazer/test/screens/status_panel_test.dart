import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
// `Override` (the type `ProviderScope.overrides` needs) is not part of
// flutter_riverpod 3.4.3's main barrel export — it moved to `misc.dart` in
// this pin, so it must be imported explicitly (see helpers/pump_app.dart).
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:gazer/l10n/app_localizations.dart';
import 'package:gazer/models/gazer_settings.dart';
import 'package:gazer/models/license_state.dart';
import 'package:gazer/models/stream_target_settings.dart';
import 'package:gazer/models/update_info.dart';
import 'package:gazer/pigeon/pipeline.g.dart';
import 'package:gazer/providers/connectivity_provider.dart';
import 'package:gazer/providers/devices_provider.dart';
import 'package:gazer/providers/license_provider.dart';
import 'package:gazer/providers/pipeline_provider.dart';
import 'package:gazer/providers/settings_provider.dart';
import 'package:gazer/providers/telemetry_provider.dart';
import 'package:gazer/providers/update_provider.dart';
import 'package:gazer/screens/status_panel.dart';
import 'package:gazer/services/license_client.dart';
import 'package:gazer/services/pipeline_controller.dart';
import 'package:gazer/services/reconnect_policy.dart';
import 'package:gazer/telemetry/gazer_telemetry.dart';
import 'package:gazer/telemetry/telemetry_config.dart';
import 'package:mocktail/mocktail.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

import '../helpers/fake_host_api.dart';
import '../helpers/fakes.dart';
import '../helpers/pump_app.dart';

/// Test double for `UrlLauncherPlatform.instance` — lets the update-link
/// tests drive `canLaunchUrl`/`launchUrl` failure paths without a real
/// platform channel. `MockPlatformInterfaceMixin` bypasses the token
/// verification `PlatformInterface` normally enforces against `implements`
/// (see that mixin's own doc, which names this exact class as its example).
class _MockUrlLauncherPlatform extends Mock
    with MockPlatformInterfaceMixin
    implements UrlLauncherPlatform {}

/// [LicenseClient] double that counts fetches and can fail the first N of
/// them, so the panel's Retry affordance can be shown to actually re-run
/// the fetch rather than merely rendering a button.
class _CountingLicenseClient implements LicenseClient {
  _CountingLicenseClient({required this.failures, required this.success});

  /// How many leading calls resolve to a never-fetched (failed) state.
  int failures;

  /// The state every call after [failures] resolves to.
  final LicenseState success;

  /// Number of `validateAndFetchFlags` calls received.
  int fetchCalls = 0;

  @override
  final String baseUrl = 'https://fake.license.invalid';

  @override
  Future<LicenseState> validateAndFetchFlags() async {
    fetchCalls++;
    if (fetchCalls <= failures) return LicenseState.initial('test-device');
    return success;
  }

  @override
  Future<void> keepalive() async {}
}

void main() {
  late FakeGazerHostApi hostApi;
  late FakeSettingsRepository settingsRepo;

  setUp(() {
    hostApi = FakeGazerHostApi();
    settingsRepo = FakeSettingsRepository(
      GazerSettings.defaults().copyWith(
        target: const StreamTargetSettings(
          url: 'rtmp://example.com/live/mystream',
          streamKey: 'demo-key-0001',
        ),
      ),
    );
  });

  List<Override> overrides({UpdateInfo? update, Override? telemetry}) =>
      <Override>[
        settingsRepositoryProvider.overrideWithValue(settingsRepo),
        gazerHostApiProvider.overrideWithValue(hostApi),
        // Wires hostApi.bridge into the controller under test so
        // hostApi.emitStats(...) below actually reaches streamStatsProvider
        // — see Task 11's FakeGazerHostApi doc.
        pipelineControllerProvider.overrideWithValue(
          PipelineController(
            host: hostApi,
            events: hostApi.bridge,
            policy: ReconnectPolicy(),
          ),
        ),
        licenseClientProvider.overrideWith(
          (Ref ref) async => FakeLicenseClient(
            LicenseState(
              status: LicenseStatus.valid,
              flags: const <String, bool>{
                'waddlebot.gazer.camera-stream': true,
                'waddlebot.gazer.uvc-capture': true,
                'waddlebot.gazer.adaptive-bitrate': true,
                'waddlebot.gazer.rtmp-auth': true,
              },
              lastFetched: DateTime.utc(2026, 9, 7),
              deviceId: 'test-device',
            ),
          ),
        ),
        isOnlineProvider.overrideWith((Ref ref) => Stream<bool>.value(true)),
        updateCheckerProvider.overrideWith(
          (Ref ref) async => FakeUpdateChecker(update),
        ),
        telemetry ??
            telemetryConfigProvider.overrideWith(
              (Ref ref) async => const TelemetryConfig(
                endpoint: '',
                protocol: 'http/json',
                headers: <String, String>{},
                serviceName: 'gazer',
                serviceVersion: '0.0.0',
                deploymentEnvironment: 'test',
              ),
            ),
      ];

  testWidgets('phone layout shows the chip and opens a bottom sheet', (
    WidgetTester tester,
  ) async {
    await pumpGazerApp(
      tester,
      overrides: overrides(),
      size: const Size(390, 844),
    );
    expect(find.byType(StatusPanel), findsNothing);
    await tester.tap(find.text('Idle'));
    await tester.pumpAndSettle();
    expect(find.byType(StatusPanel), findsOneWidget);
    expect(find.text('No capture card connected'), findsOneWidget);
  });

  testWidgets('tablet layout shows the panel as a persistent pane', (
    WidgetTester tester,
  ) async {
    await pumpGazerApp(
      tester,
      overrides: overrides(),
      size: const Size(1280, 800),
    );
    expect(find.byType(StatusPanel), findsOneWidget);
  });

  testWidgets('renders live stats from a stats sample', (
    WidgetTester tester,
  ) async {
    await pumpGazerApp(
      tester,
      overrides: overrides(),
      size: const Size(1280, 800),
    );
    // FakeGazerHostApi.emitStats awaits a real Future.delayed internally;
    // testWidgets runs inside a FakeAsync zone where a bare await never
    // elapses on its own, so real async work must run via `runAsync` (see
    // fake_host_api.dart's emitState/emitStats doc).
    await tester.runAsync(
      () => hostApi.emitStats(
        StatsSample(
          bitrateKbps: 2200,
          fps: 29.8,
          droppedVideoFrames: 3,
          sentBytes: 1000,
          congestionPercent: 0,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('2200'), findsOneWidget);
  });

  testWidgets('masked stream key shows only the last 4 characters', (
    WidgetTester tester,
  ) async {
    await pumpGazerApp(
      tester,
      overrides: overrides(),
      size: const Size(1280, 800),
    );
    expect(find.text('•••••••••0001'), findsOneWidget);
    expect(find.text('demo-key-0001'), findsNothing);
  });

  group('update link', () {
    final UpdateInfo update = UpdateInfo(
      latestVersion: '9.9.9',
      currentVersion: '1.0.0',
      releaseUrl: Uri.parse(
        'https://github.com/penguintechinc/waddlebot/releases/tag/gazer-v9.9.9',
      ),
    );

    late _MockUrlLauncherPlatform urlLauncher;
    late UrlLauncherPlatform originalPlatform;

    setUpAll(() {
      registerFallbackValue(const LaunchOptions());
    });

    setUp(() {
      originalPlatform = UrlLauncherPlatform.instance;
      urlLauncher = _MockUrlLauncherPlatform();
      UrlLauncherPlatform.instance = urlLauncher;
    });

    tearDown(() {
      UrlLauncherPlatform.instance = originalPlatform;
    });

    testWidgets(
      'canLaunchUrl false shows a SnackBar and never calls launchUrl',
      (WidgetTester tester) async {
        when(() => urlLauncher.canLaunch(any())).thenAnswer((_) async => false);
        await pumpGazerApp(
          tester,
          overrides: overrides(update: update),
          size: const Size(1280, 800),
        );
        await tester.tap(find.textContaining('Update available'));
        await tester.pumpAndSettle();
        expect(
          find.text('Could not open the release page. Please try again.'),
          findsOneWidget,
        );
        verifyNever(() => urlLauncher.launchUrl(any(), any()));
      },
    );

    testWidgets(
      'canLaunchUrl true calls launchUrl once and shows no SnackBar',
      (WidgetTester tester) async {
        when(() => urlLauncher.canLaunch(any())).thenAnswer((_) async => true);
        when(() => urlLauncher.launchUrl(any(), any()))
            .thenAnswer((_) async => true);
        await pumpGazerApp(
          tester,
          overrides: overrides(update: update),
          size: const Size(1280, 800),
        );
        await tester.tap(find.textContaining('Update available'));
        await tester.pumpAndSettle();
        verify(() => urlLauncher.launchUrl(any(), any())).called(1);
        expect(
          find.text('Could not open the release page. Please try again.'),
          findsNothing,
        );
      },
    );
  });

  testWidgets('telemetry row shows disabled when no endpoint is configured', (
    WidgetTester tester,
  ) async {
    await pumpGazerApp(
      tester,
      overrides: overrides(),
      size: const Size(1280, 800),
    );
    // Shortened from "Disabled (no endpoint configured)", which the row's
    // single-line ellipsis truncated mid-word at 360dp.
    expect(find.text('Disabled (no endpoint)'), findsOneWidget);
    final Text value = tester.widget<Text>(find.text('Disabled (no endpoint)'));
    expect(value.overflow, TextOverflow.ellipsis);
    expect(
      value.data!.length,
      lessThanOrEqualTo(26),
      reason: 'the fixed telemetry string must fit the 360dp value column',
    );
  });

  group('camera row', () {
    setUp(() {
      hostApi.videoDevices = <VideoDevice>[
        VideoDevice(
          id: 'camera:back',
          kind: VideoDeviceKind.backCamera,
          name: 'Back Camera',
        ),
        VideoDevice(
          id: 'camera:front',
          kind: VideoDeviceKind.frontCamera,
          name: 'Front Camera',
        ),
      ];
    });

    testWidgets('reports the SELECTED device, not simply the first one', (
      WidgetTester tester,
    ) async {
      await pumpGazerApp(
        tester,
        overrides: overrides(),
        size: const Size(1280, 800),
      );
      // Pick the front camera through the same picker the user would, then
      // drive the pipeline out of Idle so the camera row reports "On".
      await tester.tap(find.text('Front camera'));
      await tester.pumpAndSettle();
      await tester.runAsync(
        () => hostApi.emitState(NativePipelineState.streaming),
      );
      await tester.pumpAndSettle();

      // Before the fix this read "On (Back Camera)" -- devices.first.
      expect(find.text('On (Front Camera)'), findsOneWidget);
      expect(find.text('On (Back Camera)'), findsNothing);
    });

    testWidgets('falls back to Off while idle even with devices enumerated', (
      WidgetTester tester,
    ) async {
      await pumpGazerApp(
        tester,
        overrides: overrides(),
        size: const Size(1280, 800),
      );
      expect(find.text('Off'), findsOneWidget);
    });
  });

  group('license fetch retry', () {
    late _CountingLicenseClient client;

    LicenseState valid() => LicenseState(
      status: LicenseStatus.valid,
      flags: const <String, bool>{'waddlebot.gazer.camera-stream': true},
      lastFetched: DateTime.utc(2026, 9, 7),
      deviceId: 'test-device',
    );

    List<Override> retryOverrides() => <Override>[
      settingsRepositoryProvider.overrideWithValue(settingsRepo),
      gazerHostApiProvider.overrideWithValue(hostApi),
      licenseClientProvider.overrideWith((Ref ref) async => client),
      isOnlineProvider.overrideWith((Ref ref) => Stream<bool>.value(true)),
      updateCheckerProvider.overrideWith(
        (Ref ref) async => FakeUpdateChecker(null),
      ),
      telemetryConfigProvider.overrideWith(
        (Ref ref) async => const TelemetryConfig(
          endpoint: '',
          protocol: 'http/json',
          headers: <String, String>{},
          serviceName: 'gazer',
          serviceVersion: '0.0.0',
          deploymentEnvironment: 'test',
        ),
      ),
    ];

    testWidgets(
      'a failed first fetch offers Retry, and Retry actually re-fetches',
      (WidgetTester tester) async {
        client = _CountingLicenseClient(failures: 1, success: valid());
        await pumpGazerApp(
          tester,
          overrides: retryOverrides(),
          size: const Size(1280, 800),
        );

        // Settled with no lastFetched == the fetch failed quietly
        // (LicenseClient never throws); the panel used to claim it was
        // still fetching, forever, with no way out but an app restart.
        expect(
          find.text('Could not fetch features — streaming stays disabled'),
          findsOneWidget,
        );
        expect(find.byKey(const Key('licenseRetryButton')), findsOneWidget);
        expect(client.fetchCalls, 1);

        await tester.tap(find.byKey(const Key('licenseRetryButton')));
        await tester.pumpAndSettle();

        expect(client.fetchCalls, 2);
        expect(find.byKey(const Key('licenseRetryButton')), findsNothing);
        expect(find.text('Valid'), findsOneWidget);
      },
    );

    testWidgets('an in-flight fetch shows Retry only after a bounded wait', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(body: LicenseFetchRow(fetching: true, onRetry: () {})),
        ),
      );
      expect(
        find.text('Fetching features… (required to stream)'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('licenseRetryButton')), findsNothing);

      await tester.pump(kLicenseFetchRetryDelay + const Duration(seconds: 1));
      expect(find.byKey(const Key('licenseRetryButton')), findsOneWidget);
    });
  });

  testWidgets('the update link excludes its child semantics', (
    WidgetTester tester,
  ) async {
    await pumpGazerApp(
      tester,
      overrides: overrides(
        update: UpdateInfo(
          latestVersion: '9.9.9',
          currentVersion: '1.0.0',
          releaseUrl: Uri.parse('https://example.invalid/releases'),
        ),
      ),
      size: const Size(1280, 800),
    );
    final Semantics link = tester.widget<Semantics>(
      find.byKey(const Key('updateLinkSemantics')),
    );
    expect(link.excludeSemantics, isTrue);
  });

  testWidgets('the phone bottom sheet has a real close control', (
    WidgetTester tester,
  ) async {
    await pumpGazerApp(
      tester,
      overrides: overrides(),
      size: const Size(390, 844),
    );
    await tester.tap(find.text('Idle'));
    await tester.pumpAndSettle();
    expect(find.byType(StatusPanel), findsOneWidget);

    // Previously the sheet could only be dismissed by drag or scrim tap,
    // and statusPanelCloseButtonLabel was defined but never referenced.
    await tester.tap(find.byKey(const Key('statusPanelCloseButton')));
    await tester.pumpAndSettle();
    expect(find.byType(StatusPanel), findsNothing);
  });

  group('panel formatting', () {
    test('timestamps drop the ISO separator and microseconds', () {
      expect(
        formatPanelTimestamp(DateTime(2026, 9, 11, 22, 29, 56, 203)),
        'Sep 11, 2026 22:29',
      );
    });

    test('durations read as h/m/s, never a bare seconds count', () {
      expect(formatPanelDuration(Duration.zero), '0s');
      expect(formatPanelDuration(const Duration(seconds: 9)), '9s');
      expect(formatPanelDuration(const Duration(seconds: 69)), '1m 09s');
      expect(
        formatPanelDuration(const Duration(hours: 2, minutes: 5, seconds: 9)),
        '2h 05m 09s',
      );
    });

    testWidgets('the panel renders the formatted values, not raw ones', (
      WidgetTester tester,
    ) async {
      await pumpGazerApp(
        tester,
        overrides: overrides(),
        size: const Size(1280, 800),
      );
      // Exact wall-clock text depends on the runner's zone; what matters
      // is that it is a formatted date, never the raw ISO-8601 string with
      // its `T` separator and microseconds.
      expect(find.textContaining('Last fetched: Sep'), findsOneWidget);
      expect(find.textContaining('2026-09-07T'), findsNothing);
      expect(find.textContaining('.203041'), findsNothing);
      expect(find.text('Uptime: 0s'), findsOneWidget);
    });
  });

  testWidgets('the stream key label and value are not run together', (
    WidgetTester tester,
  ) async {
    await pumpGazerApp(
      tester,
      overrides: overrides(),
      size: const Size(1280, 800),
    );
    // "Stream Key••••••••0001" in the shipped screenshots: the Wrap put the
    // label and MaskedText flush against each other.
    final double labelRight = tester
        .getRect(find.text('Stream Key').last)
        .right;
    final double valueLeft = tester.getRect(find.text('•••••••••0001')).left;
    expect(valueLeft - labelRight, greaterThanOrEqualTo(8.0));
  });
  testWidgets(
    'the telemetry row is live: a failing export flips it with no other rebuild',
    (WidgetTester tester) async {
      // A Dio whose adapter always fails stands in for an unreachable
      // collector: no real socket, so this stays inside the widget
      // tester's fake-async zone.
      final Dio dio = Dio()..httpClientAdapter = _UnreachableAdapter();
      const TelemetryConfig config = TelemetryConfig(
        endpoint: 'http://collector.invalid:4318',
        protocol: 'http/json',
        headers: <String, String>{},
        serviceName: 'gazer',
        serviceVersion: '0.0.0',
        deploymentEnvironment: 'test',
      );
      addTearDown(GazerTelemetry.resetForTest);

      await pumpGazerApp(
        tester,
        overrides: overrides(
          telemetry: telemetryConfigProvider.overrideWith((Ref ref) async {
            GazerTelemetry.init(config, dio: dio);
            return config;
          }),
        ),
        size: const Size(1280, 800),
      );
      await tester.pumpAndSettle();
      expect(find.text('Exporting'), findsOneWidget);

      // Nothing about the widget tree changes here -- only the telemetry
      // counters do. The row used to read those counters during build(),
      // so it never noticed.
      // runAsync: the export goes through Dio, which needs real timers --
      // inside the widget tester's fake-async zone the flush never
      // completes.
      await tester.runAsync(() async {
        GazerTelemetry.recordLog('info', 'test.log', const <String, Object?>{});
        await GazerTelemetry.flush();
      });
      await tester.pump();
      // Stop the flush scheduler before the tester's pending-timer
      // invariant check: `GazerTelemetry.init` starts a Timer.periodic, and
      // the provider's own `onDispose` teardown runs after that check.
      GazerTelemetry.shutdown();

      expect(find.text('Last export failed'), findsOneWidget);
      expect(find.text('Exporting'), findsNothing);
    },
  );
}

/// Dio adapter that fails every request, standing in for an unreachable
/// OTLP collector without opening a socket.
class _UnreachableAdapter implements HttpClientAdapter {
  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => throw StateError('collector unreachable');
}
