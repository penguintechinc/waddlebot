/// Application-wide constants for Gazer Mobile Stream Studio.
class AppConstants {
  AppConstants._();

  // API URLs
  static const String licenseServerUrl = 'https://license.penguintech.io/api/v2/validate';
  static const String licenseServerFeaturesUrl = 'https://license.penguintech.io/api/v2/features';
  static const String licenseServerKeepaliveUrl = 'https://license.penguintech.io/api/v2/keepalive';
  static const String productName = 'gazer-mobile';
  static const String appVersion = '2.1.0';

  // WaddleBot API
  static const String waddleBotApiUrl = 'https://hub-api.waddlebot.io/api/v1';
  static const String waddleBotWsUrl = 'wss://hub-api.waddlebot.io';

  // License feature flags
  static const String featureUsbCapture = 'usb_capture';
  static const String featureCameraOverlay = 'camera_overlay';
  static const String featureHdStreaming = 'hd_streaming';
  static const String featureAdvancedSettings = 'advanced_settings';
  static const String featureWaddleBotAi = 'waddlebot_ai';

  // Timing
  static const int licenseValidationIntervalMs = 5 * 60 * 1000; // 5 minutes
  static const int licenseOfflineGracePeriodMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  static const int waddleBotMetricsIntervalSec = 30;
  static const int waddleBotPingIntervalSec = 25;
  static const int waddleBotMaxReconnectAttempts = 5;
  static const int waddleBotReconnectDelayMs = 1000;

  // Stream defaults
  static const int defaultWidth = 1280;
  static const int defaultHeight = 720;
  static const int defaultFps = 30;
  static const int defaultBitrate = 3000000; // 3 Mbps
  static const int defaultAudioBitrate = 128000; // 128 kbps
}
