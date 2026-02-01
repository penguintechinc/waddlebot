import 'package:flutter_libs/flutter_libs.dart';

/// Form configuration helpers for Flutter Gazer application.
/// Provides pre-configured form definitions for common operations using FormModalBuilder.
class FormConfigs {
  /// User profile editing form configuration.
  /// Allows users to update their profile information: name, email, avatar, and bio.
  ///
  /// Fields:
  /// - name: Text field (required, 2-50 chars)
  /// - email: Email field (required, valid email format)
  /// - avatar: URL field (optional, custom avatar URL)
  /// - bio: Text area (optional, max 500 chars, for personal bio)
  static FormModalBuilder getUserProfileFormConfig() {
    return FormModalBuilder(
      title: 'Edit Profile',
      description: 'Update your profile information',
      fields: [
        FormFieldConfig(
          name: 'name',
          label: 'Display Name',
          type: FormFieldType.text,
          required: true,
          validation: FormFieldValidation(
            minLength: 2,
            maxLength: 50,
            errorMessage: 'Display name must be between 2 and 50 characters',
          ),
          placeholder: 'Enter your display name',
          hint: 'Used in stream chat and user mentions',
        ),
        FormFieldConfig(
          name: 'email',
          label: 'Email Address',
          type: FormFieldType.email,
          required: true,
          validation: FormFieldValidation(
            pattern: r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$',
            errorMessage: 'Please enter a valid email address',
          ),
          placeholder: 'your.email@example.com',
          hint: 'Used for account recovery and notifications',
        ),
        FormFieldConfig(
          name: 'avatar',
          label: 'Avatar URL',
          type: FormFieldType.url,
          required: false,
          validation: FormFieldValidation(
            pattern: r'^https?://',
            errorMessage: 'Avatar URL must start with http:// or https://',
          ),
          placeholder: 'https://example.com/avatar.jpg',
          hint: 'Custom avatar image URL (JPG, PNG, max 5MB)',
        ),
        FormFieldConfig(
          name: 'bio',
          label: 'Bio',
          type: FormFieldType.textarea,
          required: false,
          validation: FormFieldValidation(
            maxLength: 500,
            errorMessage: 'Bio must not exceed 500 characters',
          ),
          placeholder: 'Tell your viewers about yourself...',
          hint: 'Personal description displayed on your profile (max 500 chars)',
        ),
      ],
      submitLabel: 'Save Profile',
      cancelLabel: 'Cancel',
    );
  }

  /// Stream configuration form for video quality and performance settings.
  /// Allows users to configure streaming parameters: resolution quality, bitrate, and frames per second.
  /// Premium feature: Access to advanced streaming profiles (4K, 60fps, adaptive bitrate).
  ///
  /// Fields:
  /// - quality: Select field (720p, 1080p, 1440p, 4K - with premium gate)
  /// - bitrate: Number field (1000-50000 kbps, with premium limits)
  /// - fps: Select field (24, 30, 60 fps - with premium gate for 60fps)
  /// - adaptiveBitrate: Checkbox (premium feature for dynamic bitrate adjustment)
  static FormModalBuilder getStreamConfigFormConfig({
    required bool isPremium,
  }) {
    return FormModalBuilder(
      title: 'Stream Configuration',
      description: 'Configure your stream quality and performance settings',
      fields: [
        FormFieldConfig(
          name: 'quality',
          label: 'Video Quality',
          type: FormFieldType.select,
          required: true,
          options: [
            FormSelectOption(label: '720p (HD)', value: '720p'),
            FormSelectOption(label: '1080p (Full HD)', value: '1080p'),
            if (isPremium)
              FormSelectOption(label: '1440p (2K) - Premium', value: '1440p'),
            if (isPremium)
              FormSelectOption(label: '4K (Ultra HD) - Premium', value: '4k'),
          ],
          defaultValue: '720p',
          hint: 'Higher quality requires more bandwidth',
        ),
        FormFieldConfig(
          name: 'bitrate',
          label: 'Bitrate (kbps)',
          type: FormFieldType.number,
          required: true,
          validation: FormFieldValidation(
            minValue: 1000,
            maxValue: isPremium ? 50000 : 8000,
            errorMessage: isPremium
                ? 'Bitrate must be between 1000 and 50000 kbps'
                : 'Bitrate must be between 1000 and 8000 kbps (upgrade to Premium for higher)',
          ),
          defaultValue: '2500',
          placeholder: '2500',
          hint:
              'Recommended: 2500-5000 kbps for 1080p30fps ${isPremium ? '' : '(Premium: up to 50000 kbps)'}',
        ),
        FormFieldConfig(
          name: 'fps',
          label: 'Frames Per Second',
          type: FormFieldType.select,
          required: true,
          options: [
            FormSelectOption(label: '24 FPS', value: '24'),
            FormSelectOption(label: '30 FPS', value: '30'),
            if (isPremium)
              FormSelectOption(label: '60 FPS - Premium', value: '60'),
          ],
          defaultValue: '30',
          hint: 'Higher FPS provides smoother motion but increases bitrate',
        ),
        if (isPremium)
          FormFieldConfig(
            name: 'adaptiveBitrate',
            label: 'Adaptive Bitrate',
            type: FormFieldType.checkbox,
            required: false,
            defaultValue: 'true',
            hint:
                'Automatically adjust bitrate based on network conditions (Premium feature)',
          ),
      ],
      submitLabel: 'Apply Settings',
      cancelLabel: 'Cancel',
      footerNote: isPremium
          ? null
          : 'Upgrade to Premium to unlock 4K, 60fps, and adaptive bitrate settings',
    );
  }

  /// RTMP endpoint configuration form for custom streaming setup.
  /// Allows users to configure custom RTMP streaming endpoints with authentication.
  /// Premium feature: Multiple endpoints, redundancy, and advanced analytics.
  ///
  /// Fields:
  /// - rtmpUrl: URL field (required, must be valid RTMP endpoint)
  /// - streamKey: Password field (required, secret stream key)
  /// - endpointName: Text field (optional, friendly name for the endpoint)
  /// - backup: Checkbox (optional, premium feature for backup endpoint)
  /// - analytics: Checkbox (optional, premium feature for detailed streaming analytics)
  static FormModalBuilder getRtmpEndpointFormConfig({
    required bool isPremium,
  }) {
    return FormModalBuilder(
      title: 'RTMP Endpoint Setup',
      description: 'Configure your custom RTMP streaming endpoint',
      fields: [
        FormFieldConfig(
          name: 'rtmpUrl',
          label: 'RTMP Server URL',
          type: FormFieldType.url,
          required: true,
          validation: FormFieldValidation(
            pattern: r'^rtmps?://',
            errorMessage: 'Must be a valid RTMP or RTMPS URL (rtmp:// or rtmps://)',
          ),
          placeholder: 'rtmp://live.example.com/app',
          hint: 'Server address provided by your streaming service',
        ),
        FormFieldConfig(
          name: 'streamKey',
          label: 'Stream Key',
          type: FormFieldType.password,
          required: true,
          validation: FormFieldValidation(
            minLength: 10,
            errorMessage: 'Stream key must be at least 10 characters',
          ),
          placeholder: '••••••••••••••••',
          hint: 'Keep this secret! Do not share publicly',
        ),
        FormFieldConfig(
          name: 'endpointName',
          label: 'Endpoint Name',
          type: FormFieldType.text,
          required: false,
          validation: FormFieldValidation(
            maxLength: 100,
            errorMessage: 'Endpoint name must not exceed 100 characters',
          ),
          placeholder: 'e.g., "Primary Twitch", "YouTube Backup"',
          hint: 'Friendly name to identify this endpoint',
        ),
        if (isPremium)
          FormFieldConfig(
            name: 'backup',
            label: 'Use as Backup Endpoint',
            type: FormFieldType.checkbox,
            required: false,
            defaultValue: 'false',
            hint: 'Enable redundancy: stream to primary and backup simultaneously (Premium)',
          ),
        if (isPremium)
          FormFieldConfig(
            name: 'analytics',
            label: 'Enable Advanced Analytics',
            type: FormFieldType.checkbox,
            required: false,
            defaultValue: 'true',
            hint:
                'Track detailed metrics: bitrate, dropped frames, viewer bandwidth (Premium)',
          ),
      ],
      submitLabel: 'Save Endpoint',
      cancelLabel: 'Cancel',
      footerNote: isPremium
          ? null
          : 'Upgrade to Premium to set up multiple endpoints and backup streaming',
    );
  }

  /// Audio settings form configuration.
  /// Allows users to configure microphone, audio processing, and levels.
  /// Premium feature: Advanced audio processing (noise suppression, echo cancellation).
  ///
  /// Fields:
  /// - microphone: Select field (available audio devices)
  /// - volume: Slider (0-100, microphone gain)
  /// - noiseGate: Number field (premium feature, noise suppression threshold)
  /// - echoCancel: Checkbox (premium feature, echo cancellation)
  static FormModalBuilder getAudioSettingsFormConfig({
    required bool isPremium,
    required List<String> availableMicrophones,
  }) {
    return FormModalBuilder(
      title: 'Audio Settings',
      description: 'Configure your microphone and audio processing',
      fields: [
        FormFieldConfig(
          name: 'microphone',
          label: 'Microphone Device',
          type: FormFieldType.select,
          required: true,
          options: availableMicrophones
              .map((mic) => FormSelectOption(label: mic, value: mic))
              .toList(),
          hint: 'Select your microphone input device',
        ),
        FormFieldConfig(
          name: 'volume',
          label: 'Microphone Volume',
          type: FormFieldType.slider,
          required: true,
          validation: FormFieldValidation(
            minValue: 0,
            maxValue: 100,
          ),
          defaultValue: '80',
          hint: 'Microphone gain level (0-100%)',
        ),
        if (isPremium)
          FormFieldConfig(
            name: 'noiseGate',
            label: 'Noise Gate Threshold (dB)',
            type: FormFieldType.number,
            required: false,
            validation: FormFieldValidation(
              minValue: -80,
              maxValue: 0,
              errorMessage: 'Noise gate must be between -80 and 0 dB',
            ),
            defaultValue: '-40',
            hint: 'Mute audio below this level to reduce background noise (Premium)',
          ),
        if (isPremium)
          FormFieldConfig(
            name: 'echoCancel',
            label: 'Echo Cancellation',
            type: FormFieldType.checkbox,
            required: false,
            defaultValue: 'true',
            hint:
                'Automatically remove echo and reverb from your microphone (Premium)',
          ),
      ],
      submitLabel: 'Save Audio Settings',
      cancelLabel: 'Cancel',
      footerNote: isPremium
          ? null
          : 'Upgrade to Premium to enable noise suppression and echo cancellation',
    );
  }

  /// Notification preferences form configuration.
  /// Allows users to customize notification settings for various events.
  ///
  /// Fields:
  /// - pushNotifications: Checkbox (enable/disable all push notifications)
  /// - followerNotifications: Checkbox (notify on new followers)
  /// - chatNotifications: Checkbox (notify on chat messages)
  /// - donationNotifications: Checkbox (notify on donations/tips)
  /// - soundEnabled: Checkbox (enable notification sounds)
  static FormModalBuilder getNotificationPreferencesFormConfig() {
    return FormModalBuilder(
      title: 'Notification Preferences',
      description: 'Manage your notification settings',
      fields: [
        FormFieldConfig(
          name: 'pushNotifications',
          label: 'Enable Push Notifications',
          type: FormFieldType.checkbox,
          required: false,
          defaultValue: 'true',
          hint: 'Receive notifications on your device',
        ),
        FormFieldConfig(
          name: 'followerNotifications',
          label: 'Follower Notifications',
          type: FormFieldType.checkbox,
          required: false,
          defaultValue: 'true',
          hint: 'Get notified when someone follows your stream',
        ),
        FormFieldConfig(
          name: 'chatNotifications',
          label: 'Chat Message Notifications',
          type: FormFieldType.checkbox,
          required: false,
          defaultValue: 'false',
          hint: 'Get notified when you receive chat messages',
        ),
        FormFieldConfig(
          name: 'donationNotifications',
          label: 'Donation/Tip Notifications',
          type: FormFieldType.checkbox,
          required: false,
          defaultValue: 'true',
          hint: 'Get notified when viewers send donations or tips',
        ),
        FormFieldConfig(
          name: 'soundEnabled',
          label: 'Notification Sounds',
          type: FormFieldType.checkbox,
          required: false,
          defaultValue: 'true',
          hint: 'Play sound when notifications arrive',
        ),
      ],
      submitLabel: 'Save Preferences',
      cancelLabel: 'Cancel',
    );
  }
}
