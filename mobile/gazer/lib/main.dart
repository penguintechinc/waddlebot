import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'config/seed.dart';
import 'services/gazer_log.dart';
import 'services/settings_repository.dart';
import 'telemetry/gazer_telemetry.dart';
import 'telemetry/telemetry_config.dart';

/// Entry point for the Gazer mobile app; all of the work is in [bootstrap].
void main() => unawaited(bootstrap());

/// Brings the app up: renders the widget tree, then resolves configuration.
///
/// The ordering is the point. Storage I/O must never gate the first frame:
/// `flutter_secure_storage` throws a `PlatformException` on Android when
/// its keystore entry is corrupt -- a documented field failure whose only
/// user-side recovery is clearing app data -- and reading telemetry
/// headers before `runApp` turned that into a black screen with no UI, no
/// error, and no way out. Telemetry is the least important thing in the
/// app and now loads after the tree is on screen, degrading to "export
/// disabled" plus a sanitized log if anything in that path fails.
///
/// The one await that still precedes rendering is [applySeedIfRequested],
/// which must land before the widget tree's first settings read. It is a
/// debug-only, `--dart-define=GAZER_SEED=true`-only path: a release build
/// returns from it without touching storage at all, and it is guarded
/// regardless.
///
/// [settingsRepository], [loadTelemetryConfig], and [runner] are injection
/// points for tests; production uses the real platform-backed defaults.
/// The returned future completes once telemetry has been resolved -- the
/// app is already rendered well before that.
Future<void> bootstrap({
  SettingsRepository? settingsRepository,
  Future<TelemetryConfig> Function()? loadTelemetryConfig,
  void Function(Widget app) runner = runApp,
}) async {
  final Stopwatch startupTimer = Stopwatch()..start();
  WidgetsFlutterBinding.ensureInitialized();

  await _applySeed(settingsRepository ?? _platformSettingsRepository());

  runner(const ProviderScope(child: GazerApp()));

  await _startTelemetry(
    startupTimer,
    loadTelemetryConfig ?? _platformTelemetryConfig,
  );
}

/// The real, platform-backed settings repository: secrets in the
/// keystore, everything else in shared_preferences.
SettingsRepository _platformSettingsRepository() => SecureSettingsRepository(
  secure: const FlutterSecureStorage(),
  prefs: SharedPreferencesAsync(),
);

/// Resolves [TelemetryConfig] from this app's version plus the persisted
/// Settings > Developer overrides.
Future<TelemetryConfig> _platformTelemetryConfig() async {
  final PackageInfo packageInfo = await PackageInfo.fromPlatform();
  return TelemetryConfig.load(
    prefs: SharedPreferencesAsync(),
    secure: const FlutterSecureStorage(),
    serviceVersion: packageInfo.version,
  );
}

/// Applies the debug seed, swallowing any storage failure: a seeding
/// problem is a development-time inconvenience, never a reason to refuse
/// to start.
Future<void> _applySeed(SettingsRepository repo) async {
  try {
    await applySeedIfRequested(repo);
  } catch (error) {
    GazerLog.warn('startup.seedFailed', <String, Object?>{
      'reason': error.runtimeType.toString(),
    });
  }
}

/// Resolves and applies telemetry config off the first-frame path, then
/// records the resulting startup latency as `gazer.app.startup_ms`.
///
/// A failure leaves [GazerTelemetry] on its inert default -- export
/// disabled, every signal still buffered in memory -- and logs only the
/// error's *type*: a storage exception's message can quote the key it
/// failed on, and this path handles the telemetry headers, which carry an
/// auth token.
Future<void> _startTelemetry(
  Stopwatch startupTimer,
  Future<TelemetryConfig> Function() load,
) async {
  try {
    GazerTelemetry.init(await load());
  } catch (error) {
    GazerLog.warn('startup.telemetryDisabled', <String, Object?>{
      'reason': error.runtimeType.toString(),
    });
  }
  startupTimer.stop();
  GazerTelemetry.histogram(
    'gazer.app.startup_ms',
    startupTimer.elapsedMilliseconds.toDouble(),
  );
}
