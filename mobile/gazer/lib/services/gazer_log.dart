import 'dart:convert';
import 'dart:developer' as developer;

import '../telemetry/gazer_telemetry.dart';

/// Structured, sanitized logging for Gazer.
///
/// Emits one JSON line per call via `dart:developer`'s `log()` — never
/// `print` — masking secrets so tokens/credentials never reach device
/// logs. [debug] only emits when [verbose] is on, wired from the user's
/// Settings > Developer > Debug logs toggle (`GazerSettings.debugLogs`).
class GazerLog {
  GazerLog._();

  /// Whether [debug] calls actually emit.
  static bool verbose = false;

  /// Where every JSON line is written; overridable in tests to capture
  /// output instead of going through `dart:developer`'s `log()`, which
  /// cannot be intercepted directly.
  static void Function(String line) sink = _developerSink;

  /// Default [sink]: writes through `dart:developer`'s `log()` under the
  /// `gazer` name, the normal production path.
  static void _developerSink(String line) => developer.log(line, name: 'gazer');

  /// Emits an `info`-level JSON line for [event] with [fields] (sanitized).
  static void info(String event, [Map<String, Object?> fields = const {}]) =>
      _emit('info', event, fields);

  /// Emits a `warn`-level JSON line for [event] with [fields] (sanitized).
  static void warn(String event, [Map<String, Object?> fields = const {}]) =>
      _emit('warn', event, fields);

  /// Emits an `error`-level JSON line for [event] with [fields] (sanitized).
  static void error(String event, [Map<String, Object?> fields = const {}]) =>
      _emit('error', event, fields);

  /// Only emits when [verbose] is enabled.
  static void debug(String event, [Map<String, Object?> fields = const {}]) {
    if (!verbose) return;
    _emit('debug', event, fields);
  }

  /// Test-only: restores [verbose] and [sink] to their production defaults
  /// (`false` and [_developerSink]). Call from `tearDown` in any test that
  /// flips [verbose] or overrides [sink] — directly, or indirectly via a
  /// real notifier/controller — so the mutation never leaks into a later
  /// test.
  static void resetForTest() {
    verbose = false;
    sink = _developerSink;
  }

  /// Builds the JSON record (`ts`/`level`/`event` plus sanitized [fields])
  /// and writes it through [sink]. Never throws: a field value `jsonEncode`
  /// can't natively encode falls back to its `toString()`, via
  /// [JsonEncoder.toEncodable], instead of propagating a
  /// [JsonUnsupportedObjectError] to the caller.
  static void _emit(String level, String event, Map<String, Object?> fields) {
    final sanitized = sanitize(fields);
    final record = <String, Object?>{
      'ts': DateTime.now().toIso8601String(),
      'level': level,
      'event': event,
      ...sanitized,
    };
    sink(jsonEncode(record, toEncodable: (Object? value) => value.toString()));
    // Already-sanitized fields only -- GazerTelemetry never re-sanitizes,
    // so this is the one funnel point that guarantees no secret/PII ever
    // reaches an attribute. debug() only calls _emit when GazerLog.verbose
    // is true, so telemetry's debug-level logs stay off by default too.
    GazerTelemetry.recordLog(level, event, sanitized);
  }

  /// Masks [value]: `null`/empty -> `''`; otherwise `'****'` + the last 4
  /// characters, or just `'****'` when shorter than 4 characters.
  static String maskSecret(String? value) {
    if (value == null || value.isEmpty) return '';
    if (value.length < 4) return '****';
    return '****${value.substring(value.length - 4)}';
  }

  /// Masks any field named `password`/`streamKey`/`username` wholesale via
  /// [maskSecret]; a field named `url` keeps its scheme/host but masks
  /// only its last path segment, since the full path/query may embed the
  /// stream key.
  ///
  /// Recurses into nested maps and lists: matching on key name alone is
  /// only a control if every key in the structure is actually visited, and
  /// a `{'target': {'password': ...}}` shape would otherwise pass through
  /// untouched.
  static Map<String, Object?> sanitize(Map<String, Object?> fields) {
    return fields.map(
      (String key, Object? value) => MapEntry(key, _sanitizeValue(key, value)),
    );
  }

  /// Sanitizes one field: secrets by key name, containers by recursion,
  /// anything else unchanged.
  static Object? _sanitizeValue(String key, Object? value) {
    if (value is Map) {
      return <String, Object?>{
        for (final MapEntry<Object?, Object?> e in value.entries)
          e.key.toString(): _sanitizeValue(e.key.toString(), e.value),
      };
    }
    if (value is List) {
      // The element keeps the enclosing key's name: a list under
      // `password` is a list of passwords.
      return <Object?>[for (final Object? e in value) _sanitizeValue(key, e)];
    }
    if (value is! String) return value;
    switch (key) {
      case 'password':
      case 'streamKey':
      case 'username':
        return maskSecret(value);
      case 'url':
        return maskUrlLastSegment(value);
      default:
        return value;
    }
  }

  /// Masks only the last path segment of [url] via [maskSecret], keeping
  /// scheme, host, port, and earlier segments.
  ///
  /// `userInfo`, query, and fragment are dropped rather than preserved: a
  /// RTMP(S) URL can carry credentials or a token in any of the three
  /// (`rtmp://user:pass@host/...`, `?token=...`), and this helper is the
  /// defence-in-depth control that keeps them out of logs and out of
  /// [StreamTargetSettings.toString]. Returns `'<redacted>'` for a string
  /// that will not parse as a URI at all -- an unparseable value is not
  /// evidence that it holds no secret.
  ///
  /// Shared with `StreamTargetSettings`: one implementation, so the model's
  /// redaction and the log sanitizer cannot drift apart.
  static String maskUrlLastSegment(String url) {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return '<redacted>';
    final List<String> segments = List<String>.from(uri.pathSegments);
    if (segments.isNotEmpty) {
      segments[segments.length - 1] = maskSecret(segments.last);
    }
    return Uri(
      scheme: uri.scheme.isEmpty ? null : uri.scheme,
      host: uri.host.isEmpty ? null : uri.host,
      port: uri.hasPort ? uri.port : null,
      pathSegments: segments,
    ).toString();
  }
}
