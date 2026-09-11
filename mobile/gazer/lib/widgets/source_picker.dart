import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../pigeon/pipeline.g.dart';

/// Lists selectable video sources (M1: back/front camera only) as
/// radio-style tiles.
///
/// [devices] comes from `videoDevicesProvider`; [selectedId] is the
/// currently-chosen `VideoDevice.id`; [onSelected] fires with the tapped
/// device's id.
class SourcePicker extends StatelessWidget {
  const SourcePicker({
    super.key,
    required this.devices,
    required this.selectedId,
    required this.onSelected,
  });

  final List<VideoDevice> devices;
  final String? selectedId;
  final ValueChanged<String> onSelected;

  /// Display name for [d]: a localized string for the built-in cameras,
  /// and the device's own reported product name for UVC sources.
  String _labelFor(AppLocalizations l10n, VideoDevice d) {
    return switch (d.kind) {
      VideoDeviceKind.backCamera => l10n.sourceBackCameraLabel,
      VideoDeviceKind.frontCamera => l10n.sourceFrontCameraLabel,
      VideoDeviceKind.uvcCamera2 || VideoDeviceKind.uvcLibuvc => d.name,
    };
  }

  @override
  Widget build(BuildContext context) {
    final AppLocalizations l10n = AppLocalizations.of(context);
    // `RadioListTile.groupValue`/`onChanged` were deprecated in Flutter
    // 3.32 in favour of a single `RadioGroup` ancestor managing the whole
    // group — see radio_list_tile.dart's deprecation notice. `onChanged`
    // only ever fires with a non-null id here since none of these tiles
    // are toggleable.
    return RadioGroup<String>(
      groupValue: selectedId,
      onChanged: (String? id) {
        if (id != null) onSelected(id);
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              l10n.sourcePickerTitle,
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          if (devices.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                l10n.sourcePickerEmptyLabel,
                key: const Key('sourcePickerEmpty'),
              ),
            ),
          // No wrapping `Semantics` here, deliberately: RadioListTile
          // already exposes its title as the label plus the `checked` /
          // `inMutuallyExclusiveGroup` flags and the tap action. An outer
          // node announced the device name a second time ("Back camera
          // camera source"), and excluding the child's semantics to stop
          // that would also drop the radio role and the tap action.
          for (final VideoDevice d in devices)
            RadioListTile<String>(
              // 'camera:back' gets the fixed integration_test key; every
              // other tile still gets a stable per-device key so the list
              // never relies on Flutter's positional fallback.
              key: d.id == 'camera:back'
                  ? const Key('backCameraOption')
                  : ValueKey(d.id),
              value: d.id,
              title: Text(_labelFor(l10n, d)),
            ),
        ],
      ),
    );
  }
}
