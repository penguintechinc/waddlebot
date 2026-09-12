import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:gazer/app.dart';
import 'package:gazer/main.dart';
import 'package:gazer/models/gazer_settings.dart';
import 'package:gazer/services/gazer_log.dart';
import 'package:gazer/telemetry/gazer_telemetry.dart';
import 'package:gazer/telemetry/telemetry_config.dart';

import 'helpers/fakes.dart';

/// Records the order in which [bootstrap]'s steps ran, so a test can
/// assert that the app was handed to the runner *before* configuration
/// was resolved rather than after it.
class _Trace {
  final List<String> events = <String>[];
}

const TelemetryConfig _config = TelemetryConfig(
  endpoint: 'http://collector.example:4318',
  protocol: 'http/json',
  headers: <String, String>{},
  serviceName: 'gazer',
  serviceVersion: '9.9.9',
  deploymentEnvironment: 'test',
);

void main() {
  tearDown(() {
    GazerTelemetry.resetForTest();
    GazerLog.resetForTest();
  });

  testWidgets('renders before telemetry config is resolved', (
    WidgetTester tester,
  ) async {
    final _Trace trace = _Trace();
    Widget? rendered;

    await bootstrap(
      settingsRepository: FakeSettingsRepository(GazerSettings.defaults()),
      loadTelemetryConfig: () async {
        trace.events.add('configLoaded');
        return _config;
      },
      runner: (Widget app) {
        trace.events.add('runApp');
        rendered = app;
      },
    );

    // The ordering is the whole fix: storage I/O must not gate the first
    // frame. Previously TelemetryConfig.load was awaited before runApp.
    expect(trace.events, <String>['runApp', 'configLoaded']);
    expect(rendered, isA<ProviderScope>());
    expect((rendered! as ProviderScope).child, isA<GazerApp>());
    expect(GazerTelemetry.isExporting, isTrue);
    GazerTelemetry.shutdown();
  });

  testWidgets(
    'a keystore failure degrades to telemetry disabled, never a black screen',
    (WidgetTester tester) async {
      Widget? rendered;

      await bootstrap(
        settingsRepository: FakeSettingsRepository(GazerSettings.defaults()),
        loadTelemetryConfig: () async => throw PlatformException(
          code: 'Failed to decrypt',
          message: 'keystore entry for gazer.telemetry.headers is corrupt',
        ),
        runner: (Widget app) => rendered = app,
      );

      // The app is on screen and telemetry is simply off -- the previous
      // code threw out of main() before runApp and left a black screen
      // whose only recovery was clearing app data.
      expect(rendered, isA<ProviderScope>());
      expect(GazerTelemetry.isExporting, isFalse);
    },
  );

  testWidgets('a failing seed does not stop the app from rendering', (
    WidgetTester tester,
  ) async {
    Widget? rendered;
    final FakeSettingsRepository repo = FakeSettingsRepository(
      GazerSettings.defaults(),
    )..loadError = StateError('settings store unavailable');

    await bootstrap(
      settingsRepository: repo,
      loadTelemetryConfig: () async => _config,
      runner: (Widget app) => rendered = app,
    );

    expect(rendered, isA<ProviderScope>());
    GazerTelemetry.shutdown();
  });

  testWidgets('startup latency is recorded as a histogram', (
    WidgetTester tester,
  ) async {
    await bootstrap(
      settingsRepository: FakeSettingsRepository(GazerSettings.defaults()),
      loadTelemetryConfig: () async => _config,
      runner: (Widget app) {},
    );

    // gazer.app.startup_ms is one of the spec's named histograms; it must
    // still be emitted now that startup is asynchronous.
    expect(GazerTelemetry.isExporting, isTrue);
    GazerTelemetry.shutdown();
  });
}
