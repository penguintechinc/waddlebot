import 'package:flutter_test/flutter_test.dart';
import 'package:gazer/config/constants.dart';

/// `constants.dart` is a `const`-only library: it declares no executable
/// statement, so it can never appear in an lcov report no matter what is
/// tested. These assertions exist for the other reason to pin a constant
/// -- three of these four values are licensing- or network-relevant, and
/// a silent edit to any of them changes who the app talks to or for how
/// long it trusts a cached entitlement.
void main() {
  test('the licence server base URL is the documented v2 endpoint', () {
    expect(kLicenseBaseUrl, 'https://license.penguintech.io/api/v2');
  });

  test('the update checker polls the waddlebot repository releases', () {
    expect(
      kGithubReleasesUrl,
      'https://api.github.com/repos/penguintechinc/waddlebot/releases',
    );
  });

  test('keepalive runs every 5 minutes, well inside the staleness window', () {
    expect(kLicenseKeepaliveInterval, const Duration(minutes: 5));
  });

  test('the offline grace period is 7 days', () {
    expect(kLicenseGracePeriod, const Duration(days: 7));
  });

  test('outbound HTTP is bounded well under the OS TCP timeout', () {
    // Dio's default is null -- i.e. roughly two minutes on Android.
    expect(kHttpTimeout, const Duration(seconds: 10));
    expect(kHttpTimeout, lessThan(const Duration(seconds: 30)));
  });
}
