import 'package:flutter/material.dart';
import 'package:flutter_libs/flutter_libs.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/flag_keys.dart';
import '../l10n/app_localizations.dart';
import '../models/gazer_settings.dart';
import '../models/quality.dart';
import '../models/validation_issue.dart';
import '../providers/license_provider.dart';
import '../providers/settings_provider.dart';
import '../providers/telemetry_provider.dart';
import '../services/feature_flags.dart';
import '../services/settings_validation.dart';
import '../telemetry/telemetry_config.dart';

/// Settings screen: stream target, quality, audio source, and a
/// long-press-revealed developer section.
///
/// Validation runs on every keystroke via [validateGazerSettings] — the
/// same helper HomeScreen's Go Live enablement uses, so the two screens can
/// never disagree about validity — and the Save button is disabled whenever
/// the draft would fail to stream.
/// Save persists through [SettingsNotifier.save].
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

/// Owns the editable draft ([_draft] plus the five text controllers) that
/// every field mutates, and the reveal/developer-section toggles; nothing
/// is written back to [settingsProvider] until Save succeeds.
class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final TextEditingController _url = TextEditingController();
  final TextEditingController _streamKey = TextEditingController();
  final TextEditingController _username = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _telemetryEndpoint = TextEditingController();
  GazerSettings? _draft;
  bool _initialized = false;
  bool _telemetryInitialized = false;
  bool _devUnlocked = false;
  bool _streamKeyObscured = true;
  bool _usernameObscured = true;
  bool _passwordObscured = true;
  late final Future<PackageInfo> _packageInfoFuture;

  @override
  void initState() {
    super.initState();
    // Fetched once and cached: `build()` runs on every keystroke, and
    // re-invoking `PackageInfo.fromPlatform()` per build would restart the
    // platform-channel call repeatedly for no benefit.
    _packageInfoFuture = PackageInfo.fromPlatform();
  }

  /// Copies [s] into the draft and the text controllers, once, the first
  /// time [settingsProvider] resolves.
  void _seed(GazerSettings s) {
    _draft = s;
    _url.text = s.target.url;
    _streamKey.text = s.target.streamKey ?? '';
    _username.text = s.target.username ?? '';
    _password.text = s.target.password ?? '';
  }

  /// Applies [f] to the draft and rebuilds, so validation and the Save
  /// button's enablement re-run on every keystroke.
  void _update(GazerSettings Function(GazerSettings) f) {
    setState(() => _draft = f(_draft!));
  }

  /// Maps a [ValidationIssue.messageKey] to its localized message; an
  /// unrecognised key falls back to a generic "invalid" string rather than
  /// rendering the raw key.
  String _messageFor(AppLocalizations l10n, String messageKey) {
    return switch (messageKey) {
      // Keys match TargetValidator.validate()'s literal messageKey strings
      // exactly — 'error'-prefixed, not the bare 'urlScheme' etc.
      'errorUrlScheme' => l10n.validationUrlSchemeError,
      'errorUrlSchemeRtmpsUnsupported' =>
        l10n.validationUrlSchemeRtmpsUnsupportedError,
      'errorUrlHost' => l10n.validationUrlHostError,
      'errorUrlPath' => l10n.validationUrlPathError,
      'errorAuthBothOrNeither' => l10n.validationAuthBothOrNeitherError,
      'rtmpAuthDisabled' => l10n.validationRtmpAuthDisabledError,
      _ => l10n.validationUnknownError,
    };
  }

  @override
  void dispose() {
    _url.dispose();
    _streamKey.dispose();
    _username.dispose();
    _password.dispose();
    _telemetryEndpoint.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final AppLocalizations l10n = AppLocalizations.of(context);
    final AsyncValue<GazerSettings> settingsAsync = ref.watch(settingsProvider);
    final FeatureFlags flags = ref.watch(featureFlagsProvider);

    if (!_initialized && settingsAsync.hasValue) {
      _seed(settingsAsync.requireValue);
      _initialized = true;
    }

    final AsyncValue<TelemetryConfig> telemetryConfigAsync = ref.watch(
      telemetryConfigProvider,
    );
    if (!_telemetryInitialized && telemetryConfigAsync.hasValue) {
      _telemetryEndpoint.text = telemetryConfigAsync.requireValue.endpoint;
      _telemetryInitialized = true;
    }

    if (_draft == null) {
      return Scaffold(
        appBar: AppBar(title: Text(l10n.settingsScreenTitle)),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    final GazerSettings draft = _draft!;
    final List<ValidationIssue> issues = validateGazerSettings(draft, flags);
    final Map<String, String> fieldErrors = <String, String>{};
    for (final ValidationIssue issue in issues) {
      final String message = _messageFor(l10n, issue.messageKey);
      if (issue.field == 'auth') {
        // Both-or-neither / rtmp-auth-disabled applies to the username and
        // password fields jointly; surfacing it under whichever of the two
        // is currently empty keeps it attached to exactly one field (a
        // single Text widget), matching a full pair being flagged too.
        final bool hasUsername = (draft.target.username ?? '').isNotEmpty;
        fieldErrors[hasUsername ? 'password' : 'username'] = message;
      } else {
        fieldErrors[issue.field] = message;
      }
    }
    final bool canSave = issues.isEmpty;
    final bool adaptiveBitrateAllowed = flags.isEnabled(
      FlagKeys.adaptiveBitrate,
    );

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsScreenTitle)),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              l10n.targetSectionTitle,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            TextFormField(
              key: const Key('targetUrlField'),
              controller: _url,
              decoration: InputDecoration(
                labelText: l10n.urlFieldLabel,
                hintText: l10n.urlFieldHint,
                errorText: fieldErrors['url'],
              ),
              onChanged: (String v) => _update(
                (GazerSettings s) =>
                    s.copyWith(target: s.target.copyWith(url: v)),
              ),
            ),
            TextFormField(
              key: const Key('streamKeyField'),
              controller: _streamKey,
              obscureText: _streamKeyObscured,
              decoration: InputDecoration(
                labelText: l10n.streamKeyFieldLabel,
                suffixIcon: Semantics(
                  label: l10n.revealStreamKeyLabel,
                  button: true,
                  excludeSemantics: true,
                  child: IconButton(
                    key: const Key('streamKeyRevealButton'),
                    icon: Icon(
                      _streamKeyObscured
                          ? Icons.visibility
                          : Icons.visibility_off,
                    ),
                    onPressed: () => setState(
                      () => _streamKeyObscured = !_streamKeyObscured,
                    ),
                  ),
                ),
              ),
              onChanged: (String v) => _update(
                (GazerSettings s) =>
                    s.copyWith(target: s.target.copyWith(streamKey: v)),
              ),
            ),
            TextFormField(
              key: const Key('usernameField'),
              controller: _username,
              // Masked like the password: the spec's Settings rule is
              // "mask username/password in UI", and an RTMP username is a
              // shoulder-surfable credential half.
              obscureText: _usernameObscured,
              decoration: InputDecoration(
                labelText: l10n.usernameFieldLabel,
                errorText: fieldErrors['username'],
                suffixIcon: Semantics(
                  label: l10n.revealUsernameLabel,
                  button: true,
                  excludeSemantics: true,
                  child: IconButton(
                    key: const Key('usernameRevealButton'),
                    icon: Icon(
                      _usernameObscured
                          ? Icons.visibility
                          : Icons.visibility_off,
                    ),
                    onPressed: () =>
                        setState(() => _usernameObscured = !_usernameObscured),
                  ),
                ),
              ),
              onChanged: (String v) => _update(
                (GazerSettings s) =>
                    s.copyWith(target: s.target.copyWith(username: v)),
              ),
            ),
            TextFormField(
              key: const Key('passwordField'),
              controller: _password,
              obscureText: _passwordObscured,
              decoration: InputDecoration(
                labelText: l10n.passwordFieldLabel,
                errorText: fieldErrors['password'],
                suffixIcon: Semantics(
                  label: l10n.revealPasswordLabel,
                  button: true,
                  excludeSemantics: true,
                  child: IconButton(
                    key: const Key('passwordRevealButton'),
                    icon: Icon(
                      _passwordObscured
                          ? Icons.visibility
                          : Icons.visibility_off,
                    ),
                    onPressed: () =>
                        setState(() => _passwordObscured = !_passwordObscured),
                  ),
                ),
              ),
              onChanged: (String v) => _update(
                (GazerSettings s) =>
                    s.copyWith(target: s.target.copyWith(password: v)),
              ),
            ),
            const Divider(),
            Text(
              l10n.qualitySectionTitle,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            DropdownButtonFormField<Resolution>(
              key: const Key('resolutionField'),
              // isExpanded, or the selected item sizes to its natural
              // width and overflows the decorator Row at 360dp once the
              // text scale rises.
              isExpanded: true,
              initialValue: draft.quality.resolution,
              decoration: InputDecoration(labelText: l10n.resolutionFieldLabel),
              items: <DropdownMenuItem<Resolution>>[
                for (final Resolution r in Resolution.values)
                  DropdownMenuItem<Resolution>(value: r, child: Text(r.label)),
              ],
              onChanged: (Resolution? r) {
                if (r != null) {
                  _update(
                    (GazerSettings s) =>
                        s.copyWith(quality: s.quality.copyWith(resolution: r)),
                  );
                }
              },
            ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    l10n.frameRateFieldLabel,
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                  // SegmentedButton neither wraps nor scrolls, and four
                  // "{n} fps" segments already consume the full 328dp
                  // content box of a 360dp phone -- any text scale above
                  // 1.0x threw `RenderFlex overflowed`. A horizontal
                  // scroll view gives it unbounded width to lay out in and
                  // lets the user reach the off-screen segments.
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: SegmentedButton<FrameRate>(
                      key: const Key('frameRateField'),
                      segments: <ButtonSegment<FrameRate>>[
                        for (final FrameRate fr in FrameRate.values)
                          ButtonSegment<FrameRate>(
                            value: fr,
                            label: Text(l10n.frameRateOptionLabel(fr.value)),
                          ),
                      ],
                      selected: <FrameRate>{draft.quality.frameRate},
                      onSelectionChanged: (Set<FrameRate> s) => _update(
                        (GazerSettings gs) => gs.copyWith(
                          quality: gs.quality.copyWith(frameRate: s.first),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Text(l10n.bitrateFieldValueLabel(draft.quality.videoBitrateKbps)),
            Slider(
              key: const Key('bitrateSlider'),
              min: kMinBitrateKbps.toDouble(),
              max: kMaxBitrateKbps.toDouble(),
              divisions:
                  (kMaxBitrateKbps - kMinBitrateKbps) ~/ kBitrateStepKbps,
              value: draft.quality.videoBitrateKbps.toDouble(),
              label: l10n.bitrateValueLabel(draft.quality.videoBitrateKbps),
              onChanged: (double v) => _update(
                (GazerSettings s) => s.copyWith(
                  quality: s.quality.copyWith(videoBitrateKbps: v.round()),
                ),
              ),
            ),
            // PipelineController only honours adaptive bitrate when this
            // flag is on, so an ungated switch let the user turn on -- and
            // save -- a setting the stream silently ignored. Mirrors the
            // rtmp-auth treatment above.
            SwitchListTile(
              key: const Key('adaptiveBitrateSwitch'),
              title: Text(l10n.adaptiveBitrateLabel),
              subtitle: adaptiveBitrateAllowed
                  ? null
                  : Text(l10n.adaptiveBitrateDisabledHint),
              value: adaptiveBitrateAllowed && draft.quality.adaptiveBitrate,
              onChanged: adaptiveBitrateAllowed
                  ? (bool v) => _update(
                      (GazerSettings s) => s.copyWith(
                        quality: s.quality.copyWith(adaptiveBitrate: v),
                      ),
                    )
                  : null,
            ),
            const Divider(),
            Text(
              l10n.audioSectionTitle,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            DropdownButtonFormField<AudioSourceChoice>(
              key: const Key('audioSourceField'),
              isExpanded: true,
              initialValue: draft.audio,
              decoration: InputDecoration(labelText: l10n.audioSectionTitle),
              items: <DropdownMenuItem<AudioSourceChoice>>[
                DropdownMenuItem<AudioSourceChoice>(
                  value: AudioSourceChoice.auto,
                  child: Text(l10n.audioSourceAutoLabel),
                ),
                DropdownMenuItem<AudioSourceChoice>(
                  value: AudioSourceChoice.mic,
                  child: Text(l10n.audioSourceMicLabel),
                ),
                DropdownMenuItem<AudioSourceChoice>(
                  value: AudioSourceChoice.usbAudio,
                  child: Text(l10n.audioSourceUsbLabel),
                ),
                DropdownMenuItem<AudioSourceChoice>(
                  value: AudioSourceChoice.silence,
                  child: Text(l10n.audioSourceSilenceLabel),
                ),
              ],
              onChanged: (AudioSourceChoice? a) {
                if (a != null) {
                  _update((GazerSettings s) => s.copyWith(audio: a));
                }
              },
            ),
            const Divider(),
            GestureDetector(
              key: const Key('versionFooter'),
              onLongPress: () => setState(() => _devUnlocked = !_devUnlocked),
              child: FutureBuilder<PackageInfo>(
                future: _packageInfoFuture,
                builder:
                    (
                      BuildContext context,
                      AsyncSnapshot<PackageInfo> snapshot,
                    ) {
                      final String version = snapshot.data?.version ?? '';
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Column(
                          children: <Widget>[
                            if (version.isNotEmpty)
                              ConsoleVersion(
                                appName: l10n.appTitle,
                                version: version,
                              ),
                            Text(
                              l10n.versionLabel(version),
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      );
                    },
              ),
            ),
            if (_devUnlocked) ...<Widget>[
              Text(
                l10n.developerSectionTitle,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              SwitchListTile(
                key: const Key('forceLibuvcSwitch'),
                title: Text(l10n.forceLibuvcLabel),
                value: draft.forceLibuvc,
                onChanged: (bool v) =>
                    _update((GazerSettings s) => s.copyWith(forceLibuvc: v)),
              ),
              SwitchListTile(
                key: const Key('debugLogsSwitch'),
                title: Text(l10n.settingsDebugLogsLabel),
                value: draft.debugLogs,
                onChanged: (bool v) =>
                    _update((GazerSettings s) => s.copyWith(debugLogs: v)),
              ),
              TextFormField(
                key: const Key('telemetryEndpointField'),
                controller: _telemetryEndpoint,
                decoration: InputDecoration(
                  labelText: l10n.telemetryEndpointFieldLabel,
                  hintText: l10n.telemetryEndpointFieldHint,
                ),
              ),
            ],
            const SizedBox(height: 16),
            Semantics(
              label: l10n.saveButtonSemanticsLabel,
              button: true,
              excludeSemantics: true,
              child: FilledButton(
                key: const Key('saveSettingsButton'),
                onPressed: canSave
                    ? () async {
                        try {
                          await ref.read(settingsProvider.notifier).save(draft);
                          await TelemetryConfig.saveEndpointOverride(
                            SharedPreferencesAsync(),
                            _telemetryEndpoint.text.trim(),
                          );
                          ref.invalidate(telemetryConfigProvider);
                          await ref.read(telemetryConfigProvider.future);
                        } catch (_) {
                          // Never surface the exception's own text: it may
                          // wrap a secret-bearing value (e.g. secure-storage
                          // failures echoing back what they failed to
                          // write). The draft is left untouched either way —
                          // this handler never clears `_draft`/the text
                          // controllers, so a failed save is retryable.
                          if (!context.mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text(l10n.settingsSaveFailed)),
                          );
                          return;
                        }
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text(l10n.settingsSavedMessage)),
                        );
                      }
                    : null,
                child: Text(l10n.saveButtonLabel),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
