import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_libs/flutter_libs.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'l10n/app_localizations.dart';
import 'providers/license_provider.dart';
import 'screens/home_screen.dart';
import 'screens/settings_screen.dart';

/// Route table for the app: `'/'` → [HomeScreen], `'/settings'` →
/// [SettingsScreen]. Declared at file scope (rather than inside
/// [GazerApp]) so [GazerApp] stays `const` and tests share one instance.
///
/// [GoRouter.errorBuilder] is set so an unknown route renders a localized
/// screen with a way back, instead of go_router's own unlocalized default
/// error page.
final GoRouter gazerRouter = GoRouter(
  initialLocation: '/',
  errorBuilder: (BuildContext context, GoRouterState state) =>
      const _RouteNotFoundScreen(),
  routes: <RouteBase>[
    GoRoute(
      path: '/',
      name: 'home',
      builder: (BuildContext context, GoRouterState state) =>
          const HomeScreen(),
    ),
    GoRoute(
      path: '/settings',
      name: 'settings',
      builder: (BuildContext context, GoRouterState state) =>
          const SettingsScreen(),
    ),
  ],
);

/// Root widget for the Gazer mobile app.
///
/// Wires go_router navigation, the Elder theme, and the generated
/// [AppLocalizations] delegates. `ElderThemeData` (flutter_libs) is a
/// [ThemeExtension], not a [ThemeData], so it is installed via
/// `ThemeData(...).copyWith(extensions: [ElderThemeData.dark])`.
/// `themeMode` is [ThemeMode.system] but both `theme` and `darkTheme` are
/// set to the same Elder-dark [ThemeData], so the app renders dark
/// regardless of the platform brightness setting (house rule: dark
/// default for client apps with a single supported theme).
class GazerApp extends ConsumerStatefulWidget {
  const GazerApp({super.key});

  // `static final`, not a getter: a getter allocated a fresh ThemeData on
  // every build of GazerApp, and the theme never varies.
  static final ThemeData _elderDarkTheme = ThemeData.dark().copyWith(
    scaffoldBackgroundColor: ElderThemeData.dark.pageBackground,
    colorScheme: ThemeData.dark().colorScheme.copyWith(
      primary: ElderThemeData.dark.primaryButton,
      onPrimary: ElderThemeData.dark.primaryButtonText,
      error: ElderThemeData.dark.errorText,
    ),
    extensions: <ThemeExtension<dynamic>>[ElderThemeData.dark],
  );

  @override
  ConsumerState<GazerApp> createState() => _GazerAppState();
}

/// Owns the app-wide [KeepaliveScheduler] lifecycle: starts it once the
/// first [licenseProvider] fetch resolves (success or degraded/offline —
/// [LicenseClient] never throws), then starts/stops it on every
/// subsequent foreground/background transition via
/// [WidgetsBindingObserver].
class _GazerAppState extends ConsumerState<GazerApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_startKeepaliveAfterFirstFetch());
  }

  /// Awaits the first [licenseProvider] resolution, then starts the
  /// keepalive loop -- pinging before the first fetch settles would race
  /// the device-id/cache setup [LicenseClient] performs on that call.
  Future<void> _startKeepaliveAfterFirstFetch() async {
    try {
      await ref.read(licenseProvider.future);
    } catch (_) {
      // LicenseClient never throws by contract; if this ever fires we
      // still want the keepalive loop foregrounded rather than silently
      // never starting.
    }
    if (!mounted) return;
    ref.read(keepaliveSchedulerProvider).start();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    ref.read(keepaliveSchedulerProvider).onLifecycle(state);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      onGenerateTitle: (BuildContext context) =>
          AppLocalizations.of(context).appTitle,
      theme: GazerApp._elderDarkTheme,
      darkTheme: GazerApp._elderDarkTheme,
      themeMode: ThemeMode.system,
      debugShowCheckedModeBanner: false,
      routerConfig: gazerRouter,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
    );
  }
}

/// Fallback screen for an unmatched route: a localized message plus a
/// button back to [HomeScreen], so a bad deep link never strands the user
/// on go_router's untranslated default error page.
class _RouteNotFoundScreen extends StatelessWidget {
  const _RouteNotFoundScreen();

  @override
  Widget build(BuildContext context) {
    final AppLocalizations l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.routeNotFoundTitle)),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(l10n.routeNotFoundMessage),
            const SizedBox(height: 16),
            FilledButton(
              key: const Key('routeNotFoundHomeButton'),
              onPressed: () => gazerRouter.go('/'),
              child: Text(l10n.routeNotFoundHomeLabel),
            ),
          ],
        ),
      ),
    );
  }
}
