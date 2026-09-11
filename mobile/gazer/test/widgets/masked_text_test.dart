import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gazer/widgets/masked_text.dart';

Widget _wrap(String value) => MaterialApp(
  home: Scaffold(
    body: MaskedText(value: value, revealSemanticsLabel: 'Show'),
  ),
);

void main() {
  testWidgets('shows only the last 4 characters by default', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap('abcd1234efgh'));
    expect(find.text('••••••••efgh'), findsOneWidget);
    expect(find.text('abcd1234efgh'), findsNothing);
  });

  testWidgets('reveals the full value when tapped', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap('abcd1234efgh'));
    await tester.tap(find.byIcon(Icons.visibility));
    await tester.pump();
    expect(find.text('abcd1234efgh'), findsOneWidget);
  });

  testWidgets('a value of 4 characters or fewer is masked entirely', (
    WidgetTester tester,
  ) async {
    // The "last 4 visible" rule must not degrade into "show everything"
    // for a short secret.
    await tester.pumpWidget(_wrap('1234'));
    expect(find.text('••••'), findsOneWidget);
    expect(find.text('1234'), findsNothing);

    await tester.pumpWidget(_wrap('ab'));
    expect(find.text('••'), findsOneWidget);
    expect(find.text('ab'), findsNothing);
  });

  testWidgets('an empty value renders empty, not a mask', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_wrap(''));
    expect(find.text(''), findsOneWidget);
    expect(find.text('•'), findsNothing);
  });

  testWidgets('the reveal toggle excludes its child semantics so the button '
      'is announced once, not twice', (WidgetTester tester) async {
    await tester.pumpWidget(_wrap('abcd1234efgh'));
    final Semantics wrapper = tester.widget<Semantics>(
      find
          .ancestor(
            of: find.byType(IconButton),
            matching: find.byType(Semantics),
          )
          .first,
    );
    expect(wrapper.excludeSemantics, isTrue);
  });
}
