import 'package:freezed_annotation/freezed_annotation.dart';

import '../services/gazer_log.dart';

part 'stream_target_settings.freezed.dart';
part 'stream_target_settings.g.dart';

/// User-supplied RTMP/RTMPS destination: URL, optional stream key, and an
/// optional both-or-neither username/password pair.
///
/// Every field here is sensitive: [SecureSettingsRepository] stores it in
/// `flutter_secure_storage`, never `shared_preferences`, and it is never
/// logged. Validation and the key-append/dedupe logic live in
/// `TargetValidator`, not here.
@freezed
abstract class StreamTargetSettings with _$StreamTargetSettings {
  /// Private constructor (freezed convention) so this class can carry the
  /// [toString] override below in addition to its generated members.
  const StreamTargetSettings._();

  const factory StreamTargetSettings({
    required String url,
    String? streamKey,
    String? username,
    String? password,
  }) = _StreamTargetSettings;

  /// Deserializes a [StreamTargetSettings] from JSON (round-trip tests only).
  factory StreamTargetSettings.fromJson(Map<String, dynamic> json) =>
      _$StreamTargetSettingsFromJson(json);

  /// Empty target: blank URL, no key, no credentials — the pre-setup state.
  factory StreamTargetSettings.empty() => const StreamTargetSettings(url: '');

  /// Redacted string form (R22): this class is logged and nested inside
  /// [GazerSettings]'s own toString, so the freezed-generated default
  /// (which prints every field in plaintext) is overridden here. [url]
  /// keeps its scheme/host/earlier path segments but masks its **last**
  /// path segment, and drops userinfo/query/fragment; [username] and
  /// [password] print as `<redacted>`; [streamKey] prints masked with only
  /// its last 4 characters visible, enough to eyeball "is this the key I
  /// expect" without exposing it.
  @override
  String toString() {
    return 'StreamTargetSettings(url: $_redactedUrl, streamKey: $_redactedStreamKey, '
        'username: ${_redactCredential(username)}, password: ${_redactCredential(password)})';
  }

  /// The URL with its last path segment masked.
  ///
  /// Previously this returned `host + path` in full, which prints the
  /// stream key verbatim whenever the user pastes a complete
  /// `rtmp://host/live/KEY` URL -- a form the spec explicitly supports.
  /// A redaction helper that prints the secret is a hole in exactly the
  /// control meant to be defence-in-depth, so the masking is now shared
  /// with [GazerLog.maskUrlLastSegment].
  String get _redactedUrl {
    if (url.isEmpty) return '';
    final Uri? uri = Uri.tryParse(url);
    if (uri == null || uri.host.isEmpty) return '<redacted>';
    return GazerLog.maskUrlLastSegment(url);
  }

  String get _redactedStreamKey {
    final key = streamKey;
    if (key == null) return 'null';
    if (key.length <= 4) return '****';
    return '****${key.substring(key.length - 4)}';
  }

  /// `null` stays `null` (absence isn't a secret); any non-null value,
  /// however short, redacts fully rather than partially mask it.
  String _redactCredential(String? value) =>
      value == null ? 'null' : '<redacted>';
}
