import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

/// Installs an in-memory `shared_preferences` backend and returns a client
/// bound to it, so a test can exercise real persistence without a
/// platform channel.
///
/// This is the fake the app's own code supports: both
/// `SecureSettingsRepository` and `TelemetryConfig` go through
/// [SharedPreferencesAsync], whose platform interface is swappable --
/// `SharedPreferences.setMockInitialValues` targets the legacy
/// synchronous API these never touch, so it would silently do nothing.
///
/// Pass [initial] to pre-populate the store (values must be `String`,
/// `int`, `double`, `bool`, or `List<String>`, matching what
/// shared_preferences can hold). The platform instance is global, so call
/// this in `setUp` rather than once per file: whatever a previous test
/// installed otherwise leaks into the next one.
SharedPreferencesAsync useFakeSharedPreferences([
  Map<String, Object>? initial,
]) {
  SharedPreferencesAsyncPlatform.instance = initial == null
      ? InMemorySharedPreferencesAsync.empty()
      : InMemorySharedPreferencesAsync.withData(initial);
  return SharedPreferencesAsync();
}
