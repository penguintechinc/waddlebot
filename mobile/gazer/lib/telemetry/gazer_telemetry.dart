import 'dart:async';
import 'dart:collection';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show ValueListenable, ValueNotifier;

import '../services/gazer_log.dart';
import 'otlp_http_exporter.dart';
import 'telemetry_config.dart';

/// One completed or in-flight trace span. Obtained via
/// `GazerTelemetry.startSpan`; call [end] exactly once when the work it
/// covers finishes.
class Span {
  Span._(this._name, {Span? parent})
    : _start = DateTime.now(),
      traceId = parent?.traceId ?? GazerTelemetry._newId(16),
      spanId = GazerTelemetry._newId(8),
      parentSpanId = parent?.spanId;

  /// This span's trace, as 32 lowercase hex characters (16 bytes).
  /// Inherited from the parent passed to `GazerTelemetry.startSpan`, so a
  /// parent and its children share one trace; a root span mints its own.
  final String traceId;

  /// This span's own id, as 16 lowercase hex characters (8 bytes). Unique
  /// per span, never shared with the parent.
  final String spanId;

  /// The enclosing span's [spanId], or `null` when this span is the root
  /// of its trace.
  final String? parentSpanId;

  final String _name;
  final DateTime _start;
  final Map<String, Object?> _attributes = <String, Object?>{};
  bool _ended = false;

  /// Attaches [value] under [key]; call before [end]. Never pass PII,
  /// secrets, or a raw device identifier -- see `GazerLog.sanitize` for the
  /// equivalent log-side rule.
  void setAttribute(String key, Object? value) => _attributes[key] = value;

  /// Records the span's end time and hands it to [GazerTelemetry] for
  /// export. A second call is a no-op (idempotent, so a defensive
  /// double-call from cleanup code never double-counts).
  void end() {
    if (_ended) return;
    _ended = true;
    GazerTelemetry._completeSpan(this, DateTime.now());
  }
}

/// Coarse health of telemetry export, as one value the status panel can
/// render directly instead of doing boolean arithmetic over counters.
enum TelemetryHealthStatus {
  /// No endpoint configured: nothing is sent, and nothing is wrong.
  disabled,

  /// An endpoint is configured and the most recent export cycle that
  /// actually attempted a POST succeeded.
  ok,

  /// An endpoint is configured but export is not working: the most recent
  /// cycle that attempted a POST failed in transport, or a batch has been
  /// dropped because it could not be encoded.
  degraded,
}

/// Immutable snapshot of telemetry export health: one combined signal
/// derived from every counter [GazerTelemetry] keeps, published through
/// `GazerTelemetry.health`.
///
/// Exists because the status panel previously read three mutable statics
/// during `build()` and combined them itself -- which both went stale (the
/// widget never rebuilt when a counter changed) and got the common cases
/// wrong: a collector that succeeded once and then died forever still
/// read as "exporting", and dropped-on-encode batches surfaced nowhere at
/// all.
class TelemetryHealth {
  const TelemetryHealth({
    required this.status,
    this.lastError,
    this.encodeFailures = 0,
    this.transportFailures = 0,
  });

  /// What the UI renders.
  final TelemetryHealthStatus status;

  /// Short, non-localized diagnostic tag for the most recent failure, e.g.
  /// `'transport:metrics'` -- the signal type and which half failed, never
  /// a URL, header, or response body, since this value is readable from
  /// the UI and could be screenshotted.
  final String? lastError;

  /// Total batches dropped because they could not be encoded; see
  /// `GazerTelemetry.encodeFailures`.
  final int encodeFailures;

  /// Total export POSTs that failed in transport; see
  /// `GazerTelemetry.exportFailures`.
  final int transportFailures;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is TelemetryHealth &&
          other.status == status &&
          other.lastError == lastError &&
          other.encodeFailures == encodeFailures &&
          other.transportFailures == transportFailures;

  @override
  int get hashCode =>
      Object.hash(status, lastError, encodeFailures, transportFailures);

  @override
  String toString() =>
      'TelemetryHealth(${status.name}, lastError: $lastError, '
      'encodeFailures: $encodeFailures, transportFailures: $transportFailures)';
}

/// Capped, drop-oldest buffer of telemetry records pending export.
///
/// A plain [List] was not sufficient for the flush path. Removing a sent
/// batch with `removeRange(0, batch.length)` removes by position, and the
/// buffer can shift under an in-flight POST (a drop-oldest eviction while
/// the request is outstanding), so the removal would delete newer records
/// that were never exported -- and once the buffer had shrunk below the
/// batch length it threw a `RangeError`, inside a `Timer.periodic`
/// callback, in the one subsystem whose hard rule is that it never breaks
/// the app. Counting evictions makes the removal exact. [ListQueue] also
/// makes each eviction O(1) instead of `List.removeAt(0)`'s O(n) at the
/// 1000-record cap.
class _RingBuffer<T> {
  _RingBuffer(this.cap);

  /// Maximum retained records; the oldest is evicted beyond this.
  final int cap;

  final ListQueue<T> _items = ListQueue<T>();
  int _evicted = 0;

  bool get isEmpty => _items.isEmpty;

  /// Number of records currently buffered.
  int get length => _items.length;

  /// Appends [item], evicting the oldest records past [cap].
  void add(T item) {
    _items.addLast(item);
    while (_items.length > cap) {
      _items.removeFirst();
      _evicted++;
    }
  }

  /// Everything currently buffered, paired with the eviction counter at
  /// snapshot time -- pass both back to [removeSent].
  (List<T>, int) snapshot() => (List<T>.of(_items), _evicted);

  /// Drops the [batchLength] records taken by a [snapshot] that are still
  /// buffered: anything evicted since [evictedAtSnapshot] is already gone,
  /// and removing for it again would discard records that were never sent.
  void removeSent(int batchLength, int evictedAtSnapshot) {
    int remaining = batchLength - (_evicted - evictedAtSnapshot);
    while (remaining > 0 && _items.isNotEmpty) {
      _items.removeFirst();
      remaining--;
    }
  }

  /// Empties the buffer and resets the eviction counter.
  void clear() {
    _items.clear();
    _evicted = 0;
  }
}

/// Facade over the app's OpenTelemetry emission: structured logs, metrics
/// (histograms/counters/gauges), and traces, buffered in-memory and
/// exported every 10s as OTLP/HTTP JSON via [OtlpHttpExporter].
///
/// Every recording method is synchronous and never throws: signals always
/// land in the ring buffer (cap [ringBufferCap] per signal type,
/// drop-oldest) even when `TelemetryConfig.endpoint` is empty (export
/// disabled) or the collector is unreachable (export fails,
/// [exportFailures] increments) -- a dead or unconfigured endpoint never
/// breaks app functionality, per the house OpenTelemetry rule.
///
/// UI reads [health], not the raw counters: it is a [ValueListenable], so
/// a widget bound to it actually rebuilds when export health changes.
class GazerTelemetry {
  GazerTelemetry._();

  static const int ringBufferCap = 1000;
  static const Duration flushInterval = Duration(seconds: 10);

  static TelemetryConfig _config = const TelemetryConfig(
    endpoint: '',
    protocol: 'http/json',
    headers: <String, String>{},
    serviceName: 'gazer',
    serviceVersion: '0.0.0',
    deploymentEnvironment: 'dev',
  );

  static OtlpHttpExporter _exporter = OtlpHttpExporter(
    dio: Dio(),
    endpoint: '',
    headers: const <String, String>{},
  );
  static Timer? _timer;

  /// Cryptographically-seeded, so trace/span ids cannot be predicted or
  /// replayed across installs from a known seed.
  static final Random _idRandom = Random.secure();

  static final _RingBuffer<OtlpLogRecord> _logs = _RingBuffer<OtlpLogRecord>(
    ringBufferCap,
  );
  static final _RingBuffer<OtlpMetricPoint> _metrics =
      _RingBuffer<OtlpMetricPoint>(ringBufferCap);
  static final _RingBuffer<OtlpSpanRecord> _spans = _RingBuffer<OtlpSpanRecord>(
    ringBufferCap,
  );

  /// Count of export POST attempts that did not succeed for a transient
  /// (transport-level) reason -- timeout, connection refused, non-2xx.
  /// The batch is retained and retried on the next scheduled flush.
  /// Surfaced to the UI through [health], never read directly by a widget.
  static int exportFailures = 0;

  /// Count of export POST attempts that succeeded (2xx).
  static int exportSuccesses = 0;

  /// Count of batches dropped because they could not be encoded (e.g. an
  /// attribute value whose `toString()` throws, or a value `jsonEncode`
  /// cannot represent) -- distinct from [exportFailures] because retrying
  /// an un-encodable batch fails identically forever; see [_dropOnEncodeFailure].
  static int encodeFailures = 0;

  /// True while a [flush] is in flight. Guards re-entrancy -- see [flush].
  static bool _flushing = false;

  /// POST attempts and transport failures within the current flush cycle,
  /// so health grades off the cycle as a whole rather than off whichever
  /// of the three concurrent signal flushes happened to finish last.
  static int _cycleAttempts = 0;
  static int _cycleFailures = 0;

  /// Whether the most recent cycle that actually attempted a POST failed.
  static bool _lastCycleFailed = false;
  static String? _lastError;

  static final ValueNotifier<TelemetryHealth> _health =
      ValueNotifier<TelemetryHealth>(
        const TelemetryHealth(status: TelemetryHealthStatus.disabled),
      );

  /// One combined export-health signal for the UI, live: the status panel
  /// binds to this instead of reading [exportFailures]/[exportSuccesses]/
  /// [encodeFailures] during `build()`.
  static ValueListenable<TelemetryHealth> get health => _health;

  /// Applies [config] and rebuilds the exporter; starts the periodic flush
  /// scheduler on first call. Safe to call repeatedly -- e.g. every time
  /// Settings > Developer > Telemetry endpoint is saved, so a change takes
  /// effect without an app restart. The *previous* exporter's [Dio] client
  /// is closed (aborting any in-flight request) after the new one is
  /// installed, so repeated reloads never accumulate open HTTP clients or
  /// keep emitting through a stale client pointed at the old endpoint.
  static void init(TelemetryConfig config, {Dio? dio}) {
    _config = config;
    final OtlpHttpExporter previousExporter = _exporter;
    _exporter = OtlpHttpExporter(
      dio: dio ?? Dio(),
      endpoint: config.endpoint,
      headers: config.headers,
    );
    previousExporter.close();
    _timer ??= Timer.periodic(flushInterval, (_) => flush());
    _updateHealth();
  }

  /// Cancels the periodic flush scheduler.
  ///
  /// Production teardown hook, paired with [init] by
  /// `telemetryConfigProvider`'s `ref.onDispose`: a disposed provider
  /// container must not leave a [Timer] running, which in widget tests is
  /// one leaked timer per `pumpGazerApp`. Buffers, counters, and config
  /// are deliberately left intact -- a later [init] resumes exporting
  /// whatever accumulated meanwhile. The exporter's HTTP client is not
  /// closed here; [init] and [resetForTest] own that.
  static void shutdown() {
    _timer?.cancel();
    _timer = null;
  }

  /// Whether the current config would actually send data over the network
  /// (a non-empty endpoint).
  static bool get isExporting => _config.endpoint.isNotEmpty;

  /// Records one structured log line. Fed automatically from `GazerLog`'s
  /// existing sanitize-then-emit path -- see this task's `gazer_log.dart`
  /// modification -- so callers normally never call this directly.
  static void recordLog(
    String level,
    String event, [
    Map<String, Object?> attributes = const <String, Object?>{},
  ]) {
    _logs.add((
      time: DateTime.now(),
      level: level,
      event: event,
      attributes: attributes,
    ));
  }

  /// Records one histogram observation, e.g. `gazer.rtmp.connect_latency_ms`.
  static void histogram(
    String name,
    num value, [
    Map<String, Object?> attributes = const <String, Object?>{},
  ]) {
    _metrics.add((
      time: DateTime.now(),
      name: name,
      kind: 'histogram',
      value: value.toDouble(),
      attributes: attributes,
    ));
  }

  /// Increments a monotonic counter by 1, e.g. `gazer.pipeline.state_change`.
  static void counter(
    String name, [
    Map<String, Object?> attributes = const <String, Object?>{},
  ]) {
    _metrics.add((
      time: DateTime.now(),
      name: name,
      kind: 'counter',
      value: 1.0,
      attributes: attributes,
    ));
  }

  /// Records the current value of a gauge (e.g. a queue depth) -- provided
  /// for the house metrics guidance ("gauges for state"); no M1 caller
  /// uses this yet.
  static void gauge(
    String name,
    num value, [
    Map<String, Object?> attributes = const <String, Object?>{},
  ]) {
    _metrics.add((
      time: DateTime.now(),
      name: name,
      kind: 'gauge',
      value: value.toDouble(),
      attributes: attributes,
    ));
  }

  /// Starts a new span named [name]; the caller must call `Span.end`
  /// exactly once when the covered work finishes.
  ///
  /// Passing [parent] joins the parent's trace (same `traceId`) and records
  /// it as the new span's `parentSpanId`, so a Go Live's prepare→start
  /// pair reads as one trace in a backend rather than two unrelated
  /// single-span traces. The child is free to outlive its parent; OTLP
  /// only needs the id linkage, not containment in time.
  static Span startSpan(String name, {Span? parent}) =>
      Span._(name, parent: parent);

  static void _completeSpan(Span span, DateTime end) {
    _spans.add((
      name: span._name,
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      start: span._start,
      end: end,
      attributes: Map<String, Object?>.from(span._attributes),
    ));
  }

  /// [byteLength] random bytes as lowercase hex -- the OTLP/JSON encoding
  /// for a trace id (16 bytes) or span id (8 bytes).
  ///
  /// Never returns an all-zero id: OTLP defines all-zero as "invalid", and
  /// collectors drop such a span. The retry loop is astronomically
  /// unlikely to run but makes the invariant explicit rather than merely
  /// probable.
  static String _newId(int byteLength) {
    while (true) {
      final StringBuffer hex = StringBuffer();
      bool allZero = true;
      for (int i = 0; i < byteLength; i++) {
        final int byte = _idRandom.nextInt(256);
        if (byte != 0) allZero = false;
        hex.write(byte.toRadixString(16).padLeft(2, '0'));
      }
      if (!allZero) return hex.toString();
    }
  }

  /// Batches whatever is currently buffered per signal type and POSTs each
  /// non-empty batch as OTLP/HTTP JSON. A no-op (no HTTP calls at all)
  /// when [isExporting] is false. Each signal type's batch is removed
  /// from the buffer on a successful (2xx) POST *or* on an encode
  /// failure (a malformed batch would fail identically forever if kept,
  /// see [_dropOnEncodeFailure]); only a transient transport failure
  /// leaves the batch buffered for the next scheduled flush (still
  /// subject to the ring buffer's drop-oldest cap).
  ///
  /// Re-entrant calls return immediately. [Timer.periodic] discards the
  /// Future this returns, so against a slow or black-holed collector the
  /// next tick fires while the previous POST is still outstanding; two
  /// overlapping flushes snapshot the same records, export them twice, and
  /// then both remove them. Skipping the overlapping tick loses nothing --
  /// whatever it would have sent is still buffered for the next one.
  static Future<void> flush() async {
    if (!isExporting) return;
    if (_flushing) return;
    _flushing = true;
    _cycleAttempts = 0;
    _cycleFailures = 0;
    try {
      final Map<String, Object?> resourceAttrs = OtlpHttpExporter.resource(
        serviceName: _config.serviceName,
        serviceVersion: _config.serviceVersion,
        deploymentEnvironment: _config.deploymentEnvironment,
      );
      await Future.wait<void>(<Future<void>>[
        _flushBuffer<OtlpLogRecord>(
          'logs',
          '/v1/logs',
          _logs,
          (List<OtlpLogRecord> batch) => OtlpHttpExporter.encodeLogs(
            resourceAttrs: resourceAttrs,
            records: batch,
          ),
        ),
        _flushBuffer<OtlpMetricPoint>(
          'metrics',
          '/v1/metrics',
          _metrics,
          (List<OtlpMetricPoint> batch) => OtlpHttpExporter.encodeMetrics(
            resourceAttrs: resourceAttrs,
            points: batch,
          ),
        ),
        _flushBuffer<OtlpSpanRecord>(
          'spans',
          '/v1/traces',
          _spans,
          (List<OtlpSpanRecord> batch) => OtlpHttpExporter.encodeSpans(
            resourceAttrs: resourceAttrs,
            spans: batch,
          ),
        ),
      ]);
    } finally {
      if (_cycleAttempts > 0) {
        _lastCycleFailed = _cycleFailures > 0;
        if (!_lastCycleFailed) _lastError = null;
      }
      _flushing = false;
      _updateHealth();
    }
  }

  /// Exports one signal type's buffered batch to [path].
  ///
  /// One implementation for all three signals: the previous per-signal
  /// copies differed only in buffer, path, and encoder, and the
  /// re-entrancy and removal fixes had to land identically in each.
  static Future<void> _flushBuffer<T>(
    String signal,
    String path,
    _RingBuffer<T> buffer,
    Map<String, Object?> Function(List<T> batch) encode,
  ) async {
    if (buffer.isEmpty) return;
    final (List<T> batch, int evictedAtSnapshot) = buffer.snapshot();
    _cycleAttempts++;
    // The body-builder closure is passed to `post`, not invoked here --
    // `post` evaluates it inside its own never-throw guard and reports
    // which half (encode vs. transport) failed, so this switch can tell
    // a permanently-malformed batch from a transient network error.
    final PostResult result = await _exporter.post(path, () => encode(batch));
    switch (result) {
      case PostResult.success:
        exportSuccesses++;
        buffer.removeSent(batch.length, evictedAtSnapshot);
      case PostResult.encodeFailure:
        buffer.removeSent(batch.length, evictedAtSnapshot);
        _cycleFailures++;
        _lastError = 'encode:$signal';
        _dropOnEncodeFailure(signal, batch.length);
      case PostResult.transportFailure:
        exportFailures++;
        _cycleFailures++;
        _lastError = 'transport:$signal';
    }
  }

  /// Recomputes [health] from the current config and counters.
  ///
  /// `degraded` is sticky for [encodeFailures] on purpose: a dropped batch
  /// is never retried, so the only evidence it happened is this signal.
  static void _updateHealth() {
    final TelemetryHealthStatus status;
    if (!isExporting) {
      status = TelemetryHealthStatus.disabled;
    } else if (encodeFailures > 0 || _lastCycleFailed) {
      status = TelemetryHealthStatus.degraded;
    } else {
      status = TelemetryHealthStatus.ok;
    }
    _health.value = TelemetryHealth(
      status: status,
      lastError: status == TelemetryHealthStatus.degraded ? _lastError : null,
      encodeFailures: encodeFailures,
      transportFailures: exportFailures,
    );
  }

  /// Counts and logs (once, at DEBUG) a batch dropped because it could
  /// not be encoded -- an un-encodable record (e.g. a `toString()` that
  /// throws) would fail identically on every future retry, so the batch
  /// is dropped rather than left to block every later record of the same
  /// signal type (buffered and incoming) until the ring buffer's
  /// drop-oldest cap eventually evicts it -- effectively an unbounded
  /// blackout for that signal. Logs [signal] and [count] only, never
  /// attribute values, since the value that failed to encode may not be
  /// sanitized (it never reached `GazerLog.sanitize`). A no-op beyond the
  /// counter increment unless `GazerLog.verbose` is on, per
  /// `GazerLog.debug`'s normal gating.
  static void _dropOnEncodeFailure(String signal, int count) {
    encodeFailures++;
    GazerLog.debug('telemetry.encodeFailure', <String, Object?>{
      'signal': signal,
      'count': count,
    });
  }

  /// Test/teardown hook: cancels the flush scheduler and clears every
  /// buffer, counter, and config back to the inert default. Not used by
  /// production code -- call in `tearDown` of any test that calls [init].
  static void resetForTest() {
    shutdown();
    _logs.clear();
    _metrics.clear();
    _spans.clear();
    exportFailures = 0;
    exportSuccesses = 0;
    encodeFailures = 0;
    _flushing = false;
    _cycleAttempts = 0;
    _cycleFailures = 0;
    _lastCycleFailed = false;
    _lastError = null;
    _config = const TelemetryConfig(
      endpoint: '',
      protocol: 'http/json',
      headers: <String, String>{},
      serviceName: 'gazer',
      serviceVersion: '0.0.0',
      deploymentEnvironment: 'dev',
    );
    _exporter.close();
    _exporter = OtlpHttpExporter(
      dio: Dio(),
      endpoint: '',
      headers: const <String, String>{},
    );
    _updateHealth();
  }
}
