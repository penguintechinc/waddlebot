// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'connectivity_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, type=warning
/// The [Connectivity] instance the app queries; overridden in tests with a
/// mock that emits a scripted sequence of results.

@ProviderFor(connectivity)
final connectivityProvider = ConnectivityProvider._();

/// The [Connectivity] instance the app queries; overridden in tests with a
/// mock that emits a scripted sequence of results.

final class ConnectivityProvider
    extends $FunctionalProvider<Connectivity, Connectivity, Connectivity>
    with $Provider<Connectivity> {
  /// The [Connectivity] instance the app queries; overridden in tests with a
  /// mock that emits a scripted sequence of results.
  ConnectivityProvider._()
    : super(
        from: null,
        argument: null,
        retry: null,
        name: r'connectivityProvider',
        isAutoDispose: false,
        dependencies: null,
        $allTransitiveDependencies: null,
      );

  @override
  String debugGetCreateSourceHash() => _$connectivityHash();

  @$internal
  @override
  $ProviderElement<Connectivity> $createElement($ProviderPointer pointer) =>
      $ProviderElement(pointer);

  @override
  Connectivity create(Ref ref) {
    return connectivity(ref);
  }

  /// {@macro riverpod.override_with_value}
  Override overrideWithValue(Connectivity value) {
    return $ProviderOverride(
      origin: this,
      providerOverride: $SyncValueProvider<Connectivity>(value),
    );
  }
}

String _$connectivityHash() => r'e66720f09edf1a8b09e450e1eaedd51da9443f0e';

/// Online/offline indicator shown in the status panel: true whenever the
/// device reports any connectivity result other than [ConnectivityResult.none].
///
/// Seeded from [Connectivity.checkConnectivity] before following the change
/// stream: `onConnectivityChanged` only fires when connectivity *changes*,
/// so on a device whose state is stable from launch the indicator had no
/// value at all until something moved. A failing seed is swallowed -- the
/// change stream still supplies a value later, and an indicator is never
/// worth an error state.

@ProviderFor(isOnline)
final isOnlineProvider = IsOnlineProvider._();

/// Online/offline indicator shown in the status panel: true whenever the
/// device reports any connectivity result other than [ConnectivityResult.none].
///
/// Seeded from [Connectivity.checkConnectivity] before following the change
/// stream: `onConnectivityChanged` only fires when connectivity *changes*,
/// so on a device whose state is stable from launch the indicator had no
/// value at all until something moved. A failing seed is swallowed -- the
/// change stream still supplies a value later, and an indicator is never
/// worth an error state.

final class IsOnlineProvider
    extends $FunctionalProvider<AsyncValue<bool>, bool, Stream<bool>>
    with $FutureModifier<bool>, $StreamProvider<bool> {
  /// Online/offline indicator shown in the status panel: true whenever the
  /// device reports any connectivity result other than [ConnectivityResult.none].
  ///
  /// Seeded from [Connectivity.checkConnectivity] before following the change
  /// stream: `onConnectivityChanged` only fires when connectivity *changes*,
  /// so on a device whose state is stable from launch the indicator had no
  /// value at all until something moved. A failing seed is swallowed -- the
  /// change stream still supplies a value later, and an indicator is never
  /// worth an error state.
  IsOnlineProvider._()
    : super(
        from: null,
        argument: null,
        retry: null,
        name: r'isOnlineProvider',
        isAutoDispose: true,
        dependencies: null,
        $allTransitiveDependencies: null,
      );

  @override
  String debugGetCreateSourceHash() => _$isOnlineHash();

  @$internal
  @override
  $StreamProviderElement<bool> $createElement($ProviderPointer pointer) =>
      $StreamProviderElement(pointer);

  @override
  Stream<bool> create(Ref ref) {
    return isOnline(ref);
  }
}

String _$isOnlineHash() => r'95a87eb2fcbce0b26a6158b74654a72f5613dc9c';
