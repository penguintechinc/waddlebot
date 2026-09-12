// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'telemetry_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, type=warning
/// Loads the resolved [TelemetryConfig] (Settings override > --dart-define
/// > default) and applies it via `GazerTelemetry.init` as a side effect --
/// so simply reading this provider once is what turns telemetry on for the
/// widget tree. `keepAlive: true`: telemetry must stay configured across
/// every screen for the app's lifetime, same rationale as
/// `licenseProvider`/`settingsNotifierProvider` (Task 12).
///
/// Not directly unit-tested -- its body calls `PackageInfo.fromPlatform()`
/// and touches real `shared_preferences`/`flutter_secure_storage` plugins,
/// so it is exercised only via `.overrideWith(...)` in downstream widget
/// tests (`SettingsScreen`/`StatusPanel`), matching the plan's established
/// leaf-provider testing boundary (`licenseClientProvider`,
/// `updateCheckerProvider`).

@ProviderFor(telemetryConfig)
final telemetryConfigProvider = TelemetryConfigProvider._();

/// Loads the resolved [TelemetryConfig] (Settings override > --dart-define
/// > default) and applies it via `GazerTelemetry.init` as a side effect --
/// so simply reading this provider once is what turns telemetry on for the
/// widget tree. `keepAlive: true`: telemetry must stay configured across
/// every screen for the app's lifetime, same rationale as
/// `licenseProvider`/`settingsNotifierProvider` (Task 12).
///
/// Not directly unit-tested -- its body calls `PackageInfo.fromPlatform()`
/// and touches real `shared_preferences`/`flutter_secure_storage` plugins,
/// so it is exercised only via `.overrideWith(...)` in downstream widget
/// tests (`SettingsScreen`/`StatusPanel`), matching the plan's established
/// leaf-provider testing boundary (`licenseClientProvider`,
/// `updateCheckerProvider`).

final class TelemetryConfigProvider
    extends
        $FunctionalProvider<
          AsyncValue<TelemetryConfig>,
          TelemetryConfig,
          FutureOr<TelemetryConfig>
        >
    with $FutureModifier<TelemetryConfig>, $FutureProvider<TelemetryConfig> {
  /// Loads the resolved [TelemetryConfig] (Settings override > --dart-define
  /// > default) and applies it via `GazerTelemetry.init` as a side effect --
  /// so simply reading this provider once is what turns telemetry on for the
  /// widget tree. `keepAlive: true`: telemetry must stay configured across
  /// every screen for the app's lifetime, same rationale as
  /// `licenseProvider`/`settingsNotifierProvider` (Task 12).
  ///
  /// Not directly unit-tested -- its body calls `PackageInfo.fromPlatform()`
  /// and touches real `shared_preferences`/`flutter_secure_storage` plugins,
  /// so it is exercised only via `.overrideWith(...)` in downstream widget
  /// tests (`SettingsScreen`/`StatusPanel`), matching the plan's established
  /// leaf-provider testing boundary (`licenseClientProvider`,
  /// `updateCheckerProvider`).
  TelemetryConfigProvider._()
    : super(
        from: null,
        argument: null,
        retry: null,
        name: r'telemetryConfigProvider',
        isAutoDispose: false,
        dependencies: null,
        $allTransitiveDependencies: null,
      );

  @override
  String debugGetCreateSourceHash() => _$telemetryConfigHash();

  @$internal
  @override
  $FutureProviderElement<TelemetryConfig> $createElement(
    $ProviderPointer pointer,
  ) => $FutureProviderElement(pointer);

  @override
  FutureOr<TelemetryConfig> create(Ref ref) {
    return telemetryConfig(ref);
  }
}

String _$telemetryConfigHash() => r'bf0da4b6ad449a7b0344af21a1ca490c9d3890c4';

/// Live telemetry export health for the status panel.
///
/// Bridges `GazerTelemetry.health` -- a [ValueListenable] on a static
/// facade -- into the provider graph, so a widget watches a provider
/// instead of reading mutable statics during `build()` and actually
/// rebuilds when export health changes.
///
/// Watching [telemetryConfigProvider] is load-bearing, not incidental:
/// reading it is what resolves and applies the config, and therefore what
/// decides whether health starts out `disabled`. A widget watching this
/// notifier gets that side effect transitively.

@ProviderFor(TelemetryHealthNotifier)
final telemetryHealthProvider = TelemetryHealthNotifierProvider._();

/// Live telemetry export health for the status panel.
///
/// Bridges `GazerTelemetry.health` -- a [ValueListenable] on a static
/// facade -- into the provider graph, so a widget watches a provider
/// instead of reading mutable statics during `build()` and actually
/// rebuilds when export health changes.
///
/// Watching [telemetryConfigProvider] is load-bearing, not incidental:
/// reading it is what resolves and applies the config, and therefore what
/// decides whether health starts out `disabled`. A widget watching this
/// notifier gets that side effect transitively.
final class TelemetryHealthNotifierProvider
    extends $NotifierProvider<TelemetryHealthNotifier, TelemetryHealth> {
  /// Live telemetry export health for the status panel.
  ///
  /// Bridges `GazerTelemetry.health` -- a [ValueListenable] on a static
  /// facade -- into the provider graph, so a widget watches a provider
  /// instead of reading mutable statics during `build()` and actually
  /// rebuilds when export health changes.
  ///
  /// Watching [telemetryConfigProvider] is load-bearing, not incidental:
  /// reading it is what resolves and applies the config, and therefore what
  /// decides whether health starts out `disabled`. A widget watching this
  /// notifier gets that side effect transitively.
  TelemetryHealthNotifierProvider._()
    : super(
        from: null,
        argument: null,
        retry: null,
        name: r'telemetryHealthProvider',
        isAutoDispose: false,
        dependencies: null,
        $allTransitiveDependencies: null,
      );

  @override
  String debugGetCreateSourceHash() => _$telemetryHealthNotifierHash();

  @$internal
  @override
  TelemetryHealthNotifier create() => TelemetryHealthNotifier();

  /// {@macro riverpod.override_with_value}
  Override overrideWithValue(TelemetryHealth value) {
    return $ProviderOverride(
      origin: this,
      providerOverride: $SyncValueProvider<TelemetryHealth>(value),
    );
  }
}

String _$telemetryHealthNotifierHash() =>
    r'61633ce21c2c174365b1fec88a5c5b1dbd2f4e15';

/// Live telemetry export health for the status panel.
///
/// Bridges `GazerTelemetry.health` -- a [ValueListenable] on a static
/// facade -- into the provider graph, so a widget watches a provider
/// instead of reading mutable statics during `build()` and actually
/// rebuilds when export health changes.
///
/// Watching [telemetryConfigProvider] is load-bearing, not incidental:
/// reading it is what resolves and applies the config, and therefore what
/// decides whether health starts out `disabled`. A widget watching this
/// notifier gets that side effect transitively.

abstract class _$TelemetryHealthNotifier extends $Notifier<TelemetryHealth> {
  TelemetryHealth build();
  @$mustCallSuper
  @override
  WhenComplete runBuild() {
    final ref = this.ref as $Ref<TelemetryHealth, TelemetryHealth>;
    final element =
        ref.element
            as $ClassProviderElement<
              AnyNotifier<TelemetryHealth, TelemetryHealth>,
              TelemetryHealth,
              Object?,
              Object?
            >;
    return element.handleCreate(ref, build);
  }
}
