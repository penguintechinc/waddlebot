import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gazer/telemetry/gazer_telemetry.dart';
import 'package:gazer/telemetry/telemetry_config.dart';

/// An attribute value whose `toString()` throws, so a batch containing it
/// fails encoding and is dropped rather than retried.
class _ThrowingToString {
  @override
  String toString() => throw StateError('toString() deliberately throws');
}

TelemetryConfig _configFor(String endpoint) => TelemetryConfig(
  endpoint: endpoint,
  protocol: 'http/json',
  headers: const <String, String>{},
  serviceName: 'gazer-test',
  serviceVersion: '0.0.0',
  deploymentEnvironment: 'test',
);

/// Binds then immediately closes a server, yielding a port nothing is
/// listening on -- a guaranteed connection-refused rather than a flaky
/// guessed-unused port.
Future<int> _deadPort() async {
  final HttpServer probe = await HttpServer.bind(
    InternetAddress.loopbackIPv4,
    0,
  );
  final int port = probe.port;
  await probe.close(force: true);
  return port;
}

void main() {
  tearDown(GazerTelemetry.resetForTest);

  test('health is disabled while no endpoint is configured', () {
    GazerTelemetry.init(_configFor(''), dio: Dio());

    expect(GazerTelemetry.health.value.status, TelemetryHealthStatus.disabled);
  });

  test('health is ok after a cycle whose POSTs all succeeded', () async {
    final HttpServer server = await HttpServer.bind(
      InternetAddress.loopbackIPv4,
      0,
    );
    final StreamSubscription<HttpRequest> subscription = server.listen((
      HttpRequest request,
    ) async {
      await utf8.decoder.bind(request).join();
      request.response.statusCode = 200;
      await request.response.close();
    });
    addTearDown(() async {
      await server.close(force: true);
      await subscription.cancel();
    });

    GazerTelemetry.init(
      _configFor('http://127.0.0.1:${server.port}'),
      dio: Dio(),
    );
    GazerTelemetry.recordLog('info', 'test.log', const <String, Object?>{});
    await GazerTelemetry.flush();

    expect(GazerTelemetry.health.value.status, TelemetryHealthStatus.ok);
  });

  test('a collector that succeeds once and then dies reads as degraded, not exporting', () async {
    // The case the old status-panel arithmetic got wrong: it asked
    // `exportFailures > 0 && exportSuccesses == 0`, so one historical
    // success masked every later failure forever.
    final HttpServer server = await HttpServer.bind(
      InternetAddress.loopbackIPv4,
      0,
    );
    final StreamSubscription<HttpRequest> subscription = server.listen((
      HttpRequest request,
    ) async {
      await utf8.decoder.bind(request).join();
      request.response.statusCode = 200;
      await request.response.close();
    });

    GazerTelemetry.init(
      _configFor('http://127.0.0.1:${server.port}'),
      dio: Dio(),
    );
    GazerTelemetry.recordLog('info', 'test.log', const <String, Object?>{});
    await GazerTelemetry.flush();
    expect(GazerTelemetry.health.value.status, TelemetryHealthStatus.ok);
    expect(GazerTelemetry.exportSuccesses, greaterThanOrEqualTo(1));

    // The collector goes away for good.
    await server.close(force: true);
    await subscription.cancel();
    GazerTelemetry.recordLog('info', 'test.log.2', const <String, Object?>{});
    await GazerTelemetry.flush();

    final TelemetryHealth health = GazerTelemetry.health.value;
    expect(health.status, TelemetryHealthStatus.degraded);
    expect(health.transportFailures, greaterThanOrEqualTo(1));
    expect(health.lastError, 'transport:logs');
  });

  test(
    'a dropped-on-encode batch degrades health even while transport is fine',
    () async {
      // encodeFailures surfaced nowhere in the app before: the batch is
      // dropped and never retried, so this signal is the only evidence it
      // ever happened.
      final HttpServer server = await HttpServer.bind(
        InternetAddress.loopbackIPv4,
        0,
      );
      final StreamSubscription<HttpRequest> subscription = server.listen((
        HttpRequest request,
      ) async {
        await utf8.decoder.bind(request).join();
        request.response.statusCode = 200;
        await request.response.close();
      });
      addTearDown(() async {
        await server.close(force: true);
        await subscription.cancel();
      });

      GazerTelemetry.init(
        _configFor('http://127.0.0.1:${server.port}'),
        dio: Dio(),
      );
      GazerTelemetry.recordLog('info', 'test.log', <String, Object?>{
        'bad': _ThrowingToString(),
      });
      await GazerTelemetry.flush();

      final TelemetryHealth health = GazerTelemetry.health.value;
      expect(health.status, TelemetryHealthStatus.degraded);
      expect(health.encodeFailures, 1);
    },
  );

  test('health notifies its listeners when export health changes', () async {
    final List<TelemetryHealthStatus> seen = <TelemetryHealthStatus>[];
    void listener() => seen.add(GazerTelemetry.health.value.status);
    GazerTelemetry.health.addListener(listener);
    addTearDown(() => GazerTelemetry.health.removeListener(listener));

    GazerTelemetry.init(
      _configFor('http://127.0.0.1:${await _deadPort()}'),
      dio: Dio(),
    );
    GazerTelemetry.recordLog('info', 'test.log', const <String, Object?>{});
    await GazerTelemetry.flush();

    expect(seen, contains(TelemetryHealthStatus.ok));
    expect(seen.last, TelemetryHealthStatus.degraded);
  });

  test('an overlapping flush is skipped instead of double-exporting the same batch', () async {
    int logRequests = 0;
    final Completer<void> holdFirst = Completer<void>();

    final HttpServer server = await HttpServer.bind(
      InternetAddress.loopbackIPv4,
      0,
    );
    final StreamSubscription<HttpRequest> subscription = server.listen((
      HttpRequest request,
    ) async {
      await utf8.decoder.bind(request).join();
      if (request.uri.path == '/v1/logs') {
        logRequests += 1;
        // Hold only the first POST open, simulating the black-holed
        // collector the spec calls out. Holding every POST would deadlock
        // the unguarded code rather than let it fail with a count.
        if (logRequests == 1) await holdFirst.future;
      }
      request.response.statusCode = 200;
      await request.response.close();
    });
    addTearDown(() async {
      await server.close(force: true);
      await subscription.cancel();
    });

    GazerTelemetry.init(
      _configFor('http://127.0.0.1:${server.port}'),
      dio: Dio(),
    );
    GazerTelemetry.recordLog('info', 'test.log', const <String, Object?>{
      'k': 'v',
    });

    final Future<void> first = GazerTelemetry.flush();
    // Let the first POST actually reach the server before the second
    // tick fires, so the overlap is real rather than a race.
    await Future<void>.delayed(const Duration(milliseconds: 50));
    final Future<void> second = GazerTelemetry.flush();
    await second;
    holdFirst.complete();

    // Unguarded, the second flush snapshots the same record, POSTs it
    // again, and then both flushes remove by index -- the second removal
    // throwing RangeError inside a Timer.periodic callback.
    await expectLater(first, completes);
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(logRequests, 1, reason: 'the overlapping flush must not re-send');
  });

  test(
    'a record appended during an in-flight flush survives the batch removal',
    () async {
      // The buffer can shift under an outstanding POST; removing the sent
      // batch by position would then discard records that were never sent.
      final List<String> receivedEvents = <String>[];
      final Completer<void> holdFirst = Completer<void>();
      int logRequests = 0;

      final HttpServer server = await HttpServer.bind(
        InternetAddress.loopbackIPv4,
        0,
      );
      final StreamSubscription<HttpRequest> subscription = server.listen((
        HttpRequest request,
      ) async {
        final String body = await utf8.decoder.bind(request).join();
        if (request.uri.path == '/v1/logs') {
          logRequests += 1;
          final Map<String, dynamic> decoded =
              jsonDecode(body) as Map<String, dynamic>;
          for (final rl in decoded['resourceLogs'] as List) {
            for (final sl
                in (rl as Map<String, dynamic>)['scopeLogs'] as List) {
              for (final lr
                  in (sl as Map<String, dynamic>)['logRecords'] as List) {
                receivedEvents.add(
                  ((lr as Map<String, dynamic>)['body']
                          as Map<String, dynamic>)['stringValue']
                      as String,
                );
              }
            }
          }
          if (logRequests == 1) await holdFirst.future;
        }
        request.response.statusCode = 200;
        await request.response.close();
      });
      addTearDown(() async {
        await server.close(force: true);
        await subscription.cancel();
      });

      GazerTelemetry.init(
        _configFor('http://127.0.0.1:${server.port}'),
        dio: Dio(),
      );
      GazerTelemetry.recordLog('info', 'first', const <String, Object?>{});

      final Future<void> first = GazerTelemetry.flush();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      GazerTelemetry.recordLog('info', 'second', const <String, Object?>{});
      holdFirst.complete();
      await first;

      await GazerTelemetry.flush();
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(receivedEvents, containsAllInOrder(<String>['first', 'second']));
    },
  );
}
