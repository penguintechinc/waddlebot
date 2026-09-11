// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'selected_device_provider.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, type=warning
/// The video device id the user is currently streaming from, lifted out of
/// `HomeScreen`'s widget state so both the source picker and `StatusPanel`
/// read one selection instead of each guessing (the panel previously
/// reported `devices.first`, which is wrong whenever the front camera is
/// picked).
///
/// `keepAlive: true`: the selection must survive navigating to Settings and
/// back, where nothing in the tree watches this provider.

@ProviderFor(SelectedDevice)
final selectedDeviceProvider = SelectedDeviceProvider._();

/// The video device id the user is currently streaming from, lifted out of
/// `HomeScreen`'s widget state so both the source picker and `StatusPanel`
/// read one selection instead of each guessing (the panel previously
/// reported `devices.first`, which is wrong whenever the front camera is
/// picked).
///
/// `keepAlive: true`: the selection must survive navigating to Settings and
/// back, where nothing in the tree watches this provider.
final class SelectedDeviceProvider
    extends $NotifierProvider<SelectedDevice, String?> {
  /// The video device id the user is currently streaming from, lifted out of
  /// `HomeScreen`'s widget state so both the source picker and `StatusPanel`
  /// read one selection instead of each guessing (the panel previously
  /// reported `devices.first`, which is wrong whenever the front camera is
  /// picked).
  ///
  /// `keepAlive: true`: the selection must survive navigating to Settings and
  /// back, where nothing in the tree watches this provider.
  SelectedDeviceProvider._()
    : super(
        from: null,
        argument: null,
        retry: null,
        name: r'selectedDeviceProvider',
        isAutoDispose: false,
        dependencies: null,
        $allTransitiveDependencies: null,
      );

  @override
  String debugGetCreateSourceHash() => _$selectedDeviceHash();

  @$internal
  @override
  SelectedDevice create() => SelectedDevice();

  /// {@macro riverpod.override_with_value}
  Override overrideWithValue(String? value) {
    return $ProviderOverride(
      origin: this,
      providerOverride: $SyncValueProvider<String?>(value),
    );
  }
}

String _$selectedDeviceHash() => r'f140b44fa910ff88ac1bccad98e98ac45f6fe3bc';

/// The video device id the user is currently streaming from, lifted out of
/// `HomeScreen`'s widget state so both the source picker and `StatusPanel`
/// read one selection instead of each guessing (the panel previously
/// reported `devices.first`, which is wrong whenever the front camera is
/// picked).
///
/// `keepAlive: true`: the selection must survive navigating to Settings and
/// back, where nothing in the tree watches this provider.

abstract class _$SelectedDevice extends $Notifier<String?> {
  String? build();
  @$mustCallSuper
  @override
  WhenComplete runBuild() {
    final ref = this.ref as $Ref<String?, String?>;
    final element =
        ref.element
            as $ClassProviderElement<
              AnyNotifier<String?, String?>,
              String?,
              Object?,
              Object?
            >;
    return element.handleCreate(ref, build);
  }
}
