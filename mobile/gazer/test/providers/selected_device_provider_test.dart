import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gazer/providers/selected_device_provider.dart';

void main() {
  late ProviderContainer container;

  setUp(() {
    container = ProviderContainer();
    addTearDown(container.dispose);
  });

  test('starts with no selection', () {
    expect(container.read(selectedDeviceProvider), isNull);
  });

  test('select records an explicit pick and overwrites a previous one', () {
    final SelectedDevice notifier = container.read(
      selectedDeviceProvider.notifier,
    );
    notifier.select('camera:back');
    expect(container.read(selectedDeviceProvider), 'camera:back');
    notifier.select('camera:front');
    expect(container.read(selectedDeviceProvider), 'camera:front');
  });

  test('selectDefaultIfUnset latches only the first enumeration', () {
    final SelectedDevice notifier = container.read(
      selectedDeviceProvider.notifier,
    );
    notifier.selectDefaultIfUnset('camera:back');
    expect(container.read(selectedDeviceProvider), 'camera:back');

    // A later enumeration must not silently move the user's camera.
    notifier.selectDefaultIfUnset('uvc:1');
    expect(container.read(selectedDeviceProvider), 'camera:back');
  });

  test('selectDefaultIfUnset never overrides an explicit pick', () {
    final SelectedDevice notifier = container.read(
      selectedDeviceProvider.notifier,
    );
    notifier.select('camera:front');
    notifier.selectDefaultIfUnset('camera:back');
    expect(container.read(selectedDeviceProvider), 'camera:front');
  });
}
