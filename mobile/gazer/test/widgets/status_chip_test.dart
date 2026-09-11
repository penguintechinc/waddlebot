import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gazer/l10n/app_localizations.dart';
import 'package:gazer/models/pipeline_state.dart';
import 'package:gazer/widgets/status_chip.dart';

Widget _wrap(Widget child) => MaterialApp(
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: child),
);

/// Every [PipelineState] the sealed hierarchy declares, with the colour and
/// label the spec's chip table requires. Listed exhaustively on purpose:
/// the previous table covered 6 of 8 states (ReadyState and StoppingState
/// were missing) and asserted colour only, so `_labelFor` had no coverage
/// for any state at all.
const Map<String, (PipelineState, Color, String)> _cases =
    <String, (PipelineState, Color, String)>{
      'idle': (IdleState(), Colors.grey, 'Idle'),
      'preparing': (PreparingState(), Colors.amber, 'Preparing'),
      'ready': (ReadyState(), Colors.grey, 'Ready'),
      'connecting': (ConnectingState(), Colors.blue, 'Connecting'),
      'streaming': (StreamingState(), Colors.green, 'Streaming'),
      'reconnecting': (
        ReconnectingState(1, Duration(seconds: 1)),
        Colors.orange,
        'Reconnecting',
      ),
      'stopping': (StoppingState(), Colors.grey, 'Stopping'),
      'error': (
        ErrorState(GazerError(code: GazerErrorCode.unknown)),
        Colors.red,
        'Error',
      ),
    };

void main() {
  testWidgets('renders the correct color and label for all 8 states', (
    WidgetTester tester,
  ) async {
    // Disposed inline, not via addTearDown: flutter_test verifies handle
    // disposal *before* tearDown callbacks run.
    final SemanticsHandle handle = tester.ensureSemantics();
    expect(_cases, hasLength(8));
    for (final MapEntry<String, (PipelineState, Color, String)> entry
        in _cases.entries) {
      final (PipelineState state, Color color, String label) = entry.value;
      await tester.pumpWidget(_wrap(StatusChip(state: state, onTap: () {})));
      final Chip chip = tester.widget<Chip>(find.byType(Chip));
      expect(chip.backgroundColor, color, reason: entry.key);
      expect(find.text(label), findsOneWidget, reason: entry.key);
      expect(
        tester.getSemantics(find.byKey(const Key('statusChip'))).label,
        'Stream status: $label',
        reason: entry.key,
      );
      // excludeSemantics, or the chip's own Text merges in and TalkBack
      // reads the state twice ("Stream status: Idle. Idle.").
      expect(
        tester
            .widget<Semantics>(find.byKey(const Key('statusChip')))
            .excludeSemantics,
        isTrue,
        reason: entry.key,
      );
    }
    handle.dispose();
  });

  testWidgets('tapping the chip invokes onTap', (WidgetTester tester) async {
    bool tapped = false;
    await tester.pumpWidget(
      _wrap(StatusChip(state: const IdleState(), onTap: () => tapped = true)),
    );
    await tester.tap(find.byType(StatusChip));
    expect(tapped, isTrue);
  });

  testWidgets(
    'a null onTap leaves the chip inert instead of advertising a tap that '
    'does nothing (tablet breakpoint)',
    (WidgetTester tester) async {
      await tester.pumpWidget(
        _wrap(const StatusChip(state: IdleState(), onTap: null)),
      );
      // `.first`: Chip builds its own InkWell beneath StatusChip's.
      final InkWell inkWell = tester.widget<InkWell>(
        find
            .descendant(
              of: find.byType(StatusChip),
              matching: find.byType(InkWell),
            )
            .first,
      );
      expect(inkWell.onTap, isNull);
    },
  );
}
