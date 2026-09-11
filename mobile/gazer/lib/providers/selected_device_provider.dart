import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'selected_device_provider.g.dart';

/// The video device id the user is currently streaming from, lifted out of
/// `HomeScreen`'s widget state so both the source picker and `StatusPanel`
/// read one selection instead of each guessing (the panel previously
/// reported `devices.first`, which is wrong whenever the front camera is
/// picked).
///
/// `keepAlive: true`: the selection must survive navigating to Settings and
/// back, where nothing in the tree watches this provider.
@Riverpod(keepAlive: true)
class SelectedDevice extends _$SelectedDevice {
  @override
  String? build() => null;

  /// Records an explicit pick from the source picker.
  void select(String id) {
    state = id;
  }

  /// Latches [id] as the initial selection the first time the device list
  /// enumerates; a no-op once anything is selected.
  ///
  /// Deliberately sticky: M1 has no hot-plug refresh, so a device list that
  /// later empties must not silently clear the selection —
  /// `PipelineController.goLive`'s own `devices.any(...)` check is what
  /// surfaces a vanished device, with a message, rather than a Go Live
  /// button that quietly greys out.
  void selectDefaultIfUnset(String id) {
    if (state == null) {
      state = id;
    }
  }
}
