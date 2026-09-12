import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
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

/// A [FakeSettingsRepository] that also counts read attempts, so a test can
/// tell "the seed ran and its failure was swallowed" apart from "the seed
/// never touched the store at all" -- the two are indistinguishable from
/// the rendered tree alone.
class _CountingSettingsRepository extends FakeSettingsRepository {
  _CountingSettingsRepository() : super(GazerSettings.defaults());

  /// Number of [load] calls, successful or throwing.
  int loadAttempts = 0;

  @override
  Future<GazerSettings> load() {
    loadAttempts += 1;
    return super.load();
  }
}

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
    final _CountingSettingsRepository repo = _CountingSettingsRepository()
      ..loadError = StateError('settings store unavailable');

    await bootstrap(
      settingsRepository: repo,
      loadTelemetryConfig: () async => _config,
      runner: (Widget app) => rendered = app,
    );

    expect(rendered, isA<ProviderScope>());

    // applySeedIfRequested is compiled out unless GAZER_SEED is defined, so
    // without asserting which side of that we are on this test proves
    // nothing at all in a plain `flutter test` run. `make mobile-test` and
    // CI both pass --dart-define=GAZER_SEED=true, which is the run that
    // exercises the swallow; assert the real behaviour on both sides so
    // neither run is a free pass.
    if (const bool.fromEnvironment('GAZER_SEED')) {
      expect(
        repo.loadAttempts,
        1,
        reason: 'the seed must have read the store and had its throw caught',
      );
    } else {
      expect(
        repo.loadAttempts,
        0,
        reason: 'a non-seed build must not touch storage before runApp',
      );
    }
    GazerTelemetry.shutdown();
  });

  testWidgets('startup buffers telemetry that a flush actually exports', (
    WidgetTester tester,
  ) async {
    // What this can and cannot assert. `gazer.app.startup_ms` is one of the
    // spec's named histograms and must still be emitted now that startup is
    // asynchronous -- but reading the *name* back requires a real OTLP sink,
    // and TestWidgetsFlutterBinding installs a global HttpOverrides that
    // answers every request with a synthetic 400 and never opens a socket.
    // (Both escape hatches were tried: HttpOverrides.runZoned inside
    // tester.runAsync still never reaches a local HttpServer, and the test
    // then hangs to the 10-minute timeout.) So the name is pinned by
    // test/telemetry/otlp_sink_test.dart -- a binding-free `test()` file
    // with a real sink, which `make mobile-telemetry-check` greps for a
    // non-zero histogram count -- and what is asserted *here* is the half
    // that only bootstrap can prove: startup left something in the export
    // buffers at all. A flush over empty buffers makes no attempt (see
    // _flushBuffer's `if (buffer.isEmpty) return`), so a non-zero attempt
    // count is the evidence.
    final int before =
        GazerTelemetry.exportSuccesses + GazerTelemetry.exportFailures;

    await bootstrap(
      settingsRepository: FakeSettingsRepository(GazerSettings.defaults()),
      loadTelemetryConfig: () async => _config,
      runner: (Widget app) {},
    );
    await tester.runAsync(GazerTelemetry.flush);

    expect(GazerTelemetry.isExporting, isTrue);
    expect(
      GazerTelemetry.exportSuccesses + GazerTelemetry.exportFailures,
      greaterThan(before),
      reason: 'startup recorded no signal at all, so flush had nothing to send',
    );
    GazerTelemetry.shutdown();
  });
}
