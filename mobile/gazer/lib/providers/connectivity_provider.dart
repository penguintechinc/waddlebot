import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'connectivity_provider.g.dart';

/// The [Connectivity] instance the app queries; overridden in tests with a
/// mock that emits a scripted sequence of results.
@Riverpod(keepAlive: true)
Connectivity connectivity(Ref ref) => Connectivity();

/// Online/offline indicator shown in the status panel: true whenever the
/// device reports any connectivity result other than [ConnectivityResult.none].
///
/// Seeded from [Connectivity.checkConnectivity] before following the change
/// stream: `onConnectivityChanged` only fires when connectivity *changes*,
/// so on a device whose state is stable from launch the indicator had no
/// value at all until something moved. A failing seed is swallowed -- the
/// change stream still supplies a value later, and an indicator is never
/// worth an error state.
@riverpod
Stream<bool> isOnline(Ref ref) async* {
  final connectivityInstance = ref.watch(connectivityProvider);
  try {
    yield _anyOnline(await connectivityInstance.checkConnectivity());
  } catch (_) {
    // No seed available; fall through to the change stream.
  }
  yield* connectivityInstance.onConnectivityChanged.map(_anyOnline);
}

/// Whether [results] report any usable transport.
bool _anyOnline(List<ConnectivityResult> results) =>
    results.any((ConnectivityResult r) => r != ConnectivityResult.none);
