import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../models/pipeline_state.dart';

/// Colour-coded chip summarising the current [PipelineState].
///
/// Tapping it invokes [onTap] — [HomeScreen] wires this to
/// `showStatusPanel`. Colours: idle/ready/stopping = grey, preparing =
/// amber, connecting = blue, streaming = green, reconnecting = orange,
/// error = red (per spec).
class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.state, required this.onTap});

  final PipelineState state;

  /// Tap handler, or `null` where the chip has nothing to open — at the
  /// tablet breakpoint the status panel is already a persistent pane, so a
  /// tappable-but-inert chip would be focusable for no purpose.
  final VoidCallback? onTap;

  /// Chip background colour for [s]; exhaustive over [PipelineState] with
  /// no `default:` arm so a new state cannot silently fall through.
  Color _colorFor(PipelineState s) {
    return switch (s) {
      IdleState() => Colors.grey,
      PreparingState() => Colors.amber,
      ReadyState() => Colors.grey,
      ConnectingState() => Colors.blue,
      StreamingState() => Colors.green,
      ReconnectingState() => Colors.orange,
      StoppingState() => Colors.grey,
      ErrorState() => Colors.red,
    };
  }

  /// Localized chip text for [s]; exhaustive over [PipelineState] for the
  /// same reason [_colorFor] is.
  String _labelFor(AppLocalizations l10n, PipelineState s) {
    return switch (s) {
      IdleState() => l10n.statusChipIdleLabel,
      PreparingState() => l10n.statusChipPreparingLabel,
      ReadyState() => l10n.statusChipReadyLabel,
      ConnectingState() => l10n.statusChipConnectingLabel,
      StreamingState() => l10n.statusChipStreamingLabel,
      ReconnectingState() => l10n.statusChipReconnectingLabel,
      StoppingState() => l10n.statusChipStoppingLabel,
      ErrorState() => l10n.statusChipErrorLabel,
    };
  }

  @override
  Widget build(BuildContext context) {
    final AppLocalizations l10n = AppLocalizations.of(context);
    final String label = _labelFor(l10n, state);
    return Semantics(
      key: const Key('statusChip'),
      label: l10n.statusChipSemanticsLabel(label),
      button: onTap != null,
      // The Chip's own Text is announced by the explicit label above;
      // without this the state reads twice ("Stream status: Idle. Idle.").
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Chip(
          backgroundColor: _colorFor(state),
          label: Text(label, style: const TextStyle(color: Colors.black)),
        ),
      ),
    );
  }
}
