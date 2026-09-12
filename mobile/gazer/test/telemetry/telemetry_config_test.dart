import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gazer/telemetry/telemetry_config.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/fake_shared_preferences.dart';

class _MockPrefs extends Mock implements SharedPreferencesAsync {}

class _MockSecureStorage extends Mock implements FlutterSecureStorage {}

void main() {
  group('TelemetryConfig.resolve', () {
    test(
      'a non-empty settings endpoint wins over the --dart-define default',
      () {
        final config = TelemetryConfig.resolve(
          settingsEndpoint: 'http://collector.example.com:4318',
          settingsHeadersJson: '',
          serviceVersion: '1.2.3',
        );
        expect(config.endpoint, 'http://collector.example.com:4318');
        expect(config.serviceVersion, '1.2.3');
        expect(config.serviceName, 'gazer');
        expect(config.deploymentEnvironment, 'dev');
        expect(config.protocol, 'http/json');
      },
    );

    test('an empty settings endpoint falls back to the --dart-define value (empty when unset)', () {
      final config = TelemetryConfig.resolve(
        settingsEndpoint: '',
        settingsHeadersJson: '',
        serviceVersion: '1.2.3',
      );
      expect(config.endpoint, isEmpty);
    });

    test('settings headers parse as comma-separated key=value pairs and win over the define', () {
      final config = TelemetryConfig.resolve(
        settingsEndpoint: '',
        settingsHeadersJson: 'authorization=Bearer abc,x-tenant=demo',
        serviceVersion: '1.2.3',
      );
      expect(config.headers, {
        'authorization': 'Bearer abc',
        'x-tenant': 'demo',
      });
    });

    test('a malformed header pair (no "=") is skipped, not thrown', () {
      final config = TelemetryConfig.resolve(
        settingsEndpoint: '',
        settingsHeadersJson: 'not-a-pair,authorization=ok',
        serviceVersion: '1.2.3',
      );
      expect(config.headers, {'authorization': 'ok'});
    });
  });

  group('TelemetryConfig.load never throws', () {
    late _MockPrefs prefs;
    late _MockSecureStorage secure;

    setUp(() {
      prefs = _MockPrefs();
      secure = _MockSecureStorage();
    });

    test(
      'a corrupt keystore entry degrades to no headers, not an exception',
      () async {
        // flutter_secure_storage raises this on Android when its keystore
        // entry is unreadable; awaited before runApp it used to leave a
        // black screen with no in-app recovery.
        when(() => prefs.getString(any())).thenAnswer((_) async => null);
        when(() => secure.read(key: any(named: 'key')))
            .thenThrow(PlatformException(code: 'Failed to decrypt'));

        final TelemetryConfig config = await TelemetryConfig.load(
          prefs: prefs,
          secure: secure,
          serviceVersion: '1.2.3',
        );

        expect(config.headers, isEmpty);
        expect(config.serviceVersion, '1.2.3');
      },
    );

    test(
      'an unreadable prefs store degrades to no endpoint override',
      () async {
        when(
          () => prefs.getString(any()),
        ).thenThrow(PlatformException(code: 'shared_preferences unavailable'));
        when(() => secure.read(key: any(named: 'key')))
            .thenAnswer((_) async => null);

        final TelemetryConfig config = await TelemetryConfig.load(
          prefs: prefs,
          secure: secure,
          serviceVersion: '1.2.3',
        );

        expect(config.endpoint, isEmpty);
      },
    );

    test('both stores readable resolves the persisted overrides', () async {
      when(() => prefs.getString(any()))
          .thenAnswer((_) async => 'http://collector.example.com:4318');
      when(() => secure.read(key: any(named: 'key')))
          .thenAnswer((_) async => 'authorization=Bearer abc');

      final TelemetryConfig config = await TelemetryConfig.load(
        prefs: prefs,
        secure: secure,
        serviceVersion: '1.2.3',
      );

      expect(config.endpoint, 'http://collector.example.com:4318');
      expect(config.headers, {'authorization': 'Bearer abc'});
    });
  });

  group('telemetry endpoint persistence (real shared_preferences store)', () {
    late SharedPreferencesAsync prefs;
    late _MockSecureStorage secure;

    setUp(() {
      // The platform instance is global; re-installing per test keeps one
      // test's writes out of the next one.
      prefs = useFakeSharedPreferences();
      secure = _MockSecureStorage();
      when(() => secure.read(key: any(named: 'key')))
          .thenAnswer((_) async => null);
    });

    test('a saved endpoint round-trips back out of load()', () async {
      await TelemetryConfig.saveEndpointOverride(
        prefs,
        'http://collector.example.com:4318',
      );

      final TelemetryConfig config = await TelemetryConfig.load(
        prefs: prefs,
        secure: secure,
        serviceVersion: '1.2.3',
      );

      expect(config.endpoint, 'http://collector.example.com:4318');
    });

    test('saving an empty endpoint clears the override', () async {
      await TelemetryConfig.saveEndpointOverride(prefs, 'http://old:4318');
      await TelemetryConfig.saveEndpointOverride(prefs, '');

      final TelemetryConfig config = await TelemetryConfig.load(
        prefs: prefs,
        secure: secure,
        serviceVersion: '1.2.3',
      );

      // Back to the --dart-define default, which is empty in a test build.
      expect(config.endpoint, isEmpty);
    });

    test('the endpoint is stored under the documented key', () async {
      await TelemetryConfig.saveEndpointOverride(prefs, 'http://c:4318');

      expect(await prefs.getString(kTelemetryEndpointKey), 'http://c:4318');
    });
  });
}
